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

## 后端：auto / local / bwrap / e2b

`config.json` 的 `sandbox`（或 `NYRA_SANDBOX` 环境变量，或 `--sandbox`），
默认 `auto`。优先级：CLI flag > 环境变量 > `config.json`。

| 后端 | 行为 | 怎么选 |
|---|---|---|
| `auto`（默认） | Linux 且本机装了 bwrap → 用 bwrap（OS 沙箱）；否则回落到工具级隔离（现有工作区 containment + shell 黑名单），并在 doctor 与首次 shell 执行时给一次提示，说明这是工具级隔离、不是 OS 沙箱。 | 默认就用它。对普通用户无感。 |
| `local` | 显式只要工具级，即使用户机器上有 bwrap 也不用。 | 想退出 OS 沙箱的开关（例如 bwrap 与某个工具不兼容时）。 |
| `bwrap` | 强制要求 bwrap：找不到 bwrap、或非 Linux 平台、或启动失败 → 直接报错退出（fail-closed），绝不静默降级裸奔。 | 想确保“没有 OS 沙箱就宁可不跑”时用。 |
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
| Windows | 无 bwrap：受限执行 + 工具级限制（工作区 containment + shell 黑名单 + 审批）。不是 OS 沙箱。 |
| macOS | 无 bwrap：同 Windows，工具级限制。OS 级 Seatbelt 后端后续再接，目前没有，不要当成已有。 |

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
