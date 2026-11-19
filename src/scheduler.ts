// src/scheduler.ts — 定时任务，与 Python 版 nyra/scheduler.py 同语义。
// schedule.json 原子写；损坏文件先备份成 .corrupt-<时间戳> 再跳过。
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { enqueueAutomationResults } from "./reviewQueue.ts";

export class ScheduleError extends Error {
  constructor(message: string) { super(message); this.name = "ScheduleError"; }
}

export interface ScheduleTask {
  name: string;
  prompt: string;
  every_seconds?: number | null;
  at?: string | null;
  enabled?: boolean;
  workdir?: string | null;
  mode?: string;
  max_turns?: number;
  last_run?: string | null;
  last_status?: string | null;
  last_summary?: string | null;
}

export interface ScheduleData { tasks: ScheduleTask[]; }

export function schedulePath(home?: string): string {
  const h = home ?? process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra");
  return join(h, "schedule.json");
}

const AT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateTask(task: Record<string, unknown>): ScheduleTask {
  if (typeof task.name !== "string" || !task.name.trim() || task.name.trim().length > 100) {
    throw new ScheduleError("定时任务名不能为空且不超过 100 字符");
  }
  if (typeof task.prompt !== "string" || !task.prompt.trim() || task.prompt.length > MAX_TASK_CHARS) {
    throw new ScheduleError("定时任务内容不能为空且不超过 8000 字符");
  }
  const every = task.every_seconds;
  const at = task.at;
  if (every === null || every === undefined) {
    if (typeof at !== "string" || !AT_RE.test(at)) throw new ScheduleError("--at 必须是 HH:MM（24 小时制）");
  } else {
    if (typeof every !== "number" || !Number.isInteger(every) || every < 60) {
      throw new ScheduleError("--every 必须是不小于 60 的整数秒数");
    }
  }
  if (task.workdir !== null && task.workdir !== undefined && typeof task.workdir !== "string") {
    throw new ScheduleError("工作目录无效");
  }
  const mode = (task.mode as string) ?? "auto";
  if (!["readonly", "auto"].includes(mode)) throw new ScheduleError("定时任务只允许 readonly 或 auto");
  const maxTurns = (task.max_turns as number) ?? 20;
  if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new ScheduleError("--max-turns 必须为正整数");
  }
  return {
    name: task.name.trim(), prompt: task.prompt,
    every_seconds: every === null || every === undefined ? null : every,
    at: (at as string | null | undefined) ?? null,
    enabled: task.enabled !== false,
    workdir: (task.workdir as string | null) ?? null,
    mode, max_turns: maxTurns,
    last_run: (task.last_run as string | null) ?? null,
    last_status: (task.last_status as string | null) ?? null,
    last_summary: (task.last_summary as string | null) ?? null,
  };
}

const MAX_TASK_CHARS = 8000;

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadSchedule(path?: string): ScheduleData {
  const p = path ?? schedulePath();
  if (!existsSync(p)) return { tasks: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    backupCorrupt(p);
    throw new ScheduleError("定时任务文件损坏，已备份，请检查后重新添加");
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).tasks)) {
    backupCorrupt(p);
    throw new ScheduleError("定时任务文件格式无效，已备份");
  }
  const tasks: ScheduleTask[] = [];
  const names = new Set<string>();
  for (const item of (raw as ScheduleData).tasks) {
    try {
      const task = validateTask(item as unknown as Record<string, unknown>);
      if (names.has(task.name)) throw new ScheduleError(`已存在同名定时任务：${task.name}`);
      tasks.push(task);
      names.add(task.name);
    } catch (err: unknown) {
      process.stderr.write(`跳过无效定时任务：${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }
  }
  return { tasks };
}

export function saveSchedule(data: ScheduleData, path?: string): string {
  const p = path ?? schedulePath();
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = join(join(p, ".."), `.schedule-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, p); } catch (err) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw err; }
  return p;
}

export function addScheduleTask(data: ScheduleData, task: Record<string, unknown>): ScheduleData {
  const cleaned = validateTask(task);
  if (data.tasks.some((t) => t.name === cleaned.name)) throw new ScheduleError(`已存在同名定时任务：${cleaned.name}`);
  data.tasks.push(cleaned);
  return data;
}

