// src/sideEffects.ts — DSH-4：“先存后做”的持久副作用队列 + 重启恢复。
//
// 决策后的副作用（写文件、对外发消息、调外部接口）先落库再执行：崩在
// 执行中途，重启后还能知道“这件事做到哪了”，而不是靠模型回忆。恢复时
// 按工单年龄从老到新（先处理最老的未完成项），每项带 recovery note：
// 先查目录与 git 历史（只读），再决定是“已经做过了”还是“重新执行”。
// 已读/未读跨重启保留：恢复只读写副作用队列本身，绝不碰收件箱
// （inbox.jsonl 的 read 标记重启前后不变，见测试）。
//
// 队列 ~/.nyra/side-effects.json（原子写 0600，损坏先备份再抛错）。
// 只记元数据：副作用的种类、描述、目标摘要（相对路径/host，不记绝对路
// 径、不记参数原文、不记密钥与正文）；执行本身由调用方完成，队列只负责
// “记下来 + 恢复时告诉你还剩什么 + 帮你判断做没做过”。
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";
import { RunStore } from "./runs.ts";

export class SideEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SideEffectError";
  }
}

export type SideEffectStatus = "pending" | "done" | "failed" | "skipped";
export type SideEffectKind = "file_write" | "external_send" | "shell" | "other";

export interface SideEffect {
  id: string;
  runId: string | null;
  kind: SideEffectKind;
  description: string;
  target: string;
  status: SideEffectStatus;
  createdAt: string;
  executedAt: string | null;
  recoveryNote: string | null;
}

export interface SideEffectStore {
  version: 1;
  effects: SideEffect[];
}

