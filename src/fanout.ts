// src/fanout.ts — H-6：后台扇出（background fan-out，结果单条回填，缺口 30/31/26 深化）。
//
// 顶层委派立即回 handle，聊天继续；全部跑完结果以单条 consolidated 消息回填
// （H-5 的合并步就是回填内容）；独立完成可 opt-in 按 group 逐个回。
// 后台扇出直接落任务板（nyra kanban 可查），重启不丢，不走 Hermes“重启即丢”的老路。
//
// 诚实边界：
// - 进程退出，后台跑着的模型循环就停了——扇出记录与任务板行还在，但跑一半的
//   任务不能在原地续跑（没有模型循环的检查点可恢复，与崩溃自续同款限制）。
//   `nyra fanout recover` 把这类 running 记录标 interrupted，任务板行走 fail
//   路径回队列（attempts+1，满 3 次熔断进 blocked，只人 reset），并写收件箱通知。
// - “跑完了没人看”是新问题：完成未回填 / 中断 / 失败的扇出由 Heartbeat 的
//   fanout_unfinished 检查项兜底（见 src/heartbeat.ts）。
// - fanout 账本只记元数据（计数、花费、id），不记任务正文、不记模型输出原文、
//   不记绝对路径；完整合并交付物在 ~/.nyra/merged/<id>.md，审阅项在 review queue。

import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";
import { failKanbanTask, getKanbanTask } from "./kanban.ts";
import { appendInbox } from "./tasks.ts";

export class FanoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FanoutError";
  }
}

/** 后台扇出状态：running（跑着）/ done（全成功）/ partial（部分成功）/ failed（全失败）/ interrupted（进程不在了或人工回收）。 */
export type FanoutStatus = "running" | "done" | "partial" | "failed" | "interrupted";
/** 回填方式：single（全部跑完单条回填）/ per-group（每线程完成逐个回 + 最后单条汇总）。 */
export type FanoutBackfill = "single" | "per-group";

