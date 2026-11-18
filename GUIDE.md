# Nyra 完整手册

这里是 Nyra 的全部功能、命令与安全说明。简介与快速上手见 [README](README.md)。

## 功能一览

- **先计划，后执行**：`--plan` 只读生成 `plan.md`，你审完用 SHA-256 批准，改一个字节旧批准就失效。
- **每一步都问你**：写文件、跑命令默认逐项审批；`apply_patch` 编辑前自动存检查点，`/undo`、`/rewind` 随时回退。
- **带证据的研究**：`web_search` / `web_fetch` 抓到的原文存为证据，结论必须附来源。
- **接 MCP 与技能**：标准 MCP 服务器（stdio）即插即用，`skills/` 目录扩展能力。
- **会自己干活**：内置调度器，按间隔或每天定时跑任务。
- **多机器人群聊**：一个房间里多个 bot 分工，每个 bot 权限独立。
- **任意模型**：DeepSeek、Grok、OpenAI、通义、Kimi、智谱、Gemini、本地 Ollama 等十多家 OpenAI 兼容接口；`profiles` 一键切换，失败自动换备用。
- **可选 E2B 沙盒**：`--sandbox e2b` 让文件与 shell 不碰本机。
- **用量透明**：`/status` 显示真实 Token 用量与上下文余量，`/compact` 压缩长会话。
- **网页界面**：`python3 -m nyra ui` 打开本地 Web UI。

> 代码全部原创，只借鉴了 Codex、OpenCode、Goose、OpenHands 等开源 agent 的设计思想（来源见 [DESIGN.md](DESIGN.md)），没有复制任何源码。

## 官网

项目官网是 `docs/` 目录下的纯静态单页（`index.html` + `style.css` + `main.js`），由 GitHub Pages 从 `main` 分支的 `/docs` 发布，地址 <https://js2005happy.github.io/nyra/>。没有构建步骤、外部 CDN、外部字体或追踪脚本；默认中文，右上角可切换 English，支持手机与暗色模式。内容全部取自本 README、DESIGN.md 与 CHANGELOG.md。本地预览直接用浏览器打开 `docs/index.html` 即可；`tests/test_docs_site.py` 会检查页面存在、内部链接/锚点有效、没有加载任何外部资源。

## 新功能（0.2.0 / 0.3.0）

- **E2B 沙盒**（0.3.0）：`--sandbox e2b` 让文件读写与 shell 在 E2B 沙盒里执行，不碰本机；详见下文「E2B 沙盒」一节。
- **MCP 客户端**：接标准 MCP 服务器（stdio JSON-RPC，协议 2026-07-28，旧版服务器自动回退 `initialize` 握手），配置里 `mcp_enabled: true` 并配好 `mcp_servers` 后，服务器的工具会以 `mcp_<服务器>_<工具>` 出现在工具列表里。默认关闭，需显式启用。
- **内置调度器**：`nyra schedule add --name 每日整理 --prompt "整理下载目录" --every 86400`，再 `nyra schedule daemon` 跑守护进程；任务存在 `~/.nyra/schedule.json`，支持间隔或每天固定时间（`--at 08:30`）。
- **会话压缩**：`python3 -m nyra --compact <会话 id>` 或 REPL 里 `/compact`，模型把长会话摘要成要点再继续；模型失败时本地回退保留首尾消息。
- **证据链**：`web_fetch` / `web_search` 抓到的页面原文自动存为会话内证据（`~/.nyra/evidence/<会话 id>/`），结论必须附来源链接，可按证据复核。
- **新工具**：`grep_search`（文件内容搜索）、`git_status`（只读 git 状态/差异统计）、`http_post`（走审批）。
- **Provider 档案**：配置里 `profiles` 可存多个命名档案，`--profile strong` 切换；显式 `--provider` / `--model` / `--mode` 优先于档案。
- **web_search 修好**：必应优先、百度兜底的双后端（按 IllusionAgent 的做法），全部失败才报明确错误，绝不编结果。

## EigenFlux 可选接入准备（bare-CLI，默认离线）

Nyra 支持为主 Agent 和每个已创建的群聊机器人分配**独立且稳定**的 EigenFlux Home，并检查本机是否已有官方 CLI 与 Skills。此功能不自动安装、认证、注册、广播、读取私人上下文或创建定时任务。它也**不是**一个已经连入 EigenFlux 网络的客户端。

```bash
# 只生成本地准备报告，不访问网络、不执行 EigenFlux CLI
python -m nyra eigenflux doctor
python -m nyra eigenflux doctor --room alpha --bot lead

# 明确运行本地两条官方验证命令，仍不开始 onboarding
python -m nyra eigenflux doctor --check
python -m nyra eigenflux doctor --room alpha --bot lead --check
```

默认使用 `~/.nyra/eigenflux/agents/main/.eigenflux` 作为主 Agent Home；新建群聊的每个机器人使用 `~/.nyra/eigenflux/agents/rooms/<room>/instances/<随机实例ID>/bots/<bot>/.eigenflux`（旧群兼容先前路径）。这样即使删除并重建同名群，也不能意外复用以前的身份密钥。这些 Home 与 Nyra 的群聊记忆/会话文件分开，不能借用其他机器人的身份或凭据。EigenFlux CLI 需要明确传入同一个 `--homedir`，并且 Home 的最后一级必须是 `.eigenflux`，以免 CLI 再追加目录层级。

`--check` 仅调用 PATH 中已有的 `eigenflux --homedir HOME version` 和 `eigenflux --homedir HOME skills path --host terminal`，不经过 shell，限制超时，调用子进程时仅传递最少环境变量，避免把模型 API Key 或其他代理凭据交给诊断 CLI。检测成功只表示本地工具可用，**不等于邮箱认证、网络身份、用户授权或收件箱订阅已完成**。

