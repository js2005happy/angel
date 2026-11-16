# Angel 👼

一个全能 AI 助手命令行工具：集开源 agent 之长（Codex、OpenCode、Pi、Goose、OpenHands、Hermes Agent、Grokbot、Hermes 模型），用 Python 标准库从零写成。没有 pip 依赖，有 Python 3 就能跑。

> Angel 的代码全部是原创（见 [DESIGN.md](DESIGN.md) 的来源说明），只借鉴了各项目的设计思想，没有复制任何源码。

**官网：** <https://js2005happy.github.io/angel/>（中英双语）

## 官网

项目官网是 `docs/` 目录下的纯静态单页（`index.html` + `style.css` + `main.js`），由 GitHub Pages 从 `main` 分支的 `/docs` 发布，地址 <https://js2005happy.github.io/angel/>。没有构建步骤、外部 CDN、外部字体或追踪脚本；默认中文，右上角可切换 English，支持手机与暗色模式。内容全部取自本 README、DESIGN.md 与 CHANGELOG.md。本地预览直接用浏览器打开 `docs/index.html` 即可；`tests/test_docs_site.py` 会检查页面存在、内部链接/锚点有效、没有加载任何外部资源。

## v2 新功能（0.2.0）

- **MCP 客户端**：接标准 MCP 服务器（stdio JSON-RPC），配置里 `mcp_enabled: true` 并配好 `mcp_servers` 后，服务器的工具会以 `mcp_<服务器>_<工具>` 出现在工具列表里。默认关闭，需显式启用。
- **内置调度器**：`angel schedule add --name 每日整理 --prompt "整理下载目录" --every 86400`，再 `angel schedule daemon` 跑守护进程；任务存在 `~/.angel/schedule.json`，支持间隔或每天固定时间（`--at 08:30`）。
- **会话压缩**：`python3 -m angel --compact <会话 id>` 或 REPL 里 `/compact`，模型把长会话摘要成要点再继续；模型失败时本地回退保留首尾消息。
- **证据链**：`web_fetch` / `web_search` 抓到的页面原文自动存为会话内证据（`~/.angel/evidence/<会话 id>/`），结论必须附来源链接，可按证据复核。
- **新工具**：`grep_search`（文件内容搜索）、`git_status`（只读 git 状态/差异统计）、`http_post`（走审批）。
- **Provider 档案**：配置里 `profiles` 可存多个命名档案，`--profile strong` 切换；显式 `--provider` / `--model` / `--mode` 优先于档案。
- **web_search 修好**：必应优先、百度兜底的双后端（按 IllusionAgent 的做法），全部失败才报明确错误，绝不编结果。

## 快速开始

```bash
cd ~/workspace/angel

# 一次性任务（需要先配置模型，见下）
python3 -m angel "创建一个文件 hello.txt，写一句问候，再读回来汇报"

# 交互模式
python3 -m angel

# 查看技能和历史会话
python3 -m angel --list-skills
python3 -m angel --list-sessions
```

## Token 用量与上下文状态

Angel 现在会统计模型 API **实际返回** 的 Token 用量。交互终端输入 `/status` 即可查看调用次数、输入/输出 Token、最近一次请求的输入长度及参考上下文余量；Web UI 右侧新增 **Token 用量** 状态面板。单次任务结束时，统计信息输出到 **stderr**，不污染 stdout 的任务结果，适合未来的脚本/JSON 模式。

```bash
python3 -m angel --context-window 8192 "检查这个项目"
python3 -m angel                 # 然后输入 /status
```

如果你知道当前模型官方的上下文上限，可以设置 `--context-window N` 或在 `~/.angel/config.json` 中设置 `"context_window_tokens": 8192`（数字仅为示例，不是对任何模型上限的断言）。没配置时会明确显示 **未知**；如果 API 没有提供 usage 字段，也不会用字符数伪造精确 Token。**上下文参考余量**按最近一次请求的输入 Token 减去已配置窗口计算，不包含最新生成、下一轮新输入以及模型额外的保留量，因此不能当成严格的剩余可用 Token。累计值只统计当前 Agent 进程中的模型回复；历史会话重新载入不自动补算之前的调用。

