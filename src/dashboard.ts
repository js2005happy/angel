// src/dashboard.ts — P2-3：实时看板（TUI + --json 事件）。
//
// 每轮更新已花费/剩余；金额只用 CostGuard 的三态（priced/unpriced/missing），
// 未报告 usage 时显示"未知"，绝不瞎猜。复用 usage.ts / cost.ts 的口径，
// 不另发明计费方式：单价来自 config.pricing（resolvePricing），
// 上限来自 --max-cost / config.max_cost_usd（Agent 已接好）。
//
// 三个出口共用同一份快照：
//   --json：每轮一个 cost_update 事件（Agent.runLoop 里发）；
//   REPL：状态行末尾追加成本段（agent.lastCost 有值时才显示）；
//   一次性任务：ToolPrinter 每轮打印一行看板（与工具调用行同款去向）。
// 自动压缩（maybeAutoCompact）里那次额外调用的用量不单独发事件，
// 直接并进下一轮的累计值——钱一分不少报，只是晚一轮出现，文档里写明。
import { estimateCost, type CostEstimate, type Pricing } from "./cost.ts";
import type { UsageSnapshot } from "./usage.ts";

/** 每轮的看板快照：JSON 事件的 payload，也是 TUI 那一行的唯一事实源。 */
export interface DashboardSnapshot {
  turn: number;
  max_turns: number;
  /** CostGuard 三态：priced（能算）/ unpriced（有 usage 无单价）/ missing（没报 usage）。 */
  status: CostEstimate["status"];
  /** 已花费（美元）；非 priced 时为 null——不编造。 */
  spent_usd: number | null;
  /** 剩余（美元）；非 priced 或未设上限时为 null。 */
  remaining_usd: number | null;
  /** 上限（美元）；未设置时为 null。 */
  limit_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  calls: number;
  missing_calls: number;
  context_window_tokens: number | null;
  context_remaining_tokens: number | null;
  /** 算不出金额的原因（unpriced / missing 时有值）。 */
  reason?: string;
}

/** 从一轮的用量快照与已算好的 CostEstimate 拼看板快照（纯函数）。 */
export function buildDashboardSnapshot(input: {
  turn: number;
  maxTurns: number;
  snapshot: UsageSnapshot;
  estimate: CostEstimate;
}): DashboardSnapshot {
  const s = input.snapshot;
  const e = input.estimate;
  return {
    turn: input.turn,
    max_turns: input.maxTurns,
    status: e.status,
    spent_usd: e.spentUsd,
    remaining_usd: e.remainingUsd,
    limit_usd: e.limitUsd,
    prompt_tokens: s.prompt_tokens,
    completion_tokens: s.completion_tokens,
    total_tokens: s.total_tokens,
    calls: s.calls,
    missing_calls: s.missing_calls,
    context_window_tokens: s.context_window_tokens,
    context_remaining_tokens: s.context_remaining_tokens,
    ...(e.reason ? { reason: e.reason } : {}),
  };
}

/** 拼看板快照的快捷方式：先按 CostGuard 算金额，再拼快照。 */
export function buildDashboardSnapshotFor(
  turn: number,
  maxTurns: number,
  snapshot: UsageSnapshot,
  pricing: Pricing | null,
  limitUsd: number | null,
): { snapshot: DashboardSnapshot; estimate: CostEstimate } {
  const estimate = estimateCost(snapshot, pricing, limitUsd);
  return { snapshot: buildDashboardSnapshot({ turn, maxTurns, snapshot, estimate }), estimate };
}

function fmtTokens(v: number | null | undefined): string {
  return typeof v === "number" ? v.toLocaleString("en-US") : "未报告";
}

/** 看板一行（TUI / ToolPrinter 用）：紧凑、可断言，缺数就写"未知"。 */
export function formatDashboardLine(snap: DashboardSnapshot): string {
  const turn = typeof snap.turn === "number" ? snap.turn : 0;
  const maxTurns = typeof snap.max_turns === "number" ? snap.max_turns : 0;
  const head = `看板 [轮次 ${turn}/${maxTurns}]`;
  const tokens = `Token ${fmtTokens(snap.prompt_tokens)}/${fmtTokens(snap.completion_tokens)}`;
  const ctx = typeof snap.context_remaining_tokens === "number"
    ? `上下文剩余 ${snap.context_remaining_tokens.toLocaleString("en-US")}`
    : "上下文剩余未知";
  if (snap.status === "priced" && typeof snap.spent_usd === "number") {
    const spent = `$${snap.spent_usd.toFixed(4)}`;
    const limit = snap.limit_usd === null
      ? "未设上限"
      : `上限 $${snap.limit_usd.toFixed(2)}（剩余 $${(snap.remaining_usd ?? 0).toFixed(4)}）`;
    return `${head} 已花费 ${spent} / ${limit} · ${tokens} · ${ctx}`;
  }
  return `${head} 成本：未知（${snap.reason ?? "数据不足"}）· ${tokens} · ${ctx}`;
}

/**
 * REPL 状态行用的成本段：有估算才返回字符串，否则返回 null（状态行保持原样）。
 * priced：`成本 $0.0123/$0.50`（无上限时只写已花费）；unpriced/missing：`成本未知`。
 */
export function dashboardCostSegment(estimate: CostEstimate | null | undefined): string | null {
  if (!estimate) return null;
  if (estimate.status === "priced" && typeof estimate.spentUsd === "number") {
    return estimate.limitUsd === null
      ? `成本 $${estimate.spentUsd.toFixed(4)}`
      : `成本 $${estimate.spentUsd.toFixed(4)}/$${estimate.limitUsd.toFixed(2)}`;
  }
  return "成本未知";
}
