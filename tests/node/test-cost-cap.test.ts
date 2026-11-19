// tests/node/test-cost-cap.test.ts — P2-2：成本可预测（硬顶）。
// 最重要的一条纪律：**算不出金额时绝不编造，也绝不假装封顶**。
import { test, expect } from "bun:test";
import { resolvePricing, computeCostUsd, estimateCost, formatCost } from "../../src/cost.ts";
import type { UsageSnapshot } from "../../src/usage.ts";

const PRICING = { inputPer1M: 1, outputPer1M: 2 };

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    calls: 2, reported_calls: 2, missing_calls: 0,
    prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000,
    prompt_samples: 2, completion_samples: 2, total_samples: 2,
    last_prompt_tokens: 500_000, context_window_tokens: null, context_remaining_tokens: null,
    ...over,
  };
}

test("resolvePricing：精确优先，其次最长前缀，未知模型返回 null", () => {
  const table = {
    "deepseek-v4": { input_per_1m: 0.28, output_per_1m: 0.42 },
    "deepseek-v4-pro": { input_per_1m: 0.5, output_per_1m: 1.5 },
  };
  expect(resolvePricing(table, "deepseek-v4-pro")?.inputPer1M).toBe(0.5);
  expect(resolvePricing(table, "deepseek-v4-flash")?.inputPer1M).toBe(0.28);
  expect(resolvePricing(table, "unknown-model")).toBeNull();
  expect(resolvePricing(null, "x")).toBeNull();
  expect(resolvePricing(table, null)).toBeNull();
});

test("resolvePricing：非法单价条目被忽略，不产生 NaN 金额", () => {
  const table = {
    bad: { input_per_1m: "abc", output_per_1m: 1 },
    negative: { input_per_1m: -1, output_per_1m: 1 },
    good: { input_per_1m: 1, output_per_1m: 2 },
  };
  expect(resolvePricing(table, "bad")).toBeNull();
  expect(resolvePricing(table, "negative")).toBeNull();
  expect(resolvePricing(table, "good")?.outputPer1M).toBe(2);
});

test("computeCostUsd：按百万 token 计价；无 token 返回 null", () => {
  expect(computeCostUsd(1_000_000, 1_000_000, PRICING)).toBeCloseTo(3, 10);
  expect(computeCostUsd(500_000, 0, PRICING)).toBeCloseTo(0.5, 10);
  expect(computeCostUsd(null, null, PRICING)).toBeNull();
});

test("priced：能算出金额并正确判定超支", () => {
  const e = estimateCost(snap(), PRICING, 2.5);
  expect(e.status).toBe("priced");
  expect(e.spentUsd).toBeCloseTo(3, 10);
  expect(e.exceeded).toBe(true);
  expect(e.remainingUsd).toBe(0);
});

test("priced 且未超支：exceeded=false，剩余正确", () => {
  const e = estimateCost(snap(), PRICING, 100);
  expect(e.exceeded).toBe(false);
  expect(e.remainingUsd).toBeCloseTo(97, 10);
});

test("未设上限：有金额但不判超支", () => {
  const e = estimateCost(snap(), PRICING, null);
  expect(e.status).toBe("priced");
  expect(e.limitUsd).toBeNull();
  expect(e.exceeded).toBe(false);
});

test("未配单价：unpriced，金额为 null，不判超支（不编造）", () => {
  const e = estimateCost(snap(), null, 5);
  expect(e.status).toBe("unpriced");
  expect(e.spentUsd).toBeNull();
  expect(e.exceeded).toBe(false);
  expect(e.reason).toContain("未配置");
});

test("provider 未上报 usage：status=missing，金额为 null", () => {
  const e = estimateCost(snap({ reported_calls: 0, missing_calls: 2 }), PRICING, 5);
  expect(e.status).toBe("missing");
  expect(e.spentUsd).toBeNull();
  expect(e.exceeded).toBe(false);
});

test("部分调用未上报：判为 unpriced（绝不把已知部分当全部而低报）", () => {
  const e = estimateCost(snap({ missing_calls: 1 }), PRICING, 100);
  expect(e.status).toBe("unpriced");
  expect(e.spentUsd).toBeNull();
  expect(e.reason).toContain("不完整");
});

test("formatCost：能算与算不出是两种文案", () => {
  expect(formatCost(estimateCost(snap(), PRICING, 2.5))).toContain("上限");
  expect(formatCost(estimateCost(snap(), null, 2.5))).toContain("未知");
});
