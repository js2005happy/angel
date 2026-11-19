// tests/node/test-tool-budget.test.ts — 工具集常驻 token 成本（先量化再裁剪）。
// 事实基础：工具 schema 每一轮请求都要重发，30 个工具通常是几千 token/轮的纯开销。
import { test, expect } from "bun:test";
import {
  schemaTokens, measureToolBudget, filterSchemas, summarizeSavings,
  estimateRunToolOverhead, formatToolBudget, CHARS_PER_TOKEN,
} from "../../src/toolBudget.ts";

function tool(name: string, descSize = 100) {
  return { type: "function", function: { name, description: "x".repeat(descSize), parameters: { type: "object" } } };
}

const SCHEMAS = [tool("read_file", 300), tool("shell", 900), tool("computer_use", 2000), tool("poppy", 1200)];

test("单工具 token 估算按 CHARS_PER_TOKEN 折算", () => {
  const s = tool("a", 100);
  const json = JSON.stringify(s);
  expect(schemaTokens(s)).toBe(Math.ceil([...json].length / CHARS_PER_TOKEN));
});

test("工具集总成本与最贵排序", () => {
  const b = measureToolBudget(SCHEMAS, 128000);
  expect(b.totalTools).toBe(4);
  expect(b.tokensPerTurn).toBeGreaterThan(0);
  expect(b.byTool[0].name).toBe("computer_use");
  expect(b.contextRatio).toBeGreaterThan(0);
  expect(b.contextRatio).toBeLessThan(1);
});

test("未给上下文窗口时占比为 null（不瞎算）", () => {
  expect(measureToolBudget(SCHEMAS).contextRatio).toBeNull();
});

test("filterSchemas：按名裁剪，返回被移除的名字", () => {
  const { kept, dropped } = filterSchemas(SCHEMAS, ["computer_use"]);
  expect(kept.length).toBe(3);
  expect(dropped).toEqual(["computer_use"]);
});

test("filterSchemas：支持前缀通配 comp*", () => {
  const { dropped } = filterSchemas(SCHEMAS, ["comp*"]);
  expect(dropped).toContain("computer_use");
});

test("filterSchemas：空清单不裁剪（零配置零影响）", () => {
  expect(filterSchemas(SCHEMAS, []).kept.length).toBe(4);
  expect(filterSchemas(SCHEMAS, [""]).kept.length).toBe(4);
});

test("summarizeSavings：算得出省多少与比例", () => {
  const kept = filterSchemas(SCHEMAS, ["computer_use", "poppy"]).kept;
  const s = summarizeSavings(SCHEMAS, kept);
  expect(s.dropped.length).toBe(2);
  expect(s.tokensPerTurnSaved).toBeGreaterThan(0);
  expect(s.ratio).toBeGreaterThan(0.5);
});

test("estimateRunToolOverhead：轮次 × 每轮", () => {
  const perTurn = measureToolBudget(SCHEMAS).tokensPerTurn;
  expect(estimateRunToolOverhead(SCHEMAS, 20).totalTokens).toBe(perTurn * 20);
  // 非法轮次兜底为 1，不产生 0 或 NaN
  expect(estimateRunToolOverhead(SCHEMAS, 0).totalTokens).toBe(perTurn);
  expect(estimateRunToolOverhead(SCHEMAS, -5).totalTokens).toBe(perTurn);
});

test("formatToolBudget：含数量/每轮 token/最贵名单", () => {
  const text = formatToolBudget(measureToolBudget(SCHEMAS, 128000));
  expect(text).toContain("4 个工具");
  expect(text).toContain("每轮约");
  expect(text).toContain("computer_use");
});

test("未命名工具不会让统计崩掉", () => {
  const b = measureToolBudget([{ type: "function" }, { type: "function", function: {} } as never]);
  expect(b.totalTools).toBe(2);
  expect(b.byTool.every((t) => typeof t.name === "string")).toBe(true);
});
