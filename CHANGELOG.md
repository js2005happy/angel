# Angel 变更记录

## 未发布（网页界面 UI v2）

- 网页界面按原型「Angel UI v2」重做：新配色（浅色底 `#F3F5F4`、鼠尾草绿主色 `#5F7D5C`、雾蓝强调 `#6B8CAE`、蜜桃珊瑚 `#E07856` 只小面积点缀，另补一套深炭底 `#1F2420` 暗色变体——原型没有暗色模式），旧墨 `#111A42` / 金 `#EAC45F` / 暖纸白 `#FAF8F4` 已退役；三栏布局（268px 左侧栏 / 自适应主聊天区 / 324px 右侧检查器，52px 顶栏），六视图（对话、技能与工具、定时任务、群聊、品牌与外观、设置）。
- 形象改为毛绒动物：默认奶油白毛绒小兔（`assets/angel-plush-bunny.png`），备选蜜糖色毛绒小熊，品牌视图可切换（localStorage 记忆）；形象图缩小到 512px 后以 base64 内嵌进 `webui_page.py` 与 `group_ui.html`，保持“无外部资源”、新克隆也能显示，`assets/` 不进 git。旧二次元少女形象 `angel-character.png` 不删、不覆盖，已在品牌视图标为弃用。顺带修了一个注入 bug：形象 data URI 原先未加引号注入 JS 的 `IMG` 表，导致整段内联脚本语法错误，页面 JS 全灭；现已加引号并用 `node --check` 验过。
- 新增三个视图（单页内切换）：技能与工具（3 个技能 + 15 个工具一览，标明是否需要审批）、定时任务（列表 + 开关 + 添加表单）、品牌与外观（11 色板、形象切换、字体示例、使用规则）；设置由只读对话框升级为完整视图（provider 预设列表、模式三段切换调真实 `/api/mode`）；群聊视图列出群聊并链接到独立的 `/groups` 页。
- `webui.py`：`/api/info` 扩展返回 13 个 provider 预设列表、15 个工具（每个含 `needs_approval`）、技能列表、`tool_count` 15 / `provider_count` 13；新增 `/api/schedule`（GET 列表；POST `add`/`toggle`/`remove`，只调 `scheduler.py` 的公开函数，不改 `scheduler.py`）；`FORBIDDEN_PAGE` 换新色板。`group-ui.js` 的 provider 下拉改为从 `/api/info` 取，失败时回退到完整的 13 个硬编码列表。
- `docs/index.html` 首页数字修正：14 个内置工具 → 15 个，6 个 provider 预设 → 13 个。
- 新增 5 个测试（`tests/test_webui.py` 的 `UIv2Tests`）：`/api/info` 的 provider/tools/skills 列表与审批标志、新色板与内嵌形象（旧色只许出现在品牌视图的“已退役”文案里，不许出现在 CSS 中）、`/api/schedule` 的增删开关、群聊页换肤与 provider 列表。测试总数 456 → 461，全部通过；本地 Web UI 冒烟检查通过（页面 200、`/api/info` 13 预设 / 15 工具、`/api/schedule` 200、群聊页 200 且无外部资源、内联与群聊 JS 均过 `node --check`，未真实调用模型）。

## 未发布（自定义 provider 明文 http 防护）

- 自定义 provider 的 `http://` 只允许本机地址（`localhost`、`127.0.0.1`、`::1`，比如本机 Ollama）；`http://` 配外网地址时直接拒绝，报错写清“API Key 会随请求明文传输，请改用 https://”。外网地址必须用 `https://`。
- 校验做两道：① `angel/config.py` 的 `plaintext_http_error`，自定义 provider 解析（`custom_providers`）与环境变量方式（`ANGEL_BASE_URL`）都在解析时校验，`resolve_provider` 同样校验（覆盖全部 13 个内置预设）；② `angel/providers.py` 的 `Provider.chat()` / `list_models()` 发请求前再校验一次，防止绕过配置解析直接构造 provider 时仍把 Key 发往明文外网。两处报错文本一致；发请求前的拒绝是 `ProviderError(kind="config")`，不触发兜底切换、不静默降级。
- 内置 13 个预设自查全部合规：Ollama 的 `http://localhost:11434` 是本机、放行；其余 12 个均为 `https://`，无需改动。
- 不影响已有行为：https 自定义与本机 http 正常使用；`--no-fallback` 与兜底链逻辑不动。
- 新增 `tests/test_plaintext_http.py`（14 个）：http 外网在解析与发请求前均被拒（且发请求前拒绝时确认没有发出任何请求）、http localhost / 127.0.0.1 / ::1 / 大小写 / 末尾点号放行、https 外网放行、userinfo 障眼法（`http://127.0.0.1@evil.com`）不绕过、两处报错文本一致、配置错误不触发兜底切换、内置预设全部合规。测试总数 442 → 456，全部通过。

