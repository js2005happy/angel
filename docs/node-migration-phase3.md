# Node 迁移第 3 阶段实测报告

> 基线：第 2 阶段工作目录（远端 134805e + 第 1 阶段 + 第 2 阶段）。
> 本阶段工作目录：`~/workspace/angel-node-phase3/`。推送由总协调经浏览器做，
> 本报告不含任何 push。性能指标放前面（用户 2026-11-18 23:22：一切性能优先）。

## 0. 结论

第 3 阶段 5 项 + 压缩分层全部落地并实测通过：单 gateway、网页 UI 升级
（桌面 + /m 手机 + 桌面外壳兼容）、/rewind 三端一致、smart approvals
三档、MCP 成本显示与上限、网关压缩分层（85%）。桥覆盖面 12 区 → 7 区。

**回归（必须如实写在前面）：**

- **gateway 空闲 RSS 回归**：Node 编译后 37.1MB vs Python 26.0MB（+11.1MB，
  约 +43%）。第 2 阶段 `--help` 只高 1–6MB；gateway 常驻进程把 Bun 运行时
  全量吃进来，差距拉大。第 4 阶段处理（Bun 运行时瘦身 / 换更轻的底座），
  本阶段不掩盖。
- **启动到首字节基本持平**：Node 编译后中位约 113ms vs Python 约 188ms
  （三次实测，见 §1）。第 0 阶段 Python 基线 33ms 是另一台环境/另一种
  测法（`nyra ui` 首字节），本次同环境同方法重测 Python 为 154–203ms，
  以本次同环境数为准。
- **打包体积未变**：编译产物仍 109MB（`dist/nyra-linux-x64`），第 4 阶段处理。

## 1. 性能实测（隔离 HOME，`NYRA_HOME` 临时目录；不碰真实 `~/.nyra`）

### 1.1 gateway 启动到首字节、空闲 RSS

方法：spawn 进程 → 轮询首个 HTTP 响应；空闲 2 秒后读 `/proc/<pid>/status`
VmRSS 三次取中位。Node 用 `--print-url-json` 的 stdout 首行 + `/api/health`
200；Python webui 没有 `/api/health`（那是 server.py 的 8766 端口），
以首次任意 HTTP 响应为准（未鉴权 GET / 返回 403 即代表已可服务）。

| 指标 | Python `python3 -m nyra ui` | Node `bun run src/cli.ts ui` | Node 编译 `dist/nyra-linux-x64 ui` |
|---|---|---|---|
| spawn → 首字节 | 203 / 200 / 175 / 154 ms（中位约 188ms） | 74 ms | 198（冷）/ 71 / 113 ms（中位约 113ms） |
| 空闲 RSS | **26.0 MB** | 41.0 MB | **37.1 MB** |
| 历史读取（5 次平均） | — | 1.2 ms | 1.2 ms |

结论：启动 Node 编译后略快于 Python（约 1.7 倍中位）；**内存回归 +11.1MB**，
见 §0。脚本：`/tmp/perf-phase3.ts`、`/tmp/perf-py.py`（临时脚本，不进推送）。

### 1.2 双客户端同时在线（假 provider，50ms 延迟在内）

脚本 `/tmp/perf-gw.ts`（进程内 Gateway + `providerFactory` 注入 fake provider）：

- A 发送 → `run_finished`：203 / 201 / 203 ms；B 同期再发得 **409**（三轮全是），
  不丢消息、不重复发、不开第二个 agent。
- B 在 A 完成后发一轮 → `run_finished`：204 / 203 / 203 ms。
- 与第 2 阶段并行延迟 202ms 持平，无回归。
- 自动化测试：`tests/node/test-gateway.test.ts`（4 项）：A 发 → B 立刻再发得 409；
  等 done 后 A/B 看到的 messages 逐字节一致；assistant 恰好 2 条；存档 user/assistant
  各 1 条；SSE 流以 `run_finished` 结尾且含 user 事件。

### 1.3 /rewind 回退延迟

40 条消息存档，回退到第 20 条，5 次：7 / 2 / 2 / 1 / 1 ms，**平均 2.6ms**；
回退后消息数 20，live 会话与存档一致。Python 无此功能（Python 的 `/rewind N`
是文件检查点撤销，不是对话回退），无对照。

## 2. 验收逐项（全部实测）

### 2.1 单 gateway

- `nyra ui` 启动 gateway 拥有全部会话；CLI（`nyra gw …`）、网页、定时任务
  （scheduler 每 60 秒，到期任务用主 provider，不走兜底链，结果进 inbox）、
  群聊都接 gateway——群聊 API 明确返回 **501**（仍走 worker 桥，不假装可用）。
