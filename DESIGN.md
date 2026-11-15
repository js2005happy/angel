# Angel 设计文档

## 一句话

Angel 是一个全能 AI agent 命令行工具：用 **Python 标准库**从零写成（零 pip 依赖），集多个开源 agent 的设计思想之长，跑在任何只有 Python 3 的机器上。

## 架构

```
用户
 │  python3 -m angel "任务" / 交互 REPL
 ▼
cli.py ── 参数解析、审批模式、会话恢复、REPL 命令、schedule 子命令
 │
 ▼
agent.py ── 主循环：组装系统提示词 → 调模型 → 执行工具调用 → 直到回答
 │   ├── providers.py ── OpenAI 兼容客户端（urllib，无依赖）
 │   ├── tools.py ────── 14 个工具 + 审批 + shell 危险命令黑名单
 │   ├── skills.py ──── 技能加载 / 关键词匹配 / 保存
 │   ├── memory.py ──── 长期记忆 + AGENTS.md + 会话 jsonl 存储
 │   ├── config.py ──── 配置 + provider 注册表 + provider 档案
 │   ├── mcp.py ─────── MCP 客户端（stdio JSON-RPC，默认关闭）
 │   ├── scheduler.py ─ 内置调度器（~/.angel/schedule.json + daemon）
 │   ├── compact.py ─── 会话压缩（模型摘要 + 本地回退）
 │   └── evidence.py ── 会话内证据链（联网抓取原文存档）
```

**关键设计选择：**

- **标准库 only**：`urllib` 调 API、`subprocess` 跑命令、`json`/`re` 做解析。没有 requests、没有 pydantic，部署就是复制一个目录。
- **OpenAI 兼容协议**：所有 provider（DeepSeek、Grok、Hermes via OpenRouter、Ollama、OpenAI）都走同一套 `/v1/chat/completions` + function calling，换模型只改配置。
- **审批是工具层的门**：`tools.py` 的 `_check_approval` 是唯一入口，readonly / auto / full 三档；非交互环境下 auto 拒绝写入，避免 cron 悄悄改文件。
- **技能是 Markdown**：`skills/*.md` + frontmatter（name/description/when/keywords），关键词匹配后注入系统提示词。技能可读、可改、可直接用编辑器写。
- **会话是 jsonl**：`~/.angel/sessions/<id>.jsonl`，每行一条消息，`--resume` 直接续聊；坏了也能用文本编辑器修。

## 设计来源（集百家之长）

Angel 的代码全部是原创实现，没有复制任何项目的源码。下表只说明**设计思想**来自哪里，以及对应项目的许可证（供合规参考）：

| Angel 的功能 | 思想来源 | 来源项目许可证 |
|---|---|---|
| 沙箱式 shell 执行、审批模式（readonly/auto/full） | Codex CLI | Apache 2.0 |
| AGENTS.md 项目说明、会话保存/恢复 | Codex CLI | Apache 2.0 |
| Provider 无关：任意 OpenAI 兼容接口 + 配置选模型 | OpenCode / Pi | MIT |
| 极简、低 token 的 agent 主循环 | Pi | MIT |
| `delegate` 子 agent（有限轮数、返回摘要） | Pi | MIT |
| `plan` 工具：先写计划文件再执行 | Pi / OpenHands | MIT |
| 执行前先规划 | OpenHands | MIT |
| recipes/skills：可复用技能文件 | Goose | Apache 2.0 |
| 技能系统（SKILL.md + 按需加载 + save_skill） | Hermes Agent | MIT |
| 非交互 one-shot 模式（适合 cron/后台） | Grokbot 社区版 | MIT |
| OpenRouter Hermes 模型预设、本地 Ollama 预设 | Hermes 开权重模型 | Apache 2.0（14B/4.3）、Llama 社区许可证（70B/405B） |
| MCP 客户端（stdio JSON-RPC、接第三方服务器工具） | IllusionAgent 0.5.0 | MIT |
| cron 调度器（无人值守自动化、文件式任务） | IllusionAgent 0.5.0 / OpenClaw 调度 | MIT |
| 会话压缩（两种方式：模型摘要 + 本地回退） | IllusionAgent 0.5.0 | MIT |
| 多 provider 档案分组（env_N 式分组、按 flag 切换） | IllusionAgent 0.5.0 / cc-switch 路由 | MIT |
| 搜索双后端：必应优先、百度兜底，独立实例 | IllusionAgent 0.5.0 | MIT |
| “查证是一等公民”：搜索→打开官网→逐项核对→存证→附链接交付 | IllusionAgent 0.5.0（抖音演示，2026-11-15） | MIT |
| 证据链：每一步留档、结论附官方链接可复核 | IllusionAgent 0.5.0（抖音演示） | MIT |
| 能力默认关闭、一键启用、随时热切换 | IllusionAgent 0.5.0（浏览器能力开关） | MIT |