**自动会话压缩（可选）**：如果确认了所用模型的真实上下文窗口，可以开启自动压缩。默认关闭，避免意外触发额外收费的模型摘要请求。打开后，当模型上一次**实际报告的输入 token** 达到指定窗口的 80% 时，Angel 在下一次模型请求前使用已有 `compact` 压缩**此前的完整历史**，同时保留当前用户请求以及当前轮次的工具调用和结果。

```bash
python3 -m angel --auto-compact --context-window 8192 "继续处理任务"
```

也可以写入 `~/.angel/config.json`：

```json
{
  "context_window_tokens": 8192,
  "auto_compact_enabled": true,
  "auto_compact_threshold": 0.80
}
```

阈值支持 0.50–0.95，仅在上下文上限已经配置且 API 实际返回输入 token 时自动触发；**不会按字符数伪造精确 token**，也不会对没有 usage 的模型擅自触发。每次任务至多自动尝试一次压缩，控制调用费用。如果摘要失败或者摘要没有缩短内容，原始历史保持不变；自动压缩绝不使用手动压缩的丢弃历史回退。压缩仍可能丢失某些未写入摘要的细节，应定期检查会话与备份；不能保证百分百保留原始上下文。Web UI 采用配置文件里的同一开关，会显示自动压缩次数。群聊默认沿用独立机器人设置，不因主 UI 开关自动获得额外写入权限。

后续迭代按 [ROADMAP.md](ROADMAP.md) 排序，下一项是面向 CI 和脚本的非交互 `--json`。

## 多机器人群聊（Python 核心 + JavaScript 界面）

启动原有本地网页界面：

```bash
python3 -m angel ui
```

在网页顶部点击 **机器人群聊**，点击 **新建群**。默认会创建组长、架构师、开发者、审查员四个独立机器人；可以在创建时分别指定模型提供商和模型 ID。每个机器人拥有自己的 system 指令、会话历史、长期记忆与工作目录，而不是一个模型分饰多角。

- 在群里直接发送任务：所有成员分别表达看法、提出方案，可以相互反驳。
- 用 `@architect`、`@builder` 等定向分工，只唤醒指定机器人；也可以同时 @ 多位。
- 显式选择 1 或 2 轮群内讨论，最多 6 位成员，每位机器人单次最多 3 轮模型调用。
- 默认机器人均为 `readonly`，防止创建群聊就自动在本机执行命令。**本版本可进行独立分析和只读工具调用，不具备无人值守自动修改项目或后台并行执行能力。**
- 用户主动发送群消息才会触发模型 API 费用。模型未配置或失败会在群消息中标记错误，绝不伪造执行成功。

数据保存在 `~/.angel/groups/<群 ID>/room.json` 和对应成员的 `bots/<成员 ID>/` 私有目录；每个成员的会话是独立的 `~/.angel/sessions/group-<群 ID>-<成员 ID>.jsonl`。群消息是共享上下文，但各机器人的记忆文件相互独立。浏览器群聊交互单独使用 `angel/group-ui.js` 和 HTML/CSS，复用现有 Python Agent 核心与 HTTP API，而不是把整套系统强行写成一种语言。该目录隔离不是操作系统沙箱。

**群聊安全说明**：不要把群内的 AI 建议当成已经实际执行的操作。当前默认只读、限制讨论轮次和模型调用；多 Agent 写文件权限、任务队列、并行调度和人工审批将分阶段实现。群聊页面与 API 继续使用 Angel Web UI 的本地监听及访问 token 机制。

## 配置模型

Angel 支持任何 OpenAI 兼容接口。配置方式按优先级：命令行参数 > 环境变量 > `~/.angel/config.json`。

