// tests/node/test-dashboard-delegate.test.ts — 看板成本口径必须含委派花费。
//
// 背景（docs/cost.md「已知缺口」第二条）：看板（cost_update / REPL 状态行）的成本段
// 是单 agent 口径，不含子任务花费。后果是「显示 $0.02，实际花了 $0.15」——口径错了
// 比没有数字更危险，因为人会据此判断还能不能再跑。
import { test, expect, afterEach } from "bun:test";
import { setLang } from "../../src/i18n.ts";
import { buildDashboardSnapshot, formatDashboardLine, type DashboardSnapshot } from "../../src/dashboard.ts";

const SNAPSHOT = {
  prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
  calls: 2, missing_calls: 0,
  context_window_tokens: 1000, context_remaining_tokens: 850,
};
const ESTIMATE = { status: "priced", spentUsd: 0.02, remainingUsd: 0.48, limitUsd: 0.5 };

afterEach(() => setLang("zh"));

function snap(delegateUsd?: number | null): DashboardSnapshot {
  return buildDashboardSnapshot({
    turn: 1, maxTurns: 5,
    snapshot: SNAPSHOT as never,
    estimate: ESTIMATE as never,
    delegateUsd,
  });
}

test("没有子任务：不报 delegate_usd（不加噪音字段）", () => {
  const s = snap();
  expect("delegate_usd" in s).toBe(false);
  expect("run_total_usd" in s).toBe(false);
  expect(formatDashboardLine(s)).not.toContain("子任务");
});

test("有子任务：报 delegate_usd 与 run_total_usd", () => {
  const s = snap(0.13);
  expect(s.delegate_usd).toBe(0.13);
  expect(s.run_total_usd).toBeCloseTo(0.15, 10);
});

test("看板行同时给出委派额与合计（人能一眼看懂还差多少）", () => {
  const line = formatDashboardLine(snap(0.13));
  expect(line).toContain("子任务");
  expect(line).toContain("0.1300");
  expect(line).toContain("0.1500");
  // 单 agent 口径仍然在，只是后面补了括号说明
  expect(line).toContain("0.0200");
});

test("委派为 0 时不报（0 不算花费）", () => {
  expect("delegate_usd" in snap(0)).toBe(false);
});

test("非有限值不报（NaN/Infinity 不能变成 $-NaN）", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    expect("delegate_usd" in snap(bad)).toBe(false);
  }
});

test("单价未知时合计为 null——不编造总数", () => {
  const s = buildDashboardSnapshot({
    turn: 1, maxTurns: 5,
    snapshot: SNAPSHOT as never,
    estimate: { status: "unpriced", spentUsd: null, remainingUsd: null, limitUsd: null, reason: "no_pricing" } as never,
    delegateUsd: 0.1,
  });
  expect(s.delegate_usd).toBe(0.1);
  expect(s.run_total_usd).toBeNull();
});

test("英文环境文案也带委派段", () => {
  setLang("en");
  const line = formatDashboardLine(snap(0.13));
  expect(line).toContain("subtasks");
  expect(line).toContain("0.1300");
});

test("口径一致性：run_total = spent + delegate（不多不少）", () => {
  for (const d of [0.0001, 0.5, 3.75]) {
    const s = snap(d);
    expect(s.run_total_usd! - s.spent_usd!).toBeCloseTo(d, 10);
  }
});
