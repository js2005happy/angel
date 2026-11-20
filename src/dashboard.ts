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
import { t } from "./i18n.ts";

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
  /**
   * 已完成子任务的计价花费（美元）；没有子任务或算不出时为 null。
   * 只报 spent_usd 会让人以为整轮才花了这么点——委派花费是旁路。
   */
  delegate_usd?: number | null;
  /** 本次运行已计价的语音花费（缺口 15：agent 的 voiceSpentUsd）；不给则不报这一项。 */
  voice_usd?: number | null;
  /** spent_usd + delegate_usd + voice_usd（本次运行合计）；任一缺失则为 null。 */
  run_total_usd?: number | null;
  /** 算不出金额的原因（unpriced / missing 时有值）。 */
  reason?: string;
}

/** 从一轮的用量快照与已算好的 CostEstimate 拼看板快照（纯函数）。 */
export function buildDashboardSnapshot(input: {
  turn: number;
  maxTurns: number;
  snapshot: UsageSnapshot;
  estimate: CostEstimate;
  /** 已完成子任务的计价花费（agent 的 delegateSpentUsd）；不给则不报这一项。 */
  delegateUsd?: number | null;
  /** 本次运行已计价的语音花费（agent 的 voiceSpentUsd）；不给则不报这一项。 */
  voiceUsd?: number | null;
}): DashboardSnapshot {
  const s = input.snapshot;
  const e = input.estimate;
  const extraUsd = (typeof input.delegateUsd === "number" && Number.isFinite(input.delegateUsd) ? input.delegateUsd : 0)
    + (typeof input.voiceUsd === "number" && Number.isFinite(input.voiceUsd) ? input.voiceUsd : 0);
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
    ...(extraUsd > 0
      ? {
        ...(typeof input.delegateUsd === "number" && input.delegateUsd > 0 ? { delegate_usd: input.delegateUsd } : {}),
        ...(typeof input.voiceUsd === "number" && input.voiceUsd > 0 ? { voice_usd: input.voiceUsd } : {}),
        run_total_usd: e.spentUsd === null ? null : e.spentUsd + extraUsd,
      }
      : {}),
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
  return typeof v === "number" ? v.toLocaleString("en-US") : t("usage.notReported");
}

/** 看板一行（TUI / ToolPrinter 用）：紧凑、可断言，缺数就写"未知"。 */
/**
 * 成本原因：cost.ts 产出的是中文原文（--json 事件里原样保留，不改），终端看板行按界面语言显示。
 * 认不出的原因原样返回。
 */
export function localizeCostReason(reason: string): string {
  const known: [string, string][] = [
    ["未配置该模型的单价（config.pricing），无法计算金额", t("cost.noPricing")],
    ["provider 未上报 usage，无法计算金额", t("cost.noUsage")],
    ["usage 里没有可用的 token 数", t("cost.noTokens")],
  ];
  for (const [zh, out] of known) if (reason === zh) return out;
  const m = /^有 (\d+) 次调用未上报 usage，金额不完整，不做超支判定$/.exec(reason);
  if (m) return t("cost.missing", { n: m[1] });
  return reason;
}

export function formatDashboardLine(snap: DashboardSnapshot): string {
  const turn = typeof snap.turn === "number" ? snap.turn : 0;
  const maxTurns = typeof snap.max_turns === "number" ? snap.max_turns : 0;
  const head = t("dash.head", { turn, max: maxTurns });
  const tokens = `Token ${fmtTokens(snap.prompt_tokens)}/${fmtTokens(snap.completion_tokens)}`;
  const ctx = typeof snap.context_remaining_tokens === "number"
    ? t("dash.ctxLeft", { n: snap.context_remaining_tokens.toLocaleString("en-US") })
    : t("dash.ctxUnknown");
  if (snap.status === "priced" && typeof snap.spent_usd === "number") {
    const spent = `$${snap.spent_usd.toFixed(4)}`;
    const limit = snap.limit_usd === null
      ? t("dash.noLimit")
      : t("dash.limit", { limit: `$${snap.limit_usd.toFixed(2)}`, left: `$${(snap.remaining_usd ?? 0).toFixed(4)}` });
    // 委派花费是单 agent 口径的旁路：不报会让人以为整轮只花了这么多。
    const delegate = typeof snap.delegate_usd === "number" && snap.delegate_usd > 0
      ? t("dash.delegate", {
        delegate: `$${snap.delegate_usd.toFixed(4)}`,
        total: typeof snap.run_total_usd === "number" ? `$${snap.run_total_usd.toFixed(4)}` : "?",
      })
      : "";
    return t("dash.priced", { head, spent: spent + delegate, limit, tokens, ctx });
  }
  return t("dash.unpriced", { head, reason: snap.reason ? localizeCostReason(snap.reason) : t("dash.noData"), tokens, ctx });
}

/**
 * REPL 状态行用的成本段：有估算才返回字符串，否则返回 null（状态行保持原样）。
 * priced：`成本 $0.0123/$0.50`（无上限时只写已花费）；unpriced/missing：`成本未知`。
 */
export function dashboardCostSegment(estimate: CostEstimate | null | undefined): string | null {
  if (!estimate) return null;
  if (estimate.status === "priced" && typeof estimate.spentUsd === "number") {
    return estimate.limitUsd === null
      ? t("status.cost", { cost: `$${estimate.spentUsd.toFixed(4)}` })
      : t("status.cost", { cost: `$${estimate.spentUsd.toFixed(4)}/$${estimate.limitUsd.toFixed(2)}` });
  }
  return t("status.costUnknown");
}