| Provider | 环境变量 | 默认模型 | 说明 |
|---|---|---|---|
| deepseek（默认） | `DEEPSEEK_API_KEY` | `deepseek-flash` | 便宜，适合日常任务；`deepseek-v4-pro` 更强 |
| xai（Grok） | `XAI_API_KEY` | `grok-4.3` | |
| openrouter | `OPENROUTER_API_KEY` | `nousresearch/hermes-4-14b` | 可用 Hermes 等开源权重模型 |
| ollama（本地） | 无需 Key | `qwen2.5:7b` | 需本地跑 Ollama |
| openai | `OPENAI_API_KEY` | `gpt-4o-mini` | |
| custom | `ANGEL_API_KEY` + `ANGEL_BASE_URL` + `ANGEL_MODEL` | — | 任意兼容接口 |

也可以直接用已保存的连接器凭证：DeepSeek 和 xAI 的 Key 已通过安全流程保存，**不用再填 Key**，直接用：

```bash
python3 -m angel --provider deepseek "做点什么"
python3 -m angel --provider xai --model grok-4.5 "做点什么"
```

发往本机地址（如本地 Ollama 的 `localhost:11434`）的请求总是直连，不受 `HTTP_PROXY` / `HTTPS_PROXY` 影响；其他地址照常遵守代理设置。

Key 只从环境变量或已保存的连接器读取，**绝不会**打印、记录或写进项目文件。配置存在 `~/.angel/config.json`（不含任何 Key）。

## 审批模式

| 模式 | 行为 |
|---|---|
| `readonly`（只读） | 只能读文件、联网查资料，不能写文件、执行命令 |
| `auto`（默认） | 写文件/执行命令前请你确认（`[y/N]`）；非交互运行时（如 cron）不会悄悄写入，必须加 `--mode full` |
| `full`（全权） | 不确认，直接执行；适合你明确信任的任务和后台运行 |

```bash
python3 -m angel --mode readonly "看看这个目录里有什么"
python3 -m angel --mode full "整理下载目录"
```

**MCP 启动环境隔离**：默认启动 MCP 子进程时，只传递运行所需的少量系统环境变量（如 `PATH`、`HOME`、Windows 系统路径等）和显式配置的 `env`，不再自动传递 DeepSeek/OpenAI 等 API Key。确实需要额外环境变量的服务器可以在各自的配置中明确声明 `inherit_env`：

```json
{
  "mcp_enabled": true,
  "mcp_servers": {
    "example": {
      "command": "python",
      "args": ["server.py"],
      "inherit_env": ["EXAMPLE_API_KEY"],
      "env": {"EXAMPLE_MODE": "safe"}
    }
  }
}
```

`inherit_env` 是精确变量名白名单，不支持 `*`；`env` 中显式值优先。**这仅减少凭证意外传递，不是进程沙箱**：MCP 服务本身仍能以当前用户身份访问本机文件和网络，应仅连接可信程序。

**MCP 进程启动与工具审批**：MCP 服务在启动时就可能访问本机文件和网络。`readonly` 与无人值守的 `auto` 不启动 MCP；终端交互式 `auto` 会逐个确认是否允许启动服务，且每次工具调用仍需另外批准；`full` 允许自动启动和调用。终端 `/mode` 切换会先关闭原有 MCP 子进程，再按新权限启动。Web UI 无终端启动审批入口，所以 `auto`/`readonly` 模式不启动 MCP；Web UI 切换到 `full` 才会启动，并禁止在任务运行中变更模式。注意：这仅是启动授权，不是操作系统级沙箱。

## 交互命令

在交互模式里除了直接提问，还可以用：

