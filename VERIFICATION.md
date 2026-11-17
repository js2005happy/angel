## 2026-11-17 同大小原地修改检测（仅静态审阅）

- 静态确认读取前后 fstat 的 mtime_ns/ctime_ns 对比；回归测试源码通过 mock fstat 模拟第二次文件元数据变化，预期抛出 JournalError。
- 未运行测试、编译、CI 或 Windows/Linux 验证；不保证时间戳精度、防篡改或外部副作用真实性。

## 2026-11-17 事件读取后元数据复核（静态检查，未执行）

- 已静态核对：事件读取前后对同一 fd 的 fstat 检查身份、文件类型、大小、硬链接数量及 POSIX 私有权限；模拟 read 后 chmod 的回归测试已编写。
- **未执行测试、编译、CI 或平台验证**。仍存在同用户等长篡改、Windows ACL、目录祖先竞态及外部副作用真实性问题。

## 2026-11-17 ToolJournal 时间戳格式（仅静态审阅）

- 静态核对写入格式 `datetime.now(timezone.utc).isoformat(timespec="seconds")`，读侧新增 `datetime.fromisoformat` 与 UTC/秒精度/规范化格式检查。
- 新增非法日期、无时区、偏移时区、微秒和任意字符串的回归测试源码；未执行任何测试、编译或 CI。Windows ACL 与目录替换竞态仍未解决。

## 2026-11-17 ToolJournal 异常分类（仅静态审阅）

- 确认 `_records()` 中 `JournalError` 是 `ValueError` 子类，原异常处理会将重复 JSON 字段等明确安全错误重新包装为泛化损坏错误；现在先原样抛出 `JournalError`。
- 新增精确错误文本回归测试源码，**未执行**；未运行测试、编译或 CI，不宣称跨平台验证通过。


### 2026-11-17 ToolJournal 事件文件权限（仅静态检查）

- 核对读取事件文件的 `fstat` 后增加 POSIX `mode & 0o077` 拒绝；新增 0644 事件文件读取及再次 begin 拒绝的回归测试源码，且不改变文件权限。
- 未执行测试、编译、CI 或 Windows/Linux 运行验证。Windows ACL、文件替换竞态与同用户篡改仍未解决。
### 2026-11-17 POSIX 日志目录句柄权限竞态（未运行测试）

- 静态核对读/写路径：在已打开目录 fd 上用 fstat 复查组/其他用户权限，读侧逐事件后复查；新增 mock fstat 权限变宽回归测试。
- 未执行测试、编译、CI 或 Windows/Linux 平台验证；此检查不能防止所有 TOCTOU 或同用户篡改。

### 2026-11-17 既有 ToolJournal 目录权限检查（未运行测试）

- 静态检查：POSIX 上 `_directory_identity` 拒绝会话目录的组/其他用户权限位，不修改既有权限；新增测试源码检查读取、写入均拒绝。
- 未运行测试、编译、CI 或平台验证；Windows ACL、祖先目录竞态、外部副作用对账仍未解决。

### 2026-11-17 ToolJournal 私有会话目录（未执行测试）

静态审阅：`ToolJournal._write()` 创建会话目录时显式请求 `0o700`，新增 POSIX 权限回归测试。未运行测试/CI；未验证 Windows ACL，现有目录权限不自动修改。禁止将此视为日志防篡改或工具副作用验证。

## 2026-11-17 ToolJournal 回归测试静态阻塞修复

- 静态发现 `tests/test_tool_journal.py::test_hardlinked_event_is_rejected` 使用 `os.link` 而模块未导入 `os`；本轮补充导入。
- 未运行单元测试、静态分析命令或 CI；该修复仅解除可见的 NameError 风险，不证明硬链接保护通过。

## 2026-11-17 ToolJournal 文件身份核对（仅静态审阅）

- 打开事件文件后比较 fstat 与目录条目的 stat/lstat 身份，拒绝硬链接。
- 新增 test_hardlinked_event_is_rejected 与 test_replaced_event_entry_is_rejected 测试源码。
- 未运行测试、编译、安装或 CI。Windows 路径检查不是原子操作；外部工具执行状态不能据此自动恢复。

# Angel 验证报告（2026-11-16，v3 0.3.0）

## 待验证：ToolJournal JSON 歧义字段拒绝（2026-11-17）

- 静态审阅 object_pairs_hook 拒绝任意层级重复键，版本字段严格为 int 类型 1。
- 编写重复键与布尔版本回归测试，未执行测试/CI；Windows/Linux 尚待验证，不构成防篡改保证。

## 待验证：POSIX 事件读取目录句柄（2026-11-17）

- 静态审阅 `ToolJournal._records()`：POSIX 目录 fd 的 `fstat` 身份校验、`os.listdir(fd)`、相对 fd 打开事件文件、关闭句柄与读取中路径身份核验。
- 新增模拟目录句柄身份不匹配与事件文件相对打开的回归测试源码，**未执行**。Windows 仍为原路径回退；目录祖先竞态和攻击者直接篡改事件尚未消除。旧 CI 不作为本次验证依据。


## 待验证：POSIX 目录句柄写入（2026-11-17）
- 静态审阅 `ToolJournal._write`：在支持 dir_fd 的 POSIX 系统上核对目录句柄 `fstat`，相对该句柄 `O_EXCL` 创建事件文件并同步目录；Windows 保留旧路径方式。
- 新增 POSIX 路径创建与句柄不一致失败关闭测试源码。**未执行任何测试、安装、CI 或发布**；还需真实 Linux/macOS 与 Windows 验证，读取侧仍是路径模式。


