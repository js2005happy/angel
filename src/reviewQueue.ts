// src/reviewQueue.ts — 缺口 3b：审阅队列（review queue）+ 手机审批面的服务端。
//
// Codex App 的 Review 标签页只给 diff；Nyra 的队列每项给 diff + 验证结论 +
// 成本，批复本身也进证据链。队列是“人逐项批”的地方：
//   - 入队：并行 delegate 每线程的结构化证据（3a 的 ParallelThreadResult）、
//     定时任务（Automations）结果、单次 delegate——都能进队；
//   - 状态机：pending → approved → applied，或 pending → rejected；
//     approved 之前改动不放行，rejected/applied 是终态；
//   - 审批 fail-closed：不点通过就不放行，绝不默认放行、绝不静默通过；
//     超时/断线/异常时保持 pending，不自动改状态；
//   - 每一项批复（批准或拒绝、谁、在哪、依据什么证据）都进证据链：
//     有 runId 且运行目录在 ~/.nyra/runs 或 ~/.nyra/tasks 里时写 events.jsonl
//     （review_enqueued / review_decision / review_verified / review_applied）；
//     否则写 evidence/review/ 下的证据文件；两路都失败时调用方会看到
//     evidenceChannel "none"，不静默假装已记录。
//
// 存储：~/.nyra/review-queue.json，单文件 JSON（队列小，不值得拆文件），
// 原子写（同目录 tmp 0600 + fsync + rename，见 style.ts / scheduler.ts 的同款
// 写法）；文件损坏时抛错不静默丢队列。落盘位置与 runs/evidence 风格一致。
//
// 诚实边界：
//   - 验收者（缺口 13）未开启时，3a 的 verification 恒为 not-verified，队列如实
//     显示 not-verified 并注明“未经核实”，不编验证结论；verifyReviewItem 只附
//     一个轻量检查（方法 files-exist）：核对改动文件在 worktree/工作目录里存在、
//     diffStat 非空；它明确写清没验证什么（没跑测试、没跑类型检查、没审代码语义），
//     通过它不等于“代码是对的”。验收者开启后，verifyReviewItem 改跑完整验收
//     （verifyOutput：确定性检查 + 模型复核），结论写进 verification，方法为
//     verifier / verifier-deterministic，另记 verifier_verdict 事件。
//   - worktree 隔离的改动在 apply 之前只活在 worktree 里，批准 ≠ 合并；
//     apply 才把文件拷回工作目录。非 worktree 的委派改动已在工作目录内，
//     队列对它只是事后验收（批准即接受现状，拒绝只留记录，建议用影子快照回滚）。
//   - 定时任务结果进队时改动文件未上报（调度器路径不经过 RunRecorder），
//     队列里如实记这一点，批复前请结合 inbox 与会话记录核对。

import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, statSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { RunStore } from "./runs.ts";
import { EvidenceStore } from "./evidence.ts";
import { loadConfig } from "./config.ts";
import { buildVerifierRunner, verifyOutput, verifierEnabled } from "./verifier.ts";
import type { ReviewerLike } from "./reviewer.ts";
import type { ParallelDelegateResult, ParallelThreadResult } from "./parallelDelegate.ts";

export class ReviewQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewQueueError";
  }
}

/** 审阅项来源：并行线程 / 定时任务（Automations）结果 / 单次 delegate。 */
export type ReviewSource = "parallel" | "automation" | "delegate";
export type ReviewStatus = "pending" | "approved" | "rejected" | "applied";
export type VerificationStatus = "verified" | "not-verified" | "failed";

export interface ReviewVerification {
  status: VerificationStatus;
  /** 验证方法：null = 未经过任何验证。轻量 verifier 的方法是 "files-exist"。 */
  method: string | null;
  note: string;
  /** 验证时间（ISO）；未验证过为 null。 */
  at: string | null;
}

export interface ReviewItem {
  id: string;
  source: ReviewSource;
  /** 人看的标题（并行线程：线程任务；定时任务：任务名）。 */
  title: string;
  /** 结果摘要原文（子任务摘要 / 定时任务输出前 2000 字）。 */
  summary: string;
  runId: string | null;
  sessionId: string | null;
  /** 改动要合回的工作目录（worktree 项必填；非 worktree 项为改动所在目录）。 */
  workdir: string | null;
  /** worktree 隔离下改动留下的 worktree 路径；无隔离时为 null。 */
  worktreePath: string | null;
  changedFiles: string[];
  /** `git diff --stat HEAD` 原文；无改动或非 worktree 为 null。 */
  diffStat: string | null;
  verification: ReviewVerification;
  /** 已花美元；未计价时为 null，不编数字。 */
  spentUsd: number | null;
  status: ReviewStatus;
  createdAt: string;
  decidedAt: string | null;
  /** 批复人：CLI 默认 "cli"，网关传 "owner（本机）" 或 "device:<设备名>"。 */
  decidedBy: string | null;
  decisionNote: string | null;
  appliedAt: string | null;
  appliedNote: string | null;
}

