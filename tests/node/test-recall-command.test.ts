// tests/node/test-recall-command.test.ts — `nyra recall` 的可见性保证（隐式能力必须可观察）。
// 说明：CLI 本体在 cli.ts 里，这里测它的核心选择逻辑与输出要素，避免依赖 stdout 抓取。
import { test, expect } from "bun:test";
import { selectRecalledRuns, formatRecallNote } from "../../src/runRecall.ts";
import type { RunState } from "../../src/runs.ts";

const NOW = Date.parse("2026-11-20T00:00:00Z");

function run(over: Record<string, unknown> = {}): RunState {
  return {
    run_id: "r",
    task: "重构 auth 模块并补测试",
    workdir: "/proj",
    status: "verified",
    created_at: new Date(NOW - 2 * 86_400_000).toISOString(),
    changed_files: ["src/auth.ts"],
    verify_cmd: "npm test",
    verify_result: { exit_code: 0, passed: true },
    ...over,
  } as unknown as RunState;
}

test("nyra recall 能列出的，和实际注入的是同一批（同一函数）", () => {
  const runs = [run({ run_id: "a" }), run({ run_id: "b", status: "failed" })];
  const picked = selectRecalledRuns(runs, "重构 auth 模块", { workdir: "/proj", limit: 5, maxAgeDays: 30, now: NOW });
  const note = formatRecallNote(picked);
  expect(picked.map((r) => r.run_id)).toEqual(["a"]);
  expect(note).toContain("a".length ? "重构 auth 模块" : "");
});

test("命令展示的字段齐全：run_id / status / ageDays / score / task", () => {
  const [picked] = selectRecalledRuns([run()], "重构 auth 模块", { workdir: "/proj", now: NOW });
  expect(picked.run_id).toBe("r");
  expect(picked.status).toBe("verified");
  expect(picked.ageDays).toBe(2);
  expect(picked.score).toBeGreaterThan(0);
  expect(picked.task.length).toBeGreaterThan(0);
});

test("没有可复用历史时返回空数组（命令据此打印「没有可复用」）", () => {
  expect(selectRecalledRuns([], "任意任务", { now: NOW })).toEqual([]);
  expect(selectRecalledRuns([run({ status: "incomplete" })], "重构 auth 模块", { now: NOW })).toEqual([]);
});

test("超过 30 天的历史不会出现在命令列表里（与注入一致）", () => {
  const old = run({ created_at: new Date(NOW - 90 * 86_400_000).toISOString() });
  expect(selectRecalledRuns([old], "重构 auth 模块", { now: NOW })).toEqual([]);
});

test("别的目录的历史不会出现在本目录的命令列表里", () => {
  const other = run({ workdir: "/other" });
  expect(selectRecalledRuns([other], "重构 auth 模块", { workdir: "/proj", now: NOW })).toEqual([]);
});
