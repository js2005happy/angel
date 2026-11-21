// tests/node/test-kanban.test.ts — 缺口 26 持久任务板。
// 钉住的事：
//   - 账本往返（原子写 0600、损坏先备份再抛错、不静默重建）、创建校验；
//   - 状态机：queued → working → review → working/queued，失败回队、满 3 次熔断进 blocked、reset 只人动；
//   - 通用完成边界：没通过的验证证据，done 标不上去；验证不过不进熔断计数；
//   - tick（假 dispatch：派发成功挂 runId、派发抛错走 fail 路径、空队无事）；
//   - sweepStaleWorking（绑的运行已失败才走 fail 路径）；
//   - 有运行上下文时流转镜像进运行事件；CLI 端到端与退出码。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { RunStore } from "../../src/runs.ts";
import {
  createKanbanTask, getKanbanTask, listKanbanTasks, startKanbanTask, failKanbanTask,
  requestKanbanReview, decideKanbanReview, verifyKanbanTask, completeKanbanTask,
  resetKanbanTask, removeKanbanTask, kanbanTick, sweepStaleWorking, kanbanPath, KanbanError,
} from "../../src/kanban.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

test("KanbanTest.test_create_fields_and_validation", () => {
  const home = tmpHome("nyra-kanban-");
  const task = createKanbanTask(home, { title: "修登录 bug", kind: "task", agent: "nyra" });
  expect(task.id).toMatch(/^kb_[0-9a-f]{12}$/);
  expect(task.status).toBe("queued");
  expect(task.attempts).toBe(0);
  expect(task.maxAttempts).toBe(3);
  expect(task.verification).toBeNull();
  expect(() => createKanbanTask(home, { title: "" })).toThrow(KanbanError);
  expect(() => createKanbanTask(home, { title: "x".repeat(201) })).toThrow(KanbanError);
  expect(() => createKanbanTask(home, { title: "t", kind: "nope" as never })).toThrow(KanbanError);
  expect(() => createKanbanTask(home, { title: "t", agent: "Bad Agent" })).toThrow(KanbanError);
  expect(() => createKanbanTask(home, { title: "t", maxAttempts: 0 })).toThrow(KanbanError);
  expect(() => createKanbanTask(home, { title: "t", maxAttempts: 11 })).toThrow(KanbanError);
});

test("KanbanTest.test_store_roundtrip_perms_and_corrupt_backup", () => {
  const home = tmpHome("nyra-kanban-");
  createKanbanTask(home, { title: "任务 A" });
  const store = JSON.parse(readFileSync(kanbanPath(home), "utf-8")) as { version: number; tasks: unknown[]; history: unknown[] };
  expect(store.version).toBe(1);
  expect(store.tasks).toHaveLength(1);
  expect(store.history).toHaveLength(1);
  expectPerms(kanbanPath(home), 0o600);
  writeFileSync(kanbanPath(home), "{ 不是 json");
  expect(() => listKanbanTasks(home)).toThrow(KanbanError);
  const backups = readdirSync(home).filter((f) => f.startsWith("kanban.json.corrupt-"));
  expect(backups).toHaveLength(1);
  expect(existsSync(join(home, backups[0]))).toBe(true);
});

test("KanbanTest.test_fail_circuit_breaker_and_reset", () => {
  const home = tmpHome("nyra-kanban-");
  const task = createKanbanTask(home, { title: "总失败的任务" });
  startKanbanTask(home, task.id);
  let t = failKanbanTask(home, task.id, "第一炸");
  expect(t.status).toBe("queued");
  expect(t.attempts).toBe(1);
  expect(t.lastError).toBe("第一炸");
  startKanbanTask(home, task.id);
  failKanbanTask(home, task.id, "第二炸");
  startKanbanTask(home, task.id);
  t = failKanbanTask(home, task.id, "第三炸");
  expect(t.status).toBe("blocked");
  expect(t.attempts).toBe(3);
  expect(() => startKanbanTask(home, task.id)).toThrow(KanbanError);
  expect(() => resetKanbanTask(home, task.id)).not.toThrow();
  t = getKanbanTask(home, task.id);
  expect(t.status).toBe("queued");
  expect(t.attempts).toBe(0);
  expect(t.lastError).toBeNull();
  expect(() => resetKanbanTask(home, task.id)).toThrow(KanbanError);
});

test("KanbanTest.test_review_round_trip", () => {
  const home = tmpHome("nyra-kanban-");
  const task = createKanbanTask(home, { title: "待审任务" });
  expect(() => requestKanbanReview(home, task.id, "boss")).toThrow(KanbanError);
  startKanbanTask(home, task.id);
  let t = requestKanbanReview(home, task.id, "boss");
  expect(t.status).toBe("review");
  expect(t.review?.by).toBe("boss");
  t = decideKanbanReview(home, task.id, "reject", "少个测试");
  expect(t.status).toBe("queued");
  expect(t.review?.note).toBe("少个测试");
  startKanbanTask(home, task.id);
  requestKanbanReview(home, task.id, "boss");
  t = decideKanbanReview(home, task.id, "approve", "行");
  expect(t.status).toBe("working");
  expect(() => decideKanbanReview(home, task.id, "approve")).toThrow(KanbanError);
});