## 待验证：ToolJournal 目录身份变化检测（2026-11-17）
- 仅静态审阅：新增 `tests/test_tool_journal.py` 两个模拟目录替换的测试；未执行 Python、单元测试或 CI。
- 预期：读取期间目录设备号/inode 改变则拒绝结果；写入后目录改变则抛 `JournalError`，不把事件当作可靠提交。
- 限制：stat 比对不能消除检查间竞态，也不能防拥有写权限的进程替换文件或伪造日志；需要后续按平台使用稳定目录句柄、审查跨进程文件一致性。


## 2026-11-17 日志文件名绑定（静态审阅）
- 核对 tool_journal.py 的 intent/result 固定文件名及 _records 文件名/JSON 一致性检查。
- 编写结果重命名、JSON call_id 错配、复制 intent 的测试；更新过时的随机文件名测试。
- 未运行测试、CI、安装、合并或发布。Windows/Linux、目录替换与跨进程端到端安全仍未验证。


## 2026-11-17 工具日志单结果槽（仅静态检查）

- 已审阅 `ToolJournal.finish()` 先读取调用意图、再 `_write()` 的竞争窗口：旧随机结果文件名可能允许两个并发 finish 都写入结果。新结果文件名固定为 `result-<call_id>.json`，`O_CREAT|O_EXCL` 在同一文件系统目录上使重复结果创建冲突而非静默覆盖。
- 新增测试：重复完成不能改变既有结果；模拟过期写入者直接 `_write()` 也会被拒绝。**测试未执行，Windows/Linux 运行验证未完成；既有 CI 不能证明本次提交。**
- 仍未消除目录祖先替换竞态、磁盘权限攻击、同一外部副作用重复执行、文件系统持久性差异。不得宣称已实现自动恢复或跨进程完整事务。


## 待验证：工具异常日志收尾（2026-11-17）

- 静态核对 `agent.py`：工具执行异常被分类为报告错误；显式日志写入 `result_error` 后抛出不包含原始异常详情的 `AgentError`，不继续执行后续工具，也不重试。
- 结果写入失败时仍为 unknown；新增测试覆盖异常内容不泄露、默认关闭、写入失败和只调用一次。没有执行测试或 CI；不能声明异常时副作用已撤销。
- 限制：成功/失败仍有返回字符串 `错误：` 前缀的旧兼容判断；日志尚无跨进程一致性保证，未达到安全自动恢复条件。

## 待验证：Agent 工具日志执行边界（2026-11-17）

- 静态审阅 `agent.py`：`tool_journal=None` 默认关闭；显式注入时 intent 写入在内置/MCP 工具审批和执行前，result 写入在返回事件和会话追加前。
- 写 intent 失败阻止工具执行；写 result 失败停止并报告可能执行、结果未知。新建 `tests/test_agent_journal_boundary.py`，**未运行**。
- 风险：工具抛异常留下 unknown；`错误：` 前缀分类不是结构化状态；日志没有跨进程互斥或防篡改能力。本轮没有运行测试/CI，也没有合并或发布。


## 待验证：工具执行意图/结果元数据日志（2026-11-17）

- 静态审阅新增 `angel/tool_journal.py` 和 `tests/test_tool_journal.py`：只存固定元数据；intent 无结果标记 unknown；即使 result_ok 也不代表副作用完成或已验证。
- 单条事件使用 O_EXCL 创建和 fsync，读取拒绝损坏文件、符号链接、异常字段和超限事件。文件名随机，聚合不依赖字典序。
- **未运行单元测试、CI、安装或发布。** 已提供显式注入主循环；并发写入与日志目录祖先替换仍有竞态，不能视为可信执行审计或安全自动恢复机制。


## 待验证：会话状态诊断安全加固（2026-11-17）

- 静态审阅 `angel/session_diagnostics.py`：新增整段工具调用 ID 去重、空会话/空白最终回复拒绝、工具链乱序标记；所有状态继续 `execution_verified=false`、`safe_to_auto_resume=false`。
- 文件路径对祖先目录及最终文件检查符号链接；在支持 `O_NOFOLLOW` 的平台拒绝末尾符号链接竞态，打开后用 `fstat` 复核普通文件和大小，并限制读取累计字节。祖先目录跨进程替换竞态尚未由目录句柄逐级锁定，不能声称完全消除 TOCTOU。
- 新增 `tests/test_session_diagnostics.py` 回归用例：空会话、无用户消息、空白助手结尾、重复工具调用 ID、乱序工具结果、合法配对及父目录符号链接。
- **未执行测试、构建或 CI**；尚需 Windows/Linux 兼容性验证，尤其是 Windows 文件标志与路径竞态。不得将本轮标记为已验证。

## 待验证：长任务会话状态只读诊断（2026-11-17）

- 本轮仅进行源码与文档静态审阅，**没有运行测试、构建、安装或 GitHub Actions**。新增 `tests/test_session_diagnostics.py`，覆盖末尾消息、未配对工具调用、孤立工具结果、损坏 JSONL、超限文件、符号链接、CLI 绕过 Provider/MCP 与隐私字段不外泄。
- 验收尚未完成：需授权后运行 Windows/Linux 单元测试，并检查真实会话记录兼容性。该功能不执行恢复，也不证明任务完成。
- 设计局限：JSONL 保存并非原子写入，只有会话级消息而非持久化执行事件；工具副作用及远端状态不能从消息推断。