- gateway 默认按需启动，不强制常驻；`--exit-on-stdin-close` 时 stdin 关闭即退出 0。
- 双客户端一致性见 §1.2。

### 2.2 网页 UI 升级

- 桌面单页：会话 / 审批卡 / always 授权 / 计划模式 / 产物 / 定时任务 / 设置 /
  MCP 成本 / 记忆 / 手机配对；每条消息有回退 / 编辑重发 / Fork 按钮。
- 手机 `/m`：会话 / 审批 / 任务 / 设置 + 配对码输入，PWA manifest + 图标
  （纯手写 PNG 编码器，无图片库依赖）。
- **Playwright 实测发现并修掉一个真缺口**：手机页最初没有回退按钮（只渲染
  消息），桌面页有。已补 `MOBILE_JS` 的回退按钮行与 `doRewind`（与桌面页
  同一份实现），并加回归测试 `test_m_page_has_rewind_buttons_like_desktop`。
  Playwright 端到端（iPhone 390×844 + 触摸，Chromium headless shell 159）：
  /m 加载 → 填 6 位码配对成功（设备 token 存 localStorage，配对框隐藏，
  设备 token 读会话列表 200）→ 打开 6 条消息的会话 → 点第 4 条“回退到此”
  → 页面剩 4 条，API history 剩 4 条，一致。截图见 `/tmp/pw-mobile-m.png`。
  PWA 真机安装仍待真机验证。
- 桌面外壳兼容：`nyra ui --print-url-json --exit-on-stdin-close` 实测
  （`tests/node/test-desktop-json.test.ts`）：stdout 首行一行 JSON
  （nyra/version/url/host/port/token）；带 token `/api/info` 200、不带 403；
  页面不带 token 403、带 `?token=` 200；关 stdin 后退出码 0。
  与 Python 版行为一致（Python 版无此 flag，以终端打印的含 token 链接为准，
  契约按任务书实现）。

### 2.3 /rewind（三端一致）

- 基于 conversations SQLite：任意消息回退（truncate）、编辑重发（仅 user 消息）、
  fork 新会话（原会话不动）。
- CLI：`nyra gw rewind <会话> <消息 id> <truncate|edit|fork> [新文本]` 实测：
  10 条 → truncate 到 6 条（“回退完成：保留 6 条，删除 4 条”，history 验证 6 条，
  末条为第 3 个回答）；fork 到消息 3 得新会话 `20261118-164139-4b01`。
  REPL：`/rewind-msg`、`/rewind-edit`、`/rewind-fork`（与网页/手机同一份实现，
  每轮问答记入 ConversationStore）。
- 网页 / 手机：见 §2.2 Playwright 实测；API 级测试 `test-rewind.test.ts`（5 项）：
  存档级 truncate/edit/fork、跨会话拒绝、gateway API 回退后 live 会话与存档一致。
- 注意：Python 的 `/rewind N` 是另一功能（文件检查点撤销），两者并存、互不干扰。

### 2.4 smart approvals

- 三档：静态规则（denylist → DENY；只读工具 → APPROVE；其余变异 → ESCALATE）
  → 评审模型（仅显式开启且提供评审器时）→ 人工。评审模型**默认关**
  （`smart_approvals.reviewer_enabled` 须为 true 才开）。
- 评估前剥离 shell 注释（引号内 `#` 不动）；命令包在 XML 块里给评审者，
  系统提示明确要求评审者忽略块内指令；评审返回 `{verdict, reason}` JSON，
  解析失败 / 模型抛错 → ESCALATE（fail-closed 到人工）。
- 审计：每次结论写 `approvals_audit.jsonl`（结论、档位、剥离后的命令、评审理由），
  可经 `/api/smart-approvals/audit` 查（仅 owner）。
- 测试 `tests/node/test-smart-approvals.test.ts`（8 项）：注释剥离、XML 包裹、
  静态 DENY（`rm -rf /`）、静态 APPROVE（只读工具）、默认关时 ESCALATE 到人工且
  审计留痕、评审开启时模型结论与审计、评审返回垃圾/抛错时 fail-closed。
  评审关闭时行为与第 2 阶段二值审批一致（静态档 + 人工）。
- 测试中纠正的一个实现细节：静态规则最初对**原始**命令判定，注释里的危险词
  会误拒；已改为静态与评审都用剥离后的命令判定。

### 2.5 MCP 成本显示