export const REVIEW_QUEUE_NAME = "review-queue.json";
export const MAX_TITLE_CHARS = 200;
export const MAX_SUMMARY_CHARS = 2000;
export const MAX_DIFF_STAT_CHARS = 20000;
export const MAX_NOTE_CHARS = 500;
export const REVIEW_ID_RE = /^[0-9a-f]{16}$/;

export const NOT_VERIFIED_NOTE =
  "未经核实：本项未经过独立验证，不要把它当成已验证的结论。";
export const AUTOMATION_NO_FILES_NOTE =
  "未经核实：定时任务结果，未上报改动文件（调度器路径不经过 RunRecorder）；" +
  "批复前请结合 inbox 与会话记录核对。";
export const FILES_EXIST_NOT_CHECKED =
  "未验证的部分：没跑测试、没跑类型检查、没审代码语义；只核对了改动文件存在与 diffStat 非空。";

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function privateChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    if (process.platform !== "win32") throw new Error(`无法设置权限：${path}`);
  }
}

export function reviewQueuePath(home?: string): string {
  const h = home ?? process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra");
  return join(h, REVIEW_QUEUE_NAME);
}

function newReviewId(): string {
  return randomBytes(8).toString("hex");
}

function isRelativePath(p: string): boolean {
  if (typeof p !== "string" || !p) return false;
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) return false;
  const parts = p.split(/[\\/]/);
  return !parts.includes("..") && !parts.includes("");
}

function validateChangedFiles(files: unknown): string[] {
  if (!Array.isArray(files)) throw new ReviewQueueError("changedFiles 须为数组");
  for (const f of files) {
    if (typeof f !== "string" || !isRelativePath(f)) {
      throw new ReviewQueueError(`改动文件路径无效（须为相对路径，不含 ..）：${String(f)}`);
    }
  }
  return [...files];
}

/** 读队列：不存在返回 []；损坏或字段不全抛错（不静默丢队列）。 */
export function loadReviewQueue(home?: string): ReviewItem[] {
  const path = reviewQueuePath(home);
  if (!existsSync(path)) return [];
  if (lstatSync(path).isSymbolicLink()) throw new ReviewQueueError("审阅队列文件不能是符号链接");
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new ReviewQueueError(`审阅队列损坏：${path} 不是有效 JSON，请手工检查后恢复或删掉重建`);
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as { items?: unknown }).items)) {
    throw new ReviewQueueError(`审阅队列损坏：${path} 的顶层须为 {version: 1, items: [...]}`);
  }
  const raw = data as { version?: unknown; items: unknown[] };
  if (raw.version !== 1) throw new ReviewQueueError("审阅队列 version 须为 1");
  return raw.items.map((it, i) => validateReviewItem(it, `${path}#items[${i}]`));
}

export function validateReviewItem(it: unknown, where = "审阅项"): ReviewItem {
  if (!it || typeof it !== "object") throw new ReviewQueueError(`${where} 不是对象`);
  const p = it as Record<string, unknown>;
  const req = (k: string): unknown => {
    if (!(k in p)) throw new ReviewQueueError(`${where} 缺字段：${k}`);
    return p[k];
  };
  if (typeof p.id !== "string" || !REVIEW_ID_RE.test(p.id)) throw new ReviewQueueError(`${where} 的 id 无效`);
  if (!["parallel", "automation", "delegate"].includes(p.source as string)) {
    throw new ReviewQueueError(`${where} 的 source 无效`);
  }
  if (typeof p.title !== "string" || !p.title.trim()) throw new ReviewQueueError(`${where} 的 title 不能为空`);
  if (typeof p.summary !== "string") throw new ReviewQueueError(`${where} 的 summary 须为字符串`);
  if (p.runId !== null && typeof p.runId !== "string") throw new ReviewQueueError(`${where} 的 runId 无效`);
  if (p.sessionId !== null && typeof p.sessionId !== "string") throw new ReviewQueueError(`${where} 的 sessionId 无效`);
  if (p.workdir !== null && typeof p.workdir !== "string") throw new ReviewQueueError(`${where} 的 workdir 无效`);
  if (p.worktreePath !== null && typeof p.worktreePath !== "string") throw new ReviewQueueError(`${where} 的 worktreePath 无效`);
  const changedFiles = validateChangedFiles(req("changedFiles"));
  if (p.diffStat !== null && typeof p.diffStat !== "string") throw new ReviewQueueError(`${where} 的 diffStat 无效`);
  const v = req("verification") as Record<string, unknown>;
  if (!v || typeof v !== "object" || !["verified", "not-verified", "failed"].includes(v.status as string)) {
    throw new ReviewQueueError(`${where} 的 verification.status 无效`);
  }
  if (v.method !== null && typeof v.method !== "string") throw new ReviewQueueError(`${where} 的 verification.method 无效`);
  if (typeof v.note !== "string") throw new ReviewQueueError(`${where} 的 verification.note 须为字符串`);
  if (v.at !== null && typeof v.at !== "string") throw new ReviewQueueError(`${where} 的 verification.at 无效`);
  if (p.spentUsd !== null && (typeof p.spentUsd !== "number" || !Number.isFinite(p.spentUsd) || p.spentUsd < 0)) {
    throw new ReviewQueueError(`${where} 的 spentUsd 无效`);
  }
  if (!["pending", "approved", "rejected", "applied"].includes(p.status as string)) {
    throw new ReviewQueueError(`${where} 的 status 无效`);
  }
  for (const k of ["createdAt", "decidedAt", "decidedBy", "decisionNote", "appliedAt", "appliedNote"] as const) {
    const val = req(k);
    if (k === "createdAt" ? typeof val !== "string" : val !== null && typeof val !== "string") {
      throw new ReviewQueueError(`${where} 的 ${k} 无效`);
    }
  }
  return it as ReviewItem;
}

