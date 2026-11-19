# Nyra 变更记录

## 未发布（0.5.2）

- 手机 PWA 第 2 阶段（2026-11-19）：入场动画（约 3.4 秒：圆盘长出 → 光标飞入点击 → Nyra 字标出现；只在手机主屏幕独立窗口里播，一次冷启动只播一次，轻点跳过，系统开了“减少动态效果”时只淡入）；手机设置页（已允许规则列表 + 撤销、模式切换——切全权要两步确认，服务端也要求手机带 `confirm: "full"` 才放行、API Key 只提示“请在电脑上输入”、断开这台手机）。测试 +2 项；Playwright 模拟 Pixel 7（模拟 standalone 显示模式）跑过动画播放/跳过/普通标签不播/减少动态效果、设置页撤销规则与全权二次确认。
- 手机 PWA 移植到 Node（第 1 阶段，2026-11-19）：`/m` 换成新手机页 `src/webuiMobile.ts`（终端 v2 配色、渐变字标、彩色模式徽章、大触控目标；配对页、会话列表、当前对话、回退操作）。Codex 式审批卡：大“允许”按钮；“允许并不再询问”显示具体前缀规则、可选本会话/本项目（`src/approvalRules.ts`，危险或复合命令不给规则，匹配时重新检查，`; && | $() 反引号 换行` 绕不过；项目规则存 `~/.nyra/approval_rules.json` 0600，不写进项目目录）；“拒绝…”展开文本框，反馈作为工具错误带回 agent。终端“始终允许”与手机共用同一套规则（`tools.checkApproval` 统一查本会话/本项目规则）。`nyra ui --pair` 在终端画二维码（`src/qrcode.ts`，与 Python 版逐模块一致），`/api/pair/start` 返回 `qr_svg`。PWA 图标从 `docs/assets/nyra-mark.svg` 光栅化：192/512 any + maskable、apple-touch-icon 180、favicon（PNG + SVG），光标填白。新 API：`GET /api/rules`、`POST /api/rules/<id>/revoke`；审批决定接受 `scope` / `feedback`。测试：`tests/node/test-mobile-pwa-v2.test.ts` 16 项；Playwright 模拟 Pixel 7 跑过配对 → 允许并记住 → 拒绝并反馈。入场动画与手机设置页未做。
- 终端外观 v2（品牌化，2026-11-19，在上一条 Claude Code 风格的基础上加色彩与品牌感）：新增 `src/theme.ts`（品牌色取自 DESIGN.md UI v2：鼠尾草绿主色、雾蓝渐变色、蜜桃珊瑚点缀，为深色终端提亮；色彩等级 truecolor → 256 → 16 → NO_COLOR 无色，`NYRA_COLOR` 可强制，只看环境变量）。欢迎屏：5 行渐变块字 NYRA + 版本与一句话介绍，下面圆角信息卡（模型 / 彩色模式徽章 readonly 绿·auto 蓝紫·full 红·creator 珊瑚 / 目录 / git 分支——读 `.git/HEAD`，不 spawn git），再一行"提示"（/help、/mode、/undo、/pet，只列真有的命令）；窄于 60 列、ASCII 回退或非 TTY 退回单行 `✻ Nyra`。输入区：主色 `›`、暗主色横线；状态栏改为彩色分段左右对齐（模型 + 模式徽章 ｜ 上下文 n% · ⎇ 分支，放不下依次丢分支、上下文）。输出：助手回复以主色 `●` 开头，工具调用是暗色 `⎿` 树，结果绿 ✓ / 红 ✗，命令成功绿 ✓、错误红 ✗。新增 `src/spinner.ts`：思考时主色 braille spinner + "思考中…" / "运行 <工具>…" + 秒数，只在 TTY 上动；agent 运行期间其他输出（含 Bun `console.log`、审批菜单）会先收起 spinner 再写。新增终端小伙伴 `src/pet.ts`（原创造型，4 行 × 12 列，坐在输入区右侧）：idle 偶尔眨眼、thinking 眼珠随 spinner 转、成功开心、出错担心、等审批举手；偶尔冒一行小气泡（启动 60 秒内不冒、两次闲聊至少隔 150 秒，5 秒后消失）；`/pet [on|off]` 开关并写入 `config.json` 的 `pet`（缺省开）；非 TTY、< 80 列、ASCII 回退、CI 自动隐藏；动画用保存/恢复光标只画右侧固定列，不动 readline 光标，定时器全部 unref。`src/approvalUi.ts` 新增 `approvalHooks`（审批前后钩子，出错忽略，审批语义不变）。启动耗时不变（同条件 pty 测到出现输入框：改前 65–68 ms，改后 67 ms）。测试：`test-banner.test.ts` 重写为 25 项（含与 P2-3 成本段合并后的状态栏），新增 `test-tui-theme-pet.test.ts` 16 项（色彩等级、NO_COLOR、渐变、spinner 非 TTY 不动、小伙伴帧尺寸 / 表情 / 可见性 / 控制器定时 / `/pet` 解析、工具调用树）。
- 终端外观改成 Claude Code 风格（`src/banner.ts`、`src/cli.ts` 的 REPL 与信任确认）：删掉 11 行 `###` 大字标；头部改为圆角小框（✻ Nyra <版本>，下面是模型 / 模式 / 工作目录，长路径用 `~` 与省略号缩短）；工作区信任改为简短框式确认（仍是 y/N）；输入区是两条横线夹一行 `> `，下面一行暗色状态栏（模型 · 模式 · 上下文）。Node 版没有 shift+tab 切换模式，所以不显示该提示（`renderStatusBar` 的 `modeSwitchKey` 留给以后接上）。NO_COLOR 只去颜色、布局不变；窄终端不画框、逐行截断；Windows 上只在 Windows Terminal / VS Code / ConEmu / mintty 等确认能显示框线的宿主用框线，裸 conhost 退回纯 ASCII（`NYRA_ASCII=1` / `NYRA_UNICODE=1` 可强制）；探测只看环境变量，不 spawn、不加依赖。非 TTY 时仍是纯文本状态行，提示符改为 `> `。测试：`tests/node/test-banner.test.ts` 改为新布局的快照与单测 14 项。
- Node CI #73 附带小修（不是 #38 的真回归）：#38 合入后 main 上 Node CI #73 只有 Windows 任务失败，ubuntu/macOS 同一提交全过；两个失败都是 5000ms 超时、无断言错误（`test-gateway-sandbox.test.ts`「网关沙箱：默认断网」5187ms、`test-knowledge.test.ts`「大知识库异步/同步搜索一致性」9084ms），是 Windows 运行器偏慢导致的偶发超时。按之前 rewind 用例的做法，给这两个用例单独加 15000ms；测试逻辑本身未动。
- P1-2 证据链落盘：工具调用 → 产物 → 校验结果三元组可回放。`src/runs.ts`：`RunState` 加可选 `file_hashes`（运行结束时为每个改动文件记 sha256，成功与失败路径都记，读不到跳过、失败不影响运行）；新增 `RunStore.readEvents()`（读 `events.jsonl`，跳过损坏行）；新增 `verifyEvidenceChain()`（五项检查：verify-result、tool-calls-closed、artifacts-present、artifacts-hash、tests-modified 只警告不失败）与 `formatEvidenceReport()`；新增 `nyra evidence verify <运行 ID>`（`src/cli.ts`，通过 0、链不完整 4、运行不存在/记录损坏 1、用法错误 2）。复用现有 `evidence.ts` / `artifacts.ts` / `runs.ts` / `--verify`，未另发明存储格式。文档 `docs/evidence.md`。测试：`tests/node/test-evidence-chain.test.ts` 11 项（含 CLI 级 spawn 真测）。诚实边界：复核不重跑验证命令，只核对记录自洽与产物未改；旧运行无 `file_hashes` 时哈希检查失败并明说原因。
- P1-4 断点续跑不重复副作用：幂等键 = `sha256(工具名 + "\n" + 参数的稳定序列化)`（键序无关）。`src/tools.ts` 新增 `stableStringify` / `idempotencyKey` / `RESUME_IDEMPOTENT_TOOLS`（只含 `verifyWriteApplied` 能读回核查的 5 个写工具：`write_file`、`edit_file`、`plan`、`memory_append`、`save_skill`）与 `resumeWriteAlreadyDone()`（键命中 **且** 读回核查仍证明写入已生效才跳过；中断后文件被外部改动/删除时重执行，不撒谎）；`src/runs.ts` 的 `RunRecorder.call()` 在 `tool_start` / `tool_result` 事件记 `args_hash`，新增 `loadCompletedWriteKeys()`；`src/agent.ts` 分派循环在参数校验后、循环守卫之前查跳过（跳过的调用不进守卫计数）；`src/cli.ts` 的 `--resume-run` 路径接线并打 stderr 提示。附带修掉一个真问题：`appendEvent` 的脱敏会把 64 位十六进制的 `args_hash` 当密钥打码成 `[已隐藏]`，现对该字段豁免（单向指纹，不可还原参数原文）。`shell` / `apply_patch` / `http_post` / 浏览器与电脑操作 / `delegate` / MCP 不参与去重（相同参数不等于相同结果），续跑时照常重执行。文档 `docs/resume.md`。测试：`tests/node/test-resume-idempotent.test.ts` 7 项（含跳过、正常执行、外部改动重执行、文件删除重执行、记录器往返）。
- P1-3（失败三分类）：DeepSeek 的 PR #40 已合入 main（e0b1c8a；Node CI #81 与 Node binaries #118 均绿），我方按避让规则未重复做；#42（P2-1 运行前成本预估，4773df4）亦已合入，Node CI #83 与 Node binaries #120 均绿；合入后主干本地验证干净（tsc 0、全量 959 项全过、探针 6/6、预算全过）。#41 的证据链自洽审计扩展未随 #42 进 main（main 里只有我方 P1-2 的 `nyra evidence verify <运行 ID>`，无 `--last` / `evidence list`），若 DeepSeek 之后再合，需核对与我方 verify 实现有无重叠。
- P2-3 实时看板：每轮更新已花费/剩余。`src/dashboard.ts` 新增 `buildDashboardSnapshot` / `formatDashboardLine` / `dashboardCostSegment`（纯函数，复用 `cost.ts` 的 CostGuard 三态与 `usage.ts` 的快照，不另发明计费口径）；`src/agent.ts` 的 `runLoop` 每轮发一次 `cost_update` 事件（与 `usage` 事件不同：`usage` 只在 provider 报了用量时发，`cost_update` 每轮都发，算不出金额时状态写 `unpriced`/`missing`、金额为 `null`）；`src/jsonMode.ts` 的 `agentEvent` 透传 `cost_update`；`src/consoleUi.ts` 的 `ToolPrinter` 每轮打印一行看板，`formatReplStatus` 加可选第 5 参数成本段；`src/cli.ts` 的 REPL 状态行在 `agent.lastCost` 有值时追加 `成本 $x/$y` 或 `成本未知`（纯文本回落分支与框式状态栏两路都接，框式栏走 `src/banner.ts` 的 `renderStatusBar` 可选 `cost` 字段）。文档 `docs/dashboard.md`（新建）与 `docs/json-events.md`（`cost_update` 一行 + 不变式说明）。测试：`tests/node/test-dashboard.test.ts` 13 项（含 Agent 级 FakeProvider 真跑：每轮一个 `cost_update`，金额与 usage 对得上；无 usage 时状态为 `missing`、金额为 `null`）。诚实边界：自动压缩里那次额外调用的用量不单独发事件，直接并进下一轮累计值；成本硬顶触发的那轮不发 `cost_update`（错误信息本身已写明已花费与上限）。
- P0-6 Windows 沙箱（Job Object）：macOS 已有 Seatbelt（#39），补 Windows 一侧。选型：Job Object（纯 PowerShell + Add-Type P/Invoke 调 kernel32，不依赖原生模块）能落地；AppContainer 要建容器档案、配 capability SID、走 STARTUPINFOEX，且默认拿不到用户文件，不适合做默认后端——取舍见 `docs/sandbox.md`。`src/windowsSandbox.ts`（新建）：`buildJobObjectScript`（纯函数：建作业、设限制、起 `cmd.exe /c (<命令>)`、接进作业、等退出、原样传回输出与退出码；命令与工作目录走 Base64 进脚本，无引号转义问题）、`findPowerShell`（pwsh 优先）、`windowsSandboxAvailable`、`runWindowsSandboxed`、`describeJobObject`；限制固定带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（0x2000，作业关柄即全杀），进程数上限默认 64（0x8），作业总内存上限默认不设（可选）；`src/sandbox.ts`：后端加 `jobobject`（`SANDBOX_BACKENDS`、类型、`resolveSandboxBackend` 分支：非 Windows 或无 PowerShell 即 fail-closed，`danger-full-access` 互斥），`auto` 不自动选 Job Object（与 Seatbelt 同款契约，文档写明），`getSandboxStatus` 的 detail 按 level 全列（顺带修掉旧 bug：之前只有 bwrap 一个分支，seatbelt 会误落进工具级提示；现抽成纯函数 `describeSandboxLevel`，`doctor.ts` 的级别文案抽成 `sandboxLevelText`，此前 seatbelt/jobobject 会误显示"未生效"），`toolLevelFallbackNotice` 在 Windows 上提 Job Object 而非 bwrap；`src/tools.ts` 的 `toolShell` 加 `jobobject` 分支（与 Seatbelt 分支同款 fail-closed 语义；输出不是流式，不传 `onStream`）。文档 `docs/sandbox.md`（后端表、平台表、Windows 一节）。测试：`tests/node/test-windows-sandbox.test.ts` 10 项（脚本生成、Base64、无引号漏洞、内存上限可选、`danger` 拒、探测、解析、文案；真执行两例只在 win32 上跑）。诚实边界：Job Object 只管进程生命周期与资源，不管文件与网络（仍由工具级规则兜底，文档不夸大）；子进程先启动再接进作业，有毫秒级窗口；未在真机 Windows 上跑过，靠 CI 的 Windows 任务验证。
- README 的“更新了什么”一节与五处版本号本次不动（仍保持 0.5.1），等发版时再补。
- 沙箱补齐两处缺口（0.5.1 已知缺口收尾）：① 群聊机器人：`GroupStore` 增加 `sandbox` 选项，`defaultBotRunner` 建 Agent 时原样透传，网关构造时传 `resolveSandbox(this.config)` 的结果（只做配置解析，不查后端二进制是否存在——后端不可用时不拦网关启动，留给机器人跑 shell 时逐次 fail-closed）；② MCP 服务器进程：`MCPToolManager` 增加 `sandbox` 选项（`buildMcpManager` 透传，网关 `ensureMcpManager` 传 `sandboxSettings()` 与网关工作区），`startAll()` 里用 `resolveSandboxBackend` 解析一次、失败整批拒绝启动；每个服务器进程的 spawn 参数由新增纯函数 `sandboxedMcpSpawnArgs` 算出——`local` 原样启动，`bwrap` 复用新增的 `buildBwrapArgv`（argv 版，不经过 `/bin/sh -c`，stdio 管道原样透传；服务器命令与绝对路径参数所在目录追加只读绑定），`seatbelt` 走 `sandbox-exec -p <profile>`（与 shell 同款 profile），`jobobject` 装不下长驻 stdio 进程、显式指定直接拒绝，`e2b` 未接线、显式指定直接拒绝。两处都与 `sandbox.ts` / `windowsSandbox.ts` / `seatbelt.ts` 同一后端解析口径，显式后端不可用时拒绝执行、不静默裸奔。文档 `docs/sandbox.md`（新增“群聊机器人与 MCP 服务器进沙箱”一节）。测试：`tests/node/test-groups.test.ts` 新增 2 项（显式未知后端时命令不执行且拒绝原因回到模型上下文；`local` 后端正常执行——生产上群聊只允许 `readonly` 机器人，测试直接改 `room.json` 模拟已单独授权的执行型机器人，只验透传本身），`tests/node/test-mcp.test.ts` 新增 10 项（spawn 参数纯函数 7 项 + Manager 整批拒绝 / `local` 正常启动 / Client 直接拒绝）。诚实边界：MCP 服务器在 bwrap/Seatbelt 里只能读写工作区与临时目录，需写工作区外文件的服务器会跑不起来；Windows/macOS 真机未验证。
- 会话钩子补齐两处（0.5.1 已知缺口收尾）：① 网关新增逐会话关闭 `DELETE /api/sessions/:id`（`Gateway.closeSession`）：触发一次 `SessionEnd`（与 `stop()` 去重，只触发一次）并从 live 会话表里删掉该会话，持久化会话文件保留；运行中的会话回 409（不中途杀任务），不存在的回 404；关闭时等钩子跑完再回 200（有超时封顶）；② 一次性 CLI 任务触发会话钩子：`main()` 分发层用新增的 `withOneShotSession` 包住 `runOneShot` 与 `runJson` 两条路——任务开始前一次 `SessionStart`、结束（成功/失败/异常）后 `finally` 里一次 `SessionEnd`，钩子 fail-open、不改退出码、不碰 `--json` 的结构化 stdout。文档 `docs/hooks.md`（事件表与触发点两处更新）。测试：`tests/node/test-session-hooks.test.ts` 新增 4 项（逐会话关闭触发一次且关停不重复、关闭不存在/运行中、子进程一次性任务真测：ollama provider 无真实服务，任务失败但钩子开始/结束各一次）。
- 重试补齐两处：① `KeyRotatingProvider` 加同 key 重试（与 `FallbackProvider` 同款规则：换 Key 前先重试同一把，至多 2 次、退避 1s/3s + ±25% 抖动、可中断，受整条链 2× 单次超时总预算约束、重试超时按剩余预算封顶低于 0.2 秒不重试；只有瞬时错误 `rate_limit` / `server` / `timeout` / `network` 可重试，用量上限文案除外；401/403 类认证错不重试同一把、直接换 Key，轮换语义不变）；新增 `retries` 记录与 `onRetry` 回调、`KeyRotatingProviderOptions`（`retryDelaysMs` / `sleep` / `onRetry`），`chat()` 加可选 `opts.signal`。② `executeToolIdempotent` 重试不重走审批与钩子：重试调用前把 `ToolContext.idempotentRetry` 置 `true`、结束后 `finally` 恢复，`executeTool` 据此跳过 Pre/PostToolUse 钩子（首次调用的入参改写是原地改 `args`，重试时仍生效），`checkApproval` 据此跳过人工弹窗/`approveFn`——短路点放在只读拒绝与权限规则 `deny` 之后，这两条硬控制重试也绕不过。文档 `docs/idempotent-retry.md`（两处更新）。测试：`tests/node/test-providers.test.ts` 新增 4 项（瞬时错误重试后成功且无切换、认证错不重试直接换 Key、用量上限不重试直接换 Key、全失败后每把各调 3 次且重试记 4 条），`tests/node/test-idempotent-retry.test.ts` 新增 3 项（重试调用带标记且结束后恢复、重试不弹审批、重试不跑钩子）。
- JobMemoryLimit 语义修复（0.5.1 已知缺口收尾）：`src/windowsSandbox.ts` 的 `buildJobObjectScript` 里 `BasicLimits` 第二个字段名叫 `JobMemoryLimit`，但它在 `JOBOBJECT_BASIC_LIMIT_INFORMATION`（class 2）里的真实含义是 `PerJobUserTimeLimit`；布局字节数恰好对得上所以 echo 测试不受影响，但 `maxMemoryMB > 0` 时那条路径会往该槽位写内存字节数并带 0x200 标志，语义是错的（512MB 会被当成约 54 秒 CPU 时间）。改用扩展结构 `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`（class 9：嵌套 `BasicLimits` + 6 个 IO 计数器 + 4 个内存字段），`SetInformationJobObject` 改传 class 9；`BasicLimits` 第二字段正名为 `PerJobUserTimeLimit`。文档 `docs/sandbox.md`（Job Object 表格注）。测试：`tests/node/test-windows-sandbox.test.ts` 内存上限用例同步改断言并新增 `script_memory_limit_uses_extended_limits`（结构含 `ExtendedLimits` 与 `PerJobUserTimeLimit`、无错名字段、走 class 9、限制标志仍挂嵌套 `BasicLimit` 上）。诚实边界：未在真机 Windows 上跑过，靠 CI 的 Windows 任务验证。
- `--sandbox e2b` 接线评估（0.5.2，结论：暂不接线，见 `docs/sandbox.md` 新增一节）：① Node 侧没有执行路径——连接器 REST API 只有控制面（list/create/get/kill），沙箱内执行要走 E2B SDK（Python SDK 在 `~/workspace/angel/.venv`，Node 的 `@e2b/sdk` 不在 `bun.lock` / `node_modules` / `package.json`）；② 凭据不在 Nyra 配置里（`E2B_API_KEY` 只在 Muse 连接器安全存储中，需先定落点）；③ 生命周期与现有后端形态不匹配（一锤子 `runSandboxed` vs 长驻沙箱，默认超时 1800 秒、免费档上限 1 小时）；④ 要联网 + 云账号，测试要求 mock-only，真实路径不拿真 Key 跑不通。显式 `--sandbox e2b` 继续直接报错，不静默降级。前置条件（以后要接时缺一不可）：引入 `@e2b/sdk` 并锁定版本、定 `E2B_API_KEY` 落点、定生命周期形态（每次新建 vs 长驻复用，含超时/续期/退出清理）、用真 Key 在有网环境跑通端到端。

