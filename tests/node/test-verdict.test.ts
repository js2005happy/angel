// tests/node/test-verdict.test.ts — 一条结论：这次跑得值不值。
//
// 背景：redlines / savings / recall / 运行历史是四张分散的表。工具多了没人愿意拼，
// 于是「值不值」这个唯一该看的判断被省略。
//
// 规则（顺序即优先级）：
//   V1 红线有 fail → red（证据不过关，省再多也不值）
//   V2 无红线数据 → yellow（未知不当作通过）
//   V3 红线有 warn → yellow（能跑，但红线未设）
//   V4 无成本上限 → yellow + 阻断项
//   V5 全都齐 → green
//   V6 缺数据进 unknowns，不当作通过
import { test, expect } from "bun:test";
import { buildVerdict, formatVerdict } from "../../src/verdict.ts";
import type { RedlineResult } from "../../src/redlines.ts";
import type { SavingsSummary } from "../../src/savingsSummary.ts";

function redlines(fails = 0, warns = 0): RedlineResult {
  const findings = [
    ...Array.from({ length: fails }, (_, i) => ({ level: "fail" as const, code: `f${i}`, title: "", detail: "" })),
    ...Array.from({ length: warns }, (_, i) => ({ level: "warn" as const, code: `w${i}`, title: "", detail: "" })),
    { level: "ok" as const, code: "consistent", title: "", detail: "" },
  ];
  return { ok: fails === 0, verdict: "", findings } as RedlineResult;
}

function savings(capOn = true): SavingsSummary {
  return {
    lines: [
      { mechanism: "disable_tool", enabled: true, effect: "", tokensPerTurnSaved: 835, additive: true, source: "" },
      { mechanism: "cost_cap", enabled: capOn, effect: "", tokensPerTurnSaved: null, additive: false, source: "" },
    ],
    tokensPerTurnTotal: 835,
    unknownCount: 4,
    verdict: "",
  } as SavingsSummary;
}

test("V1 红线有 fail → red（省得多也不改结论）", () => {
  const v = buildVerdict({ redlines: redlines(2), savings: savings(), recallAvailable: 3 });
  expect(v.grade).toBe("red");
  expect(v.blockers.some((b) => b.includes("2 条红线被踩"))).toBe(true);
});

test("V2 什么都不传 → yellow，且未知项 ≥ 3", () => {
  const v = buildVerdict({});
  expect(v.grade).toBe("yellow");
  expect(v.unknowns.length).toBeGreaterThanOrEqual(3);
});

test("V3 有 warn → yellow（不能因为没 fail 就算全绿）", () => {
  expect(buildVerdict({ redlines: redlines(0, 2), savings: savings(), recallAvailable: 1 }).grade).toBe("yellow");
});

test("V4 没有成本上限 → yellow + 阻断项", () => {
  const v = buildVerdict({ redlines: redlines(), savings: savings(false), recallAvailable: 1 });
  expect(v.grade).toBe("yellow");
  expect(v.blockers.some((b) => b.includes("成本上限"))).toBe(true);
  expect(v.nextSteps.some((s) => s.includes("max_cost_usd"))).toBe(true);
});

test("V5 全都齐 → green", () => {
  expect(buildVerdict({ redlines: redlines(), savings: savings(), recallAvailable: 2 }).grade).toBe("green");
});

test("轮次折算：每轮 835 × 10 轮", () => {
  const v = buildVerdict({ redlines: redlines(), savings: savings(), recallAvailable: 1, turns: 10 });
  expect(v.reasons.some((r) => r.includes("8350"))).toBe(true);
});

test("实测节省进依据；负数写「多花」", () => {
  const pos = buildVerdict({ redlines: redlines(), savings: savings(), modelSavings: { mainModel: "m", rows: [], unknownCalls: 0, totalSavedUsd: 0.023, mainSpentUsd: 1 } });
  expect(pos.reasons.some((r) => r.includes("实测省 $0.0230"))).toBe(true);
  const neg = buildVerdict({ redlines: redlines(), savings: savings(), modelSavings: { mainModel: "m", rows: [], unknownCalls: 0, totalSavedUsd: -0.5, mainSpentUsd: null } });
  expect(neg.reasons.some((r) => r.includes("多花 $0.5000"))).toBe(true);
});

test("历史全挂（≥3 次、0 验证通过）→ 明确提示 + 指向失败分类", () => {
  const v = buildVerdict({ redlines: redlines(), savings: savings(), runStatusCounts: { failed: 3, verified: 0 } });
  expect(v.reasons.some((r) => r.includes("没有一次通过验证"))).toBe(true);
  expect(v.nextSteps.some((s) => s.includes("失败分类"))).toBe(true);
});

test("历史有通过记录 → 只报统计，不额外告警", () => {
  const v = buildVerdict({ redlines: redlines(), savings: savings(), runStatusCounts: { verified: 2, failed: 1 } });
  expect(v.reasons.some((r) => r.includes("历史 3 次运行"))).toBe(true);
  expect(v.reasons.some((r) => r.includes("没有一次通过验证"))).toBe(false);
});

test("没有历史数据 → 进 unknowns，不当作「没问题」", () => {
  expect(buildVerdict({ redlines: redlines(), savings: savings() }).unknowns.some((u) => u.includes("历史"))).toBe(true);
});

test("nextSteps 最多 3 条（不堆清单）", () => {
  const v = buildVerdict({ redlines: redlines(1, 2), savings: savings(false), runStatusCounts: { failed: 5, verified: 0 } });
  expect(v.nextSteps.length).toBeLessThanOrEqual(3);
});

test("formatVerdict：三个等级各有标记，未知与下一步都渲染", () => {
  expect(formatVerdict(buildVerdict({ redlines: redlines(1), savings: savings() }))).toContain("❌");
  expect(formatVerdict(buildVerdict({ redlines: redlines(0, 1), savings: savings() }))).toContain("⚠️");
  expect(formatVerdict(buildVerdict({ redlines: redlines(), savings: savings(), recallAvailable: 1 }))).toContain("✅");
  const text = formatVerdict(buildVerdict({}));
  expect(text).toContain("未知（不当作通过）");
});
