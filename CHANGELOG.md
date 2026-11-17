## 未发布：ToolJournal 非阻塞事件文件打开（2026-11-18）

- 读侧在 POSIX 支持时使用 `O_NONBLOCK` 打开事件文件，避免恶意命名管道在文件类型 `fstat` 检查前永久阻塞；普通文件读取语义不变。新增标志回归测试源码，未运行测试/CI。Windows 仍采用原有回退，未声称 Windows ACL 已解决。

## 未发布：ToolJournal 写入侧 fdopen 异常句柄清理（2026-11-18）

- 写入侧 POSIX dir_fd 和跨平台路径回退两条分支在 os.open 成功、os.fdopen 失败时显式关闭 fd；避免敏感日志句柄泄漏。新增回归测试源码，未执行测试或 CI；不改变安全恢复策略。

## 未发布：ToolJournal 事件文件句柄异常清理（2026-11-18）

- `os.open` 成功但 `os.fdopen` 失败时，显式关闭事件文件 fd，避免异常路径泄漏敏感文件句柄；新增回归测试源码。仅静态审阅，未执行测试或 CI。

## 未发布：ToolJournal 读取期间同大小文件修改检测（2026-11-17）

- 事件文件读取前后增加同一 fd 的 mtime_ns/ctime_ns 对比；即使文件长度未变化，若元数据时间变化也失败关闭。新增模拟回归测试源码，未运行测试或 CI。
- 这是尽力检测，不是防篡改签名；同用户写入者、时间戳恢复与平台时间精度仍可能绕过检测。

## 未发布：ToolJournal 读取期间事件元数据复核（2026-11-17）

- 读取事件内容后对同一已打开文件再次 fstat，发现文件身份、类型、硬链接数量、大小或 POSIX 私有权限变化时失败关闭，减少检查与读取间的权限/截断竞态窗口。
- 新增模拟读取期间 chmod 的回归测试源码；仅静态审阅，未运行测试或 CI。不能防止同用户原地等长篡改或提供 Windows ACL 保护。

## 未发布：ToolJournal 时间戳格式失败关闭（2026-11-17）

- 读取事件时验证时间戳为合法 UTC、精确到秒的 ISO 8601 格式，拒绝无时区、非 UTC 偏移、非法日期及微秒格式；不改变写入格式。新增回归测试源码，未执行测试或 CI。

## 未发布：ToolJournal 安全拒绝原因保留（2026-11-17）

- 修复 `JournalError` 继承 `ValueError` 导致事件解析阶段的明确安全拒绝原因被笼统的“损坏或不可读取”覆盖；显式重新抛出 `JournalError`，仍统一包装其他 JSON/IO 错误。
- 增加重复 JSON 字段的精确错误信息回归测试源码。仅静态审阅，未运行测试或 CI。


### 未发布：事件文件权限失败关闭（2026-11-17）

- 2026-11-17 ToolJournal POSIX 事件文件权限检查：读取已打开事件文件的 fstat 权限位，拒绝组用户/其他用户可访问的既有事件文件；不自动 chmod。新增回归测试源码，未运行测试或 CI；Windows ACL 仍待研究。
### 2026-11-17 ToolJournal POSIX 目录句柄权限二次核验（仅静态审阅）

- 读/写侧在打开目录 fd 后重新检查 fstat 的权限位；读侧逐事件后也重新核验，降低路径检查与打开句柄之间 chmod 竞态造成的元数据暴露风险。
- 新增模拟目录句柄权限变化的回归测试源码；未执行测试或 CI。Windows ACL、祖先目录竞态和具有同用户权限的攻击者仍未解决。

### 2026-11-17 ToolJournal 既有目录权限失败关闭（仅静态审阅）

- POSIX 读取和写入前拒绝组/其他用户可访问的既有会话日志目录（权限位 `0o077`），不静默 chmod；新目录继续以 `0o700` 创建。
- 新增静态回归测试源码，覆盖读取、写入均拒绝及原权限保持不变；未执行测试。Windows ACL 仍需独立设计，不能宣称日志防篡改。

### 2026-11-17 ToolJournal 会话目录隐私权限（仅静态审阅）

- 新建会话日志目录显式使用 `mode=0o700`（仍受 umask 收紧），避免 POSIX 默认 `0o755` 暴露工具名称和调用时间元数据；不自动更改已有目录权限。
- 新增 POSIX 权限回归测试源码；未执行测试。Windows ACL、祖先目录替换及跨进程竞争仍待处理。

# Angel 变更记录

## 未发布：修复 ToolJournal 硬链接回归测试缺失导入（2026-11-17）

- `test_hardlinked_event_is_rejected` 调用 `os.link`，但测试模块未导入 `os`；补全标准库导入，避免该测试因 NameError 而无法验证硬链接拒绝行为。
- 仅静态检查，未执行测试或 CI；不改变生产运行逻辑。

## 未发布：ToolJournal 事件文件身份及硬链接检查（2026-11-17）

- 读取事件时核对打开句柄与目录条目的设备号/inode，拒绝路径替换；拒绝硬链接数量不为 1 的事件文件。Windows 仍有路径检查竞态，不保证防篡改。
- 新增两项回归测试源码；仅静态审阅，未运行测试或 CI。


## 未发布：ToolJournal JSON 歧义字段拒绝（2026-11-17）

- 事件解析拒绝重复 JSON 字段；严格要求 version 为整数 1，拒绝布尔 true 伪装为版本 1。
- 新增两项回归测试源码；仅静态审阅，未运行测试或 CI。不能据此宣称日志防篡改或自动恢复。