/** 原子写队列：同目录 tmp（0600）+ fsync + rename；失败不损坏旧队列。 */
export function saveReviewQueue(home: string | undefined, items: ReviewItem[]): string {
  const target = reviewQueuePath(home);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  privateChmod(dir, 0o700);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new ReviewQueueError("审阅队列文件不能是符号链接");
  }
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const data = JSON.stringify({ version: 1, items }, null, 2) + "\n";
  const tmp = join(dir, `.review-queue-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  privateChmod(tmp, 0o600);
  renameSync(tmp, target);
  privateChmod(target, 0o600);
  return target;
}

export interface EnqueueInput {
  source: ReviewSource;
  title: string;
  summary?: string;
  runId?: string | null;
  sessionId?: string | null;
  workdir?: string | null;
  worktreePath?: string | null;
  changedFiles?: string[];
  diffStat?: string | null;
  verification?: ReviewVerification;
  spentUsd?: number | null;
}

export type EvidenceChannel = "events" | "evidence" | "none";

/**
 * 批复/入队/验证/应用的审计记录。优先写该运行的 events.jsonl（runs 或 tasks
 * 目录下有该 runId 的目录才行）；没有对应运行目录时写 evidence/review/ 下的
 * 证据文件；两路都失败返回 "none"（调用方须把这个结果告诉用户，不静默）。
 */
export function recordReviewEvent(
  home: string | undefined,
  runId: string | null,
  type: string,
  fields: Record<string, unknown>,
  evidenceLabel: string,
): EvidenceChannel {
  if (runId) {
    for (const sub of ["runs", "tasks"]) {
      const base = join(
        home ?? process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra"),
        sub,
      );
      if (!existsSync(join(base, runId))) continue;
      try {
        new RunStore(base).appendEvent(runId, type, fields);
        return "events";
      } catch {
        // 该 store 写失败就试下一个；都失败再走证据文件。
      }
    }
  }
  try {
    const h = home ?? process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra");
    new EvidenceStore(join(h, "evidence"), "review").save(
      type,
      `review://${String(fields.item_id ?? "unknown")}`,
      evidenceLabel,
    );
    return "evidence";
  } catch {
    return "none";
  }
}

function evidenceLines(item: ReviewItem, extra: string[]): string {
  return [
    `审阅项：${item.id}（来源：${item.source}；标题：${item.title}）`,
    `状态：${item.status}`,
    `改动文件：${item.changedFiles.length ? item.changedFiles.join("、") : "无"}`,
    item.diffStat ? `diffStat：\n${item.diffStat}` : "diffStat：无",
    `验证：${item.verification.status}${item.verification.method ? `（${item.verification.method}）` : "（未验证）"}——${item.verification.note}`,
    `成本：${item.spentUsd === null ? "未知（未计价）" : "$" + item.spentUsd.toFixed(4)}`,
    ...extra,
  ].join("\n");
}

