# /status 诊断清单

> 缺口 19（2026-11-20，学 Claude Code 2.1.327 的 `/status`）。
> “坏配置自检”：把“写了但静默失效”的配置一次性列出来，而不是等用户
> 在某次危险操作被放过之后才发现钩子/规则根本没生效。

## 用法

```sh
nyra status   # 子命令：有错误配置时返回 1（供脚本把关），警告不影响返回码
/status       # REPL 内同款
```

## 只读

诊断只读文件、只解析配置：**不改任何状态、不 spawn、不联网**。
跑完之后 `~/.nyra/` 里不会多出任何文件（测试 `Status.test_check_is_readonly` 钉住这一点）。

## 检查项

| 类别 | 检查内容 | 级别 |
|---|---|---|
| `config` | `~/.nyra/config.json` 解析失败 | 错误 |
| `skills` | 每个 `.md` 技能文件可解析（frontmatter + `name:`）；损坏的逐个列出 | 错误 |
| `agents` | `~/.nyra/agents/`、`<工作目录>/.nyra/agents/` 下的 `.md` 有 frontmatter + `name:`；Nyra 目前没有内置 subagent 定义文件（delegate 是动态委派），没有就报“未配置” | 错误 / 信息 |
| `commands` | 自定义命令 `.md` 可读且非空 | 错误 |
| `output-styles` | Nyra 目前没有该概念；有文件就校验 frontmatter，没有报“未配置” | 错误 / 信息 |
| `keybindings` | Nyra 未内置按键绑定配置；`config.json` 里写了 `keybindings` 才校验，动作必须是已有的 REPL 斜杠命令（不带 `/`） | 错误 |
| `sandbox` | 显式要求的后端不可用（如配了 `bwrap` 但本机没有）→ 错误；默认 `auto` 回落到工具级 → 通过（带说明） | 错误 / 通过 |
| `permissions` | 解析失败的行、指向未知工具的规则、被 `deny` 覆盖因而永不生效的 `allow`/`ask` 规则 | 错误 / 警告 |
| `hooks` | 无效的 config 条目、不存在/不可执行的脚本、写错的事件名、永不匹配的 `tools` matcher | 错误 |

输出示例：

```
状态诊断（只读，未改任何配置）：
✓ [skills] 技能文件 3 个，全部可解析
✗ [permissions] 被忽略的权限设置：规则 Frobnicate(x) 指向未知工具 Frobnicate
    修法：改成已有的工具名，或删掉该规则
⚠ [permissions] 权限规则永不生效：allow Bash(git *) 被 deny 规则 Bash 覆盖（deny 优先）
    修法：删掉这条被覆盖的规则，或收紧 deny 规则的范围
共 9 项：7 项通过，1 个警告，1 个错误。
有错误配置需要处理（见上）；警告不影响运行。
```

## 两处配套修法（缺口 19 顺带修掉的真问题）

诊断清单如果只报问题、不修根因，用户按文档写的规则还是不会生效：

1. **Claude 风格工具名与 Nyra 工具名归一化**（`src/permissionRules.ts` 的
   `normalizeToolName`）：规则按文档写成 `Bash(...)` / `Edit(...)` /
   `Write(...)` / `Read(...)`，但 `checkApproval` 传进来的是 Nyra 自己的
   工具名（`shell` / `edit_file` / `write_file` / `read_file`）——不归一化，
   按文档写的规则永远匹配不上、静默失效。归一化是双向的（规则侧与调用侧
   都归一），旧测试（直接传 `"Bash"` 作调用方）行为不变。hook matcher
   里的 `Bash` 同样归一化。
2. **钩子拦截进证据链**：每次拦截（`PreToolUse`、`PermissionRequest`、
   `SubagentStart`、`Stop`、`PreCompact`）都在 `events.jsonl` 里记一条
   `hook_blocked` 事件（事件、工具、钩子、原因），`--json` 也透传同款
   事件；审查 fail-closed 要留痕，不只拦、不记。

## 已知局限

- output-style 与按键绑定是 Claude Code 的概念，Nyra 目前没有这两个功能：
  诊断只校验用户自己放的文件/配置，没有就报“未配置”，不编造问题。
  以后 Nyra 引入这两个功能时，对应检查直接从“有文件才校验”升级为正式校验。
- agent 文件同理：Nyra 的 subagent 是动态委派，没有定义文件；只有用户
  自己放了 `agents/*.md` 时才校验。
- 沙箱检查只看“配置要求的后端现在能不能用”，不跑真实沙箱命令验证；
  后端装了但跑不起来（如 bwrap 被 seccomp 拦住）要靠 `nyra doctor` 与实际运行发现。
- `nyra status` 只查本机 CLI 的配置；网关（`nyra ui`）的会话级配置不在本批范围内。
