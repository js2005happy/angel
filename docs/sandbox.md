# Nyra 沙箱（隔离执行）

> 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI + Gemini CLI + OpenClaw）。
> 目标版本 0.5.1。沙箱与审批拆成两轴：沙箱定“物理上能做什么”，
> 审批定“何时问人”。两把旋钮互相独立，互不替代。

## 两轴模型

| 轴 | 管什么 | 在哪配 | 出处 |
|---|---|---|---|
| 沙箱 | 命令在物理上能做什么：能写哪、能不能联网 | `config.json` 的 `sandbox` / `sandbox_mode` / `sandbox_allow_net`，或 `--sandbox` / 环境变量 | `src/sandbox.ts` |
| 审批 | 何时停下问人：哪些工具调用要先经用户同意 | `--mode` 与审批流程（`src/tools.ts` 的 `checkApproval`） | 审批流程不变 |

举例：`workspace-write` 沙箱 + `auto` 审批模式下，工作区内的命令自动跑、
不用每次问；但命令想写工作区之外、想联网时，沙箱在系统调用层直接挡住
（写操作以 `EPERM` 失败），而不是靠模型“听话”不写。审批拦的是“要不要做”，
沙箱拦的是“能不能做”。

## 三档模式

`config.json` 的 `sandbox_mode`（或 `NYRA_SANDBOX_MODE`），默认 `workspace-write`。

| 模式 | 含义 |
|---|---|
| `workspace-write`（默认） | 工作区内可读写、跑命令；出工作区写与联网被挡住。常用路径不受影响。 |
| `read-only` | 工作目录也只读挂载；任何写、执行、联网都要审批（审批仍由审批轴决定）。 |
| `danger-full-access` | 无限制，不推荐。**该模式与沙箱互斥**：进 bwrap 会直接抛错拒绝；想用它必须显式走 `--sandbox local`（工具级），并自行承担风险。不要在日常使用、不要在群聊/渠道会话里用。 |

> ⚠️ 警告：`danger-full-access` 意味着模型命令不受任何 OS 级限制，
> 包括删除、格式化、联网外发等。只在你完全信任当前任务、且已看过命令原文时
> 才用，用完立即改回。Nyra 不会替你悄悄开这个模式。

## 后端：auto / local / bwrap / seatbelt / jobobject / e2b

`config.json` 的 `sandbox`（或 `NYRA_SANDBOX` 环境变量，或 `--sandbox`），
默认 `auto`。优先级：CLI flag > 环境变量 > `config.json`。

| 后端 | 行为 | 怎么选 |
|---|---|---|
| `auto`（默认） | Linux 且本机装了 bwrap → 用 bwrap（OS 沙箱）；否则回落到工具级隔离（现有工作区 containment + shell 黑名单），并在 doctor 与首次 shell 执行时给一次提示，说明这是工具级隔离、不是 OS 沙箱。**auto 不会自动选 Seatbelt 或 Job Object**（见下）。 | 默认就用它。对普通用户无感。 |
| `local` | 显式只要工具级，即使用户机器上有 bwrap 也不用。 | 想退出 OS 沙箱的开关（例如 bwrap 与某个工具不兼容时）。 |
| `bwrap` | 强制要求 bwrap：找不到 bwrap、或非 Linux 平台、或启动失败 → 直接报错退出（fail-closed），绝不静默降级裸奔。 | 想确保“没有 OS 沙箱就宁可不跑”时用。 |
| `seatbelt` | macOS `sandbox-exec`（SBPL profile）：强制要求 macOS 与 sandbox-exec，缺失即 fail-closed。 | macOS 上想用 OS 级沙箱时用（见“macOS：Seatbelt 后端”一节）。 |
| `jobobject` | Windows Job Object（PowerShell + kernel32）：强制要求 Windows 与 PowerShell，缺失即 fail-closed。进程级沙箱：随作业死、进程数上限；**不管文件与网络**（见“Windows：Job Object 后端”一节）。 | Windows 上想用进程级沙箱时用。 |
| `e2b` | 0.5.1 暂不支持（Python 已移除，Node 版 E2B 后端尚未移植），会直接报错。 | 现在别用。 |

