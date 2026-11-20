// tests/node/test-savings-json.test.ts — `nyra savings --json` 的机器可读契约。
//
// 与 `nyra verdict --json` 同一思路：人看单页（formatSavings），机器拿结构（toSavingsJson）。
// 契约纪律：**只加字段、不改名、不删字段**；`tokens_per_turn_saved` 为 null 表示"算不出"，
// 不是 0——把"不知道"写成 0 会让看板画出假的下降曲线。
import { test, expect } from "bun:test";
import { summarizeSavings, toSavingsJson, SAVINGS_JSON_SCHEMA } from "../../src/savingsSummary.ts";

const schema = (name: string, descLen = 400) => ({
  type: "function",
  function: { name, description: "x".repeat(descLen), parameters: {} },
});

const summary = () =>
  summarizeSavings({ config: {}, schemas: [schema("a"), schema("b", 900)], disabledTools: ["b"], turns: 10 });

test("S1 schema_version 是显式常量（客户端据此判断兼容）", () => {
  expect(SAVINGS_JSON_SCHEMA).toBe(1);
  expect(toSavingsJson(summary()).schema_version).toBe(1);
});

test("S2 字段顺序稳定（契约：只加不改）", () => {
  const j = toSavingsJson(summary());
  expect(Object.keys(j)).toEqual([
    "schema_version", "tokens_per_turn_total", "unknown_count", "lines", "model_savings",
  ]);
});

test("S3 总量与行数与文字版一致（两个视图不能各说各话）", () => {
  const s = summary();
  const j = toSavingsJson(s);
  expect(j.tokens_per_turn_total).toBe(s.tokensPerTurnTotal);
  expect(j.unknown_count).toBe(s.unknownCount);
  expect(j.lines.length).toBe(s.lines.length);
  expect(j.lines.map((l) => l.mechanism)).toEqual(s.lines.map((l) => l.mechanism));
});

test("S4 每一行保留 enabled / additive / tokens_per_turn_saved（含 null）", () => {
  const j = toSavingsJson(summary());
  for (const line of j.lines) {
    expect(typeof line.mechanism).toBe("string");
    expect(typeof line.enabled).toBe("boolean");
    expect(typeof line.additive).toBe("boolean");
    expect(line.tokens_per_turn_saved === null || typeof line.tokens_per_turn_saved === "number").toBe(true);
  }
});

test("S5 未传实测节省时 model_savings 为 null（不编 0）", () => {
  expect(toSavingsJson(summary()).model_savings).toBeNull();
});

test("S6 传了实测节省则带上总量与逐模型行", () => {
  const j = toSavingsJson(summary(), {
    mainModel: "main-model",
    rows: [{ model: "cheap", calls: 2, prompt_tokens: 1000, completion_tokens: 500, actualUsd: 0.002, counterfactualUsd: 0.025, savedUsd: 0.023 }],
    unknownCalls: 1,
    totalSavedUsd: 0.023,
    mainSpentUsd: 1.5,
  } as never);
  expect(j.model_savings?.main_model).toBe("main-model");
  expect(j.model_savings?.total_saved_usd).toBeCloseTo(0.023, 10);
  expect(j.model_savings?.unknown_calls).toBe(1);
  expect(j.model_savings?.rows[0].saved_usd).toBeCloseTo(0.023, 10);
});

test("S7 可 JSON.stringify / parse（看板与 CI 消费）", () => {
  const round = JSON.parse(JSON.stringify(toSavingsJson(summary())));
  expect(round.schema_version).toBe(1);
  expect(Array.isArray(round.lines)).toBe(true);
});

test("S8 数组是浅拷贝：改 JSON 不污染原 summary", () => {
  const s = summary();
  const before = s.lines.length;
  toSavingsJson(s).lines.push({ mechanism: "x", enabled: true, tokens_per_turn_saved: 1, additive: true, effect: "", source: "" });
  expect(s.lines.length).toBe(before);
});
