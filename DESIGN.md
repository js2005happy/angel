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
 │   ├── evidence.py ── 会话内证据链（联网抓取原文存档）
│   └── webui.py ───── 本地网页界面（http.server + 内嵌单页，复用 Agent 与审批门）
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

## 两阶段只读计划模式

- `angel/plan_mode.py` 独立于普通 Agent：规划只允许调用 `read_file` / `list_dir`，所有路径经 `resolve()` 检查必须位于工作目录内，阻止 `../`、绝对路径与符号链接越界。不能执行 shell、MCP、子 Agent、网络写入等。
- 模型返回完整 Markdown 后才原子保存 `workdir/plan.md`，如果生成失败则保留旧计划。拒绝已有的符号链接计划文件。
- `--execute-plan --approve-plan SHA256` 用完整 64 位 SHA-256 校验文件所有字节。校验失败不会初始化执行 Agent；执行仅使用校验过的内存内容，不重新读取计划。
- 批准计划不会提升工具权限；默认进入 `auto`，不继承配置中可能存在的 full；仅显式 `--mode full` 才取消工具级确认。本版本仅本地 CLI，不宣称 OS 沙箱或 Web UI 审批功能。

## 可编排 JSON Lines 执行协议

- python3 -m angel --json "任务" 通过独立的 json_mode.py 单次执行入口构造真实 Agent；Agent 仍走原有工具审批与 MCP 安全门，不因输出模式更换而提高权限。
- 每个事件是单行 JSON，包含 schema_version（当前 1）、seq（递增序号）与 type；任务开始、工具开始/结束、usage、自动压缩、完成、失败、耗尽轮数均有可枚举事件。
- 工具事件默认只输出 id、name 与执行状态，**不会**无意记录原始工具参数、文件内容或命令输出；任务最终答案仅位于 run_completed.output 或 run_incomplete.output。交互式审批不适合机器执行，非交互 auto 模式继续拒绝需要确认的写入。
- 人工 print 在执行期间被导向 stderr；机器 stdout 保留给结构化事件，即使参数校验或运行失败也返回 run_failed。help 与不支持的 schedule/ui 子命令仍属于原有人类界面，不属于 --json 合约。
- 固定退出码：0 完成、1 运行故障、2 参数/配置/凭证问题、3 达到轮数上限未完成、130 用户中断。下游程序必须结合退出码和最终事件判断结果，不应将任意助手文本视作已完成操作。


- `angel/usage.py` 仅累计 OpenAI 兼容响应中的 usage / prompt_tokens / completion_tokens / total_tokens（也接受 input_tokens / output_tokens），并标明未报告的响应数。未报告的数字不得估算为精确值。
- `Agent.usage` 负责每个 Agent 实例的实时计量；用于 CLI `/status`、一次性任务 stderr 与 Web UI 会话的 status API，原有会话存储与普通 stdout 文本接口保持兼容。
- 仅当配置中存在已核实的 `context_window_tokens`（或 CLI 的 `--context-window`）且 API 返回输入 Token，才能计算参考余量。每个模型有不同限制，需随具体模型调整配置；参考值不包括下一次输入和输出。
- 下一步自动压缩应当在请求前预估或根据上轮 usage 守护阈值，遇到模型未报告用量时需显式保守处理，不得伪装为准确 token 计算。

## 自动上下文压缩（可选）

- `compact.py` 扩展为可严格执行摘要：`strict=True` 时若摘要 API 失败，直接报错并保留原始历史；**手动** `/compact` 仍保留之前的回退行为。
- `Agent.run()` 每轮调用模型前检查最近一次真实报告的输入 token / 已配置的上下文窗口，默认达到 80% 且有足够历史消息时才尝试压缩，绝不由字符串长度估算 token。
- 只对当前用户请求以前的历史生成摘要，保留当前用户指令及其完整工具调用与结果链，因此不会将工具结果孤立在不匹配的 tool_call_id 之后。仅摘要确实比原文短才保存；失败时不写入、不中断主任务，每次根任务最多 1 次额外模型摘要调用。
- 默认 `auto_compact_enabled=false`，需明确配置或传 `--auto-compact` 并给出经核实的上下文窗口，防止用户无意消费 API。摘要请求的真实 usage 也累计在 Agent 用量计数里。
- 自动触发依赖**上一次**请求用量，而不是未发送的下一次请求的精确长度；在一次长输入突增时依然可能遇到模型上下文异常，不承诺绝对避免溢出。压缩摘要自身有信息损失风险，应配合定期历史备份。