默认行为对普通用户无感：工作目录内读写、跑命令都不受影响。
只有“出工作区写”与“联网”这两类在 bwrap 下会被挡住；挡住时报错会写清楚
是哪条规则拦的（例如 `EPERM` / 网络不可达），以及怎么放开（见下节）。

## 默认断网与怎么放开网络

bwrap 沙箱默认断网（`--unshare-net`）：沙箱内的命令连不上外网。

放开网络（二选一）：

1. 临时放开一次：`NYRA_SANDBOX_ALLOW_NET=1 nyra "帮我跑 …"`；
2. 长期放开：`config.json` 里加 `"sandbox_allow_net": true`。

放开后仍受审批与 shell 黑名单约束；需要联网的操作仍建议先看一眼命令原文。

## 各平台的隔离级别（不夸大）

| 平台 | auto 下的实际隔离 |
|---|---|
| Linux + 已装 bwrap | OS 级沙箱：bubblewrap（`--bind` 工作目录可写，`/usr`、`/lib`、`/lib64`、`/bin`、`/etc` 只读挂载，`--proc`、`/dev`、默认断网、`--die-with-parent`）。 |
| Linux，未装 bwrap | 工具级隔离：工作区 containment + shell 黑名单 + 审批。不是 OS 沙箱，命令在宿主机上跑。 |
| Windows | auto 下仍是工具级隔离（不是 OS 沙箱）。显式 `--sandbox jobobject` 可用进程级沙箱（Job Object，见下节）。 |
| macOS | auto 下仍是工具级隔离（不是 OS 沙箱）。显式 `--sandbox seatbelt` 可用 OS 级沙箱（见下节）。 |

用 `nyra doctor` 看当前生效的隔离级别（“隔离级别”一项恒为通过，
bwrap 缺失是预期内的降级，不算故障）。

## 与 Hooks 的职责分工

- PreToolUse / PostToolUse 钩子在**沙箱外（宿主机）**跑检查（`src/hooks.ts`
  已是宿主机 spawn，本项不动它）；沙箱内只跑命令本身。
- 也就是说：钩子决定“这次调用允不允许发生”，沙箱决定“命令跑起来后
  物理上能碰到什么”。钩子拦不住的越界写，沙箱在内核层再拦一道；
  沙箱挡住的命令，钩子不会在沙箱内重跑一次。
- 钩子本身的配置与写法见 `docs/hooks.md`。

## 网关接线（`nyra ui`）

网关会话与定时任务建 Agent 时，按与 CLI 同一套来源与优先级解析沙箱，
不另发明配置键：`config.json` 的 `sandbox` / `sandbox_mode` /
`sandbox_allow_net` + `NYRA_SANDBOX` / `NYRA_SANDBOX_MODE` /
`NYRA_SANDBOX_ALLOW_NET` 环境变量（CLI 的 `--sandbox` 旗标只对 CLI 有效，
网关没有对应旗标）。行为与 CLI 一致：

- `auto`（默认）：Linux 且装了 bwrap 就进 OS 沙箱，否则回落工具级，
  在该会话首次执行 shell 时提示一次；
- 显式 `bwrap` 但本机无 bwrap、`e2b`、`danger-full-access` + `bwrap`：
  fail-closed，会话启动失败（`send` 返回 error 状态），命令不跑；
- 默认断网（`sandbox_allow_net` 未开时沙箱内 `--unshare-net`）。

钩子仍在宿主机跑，不进沙箱。未接线的执行路径：MCP 工具调用
（走 MCP 服务器子进程，不走 shell）与群聊机器人（`src/groups.ts`
的 `defaultBotRunner` 建 Agent 时暂未传沙箱配置）目前仍走旧行为，
后续再接。

## bwrap 安装指引

```sh
# Debian / Ubuntu
sudo apt install bubblewrap

# Fedora
sudo dnf install bubblewrap

# Arch Linux
sudo pacman -S bubblewrap
```

装好后 `which bwrap` 能找到即生效；`nyra doctor` 的“隔离级别”一项
会从“工具级”变成“OS 沙箱（bwrap）”。不用重启 Nyra。

## 常见问题

- **命令在沙箱里报 `Permission denied` / `EPERM`？**
  多半是写了工作区之外的路径。把输出写回工作区内，或检查命令里的绝对路径。