## 未发布：ToolJournal POSIX 读侧稳定目录句柄（2026-11-17）

- 在支持目录 fd 的 POSIX 系统中，以已核验目录句柄列举并打开事件文件，避免每个文件都重新解析完整路径；Windows 保留现有回退。
- 新增只读句柄使用及目录身份不匹配的回归测试源码；本轮没有执行测试、CI 或发布。


## 未发布：ToolJournal POSIX 稳定目录句柄写入（2026-11-17）
- 在支持 dir_fd 的 POSIX 系统中使用已核验目录句柄相对创建事件文件并同步目录；句柄与路径身份不一致时拒绝写入。
- Windows 维持路径检查回退，未引入强制第三方依赖；新增回归测试源码，未运行。该机制不等于跨平台完整 TOCTOU 防护或工具 exactly-once。


## 未发布：ToolJournal 目录替换检测（2026-11-17）
- 在事件读写前后比较日志目录的设备号与 inode，并在逐文件读取后再次检查；发现目录在操作期间变化时失败关闭，不将读取结果视为可信。
- 新增模拟读取/写入期间目录身份变化的回归测试源码；未执行。该方案是跨平台检测，不是 POSIX dirfd 或 Windows 句柄级原子防护；仍存在检查之间的 TOCTOU 竞态。


## 未发布：日志文件名完整性（2026-11-17）
- ToolJournal intent 改用 intent-<call_id>.json；读取时严格校验 intent/result 文件名与事件类型、call_id 对应，拒绝被重命名的结果事件。
- 新增重命名、错配、重复 intent 的回归测试源码；未执行。不能防磁盘写入者删除文件，也未消除目录替换竞态。


## 未发布：工具日志跨进程结果槽去重（2026-11-17）

- `ToolJournal` 的结果事件文件改为 `result-<call_id>.json`，使用标准库 `os.O_EXCL` 保证同一调用在多个进程竞争写结果时至多一个提交成功；intent 仍使用随机文件名。失败方抛出 `JournalError`，不覆盖已有结果。
- 新增针对重复 finish 与过期写入者的回归测试源码，**未运行**。这不构成外部工具执行幂等、目录防替换或安全恢复保证。


## 未发布（工具异常结果保守落盘，2026-11-17）

- 主循环在工具调用抛出异常时（包括外部 MCP 调用）不再直接跳过日志收尾：显式启用 ToolJournal 时写入 `result_error`，然后停止当前任务，要求人工核查外部副作用，绝不自动重试。
- 如果异常后连结果日志也无法写入，则保留未配对 intent（unknown），沿用“状态未知”错误。面向用户的错误不包含原始异常正文，避免泄露第三方响应或凭据。
- 增加异常日志记录、日志写入失败、默认关闭模式和敏感异常内容不外泄的测试用例。测试仅编写未运行；日志的 `result_error` 不是副作用已回滚的证明。

## 未发布（工具日志接入 Agent 执行边界，2026-11-17）

- `Agent(..., tool_journal=ToolJournal(...))` 显式启用后，在内置工具和 MCP 审批/执行前先写入 intent，返回结果后再写入 result；原有调用默认不启用。
- intent 持久化失败则拒绝执行；result 持久化失败则停止并报告执行结果未知，绝不自动重放。子 Agent 不隐式继承日志配置。
- 新增静态编写的 `tests/test_agent_journal_boundary.py`，尚未运行。仅记录结果字符串以“错误：”开头的错误状态，不能证明副作用是否成功；工具抛异常时保留 unknown。

## 未发布（工具意图与结果事件日志基础，2026-11-17）

- 新增 `angel/tool_journal.py`：独立于工具执行器的显式启用、元数据限定的 intent/result 事件记录；崩溃后缺少 result 只能报告 unknown，绝不自动重放。
- 每条事件独立 O_EXCL 文件写入并 fsync；不记录 prompt、工具参数、结果正文或凭据。随机文件名不代表时间顺序，检查时按 call_id 分组。
- 新增 `tests/test_tool_journal.py`（仅编写未运行）；尚未接入 Agent 主循环、跨进程锁或 CLI。当前不宣称日志可用于安全恢复。


## 未发布（会话状态诊断安全加固，2026-11-17）

- 修复空会话、空白助手结尾和没有用户消息时被误判为对话结束的情况；只有明确的最终助手正文才能报告 `conversation_ended`，仍不代表任务完成。
- 对整份会话的工具调用 ID 去重，识别工具结果未返回时又出现助手消息的歧义链；一律 `needs_review` 或拒绝损坏记录，绝不自动重放。
- 对会话文件及祖先目录拒绝符号链接；打开后再次检查普通文件与大小，读取过程中限制总字节，防止增长中的文件绕过预检查。
- 补充回归测试，但依用户要求仅做静态审阅，不运行测试或 CI。

## 未发布（长任务恢复基础：会话状态只读诊断）

- 新增 `python -m angel session-status SESSION_ID`，只读检查已保存 JSONL 会话的角色、工具调用与工具响应配对，识别需要人工核对的中断状态。
- 不打印对话或工具内容，不运行模型、网络或 Shell；拒绝非法会话 ID、符号链接、损坏及超过大小限制的会话文件。
- 输出明确区分 `conversation_ended` 和真正执行成功；当前 `execution_verified=false`、`safe_to_auto_resume=false`，不擅自重放有副作用的工具。附静态编写的回归测试，尚未执行。

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