## Poppy 用户授权意向账本（第二阶段）

- 新增 `poppy_permissions.py`：独立按 `(公开 HTTPS 精确主机, visitor 或 account:<本地别名>, OAuth scope)` 保存本地授权意向，默认拒绝、禁止通配 scope、子域名/账户不共享。**不是 Poppy Session / OAuth 权限记录**，即使存在 local_intent 也始终将 `may_execute_remote_action` 标记为 false。
- `angel permissions list|check|grant|revoke|audit` 在创建 Provider、MCP 进程或任何网络请求之前直接执行。只有显式用户 CLI `grant --confirm` 能新增记录；Agent 的 `--poppy` 工具仅支持 `poppy_permission_check` 只读查询，不包含 grant/revoke。
- JSON 持久化存于 `~/.angel/poppy/permissions.json`，私有权限 0600（POSIX）、同目录临时文件加 `os.replace`，进程内锁序列化更改。`--expect-revision` 可对存储字节执行 SHA-256 乐观并发校验。有界审计事件与账本同一次原子替换，限制站点/身份/scope 数量及 256 KiB 容量；文件/目录已有符号链接会拒绝。
- `classify_scope` 符合 Poppy 1.0 §4.7：未知 changes 按 irreversible，缺少 personal_data 视作未知；任何非 `none` 或未知个人数据都标记为日后执行时必须人工确认。`poppy.py` 的 discovery 摘要也避免将缺失提示降级为安全，不信任网站描述本身等于用户授权。
- **尚未落地的 runtime gate**：现阶段没有 Poppy HTTP MCP/OAuth Session/远端操作，所以账本不使任何远程操作实际可执行。真正的 transport 必须核验公司 issuer、运行时 token 实际 scopes、Session 身份归属、用户明确批准和高风险每次操作审批，且支持撤销后的实时阻断。多进程竞争与具备本地磁盘权限的恶意修改不由本期彻底解决。

## Poppy 协议发现薄层（首阶段，默认关闭）

- 官方参考：`https://personalagentprotocol.org/docs/1.0/spec`。新增 `angel/poppy.py` 只做不带登录身份的公共 `/.well-known/poppy.json` 发现，检查文档版本、实际服务主机与 `organization.domain` 一致、重定向最终 well-known 路径精确且无 query。首选非 1.0 时若 `supported_versions` 指向同主机的 1.0 备选文件，则按规范拒绝备选重定向并校验它的版本。
- 为减少 SSRF，域名须有效且为公共 DNS；DNS 地址全部要求是公开可路由 IP，再通过定制的标准库 `http.client.HTTPSConnection` 连接到已检查的 IP、以原主机做 TLS SNI/证书校验。禁用自动代理与 Cookie/Token，拒绝非 HTTPS、URL 凭据、非默认端口以及内网/环回 DNS 和重定向目标；响应受字节数、超时和重定向次数限制。
- 能力解析返回类型、渠道 URL 与缩短的描述，`status=metadata_only`；禁止自动发起身份验证或调用任意返回的远端 MCP/OpenAPI/UCP 公司 Agent。远程 HTTP MCP 与 Angel 既有 stdio MCP 不等价，必须后续另行实现 OAuth 与 Session JWT。
- `ToolContext.poppy_enabled` 默认 false，只有 CLI `--poppy` 明确开放工具 schema，委派子 Agent 保留显式开关；独立 CLI `--discover-poppy` 在创建 Provider/连接 MCP 前完成，无实际模型调用。JSONL 单次任务可以带 `--poppy`，权限仍遵守原有模式。
- 未来步骤：权限账本（站点/授权 scope/操作风险），再实现 HTTP MCP、Session、OAuth/DPoP 与用户审批；之后按需实现 UCP 搜索、加购、结账。没有显式核实的交易能力不得被认为已可用。用户的 Shopify 站点需单独实测发现文件，不能从平台公告推断其特定文件内容。

