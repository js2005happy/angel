# Hooks：确定性钩子层

> 调研报告第 1 项：Hooks 确定性钩子层（学 Claude Code）。
> 钩子是挂在生命周期事件上的 shell 脚本。与写在 CLAUDE.md / Skill 里的
> “请求，不保证执行”不同，钩子是**事件发生了就一定执行**的确定性检查：
> PreToolUse 返回退出码 2 就能拦截该次工具调用，无论模型怎么想。
> 钩子本身不占上下文，成本几乎为零。

## 事件表

| 事件 | 触发时机 | 能拦截吗 |
|---|---|---|
| `PreToolUse` | 工具执行前、审批之前；目前只对 `write_file` / `edit_file` / `apply_patch` / `shell` 四类工具触发 | 能：退出码 2 即拦截 |
| `PostToolUse` | 四类工具执行成功后 | 不能：只通知 |
| `SessionStart` | 会话开始时：CLI REPL 启动后（首个提示前）；一次性 CLI 任务开始前；网关新建会话或首次 `send` 建 Agent 成功后 | 不能 |
| `SessionEnd` | 会话结束时：CLI REPL 退出时（`/exit`、EOF、Ctrl+C）；一次性 CLI 任务结束时（无论成败）；网关逐会话关闭（`DELETE /api/sessions/:id`）或关停时，为每个已开始的会话触发 | 不能 |

## 会话钩子触发点

- **CLI REPL**：`SessionStart` 在会话建立后、首个提示前等一次；
  `SessionEnd` 由 `try/finally` 保证，`/exit`、Ctrl+D（EOF）、循环内异常
  都触发；Ctrl+C 尽力触发一次（3 秒宽限后退出，退出码 130，不等满 10 秒
  钩子超时；连按两次时第二次走默认行为直接退出）。
- **一次性 CLI 任务**（`nyra "任务"` 与 `--json` 模式）：`main()` 分发层
  用 `withOneShotSession` 包一层——任务开始前触发一次 `SessionStart`，
  任务结束（成功、失败或异常退出）后在 `finally` 里触发一次 `SessionEnd`；
  钩子 fail-open，不改退出码、不碰 `--json` 的结构化 stdout（钩子输出只
  走 stderr）。与 REPL 口径一致：一次任务一个会话。
- **网关**：`SessionStart` 在 `POST /api/sessions` 新建会话、或首次
  `send` 隐式建出会话时触发，每个会话只触发一次；为不阻塞 HTTP 响应，
  以 fire-and-forget 方式触发。`SessionEnd` 在逐会话关闭
  （`DELETE /api/sessions/:id`，见 `Gateway.closeSession`）或网关关停
  （`stop()`）时为每个已开始的会话触发一次；关闭时等钩子跑完再回 200
  （有超时封顶），运行中的会话回 409（等它跑完再关，不中途杀任务），
  不存在的会话回 404；持久化会话文件保留，关闭后仍可从列表/历史读到。
  同一个会话的 `SessionEnd` 只触发一次（`closeSession` 与 `stop()` 之间
  有去重）。
- 约定与其它事件一致：超时走 `config.json` 的 `hooks.timeout_ms`
  （默认 10 秒）、fail-open、退出码 2 只通知不拦截；无钩子时零 spawn
  零打扰。钩子超时被杀后若留了孤儿孙子进程（如钩子里的 `sleep`），
  主进程仍能正常退出（超时兜底会销毁钩子管道，不等孙子进程）。

## 放脚本的位置

两种方式都支持，**目录方式优先**（推荐）：

1. **目录方式**：把可执行脚本放进 `<home>/hooks/<事件>.d/` 目录，文件名以
   `.sh` 结尾，按文件名排序依次执行。例如：

   ```
   ~/.nyra/hooks/PreToolUse.d/lint.sh
   ~/.nyra/hooks/PreToolUse.d/block-danger.sh
   ~/.nyra/hooks/PostToolUse.d/notify.sh
   ```

   脚本必须可执行：`chmod +x ~/.nyra/hooks/PreToolUse.d/lint.sh`，
   并以 shebang 开头（例如 `#!/bin/sh`）。

2. **config.json 显式列出**：在 `~/.nyra/config.json` 里写：

   ```json
   {
     "hooks": {
       "PreToolUse": ["/abs/path/to/check.sh", "~/my-hooks/block.sh"]
     }
   }
   ```

   支持绝对路径和 `~/` 开头的路径。目录里的脚本和显式列出的脚本都会跑，
   同一路径只跑一次。

