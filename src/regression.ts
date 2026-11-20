// src/regression.ts — G-3：失败 → 回归测试集（7×24 自改进环的测例库）。
//
// 一次运行跑完后，它的失败步骤可以沉淀为回归测试用例：下次改指令或改
// harness 后，先跑回归集——同一类失败再出现就立刻知道，不用等用户撞上。
// 本批只做确定性沉淀与记录：
//   - 沉淀来源是时间线已经记下的失败步骤（failedStepSummaries，与阶段表
//     同一份失败口径，不另造一套）；
//   - 只记元数据（失败类型、步骤标题、来源运行 id），不记 prompt/回答、
//     不记参数原文、不记绝对路径；
//   - 不调模型、不自动改代码、不自动重跑回归集（跑回归集是下一批；
//     “重打分”也是下一批——本批沉淀的是运行里已经打过的分）。
// 账本 ~/.nyra/regression-cases.json（原子写 0600，损坏先备份再抛错，
// 与 business-redlines.json 同款口径）；用例状态 open / verified / retired。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";
import { RunStore } from "./runs.ts";
import { buildTimeline, failedStepSummaries, type FailedStepSummary, type Timeline } from "./timeline.ts";

export class RegressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegressionError";
  }
}

export type RegressionKind = "tool-failed" | "delegate-failed" | "verdict-failed" | "llm-failed" | "run-error";
export type RegressionStatus = "open" | "verified" | "retired";

export interface RegressionCase {
  id: string;
  sourceRunId: string;
  kind: RegressionKind;
  title: string;
  detail: string | null;
  status: RegressionStatus;
  createdAt: string;
}

export interface RegressionHistoryEntry {
  at: string;
  action: "added" | "removed" | "status";
  caseId: string;
  note: string;
}

export interface RegressionStore {
  version: 1;
  cases: RegressionCase[];
  history: RegressionHistoryEntry[];
}

export function regressionStorePath(home: string): string {
  return join(home, "regression-cases.json");
}

const KIND_MAP: Record<FailedStepSummary["kind"], RegressionKind> = {
  tool: "tool-failed",
  delegate: "delegate-failed",
  verdict: "verdict-failed",
  llm: "llm-failed",
  run: "run-error",
};

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function newCaseId(): string {
  return `rg_${randomBytes(6).toString("hex")}`;
}

/** 去重键：同一次运行、同类失败、同一步骤标题只留一例。 */
export function caseKey(c: Pick<RegressionCase, "sourceRunId" | "kind" | "title">): string {
  return `${c.sourceRunId}|${c.kind}|${c.title}`;
}