- **命令在沙箱里连不上网？**
  默认断网是设计。确认确实需要联网后，用 `NYRA_SANDBOX_ALLOW_NET=1` 放开。
- **`--sandbox bwrap` 直接报错退出？**
  这是 fail-closed：本机没装 bwrap（或不在 Linux 上）。按上面装 bwrap，
  或改回 `--sandbox auto` / `--sandbox local`。
- **沙箱会不会影响 `write_file` / `edit_file`？**
  不会直接影响：文件工具仍走工作区 containment + 审批；沙箱目前只隔离
  `shell` 工具的命令执行（工具级沙箱，学 Gemini CLI 的做法，不隔离整个
  CLI 进程）。

---

## 受保护写入路径（与沙箱互补，但不是同一件事）

workspaceWritePath 上挂了一层受保护判定：工作目录内的以下路径**默认拒写**。

| 类型 | 路径 |
|---|---|
| 目录 | `.git` / `.nyra` / `commands` / `skills`（均为**顶层**目录） |
| 单文件（仅根级） | `AGENTS.md` / `CLAUDE.md` / `nyra.json` / `.nyra.json` |

判定按"工作目录内的相对路径"做，大小写不敏感；子目录里的同名文件**不拦**（`docs/AGENTS.md`、`src/skills/a.md` 都能写）。

### 三个必须知道的边界

1. **只覆盖文件工具**：`write_file` / `edit_file` / `apply_patch` / `plan` 走 `workspaceWritePath`，被拦；**`shell` 不在覆盖范围内**——`echo x >> AGENTS.md` 照样成功，即使进了 bwrap（AGENTS.md 就在工作目录内）。要封死 shell 的写操作得靠权限规则层（S5）。
2. **顶层同名目录会被一刀切**：如果你的项目自己就有顶层 `commands/` 或 `skills/`（例如前端的技能组件目录），agent 将无法写入这些目录。这是刻意的取舍，用下面的环境变量放开。
3. **放开方式**：`NYRA_ALLOW_PROTECTED_WRITES=1`（也接受 `true` / `yes`，大小写不敏感）。它是全进程开关，不区分路径——放开就是全部放开。

```bash
# 确需让 agent 维护自己的规则文件时（例如让它在 skills/ 下生成新技能）
NYRA_ALLOW_PROTECTED_WRITES=1 nyra "<task>"
```

### 为什么默认拦

agent 的指令来源就是 `AGENTS.md` / `commands/*.md` / `skills/*.md`。允许它改这些，等于允许它给自己放权——在一次被污染的会话里，这是最直接的持久化路径。`.git` 则是回滚与审计的底线。

---

## macOS：Seatbelt 后端（P0-6）

Linux 用 bwrap，macOS 用系统自带的 `sandbox-exec`（SBPL profile）。两者是同一层东西：**内核级拦截**，不是工具级规则。

```bash
nyra --sandbox seatbelt "<task>"     # 显式要求（非 macOS 会报错，不静默降级）
nyra --sandbox auto "<task>"         # 注意：auto 不会自动选 Seatbelt（见下）
```

### profile 的形状

原则是 **deny default，再逐项放行**（Apple 推荐的写法，也比"默认允许再禁止"安全）：

| mode | 文件写 | 网络 |
|---|---|---|
| `read-only` | 不给 `file-write*`，只留 `/dev/null` 等设备节点 | 按 `allowNet` |
| `workspace-write` | 只有工作目录 + `/private/tmp` + `/private/var/folders` | 按 `allowNet`，默认只放 localhost |
| `danger-full-access` | `(allow default)`，与 bwrap 后端语义一致 | 全放开 |

