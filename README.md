# Angel 👼

一个全能 AI 助手命令行工具：集开源 agent 之长（Codex、OpenCode、Pi、Goose、OpenHands、Hermes Agent、Grokbot、Hermes 模型），用 Python 标准库从零写成。没有 pip 依赖，有 Python 3 就能跑。

> Angel 的代码全部是原创（见 [DESIGN.md](DESIGN.md) 的来源说明），只借鉴了各项目的设计思想，没有复制任何源码。

**官网：** <https://js2005happy.github.io/angel/>（中英双语）

## 官网

项目官网是 `docs/` 目录下的纯静态单页（`index.html` + `style.css` + `main.js`），由 GitHub Pages 从 `main` 分支的 `/docs` 发布，地址 <https://js2005happy.github.io/angel/>。没有构建步骤、外部 CDN、外部字体或追踪脚本；默认中文，右上角可切换 English，支持手机与暗色模式。内容全部取自本 README、DESIGN.md 与 CHANGELOG.md。本地预览直接用浏览器打开 `docs/index.html` 即可；`tests/test_docs_site.py` 会检查页面存在、内部链接/锚点有效、没有加载任何外部资源。

## 新功能（0.2.0 / 0.3.0）

- **E2B 沙盒**（0.3.0）：`--sandbox e2b` 让文件读写与 shell 在 E2B 沙盒里执行，不碰本机；详见下文「E2B 沙盒」一节。
- **MCP 客户端**：接标准 MCP 服务器（stdio JSON-RPC），配置里 `mcp_enabled: true` 并配好 `mcp_servers` 后，服务器的工具会以 `mcp_<服务器>_<工具>` 出现在工具列表里。默认关闭，需显式启用。
- **内置调度器**：`angel schedule add --name 每日整理 --prompt "整理下载目录" --every 86400`，再 `angel schedule daemon` 跑守护进程；任务存在 `~/.angel/schedule.json`，支持间隔或每天固定时间（`--at 08:30`）。
- **会话压缩**：`python3 -m angel --compact <会话 id>` 或 REPL 里 `/compact`，模型把长会话摘要成要点再继续；模型失败时本地回退保留首尾消息。
- **证据链**：`web_fetch` / `web_search` 抓到的页面原文自动存为会话内证据（`~/.angel/evidence/<会话 id>/`），结论必须附来源链接，可按证据复核。
- **新工具**：`grep_search`（文件内容搜索）、`git_status`（只读 git 状态/差异统计）、`http_post`（走审批）。
- **Provider 档案**：配置里 `profiles` 可存多个命名档案，`--profile strong` 切换；显式 `--provider` / `--model` / `--mode` 优先于档案。
- **web_search 修好**：必应优先、百度兜底的双后端（按 IllusionAgent 的做法），全部失败才报明确错误，绝不编结果。

## EigenFlux 可选接入准备（bare-CLI，默认离线）

Angel 支持为主 Agent 和每个已创建的群聊机器人分配**独立且稳定**的 EigenFlux Home，并检查本机是否已有官方 CLI 与 Skills。此功能不自动安装、认证、注册、广播、读取私人上下文或创建定时任务。它也**不是**一个已经连入 EigenFlux 网络的客户端。

```bash
# 只生成本地准备报告，不访问网络、不执行 EigenFlux CLI
python -m angel eigenflux doctor
python -m angel eigenflux doctor --room alpha --bot lead

# 明确运行本地两条官方验证命令，仍不开始 onboarding
python -m angel eigenflux doctor --check
python -m angel eigenflux doctor --room alpha --bot lead --check
```

默认使用 `~/.angel/eigenflux/agents/main/.eigenflux` 作为主 Agent Home；新建群聊的每个机器人使用 `~/.angel/eigenflux/agents/rooms/<room>/instances/<随机实例ID>/bots/<bot>/.eigenflux`（旧群兼容先前路径）。这样即使删除并重建同名群，也不能意外复用以前的身份密钥。这些 Home 与 Angel 的群聊记忆/会话文件分开，不能借用其他机器人的身份或凭据。EigenFlux CLI 需要明确传入同一个 `--homedir`，并且 Home 的最后一级必须是 `.eigenflux`，以免 CLI 再追加目录层级。

