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
  expect(selectRecalledRuns(runs, "重构 auth 模块").map((r) => r.run_id)).toEqual(["c"]);
});

test("必须同工作目录（别的项目历史没参考价值）", () => {
  const runs = [
    run({ run_id: "here", workdir: "/proj" }),
    run({ run_id: "elsewhere", workdir: "/other" }),
  ];
  const got = selectRecalledRuns(runs, "重构 auth 模块", { workdir: "/proj" });
  expect(got.map((r) => r.run_id)).toEqual(["here"]);
});

test("排除本次运行自身", () => {
  const runs = [run({ run_id: "self" }), run({ run_id: "other" })];
  const got = selectRecalledRuns(runs, "重构 auth 模块", { excludeRunId: "self" });
  expect(got.map((r) => r.run_id)).toEqual(["other"]);
});

test("阈值与条数上限生效", () => {
  const runs = [
    run({ run_id: "a" }),
    run({ run_id: "b", task: "重构 auth" }),
    run({ run_id: "c", task: "重构 auth 模块并补测试" }),
  ];
  expect(selectRecalledRuns(runs, "重构 auth 模块", { limit: 1 }).length).toBe(1);
  expect(selectRecalledRuns(runs, "重构 auth 模块", { threshold: 0.99 }).length).toBe(0);
});

test("formatRecallNote：没有回忆时返回 null（零影响）", () => {
  expect(formatRecallNote([])).toBeNull();
});

test("formatRecallNote：带状态、改动文件、验证命令，并明确要求复核", () => {
  const note = formatRecallNote(selectRecalledRuns([run({ run_id: "a" })], "重构 auth 模块"))!;
  expect(note).toContain("上次做过类似任务");
  expect(note).toContain("已验证");
  expect(note).toContain("src/auth.ts");
  expect(note).toContain("npm test");
  expect(note).toContain("需自行复核");
});

test("formatRecallNote：超长截断（有界输出，不撑爆上下文）", () => {
  const long = run({ run_id: "a", task: "重构".repeat(400), changed_files: Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`) });
  const note = formatRecallNote(selectRecalledRuns([long], "重构", { threshold: 0.1 }), 200)!;
  expect(note.length).toBeLessThan(300);
  expect(note).toContain("已截断");
});

test("buildRecallNote：一步到位；没有历史时返回 null", () => {
  expect(buildRecallNote([], "任意任务")).toBeNull();
  expect(buildRecallNote([run({ run_id: "a" })], "重构 auth 模块")).toContain("上次做过类似任务");
});

test("verify_failed 的历史也会被回忆（带着失败信息更有用）", () => {
  const failed = run({ run_id: "f", status: "verify_failed", verify_result: { exit_code: 2, passed: false } });
  const note = formatRecallNote(selectRecalledRuns([failed], "重构 auth 模块"))!;
  expect(note).toContain("验证未通过");
  expect(note).toContain("退出码 2");
});
