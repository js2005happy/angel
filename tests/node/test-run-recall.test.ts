// tests/node/test-run-recall.test.ts — 跨会话回忆（自研特色）。
// 目的：同一任务二次运行时复用上次结论，省掉重新探索的 token。
// 纪律：只回忆有结论的运行、必须同工作目录、输出有界、明确标注"需复核"。
import { test, expect } from "bun:test";
import { taskSimilarity, selectRecalledRuns, formatRecallNote, buildRecallNote } from "../../src/runRecall.ts";
import type { RunState } from "../../src/runs.ts";

function run(over: Record<string, unknown>): RunState {
  return {
    run_id: "r1",
    task: "重构 auth 模块并补测试",
    workdir: "/proj",
    status: "verified",
    created_at: "2026-01-01T00:00:00Z",
    changed_files: ["src/auth.ts"],
    verify_cmd: "npm test",
    verify_result: { exit_code: 0, passed: true },
    ...over,
  } as unknown as RunState;
}

test("相似度：同词高、不同词低、空串为 0", () => {
  expect(taskSimilarity("重构 auth 模块", "重构 auth 模块并补测试")).toBeGreaterThanOrEqual(0.5);
  expect(taskSimilarity("重构 auth 模块", "写一个 README")).toBeLessThan(0.2);
  expect(taskSimilarity("", "x")).toBe(0);
  expect(taskSimilarity("x", "")).toBe(0);
});

test("只回忆有结论的运行：failed / incomplete 不算", () => {
  const runs = [
    run({ run_id: "a", status: "failed" }),
    run({ run_id: "b", status: "incomplete" }),
    run({ run_id: "c", status: "verified" }),
  ];
  expect(selectRecalledRuns(runs, "重构 auth 模块", { maxAgeDays: 0 }).map((r) => r.run_id)).toEqual(["c"]);
});

test("必须同工作目录（别的项目历史没参考价值）", () => {
  const runs = [
    run({ run_id: "here", workdir: "/proj" }),
    run({ run_id: "elsewhere", workdir: "/other" }),
  ];
  const got = selectRecalledRuns(runs, "重构 auth 模块", { workdir: "/proj", maxAgeDays: 0 });
  expect(got.map((r) => r.run_id)).toEqual(["here"]);
});

test("排除本次运行自身", () => {
  const runs = [run({ run_id: "self" }), run({ run_id: "other" })];
  const got = selectRecalledRuns(runs, "重构 auth 模块", { excludeRunId: "self", maxAgeDays: 0 });
  expect(got.map((r) => r.run_id)).toEqual(["other"]);
});

test("阈值与条数上限生效", () => {
  const runs = [
    run({ run_id: "a" }),
    run({ run_id: "b", task: "重构 auth" }),
    run({ run_id: "c", task: "重构 auth 模块并补测试" }),
  ];
  expect(selectRecalledRuns(runs, "重构 auth 模块", { limit: 1, maxAgeDays: 0 }).length).toBe(1);
  expect(selectRecalledRuns(runs, "重构 auth 模块", { threshold: 0.99, maxAgeDays: 0 }).length).toBe(0);
});

test("formatRecallNote：没有回忆时返回 null（零影响）", () => {
  expect(formatRecallNote([])).toBeNull();
});

test("formatRecallNote：带状态、改动文件、验证命令，并明确要求复核", () => {
  const note = formatRecallNote(selectRecalledRuns([run({ run_id: "a" })], "重构 auth 模块", { maxAgeDays: 0 }))!;
  expect(note).toContain("上次做过类似任务");
  expect(note).toContain("已验证");
  expect(note).toContain("src/auth.ts");
  expect(note).toContain("npm test");
  expect(note).toContain("需自行复核");
});