## 未发布（模型兜底接剩余入口）

- `--json` 单次模式接上模型兜底链：与命令行入口同一条链、同一套错误分类（402/429/5xx/超时/网络错误切换，401/403 与配置错误不切换），`--no-fallback` 可关。每次切换在 JSONL 流里发一个 `model_switch` 事件（from/to/error/kind/status）；`run_completed` / `run_incomplete` 增加 `provider` / `model` / `model_switches` 三个字段，如实写清实际答复的模型（`run_started` 仍是起跑的主模型）。失败时的 `run_failed` 错误结构不变。
- 网页界面（`webui.py` 的 `UIState.provider()`）与群聊（`groups.py` 的 `GroupStore._provider()`）接上同一条兜底链：只经过 providers.py / agent 核心，不碰调度器。切换提示写到服务端日志（stderr）；网页界面的信息面板显示实际答复的模型与 `model_switches` 记录。注入的 `provider_factory`（测试用）保持原样、不包链。
- 定时任务**未接兜底**：`cli.py` 的 `_make_task_agent` 仍用单个 provider——调度器（`scheduler.py`）正在 GrokBot 那边开发，按分工本轮不碰。
- 附带修正：`FallbackProvider.has_credentials()` 改为始终看主模型（providers[0]），缓存的链对象在切换前后汇报一致，不再随最后一次答复的模型变化。
- 新增 6 个测试：`tests/test_json_mode.py`（3 个：--json 下 402 切换并上报实际模型、401 不切换、`--no-fallback` 不切换）、`tests/test_webui.py`（默认 provider 走链且 info() 如实上报）、`tests/test_group_chat.py`（机器人默认 provider 走链）、`tests/test_fallback.py`（has_credentials 始终看主模型）。测试总数 436 → 442，全部通过。
- 真实端到端验证（一次 DeepSeek flash 短调用）：`--json --provider ollama`（本地未跑 Ollama）→ 连接拒绝 → `model_switch` 事件 → DeepSeek 返回“好”，`run_completed` 的 provider 为 deepseek。

## 未发布（通用模型接入）

- 新增 7 个内置 provider 预设（只写公开官方 endpoint 与默认模型，不写 Key）：Qwen（DashScope 兼容模式，`qwen-plus`）、Kimi（月之暗面中国区，`kimi-k3`）、GLM（智谱 BigModel，`glm-5.3`）、Gemini（Google OpenAI 兼容端点，`gemini-2.5-flash`）、Mistral（`mistral-small-latest`）、Groq（`llama-3.3-70b-versatile`）、Together（`meta-llama/Llama-3.3-70B-Instruct-Turbo`）；预设的 endpoint 与默认模型均经网页核实。内置预设共 13 个。
- 新增配置项 `custom_providers`：`~/.angel/config.json` 里可自定义任意 OpenAI 兼容接口（`base_url` + `default_model` 必填，`env_key`/`models`/`allowed_hosts` 可选，未知字段忽略；同名覆盖内置预设；缺 `base_url`/`default_model` 或协议不是 http/https 时解析直接报错并点名）。自定义名字可进 fallback 链；`resolve_provider` 会校验 base_url 协议。
- `Provider` 需要 Key 但环境变量没设时不再静默走无认证请求：`resolve_provider` 保持 `auth="env"` 且 Key 为空，`has_credentials()` 为 False（CLI 会显示配置提示），`chat()`/`list_models()` 直接报“未设置 API Key”的配置错误。无 Key 需求的 provider（如本地 Ollama）不受影响。
- 新增 `Provider.list_models()`（`GET {base_url}/models`，OpenAI 形状，`FallbackProvider` 同样支持）：401/403 不兜底，402/429/5xx/超时/网络错误沿用上一轮的错误分类；无 `data` 列表或条目无字符串 `id` 时为解析错误。CLI 新增 `--list-providers`（列出全部 provider 与默认模型）与 `--list-models`（列出当前 provider 的实时模型 id）。
- `providers.py` 内部整理：认证头逻辑抽为 `_apply_auth`，HTTP 状态到错误种类的映射抽为 `_kind_for_status` / `_http_error`，`chat()` 的报错文本与行为不变。
- 新增 `tests/test_generic_providers.py`（29 个）：预设 endpoint/默认模型核实、自定义解析与容错、fallback 链含自定义名字、`list_models` 的 mock opener 映射、CLI 两个 flag。测试总数 407 → 436，全部通过。