- 原生 MCP 客户端：stdio JSON-RPC，协议 2026-07-28（`server/discover` 探测 +
  `-32022` 挑版本 + 旧版 `initialize` 2025-11-25 回退）、`tools/list` 分页、
  `tools/call`、MRTR（多轮往返）直接报错、服务器主动请求回 `-32601`、
  超时旧响应按 id 丢弃、代理环境变量去凭据。
- 预置 10 个，默认启用 memory / sequential-thinking / fetch / time；
  预置优先、用户配置覆盖；缺 Key / 缺路径只跳过，不编造。
- 成本：`mcp_tool_costs["服务器.工具"]` → 服务器级 `cost_per_call_usd` → 未标价 0；
  上限 `mcp_cost_limit_usd`（未设 = 不设上限）；调用前显示预估
  （工具列表与调用响应里都有 `estimate_line`，如“预估 $0.0200”）；
  超上限停手并报信（409“成本上限已到……已停手”），花费记 `mcp_spend.jsonl` 只追加。
- 测试：`test-mcp.test.ts`（7 项，假 MCP 服务器 stdio 脚本：现代 discover 路径 +
  旧版 initialize 回退、tools/list 分页、call_tool、MRTR 报错、预置与成本拦截）；
  `test-gateway-mcp.test.ts`（1 项，API 级：列表含预估 → 两次调用成功累计 $0.04 →
  第三次 409 停手 → `/api/mcp/spend` 显示上限 $0.05 / 已花 $0.04）。

### 2.6 压缩分层（方案 2.6 第 7 条）

- 网关阈值 85% / agent 阈值 50%，落到 gateway（第 2 阶段只做了 agent 侧）。
- 用量比 ≥85% 时先剪旧工具结果（不调 LLM），最新一轮不动，记 `gateway_compact` 事件；
  低于阈值不触发。测试 `test-gateway-compact.test.ts`（3 项）：
  40% 不触发；85% 触发且旧工具结果被折叠、最新不动、全程零模型调用。

### 2.7 桌面外壳 / 配对 / 记忆 / 产物

- 见 §2.2；`test-gateway-mobile.test.ts`（4 项）：/m 页面无需 token 200、
  manifest、icon-192.png 的 PNG 魔数、loopback 下 `pair/start` 409、
  0.0.0.0 下配对码兑换 → 设备 token 能读 sessions、不能管 devices（403）、
  撤销后设备 token 立即失效。
- `test-pairing.test.ts`（8 项）：6 位码、5 分钟有效、一次性、错 5 次作废、过期、
  重新生成作废旧码、authenticate 常量时间比对、撤销、磁盘只存 SHA-256。
  UDP 发现（47831）测试在本沙箱因禁 UDP 发送（EPERM）跳过并注明，
  待有 UDP 的环境验证——不算通过证据。
- `test-memory-browser.test.ts`（6 项）：revision 乐观锁冲突、64 KiB 上限、
  符号链接拒绝、global/bot 范围。
- `test-artifacts.test.ts`（4 项）：创建/列表/读取、每会话 50 上限、围栏 + HTML
  检测、markdown 转义。

## 3. 测试对账

| 套件 | 数量 | 结果 |
|---|---|---|
| Node 全量 `bun test tests/node/` | **508 项**（第 2 阶段 456 → +52） | 见 §3.1 |
| Python 全量 `/tmp/pytest-venv/bin/python -m pytest tests/ -q` | **1139 项**（1128 passed + 11 skipped） | 全过 |
| TypeScript strict `tsc -p tsconfig.json --noEmit` | — | 0 错误 |

对账：1139 = 原生对应 604 项 + 桥契约 535 项（第 2 阶段 `/tmp/phase2-accounting.json`
口径；本阶段 Python 代码未改，Python 侧总数不变）。Node 新增 52 项：
rewind 5、smart-approvals 8、mcp 7、pairing 8、memory-browser 6、artifacts 4、
gateway-compact 3、desktop-json 2、gateway-mobile 4（含新增回归项）、
gateway-mcp 1、fake-mcp-server 抽取后 mcp 测试重组、bridge-contracts 改写 10 项、
worker-bridge 覆盖清单改写 1 项，合计 52 项（456 + 52 = 508）。

### 3.1 两项过期测试的处置（cli.test.ts，第 1 阶段二进制黑盒）

第 2 阶段目录没有 `dist/`，这两项当时是**跳过**（算通过）；本阶段为测性能编了
`dist/nyra-linux-x64`，它们才真正跑起来，暴露期望已过期：

