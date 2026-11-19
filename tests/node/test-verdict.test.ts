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

// ---- 单次运行的结论（buildRunVerdict）----
import { buildRunVerdict } from "../../src/verdict.ts";

const RUN_BASE = {
  run_id: "r1",
  task: "修 auth 的登录态",
  status: "verified",
  verify_result: { exit_code: 0, passed: true } as Record<string, unknown> | null,
  verify_cmd: "npm test",
  changed_files: ["src/auth.ts"],
  spent_usd: 0.02,
  delegate_spent_usd: 0,
  error: null,
};

test("R1 verified + 退出码 0 → green", () => {
  expect(buildRunVerdict(RUN_BASE).grade).toBe("green");
});

test("R2 verify_failed → red，并给出具体命令让人去复现", () => {
  const v = buildRunVerdict({ ...RUN_BASE, status: "verify_failed", verify_result: { exit_code: 2, passed: false } });
  expect(v.grade).toBe("red");
  expect(v.blockers.some((b) => b.includes("退出码 2"))).toBe(true);
  expect(v.nextSteps.some((s) => s.includes("npm test"))).toBe(true);
});

test("R3 failed → red，带上错误原因", () => {
  const v = buildRunVerdict({ ...RUN_BASE, status: "failed", error: "工具报错" });
  expect(v.grade).toBe("red");
  expect(v.blockers.some((b) => b.includes("工具报错"))).toBe(true);
});

test("R4 completed_unverified → yellow（跑完了但没证据）", () => {
  const v = buildRunVerdict({ ...RUN_BASE, status: "completed_unverified", verify_result: null });
  expect(v.grade).toBe("yellow");
  expect(v.reasons.some((r) => r.includes("没有验证证据"))).toBe(true);
});

test("R5 状态 verified 但没有退出码 → yellow + unknown（状态不能替代证据）", () => {
  const v = buildRunVerdict({ ...RUN_BASE, verify_result: null });
  expect(v.grade).toBe("yellow");
  expect(v.unknowns.some((u) => u.includes("退出码"))).toBe(true);
});

test("R6 passed=false 即便状态 verified 也判 red", () => {
  expect(buildRunVerdict({ ...RUN_BASE, verify_result: { exit_code: 0, passed: false } }).grade).toBe("red");
});

test("R7 花费未知 → 进 unknowns，不当 0", () => {
  const v = buildRunVerdict({ ...RUN_BASE, spent_usd: null, delegate_spent_usd: null });
  expect(v.unknowns.some((u) => u.includes("花费未知"))).toBe(true);
});

test("R8 总花费含子任务", () => {
  const v = buildRunVerdict({ ...RUN_BASE, spent_usd: 0.02, delegate_spent_usd: 0.13 });
  expect(v.reasons.some((r) => r.includes("$0.1500") && r.includes("含子任务 $0.1300"))).toBe(true);
});

test("R9 失败且烧了钱 → 明确劝阻「重跑碰运气」", () => {
  const v = buildRunVerdict({ status: "verify_failed", verify_result: { exit_code: 1 }, spent_usd: 0.05 });
  expect(v.nextSteps.some((s) => s.includes("花了 $0.0500"))).toBe(true);
});

test("R10 未覆盖状态（running）→ yellow + unknown，不当作通过", () => {
  const v = buildRunVerdict({ ...RUN_BASE, status: "running" });
  expect(v.grade).toBe("yellow");
  expect(v.unknowns.length).toBeGreaterThan(0);
});

test("R11 无文件改动但有验证 → 说明可能是查询型任务，不误判", () => {
  const v = buildRunVerdict({ ...RUN_BASE, changed_files: [] });
  expect(v.grade).toBe("green");
  expect(v.reasons.some((r) => r.includes("没有文件改动"))).toBe(true);
});

test("R12 nextSteps 最多 3 条", () => {
  const v = buildRunVerdict({ status: "verify_failed", verify_result: { exit_code: 1 }, spent_usd: 0.5, verify_cmd: "npm test" });
  expect(v.nextSteps.length).toBeLessThanOrEqual(3);
});

// ---- 批量趋势（buildTrendVerdict / summarizeTrend）----
import { buildTrendVerdict, summarizeTrend } from "../../src/verdict.ts";

const R = (status: string, over: Record<string, unknown> = {}) => ({
  run_id: "r", status,
  verify_result: status === "verified" ? { exit_code: 0 } : null,
  spent_usd: 0.02, delegate_spent_usd: 0, ...over,
});

test("T1 没有记录 → yellow + unknown（不谎报趋势）", () => {
  const v = buildTrendVerdict({ runs: [] });
  expect(v.grade).toBe("yellow");
  expect(v.unknowns.length).toBe(1);
});

test("T2 一次都没通过 → red + 阻断项", () => {
  const v = buildTrendVerdict({ runs: [R("failed"), R("verify_failed")] });
  expect(v.grade).toBe("red");
  expect(v.blockers.some((b) => b.includes("没有一次通过验证"))).toBe(true);
});