/** 从一条时间线提炼回归用例（纯函数）：失败步骤各一例，标题与 detail 只取元数据。 */
export function precipitateFromTimeline(tl: Timeline): RegressionCase[] {
  const at = nowIso();
  const seen = new Set<string>();
  const out: RegressionCase[] = [];
  for (const f of failedStepSummaries(tl)) {
    const c: RegressionCase = {
      id: newCaseId(),
      sourceRunId: tl.runId,
      kind: KIND_MAP[f.kind],
      title: f.label,
      detail: f.detail,
      status: "open",
      createdAt: at,
    };
    const key = caseKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err: unknown) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/** 读回归测例库；不存在返回空库；损坏先备份再抛错（不静默重建）。 */
export function loadRegressionStore(home: string): RegressionStore {
  const path = regressionStorePath(home);
  if (!existsSync(path)) return { version: 1, cases: [], history: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new RegressionError(`回归测例库损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || !Array.isArray((raw as RegressionStore).cases)
    || !Array.isArray((raw as RegressionStore).history)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new RegressionError(`回归测例库格式无效，已备份到 ${backup}`);
  }
  return raw as RegressionStore;
}

export function saveRegressionStore(home: string, store: RegressionStore): void {
  atomicWriteJson(regressionStorePath(home), store);
}

/** 沉淀进库：同（来源运行、类型、标题）已在库里时跳过，返回新增/跳过数。 */
export function addRegressionCases(home: string, cases: RegressionCase[]): { added: number; skipped: number } {
  const store = loadRegressionStore(home);
  const existing = new Set(store.cases.map(caseKey));
  let added = 0;
  let skipped = 0;
  for (const c of cases) {
    if (existing.has(caseKey(c))) { skipped += 1; continue; }
    existing.add(caseKey(c));
    store.cases.push(c);
    store.history.push({ at: nowIso(), action: "added", caseId: c.id, note: `${c.kind}（来源运行 ${c.sourceRunId}）` });
    added += 1;
  }
  if (added > 0) saveRegressionStore(home, store);
  return { added, skipped };
}

export function removeRegressionCase(home: string, id: string): boolean {
  const store = loadRegressionStore(home);
  const idx = store.cases.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  const [removed] = store.cases.splice(idx, 1);
  store.history.push({ at: nowIso(), action: "removed", caseId: id, note: removed.title });
  saveRegressionStore(home, store);
  return true;
}

export function setRegressionCaseStatus(home: string, id: string, status: RegressionStatus): boolean {
  const store = loadRegressionStore(home);
  const c = store.cases.find((x) => x.id === id);
  if (!c) return false;
  if (c.status === status) return true;
  const from = c.status;
  c.status = status;
  store.history.push({ at: nowIso(), action: "status", caseId: id, note: `${from} → ${status}` });
  saveRegressionStore(home, store);
  return true;
}

// ---- 子命令：regression（G-3：回归测例库） ----
// 只做沉淀与记录：list / precipitate / remove / status。不调模型、不自动
// 改代码、不自动重跑回归集。删除是破坏性操作，须加 --yes 才执行。

const USAGE = "用法：nyra regression <list|precipitate|remove|status> [选项]\n"
  + "  list [--json]  列出回归用例\n"
  + "  precipitate --run <运行 ID>  从一次运行的失败步骤沉淀用例\n"
  + "  remove <用例 id> --yes  删除用例\n"
  + "  status <用例 id> <open|verified|retired>  改用例状态\n";

export function handleRegression(argv: string[], home: string): number {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action) {
    process.stdout.write(USAGE);
    return 2;
  }
  try {
    if (action === "list") {
      const store = loadRegressionStore(resolvedHome);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(store.cases, null, 2) + "\n");
        return 0;
      }
      if (!store.cases.length) {
        process.stdout.write("没有回归用例（先 nyra regression precipitate --run <运行 ID> 从失败运行沉淀）。\n");
        return 0;
      }
      for (const c of store.cases) {
        process.stdout.write(`${c.id} [${c.status}] ${c.kind} ${c.title}（来源运行 ${c.sourceRunId}，${c.createdAt}）\n`);
      }
      return 0;
    }
    if (action === "precipitate") {
      const idx = argv.indexOf("--run");
      const runId = idx >= 0 ? argv[idx + 1] ?? "" : "";
      if (!runId) {
        process.stderr.write("错误：precipitate 需要 --run <运行 ID>\n");
        return 2;
      }
      const store = new RunStore(join(resolvedHome, "runs"));
      let tl: Timeline;
      try {
        tl = buildTimeline(store, runId);
      } catch {
        process.stderr.write(`找不到运行 ${runId}\n`);
        return 2;
      }
      const cases = precipitateFromTimeline(tl);
      if (!cases.length) {
        process.stdout.write(`运行 ${runId} 没有失败步骤，无用例可沉淀。\n`);
        return 0;
      }
      const { added, skipped } = addRegressionCases(resolvedHome, cases);
      process.stdout.write(`沉淀完成：失败步骤 ${cases.length} 个，新增 ${added} 条，跳过 ${skipped} 条（已在库里），来源运行 ${runId}。\n`);
      return 0;
    }
    if (action === "remove") {
      const id = argv[1] ?? "";
      if (!id) {
        process.stderr.write("错误：用法：nyra regression remove <用例 id> --yes\n");
        return 2;
      }
      if (!argv.includes("--yes")) {
        process.stderr.write("删除用例须加 --yes 确认：nyra regression remove <用例 id> --yes\n");
        return 2;
      }
      if (!removeRegressionCase(resolvedHome, id)) {
        process.stderr.write(`找不到用例 ${id}\n`);
        return 1;
      }
      process.stdout.write(`已删除用例 ${id}。\n`);
      return 0;
    }
    if (action === "status") {
      const id = argv[1] ?? "";
      const status = argv[2] ?? "";
      if (!id || (status !== "open" && status !== "verified" && status !== "retired")) {
        process.stderr.write("错误：用法：nyra regression status <用例 id> <open|verified|retired>\n");
        return 2;
      }
      if (!setRegressionCaseStatus(resolvedHome, id, status)) {
        process.stderr.write(`找不到用例 ${id}\n`);
        return 1;
      }
      process.stdout.write(`用例 ${id} 状态已改为 ${status}。\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 regression ${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