## 未发布（0.5.1：补齐 0.5.0 的已知缺口 + OpenMausBot 循环守卫与幂等重试）

- 版本升到 0.5.1（五处一致：`src/config.ts` 的 `VERSION`、根 package.json、desktop/package.json、desktop/src-tauri/tauri.conf.json、desktop/src-tauri/Cargo.toml 与 Cargo.lock 里的 `nyra-desktop` 条目；`src/sandbox.ts` 的 e2b 报错文案与测试断言同步 0.5.1；安装文档与 GUIDE 里当前版本期望输出同步 0.5.1，历史叙述保留 0.5.0 不动）。
- 网关沙箱接线（0.5.0 已知缺口）：网关 `send()` 与定时任务建 Agent 时按 CLI 同一套来源解析沙箱（`config.sandbox/sandbox_mode/sandbox_allow_net` + `NYRA_SANDBOX*` 环境变量，不另发明配置键）并透传给 `ToolContext`，`shell` 执行经 `toolShell` 原有解析生效：auto 回落工具级（每会话首次 shell 提示一次）、显式 bwrap 缺失 fail-closed（会话进 error 状态，模型一次都不跑）、默认断网、danger-full-access 与 bwrap 互斥；钩子仍在宿主机跑。`src/gateway.ts` 新增 `sandboxSettings()`（fail-closed 校验）。文档 `docs/sandbox.md` 补网关接线一段。已知缺口：群聊机器人路径（`src/groups.ts` 的 `defaultBotRunner` 建 Agent 时没传 sandbox）未接；MCP 工具调用不走 shell，同样不在沙箱内。测试：`tests/node/test-gateway-sandbox.test.ts` 5 项（PATH 受控假 bwrap shim，不依赖本机真有 bwrap）。
- SessionStart/SessionEnd 钩子接会话生命周期（0.5.0 已知缺口）：CLI REPL 建会话后、首个提示前触发一次 SessionStart，SessionEnd 由 `try/finally` 保证（/exit、EOF、循环内异常），Ctrl+C 尽力触发一次（3 秒宽限后退出 130，连按两次直接退出）；网关新建会话或首次 send 隐式建会话时触发一次 SessionStart（fire-and-forget，不阻塞 HTTP 响应），关停时为每个已开始的会话触发一次 SessionEnd（`stop()` 里 await，有超时封顶）。约定不变：超时走 `hooks.timeout_ms`（默认 10 秒）、fail-open、退出码 2 只通知不拦截、无钩子零 spawn。文档 `docs/hooks.md` 更新事件表与触发点。已知缺口：网关没有逐会话关闭接口，SessionEnd 只能在网关关停时触发；一次性 CLI 任务（`nyra "任务"`）不触发会话钩子，只有 REPL 会话才触发。测试：`tests/node/test-session-hooks.test.ts` 8 项（含子进程 REPL 真测，管道喂 `/exit` + ollama provider，无需真实凭证）。
- 附带修掉超时钩子的旧泄漏：超时钩子的孤儿孙子进程（如钩子里的 `sleep 30`）攥着管道写端，导致 `close` 事件不到、主进程事件循环排不空，REPL `/exit` 后要等 30 秒才退得出；这是 SessionEnd-on-exit 暴露出来的，`src/hooks.ts` 超时兜底改为杀钩子 1 秒后销毁其 stdin/stdout/stderr 管道，修后超时测试 4.1 秒跑完，`test-hooks.test.ts` 15 项仍全过。
- compactSessionFile 压缩后重读（0.5.0 已知缺口）：与 REPL 侧行为一致，压缩成功后自动重读记忆与规则并追加 `[压缩后重读：记忆与规则]` 备注，失败回退时不追加（由 `compactMessages` 本身保证）。`src/compact.ts` 新增 `buildSessionReReadNote()`（与 `Agent.postCompactReReadNote` 同源：记忆取 `loadMemorySummary(40)`、规则取 `loadAgentsMd` 末尾段落，读失败返回 null），`compactSessionFile` 增加可选第 6 参数 `opts { workdir, memoryPath, reRead }`，默认自动计算，`reRead` 显式传入（含 `null`）时优先于自动计算；`nyra --compact` 走 `Agent.compact()`，本来就已带重读，无需改动。文档 `docs/context.md` 补一段。测试：`tests/node/test-compact-reread.test.ts` 5 项。
- 技能列表顺序统一（0.5.0 已知缺口）：规范顺序定为加载顺序（未按技能名排序——字母序会打乱项目层覆盖全局层的优先级表达）。`src/skills.ts` 新增唯一来源 `canonicalSkillDirs(workdir, home, pluginDirs)`（项目 `skills` → 项目 `.nyra/skills` → 全局 `skills` → 插件 `skills`，同目录按文件名排序）与 `canonicalSkillOrder()`（同名去重、先出现者胜），`skillIndex()` 内部也走规范顺序；`agent.ts` 默认 `skillsDirs`、`cli.ts` 的 `--list-skills`、`gateway.ts` 的 `info()` 状态 `skills` 三处全部改用它。附带修掉一个真分歧：CLI/网关此前缺 `<workdir>/.nyra/skills` 一层，且网关用 `process.cwd()` 而不用自身的 `workdir`，现一并统一（网关 `workdir` 默认即 `process.cwd()`，行为不变）。文档 `docs/skills.md` 更新。测试：`tests/node/test-skill-order.test.ts` 3 项。
- 循环守卫（OpenMausBot B 项，学 `chat-repeat-guard.ts` + `tool-failure.ts`，按思路用 TypeScript 重写，未抄代码）：新增 `src/repeatGuard.ts`（只依赖 `node:crypto`），key = 工具名 + key 排序后 JSON 参数，结果 SHA-256 摘要（先截断 4000 字符），截图类工具与 base64 图片结果不计入；逐调用计数，不要求连续，交替出现也算。阈值默认开启：同一失败调用 3 次后拒绝执行并给模型写纸条“换输入、换方法、或说出卡点”；同一成功调用返回同一答案 3 次后提醒、10 次后直接停掉本轮。接入 `src/agent.ts` 的工具调用循环（调用前问拒否、调用后记录、轮末停轮）；停轮与 `max_turns` 耗尽时返回诚实失败文案（列出失败/被拒的调用名）。测试：`tests/node/test-repeat-guard.test.ts`。
- 幂等重试（OpenMausBot C 项，学 `retry.ts`，按思路用 TypeScript 重写，未抄代码）：`FallbackProvider` 同一 provider 先重试（至多 2 次、退避 1s/3s + ±25% 抖动、可中断，受整条链 2× 单次超时总预算约束，剩余时间不够“一次退避 + 一次重试（重试超时按剩余预算封顶，低于 0.2 秒不重试）”时直接改走切换），只有瞬时错误可重试（`rate_limit` / `server` / `timeout` / `network`）；用量上限类错误即使措辞像 rate limit 也判终结、不重试（消息文本模式优先于 429 匹配：`weekly/monthly/usage limit`、`out of credits`、`quota exceeded`、用量上限、余额不足等）；认证、未知模型、无效请求、404、用户中断、安全拦截绝不重试。工具侧新增 `executeToolIdempotent()`（`src/tools.ts`）：只读工具直接重试至多 2 次（退避 200ms/500ms）；可核查写操作为 `write_file`（读回比对全文）、`edit_file`（读回含 `new_text`）、`plan`（读回比对整份内容）、`memory_append`、`save_skill`；`apply_patch` / `shell` / `http_post` / 浏览器与电脑操作 / `delegate` / MCP 无法通用核查，不重试；截图类工具因每次执行多存一个本地文件，不自动重试。文档 `docs/idempotent-retry.md`（守卫阈值、可重试只读表、写操作核查表、provider 分类表与退避参数）。测试：`tests/node/test-idempotent-retry.test.ts`（含本地 HTTP 服务先 500 后 200 的真实重试）。
- 决定：用量上限切换语义保持不变——`quota` 仍在 `RECOVERABLE_KINDS` 内，用量上限文本错误不重试同一 provider，但仍会切换到下一个 provider。理由：兜底默认就是关闭的，用户显式配了多 Key 兜底链才可能切换；改成终结会悄悄改变已有行为，且现有测试 `test_fallback_switches_only_on_recoverable` 锁定了该语义。
- 测试适配（与 0.5.1 改动有关）：`FallbackProvider` 加了同一 provider 重试后，两处既有测试会撞上 Bun 单测 5 秒超时，注 0 退避以只验切换语义（`test_fallback_all_fail_reports_all`、`test_fast_failures_still_try_every_provider`，构造器传 `retryDelaysMs: [0, 0]`；产品代码未动）。
- 修掉幂等重试与总预算的冲突（0.5.1 集成验收抓到的真 bug）：同一 provider 重试前只看“剩余预算够不够一次退避”，没算再试一次本身也要等一份超时——挂起的 provider 一重试就把整条链 2× 超时的预算吃光，后面的 provider 一次都试不到，`test_fallback_chain_total_budget_caps_slow_providers` 因此失败。改为重试超时按剩余预算封顶（低于 0.2 秒不重试），不够就直接切换；`src/providers.ts` 另把 `attemptTimeout` 改为每轮可变的 `let`。文档 `docs/idempotent-retry.md` 与本条目同步。
- 代码签名接线（第 7 项附加工作，用户 2026-11-19 18:41 定，不等证书、0.5.1 仍按未签名发）：`desktop.yml` 的 Windows 与 macOS 两个 job 各加条件签名步骤（Windows：秘密存在时把 `.pfx` 导入证书库，thumbprint 经 `npx tauri build --config signing-config.json` 合并进配置——已用 Tauri CLI v2 实测 `--config` 接受 JSON 文件路径并合并；macOS：秘密存在时把 `.p12` 导入临时钥匙串，签名身份经 `--config` 覆盖，`APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID` 到位时构建自动公证）；`node-binaries.yml` 的构建 job 在秘密存在时用 osslsigncode 给 `nyra-windows-x64.exe` 做构建后签名（RFC 3161 时间戳）。秘密一个都没有时构建与以前完全一致（未签名）；只配一半时直接报错，绝不悄悄出未签名包。秘密名：Windows `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD`；macOS `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `KEYCHAIN_PASSWORD` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`。文档 `docs/SIGNING.md`（买哪家证书、怎么导出 .pfx/.p12、秘密怎么加、验证命令、SmartScreen 实话、2023 年硬件密钥的提醒）。诚实边界：没有真实证书，无法跑出已签名产物验证，只验证了 YAML 语法、bash 语法与“无秘密走旧分支、有秘密走签名分支”的条件逻辑；macOS 的 Node 命令行版暂不签名（裸 Mach-O 文件，公证票据钉不上去，见文档）。
- 受保护写入路径守卫（PR #31）：`workspaceWritePath` 拒写顶层受保护路径（目录 `.git` / `.nyra` / `commands` / `skills`，文件 `AGENTS.md` / `CLAUDE.md` / `nyra.json` / `.nyra.json`），任何 sandbox 模式下都拒写（含 workspace-write 与 danger-full-access），逃逸口 `NYRA_ALLOW_PROTECTED_WRITES=1`（显式，不静默放行）；拒绝信息说明原因与放开方式。另附 `docs/COMPETITIVE-RESEARCH.md`：30 家 harness 调研与 Nyra 差距矩阵。测试：`tests/node/test-protected-writes.test.ts` 8 项。
- 技能 allowed-tools / model + `!cmd` 动态上下文注入（PR #32）：技能 frontmatter 新增声明式字段 `allowed-tools`（逗号分隔，也接受 `allowed_tools`）与 `model`（建议模型），只渲染进提示词、无强制执行；正文 `!cmd` 在渲染时执行并把输出注入（4000 字符截断并注明原长度）。信任模型（审阅后收紧）：只有 `<home>/skills` 下的技能才自动执行，项目/插件技能默认不执行（`isTrustedSkillPath` + `skillRenderOptionsFor` 纯函数，放开走 `NYRA_ALLOW_UNTRUSTED_SKILL_COMMANDS=1`）；危险命令黑名单补齐 Windows 项（del/rd/format/diskpart/Remove-Item -Recurse 等），注释写明黑名单挡不住 `curl | sh`、真正的边界是信任模型；计划模式不执行；`docs/skills.md` 写明声明式字段无强制。测试：`tests/node/test-skills-inline.test.ts` 12 项。
- 权限规则语言 `Tool(specifier)`（PR #34，学 Claude Code）：`src/permissionRules.ts`，纯函数（不读文件、不 spawn、不抛异常，解析失败按无效规则丢弃并计入 warnings）；语法 `Bash` / `Bash(npm run build)` / `Bash(git *)` / `Edit(src/**)` / `Read(./.env)` / `WebFetch(domain:example.com)` / `mcp__<server>__<tool>` / 裸工具名；求值顺序 **deny > ask > allow**，都不命中返回 null（走默认审批）；不改变 readonly 模式的硬约束；规则集为空时行为与之前完全一致。`src/tools.ts` 与 `src/config.ts` 接线；`docs/VISION-NEXT.md` 路线图。测试：`tests/node/test-permission-rules.test.ts` 11 项。
- 子 Agent 的 worktree 隔离 + 工具白名单 + 独立模型（PR #35）：`delegate(task, maxTurns, { isolation, tools, model })`——`isolation: "worktree"` 时子 Agent 在 `git worktree add --detach` 的临时工作树里干活，主工作区一个字节都不动，结束后 `git status --porcelain` + `git diff --stat HEAD` 给出 diff 摘要，无改动自动清理、有改动保留并打印审查/合并命令，非 git 目录明确报错不静默降级；`tools` 白名单只保留名单内工具（未知工具名明确提示忽略）；`model` 经 `multiModelFactory` 造 provider，造不出来沿用父级模型并把原因写进结果，不假装切换成功。测试：`tests/node/test-delegate-isolation.test.ts` 4 项。
- PreToolUse 结构化决策与 updatedInput（PR #36，学 Claude Code）：退出码只能表达“拦 / 不拦”，现在钩子可以在 stdout 返回结构化 JSON `{"permissionDecision":"allow|deny|ask","permissionDecisionReason":"...","updatedInput":{...}}`（也接受平铺的 `decision` / `reason` / `updated_input`）；deny 等价于退出码 2，updatedInput 会真的合并进工具入参再执行并打审计日志；多个钩子给不同决策时按 **deny > ask > allow** 取最严，平级保留先到者；格式写错（非 JSON / 数组 / 未知决策值 / updatedInput 非对象）一律忽略——钩子写错格式绝不能把危险操作放过去；只有 PreToolUse 支持决策，其余三个事件忽略 stdout JSON。`parseHookStdout()` / `pickStricter()` 为纯函数；`docs/hooks.md` 新增契约说明与“把 rm -rf 改写成 ls”的可运行示例。测试：`tests/node/test-hook-decisions.test.ts` 7 项。
- 未验证通过的运行不得宣称“已完成”（PR #37）：新增 `downgradeCompletionClaim(text, status, verifyNote)`（`src/runs.ts`）：`verified` 原样返回；其他状态且回复里出现完成断言（已完成 / 搞定了 / 全部通过 / 已修复 / done / completed / all tests passed 等）时在最前面插入未验证横幅、保留原文，没有完成断言不打扰。两条输出路径都过这道门：普通输出打印前降级；`--json` 的 `final` 事件放降级后的内容，并额外发 `completion_downgraded` 事件（status + 触发的断言片段），方便 CI 判定。测试：`tests/node/test-completion-gate.test.ts` 9 项。
- CI 修复（发版前修掉的三类问题，根因均已实证）：① 工作流文件无效——`desktop.yml` 与 `node-binaries.yml` 在 `if:` 里直接引用 `secrets`，GitHub 不认（应先映射到 job 级 env 再用 `env.X` 判断），已改 job 级 env 映射；`desktop.yml` 的无效文件还会导致每次推送都记一条失败运行（零任务），与 `on:` 配置无关，修好即止。② Node CI 三个失败——`test-idempotent-retry.test.ts` 设了 `NYRA_ALLOW_PRIVATE_URLS=1` 从不恢复，Bun 同进程并发跑测试文件、env 跨文件共享，SSRF 拦截被旁路（Windows 运行器真的连到 169.254.169.254 拿到 HTTP 404），已改为 save/restore；`canonicalSkillDirs` 用 `join()` 在 Windows 产出反斜杠、下游按 `/` 比较，已在 `src/skills.ts` 归一化为 POSIX 形式，测试期望同步归一化；rewind 超时用例内部等待上限 10 秒 > Bun 默认 5 秒超时，已给该用例单独 15000ms。③ 桌面 macOS 构建失败——CI 修复新加的 job 级 env 把 `APPLE_CERTIFICATE` 等秘密以空字符串传进任务，Tauri 打包器只要检测到该变量存在（即使是空值）就尝试把它当 `.p12` 导入，空值解码失败；0.5.0 没映射这些变量所以是绿的。已在未签名分支构建前 `unset` 掉 8 个签名变量，手动触发桌面构建验证两平台都过。
- 验证（集成树内实测，2026-11-19，含合并的 PR #31/#32/#34/#35/#36/#37）：`tsc --noEmit` 0 错误；Node 全量 **910 项 0 失败**（3487 个 expect，70 个文件，约 60 秒；0.5.0 基线 814 项，新增 96 项：7 项开发 45 + 受保护写入 8 + 技能内联 12 + 权限规则 11 + 委派隔离 4 + 钩子决策 7 + 完成断言降级 9）；探针 6/6；预算检查全部通过（二进制 110,127,280 字节 ≤136,314,880、`--help` 116ms ≤2000ms、首字节 51ms ≤1000ms、gateway 空闲 RSS 37,156KB ≤61,440KB）；Linux x64 二进制重编后 `--version` 输出 `nyra 0.5.1 (node runtime)`；桌面版四处版本检查脚本本地通过（package.json / tauri.conf.json / Cargo.toml / desktop/package.json 均为 0.5.1，另手工核对 Cargo.lock 的 nyra-desktop 条目为 0.5.1）。CI 在最终 head 上三线全绿：Node CI、Node binaries、桌面构建（macOS + Windows 均成功，见桌面 #27 手动触发验证与 tag 触发运行）。诚实边界：Windows/macOS 真机未验证；群聊机器人路径未接沙箱；网关 SessionEnd 只在关停时触发；一次性 CLI 任务不触发会话钩子；`KeyRotatingProvider` 未加同 key 重试；`executeToolIdempotent` 每次重试会重新走审批与 PreToolUse 钩子。PR #34/#35 由 DeepSeek 直接合入 main，未经本轮独立审阅（CI 三平台全绿、本地全量已覆盖其新增测试）；PR #36/#37 经本轮审阅与本地合树验证（tsc 0、全量 910/0）后合入。

