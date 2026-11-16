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
- **MCP 工具同样经过审批**：MCP 服务器提供的工具描述不能证明其只读性，因此按可能产生副作用处理：readonly 禁止调用、auto 交互式每次调用确认（非交互直接拒绝）、full 允许直接调用。审批提示只显示工具名，不打印参数。启用 MCP 时仍会启动用户已配置的服务器进程；执行未知 MCP 服务器前应先审核启动命令。
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

## 服务化架构（多用户，2026-11-16 用户定方向）

把 Angel 从单用户 CLI 变成多用户云端 agent 服务的演进路线。Angel 现在是第 1 步的单用户形态（缺真沙盒）；下面是服务化后的目标形态。

```
用户 App → API 服务 → 编排层(user_id → 沙盒) → 沙盒集群
                         ↓
              每用户持久卷 + 密钥库 + 浏览器配置
```

**1. 注册时不开机，只建「硬盘」**：注册只创建一条记录 + 一个持久存储（网络卷或 S3/R2 前缀）。用户第一次发消息时才懒加载开一台沙盒。大部分注册用户不常活跃，这一步省最多钱。

**2. 编排层：一张映射表**：表里存 `user_id → sandbox_id, 状态(运行/休眠/无), 最后活动时间`。来消息：有运行中的就复用，休眠就恢复，没有就新建并挂上该用户的卷。加一把锁（Redis），防止同一用户并发请求开出两台。

**3. 空闲休眠，秒级恢复**：空闲 5–15 分钟就暂停：内存和磁盘快照存下来，不占 CPU。现成方案：E2B 的 pause/resume、Fly Machines 的 suspend、Firecracker 快照、Daytona 的工作区自动停止。用户感觉不到关机，文件和进程都还在。

**4. 隔离与安全**：一用户一台微虚拟机（Firecracker/gVisor），不要多用户共用一个容器。出网走代理：封掉内网地址和云元数据接口，限速防滥用。密码/API key 存每用户密钥库，由代理在请求里注入，沙盒和模型都拿不到明文。CPU、内存、磁盘、单命令超时都设上限。

**5. 每用户的浏览器**：浏览器单独跑（自建 Playwright 池，或 Browserbase/Steel）。每用户保存一份 profile（cookie、登录态），用完写回存储，下次加载，就「记得登录」。

**6. 后台自己干活**：定时任务表 + 队列：到点唤醒该用户的沙盒，跑一个新 agent 会话，结果推送回 App。

**7. 成本控制**：按活跃时长计费的沙盒服务 + 休眠，成本和活跃用户数挂钩，而不是注册用户数。长期不登录的用户：删快照只留文件，再久归档到冷存储。免费用户限制每天的工具调用次数和机器时长。

**起步路线**：
1. 单用户跑通：模型 + E2B + 文件/shell 工具
2. 加映射表 + 持久卷，变成多用户
3. 加休眠/恢复和并发锁
4. 再加浏览器 profile、密钥库、定时任务

**设计时要补的缺口（诚实记录，动手前先定）：**
- 沙盒选型不是等价的：E2B 最容易起步但按分钟计费贵；Fly Machines suspend 便宜；Daytona 开箱即用；自托管 Firecracker 最便宜但运维最重。起步先定一家，别留到编码时再选。
- 映射表必须持久化（Postgres 之类），Redis 只做锁；映射表丢了要能从卷和沙盒服务商反查重建。
- 出网代理要做白名单，不只是封内网和元数据接口；模型仍可能从工具输出里看到密钥，DNS 渗出也要防。
- 浏览器 profile 要按用户加密存；云 IP 会被网站风控（登录态在新 IP 上常被要求二次验证），「记得登录」不是 100% 可靠。
- 冷启动延迟：新建沙盒 + 挂卷要 10–60 秒，消息层要先回「正在唤醒」或对活跃用户预热；同一用户并发消息要排队，不只是加锁。
- 计费归属：每个用户的模型调用、沙盒时长、工具次数都要记账，否则免费额度没法限。
- 注销要能彻底删：卷、快照、密钥、浏览器 profile 一起删。
- 后台任务的调度器本身要持久化、可恢复；结果推送需要通道（App 推送/websocket）。
- 服务化后 Angel 的「标准库 only」不再适用：服务端是另一套技术选型，CLI 保持轻量，服务层另起炉灶。

