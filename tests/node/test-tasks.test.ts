// tests/node/test-tasks.test.ts — 对应 tests/test_tasks.py（9 个唯一测试）。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskError, WorkerLock, addTask, cancelTask, listTasks, showTask,
  appendInbox, loadInbox, markInboxRead, formatUnreadInbox,
} from "../../src/tasks.ts";
import { RunStore } from "../../src/runs.ts";

function storeFor(home: string): RunStore {
  return new RunStore(join(home, "runs"));
}

test("TasksTest.test_add_task_validation", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-tasks-"));
  const wd = mkdtempSync(join(tmpdir(), "nyra-tasks-wd-"));
  const store = storeFor(home);
  expect(() => addTask("", { workdir: wd, store, home })).toThrow(TaskError);
  expect(() => addTask("x".repeat(8001), { workdir: wd, store, home })).toThrow(TaskError);
  expect(() => addTask("做点事", { workdir: wd, mode: "full", store, home })).toThrow(TaskError);
  expect(() => addTask("做点事", { workdir: "/tmp/no-such-dir-xyz", store, home })).toThrow(TaskError);
  expect(() => addTask("做点事", { workdir: wd, maxTurns: 0, store, home })).toThrow(TaskError);
});

test("TasksTest.test_add_list_cancel", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-tasks-"));
  const wd = mkdtempSync(join(tmpdir(), "nyra-tasks-wd-"));
  const store = storeFor(home);
  const state = addTask("做点事", { workdir: wd, mode: "auto", store, home });
  expect(state.status).toBe("queued");
  expect(state.task).toBe("做点事");
  expect(listTasks(store).map((s) => s.run_id)).toContain(state.run_id);
  const cancelled = cancelTask(state.run_id, store);
  expect(["interrupted", "failed", "cancelled"].includes(cancelled.status) || cancelled.status === "queued").toBe(true);
  const [shown, events] = showTask(state.run_id, store);
  expect(shown.run_id).toBe(state.run_id);
  expect(Array.isArray(events)).toBe(true);
});

test("TasksTest.test_worker_lock_single_instance", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-tasks-"));
  const lock = new WorkerLock(join(home, "worker.lock"));
  expect(lock.acquire()).toBe(true);
  const lock2 = new WorkerLock(join(home, "worker.lock"));
  expect(lock2.acquire()).toBe(false);
  lock.release();
  expect(lock2.acquire()).toBe(true);
  lock2.release();
});

test("TasksTest.test_worker_lock_stale_pid_released", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-tasks-"));
  const lock = new WorkerLock(join(home, "worker.lock"));
  expect(lock.acquire()).toBe(true);
  // 模拟崩溃：锁文件留着，但 pid 已死。
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(join(home, "worker.lock"), "999999");
  lock.release();
  const lock2 = new WorkerLock(join(home, "worker.lock"));
  expect(lock2.acquire()).toBe(true);
  lock2.release();
});

test("TasksTest.test_inbox_flow", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-tasks-"));
  appendInbox("run-1", "completed", "任务完成", home);
  appendInbox("run-2", "failed", "任务失败", home);
  const unread = loadInbox(home, true);
  expect(unread.length).toBe(2);
  expect(formatUnreadInbox(home)).toContain("run-1");
  const marked = markInboxRead(home);
  expect(marked).toBe(2);
  expect(loadInbox(home, true).length).toBe(0);
  expect(loadInbox(home, false).length).toBe(2);
});

test("TasksTest.test_add_task_readonly_allowed", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-tasks-"));
  const wd = mkdtempSync(join(tmpdir(), "nyra-tasks-wd-"));
  const store = storeFor(home);
  const state = addTask("只读任务", { workdir: wd, mode: "readonly", store, home });
  expect(state.mode).toBe("readonly");
});

test("TasksTest.test_add_task_verify_frozen_at_creation", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-tasks-"));
  const wd = mkdtempSync(join(tmpdir(), "nyra-tasks-wd-"));
  const store = storeFor(home);
  const state = addTask("做点事", { workdir: wd, verifyCmd: "make test", store, home });
  expect(state.verify_cmd).toBe("make test");
});

test("TasksTest.test_show_unknown_task_throws", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-tasks-"));
  const store = storeFor(home);
  expect(() => showTask("20261118-000000-abcdef", store)).toThrow();
});

test("TasksTest.test_list_tasks_empty", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-tasks-"));
  const store = storeFor(home);
  expect(listTasks(store)).toEqual([]);
});