## 未发布（模型自动兜底）

- 新增 `angel/providers.py` 的 `FallbackProvider`：与 `Provider` 同样的 `chat()` 接口，按链逐个试模型；主模型遇可恢复失败（402 余额不足、429 限流、5xx、超时、网络错误）时自动切换到下一个并重试一次，每次切换记录到 `switches` 并经 `on_switch` 回调通知；认证失败（401/403）与配置问题（没设 Key、响应无法解析等）直接抛出，不兜底；全部模型都失败时报错列出每个模型的失败原因。每次调用都从主模型开始试。
- `ProviderError` 增加结构化分类：`status`（HTTP 状态码）与 `kind`（auth/quota/rate_limit/server/client/timeout/network/config/parse/redirect/unknown），`recoverable` 属性只对 quota/rate_limit/server/timeout/network 为真；原有只传一句话的调用方式不变，消息文本不变。
- 新增 `angel/config.py` 的 `resolve_fallback_chain` 与配置项 `fallback_enabled`（默认 true）、`fallback_providers`（默认 `["deepseek", "xai", "ollama"]`）；开关优先级：`--no-fallback` > `ANGEL_FALLBACK` 环境变量 > 配置 > 默认开启；链顺序：`ANGEL_FALLBACK_PROVIDERS` 环境变量 > 配置 > 默认链，主模型始终排第一，未知名字跳过。
- CLI 接入命令行入口（交互 REPL、一次性任务、`--plan`）：`--no-fallback` 关闭单次兜底；切换提示打印到 stderr，一次性任务的 stdout 仍只有答案。`--json` 单次模式、网页界面、群聊和定时任务仍用单个 provider，后续再接。
- 新增 `tests/test_fallback.py`（31 个）：错误分类、402 切备用成功、401/403 不切换、429/超时/5xx/网络错误切换、全部失败报错明确、每次调用从主模型重新开始、链顺序与配置/环境变量读取、真实 `Provider.chat` 的 HTTP/超时/网络错误映射（mock opener）、Agent 循环经 FallbackProvider 拿到备用模型答复。测试总数 376 → 407，全部通过。
- 真实端到端验证（一次 DeepSeek flash 短调用）：`--provider ollama`（本地未跑 Ollama）→ 网络错误 → 切换提示打印到 stderr → DeepSeek 返回答案；`--no-fallback` 下同样场景直接报错退出，无切换。

## 未发布（/init 与自定义命令）