## 未发布（0.5.0：竞品调研前 3 项 + 隔离执行全部落地）

- 版本升到 0.5.0（五处一致：`src/config.ts` 的 `VERSION`、根 package.json、desktop/package.json、desktop/src-tauri/tauri.conf.json、desktop/src-tauri/Cargo.toml 与 Cargo.lock 里的 `nyra-desktop` 条目——0.4.0 升版时漏掉的 Cargo 两处已在 0.4.1 补升时一并对齐；desktop.yml 的版本检查以根 package.json 为准，本地已用其检查脚本自验通过）。
- Hooks 确定性钩子层（调研报告第 1 项，学 Claude Code）：新建 `src/hooks.ts`（`HookEvent`：PreToolUse / PostToolUse / SessionStart / SessionEnd；`runHooks` / `listHooks`）；钩子放 `<home>/hooks/<Event>.d/` 或 config.json 的 `hooks` 列表；退出码 2 = 拦截（PreToolUse），其他非零与超时 = fail-open 警告继续；单个脚本默认 10 秒超时（`hooks.timeout_ms`，夹取 1000–120000）；stdin 传 JSON（event/tool/args/workdir），环境只给 `PATH` + `NYRA_HOOK_EVENT` / `NYRA_HOOK_TOOL`，不透传密钥；无钩子时零 spawn、零打扰。`src/tools.ts` 在 checkApproval 之前对 write_file / edit_file / apply_patch / shell 跑 PreToolUse（拦截抛 ToolError，转成工具结果返回模型），成功后跑 PostToolUse（只通知）；`hooks.enabled` / `NYRA_HOOKS=0` 可关；`nyra hooks list` + `--help` 说明；文档 `docs/hooks.md`（含 TODO 门禁与 shell 关键词拦截两例）。测试：`tests/node/test-hooks.test.ts` 14 项。
- 技能渐进披露 + 分层 / 路径触发加载（调研报告第 2 项，学 Claude Code + OpenHands）：`src/skills.ts` 的 Skill 加可选 `paths?: string[]`（frontmatter `paths:`，逗号分隔，支持 `[a, b]` 写法）；30 行内无依赖 glob 匹配器 `matchGlob`（`**` / `*` / `?`，`\` 转 `/`）；新增 `skillIndex()`（每行 `name — description`，描述截断约 100 字）、`matchSkillsByPaths()`（命中去重、按名排序）、`readSkillBody()`；`matchSkills` 关键词评分行为不变。`src/agent.ts` 提示词改两段式（常驻技能索引 + 仅命中技能全文），`skillIndexText()` 缓存，runLoop 工具结果后按触碰路径确定性追加命中技能全文（每技能每轮一次，shell 除外，不碰 system prompt 缓存）；默认 skillsDirs 改为项目（`<workdir>/skills`、`<workdir>/.nyra/skills`）→ 全局（`~/.nyra/skills`）→ 插件分层（先加载的赢，同名项目层覆盖全局层）。`src/tools.ts` 新增只读工具 `read_skill`（不审批，工具总数 24→25）。文档 `docs/skills.md`。已知缺口：`nyra --list-skills` 与网关技能列表仍用旧顺序（见 docs/skills.md）；`save_skill` 同名覆盖带 paths 的技能会丢原 paths（改手动编辑）。测试：`tests/node/test-skills.test.ts` 新增 12 项（单文件 21 项）。
- 上下文补齐（调研报告第 3 项，学 Claude Code）：`src/agent.ts` 新增 `contextUsage()`（system / skills / history / toolResults 四类字符数 + 总量；token 只用模型实报快照，未报告时按 4 字符 ≈ 1 token 估算并标 `estimated: true`）；REPL 新增 `/context`（四类占比 + 总量 + 模型窗口 + 优化建议，最高占比类别 >50% 时给针对性建议）与 `/compact focus <关键词>`；`compact(keepLast, focus?)`：focus 摘要指令追加重点保留、额外保留含 focus 关键词的历史消息（原顺序前 10 条、去重）；压缩成功后自动重读记忆与规则（`loadMemorySummary(40)` + `loadAgentsMd` 末尾 2 段，以 `[压缩后重读：记忆与规则]` 备注追加，重读内容计入 system 部分；fallback 不重读；自动压缩走同一条路）。网关 `sessionView` 加 `context` 字段（无 live agent 时为 `null`，不编造）；网页端会话页状态行下加 `#context` 一行（桌面+手机共用，随轮询刷新）。文档 `docs/context.md`。已知缺口：`compactSessionFile`（文件级压缩）不知道 workdir，未接重读。测试：test-compact / test-agent / test-cli 共新增 19 项。
- 隔离执行（调研报告第 9 项，学 Codex CLI + Gemini CLI + OpenClaw，用户 2026-11-19 16:19 新加）：审批与沙箱拆成两轴——审批定“能不能做”，沙箱定“在哪里做”。新建 `src/sandbox.ts`（`SandboxMode`：read-only / workspace-write / danger-full-access；`SandboxBackend`：auto / local / bwrap / e2b；`detectBwrap`：Linux + 遍历 PATH 查可执行位；`resolveSandboxBackend`；`buildBwrapArgs`：`--bind` 工作目录可写、`--ro-bind /usr /lib /lib64 /bin /etc`（只挂存在的目录）、`--proc` / `--dev` / `--tmpfs /tmp`、默认 `--unshare-net`、 `--die-with-parent`、`--chdir`；read-only 时工作目录也只读；danger 拒绝进 bwrap；`runSandboxed`；`getSandboxStatus`）。`src/config.ts`：`DEFAULT_CONFIG.sandbox` 由 `"local"` 改 `"auto"`，新增 `sandbox_mode: "workspace-write"`、`sandbox_allow_net: false`，`VALID_SANDBOXES` 扩为 `["auto","local","bwrap","e2b"]`，`NYRA_SANDBOX_MODE` / `NYRA_SANDBOX_ALLOW_NET=1` 生效。解析规则：auto = Linux 有 bwrap 则进沙箱、否则工具级回落并提示一次；local = 显式只要工具级；bwrap = 强制要求，缺失或启动失败直接报错退出（fail-closed，绝不静默裸奔）；e2b 仍不支持（文案已同步 0.5.0）。`src/tools.ts` 的 shell 两处执行点统一走沙箱分支（审批之后、执行之前；未配 sandbox 的旧调用保持原行为）；`src/agent.ts` 透传 sandbox 配置，delegate 的子 agent 继承父级；`src/cli.ts` 的 main 入口统一 fail-closed 校验（bwrap 缺失 / e2b / danger+bwrap 直接 exit 2）。Hooks 在沙箱外（宿主机）跑检查、沙箱内只跑命令（`docs/sandbox.md` 写明分工）。`src/doctor.ts` 新增“隔离级别”检查（恒为通过，用 level + detail 说明，不因 bwrap 缺失拉低 allOk——fail-closed 由 shell/CLI 入口承担）。文档 `docs/sandbox.md`（两轴模型、三档模式、auto/local/bwrap/e2b 选法、默认断网与放开方法、Windows/macOS 隔离级别如实说明、bwrap 安装指引）。已知缺口：网关未接线（直接构造 Agent 不传 sandbox，网关会话仍走工具级）；doctor 对显式 bwrap 缺失也报通过（见决定）。测试：`tests/node/test-sandbox.test.ts` 20 项（含 PATH 假 bwrap shim 端到端）。
- 测试修复（与 0.5.0 改动无关，上游行为变化）：`tests/node/cli.test.ts` 的假 Key 真网测试原先期望 DashScope 120 秒超时，现上游对假 Key 直接回 HTTP 401（约 1.5 秒）；期望改为超时或 401 任一通过（本意是“假 Key 被上游拒绝、退出码 1”），产品代码未动。另补：沙箱测试里 5 项依赖假 bwrap shim（`#!/bin/sh` 脚本）的用例加 Linux-only 跳过——`detectBwrap` 在非 Linux 直接返回 false，macOS/Windows CI 上否则必挂；其余沙箱测试全平台可跑。
- 版本文案与文档同步：README 新增“0.5.0 更新了什么”一节（在 0.4.1 一节之后，4 项每项一句话）；安装文档与 GUIDE 里的当前版本期望输出由 0.4.1 改 0.5.0（历史叙述保留 0.4.1/0.4.0 不动）；测试里的版本断言同步 0.5.0。
- 验证（集成树内实测，2026-11-19）：`tsc --noEmit` 0 错误；Node 全量 **813 项 0 失败**（3078 个 expect，58 个文件，约 54 秒；0.4.1 基线 748 项，新增 65 项：Hooks 14 + 技能 12 + 上下文 19 + 沙箱 20）；探针 6/6；预算检查全部通过（二进制 110,090,416 字节 ≤136,314,880、`--help` 93ms ≤2000ms、首字节 58ms ≤1000ms、gateway 空闲 RSS 36,708KB ≤61,440KB）；Linux x64 二进制重编后 `--version` 输出 `nyra 0.5.0 (node runtime)`；桌面版四处版本检查脚本本地通过（package.json / tauri.conf.json / Cargo.toml / desktop/package.json 均为 0.5.0，另手工核对 Cargo.lock 的 nyra-desktop 条目为 0.5.0）。诚实边界：bwrap 只在 Linux 有，Windows/macOS 无 OS 级沙箱（见 docs/sandbox.md）；Rust 改动本机无 cargo，未编译验证，靠 CI 的 desktop 工作流；Windows/macOS 真机未验证。

## 未发布（0.4.1：审查留下的 12 项待拍板事项全部落地）

- 版本升到 0.4.1（`src/config.ts`、package.json、桌面端两处；`src/cli.ts` 的 e2b 报错文案同步）；`node-binaries.yml` 的 Release 不再标 `prerelease`（0.4.1 起是正式版）。
- 密码箱 PBKDF2 由 200k 次提到 600k 次（OWASP 对 SHA-256 的建议值）：新建密码箱直接 600k；旧密码箱（文件里无 `iterations` 字段即按 200k 读）在下次成功解锁时后台自动重算升级并保存，用户无感，升级失败不影响本次解锁（`src/vault.ts`，`VaultDoc.iterations`，`deriveKeys(password, salt, iterations)`）。
- 主密码最小长度 8 位（新建与改密码时 enforcing，已有弱口令密码箱照常用）；解锁输错限流：5 次后递进锁死（60 秒起、翻倍、上限 15 分钟），锁死状态记密码箱旁的 `vault.attempts.json`（0600）跨进程生效，锁死期间直接拒绝不烧 PBKDF2；CLI 解锁失败时区分提示“尝试次数过多，请 N 秒后再试”（`src/vault.ts`、`src/cli.ts`）。
- 配对 token 加 180 天未使用过期：每次认证成功刷新 `last_seen`，常用设备永不过期；超期自动从列表剪掉（`src/pairing.ts`，`TOKEN_INACTIVITY_TTL_SECONDS`）。配对码保留 6 位（好记；错 5 次作废 + 300 秒 TTL + 一次性已堵住暴力破解）；UDP 发现应答只回名字和 HTTP 端口，不带码也不带 token（无配对码预言机，`buildDiscoveryReply` 回归测试锁定）。
- SSRF 只拦内网/保留地址段，公网 URL 正常放行：`src/net.ts` 新增 `isPrivateOrReservedHost`/`isPrivateOrReservedIp`（回环、RFC1918、100.64/10、169.254/16、组播、保留段、`.localhost`、`.local`、`metadata.google.internal`、IPv6 回环/链路本地/唯一本地/组播、`::ffff:a.b.c.d` 映射解包）与 `assertPublicUrl`（主机名检查 + `dns.lookup` 解析后逐个验 IP；解析失败放行、让 fetch 自己报错；`NYRA_ALLOW_PRIVATE_URLS=1` 可放行本地开发）；`web_fetch`/`http_post`（含重定向每一跳）入口调用。诚实边界：拦的是地址本身在内网段，拦不住内网服务自己暴露到公网、也拦不住解析后地址被换掉。
- 只读工具默认限制在工作目录内：`src/tools.ts` 新增 `workspaceReadPath`（与 `workspaceWritePath` 同款；后端分支不动），用于 `read_file`/`list_dir`/`grep_search`/`git_status` 的本地分支；越界给清楚提示并允许 `NYRA_ALLOW_READ_OUTSIDE_WORKDIR=1` 显式放开。
- 群 Key 不再明文存 `room.json`：改存 `api_keys_enc`（`v1:vault:<密码箱条目名>` 或 `v1:local:<nonce>:<data>:<mac>`），优先密码箱（存在 + `NYRA_VAULT_PASSWORD` 能解锁时），否则本机密钥 `<home>/groups.key`（首次自动生成 32 随机字节、0600）；读到旧明文 `api_keys` 自动迁移并写回；公开返回同时剥掉 `api_keys` 与 `api_keys_enc`；密码箱实例在 `GroupStore` 内缓存（免得每次解密都重算 600k 次 PBKDF2）；解不出的 Key 不进轮换，`providerForBot` 报清楚原因（`src/groups.ts`）。
- 聊天 zip 存档走与记忆导出同一套脱敏：`importChatZip` 落盘前按 JSON 结构逐值脱敏并返回删掉的行数；`scrubSecrets` 改成 PEM 块感知（`BEGIN PRIVATE KEY` 起整块删到 `END` 行，补齐 Python S-H3 的 Node 缺口）（`src/memoryExchange.ts`、`src/cli.ts`）。
- shell 黑名单加固（Python S-H2 移植到 Node）：`rm` 组合短标志逐位解析（`rm -r -f /`、`rm --recursive --force /`、`rm -rfv /` 都拦）+ `--` 终止符 + 危险目标归一化（`~/`、`$HOME/`、`${HOME}/`、`/*`、`.`、`..`），仅递归+强制同时满足且目标危险时拦；`dd … of=/dev/…` 与 `chmod 777 -R /` 两种参数顺序都拦；顶部加诚实边界注释（`find … -delete`、`curl | sh` 等仍未拦，黑名单是绊线不是沙箱）（`src/tools.ts`）。
- 向导 Key 掩码与 rc 明文：新增 `readSecret`（终端上 raw-mode 逐字回显 `*`，退格与 Ctrl-C 处理；管道输入回退到普通提问）；Key 确认行只显示后 4 位；rc 里已有 Key 时只显示后 4 位，密码箱可用时问是否迁入密码箱（迁完删 rc 里那行）；新 Key 密码箱可用时默认问“存密码箱还是追加进 rc”（默认密码箱），否则走 rc 流程 + 追加后 `chmod 600`（POSIX）（`src/wizard.ts`）。
- 桌面端单实例：`tauri-plugin-single-instance = "2"`，第二次启动取 `main` 窗口 `unminimize()` + `set_focus()` + `show()`（`desktop/src-tauri/Cargo.toml`、`desktop/src-tauri/src/lib.rs`、`docs/desktop.md`）。本机无 cargo，Rust 改动未编译验证，靠 CI 的 desktop 工作流验证。
- Windows 安装脚本：`nyra ui --open` 在 0.4.0 起是真实命令，快捷方式保留；补 `--uninstall` 开关（删安装目录、删两个桌面快捷方式、从用户级 PATH 摘掉安装目录，保留 `~/.nyra` 数据）（`scripts/install-node.ps1`）。
- 验证（集成树内实测，2026-11-19）：`tsc --noEmit` 0 错误；Node 全量 **748 项 0 失败**（2819 个 expect，56 个文件，约 112 秒；基线 723 项，新增 25 项）；探针 6/6；预算检查全部通过（二进制 110,049,456 字节 ≤130MB、`--help` 100ms ≤2000ms、首字节 117ms ≤1000ms、gateway 空闲 RSS 36,912KB ≤60MB）；600k 次 PBKDF2 解锁实测约 0.4–0.5 秒（本机），只在解锁时算一次，常用路径不受影响；Linux x64 二进制重编后 `--version` 输出 `nyra 0.4.1 (node runtime)`。Rust 改动未编译验证（本机无 cargo）；Windows 安装脚本的 `--uninstall` 未在真机验证。

## 未发布（集成：审查 75 项 + Node 第 2 阶段移植 + 第 3 阶段 + 第 4 阶段）

- 0.4.0（第 4 阶段）：**Python 全部移除**——仓库里不再有任何 `.py` 文件（`nyra/` 58 个、`tests/*.py` 78 个、`scripts/remote_run.py`、`scripts/upload_nyra.py`、`desktop/scripts/make_icons.py`，共 139 个），另删 4 个 Python 时代安装/打包脚本与 2 个已嵌进二进制的群聊页原文件；工作流 `python-ci.yml` 与 `build-windows.yml` 已删，新增 `node-ci.yml`（push main + PR 时跑 `tsc` + 三平台 `bun test tests/node` + 探针，另有 budgets job）；`--sandbox e2b` 在 0.4.0 暂不支持（Python 已移除，Node 版 E2B 后端尚未移植），当前只支持 `--sandbox local`；版本升到 0.4.0（`src/config.ts`、package.json、桌面端两处）；桌面端 `lib.rs` 改指 Node 二进制（本机无 cargo，未编译验证，靠 CI 的 desktop 工作流验证）；网关 `urlJson()` 的 `nyra` 字段由 `"nyra"` 改回 `"ui"`（桌面外壳契约，Python 版一直是 `"ui"`）；群聊页随二进制打包（`src/assets/`）；`systemd` 与 `launchd` 服务文件改调 `nyra` 二进制；README/GUIDE/DESIGN/安装文档里的 Python 引用已全部改写为 Node 口径。

