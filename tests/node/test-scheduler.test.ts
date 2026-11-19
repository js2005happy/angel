// tests/node/test-scheduler.test.ts — 对应 tests/test_scheduler_robust.py（4 唯一）+ 调度器行为。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ScheduleError, validateTask, loadSchedule, saveSchedule, addScheduleTask,
  removeScheduleTask, listScheduleTasks, isDue, dueTasks, runDueTasks,
} from "../../src/scheduler.ts";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "nyra-sched-")), "schedule.json");
}

test("SchedulerTest.test_validate_task", () => {
  const t = validateTask({ name: "晨报", prompt: "汇总", every_seconds: 3600, mode: "readonly", max_turns: 5 });
  expect(t.name).toBe("晨报");
  expect(t.every_seconds).toBe(3600);
  expect(t.enabled).toBe(true);
  expect(() => validateTask({ name: "", prompt: "x", every_seconds: 60 })).toThrow(ScheduleError);
  expect(() => validateTask({ name: "x".repeat(101), prompt: "x", every_seconds: 60 })).toThrow(ScheduleError);
  expect(() => validateTask({ name: "a", prompt: "", every_seconds: 60 })).toThrow(ScheduleError);
  expect(() => validateTask({ name: "a", prompt: "x".repeat(8001), every_seconds: 60 })).toThrow(ScheduleError);
  expect(() => validateTask({ name: "a", prompt: "x", every_seconds: 30 })).toThrow(ScheduleError);
  expect(() => validateTask({ name: "a", prompt: "x", every_seconds: 60.5 })).toThrow(ScheduleError);
  expect(() => validateTask({ name: "a", prompt: "x", at: "25:00" })).toThrow(ScheduleError);
  expect(() => validateTask({ name: "a", prompt: "x", mode: "full" })).toThrow(ScheduleError);
  expect(() => validateTask({ name: "a", prompt: "x", max_turns: 0 })).toThrow(ScheduleError);
});

test("SchedulerTest.test_at_time_valid", () => {
  const t = validateTask({ name: "a", prompt: "x", at: "08:38", mode: "auto", max_turns: 3 });
  expect(t.at).toBe("08:38");
});

test("SchedulerTest.test_save_load_roundtrip", () => {
  const path = tmpPath();
  const data = { tasks: [validateTask({ name: "a", prompt: "x", every_seconds: 60 })] };
  saveSchedule(data, path);
  const loaded = loadSchedule(path);
  expect(loaded.tasks.length).toBe(1);
  expect(loaded.tasks[0].name).toBe("a");
});

test("SchedulerTest.test_load_corrupt_file_backs_up_and_raises", () => {
  const path = tmpPath();
  writeFileSync(path, "{not json");
  expect(() => loadSchedule(path)).toThrow(ScheduleError);
  // 原文件仍在，且同目录出现 .corrupt-* 备份。
  expect(readFileSync(path, "utf-8")).toContain("not json");
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const dir = dirname(path);
  expect(readdirSync(dir).some((f: string) => f.includes(".corrupt-"))).toBe(true);
});

test("SchedulerTest.test_load_skips_invalid_task_entries", () => {
  const path = tmpPath();
  writeFileSync(path, JSON.stringify({ tasks: [
    { name: "ok", prompt: "x", every_seconds: 60 },
    { name: "bad", prompt: "x", every_seconds: 30 },
  ] }));
  const loaded = loadSchedule(path);
  expect(loaded.tasks.map((t) => t.name)).toEqual(["ok"]);
});

test("SchedulerTest.test_add_remove_list", () => {
  const data = { tasks: [] as never[] };
  addScheduleTask(data as never, { name: "a", prompt: "x", every_seconds: 60 });
  addScheduleTask(data as never, { name: "b", prompt: "y", at: "09:00" });
  expect(listScheduleTasks(data as never).length).toBe(2);
  expect(() => addScheduleTask(data as never, { name: "a", prompt: "z", every_seconds: 60 })).toThrow(ScheduleError);
  expect(removeScheduleTask(data as never, "a")).toBe(true);
  expect(removeScheduleTask(data as never, "a")).toBe(false);
  expect(listScheduleTasks(data as never).map((t) => t.name)).toEqual(["b"]);
});

test("SchedulerTest.test_is_due_interval", () => {
  const now = new Date("2026-11-18T10:00:00Z");
  const fresh = validateTask({ name: "a", prompt: "x", every_seconds: 3600 });
  expect(isDue(fresh, now)).toBe(true);
  const justRan = { ...fresh, last_run: new Date("2026-11-18T09:59:00Z").toISOString() };
  expect(isDue(justRan, now)).toBe(false);
  const overdue = { ...fresh, last_run: new Date("2026-11-18T08:00:00Z").toISOString() };
  expect(isDue(overdue, now)).toBe(true);
  const disabled = { ...fresh, enabled: false };
  expect(isDue(disabled, now)).toBe(false);
});

test("SchedulerTest.test_is_due_daily_at", () => {
  // isDue 按本地时间比较；用本地分量构造日期，测试在任何时区都通过。
  const now = new Date(2026, 10, 18, 9, 0, 0);
  const task = validateTask({ name: "a", prompt: "x", at: "08:38" });
  expect(isDue(task, now)).toBe(true);
  const doneToday = { ...task, last_run: new Date(2026, 10, 18, 8, 40, 0).toISOString() };
  expect(isDue(doneToday, now)).toBe(false);
  const before = new Date(2026, 10, 18, 8, 0, 0);
  expect(isDue(task, before)).toBe(false);
});

test("SchedulerTest.test_due_tasks_and_run", async () => {
  const now = new Date("2026-11-18T10:00:00Z");
  const data = { tasks: [validateTask({ name: "a", prompt: "x", every_seconds: 60 })] };
  expect(dueTasks(data, now).length).toBe(1);
  const results = await runDueTasks(data, async () => "完成", now);
  expect(results.length).toBe(1);
  expect(results[0].status).toBe("ok");
  expect(results[0].summary).toBe("完成");
  expect(data.tasks[0].last_run).toBe(now.toISOString());
  expect(data.tasks[0].last_status).toBe("ok");
  expect(dueTasks(data, now).length).toBe(0);
});

test("SchedulerTest.test_run_due_tasks_failure_recorded", async () => {
  const now = new Date("2026-11-18T10:00:00Z");
  const data = { tasks: [validateTask({ name: "a", prompt: "x", every_seconds: 60 })] };
  const results = await runDueTasks(data, async () => { throw new Error("炸了"); }, now);
  expect(results[0].status).toBe("error");
  expect(results[0].summary).toContain("炸了");
  expect(data.tasks[0].last_status).toBe("error");
});