## 长期记忆：可查看、可管理、与会话压缩解耦

- 原有 `memory.py` 的全局 `MEMORY.md` 和 `groups.py` 中按机器人隔离的 `MEMORY.md` 都位于 session JSONL 之外，`compact.py` 只处理消息数组，不会写入长期记忆。Agent 每次构造系统提示词时加载相应记忆文件的**最后 40 行**，因此持久文件本身不等于模型能同时回忆所有内容。
- 新增 `memory_browser.py`：严格按既有文件路径读取 UTF-8 完整内容，支持带 SHA-256 修订号的 CAS 保存、同目录临时文件与原子替换、64 KiB 容量限制及已有符号链接防护，文件冲突失败关闭。使用 `MEMORY_LOCK` 与同一 Python 进程中 `append_memory` 串行化。
- Web UI 新增受原有访问 token 保护的 `GET /api/memory/scopes`、`GET /api/memory?scope=...`、`POST /api/memory`，只允许全局记忆和通过 `GroupStore.get` 证实存在的机器人。群 ID 与机器人 ID 不作为任意文件路径，拒绝符号链接穿透及跨机器人越界访问。
- `webui_page.py` 加入独立的编辑对话框，选择记忆所属、载入完整 Markdown、刷新和明确保存；版本冲突提示用户先手工合并，关闭/切换未保存内容时警告。所有记忆正文通过 `textarea.value` 输出，不插入 HTML。
- 已知限制：单进程锁与 SHA-256 校验不构成多进程原子 compare-and-swap；文件系统竞争时仍有 TOCTOU 风险；目前没有记忆条目语义索引、自动去重、记忆摘要层次或跨机器人授权共享。

## 多 Agent 群聊架构（可运行 MVP）

- `angel/groups.py`（Python）：群存储、不同 bot 的角色指令、独立会话、不同 provider/model、成员私有记忆和 workspace、@mention 路由、预算控制。复用成熟的 `Agent` 执行器，避免多套模型调用实现。
- `angel/group-ui.html` + `angel/group-ui.js`（原生 HTML/CSS/JavaScript）：独立群聊 UI、组员列表、各成员模型配置与发送消息；不强制所有代码使用 Python，前端无需重新编译。
- `angel/webui.py`：沿用现有同源 token 安全边界，提供 `GET/POST /api/groups`、`GET /api/groups/<id>`、`POST /api/groups/<id>/messages`。前端以 `textContent` 显示不可信的群消息，避免 HTML 注入。
- 机器人身份和记忆分离：不同成员的 `Agent` 实例、模型会话 ID、群内 workspace 与 `MEMORY.md` 相互独立；共享的只有群消息记录。
- 资源限制：每群最多 6 人、每条消息最多 2 轮、每个机器人每次最多 3 轮模型调用；独立的 `delegate` 工具有共享子任务预算/递归深度限制。
- 当前选择串行逐个响应，以便后续成员能看到前一个人的意见，也便于控制模型调用成本。可并行的独立任务队列、WebSocket/SSE 推送与多机器人实际代码执行放入后续迭代，不虚称已实现。
- 语言路线：保留 Python 标准库 agent / 协议适配，交互层使用 JavaScript；当有具体并发或性能瓶颈，再评估 TypeScript、Go、Rust，而不是先重写。

## 单文件补丁与审批差异预览