- 新增 `angel/commands.py`：自定义斜杠命令以 Markdown 文件存放在项目级 `<工作目录>/.angel/commands/` 或用户级 `~/.angel/commands/`，文件名即命令名，同名时项目级优先；支持 `description` / `argument-hint` frontmatter，`$ARGUMENTS` 与 `$1`..`$9` 占位符，无占位符时参数追加到正文末尾。
- REPL 新增 `/commands`（列出可用自定义命令及来源）与 `/init`（生成 `AGENTS.md` 起始模板，已存在不覆盖；写入走 `write_file`，过审批、边界与检查点，readonly 下拒绝）；内置命令优先于同名自定义命令，符号链接命令文件会被跳过。
- 新增 `tests/test_commands.py`（19 个）：解析、加载优先级、占位符渲染、模板内容、`/init` 的读写路径与 readonly 拒绝。测试总数 356 → 376（含同步远程新增的 1 个 net scheme 测试），全部通过。
- 附带修正 README/DESIGN：工具数 14 → 15（补上漏记的 `apply_patch`），测试数 247 → 376。

## 未发布（网络请求协议限制）

- `net.open_url` 只允许 http/https，`web_fetch` 等不再能通过 `file://`、`ftp://` 读取本地文件；新增 tests/test_net_scheme.py。

## 未发布（EigenFlux 逐机器人网络权限上限）

- 新增 `angel eigenflux policy show|allow|deny|audit`，为每个主/群聊 Agent 显式记录固定网络行为的本地意向；默认拒绝，allow 需要 `--confirm`，deny 即时本地撤销，带 SHA-256 并发检查与有界审计。
- 新建群聊获得随机稳定 `instance_id`，删除同名群后重新创建不会继承旧群的 EigenFlux Home/网络行为许可；老群保持旧路径兼容。
- 策略不会安装、登录、广播或启用调度，所有 `effective_network_permission` 保持 false；后续网络执行层仍需遵守 EigenFlux 官方 onboarding 和用户授权。
- 新增身份隔离、撤销、并发冲突、损坏文件/符号链接、CLI 不创建模型/CLI 进程与群聊重建安全的回归测试。

## 未发布（EigenFlux bare-CLI 本地接入准备）

- 新增 `angel eigenflux doctor [--room ID --bot ID] [--check]`。默认不执行命令、不安装，也不发起网络行动；只计算独立、稳定的 EigenFlux Home 和准备状态。
- 可选 `--check` 对 PATH 中已安装的 CLI 运行 `version` 与 `skills path --host terminal` 两条诊断，最小环境变量、固定参数与超时；绝不在检测期间执行 onboarding、广播、注册或创建定时任务。
- 主 Agent 与各群聊机器人共享 Angel 项目代码，但拥有互相隔离的 EigenFlux 身份根目录。非法群 ID、非成员 bot、已有符号链接目录会拒绝。
- 新增纯模拟 CLI、凭据环境白名单、路径隔离与零副作用测试。该阶段不能宣称已加入 EigenFlux 网络。

## 未发布（Poppy OAuth issuer 双向元数据核验）

- 新增 `python -m angel --inspect-poppy-identity SITE`：不需模型凭证，只读核验公司域名的 OAuth protected resource metadata 与发行方 OAuth server metadata 双向绑定，拒绝缺少精确 resource、错配发行方和不合规 metadata。
- `--poppy` 下新增只读 `poppy_identity_check`；发行方验证通过依旧报告 `remote_calls_allowed=false`、`session_ready=false` 和 `oauth_ready=false`，不启动登录、不发送凭证、不调用远端工具。
- 区分合法 404/无 issuer 与服务器错误和网络超时；元数据禁止重定向，继续保持固定公网 IP/TLS 校验及响应大小限制。
- 新增 RFC 8414 issuer path、多 issuer 选择、资源回指、缺少端点、非 HTTPS、授权未完成以及 CLI 机器输出回归测试。

## 未发布（Poppy 站点/身份/scope 授权意向账本）

- 新增默认拒绝的本地 Poppy 授权意向账本，按精确 HTTPS 主机、访客/本地账户别名与单个 scope 隔离，禁止通配授权。`angel permissions list|check|grant|revoke|audit` 无需模型凭证或网络；用户明确 `grant --confirm` 才会持久化。撤销和有界审计历史随账本原子更新。
- `--poppy` 额外开放仅可读的 `poppy_permission_check`，模型不能变更权限账本。任何本地记录都不等于 OAuth token、Poppy Session 或执行许可；公司声明与实际用户同意严格分离。
- 对 `scope_hints` 的未知变更类型按 `irreversible` 风险处理，缺失个人信息提示保持未知，禁止无依据地显示成低风险。
- 新增 ACL 边界、账户隔离、版本冲突、符号链接、显式确认、模型工具不可提权以及 CLI 的回归测试。