| 命令 | 作用 |
|---|---|
| `/help` | 显示帮助 |
| `/mode <模式>` | 切换审批模式 |
| `/skills` | 列出已加载的技能 |
| `/sessions` | 列出历史会话 |
| `/compact` | 压缩当前会话（模型摘要 + 保留最近消息） |
| `/clear` | 清空当前对话历史 |
| `/new` | 开始一个新会话 |
| `/exit` 或 `/quit` | 退出 |

继续上一次会话：`python3 -m angel --resume <会话 id> "继续"`。

交互模式启动时会显示横幅（版本、模型、审批模式、会话 id），提示符是 `angel[auto] ›`（方括号里是当前审批模式）；每次工具调用按 `┌ 工具名 参数` / `└ ✓/✗ 结果摘要` 分组显示。颜色只在终端（TTY）里启用，设置 `NO_COLOR=1`、`TERM=dumb` 或输出被重定向时自动退回纯文本；一次性任务（`python3 -m angel "任务"`）的输出保持不变。

## 网页界面

```bash
python3 -m angel ui            # 启动后打印带 token 的链接，在浏览器打开
python3 -m angel ui --open     # 自动打开浏览器
python3 -m angel ui --port 9000 --workdir ~/project --mode auto
```

本地网页界面，纯标准库 `http.server` + 一个内嵌的 HTML/CSS/JS 页面，不引用任何 CDN 或外部资源：

- **左栏：会话列表**——直接读取 `~/.angel/sessions/`，可新建会话，也可点开历史会话继续。
- **中栏：对话**——用户/助手消息（基本 Markdown 渲染），执行中轮询显示进度；每次工具调用是一张可折叠卡片（工具名、参数、结果摘要）。auto 模式下需要审批时卡片里出现“批准 / 拒绝”按钮，走的是和终端相同的审批门（`tools.py` 的 `_check_approval`），readonly / full 行为不变；10 分钟无人处理按拒绝处理。
- **右栏：检查器**——当前 provider / 模型 / 凭据状态 / 工作目录、本会话的证据列表（来源链接）、最近一次 `plan` 的步骤。
- **顶栏**——切换审批模式；“设置”只读显示当前配置，API Key 只显示是否已配置，**绝不回显值**。

安全：默认只监听 `127.0.0.1`（`--host` 改成非本机地址时会打印警告）；每次启动随机生成一个访问 token，页面链接通过 `?token=` 带入，所有 API 请求都必须在请求头里带上它（防 CSRF），监听本机地址时还会校验 `Host` 头。网页界面目前在本地执行工具（不接 E2B 沙盒），会按配置启动 MCP 服务器（默认关闭）。

## 技能（Skills）

技能是 `skills/*.md` 文件（自带三个示例：`web-research` 网上调研、`file-organizer` 文件整理、`verify-research` 核查式调研），格式：

```markdown
---
name: web-research
description: 在网上搜索并核实信息
when: 需要查找最新信息时使用
keywords: 搜索, 查, 最新
---
这里是给 agent 的操作说明……
```

Angel 会按任务关键词自动加载最相关的技能。你自己的技能存在 `~/.angel/skills/`。任务完成后如果做法值得复用，Angel 会用 `save_skill` 工具把它保存为新技能。

## 工具

Angel 有 14 个工具：`read_file`、`write_file`、`edit_file`、`list_dir`、`shell`（带危险命令黑名单）、`web_fetch`、`web_search`、`memory_append`、`save_skill`、`delegate`（子 agent）、`plan`（先写计划再执行）、`grep_search`、`git_status`、`http_post`。

- **plan**：多步骤任务先写计划文件（默认 `plan.md`）再执行。
- **delegate**：把子任务交给一个子 agent（轮数受限），拿回摘要再继续。
- **memory**：长期记忆在 `~/.angel/MEMORY.md`；项目说明读工作目录的 `AGENTS.md`（像 Codex 一样）。
- **会话**：每次运行自动保存到 `~/.angel/sessions/<id>.jsonl`，可用 `--resume` 继续。