## 已验证：EigenFlux 逐机器人网络行为上限（PR #22）

- `tests/test_eigenflux_policy.py`：默认拒绝所有行为、必须用户 `--confirm`、群聊/机器人和能力隔离、撤销及审计、SHA-256 过期修改拒绝、私有权限文件、未知能力/账户拒绝、损坏文件和符号链接拒绝。
- 验证删除同 ID 群并重建时，旧 Home 和旧本地网络意向不被继承。`tests/test_eigenflux_adapter.py` 同步验证新建群带随机实例标记，历史房间目录路径兼容。
- `angel eigenflux policy` CLI 的 allow/deny/show/audit 不调用 Provider、MCP、外部 EigenFlux CLI 或宿主 scheduler；无实际模型、网络或密钥操作，所有策略结果都不能声称完成 onboarding。
- GitHub Actions [PR #22 运行 43832998445](https://github.com/js2005happy/angel/actions/runs/43832998445)：Ubuntu Python 3.10/3.12 与 Windows Python 3.12 全通过；Windows 共执行 356 项 unittest。模拟网络工具与子进程，无真实 EigenFlux 安装、登录、网络调用或付费模型费用。

## 已验证：EigenFlux bare-CLI 本地适配准备（PR #21）

- `tests/test_eigenflux_adapter.py`：主 Agent Home 不随会话/cwd 变化；不同群/机器人成员 Home 无重叠；未知机器人、非法 ID、符号链接路径拒绝。
- 默认 doctor 不读取 CLI 版本、不调用子进程且不创建任何身份目录；显式 `--check` 固定只允许两条本地 CLI 命令，传递凭据最小环境变量，并按超时或命令错误报告 incomplete，不虚报网络已连接。
- CLI 集成不会创建模型 Provider、MCP 或 scheduler，全部测试采用临时目录与模拟命令，没有真实安装、EigenFlux 网络请求或模型调用。
- GitHub Actions [PR #21 CI 43830402473](https://github.com/js2005happy/angel/actions/runs/43830402473)：Ubuntu Python 3.10/3.12 和 Windows Python 3.12 全部通过，Windows 运行 342 项 unittest。全部 EigenFlux 命令使用 mock，未进行实际安装、登录、网络发布或付费模型调用。

## 已验证：Poppy OAuth issuer 双向核验（PR #20）

- `tests/test_poppy_identity.py` 检验公司域名 → protected resource → issuer metadata → issuer `protected_resources` 反向绑定，多个 issuer 的 `auth.issuer` 选择及单 issuer 自动确认。
- 测试合法 404、合法无 issuer、非法 403/超时不降级；错误资源、错配发行方、无 `refresh_token`、无 revocation/token/authorization 端点和重定向均失败关闭。
- CLI `--inspect-poppy-identity` 不调用 Provider/MCP/外部 API；只读 Agent 工具必须显式 `--poppy`；结果不声称已登录、获得 OAuth 令牌或支持远端操作。
- GitHub Actions [PR #20 CI 43827185087](https://github.com/js2005happy/angel/actions/runs/43827185087)：Ubuntu Python 3.10、Ubuntu Python 3.12、Windows Python 3.12 全部成功；Windows 运行 330 项 unittest。测试使用 mocked HTTPS，无真实 OAuth、远端 MCP 或付费模型调用。

## 已验证：Poppy 站点授权意向账本（PR #19）

- `tests/test_poppy_permissions.py`：默认拒绝、按完整站点/账户别名/scope 隔离，CLI grant 强制 `--confirm`，revoke 与审计，SHA-256 版本校验，损坏文件/符号链接拒绝、非公开域名/错误 scope 拒绝。
- 只读 Agent 工具 `poppy_permission_check` 仅在 `--poppy` 开启，不能通过模型工具 grant/revoke，`local_intent=recorded` 依然 `may_execute_remote_action=false`。
- Poppy 1.0 `scope_hints` 未知 changes 按不可逆、个人数据字段缺失按未知处理，均不等于真实远端授权。
- GitHub Actions [PR #19 运行 43825501917](https://github.com/js2005happy/angel/actions/runs/43825501917)：Ubuntu Python 3.10/3.12 与 Windows Python 3.12 全通过，Windows 共执行 313 项测试。全部采用临时目录和 mock，无真实网络或模型 API 花费。
- 后续 OAuth Session、HTTP MCP 与真实远端操作审批不在本 PR，不能把本地意向当作可执行授权。

## 已验证：Poppy 1.0 公共发现客户端首阶段（PR #18）

- `tests/test_poppy.py` 验证：公共域名标准发现、精确重定向路径、Poppy 1.0 及同主机备选版本、组织域名绑定、HTTP/URL 凭据/端口拒绝、公开 DNS 检查与 pinned-IP TLS、默认隐藏工具/只读显式开启、无需 Provider 的 CLI 诊断。
- GitHub Actions [PR #18 运行 43823881880](https://github.com/js2005happy/angel/actions/runs/43823881880)：Ubuntu Python 3.10、Ubuntu Python 3.12、Windows Python 3.12 全部通过，Windows 测试共 299 项。无真实外站请求、付费模型调用或外部 MCP 连接；网络层使用模拟 HTTPS/DNS 回归。
- 已知限制：尚未实现 Poppy Session、OAuth issuer、DPoP、API 资源令牌或 UCP 商务调用；本阶段只发现而不执行。

## 已验证：长期记忆浏览器（PR #17）

- `tests/test_memory_browser.py` 测试全局及独立机器人完整记忆读写、token 鉴权、未知机器人及路径穿越拒绝、符号链接不越界、超过 64 KiB 不允许网页编辑。
- 模拟另一个 Agent 在读取与保存之间调用 `append_memory`：确认服务器返回 409 且不会覆盖新记忆；文件修订号按原始 UTF-8 字节 SHA-256 校验。
- 测试手动与自动会话压缩不改动长期 MEMORY.md 原始内容，并且 Agent 下次任务仍加载所选记忆。测试使用假 Provider，不消耗真实模型 API。
- GitHub Actions [PR #17 运行 43821614526](https://github.com/js2005happy/angel/actions/runs/43821614526)：Ubuntu Python 3.10、Ubuntu Python 3.12、Windows Python 3.12 全部通过；Windows 运行 281 项 unittest。测试没有真实模型 API 费用。
- 保留限制：没有跨进程锁，也未实现所有历史记忆的语义自动检索；本期仅管理完整文件并保留原有最近 40 行注入策略。

## 已验证：单文件 apply_patch、审批 diff 和 /diff（PR #16）

- `tests/test_apply_patch.py`：严格 hunk 匹配、多段修改/插入/删除、过期文件、错误行号、LF/CRLF、无尾换行、越界保护、权限审批、审批中并发修改、检查点撤销及 Web UI 多行预览。
- `tests/test_checkpoint_cli.py`：实际 REPL `/diff` 查看最新检查点，并在 `/undo` 后不再显示原差异。
- GitHub Actions [PR #16 CI 43814541490](https://github.com/js2005happy/angel/actions/runs/43814541490)：Ubuntu Python 3.10、Ubuntu Python 3.12 和 Windows Python 3.12 全部通过，Windows unittest 日志显示 265 项通过。测试用假 Provider，没有实际模型 API 消费。
- 限制：不增加 Shell、MCP、E2B 写入能力，也不提供跨文件补丁原子事务、完整工作树 diff 或 OS 级沙箱。

## 已验证：本地文件检查点与 /undo、/rewind（PR #15）

- `tests/test_checkpoints.py` 验证新建/覆盖/编辑/plan 以及二进制原件恢复、一次任务多次写入只有一条检查点、子 Agent 继承、跨轮 rewind、重启后的恢复。
- 验证文件被用户修改、原始备份损坏、出现符号链接/越界时拒绝回滚，所有文件的冲突预检先于任何恢复；文件过大或轮次超限失败保护。E2B 写入不产生虚假的本地检查点。
- `tests/test_checkpoint_cli.py` 使用假模型驱动交互 REPL 验证 /undo、/rewind 2、非法轮数、/new 会话隔离和撤销后会话通知。
- GitHub Actions [PR #15 运行 43811411177](https://github.com/js2005happy/angel/actions/runs/43811411177)：Ubuntu Python 3.10/3.12 和 Windows Python 3.12 全部通过；Windows 运行 247 项 unittest。使用临时目录和假模型，无真实 API 费用。
- 限制：Shell/MCP/E2B/HTTP 不在范围内，多文件恢复不是 OS 事务，异常退出可能留下不能自动安全恢复的未完成记录。


## 已验证：精确会话授权及 Shell 起始目录约束（PR #14）

- `tests/test_workspace_writes.py` 更新原有会话授权行为：`a` 仅对同一文件和工具有效，换文件/工具再批准；Shell 同时匹配规范化 cwd、timeout、后端和命令文本。
- 新增工作区外的 ../、绝对路径、符号链接的 shell cwd 拒绝测试；模拟 E2B 拒绝工作区外 cwd、合法相对 cwd 可执行；Web UI 回调不会被旧授权绕过。
- GitHub Actions [PR #14 CI 43804261790](https://github.com/js2005happy/angel/actions/runs/43804261790)：Ubuntu Python 3.10/3.12 和 Windows Python 3.12 全部通过；Windows 日志显示 227 项 unittest 通过。测试使用临时目录和 fake backend，无真实 API 调用。
- 已知限制：尚不测试或承诺 OS 沙箱、命令内部的跨目录访问或远端 E2B 符号链接隔离。


## 待验证：工作目录内置文件限制与会话审批

- `tests/test_workspace_writes.py`：覆盖本机 write/edit/plan 越界、绝对路径、外部符号链接、合法嵌套写入，以及 E2B POSIX 路径边界；模拟模型不需任何 API 费用。
- 验证 auto 的 `a` 仅缓存批准的单个文件工具或 shell 完全相同命令及 cwd；不允许 readonly/后台 auto 通过缓存；MCP/http_post/记忆/技能依旧逐次确认。
- 不声称完全阻止 shell 写出工作区或保证远端 E2B 符号链接目标；需等待 Ubuntu Python 3.10/3.12、Windows Python 3.12 CI 验证。


## 已验证：两阶段计划模式（PR #12）

- `tests/test_plan_mode.py` 使用模拟 Provider 测试只读工具白名单、路径穿越与符号链接、拒绝 shell/写入/MCP、旧计划在失败后不变、SHA-256 绑定批准。
- CLI 测试验证规划阶段不实例化 Agent/MCP/E2B；执行默认 auto（包括全权配置的情况），错误哈希不启动 Agent，与 JSONL 冲突得到错误。
- GitHub Actions [PR #12 CI 运行 43799280549](https://github.com/js2005happy/angel/actions/runs/43799280549)：Ubuntu Python 3.10、Ubuntu Python 3.12、Windows Python 3.12 全部通过；Windows 日志显示 211 项 unittest 全部通过。测试使用假模型，无实际 API 费用。


## 未发布：memory_append / save_skill 测试补齐（2026-11-16）

- 本轮先把本地 checkout 与 GitHub main 同步：本地停在 5cfad1f，远程已走到 b9248f28（网页界面、项目官网、群聊、Token 用量 5 个提交）；56 个文件经连接器拉取同步，同步后全套测试 164 个通过。
- 新增 `tests/test_memory_skill_tools.py`（11 个）：`memory_append` 与 `save_skill` 的直接单元测试，v1 已知限制第 3 条就此关闭；测试只写临时目录（验证：跑完后 `~/.angel/` 下仍无 MEMORY.md）。
- README 测试数 127 修正为 175（164 + 11），版本号标题修正为 0.3.0。本次未做真实 API 调用（纯 mock 测试加固，无需调用）。

## 待验证：Token 用量与剩余上下文（PR）

- 新增 `tests/test_usage.py`，验证真实 API usage 累计、缺失或畸形数据不产生伪值、模型上下文上限仅在明确配置时生效。
- 覆盖 Agent 用量事件、CLI `/status`、一次性任务 stdout/stderr 分离，以及 Web UI 会话状态与展示标记。
- 使用模拟模型返回，不实际消耗 API Token；需要等待本 PR 在 Linux 3.10/3.12 和 Windows 3.12 全部通过后再合并。


## 未发布：多机器人群聊与独立 Agent 验证

- `tests/test_group_chat.py`：成员独立 system 身份、会话文件与 workspace、私有记忆、不同模型、@mention 路由、持久化、创建校验和讨论上限。
- `tests/test_group_webui.py`：本地 HTTP 服务测试群聊创建/发送/获取、 token 鉴权、独立 JavaScript 静态资源与 CSP。
- `tests/test_delegation_budget.py`：子 Agent 委派次数、递归深度、最大轮数以及角色和记忆继承。
- 通过 GitHub Actions Ubuntu Python 3.10、3.12 与 Windows Python 3.12 的跨平台验证后才合并；测试使用假模型而不花 API 费用。
- 群聊 MVP 默认只读且串行回应，不代表真实生产多 Agent 并行执行或自主后台运行已完成。


## 未发布：MCP 启动授权（含新 Web UI 兼容性）

- `tests/test_mcp_startup.py` 使用真实本地模拟 MCP stdio 进程启动标记，覆盖 readonly/非交互 auto 未启动、终端交互逐台批准、full 启动、旧 Windows 输出编码及 REPL 模式切换。
- `tests/test_webui_mcp_mode.py` 覆盖 Web UI 权限降级时关闭进程、升为 full 时重新加载、任务执行中拒绝切换，以及相同模式不重复启动。
- Web UI 新功能被保留，不覆盖任何已合并的 UI/官网源码。仅以 GitHub Actions 当前 PR Linux/Windows 结果为真实回归测试证据；这是进程启动控制，不是 OS 沙箱。


## 未发布：MCP 子进程环境隔离验证

- 新增单元测试 `tests/test_mcp_environment.py`：验证默认不继承模型 API Key、显式环境传递、配置格式错误及实际 Python MCP stdio 子进程的环境可见性。
- 只有 GitHub Actions 中 Linux/Windows 检查成功，才能认为新变更通过回归测试；与先前真实 DeepSeek/E2B 端到端测试不同。
- 安全边界：这是环境变量过滤，不代表进程、磁盘或网络沙箱。


## 未发布：跨平台稳定性修复（2026-11-16）

- GitHub Actions [运行记录](https://github.com/js2005happy/angel/actions/runs/43778155074)：Ubuntu Python 3.10、Ubuntu Python 3.12、Windows Python 3.12 均通过语法编译、单元测试、CLI 版本检查。
- Windows 任务日志显示 `Ran 67 tests`，其中包含新增 5 项 Windows/MCP/沙盒路径回归测试；测试使用 mock 和本地子进程，不需要真实模型或 E2B 凭证。
- 修复了 Windows 匿名管道无法使用 `select.select()` 的 MCP stdio 超时问题；Python MCP 服务默认使用 UTF-8 输出；旧代码页的 CLI/daemon 输出自动安全降级；E2B 路径始终按 Linux/POSIX 规则解析。
- 本次证明的是跨平台模拟测试通过，**没有**重新进行真实模型 + E2B 端到端集成测试；v3 的既有端到端验证记录见下文。

---

## v3 结论

Angel 0.3.0 已完成并全部通过测试：62 个 mock 测试通过（v2 的 53 个全部保留并通过，新增 9 个）；E2B 沙盒执行后端已接进 Angel 本身，真实 DeepSeek + 真实 E2B 沙盒端到端跑通。

## v3 新增内容

| 模块/文件 | 说明 |
|---|---|
| `angel/e2b_backend.py`（新增） | E2B 沙盒执行后端：懒加载官方 `e2b` SDK（可选依赖），凭证优先 `E2B_API_KEY`、否则走已保存的 Muse 连接器凭证替身；`connect()` 新建或连接已有沙盒；`run_command` / `read_file` / `write_file` / `list_dir`；`close()` 不杀沙盒（到期自动销毁） |
| `angel/tools.py`（改） | `ToolContext` 增加 `backend` 字段；`read_file` / `write_file` / `edit_file` / `list_dir` / `shell` / `plan` / `grep_search` / `git_status` 有后端时走后端，其余工具仍在本地；审批与 shell 黑名单在两种后端下都生效 |
| `angel/config.py`（改） | `sandbox` / `e2b_template` / `e2b_timeout` / `e2b_sandbox_id` 配置 + `resolve_sandbox()`（CLI 参数 > `ANGEL_SANDBOX` / `ANGEL_E2B_*` 环境变量 > 配置文件 > 默认值） |
| `angel/agent.py`（改） | `Agent` 接受 `backend` 参数并传给 `ToolContext`；`delegate()` 把同一后端传给子 agent；系统提示词在沙盒模式下告知模型文件与命令都在沙盒里执行 |
| `angel/cli.py`（改） | `--sandbox {local,e2b}`、`--sandbox-id`、`--sandbox-template`、`--sandbox-timeout`；沙盒模式下工作目录默认 `/home/user`（沙盒路径，不在本地校验）；连接成功打印沙盒 id 与超时 |
| `scripts/remote_run.py`、`scripts/upload_angel.py`（新增） | 第 1 步原型验证脚本（大脑在外、手在沙盒）与把 Angel 代码传进沙盒跑测试的脚本 |

## v3 测试结果

### 1. Mock 测试（62 个，全部通过）

```bash
cd ~/workspace/angel
python3 -m unittest discover tests   # Ran 62 tests — OK
```

新增 9 个测试覆盖：FakeBackend 路由（读写改列文件、shell、plan、grep/git_status 走后端、本地零写入）、沙盒模式下黑名单与只读模式仍生效、E2B SDK 缺失时报明确安装提示、`E2B_API_KEY` 优先于连接器、`resolve_sandbox` 默认/环境变量/非法值、delegate 把后端传给子 agent。

### 2. 真实 DeepSeek + 真实 E2B 沙盒端到端

```bash
cd ~/workspace/angel
~/workspace/angel/.venv/bin/python -m angel --provider deepseek --mode full \
  --sandbox e2b --sandbox-id ipfjq62okgtm53z1fl8io --max-turns 8 \
  "在工作目录创建 sandbox-demo.txt，内容是'Angel 在沙盒里'，然后读出它确认，再列出工作目录"
```

结果：成功。Angel 连接沙盒 `ipfjq62okgtm53z1fl8io`，模型在沙盒里写 `/home/user/sandbox-demo.txt`（内容 `Angel 在沙盒里`）、读回确认、列出目录（`.bashrc`、`.profile` 等沙盒自带文件 + 本次新建的文件）。随后用 E2B SDK 独立回读确认：沙盒里确有该文件且内容一致；本地 `/home/user` 根本不存在，零写入。

### 3. 第 1 步原型（remote_run.py）

模型走 DeepSeek 连接器、工具走 E2B 沙盒，4 轮完成：写 `prime_sum.py`、沙盒里运行、结果 1060、读回确认。Angel 代码 28 个文件已上传进同一台沙盒，`--help` 正常，53 个测试在沙盒里全过。

## v3 已知限制（诚实记录）

1. **E2B 免费档沙盒超时上限 1 小时**：`--sandbox-timeout` 超过 3600 会被 E2B 拒绝（HTTP 400）；沙盒不主动删除，到期自动销毁。
2. **定时任务仍走本地执行**：`angel schedule` 创建的任务不读沙盒设置；沙盒模式只对本次命令行/交互会话生效。
3. 其余 v2 限制（web_search 未在真实网络验证、MCP 未接真实服务器、调度器 naive 本地时间、无真浏览器）仍适用。

---

# Angel 验证报告（2026-11-16，v2 0.2.0）

## v2 结论

Angel 0.2.0 已完成并全部通过测试：53 个 mock 测试通过（v1 的 21 个全部保留并通过，新增 32 个）；真实 DeepSeek API 端到端跑通（新工具 `grep_search` 实测）；MCP、调度器、会话压缩、证据链、provider 档案、web_search 双后端均已验证。

## v2 新增内容

| 模块/文件 | 说明 |
|---|---|
| `angel/mcp.py` | MCP 客户端（stdio JSON-RPC）：启动、initialize、list_tools、call_tool、超时控制；`MCPToolManager` 按最长前缀路由，工具名 `mcp_<服务器>_<工具>`；默认关闭（`mcp_enabled`） |
| `angel/scheduler.py` | 内置调度器：`~/.angel/schedule.json` 文件式任务，间隔或每天固定时间，daemon 循环；到期判断、运行记录、错误隔离 |
| `angel/compact.py` | 会话压缩：模型摘要 + 保留最近消息；模型失败时本地回退（保留首尾消息）；支持压缩整个会话文件 |
| `angel/evidence.py` | 证据链：联网抓取的页面原文按会话存档（`~/.angel/evidence/<会话 id>/`），带来源、时间、搜索词 |
| `angel/tools.py`（新增） | `grep_search`（文件内容搜索，支持正则/大小写）、`git_status`（只读）、`http_post`（走审批）；`web_search` 改为必应优先、百度兜底 |
| `angel/config.py`（新增） | `profiles` 档案 + `resolve_profile`（CLI 参数 > `ANGEL_PROFILE` 环境变量 > 配置默认值）；`mcp_enabled` 开关 |
| `skills/verify-research.md` | 核查式调研技能：搜索→打开官网→逐项核对→存证→附链接交付 |
| `angel/agent.py`（改） | MCP 工具路由、证据 store、`/compact` 与 `compact()`、系统提示词加入查证流程 |
| `angel/cli.py`（改） | `schedule` 子命令（list/add/remove/run/daemon）、`--profile`、`--compact`、`--list-mcp`、`--list-profiles`、REPL `/compact` |

## v2 分工（Codex 生成 vs Muse 写/改）

- **Codex 生成（按 Muse 的规格逐模块生成，Muse 落盘并逐一测试）**：`mcp.py`、`scheduler.py`、`compact.py`。三个模块一次通过编译与导入，无需返工；`scheduler.py` 的 `is_due` 有一处逻辑由 Muse 在测试后修正（见下）。
- **Muse 写/改**：全部 v2 规格、集成改动（`config.py` 档案与开关、`tools.py` 新工具与 web_search 双后端、`agent.py` 路由与证据接线、`cli.py` 子命令与档案接线）、`evidence.py`、`verify-research` 技能、全部 32 个新增测试、文档更新（README/DESIGN/VERIFICATION/CHANGELOG）、全部测试与真实 API 验证。
- **Muse 修正**：`scheduler.py` 的 `is_due`：原实现对“每天固定时间”任务只要从未运行就判到期，导致上午 9 点就触发 10:30 的任务。已改为：未到今天的执行时间就不到期（即使从未运行过），测试 `test_is_due_daily_at` 覆盖。

## v2 测试结果

### 1. Mock 测试（53 个，全部通过）

```bash
cd ~/workspace/angel
python3 -m unittest discover tests   # Ran 53 tests — OK
```

新增 32 个测试覆盖：MCP（假 stdio JSON-RPC 服务器：列工具、调用、未知工具、坏服务器优雅失败、配置校验）、调度器（任务校验、到期判断、间隔/每天固定时间、运行记录、daemon 两轮）、压缩（模型摘要、失败回退、空会话、整文件压缩）、provider 档案（默认/命名/未知报错/列表）、证据链（存档与列表、web_fetch 存证）、新工具（grep 纯文本/正则/大小写、git 非仓库与真仓库、http_post 本地回显、只读模式拦截）、web_search 解析器（必应/百度固定 HTML、拦截页报错、双后端全失败时明确报错）。

### 2. 真实 API 调用（DeepSeek flash，凭证走已保存连接器）

```bash
python3 -m angel --provider deepseek --model deepseek-flash --mode full \
  --workdir /tmp/angel-v2-e2e \
  "用 grep_search 找到工作目录里包含“香蕉”的文件和行号，把结果写进 result.txt，然后告诉我找到了什么"
```

结果：成功。模型调 `grep_search` 找到 `fruits.txt:2` 与 `more.txt:2`，写入 `result.txt` 并读回复核，还主动提醒 `result.txt` 自身含“香蕉”会导致下次搜索多一条命中。会话存于 `~/.angel/sessions/20261115-235218-1493.jsonl`。

### 3. CLI 新功能实测

- `python3 -m angel schedule list`：无任务时正常提示，exit 0。
- `python3 -m angel --list-mcp`：MCP 未启用时提示在配置里设 `"mcp_enabled": true`，exit 0。
- `python3 -m angel --list-skills`：列出 web-research、verify-research、file-organizer。
- `python3 -m angel --version`：Angel 0.2.0。

## v2 运行命令（给用户）

```bash
cd ~/workspace/angel

# 调度器：每天 08:30 跑一个任务
python3 -m angel schedule add --name 每日整理 --prompt "整理下载目录" --at 08:30 --mode full
python3 -m angel schedule daemon          # 守护进程跑起来
python3 -m angel schedule list             # 查看任务
python3 -m angel schedule run              # 立刻跑一次到期的任务

# 会话压缩
python3 -m angel --compact <会话 id>

# provider 档案（在 ~/.angel/config.json 的 profiles 里加档案后）
python3 -m angel --profile strong "做点什么"
python3 -m angel --list-profiles

# MCP（在 ~/.angel/config.json 里设 "mcp_enabled": true 并配 mcp_servers 后）
python3 -m angel --list-mcp
```

## v2 已知限制（诚实记录）

1. **web_search 双后端未在真实网络验证**：必应/百度解析器只在固定 HTML 上测过；本机网络下真实搜索是否通（必应是否也被拦、百度是否要求验证）尚未实测，下次真实调用时以实际结果为准。全部失败时工具会明确报错，不编结果。
2. **MCP 未接真实服务器验证**：只用假 stdio 服务器测过协议；真实 MCP 服务器的兼容性以实际接入为准。
3. **调度器是 naive 本地时间**：不处理时区；daemon 需自己保持进程运行（systemd/后台运行另行配置）。
4. **无真浏览器**：浏览器类工具（navigate/click/screenshot）未做，记入路线图；证据链是截图留档的轻量版。
5. 其余 v1 限制（无真沙箱、模型调用计费、auto + 非交互）仍适用，见下。

---

## v1（2026-11-15）结论

Angel 0.1.0 已完成并全部通过测试：Python 标准库 only，无 pip 依赖；21 个 mock 测试通过；真实 DeepSeek API 端到端跑通；REPL、会话恢复、auto 审批确认均已实测。

## 交付物

`~/workspace/angel/`，共约 2100 行代码+文档：

| 文件 | 说明 |
|---|---|
| `angel/config.py` | 配置 + provider 注册表（deepseek/xai/openrouter/ollama/openai/custom） |
| `angel/providers.py` | OpenAI 兼容客户端（urllib），支持 env Key 与已保存连接器凭证 |
| `angel/tools.py` | 11 个工具 + 审批 + shell 危险命令黑名单 |
| `angel/agent.py` | agent 主循环、系统提示词组装、delegate 子 agent |
| `angel/skills.py` | 技能解析 / 关键词匹配 / 保存 |
| `angel/memory.py` | 长期记忆 + AGENTS.md + 会话 jsonl 存储 |
| `angel/cli.py` | 参数解析 + REPL（/help /mode /skills /sessions /clear /new /exit） |
| `angel/__init__.py`、`angel/__main__.py` | 版本号与入口 |
| `skills/web-research.md`、`skills/file-organizer.md` | 自带示例技能 |
| `tests/test_smoke.py` | 21 个测试（stdlib unittest） |
| `README.md`、`DESIGN.md`、`LICENSE`（MIT） | 文档与许可证 |

## 分工（Codex 生成 vs Muse 写/改）

- **Codex 生成（按 Muse 的规格逐模块生成，Muse 落盘并逐一测试）**：`config.py`、`providers.py`、`skills.py`、`memory.py`、`tools.py`、`agent.py`、`cli.py`。6 个模块全部一次通过，无需返工（`tools.py` 的 web_search 提示文案由 Muse 后补一处，见下）。
- **Muse 写/改**：架构与接口设计、全部规格提示词、`__init__.py`、`__main__.py`、两个示例技能、`tests/test_smoke.py`、`README.md`、`DESIGN.md`、`LICENSE`、本报告；`tools.py` 的一处小修（见“已知限制”）；全部测试与真实 API 验证。

## 测试结果

### 1. Mock 测试（21 个，全部通过）

```bash
cd ~/workspace/angel
python3 -m unittest discover tests   # Ran 21 tests — OK
python3 tests/test_smoke.py          # 同样通过
```

覆盖：主循环（写→读→回答）、delegate 子 agent、会话保存/恢复、最大轮数截断、provider 错误透传、11 个工具的读写改列、shell 黑名单（`rm -rf /`、`rm -rf ~`、`mkfs`、`dd` 写设备、关机、fork 炸弹）、readonly 禁写、auto 非交互禁写、edit 歧义拒绝、plan 写文件、技能解析/匹配、配置解析、CLI `--list-skills` / `--version`。

### 2. 真实 API 调用（DeepSeek flash，凭证走已保存连接器）

```bash
python3 -m angel --provider deepseek --model deepseek-flash --mode full \
  --workdir /tmp/angel-e2e \
  "创建一个文件 hello-angel.txt，里面写一句英文问候，然后读回文件内容并向我汇报"
```

结果：成功。模型调用 `write_file` 写入 73 字符问候，再用 `read_file` 读回并中文汇报。文件内容：`Hello! It's a pleasure to meet you, and I hope you have a wonderful day.` 会话存于 `~/.angel/sessions/20261115-154741-0afd.jsonl`（即本次端到端 transcript）。

随后用 `--resume 20261115-154741-0afd` 追问文件内容，模型直接从会话历史回答，未再读写文件——会话恢复已验证。

### 3. REPL

`printf '/help\n/skills\n/exit\n' | python3 -m angel`：横幅、`/help`、`/skills`（列出 web-research、file-organizer）、退出均正常，exit 0。

### 4. auto 审批（PTY 实测）

用 PTY 驱动 `python3 -m angel --mode auto`，模型请求写文件时出现 `允许执行吗？[y/N]`，输入 `y` 后文件 `approved.txt` 创建成功（内容 `approved`），exit 0。证明交互确认链路真实工作。

### 5. web_fetch / web_search

- `web_fetch https://example.com`：正常抓取并提取文本。
- `web_search`：本机网络下 DuckDuckGo 返回人机验证页，工具返回明确提示（“DuckDuckGo 要求人机验证，当前网络下无法搜索”）而不是崩溃或假装有结果。见“已知限制”。

## 运行命令（给用户）

```bash
cd ~/workspace/angel

# DeepSeek（已保存的连接器凭证，不用再填 Key）
python3 -m angel "帮我看看这个目录里有什么"
python3 -m angel --mode full "创建一个文件 hello.txt，写一句问候"

# 交互模式
python3 -m angel

# Grok
python3 -m angel --provider xai "做点什么"

# 查看技能 / 会话
python3 -m angel --list-skills
python3 -m angel --list-sessions
```

## 已知限制（诚实记录）

1. **web_search 被 DuckDuckGo 拦截**：本机出口 IP 触发 DuckDuckGo 人机验证，搜索返回明确错误而非结果。换网络或接正式搜索 API 可解决；Muse 已补一处判断，让报错原因可读。这不是解析 bug。
2. **无真沙箱**：shell 以运行 Angel 的用户身份执行，MVP 只靠审批 + 黑名单挡危险命令；真沙箱在路线图第一项。full 模式请只在信任目录使用。
3. **memory_append / save_skill 未进单元测试**：这两个工具会写 `~/.angel/` 下的真实文件，单元测试里未覆盖；其代码路径已随主循环跑通过（工具分发表无问题），但未单独断言。
4. **模型调用要花钱**：软件免费，推理按 token 计费。本次验证总计只用了几百 token 的 deepseek-flash，成本可忽略；日常使用建议默认 flash 模型。
5. **auto + 非交互**：cron/管道运行时 auto 模式遇到写操作会明确报错退出，不会悄悄写入；后台任务请用 `--mode full`。
