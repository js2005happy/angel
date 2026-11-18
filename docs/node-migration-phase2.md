# Node 迁移第 2 阶段实测报告（2026-11-18）

执行者：Nyra Node 迁移第 2 阶段子代理。工作目录 `~/workspace/angel-node-phase2/`（基线 = 远端 134805e + 第 1 阶段改动）。
只向总协调汇报，不打扰用户。推送与 rebase 由总协调的父级经浏览器做。

## 结论

第 2 阶段核心移植完成并通过全部验收，唯一例外是 Python 全量里 2 项失败——
原因已定位：是我按方案新增的 `skills/debugging.md` 导致两个 Python 测试里写死的
4 技能集合断言失败（见“已知问题”）；Node 侧一致（CLI 列出 5 个技能）。
其余验收全部实测通过。

**验收里明确写一条（用户 2026-11-18 23:14 澄清）：最终交付的 0.4.0 不含 Python
运行时依赖（过渡期 worker 除外，到第 4 阶段清掉）。**

## 性能对照（用户 2026-11-18 23:22：一切性能优先；验收里性能放前面）

| 指标 | Python 版 | Node 版 | 结论 |
|---|---|---|---|
| `--help` 冷启动（中位数，5 次） | 162.1 ms | bun run 53.1 ms / 编译后 44.5 ms | Node 快约 3.6 倍 |
| `--version` 冷启动（中位数，5 次） | 164.0 ms | 编译后 45.2 ms | 同上 |
| 一次性回放任务（录制 3 轮） | 161.9 ms | 44.4 ms（bun run） | Node 快约 3.6 倍 |
| 工具并行延迟（4 模型 × 200ms 睡眠） | 202 ms | 202 ms | 持平，无回归 |
| 内存 `--help`（max RSS） | 23.8 MB | bun run 26.9 MB / 编译后 24.9 MB | Node 高约 1–3 MB，可接受 |
| 内存回放任务（max RSS） | 23.9 MB | 29.8 MB（bun run） | Node 高约 6 MB，Bun 运行时基线所致，标出但不阻塞 |
| 打包体积（`bun build --compile` 单文件） | —（Python 标准库 only，无打包） | **109 MB**（/tmp/nyra-bench） | 偏大，第 4 阶段收尾时处理（Bun 运行时打进去了）；不阻塞第 2 阶段 |

无性能回归。并行延迟持平是因为 Python 版已用线程并行；Node 的优势在启动与
单任务耗时。内存略高是 Bun 运行时基线，不是泄漏（回放任务 44ms 内完成）。

## 测试

- **Node 全量：456 项，0 失败**（`bun test tests/node/`；1413 个 expect）。
  37 个文件：既有 6 个（58 项）+ 本阶段新增 31 个（398 项，含 test-compact 14 项与桥契约 32 项）。
- **Python 全量（本工作目录基线）：1126 通过、11 跳过、2 失败，共 1139 项**
  （`/tmp/pytest-venv/bin/python -m pytest tests/ -q`，96.14s；本机原先无 pytest，
  用隔离 venv `/tmp/pytest-venv` 装 pytest 9.2.0 跑的，系统 Python 未动）。
  2 项失败均为 `skills/debugging.md` 新增所致（见下），非回归。
- **TypeScript strict：`tsc -p tsconfig.json --noEmit` 0 错误。**
- **对账：1139 = 原生对应 604 项 + 桥契约 535 项**
  （pytest `--collect-only` 权威数，见 `/tmp/phase2-accounting.json`）。
  原生 604 项由 Node 测试覆盖（442 个 bun 测试项覆盖 604 个 Python 行为项——
  一个 Node 测试常覆盖多个参数化 Python 用例，如 fallback 的 38 项）；
  桥 535 项由 `tests/node/test-bridge-contracts.test.ts`（32 项）契约化：
  每项断言 Python 源码在位 + 桥覆盖清单含该区 + 真实 worker ping 通。
  桥测试不冒充原生实现，文件头已写明拆分。

## 逐字节一致（录制回放，隔离 HOME）