**第 1 步进展（2026-11-16 已跑通并收进 Angel 0.3.0）：** 单用户原型已验证：大脑在外、双手在沙盒。模型调用走保管的 DeepSeek 连接器（key 不出保险库），工具执行走 E2B 沙盒（SDK 用保管的 E2B 凭证替身认证，key 不出现）。验证脚本 `workspace/angel/scripts/remote_run.py`：模型写 `prime_sum.py`、沙盒里运行、结果 1060、读回确认，全程 4 轮。Angel 代码已上传进同一台沙盒（28 个文件），`--help` 正常，53 个测试全过。沙盒 `id0mo7xciz8qsrn88a06v`（base 模板，1 小时超时）。2026-11-16 同日，E2B 后端已收进 Angel 本身（0.3.0）：`angel/e2b_backend.py` + tools.py 里的执行后端缝，`--sandbox e2b` 切换，文件与 shell 工具（read/write/edit/list/shell/plan/grep/git_status）走沙盒，其余工具仍在本地，审批与黑名单两种后端都生效，子 agent 继承同一后端；真实 DeepSeek + 真实沙盒端到端已验证（沙盒里写 `sandbox-demo.txt`、读回、列目录，本地零写入）。限制：E2B 免费档沙盒超时上限 1 小时；沙盒不主动删除、到期自动销毁；定时任务仍走本地执行（未接沙盒）。下一步：第 2 步——映射表 + 持久卷（user_id → sandbox_id/状态/最后活动，Postgres 存映射）。

## 品牌与产品界面（2026-11-16 用户定：全部自己设计）

Angel 的整个 UI 由我们自己设计：头像 logo、产品界面、布局、审美。不抄任何同类产品的界面，只用通用应用布局惯例，视觉、组件、文案全部原创。

**形象（assets/angel-character.png，设定集 assets/angel-character-sheet.png）：** Angel 的品牌形象是一个原创二次元少女（用户 2026-11-16 定：几何图形 logo 太丑，改成像 Hermes / Alma 那样的二次元少女形象）。银白长发、发梢带金，金色眼睛，头顶悬一枚发光金色光环，双肩各有一只小白翅膀，深墨蓝制服配金色镶边、光环胸针，温和自信的微笑。设定集含正面、侧面、背面三视图与微笑、沉思、坚定三种表情，同一角色、同一配色。光环 = 守护与核查（Angel 凡事留证据、可复核），翅膀 = 替用户行动。形象是原创设计，只借鉴了同类产品的“有个少女看板娘”这种做法，不抄任何一家的具体角色。几何版光环+翅膀 mark（assets/angel-logo.webp）退为次要标记，只在需要极小尺寸图标（如 favicon）时用。

**品牌色（从形象与 logo 实测取色）：**
- 墨色 Ink `#111A42`：深墨蓝，主深色面 / 浅色底上的文字
- 金色 Gold `#EAC45F`：光环金，点缀色，只用在 logo、激活态、细线高光，不做大面积填充
- 纸色 Paper `#FAF8F4`：暖白，浅色主底
- 石板 Slate `#6B7280`：次要文字
- 通过绿 / 拒绝红：审批卡片的状态色，克制使用

**界面语言：**
- 浅色优先、安静克制：暖纸底、墨字、金色只作点缀；深色模式用墨色底 + 同款金色。
- 三栏应用壳：左栏 bot/频道列表（像联系人）、中栏对话、右栏检查器（沙盒状态、证据、定时任务）。
- 审批是一等公民：危险操作以卡片形式出现在对话流里（允许/拒绝/追问），不用弹窗挡路。
- 处处可核查：结论附来源链接，沙盒状态用药丸标签显示（运行中/休眠中/唤醒中），工具执行过程一步一屏可见。
- 字体：系统无衬线优先，数字与代码用等宽；中文按系统字体回落。

**界面原型：** 交互原型见 artifact「Angel UI Prototype」（angel-ui-prototype），按上面这套语言做第一版；用户反馈后迭代，定稿后再落到真正的 App 实现里。

**虚拟 3D 形象（2026-11-16 用户定）：** Angel 少女形象做虚拟形象，可动、可说话，像虚拟主播一样站在 App 里。第一版动画小样已做出（assets/angel-avatar-anim.mp4，10 秒）：眨眼、微笑、微微歪头、头发轻摆、光环发光。真 3D 的路线：VRM 格式（VRoid Studio 免费建模，按设定集捏出同款角色 → VTube Studio 驱动直播，或网页 Three.js 驱动）；2D 动态的路线：Live2D（分层原画 + Cubism 绑骨，眨眼张嘴都可驱动）。诚实说明：真正的 VRM 模型和 Live2D 绑定文件需要专业软件手工制作，Muse 不能直接生成可用的 .vrm 或 Live2D 模型文件；能做的是设定集、动画小样、网页里的动态形象原型。下一步由用户选：先在 VRoid 里捏 3D 版，或先做 Live2D 版。