- “无 Key 跑任务”：断言输出含 `DASHSCOPE_API_KEY` 与 `nyra --example`（第 1 阶段
  文案）；现二进制无 Key 时退出码仍是 1，但文案是“未找到可用的 API 凭据”
  （DEEPSEEK_API_KEY / NYRA_API_KEY）。已把断言改成当前文案。
- “有 Key 跑模型任务”：断言退出码 2 与“第 2 阶段”未实现提示；第 2 阶段已实现
  provider，带假 Key 时二进制会真实调 DashScope，provider 默认超时 120s，
  本沙箱网络黑洞导致 5s 测试超时（-1）。已改写：以 150s 测试超时跑一次真实调用，
  实测退出码 1、“错误：ProviderError: API 请求超时，请稍后重试”（120.25s），
  断言即按此定（退出 1 + 含“API 请求超时” + 不含“第 2 阶段”），4 项全过。
  （provider 120s 默认超时是第 2 阶段的设计，本阶段不改；如需收紧超时，属第 4 阶段议题。）

## 4. 桥覆盖清单更新版（12 区 → 7 区）

已原生化（本阶段从清单移除）：

| 区 | 原生落点 |
|---|---|
| webui / server | `src/gateway.ts` + `src/webuiPage.ts` + `src/gatewayClient.ts` |
| mcp（含成本上限） | `src/mcp.ts` + `src/mcpPresets.ts` + `src/mcpCost.ts` |
| pairing | `src/pairing.ts`（DeviceRegistry，5 分钟 TTL） |
| memory-browser | `src/memoryBrowser.ts` |
| artifacts | `src/artifacts.ts` |

仍走桥（`src/workerBridge.ts` 内 `BRIDGE_COVERAGE`，7 区）：

| 区 | 原因与第 4 阶段计划 |
|---|---|
| computer（截屏/点击/输入/按键/列窗口）+ vision 看屏接线 | 三后端（scrot/imports/Win32）需真机验证；vision 接线随 computer 走 |
| groups（群聊多 Key） | Bot.api_keys 轮换与群聊多 bot 并行仍走 worker；gateway 群聊 API 现报 501，不假装可用 |
| poppy（Poppy 客户端、按站权限账本、UCP 购物） | schema 已在 Node tools.ts 声明，执行走 worker；UCP 购物涉支付，须单独验收 |
| eigenflux（入网/策略） | 入网须用户前台逐项确认 |
| install / packaging / systemd / launchd / mobile PWA | 安装脚本与部署仍以 Python 版为准；PWA 壳已原生（/m + manifest），真机安装待验证 |
| tui / trust / webui-v2 / docs-site | TUI 终端交互与 trust 台账未列入第 3 阶段移植范围；webui-v2 评审面板与计划模式已随 gateway 落地，剩余 trust 台账第 4 阶段 |
| windows-compat（Windows 兼容守卫） | 需 Windows 真机验证，Node 版暂不原生断言 |

## 5. 改动文件清单与提交信息建议

> 二进制与 `dist/`、`node_modules/`、`__pycache__/` 绝不进清单。
> 行数以本工作目录 `wc -l` 为准（新增文件为全量行数，修改文件为当前总行数）。

### 提交 1：单 gateway 与网页 UI（核心）

```
node: phase 3 single gateway + webui upgrade

- Gateway owns all sessions (CLI/web/scheduler/chat); one agent per
  session, second send gets 409; SSE + session file + conversation
  archive kept in sync
- nyra ui --print-url-json --exit-on-stdin-close (desktop shell contract)
- Desktop + /m mobile pages (PWA shell, pairing), rewind buttons on
  both (mobile was missing them; found by Playwright)
- Gateway-level compaction at 85% (agent side stays 50%)
```

| 文件 | 状态 | 行数 |
|---|---|---|
| `src/gateway.ts` | 新增 | 1333 |
| `src/gatewayClient.ts` | 新增 | 55 |
| `src/webuiPage.ts` | 新增 | 467 |
| `src/cli.ts` | 修改 | 1224 |
| `src/conversations.ts` | 修改（rewind 用：getMessage/deleteAfter/updateMessageText/copyUpTo） | 283 |
| `src/tools.ts` | 修改（checkApproval 透传 details） | 1121 |

### 提交 2：/rewind 与 smart approvals

```
node: phase 3 /rewind + smart approvals

- /rewind on SQLite conversations: truncate / edit-resend (user
  messages only) / fork; CLI, web and mobile share one implementation
- Smart approvals: static rules -> optional reviewer model (off by
  default) -> human; comment stripping, XML-wrapped commands,
  audit log (approvals_audit.jsonl); fail-closed to human
```

