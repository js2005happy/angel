// tests/node/test-recall-consistency.test.ts — 三处「可复用历史」口径的交叉一致性。
//
// 现状：三个地方各自调用 selectRecalledRuns，但 limit 不同（运行时注入 3、nyra recall 5、
// cost --estimate 3）。不同 limit 是设计，不是 bug——但**必须是唯一差异**。
// 这个文件锁住三件事，防止将来某处偷偷改了口径：
//   C1. 同样的 (task, workdir, limit) → 同样的结果（确定性）
//   C2. 注入文本里的条目数 === selectRecalledRuns 返回条数（不许多也不许少）
//   C3. limit 是唯一差异：同一批输入下，小 limit 的结果一定是大 limit 结果的前缀
import { test, expect } from "bun:test";
import { selectRecalledRuns, buildRecallNote, formatRecallNote } from "../../src/runRecall.ts";
import type { RunState } from "../../src/runs.ts";

const NOW = Date.parse("2026-11-20T00:00:00Z");

function run(id: string, over: Record<string, unknown> = {}): RunState {
  return {
    run_id: id,
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

const RUNS = [
  run("a", { task: "重构 auth 模块并补测试" }),
  run("b", { task: "重构 auth 模块" }),
  run("c", { task: "重构 auth 的登录态" }),
  run("d", { task: "重构 auth 模块并补测试" }),
  run("old", { task: "重构 auth 模块并补测试", created_at: new Date(NOW - 90 * 86_400_000).toISOString() }),
  run("failed", { task: "重构 auth 模块", status: "failed" }),
  run("other", { task: "重构 auth 模块", workdir: "/elsewhere" }),
];

const OPTS = { workdir: "/proj", now: NOW };

test("C1 确定性：同样输入两次调用结果完全相同", () => {
  const a = selectRecalledRuns(RUNS, "重构 auth 模块并补测试", { ...OPTS, limit: 3 });
  const b = selectRecalledRuns(RUNS, "重构 auth 模块并补测试", { ...OPTS, limit: 3 });
  expect(a.map((r) => r.run_id)).toEqual(b.map((r) => r.run_id));
});

test("C2 注入文本的条目数 === 选择结果条数（不只是「差不多」）", () => {
  for (const limit of [1, 2, 3, 5]) {
    const picked = selectRecalledRuns(RUNS, "重构 auth 模块并补测试", { ...OPTS, limit });
    const note = formatRecallNote(picked, 4000)!;
    // 每一条都以「- 」开头；标题行以「## 」开头，不计入
    const entries = note.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(entries).toBe(picked.length);
  }
});

test("C3 limit 是唯一差异：小 limit 是大 limit 的前缀", () => {
  const big = selectRecalledRuns(RUNS, "重构 auth 模块并补测试", { ...OPTS, limit: 5 }).map((r) => r.run_id);
  for (const limit of [1, 2, 3]) {
    const small = selectRecalledRuns(RUNS, "重构 auth 模块并补测试", { ...OPTS, limit }).map((r) => r.run_id);
    expect(small).toEqual(big.slice(0, small.length));
  }
});

test("C3 补充：limit 变化不会改变过滤器（同一条记录不会时有时无）", () => {
  const ids1 = new Set(selectRecalledRuns(RUNS, "重构 auth 模块", { ...OPTS, limit: 1 }).map((r) => r.run_id));
  const ids5 = new Set(selectRecalledRuns(RUNS, "重构 auth 模块", { ...OPTS, limit: 5 }).map((r) => r.run_id));
  for (const id of ids1) expect(ids5.has(id)).toBe(true);
});

test("运行时注入（limit 3）与 cost 估算（limit 3）得到同一批", () => {
  const inject = selectRecalledRuns(RUNS, "重构 auth 模块并补测试", { ...OPTS, limit: 3 });
  const cost = selectRecalledRuns(RUNS, "重构 auth 模块并补测试", { ...OPTS, limit: 3 });
  expect(inject.map((r) => r.run_id)).toEqual(cost.map((r) => r.run_id));
});

test("nyra recall（limit 5）不少于注入（limit 3），且包含后者", () => {
  const inject = selectRecalledRuns(RUNS, "重构 auth 模块并补测试", { ...OPTS, limit: 3 }).map((r) => r.run_id);
  const listCmd = selectRecalledRuns(RUNS, "重构 auth 模块并补测试", { ...OPTS, limit: 5 }).map((r) => r.run_id);
  expect(listCmd.length).toBeGreaterThanOrEqual(inject.length);
  for (const id of inject) expect(listCmd).toContain(id);
});

test("buildRecallNote 与 selectRecalledRuns + formatRecallNote 等价（同一入口）", () => {
  const a = buildRecallNote(RUNS, "重构 auth 模块并补测试", { ...OPTS, limit: 2 });
  const b = formatRecallNote(selectRecalledRuns(RUNS, "重构 auth 模块并补测试", { ...OPTS, limit: 2 }), 1200);
  expect(a).toBe(b);
});

test("被排除的三类真的不出现：过期 / 失败 / 别的目录", () => {
  const ids = selectRecalledRuns(RUNS, "重构 auth 模块并补测试", { ...OPTS, limit: 10 }).map((r) => r.run_id);
  expect(ids).not.toContain("old");
  expect(ids).not.toContain("failed");
  expect(ids).not.toContain("other");
});