/** 入队：校验后以 pending 落盘，并记 review_enqueued 事件。 */
export function enqueueReviewItem(
  home: string | undefined,
  input: EnqueueInput,
): { item: ReviewItem; evidenceChannel: EvidenceChannel } {
  if (!["parallel", "automation", "delegate"].includes(input.source)) {
    throw new ReviewQueueError(`来源无效：${String(input.source)}（只允许 parallel / automation / delegate）`);
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new ReviewQueueError("标题不能为空");
  if (title.length > MAX_TITLE_CHARS) throw new ReviewQueueError(`标题过长（超过 ${MAX_TITLE_CHARS} 字符）`);
  const changedFiles = validateChangedFiles(input.changedFiles ?? []);
  if (input.spentUsd !== undefined && input.spentUsd !== null &&
    (typeof input.spentUsd !== "number" || !Number.isFinite(input.spentUsd) || input.spentUsd < 0)) {
    throw new ReviewQueueError("spentUsd 须为 null 或不小于 0 的数字");
  }
  const item: ReviewItem = {
    id: newReviewId(),
    source: input.source,
    title,
    summary: (input.summary ?? "").slice(0, MAX_SUMMARY_CHARS),
    runId: input.runId ?? null,
    sessionId: input.sessionId ?? null,
    workdir: input.workdir ?? null,
    worktreePath: input.worktreePath ?? null,
    changedFiles,
    diffStat: input.diffStat === undefined || input.diffStat === null ? null : input.diffStat.slice(0, MAX_DIFF_STAT_CHARS),
    verification: input.verification ?? { status: "not-verified", method: null, note: NOT_VERIFIED_NOTE, at: null },
    spentUsd: input.spentUsd ?? null,
    status: "pending",
    createdAt: nowIso(),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    appliedAt: null,
    appliedNote: null,
  };
  const items = loadReviewQueue(home);
  items.push(item);
  saveReviewQueue(home, items);
  const channel = recordReviewEvent(home, item.runId, "review_enqueued", {
    item_id: item.id,
    source: item.source,
    spent_usd: item.spentUsd,
  }, evidenceLines(item, ["动作：入队（pending）"]));
  return { item, evidenceChannel: channel };
}

/**
 * 并行 delegate 的每线程结果进队（3a 的结构化证据直接消费）。
 * 只进“成功且有改动”的线程：失败/超时/被拒的线程没有可审的改动，
 * 成功但无改动的线程没有可审的东西——两类都进 skipped，不静默丢掉。
 */
export function enqueueParallelResults(
  home: string | undefined,
  result: ParallelDelegateResult,
  opts?: { runId?: string | null; sessionId?: string | null; workdir?: string | null },
): { enqueued: ReviewItem[]; skipped: { index: number; reason: string }[] } {
  const enqueued: ReviewItem[] = [];
  const skipped: { index: number; reason: string }[] = [];
  for (const thread of result.results as ParallelThreadResult[]) {
    const hasChanges = thread.evidence.changedFiles.length > 0 || thread.evidence.diffStat !== null;
    if (thread.status !== "ok") {
      skipped.push({ index: thread.index, reason: `线程状态为 ${thread.status}，无可审改动` });
      continue;
    }
    if (!hasChanges) {
      skipped.push({ index: thread.index, reason: "成功但无文件改动，无可审内容" });
      continue;
    }
    const { item } = enqueueReviewItem(home, {
      source: "parallel",
      title: `并行线程 ${thread.index + 1}：${thread.task.slice(0, 120)}`,
      summary: thread.summary ?? "",
      runId: opts?.runId ?? null,
      sessionId: opts?.sessionId ?? null,
      workdir: opts?.workdir ?? null,
      worktreePath: thread.evidence.worktreePath,
      changedFiles: thread.evidence.changedFiles,
      diffStat: thread.evidence.diffStat,
      verification: {
        status: thread.evidence.verification.status,
        method: thread.evidence.verification.method ?? null,
        note: thread.evidence.verification.note,
        at: thread.evidence.verification.at ?? null,
      },
      spentUsd: thread.evidence.spentUsd,
    });
    enqueued.push(item);
  }
  return { enqueued, skipped };
}

/**
 * 定时任务（Automations）结果进队：网关调度 tick 与 `nyra schedule daemon`
 * 在任务跑完后调这里。只进跑成功的任务（失败的没有可审的结果，inbox 已记）。
 * 改动文件未上报是已知局限，验证栏如实记这一点。
 */
export function enqueueAutomationResults(
  home: string | undefined,
  results: { name: string; status: string; summary: string }[],
): { enqueued: ReviewItem[]; skipped: { name: string; reason: string }[] } {
  const enqueued: ReviewItem[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const r of results) {
    if (r.status !== "ok") {
      skipped.push({ name: r.name, reason: `任务状态为 ${r.status}，无可审结果` });
      continue;
    }
    const { item } = enqueueReviewItem(home, {
      source: "automation",
      title: `定时任务：${r.name}`,
      summary: r.summary ?? "",
      runId: null,
      sessionId: `schedule-${r.name}`,
      workdir: null,
      worktreePath: null,
      changedFiles: [],
      diffStat: null,
      verification: { status: "not-verified", method: null, note: AUTOMATION_NO_FILES_NOTE, at: null },
      spentUsd: null,
    });
    enqueued.push(item);
  }
  return { enqueued, skipped };
}

export function listReviewItems(home?: string, status?: ReviewStatus): ReviewItem[] {
  const items = loadReviewQueue(home);
  const filtered = status ? items.filter((i) => i.status === status) : items;
  const rank = (s: ReviewStatus): number => (s === "pending" ? 0 : s === "approved" ? 1 : 2);
  return [...filtered].sort((a, b) =>
    rank(a.status) - rank(b.status) || b.createdAt.localeCompare(a.createdAt));
}

export function getReviewItem(home: string | undefined, id: string): ReviewItem {
  if (!REVIEW_ID_RE.test(id)) throw new ReviewQueueError(`审阅项 id 无效：${id}`);
  const item = loadReviewQueue(home).find((i) => i.id === id);
  if (!item) throw new ReviewQueueError(`审阅项不存在：${id}`);
  return item;
}

/**
 * 批复：只允许 pending → approved / rejected。fail-closed：状态不对就抛错，
 * 队列原样不动；批复人必填（CLI 默认 "cli"，网关传本机/设备）；批复记
 * review_decision 事件（谁、在哪、批了什么、依据什么证据——证据就是本项
 * 的 diff + 验证结论 + 成本，事件里只记 id 与结论，详情在队列文件里）。
 */
export function decideReviewItem(
  home: string | undefined,
  id: string,
  decision: "approved" | "rejected",
  opts?: { by?: string; note?: string | null },
): { item: ReviewItem; evidenceChannel: EvidenceChannel } {
  const by = typeof opts?.by === "string" && opts.by.trim() ? opts.by.trim() : "";
  if (!by) throw new ReviewQueueError("批复须注明批复人（--by）");
  if (decision !== "approved" && decision !== "rejected") {
    throw new ReviewQueueError(`批复无效：${String(decision)}（只允许 approved / rejected）`);
  }
  const items = loadReviewQueue(home);
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) throw new ReviewQueueError(`审阅项不存在：${id}`);
  const item = items[idx];
  if (item.status !== "pending") {
    throw new ReviewQueueError(`只能批复 pending 的审阅项，当前状态为 ${item.status}`);
  }
  item.status = decision;
  item.decidedAt = nowIso();
  item.decidedBy = by;
  item.decisionNote = typeof opts?.note === "string" && opts.note.trim()
    ? opts.note.trim().slice(0, MAX_NOTE_CHARS)
    : null;
  saveReviewQueue(home, items);
  const channel = recordReviewEvent(home, item.runId, "review_decision", {
    item_id: item.id,
    decision,
    decided_by: by,
    spent_usd: item.spentUsd,
  }, evidenceLines(item, [
    `动作：${decision === "approved" ? "批准" : "拒绝"}（批复人：${by}）`,
    ...(item.decisionNote ? [`批复备注：${item.decisionNote}`] : []),
    `依据的证据：改动文件 ${item.changedFiles.length ? item.changedFiles.join("、") : "无"}；` +
    `验证 ${item.verification.status}${item.verification.method ? `（${item.verification.method}）` : "（未验证）"}；` +
    `成本 ${item.spentUsd === null ? "未知（未计价）" : "$" + item.spentUsd.toFixed(4)}`,
  ]));
  return { item, evidenceChannel: channel };
}

