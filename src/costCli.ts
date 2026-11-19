// src/costCli.ts — P2-1：`nyra cost` 子命令。
//
//   nyra cost --estimate "<task>" [--turns N] [--system-chars N] [--model M]
//   nyra cost --show                    当前定价配置
//
// 输出原则：给区间 + 明写假设。不打印"精确预估"这种骗人的数字。
import { estimateRunCost, resolvePricing, formatCost, estimateCost, adjustEstimateForRecall, resolveMonthlyLimit, type Pricing } from "./cost.ts";
import { UsageLedger, monthKeyString, nextMonthlyResetDate } from "./usageLedger.ts";
import { McpCostTracker } from "./mcpCost.ts";
import type { UsageSnapshot } from "./usage.ts";
import { t } from "./i18n.ts";

function parseFlags(argv: string[]): { estimate?: string; show: boolean; turns: number; systemChars: number; model?: string } {
  const out = { estimate: undefined as string | undefined, show: false, turns: 20, systemChars: 2000, model: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--show") out.show = true;
    else if (a === "--estimate") out.estimate = next();
    else if (a === "--turns") out.turns = parseInt(next() ?? "20", 10);
    else if (a === "--system-chars") out.systemChars = parseInt(next() ?? "2000", 10);
    else if (a === "--model") out.model = next();
    else if (!a.startsWith("-") && out.estimate === undefined) out.estimate = a;
  }
  return out;
}

function printPricingTable(config: Record<string, unknown>, home?: string): void {
  const table = config.pricing;
  const entries = table && typeof table === "object" ? Object.entries(table as Record<string, unknown>) : [];
  if (entries.length === 0) {
    process.stdout.write(t("cost.pricingEmpty") + "\n");
    process.stdout.write(t("cost.pricingNoGuess") + "\n");
  } else {
    process.stdout.write(t("cost.pricingHead") + "\n");
    for (const [model, raw] of entries) {
      const p = resolvePricing({ [model]: raw }, model);
      if (!p) {
        process.stdout.write(`  ${model}：配置无效（已忽略）\n`);
        continue;
      }
      process.stdout.write(`  ${model}：输入 $${p.inputPer1M} / 输出 $${p.outputPer1M}\n`);
    }
  }
  const limit = typeof config.max_cost_usd === "number" ? config.max_cost_usd : null;
  process.stdout.write(t("cost.limitLine", { limit: limit === null ? t("cost.limitUnset") : "$" + limit.toFixed(2) }) + "\n");
  // 缺口 29：月度上限与本月已花（与 --max-cost 同口径的账本数）。
  if (home) {
    const month = monthKeyString();
    const llm = new UsageLedger(home).monthTotal(month);
    const mcp = new McpCostTracker(home).monthTotalUsd(month);
    const monthly = resolveMonthlyLimit(config);
    const spent = llm.spentUsd + mcp;
    if (monthly === null) {
      process.stdout.write(t("cost.monthlyUnset", { spent: spent.toFixed(4), mcp: mcp.toFixed(4) }) + "\n");
    } else {
      process.stdout.write(t("cost.monthlyLine", {
        limit: monthly.toFixed(2), spent: spent.toFixed(4),
        mcp: mcp.toFixed(4), reset: nextMonthlyResetDate(),
      }) + "\n");
    }
  }
}

export function handleCost(argv: string[], config: Record<string, unknown>, model: string | null, opts?: { recalledCount?: number; home?: string }): number {
  const flags = parseFlags(argv);
  if (flags.show || (!flags.estimate && !flags.show)) {
    printPricingTable(config, opts?.home);
    if (!flags.estimate) return 0;
  }

  const task = flags.estimate ?? "";
  if (!task.trim()) {
    process.stderr.write("用法：nyra cost --estimate \"<任务>\"; nyra cost --show\n");
    return 2;
  }

  const useModel = flags.model ?? model;
  const pricing: Pricing | null = resolvePricing(config.pricing, useModel);
  if (!pricing) {
    process.stdout.write(t("cost.cannotEstimate", { model: useModel ?? "(未配置)" }) + "\n");
    process.stdout.write(t("cost.pricingExample") + "\n");
    return 0;
  }

  const est = estimateRunCost({
    taskChars: [...task].length,
    systemChars: flags.systemChars,
    turns: Number.isFinite(flags.turns) && flags.turns > 0 ? flags.turns : 20,
    pricing,
  });

  const money = (v: number) => `$${v.toFixed(4)}`;
  process.stdout.write(t("cost.title", { model: useModel ?? "", in: pricing.inputPer1M, out: pricing.outputPer1M }) + "\n");
  process.stdout.write(t("cost.taskLen", { chars: [...task].length, sys: flags.systemChars }) + "\n");
  process.stdout.write(t("cost.optimistic", { turns: Math.min(2, flags.turns), usd: money(est.optimisticUsd) }) + "\n");
  process.stdout.write(t("cost.typical", { turns: Math.max(1, Math.ceil(flags.turns / 2)), usd: money(est.typicalUsd) }) + "\n");
  process.stdout.write(t("cost.pessimistic", { turns: flags.turns, usd: money(est.pessimisticUsd) }) + "\n");
  process.stdout.write(t("cost.tokens", { prompt: est.tokens.prompt.toLocaleString(), completion: est.tokens.completion.toLocaleString() }) + "\n");
  process.stdout.write("\n" + t("cost.assumptions") + "\n");
  for (const a of est.assumptions) process.stdout.write(`  - ${a}\n`);
  // 回忆感知：有历史可复用时给出下调后的投影（假设写死在 adjustEstimateForRecall 里）
  if (typeof opts?.recalledCount === "number") {
    const adj = adjustEstimateForRecall(est, opts.recalledCount, { turns: flags.turns, pricing });
    process.stdout.write("\n" + adj.note + "\n");
    if (adj.savedTurns > 0) {
      process.stdout.write(t("cost.recallAdjusted", {
        before: est.pessimisticUsd.toFixed(4),
        after: adj.pessimisticUsd.toFixed(4),
      }) + "\n");
    }
  }
  process.stdout.write("\n" + t("cost.suggest", { usd: est.pessimisticUsd.toFixed(2) }) + "\n");
  return 0;
}

/** 供 doctor/自检复用：把一次已结束运行的成本摘要成一行。 */
export function summarizeRunCost(snapshot: UsageSnapshot, config: Record<string, unknown>, model: string | null, limit: number | null): string {
  return formatCost(estimateCost(snapshot, resolvePricing(config.pricing, model), limit));
}