export function sideEffectsPath(home: string): string {
  return join(home, "side-effects.json");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function newEffectId(): string {
  return `se_${randomBytes(6).toString("hex")}`;
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadSideEffectStore(home: string): SideEffectStore {
  const path = sideEffectsPath(home);
  if (!existsSync(path)) return { version: 1, effects: [] };
  if (lstatSync(path).isSymbolicLink()) throw new SideEffectError("副作用队列不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new SideEffectError("副作用队列损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as SideEffectStore).version !== 1 || !Array.isArray((raw as SideEffectStore).effects)) {
    backupCorrupt(path);
    throw new SideEffectError("副作用队列格式无效，已备份");
  }
  return raw as SideEffectStore;
}

export function saveSideEffectStore(home: string, store: SideEffectStore): void {
  const path = sideEffectsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new SideEffectError("副作用队列不能是符号链接");
  const tmp = join(dirname(path), `.side-effects-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function getEffect(store: SideEffectStore, id: string): SideEffect {
  const effect = store.effects.find((e) => e.id === id);
  if (!effect) throw new SideEffectError(`找不到副作用 ${id}`);
  return effect;
}

function mirrorEvent(home: string, runId: string | null, type: string, fields: Record<string, unknown>): void {
  if (!runId) return;
  for (const dir of ["tasks", "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      store.load(runId);
      store.appendEvent(runId, type, fields);
      return;
    } catch { /* 不在这个目录 */ }
  }
}

/** 先存后做：执行之前先把副作用记下来，崩了重启后才找得到它。 */
export function recordSideEffect(
  home: string,
  opts: { runId?: string | null; kind?: SideEffectKind; description: string; target?: string },
): SideEffect {
  const description = (opts.description ?? "").trim();
  if (!description) throw new SideEffectError("副作用描述不能为空");
  if (description.length > 300) throw new SideEffectError("副作用描述过长（超过 300 字符）");
  const kind = opts.kind ?? "other";
  if (!["file_write", "external_send", "shell", "other"].includes(kind)) throw new SideEffectError("副作用类型无效");
  const store = loadSideEffectStore(home);
  const effect: SideEffect = {
    id: newEffectId(), runId: opts.runId ?? null, kind, description,
    target: String(opts.target ?? "").slice(0, 120),
    status: "pending", createdAt: nowIso(), executedAt: null, recoveryNote: null,
  };
  store.effects.push(effect);
  saveSideEffectStore(home, store);
  mirrorEvent(home, effect.runId, "side_effect_recorded", { effect_id: effect.id, kind });
  return effect;
}

export function getSideEffect(home: string, id: string): SideEffect {
  return getEffect(loadSideEffectStore(home), id);
}

export function listSideEffects(home: string, filter?: { status?: SideEffectStatus; runId?: string }): SideEffect[] {
  const store = loadSideEffectStore(home);
  return store.effects
    .filter((e) => (!filter?.status || e.status === filter.status) && (!filter?.runId || e.runId === filter.runId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function markSideEffect(home: string, id: string, status: SideEffectStatus, note = ""): SideEffect {
  const store = loadSideEffectStore(home);
  const effect = getEffect(store, id);
  if (effect.status !== "pending") throw new SideEffectError(`只能标记 pending 状态的副作用，当前为 ${effect.status}`);
  effect.status = status;
  effect.executedAt = nowIso();
  if (note) effect.recoveryNote = String(note).slice(0, 500);
  saveSideEffectStore(home, store);
  return effect;
}

/** recovery note 的只读部分：目录还在不在、是不是 git 仓库、最近 3 条
 * 提交与未提交改动（只读 git 命令，失败就记“git 不可用”，不破坏恢复）。 */
export function buildRecoveryNote(workdir: string): string {
  const lines: string[] = [];
  lines.push(existsSync(workdir) ? `工作目录存在：${workdir}` : `工作目录已不存在：${workdir}`);
  if (!existsSync(workdir)) return lines.join("；");
  try {
    const log = spawnSync("git", ["-C", workdir, "log", "--oneline", "-3"], { encoding: "utf-8", timeout: 5000 });
    if (log.status === 0) {
      lines.push(`最近提交：${log.stdout.trim().split("\n").join(" / ").slice(0, 200) || "（无提交）"}`);
      const status = spawnSync("git", ["-C", workdir, "status", "--porcelain"], { encoding: "utf-8", timeout: 5000 });
      if (status.status === 0) {
        const dirty = status.stdout.trim();
        lines.push(dirty ? `未提交改动 ${dirty.split("\n").length} 个文件` : "工作区干净");
      }
    } else {
      lines.push("不是 git 仓库（或 git 读不到历史）");
    }
  } catch {
    lines.push("git 不可用，未查历史");
  }
  return lines.join("；");
}

export interface SideEffectExecutor {
  /** 已经做过了吗（调用方按 target 复核，如文件存在且内容对得上）？ */
  check?: (effect: SideEffect) => "already-done" | "not-done" | "unknown";
  /** 没做过时重新执行。抛错即 failed。 */
  execute?: (effect: SideEffect) => void | Promise<void>;
}

export interface RecoveryReport {
  total: number;
  alreadyDone: string[];
  executed: string[];
  failed: string[];
  leftPending: string[];
}

/** 重启恢复：按工单年龄从老到新。已经做过的标 done（不重复对外动作，
 * 这是 recovery note 存在的意义）；没做过的交给执行器重做；没有执行器
 * 的留在 pending 并写明原因，不擅自标 done。 */
export async function recoverSideEffects(
  home: string,
  opts?: { executor?: SideEffectExecutor; workdir?: string },
): Promise<RecoveryReport> {
  const report: RecoveryReport = { total: 0, alreadyDone: [], executed: [], failed: [], leftPending: [] };
  const pending = listSideEffects(home, { status: "pending" });
  report.total = pending.length;
  for (const effect of pending) {
    const workdir = opts?.workdir ?? process.cwd();
    const note = buildRecoveryNote(workdir);
    let verdict: "already-done" | "not-done" | "unknown" = "unknown";
    try {
      verdict = opts?.executor?.check?.(effect) ?? "unknown";
    } catch {
      verdict = "unknown";
    }
    if (verdict === "already-done") {
      markSideEffect(home, effect.id, "done", `${note}；复核：已做过，不重复执行`);
      mirrorEvent(home, effect.runId, "side_effect_recovered", { effect_id: effect.id, outcome: "already-done" });
      report.alreadyDone.push(effect.id);
      continue;
    }
    if (!opts?.executor?.execute) {
      const store = loadSideEffectStore(home);
      const row = getEffect(store, effect.id);
      row.recoveryNote = `${note}；未执行：没有执行器，留待人工处理`;
      saveSideEffectStore(home, store);
      report.leftPending.push(effect.id);
      continue;
    }
    try {
      await opts.executor.execute(effect);
      markSideEffect(home, effect.id, "done", `${note}；已重新执行`);
      mirrorEvent(home, effect.runId, "side_effect_recovered", { effect_id: effect.id, outcome: "executed" });
      report.executed.push(effect.id);
    } catch (err: unknown) {
      markSideEffect(home, effect.id, "failed", `${note}；重新执行失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
      mirrorEvent(home, effect.runId, "side_effect_recovered", { effect_id: effect.id, outcome: "failed" });
      report.failed.push(effect.id);
    }
  }
  return report;
}

