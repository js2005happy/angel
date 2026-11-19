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