export function removeScheduleTask(data: ScheduleData, name: string): boolean {
  const idx = data.tasks.findIndex((t) => t.name === name);
  if (idx < 0) return false;
  data.tasks.splice(idx, 1);
  return true;
}

export function listScheduleTasks(data: ScheduleData): ScheduleTask[] {
  return [...data.tasks];
}

export function isDue(task: ScheduleTask, now: Date = new Date()): boolean {
  if (task.enabled === false) return false;
  if (task.every_seconds !== null && task.every_seconds !== undefined) {
    if (!task.last_run) return true;
    const last = new Date(task.last_run);
    if (Number.isNaN(last.getTime())) return true;
    return (now.getTime() - last.getTime()) / 1000 >= task.every_seconds;
  }
  if (!task.at) return false;
  const [hour, minute] = task.at.split(":").map(Number);
  const scheduled = new Date(now);
  scheduled.setHours(hour, minute, 0, 0);
  if (now < scheduled) return false;
  if (!task.last_run) return true;
  const last = new Date(task.last_run);
  if (Number.isNaN(last.getTime())) return true;
  const sameDay = last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate();
  return !sameDay;
}

export function dueTasks(data: ScheduleData, now: Date = new Date()): ScheduleTask[] {
  return data.tasks.filter((t) => isDue(t, now));
}

export async function runDueTasks(
  data: ScheduleData,
  agentFactory: (task: ScheduleTask) => Promise<string>,
  now: Date = new Date(),
): Promise<{ name: string; status: string; summary: string }[]> {
  const results: { name: string; status: string; summary: string }[] = [];
  for (const task of dueTasks(data, now)) {
    let summary: string; let status: string;
    try {
      summary = (await agentFactory(task)).slice(0, 200);
      status = "ok";
    } catch (err: unknown) {
      summary = `失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      status = "error";
    }
    task.last_run = now.toISOString();
    task.last_status = status;
    task.last_summary = summary;
    results.push({ name: task.name, status, summary });
  }
  return results;
}

export async function runDaemon(
  agentFactory: (task: ScheduleTask) => Promise<string>,
  opts?: { interval?: number; path?: string; stopAfter?: number | null },
): Promise<number> {
  const interval = opts?.interval ?? 60.0;
  let rounds = 0;
  const stopAfter = opts?.stopAfter ?? null;
  try {
    while (stopAfter === null || rounds < stopAfter) {
      let data: ScheduleData;
      try { data = loadSchedule(opts?.path); } catch (err: unknown) {
        process.stderr.write(`加载定时任务失败：${err instanceof Error ? err.message : String(err)}\n`);
        data = { tasks: [] };
      }
      const results = await runDueTasks(data, agentFactory);
      saveSchedule(data, opts?.path);
      // 缺口 3b：跑成功的定时任务结果进审阅队列（Automations → review queue），
      // 人在队列里逐项批；失败的任务没有可审结果，inbox 已记。入队失败不破坏
      // 守护进程（只记 stderr），队列本身 fail-closed：不批就不放行。
      try {
        const home = dirname(opts?.path ?? schedulePath());
        const { enqueued } = enqueueAutomationResults(home, results);
        for (const item of enqueued) {
          process.stdout.write(`[定时任务] ${item.title} 已进审阅队列（${item.id}，nyra review list 查看）\n`);
        }
      } catch (err: unknown) {
        process.stderr.write(`审阅队列入队失败：${err instanceof Error ? err.message : String(err)}\n`);
      }
      for (const r of results) {
        process.stdout.write(`[定时任务] ${r.name}：${r.status} - ${r.summary.slice(0, 100)}\n`);
      }
      rounds += 1;
      if (stopAfter !== null && rounds >= stopAfter) break;
      await new Promise((r) => setTimeout(r, interval * 1000));
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "KeyboardInterrupt") {
      process.stdout.write("定时任务守护进程已停止\n");
    } else throw err;
  }
  return rounds;
}
