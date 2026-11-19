// src/costCli.ts — P2-1：`nyra cost` 子命令。
//
//   nyra cost --estimate "<task>" [--turns N] [--system-chars N] [--model M]
//   nyra cost --show                    当前定价配置
//
// 输出原则：给区间 + 明写假设。不打印"精确预估"这种骗人的数字。
import { estimateRunCost, resolvePricing, formatCost, estimateCost, type Pricing } from "./cost.ts";
import type { UsageSnapshot } from "./usage.ts";

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

function printPricingTable(config: Record<string, unknown>): void {
  const table = config.pricing;
  const entries = table && typeof table === "object" ? Object.entries(table as Record<string, unknown>) : [];
  if (entries.length === 0) {
    process.stdout.write("定价配置：空（config.pricing 里按模型配 input_per_1m / output_per_1m）\n");
    process.stdout.write("未配单价时金额一律显示为「未知」，不会瞎猜。\n");
    return;
  }
  process.stdout.write("定价配置（美元 / 百万 token）：\n");
  for (const [model, raw] of entries) {
    const p = resolvePricing({ [model]: raw }, model);
    if (!p) {
      process.stdout.write(`  ${model}：配置无效（已忽略）\n`);
      continue;
    }
    process.stdout.write(`  ${model}：输入 $${p.inputPer1M} / 输出 $${p.outputPer1M}\n`);
  }
  const limit = typeof config.max_cost_usd === "number" ? config.max_cost_usd : null;
  process.stdout.write(`单次运行上限：${limit === null ? "未设置（建议设置 max_cost_usd）" : "$" + limit.toFixed(2)}\n`);
}

export function handleCost(argv: string[], config: Record<string, unknown>, model: string | null): number {
  const flags = parseFlags(argv);
  if (flags.show || (!flags.estimate && !flags.show)) {
    printPricingTable(config);
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
    process.stdout.write(`无法估算：模型 ${useModel ?? "(未配置)"} 没有单价。\n`);
    process.stdout.write("先配 config.pricing，例如：{\"deepseek-v4-pro\": {\"input_per_1m\": 0.28, \"output_per_1m\": 0.42}}\n");
    return 0;
  }

  const est = estimateRunCost({
    taskChars: [...task].length,
    systemChars: flags.systemChars,
    turns: Number.isFinite(flags.turns) && flags.turns > 0 ? flags.turns : 20,
    pricing,
  });

  const money = (v: number) => `$${v.toFixed(4)}`;
  process.stdout.write(`成本估算（模型 ${useModel}，输入 $${pricing.inputPer1M}/M、输出 $${pricing.outputPer1M}/M）\n`);
  process.stdout.write(`  任务长度：${[...task].length} 字符，系统提示词按 ${flags.systemChars} 字符计\n`);
  process.stdout.write(`  乐观（${
    Math.min(2, flags.turns)
  } 轮）：${money(est.optimisticUsd)}\n`);
  process.stdout.write(`  典型（${Math.max(1, Math.ceil(flags.turns / 2))} 轮）：${money(est.typicalUsd)}\n`);
  process.stdout.write(`  悲观（${flags.turns} 轮）：${money(est.pessimisticUsd)}\n`);
  process.stdout.write(`  token 口径：prompt ${est.tokens.prompt.toLocaleString()} / completion ${est.tokens.completion.toLocaleString()}\n`);
  process.stdout.write("\n假设（请逐条确认是否成立）：\n");
  for (const a of est.assumptions) process.stdout.write(`  - ${a}\n`);
  process.stdout.write("\n建议：`--max-cost " + est.pessimisticUsd.toFixed(2) + "` 可把最坏情况封顶。\n");
  return 0;
}

/** 供 doctor/自检复用：把一次已结束运行的成本摘要成一行。 */
export function summarizeRunCost(snapshot: UsageSnapshot, config: Record<string, unknown>, model: string | null, limit: number | null): string {
  return formatCost(estimateCost(snapshot, resolvePricing(config.pricing, model), limit));
}