- `angel/patches.py` 使用标准库解析单文件 unified diff。强制匹配文件头、每段 hunk 的旧/新行号以及逐行上下文，不允许模糊匹配、多文件补丁、重命名或新建/删除补丁；支持 LF、CRLF 和基本无末尾换行标记。
- `apply_patch` 先通过工作目录安全检查，读取原始字节、计算修改与 diff，再按原有 `readonly/auto/full` 权限审批。审批后重新比对原始文件防止过期补丁，最终交由 `CheckpointStore` 写入，保留 `/undo` 能力。E2B 暂不支持此工具。
- 本地 `write_file`、`edit_file`、`plan` 与 `apply_patch` 的交互审批摘要附带最大 6000 字符的 unified diff（单侧超过 128 KiB 时不执行昂贵的对比运算，提示无法预览）；Web UI 保留预格式化换行和滚动，避免多行文本压成一行。超长预览标记截断，不宣称展示了完整改动。
- `CheckpointStore.latest_diff()` 展示最近活动检查点原始内容与当前文件差异；若文件哈希不匹配，报告外部冲突而非展示外部编辑。CLI `/diff` 为只读视图。
- 已知限制：路径安全检查与执行之间有残余竞态；本次不实现跨文件补丁事务、远端补丁、OS 沙箱或完整 Git 工作树 diff。

## 本地文件检查点和冲突安全恢复（CLI MVP）

- `angel/checkpoints.py` 按 session_id + 真实工作目录计算隔离存储目录，每次顶层 Agent.run 重置当前检查点；子 Agent 分享父任务同一检查点。仅本地 `write_file`/`edit_file`/`plan` 的最终 UTF-8 文本写入由该管理器持久化；备份保存写入前原始二进制字节。
- 首次写入某文件前保存完整的原始字节（base64）、原始哈希、目标哈希；采用同目录临时文件 + os.replace 进行文件写入，尽量避免部分写入。一次任务改动多个文件仍归一条检查点。每文件 2 MiB/每轮 20 文件/最多 20 未撤销轮限制，超过上限则拒绝修改。
- `/undo` 恢复最近一轮，`/rewind N` 预检最近 N 轮所有关联文件及重叠的历史状态；任何哈希/符号链接/工作区路径冲突都会在写入前整体中止，避免覆盖其他人的编辑。恢复完成的检查点标记 undone，CLI 提示并写入会话通知后续 Agent 重新核对文件。
- 明确非覆盖范围：Shell/MCP/E2B/HTTP/全局 memory 与 skills/任何外部系统修改都不在检查点内；文件操作、哈希检查与多个文件恢复过程也不是 OS 级多文件事务，对并发修改存在 TOCTOU 残余风险。掉电/强杀在清单写入和实际文件替换之间可能留下无法自动恢复的记录，系统会按当前哈希拒绝危险的撤销，不默默覆盖。
- 本次交付 CLI 检查点入口；Web UI 独立撤销交互、操作前后 diff、shell/沙箱级快照等后续扩展，不能宣称已经完成。

## Session 授权进一步收窄（文件目标与 Shell 起始目录）

- 交互式 `auto` 的 `a` 绑定单个文件工具名称、`resolve()` 后的目标路径、规范化工作区和后端身份。不再按整个工具名授权全部文件；另一文件必须再次征得批准。
- Shell 缓存的精确匹配键包括原始命令字符串、规范化起始 `cwd`、工作区、timeout 和后端身份。Shell 的起始目录经本地真实路径包含关系 / E2B 远端词法范围校验，拒绝通过 `../`、绝对路径、已有外部符号链接指定工作区外目录。
- 回调型（例如 Web UI）审批总是先于终端缓存，避免同一个 ToolContext 中的旧授权绕过前端确认；非交互 auto 与 readonly 仍失败关闭。
- 安全范围：上述只约束**授权范围及起始 cwd**，不能限制 shell 内部命令行为、任意子进程、外部资源或 shell 切目录。远端沙盒符号链接未验证，文件操作仍可能存在 TOCTOU，不能当成完整文件系统沙箱。

## 工作目录内置文件写入限制与会话授权