## 未发布（Poppy 1.0 公共发现首阶段）

- 新增 `--discover-poppy SITE` 公共能力诊断：无模型 API Key 可读取并校验 HTTPS `/.well-known/poppy.json`，输出有限 JSON 元数据。新增 `--poppy` 显式启用 Agent 的只读 `poppy_discover` 工具，默认关闭。
- 发现层实施精确 well-known 重定向路径、最终主机和 `organization.domain` 绑定、1.0 版本及同主机备选版本校验、公开 DNS/禁止内网 SSRF 与证书 SNI 验证；不自动启动 MCP、登录或向站点发送令牌。
- 增加版本、重定向、SSL 地址绑定、公开 DNS、权限开关、CLI 无密钥诊断的模拟测试。Poppy Session、签名与 OAuth、远端 HTTP MCP、UCP 尚待完成。

## 未发布（长期记忆浏览与管理）

- Web UI 新增全局 / 群聊机器人长期记忆浏览器，可查看完整 Markdown、手动修改并保存、切换记忆主人。当前完整原文保存在独立 MEMORY.md，聊天压缩不会覆盖该文件。
- 新增 `GET /api/memory/scopes`、`GET /api/memory` 与 `POST /api/memory`，继续复用 token/Host 检查。群聊机器人只允许访问真实存在的成员，拒绝路径穿越与符号链接。
- 写入使用 SHA-256 文件版本校验与原子替换，同进程 `memory_append` 由锁保护；编辑器过期时返回 409，防止覆盖 Agent 新增记忆。
- 新增鉴权、群聊隔离、未保存内容冲突、容量限制与手动/自动压缩保持长期记忆不变的测试。未来继续补费用封顶、长任务恢复和自证、多 Agent 状态板。

## 未发布（apply_patch、/diff 与审批差异预览）

- 新增严格单文件 `apply_patch`，核验 unified diff 头与 hunk 行号、原始上下文，拒绝越界路径、过期文件、格式不正确及跨文件修改；复用本地检查点，支持 `/undo`。
- 本地 `write_file`、`edit_file`、`plan` 和 `apply_patch` 的审批中展示修改前后的差异；Web UI 以多行滚动文本显示；超大差异提示无法预览，E2B 的 Agent 不会看到仅限本地的 apply_patch 工具。
- REPL 新增 `/diff`，查看最近一次未撤销检查点对应的文件变更，外部文件更改显示冲突。
- 增加 CRLF、缺少末尾换行、拒绝不匹配补丁、审批期间竞态与跨平台 CLI 回归测试。

## 未发布（本地任务检查点与 /undo、/rewind）

- 为内置本地 `write_file`、`edit_file`、`plan` 增加任务级检查点：首次写入前保存原始文件字节，后续覆盖更新目标哈希，重启后仍可在相同会话/工作区撤销。
- 增加 REPL `/undo`、`/rewind N`；执行前核查所有目标文件当前哈希/路径，外部修改或符号链接变化时拒绝恢复，防止丢失人工或其他 Agent 编辑；撤销后记录会话通知。
- 限制每文件 2 MiB、每轮 20 文件、最多 20 个未撤销轮；超过范围会拒绝工具写入。远端 E2B、Shell、MCP、HTTP 及 memory/skill 不在撤销范围内。
- 新增持久化、覆盖/创建/二进制、跨轮、外部冲突、不同会话及 CLI 回归测试。


## 未发布（会话审批作用域收紧）

- 文件工具 `a` 授权由“全部同类型写入”收紧至“指定规范化文件路径 + 工具 + 工作区 + 后端”；不同文件重新申请。
- shell `a` 授权额外绑定规范化的 `cwd`、timeout 和执行后端，阻止等价路径的伪绕过与切换后端的缓存滥用；在审批前拒绝在工作区外启动 shell。
- Web UI 回调优先于已有缓存，避免跨前端旧授权绕过逐项审批；新增本机/远端的越界 cwd 和变更作用域测试。
- 仍不提供 shell 命令内部的 OS 级隔离；命令可自行改变路径和访问外部资源。