- 回放 1（read_file → write_file → 最终文本）：Python 与 Node 的 stdout
  SHA-256 均为 `daa7c78c596cfb90c2af07f6f8ccdf9d05748308ca2eb03da09e1680e73f7e70`；
  产物 `output.txt` 均为 `a5a0b183b43c6137d03542c97f7d82b919f22b040b73ab060f4d9c431e21e62c`。
- 回放 2（RunRecorder + 验证命令 `true`）：stdout 均为
  `ee7cf37c3d47372702ca3e4c0dadfb7c2112d390dd3d1c8cc2660fe491052eed`；
  产物 `verified.txt` 均为 `dc51b8c96c2d745df3bd5590d990230a482fd247123599548e0632fdbf97fc22`；
  报告含“运行状态：verified（已验证）/ 改动文件：verified.txt / 验证命令：true / 退出码：0”。
  回放脚本在 `/tmp/replay/`（`fake_py.py`、`fake_node.ts`、`fake_py2.py`、`fake_node2.ts`）。
  本轮重跑复核：两轮哈希与记录完全一致。

## 密码箱字节级兼容（双向，隔离 HOME）

- Python 版现造 `vault.json`（主密码 `test-password-123`，
  `DEEPSEEK_API_KEY=sk-test-deepseek-abc123`、`XAI_API_KEY=xai-test-key-xyz789`）
  → Node 版 `Vault.unlock` 后两条全读出；反向 Node 造箱（主密码
  `node-password-456`，`DEEPSEEK_API_KEY=sk-node-created-999`）→ Python 版全读出；
  双向错密码 `unlock` 均返回 False/false。文件结构：version 1、salt 64 hex、
  verifier 64 hex、条目字段 `data/mac/nonce`。算法 HMAC-CTR（非 AES），
  PBKDF2-HMAC-SHA256 200k 次，向量 `d8583695…49773` 与 Python 逐字节一致。

## 专项验收

- **审批语义**：超时即拒绝（桥：600s 超时发拒绝 decision，worker 端到时自动拒绝）、
  未命名 approval_id 即拒绝（decision 必须命名待决请求 id + approval_id）、
  denylist 命中即拒绝（`checkShellDenied` 与 Python 同规则）、fail-closed
  （EOF/Ctrl-C 即拒绝）——覆盖于 test-tools / test-approval-ui / test-runs /
  test-worker-bridge。
- **委派**：test-agent 覆盖子级全新会话 + 独立 task_id、工具集 = 父级减禁用、
  父级只看调用与最终摘要、一次只给一个明确目标、深度/预算上限。
- **压缩分层**：`tests/node/test-compact.test.ts`（14 项，对应 test_auto_compact.py）：
  `trimOldToolResults` 先剪旧工具结果 → `splitCompletedVsActive` 选边界 → LLM 摘要；
  网关 85% / agent 50%；只压缩已完成轮次，绝不碰当前用户请求及其工具往返；
  strict 摘要失败抛错保留原文，非 strict 本地回退保留首尾消息。
- **缓存不变式**：一次运行内 system prompt 与工具 schema 只构建一次、逐轮不变，
  测试覆盖（test-agent）。
- **引用台账**：`src/citations.ts` + test-citations（7 项）：编号与 URL 由记录产生，
  同一 URL 复用同一编号；`verify` 要求逐字引用在证据文本里字面出现；
  记忆内容标 `[unverified]`。
- **spec 07**：test-migration（12 项）：原子迁移（`.migrating` 暂存后改名）、
  批准作废、ANGEL_* 回退无警告（以任务书为准，与 spec 07 第 3 条“打印一条警告”不同）、
  `angel` 命令别名、符号链接跳过、0700/0600 权限、X-Angel-Token 兼容、崩溃残留重跑。