- **证据链**：联网抓到的页面原文存到 `~/.angel/evidence/<会话 id>/`，引用网上信息时附上来源链接；核查类任务走 `verify-research` 技能（搜索→打开官网→逐项核对→存证→附链接交付）。
- **MCP**：默认关闭；在 `~/.angel/config.json` 里设 `"mcp_enabled": true` 并配置 `mcp_servers` 后可用，`python3 -m angel --list-mcp` 查看已加载的工具。stdio 管道在 Windows/Linux/macOS 上均支持超时处理。
- **Windows 终端编码**：旧代码页无法表示中文时，CLI/调度器会以 `\\uXXXX` 转义显示而不是崩溃。建议终端使用 UTF-8（如 PowerShell 设置 `$env:PYTHONIOENCODING="utf-8"`），以直接显示中文。
- **调度器**：`python3 -m angel schedule list/add/remove/run/daemon`，见 `angel schedule --help`。
- **会话压缩**：`python3 -m angel --compact <会话 id>` 或 REPL `/compact`。
- **E2B 沙盒**（0.3.0）：文件读写与 shell 命令可以在 E2B 沙盒里执行，不碰本机：

```bash
pip install e2b   # 可选依赖，核心仍是标准库 only
export E2B_API_KEY=你的 Key   # 或在 Muse 里保存 E2B 连接器
python3 -m angel --sandbox e2b --mode full "在工作目录写一个 hello.txt"
python3 -m angel --sandbox e2b --sandbox-id <已有沙盒 id> "继续上次的工作"
```

沙盒模式下工作目录默认 `/home/user`；沙盒到期自动销毁（默认 1 小时，免费档上限），不主动删；`--sandbox-timeout` 可改（不超过 3600）。审批与 shell 黑名单在沙盒里同样生效。

## 测试

```bash
python3 -m unittest discover tests   # 127 个测试，全部使用 mock，无需 Key
python3 tests/test_smoke.py
```

真实 API 端到端测试记录见 [VERIFICATION.md](VERIFICATION.md)。

## 项目结构

```
angel/
├── angel/
│   ├── __main__.py    入口：python3 -m angel
│   ├── cli.py         参数解析 + 交互 REPL + schedule 子命令
│   ├── agent.py       agent 主循环（plan → 工具调用 → 汇报）
│   ├── providers.py   OpenAI 兼容客户端（urllib）
│   ├── tools.py       14 个工具 + 审批 + shell 黑名单
│   ├── skills.py      技能加载 / 匹配 / 保存
│   ├── memory.py      长期记忆 + AGENTS.md + 会话存储
│   ├── config.py      配置 + provider 注册表 + provider 档案 + 沙盒设置
│   ├── e2b_backend.py E2B 沙盒执行后端（可选依赖，凭证替身认证）
│   ├── mcp.py         MCP 客户端（stdio JSON-RPC）
│   ├── scheduler.py   内置调度器（文件式任务 + daemon）
│   ├── compact.py     会话压缩（模型摘要 + 本地回退）
│   ├── net.py         网络小工具（本机地址直连、不走代理）
│   ├── evidence.py    会话内证据链
│   ├── console.py     终端输出（编码降级、颜色、工具调用分组）
│   ├── webui.py       本地网页界面服务器（python3 -m angel ui）
│   └── webui_page.py  网页界面的内嵌单页（HTML/CSS/JS）
├── docs/              项目官网（GitHub Pages，纯静态）
├── skills/            自带示例技能
├── tests/             mock 测试
├── README.md
├── DESIGN.md          架构与设计来源
├── VERIFICATION.md    验证报告
├── CHANGELOG.md       版本变更记录
└── LICENSE            MIT
```

## 路线图

见 [DESIGN.md](DESIGN.md)：真沙箱、浏览器工具（需真实浏览器驱动）、GEPA 式自动学习、桌面 UI（本地网页界面已可用，独立桌面应用未开始）、多会话并发。