## 未发布（内置文件工作目录边界与会话审批）

- `write_file`、`edit_file`、`plan` 默认拒绝工作目录外的写入，拦截 ../、绝对路径、已有外部符号链接；E2B 写入路径增加词法边界检查。`full` 也不可绕过。
- `auto` 交互式终端增加 `a`（本次会话始终允许）：仅按单个内置文件工具名称或 shell 完全相同命令及 cwd 组合缓存。MCP、HTTP POST、记忆与技能继续逐次确认；新会话、清空会话和权限模式切换会清除缓存。
- 新增本机/E2B 边界、符号链接、会话独立批准、非交互与只读拒绝等测试。
- 这不提供 shell/MCP 沙箱；任意 shell 仍可能产生工作目录之外的副作用，远端 E2B 符号链接和竞态是现阶段限制。


## 未发布（只读计划与校验批准执行）

- 新增 `--plan`，只通过 `read_file` 和 `list_dir` 在工作目录内分析，生成 `plan.md`，不运行 shell/MCP/Agent；规划失败不覆盖原计划。
- 新增 `--execute-plan --approve-plan SHA256`，完整哈希匹配后才执行；默认 auto 工具级审批，禁止隐式升权至 full。
- 测试覆盖危险工具、路径越界、符号链接、计划篡改、失败保留原计划及 CLI 权限分离。


## 未发布（memory_append / save_skill 测试补齐）

- 新增测试 `tests/test_memory_skill_tools.py`（11 个）：`memory_append` 与 `save_skill` 首次有了直接的单元测试（此前只有群聊测试顺带调过一次 `memory_append`，`save_skill` 完全没有覆盖）。覆盖写入/多行折叠/空文本不写、readonly 与 auto 非交互拦截、技能文件可解析回读、非法技能名拒绝、覆盖重写；测试全程只写临时目录，不碰真实 `~/.angel/MEMORY.md`。
- 附带修正 README：版本号标题仍写 0.2.0、测试数仍写 127，已同步为 0.3.0 / 175。测试总数 164 → 175，全部通过。

## 未发布（Token 用量与上下文状态）

- 新增模型 API 响应 usage 统计，分别累计输入、输出、总 Token 和未报告用量的调用；不使用字符数冒充精确用量。
- CLI 新增 `/status` 和可选 `--context-window`，单次任务结束后将用量报告写入 stderr，保持 stdout 为任务结果。
- Web UI 为每个会话展示模型调用、已报告的 Token、参考上下文余量，未知数据明确标记；配置支持可选的 `context_window_tokens`。
- 新增 usage、CLI、Web UI 回归测试；功能队列记录在 ROADMAP.md。


## 未发布（独立机器人群聊与委派配额）

- 新增 `angel/groups.py` 多机器人群聊核心：每位机器人拥有自己的身份指令、模型选择、独立会话、记忆与工作目录；群消息可 @ 定向分配任务，多成员讨论有轮次上限和持久化记录。
- 网页界面使用独立的 `angel/group-ui.html` 与 `angel/group-ui.js`（HTML/CSS/JavaScript）实现群聊交互；在现有 Web UI 添加群聊入口与令牌保护的群聊 API。
- Agent `delegate` 增加共享子 Agent 数量预算、最大递归深度与子任务轮数检查，避免模型无限嵌套调用；子 Agent 继承所属机器人的独立角色与记忆。
- 对群聊创建、@mention、模型/会话隔离、长期记忆、访问鉴权、嵌套委派边界添加 mock 回归测试，无需真实模型密钥。
- 当前默认 readonly、串行讨论；尚未实现并行自主执行/群成员动态管理/完整操作系统沙箱。


## 未发布（MCP 启动权限与 Web UI 生命周期）