- **CLI 冒烟**（隔离 HOME `/tmp/nyra-smoke-final`）：`--help` / `--version`（0.3.0）/
  `--list-providers`（14 个）/ `--list-skills`（5 个，含 debugging）/
  `--list-sessions` / `--json`（无任务时 exit 2，`invalid_arguments`）/
  `memory export`（exit 0）/ `memory import`（exit 0，“已导入 0 条，跳过 2 条（已存在）”）/
  `memory local codex`（隔离 HOME 无库时 exit 1，报错明确）/
  `memory export-prompt`（exit 0）全部按预期。
  注意：`memory import` 从 stdin 读快照，无输入时会等 stdin（非 bug，与 Python 同行为）。

## 本轮修掉的实现真 bug（测试抓到的，不是测试期望错）

1. `src/memory.ts` `loadMemorySummary`：`split("\n")` 把文件末尾换行算成空行，
   `slice(-N)` 少取一行；已按 Python `splitlines()` 语义修。
2. `src/cli.ts` `listCustomCommands`：返回带 `.md` 的文件名；Python
   `load_commands` 返回去 `.md` 的 stem 且按目录去重。已按 Python 修。
3. 其余本阶段修过的真 bug（见摘要）：runs.ts 的标记前缀丢失、untrusted.ts 空标记、
   checkpoints undo 多轮校验、tools shell 超时（进程组杀）、memoryExchange 路径参数
   混淆与 Codex 双表缺失、cli memory 命令传参、`config.ts` 模型回落。

## 桥覆盖清单（第 2 阶段结束时；`src/workerBridge.ts` 内 `BRIDGE_COVERAGE`）

| 区 | 原因 |
|---|---|
| webui / server（网页端、SSE、WebSocket、CDP 浏览器） | 第 3 阶段；Node 版只保留 Python worker 的 HTTP 服务 |
| mcp（MCP 客户端/服务器） | 第 3 阶段；协议与工具发现仍走 worker |
| pairing（扫码配对、GET /memory 对端读取） | 第 3 阶段；配对码与 token 明文传输规则未在 Node 端重做 |
| computer（截屏/点击/输入/按键/列窗口）+ vision 看屏接线 | 第 3 阶段；三后端（scrot/imports/Win32）仍走 worker |
| groups（群聊多 Key） | 第 3 阶段；Bot.api_keys 轮换仍走 worker |
| poppy（Poppy 客户端、按站权限账本、UCP 购物） | 第 3 阶段；schema 已在 Node tools.ts 声明，执行走 worker |
| eigenflux（入网/策略） | 第 3 阶段；入网须用户前台逐项确认，仍走 worker |
| install / packaging / systemd / launchd / mobile PWA | 第 4 阶段打包；安装脚本与部署仍以 Python 版为准 |
| tui / trust / webui-v2 / docs-site | 第 3–4 阶段；未列入第 2 阶段移植范围 |
| memory-browser（记忆浏览器） | 第 3 阶段；随 webui 走 worker |
| artifacts（网页端产物存储） | 第 3 阶段；随 webui 走 worker |
| windows-compat（Windows 兼容守卫） | 第 4 阶段；需 Windows 真机验证，Node 版暂不原生断言 |

桥协议：worker 协议 v1（`run` / `approval_decision` / `stop` / `ping` 不变），
`APPROVAL_TIMEOUT = 600.0`，fail-closed。真实 worker ping 已在
test-worker-bridge 与 test-bridge-contracts 里实测通过。

## 已知问题（需总协调定夺，不由我改）

1. **Python 全量 2 项失败，根因是我按方案新增的 `skills/debugging.md`**：
   `tests/test_skill_deep_thinking.py::test_shipped_skills_all_load` 与
   `tests/test_webui.py::UIv2Tests::test_info_includes_providers_tools_skills`
   都把已发技能集合写死为 `{file-organizer, verify-research, web-research, deep-thinking}`，
   现多出 `debugging`。已在 phase1 目录复核：不含 debugging.md 时两项都过。
   修复是各加一行期望（`"debugging"`），但任务书规定第 2 阶段不碰 `tests/test_*.py`，
   请总协调在推送时一并改，或另派人改。