- `angel/tools.py` 在执行 `write_file`、`edit_file`、`plan` 之前先校验目标：本机使用 `Path.resolve` 后检查目标是否在实际 `workdir` 内，已有符号链接的外部目标会被拒绝；E2B 用 `posixpath.normpath` 限制远端词法路径。`full` 模式不能绕过此检查。
- `ToolContext` 持有单次会话的批准缓存，仅能为 `write_file`、`edit_file`、`plan` 记住某种文件工具，以及 shell **完全相同的命令文本和 cwd**；不会采用易混淆的前缀匹配，也不给 MCP/http_post/memory/skill 记住宽泛授权。回调式 Web UI 审批仍按原来逐项进行。
- 不可信 shell 仍可能读取或写入工作目录之外；运行命令的 cwd 不构成沙箱，MCP 和 HTTP POST 也可拥有外部副作用。记忆、技能、会话、证据文件在 Agent 数据目录写入属于独立路径。远端 E2B 符号链接无法在本地做真实目标验证；Path.resolve 和执行操作之间也不是原子检查，尚需进一步防 TOCTOU。此改动是文件工具拦截，不是安全承诺“整个 Agent 只能写工作目录”。
- 下一步再考虑可信 shell 操作系统沙箱、命令前缀解析/白名单、细分路径级授权与审计日志。

## 安全模型

- **Key 不落地**：只从环境变量或已保存的安全连接器读取；绝不打印、记日志、写进项目文件。
- **写操作要审批**：默认 auto 模式每次写文件/执行命令都要确认；readonly 模式完全禁写。
- **MCP 子进程环境最小化**：启动时不直接复制整个 `os.environ`，只传系统启动所需变量与每个服务器明确声明的 `inherit_env`、`env`。后者优先级更高。这降低 Agent 自身模型 Key 意外被 MCP 子进程继承的风险；子进程仍以同一系统用户运行，**没有文件系统与网络隔离**，不能替代沙箱。
- **MCP 启动和调用均经过授权**：MCP 进程启动本身就可能有副作用。readonly 不启动、非交互 auto 不启动、终端交互 auto 逐项确认启动并对工具逐次确认、full 自动启动。终端 `/mode` 切换会关闭旧 MCP 进程并按模式重新加载；Web UI 在 auto/readonly 不自动启动 MCP，切换 full 才可启动，活跃任务期间拒绝切换以避免竞态。提示仅展示服务器/工具名，**该策略不是进程沙箱**。
- **shell 黑名单**：`rm -rf /`、`rm -rf ~`、`mkfs`、`dd` 写设备、关机/重启、fork 炸弹等一律拒绝（见 `tools.py` 的 `_check_shell_denied`）。
- **无真沙箱（诚实说明）**：MVP 没有实现容器/命名空间级沙箱，命令以运行 Angel 的用户身份执行。这是路线图第一项；在此之前，请只在信任的目录用 full 模式。

## 路线图

**v2 已完成（0.2.0）：** MCP 客户端、内置调度器/daemon、会话压缩、证据链、grep/git_status/http_post、provider 档案、web_search 双后端。

1. **真沙箱**：Linux 上用 bubblewrap 或 uid 沙箱跑 shell，写操作限制在工作目录。
2. **浏览器工具**：BrowserNavigate / BrowserClick / BrowserScreenshot 等，需要真实浏览器驱动（Playwright/Chromium），不属于 stdlib 范围；v2 只做了证据链轻量版。待定。
3. **GEPA 式自动学习**：任务成功后自动提炼技能（现在是模型主动调 `save_skill`，未来是成功后自动总结+评估）。
4. **桌面 UI**（部分完成）：本地网页界面 `python3 -m angel ui` 已可用（2026-11-16：会话列表、对话与工具卡片、网页内审批、证据与计划检查器，纯标准库、默认只听 127.0.0.1 + 启动 token）；技能浏览、独立桌面应用、按品牌形象的完整三栏 App 尚未开始。
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