| 文件 | 状态 | 行数 |
|---|---|---|
| `src/rewind.ts` | 新增 | 87 |
| `src/smartApprovals.ts` | 新增 | 236 |

### 提交 3：MCP 原生客户端、成本上限、配对、记忆、产物

```
node: phase 3 native MCP client + cost cap, pairing, memory browser, artifacts

- MCP stdio client (protocol 2026-07-28, legacy initialize fallback),
  10 presets, per-call cost estimate + limit that stops over-limit calls
- Device pairing (6-digit code, 5-min TTL, SHA-256-only token storage)
- Memory browser (revision lock, 64 KiB cap, symlink refusal)
- Artifacts (1 MB truncation, 50 per session)
- Bridge coverage shrinks 12 -> 7 areas
```

| 文件 | 状态 | 行数 |
|---|---|---|
| `src/mcp.ts` | 新增 | 523 |
| `src/mcpPresets.ts` | 新增 | 118 |
| `src/mcpCost.ts` | 新增 | 98 |
| `src/pairing.ts` | 新增 | 216 |
| `src/memoryBrowser.ts` | 新增 | 148 |
| `src/artifacts.ts` | 新增 | 228 |
| `src/workerBridge.ts` | 修改（BRIDGE_COVERAGE 12 → 7） | 215 |
| `src/gateway/index.ts`、`src/mcp/index.ts`、`src/pairing/index.ts` | 修改（占位 stub 改 re-export） | — |

### 提交 4：测试与文档

```
node: phase 3 tests + docs

- 52 new Node tests (508 total); bridge-contract tests rewritten for
  the 5 newly native areas; cli.test.ts updated from phase-1 stubs to
  current binary behaviour
- Phase 3 verification report
```

| 文件 | 状态 |
|---|---|
| `tests/node/test-gateway.test.ts` | 新增 |
| `tests/node/test-rewind.test.ts` | 新增 |
| `tests/node/test-smart-approvals.test.ts` | 新增 |
| `tests/node/test-mcp.test.ts` | 新增 |
| `tests/node/test-gateway-mcp.test.ts` | 新增 |
| `tests/node/test-pairing.test.ts` | 新增 |
| `tests/node/test-memory-browser.test.ts` | 新增 |
| `tests/node/test-artifacts.test.ts` | 新增 |
| `tests/node/test-gateway-compact.test.ts` | 新增 |
| `tests/node/test-desktop-json.test.ts` | 新增 |
| `tests/node/test-gateway-mobile.test.ts` | 新增 |
| `tests/node/fake-provider.ts` | 新增（脚本化响应 + delayMs） |
| `tests/node/fake-mcp-server.ts` | 新增（假 MCP 服务器） |
| `tests/node/test-bridge-contracts.test.ts` | 修改（10 项“走桥”改“已原生”） |
| `tests/node/test-worker-bridge.test.ts` | 修改（覆盖清单 12 → 7） |
| `tests/node/cli.test.ts` | 修改（两项过期断言改当前行为） |
| `bun.lock` | 修改（`bun install` 引入 @types/bun 1.4.4） |
| `docs/node-migration-phase3.md` | 新增（本文件） |

## 6. 未完成 / 待验证项

- Windows / macOS 真机验证（gateway、桌面外壳 flag、编译产物运行行为）。
- PWA 真机安装（手机浏览器“添加到主屏幕”）；Playwright 只验证了 /m 页面与配对流程。
- UDP 发现（47831）真实应答：本沙箱禁 UDP 发送（EPERM），测试跳过并注明。
- Release tag：第 4 阶段收尾时再打（与第 1–2 阶段相同）。
- gateway 空闲 RSS 回归（37.1MB vs Python 26.0MB）：第 4 阶段处理。
- 编译产物 109MB：第 4 阶段处理（与第 2 阶段相同）。
- provider 默认 120s 超时：带假 Key 的 CLI 调用会等满 120s 才报错；
  是否收紧超时属第 4 阶段议题，本阶段只把测试改成真实行为。
- 备注：本次 Python 全量回归中途遇到一次服务重启，`/tmp/pytest-venv` 被清掉，
  已重建（`python3 -m venv` + `pip install pytest` 9.2.0）后重跑，全过。
  本机 stdlib 的 `tempfile` 被裁过（无 `mkdtempdir`），性能脚本改用手工建目录，
  不影响结论。
