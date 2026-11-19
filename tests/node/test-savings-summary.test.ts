// tests/node/test-savings-summary.test.ts — 省钱机制汇总成一张单页。
// 核心纪律：**算不出的项不填 0**（0 会被读成"没省"），只把真正可加的项加总。
import { test, expect } from "bun:test";
import { summarizeSavings, formatSavings } from "../../src/savingsSummary.ts";

function tool(name: string, size = 400) {
  return { type: "function", function: { name, description: "x".repeat(size), parameters: {} } };
}

const SCHEMAS = [tool("read_file"), tool("shell", 800), tool("computer_use", 2000)];

test("六项机制都出现在汇总里（不多不少）", () => {
  const s = summarizeSavings({ config: {}, schemas: SCHEMAS });
  expect(s.lines.map((l) => l.mechanism)).toEqual([
    "disable_tool", "tool_search", "aux_model_routing", "reasoning_effort", "run_recall", "cost_cap",
  ]);
});

test("工具裁剪：有数字且计入可加总量", () => {
  const s = summarizeSavings({ config: {}, schemas: SCHEMAS, disabledTools: ["computer_use"] });
  const toolLine = s.lines.find((l) => l.mechanism === "disable_tool")!;
  expect(toolLine.enabled).toBe(true);
  expect(toolLine.tokensPerTurnSaved).toBeGreaterThan(0);
  expect(s.tokensPerTurnTotal).toBe(toolLine.tokensPerTurnSaved);
});

test("未裁剪时明确写 0（这是真的没省，不是算不出）", () => {
  const s = summarizeSavings({ config: {}, schemas: SCHEMAS });
  expect(s.lines.find((l) => l.mechanism === "disable_tool")!.tokensPerTurnSaved).toBe(0);
  expect(s.tokensPerTurnTotal).toBe(0);
});

test("算不出的项必须是 null 而不是 0", () => {
  const s = summarizeSavings({ config: { compact_model: "cheap", model: "main" }, schemas: SCHEMAS });
  const aux = s.lines.find((l) => l.mechanism === "aux_model_routing")!;
  expect(aux.enabled).toBe(true);
  expect(aux.tokensPerTurnSaved).toBeNull(); // 取决于单价差，静态算不出
  expect(aux.additive).toBe(false);
});

test("未知项计入 unknownCount，且不进总量", () => {
  const s = summarizeSavings({ config: { reasoning_effort: "low" }, schemas: SCHEMAS });
  expect(s.unknownCount).toBeGreaterThanOrEqual(3);
  expect(s.tokensPerTurnTotal).toBe(0);
  expect(s.verdict).toContain("无法静态量化");
});

test("回忆：未统计与有 N 条两种表述都正确", () => {
  const noStat = summarizeSavings({ config: {}, schemas: SCHEMAS, recallCount: null });
  expect(noStat.lines.find((l) => l.mechanism === "run_recall")!.effect).toContain("未统计");
  const withStat = summarizeSavings({ config: {}, schemas: SCHEMAS, recallCount: 2 });
  expect(withStat.lines.find((l) => l.mechanism === "run_recall")!.effect).toContain("2 条");
});

test("成本硬顶：显示具体上限，未设时明确警告", () => {
  expect(summarizeSavings({ config: { max_cost_usd: 3 }, schemas: SCHEMAS })
    .lines.find((l) => l.mechanism === "cost_cap")!.effect).toContain("$3");
  expect(summarizeSavings({ config: {}, schemas: SCHEMAS })
    .lines.find((l) => l.mechanism === "cost_cap")!.effect).toContain("无限烧钱");
});

test("总轮次折算：给了 turns 才有总量", () => {
  const s = summarizeSavings({ config: {}, schemas: SCHEMAS, disabledTools: ["computer_use"], turns: 10 });
  expect(s.verdict).toContain("10 轮共");
});

test("全都没开时结论直说，不粉饰", () => {
  const s = summarizeSavings({ config: {}, schemas: [] });
  expect(s.verdict).toMatch(/都没开|没有可静态相加/);
});

test("formatSavings 每项都有一行，且带解释尾巴", () => {
  const text = formatSavings(summarizeSavings({ config: {}, schemas: SCHEMAS }));
  for (const m of ["disable_tool", "tool_search", "aux_model_routing", "reasoning_effort", "run_recall", "cost_cap"]) {
    expect(text).toContain(m);
  }
  expect(text).toContain("不填 0");
});

test("与红线合并：顺序为红线在前、省钱在后，且带明确过渡标题", () => {
  const text = formatRedlinesWithSavings("上线红线自检：红线全绿", summarizeSavings({ config: {}, schemas: SCHEMAS }));
  expect(text.indexOf("上线红线自检")).toBeLessThan(text.indexOf("省钱机制"));
  expect(text).toContain("—— 省钱机制（上了之后能省多少）——");
});

test("与红线合并：两段各自内容都完整保留（不是互相覆盖）", () => {
  const savings = summarizeSavings({ config: {}, schemas: SCHEMAS, disabledTools: ["computer_use"], turns: 10 });
  const text = formatRedlinesWithSavings("上线红线自检：可运行", savings);
  expect(text).toContain("上线红线自检：可运行");
  expect(text).toContain("每轮可确定省下");
  expect(text).toContain("10 轮共");
});