/**
 * 轻量 verifier（方法 files-exist）：核对每个改动文件在 worktree（有则优先）
 * 或工作目录里存在、diffStat 非空（有改动文件时）。通过只代表“文件都在”，
 * 不代表代码是对的——note 里写清没验证什么。只允许 pending / approved 的项。
 */
/**
 * 验证一项：验收者未开启时沿用轻量 files-exist（行为与 3b 原样一致）；
 * 开启时跑完整验收（verifyOutput：确定性检查 + 模型复核），结论写进
 * item.verification，并另记一条 verifier_verdict 事件（谁验的、验了什么、
 * 为什么通过/打回）。验证本身也进证据链（review_verified 事件照常记）。
 */
export async function verifyReviewItem(
  home: string | undefined,
  id: string,
  opts?: { config?: Record<string, unknown>; runner?: ReviewerLike | null },
): Promise<{ item: ReviewItem; evidenceChannel: EvidenceChannel }> {
  const items = loadReviewQueue(home);
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) throw new ReviewQueueError(`审阅项不存在：${id}`);
  const item = items[idx];
  if (item.status !== "pending" && item.status !== "approved") {
    throw new ReviewQueueError(`只能验证 pending 或 approved 的审阅项，当前状态为 ${item.status}`);
  }
  const base = item.worktreePath ?? item.workdir;
  if (!base) {
    throw new ReviewQueueError("无法验证：既无 worktree 也无工作目录，改动文件无处核对");
  }
  const config = opts?.config ?? loadConfig(home);
  if (verifierEnabled(config)) {
    const runner = opts?.runner === undefined ? buildVerifierRunner(config, home) : opts.runner;
    const verdict = await verifyOutput({
      config,
      input: {
        title: item.title,
        summary: item.summary,
        changedFiles: item.changedFiles,
        diffStat: item.diffStat,
        worktreePath: item.worktreePath,
        workdir: item.workdir,
        spentUsd: item.spentUsd,
      },
      runner,
    });
    item.verification = { status: verdict.status, method: verdict.method, note: verdict.reason, at: verdict.at };
    saveReviewQueue(home, items);
    const channel = recordReviewEvent(home, item.runId, "review_verified", {
      item_id: item.id,
      status: item.verification.status,
      method: item.verification.method,
    }, evidenceLines(item, [`动作：验证（方法 ${verdict.method ?? "未验收"}）——${item.verification.note}`]));
    // 验收结论另记一条 verifier_verdict（可审计：谁验的、为什么通过/打回）。
    // item_id 不在 verifier_verdict 的字段表里（事件里不写），但证据文件用它做键，
    // 所以这里多传一个，appendEvent 会忽略表外字段。
    try {
      recordReviewEvent(home, item.runId, "verifier_verdict", {
        item_id: item.id,
        target: item.id,
        verdict: verdict.status,
        reason: verdict.reason,
        verifier_model: verdict.verifierModel,
        source: verdict.source,
        checks_passed: verdict.checks.filter((c) => c.passed).length,
        checks_failed: verdict.checks.filter((c) => !c.passed).length,
      }, evidenceLines(item, [`动作：验收（${verdict.method ?? "未验收"}）——${verdict.reason}`]));
    } catch { /* 验收主事件已记，这条记不上也不破坏验证结果 */ }
    return { item, evidenceChannel: channel };
  }
  const missing: string[] = [];
  for (const f of item.changedFiles) {
    if (!existsSync(join(base, f))) missing.push(f);
  }
  const diffEmpty = item.changedFiles.length > 0 && (item.diffStat === null || !item.diffStat.trim());
  if (missing.length || diffEmpty) {
    const reasons = [
      ...(missing.length ? [`缺文件：${missing.join("、")}`] : []),
      ...(diffEmpty ? ["有改动文件但 diffStat 为空"] : []),
    ];
    item.verification = {
      status: "failed",
      method: "files-exist",
      note: `文件存在性核查未通过——${reasons.join("；")}。${FILES_EXIST_NOT_CHECKED}`,
      at: nowIso(),
    };
  } else {
    item.verification = {
      status: "verified",
      method: "files-exist",
      note: item.changedFiles.length
        ? `文件存在性核查通过：${item.changedFiles.length} 个改动文件都在 ${base} 里，diffStat 非空。${FILES_EXIST_NOT_CHECKED}`
        : `无改动文件可核对（diff 为空）。${FILES_EXIST_NOT_CHECKED}`,
      at: nowIso(),
    };
  }
  saveReviewQueue(home, items);
  const channel = recordReviewEvent(home, item.runId, "review_verified", {
    item_id: item.id,
    status: item.verification.status,
    method: item.verification.method,
  }, evidenceLines(item, [`动作：验证（方法 files-exist）——${item.verification.note}`]));
  return { item, evidenceChannel: channel };
}