export interface FanoutRecord {
  id: string;
  title: string;
  status: FanoutStatus;
  tasksCount: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  rejected: number;
  /** 全部线程已花美元合计；任一线程未计价时为已计价部分之和，不当全量。 */
  totalSpentUsd: number | null;
  /** 任务板上的对应行（nyra kanban show <id>）；任务板写失败时为 null。 */
  kanbanTaskId: string | null;
  backfill: FanoutBackfill;
  /** 回填消息是否已写入收件箱。 */
  delivered: boolean;
  deliveredAt: string | null;
  /** 合并交付物与各线程的审阅项 id。 */
  reviewItemIds: string[];
  /** 是否跑了合并步。 */
  merged: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FanoutStore {
  version: 1;
  fanouts: FanoutRecord[];
}

export const FANOUT_NAME = "fanout.json";

export function fanoutPath(home: string): string {
  return join(home, FANOUT_NAME);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function newFanoutId(): string {
  return `fo_${randomBytes(6).toString("hex")}`;
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadFanoutStore(home: string): FanoutStore {
  const path = fanoutPath(home);
  if (!existsSync(path)) return { version: 1, fanouts: [] };
  if (lstatSync(path).isSymbolicLink()) throw new FanoutError("后台扇出账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new FanoutError("后台扇出账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as FanoutStore).version !== 1 || !Array.isArray((raw as FanoutStore).fanouts)) {
    backupCorrupt(path);
    throw new FanoutError("后台扇出账本格式无效，已备份");
  }
  return raw as FanoutStore;
}

export function saveFanoutStore(home: string, store: FanoutStore): void {
  const path = fanoutPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new FanoutError("后台扇出账本不能是符号链接");
  const tmp = join(dirname(path), `.fanout-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

export function createFanout(
  home: string,
  opts: { title: string; tasksCount: number; backfill?: FanoutBackfill; kanbanTaskId?: string | null },
): FanoutRecord {
  const title = (opts.title ?? "").trim();
  if (!title) throw new FanoutError("扇出标题不能为空");
  if (!Number.isInteger(opts.tasksCount) || opts.tasksCount < 1) throw new FanoutError("子任务数须为正整数");
  const store = loadFanoutStore(home);
  const at = nowIso();
  const record: FanoutRecord = {
    id: newFanoutId(), title, status: "running",
    tasksCount: opts.tasksCount, succeeded: 0, failed: 0, timedOut: 0, rejected: 0,
    totalSpentUsd: null, kanbanTaskId: opts.kanbanTaskId ?? null,
    backfill: opts.backfill ?? "single",
    delivered: false, deliveredAt: null, reviewItemIds: [], merged: false,
    error: null, createdAt: at, updatedAt: at,
  };
  store.fanouts.push(record);
  saveFanoutStore(home, store);
  return record;
}

export function getFanout(home: string, id: string): FanoutRecord {
  const record = loadFanoutStore(home).fanouts.find((f) => f.id === id);
  if (!record) throw new FanoutError(`找不到后台扇出 ${id}`);
  return record;
}

export function listFanouts(home: string, filter?: { status?: FanoutStatus }): FanoutRecord[] {
  const store = loadFanoutStore(home);
  return store.fanouts
    .filter((f) => !filter?.status || f.status === filter.status)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function updateFanout(home: string, id: string, patch: Partial<FanoutRecord>): FanoutRecord {
  const store = loadFanoutStore(home);
  const record = store.fanouts.find((f) => f.id === id);
  if (!record) throw new FanoutError(`找不到后台扇出 ${id}`);
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id" || k === "createdAt") continue;
    (record as unknown as Record<string, unknown>)[k] = v;
  }
  record.updatedAt = nowIso();
  saveFanoutStore(home, store);
  return record;
}

/**
 * 回收跑一半的扇出：进程不在了，跑一半的模型循环不能原地续跑（没有检查点），
 * 如实标 interrupted；任务板行走 fail 路径回队列（attempts+1，满 3 次熔断，
 * 只人 reset），并写收件箱通知——不静默丢掉。
 */
export function recoverFanouts(home: string): { interrupted: string[]; notified: string[] } {
  const store = loadFanoutStore(home);
  const interrupted: string[] = [];
  const notified: string[] = [];
  for (const record of store.fanouts) {
    if (record.status !== "running") continue;
    record.status = "interrupted";
    record.error = "进程不在了，后台扇出未跑完（跑一半的模型循环不能原地续跑，任务板行已回队列待人重派）";
    record.updatedAt = nowIso();
    interrupted.push(record.id);
    if (record.kanbanTaskId) {
      try {
        const task = getKanbanTask(home, record.kanbanTaskId);
        if (task.status === "working") failKanbanTask(home, record.kanbanTaskId, record.error);
      } catch { /* 任务板行没了就不挡回收 */ }
    }
    try {
      appendInbox(record.id, "fanout-interrupted", `后台扇出 ${record.id}（${record.title.slice(0, 60)}）中断：进程不在了，未跑完；任务板行已回队列，nyra fanout show ${record.id} 查看。`, home);
      notified.push(record.id);
    } catch { /* 收件箱写失败不挡回收 */ }
  }
  if (interrupted.length) saveFanoutStore(home, store);
  return { interrupted, notified };
}

export function formatFanout(record: FanoutRecord): string {
  const statusLabel = record.status === "running" ? "跑着"
    : record.status === "done" ? "已完成"
    : record.status === "partial" ? "部分完成"
    : record.status === "failed" ? "失败" : "已中断";
  const lines = [
    `后台扇出 ${record.id}：${record.title}`,
    `状态：${statusLabel}；子任务 ${record.tasksCount} 个（成功 ${record.succeeded}、失败 ${record.failed}、超时 ${record.timedOut}、被拒 ${record.rejected}）`,
    `花费：${record.totalSpentUsd === null ? "未知（未计价）" : "$" + record.totalSpentUsd.toFixed(4)}；回填：${record.backfill === "per-group" ? "逐个回 + 最后汇总" : "单条回填"}${record.delivered ? `（已回填，${record.deliveredAt ?? ""}）` : "（未回填）"}`,
    `任务板：${record.kanbanTaskId ?? "无"}；合并：${record.merged ? "已跑" : "未跑"}；审阅项：${record.reviewItemIds.length ? record.reviewItemIds.join("、") : "无"}`,
    `创建：${record.createdAt}；更新：${record.updatedAt}`,
  ];
  if (record.error) lines.push(`原因：${record.error}`);
  return lines.join("\n");
}

export function formatFanoutList(records: FanoutRecord[]): string {
  if (!records.length) return "没有后台扇出（nyra fanout recover 可回收跑一半的扇出）。";
  return records.map((r) => {
    const statusLabel = r.status === "running" ? "跑着"
      : r.status === "done" ? "已完成"
      : r.status === "partial" ? "部分完成"
      : r.status === "failed" ? "失败" : "已中断";
    return `${r.id} [${statusLabel}] ${r.title.slice(0, 60)}（${r.succeeded}/${r.tasksCount} 成功${r.delivered ? "，已回填" : "，未回填"}）`;
  }).join("\n");
}

const USAGE = `用法：
  nyra fanout list [--status <running|done|partial|failed|interrupted>] [--json]   列后台扇出
  nyra fanout show <id> [--json]   看一个扇出的详情
  nyra fanout recover   回收跑一半的扇出（标 interrupted，任务板行回队列，写收件箱通知）
`;

export function handleFanout(argv: string[], home: string): number {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action) {
    process.stdout.write(USAGE);
    return 2;
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    if (action === "list") {
      const records = listFanouts(resolvedHome, {
        status: get("--status") as FanoutStatus | undefined,
      });
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(records, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(formatFanoutList(records) + "\n");
      return 0;
    }
    if (action === "show") {
      const id = argv[1] ?? "";
      if (!id) {
        process.stderr.write("用法：nyra fanout show <id>\n");
        return 2;
      }
      const record = getFanout(resolvedHome, id);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(record, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(formatFanout(record) + "\n");
      return 0;
    }
    if (action === "recover") {
      const { interrupted, notified } = recoverFanouts(resolvedHome);
      if (!interrupted.length) {
        process.stdout.write("没有跑一半的后台扇出可回收。\n");
        return 0;
      }
      process.stdout.write(
        `已回收 ${interrupted.length} 个后台扇出：${interrupted.join("、")}（标 interrupted，任务板行已回队列${notified.length ? "，收件箱已通知" : "，收件箱通知失败"}）。\n`,
      );
      return 0;
    }
    process.stderr.write(`未知动作：${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`fanout 失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