- 创造模式（Creator Mode，第 4 阶段新增）：新模式 `creator` 与 readonly/auto/full 并列，入口 `nyra --mode creator`、REPL `/creator`、网页端设置页模式选择器；流程一句话需求 → 对齐 spec 存档（`.nyra/creator/<名>/spec.md`）→ 生成插件（`plugin.json` + `skills/*.md` + 可选 `panel/*.html`）→ `nyra creator verify` 验证 → 展示变更与权限、用户确认后安装；内置两个一句话示例端到端跑通（番茄钟面板、TODO 扫描工具），面板为自包含静态页面、计时逻辑有假时钟回归测试；安全比 Harness 强：插件是 skill + manifest（不直接执行模型生成的代码），安装前必验证、必经用户确认，默认最小权限，声明的工具必须是已知 Nyra 工具，高权限工具（shell、电脑/浏览器操作）单独标出；无模板且无模型时报可读错误、什么都不装；创造技能随二进制内嵌（与 `skills/creator-mode.md` 同文，测试锁定），切换出创造模式时撤下；审批行为与 `auto` 同级（`checkApproval` + 改动预览）。测试：`tests/node/test-creator.test.ts` 14 项、`test-cli.test.ts` 创造模式 3 项、网关与 agent 各 1 项，全量 Node 719 项 0 失败。
- 最小插件市场（第 4 阶段）：插件 = 技能包（`plugin.json` 清单 + `skills/*.md` + 可选 `panel/*.html`）；只装用户显式指定的来源（本地目录或 git URL，拒明文 http）；装前验清单与内置技能硬保护；每个文件记 sha256 进锁定文件；升级只覆盖哈希一致的文件（用户改过的保留并报告）；卸载只删哈希一致的文件；生命周期 active→stale→archived（90 天未用降级）；遥测写旁挂 `plugins/telemetry.jsonl`；`nyra plugin <list|search|install|uninstall|enable|disable|verify|audit|pin|unpin>`；清单新增可选 `tools`/`permissions` 声明（创造模式的插件必须声明）。

- 合并 Node 第 3 阶段（单 gateway、`ui` / `gw`、`--print-url-json` 桌面外壳契约、/rewind 三端一致、smart approvals 三档、MCP 原生客户端与成本上限、配对/记忆/产物；桥覆盖 12 区→7 区；新增 `docs/node-migration-phase3.md`）；第 3 阶段自己的验证记录（Node 508 项）见该文档。诚实边界：gateway 空闲 RSS 回归 +11.1MB（Node 编译后 37.1MB vs Python 26.0MB），第 4 阶段处理，本轮不掩盖、不修；编译产物仍约 109MB；provider 默认 120s 超时是第 2 阶段设计，本轮不改。

- 合并 2026-11-19 源码全面审查的 75 项修复（安全 9、核心 25、功能 14、Node+文档+CI 14、桌面端 10、汇总 3）与 Node 第 2 阶段完整移植（29 个新 `src/*.ts`、6 个 `index.ts` 重导出、32 个新 `tests/node/test-*.test.ts`、`skills/debugging.md`、`docs/node-migration-phase2.md`、`package.json` / `bun.lock` / `tsconfig.json`）；12 项需用户决定的事未动（Vault PBKDF2 仍 200k 次、配对 token 无 TTL、群 Key 仍明文存 `room.json` 等）。
- 审查的 5 个 Node 文件以第 2 阶段版本为底移植：未知 provider 时 `nyra setup` / `nyra --example` 只报一行中文错误、退出码 1；第 3 阶段集成时修掉上一轮遗留的 `setup --provider <未知名>` 不报错缺口（`parseArgs` 在子命令 early-return 前先扫 `--provider` / `--model`，`schedule` / `task` 等仍从 `subArgs` 取参数），`setup --provider nope` 与 `--example --provider nope` 均一行中文错、退出码 1（回归测试在 `tests/node/test-cli.test.ts`，`setup` 无 flag 时行为不变）；自定义 provider 的 snake_case 条目可解析（`normalizeCustomPreset` / `lookupPreset`，缺 `base_url` 时报错点名该 provider）、向导用 `providerOrder` 列出自定义项；`doctor` 验运行时版本下限（Bun >= 1.4 或 Node >= 24）与 vault 权限位；示例任务只读文件前 4KB；向导输 Key 前加明文提醒。
- 桌面端以远端 main（dea5394）为准三路合并：`lib.rs`（审查的 Node 运行时跳过、读管道 2 秒兜底、90 秒总预算、生成代号防覆盖 + 远端的裸解释器探测）、`tauri.conf.json`（删 `style-src 'unsafe-inline'` + `installerIcon`）、`package.json`（`icons` 脚本取远端的 `python3 scripts/make_icons.py`，脚本已入仓库）、`docs/desktop.md`（审查的引导页打码、90 秒说明、单实例缺失 + 远端的 `make_icons.py` 图标生成说明）；`desktop/ui/app.js` 与 `.github/workflows/desktop.yml` 取审查版（远端自 fad00c8 未动）；图标、`make_icons.py`、`icon-src/nyra-mark-small.svg` 取远端现版。
- 第 3 阶段集成时修掉的缺口（原“已知偏离”，已修、有回归测试）：`nyra setup --provider <未知名>` 曾不报错——`parseArgs` 遇子命令首参即返回、`--provider` 未被解析，向导按配置文件里的 provider 跑；现子命令 early-return 前先扫 `--provider` / `--model`，`schedule` / `task` 相关测试仍全过（见 Node 全量）。
- 验证（集成树内实测，隔离 HOME；第 4 阶段收尾，2026-11-19）：Python 已全部删除（0.4.0 不再有 Python 测试）；Node 全量 **722 项 0 失败**（2634 个 expect，约 94 秒，56 个文件）；`tsc --noEmit` 0 错误；探针 6/6；Linux x64 二进制重编（110,020,784 字节）后 `--version` 输出 `nyra 0.4.0 (node runtime)`，`--help` / `doctor` / `--example` 冒烟通过，`--example --provider nope` 与配置文件写未知 provider 时 `setup` / `--example` 均一行中文错、退出码 1；预算检查全部通过（二进制 ≤130MB、--help 77ms ≤2000ms、首字节 54ms ≤1000ms、gateway 空闲 RSS 36,800KB ≤60MB）；干净安装走查通过（隔离 HOME，`install-node.sh --from-file` 装好，`~/.nyra` 0700，systemd unit 只装文件未启动）；`.deb` 真实安装验证通过（`sudo dpkg -i` 后 `/usr/bin/nyra --version` 为 0.4.0，`dpkg -r nyra-node` 后无残留）；创造模式两例（番茄钟、TODO 扫描）编译二进制端到端跑通。Rust 改动未编译验证（本机无 cargo）；Windows/macOS 真机行为待验证。

## 未发布（Node 运行时第 1 阶段：安装与第一次使用）

- 单文件可执行（Bun `--compile`）：`scripts/build-binaries.sh` 一台 Linux CI 一次编出 5 个产物（Linux x64/arm64、Windows x64、macOS arm64/x64，`file` 格式已验；Linux x64 105M，冷启动 `--help` 18–22ms，对照 Python 基线 0.180 秒）；二进制不进 git，走 GitHub Releases（新增 `.github/workflows/node-binaries.yml`：v* 标签发 Release，prerelease；windows-latest / macos-latest 跑 `--version` / `--example` 冒烟）。
- `nyra doctor` 中文自检（`src/doctor.ts`）：运行时、配置目录（0700）、配置文件、模型配置与 Key、网络、磁盘空间、写权限、vault.json 权限；每项中文说明，故障给中文修复步骤；三种故障（无 Key、目录权限 755、网络不通）逐个造出来验证过，对照（本机 HTTP 服务）7 项全绿。
- 首次启动向导（`src/wizard.ts`，中文三步）：选模型来源 → 填 Key 或选本地 → 跑本地示例任务；示例任务不调模型（读文件前 200 字 + SQLite 插 100 行查计数）；Key 绝不写进 config.json，只问要不要把 export 行追加进 shell rc（默认不追加）。
- 无 Key 模式原样保留（`src/noKey.ts`）：只打印中文设置说明、退出码 1、strace 验证零网络请求；并修了 Python 版的小毛病——提示按当前 provider 给环境变量名（qwen 给 `DASHSCOPE_API_KEY`，不是永远 `DEEPSEEK_API_KEY`）。
- 五端安装包：新增 Node 版脚本 `scripts/install-node.sh`（Linux）、`scripts/install-node.ps1`（Windows）、`scripts/install-node-macos.sh`（macOS）、`scripts/build-package-node.sh`（Linux tarball 50M / .deb 40M，`Depends: libc6`）；PWA 不变，只补了真机验证待办。Python 版安装/打包脚本故意没动（`test_install_script.py` 与 `test_packaging.py` 钉死了它们的行为）；README/GUIDE 快速开始改成“下载、运行”两步，旧方式（`python3 -m nyra`）保留，写明不强制切。
- Bun API 兼容性探针（`scripts/probes/`，6/6 通过）：MCP stdio/HTTP、子进程、WebSocket、加密（PBKDF2 200k 次与 Python 向量逐字节一致）、SQLite（`node:sqlite` 在 Bun 下可用）；不兼容项无；唯一注意点是 WebSocket 探针的服务端用了 Bun 专属 `Bun.serve`。
- 骨架：`src/cli.ts`、`src/config.ts`（14 个 provider 预置与 Python 版一一对应，`NYRA_*` 同名同义、`ANGEL_*` 回退保留）、`src/agent/` 等 9 个目录先放占位并注明第 2 阶段移植；`~/.nyra/` 格式与权限语义不动；模型兜底默认关闭。
- 限制（预览版诚实边界）：有 Key 跑模型任务时明确告知“第 2 阶段移植”、退出码 2；连接器注入的 Key 与密码箱解密在第 2 阶段；`nyra ui` / schedule / REPL 在第 2–3 阶段；Windows/macOS 真机运行、PWA 真机验证、GitHub Release 发布（需打 v* 标签）均为待办。
- 新增 Node 测试 23 项（`bun test tests/node` 全过）与探针总跑脚本；Python 全量 1145 项仍全过（skipped=11）。
- 审查修正（2026-11-19，副本内审查，未发布）：`nyra setup` / `nyra --example` 在未知 provider 时不再抛堆栈，改报一行中文错误、退出码 1；`nyra doctor` 的运行时项开始验版本下限（Bun >= 1.4 或 Node >= 24，旧运行时不再“全绿”），vault.json 读不到权限位时不再当通过；自定义 provider 的 snake_case 条目（`base_url` / `default_model` / `env_key`）现在能解析，向导里可选、不会崩；示例任务只读文件前 4KB，不再整文件读进内存；向导填 Key 前提醒明文回显。安装脚本：`install-node.sh` / `install-node-macos.sh` 补了 `--prefix` 危险值拦截（`/` / `$HOME` / 含空格）、系统检查（Linux / macOS 各自拒绝跑错系统）、下载先落临时文件再 mv、版本号自动补 `v` 前缀；`--with-systemd` / `--with-launchd` 在第 1 阶段只装服务文件、不启动（`schedule daemon` 要到第 2–3 阶段才有）；`build-binaries.sh` 去掉 `declare -A`（macOS 自带 bash 3.2 能跑）；`build-package-node.sh` 的 staging 改放 OUT_DIR 下面，不再挤小 tmpfs。CI：`node-binaries.yml` 开始在推 main（改到 Node 相关文件）时也跑，并加了安装脚本与打包冒烟；Node 测试现为 28 项。文档：README 徽章与测试数 1111 / 1011、GUIDE 的 964 统一改成 1234；快速开始补了“带二进制的 Release 随 v* 标签发布、未发布前先本地构建”的说明；`v0.4.0` 示例版本号改成 `v0.3.0`。另：安全方向修配对码预言机、rm 黑名单绕过、记忆脱敏漏私钥等 9 项；核心方向修压缩尾部孤儿消息、daemon 覆写损坏配置等 25 项；功能方向修知识库目录穿越、技能 frontmatter 注入等 14 项；桌面端修 Node 版 nyra 被误认启动器、读管道挂死等 10 项；汇总修 `test_smoke` 的 `interval=0` 与实现校验冲突、截屏文案谎称模型能看图、`--print-url-json` 模式 stderr 漏真实 token；Python 全量现为 1234 项、Node 28 项。

## 未发布（桌面 App：macOS / Windows 预览）

- 新增 `desktop/`：Tauri 2（Rust + 系统 WebView）桌面外壳。启动时在后台运行本机的 `nyra ui --host 127.0.0.1 --port 0 --print-url-json --exit-on-stdin-close`，读取子进程 stdout 的那行 JSON 后让窗口打开地址；退出时关闭子进程 stdin、3 秒未退则强制结束；子进程中途退出时显示“已停止”页和“重新启动”。查找顺序：`NYRA_PYTHON` → `PATH` 上的 `nyra`（含 `nyra.exe`）→ Python 3.10+（可带 `NYRA_SOURCE` / `~/.local/share/nyra` / `~/nyra` 源码目录）；都没有时显示安装引导（Python / Nyra 安装步骤、“重新检测”），不崩溃。macOS 读一次登录 shell 环境补上 `PATH` 与 API Key。窗口标题 Nyra，图标由 `docs/assets/nyra-mark.svg` 生成（icns / ico / png）。
- 安全：网页界面的 CSP、token 与 `Host` 校验不变；窗口只允许内置引导页与本次子进程的 `http://127.0.0.1:<端口>`，其他 http(s) / mailto 链接交给系统浏览器；网页没有 Tauri IPC（capabilities 不放行远程地址）。桌面端不播入场动画。
- `nyra ui` 新增 `--print-url-json`（stdout 第一行一行 JSON：`nyra` / `version` / `url` / `host` / `port` / `token`，人读提示改到 stderr）与 `--exit-on-stdin-close`；`nyra/webui.py` 新增 `url_json()`、`watch_stdin_close()`。新增 `tests/test_desktop_ui_json.py`（参数、JSON 内容、stdin 关闭回调、真实子进程：读 JSON → 带 token 访问 200 / 不带 403 → 关 stdin 后退出码 0）。外壳自带 Rust 单元测试（启动行校验、导航白名单）。
- 新增 `.github/workflows/desktop.yml`：只在手动触发与 `v*` tag 时运行，macos-latest 构建 universal `.dmg`，windows-latest 构建 `.msi` 与 NSIS `-setup.exe`，作为 workflow artifacts 上传（保留 14 天）；不建 Release。安装包**未签名**（macOS 只有 ad-hoc 签名、未公证），打开方法见新文档 `docs/desktop.md`。
- 图标：全部由 `docs/assets/nyra-mark.svg` 生成（`desktop/scripts/make_icons.py`）：`icon.ico` 含 16/24/32/48/64/256，`icon.icns` 含 16–1024（@2x）；16/24/32 用加粗简化版（`desktop/icon-src/nyra-mark-small.svg`），光标填白以便在深色程序坞 / 任务栏上可辨；NSIS 安装程序图标显式指向同一 `icon.ico`。
- 待办：Apple Developer ID 签名与公证、Windows 代码签名、自动更新、内置 Python；macOS / Windows 真机手动验证。

## 未发布（手机版 PWA + 扫码配对 + 入场动画）

- 手机页面：`python3 -m nyra ui` 新增 `/m`（`nyra/webui_mobile.py`），按手机设计稿做：会话列表（按项目分组，运行中 / 等待批准标记，“新会话”悬浮按钮）、对话流（用户气泡、回复、工具步骤行）、审批卡（“允许一次 / 本会话始终允许 / 拒绝”，按钮高 ≥ 50px，diff 可横向滚动）、底部输入框；浅色 / 深色跟随系统；安卓返回键回到列表。有待审批时页面标题 `(N) Nyra` + Badging API 角标 + 列表顶部横幅（新增 `GET /api/approvals` 列出所有会话的待审批项）；不做推送通知。独立 manifest（`/m/manifest.json`，`start_url` `/m`，`background_color` / `theme_color` `#0B0B0C`，PNG 图标 180/192/512 含 maskable）与 12 种 iPhone 尺寸的 `apple-touch-startup-image`（服务端生成的纯色 PNG，与动画首帧同色，不闪白）。`/m` 页面与静态资源不含秘密、无需 token；CSP 与桌面页面相同，未放宽。
- 入场动画：只在手机上以安装后的独立窗口启动时播放（`display-mode: standalone` 或 iOS `navigator.standalone`，且为触屏、短边 ≤ 1024px），每次冷启动一次（`sessionStorage`），约 3.4 秒，点一下跳过；`prefers-reduced-motion` 时只淡入标志。复用昨天的动画时间轴（`frame(t)` → SVG），按竖屏重新取景；纯 CSS/JS，不含 mp4，零外部请求。桌面网页、手机浏览器普通标签页、官网都不播（有测试）。
- 扫码配对：`python3 -m nyra ui --pair` 监听局域网（打印风险警告）并在终端用 Unicode 半块字符画出二维码；网页“设置 → 手机”的“连接手机”显示 SVG 二维码 + 配对码 + 倒计时，并列出已配对设备、可撤销。二维码内容为 `http://<局域网IP>:<端口>/m#pair=<码>`（码在 fragment 里，不进日志）。新增 `nyra/qrcode.py`：纯 Python QR 编码器（字节模式、L/M 级、版本 1–40、8 种掩码按罚分选优），结构参考 Project Nayuki 的 QR Code generator（MIT），独立精简重写。
- 设备鉴权：`nyra/pairing.py` 新增 `DeviceRegistry`（基于原有配对码规则）：6 位码、5 分钟有效、一次性、错 5 次作废、重新生成即作废旧码；配对成功发设备专属 token（只返回一次），`~/.nyra/devices.json` 只存 SHA-256（0600、原子写入、最多 20 台），别的进程改了登记表（如 `python3 -m nyra.pairing revoke`）会自动重读。网页界面新增 `POST /api/pair`（唯一免鉴权的 API）、`GET /api/devices`、`POST /api/pair/start`、`POST /api/devices/{id}/revoke`——后三个只认电脑端启动 token；手机用请求头 `X-Nyra-Device`，无效时回 401。默认仍只绑 `127.0.0.1`，此时“连接手机”返回 409 并提示用 `--pair`。
- 文档：`docs/mobile-pwa.md` 改写为扫码流程；GUIDE 网页界面一节加“手机”小节。如实说明：只用 Playwright 模拟 iPhone 14 / Pixel 7（Chromium）跑通过，没在真机上装过。
- 新增 `tests/test_mobile_pwa.py`（二维码可解码——装了 zxing-cpp 时用它解码并与自写校验器交叉核对，否则用自写校验器：读格式位、去掩码、解交织、RS 校验子为零、解析字节模式；配对码过期 / 一次性 / 限次 / 新码作废旧码；token 只存哈希、撤销、跨进程撤销；动画判断规则用 node 跑多组环境；`/m` 免 token 而 API 仍鉴权、CSP 不变、完整配对流程与权限边界、`--pair`）。

## 未发布（网页界面桌面端 v2）