/**
 * 应用已批准的改动：只允许 approved → applied。
 * 有 worktree 时把改动文件逐个拷回 workdir（每文件 tmp + rename，目录自动建）；
 * 任一文件拷失败就抛错、状态保持 approved（不把半成品记成 applied，
 * 已拷好的文件与失败清单都在错误里写清）。无 worktree 时改动已在工作目录内，
 * 只记 applied 并注明无需合并。应用记 review_applied 事件。
 */
export function applyReviewItem(
  home: string | undefined,
  id: string,
  opts?: { by?: string },
): { item: ReviewItem; evidenceChannel: EvidenceChannel; appliedFiles: string[] } {
  const items = loadReviewQueue(home);
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) throw new ReviewQueueError(`审阅项不存在：${id}`);
  const item = items[idx];
  if (item.status !== "approved") {
    throw new ReviewQueueError(`只能应用 approved 的审阅项，当前状态为 ${item.status}`);
  }
  const by = typeof opts?.by === "string" && opts.by.trim() ? opts.by.trim() : "";
  let appliedFiles: string[] = [];
  let appliedNote: string;
  if (item.worktreePath) {
    if (!item.workdir) throw new ReviewQueueError("应用 worktree 改动需要 workdir（本项未记录工作目录）");
    const copied: string[] = [];
    try {
      for (const f of item.changedFiles) {
        const src = join(item.worktreePath, f);
        if (!existsSync(src)) throw new Error(`worktree 里找不到改动文件：${f}`);
        const target = join(item.workdir, f);
        mkdirSync(dirname(target), { recursive: true });
        const tmp = join(dirname(target), `.nyra-apply-${process.pid}-${randomBytes(4).toString("hex")}`);
        copyFileSync(src, tmp);
        renameSync(tmp, target);
        copied.push(f);
      }
    } catch (err: unknown) {
      throw new ReviewQueueError(
        `应用失败：${err instanceof Error ? err.message : String(err)}` +
        `（已拷回 ${copied.length} 个：${copied.join("、") || "无"}；状态保持 approved，未记成 applied）`,
      );
    }
    appliedFiles = copied;
    appliedNote = appliedFiles.length
      ? `已从 worktree ${item.worktreePath} 拷回 ${appliedFiles.length} 个文件到 ${item.workdir}`
      : "worktree 无改动文件可拷回";
  } else {
    appliedNote = "改动已在工作目录内（非 worktree 委派），无需合并；批准即验收";
  }
  item.status = "applied";
  item.appliedAt = nowIso();
  item.appliedNote = appliedNote + (by ? `（执行：${by}）` : "");
  saveReviewQueue(home, items);
  const channel = recordReviewEvent(home, item.runId, "review_applied", {
    item_id: item.id,
    files: appliedFiles.join(","),
  }, evidenceLines(item, [
    "动作：应用已批准的改动",
    item.appliedNote ?? "",
  ]));
  return { item, evidenceChannel: channel, appliedFiles };
}

