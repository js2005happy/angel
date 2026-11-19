// tests/node/test-model-savings.test.ts — 辅助模型到底省了多少钱（用账本算，不靠估）。
//
// 背景：`nyra savings` 对 aux_model_routing 只能写「单价差决定省多少，未配 pricing 时算不出」。
// 但账本每笔都记了 model + tokens + spent_usd，可以拿「主模型单价 × 该笔 tokens」做反事实，
// 与实际花费相减 —— 这是**实测**，不是估算。
//
// 纪律：
//   S1 只算能算的：缺 model / 缺主模型单价 → 不进合计，计入 unknownCalls
//   S2 反事实用同一份 tokens，prompt/completion 分开计价
//   S3 省下的可能是负数（辅助模型更贵）——照实报，不取绝对值
import { test, expect } from "bun:test";
import { summarizeModelSavings, formatModelSavings } from "../../src/modelSavings.ts";
import type { LedgerRecord } from "../../src/usageLedger.ts";

const MAIN_PRICING = { inputPer1M: 10, outputPer1M: 30 };

function rec(o: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    date: "2026-11-20", month: "2026-11",
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    calls: 1, spent_usd: null, model: null,
    ...o,
  } as LedgerRecord;
}

test("只列非主模型的记录（主模型花费单列，不进节省）", () => {
  const r = summarizeModelSavings([
    rec({ model: "main", prompt_tokens: 1000, completion_tokens: 500, spent_usd: 0.025 }),
    rec({ model: "cheap", prompt_tokens: 1000, completion_tokens: 500, spent_usd: 0.002 }),
  ], { mainModel: "main", mainPricing: MAIN_PRICING });
  expect(r.rows.map((x) => x.model)).toEqual(["cheap"]);
  expect(r.mainSpentUsd).toBeCloseTo(0.025, 10);
});

test("S2 反事实按 prompt/completion 两段计价", () => {
  const r = summarizeModelSavings([
    rec({ model: "cheap", prompt_tokens: 1000, completion_tokens: 500, spent_usd: 0.002 }),
  ], { mainModel: "main", mainPricing: MAIN_PRICING });
  // 1000/1e6*10 + 500/1e6*30 = 0.01 + 0.015 = 0.025
  expect(r.rows[0].counterfactualUsd).toBeCloseTo(0.025, 10);
  expect(r.rows[0].savedUsd).toBeCloseTo(0.023, 10);
  expect(r.totalSavedUsd).toBeCloseTo(0.023, 10);
});

test("S1 没有主模型单价 → 反事实与节省都是 null，并计入 unknownCalls", () => {
  const r = summarizeModelSavings([
    rec({ model: "cheap", prompt_tokens: 1000, completion_tokens: 500, spent_usd: 0.002 }),
  ], { mainModel: "main", mainPricing: null });
  expect(r.rows[0].counterfactualUsd).toBeNull();
  expect(r.rows[0].savedUsd).toBeNull();
  expect(r.totalSavedUsd).toBe(0);
  expect(r.unknownCalls).toBeGreaterThanOrEqual(1);
});

test("S1 没有 model 名 → 不进 rows，计 unknown", () => {
  const r = summarizeModelSavings([rec({ model: null, prompt_tokens: 10, spent_usd: 0.01 })],
    { mainModel: "main", mainPricing: MAIN_PRICING });
  expect(r.rows).toEqual([]);
  expect(r.unknownCalls).toBeGreaterThanOrEqual(1);
});

test("没有实际花费（未计价）→ 节省也算不出", () => {
  const r = summarizeModelSavings([rec({ model: "cheap", prompt_tokens: 100, spent_usd: null })],
    { mainModel: "main", mainPricing: MAIN_PRICING });
  expect(r.rows[0].actualUsd).toBeNull();
  expect(r.rows[0].savedUsd).toBeNull();
});

test("S3 辅助模型更贵 → 负节省照实报，文案写「多花」", () => {
  const r = summarizeModelSavings([rec({ model: "pricey", prompt_tokens: 1000, completion_tokens: 500, spent_usd: 0.5 })],
    { mainModel: "main", mainPricing: MAIN_PRICING });
  expect(r.rows[0].savedUsd).toBeLessThan(0);
  expect(formatModelSavings(r)).toContain("多花");
});

test("多笔同模型累加（不是取最后一笔）", () => {
  const r = summarizeModelSavings([
    rec({ model: "cheap", prompt_tokens: 1000, completion_tokens: 0, spent_usd: 0.001 }),
    rec({ model: "cheap", prompt_tokens: 1000, completion_tokens: 0, spent_usd: 0.001 }),
  ], { mainModel: "main", mainPricing: MAIN_PRICING });
  expect(r.rows[0].calls).toBe(2);
  expect(r.rows[0].prompt_tokens).toBe(2000);
  expect(r.rows[0].actualUsd).toBeCloseTo(0.002, 10);
});

test("排序：省得多的在前", () => {
  const r = summarizeModelSavings([
    rec({ model: "small-save", prompt_tokens: 1000, completion_tokens: 0, spent_usd: 0.009 }),
    rec({ model: "big-save", prompt_tokens: 1000, completion_tokens: 0, spent_usd: 0.001 }),
  ], { mainModel: "main", mainPricing: MAIN_PRICING });
  expect(r.rows.map((x) => x.model)).toEqual(["big-save", "small-save"]);
});

test("空账本：文案明说没有非主模型用量（不谎报节省）", () => {
  expect(formatModelSavings(summarizeModelSavings([], { mainModel: "main", mainPricing: MAIN_PRICING })))
    .toContain("没有非主模型的用量记录");
});

test("明细行包含次数、实际、主模型口径与省额", () => {
  const text = formatModelSavings(summarizeModelSavings([
    rec({ model: "cheap", prompt_tokens: 1000, completion_tokens: 500, spent_usd: 0.002 }),
  ], { mainModel: "main", mainPricing: MAIN_PRICING }));
  expect(text).toContain("1 次");
  expect(text).toContain("实际 $0.0020");
  expect(text).toContain("主模型口径 $0.0250");
  expect(text).toContain("省 $0.0230");
});