- 网页界面（`python3 -m nyra ui`）按已定稿的桌面端设计稿重写前端（`nyra/webui_page.py`）：黑白极简、浅色/深色跟随系统；左侧按项目分组的会话列表 + 搜索 + 新建会话；对话流里工具调用折叠成步骤行（读取 / 搜索 / 编辑 / 运行…），运行中显示“正在工作 · Ns”、结束显示“工作了 Ns · N 个步骤”；审批卡片带审批时的真实 diff，按钮为“拒绝 / 本会话始终允许 / 允许一次”；一轮改动结束后出现改动文件卡；右侧审阅面板（改动 / 计划 / 证据 / 终端 / 产物 / 用量）；底部输入框带审批模式切换、模型选择与计划模式开关；顶栏显示运行状态、等待批准、本会话 Token 用量；状态栏显示工作目录、模式、上下文占用、MCP。390px 手机宽度可用，全键盘可操作，`prefers-reduced-motion` 时关动画，无开场动画。品牌标志内联 `docs/assets/nyra-mark.svg`；旧的“品牌与外观”色板页与鼠尾草绿配色退役，PWA manifest 与 theme-color 同步改为黑白（`#0B0B0C` / `#FFFFFF`）。只做内核真实支持的功能：设计稿里的 diff 逐行评论、提交 / 在编辑器打开、云电脑、终端实时输入没有做按钮。
- 后端最小补充（都有测试）：
  - “本会话始终允许”：`tools.py` 的 `approve_fn` 可回 `APPROVE_ALWAYS`，按终端 `a` 相同的范围（同一文件的 `write_file` / `edit_file` / `plan`，或完全相同的 shell 命令 + 目录 + 超时）记在 `ToolContext.approve_fn_grants`，与终端缓存授权分开记账、互不放行；`SESSION_GRANT_TOOLS` 标出可用的工具。网页 `POST /api/approvals/{id}` 与 API 服务器 `POST /api/approvals/{id}/decide` 都接受 `{"approve": true, "always": true}`，对没有会话范围的工具返回 400；审批事件与 `pending` 里多一个 `always` 字段，`approval_result` 也标明是否为会话授权。
  - 会话按项目分组：网页端发消息时把会话的工作目录记到 `~/.nyra/sessions/ui-projects.json`（原子替换，最多 2000 条，坏文件忽略）；`GET /api/sessions` 每条会话多 `workdir` / `project`（未记录的为 `null`，不猜），并返回当前 `project`。
  - 计划模式：`POST /api/sessions/{id}/plan`（与 `nyra --plan` 同一条只读规划路径，只写 `plan.md`，事件 `plan_ready` 带全文与 SHA-256）和 `POST /api/sessions/{id}/plan/execute`（`{"sha256": …}`，校验不符或只读模式返回 400，执行仍走正常审批）。
  - 字体：Inter（400/600）与 JetBrains Mono（400）的拉丁子集 WOFF 以 Python 数据随包（`nyra/webui_fonts.py`，SIL OFL 1.1，约 77 KB），`GET /assets/fonts/<名>.woff` 须请求头 token；页面用 FontFace API 从 ArrayBuffer 加载，CSP 不变（未加 `font-src`），零外部请求。
- 新增 `tests/test_webui_v2.py`（24 项：会话授权范围与隔离、两套 API 的 `always`、项目分组、计划模式生成/执行/只读拒绝/失败、字体鉴权、CSP 不变、页面控件与无假按钮）；`tests/test_webui.py` 的配色、视图、manifest 断言随新设计更新。用 Playwright + 本地桩模型实际点过：发消息、审批卡、允许一次 / 本会话始终允许 / 拒绝、看 diff 与终端、切模式、切会话、计划模式生成并执行，桌面 1440 / 手机 390 / 深色均截图检查，控制台零错误、零外部请求。
- 测试 1011 → 1035 项，全部通过（skipped=10）。

## 未发布（命令行交互界面重做）

- 交互模式（`python3 -m nyra`）参照常见终端编程助手的布局重做，只借鉴布局与交互，文字、配色与标志都是 Nyra 自己的（黑白极简 + 少量强调色）。新增 `nyra/tui.py`（标准库 only）：启动头部（左侧 4 行半块字符的 Nyra 标志——实心圆里刻光标，单色；右侧 `Nyra v<版本>` / `<模型> · <provider> · <计费方式>` / 工作目录，窄于 60 列只留文字）；上下横线夹住的 `> ` 输入行（随终端宽度，左右键/Home/End/历史/Ctrl+U/K/W/L，超宽横向滚动，中文两列宽）；输入框下的状态栏（`[模型] │ 项目名`、`上下文 N%`——只用 provider 报告的最近输入 token 与已配置窗口计算，缺一个就不显示、不估算；审批模式行 `›› auto（shift+tab 切换）`，full 整行红色警告）。推理强度/计划模式状态内核不支持，不显示。
- shift+tab 循环 readonly → auto → full → readonly；进 full 要连按两次（第一次只亮红色确认提示，按其他键取消）。切换走与 `/mode` 同一个函数（`cli.py` 里抽出 `switch_mode`：重启 MCP 子进程、清空逐项批准），安全约束不变。
- 工作区信任确认：首次在某目录交互运行时先问“正在访问工作区：”，`1. 是，我信任这个文件夹` / `2. 否，退出`，上下键或数字选择，Enter 确认、Esc 取消（Esc / Ctrl+C 算否）。新增 `nyra/trust.py`：信任记录存 `~/.nyra/trusted_workspaces.json`（每个绝对路径一条、只认目录本身、0600 原子写入，文件损坏视为未信任）。新增 `--trust` 参数与配置项 `skip_workspace_trust`。非 TTY、`--json`、定时任务、worker、E2B 沙盒不弹，行为不变。未信任即退出（退出码 1），信任后按原审批规则，不自动放宽。
- 退回路径：stdin/stdout 不是终端、`TERM=dumb`、Windows 不能开 VT 模式或 `NYRA_TUI=0` 时，交互模式保持原来的字标横幅 + `nyra[auto] ›` 纯文本界面；`NO_COLOR` 只去颜色不改布局；终端编码不支持方块字符时改用 ASCII。按键：macOS/Linux 用 `termios`，Windows 用 `msvcrt`（`\x00\x0f` 即 shift+tab）。界面文字默认中文，`language: "en"` 或 `NYRA_LANG=en` 切英文。零新增依赖。
- 启动时间（本机中位数，改前 → 改后）：`--version` 110.6 → 110.6 ms，`import nyra.cli` 107.2 → 106.6 ms，伪终端里从启动到可输入 98.5 → 100.8 ms（`tui` 只在交互 TTY 路径里延迟导入）。
- 新增 `tests/test_tui.py`（41 项：头部宽/窄/无色、状态栏宽/窄/NO_COLOR/ASCII/英文、上下文百分比、信任确认渲染、模式循环、POSIX 与 Windows 按键解析、TTY/dumb/NYRA_TUI/Windows VT 能力判断）与 `tests/test_trust.py`（14 项：信任存储、精确路径、损坏文件、权限、CLI 信任闸门在非 TTY/`--trust`/配置跳过/是/否下的行为）。另用伪终端实跑了 启动 → 信任确认 → 头部与状态栏 → shift+tab → 退出 全流程。如实说明：Windows 与 macOS 没在真机上手动跑过，Windows 路径靠 CI 单元测试与代码审查。
- 纯文本退回界面保留提示符上方的一行状态（`format_repl_status`）；`nyra/approval_ui.py` 的审批选择器与工具输出实时流不受影响。
- 新增测试 55 项；当前全量 1111 项全部通过（skipped=10）。

## 未发布（电脑操作 + 视觉模型看屏 + 多模型调研 + 群聊多 Key）

- 电脑操作：新增 `nyra/computer.py`（`ComputerControl`，标准库 only，三后端：Linux xdotool、Windows ctypes 直调 user32/gdi32、macOS osascript + screencapture；`screenshot` / `click` / `move` / `type_text` / `press` / `windows` / `screen_size`，坐标校验、按键归一化；DISPLAY 未设或 xdotool 缺失时报清错，不自启 X 服务、不装东西、不联网）与 `nyra/tools.py` 的 5 个新工具（`computer_screenshot` / `computer_click` / `computer_type` / `computer_key` / `computer_windows`，全部进 `MUTATING_TOOLS`，照 `browser_*` 规矩走 `_check_approval` + `wrap_untrusted` + 证据目录）。`nyra/webui.py` 的 `NEEDS_APPROVAL_TOOLS` 与 `/api/info` 工具数同步补到 24（`tests/test_webui.py` 断言 18→24）。新增 `tests/test_computer.py`（44 项，全 mock）。如实说明：本机无桌面，`sudo apt-get install -y xdotool` 一次尝试即失败（源里没有这个包），没跑成 Xvfb 真冒烟；Windows/macOS 后端只在 mock 上验过，没在真机上跑过；Nyra 本身不“看图找按钮”，坐标须来自用户、窗口几何，或视觉模型看了截屏后报的点。
- 视觉模型看屏：新增 `nyra/vision.py`（`image_part` / `supports_vision` / `build_image_message`：OpenAI 兼容 image part、视觉模型判断表 + `NYRA_VISION_MODELS` 环境变量覆盖）与 `nyra/providers.py` 的 `_normalize_messages`（`str` 照旧、part 列表原样透传进 HTTP payload，Codex CLI 路径扁平化 part 不炸）。`computer_screenshot` 的工具描述已改成“已配置视觉模型时，模型可直接看这张截屏定位元素、再报坐标点”。新增 `tests/test_vision.py`（26 项，全 mock）。还差一步：`agent.py` 主循环在工具结果处把截屏 PNG 挂进下一次模型请求——该文件冻结，等 A–E 合并后接线，接线点已写进 `vision.py` 的模块 docstring；在那之前截屏只存证据、不进模型视野。
- 多模型调研：新增 `nyra/multi_model.py`（`research(models, prompt, system, timeout, synthesizer)`：同一问题并行问多个模型——`provider` 或 `provider:model`，最多 5 个，线程并行、共用一个超时；挂掉或超时的模型只记录、不兜底、不拖垮其他模型；可选一个综合模型把各家回答按模型署名合成共识/分歧/独特观点三节；入口 `python3 -m nyra.multi_model research --models a,b --prompt ... [--synthesizer x] [--json]`，`--list` 列 14 个 provider）与 `tools.py` 的 `multi_model_research` 工具（不进 `MUTATING_TOOLS`，与 `delegate` 同例：只花模型调用、不写文件不跑命令）。新增 `tests/test_multi_model.py`（20 项，含 3 项工具接线测试，全 mock）。只做纯文本调研 v1，图片输入走 `vision.py`。
- 群聊多 Key：每个机器人可配各自独立的多个 API Key（`nyra/groups.py` 的 `Bot.api_keys`，最多 5 把，空 Key 与超数都报清错，旧房间无此字段照常解析；不同机器人之间不共享 Key 池）；新增 `nyra/providers.py` 的 `KeyRotatingProvider`（同一 provider+模型、多把 Key 轮换：401/403 也轮换——换 Key 能治认证问题，换模型不能，这是与 `FallbackProvider` 故意不同的语义；每把 Key 失败都记进 `switches`，全挂时报错只写“第几把 Key”绝不带 Key 值；每次调用从第一把 Key 重新开始）。`GroupStore._provider` 在有 `api_keys` 时用 `dataclasses.replace` 逐 Key 生成配置并包进 `KeyRotatingProvider`，无 Key 时走原来的兜底链不变；CLI 认证的机器人（Codex）配 Key 时报清错。展示数据已脱敏（发给网页端的机器人信息不含 Key）。新增测试在 `tests/test_group_chat.py`（轮换、401/402/429 全轮换、全挂不泄 Key、单 Key 路径、旧房间兼容等）。`FallbackProvider` 与 `build_provider_chain` 未改。
- 测试 860 → 964 项，全部通过（skipped=11）。

## 未发布（五端安装包：Linux 复核 + Windows + macOS + 手机 PWA）

- Linux 打包复核：`bash scripts/build_package.sh` 重跑成功，tarball（261,901 字节）与 .deb（201,358 字节）均含全部 46 个 `nyra/*.py`（7 个新模块全在内），不含 `__pycache__` / `.venv` / `.git`；tarball 解压后 `python3 -m nyra --version` 出 `Nyra 0.3.0`，新模块 import 全过；.deb 的 control 字段与解包后 payload 同样验证通过。本轮 .deb 未做真实 `sudo dpkg -i` 系统安装（此前真实安装验证时的模块集比现在少，本轮只是多了 .py 文件），构建脚本无需改（glob 自动包含新模块）。
- Windows：`scripts/install.ps1` 逐行审过并修了 4 个真问题（`git pull` / `git clone` 失败时查 `$LASTEXITCODE` 停下、不再装半截；识别微软商店 python 占位程序并报错指去 python.org；只有 `py` 启动器时也能用；图标下载失败先删半截文件）；新增 `.github/workflows/build-windows.yml`（windows-latest + Python 3.12：先跑全量测试，再用 PyInstaller 打单文件 exe，跑 `nyra.exe --version` 冒烟，上传为 workflow artifact 保留 90 天；只有 `v*` 标签才走 release job 挂到 Release，普通 main 推送绝不发布；`webui.py` 运行时要读的 4 个非代码文件已 `--add-data` 进包）。新增 `docs/windows-install.md`，README 快速开始处加指向。如实说明：exe 与脚本都没在真 Windows 上跑过（本机无 PowerShell、无 Wine，装 PowerShell 的一次尝试也被运行时重启打断、未装上，脚本只做了括号平衡弱检查），CI 是第一次真正的语法与运行验证；`branding/nyra.ico` 尚未推送，脚本装的快捷方式暂时是默认图标，图标推上去后重跑脚本可换上。
- macOS：新增 `scripts/install-macos.sh`（镜像 Linux `install.sh`：装到 `~/.local/share/nyra`、启动器 `~/.local/bin/nyra`、`~/.nyra` 0700、`--source` 支持本地目录或 git URL、重复跑即升级、`--uninstall` 保留数据；开头验 Darwin、python < 3.10 拒绝并指 `brew install python`、PATH 不在时给 zsh 的 `~/.zshrc` 追加命令，只写 `$HOME`、零 pip 依赖）与 `launchd/ai.nyra.scheduler.plist`（`Label` 为 `ai.nyra.scheduler`，跑 `python3 -m nyra schedule daemon`，`RunAtLoad=true` + `KeepAlive`（`SuccessfulExit=false`，即 systemd `Restart=on-failure` 的镜像），日志进 `~/.nyra/logs/`），新增 `docs/macos-install.md`。验证：`bash -n` 通过、plist 解析通过、占位替换后无残留、Linux 上跑以 exit 1 拒绝并说明去向；如实说明：没在真 Mac 上跑过，`launchctl load` 用的是老式命令。
- 手机 PWA（Android / iOS 的安装方式）：`nyra/webui.py` 新增 `GET /manifest.json`（name/short_name "Nyra"、display standalone、背景 `#F3F5F4`、主题 `#5F7D5C`、图标 `/nyra-mark.svg`）与 `GET /nyra-mark.svg` 两个路由，均走与页面一样的 token 鉴权（浏览器拉 manifest 不带请求头，只能走查询串 token），CSP 补 `manifest-src 'self'`；`nyra/webui_page.py` 的 head 加 manifest 链接、theme-color、apple-touch-icon 等 7 个标签与移动端 CSS（≤760px 时主要按钮最小 44px 触摸高度、顶栏收紧、防 360px 宽横向溢出）。新增 `docs/mobile-pwa.md`（安卓 Chrome 与 iPhone Safari 的“添加到主屏幕”步骤、局域网访问要 `python3 -m nyra ui --host 0.0.0.0` 并把链接里的 `127.0.0.1` 换成电脑局域网 IP、安全警告：只在信任的家庭 Wi-Fi 下用、绝不映射到公网）。新增 `tests/test_webui.py` 的 `PWATests`（6 项）并收窄 `test_page_has_no_external_resources` 的 blanket `<link>` 断言为只禁外部 href。如实说明：没在真手机上装过；token 每次启动随机、写不进静态 manifest，点主屏幕图标会先看到 token 门页（须先在浏览器打开带 token 的链接再添加）；无 Service Worker、不支持离线；图标只有 SVG。
- 测试 854 → 860 项，全部通过（skipped=11）。

## 未发布（架构解耦第 1 批：API 服务器 + Artifacts + sqlite 对话记忆 + CDP 浏览器）

- 新增 `nyra/server.py`：独立 API 服务器（标准库 `http.server` + `threading`，默认只绑 `127.0.0.1:8766`，网页界面仍用 8765），持有自己的 `UIState`，入口 `python3 -m nyra.server`：`POST /api/sessions` 建会话、`GET /api/sessions/{id}/messages` 读会话、`POST /api/sessions/{id}/send` 发任务（202 立即返回，后台跑）、`GET /api/sessions/{id}/events?since=N` 用 SSE 推事件（断线重连按 `since` 游标补发漏掉的事件，15 秒心跳，跑完以 `run_finished` 结束）、`POST /api/approvals/{id}/decide` 批/拒工具、`GET /api/health` 健康检查（唯一免 token）。鉴权与网页界面同一套：每次启动随机 token，`X-Nyra-Token` 请求头、常量时间比较，查询串 token 一律不认；loopback 绑定时验 Host 头、不开 CORS；未知会话 404、空文本/坏 JSON 400、运行中重复发送 409，错误一律 JSON、不炸服务。新增 `tests/test_server.py`（22 项，全离线：假 provider、随机本地端口）。
- 新增 `nyra/artifacts.py`：Artifacts（富文本产物）存储与检测——`create_artifact` / `get_artifact` / `list_artifacts`（JSON 文件存 `~/.nyra/artifacts/<会话>/`，0700 目录、单件 1 MB 上限截断并标记、每会话 50 件上限删最旧的）、`detect_artifacts` 从 agent 输出里拆围栏代码块与裸 HTML 块（未闭合的围栏与正文里的 `<` 不动，拆出的位置留一行 `[产物：标题]` 标记，不丢文本）、`markdown_to_html`（先转义 HTML 再做标题/粗斜体/代码/列表/链接子集）。网页端 `nyra/webui_page.py` 加“产物”侧栏：从已轮询的会话消息里派生产物列表（全量加载与实时事件都接），代码用 `textContent` 显示、Markdown 用 DOM 拼（`createElement`/`textContent`，不用 `innerHTML`）、HTML 只进 `sandbox="allow-scripts"` 的 iframe `srcdoc`。新增 `tests/test_artifacts.py`（21 项，全离线；页面 JS 另过 `node --check`）。
- 新增 `nyra/conversations.py`：sqlite 对话记忆——`NYRA_HOME/conversations.db`（0600 文件、0700 目录，schema 版本表 + 开库迁移），`messages` 表（会话/角色/文本/工具名/时间）+ FTS5 全文索引（trigram 分词，中文子串能查；短于 3 字符的词自动走 LIKE 兜底，按关键词重叠数打分；无 FTS5 的环境只走 LIKE）。`record` / `history` / `search` / `retrieve_context`（拼给 prompt 用，单条 300 字、上限 2000 字）/ `sessions` / `prune`（删 90 天前的，FTS 触发器同步）。存前先过 `memory_exchange.py` 的 `scrub_secrets`（只剩凭据的行不存），SQL 全参数化。暂未接 agent 主循环与 server（冻结文件，等 A–E 后接线）。新增 `tests/test_conversations.py`（18 项，全离线，临时 NYRA_HOME）。
- 新增 `nyra/websocket.py` + `nyra/cdp_browser.py`：agent 自己的浏览器（CDP）——最小 WebSocket 客户端（标准库 `socket` + `http.client`，握手验 `Sec-WebSocket-Accept`、客户端掩码、分片重组、126/127 扩展长度、ping 自动回 pong、close 握手、10 MB 上限）；CDP 客户端只连本机 Chrome（`http://127.0.0.1:9222/json` 取 page 目标，非 loopback 拒绝、绝不自动启动 Chrome），`navigate`（只 http/https，最多等 10 秒加载事件，慢页不挂住 agent）、`evaluate`（返回值，JS 异常报详情）、`click`（`querySelector` 点元素，找不到报错）、`screenshot`（PNG 字节）、`title` / `current_url` / `visible_text`、`close`；失败一律报清楚的 `CDPError`，不挂起。`nyra/tools.py` 只加三个工具（`browser_navigate` / `browser_click` / `browser_screenshot`，走原有 `_check_approval` 与 `wrap_untrusted`，截图写证据目录），`nyra/webui.py` 的 `NEEDS_APPROVAL_TOOLS` 与 `/api/info` 工具数同步补到 18。新增 `tests/test_websocket.py`（13 项）与 `tests/test_cdp_browser.py`（29 项），全 mock，不启动真 Chrome。已知缺口：会话结束时没有统一 teardown hook 调 `disconnect_browser`（`cli.py` / `agent.py` / `webui.py` 均冻结），连接随进程退出关闭。
- 终端横幅改成 NYRA 四字母字标：11 行 × 42 列纯 `#` 粗体（`nyra/banner.py` 的 `WORDMARK` / `wordmark_lines`，`tests/test_banner.py` 改写为字标测试 10 项：N 斜线/Y 叉/R 碗/A 横杠、全行非空、只含 `#` 与空格）；此前线条画天使与照片密度画两版均已否决，不再使用。标志定为光标 01（`docs/assets/nyra-mark.svg`、Windows 图标 `branding/nyra.ico`），Windows 一键安装脚本 `scripts/install.ps1` 已写（未在真 Windows 上试过）。
- 测试 741 → 860 项，全部通过（skipped=11）。