const USAGE =
  "用法：nyra side-effects <list|show|record|mark|recover> [选项]\n" +
  "  list [--status pending|done|failed|skipped] [--run <运行 id>] [--json]\n" +
  "  show <副作用 id> [--json]\n" +
  "  record \"<描述>\" [--kind file_write|external_send|shell|other] [--target \"<目标摘要>\"] [--run <运行 id>]\n" +
  "  mark <副作用 id> <done|failed|skipped> [--note \"<说明>\"]\n" +
  "  recover          按年龄从老到新恢复 pending 项（无执行器时只写 recovery note、不擅自标 done）\n";

export async function handleSideEffects(argv: string[], home: string): Promise<number> {
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
      const effects = listSideEffects(resolvedHome, {
        status: get("--status") as SideEffectStatus | undefined,
        runId: get("--run"),
      });
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(effects, null, 2) + "\n");
        return 0;
      }
      if (!effects.length) {
        process.stdout.write("副作用队列是空的（nyra side-effects record \"<描述>\" 先记下来再执行）。\n");
        return 0;
      }
      for (const e of effects) {
        process.stdout.write(`${e.id} [${e.status}] ${e.kind} ${e.description.slice(0, 60)}${e.target ? ` → ${e.target}` : ""}\n`);
      }
      return 0;
    }
    if (action === "show") {
      const effect = getSideEffect(resolvedHome, argv[1] ?? "");
      process.stdout.write(JSON.stringify(effect, null, 2) + "\n");
      return 0;
    }
    if (action === "record") {
      const description = argv[1] ?? "";
      const effect = recordSideEffect(resolvedHome, {
        description, kind: (get("--kind") as SideEffectKind | undefined) ?? "other",
        target: get("--target"), runId: get("--run"),
      });
      process.stdout.write(`${effect.id}\n`);
      return 0;
    }
    if (action === "mark") {
      const status = argv[2] as SideEffectStatus | undefined;
      if (status !== "done" && status !== "failed" && status !== "skipped") {
        process.stderr.write("错误：用法：nyra side-effects mark <副作用 id> <done|failed|skipped> [--note \"<说明>\"]\n");
        return 2;
      }
      const effect = markSideEffect(resolvedHome, argv[1] ?? "", status, get("--note") ?? "");
      process.stdout.write(`${effect.id} 已标 ${effect.status}。\n`);
      return 0;
    }
    if (action === "recover") {
      const report = await recoverSideEffects(resolvedHome, {});
      process.stdout.write(`恢复完成：pending ${report.total} 项，已做过 ${report.alreadyDone.length} 项，重新执行 ${report.executed.length} 项，失败 ${report.failed.length} 项，留待人工 ${report.leftPending.length} 项（无执行器时不擅自标 done）。\n`);
      return report.failed.length ? 1 : 0;
    }
    process.stderr.write(`错误：未知子命令 side-effects ${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