export function formatReviewItem(item: ReviewItem): string {
  const lines = [
    `${item.id}  [${item.status}]  来源：${item.source}  ${item.title}`,
    `  创建：${item.createdAt}${item.sessionId ? `  会话：${item.sessionId}` : ""}${item.runId ? `  运行：${item.runId}` : ""}`,
    `  改动文件：${item.changedFiles.length ? item.changedFiles.join("、") : "无"}`,
    item.worktreePath ? `  worktree：${item.worktreePath}` : "",
    item.workdir ? `  工作目录：${item.workdir}` : "",
    `  验证：${item.verification.status}${item.verification.method ? `（${item.verification.method}）` : "（未验证）"}——${item.verification.note}`,
    `  成本：${item.spentUsd === null ? "未知（未计价）" : "$" + item.spentUsd.toFixed(4)}`,
    item.decidedAt ? `  批复：${item.status}（${item.decidedBy ?? "?"}，${item.decidedAt}${item.decisionNote ? `，${item.decisionNote}` : ""}）` : "",
    item.appliedAt ? `  应用：${item.appliedAt}——${item.appliedNote ?? ""}` : "",
    `  摘要：${item.summary ? item.summary.slice(0, 500) : "（无）"}`,
  ];
  if (item.diffStat) lines.push(`  diffStat：\n${item.diffStat.split("\n").map((l) => "    " + l).join("\n")}`);
  return lines.filter((l) => l !== "").join("\n");
}