**从 IllusionAgent 0.5.0 借鉴的落地方式（2026-11-16，抖音 60 秒演示“周二去博物馆”）：**
- 视频里的 7 步流程（交代任务→打开浏览器→搜索关键词→点开官网→逐条核对细则→截图留档→交付带官网链接的结论）被压缩成 Angel 的核查式调研技能 `verify-research`：搜索→打开官网→逐项核对→存证→附链接交付。
- 截图留档在 Angel 里做成了轻量版：没有真实浏览器，`web_fetch` / `web_search` 抓到的页面原文存为会话内证据文件（`evidence.py`，`~/.angel/evidence/<会话 id>/`），结论必须附来源链接。
- 搜索后端直接按她的做法：必应优先、百度兜底，每次搜索用全新请求（不共享 cookie/会话），全部失败才报明确错误。
- 能力开关思路用在 MCP 上：MCP 默认关闭，配置里 `mcp_enabled: true` 才启动；系统提示词里也写明了查证流程。

**许可证说明：** Angel 本身以 MIT 许可证发布（见 LICENSE）。借鉴设计思想不产生许可证义务；Angel 没有复制、改编或再分发上述任何项目的代码，没有使用它们的商标（如 Codex、Grok、Hermes、Goose 等名称只出现在本文档的来源说明中，不出现在 Angel 的产品名或界面中）。用户自己配置模型时需遵守各模型提供商的使用条款；Hermes 70B/405B 权重受 Llama 社区许可证约束（商用需注意署名与规模条款），Angel 默认只预设了 Apache 2.0 的 Hermes 4 14B。

**没有采纳的东西（去其糟粕）：**
- 各家的大而全：OpenHands 的重型服务端、Goose 的桌面应用、Codex 的 Rust 工具链——Angel 只要一个能跑的 CLI。
- 闭源部分：Codex 的模型与云服务、Grok Bot 官方客户端都是闭源的，Angel 不依赖它们。
- 厂商锁定：不绑定任何一家模型；Claude Code 的专有配置方式也不采纳。
- **浏览器工具（BrowserNavigate / BrowserClick / BrowserScreenshot 等）**：IllusionAgent 0.5.0 的核心是内置真浏览器，Angel 在 v2 里**不做假的**：没有真实浏览器驱动就无法实现导航、点击、截图，`web_fetch` 的纯文本抓取不能冒充浏览器。已记入路线图，待有浏览器驱动（如 Playwright/Chromium）再做。

## 安全模型

- **Key 不落地**：只从环境变量或已保存的安全连接器读取；绝不打印、记日志、写进项目文件。
- **写操作要审批**：默认 auto 模式每次写文件/执行命令都要确认；readonly 模式完全禁写。
- **shell 黑名单**：`rm -rf /`、`rm -rf ~`、`mkfs`、`dd` 写设备、关机/重启、fork 炸弹等一律拒绝（见 `tools.py` 的 `_check_shell_denied`）。
- **无真沙箱（诚实说明）**：MVP 没有实现容器/命名空间级沙箱，命令以运行 Angel 的用户身份执行。这是路线图第一项；在此之前，请只在信任的目录用 full 模式。

## 路线图

**v2 已完成（0.2.0）：** MCP 客户端、内置调度器/daemon、会话压缩、证据链、grep/git_status/http_post、provider 档案、web_search 双后端。

1. **真沙箱**：Linux 上用 bubblewrap 或 uid 沙箱跑 shell，写操作限制在工作目录。
2. **浏览器工具**：BrowserNavigate / BrowserClick / BrowserScreenshot 等，需要真实浏览器驱动（Playwright/Chromium），不属于 stdlib 范围；v2 只做了证据链轻量版。待定。
3. **GEPA 式自动学习**：任务成功后自动提炼技能（现在是模型主动调 `save_skill`，未来是成功后自动总结+评估）。
4. **桌面 UI**：轻量 Web 界面查看会话与技能。
5. **多模型路由**：按任务难度自动选便宜/强的模型。
6. **多会话并发**：每会话独立引擎（IllusionAgent 的做法），目前 Angel 一次只跑一个会话。
7. **hooks / 插件**：任务前后钩子与第三方插件加载。
