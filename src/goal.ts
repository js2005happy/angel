// src/goal.ts — GROK-5：长目标对象（目标陈述 + 动态进度清单 + 逐项验证）。
//
// 做法借的是 Grok Build / Cursor 的 /goal 背后的“目标对象”设计，不是名字，
// 也不抄命令：目标对象 = 目标陈述 + 动态进度清单 + 逐项验证，全部通过才标
// 完成；中途可加指令不丢目标；可暂停 / 恢复 / 取消。
//
// 为什么需要它：长任务以前没有“完成”的明确定义，模型自己说完了就算。
// 目标对象把“完成”变成账本上的状态：清单每一项都有状态（待做 / 进行中 /
// 已验证通过 / 未通过 / 已取消），每一项的验证都附证据（方法 + 结论 +
// 通过与否），全部通过才允许标完成；暂停与恢复有状态可续，取消是终态。
//
// 诚实边界（写进文档，不粉饰）：
//   - 清单是模型自己生成的，清单错了目标就错了——目标对象只保证“清单
//     全过”，不保证“清单本身是对的”。清单本身对不对，靠人审清单。
//   - 验证是操作性的，不是形式化的：逐项验证核的是“按声称的方法跑了、
//     给了结论”，不是“目标在真实世界里真达成了”。“清单全过”不等于
//     “目标真对了”，不要把前者写成后者。
//   - 确定性检查（verifier 的 runDeterministicChecks）只核说法与文件
//     存在性，不验语义；模型复核腿不在本批——逐项验证默认是人工证据
//     （方法 + 结论），供了 --files 才跑确定性检查。
//
// 与任务板的关系（口径写清，不混用）：
//   - 目标可以拆成任务板任务（split/link），但目标完成以“清单全过”
//     为准，不以任务板行全 done 为准：任务板行 done 了，清单项仍须
//     自己附验证证据才算通过；反过来清单项通过了，关联的任务板行不
//     会自动变 done，两边各按各的完成边界走。
//   - 恢复前重验证：恢复时逐项重核已验证项——证据记录还在不在、关联
//     的任务板任务还在不在、供过 --files 的重跑确定性检查；证据失效
//     的项退回待做（不静默保留“已验证”）。
//
// 账本 ~/.nyra/goals.json（原子写 0600，损坏先备份再抛错，与 kanban.json
// 同款口径）；只记元数据与验证结论，不记任务正文以外的模型输出、不记
// 参数原文、不记绝对路径（workdir 只在验证证据里记调用方传的相对路径
// 或原样传的工作目录，事件里不记——过 appendEvent 的 redact 会把长词
// 串掩掉）。
//
// 本模块不 import tools.ts（运行时），只 import kanban.ts（拆/关联任务板
// 任务）、verifier.ts（确定性检查）、runs.ts（事件镜像）——三者都不 import
// goal.ts，没有循环导入。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveHome } from "./config.ts";
import { RunStore } from "./runs.ts";
import { SOUL_AGENT_ID_RE } from "./soul.ts";
import { createKanbanTask, getKanbanTask, loadKanbanStore, type KanbanTask } from "./kanban.ts";
import { runDeterministicChecks, type VerifierCheck } from "./verifier.ts";

export class GoalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalError";
  }
}

export type GoalStatus = "active" | "paused" | "completed" | "cancelled";
export type ChecklistStatus = "pending" | "in_progress" | "verified" | "failed" | "cancelled";

export interface GoalItemVerification {
  method: string;
  summary: string;
  passed: boolean;
  at: string;
  /** 供过 --files 时的确定性检查证据：文件清单 + 工作目录；恢复时重跑同一组检查。 */
  evidence: { files: string[]; workdir: string | null; diffStat: string | null } | null;
}