export function formatReviewList(items: ReviewItem[]): string {
  if (!items.length) return "审阅队列为空。";
  const pending = items.filter((i) => i.status === "pending").length;
  const lines = [`审阅队列：共 ${items.length} 项，待审 ${pending} 项`];
  for (const item of items) {
    lines.push(
      `${item.id}  [${item.status}]  ${item.source}  ${item.title.slice(0, 80)}` +
      `  验证：${item.verification.status}` +
      `  成本：${item.spentUsd === null ? "未知" : "$" + item.spentUsd.toFixed(4)}` +
      (item.changedFiles.length ? `  改动 ${item.changedFiles.length} 个文件` : ""),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- CLI ---
// nyra review <list|show|approve|reject|apply|verify|enqueue>，风格与
// nyra task / nyra style 一致：用法错回 2，业务错回 1 并写“错误：…”到 stderr。

export async function handleReview(argv: string[], home: string): Promise<number> {
  const REVIEW_USAGE = "用法：\n"
    + "  nyra review list [--status pending|approved|rejected|applied] [--json]   列出审阅项（默认待审在前）\n"
    + "  nyra review show <id> [--json]                                            查看一项（含 diffStat 与验证结论）\n"
    + "  nyra review approve <id> [--by <批复人>] [--note <备注>]                   批准（只允许 pending 的项）\n"
    + "  nyra review reject <id> [--by <批复人>] [--note <备注>]                    拒绝（只允许 pending 的项）\n"
    + "  nyra review verify <id>                                                   验收：验收者未开启时只核对文件存在；开启时跑完整验收（确定性检查 + 模型复核）\n"
    + "  nyra review apply <id> [--by <执行人>]                                    应用已批准的改动（worktree 文件拷回工作目录）\n"
    + "  nyra review enqueue --title <标题> [--source parallel|automation|delegate] [--summary <摘要>] [--run <运行 id>] [--session <会话 id>] [--workdir <目录>] [--worktree <路径>] [--files <逗号分隔>] [--diff-stat <文本>] [--spent <美元>]   手动入队\n"
    + "审批 fail-closed：不批复就不放行；批复、验证、应用都进证据链（见 docs/review-queue.md）";
  const cmd = argv[0];
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const warnEvidence = (channel: EvidenceChannel): void => {
    if (channel === "none") {
      process.stderr.write("警告：本次操作的证据链记录失败（events.jsonl 与证据文件都写不进去），决定本身已落盘，请检查 ~/.nyra 权限。\n");
    }
  };
  try {
    if (!cmd) {
      process.stdout.write(REVIEW_USAGE + "\n");
      return 2;
    }
    if (cmd === "list") {
      const status = flag("--status") as ReviewStatus | null;
      if (status && !["pending", "approved", "rejected", "applied"].includes(status)) {
        process.stderr.write("错误：--status 只允许 pending|approved|rejected|applied\n");
        return 2;
      }
      const items = listReviewItems(home, status ?? undefined);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify({ items }, null, 2) + "\n");
      } else {
        process.stdout.write(formatReviewList(items) + "\n");
      }
      return 0;
    }
    if (cmd === "show") {
      const id = argv[1];
      if (!id) { process.stderr.write("用法：nyra review show <id>\n"); return 2; }
      const item = getReviewItem(home, id);
      if (argv.includes("--json")) process.stdout.write(JSON.stringify(item, null, 2) + "\n");
      else process.stdout.write(formatReviewItem(item) + "\n");
      return 0;
    }
    if (cmd === "approve" || cmd === "reject") {
      const id = argv[1];
      if (!id) { process.stderr.write(`用法：nyra review ${cmd} <id> [--by <批复人>] [--note <备注>]\n`); return 2; }
      const { item, evidenceChannel } = decideReviewItem(home, id, cmd === "approve" ? "approved" : "rejected", {
        by: flag("--by") ?? "cli",
        note: flag("--note"),
      });
      warnEvidence(evidenceChannel);
      process.stdout.write(`已${cmd === "approve" ? "批准" : "拒绝"} ${item.id}（${item.title.slice(0, 60)}）\n`);
      return 0;
    }
    if (cmd === "verify") {
      const id = argv[1];
      if (!id) { process.stderr.write("用法：nyra review verify <id>\n"); return 2; }
      const { item, evidenceChannel } = await verifyReviewItem(home, id);
      warnEvidence(evidenceChannel);
      process.stdout.write(`验证结论：${item.verification.status}——${item.verification.note}\n`);
      return 0;
    }
    if (cmd === "apply") {
      const id = argv[1];
      if (!id) { process.stderr.write("用法：nyra review apply <id>\n"); return 2; }
      const { item, evidenceChannel, appliedFiles } = applyReviewItem(home, id, { by: flag("--by") ?? "cli" });
      warnEvidence(evidenceChannel);
      process.stdout.write(`已应用 ${item.id}（${appliedFiles.length ? `拷回 ${appliedFiles.length} 个文件` : "无需合并"}）\n`);
      return 0;
    }
    if (cmd === "enqueue") {
      const title = flag("--title");
      if (!title) { process.stderr.write("用法：nyra review enqueue --title <标题> [选项]\n"); return 2; }
      const source = (flag("--source") ?? "delegate") as ReviewSource;
      const spentRaw = flag("--spent");
      let spent: number | null = null;
      if (spentRaw !== null) {
        spent = Number(spentRaw);
        if (!Number.isFinite(spent) || spent < 0) { process.stderr.write("错误：--spent 须为不小于 0 的数字\n"); return 2; }
      }
      const filesRaw = flag("--files");
      const { item, evidenceChannel } = enqueueReviewItem(home, {
        source,
        title,
        summary: flag("--summary") ?? "",
        runId: flag("--run"),
        sessionId: flag("--session"),
        workdir: flag("--workdir"),
        worktreePath: flag("--worktree"),
        changedFiles: filesRaw ? filesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
        diffStat: flag("--diff-stat"),
        spentUsd: spent,
      });
      warnEvidence(evidenceChannel);
      process.stdout.write(`已入队 ${item.id}\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 review ${cmd}\n${REVIEW_USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