## 未发布（配对码协作 + 本地密码箱 + 本地知识库 + CI 去位）

- 新增 `nyra/knowledge.py`：本地 AI 知识库——建库、收录文本/文件/网页正文、分块存成本地笔记（`NYRA_HOME/knowledge/<库名>/kb.json` + `notes.jsonl`，每条带标题、来源、日期）、BM25 本地检索、`ask` 提问时把相关笔记交给模型回答并注明依据的笔记标题，库里没有就直说不知道、不编造。标准库 only，不依赖第三方服务。模块入口 `python3 -m nyra.knowledge create|list|add|search|ask|remove`（`add` 支持 `--file` / `--dir` / `--text` / `--url`；`remove` 需输入 yes 确认）。说明边界：抖音视频链接本身拉不到完整文稿（JS 渲染的页面只能拿到标题与描述），视频内容须先把文稿贴进来；跟 agent 主循环的自动调用等 A–E 合并后再接。新增 `tests/test_knowledge.py`（13 项，全离线）。
- 新增 `nyra/pairing.py`：配对码协作——两个 Nyra 用 6 位数字码配对后一起工作。宿主显示配对码（10 分钟过期、一次性、错 5 次作废），客人输入码配对，拿到会话 token（只存内存）后可发任务；任务只在宿主以只读模式执行（不写文件、不跑 shell、不发网络请求），会话只传任务文本与结果，绝不传凭据；只在可信网络配对。宿主是本机 HTTP（0.0.0.0 临时端口，POST /pair、POST /task 须 Bearer token、GET /ping）+ UDP 47831 发现广播；客人有 discover（UDP 广播，5 秒）/pair/run_task/ping。模块入口 `python3 -m nyra.pairing host|join CODE`。新增 `tests/test_pairing.py`（19 项，全离线：错码/过期/5 次作废/无 token 401/发现走 127.0.0.1 单播）。
- 新增 `nyra/vault.py`：本地加密密码箱——provider API Key / 账号密码加密存在本机 `NYRA_HOME/vault.json`（0600 文件、0700 目录），agent 用的时候读出来，绝不在聊天记录、日志里暴露明文。标准库 only：PBKDF2-HMAC-SHA256 200_000 次、64 字节密钥分加密/认证各 32、HMAC-CTR 异或加密、HMAC 验 MAC 后才解密、verifier 验主密码；解密失败统一报错，不区分密码错与文件被改。`config.py` 的 `resolve_provider` 加回退：环境变量里没 Key 且认证方式是 env（无连接器）时读密码箱，文件不存在、未设 `NYRA_VAULT_PASSWORD`、解锁失败时静默跳过、保持原报错，绝不弹 getpass。模块入口 `python3 -m nyra.vault init|add|get|list|remove|change-password`，密钥一律 getpass、拒绝 argv 传密钥。威胁模型写在模块 docstring 里：防读文件，不防机器被入侵/内存/弱主密码，未审计，高价值密钥用专业密码管理器。新增 `tests/test_vault.py`（35 项，全离线）。
- CI 不再依赖 `.sh` 可执行位：快照式推送会丢文件模式（GitHub 上常为 644），测试与文档里原来直接跑 `./scripts/install.sh` / `./scripts/build_package.sh` 的地方全改成 `bash` 显式调用；两个静态测试改断言 shebang（不测模式位）；`docs/linux-install.md` 与 `docs/linux-packaging.md` 里的示例命令同步改成 `bash scripts/...`。去位验证：安装与打包测试 24 项全过。
- 新增 `skills/deep-thinking.md`：深度思考十问（来源：X @Khazix0918“数字生命卡兹克”2026-11-18 的帖子，用户要求写入 Nyra）——第一性原理、对齐喜好出 3 版方案、质疑问题定义、二阶三阶影响、跨领域类比、反方证伪、Git 历史包袱、新人认知成本、慢 PR 分析、Bug 复盘沉淀；按任务挑相关的几条用，不必十条全走一遍。`--list-skills` 与网页端技能列表同步更新为 4 个。新增 `tests/test_skill_deep_thinking.py`（4 项：解析、十条齐全、关键词匹配、自带技能全加载）。
- 新增 `nyra/memory_exchange.py`：记忆模式，照 Muse 的记忆导入做——快照导入/导出（固定五章：身份 / 事实 / 偏好 / 目标与承诺 / 关系，第三人称、只写确切信息、无可靠信息的章节省略；`export-prompt` 打印提示词贴到别的 AI 聊天里让对方输出快照；`import` 去重合并进 MEMORY.md，只追加不覆盖）、配对读记忆（宿主加 GET /memory，须 Bearer token，返回脱敏后的快照；客人加 read_peer_memory，复用带 auth 的请求）、本地读取（Codex 只读打开 `~/.codex/memories_1.sqlite`，本机版本没有 memories 表、记忆在 stage1_outputs.raw_memory 里，两种结构都支持；Claude 读 `~/.claude/CLAUDE.md` 与 MEMORY.md；指定目录读 MEMORY.md / AGENTS.md / CLAUDE.md；找不到或库里没内容报“未找到”）、聊天 .zip 导入（ChatGPT / Claude 的 conversations.json：解析对话清单、原文存 `~/.nyra/memory-imports/<日期>-<来源>/`、MEMORY.md 只记一行导入记录，不做自动事实提炼）。导出与导入两端都先过 scrub_secrets（含凭据的行删掉并计数）；配对原有安全规则不变。模块入口 `python3 -m nyra.memory_exchange export|export-prompt|import|peer|local|import-zip`（cli.py 冻结未碰）。`nyra/pairing.py` 只加 GET /memory 与 `PairingClient.read_peer_memory()`。新增 `tests/test_memory_exchange.py`（34 项，全离线）。
- 新增 `nyra/untrusted.py`：提示词注入防御——`web_fetch` / `web_search` 抓到的网页内容在进模型前先打首尾标记（不可信外部数据，附来源 URL，标记在截断之后、原文同款标记先中性化防冒充），并按句拦截中英文指令型文字（无视指令、改写身份/系统提示、要求执行命令或删文件、泄露密钥等），被拦句改占位行不进上下文；证据文件仍存原文备查。`nyra/tools.py` 只改接入点与两处 tool schema 描述。新增 `tests/test_untrusted.py`（14 项，全离线）。
- 测试 727 → 741 项，全部通过。
- 文档补齐与小修：GUIDE“项目结构”补 19 个模块、工具数 15 改 18（加 3 个 Poppy opt-in 工具说明）、“路线图”一节换成待开发项集中清单、“测试”一节测试数 472 改 727；README“它能做什么”加配对码、密码箱、知识库、MCP 预置四项，快速开始补 Python 3.10+ 要求与 Windows `python -m nyra` 命令；修 `--provider ollama` 不带 `--model` 时错传 deepseek-flash 的问题（config.py 的 resolve_provider：配置默认值漏到新 provider 时改用新 provider 的预置默认模型）、load_config 新建 `~/.nyra` 时用 0700（已有目录不动）。新增 `tests/test_generic_providers.py` 回归测试 8 项。

## 未发布（MCP 内置预置）

- 新增 `nyra/mcp_presets.py`：内置 10 个 MCP 服务器预置，开箱即用，无需手写 `mcp_servers`。默认开启的 4 个（无需密钥、无需路径）：memory（知识图谱记忆）、sequential-thinking（结构化思考）、fetch（抓网页转 Markdown）、time（时间与时区）。按名启用的：github（需 GITHUB_PERSONAL_ACCESS_TOKEN）、brave-search（需 BRAVE_API_KEY）、filesystem / git / sqlite（需在 `mcp_preset_args` 里给路径）、puppeteer（首次使用下载 Chromium）。预置只给配置，不自动启动：MCP 默认关闭，`auto` 模式下每个服务器启动前仍逐一确认。
- 配置新增 `mcp_presets`（默认 4 个即用型）与 `mcp_preset_args`（预置名 -> 追加参数，如 `{"filesystem": ["D:/docs"]}`）；`load_mcp_servers` 先合入预置，再叠加用户 `mcp_servers`（同名覆盖）；密钥缺失或路径未给时跳过并在 stderr 说明原因，密钥只通过 `inherit_env` 按名转发。`--list-mcp` 不变。
- 新增 `tests/test_mcp_presets.py`（单元测试离线跑；真实服务器测试需 `NYRA_LIVE_MCP_TESTS=1`）：预置表结构、默认集与默认配置一致、解析（密钥缺失跳过/路径追加/同名覆盖/未知名跳过）、`load_mcp_servers` 合并行为；真实服务器逐个实测通过（见下）。
- 实测（2026-11-18，本机，真实 npx/uvx 服务器）：memory、sequential-thinking、fetch、time、filesystem（临时目录）、git（临时仓库）、sqlite（临时数据库文件）、github 与 brave-search（假密钥，只验启动与工具列表）均能启动并列出工具；puppeteer 也已实测通过（旧版 2024-11-05，7 个工具：navigate/screenshot/click/fill/select/hover/evaluate，首次下载 Chromium 约 79 秒）。10 个预置至此全部实测通过。只收录 npm/PyPI 上确认存在的包：fetch、git、time 走 PyPI（`uvx mcp-server-*`，需装 uv），其余走 npm（`npx -y @modelcontextprotocol/server-*`，需装 Node.js）；github、brave-search、sqlite、puppeteer 为官方已归档服务器，已在预置说明里注明。
- 实测中修了三个真问题：① 探测超时 5 秒不够（npx/uvx 首次下载要二三十秒，超时后回退握手会被现代服务器拒绝），`PROBE_TIMEOUT` 改到 60 秒，并加慢启动回归测试（假服务器 7 秒后才回探测，须走现代版）；② 子进程环境不传代理与 CA 变量，沙箱/公司出口代理下首次下载连不上：`_subprocess_env` 现透传代理变量（HTTP(S)_PROXY、ALL_PROXY、NO_PROXY、NODE_USE_ENV_PROXY）与受信 CA 变量（NODE_EXTRA_CA_CERTS、SSL_CERT_FILE、CURL_CA_BUNDLE、REQUESTS_CA_BUNDLE、GIT_SSL_CAINFO、AWS_CA_BUNDLE），代理 URL 里嵌的密码去掉再传，用户在 `inherit_env` / `env` 里显式声明的优先；③ sqlite 预置缺 `--db-path` 参数（服务器直接报错退出），且已归档的 sqlite 服务器与新版 MCP SDK 不兼容（`Server` 没有 `list_resources`），现用 `uvx --with mcp==1.30.0` 固定跑 1.x。memory 预置默认把知识图谱写到 `~/.nyra/memory.jsonl`（不在 npx 缓存里，缓存清了也不丢）。

## 未发布（MCP 协议升级到 2026-07-28）

- MCP 客户端从 2024-11-05 升级到 2026-07-28：双时代协商——先用 `server/discover` 探测现代版（每次请求在 `_meta` 里自带 `io.modelcontextprotocol/protocolVersion`、`clientCapabilities`、`clientInfo`），探测失败（非现代错误或超时，最多等 60 秒）时回退旧版握手 `initialize`（最新握手版 2025-11-25）；旧版服务器返回的协议版本须在已知列表里（2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05），未知版本直接报错。只做 stdio，HTTP 传输不在本客户端范围。
- `-32022 UnsupportedProtocolVersionError`：按服务器列出的 `supported` 重试现代版，没有共同版本时回退握手；迟到响应按已放弃的请求 id 丢弃，不冲掉握手的 id 匹配。
- `tools/list` 跟随 `nextCursor` 分页；`tools/call` 返回 `resultType: input_required`（多轮往返）时直接报错，Nyra 暂不支持交互式追问；`clientInfo` 版本改成跟包版本（0.3.0），不再写死 0.2.0。
- 新增 `tests/test_mcp_protocol_2026.py`（12 项）：现代/旧版/旧版低版本/空发现结果/`-32022` 回退/未知旧版拒绝/沉默探测超时回退/分页/多轮往返报错/`-32022` 重试；原有三个假服务器对未知方法改回 `-32601`（更贴近真实旧版服务器）。
- 测试 573 → 585 项，全部通过；未做的：HTTP（Streamable HTTP）传输、MRTR 交互式追问。

## 未发布（Linux 打包）

- 新增 `scripts/build_package.sh`：从当前检出产出 `dist/nyra-<版本>.tar.gz`（解压即用，顶层目录 `nyra-<版本>/`）与 `dist/nyra_<版本>_all.deb`（装到 `/usr/share/nyra`，启动器 `/usr/bin/nyra`，只声明 `Depends: python3 (>= 3.10)`）；版本号只从 `nyra/__init__.py` 读；只打包白名单文件（`nyra/*.py`、`scripts/install.sh`、systemd unit、README/GUIDE/CHANGELOG/LICENSE、`docs/linux-*.md`），`.git`/`.venv`/`__pycache__`/`dist/` 不进包；没有 `dpkg-deb` 时只产出 tarball 并警告；无 maintainer 脚本，不碰用户 systemd 与 `~/.nyra`。
- 新增 `docs/linux-packaging.md`：构建、核对（`tar -tzf` / `dpkg-deb --info`）、.deb 与 tarball 两种安装方式、卸载、安全说明；README 快速开始处加一行指向该文档。
- 新增 `tests/test_packaging.py`（11 项）：`bash -n`、--help、未知选项失败、tarball 命名与白名单内容、解压后 `python3 -m nyra --version` 跑出版本、`--no-deb` 只产 tarball、.deb 的 control 字段与内容、解包后 payload 可运行；执行类测试只在 POSIX + bash/tar 环境跑。
- 测试 562 → 573 项，全部通过；本机实测 tarball 与 .deb 均已产出并冒烟通过（`Nyra 0.3.0`）。
- 本轮只做打包；Linux 平台部署三项（systemd 服务、安装脚本、打包）至此全部落地（另两项提交仍在本地未推，见下）。

## 未发布（Linux 安装脚本）

- 新增 `scripts/install.sh`：Linux 一键安装，只写 `$HOME`、不需要 root；把 Nyra 装到 `~/.local/share/nyra`（`--prefix` 可改），在 `~/.local/bin/nyra` 放启动器（`PYTHONPATH` 指到安装位置，cwd 无关），建 `~/.nyra`（0700），装完跑 `nyra --version` 自检；`--source` 支持本地目录（直接复制，去掉 `.git`/`.venv`/`__pycache__`）与仓库 URL（`git clone --depth 1`）；重复跑就是升级，`~/.nyra` 数据不动；`--uninstall` 删安装目录、启动器与服务文件，但保留 `~/.nyra`。
- `--with-systemd`：把 `systemd/nyra-scheduler.service` 装到 `~/.config/systemd/user/`，按本次安装替换 `WorkingDirectory` 与 `ExecStart` 的 python 路径，再 `daemon-reload` + `enable --now`；没有用户 systemd 总线时只装文件并警告，不报错。
- 安装脚本拒绝危险输入：python3 < 3.10、来源不存在、`--prefix` 为 `/`、`$HOME` 或含空格时报错退出；不装任何 pip 依赖、不联网（除 `git clone` 一步）、不用 sudo。
- 新增 `docs/linux-install.md`：安装三种方式、选项表、升级、卸载、排错、安全说明；`docs/linux-systemd.md` 前置条件与 README 快速开始加指向安装脚本的说明；README 测试徽标 518 → 562。
- 新增 `tests/test_install_script.py`（13 项）：`bash -n` 语法检查、`--help`、临时 HOME 真实安装（启动器在无关 cwd 下跑出 `Nyra 0.3.0`、`~/.nyra` 0700、默认不装服务）、重复安装幂等、`--with-systemd` 的 unit 路径替换与 systemctl 调用记录、`--uninstall` 删安装留数据、桩 python3 3.9 拒绝、来源不存在与危险 `--prefix` 拒绝；执行类测试只在 POSIX + bash 环境跑（安装脚本本身是 Linux 专用的）。
- 测试 549 → 562 项，全部通过。
- 本轮只做安装脚本；打包（.deb / 归档分发）仍未做；网页界面（`nyra ui`）的服务未做。

## 未发布（systemd 用户服务：调度器 daemon）

- 新增 `systemd/nyra-scheduler.service`：systemd `--user` 单元，`Type=simple`，跑 `python3 -m nyra schedule daemon`；`WorkingDirectory=%h/nyra`（默认检出位置 `~/nyra`，可改）、`Restart=on-failure`，加固 `NoNewPrivileges=true`、`PrivateTmp=true`、`ProtectSystem=true`；不需要 root、不写系统目录、不含密钥（Key 按文档用 drop-in 的 `Environment=` 补）。
- 新增 `docs/linux-systemd.md`：安装、启动、`enable --now`、状态/日志查看、`loginctl enable-linger` 开机自启、改检查间隔、卸载、排错；README 快速开始处加一行指向该文档。
- 新增 `tests/test_systemd_unit.py`（9 项）：解析 unit 断言关键字段、ExecStart 可执行文件真实存在且指向调度器 daemon、临时 HOME 空 schedule 下 daemon 短超时冒烟（`--interval 0.1 --rounds 1`，无任务、无模型调用）、`systemd-analyze verify` 通过。
- 测试 540 → 549 项，全部通过；`systemd-analyze verify` 退出 0（本机无用户 systemd 总线，`systemd-analyze security` 跑不起来，改为人工复核：见上）。
- 本轮只做调度器服务；网页界面（`nyra ui`）的服务、安装脚本与打包未做；调度器仍是 naive 本地时间（见 VERIFICATION.md 已知限制）。

## 未发布（官网重做 + 安装面板）

