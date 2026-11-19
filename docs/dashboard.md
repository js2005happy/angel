# 实时看板（P2-3）

每轮更新已花费/剩余。三个出口共用同一份快照（`src/dashboard.ts` 的
`DashboardSnapshot`），金额只用 CostGuard 的三态，算不出就写"未知"，绝不瞎猜。

## 三个出口

| 出口 | 形态 | 何时 |
|---|---|---|
| `--json` | 每轮一个 `cost_update` 事件 | 每次模型调用后（见下） |
| REPL | 状态栏末尾追加成本段 | 每次输入前，`agent.lastCost` 有值时才显示（框式状态栏与纯文本回落分支两路都接） |
| 一次性任务 | `ToolPrinter` 每轮打印一行看板 | 每次模型调用后，与工具调用行同款去向 |

## 快照字段

`turn` / `max_turns` / `status`（`priced` / `unpriced` / `missing`）/
`spent_usd` / `remaining_usd` / `limit_usd` / `prompt_tokens` /
`completion_tokens` / `total_tokens` / `calls` / `missing_calls` /
`context_window_tokens` / `context_remaining_tokens` / `reason`（可选）。

金额口径与 P2-2 成本硬顶完全一致（`src/cost.ts` 的 `estimateCost`）：

- `priced`：有单价 + provider 报了 usage → 金额确定。
- `unpriced`：有 usage 但没配单价，或有调用没报 usage → 金额为 `null`，
  `reason` 写明原因。
- `missing`：一次 usage 都没报 → 金额为 `null`。

与 `cost` 事件的区别：`cost` 只在 `priced` 时发（P2-2 的硬顶用）；
`cost_update` **每轮都发**，算不出金额时状态写 `unpriced`/`missing`、
金额字段为 `null`——CI/脚本据此显示"未知"，而不是收不到事件就当成 0 花费。

## 一行文本的格式

```
看板 [轮次 3/10] 已花费 $0.0123 / 上限 $0.50（剩余 $0.4877）· Token 12,400/3,100 · 上下文剩余 45,000
看板 [轮次 3/10] 成本：未知（provider 未上报 usage）· Token 12,400/3,100 · 上下文剩余未知
```

- 未设上限时写"未设上限"，不写假数字。
- Token 数只用 provider 实报的数字；没报写"未报告"。
- 上下文剩余只用已配置的窗口与最近一次输入 token 算；算不出写"上下文剩余未知"。

REPL 状态栏的成本段是同一份估算的缩写：`成本 $0.0123/$0.50`（无上限时只写
已花费），算不出时写`成本未知`，没跑过一轮、或既没配单价也没设上限时不显示。
框式状态栏（`renderStatusBar` 的可选 `cost` 字段）与纯文本回落分支
（`formatReplStatus` 的可选第 5 参数）走同一份 `dashboardCostSegment`。

## 诚实边界

- 自动压缩（`maybeAutoCompact`）里那次额外调用的用量不单独发事件，
  直接并进下一轮的累计值——钱一分不少报，只是晚一轮出现。
- 成本硬顶触发的那轮不会发 `cost_update`：`checkCost()` 先抛错中止运行，
  错误信息本身已写明已花费与上限。
- 估算口径（单价表、字符换算）见 `nyra cost --estimate`（P2-1）；
  看板只报**实际已花费**，不做运行前预估。