test("formatRecallNote：超长截断（有界输出，不撑爆上下文）", () => {
  const long = run({ run_id: "a", task: "重构".repeat(400), changed_files: Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`) });
  const note = formatRecallNote(selectRecalledRuns([long], "重构", { threshold: 0.1, maxAgeDays: 0 }), 200)!;
  expect(note.length).toBeLessThan(300);
  expect(note).toContain("已截断");
});

test("buildRecallNote：一步到位；没有历史时返回 null", () => {
  expect(buildRecallNote([], "任意任务")).toBeNull();
  expect(buildRecallNote([run({ run_id: "a" })], "重构 auth 模块", { maxAgeDays: 0 })).toContain("上次做过类似任务");
});

test("verify_failed 的历史也会被回忆（带着失败信息更有用）", () => {
  const failed = run({ run_id: "f", status: "verify_failed", verify_result: { exit_code: 2, passed: false } });
  const note = formatRecallNote(selectRecalledRuns([failed], "重构 auth 模块", { maxAgeDays: 0 }))!;
  expect(note).toContain("验证未通过");
  expect(note).toContain("退出码 2");
});

test("新鲜度：默认只回忆 30 天内的运行", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const mk = (id: string, daysAgo: number) => run({
    run_id: id,
    created_at: new Date(now - daysAgo * 86_400_000).toISOString(),
  });
  const got = selectRecalledRuns([mk("today", 0), mk("d10", 10), mk("d45", 45)], "重构 auth 模块", { now, workdir: "/proj" });
  expect(got.map((r) => r.run_id).sort()).toEqual(["d10", "today"]);
});

test("新鲜度：maxAgeDays=0 表示不限", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const old = run({ run_id: "old", created_at: new Date(now - 400 * 86_400_000).toISOString() });
  expect(selectRecalledRuns([old], "重构 auth 模块", { now, maxAgeDays: 0 }).length).toBe(1);
});

test("新鲜度：输出里带年龄，过期历史不出现", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const recent = run({ run_id: "r", created_at: new Date(now - 10 * 86_400_000).toISOString() });
  const stale = run({ run_id: "s", created_at: new Date(now - 90 * 86_400_000).toISOString() });
  const note = formatRecallNote(selectRecalledRuns([recent, stale], "重构 auth 模块", { now, workdir: "/proj" }))!;
  expect(note).toContain("10 天前");
  expect(note).not.toContain("90 天前");
});

test("跨目录：默认排除（别的项目历史没参考价值）", () => {
  const { selectRecalledRuns: sel, CROSS_DIR_SCORE_FACTOR: _f } = { selectRecalledRuns, CROSS_DIR_SCORE_FACTOR: 0 };
  void _f;
  const runs = [run({ run_id: "same", workdir: "/proj" }), run({ run_id: "other", workdir: "/other" })];
  const got = sel(runs, "重构 auth 模块", { workdir: "/proj", maxAgeDays: 0 });
  expect(got.map((r) => r.run_id)).toEqual(["same"]);
});

test("跨目录弱复用：开启后包含，打上 crossDir 与来源目录", async () => {
  const { selectRecalledRuns: sel, CROSS_DIR_SCORE_FACTOR } = await import("../../src/runRecall.ts");
  const runs = [run({ run_id: "same", workdir: "/proj" }), run({ run_id: "other", workdir: "/other" })];
  const got = sel(runs, "重构 auth 模块", { workdir: "/proj", maxAgeDays: 0, allowCrossDir: true });
  expect(got.length).toBe(2);
  const cross = got.find((r) => r.run_id === "other")!;
  expect(cross.crossDir).toBe(true);
  expect(cross.workdir).toBe("/other");
  const same = got.find((r) => r.run_id === "same")!;
  expect(same.crossDir).toBe(false);
  expect(cross.score).toBeLessThanOrEqual(same.score);
  expect(CROSS_DIR_SCORE_FACTOR).toBeGreaterThan(0);
});

test("跨目录：输出里标注来源目录与「仅供参考」", async () => {
  const { selectRecalledRuns: sel } = await import("../../src/runRecall.ts");
  const runs = [run({ run_id: "other", workdir: "/other" })];
  const note = formatRecallNote(sel(runs, "重构 auth 模块", { workdir: "/proj", maxAgeDays: 0, allowCrossDir: true }))!;
  expect(note).toContain("来自 /other");
  expect(note).toContain("仅供参考");
});

test("误用防护：同目录回忆要求先用 read_file 复核，以当前文件为准", () => {
  const note = formatRecallNote(selectRecalledRuns([run({ run_id: "a" })], "重构 auth 模块", { maxAgeDays: 0 }))!;
  expect(note).toContain("read_file");
  expect(note).toContain("以当前文件为准");
  expect(note).toContain("丢弃该条回忆结论");
});

test("误用防护：含跨项目条目时追加「说明为什么仍成立」的严格要求", async () => {
  const { RECALL_GUARD_CROSS, requiresStrictRecheck } = await import("../../src/runRecall.ts");
  const runs = [run({ run_id: "a", workdir: "/proj" }), run({ run_id: "b", workdir: "/other" })];
  const picked = selectRecalledRuns(runs, "重构 auth 模块", { workdir: "/proj", maxAgeDays: 0, allowCrossDir: true });
  const note = formatRecallNote(picked)!;
  expect(note).toContain(RECALL_GUARD_CROSS);
  expect(note).toContain("为什么这个结论在当前项目仍然成立");
  expect(requiresStrictRecheck(picked)).toBe(true);
});

test("误用防护：同目录时不加跨项目要求（避免噪音）", async () => {
  const { RECALL_GUARD_CROSS } = await import("../../src/runRecall.ts");
  const note = formatRecallNote(selectRecalledRuns([run({ run_id: "a" })], "重构 auth 模块", { maxAgeDays: 0 }))!;
  expect(note).not.toContain(RECALL_GUARD_CROSS);
});

test("误用防护：空回忆仍然返回 null（不加任何提示）", () => {
  expect(formatRecallNote([])).toBeNull();
});