- MCP 服务器进程启动遵循审批模式：readonly 和无人值守 auto 不启动；终端交互 auto 逐项请求同意；full 可直接启动。
- 终端 `/mode` 和 Web UI 模式切换同时管理 MCP 子进程生命周期，防止权限降级后服务继续运行；Web UI 拒绝在任务进行中切换模式。
- 新增模拟真实 MCP stdio 子进程及 Windows CP1252 控制台的启动回归测试、Web UI 模式切换测试；仍需可信 CI 才能合并。


## 未发布（网页界面、终端打磨、项目官网）

- 新增本地网页界面 `python3 -m angel ui`（`angel/webui.py` + 内嵌单页 `angel/webui_page.py`）：纯标准库 `http.server`，无 CDN。左栏会话列表（读现有会话存储，可新建/恢复），中栏对话 + 可折叠工具调用卡片（auto 模式下卡片内批准/拒绝），右栏 provider/模型、证据来源链接、plan 步骤；设置面板只显示 Key 是否已配置，从不回显值。
- 网页界面安全：默认只监听 `127.0.0.1`，绑定非本机地址时打印警告；每次启动随机生成访问 token（页面经 `?token=` 带入，API 必须用 `X-Angel-Token` 请求头），本机监听时校验 `Host` 头，不回应跨域预检，页面带 CSP。
- `Agent` 新增可选 `on_event` 观察回调（工具开始/结果、助手消息），`ToolContext` 新增可选 `approve_fn`，让网页界面复用同一个审批门；不传时行为与之前完全一致，子 agent 继承同一审批回调。
- 终端 REPL 打磨：启动横幅、`angel[模式] ›` 提示符、工具调用分组显示（`┌ 工具 参数` / `└ ✓/✗ 结果`）、`/help` 对齐排版；颜色尊重 `NO_COLOR`、`TERM=dumb` 与非 TTY；一次性任务输出不变。
- 新增项目官网 `docs/`（GitHub Pages，纯静态、中英双语、暗色模式、无外部资源），地址 https://js2005happy.github.io/angel/ 。
- 新增测试 `tests/test_webui.py`（23 个，mock provider + 随机端口）、`tests/test_repl_ui.py`（12 个）、`tests/test_docs_site.py`（5 个）；`unittest discover` 共 127 个通过。

## 未发布（MCP 环境变量最小权限）

- MCP 子进程默认只继承启动所需的基础环境变量，不再复制宿主进程全部环境变量，避免自动暴露 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 等无关凭证。
- MCP 配置新增可选的 `inherit_env`（精确变量名列表），与现有 `env` 合并；`env` 显式值覆盖继承值。非法变量名和非列表配置被拒绝。
- 新增跨平台模拟及真实 Python MCP 子进程的环境隔离回归测试；MCP 可执行程序仍以本机用户身份运行，此改动不是进程沙箱。

## 未发布（本机请求绕过代理）

- 修复：设置了 `HTTP_PROXY` / `HTTPS_PROXY` 但没设 `NO_PROXY` 时，发往本机（`localhost`、`127.0.0.0/8`、`::1`）的请求也被转发到代理，导致本地 Ollama provider、`web_fetch` / `http_post` 访问本机服务失败（代理返回 404/502），两个 mock 测试也因此在代理环境里失败。
- 新增 `angel/net.py`：本机地址的请求一律直连，其余地址照常遵守环境代理设置；provider 客户端、`web_fetch`、`web_search`、`http_post` 统一走它。
- 新增回归测试 `tests/test_net_proxy.py`（本机地址识别、代理指向不可用端口时本机服务仍可访问、远程地址仍使用代理）。

## 未发布（MCP 权限安全）

- MCP 工具调用统一接入工具层审批：`readonly` 禁止、`auto` 每次确认、`auto` 非交互拒绝、`full` 允许；不信任服务端提供的工具名称/描述来判断是否只读。
- 新增 MCP 审批回归测试：拒绝、授权、逐次确认、后台拒绝与审批提示敏感参数保护。

## 未发布（证据文件可靠性）

- 证据存档使用独占创建模式，遇到文件名冲突自动尝试下一个序号，避免覆盖已存在的证据；证据类型字段用于文件名时先进行安全字符过滤。
- 新增证据文件冲突、非法类型和连续保存的回归测试（`tests/test_evidence_files.py`）。