- 官网 `docs/` 重做：新增常见问题、服务条款、隐私政策、可接受使用政策四个页面；首页加入可翻转的功能卡片、滚动显现、交互式审批示意和终端示意，遵守系统的减少动态效果设置，关闭 JavaScript 时内容仍完整可见。
- 新增安装面板：点击“安装”从右侧滑出，按 macOS / Linux / Windows（PowerShell）给出五步命令，每条命令可一键复制，带进度指示；无 JavaScript 时跳到首页的安装区块。
- 首页、FAQ 与安装面板支持 10 种语言；法律页提供中文与英文。
- 修复 Windows CI：进程组超时测试只在支持 `os.killpg` 的系统上运行。

## 未发布（worker 协议 + Python worker 入口，混合 Go 迁移第 1 批）

- 新增 `nyra/worker_protocol.py`：协议 v1（`PROTOCOL_VERSION = 1`），子进程 + stdio JSONL；请求 `run` / `approval_decision` / `stop` / `ping`，事件 `run_started` / `run_completed` / `run_incomplete` / `run_failed` / `tool_start` / `tool_result` / `assistant` / `final` / `usage` / `approval_request` / `approval_result` / `model_switch` / `turn_limit` / `pong` / `error`；`APPROVAL_TIMEOUT = 600.0`（与 webui 一致）；`new_id`、`encode_line`、`decode_line`、`ensure_request_id`、`validate_run_request`、`validate_approval_decision`。
- 新增 `nyra/worker.py`：`WorkerEmitter` 线程安全 stdout JSONL、`WorkerIO` 读线程 + 队列、reader 线程内直接回 `pong`、`Worker` 含 `approve_fn` / `on_agent_event` / `run_request` / `serve`、`build_agent` 用 `build_provider_chain` 传单元素链、永不兜底；`main()` 用 argparse；Agent 以 `interactive=True` 构造，审批才能到达 `approve_fn`。
- 新增 `tests/test_worker_protocol.py`（22 项，见 DESIGN.md 的 Worker 协议一节）；端到端冒烟：真实子进程 + 真实管道 + 本地桩 HTTP 模型，`run_completed` 输出 `smoke-ok`，usage total 13，零付费调用。
- 入口为模块形式 `python3 -m nyra.worker`（设计文档的空格形式 `python3 -m nyra worker` 须改 `nyra/__main__.py` 或 `nyra/cli.py`，第 1 批只新增文件、不改现有入口与冻结文件；行为一致，空格形式等冻结解除后补，协议不变）。
- 审批决定权永远在 Python 的 `tools.py`：worker 的 `approve_fn` 只传话；审批超时、无匹配的决定、协议异常、stdin 关闭一律按拒绝处理。worker 不进兜底链、不进定时任务。
- 测试 518 → 540 项，全部通过。

## 未发布（统一更名 Nyra + 官网新设计）

- 全面使用 Nyra 名称：包目录 `nyra/`，命令 `python3 -m nyra`（子命令 `nyra schedule` / `nyra ui` / `nyra permissions` / `nyra eigenflux`），交互提示符 `nyra[auto] ›`，网页界面与文档同步。
- 数据目录改为 `~/.nyra`；已有旧数据目录时继续沿用，不丢数据。项目级命令目录改为 `<工作目录>/.nyra/commands/`（旧目录仍可读取）。
- 环境变量改为 `NYRA_*`（`NYRA_API_KEY`、`NYRA_BASE_URL`、`NYRA_MODEL`、`NYRA_FALLBACK`、`NYRA_SANDBOX` 等），旧前缀仍作为兜底读取。
- README 重写为简明首页，完整说明移到 `GUIDE.md`。
- 官网 `docs/` 换成新设计：黑白极简、深色自适应、移动端适配，右上角 10 种语言切换；新标志为实心圆里刻出的光标（`docs/assets/nyra-mark.svg`）。开场动画只用于手机端，网页与官网不播放。
- 测试 518 项全部通过。

## 未发布（Codex CLI provider，不用 API Key）

- 新增 `codex` provider 预设（`config.py`）：`base_url` 为 `cli://codex` 标记（无 HTTP 端点）、`auth` 为 `"cli"`、`env_key` 为空、默认模型 `codex-default`。`resolve_provider` 在模型解析后加 CLI 分支：auth 为 CLI 时跳过 base_url 的 http/https 校验与明文检查，直接返回 `ProviderConfig(auth="cli", api_key=None)`；`resolve_fallback_chain` 加两条 CLI 排除（主 provider 是 CLI 时只返回 `[primary]`；链里出现 CLI 名字时跳过并记日志）。
- 新增 `CliProvider`（`providers.py`，`Provider` 子类）：用子进程跑本机 `codex` CLI（`codex exec` 非交互方式），复用它自己的登录态与 ChatGPT 订阅，不调模型 API。固定 argv：`codex exec --json -o <临时文件> -s read-only -C <空临时工作目录> --ephemeral --skip-git-repo-check -c features.browser_use=false -c features.computer_use=false -c features.plugins=false`（默认模型时不加 `-m`）；prompt 走 stdin（不在 argv 里，`ps` 看不到）；成功时优先读 `-o` 文件，文件为空时回退解析 `--json` 的 JSONL 事件流；用量能解析到就附进返回的 `"usage"`；超时由 Nyra 的 subprocess 侧强制并杀掉整个进程组（`codex exec` 没有 `--timeout` 参数）。
- 固定提示前缀（缓存命中）：`CODEX_PROMPT_PREFIX` 是字节级固定的英文前缀，拼在每次请求的最开头，再接按 `[role]` 标记序列化的消息；前缀内容是身份与边界声明（只作文字模型，不调工具、不跑命令、不浏览网页、不改文件，只回文字）。因为它在每个请求里一字不变、又始终在最前面，提供商侧的提示缓存能直接命中这段公共前缀。工具 schema 绝不传入。
- 默认模型 `codex-default` 的含义是不传 `-m`，让 CLI 用自己的默认模型。实测：ChatGPT 订阅登录时 `-m gpt-5` 与 `-m gpt-5-codex` 都会被服务端以 `model_not_found` 拒绝，唯有不传 `-m` 能跑通；显式 `--model` 会原样传 `-m`，被服务端拒绝时按配置错误分类（`_classify_codex_error` 新增 `model_not_found` / “model is not supported” → `"config"`），不兜底、不重试。
- 四个安全条件（代码强制 + 测试覆盖 + README 写明）：① CLI 只用固定路径调用（固定已知位置优先，`shutil.which` 只是最后兜底，绝不从配置、环境变量或用户输入取路径）；② 不读取、不复制、不记录登录凭证（登录检查只跑 `codex login status`，只读退出码与 “Logged in” 标记——实测该标记走 stderr；子进程环境删掉全部 `*_API_KEY` 变量）；③ 不用跳过审批的参数（`--dangerously-bypass-approvals-and-sandbox`、`--approve-for-me`、`--dangerously-bypass-hook-trust`、`-y`、`--full-auto` 均禁用，argv 建好后自检；始终 `-s read-only` + 空临时工作目录，用后删除）；④ 不进兜底链（只能被显式选中；`Provider` 的直接构造在 auth 为 CLI 时直接拒绝，全仓库唯一的直接构造点正是定时任务的 `_make_task_agent`，所以定时任务与队列里绝不用）。
- `build_provider_chain` 新增 `cli_provider_cls` 关键字参数（默认 `CliProvider`）：主 provider 是 CLI 时直接返回该类的实例，不进任何链；链内条目 auth 为 CLI 时跳过并记日志。`cli.py`、`groups.py`、`json_mode.py`、`webui.py` 的调用点均未改（默认值即够用），`--provider codex` 与 `POST /api/provider` 选中 codex 时走正常校验。
- 本机核查：`codex` 在 `/opt/hatch-image/bin/codex`（`codex-cli 0.164.0-alpha.9`），`codex login status` 为 `Logged in using ChatGPT`；版本低于 0.164.0、未登录或无法解析版本时直接拒绝。`claude` 本机未装，本轮不做，须先在用户电脑（Windows）上核查 `claude --version` 与登录情况再接。
- 新增 35 个测试（`tests/test_cli_providers.py`）：固定路径解析、版本与登录检查（含登录标记走 stderr）、固定前缀、chat 成功与 OpenAI 形状、argv 固定只读且无禁用参数、prompt 走 stdin、空临时工作目录、tools 被忽略、子进程环境不含 `*_API_KEY`、不打开凭据文件、JSONL 回退与用量、空输出与非零退出分类（含 `model_not_found` → config）、超时杀进程组、兜底排除（codex 作主时链只有自身、不当兜底目标、直接构造被拒、定时任务 `_make_task_agent` 用 codex 被拒）、预设解析。另更新 `tests/test_generic_providers.py`（CLI 预设豁免 http base_url 断言）与 `tests/test_webui.py`（`/api/info` 的 provider 数 13 → 14，自定义 provider 场景 14 → 15）；`nyra/group-ui.js` 的兜底 provider 列表补 codex；README、DESIGN.md、`docs/index.html`、`webui_page.py` 的 provider 预设数 13 → 14。测试总数 483 → 518，全部通过；本地冒烟检查通过（`--list-providers` 见 codex、真实短调用一次回 `smoke-ok` 且 usage 有记录、Web UI 页面 200 且 `/api/info` 的 provider_count 为 14）。

## 未发布（后台任务队列）

- 新增 `nyra task add|list|show|cancel|worker|approve`：任务入队后由 worker 顺序执行，文件锁保证同时只有一个 worker。遇到需要审批的操作立即停下并标为 `awaiting_approval`，绝不自动放行；前台 `task approve` 走续跑逻辑并重新审批。完成通知写入 `~/.nyra/inbox.jsonl`，REPL 启动和 `/status` 显示未读。定时任务到期改为入队，不再当场执行。
- 定时任务（`schedule add|run|daemon` 与调度路径）与队列一样拒绝 `full` 模式，只允许 `readonly` 或 `auto`；`schedule add` 默认改为 `auto`。已有 `full` 任务在加载或到期入队时会被拒绝，不会在无人值守时自动放行。
- worker 不会自动信任工作目录 `AGENTS.md` 里的 `verify:`。未加 `--trust-agents-verify` 或显式 `--verify` 时不冻结该命令，任务结束后为 `completed_unverified` 并写明原因。

## 未发布（结果自证）

- 新增 `--verify`：建任务时把验证命令冻结进运行记录，之后改 AGENTS.md 或配置都不再生效。只有命令真实退出码 0 才是 `verified`；失败把输出以不可信的 tool 消息交回模型，最多重试 2 次，仍失败则为 `verify_failed`（`--json` 退出码 4）。未配置验证时状态为 `completed_unverified`，报告写明「未验证」。测试文件被改过会单独标出。
- 验证失败输出写入 `<untrusted_data>` 前，会转义正文里的开关标签（大小写不敏感），防止伪造结束标记跳出包裹。
- 来自工作目录 `AGENTS.md` 的 `verify:` 视为外部内容：任意模式（含 `--mode full`）都要先确认一次再冻结。未确认或非交互（如 `--json`）未加 `--trust-agents-verify` 时不执行该命令，状态为 `completed_unverified` 并写明原因。命令行 `--verify` 和用户配置 `verify_command` 不需要这步确认。续跑只用已确认并冻结的命令，不再读取 `AGENTS.md`。
- `state.verify_cmd` 保存未脱敏的原命令，保证续跑执行的是真实命令；报告、日志和事件里才打码。运行目录与状态文件仍是 `0700` / `0600`。

## 未发布（断点续跑）

- 新增 `--resume-run`，普通单次与 JSON 模式沿用原运行、会话、目录和权限模式；未知工具结果先落盘提示，不自动重试，审批重新确认，轮次与改动记录连续累计。

## 未发布（运行记录）

- 单次 CLI 与 JSON 模式保存私有运行日志：原子状态、精简事件、真实审批和中断状态、检查点文件列表；敏感文本脱敏，JSON 新增运行 ID 与最终状态事件。

## 未发布（会话原子写）

- 会话通过同目录临时文件、flush/fsync 与原子替换保存，失败保留旧会话并清理临时文件；新增会话目录和文件使用私有权限，并校验会话 ID 防止路径越界。
- 工具调用执行前及每个工具结果追加后立即保存会话，工具中断时保留完整调用与已有结果；新增原子写、中断、权限和非法 ID 回归测试。

## 未发布（兜底默认关闭 + 网页切换可见 + 网页端新建定时任务暂缓）

- **模型自动兜底改默认关闭**（用户 2026-11-17 安全事项第 1 条）：`config.py` 的 `DEFAULT_CONFIG["fallback_enabled"]` 与 `resolve_fallback_chain` 的默认值由 True 改 False；开启只由用户自己做——`~/.nyra/config.json` 里设 `"fallback_enabled": true`、环境变量 `NYRA_FALLBACK=1`，或 CLI 新增 `--fallback`（`--no-fallback` 保留作显式关闭；两者同时给时以关闭为准，`cli.py` 新增 `_fallback_enabled()` 统一优先级，`json_mode.py` 同样处理）。网页端设置里没有兜底开关控件（只有一行状态说明），不存在默认开启或静默开启的路径。
- **兜底链只认允许列表**：允许列表就是用户配置的 `fallback_providers`；`resolve_fallback_chain` 只在 key 缺失时才用内置默认链，显式写空列表表示不允许任何备用（不再静默补默认链）；未知名字跳过并写 stderr 日志；`build_provider_chain` 跳过未配置 Key 的备用（同样记日志），不静默补别的。`POST /api/provider` 的 `resolve_provider` 校验不变。
- **网页端切换可见**：`webui.py` 的 `UIState` 新增 `_on_switch` 回调——切换时除写服务端日志外，还向当前运行中的会话追加一条 `model_switch` 事件（from/to/error/kind/status，复用 `--json` 的事件结构）；前端 `applyEvent` 渲染一行“模型已切换：deepseek → xai（402 …）”并刷新模型卡。群聊同样：`groups.py` 的 `_bot_response` 记录本次调用的 `switches`，`send()` 附加到机器人回复条目上（`model_switches` 字段），`group-ui.js` 在回复下方渲染切换提示；无切换时不附加字段。
- **队列与定时任务不切换**（只读核查，未改 `scheduler.py`）：`cli.py` 的 `_make_task_agent` 仍直接构造单个 `Provider`，定时任务执行时用任务指定的 provider/model 原样跑、不包兜底链；`/api/schedule` 存下来的 provider/model 执行时同样不兜底。`runs.py` 在 main 上不存在，未新建。
- **网页端新建定时任务暂缓开放**（用户安全事项第 2 条，E 合并前）：定时任务视图的添加表单已彻底撤下（不是置灰），换成一行说明“网页端新建定时任务暂缓开放，等任务队列合并（E）后恢复；请用 `nyra schedule add` 命令添加”；后端 `POST /api/schedule` 的 action=add 返回 409 并写明原因（现在 main 上的任务默认用 full 模式，E 合并后会拒绝这种情况）。列表、开关、删除保持可用。
- 新增 11 个测试：`tests/test_fallback.py`（默认关闭、配置显式开启、空允许列表只留主模型、环境变量开启、链里无 Key 的备用被跳过、CLI `--fallback`/`--no-fallback` 优先级、定时任务 agent 用单个 provider）、`tests/test_json_mode.py`（`--fallback` 开启切换、默认关闭不切换）、`tests/test_webui.py`（默认关闭不切换、会话轮询里出现 `model_switch` 事件、add 返回 409 且其余操作可用、表单已撤下）、`tests/test_group_chat.py`（机器人回复条目带 `model_switches`）。测试总数 472 → 483，全部通过；本地 Web UI 冒烟检查通过（见下）。

## 未发布（调度器健壮性）

- `save_schedule` 改为原子写（同目录临时文件 + fsync + `os.replace`），崩溃或并发写入不再留下半截 JSON；失败时清理临时文件、旧文件保持不变。
- `load_schedule` 遇到损坏（非 JSON / 编码错误 / 顶层不是对象）时，先把原文件备份为 `schedule.json.corrupt-<时间戳>` 再报错，避免下次保存覆盖丢失。
- 新增 4 个测试（`tests/test_scheduler_robust.py`）。测试总数 468 → 472，unittest 与 smoke 均通过。

## 未发布（网页界面 UI v2 面板补完）

- 设置视图的 provider 下拉真正可用（此前是 `disabled` 占位）：新增 `POST /api/provider {provider, model?}`（`webui.py` 的 `UIState.set_provider`，用 `resolve_provider` 校验，未知 provider / 明文 http 外网地址直接报 400，不触发兜底），前端启用下拉 + 模型输入（datalist 用该 provider 的 `models`，允许自定义填）+“应用”按钮 + 状态提示。切换只改运行状态：重置缓存的 provider 链，新会话用新 provider，已有会话保持原 provider，不写配置文件，重启后恢复配置。设置副标题“只读视图”改为准确描述。
- `/api/info` 的 provider 列表每项增加 `models` 字段；新增 `fallback_chain` 字段（当前链的 provider 名，主模型排第一；单 provider 时为 `[name]`），模型卡加一行“兜底链：deepseek → xai → ollama”。Keys 表改用 `get_provider_presets`（失败回退内置），自定义 provider 不再被藏起来。
- 群聊“打开”直达具体群：主站群聊视图的链接带 `?room=<id>`，`group-ui.js` 启动时读 `room` 参数并选中该群（不存在回退第一个）。
- 定时任务行补上“上次运行：<时间>”与摘要（截断 80 字），API 早已返回 `last_run` / `last_status` / `last_summary`，此前行里只显示了 `last_status`。添加表单补 provider / model 两个可选字段（provider 下拉取 `/api/info`，不填则用当前 provider；POST 时只在填了才带），“执行时间”输入框按“每天 / 每隔一段时间”切换 placeholder（`08:30` / `分钟数，如 30`）。
- 顶栏模式下拉与模式分段切换失败时不再错位显示：`api` 失败后调 `loadInfo()` 回滚到实际值。
- 仍缺后端、如实留空（未编造数据）：守护进程运行状态（`scheduler.py` 无 pidfile/状态机制，且按分工归 GrokBot，面板上已写“执行仍需 daemon 在运行”）；费用看板（usage 只统计 token 数，无任何成本统计接口）。
- 新增 7 个测试（`tests/test_webui.py`）：`/api/provider` 切换与拒绝、切换后链重排（新主模型排第一）、`models` / `fallback_chain` / 自定义 provider 进 Keys 表、设置与定时任务表单控件存在且 provider 下拉未禁用、群聊 JS 读 `room` 参数、定时任务添加带 provider/model。测试总数 461 → 468，全部通过；本地 Web UI 冒烟检查通过（页面 200、六视图齐全、`/api/info` 13 预设 / 15 工具 / 兜底链如实、`/api/provider` 切换后 info() 显示新 provider 与重排后的链、`/api/schedule` 添加带 provider 正常、群聊页 200、内联与群聊 JS 均过 `node --check`、无外部资源、暗色 CSS 存在，未真实调用模型）。

## 未发布（网页界面 UI v2）