test("KanbanTest.test_completion_boundary_needs_passing_verification", () => {
  const home = tmpHome("nyra-kanban-");
  const task = createKanbanTask(home, { title: "要验收的任务" });
  startKanbanTask(home, task.id);
  expect(() => completeKanbanTask(home, task.id)).toThrow(/验证证据/);
  verifyKanbanTask(home, task.id, { method: "bun test", summary: "2 fail", passed: false });
  expect(() => completeKanbanTask(home, task.id)).toThrow(/验证证据/);
  // 验证不过不进熔断计数：attempts 仍是 0。
  expect(getKanbanTask(home, task.id).attempts).toBe(0);
  verifyKanbanTask(home, task.id, { method: "bun test", summary: "2508 pass", passed: true });
  const t = completeKanbanTask(home, task.id);
  expect(t.status).toBe("done");
  expect(t.verification?.passed).toBe(true);
  expect(() => verifyKanbanTask(home, task.id, { method: "x", summary: "y", passed: true })).toThrow(KanbanError);
});

test("KanbanTest.test_remove_and_list_filters", () => {
  const home = tmpHome("nyra-kanban-");
  const a = createKanbanTask(home, { title: "A", agent: "nyra" });
  const b = createKanbanTask(home, { title: "B", agent: "other" });
  expect(listKanbanTasks(home)).toHaveLength(2);
  expect(listKanbanTasks(home, { agent: "nyra" })).toHaveLength(1);
  expect(listKanbanTasks(home, { status: "queued" })).toHaveLength(2);
  expect(removeKanbanTask(home, a.id)).toBe(true);
  expect(removeKanbanTask(home, a.id)).toBe(false);
  expect(listKanbanTasks(home)).toHaveLength(1);
  expect(listKanbanTasks(home)[0].id).toBe(b.id);
});

test("KanbanTest.test_tick_dispatch_and_empty_queue", () => {
  const home = tmpHome("nyra-kanban-");
  expect(kanbanTick(home, { dispatch: () => "run-1" })).toEqual({ claimed: 0, dispatched: 0, runId: null, skipped: "队列为空" });
  const a = createKanbanTask(home, { title: "先来的" });
  createKanbanTask(home, { title: "后来的" });
  const report = kanbanTick(home, { dispatch: (t) => `run-${t.id}` });
  expect(report.dispatched).toBe(1);
  expect(report.runId).toBe(`run-${a.id}`);
  const started = getKanbanTask(home, a.id);
  expect(started.status).toBe("working");
  expect(started.runId).toBe(`run-${a.id}`);
  // dispatch 抛错走 fail 路径：attempts+1，回队列。
  const report2 = kanbanTick(home, { dispatch: () => { throw new Error("队列满了"); } });
  expect(report2.dispatched).toBe(0);
  expect(report2.skipped).toContain("队列满了");
  const failed = listKanbanTasks(home, { status: "queued" }).find((t) => t.title === "后来的");
  expect(failed?.attempts).toBe(1);
});

test("KanbanTest.test_sweep_stale_working_only_failed_runs", () => {
  const home = tmpHome("nyra-kanban-");
  const a = createKanbanTask(home, { title: "绑了失败运行" });
  const b = createKanbanTask(home, { title: "绑了成功运行" });
  const c = createKanbanTask(home, { title: "没绑运行" });
  startKanbanTask(home, a.id, "run-failed");
  startKanbanTask(home, b.id, "run-ok");
  startKanbanTask(home, c.id);
  const report = sweepStaleWorking(home, (runId) => (runId === "run-failed" ? "failed" : runId === "run-ok" ? "verified" : null));
  expect(report).toEqual({ swept: 1, failed: [a.id] });
  expect(getKanbanTask(home, a.id).status).toBe("queued");
  expect(getKanbanTask(home, a.id).attempts).toBe(1);
  expect(getKanbanTask(home, b.id).status).toBe("working");
  expect(getKanbanTask(home, c.id).status).toBe("working");
});

test("KanbanTest.test_transition_mirrors_run_event", () => {
  const home = tmpHome("nyra-kanban-");
  const store = new RunStore(join(home, "tasks"));
  const state = store.create("队列任务", "sess-1", home, "auto", 10, "queued");
  const task = createKanbanTask(home, { title: "有运行的任务" });
  startKanbanTask(home, task.id, state.run_id);
  const events = store.readEvents(state.run_id);
  expect(events.some((e) => e.type === "kanban_transition" && e.task_id === task.id && e.from === "queued" && e.to === "working")).toBe(true);
});

test("KanbanTest.test_cli_end_to_end", () => {
  const home = tmpHome("nyra-kanban-");
  const created = runCli(home, ["kanban", "create", "CLI 任务"]);
  expect(created.status).toBe(0);
  const id = created.stdout.trim();
  expect(id).toMatch(/^kb_[0-9a-f]{12}$/);
  // 没验证就 done：拒绝，退出码非 0。
  runCli(home, ["kanban", "start", id]);
  const noVerify = runCli(home, ["kanban", "done", id]);
  expect(noVerify.status).not.toBe(0);
  expect(noVerify.stderr).toContain("验证证据");
  expect(runCli(home, ["kanban", "verify", id, "--method", "bun test", "--summary", "全过", "--passed"]).status).toBe(0);
  expect(runCli(home, ["kanban", "done", id]).status).toBe(0);
  const listed = runCli(home, ["kanban", "list", "--status", "done"]);
  expect(listed.stdout).toContain(id);
  expect(runCli(home, ["kanban", "nope"]).status).toBe(2);
  expect(runCli(home, ["kanban", "remove", id]).status).toBe(2); // 没 --yes 不让删
  expect(runCli(home, ["kanban", "remove", id, "--yes"]).status).toBe(0);
});