## 未发布（Windows 兼容性）

- MCP stdio 从不兼容 Windows 匿名管道的 `select` 改为后台读取线程 + 队列，保留响应超时和进程退出处理。
- 启动 Python MCP 子进程时默认配置 UTF-8 标准输出（保留显式环境变量覆盖），避免非 UTF-8 Windows 代码页导致服务器退出。
- E2B 沙盒路径始终使用 POSIX 规则解析，修复 Windows 客户端将 `/home/user` 转为反斜杠路径的问题。
- CLI 和调度器对旧终端编码使用 `backslashreplace` 安全降级，避免中文日志触发 `UnicodeEncodeError`。
- 新增 Windows/MCP 相关回归测试，并建立 Linux、Windows 多版本 Python 的 GitHub Actions CI。

## 0.3.0（2026-11-16）

- 新增 E2B 沙盒执行后端（`angel/e2b_backend.py`）：`--sandbox e2b` 让文件读写与 shell 命令在 E2B 沙盒里执行，不在本机上；`--sandbox-id` 可连回已有沙盒，不给则新建（默认 base 模板、1 小时超时）。沙盒模式下工作目录默认 `/home/user`。
- 执行后端是 tools.py 里的一道缝：`read_file` / `write_file` / `edit_file` / `list_dir` / `shell` / `plan` / `grep_search` / `git_status` 走后端，其余工具（联网、记忆、技能、delegate、http_post）仍在本地；审批三档与 shell 黑名单在两种后端下都生效；子 agent 继承同一后端。
- 核心仍是标准库 only：E2B 后端是可选依赖（`pip install e2b`），缺 SDK 时报明确安装提示；凭证优先用 `E2B_API_KEY`，否则走已保存的 Muse 连接器凭证替身，真实 key 不落盘、不进沙盒。
- 测试从 53 个增至 62 个，全部通过；真实 DeepSeek + 真实 E2B 沙盒端到端跑通（沙盒里写文件、读回、列目录，本地无任何写入）。

## 0.2.0（2026-11-16）

- 新增 MCP 客户端（`angel/mcp.py`）：stdio JSON-RPC，加载配置里的服务器，工具以 `mcp_<服务器>_<工具>` 形式调用；默认关闭，需 `mcp_enabled: true` 显式启用。
- 新增内置调度器（`angel/scheduler.py`）：`angel schedule` 子命令（list/add/remove/run/daemon），任务存 `~/.angel/schedule.json`，支持间隔或每天固定时间。
- 新增会话压缩（`angel/compact.py`）：`--compact <会话 id>` 与 REPL `/compact`，模型摘要 + 保留最近消息，模型失败时本地回退。
- 新增证据链（`angel/evidence.py`）：`web_fetch` / `web_search` 抓到的页面原文按会话存档，结论附来源链接。
- 新增工具：`grep_search`、`git_status`（只读）、`http_post`（走审批）。
- `web_search` 改为必应优先、百度兜底的双后端（按 IllusionAgent 的做法），全部失败才报明确错误。
- 新增 provider 档案（`profiles` + `--profile`），显式参数优先于档案。
- 新增核查式调研技能 `verify-research`：搜索→打开官网→逐项核对→存证→附链接交付。
- 浏览器类工具（navigate/click/screenshot）记入路线图，不做假的。
- 测试从 21 个增至 53 个，全部通过；真实 DeepSeek flash 端到端跑通。

## 0.1.0（2026-11-15）

- 首版：Python 标准库 only 的全能 agent CLI。
- 6 个 provider（deepseek/xai/openrouter/ollama/openai/custom），OpenAI 兼容协议。
- 11 个工具（读写改列文件、shell、web_fetch/web_search、记忆、技能、delegate、plan）+ 审批三档 + shell 黑名单。
- 技能系统（Markdown + frontmatter）、长期记忆、会话 jsonl 存储与恢复。
- 21 个 mock 测试通过；真实 DeepSeek API 端到端跑通。
