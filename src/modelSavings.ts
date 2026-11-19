// src/modelSavings.ts — 辅助模型路由到底省了多少钱（用真实账本算，不靠估）。
//
// 现状：`nyra savings` 对 aux_model_routing / tool_model 只能写「单价差决定省多少，
// 未配 pricing 时算不出」。但账本里每一笔都记了 **model + tokens + spent_usd**，
// 于是可以拿「主模型单价 × 该笔 tokens」做**反事实**，与实际花费相减。
//
// 纪律：
//   - 只算**能算的**：某笔没有 model、或主模型没有单价 → 不进合计，计入 unknownCalls
//   - 反事实必须用**同一份 tokens**（prompt/completion 分开计价），不混用总 token
//   - 省下的钱可能是负数（辅助模型比主模型贵）——照实报，不取绝对值
import type { Pricing } from "./cost.ts";
import type { LedgerRecord } from "./usageLedger.ts";

export interface ModelSavingRow {
  model: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** 实际花费；有任一笔记价缺失时为已知部分之和。 */
  actualUsd: number | null;
  /** 若同样 tokens 走主模型要花多少；主模型无单价时为 null。 */
  counterfactualUsd: number | null;
  /** 省下 = 反事实 − 实际；任一侧为 null 时为 null。 */
  savedUsd: number | null;
}

export interface ModelSavingsReport {
  mainModel: string | null;
  rows: ModelSavingRow[];
  /** 有记录但算不出（无 model / 无主模型单价 / 无实际花费）的调用数。 */
  unknownCalls: number;
  /** 可直接相加的节省合计（只含两侧都算得出的行）。 */
  totalSavedUsd: number;
  /** 主模型自己那部分的花费（不进 savings）。 */
  mainSpentUsd: number | null;
}

/** 按 (prompt, completion) 两段计价。 */
function priceOf(p: Pricing | null | undefined, prompt: number, completion: number): number | null {
  if (!p) return null;
  const i = typeof p.inputPer1M === "number" ? p.inputPer1M : null;
  const o = typeof p.outputPer1M === "number" ? p.outputPer1M : null;
  if (i === null || o === null) return null;
  return (prompt / 1_000_000) * i + (completion / 1_000_000) * o;
}

/**
 * 从账本记录里算辅助模型的真实节省。纯函数。
 *
 * `mainPricing` 是**主模型**单价：用它给辅助模型的 tokens 做反事实定价。
 */
export function summarizeModelSavings(
  records: readonly LedgerRecord[],
  opts: { mainModel: string | null; mainPricing: Pricing | null | undefined },
): ModelSavingsReport {
  const main = opts.mainModel;
  const rows = new Map<string, ModelSavingRow>();
  let unknownCalls = 0;
  let totalSavedUsd = 0;
  let mainSpentUsd: number | null = null;

  for (const r of records) {
    const model = typeof r.model === "string" && r.model.trim() ? r.model.trim() : null;
    const prompt = typeof r.prompt_tokens === "number" && Number.isFinite(r.prompt_tokens) ? r.prompt_tokens : 0;
    const completion = typeof r.completion_tokens === "number" && Number.isFinite(r.completion_tokens) ? r.completion_tokens : 0;
    const calls = typeof r.calls === "number" && Number.isFinite(r.calls) ? r.calls : 0;

    if (!model) { unknownCalls += calls || 1; continue; }

    if (main && model === main) {
      if (typeof r.spent_usd === "number") mainSpentUsd = (mainSpentUsd ?? 0) + r.spent_usd;
      continue;
    }

    const row = rows.get(model) ?? {
      model, calls: 0, prompt_tokens: 0, completion_tokens: 0,
      actualUsd: null, counterfactualUsd: null, savedUsd: null,
    };
    row.calls += calls;
    row.prompt_tokens += prompt;
    row.completion_tokens += completion;
    if (typeof r.spent_usd === "number") row.actualUsd = (row.actualUsd ?? 0) + r.spent_usd;
    rows.set(model, row);
  }

  const out: ModelSavingRow[] = [];
  for (const row of rows.values()) {
    const cf = priceOf(opts.mainPricing, row.prompt_tokens, row.completion_tokens);
    row.counterfactualUsd = cf;
    if (cf !== null && row.actualUsd !== null) {
      row.savedUsd = cf - row.actualUsd;
      totalSavedUsd += row.savedUsd;
    } else {
      unknownCalls += row.calls;
    }
    out.push(row);
  }
  out.sort((a, b) => (b.savedUsd ?? -Infinity) - (a.savedUsd ?? -Infinity) || a.model.localeCompare(b.model));
  return { mainModel: main, rows: out, unknownCalls, totalSavedUsd, mainSpentUsd };
}

/** 人类可读：一行说结论，逐模型列明细。 */
export function formatModelSavings(report: ModelSavingsReport): string {
  const lines: string[] = [];
  if (!report.rows.length) {
    lines.push("辅助模型：没有非主模型的用量记录（没开 compact_model / delegate_model / tool_model，或还没跑过）");
    return lines.join("\n");
  }
  const head = report.totalSavedUsd >= 0
    ? `辅助模型：实测省 $${report.totalSavedUsd.toFixed(4)}`
    : `辅助模型：实测**多花** $${Math.abs(report.totalSavedUsd).toFixed(4)}（辅助模型比主模型贵）`;
  lines.push(head + (report.unknownCalls > 0 ? `；另有 ${report.unknownCalls} 次调用算不出（缺单价或缺模型名）` : ""));
  for (const r of report.rows) {
    const saved = r.savedUsd === null ? "省额算不出" : r.savedUsd >= 0 ? `省 $${r.savedUsd.toFixed(4)}` : `多花 $${Math.abs(r.savedUsd).toFixed(4)}`;
    const actual = r.actualUsd === null ? "实际花费未知" : `实际 $${r.actualUsd.toFixed(4)}`;
    const cf = r.counterfactualUsd === null ? "主模型口径未知" : `主模型口径 $${r.counterfactualUsd.toFixed(4)}`;
    lines.push(`  ${r.model}：${r.calls} 次 · ${actual} · ${cf} · ${saved}`);
  }
  return lines.join("\n");
}