查看已装的钩子：

```sh
nyra hooks list
```

## 脚本收到的输入

脚本通过 **stdin** 收到一份 JSON：

```json
{ "event": "PreToolUse", "tool": "write_file", "args": { "path": "a.txt", "content": "..." }, "workdir": "/path/to/workdir" }
```

另外只注入两个只读环境变量：`NYRA_HOOK_EVENT`（事件名）和
`NYRA_HOOK_TOOL`（工具名）。脚本**拿不到任何密钥**：Nyra 不把进程环境
整体透传给钩子（API Key、连接器凭据等一律不给），只给 `PATH` 和上述两个变量。

## 拦截约定（退出码）

| 脚本退出码 | 含义 |
|---|---|
| `0` | 通过，继续执行 |
| `2` | **拦截**（只对 `PreToolUse` 有效）：本次工具调用被拒绝，stdout/stderr 的第一行会作为原因写进工具结果 |
| 其他非零（如 `1`） | 钩子自身出错，**不拦截**，只记一条警告，主流程继续跑 |

stdout 的前 2000 个字符可作原因 / 备注。拦截时工具会返回类似这样的结果：

```
错误：钩子拦截了 write_file：/home/you/.nyra/hooks/PreToolUse.d/no-todo.sh：内容含 TODO，先处理完再写文件
```

## 超时与降级（fail-open）

- 单个脚本默认 **10 秒**超时；可在 `config.json` 里调：

  ```json
  { "hooks": { "timeout_ms": 5000 } }
  ```

  取值范围 1000–120000 毫秒，超出范围会被夹到边界内。
- 超时按钩子自身出错处理：**警告 + 跳过该钩子，主流程继续，不拦截**。
- 钩子脚本无法启动（如不可执行、路径不存在）、非零退出码（除 2 外）
  同样只警告、不拦截。
- 钩子是确定性检查，但**绝不把主流程拖死**：任何钩子故障都 fail-open。

## 开关

- `config.json` 里 `"hooks": { "enabled": false }` 可关闭全部钩子（默认 `true`）。
- 环境变量 `NYRA_HOOKS=0` 可全局关闭（优先级最高，调试时用）。
- 默认不装任何钩子 = 零打扰、零性能损耗：没有钩子文件时 Nyra 不会 spawn
  任何进程。

## 钩子与审批的关系

两者互补，不互相替代：

- **钩子是确定性检查**：规则写死在脚本里，每次必跑、不用人看，适合
  “每次都必须成立”的硬规则（危险命令、TODO 门禁、敏感路径保护）。
- **审批是人工确认**：人看一眼再决定，适合“这次是否合适”的判断
  （这条命令 / 这次改动在当前上下文里对不对）。

执行顺序：**钩子先于审批**。钩子拦下的危险操作不会再弹一次审批来打扰人；
钩子放行的操作仍按原有审批流程走（`auto` 模式弹审批、`full` 模式直接放行）。

## 例子 1：写文件前跑 lint 检查（TODO 门禁）

`~/.nyra/hooks/PreToolUse.d/no-todo.sh`：

```sh
#!/bin/sh
# PreToolUse：write_file / edit_file 的内容含 TODO 时拦截。
# stdin 是 JSON：{ event, tool, args, workdir }。
# 只用 POSIX shell + grep，不依赖额外工具。
input=$(cat)
tool=$(printf '%s' "$input" | grep -o '"tool": *"[^"]*"' | head -1 | sed 's/.*"tool": *"//; s/"$//')
case "$tool" in
  write_file|edit_file) ;;
  *) exit 0 ;;
esac
content=$(printf '%s' "$input" | grep -o '"content": *"[^"]*"' | head -1)
new_text=$(printf '%s' "$input" | grep -o '"new_text": *"[^"]*"' | head -1)
if printf '%s\n%s\n' "$content" "$new_text" | grep -q 'TODO'; then
  echo "内容含 TODO，先处理完再写文件"
  exit 2
fi
exit 0
```

> 注意：上面用 `grep`/`sed` 从 JSON 里抠字段只是演示最轻量的写法；
> 内容里若有转义引号会抠不准。正式使用建议用 `jq`（`jq -r .args.content`）
> 或 Python 解析 stdin 的 JSON。

测试：

```sh
chmod +x ~/.nyra/hooks/PreToolUse.d/no-todo.sh
nyra hooks list   # 应列出该脚本
```

