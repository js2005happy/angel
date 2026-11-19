// src/modelRouting.ts — 辅助任务走便宜模型（对齐 Alma 的 Tool Model 思路）。
//
// 为什么这是省钱最大的一刀：一轮 agent 循环里，真正贵的不只是对话输出，还有
// **压缩**（把整段上下文喂进去换一段摘要）和**子任务**（子 agent 从零开始跑）。
// 这两类工作对模型能力要求低得多，却按主模型的价格计费。
//
// 设计纪律：
//   - 只做"路由"，不猜单价：没配就是从主模型回退，并把"没生效"写进备注
//   - 路由目标必须与主模型不同，配置成同一个值等于没配（直接忽略，避免假优化）
//   - 纯函数，便于单测；真正造 provider 在 agent 侧（multiModelFactory）
import type { Pricing } from "./cost.ts";
import { resolvePricing } from "./cost.ts";

export type AuxTask = "compact" | "delegate";

export interface AuxRoutingConfig {
  /** config.compact_model：压缩摘要用的模型。 */
  compactModel?: string;
  /** config.delegate_model：子 Agent 默认模型。 */
  delegateModel?: string;
  /** 主模型，用于"配成同一个就忽略"的判定。 */
  mainModel?: string | null;
}

export interface AuxRouting {
  compact?: string;
  delegate?: string;
  /** 被忽略的配置及原因（展示给用户，不静默吞掉）。 */
  ignored: { key: string; value: string; reason: string }[];
}

function clean(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/**
 * 从 config 解析辅助模型路由。
 *
 * 与主模型相同的配置会被忽略——否则用户以为省了钱，实际还是走主模型。
 */
export function resolveAuxRouting(config: Record<string, unknown> | null | undefined, mainModel?: string | null): AuxRouting {
  const cfg = config ?? {};
  const main = clean(mainModel ?? undefined);
  const out: AuxRouting = { ignored: [] };

  const compact = clean(cfg.compact_model);
  const delegate = clean(cfg.delegate_model);

  for (const [key, value] of [["compact_model", compact], ["delegate_model", delegate]] as const) {
    if (!value) continue;
    if (main && value === main) {
      out.ignored.push({ key, value, reason: "与主模型相同，等于没配，已忽略" });
      continue;
    }
    if (key === "compact_model") out.compact = value;
    else out.delegate = value;
  }
  return out;
}

/** 某个辅助任务实际会用哪个模型（null = 沿用主模型）。 */
export function modelForTask(routing: AuxRouting, task: AuxTask): string | null {
  const picked = task === "compact" ? routing.compact : routing.delegate;
  return picked ?? null;
}

/**
 * 估算"压缩走便宜模型"能省多少：给压缩前后的 token 与两个模型的单价，算差额。
 * 只做演示性估算，不参与运行时决策——实际以 usage 为准。
 */
export function estimateCompactSaving(args: {
  promptTokens: number;
  completionTokens: number;
  main: Pricing;
  aux: Pricing;
}): { mainUsd: number; auxUsd: number; savingUsd: number; savingRatio: number } {
  const cost = (p: Pricing) =>
    (args.promptTokens / 1_000_000) * p.inputPer1M + (args.completionTokens / 1_000_000) * p.outputPer1M;
  const mainUsd = cost(args.main);
  const auxUsd = cost(args.aux);
  const savingUsd = mainUsd - auxUsd;
  return {
    mainUsd,
    auxUsd,
    savingUsd,
    savingRatio: mainUsd > 0 ? savingUsd / mainUsd : 0,
  };
}

/** doctor / redlines 用的一行摘要。 */
export function describeRouting(routing: AuxRouting): string {
  const parts: string[] = [];
  if (routing.compact) parts.push(`压缩 → ${routing.compact}`);
  if (routing.delegate) parts.push(`子任务 → ${routing.delegate}`);
  const head = parts.length ? parts.join("，") : "未配置：压缩与子任务都沿用主模型（成本更高）";
  const ignored = routing.ignored.length ? `；已忽略：${routing.ignored.map((i) => i.key).join("、")}` : "";
  return head + ignored;
}

/** 便捷：给定 pricing 表判断某模型是否有单价（没单价就无法估算节省）。 */
export function hasPricingFor(pricingTable: unknown, model: string | null | undefined): boolean {
  return resolvePricing(pricingTable, model) !== null;
}
