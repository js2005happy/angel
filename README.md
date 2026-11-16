# Angel 👼

一个全能 AI 助手命令行工具：集开源 agent 之长（Codex、OpenCode、Pi、Goose、OpenHands、Hermes Agent、Grokbot、Hermes 模型），用 Python 标准库从零写成。没有 pip 依赖，有 Python 3 就能跑。

> Angel 的代码全部是原创（见 [DESIGN.md](DESIGN.md) 的来源说明），只借鉴了各项目的设计思想，没有复制任何源码。

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

**MCP 进程启动与工具审批**：外部 MCP 服务在启动时就可能访问本机资源。现在 `readonly` 不启动 MCP 进程；无人值守的 `auto` 也不启动；交互式 `auto` 会逐个确认是否启动 MCP 服务，随后**每次工具调用仍需单独确认**。`full` 允许自动启动及调用。交互模式下切换 `/mode` 时会停止原有 MCP 进程，并按新权限重新启动允许的服务器。使用 `--list-mcp` 时同样遵循当前权限（需要启动服务器才能读取工具列表）。只有可信 MCP 服务器才应使用 `full`。

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
python3 -m unittest discover tests   # 83 个测试，全部使用 mock，无需 Key
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
│   └── evidence.py    会话内证据链
├── skills/            自带示例技能
├── tests/             mock 测试
├── README.md
├── DESIGN.md          架构与设计来源
├── VERIFICATION.md    验证报告
├── CHANGELOG.md       版本变更记录
└── LICENSE            MIT
```

## 路线图

见 [DESIGN.md](DESIGN.md)：真沙箱、浏览器工具（需真实浏览器驱动）、GEPA 式自动学习、桌面 UI、多会话并发。