`--check` 仅调用 PATH 中已有的 `eigenflux --homedir HOME version` 和 `eigenflux --homedir HOME skills path --host terminal`，不经过 shell，限制超时，调用子进程时仅传递最少环境变量，避免把模型 API Key 或其他代理凭据交给诊断 CLI。检测成功只表示本地工具可用，**不等于邮箱认证、网络身份、用户授权或收件箱订阅已完成**。

安装需要用户单独授权，并须先审阅 [EigenFlux 官方安装指南](https://github.com/phronesis-io/eigenflux/blob/main/skills/install.md)。macOS/Linux 的非官方宿主推荐 `EIGENFLUX_SKIP_AGENT_SETUP=1` bare-CLI 路线；Windows 官方 PowerShell 安装器的宿主集成能力与 Unix 不同，不能假设自动配置了 Codex/Claude 插件。EigenFlux 官方安装器是外部代码，Angel 不会在 doctor 中代为执行。邮箱 OTP、Agent Card、公开广播以及周期性订阅均通过后续 `ef-onboarding` 前台确认，不应把安装同意当成网络行动许可。

## EigenFlux 本地网络权限上限（按机器人独立，默认全部拒绝）

Angel 可为主 Agent 和群聊中的**每个独立机器人**设置本地网络行为上限。它只是一层额外的 Angel 限制：不会替代官方 `ef-onboarding` 用户确认，不会注册账户、打开网络通道、访问私有上下文，也不能作为已认证的凭据。

```bash
# 主 Agent 默认全部拒绝，查看当前可选的六项行为
python -m angel eigenflux policy show

# 查看群聊 alpha 中 lead 机器人自己的限制
python -m angel eigenflux policy show --room alpha --bot lead

# 显式记录允许其“将来在官方授权后”读取 Feed 的本地意向
python -m angel eigenflux policy allow --room alpha --bot lead --capability feed_read --confirm

# 取消上面的本地意向
python -m angel eigenflux policy deny --room alpha --bot lead --capability feed_read

# 查看该机器人本地变更记录
python -m angel eigenflux policy audit --room alpha --bot lead
```

只接受固定行为：`feed_read`、`public_broadcast`、`direct_message`、`relationship_request`、`recurring_check`、`profile_prefill`。每次 `allow` 必须明确 `--confirm`，不支持 `*` 或“所有行为”授权；`deny` 可以立即删除本地许可。支持用 `--expect-revision SHA256` 防止管理员依据过期状态修改。**本地 allow 意向并不允许实际执行这些网络行为**，`effective_network_permission`、`network_actions_enabled` 在本阶段始终为 `false`。官方网络授权、登录、宿主执行许可、公开发布前审核，仍必须分别成立。

权限存在 `~/.angel/eigenflux/network-policy.json`：和各机器人 `EIGENFLUX_HOME` 凭据文件分离，使用私有文件权限、原子写入及 SHA-256 版本检查。记录最多 250 条非不可篡改的本地审计事件；同进程修改有锁，跨进程文件竞争仍需加强。群聊采用随机实例标记，删除后同 ID 重建不会继承旧组的网络权限或 EigenFlux Home；旧群聊保留原路径以兼容。

此功能尚未执行官方 EigenFlux CLI 的网络指令。即使设为 `allow`，也不会触发 `ef-onboarding`、自动读取 Feed、发布广播或设定周期任务；未来的网络执行网关必须在每次操作前再次核验本地上限和**独立的官方授权**。当前不声称可以控制用户在 Angel 之外直接执行的 EigenFlux CLI。

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

## 两阶段计划模式（先审核，后执行）

先在项目工作目录生成计划，不直接修改代码：

```bash
python3 -m angel --workdir . --plan "评估登录逻辑并列出修复步骤"
```

规划时只开放 `read_file`、`list_dir`，读取路径限制在工作目录内；不会调用 shell、MCP、E2B 或普通 Agent 会话。完成后仅生成 `plan.md`，输出完整 SHA-256 校验值。调用模型仍可能计费。

人工审阅 `plan.md` 后，复制完整 64 位 SHA-256，再批准该版本执行：

```bash
python3 -m angel --workdir . --execute-plan --approve-plan 完整SHA256
```

计划任意字节修改都会使旧批准失效。**批准计划不等于跳过工具审批**：执行默认 `auto`，每次写文件或运行命令仍需同意；只有显式指定 `--mode full` 才免逐项确认。当前仅支持本地工作目录，不与 `--json` 混用。这不是操作系统沙箱，应人工审查改动范围和风险。

## Token 用量与上下文状态

Angel 现在会统计模型 API **实际返回** 的 Token 用量。交互终端输入 `/status` 即可查看调用次数、输入/输出 Token、最近一次请求的输入长度及参考上下文余量；Web UI 右侧新增 **Token 用量** 状态面板。单次任务结束时，统计信息输出到 **stderr**，不污染 stdout 的任务结果，适合未来的脚本/JSON 模式。

```bash
python3 -m angel --context-window 8192 "检查这个项目"
python3 -m angel                 # 然后输入 /status
```

如果你知道当前模型官方的上下文上限，可以设置 `--context-window N` 或在 `~/.angel/config.json` 中设置 `"context_window_tokens": 8192`（数字仅为示例，不是对任何模型上限的断言）。没配置时会明确显示 **未知**；如果 API 没有提供 usage 字段，也不会用字符数伪造精确 Token。**上下文参考余量**按最近一次请求的输入 Token 减去已配置窗口计算，不包含最新生成、下一轮新输入以及模型额外的保留量，因此不能当成严格的剩余可用 Token。累计值只统计当前 Agent 进程中的模型回复；历史会话重新载入不自动补算之前的调用。

后续迭代按 [ROADMAP.md](ROADMAP.md) 排序，下一项是基于真实用量和保守阈值的自动会话压缩。

## Poppy OAuth issuer 双向核验（第三阶段首个安全增量）

Angel 可以在不需要模型 API Key、**不登录**的情况下，核验某个 Poppy 1.0 公司是否正确声明其 OAuth issuer：

```bash
python -m angel --inspect-poppy-identity https://shop.example.com
```

检查顺序：先读取 Poppy 1.0 发现文件；再读取公司域名的 `/.well-known/oauth-protected-resource`，确认 `resource` 是该公司的**精确 HTTPS origin**；如有 OAuth issuer，再按 RFC 8414 读取 issuer 的 `/.well-known/oauth-authorization-server` 元数据，核验 issuer **精确匹配**、反向 `protected_resources` 包含公司域名，并检查 token/revocation 端点和 `refresh_token` 等必要声明。多个授权服务器时必须以 Poppy `auth.issuer` 明确选择，否则拒绝。

404 可以表明站点目前没有 issuer，但**只有确实得到 404 或合法的无 issuer 元数据**才允许以 signed-out-only 标记；超时、403、损坏 JSON、证书错误、issuer 未回指公司都必须失败，不得假装是游客模式。元数据读取继续使用公开 DNS/IP 检查、固定 IP + TLS 主机名验证、HTTPS、体积限制，并禁止跟随元数据重定向。

在显式 `--poppy` 下，模型新增只读 `poppy_identity_check` 工具，可查询元数据核验状态；默认不开放。输出 `issuer_link_verified` 仅说明**公开元数据归属双向验证**，并不说明用户已授权、OAuth 客户端注册完成、token 可用或 Poppy Session JWT 已签名。`session_ready`、`oauth_ready`、`remote_calls_allowed` 仍全部为 `false`。

**后续必要步骤**：实现私有密钥安全存储与 `private_key_jwt`、Poppy ES256 委派签名及 per-request JWT、真正的 OAuth 交互和 DPoP、带作用域检查和审批的 HTTP MCP 传输。不能将拼接的未签名 JSON 称为可用的 Poppy Session；完整加密实现可能需要经过审计的密码学依赖，不能为了纯标准库而自造加密算法。

## Poppy 站点权限账本：精确站点 × 身份 × Scope（第二阶段）

Angel 新增**本地授权意向账本**，默认拒绝任何未登记的站点/身份/scope，所有修改只能由用户通过 `angel permissions` 命令显式执行，Agent 只能只读查询。**这里登记的是用户本地偏好，不是 OAuth 同意、有效访问令牌、Poppy Session 或公司服务端的权限**。尚未建立远端调用通道，任何记录都不能让 Agent 直接执行远端操作。

```bash
python -m angel permissions list
python -m angel permissions check --site shop.example.com --scope orders:read
python -m angel permissions grant --site shop.example.com --scope orders:read --account personal --confirm
python -m angel permissions check --site shop.example.com --scope orders:read --account personal
python -m angel permissions audit --site shop.example.com
python -m angel permissions revoke --site shop.example.com --scope orders:read --account personal
```

不带 `--account` 是 `visitor` 访客身份，`--account personal` 表示本地名为 `personal` 的账户槽位，**不表示已经登录**。同一个站点的不同账户、不同 scope 和不同子域名严格隔离；没有通配符授权。`grant` 必须显式带 `--confirm`。`list` 返回账本版本 SHA-256，变更时可使用可选的 `--expect-revision` 拒绝过期写入。

存储位置是 `~/.angel/poppy/permissions.json`，文件按最小本地权限保存，记录最近 300 次授权/撤销的有界审计事件，不保存密码或令牌。当前通过进程内锁和原子替换避免同进程交叉覆盖，跨多个 Angel 进程仍可能竞争，这份审计记录**不是防篡改审计日志**。

使用 `--poppy` 时，Agent 只额外获得 `poppy_permission_check` 查询工具，不获得 grant/revoke 工具。Poppy 1.0 官方 `scope_hints` 描述的变更风险为 `none`、`reversible`、`irreversible`；未知风险值按不可逆处理，缺失 `personal_data` 按未知处理。即使网站宣称风险很低，也不能代替用户批准。以后实现 OAuth/HTTP MCP 时，仍必须独立核验访问令牌实际 scopes、账户与会话，写入或未知风险操作要逐次人工审批。

## Poppy 1.0 公共协议发现（默认关闭，第一阶段）

Angel 的 Poppy 适配采用**先发现、再授权、最后调用**的渐进架构。当前第一阶段是纯标准库只读发现：读取站点 `https://域名/.well-known/poppy.json`，校验 `protocol_version`、实际提供文件的域名和规范要求的重定向终点，列出公司 Agent、MCP、OpenAPI、网页渠道与公开 scope 描述。**不创建 Poppy Session、不执行 UCP 购物、不调用所声明的远端 MCP/API，也不尝试 OAuth 登录。**

在终端直接检查网站，不需要模型 API Key：

```bash
python -m angel --discover-poppy https://example.com
```

显式允许 Agent 先检查结构化发现，再按原有网页搜索/读取方式完成信息任务：

```bash
python -m angel --poppy --mode readonly "查看 example.com 的公开能力和商品信息"
```

默认没有 `poppy_discover` 工具；必须在命令行指定 `--poppy`。`--json --poppy` 也支持该只读工具。标准 Poppy 1.0 的 HTTP Streamable MCP、Session JWT、OAuth issuer 归属验证、权限账本及 UCP 行为**尚未实现**，因此工具只列出能力，不把广告中的端点自动接入现有 stdio MCP 客户端。发现结果来自第三方站点，是不可信数据。

安全边界：只接受 HTTPS 及默认 443 端口的公共 DNS 域名；拒绝内网/回环/保留地址、URL 用户名密码、非 HTTPS 重定向，TLS 使用原始主机名验证证书且连接到已检查的公开 IP。规范允许跨主机重定向，但最终地址必须是精确 `/.well-known/poppy.json` 且无查询参数；备选版本的文档只允许同主机且不可重定向。文件最大 128 KiB，最多 4 次重定向。只实现标记为 1.0 的文档（支持从首选旧版发现同主机 1.0 备选）；其他不兼容版本会拒绝。

本次防护不意味着完整网络沙箱或完成了 Poppy 1.0 所需的 OAuth、签名、Session 等安全校验。未来将按协议版本继续迭代，并在用户授权后接入远端 HTTP MCP；不可用时沿用已有 `web_search`/`web_fetch`，没有浏览器操作时不声称能自动用浏览器兜底。

## 长期记忆浏览器（Web UI）

Angel 的 `MEMORY.md` 不属于会话 JSONL：每个新会话都可重新读取长期记忆，手动 `/compact` 和自动上下文压缩不会改写这份文件。**需要注意：Agent 当前通常只将长期记忆的最后 40 行注入模型提示词，并非所有历史记忆都会同时被模型使用。**

启动 `python3 -m angel ui`，点击顶部 **长期记忆**，即可选择「Angel · 全局记忆」或已经创建的群聊中某个机器人，浏览完整的 Markdown 记忆文本。全局文件在 `~/.angel/MEMORY.md`；群聊机器人各自保存为 `~/.angel/groups/<群ID>/bots/<机器人ID>/MEMORY.md`，互不共享。

网页可直接编辑、清理和保存当前机器人记忆。每次读取返回整个文件的 SHA-256 版本号，保存时必须提交该版本：如果另一个 Agent 在此期间追加了记忆，服务器返回 **409 冲突**并保留原有数据，绝不会默默覆盖。跨同一个 Python 进程的 `memory_append` 和网页保存使用共享锁；多进程同时写入尚无跨进程锁，建议同一记忆文件只运行一个 Angel 实例。

接口通过原有 Web UI 随机 token 和本机 Host 检查保护；不在模型信息、会话列表等无关 API 中泄漏记忆内容。记忆仅支持 UTF-8，网页编辑器每文件上限 64 KiB，已有符号链接记忆文件不可被网页读写。修改后请手动保存，新的长期记忆在下一次 Agent 请求中生效；敏感记忆请不要复制到公开聊天或截图中。

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
| qwen（通义千问） | `DASHSCOPE_API_KEY` | `qwen-plus` | 阿里 DashScope 兼容模式 |
| kimi（Kimi） | `MOONSHOT_API_KEY` | `kimi-k3` | 月之暗面，中国区 endpoint |
| glm（智谱） | `ZHIPU_API_KEY` | `glm-5.3` | 智谱 BigModel 兼容模式 |
| gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` | Google OpenAI 兼容端点 |
| mistral | `MISTRAL_API_KEY` | `mistral-small-latest` | |
| groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | 极快推理，免费额度 |
| together | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | 一个 Key 用上百个开源模型 |
| custom | `ANGEL_API_KEY` + `ANGEL_BASE_URL` + `ANGEL_MODEL` | — | 任意兼容接口（环境变量方式） |

### 自定义 provider 与列出模型

上面没有的模型也能接：只要它走 OpenAI `/v1/chat/completions` 协议，在 `~/.angel/config.json` 的 `custom_providers` 里加一条就行，Key 只从环境变量读，不写进配置：

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

- `base_url` 和 `default_model` 必填，且 `base_url` 必须是 http/https；`env_key` 是存 Key 的环境变量名（不填则无需 Key，或用 `ANGEL_API_KEY`）；`models`、`allowed_hosts` 可选；未知字段会被忽略。
- 明文 `http://` 只允许本机地址（`localhost`、`127.0.0.1`、`::1`，比如本机 Ollama），外网地址必须用 `https://`——否则 API Key 会随请求明文发出去。写了外网 `http://` 会在解析配置时直接报错并提示改用 `https://`；即使绕过配置解析直接构造 provider，`chat()` / `list_models()` 发请求前也会再拦一次。环境变量方式的自定义（`ANGEL_BASE_URL`）同样受这条规则约束。
- 同名自定义会覆盖内置预设（比如自己搭的 DeepSeek 兼容代理可以覆盖 `deepseek`）；写错的自定义（缺 `base_url`/`default_model`、协议不是 http/https）会在解析时直接报错并点名，不会静默失效。
- 自定义 provider 可以进 fallback 链：`"fallback_providers": ["myllm", "deepseek"]`，或环境变量 `ANGEL_FALLBACK_PROVIDERS="myllm,deepseek"`。
- 某个 provider 需要 Key 但环境变量没设时，Angel 会直接报“未设置 API Key”并提示配置，不会先发一个无认证的请求再等服务端 401。
- 列出可用模型：`python3 -m angel --list-providers` 看全部 provider 与默认模型；`python3 -m angel --provider qwen --list-models` 问该 endpoint 的 `/models` 接口拿实时模型列表（需要 Key，Ollama 本地不用）。

也可以直接用已保存的连接器凭证：DeepSeek 和 xAI 的 Key 已通过安全流程保存，**不用再填 Key**，直接用：

```bash
python3 -m angel --provider deepseek "做点什么"
python3 -m angel --provider xai --model grok-4.5 "做点什么"
```

发往本机地址（如本地 Ollama 的 `localhost:11434`）的请求总是直连，不受 `HTTP_PROXY` / `HTTPS_PROXY` 影响；其他地址照常遵守代理设置。

Key 只从环境变量或已保存的连接器读取，**绝不会**打印、记录或写进项目文件。配置存在 `~/.angel/config.json`（不含任何 Key）。

### 模型自动兜底

主模型调用失败时，Angel 会自动按链切换到下一个模型重试一次，不用手动换模型。默认链是 DeepSeek flash → Grok → 本地 Ollama（主模型始终排第一，每次调用都从主模型开始试）。

- 会兜底的失败：余额不足（402）、限流（429）、服务端错误（5xx）、超时、网络错误。
- 不会兜底的失败：认证失败（401/403，换模型也解决不了）、配置问题（没设 Key、响应无法解析等）。
- 每次切换都会在终端打印一条明确提示（走 stderr，一次性任务的 stdout 仍只有答案），例如：`模型切换：ollama 失败（网络错误……），已切换到 deepseek 继续`。
- 默认开启。关闭方式（三选一）：`~/.angel/config.json` 里设 `"fallback_enabled": false`；环境变量 `ANGEL_FALLBACK=0`；单次加 `--no-fallback`。
- 改链：`~/.angel/config.json` 里设 `"fallback_providers": ["deepseek", "xai", "ollama"]`，或环境变量 `ANGEL_FALLBACK_PROVIDERS="deepseek,xai,ollama"`（逗号分隔，主模型自动排第一，未知名字会被跳过）。备用模型用各自的默认模型；自定义 provider 的名字也可以写进链里。
- 全部备用模型都失败时，报错会列出每个模型失败的原因，不会静默失败。
- 已接在命令行入口（交互 REPL、一次性任务、`--plan`）、`--json` 单次模式、网页界面和群聊：主模型遇可恢复失败时都按同一条链切换。`--json` 会在输出里如实写清最终用了哪个 provider（`run_started` 是起跑的主模型，`run_completed` / `run_incomplete` 是实际答复的模型，另有 `model_switch` 事件和 `model_switches` 列表）；网页界面的信息面板同样显示实际答复的模型与切换记录；群聊里切换提示写到服务端日志。定时任务仍用单个 provider（调度器正在另一路开发中，本轮未碰）。

## apply_patch 补丁编辑与 /diff

Angel 增加了 `apply_patch` 工具：严格使用单文件 unified diff 编辑已存在的**本地文本文件**。补丁必须包含 `--- a/相对路径`、`+++ b/相对路径` 和 `@@ -旧行号 +新行号 @@`，每行原文上下文必须准确匹配，不允许猜测匹配、越界写入或一次修改多个文件。

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

终端新增 `/diff`，用于查看本会话**最近一个未撤销检查点**的变更；遇到外部修改会显示冲突，不把他人的文件修改误记为 Angel 的成果。补丁与已有检查点兼容，可以随后使用 `/undo`。

当前只支持本地已有文本文件。新建/删除文件、重命名、多文件补丁、远程 E2B 补丁、OS 级隔离和跨文件原子提交尚未实现；`/diff` 不是完整 `git diff`，无法追踪 Shell、MCP、HTTP 等外部副作用。

## 写入前检查点：/undo 与 /rewind

交互式 Angel 现在会对**本地**内置文件工具 `write_file`、`edit_file`、`plan` 自动建立任务检查点：在一次用户任务首次修改某文件时保留原始字节（包括原先不存在的文件），同一任务后续写入仅更新最终文件哈希。检查点按会话和工作目录隔离，保存在 `~/.angel/checkpoints/`，不需要安装插件。

```text
/undo           # 撤销最近一轮任务中的这些本地文件修改
/rewind 3       # 撤销最近三轮，先全部检查，发现冲突则不改动任何文件
```

撤销前逐文件验证目前的内容哈希仍与 Angel 最后写入时一致。如果文件被用户、另一个机器人或外部进程修改，操作会**拒绝执行，不覆盖外部修改**。撤销创建的文件时删除该文件；覆盖原有文件时恢复原始二进制字节；其他文件不受影响。单个检查点最多包含 20 个文件，单文件最大 2 MiB，最多保留 20 个未撤销的检查点，`/rewind N` 每次最多 10 轮。超出限制时，Angel 拒绝带检查点的文件写入，以免生成无法安全恢复的修改。

撤销后会在当前会话记录一条提示，提醒模型之前的工具成功记录已失效；不会自动改写此前所有消息。`/new` 启动不同会话的检查点集合，`--resume` 在相同工作目录下可继续使用之前保存的检查点。

**不能撤销的范围**：Shell（包括它启动的子进程）、MCP、HTTP 请求、远端 E2B、memory/skill 文件、其他 Agent 以外的外部副作用；原子文件替换也不能保证多个文件一起恢复时绝对不发生系统故障。检查点不是完整备份或 OS 沙箱，建议结合 Git 版本控制。

## 精确文件与 Shell 授权（安全加固）

交互式 `auto` 的 `a`（本次会话始终允许）现在仅对**同一文件、同一种工具**生效；路径在授权前被规范化，因此相同文件的等价相对/绝对路径不需要重复审批，其他文件仍要重新批准。对于 shell，缓存授权绑定**完全相同命令文本、规范化起始目录、超时时长、执行后端及工作区**。换目录、换后端、提高超时不会沿用旧授权；Web UI 的逐项审批回调始终优先于缓存。

shell 的起始 `cwd` 现在必须位于 `--workdir` 内；绝对外部路径、`../` 和现有指向外部的符号链接会在执行与人工审批前拒绝。**这只限制 shell 从哪里启动**，命令内部仍可以通过 `cd`、绝对路径、重定向或其他程序访问工作目录之外。它不构成 shell/OS 沙箱；后续仍需进程隔离和工具执行审计。

## 工作目录写入边界与本次会话批准

`write_file`、`edit_file`、普通 `plan` 文件工具现在**默认**拒绝写到 `--workdir` 外部，`full` 也不能绕过。这包括绝对外部路径、`../` 越界及已有指向外部的符号链接；合法的工作目录内路径仍可使用。E2B 的写入路径也会进行 POSIX 路径归一化和词法范围检查。

在交互式 `auto` 模式下，每次文件写入或 shell 命令会提示 `[y/N/a]`：`y` 仅批准一次，`a` 表示**本次会话始终批准**此种文件工具（write_file/edit_file/plan 按具体工具分别记录），或者 shell 的**完全相同命令字符串及 cwd 工作目录**。不把一个 shell 前缀视为可任意执行的白名单；MCP、HTTP POST、记忆与技能操作继续逐次审批。`/new`、`/clear`、`/mode` 切换会清除会话批准；后台非交互 `auto` 和 `readonly` 绝不会因为缓存批准而执行写入。网页审批仍按每次工具调用请求授权。

**边界说明**：工作目录写入检查只覆盖上述内置文件工具，不限制已有的 `shell` 在执行时使用绝对路径、改变目录或启动其他程序；`memory_append`、`save_skill` 和证据/会话存储本来就会写入 Angel 的专用数据目录，属于已知例外。E2B 的词法检查无法识别远端符号链接，检查与写入之间也可能存在竞态，因此这不是完整操作系统沙箱。需要运行不可信代码时，使用受保护的隔离环境，并继续审阅命令。更强的 shell 沙箱与精确命令白名单列在后续安全迭代。

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

## 自定义命令与 /init

把常用提示词存成命令文件，随时用斜杠调用，不用每次重打：

```bash
# 用户级：~/.angel/commands/review.md
# 项目级：<工作目录>/.angel/commands/review.md（同名时项目级优先）
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
python3 -m angel ui            # 启动后打印带 token 的链接，在浏览器打开
python3 -m angel ui --open     # 自动打开浏览器
python3 -m angel ui --port 9000 --workdir ~/project --mode auto
```

本地网页界面，纯标准库 `http.server` + 一个内嵌的 HTML/CSS/JS 页面，不引用任何 CDN 或外部资源。UI v2（三栏 + 六视图，2026-11-17）：

- **左栏**——品牌卡（毛绒小兔头像）与六视图导航（对话 / 技能与工具 / 定时任务 / 群聊 / 品牌与外观 / 设置），会话列表在对话视图内，可新建会话，也可点开历史会话继续。
- **中栏：对话**——用户/助手消息（基本 Markdown 渲染），执行中轮询显示进度；每次工具调用是一张可折叠卡片（工具名、参数、结果摘要）。auto 模式下需要审批时卡片里出现“批准 / 拒绝”按钮，走的是和终端相同的审批门（`tools.py` 的 `_check_approval`），readonly / full 行为不变；10 分钟无人处理按拒绝处理。
- **右栏：检查器**——当前 provider / 模型 / 凭据状态 / 工作目录、本会话的证据列表（来源链接）、最近一次 `plan` 的步骤；模型卡显示兜底链（如 `deepseek → xai → ollama`）与切换记录，Token 用量按 13 个 provider 预设 / 15 个内置工具更新。
- **技能与工具视图**——3 个内置技能与 15 个内置工具一览（每个工具标明是否需要审批）。
- **定时任务视图**——读 `~/.angel/schedule.json`，可查看、添加、启用/停用、删除定时任务（走新增的 `/api/schedule`，只调 `scheduler.py` 的公开函数）；添加表单可填可选的 provider / 模型（不填用当前 provider），行里显示任务的 provider / 模型与上次运行时间、状态、摘要；“执行时间”按“每天 HH:MM / 每隔 N 分钟”切换提示。
- **群聊视图**——群列表与“打开群聊页面”入口（带 `?room=<id>`，群聊页打开即选中该群，不存在时回退第一个）；群聊页本身是独立的 `/groups`（`group_ui.html` + `group-ui.js`），同款换肤，provider 下拉从 `/api/info` 取、失败时回退到 13 个预设。
- **品牌与外观视图**——11 色板、形象切换（默认奶油白毛绒小兔，备选蜜糖色毛绒小熊，localStorage 记忆选择）、字体示例与使用规则。
- **设置视图**——provider 下拉可用（13 个预设，`/api/info` 返回，含各 provider 的模型列表做输入提示）：选 provider + 填模型后点“应用”调真实的 `POST /api/provider`，新会话立即生效，已有会话保持原 provider，重启后恢复配置文件中的设置；未知 provider / 明文 http 外网地址会直接报 400。模式三段切换（调真实 `/api/mode`，失败时界面自动回滚到实际值）；Keys 表含自定义 provider（来自 `get_provider_presets`）；MCP 与证据链状态只读；API Key 只显示是否已配置，**绝不回显值**。
- **顶栏**——小兔圆形头像、provider 芯片与模式芯片；配色为鼠尾草绿主色 + 雾蓝强调 + 蜜桃珊瑚小面积点缀（浅色底 `#F3F5F4`，另有深炭底暗色变体）；形象图以 base64 内嵌在页面里，不引用外部图片。

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

Angel 有 15 个工具：`read_file`、`write_file`、`edit_file`、`apply_patch`、`list_dir`、`shell`（带危险命令黑名单）、`web_fetch`、`web_search`、`memory_append`、`save_skill`、`delegate`（子 agent）、`plan`（先写计划再执行）、`grep_search`、`git_status`、`http_post`。

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
python3 -m unittest discover tests   # 468 个测试，全部使用 mock，无需 Key
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
│   ├── providers.py   OpenAI 兼容客户端（urllib）+ 模型自动兜底（FallbackProvider）+ 通用 provider 预设与 /models 发现
│   ├── commands.py    自定义斜杠命令 + /init 的 AGENTS.md 模板
│   ├── tools.py       15 个工具 + 审批 + shell 黑名单
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