2. **基线漂移**：phase1 目录在复制后又被刷新（`nyra/webui.py` 15:15，
   含桌面 App 的 `url_json()` / `--print-url-json`；`tests/test_desktop_ui_json.py`
   仅 phase1 有），我的 phase2 基线仍是复制时点的 134805e + 第 1 阶段。
   推送前 rebase 须把桌面 App 这批带上；我的 Node 文件与之无交集。
   （日记称推送包已 rebase 到 dea5394；以总协调的最新核对为准。）
3. **Windows CI 红**：根因已定位（超时测试里被杀子进程仍占临时目录文件，
   Windows 锁着删不掉），已交总协调修；第 2 阶段未动 Python 代码，未碰。
4. 编译产物 109 MB（见性能表），第 4 阶段处理。

## 未完成/待验证（与第 1 阶段相同，继续列明）

- Windows/macOS 真机验证、PWA 真机验证、Release tag（打 v* 标签）。
- 本沙箱直连 api.deepseek.com 失败（出口代理限制），doctor 真实外网全绿待有直连网络的环境重跑。
- 第 3 阶段：Gateway/网页/rewind/smart approvals；第 4 阶段：插件市场、性能收尾、Python 退役（删 `python/` 目录，发 0.4.0）。

## 改动文件清单（相对第 1 阶段工作目录）

- **新增 src（29 个文件，约 7,200 行）**：agent.ts（438）、approvalUi.ts（151）、
  banner.ts（59）、checkpoints.ts（280）、citations.ts（61）、compact.ts（153）、
  consoleUi.ts（88）、conversations.ts（225）、evidence.ts（59）、jsonMode.ts（66）、
  knowledge.ts（437）、memory.ts（163）、memoryExchange.ts（276）、migration.ts（103）、
  multiModel.ts（186）、net.ts（32）、planMode.ts（177）、providers.ts（726）、
  pyjson.ts（83）、runs.ts（755）、scheduler.ts（220）、skills.ts（131）、tasks.ts（392）、
  tools.ts（1117）、untrusted.ts（133）、usage.ts（118）、vault.ts（324）、vision.ts（33）、
  workerBridge.ts（218）。另 `skills/debugging.md`、`tsconfig.json`（14 行）。
- **修改**：src/cli.ts（155 行骨架 → 1007 行完整版）、src/config.ts（413 行，补全
  resolveProvider/resolveFallbackChain 等）、src/wizard.ts（2 处类型修复）、
  src/vault/index.ts、src/providers/index.ts、src/tools/index.ts、src/agent/index.ts、
  src/skills/index.ts、src/memory/index.ts（占位目录改 re-export）、
  package.json（+ typecheck 脚本、@types/bun devDependency；bun add 时顺带 pretty-print
  重排）、bun.lock（新增，是否进提交由总协调定）。
- **新增 tests/node（30 个文件，共 4,400 行含既有 6 个）**：test-agent、test-approval-ui、
  test-banner、test-bridge-contracts、test-checkpoints、test-citations、test-cli、
  test-console-ui、test-conversations、test-evidence、test-json-mode、test-knowledge、
  test-memory-exchange、test-memory、test-migration、test-multi-model、test-net、
  test-plan-mode、test-providers、test-pyjson、test-runs、test-scheduler、test-skills、
  test-tasks、test-tools、test-untrusted、test-usage、test-vault、test-verify、
  test-vision、test-worker-bridge、test-compact。
- **不进清单**：`dist/`、编译出的二进制（/tmp/nyra-bench 仅作性能对照）、`node_modules/`、
  `__pycache__`；`nyra/` 与 `tests/test_*.py` 未动（除新增技能文件导致的 2 项 Python
  测试失败，见已知问题 1）。
- **提交信息建议（按模块分 4 个提交）**：
  1. `node: port vault/config/providers (byte-compatible vault, 14 providers, fallback chain)`
  2. `node: port tools/agent/runs/tasks (24 tools, approval, delegation, compaction)`
  3. `node: port cli/skills/knowledge/conversations/memory + spec 07 migration`
  4. `node: worker protocol v1 bridge + bridge contracts + debugging skill`