之后模型写含 `TODO` 的文件时会被拦截并看到原因；不含 `TODO` 的照常写。

## 例子 2：shell 命令前二次拦截（关键词拦截）

`~/.nyra/hooks/PreToolUse.d/block-danger.sh`：

```sh
#!/bin/sh
# PreToolUse：对 shell 命令做关键词拦截。Nyra 自带的 shell 黑名单之外，
# 再加一道你自己的确定性防线。
input=$(cat)
tool=$(printf '%s' "$input" | grep -o '"tool": *"[^"]*"' | head -1 | sed 's/.*"tool": *"//; s/"$//')
[ "$tool" = "shell" ] || exit 0
command=$(printf '%s' "$input" | grep -o '"command": *"[^"]*"' | head -1 | sed 's/.*"command": *"//; s/"$//')
case "$command" in
  *"rm -rf /"*|*"rm -rf ~"*|*"rm -rf \$HOME"*)
    echo "危险命令已被钩子拦截：$command"
    exit 2
    ;;
  *"curl "*"| sh"*|*"wget "*"| sh"*)
    echo "禁止管道到 shell 的远程执行：$command"
    exit 2
    ;;
esac
exit 0
```

同样，正式使用建议用 `jq -r .args.command` 取命令原文，避免转义问题。

## 排障

- `nyra hooks list` 看不到脚本：检查目录名是不是 `<事件>.d`
  （如 `PreToolUse.d`，大小写敏感）、文件名是否以 `.sh` 结尾、
  脚本是否有可执行权限（`ls -l` 看有没有 `x`）。
- 钩子没生效：先确认 `config.json` 里 `hooks.enabled` 不是 `false`、
  环境变量 `NYRA_HOOKS` 不是 `0`；再看终端有没有 `警告：钩子 …` 的提示。
- Windows 上 `.sh` 钩子走 Git Bash 的 `sh` 来跑（GitHub Windows 运行器自带；
  用户机器没装 Git Bash 时钩子无法启动，只警告、不拦截、不阻塞主流程）。
- 钩子把正常操作拦了：按提示里的脚本路径改脚本，或临时
  `NYRA_HOOKS=0 nyra "任务"` 关掉钩子跑一次（只影响这一次）。

---

---

## 结构化决策：改写参数（P0-4）

退出码只能表达"拦 / 不拦"。钩子还可以用 **stdout 里的 JSON** 表达更细的决策：

```json
{
  "permissionDecision": "allow",
  "permissionDecisionReason": "这条命令在只读清单里",
  "updatedInput": { "command": "git status --porcelain" }
}
```

| 字段 | 作用 |
|---|---|
| `permissionDecision` | `allow` / `deny` / `ask`（也接受平铺的 `decision`） |
| `permissionDecisionReason` | 拦截时写进工具结果给模型看（也接受 `reason`） |
| `updatedInput` | **改写入参**：合并进本次工具调用的参数后再执行（也接受 `updated_input`） |

### 三个语义

1. **`deny` 等价于退出码 2**：阻止本次调用。多个钩子给出不同决策时按 **deny > ask > allow** 取最严，平级保留先到者。
2. **`updatedInput` 会真的生效**：合并后按改写后的参数执行，并打一行审计日志 `[hook] <tool> 入参被钩子改写：<keys>`。典型用法是把 `rm -rf build` 改写成 `ls -la build`。
3. **格式写错 = 什么都不做**：非 JSON、数组、未知决策值、`updatedInput` 不是对象——一律忽略，不拦截、不放行、不报错。钩子写错格式绝不能把危险操作放过去。

### 只有 PreToolUse 支持决策

`PostToolUse` / `SessionStart` / `SessionEnd` 没有"入参"可改，也不该放行/拦截；stdout JSON 在这三个事件里被忽略（退出码 2 也只记警告）。

### 例子：把危险命令改写成只读检查

```bash
#!/usr/bin/env bash
# ~/.nyra/hooks/PreToolUse.d/20-rewrite-rm.sh
# stdin: {"event":"PreToolUse","tool":"shell","args":{"command":"rm -rf build"},...}
payload=$(cat)
cmd=$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin)["args"].get("command",""))')
if [ "$cmd" = "rm -rf build" ]; then
  printf '{"permissionDecision":"allow","permissionDecisionReason":"改写为只读检查","updatedInput":{"command":"ls -la build"}}'
fi
```

模型以为自己在删目录，实际执行的是一次 `ls`，而钩子把改写写进了审计日志。