- 网页界面按原型「Nyra UI v2」重做：新配色（浅色底 `#F3F5F4`、鼠尾草绿主色 `#5F7D5C`、雾蓝强调 `#6B8CAE`、蜜桃珊瑚 `#E07856` 只小面积点缀，另补一套深炭底 `#1F2420` 暗色变体——原型没有暗色模式），旧墨 `#111A42` / 金 `#EAC45F` / 暖纸白 `#FAF8F4` 已退役；三栏布局（268px 左侧栏 / 自适应主聊天区 / 324px 右侧检查器，52px 顶栏），六视图（对话、技能与工具、定时任务、群聊、品牌与外观、设置）。
- 形象改为毛绒动物：默认奶油白毛绒小兔（`assets/nyra-plush-bunny.png`），备选蜜糖色毛绒小熊，品牌视图可切换（localStorage 记忆）；形象图缩小到 512px 后以 base64 内嵌进 `webui_page.py` 与 `group_ui.html`，保持“无外部资源”、新克隆也能显示，`assets/` 不进 git。旧二次元少女形象 `nyra-character.png` 不删、不覆盖，已在品牌视图标为弃用。顺带修了一个注入 bug：形象 data URI 原先未加引号注入 JS 的 `IMG` 表，导致整段内联脚本语法错误，页面 JS 全灭；现已加引号并用 `node --check` 验过。
- 新增三个视图（单页内切换）：技能与工具（3 个技能 + 15 个工具一览，标明是否需要审批）、定时任务（列表 + 开关 + 添加表单）、品牌与外观（11 色板、形象切换、字体示例、使用规则）；设置由只读对话框升级为完整视图（provider 预设列表、模式三段切换调真实 `/api/mode`）；群聊视图列出群聊并链接到独立的 `/groups` 页。
- `webui.py`：`/api/info` 扩展返回 13 个 provider 预设列表、15 个工具（每个含 `needs_approval`）、技能列表、`tool_count` 15 / `provider_count` 13；新增 `/api/schedule`（GET 列表；POST `add`/`toggle`/`remove`，只调 `scheduler.py` 的公开函数，不改 `scheduler.py`）；`FORBIDDEN_PAGE` 换新色板。`group-ui.js` 的 provider 下拉改为从 `/api/info` 取，失败时回退到完整的 13 个硬编码列表。
- `docs/index.html` 首页数字修正：14 个内置工具 → 15 个，6 个 provider 预设 → 13 个。
- 新增 5 个测试（`tests/test_webui.py` 的 `UIv2Tests`）：`/api/info` 的 provider/tools/skills 列表与审批标志、新色板与内嵌形象（旧色只许出现在品牌视图的“已退役”文案里，不许出现在 CSS 中）、`/api/schedule` 的增删开关、群聊页换肤与 provider 列表。测试总数 456 → 461，全部通过；本地 Web UI 冒烟检查通过（页面 200、`/api/info` 13 预设 / 15 工具、`/api/schedule` 200、群聊页 200 且无外部资源、内联与群聊 JS 均过 `node --check`，未真实调用模型）。

## 未发布（自定义 provider 明文 http 防护）

- 自定义 provider 的 `http://` 只允许本机地址（`localhost`、`127.0.0.1`、`::1`，比如本机 Ollama）；`http://` 配外网地址时直接拒绝，报错写清“API Key 会随请求明文传输，请改用 https://”。外网地址必须用 `https://`。
- 校验做两道：① `nyra/config.py` 的 `plaintext_http_error`，自定义 provider 解析（`custom_providers`）与环境变量方式（`NYRA_BASE_URL`）都在解析时校验，`resolve_provider` 同样校验（覆盖全部 13 个内置预设）；② `nyra/providers.py` 的 `Provider.chat()` / `list_models()` 发请求前再校验一次，防止绕过配置解析直接构造 provider 时仍把 Key 发往明文外网。两处报错文本一致；发请求前的拒绝是 `ProviderError(kind="config")`，不触发兜底切换、不静默降级。
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
- 新增配置项 `custom_providers`：`~/.nyra/config.json` 里可自定义任意 OpenAI 兼容接口（`base_url` + `default_model` 必填，`env_key`/`models`/`allowed_hosts` 可选，未知字段忽略；同名覆盖内置预设；缺 `base_url`/`default_model` 或协议不是 http/https 时解析直接报错并点名）。自定义名字可进 fallback 链；`resolve_provider` 会校验 base_url 协议。
- `Provider` 需要 Key 但环境变量没设时不再静默走无认证请求：`resolve_provider` 保持 `auth="env"` 且 Key 为空，`has_credentials()` 为 False（CLI 会显示配置提示），`chat()`/`list_models()` 直接报“未设置 API Key”的配置错误。无 Key 需求的 provider（如本地 Ollama）不受影响。
- 新增 `Provider.list_models()`（`GET {base_url}/models`，OpenAI 形状，`FallbackProvider` 同样支持）：401/403 不兜底，402/429/5xx/超时/网络错误沿用上一轮的错误分类；无 `data` 列表或条目无字符串 `id` 时为解析错误。CLI 新增 `--list-providers`（列出全部 provider 与默认模型）与 `--list-models`（列出当前 provider 的实时模型 id）。
- `providers.py` 内部整理：认证头逻辑抽为 `_apply_auth`，HTTP 状态到错误种类的映射抽为 `_kind_for_status` / `_http_error`，`chat()` 的报错文本与行为不变。
- 新增 `tests/test_generic_providers.py`（29 个）：预设 endpoint/默认模型核实、自定义解析与容错、fallback 链含自定义名字、`list_models` 的 mock opener 映射、CLI 两个 flag。测试总数 407 → 436，全部通过。

## 未发布（模型自动兜底）

- 新增 `nyra/providers.py` 的 `FallbackProvider`：与 `Provider` 同样的 `chat()` 接口，按链逐个试模型；主模型遇可恢复失败（402 余额不足、429 限流、5xx、超时、网络错误）时自动切换到下一个并重试一次，每次切换记录到 `switches` 并经 `on_switch` 回调通知；认证失败（401/403）与配置问题（没设 Key、响应无法解析等）直接抛出，不兜底；全部模型都失败时报错列出每个模型的失败原因。每次调用都从主模型开始试。
- `ProviderError` 增加结构化分类：`status`（HTTP 状态码）与 `kind`（auth/quota/rate_limit/server/client/timeout/network/config/parse/redirect/unknown），`recoverable` 属性只对 quota/rate_limit/server/timeout/network 为真；原有只传一句话的调用方式不变，消息文本不变。
- 新增 `nyra/config.py` 的 `resolve_fallback_chain` 与配置项 `fallback_enabled`（默认 true）、`fallback_providers`（默认 `["deepseek", "xai", "ollama"]`）；开关优先级：`--no-fallback` > `NYRA_FALLBACK` 环境变量 > 配置 > 默认开启；链顺序：`NYRA_FALLBACK_PROVIDERS` 环境变量 > 配置 > 默认链，主模型始终排第一，未知名字跳过。
- CLI 接入命令行入口（交互 REPL、一次性任务、`--plan`）：`--no-fallback` 关闭单次兜底；切换提示打印到 stderr，一次性任务的 stdout 仍只有答案。`--json` 单次模式、网页界面、群聊和定时任务仍用单个 provider，后续再接。
- 新增 `tests/test_fallback.py`（31 个）：错误分类、402 切备用成功、401/403 不切换、429/超时/5xx/网络错误切换、全部失败报错明确、每次调用从主模型重新开始、链顺序与配置/环境变量读取、真实 `Provider.chat` 的 HTTP/超时/网络错误映射（mock opener）、Agent 循环经 FallbackProvider 拿到备用模型答复。测试总数 376 → 407，全部通过。
- 真实端到端验证（一次 DeepSeek flash 短调用）：`--provider ollama`（本地未跑 Ollama）→ 网络错误 → 切换提示打印到 stderr → DeepSeek 返回答案；`--no-fallback` 下同样场景直接报错退出，无切换。

## 未发布（/init 与自定义命令）

- 新增 `nyra/commands.py`：自定义斜杠命令以 Markdown 文件存放在项目级 `<工作目录>/.nyra/commands/` 或用户级 `~/.nyra/commands/`，文件名即命令名，同名时项目级优先；支持 `description` / `argument-hint` frontmatter，`$ARGUMENTS` 与 `$1`..`$9` 占位符，无占位符时参数追加到正文末尾。
- REPL 新增 `/commands`（列出可用自定义命令及来源）与 `/init`（生成 `AGENTS.md` 起始模板，已存在不覆盖；写入走 `write_file`，过审批、边界与检查点，readonly 下拒绝）；内置命令优先于同名自定义命令，符号链接命令文件会被跳过。
- 新增 `tests/test_commands.py`（19 个）：解析、加载优先级、占位符渲染、模板内容、`/init` 的读写路径与 readonly 拒绝。测试总数 356 → 376（含同步远程新增的 1 个 net scheme 测试），全部通过。
- 附带修正 README/DESIGN：工具数 14 → 15（补上漏记的 `apply_patch`），测试数 247 → 376。

## 未发布（网络请求协议限制）

- `net.open_url` 只允许 http/https，`web_fetch` 等不再能通过 `file://`、`ftp://` 读取本地文件；新增 tests/test_net_scheme.py。

## 未发布（EigenFlux 逐机器人网络权限上限）

- 新增 `nyra eigenflux policy show|allow|deny|audit`，为每个主/群聊 Agent 显式记录固定网络行为的本地意向；默认拒绝，allow 需要 `--confirm`，deny 即时本地撤销，带 SHA-256 并发检查与有界审计。
- 新建群聊获得随机稳定 `instance_id`，删除同名群后重新创建不会继承旧群的 EigenFlux Home/网络行为许可；老群保持旧路径兼容。
- 策略不会安装、登录、广播或启用调度，所有 `effective_network_permission` 保持 false；后续网络执行层仍需遵守 EigenFlux 官方 onboarding 和用户授权。
- 新增身份隔离、撤销、并发冲突、损坏文件/符号链接、CLI 不创建模型/CLI 进程与群聊重建安全的回归测试。

## 未发布（EigenFlux bare-CLI 本地接入准备）

- 新增 `nyra eigenflux doctor [--room ID --bot ID] [--check]`。默认不执行命令、不安装，也不发起网络行动；只计算独立、稳定的 EigenFlux Home 和准备状态。
- 可选 `--check` 对 PATH 中已安装的 CLI 运行 `version` 与 `skills path --host terminal` 两条诊断，最小环境变量、固定参数与超时；绝不在检测期间执行 onboarding、广播、注册或创建定时任务。
- 主 Agent 与各群聊机器人共享 Nyra 项目代码，但拥有互相隔离的 EigenFlux 身份根目录。非法群 ID、非成员 bot、已有符号链接目录会拒绝。
- 新增纯模拟 CLI、凭据环境白名单、路径隔离与零副作用测试。该阶段不能宣称已加入 EigenFlux 网络。

## 未发布（Poppy OAuth issuer 双向元数据核验）

- 新增 `python -m nyra --inspect-poppy-identity SITE`：不需模型凭证，只读核验公司域名的 OAuth protected resource metadata 与发行方 OAuth server metadata 双向绑定，拒绝缺少精确 resource、错配发行方和不合规 metadata。
- `--poppy` 下新增只读 `poppy_identity_check`；发行方验证通过依旧报告 `remote_calls_allowed=false`、`session_ready=false` 和 `oauth_ready=false`，不启动登录、不发送凭证、不调用远端工具。
- 区分合法 404/无 issuer 与服务器错误和网络超时；元数据禁止重定向，继续保持固定公网 IP/TLS 校验及响应大小限制。
- 新增 RFC 8414 issuer path、多 issuer 选择、资源回指、缺少端点、非 HTTPS、授权未完成以及 CLI 机器输出回归测试。

## 未发布（Poppy 站点/身份/scope 授权意向账本）

- 新增默认拒绝的本地 Poppy 授权意向账本，按精确 HTTPS 主机、访客/本地账户别名与单个 scope 隔离，禁止通配授权。`nyra permissions list|check|grant|revoke|audit` 无需模型凭证或网络；用户明确 `grant --confirm` 才会持久化。撤销和有界审计历史随账本原子更新。
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

- 新增测试 `tests/test_memory_skill_tools.py`（11 个）：`memory_append` 与 `save_skill` 首次有了直接的单元测试（此前只有群聊测试顺带调过一次 `memory_append`，`save_skill` 完全没有覆盖）。覆盖写入/多行折叠/空文本不写、readonly 与 auto 非交互拦截、技能文件可解析回读、非法技能名拒绝、覆盖重写；测试全程只写临时目录，不碰真实 `~/.nyra/MEMORY.md`。
- 附带修正 README：版本号标题仍写 0.2.0、测试数仍写 127，已同步为 0.3.0 / 175。测试总数 164 → 175，全部通过。

## 未发布（Token 用量与上下文状态）

- 新增模型 API 响应 usage 统计，分别累计输入、输出、总 Token 和未报告用量的调用；不使用字符数冒充精确用量。
- CLI 新增 `/status` 和可选 `--context-window`，单次任务结束后将用量报告写入 stderr，保持 stdout 为任务结果。
- Web UI 为每个会话展示模型调用、已报告的 Token、参考上下文余量，未知数据明确标记；配置支持可选的 `context_window_tokens`。
- 新增 usage、CLI、Web UI 回归测试；功能队列记录在 ROADMAP.md。


## 未发布（独立机器人群聊与委派配额）

- 新增 `nyra/groups.py` 多机器人群聊核心：每位机器人拥有自己的身份指令、模型选择、独立会话、记忆与工作目录；群消息可 @ 定向分配任务，多成员讨论有轮次上限和持久化记录。
- 网页界面使用独立的 `nyra/group-ui.html` 与 `nyra/group-ui.js`（HTML/CSS/JavaScript）实现群聊交互；在现有 Web UI 添加群聊入口与令牌保护的群聊 API。
- Agent `delegate` 增加共享子 Agent 数量预算、最大递归深度与子任务轮数检查，避免模型无限嵌套调用；子 Agent 继承所属机器人的独立角色与记忆。
- 对群聊创建、@mention、模型/会话隔离、长期记忆、访问鉴权、嵌套委派边界添加 mock 回归测试，无需真实模型密钥。
- 当前默认 readonly、串行讨论；尚未实现并行自主执行/群成员动态管理/完整操作系统沙箱。


## 未发布（MCP 启动权限与 Web UI 生命周期）

- MCP 服务器进程启动遵循审批模式：readonly 和无人值守 auto 不启动；终端交互 auto 逐项请求同意；full 可直接启动。
- 终端 `/mode` 和 Web UI 模式切换同时管理 MCP 子进程生命周期，防止权限降级后服务继续运行；Web UI 拒绝在任务进行中切换模式。
- 新增模拟真实 MCP stdio 子进程及 Windows CP1252 控制台的启动回归测试、Web UI 模式切换测试；仍需可信 CI 才能合并。


## 未发布（网页界面、终端打磨、项目官网）

- 新增本地网页界面 `python3 -m nyra ui`（`nyra/webui.py` + 内嵌单页 `nyra/webui_page.py`）：纯标准库 `http.server`，无 CDN。左栏会话列表（读现有会话存储，可新建/恢复），中栏对话 + 可折叠工具调用卡片（auto 模式下卡片内批准/拒绝），右栏 provider/模型、证据来源链接、plan 步骤；设置面板只显示 Key 是否已配置，从不回显值。
- 网页界面安全：默认只监听 `127.0.0.1`，绑定非本机地址时打印警告；每次启动随机生成访问 token（页面经 `?token=` 带入，API 必须用 `X-Nyra-Token` 请求头），本机监听时校验 `Host` 头，不回应跨域预检，页面带 CSP。
- `Agent` 新增可选 `on_event` 观察回调（工具开始/结果、助手消息），`ToolContext` 新增可选 `approve_fn`，让网页界面复用同一个审批门；不传时行为与之前完全一致，子 agent 继承同一审批回调。
- 终端 REPL 打磨：启动横幅、`nyra[模式] ›` 提示符、工具调用分组显示（`┌ 工具 参数` / `└ ✓/✗ 结果`）、`/help` 对齐排版；颜色尊重 `NO_COLOR`、`TERM=dumb` 与非 TTY；一次性任务输出不变。
- 新增项目官网 `docs/`（GitHub Pages，纯静态、中英双语、暗色模式、无外部资源），地址 https://js2005happy.github.io/nyra/ 。
- 新增测试 `tests/test_webui.py`（23 个，mock provider + 随机端口）、`tests/test_repl_ui.py`（12 个）、`tests/test_docs_site.py`（5 个）；`unittest discover` 共 127 个通过。

## 未发布（MCP 环境变量最小权限）

- MCP 子进程默认只继承启动所需的基础环境变量，不再复制宿主进程全部环境变量，避免自动暴露 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 等无关凭证。
- MCP 配置新增可选的 `inherit_env`（精确变量名列表），与现有 `env` 合并；`env` 显式值覆盖继承值。非法变量名和非列表配置被拒绝。
- 新增跨平台模拟及真实 Python MCP 子进程的环境隔离回归测试；MCP 可执行程序仍以本机用户身份运行，此改动不是进程沙箱。

## 未发布（本机请求绕过代理）

- 修复：设置了 `HTTP_PROXY` / `HTTPS_PROXY` 但没设 `NO_PROXY` 时，发往本机（`localhost`、`127.0.0.0/8`、`::1`）的请求也被转发到代理，导致本地 Ollama provider、`web_fetch` / `http_post` 访问本机服务失败（代理返回 404/502），两个 mock 测试也因此在代理环境里失败。
- 新增 `nyra/net.py`：本机地址的请求一律直连，其余地址照常遵守环境代理设置；provider 客户端、`web_fetch`、`web_search`、`http_post` 统一走它。
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

- 新增 E2B 沙盒执行后端（`nyra/e2b_backend.py`）：`--sandbox e2b` 让文件读写与 shell 命令在 E2B 沙盒里执行，不在本机上；`--sandbox-id` 可连回已有沙盒，不给则新建（默认 base 模板、1 小时超时）。沙盒模式下工作目录默认 `/home/user`。
- 执行后端是 tools.py 里的一道缝：`read_file` / `write_file` / `edit_file` / `list_dir` / `shell` / `plan` / `grep_search` / `git_status` 走后端，其余工具（联网、记忆、技能、delegate、http_post）仍在本地；审批三档与 shell 黑名单在两种后端下都生效；子 agent 继承同一后端。
- 核心仍是标准库 only：E2B 后端是可选依赖（`pip install e2b`），缺 SDK 时报明确安装提示；凭证优先用 `E2B_API_KEY`，否则走已保存的 Muse 连接器凭证替身，真实 key 不落盘、不进沙盒。
- 测试从 53 个增至 62 个，全部通过；真实 DeepSeek + 真实 E2B 沙盒端到端跑通（沙盒里写文件、读回、列目录，本地无任何写入）。

## 0.2.0（2026-11-16）

- 新增 MCP 客户端（`nyra/mcp.py`）：stdio JSON-RPC，加载配置里的服务器，工具以 `mcp_<服务器>_<工具>` 形式调用；默认关闭，需 `mcp_enabled: true` 显式启用。
- 新增内置调度器（`nyra/scheduler.py`）：`nyra schedule` 子命令（list/add/remove/run/daemon），任务存 `~/.nyra/schedule.json`，支持间隔或每天固定时间。
- 新增会话压缩（`nyra/compact.py`）：`--compact <会话 id>` 与 REPL `/compact`，模型摘要 + 保留最近消息，模型失败时本地回退。
- 新增证据链（`nyra/evidence.py`）：`web_fetch` / `web_search` 抓到的页面原文按会话存档，结论附来源链接。
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