安装需要用户单独授权，并须先审阅 [EigenFlux 官方安装指南](https://github.com/phronesis-io/eigenflux/blob/main/skills/install.md)。macOS/Linux 的非官方宿主推荐 `EIGENFLUX_SKIP_AGENT_SETUP=1` bare-CLI 路线；Windows 官方 PowerShell 安装器的宿主集成能力与 Unix 不同，不能假设自动配置了 Codex/Claude 插件。EigenFlux 官方安装器是外部代码，Nyra 不会在 doctor 中代为执行。邮箱 OTP、Agent Card、公开广播以及周期性订阅均通过后续 `ef-onboarding` 前台确认，不应把安装同意当成网络行动许可。

## EigenFlux 本地网络权限上限（按机器人独立，默认全部拒绝）

Nyra 可为主 Agent 和群聊中的**每个独立机器人**设置本地网络行为上限。它只是一层额外的 Nyra 限制：不会替代官方 `ef-onboarding` 用户确认，不会注册账户、打开网络通道、访问私有上下文，也不能作为已认证的凭据。

```bash
# 主 Agent 默认全部拒绝，查看当前可选的六项行为
python -m nyra eigenflux policy show

# 查看群聊 alpha 中 lead 机器人自己的限制
python -m nyra eigenflux policy show --room alpha --bot lead

# 显式记录允许其“将来在官方授权后”读取 Feed 的本地意向
python -m nyra eigenflux policy allow --room alpha --bot lead --capability feed_read --confirm

# 取消上面的本地意向
python -m nyra eigenflux policy deny --room alpha --bot lead --capability feed_read

# 查看该机器人本地变更记录
python -m nyra eigenflux policy audit --room alpha --bot lead
```

只接受固定行为：`feed_read`、`public_broadcast`、`direct_message`、`relationship_request`、`recurring_check`、`profile_prefill`。每次 `allow` 必须明确 `--confirm`，不支持 `*` 或“所有行为”授权；`deny` 可以立即删除本地许可。支持用 `--expect-revision SHA256` 防止管理员依据过期状态修改。**本地 allow 意向并不允许实际执行这些网络行为**，`effective_network_permission`、`network_actions_enabled` 在本阶段始终为 `false`。官方网络授权、登录、宿主执行许可、公开发布前审核，仍必须分别成立。

权限存在 `~/.nyra/eigenflux/network-policy.json`：和各机器人 `EIGENFLUX_HOME` 凭据文件分离，使用私有文件权限、原子写入及 SHA-256 版本检查。记录最多 250 条非不可篡改的本地审计事件；同进程修改有锁，跨进程文件竞争仍需加强。群聊采用随机实例标记，删除后同 ID 重建不会继承旧组的网络权限或 EigenFlux Home；旧群聊保留原路径以兼容。

此功能尚未执行官方 EigenFlux CLI 的网络指令。即使设为 `allow`，也不会触发 `ef-onboarding`、自动读取 Feed、发布广播或设定周期任务；未来的网络执行网关必须在每次操作前再次核验本地上限和**独立的官方授权**。当前不声称可以控制用户在 Nyra 之外直接执行的 EigenFlux CLI。

## 快速开始

先把仓库克隆到本地，再进入仓库目录——下面所有命令都在这个目录里运行：

```bash
git clone https://github.com/js2005happy/nyra.git
cd nyra

# 一次性任务（需要先配置模型，见下）
python3 -m nyra "创建一个文件 hello.txt，写一句问候，再读回来汇报"

# 交互模式
python3 -m nyra

# 查看技能和历史会话
python3 -m nyra --list-skills
python3 -m nyra --list-sessions
```

## 两阶段计划模式（先审核，后执行）

先在项目工作目录生成计划，不直接修改代码：

```bash
python3 -m nyra --workdir . --plan "评估登录逻辑并列出修复步骤"
```

规划时只开放 `read_file`、`list_dir`，读取路径限制在工作目录内；不会调用 shell、MCP、E2B 或普通 Agent 会话。完成后仅生成 `plan.md`，输出完整 SHA-256 校验值。调用模型仍可能计费。

人工审阅 `plan.md` 后，复制完整 64 位 SHA-256，再批准该版本执行：

```bash
python3 -m nyra --workdir . --execute-plan --approve-plan 完整SHA256
```

计划任意字节修改都会使旧批准失效。**批准计划不等于跳过工具审批**：执行默认 `auto`，每次写文件或运行命令仍需同意；只有显式指定 `--mode full` 才免逐项确认。当前仅支持本地工作目录，不与 `--json` 混用。这不是操作系统沙箱，应人工审查改动范围和风险。

## Token 用量与上下文状态

Nyra 现在会统计模型 API **实际返回** 的 Token 用量。交互终端输入 `/status` 即可查看调用次数、输入/输出 Token、最近一次请求的输入长度及参考上下文余量；Web UI 右侧新增 **Token 用量** 状态面板。单次任务结束时，统计信息输出到 **stderr**，不污染 stdout 的任务结果，适合未来的脚本/JSON 模式。

```bash
python3 -m nyra --context-window 8192 "检查这个项目"
python3 -m nyra                 # 然后输入 /status
```

如果你知道当前模型官方的上下文上限，可以设置 `--context-window N` 或在 `~/.nyra/config.json` 中设置 `"context_window_tokens": 8192`（数字仅为示例，不是对任何模型上限的断言）。没配置时会明确显示 **未知**；如果 API 没有提供 usage 字段，也不会用字符数伪造精确 Token。**上下文参考余量**按最近一次请求的输入 Token 减去已配置窗口计算，不包含最新生成、下一轮新输入以及模型额外的保留量，因此不能当成严格的剩余可用 Token。累计值只统计当前 Agent 进程中的模型回复；历史会话重新载入不自动补算之前的调用。

后续迭代按 [ROADMAP.md](ROADMAP.md) 排序，下一项是基于真实用量和保守阈值的自动会话压缩。

## Poppy OAuth issuer 双向核验（第三阶段首个安全增量）

Nyra 可以在不需要模型 API Key、**不登录**的情况下，核验某个 Poppy 1.0 公司是否正确声明其 OAuth issuer：

```bash
python -m nyra --inspect-poppy-identity https://shop.example.com
```

检查顺序：先读取 Poppy 1.0 发现文件；再读取公司域名的 `/.well-known/oauth-protected-resource`，确认 `resource` 是该公司的**精确 HTTPS origin**；如有 OAuth issuer，再按 RFC 8414 读取 issuer 的 `/.well-known/oauth-authorization-server` 元数据，核验 issuer **精确匹配**、反向 `protected_resources` 包含公司域名，并检查 token/revocation 端点和 `refresh_token` 等必要声明。多个授权服务器时必须以 Poppy `auth.issuer` 明确选择，否则拒绝。

404 可以表明站点目前没有 issuer，但**只有确实得到 404 或合法的无 issuer 元数据**才允许以 signed-out-only 标记；超时、403、损坏 JSON、证书错误、issuer 未回指公司都必须失败，不得假装是游客模式。元数据读取继续使用公开 DNS/IP 检查、固定 IP + TLS 主机名验证、HTTPS、体积限制，并禁止跟随元数据重定向。

在显式 `--poppy` 下，模型新增只读 `poppy_identity_check` 工具，可查询元数据核验状态；默认不开放。输出 `issuer_link_verified` 仅说明**公开元数据归属双向验证**，并不说明用户已授权、OAuth 客户端注册完成、token 可用或 Poppy Session JWT 已签名。`session_ready`、`oauth_ready`、`remote_calls_allowed` 仍全部为 `false`。

**后续必要步骤**：实现私有密钥安全存储与 `private_key_jwt`、Poppy ES256 委派签名及 per-request JWT、真正的 OAuth 交互和 DPoP、带作用域检查和审批的 HTTP MCP 传输。不能将拼接的未签名 JSON 称为可用的 Poppy Session；完整加密实现可能需要经过审计的密码学依赖，不能为了纯标准库而自造加密算法。

## Poppy 站点权限账本：精确站点 × 身份 × Scope（第二阶段）

Nyra 新增**本地授权意向账本**，默认拒绝任何未登记的站点/身份/scope，所有修改只能由用户通过 `nyra permissions` 命令显式执行，Agent 只能只读查询。**这里登记的是用户本地偏好，不是 OAuth 同意、有效访问令牌、Poppy Session 或公司服务端的权限**。尚未建立远端调用通道，任何记录都不能让 Agent 直接执行远端操作。

```bash
python -m nyra permissions list
python -m nyra permissions check --site shop.example.com --scope orders:read
python -m nyra permissions grant --site shop.example.com --scope orders:read --account personal --confirm
python -m nyra permissions check --site shop.example.com --scope orders:read --account personal
python -m nyra permissions audit --site shop.example.com
python -m nyra permissions revoke --site shop.example.com --scope orders:read --account personal
```

不带 `--account` 是 `visitor` 访客身份，`--account personal` 表示本地名为 `personal` 的账户槽位，**不表示已经登录**。同一个站点的不同账户、不同 scope 和不同子域名严格隔离；没有通配符授权。`grant` 必须显式带 `--confirm`。`list` 返回账本版本 SHA-256，变更时可使用可选的 `--expect-revision` 拒绝过期写入。

存储位置是 `~/.nyra/poppy/permissions.json`，文件按最小本地权限保存，记录最近 300 次授权/撤销的有界审计事件，不保存密码或令牌。当前通过进程内锁和原子替换避免同进程交叉覆盖，跨多个 Nyra 进程仍可能竞争，这份审计记录**不是防篡改审计日志**。

使用 `--poppy` 时，Agent 只额外获得 `poppy_permission_check` 查询工具，不获得 grant/revoke 工具。Poppy 1.0 官方 `scope_hints` 描述的变更风险为 `none`、`reversible`、`irreversible`；未知风险值按不可逆处理，缺失 `personal_data` 按未知处理。即使网站宣称风险很低，也不能代替用户批准。以后实现 OAuth/HTTP MCP 时，仍必须独立核验访问令牌实际 scopes、账户与会话，写入或未知风险操作要逐次人工审批。

## Poppy 1.0 公共协议发现（默认关闭，第一阶段）

Nyra 的 Poppy 适配采用**先发现、再授权、最后调用**的渐进架构。当前第一阶段是纯标准库只读发现：读取站点 `https://域名/.well-known/poppy.json`，校验 `protocol_version`、实际提供文件的域名和规范要求的重定向终点，列出公司 Agent、MCP、OpenAPI、网页渠道与公开 scope 描述。**不创建 Poppy Session、不执行 UCP 购物、不调用所声明的远端 MCP/API，也不尝试 OAuth 登录。**

在终端直接检查网站，不需要模型 API Key：

```bash
python -m nyra --discover-poppy https://example.com
```

显式允许 Agent 先检查结构化发现，再按原有网页搜索/读取方式完成信息任务：

```bash
python -m nyra --poppy --mode readonly "查看 example.com 的公开能力和商品信息"
```

默认没有 `poppy_discover` 工具；必须在命令行指定 `--poppy`。`--json --poppy` 也支持该只读工具。标准 Poppy 1.0 的 HTTP Streamable MCP、Session JWT、OAuth issuer 归属验证、权限账本及 UCP 行为**尚未实现**，因此工具只列出能力，不把广告中的端点自动接入现有 stdio MCP 客户端。发现结果来自第三方站点，是不可信数据。

安全边界：只接受 HTTPS 及默认 443 端口的公共 DNS 域名；拒绝内网/回环/保留地址、URL 用户名密码、非 HTTPS 重定向，TLS 使用原始主机名验证证书且连接到已检查的公开 IP。规范允许跨主机重定向，但最终地址必须是精确 `/.well-known/poppy.json` 且无查询参数；备选版本的文档只允许同主机且不可重定向。文件最大 128 KiB，最多 4 次重定向。只实现标记为 1.0 的文档（支持从首选旧版发现同主机 1.0 备选）；其他不兼容版本会拒绝。

本次防护不意味着完整网络沙箱或完成了 Poppy 1.0 所需的 OAuth、签名、Session 等安全校验。未来将按协议版本继续迭代，并在用户授权后接入远端 HTTP MCP；不可用时沿用已有 `web_search`/`web_fetch`，没有浏览器操作时不声称能自动用浏览器兜底。

## 长期记忆浏览器（Web UI）

Nyra 的 `MEMORY.md` 不属于会话 JSONL：每个新会话都可重新读取长期记忆，手动 `/compact` 和自动上下文压缩不会改写这份文件。**需要注意：Agent 当前通常只将长期记忆的最后 40 行注入模型提示词，并非所有历史记忆都会同时被模型使用。**

启动 `python3 -m nyra ui`，点击顶部 **长期记忆**，即可选择「Nyra · 全局记忆」或已经创建的群聊中某个机器人，浏览完整的 Markdown 记忆文本。全局文件在 `~/.nyra/MEMORY.md`；群聊机器人各自保存为 `~/.nyra/groups/<群ID>/bots/<机器人ID>/MEMORY.md`，互不共享。

网页可直接编辑、清理和保存当前机器人记忆。每次读取返回整个文件的 SHA-256 版本号，保存时必须提交该版本：如果另一个 Agent 在此期间追加了记忆，服务器返回 **409 冲突**并保留原有数据，绝不会默默覆盖。跨同一个 Python 进程的 `memory_append` 和网页保存使用共享锁；多进程同时写入尚无跨进程锁，建议同一记忆文件只运行一个 Nyra 实例。

接口通过原有 Web UI 随机 token 和本机 Host 检查保护；不在模型信息、会话列表等无关 API 中泄漏记忆内容。记忆仅支持 UTF-8，网页编辑器每文件上限 64 KiB，已有符号链接记忆文件不可被网页读写。修改后请手动保存，新的长期记忆在下一次 Agent 请求中生效；敏感记忆请不要复制到公开聊天或截图中。

## 记忆模式：读别的 agent 的记忆

Nyra 能读别的 agent 的记忆，照 Muse 的记忆导入模式做，分快照导入/导出和聊天导入两种，外加配对读记忆和本地读取——全部只读、只追加，导入前先脱敏。

**快照导出/导入**：`python3 -m nyra.memory_exchange export` 把自己的记忆导出成固定五章（身份 / 事实 / 偏好 / 目标与承诺 / 关系）的 Markdown 快照，无可靠信息的章节省略；`export-prompt` 打印一段提示词，贴到别的 AI 聊天里，让对方按同样格式输出快照；`import [FILE]`（不给文件就读 stdin）把快照合并进 `~/.nyra/MEMORY.md`，只追加不覆盖，已存在的内容跳过。导出与导入两端都先脱敏：含密码、密钥、token 的行直接删掉并计数。

**配对读记忆**：跟另一台 Nyra 配对成功后，`python3 -m nyra.memory_exchange peer <配对码> [HOST PORT]` 读对方的记忆快照并导入。宿主提供 GET /memory（须 Bearer token，返回脱敏后的快照）；客人侧再脱敏一次。只在可信网络用，配对规则见配对码协作一节。

**本地读取**：`python3 -m nyra.memory_exchange local codex` 读本机 `~/.codex/memories_1.sqlite`（只读打开；本机 Codex 版本没有 memories 表，记忆在 stage1_outputs.raw_memory 里，两种结构都支持）；`local claude` 读 `~/.claude/CLAUDE.md` 与 `MEMORY.md`；`local dir <目录>` 读指定目录下的 MEMORY.md / AGENTS.md / CLAUDE.md。找不到文件或库里没有内容时报“未找到”，不编造。读到的内容转成快照文本，走同一条导入合并路径。

**聊天导入**：`python3 -m nyra.memory_exchange import-zip FILE.zip` 支持 ChatGPT / Claude 的聊天导出（conversations.json）。只做清单与存档：解析出对话（标题、日期、消息数），原文存到 `~/.nyra/memory-imports/<日期>-<来源>/`，MEMORY.md 里只追加一行导入记录。不做自动事实提炼（那需要模型调用，会编造），提炼以后用知识库的 ask 做。

## 多机器人群聊（Python 核心 + JavaScript 界面）

启动原有本地网页界面：

```bash
python3 -m nyra ui
```

在网页顶部点击 **机器人群聊**，点击 **新建群**。默认会创建组长、架构师、开发者、审查员四个独立机器人；可以在创建时分别指定模型提供商和模型 ID。每个机器人拥有自己的 system 指令、会话历史、长期记忆与工作目录，而不是一个模型分饰多角。

- 在群里直接发送任务：所有成员分别表达看法、提出方案，可以相互反驳。
- 用 `@architect`、`@builder` 等定向分工，只唤醒指定机器人；也可以同时 @ 多位。
- 显式选择 1 或 2 轮群内讨论，最多 6 位成员，每位机器人单次最多 3 轮模型调用。
- 默认机器人均为 `readonly`，防止创建群聊就自动在本机执行命令。**本版本可进行独立分析和只读工具调用，不具备无人值守自动修改项目或后台并行执行能力。**
- 用户主动发送群消息才会触发模型 API 费用。模型未配置或失败会在群消息中标记错误，绝不伪造执行成功。

数据保存在 `~/.nyra/groups/<群 ID>/room.json` 和对应成员的 `bots/<成员 ID>/` 私有目录；每个成员的会话是独立的 `~/.nyra/sessions/group-<群 ID>-<成员 ID>.jsonl`。群消息是共享上下文，但各机器人的记忆文件相互独立。浏览器群聊交互单独使用 `nyra/group-ui.js` 和 HTML/CSS，复用现有 Python Agent 核心与 HTTP API，而不是把整套系统强行写成一种语言。该目录隔离不是操作系统沙箱。

**群聊安全说明**：不要把群内的 AI 建议当成已经实际执行的操作。当前默认只读、限制讨论轮次和模型调用；多 Agent 写文件权限、任务队列、并行调度和人工审批将分阶段实现。群聊页面与 API 继续使用 Nyra Web UI 的本地监听及访问 token 机制。

## 配置模型

Nyra 支持任何 OpenAI 兼容接口。配置方式按优先级：命令行参数 > 环境变量 > `~/.nyra/config.json`。

| Provider | 环境变量 | 默认模型 | 说明 |
|---|---|---|---|
| deepseek（默认） | `DEEPSEEK_API_KEY` | `deepseek-flash` | 便宜，适合日常任务；`deepseek-v4-pro` 更强 |
| xai（Grok） | `XAI_API_KEY` | `grok-4.3` | |
| openrouter | `OPENROUTER_API_KEY` | `nousresearch/hermes-4-14b` | 可用 Hermes 等开源权重模型 |
| ollama（本地） | 无需 Key | `qwen2.5:7b` | 需本地跑 Ollama |
| openai | `OPENAI_API_KEY` | `gpt-4o-mini` | |
| qwen（通义千问） | `DASHSCOPE_API_KEY` | `qwen-plus` | 阿里 DashScope 兼容模式 |
| kimi（Kimi） | `MOONSHOT_API_KEY` | `kimi-k3` | 月之暗面，中国区 endpoint |
| glm（智谱） | `ZHIPU_API_KEY` | `glm-5.3` | 智谱 BigModel 兼容模式 |
| gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` | Google OpenAI 兼容端点 |
| mistral | `MISTRAL_API_KEY` | `mistral-small-latest` | |
| groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | 极快推理，免费额度 |
| together | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | 一个 Key 用上百个开源模型 |
| custom | `NYRA_API_KEY` + `NYRA_BASE_URL` + `NYRA_MODEL` | — | 任意兼容接口（环境变量方式） |
| codex | 无需 Key（本机 Codex 登录态） | `codex-default` | 调用本机 `codex` CLI，复用 ChatGPT 订阅；不调模型 API |

### 自定义 provider 与列出模型

上面没有的模型也能接：只要它走 OpenAI `/v1/chat/completions` 协议，在 `~/.nyra/config.json` 的 `custom_providers` 里加一条就行，Key 只从环境变量读，不写进配置：

```json
{
  "custom_providers": {
    "myllm": {
      "base_url": "https://llm.example.com/v1",
      "default_model": "myllm-1",
      "env_key": "MYLLM_API_KEY",
      "models": ["myllm-1", "myllm-2"]
    }
  }
}
```

- `base_url` 和 `default_model` 必填，且 `base_url` 必须是 http/https；`env_key` 是存 Key 的环境变量名（不填则无需 Key，或用 `NYRA_API_KEY`）；`models`、`allowed_hosts` 可选；未知字段会被忽略。
- 明文 `http://` 只允许本机地址（`localhost`、`127.0.0.1`、`::1`，比如本机 Ollama），外网地址必须用 `https://`——否则 API Key 会随请求明文发出去。写了外网 `http://` 会在解析配置时直接报错并提示改用 `https://`；即使绕过配置解析直接构造 provider，`chat()` / `list_models()` 发请求前也会再拦一次。环境变量方式的自定义（`NYRA_BASE_URL`）同样受这条规则约束。
- 同名自定义会覆盖内置预设（比如自己搭的 DeepSeek 兼容代理可以覆盖 `deepseek`）；写错的自定义（缺 `base_url`/`default_model`、协议不是 http/https）会在解析时直接报错并点名，不会静默失效。
- 自定义 provider 可以进 fallback 链：`"fallback_providers": ["myllm", "deepseek"]`，或环境变量 `NYRA_FALLBACK_PROVIDERS="myllm,deepseek"`。
- 某个 provider 需要 Key 但环境变量没设时，Nyra 会直接报“未设置 API Key”并提示配置，不会先发一个无认证的请求再等服务端 401。
- 列出可用模型：`python3 -m nyra --list-providers` 看全部 provider 与默认模型；`python3 -m nyra --provider qwen --list-models` 问该 endpoint 的 `/models` 接口拿实时模型列表（需要 Key，Ollama 本地不用）。

也可以直接用已保存的连接器凭证：DeepSeek 和 xAI 的 Key 已通过安全流程保存，**不用再填 Key**，直接用：

```bash
python3 -m nyra --provider deepseek "做点什么"
python3 -m nyra --provider xai --model grok-4.5 "做点什么"
```

发往本机地址（如本地 Ollama 的 `localhost:11434`）的请求总是直连，不受 `HTTP_PROXY` / `HTTPS_PROXY` 影响；其他地址照常遵守代理设置。

Key 只从环境变量或已保存的连接器读取，**绝不会**打印、记录或写进项目文件。配置存在 `~/.nyra/config.json`（不含任何 Key）。

### Codex CLI provider（不用 API Key）

`--provider codex` 不调任何模型 API，而是用子进程跑本机装好的 `codex` CLI（`codex exec` 非交互方式），复用它自己的登录态与 ChatGPT 订阅：

```bash
python3 -m nyra --provider codex "做点什么"
```

- **模型**：默认模型名是 `codex-default`，意思是“不传 `-m`，让 CLI 用自己的默认模型”。实测：ChatGPT 订阅登录时 `-m gpt-5` 与 `-m gpt-5-codex` 都会被服务端以 `model_not_found` 拒绝（“The 'gpt-5' model is not supported when using Codex with a ChatGPT account.”），唯有不传 `-m` 能跑通。`--model` 显式指定别的模型时会原样传 `-m`，被服务端拒绝时报配置错误（不兜底、不重试去烧别的 Key）。
- **固定提示前缀（缓存命中）**：每次请求的最开头都会先拼一段字节级固定的英文前缀（`providers.py` 的 `CODEX_PROMPT_PREFIX`），再接按 `[role]` 标记序列化后的消息。前缀内容是身份与边界声明——“You are Nyra, a text-only assistant. Reply in the user's language, concisely and directly. Do not call tools, run commands, browse the web, or modify files. Answer with text only.”——因为它在每个请求里一字不变、又始终在最前面，提供商侧的提示缓存能直接命中这段公共前缀，重复调用时只算增量 token。注意：前缀只做文字模型的身份与行为约束，不传任何工具 schema；`codex exec` 本身没有“纯聊天模式”开关，仍跑自己的 agent 循环，真正的硬约束靠只读沙箱与临时工作目录（见下）。
- **调用方式**：固定 argv——`codex exec --json -o <临时文件> -s read-only -C <空临时工作目录> --ephemeral --skip-git-repo-check -c features.browser_use=false -c features.computer_use=false -c features.plugins=false`（默认模型时不加 `-m`）。prompt 走 stdin 传（不在 argv 里，`ps` 看不到）；成功时优先读 `-o` 文件里的最终消息，文件为空时回退解析 `--json` 的 JSONL 事件流；用量能解析到就记进 usage。超时由 Nyra 的 subprocess 侧强制（`codex exec` 没有 `--timeout` 参数），超时后杀掉整个进程组。
- **四个安全条件（代码里强制 + 测试覆盖）**：
  1. **只用固定路径**：`codex` 二进制只从固定已知位置解析（`/opt/hatch-image/bin/codex`、`~/.local/bin/codex`、`/usr/local/bin/codex`、`/usr/bin/codex`，Windows 再加两条固定候选），`shutil.which("codex")` 只是最后的兜底；绝不从配置、环境变量或用户输入里取路径（`NYRA_CODEX_PATH` 之类的变量会被忽略）。
  2. **不碰登录凭证**：绝不读取、复制或记录 `~/.codex/auth.json` 之类的 CLI 凭据文件；登录检查只跑 `codex login status`，只读退出码与 “Logged in” 标记（实测该标记走 stderr）。子进程环境会删掉全部 `*_API_KEY` 变量，CLI 只靠自己 HOME 下的登录态。
  3. **不用跳过审批的参数**：绝不传 `--dangerously-bypass-approvals-and-sandbox`、`--approve-for-me`、`--dangerously-bypass-hook-trust`、`-y`、`--full-auto`；argv 建好后会自检，含禁用参数直接拒绝。调用始终是 `-s read-only`，工作目录是每次新建的空临时目录，用后删除。
  4. **不进兜底链**：只能被显式选中（`--provider codex`、配置、`POST /api/provider`），绝不作为兜底目标；`resolve_fallback_chain("codex")` 只返回 `["codex"]`，链里出现 codex 会被跳过并记日志；定时任务与队列里绝不用——`Provider` 的直接构造在 auth 为 CLI 时会被拒绝，全仓库唯一的直接构造点正是定时任务的 `_make_task_agent`，所以定时任务选 codex 时会在启动前就报错。
- **Claude 待办**：本轮只做了 Codex。Claude CLI（`claude`）尚未装到本机，且须先在用户电脑（Windows）上核查 `claude --version` 与登录情况，核查完再按同一套约束接进来。

### Worker 协议 v1（混合 Go 迁移第 1 批）

Go 侧将来用子进程 + stdio JSONL 拉起 Python worker，跑一个 Agent 会话。协议有版本号（`PROTOCOL_VERSION = 1`），完整格式见 `nyra/worker_protocol.py`；入口在 `nyra/worker.py`：

```bash
python3 -m nyra.worker [--session ID] [--workdir DIR] [--provider NAME] [--model MODEL] [--mode MODE] [--max-turns N]
```

- **通道**：请求走 stdin（一行一个 JSON），事件走 stdout（一行一个 JSON），日志走 stderr。Go 只负责传话，不做任何决定。
- **请求**：`run`（`{prompt, session_id?, workdir?, provider?, model?, mode?, max_turns?, id?}`）、`approval_decision`（`{approval_id, approved}`）、`stop`、`ping`。`run` 只在 worker 启动时指定的单 provider 上跑，绝不兜底、不进定时任务。
- **事件**：`run_started` / `run_completed` / `run_incomplete` / `run_failed` / `tool_start` / `tool_result` / `assistant` / `final` / `usage` / `approval_request` / `approval_result` / `model_switch` / `turn_limit` / `pong` / `error`。`approval_request` 的 `details` 里不含工具参数、不含执行结果。
- **审批**：决定权永远在 Python 的 `tools.py`。worker 的 `approve_fn` 只把宿主（人）做的决定传进去，自己绝不批准；审批超时 600 秒、无匹配的决定、协议异常、stdin 关闭，一律按拒绝处理，绝不默认放行。
- **入口形式**：设计文档写的是 `python3 -m nyra worker`（空格形式），但那要改 `nyra/__main__.py` 或 `nyra/cli.py`，第 1 批只新增文件、不改现有入口与冻结文件，所以先用模块形式 `python3 -m nyra.worker`，行为完全一致；空格形式等冻结解除后补，协议不变。

### 模型自动兜底

主模型调用失败时，Nyra 可以自动按链切换到下一个模型重试一次，不用手动换模型。默认链是 DeepSeek flash → Grok → 本地 Ollama（主模型始终排第一，每次调用都从主模型开始试）。

- 会兜底的失败：余额不足（402）、限流（429）、服务端错误（5xx）、超时、网络错误。
- 不会兜底的失败：认证失败（401/403，换模型也解决不了）、配置问题（没设 Key、响应无法解析等）。
- **默认关闭**，只由用户自己开启（三选一）：`~/.nyra/config.json` 里设 `"fallback_enabled": true`；环境变量 `NYRA_FALLBACK=1`；单次加 `--fallback`。关闭方式：`"fallback_enabled": false`、环境变量 `NYRA_FALLBACK=0`，或单次加 `--no-fallback`（`--fallback` 与 `--no-fallback` 同时给时，以关闭为准）。
- 允许列表：只切换到 `fallback_providers` 里列出的服务商。改链：`~/.nyra/config.json` 里设 `"fallback_providers": ["deepseek", "xai", "ollama"]`，或环境变量 `NYRA_FALLBACK_PROVIDERS="deepseek,xai,ollama"`（逗号分隔，主模型自动排第一；未知名字会被跳过并记一条日志；显式写空列表表示不允许任何备用，不会静默补默认链）。链里写了未配置 Key 的服务商时也会被跳过并记日志。备用模型用各自的默认模型；自定义 provider 的名字也可以写进链里。
- 每次切换都会明确提示：命令行走 stderr（一次性任务的 stdout 仍只有答案），例如：`模型切换：ollama 失败（网络错误……），已切换到 deepseek 继续`；`--json` 在输出里发 `model_switch` 事件；网页聊天流里出现一行“模型已切换：deepseek → xai（402 …）”并刷新模型卡；群聊里机器人的回复下方同样显示切换提示。
- 全部备用模型都失败时，报错会列出每个模型失败的原因，不会静默失败。
- 已接在命令行入口（交互 REPL、一次性任务、`--plan`）、`--json` 单次模式、网页界面和群聊：主模型遇可恢复失败时都按同一条链切换。`--json` 会在输出里如实写清最终用了哪个 provider（`run_started` 是起跑的主模型，`run_completed` / `run_incomplete` 是实际答复的模型，另有 `model_switch` 事件和 `model_switches` 列表）；网页界面的信息面板同样显示实际答复的模型与切换记录。定时任务与队列里不切换：定时任务仍用单个 provider（`cli.py` 的 `_make_task_agent` 直接构造 `Provider`，调度器正在另一路开发中，本轮未碰）。

## apply_patch 补丁编辑与 /diff

Nyra 增加了 `apply_patch` 工具：严格使用单文件 unified diff 编辑已存在的**本地文本文件**。补丁必须包含 `--- a/相对路径`、`+++ b/相对路径` 和 `@@ -旧行号 +新行号 @@`，每行原文上下文必须准确匹配，不允许猜测匹配、越界写入或一次修改多个文件。

工具示例：`path="src/sample.py"`，`patch` 的内容：

```diff
--- a/src/sample.py
+++ b/src/sample.py
@@ -1,2 +1,2 @@
 print("start")
-print("old")
+print("new")
```

在交互式 `auto` 模式中，`apply_patch`、`write_file`、`edit_file` 与普通 `plan` 本地修改的审批摘要现在会展示统一格式的修改前后 diff。网页审批卡片可保留换行并滚动查看。预览最多 6000 字符；源文件或结果超过 128 KiB 时，为避免高成本 diff 计算会显示明确的“无法预览”提示，不能当作已经完整审核。补丁每次均需审批，不继承其他文件工具的长期授权。审批日志可能含文件内容，请勿将其随意公开。

终端新增 `/diff`，用于查看本会话**最近一个未撤销检查点**的变更；遇到外部修改会显示冲突，不把他人的文件修改误记为 Nyra 的成果。补丁与已有检查点兼容，可以随后使用 `/undo`。

当前只支持本地已有文本文件。新建/删除文件、重命名、多文件补丁、远程 E2B 补丁、OS 级隔离和跨文件原子提交尚未实现；`/diff` 不是完整 `git diff`，无法追踪 Shell、MCP、HTTP 等外部副作用。

## 写入前检查点：/undo 与 /rewind

交互式 Nyra 现在会对**本地**内置文件工具 `write_file`、`edit_file`、`plan` 自动建立任务检查点：在一次用户任务首次修改某文件时保留原始字节（包括原先不存在的文件），同一任务后续写入仅更新最终文件哈希。检查点按会话和工作目录隔离，保存在 `~/.nyra/checkpoints/`，不需要安装插件。

```text
/undo           # 撤销最近一轮任务中的这些本地文件修改
/rewind 3       # 撤销最近三轮，先全部检查，发现冲突则不改动任何文件
```

撤销前逐文件验证目前的内容哈希仍与 Nyra 最后写入时一致。如果文件被用户、另一个机器人或外部进程修改，操作会**拒绝执行，不覆盖外部修改**。撤销创建的文件时删除该文件；覆盖原有文件时恢复原始二进制字节；其他文件不受影响。单个检查点最多包含 20 个文件，单文件最大 2 MiB，最多保留 20 个未撤销的检查点，`/rewind N` 每次最多 10 轮。超出限制时，Nyra 拒绝带检查点的文件写入，以免生成无法安全恢复的修改。

撤销后会在当前会话记录一条提示，提醒模型之前的工具成功记录已失效；不会自动改写此前所有消息。`/new` 启动不同会话的检查点集合，`--resume` 在相同工作目录下可继续使用之前保存的检查点。

**不能撤销的范围**：Shell（包括它启动的子进程）、MCP、HTTP 请求、远端 E2B、memory/skill 文件、其他 Agent 以外的外部副作用；原子文件替换也不能保证多个文件一起恢复时绝对不发生系统故障。检查点不是完整备份或 OS 沙箱，建议结合 Git 版本控制。

## 精确文件与 Shell 授权（安全加固）

交互式 `auto` 的 `a`（本次会话始终允许）现在仅对**同一文件、同一种工具**生效；路径在授权前被规范化，因此相同文件的等价相对/绝对路径不需要重复审批，其他文件仍要重新批准。对于 shell，缓存授权绑定**完全相同命令文本、规范化起始目录、超时时长、执行后端及工作区**。换目录、换后端、提高超时不会沿用旧授权；Web UI 的逐项审批回调始终优先于终端缓存。Web UI 的“本会话始终允许”用同样的范围，但单独记账：终端的授权不会放行网页审批，网页的授权也不会放行终端。

shell 的起始 `cwd` 现在必须位于 `--workdir` 内；绝对外部路径、`../` 和现有指向外部的符号链接会在执行与人工审批前拒绝。**这只限制 shell 从哪里启动**，命令内部仍可以通过 `cd`、绝对路径、重定向或其他程序访问工作目录之外。它不构成 shell/OS 沙箱；后续仍需进程隔离和工具执行审计。

## 工作目录写入边界与本次会话批准

`write_file`、`edit_file`、普通 `plan` 文件工具现在**默认**拒绝写到 `--workdir` 外部，`full` 也不能绕过。这包括绝对外部路径、`../` 越界及已有指向外部的符号链接；合法的工作目录内路径仍可使用。E2B 的写入路径也会进行 POSIX 路径归一化和词法范围检查。

在交互式 `auto` 模式下，每次文件写入或 shell 命令会提示 `[y/N/a]`：`y` 仅批准一次，`a` 表示**本次会话始终批准**此种文件工具（write_file/edit_file/plan 按具体工具分别记录），或者 shell 的**完全相同命令字符串及 cwd 工作目录**。不把一个 shell 前缀视为可任意执行的白名单；MCP、HTTP POST、记忆与技能操作继续逐次审批。`/new`、`/clear`、`/mode` 切换会清除会话批准；后台非交互 `auto` 和 `readonly` 绝不会因为缓存批准而执行写入。网页审批仍按每次工具调用请求授权。

**边界说明**：工作目录写入检查只覆盖上述内置文件工具，不限制已有的 `shell` 在执行时使用绝对路径、改变目录或启动其他程序；`memory_append`、`save_skill` 和证据/会话存储本来就会写入 Nyra 的专用数据目录，属于已知例外。E2B 的词法检查无法识别远端符号链接，检查与写入之间也可能存在竞态，因此这不是完整操作系统沙箱。需要运行不可信代码时，使用受保护的隔离环境，并继续审阅命令。更强的 shell 沙箱与精确命令白名单列在后续安全迭代。

## 审批模式

| 模式 | 行为 |
|---|---|
| `readonly`（只读） | 只能读文件、联网查资料，不能写文件、执行命令 |
| `auto`（默认） | 写文件/执行命令前请你确认（`[y/N]`）；非交互运行时（如 cron）不会悄悄写入，必须加 `--mode full` |
| `full`（全权） | 不确认，直接执行；适合你明确信任的任务和后台运行 |

```bash
python3 -m nyra --mode readonly "看看这个目录里有什么"
python3 -m nyra --mode full "整理下载目录"
```

**MCP 内置预置**：Nyra 自带 10 个预配置的 MCP 服务器，不用手写 `mcp_servers`。只要在 `~/.nyra/config.json` 里设 `"mcp_enabled": true`，默认就开 memory（知识图谱记忆）、sequential-thinking（结构化思考）、fetch（抓网页转 Markdown）、time（时间与时区）这 4 个；想多开就在 `mcp_presets` 列表里加名字：github（需 `GITHUB_PERSONAL_ACCESS_TOKEN`）、brave-search（需 `BRAVE_API_KEY`）、filesystem / git / sqlite（需在 `mcp_preset_args` 里给路径，如 `{"filesystem": ["D:/docs"], "git": ["D:/repo"], "sqlite": ["D:/data.db"]}`）、puppeteer（首次使用下载 Chromium）。fetch、git、time、sqlite 走 `uvx`（需装 uv），其余走 `npx`（需装 Node.js）。memory 的知识图谱默认存到 `~/.nyra/memory.jsonl`（不在 npx 缓存里，缓存清了也不丢）。预置只给配置：MCP 默认关闭，`auto` 模式下每个服务器启动前仍逐一确认；密钥缺失或路径未给时该预置会被跳过并说明原因。`mcp_servers` 里写的同名条目会覆盖预置。github、brave-search、sqlite、puppeteer 是官方已归档的服务器（不再维护），已在预置说明里注明；sqlite 用 `mcp 1.30.0` 才能跑（新版 SDK 删了 resources 接口）。

**配对码协作**：两个 Nyra 可以配对后一起工作。宿主跑 `python3 -m nyra.pairing host`，屏幕上出现 6 位配对码（10 分钟过期、只能用一次、错 5 次作废）；客人在另一台机器上跑 `python3 -m nyra.pairing join <6 位码>`，配对成功后把任务发给宿主，宿主以只读模式跑完把结果传回来。任务只传文本与结果，不传任何凭据；配对只在你信任的网络里做（家里、办公室局域网），别在公共 Wi-Fi 上配对。

**本地密码箱**：不想把 API Key 写进配置文件或聊天记录时，用密码箱。`python3 -m nyra.vault init` 设一个主密码，`python3 -m nyra.vault add DEEPSEEK_API_KEY` 按提示输 Key（不会显示在屏幕或命令历史里），以后 Nyra 需要这个 Key 时：环境变量里有就用环境变量，没有就自动去密码箱里取——取之前要先解锁，设环境变量 `NYRA_VAULT_PASSWORD` 就是解锁（只在你自己的机器上这么做）。密码箱文件在 `~/.nyra/vault.json`，加密存放，别人拿到文件也打不开；但主密码太弱、机器本身被入侵时仍不安全，高价值密钥请用专业密码管理器。`vault get` 会在你自己的终端上打印出明文，只在你主动要看的时候用。

**本地知识库**：把喜欢的博主内容、文章、笔记收进知识库，再向它提问，Nyra 只按库里的内容回答、并注明依据了哪几条笔记，库里没有就直说不知道、不编造。数据全在本地 `~/.nyra/knowledge/<库名>/`（`kb.json` + `notes.jsonl`），标准库实现，不依赖第三方服务：

```bash
python3 -m nyra.knowledge create jianghushuo --description "个人成长、做事方法"
python3 -m nyra.knowledge add jianghushuo --file ~/docs/notes.md     # .txt/.md，也可 --dir 批量收
python3 -m nyra.knowledge add jianghushuo --url https://example.com/article   # 抓网页正文
python3 -m nyra.knowledge add jianghushuo --text "……" --title "赚钱核心三问题"  # 直接贴文本
python3 -m nyra.knowledge search jianghushuo "赚钱要明确什么"
python3 -m nyra.knowledge ask jianghushuo "赚钱核心三问题是什么？"
python3 -m nyra.knowledge list
```

收录时文本按标题与空行切成笔记（每条约 1500 字以内，带标题、来源、日期）；检索是本地 BM25（中英文分词）；提问默认走当前配置的 provider。注意：抖音视频链接本身拉不到完整文稿（视频页是 JS 渲染的，Nyra 只能拿到标题和描述），想把博主视频收进库，先把文稿/字幕文本贴进来，或用文章链接。跟 agent 主循环的自动调用（聊天时自动查库）等 A–E 合并后再接，现在先用命令行。

**MCP 启动环境隔离**：默认启动 MCP 子进程时，只传递运行所需的少量系统环境变量（如 `PATH`、`HOME`、Windows 系统路径等）和显式配置的 `env`，不再自动传递 DeepSeek/OpenAI 等 API Key。确实需要额外环境变量的服务器可以在各自的配置中明确声明 `inherit_env`。另外会透传去凭据后的代理变量（`HTTP(S)_PROXY`、`ALL_PROXY`、`NO_PROXY`）与受信 CA 变量（`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE` 等），否则公司网络或出口代理后面的机器首次下载 MCP 服务器会连不上；代理 URL 里嵌的密码不会传，代理必须认证的请在该服务器的 `inherit_env` 里显式声明完整 URL：

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

继续上一次会话：`python3 -m nyra --resume <会话 id> "继续"`。

## 终端界面（交互模式）

在终端里运行 `python3 -m nyra` 进入交互模式，界面分四块：

1. **启动头部**：左边是 4 行的 Nyra 小标志（实心圆里刻着光标），右边三行依次是 `Nyra v<版本>`、`<模型> · <provider> · <计费方式>`（API 计费 / 本地模型 / CLI 登录）和当前工作目录。终端窄于 60 列时只显示右边三行。
2. **工作区信任确认**：第一次在某个目录里运行时，先问“正在访问工作区：”这个目录是不是你自己创建或信任的项目——Nyra 可以在这里读取、修改和执行文件。用上下键或数字 `1` / `2` 选择，Enter 确认、Esc 取消：
   - `1. 是，我信任这个文件夹`：记下这个目录（`~/.nyra/trusted_workspaces.json`，每个绝对路径一条，只认这个目录本身、不含子目录和上级目录），以后在这里不再问；
   - `2. 否，退出`（Esc、Ctrl+C 同样算“否”）：Nyra 直接退出，什么都不记。
   信任只决定 Nyra 能不能在这里启动，**不会放宽审批模式**：信任之后 readonly / auto / full 的规则照旧。想跳过确认：加 `--trust`（信任并记录当前目录），或在 `~/.nyra/config.json` 里设 `"skip_workspace_trust": true`。非交互运行（标准输入或输出不是终端、`--json`、定时任务、任务队列 worker）从不弹确认，行为和以前一样；E2B 沙盒里的目录是远端路径，也不问。
3. **输入框**：上下两条随终端宽度的横线夹着 `> ` 输入行。左右键 / Home / End 移动光标，上下键翻历史，Ctrl+U 清到行首，Ctrl+K 清到行尾，Ctrl+W 删一个词，Ctrl+L 清屏；有内容时 Ctrl+C 清空输入，空行时 Ctrl+C 或 Ctrl+D 退出。超出宽度的输入横向滚动，中文按两列宽计算。
4. **状态栏**（输入框下方）：
   - `[模型] │ 项目名`（项目名取工作目录名；在家目录时显示用户名）；
   - `上下文 N%`：最近一次请求的输入 token ÷ 已配置的上下文窗口（`--context-window` 或配置里的 `context_window_tokens`）。两个数有一个不知道就不显示，不估算；
   - 当前审批模式，如 `›› auto 逐项确认（shift+tab 切换）`。**shift+tab** 按 readonly → auto → full → readonly 循环；从 auto 进 full 要连按两次：第一次只显示红色警告“再按 shift+tab 进入 full”，按其他任意键取消；处于 full 时整行红色提示“全权模式：写文件与执行命令不再逐项确认”。用 shift+tab 切换与 `/mode` 完全一致（同样重启 MCP 子进程、清空本次会话的逐项批准）。
   推理强度、计划模式等状态目前交互内核不支持，所以不显示。

界面文字默认中文；在 `~/.nyra/config.json` 设 `"language": "en"` 或环境变量 `NYRA_LANG=en` 改为英文。颜色只用黑白加少量强调色（模型青色、项目与标题金色、full 红色），设置 `NO_COLOR=1` 只去掉颜色、布局不变。

**自动退回纯文本**：标准输入或输出不是终端、`TERM=dumb`、Windows 控制台不支持 ANSI（VT）序列，或设置了 `NYRA_TUI=0` 时，交互模式退回原来的纯文本界面：NYRA 字标横幅（版本、模型、审批模式、会话 id），提示符上方一行状态 `[模型] | 目录 · 上下文 n% · 模式`（上下文未知时显示 `--`），提示符 `nyra[auto] ›`，用 `/mode` 切换模式。终端编码不能显示方块字符时（如旧代码页）自动改用 ASCII 线条和标志。

**跨平台**：macOS / Linux 用标准库 `termios` 读按键，Windows（PowerShell、Windows Terminal、cmd）用 `msvcrt` 并打开控制台的 VT 模式；零第三方依赖。

每次工具调用按 `┌ 工具名 参数` / `└ ✓/✗ 结果摘要` 分组显示。一次性任务（`python3 -m nyra "任务"`）的输出保持不变；在终端里第一次对某个目录跑一次性任务同样会先做信任确认。

## 自定义命令与 /init

把常用提示词存成命令文件，随时用斜杠调用，不用每次重打：

```bash
# 用户级：~/.nyra/commands/review.md
# 项目级：<工作目录>/.nyra/commands/review.md（同名时项目级优先）
```

文件是 Markdown，可带 frontmatter（`description:`、`argument-hint:`），正文就是发给模型的提示词模板；`$ARGUMENTS` 替换成命令后输入的全部文字，`$1`、`$2`……替换成第 1、2……个词；正文里没有占位符时，参数自动追加到正文末尾。示例 `review.md`：

```markdown
---
description: 审查代码并列出问题
argument-hint: <文件>
---
审查以下代码并列出问题：$ARGUMENTS
```

REPL 里直接用：`/review src/main.py`。`/commands` 列出当前可用的自定义命令（含来源：项目级/用户级）。内置命令优先于同名自定义命令；命令文件只是提示词，不能自己跑代码、读文件或改设置；符号链接的命令文件会被跳过。

`/init` 在当前工作目录生成一份 `AGENTS.md` 起始模板（项目简介、常用命令、约定、注意事项四节，带填写提示）。`AGENTS.md` 已存在时不覆盖。写入走正常的 `write_file` 工具：要过审批、工作目录边界和检查点，readonly 模式下拒绝。

## 网页界面

```bash
python3 -m nyra ui            # 启动后打印带 token 的链接，在浏览器打开
python3 -m nyra ui --open     # 自动打开浏览器
python3 -m nyra ui --port 9000 --workdir ~/project --mode auto
```

本地网页界面，纯标准库 `http.server` + 一个内嵌的 HTML/CSS/JS 页面，不引用任何 CDN 或外部资源。桌面端 v2（黑白极简，2026-11-18，按已定稿的 macOS / Windows 设计稿实现；浅色/深色跟随系统；字体 Inter / JetBrains Mono 的拉丁子集随包内嵌，中文用系统字体）：

- **左侧栏**——新建会话（Ctrl/⌘ + Shift + O）、搜索会话（Ctrl/⌘ + K，在会话标题里筛选）、技能与工具 / 定时任务 / 机器人群聊 / 长期记忆入口，底部是设置。会话**按项目分组**：网页界面每跑一个会话就记下它所在的工作目录（`~/.nyra/sessions/ui-projects.json`），当前项目排在最前；命令行或旧版本留下的会话没有项目信息，如实列在“其他会话”，不猜。
- **对话流**——用户气泡、Nyra 的回复（基本 Markdown）；工具调用合成一组可折叠的步骤行（“读取 auth/client.py”“搜索 “http.post””“运行 …”），点开某行看参数与结果；运行中显示“正在工作 · Ns”，跑完显示“工作了 Ns · N 个步骤”（时间取自本次运行的事件时间戳，读历史会话时只有最近一次运行有计时）。一轮有文件改动时，回复后面出现改动文件卡（路径 + 增删行数），点一下跳到右侧改动面板。
- **审批卡片**——auto 模式下写文件、跑命令前在对话流里出现：标题是要做的事，下方是审批时的真实 diff；按钮为“拒绝 / 本会话始终允许 / 允许一次”。“本会话始终允许”与终端的 `a` 同一范围：只对同一文件的同类工具（`write_file` / `edit_file` / `plan`），或完全相同的命令 + 目录 + 超时（`shell`）生效，其他工具不显示这个按钮；授权只存在这个会话的内存里，和终端的缓存授权互不通用。10 分钟无人处理按拒绝处理。
- **底部输入框**——审批模式切换（只读 / 逐项批准 / 完整权限，任务运行中不能切）、模型选择（调 `POST /api/provider`，新会话生效，已有会话保持原模型）、**计划模式**开关：打开后发出的任务走与 `nyra --plan` 相同的只读规划（只用 `read_file` / `list_dir`，只写 `plan.md`），对话里出现计划卡片和 SHA-256；点“按计划执行”按校验值执行（`plan.md` 被改过就拒绝；只读模式不能执行），执行时仍按当前审批模式逐项确认。
- **顶栏与状态栏**——会话标题、运行状态（空闲 / 运行中 / 等待批准 / 出错）、“工作了 Ns”、本会话 Token 用量（入 / 出，模型没报告时不显示）；状态栏显示工作目录、模式、上下文占用（按最近一次输入 Token 估算）、MCP 状态。
- **审阅面板（右侧，Ctrl/⌘ + .）**——改动（本会话每个文件改动的 diff：有审批预览时用审批时的真实 diff 和行号，读历史会话时按工具参数还原，`edit_file` 只能显示替换文本、没有行号）、计划（最近一次 `plan` 工具调用）、证据（联网抓取的来源）、终端（本会话 `shell` 工具的命令与输出）、产物（代码 / HTML，HTML 只在沙盒 iframe 里渲染）、用量（Token 明细、自动压缩次数）。窄屏下面板改为覆盖层，Esc 关闭。
- **设置页**——provider 下拉 + 模型输入 +“应用”；审批模式三段切换；API Key 表只显示环境变量名和是否已配置——Key 只能在启动 `nyra ui` 的终端里用环境变量设置后重启，页面不输入、不显示、不保存 Key；运行配置只读。
- **技能与工具 / 定时任务 / 机器人群聊**——同前：技能与 24 个内置工具一览；定时任务查看、启停、删除（网页端新建暂缓开放，请用 `nyra schedule add`）；群聊列表与独立的 `/groups` 页面入口（`?room=<id>` 直达）。
- **可用性**——390px 手机宽度可用（侧栏抽屉、面板全屏覆盖）；全键盘可操作（Tab 顺序、审阅面板标签页左右方向键切换、焦点描边）；`prefers-reduced-motion` 时关闭所有动画；网页端没有开场动画。设计稿里内核还不支持的东西（diff 逐行评论、提交 / 在编辑器打开按钮、云电脑、终端实时输入）不做假按钮。

截图说明：`python3 -m nyra ui` 打开后，桌面宽度下默认是“侧栏 + 对话 + 审阅面板”三栏，对应设计稿的 macOS / Windows 主窗口；README 顶部的设计稿图里的数据是示例，实际界面只显示真实会话数据。

安全：默认只监听 `127.0.0.1`（`--host` 改成非本机地址时会打印警告）；每次启动随机生成一个访问 token，页面链接通过 `?token=` 带入，所有 API 请求都必须在请求头里带上它（防 CSRF），监听本机地址时还会校验 `Host` 头。网页界面目前在本地执行工具（不接 E2B 沙盒），会按配置启动 MCP 服务器（默认关闭）。

### 手机（PWA + 扫码配对）

```bash
python3 -m nyra ui --pair     # 监听局域网，终端里显示配对二维码
```

手机扫码（或在手机浏览器打开 `http://<电脑IP>:8765/m` 输入 6 位配对码）后，用一次性配对码换到这台手机专属的长期 token，之后可以“添加到主屏幕”当 App 用：会话列表、对话流、发任务，审批卡上大按钮“允许一次 / 本会话始终允许 / 拒绝”，diff 可左右滑动；有待审批时标题变 `(1) Nyra`、支持的系统上图标出角标（本地，不是推送）。也可以不加 `--pair` 正常启动后，在 **设置 → 手机** 点“连接手机”出码（前提是用 `--pair` 或 `--host` 监听了局域网）；同一处列出已配对手机并可撤销，命令行用 `python3 -m nyra.pairing devices` / `revoke <ID>`。

- 安全：默认仍只绑 `127.0.0.1`；配对码 6 位、5 分钟、一次性、错 5 次作废；`~/.nyra/devices.json` 只存 token 的 SHA-256；手机 token 不能再配对或撤销设备；CSP 不放宽；明文 HTTP，只在信任的 Wi-Fi 用，不要映射到公网。
- 入场动画只在手机上从主屏幕以独立窗口启动时播放（每次冷启动一次、约 3 秒、点一下跳过、“减少动态效果”时只淡入标志）；桌面网页、手机浏览器标签页、官网都不播。系统启动屏与动画首帧同为 `#0B0B0C`，不闪白。
- 如实说明：只用 Playwright 模拟 iPhone 14 / Pixel 7 跑通过，没有在真机上装过。安卓 Chrome 对 http 局域网地址可能只建快捷方式（以标签页打开、不播动画）；iPhone 主屏幕 App 的存储可能与 Safari 分开，需要在 App 里再输一次配对码。完整步骤见 [docs/mobile-pwa.md](docs/mobile-pwa.md)。

### 桌面 App（Tauri 外壳，预览）

`desktop/` 是 macOS / Windows 桌面 App 的源码：Tauri 2（Rust + 系统 WebView），不内置浏览器内核和 Python。打开后它在本机找能运行 Nyra 的程序（`NYRA_PYTHON` → `PATH` 上的 `nyra` / `nyra.exe` → Python 3.10+，必要时带上 `NYRA_SOURCE`、`~/.local/share/nyra`、`~/nyra` 源码目录），在后台运行：

```bash
nyra ui --host 127.0.0.1 --port 0 --print-url-json --exit-on-stdin-close --workdir ~/Nyra
```

- `--print-url-json`：标准输出第一行打印一行 JSON（`nyra`、`version`、`url`、`host`、`port`、`token`），其余提示改写到标准错误，供外壳读取地址；这行含 token，和打印的链接一样不要外传。
- `--exit-on-stdin-close`：标准输入关闭时停止服务（外壳退出或崩溃后不留后台进程）。
- 窗口只显示内置引导页和这次启动的 `http://127.0.0.1:<端口>`，其他链接交给系统浏览器；网页界面的 CSP 与 token 鉴权不变，网页拿不到 Tauri 原生接口；桌面端不播入场动画。
- 找不到 Python 3.10+ 或 Nyra 时显示安装引导和“重新检测”按钮。工作目录默认 `~/Nyra`（`NYRA_DESKTOP_WORKDIR` 可改）；macOS 从程序坞打开时会读一次登录 shell 环境，补上 `~/.zshrc` 里的 `PATH` 与 API Key。
- 安装包由 `.github/workflows/desktop.yml` 在 macos-latest（universal `.dmg`）和 windows-latest（`.msi` + NSIS `-setup.exe`）上构建，只在手动触发或推 `v*` tag 时运行，产物是 workflow artifacts，**未签名**：macOS 需右键“打开”或 `xattr -dr com.apple.quarantine /Applications/Nyra.app`，Windows SmartScreen 点“更多信息 → 仍要运行”。详见 [docs/desktop.md](docs/desktop.md)。

## 技能（Skills）

技能是 `skills/*.md` 文件（自带四个示例：`web-research` 网上调研、`file-organizer` 文件整理、`verify-research` 核查式调研、`deep-thinking` 深度思考十问），格式：

```markdown
---
name: web-research
description: 在网上搜索并核实信息
when: 需要查找最新信息时使用
keywords: 搜索, 查, 最新
---
这里是给 agent 的操作说明……
```

Nyra 会按任务关键词自动加载最相关的技能。你自己的技能存在 `~/.nyra/skills/`。任务完成后如果做法值得复用，Nyra 会用 `save_skill` 工具把它保存为新技能。

## 工具

Nyra 有 24 个工具：`read_file`、`write_file`、`edit_file`、`apply_patch`、`list_dir`、`shell`（带危险命令黑名单）、`web_fetch`、`web_search`、`memory_append`、`save_skill`、`delegate`（子 agent）、`plan`（先写计划再执行）、`grep_search`、`git_status`、`http_post`、`browser_navigate` / `browser_click` / `browser_screenshot`（CDP 浏览器）、`computer_screenshot` / `computer_click` / `computer_type` / `computer_key` / `computer_windows`（电脑操作，均需审批）、`multi_model_research`（多模型并行调研），以及默认关闭、需显式开启的 3 个 Poppy opt-in 工具：`poppy_discover`、`poppy_identity_check`、`poppy_permission_check`（只做公开协议发现与本地权限意向核验，不登录、不发交易）。

- **plan**：多步骤任务先写计划文件（默认 `plan.md`）再执行。
- **delegate**：把子任务交给一个子 agent（轮数受限），拿回摘要再继续。
- **memory**：长期记忆在 `~/.nyra/MEMORY.md`；项目说明读工作目录的 `AGENTS.md`（像 Codex 一样）。
- **会话**：每次运行自动保存到 `~/.nyra/sessions/<id>.jsonl`，可用 `--resume` 继续。

- **证据链**：联网抓到的页面原文存到 `~/.nyra/evidence/<会话 id>/`，引用网上信息时附上来源链接；核查类任务走 `verify-research` 技能（搜索→打开官网→逐项核对→存证→附链接交付）。
- **MCP**：默认关闭；在 `~/.nyra/config.json` 里设 `"mcp_enabled": true` 并配置 `mcp_servers` 后可用，`python3 -m nyra --list-mcp` 查看已加载的工具。stdio 管道在 Windows/Linux/macOS 上均支持超时处理。
- **Windows 终端编码**：旧代码页无法表示中文时，CLI/调度器会以 `\\uXXXX` 转义显示而不是崩溃。建议终端使用 UTF-8（如 PowerShell 设置 `$env:PYTHONIOENCODING="utf-8"`），以直接显示中文。
- **调度器**：`python3 -m nyra schedule list/add/remove/run/daemon`，见 `nyra schedule --help`。
- **会话压缩**：`python3 -m nyra --compact <会话 id>` 或 REPL `/compact`。
- **E2B 沙盒**（0.3.0）：文件读写与 shell 命令可以在 E2B 沙盒里执行，不碰本机：

```bash
pip install e2b   # 可选依赖，核心仍是标准库 only
export E2B_API_KEY=你的 Key   # 或在 Muse 里保存 E2B 连接器
python3 -m nyra --sandbox e2b --mode full "在工作目录写一个 hello.txt"
python3 -m nyra --sandbox e2b --sandbox-id <已有沙盒 id> "继续上次的工作"
```

沙盒模式下工作目录默认 `/home/user`；沙盒到期自动销毁（默认 1 小时，免费档上限），不主动删；`--sandbox-timeout` 可改（不超过 3600）。审批与 shell 黑名单在沙盒里同样生效。

## 测试

```bash
python3 -m unittest discover tests   # 964 个测试，全部使用 mock，无需 Key
python3 tests/test_smoke.py
```

真实 API 端到端测试记录见 [VERIFICATION.md](VERIFICATION.md)。

## 项目结构

```
nyra/
├── nyra/              入口：python3 -m nyra
│   ├── __main__.py    入口：python3 -m nyra
│   ├── cli.py         参数解析 + 交互 REPL + schedule 子命令
│   ├── agent.py       agent 主循环（plan → 工具调用 → 汇报）
│   ├── providers.py   OpenAI 兼容客户端（urllib）+ 模型自动兜底（FallbackProvider）+ 同模型多 Key 轮换（KeyRotatingProvider）+ 通用 provider 预设与 /models 发现
│   ├── commands.py    自定义斜杠命令 + /init 的 AGENTS.md 模板
│   ├── tools.py       24 个工具 + 审批 + shell 黑名单
│   ├── computer.py    电脑操作：三后端（Linux xdotool / Windows ctypes / macOS osascript+screencapture），截屏/点击/输入/按键/列窗口
│   ├── vision.py      视觉模型看屏：image part 拼装 + 模型是否带视觉判断（agent.py 接线等 A–E 后）
│   ├── multi_model.py 多模型调研：同一问题并行问多个模型，综合成共识/分歧/独特观点三节
│   ├── server.py      独立 API 服务器（http.server + SSE 流式事件，默认 127.0.0.1:8766）
│   ├── artifacts.py   Artifacts 富文本产物：存储、检测、Markdown 渲染
│   ├── conversations.py  sqlite 对话记忆：FTS5 全文检索 + 检索注入 prompt
│   ├── websocket.py   最小 WebSocket 客户端（标准库，供 CDP 用）
│   ├── cdp_browser.py CDP 浏览器客户端：导航/求值/点击/截图（只连本机 Chrome）
│   ├── banner.py      终端横幅：NYRA 四字母字标（11 行 × 42 列 `#`）
│   ├── untrusted.py   提示词注入防御：外部内容打标记 + 指令句拦截
│   ├── knowledge.py   本地 AI 知识库：收文本/文件/网页，分块存笔记，BM25 检索后交给模型回答
│   ├── mcp_presets.py 内置 MCP 服务器预置（默认 memory、sequential-thinking、fetch、time）
│   ├── pairing.py     配对码协作：两个 Nyra 用 6 位码配对，宿主只读跑任务
│   ├── memory_exchange.py  记忆模式：快照导入/导出、配对读记忆、本地读 Codex/Claude 记忆、聊天 .zip 导入
│   ├── vault.py       本地加密密码箱：PBKDF2 + HMAC-CTR，存 provider API Key
│   ├── worker.py      混合 Go 迁移第 1 批：Python worker 入口（python3 -m nyra.worker）
│   ├── worker_protocol.py  worker 协议 v1：宿主与 worker 间的 stdio JSONL 契约
│   ├── checkpoints.py 写入前检查点：崩溃感知快照、/undo 与 /rewind
│   ├── plan_mode.py   两阶段计划模式：先审计划（SHA-256 批准），后执行
│   ├── json_mode.py   非交互 JSON Lines 输出协议（stdout 只出机器可读行）
│   ├── groups.py      多机器人群聊：文件式房间、@mention 路由、串行轮流、每机器人独立多 API Key 轮换
│   ├── poppy.py       Poppy 1.0 公开协议发现（默认关闭，只读校验）
│   ├── poppy_identity.py  Poppy OAuth issuer 双向元数据核验（只读预检）
│   ├── poppy_permissions.py  Poppy 站点权限意向账本（本地记录，非 OAuth 授权）
│   ├── poppy_permissions_cli.py  Poppy 权限意向的命令行管理入口
│   ├── eigenflux_adapter.py  EigenFlux bare-CLI 就绪诊断（不安装、不认证、不广播）
│   ├── eigenflux_policy.py  EigenFlux 本地网络权限上限（按机器人独立，默认拒绝）
│   ├── memory_browser.py  长期记忆的安全编辑（带版本号，防 Web UI 覆盖冲突）
│   ├── patches.py     严格单文件 unified 补丁与审批用 diff 预览
│   ├── usage.py       provider 上报的 Token 用量统计（不估算、不编造）
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
│   ├── tui.py         交互终端界面：启动头部、工作区信任确认、输入框、状态栏、shift+tab 切换模式、按键解析（termios / msvcrt）
│   ├── trust.py       工作区信任记录（~/.nyra/trusted_workspaces.json）
│   ├── webui.py       本地网页界面服务器（python3 -m nyra ui）
│   ├── webui_page.py  网页界面的内嵌单页（HTML/CSS/JS）
│   └── webui_fonts.py 网页界面随包字体（Inter / JetBrains Mono 拉丁子集，OFL）
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

待开发项集中清单（详见 [DESIGN.md](DESIGN.md) 与 [ROADMAP.md](ROADMAP.md)；已实现的不再列）：

- **真沙箱**：Linux 上用 bubblewrap 或 uid 沙箱跑 shell，写操作限制在工作目录——现在命令仍以运行 Nyra 的用户身份执行，full 模式只在信任的目录用。
- **浏览器工具**：已实现（`nyra/cdp_browser.py` + `nyra/websocket.py`，标准库 WebSocket 直连本机 Chrome 的 CDP：BrowserNavigate / BrowserClick / BrowserScreenshot，不用 Playwright/Chromium 驱动）；`web_fetch` 的纯文本抓取仍保留作只读途径。
- **可靠性队列**：长任务断点续跑 + 结果自证、费用上限及实时成本看板、多 Agent 真实状态板。
- **Poppy**：P4（UCP 购物及商店 Agent 对话）、P5（Nyra 对外发布自身能力）；P3 的真实 Session、OAuth 登录、DPoP、HTTP MCP 也未实现。
- **EigenFlux**：E2（经用户批准的安装与入网 onboarding）、E3（收件箱、feed、订阅与公开广播）、E4（多机器人协作匹配）。
- **第一梯队**：hooks（前后置钩子）、Telegram 网关。
- **第二梯队**：流式输出、图片输入、会话全文搜索、并行子 Agent、Nyra MCP Server、HTTP MCP、编辑器集成。
- **服务化第 2 步**：用户到沙盒的映射表 + 持久卷（第 1 步 E2B 单用户原型已做）。
- **其他**：知识库接 agent 主循环（现在只能命令行用）、GEPA 式自动学习、桌面 App 的签名、自动更新与内置 Python（未签名的预览安装包已可由 CI 构建，见 docs/desktop.md）、多会话并发。