test("T3 通过率 ≥70% → green", () => {
  expect(buildTrendVerdict({ runs: [R("verified"), R("verified"), R("verified"), R("failed")] }).grade).toBe("green");
});

test("T4 通过率 <70% → yellow", () => {
  expect(buildTrendVerdict({ runs: [R("verified"), R("failed")] }).grade).toBe("yellow");
});

test("T5 单位成本 = 总花费 / 通过次数", () => {
  const s = summarizeTrend({ runs: [R("verified", { spent_usd: 0.1 }), R("verified", { spent_usd: 0.3 })] });
  expect(s.costPerVerifiedUsd).toBeCloseTo(0.2, 10);
});

test("T6 没有通过运行时不谈单位成本（分母为 0）", () => {
  expect(summarizeTrend({ runs: [R("failed", { spent_usd: 0.1 })] }).costPerVerifiedUsd).toBeNull();
});

test("T7 失败严格过半 → 点名，并进 nextSteps", () => {
  const v = buildTrendVerdict({ runs: [R("failed"), R("failed"), R("failed"), R("verified")], failureCounts: { tool_error: 3 } });
  expect(v.reasons.some((r) => r.includes("tool_error"))).toBe(true);
  expect(v.nextSteps.some((s) => s.includes("tool_error"))).toBe(true);
});

test("T8 两类各占一半时不点名（点名是误导）", () => {
  const s = summarizeTrend({ runs: [R("failed"), R("failed")], failureCounts: { a: 1, b: 1 } });
  expect(s.dominantFailure).toBeNull();
});

test("T9 未验证既不算通过也不算失败", () => {
  const s = summarizeTrend({ runs: [R("completed_unverified"), R("completed_unverified")] });
  expect(s.unverified).toBe(2);
  expect(s.verified).toBe(0);
  expect(s.failed).toBe(0);
});

test("T10 花费全未知 → 单位成本 null，但统计照出", () => {
  const s = summarizeTrend({ runs: [R("verified", { spent_usd: null, delegate_spent_usd: null })] });
  expect(s.costPerVerifiedUsd).toBeNull();
  expect(s.verified).toBe(1);
});

test("T11 nextSteps 最多 3 条", () => {
  const v = buildTrendVerdict({ runs: [R("failed"), R("failed"), R("verified")], failureCounts: { tool_error: 2 } });
  expect(v.nextSteps.length).toBeLessThanOrEqual(3);
});

test("T12 通过率写进依据（百分比取整）", () => {
  const v = buildTrendVerdict({ runs: [R("verified"), R("verified"), R("verified"), R("failed")] });
  expect(v.reasons.some((r) => r.includes("75%"))).toBe(true);
});

// ---- 机器可读输出（toVerdictJson）----
import { toVerdictJson, VERDICT_JSON_SCHEMA } from "../../src/verdict.ts";

test("J1 字段顺序稳定（契约：只加不改）", () => {
  const j = toVerdictJson(buildVerdict({}), "config");
  expect(Object.keys(j)).toEqual([
    "schema_version", "kind", "grade", "headline", "reasons", "blockers", "next_steps", "unknowns",
  ]);
});

test("J2 schema_version 是显式常量（客户端可据此判断兼容）", () => {
  expect(VERDICT_JSON_SCHEMA).toBe(1);
  expect(toVerdictJson(buildVerdict({}), "run").schema_version).toBe(1);
});

test("J3 kind 区分三种结论（config / run / trend）", () => {
  const v = buildVerdict({});
  expect(toVerdictJson(v, "config").kind).toBe("config");
  expect(toVerdictJson(v, "run").kind).toBe("run");
  expect(toVerdictJson(v, "trend").kind).toBe("trend");
});

test("J4 grade 与 headline 原样搬运", () => {
  const v = buildVerdict({ redlines: redlines(1), savings: savings() });
  const j = toVerdictJson(v, "config");
  expect(j.grade).toBe(v.grade);
  expect(j.headline).toBe(v.headline);
});

test("J5 数组是浅拷贝：改 JSON 不污染原结论", () => {
  const v = buildVerdict({});
  const before = v.reasons.length;
  toVerdictJson(v, "config").reasons.push("污染");
  expect(v.reasons.length).toBe(before);
});

test("J6 可直接 JSON.stringify / parse（CI 与看板消费）", () => {
  const j = toVerdictJson(buildVerdict({}), "trend");
  const round = JSON.parse(JSON.stringify(j));
  expect(round.kind).toBe("trend");
  expect(round.schema_version).toBe(1);
  expect(Array.isArray(round.next_steps)).toBe(true);
});

test("J7 red 结论在 JSON 里也带 blockers（门禁可直接判 grade）", () => {
  const j = toVerdictJson(buildVerdict({ redlines: redlines(2), savings: savings() }), "config");
  expect(j.grade).toBe("red");
  expect(j.blockers.length).toBeGreaterThan(0);
});