- 可额外追加可写路径（例如 `~/.nyra` 要写会话/记忆时）
- 路径里的 `"` 与 `\` 会被转义——不能靠路径注入 profile

### 三个边界（别高估它）

1. 拦的是系统调用面（文件/网络/进程），**拦不住工作目录内的逻辑破坏**（比如删自己的源码）。
2. `sandbox-exec` 失败即 fail-closed：报错说"命令未执行"并**不会退化成裸奔**；要裸奔必须显式 `--sandbox local`。
3. SBPL 不是 Apple 的稳定 API，语法可能随系统版本变化；这里只用了最小集 `(allow/deny file-*/network-*/process-*)`。

### 验证状态

- profile 生成是纯函数，在任何平台都能单测（`tests/node/test-seatbelt.test.ts`）
- **真机执行尚未在 macOS 上跑过**——CI 只有 ubuntu / windows / macos-latest 三档，mac 档会走 Seatbelt 分支，但本机（Windows）无法本地复现；首次 mac 运行时请重点看 `docs/sandbox.md` 这节

## Windows：Job Object 后端（P0-6）

Linux 用 bwrap，macOS 用 Seatbelt，Windows 用系统自带的 **Job Object**
（kernel32 API，通过 PowerShell + Add-Type P/Invoke 调用，不依赖原生模块）。

```bash
nyra --sandbox jobobject "<task>"   # 显式要求（非 Windows 会报错，不静默降级）
nyra --sandbox auto "<task>"         # 注意：auto 不会自动选 Job Object（见下）
```

### 为什么是 Job Object，不是 AppContainer

| 方案 | 能不能落地 | 结论 |
|---|---|---|
| Job Object | 能：纯 PowerShell 就能建作业、设限制、把子进程接进去 | ✅ 选它 |
| AppContainer | 难：要建容器档案、配 capability SID、走 STARTUPINFOEX；且默认拿不到用户文件（agent 要读写工作区），不适合做默认后端 | ❌ 不做 |

### 它到底管什么（不夸大）

Job Object 只管**进程生命周期与资源**，不管文件与网络：

| 限制 | 怎么做 | 默认值 |
|---|---|---|
| 随作业死 | `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（0x2000）：作业句柄一关，作业内全部进程一起死，孤儿进程不留 | 恒开 |
| 进程数上限 | `JOB_OBJECT_LIMIT_ACTIVE_PROCESS`（0x8）+ `ActiveProcessLimit`：同时存活进程数 | 64 |
| 作业总内存上限 | `JOB_OBJECT_LIMIT_JOB_MEMORY`（0x200）+ `JobMemoryLimit` | 默认不设（只在需要时配） |

文件写与联网仍由工具级规则兜底（工作区 containment + shell 黑名单 + 审批），
和 auto 回落到工具级时同一套。**不要把 Job Object 当成 bwrap/Seatbelt 那样的
内核级文件网络拦截**——它不是。

### 实现形状

- 脚本生成是纯函数（`src/windowsSandbox.ts` 的 `buildJobObjectScript`），任何平台可单测。
- 子进程是 `cmd.exe /c (<命令>)`，与非沙箱的 Windows 路径同一台 shell（`ComSpec`，
  默认 `cmd.exe`）。
- 命令与工作目录走 Base64 进脚本：任意引号、`$`、反引号都不会破坏脚本结构；
  CreateProcess 命令行约 32KB 上限，超长命令会启动失败并报错。
- 输出不是流式：子进程输出先落临时文件（防管道死锁），命令结束时一次性返回；
  `onStream` 不适用，`tools.ts` 的 jobobject 分支不传它。
- 子进程先启动、再接进作业，中间有毫秒级窗口：启动瞬间 fork 出的子进程理论上
  可能逃出作业；作业关柄时只杀作业内的进程。

### 三个边界（别高估它）

1. **拦不住文件与网络**：工作目录外的写与联网靠工具级规则拦，不靠 Job Object。
2. PowerShell 启动失败、建作业失败时一律 fail-closed；**接不进作业分两种**：
   子进程已在父作业中（例如 CI runner 的作业，Windows 规定一个进程只能属于
   一个作业）或在接管前已退出时，降级为直接执行并在 stderr 告警（Job Object
   限制不生效，工具级规则兜底）——否则 CI 上永远跑不通（CI #92 根因）；其余
   接管失败仍 fail-closed，报错说"命令未执行"并**不会退化成裸奔**；要裸奔必须
   显式 `--sandbox local`。
3. `danger-full-access` 与 Job Object 互斥（与 bwrap/Seatbelt 同款规则）。

### 验证状态

- 脚本生成与探测是纯函数，在任何平台都能单测（`tests/node/test-windows-sandbox.test.ts`）
- **真机执行尚未在 Windows 上跑过**——本机是 Linux，靠 CI 的 Windows 任务验证
  （`run echo` 与 `exit 3` 两例只在 win32 上跑）；首次 Windows 运行时请重点看这节