export interface GoalChecklistItem {
  id: string;
  title: string;
  status: ChecklistStatus;
  verification: GoalItemVerification | null;
  kanbanTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalInstruction {
  at: string;
  text: string;
}

export interface Goal {
  id: string;
  statement: string;
  status: GoalStatus;
  agent: string | null;
  checklist: GoalChecklistItem[];
  instructions: GoalInstruction[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelReason: string | null;
}

export interface GoalHistoryEntry {
  at: string;
  action: string;
  goalId: string;
  note: string;
}

export interface GoalStore {
  version: 1;
  goals: Goal[];
  history: GoalHistoryEntry[];
}

export const MAX_STATEMENT_CHARS = 1000;
export const MAX_ITEM_TITLE_CHARS = 200;
export const MAX_INSTRUCTION_CHARS = 1000;
export const MAX_CANCEL_REASON_CHARS = 300;
export const MAX_CHECKLIST_ITEMS = 50;

export function goalPath(home: string): string {
  return join(home, "goals.json");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function newGoalId(): string {
  return `goal_${randomBytes(6).toString("hex")}`;
}

function newItemId(): string {
  return `chk_${randomBytes(4).toString("hex")}`;
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadGoalStore(home: string): GoalStore {
  const path = goalPath(home);
  if (!existsSync(path)) return { version: 1, goals: [], history: [] };
  if (lstatSync(path).isSymbolicLink()) throw new GoalError("目标账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new GoalError("目标账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as GoalStore).version !== 1 ||
    !Array.isArray((raw as GoalStore).goals) || !Array.isArray((raw as GoalStore).history)) {
    backupCorrupt(path);
    throw new GoalError("目标账本格式无效，已备份");
  }
  return raw as GoalStore;
}

export function saveGoalStore(home: string, store: GoalStore): void {
  const path = goalPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new GoalError("目标账本不能是符号链接");
  const tmp = join(dirname(path), `.goals-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function recordHistory(store: GoalStore, action: string, goalId: string, note: string): void {
  store.history.push({ at: nowIso(), action, goalId, note: note.slice(0, 200) });
  if (store.history.length > 500) store.history.splice(0, store.history.length - 500);
}

/** 有运行上下文时把目标动作镜像进运行事件（证据链）；没上下文时账本
 *  history 就是审计，不静默丢——mirror 失败一律吞掉，只写账本。
 *  与 kanban.ts 的 mirrorEvent 同款（tasks 目录 → runs 目录）。 */
function mirrorGoalEvent(home: string, runId: string | null | undefined, type: string, fields: Record<string, unknown>): void {
  if (!runId) return;
  for (const dir of ["tasks", "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      store.load(runId);
      store.appendEvent(runId, type, fields);
      return;
    } catch { /* 不在这个目录，换下一个 */ }
  }
}

function getGoal(store: GoalStore, id: string): Goal {
  const goal = store.goals.find((g) => g.id === id);
  if (!goal) throw new GoalError(`找不到目标 ${id}`);
  return goal;
}

function getItem(goal: Goal, itemId: string): GoalChecklistItem {
  const item = goal.checklist.find((i) => i.id === itemId);
  if (!item) throw new GoalError(`目标 ${goal.id} 里找不到清单项 ${itemId}`);
  return item;
}

export interface GoalProgress {
  total: number;
  verified: number;
  pending: number;
  inProgress: number;
  failed: number;
  cancelled: number;
}

/** 清单进度：一眼看清还剩几项没过（complete 的拒绝文案与 show 共用）。 */
export function goalProgress(goal: Goal): GoalProgress {
  const p: GoalProgress = { total: goal.checklist.length, verified: 0, pending: 0, inProgress: 0, failed: 0, cancelled: 0 };
  for (const item of goal.checklist) {
    if (item.status === "verified") p.verified += 1;
    else if (item.status === "pending") p.pending += 1;
    else if (item.status === "in_progress") p.inProgress += 1;
    else if (item.status === "failed") p.failed += 1;
    else p.cancelled += 1;
  }
  return p;
}

export function progressLine(goal: Goal): string {
  const p = goalProgress(goal);
  return `${p.verified}/${p.total} 项已验证${p.pending ? `，${p.pending} 项待做` : ""}${p.inProgress ? `，${p.inProgress} 项进行中` : ""}${p.failed ? `，${p.failed} 项未通过` : ""}${p.cancelled ? `，${p.cancelled} 项已取消` : ""}`;
}

function checkAgent(agent: string | null | undefined): string | null {
  if (agent === null || agent === undefined) return null;
  if (!SOUL_AGENT_ID_RE.test(agent)) throw new GoalError("agent 必须是小写字母开头的 agent id（小写字母/数字/_/-，最长 32 字）");
  return agent;
}

function checkMutable(goal: Goal, what: string): void {
  if (goal.status === "completed") throw new GoalError(`目标已完成，不能再${what}`);
  if (goal.status === "cancelled") throw new GoalError(`目标已取消（终态），不能再${what}`);
}

export function createGoal(
  home: string,
  opts: { statement: string; agent?: string | null; items?: string[]; runId?: string | null },
): Goal {
  const statement = (opts.statement ?? "").trim();
  if (!statement) throw new GoalError("目标陈述不能为空");
  if (statement.length > MAX_STATEMENT_CHARS) throw new GoalError("目标陈述过长（超过 1000 字符）");
  const agent = checkAgent(opts.agent);
  const titles = (opts.items ?? []).map((t) => t.trim()).filter(Boolean);
  if (titles.length > MAX_CHECKLIST_ITEMS) throw new GoalError(`清单最多 ${MAX_CHECKLIST_ITEMS} 项`);
  for (const t of titles) {
    if (t.length > MAX_ITEM_TITLE_CHARS) throw new GoalError("清单项标题过长（超过 200 字符）");
  }
  const store = loadGoalStore(home);
  const at = nowIso();
  const goal: Goal = {
    id: newGoalId(), statement, status: "active", agent,
    checklist: titles.map((title) => ({
      id: newItemId(), title, status: "pending" as ChecklistStatus,
      verification: null, kanbanTaskId: null, createdAt: at, updatedAt: at,
    })),
    instructions: [], createdAt: at, updatedAt: at, completedAt: null, cancelReason: null,
  };
  store.goals.push(goal);
  recordHistory(store, "created", goal.id, `建目标（${goal.checklist.length} 项清单）`);
  saveGoalStore(home, store);
  mirrorGoalEvent(home, opts.runId, "goal_created", { goal_id: goal.id });
  return goal;
}

export function getGoalById(home: string, id: string): Goal {
  return getGoal(loadGoalStore(home), id);
}

export function listGoals(home: string, filter?: { status?: GoalStatus; agent?: string }): Goal[] {
  const store = loadGoalStore(home);
  return store.goals
    .filter((g) => (!filter?.status || g.status === filter.status) && (!filter?.agent || g.agent === filter.agent))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 加清单项：目标进行中（active/paused）才能加；已完成/已取消是终态。 */
export function addChecklistItem(home: string, goalId: string, title: string, opts?: { runId?: string | null }): GoalChecklistItem {
  const clean = (title ?? "").trim();
  if (!clean) throw new GoalError("清单项标题不能为空");
  if (clean.length > MAX_ITEM_TITLE_CHARS) throw new GoalError("清单项标题过长（超过 200 字符）");
  const store = loadGoalStore(home);
  const goal = getGoal(store, goalId);
  checkMutable(goal, "加清单项");
  if (goal.checklist.length >= MAX_CHECKLIST_ITEMS) throw new GoalError(`清单最多 ${MAX_CHECKLIST_ITEMS} 项`);
  const at = nowIso();
  const item: GoalChecklistItem = {
    id: newItemId(), title: clean, status: "pending",
    verification: null, kanbanTaskId: null, createdAt: at, updatedAt: at,
  };
  goal.checklist.push(item);
  goal.updatedAt = at;
  recordHistory(store, "item_added", goal.id, `加清单项：${clean.slice(0, 60)}`);
  saveGoalStore(home, store);
  mirrorGoalEvent(home, opts?.runId, "goal_item_added", { goal_id: goal.id, item_id: item.id });
  return item;
}

/** 清单项开工：pending → in_progress（failed 的项重做也走这里：failed → in_progress）。 */
export function startChecklistItem(home: string, goalId: string, itemId: string, opts?: { runId?: string | null }): GoalChecklistItem {
  const store = loadGoalStore(home);
  const goal = getGoal(store, goalId);
  checkMutable(goal, "改清单项状态");
  const item = getItem(goal, itemId);
  if (item.status !== "pending" && item.status !== "failed") {
    throw new GoalError(`只能开工 pending/failed 状态的清单项，当前为 ${item.status}`);
  }
  item.status = "in_progress";
  item.updatedAt = nowIso();
  goal.updatedAt = item.updatedAt;
  recordHistory(store, "item_started", goal.id, `清单项开工：${item.title.slice(0, 60)}`);
  saveGoalStore(home, store);
  mirrorGoalEvent(home, opts?.runId, "goal_item_started", { goal_id: goal.id, item_id: item.id });
  return item;
}

export interface VerifyItemResult {
  item: GoalChecklistItem;
  /** 供了 --files 时跑的确定性检查；没供时为 null（人工证据口径）。 */
  checks: VerifierCheck[] | null;
}

/**
 * 逐项验证（verifier 接线）：每一项都须附证据——方法 + 结论 + 通过与否。
 * 通过（passed=true）→ verified；未通过 → failed（可重做：failed → start → 再验）。
 * 已取消的项不能验；已验证的项可以重验（新证据可以推翻旧结论，不静默保留）。
 *
 * 供了 files 时接确定性检查（与 `nyra verifier check` 同款口径）：
 * 改动文件须存在、diff 摘要须完整、证据须齐全；任一检查未通过时，本次
 * 验证强制记 failed（声称的 passed 也不认），失败的检查名写进结论里——
 * 调用方补齐证据（比如补 --diff-stat）后可重验。
 * 没供 files 时是人工证据口径：只记方法 + 结论，不跑检查——结论的真假
 * 由写结论的人负责，账本只保证“有结论”，不保证“结论是对的”。
 */
export function verifyChecklistItem(
  home: string,
  goalId: string,
  itemId: string,
  verification: { method: string; summary: string; passed: boolean; files?: string[]; workdir?: string | null; diffStat?: string | null },
  opts?: { runId?: string | null },
): VerifyItemResult {
  const method = (verification.method ?? "").trim().slice(0, 60);
  if (!method) throw new GoalError("验证方法不能为空");
  const summary = String(verification.summary ?? "").trim();
  if (!summary) throw new GoalError("验证结论不能为空");
  const store = loadGoalStore(home);
  const goal = getGoal(store, goalId);
  checkMutable(goal, "验证清单项");
  const item = getItem(goal, itemId);
  if (item.status === "cancelled") throw new GoalError("已取消的清单项不能验证");
  let checks: VerifierCheck[] | null = null;
  let passed = verification.passed;
  let finalSummary = summary.slice(0, 300);
  let evidence: GoalItemVerification["evidence"] = null;
  const files = (verification.files ?? []).map((f) => f.trim()).filter(Boolean);
  if (files.length > 0) {
    const workdir = verification.workdir ?? process.cwd();
    checks = runDeterministicChecks({
      title: item.title, summary,
      changedFiles: files, diffStat: verification.diffStat ?? null,
      worktreePath: null, workdir, spentUsd: null,
    });
    const failed = checks.filter((c) => !c.passed);
    evidence = { files, workdir, diffStat: verification.diffStat ?? null };
    if (failed.length > 0) {
      passed = false;
      finalSummary = `${finalSummary}（确定性检查未通过：${failed.map((c) => c.label).join("、")}）`.slice(0, 300);
    }
  }
  const at = nowIso();
  item.verification = { method, summary: finalSummary, passed, at, evidence };
  item.status = passed ? "verified" : "failed";
  item.updatedAt = at;
  goal.updatedAt = at;
  recordHistory(store, "item_verified", goal.id, `${item.title.slice(0, 40)}：${method} ${passed ? "通过" : "未通过"}`);
  saveGoalStore(home, store);
  mirrorGoalEvent(home, opts?.runId, "goal_item_verified", { goal_id: goal.id, item_id: item.id, method, passed });
  return { item, checks };
}

export interface GoalCompletionStatus {
  complete: boolean;
  total: number;
  verified: number;
  pending: string[];
  inProgress: string[];
  failed: string[];
  cancelled: string[];
}

/** 完成判定（纯函数）：清单非空且每一项都是 verified 才算 complete。
 *  这是“完成”的唯一口径——任务板行全 done 不算，模型自述完成也不算。 */
export function goalCompletionStatus(goal: Goal): GoalCompletionStatus {
  const st: GoalCompletionStatus = {
    complete: false, total: goal.checklist.length, verified: 0,
    pending: [], inProgress: [], failed: [], cancelled: [],
  };
  for (const item of goal.checklist) {
    if (item.status === "verified") st.verified += 1;
    else if (item.status === "pending") st.pending.push(item.title);
    else if (item.status === "in_progress") st.inProgress.push(item.title);
    else if (item.status === "failed") st.failed.push(item.title);
    else st.cancelled.push(item.title);
  }
  st.complete = st.total > 0 && st.verified === st.total;
  return st;
}

/** 标完成：只从 active 标（paused 先 resume）；清单为空标不上去；任一
 *  项没过都标不上去，拒绝文案列清还剩哪些项、分别卡在哪。 */
export function completeGoal(home: string, goalId: string, opts?: { runId?: string | null }): Goal {
  const store = loadGoalStore(home);
  const goal = getGoal(store, goalId);
  if (goal.status === "completed") throw new GoalError("目标已经完成了");
  if (goal.status === "cancelled") throw new GoalError("目标已取消（终态），不能标完成");
  if (goal.status === "paused") throw new GoalError("目标已暂停，先恢复（nyra goal resume）再标完成");
  const st = goalCompletionStatus(goal);
  if (st.total === 0) throw new GoalError("清单是空的：先加清单项（nyra goal add-item），全过才能标完成");
  if (!st.complete) {
    const left: string[] = [];
    if (st.pending.length) left.push(`${st.pending.length} 项待做（${st.pending.slice(0, 3).join("、")}${st.pending.length > 3 ? "…" : ""}）`);
    if (st.inProgress.length) left.push(`${st.inProgress.length} 项进行中（${st.inProgress.slice(0, 3).join("、")}${st.inProgress.length > 3 ? "…" : ""}）`);
    if (st.failed.length) left.push(`${st.failed.length} 项未通过（${st.failed.slice(0, 3).join("、")}${st.failed.length > 3 ? "…" : ""}）`);
    if (st.cancelled.length) left.push(`${st.cancelled.length} 项已取消（${st.cancelled.slice(0, 3).join("、")}${st.cancelled.length > 3 ? "…" : ""}）`);
    throw new GoalError(`清单没全过，标不上去（${st.verified}/${st.total} 项已验证）：${left.join("；")}`);
  }
  const at = nowIso();
  goal.status = "completed";
  goal.completedAt = at;
  goal.updatedAt = at;
  recordHistory(store, "completed", goal.id, `清单 ${st.verified}/${st.total} 项全过，标完成`);
  saveGoalStore(home, store);
  mirrorGoalEvent(home, opts?.runId, "goal_completed", { goal_id: goal.id, items: st.total });
  return goal;
}

/** 暂停：active → paused（清单与指令原样保留，恢复后接着干）。 */
export function pauseGoal(home: string, goalId: string, opts?: { runId?: string | null }): Goal {
  const store = loadGoalStore(home);
  const goal = getGoal(store, goalId);
  if (goal.status !== "active") throw new GoalError(`只能暂停进行中的目标，当前为 ${goal.status}`);
  goal.status = "paused";
  goal.updatedAt = nowIso();
  recordHistory(store, "paused", goal.id, "目标暂停");
  saveGoalStore(home, store);
  mirrorGoalEvent(home, opts?.runId, "goal_paused", { goal_id: goal.id });
  return goal;
}

/**
 * 恢复：paused → active，恢复前重验证（确定性重核，不调模型）——
 *   1. 已验证项的验证记录还在不在（缺了就退回待做）；
 *   2. 关联的任务板任务还在不在（被删了就退回待做：证据所指的任务已不存在）；
 *   3. 供过 --files 的项，按当时存下的证据重跑确定性检查（文件被删改后
 *      检查不过的，同样退回待做）。
 * 退回的项记进 resetItems（事件 goal_resumed 的 reset_items 字段与 history
 * 都有数）；没退回的项原样保留“已验证”，不重验、不重置。
 */
export function resumeGoal(home: string, goalId: string, opts?: { runId?: string | null }): { goal: Goal; resetItems: string[] } {
  const store = loadGoalStore(home);
  const goal = getGoal(store, goalId);
  if (goal.status !== "paused") throw new GoalError(`只能恢复已暂停的目标，当前为 ${goal.status}`);
  const resetItems: string[] = [];
  let kanban: { tasks: KanbanTask[] } | null = null;
  for (const item of goal.checklist) {
    if (item.status !== "verified") continue;
    let bad = !item.verification;
    if (!bad && item.kanbanTaskId) {
      if (!kanban) kanban = loadKanbanStore(home);
      if (!kanban.tasks.some((t) => t.id === item.kanbanTaskId)) bad = true;
    }
    if (!bad && item.verification?.evidence) {
      const ev = item.verification.evidence;
      const checks = runDeterministicChecks({
        title: item.title, summary: item.verification.summary,
        changedFiles: ev.files, diffStat: ev.diffStat,
        worktreePath: null, workdir: ev.workdir, spentUsd: null,
      });
      if (checks.some((c) => !c.passed)) bad = true;
    }
    if (bad) {
      item.status = "pending";
      item.verification = null;
      item.updatedAt = nowIso();
      resetItems.push(item.title);
    }
  }
  goal.status = "active";
  goal.updatedAt = nowIso();
  recordHistory(store, "resumed", goal.id,
    resetItems.length ? `恢复，${resetItems.length} 项证据失效退回待做` : "恢复（已验证项重核全过）");
  saveGoalStore(home, store);
  mirrorGoalEvent(home, opts?.runId, "goal_resumed", { goal_id: goal.id, reset_items: resetItems.length });
  return { goal, resetItems };
}

/** 取消是终态：active/paused → cancelled；未终态的清单项（待做/进行中/
 *  未通过）跟着进 cancelled，已验证的项保留“已验证”（证据本身还成立，
 *  只是目标不做了）。取消后任何改动都拒绝。 */
export function cancelGoal(home: string, goalId: string, reason: string, opts?: { runId?: string | null }): Goal {
  const clean = (reason ?? "").trim();
  if (!clean) throw new GoalError("取消原因不能为空");
  if (clean.length > MAX_CANCEL_REASON_CHARS) throw new GoalError("取消原因过长（超过 300 字符）");
  const store = loadGoalStore(home);
  const goal = getGoal(store, goalId);
  if (goal.status === "completed") throw new GoalError("目标已完成，不能取消");
  if (goal.status === "cancelled") throw new GoalError("目标已取消（终态）");
  const at = nowIso();
  for (const item of goal.checklist) {
    if (item.status === "pending" || item.status === "in_progress" || item.status === "failed") {
      item.status = "cancelled";
      item.updatedAt = at;
    }
  }
  goal.status = "cancelled";
  goal.cancelReason = clean.slice(0, MAX_CANCEL_REASON_CHARS);
  goal.updatedAt = at;
  recordHistory(store, "cancelled", goal.id, `取消：${clean.slice(0, 100)}`);
  saveGoalStore(home, store);
  const reasonHash = createHash("sha256").update(clean).digest("hex").slice(0, 12);
  mirrorGoalEvent(home, opts?.runId, "goal_cancelled", { goal_id: goal.id, reason_hash: reasonHash });
  return goal;
}

/** 中途加指令：active/paused 都能加；指令追加进目标记录，不重置清单、
 *  不改已验证项的状态、不动目标状态——目标丢不了，加指令也不会把已
 *  做的进度清掉。 */
export function addInstruction(home: string, goalId: string, text: string, opts?: { runId?: string | null }): GoalInstruction {
  const clean = (text ?? "").trim();
  if (!clean) throw new GoalError("追加指令不能为空");
  if (clean.length > MAX_INSTRUCTION_CHARS) throw new GoalError("追加指令过长（超过 1000 字符）");
  const store = loadGoalStore(home);
  const goal = getGoal(store, goalId);
  checkMutable(goal, "加指令");
  const instruction: GoalInstruction = { at: nowIso(), text: clean };
  goal.instructions.push(instruction);
  goal.updatedAt = instruction.at;
  recordHistory(store, "instruction_added", goal.id, `追加指令：${clean.slice(0, 100)}`);
  saveGoalStore(home, store);
  mirrorGoalEvent(home, opts?.runId, "goal_instruction_added", { goal_id: goal.id });
  return instruction;
}

/** 关联任务板任务：清单项绑一个已存在的任务板任务（只记 id，不复制
 *  任务内容；任务不存在直接拒绝，不建幽灵关联）。 */
export function linkChecklistItem(
  home: string, goalId: string, itemId: string, kanbanTaskId: string,
  opts?: { runId?: string | null },
): GoalChecklistItem {
  const store = loadGoalStore(home);
  const goal = getGoal(store, goalId);
  checkMutable(goal, "关联任务板任务");
  const item = getItem(goal, itemId);
  if (item.status === "cancelled") throw new GoalError("已取消的清单项不能关联任务板任务");
  getKanbanTask(home, kanbanTaskId);
  item.kanbanTaskId = kanbanTaskId;
  item.updatedAt = nowIso();
  goal.updatedAt = item.updatedAt;
  recordHistory(store, "item_linked", goal.id, `清单项关联任务板任务 ${kanbanTaskId}`);
  saveGoalStore(home, store);
  mirrorGoalEvent(home, opts?.runId, "goal_item_linked", { goal_id: goal.id, item_id: item.id, task_id: kanbanTaskId });
  return item;
}

/** 拆成任务板任务：在任务板上建一行（kind: task）并关联到清单项。
 *  任务板行有自己的完成边界（须附验证证据才能 done），与清单项的验证
 *  各算各的：行 done 了不等于项通过了，项通过了也不会自动把行标 done。 */
export function splitChecklistItem(
  home: string, goalId: string, itemId: string, title: string,
  opts?: { agent?: string | null; runId?: string | null },
): { item: GoalChecklistItem; task: KanbanTask } {
  const clean = (title ?? "").trim();
  if (!clean) throw new GoalError("任务标题不能为空");
  const store = loadGoalStore(home);
  const goal = getGoal(store, goalId);
  checkMutable(goal, "拆任务板任务");
  const item = getItem(goal, itemId);
  if (item.status === "cancelled") throw new GoalError("已取消的清单项不能拆任务板任务");
  const task = createKanbanTask(home, { title: clean, kind: "task", agent: checkAgent(opts?.agent) });
  item.kanbanTaskId = task.id;
  item.updatedAt = nowIso();
  goal.updatedAt = item.updatedAt;
  recordHistory(store, "item_split", goal.id, `清单项拆成任务板任务 ${task.id}：${clean.slice(0, 60)}`);
  saveGoalStore(home, store);
  mirrorGoalEvent(home, opts?.runId, "goal_item_linked", { goal_id: goal.id, item_id: item.id, task_id: task.id });
  return { item, task };
}

const USAGE =
  "用法：nyra goal <create|list|show|add-item|start-item|verify-item|complete|pause|resume|cancel|instruct|link|split> [选项]\n" +
  "  create \"<目标陈述>\" [--agent <名字>] [--item \"<清单项>\" ...] [--run <运行 id>]\n" +
  "  list [--status active|paused|completed|cancelled] [--agent <名字>] [--json]\n" +
  "  show <目标 id> [--json]\n" +
  "  add-item <目标 id> \"<清单项标题>\"\n" +
  "  start-item <目标 id> <清单项 id>        清单项开工（待做/未通过 → 进行中）\n" +
  "  verify-item <目标 id> <清单项 id> --method \"<方法>\" --summary \"<结论>\" [--passed|--failed] [--files <逗号分隔的改动文件> --workdir <目录> --diff-stat \"<文本>\"]\n" +
  "  complete <目标 id>                      清单全过才标完成（任务板行全 done 不算）\n" +
  "  pause <目标 id>\n" +
  "  resume <目标 id>                        恢复前重验证：证据失效的项退回待做\n" +
  "  cancel <目标 id> \"<原因>\" --yes         取消是终态\n" +
  "  instruct <目标 id> \"<追加指令>\"          中途加指令，不丢目标、不重置清单\n" +
  "  link <目标 id> <清单项 id> <任务板任务 id>\n" +
  "  split <目标 id> <清单项 id> \"<任务标题>\" [--agent <名字>]   拆成任务板任务并关联\n";

function printGoal(goal: Goal): void {
  process.stdout.write(`目标 ${goal.id} [${goal.status}]${goal.agent ? ` @${goal.agent}` : ""}\n`);
  process.stdout.write(`  陈述：${goal.statement}\n`);
  process.stdout.write(`  进度：${progressLine(goal)}\n`);
  for (const item of goal.checklist) {
    process.stdout.write(`  ${item.id} [${item.status}] ${item.title.slice(0, 60)}${item.kanbanTaskId ? `（任务板 ${item.kanbanTaskId}）` : ""}${item.verification ? `（验证：${item.verification.method} ${item.verification.passed ? "通过" : "未通过"}）` : ""}\n`);
  }
  if (goal.instructions.length) {
    process.stdout.write(`  追加指令（${goal.instructions.length} 条）：\n`);
    for (const ins of goal.instructions) process.stdout.write(`    - ${ins.text.slice(0, 80)}\n`);
  }
  if (goal.status === "completed" && goal.completedAt) process.stdout.write(`  完成于 ${goal.completedAt}\n`);
  if (goal.status === "cancelled" && goal.cancelReason) process.stdout.write(`  取消原因：${goal.cancelReason}\n`);
}

export function handleGoal(argv: string[], home: string): number {
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
  const getAll = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    }
    return out;
  };
  const runId = get("--run") ?? null;
  try {
    if (action === "create") {
      const goal = createGoal(resolvedHome, {
        statement: argv[1] ?? "", agent: get("--agent") ?? null,
        items: getAll("--item"), runId,
      });
      process.stdout.write(`${goal.id}\n`);
      return 0;
    }
    if (action === "list") {
      const goals = listGoals(resolvedHome, {
        status: get("--status") as GoalStatus | undefined,
        agent: get("--agent"),
      });
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(goals, null, 2) + "\n");
        return 0;
      }
      if (!goals.length) {
        process.stdout.write("没有目标（nyra goal create \"<目标陈述>\" 新建）。\n");
        return 0;
      }
      for (const g of goals) {
        process.stdout.write(`${g.id} [${g.status}] ${g.statement.slice(0, 60)}（${progressLine(g)}）${g.agent ? ` @${g.agent}` : ""}\n`);
      }
      return 0;
    }
    if (action === "show") {
      const goal = getGoalById(resolvedHome, argv[1] ?? "");
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(goal, null, 2) + "\n");
        return 0;
      }
      printGoal(goal);
      return 0;
    }
    if (action === "add-item") {
      const item = addChecklistItem(resolvedHome, argv[1] ?? "", argv[2] ?? "", { runId });
      process.stdout.write(`${item.id}\n`);
      return 0;
    }
    if (action === "start-item") {
      const item = startChecklistItem(resolvedHome, argv[1] ?? "", argv[2] ?? "", { runId });
      process.stdout.write(`${item.id} 已开工（${item.status}）\n`);
      return 0;
    }
    if (action === "verify-item") {
      const method = get("--method") ?? "";
      const summary = get("--summary") ?? "";
      if (!method || !summary) {
        process.stderr.write("错误：用法：nyra goal verify-item <目标 id> <清单项 id> --method \"<方法>\" --summary \"<结论>\" [--passed|--failed] [--files <逗号分隔> --workdir <目录> --diff-stat \"<文本>\"]\n");
        return 2;
      }
      const files = (get("--files") ?? "").split(",").map((f) => f.trim()).filter(Boolean);
      const result = verifyChecklistItem(resolvedHome, argv[1] ?? "", argv[2] ?? "", {
        method, summary,
        passed: argv.includes("--failed") ? false : true,
        files: files.length ? files : undefined,
        workdir: get("--workdir") ?? undefined,
        diffStat: get("--diff-stat") ?? undefined,
      }, { runId });
      const item = result.item;
      if (result.checks) {
        const failed = result.checks.filter((c) => !c.passed);
        process.stdout.write(`${item.id} 验证${item.status === "verified" ? "通过" : "未通过"}（${method}）${failed.length ? `：确定性检查未通过——${failed.map((c) => c.label).join("、")}` : "：确定性检查全过"}\n`);
      } else {
        process.stdout.write(`${item.id} 验证${item.status === "verified" ? "通过" : "未通过"}（${method}，人工证据口径，未跑确定性检查）\n`);
      }
      return 0;
    }
    if (action === "complete") {
      const goal = completeGoal(resolvedHome, argv[1] ?? "", { runId });
      process.stdout.write(`${goal.id} 已完成（${progressLine(goal)}）\n`);
      return 0;
    }
    if (action === "pause") {
      const goal = pauseGoal(resolvedHome, argv[1] ?? "", { runId });
      process.stdout.write(`${goal.id} 已暂停（${goal.status}，恢复用 nyra goal resume ${goal.id}）\n`);
      return 0;
    }
    if (action === "resume") {
      const { goal, resetItems } = resumeGoal(resolvedHome, argv[1] ?? "", { runId });
      process.stdout.write(`${goal.id} 已恢复（${goal.status}）${resetItems.length ? `：${resetItems.length} 项证据失效退回待做（${resetItems.slice(0, 3).join("、")}${resetItems.length > 3 ? "…" : ""}）` : "：已验证项重核全过"}\n`);
      return 0;
    }
    if (action === "cancel") {
      const reason = argv[2] ?? "";
      if (!argv.includes("--yes")) {
        process.stderr.write("取消目标是终态，须加 --yes 确认：nyra goal cancel <目标 id> \"<原因>\" --yes\n");
        return 2;
      }
      const goal = cancelGoal(resolvedHome, argv[1] ?? "", reason, { runId });
      process.stdout.write(`${goal.id} 已取消（${goal.status}）\n`);
      return 0;
    }
    if (action === "instruct") {
      const instruction = addInstruction(resolvedHome, argv[1] ?? "", argv[2] ?? "", { runId });
      process.stdout.write(`已追加指令（${instruction.at}）：${instruction.text.slice(0, 80)}\n`);
      return 0;
    }
    if (action === "link") {
      const item = linkChecklistItem(resolvedHome, argv[1] ?? "", argv[2] ?? "", argv[3] ?? "", { runId });
      process.stdout.write(`${item.id} 已关联任务板任务 ${item.kanbanTaskId}\n`);
      return 0;
    }
    if (action === "split") {
      const { item, task } = splitChecklistItem(resolvedHome, argv[1] ?? "", argv[2] ?? "", argv[3] ?? "", { agent: get("--agent") ?? null, runId });
      process.stdout.write(`${item.id} 已拆成任务板任务 ${task.id}\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 goal ${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
