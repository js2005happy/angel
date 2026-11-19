// tests/node/test-cost-recall.test.ts — 回忆感知的成本估算。
// 原则：投影必须**明说假设**、有上限，不能因为"有 10 条历史"就宣称几乎不用跑。
import { test, expect } from "bun:test";
import {
  estimateRunCost, adjustEstimateForRecall,
  TURNS_SAVED_PER_RECALL, MAX_RECALL_TURN_SAVING_RATIO,
} from "../../src/cost.ts";

const PRICING = { inputPer1M: 1, outputPer1M: 2 };
const base = estimateRunCost({ taskChars: 100, systemChars: 2000, turns: 10, pricing: PRICING });

test("没有历史：原样返回，并说明按从零探索计算", () => {
  const r = adjustEstimateForRecall(base, 0, { turns: 10, pricing: PRICING });
  expect(r.savedTurns).toBe(0);
  expect(r.savingRatio).toBe(0);
  expect(r.pessimisticUsd).toBe(base.pessimisticUsd);
  expect(r.note).toContain("没有可复用");
});

test("每条历史省固定轮次", () => {
  const r = adjustEstimateForRecall(base, 1, { turns: 10, pricing: PRICING });
  expect(r.savedTurns).toBe(TURNS_SAVED_PER_RECALL);
});

test("节省有上限（不是历史越多越省）", () => {
  const r = adjustEstimateForRecall(base, 100, { turns: 10, pricing: PRICING });
  expect(r.savedTurns).toBe(Math.floor(10 * MAX_RECALL_TURN_SAVING_RATIO));
  expect(r.note).toContain("40%");
});

test("1 轮任务不会被省成 0 轮", () => {
  const one = estimateRunCost({ taskChars: 10, systemChars: 0, turns: 1, pricing: PRICING });
  expect(adjustEstimateForRecall(one, 5, { turns: 1, pricing: PRICING }).savedTurns).toBe(0);
});

test("金额真的下降，且比例在 0-1 之间", () => {
  const r = adjustEstimateForRecall(base, 2, { turns: 10, pricing: PRICING });
  expect(r.pessimisticUsd).toBeLessThan(base.pessimisticUsd);
  expect(r.savingRatio).toBeGreaterThan(0);
  expect(r.savingRatio).toBeLessThan(1);
});

test("note 里带上历史条数与假设", () => {
  const r = adjustEstimateForRecall(base, 3, { turns: 10, pricing: PRICING });
  expect(r.note).toContain("3 条历史");
  expect(r.note).toContain("每条省");
});

test("负数/NaN 历史数不会算出负节省", () => {
  for (const n of [-5, Number.NaN]) {
    const r = adjustEstimateForRecall(base, n, { turns: 10, pricing: PRICING });
    expect(r.savedTurns).toBeGreaterThanOrEqual(0);
    expect(r.pessimisticUsd).toBeLessThanOrEqual(base.pessimisticUsd + 1e-9);
  }
});
