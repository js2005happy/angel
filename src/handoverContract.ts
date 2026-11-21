// src/handoverContract.ts — Pi Bot 借鉴第 2 条：交接契约的程序化验收。
//
// 交接不只是“把活递过去”，而是一份契约：交付物清单 + 验收项 + 修正轮次
// 上限。成员交活时程序自己核对（不调模型），过了才唤醒统筹，不过打回
// 一次，再不过停下等人。
//
// 借 Pi Bot 的 group-handoffs / group-handoff-check / group-delivery-run
// 的形状（契约 + 确定性核对 + 打回轮次上限），不抄它的 API 形状与文案，
// 不接 pi 当内核。Nyra 已有的雏形是 H-5 合并（子 agent 结果合并 + 确定
// 性检查 + 人批）与 GROK-4 文件交接（inbox/outbox/changelog），但验收
// 主要靠模型复核和人；本批补中间那层确定性验收——文件在不在、验收项
// 过没过，程序说了算，模型只负责干活不负责自证。
//
// Nyra 比 Pi Bot 多做的两步：验收检查复用缺口 29 的 checker 注册表
// （src/checkers.ts，确定性、不调模型、可复跑）+ 信任阶梯
// （src/trustLadder.ts：验收失败记一次违规、清零本级连续成功计数；
// “打回”也写进信任账本）。验收结果进运行事件（有 runId 时）与审计。
//
// 三条护城河：验收本身是只读核对（不写文件、不发消息、不烧 token）；
// 结论只记元数据与 id，不记任务原文、不记文件内容、不记绝对路径；
// 打回与停下是默认动作，接受须逐项全过，没有“差不多就过”的口子。

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdirSync, openSync, writeSync, closeSync, fsyncSync, renameSync, rmSync, appendFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { isKnownChecker, runChecker, type CheckerInput } from "./checkers.ts";
import { recordEvidence, TrustLadderError } from "./trustLadder.ts";
import { RunStore } from "./runs.ts";

export class HandoverContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoverContractError";
  }
}

/** 交接契约状态：pending 待验收 / accepted 已接受 / sent-back 已打回 / stopped 已停下等人 / resolved 人工已定夺 / closed 已放弃。 */
export type HandoverContractStatus = "pending" | "accepted" | "sent-back" | "stopped" | "resolved" | "closed";

export const HANDOVER_CONTRACT_STATUSES: readonly HandoverContractStatus[] = [
  "pending", "accepted", "sent-back", "stopped", "resolved", "closed",
];

export const HANDOVER_CONTRACT_STATUS_LABELS: Record<HandoverContractStatus, string> = {
  pending: "待验收",
  accepted: "已接受",
  "sent-back": "已打回",
  stopped: "已停下等人",
  resolved: "人工已定夺",
  closed: "已放弃",
};

/** 一件交付物：期望交回的文件（相对成员工作目录的路径）。 */
export interface HandoverDeliverable {
  id: string;
  /** 相对路径，如 "reports/weekly.md"（绝对路径与 .. 逃逸在立契约时就拒绝）。 */
  path: string;
  description: string;
}

/** 一项验收：一个 checker（缺口 29 注册表里的 id，立契约时就校验存在）。 */
export interface HandoverCheck {
  id: string;
  label: string;
  checker: string;
}

/** 一次验收里的逐项结果（交付物项 + 验收项，共用一个形状）。 */
export interface HandoverCheckItem {
  id: string;
  label: string;
  kind: "deliverable" | "acceptance";
  passed: boolean;
  detail: string;
  /** 证据出处：相对路径、命中的子串、工具在轨迹里的位置；无出处时为 null。 */
  evidence: string | null;
}

export type HandoverVerdict = "accepted" | "sent-back" | "stopped";

export const HANDOVER_VERDICT_LABELS: Record<HandoverVerdict, string> = {
  accepted: "已接受",
  "sent-back": "已打回",
  stopped: "已停下等人",
};

export interface HandoverAttempt {
  at: string;
  /** 第几轮（从 1 起；打回后下一轮轮次 +1）。 */
  round: number;
  passed: boolean;
  passedCount: number;
  total: number;
  items: HandoverCheckItem[];
  verdict: HandoverVerdict;
}

export interface HandoverContract {
  id: string;
  /** 交活的成员 agent。 */
  from: string;
  /** 统筹（接收方 agent）。 */
  to: string;
  task: string;
  deliverables: HandoverDeliverable[];
  checks: HandoverCheck[];
  /** 修正轮次上限（默认 1：Pi Bot 默认一轮；0 = 交一次就定夺，不过直接停下）。 */
  maxRounds: number;
  /** 已用轮次（打回一次 +1）。 */
  roundsUsed: number;
  status: HandoverContractStatus;
  /** 挂到的 GROK-4 交接包 id（没挂时为 null）。 */
  packageId: string | null;
  attempts: HandoverAttempt[];
  createdAt: string;
  updatedAt: string;
}

export interface HandoverContractStore {
  version: 1;
  contracts: HandoverContract[];
}

export const HANDOVER_CONTRACTS_FILE = "handover-contracts.json";
export const HANDOVER_CONTRACT_AUDIT_FILE = "handover-contract-audit.jsonl";
/** 修正轮次上限：默认 1 轮；最多 5 轮（Pi Bot 是按步骤/计划/工作流三级取上限，Nyra 一份契约一个数，更直白）。 */
export const DEFAULT_MAX_ROUNDS = 1;
export const MAX_ROUNDS_LIMIT = 5;
export const MAX_ATTEMPTS_PER_CONTRACT = 20;

export function handoverContractsPath(home: string): string {
  return join(home, HANDOVER_CONTRACTS_FILE);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function newHandoverContractId(): string {
  return `hc_${randomBytes(6).toString("hex")}`;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
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

/** 读交接契约账本；不存在返回空库；损坏先备份再抛错（不静默重建）。 */
export function loadHandoverContractStore(home: string): HandoverContractStore {
  const path = handoverContractsPath(home);
  if (!existsSync(path)) return { version: 1, contracts: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new HandoverContractError(`交接契约账本损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as HandoverContractStore).contracts)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new HandoverContractError(`交接契约账本格式无效，已备份到 ${backup}`);
  }
  return raw as HandoverContractStore;
}

export function saveHandoverContractStore(home: string, store: HandoverContractStore): void {
  atomicWriteJson(handoverContractsPath(home), store);
}

/** 交接契约审计（append-only 0600；写失败返回 false，不抛错、不拦验收本身）。 */
export function appendHandoverContractAudit(home: string, entry: Record<string, unknown>): boolean {
  try {
    const path = join(home, HANDOVER_CONTRACT_AUDIT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ at: nowIso(), ...entry }) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** 交付物路径只认成员工作目录内的相对路径（绝对路径、.. 逃逸、空串一律拒绝）。 */
export function validateDeliverablePath(path: string): void {
  if (typeof path !== "string" || !path.trim()) throw new HandoverContractError("交付物路径不能为空");
  const clean = path.trim().split(sep).join("/");
  if (clean.startsWith("/") || /^[a-zA-Z]:/.test(clean)) {
    throw new HandoverContractError(`交付物只认工作目录内的相对路径：${path}`);
  }
  if (clean.split("/").includes("..")) {
    throw new HandoverContractError(`交付物路径不许 .. 逃出工作目录：${path}`);
  }
}

function validateContractInput(input: {
  from: string; to: string; task: string;
  deliverables: HandoverDeliverable[]; checks: HandoverCheck[]; maxRounds: number;
}): void {
  if (!input.from.trim() || !input.to.trim()) throw new HandoverContractError("交接契约要有交活方与统筹（--from / --to）");
  if (input.from.trim() === input.to.trim()) throw new HandoverContractError("不能给自己交接（from 与 to 是同一个 agent）");
  if (!input.task.trim()) throw new HandoverContractError("交接契约要有任务描述（--task）");
  if (input.task.trim().length > 200) throw new HandoverContractError("交接任务一句话最长 200 字");
  if (!input.deliverables.length) throw new HandoverContractError("交接契约至少要有一件交付物（--deliverable）");
  const dIds = new Set<string>();
  for (const d of input.deliverables) {
    if (!d.id || !d.description) throw new HandoverContractError("交付物要有 id 与描述");
    if (dIds.has(d.id)) throw new HandoverContractError(`交付物 id 重复：${d.id}`);
    dIds.add(d.id);
    validateDeliverablePath(d.path);
  }
  if (!input.checks.length) throw new HandoverContractError("交接契约至少要有一项验收（--check）");
  const cIds = new Set<string>();
  for (const c of input.checks) {
    if (!c.id || !c.label) throw new HandoverContractError("验收项要有 id 与标签");
    if (cIds.has(c.id)) throw new HandoverContractError(`验收 id 重复：${c.id}`);
    cIds.add(c.id);
    if (!isKnownChecker(c.checker)) throw new HandoverContractError(`验收项 ${c.id} 的 checker 未知：${c.checker}（先 nyra handover checkers 看能用的）`);
  }
  if (!Number.isInteger(input.maxRounds) || input.maxRounds < 0 || input.maxRounds > MAX_ROUNDS_LIMIT) {
    throw new HandoverContractError(`修正轮次上限是 0–${MAX_ROUNDS_LIMIT} 的整数（默认 ${DEFAULT_MAX_ROUNDS}）`);
  }
}

/** 立一份交接契约（待验收）。只记元数据进审计，不记任务原文以外的敏感内容。 */
export function createHandoverContract(
  home: string,
  input: { from: string; to: string; task: string; deliverables: HandoverDeliverable[]; checks: HandoverCheck[]; maxRounds?: number },
): HandoverContract {
  const full = {
    from: input.from.trim(),
    to: input.to.trim(),
    task: input.task.trim(),
    deliverables: input.deliverables,
    checks: input.checks,
    maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
  };
  validateContractInput(full);
  const at = nowIso();
  const contract: HandoverContract = {
    id: newHandoverContractId(),
    ...full,
    roundsUsed: 0,
    status: "pending",
    packageId: null,
    attempts: [],
    createdAt: at,
    updatedAt: at,
  };
  const store = loadHandoverContractStore(home);
  store.contracts.push(contract);
  saveHandoverContractStore(home, store);
  appendHandoverContractAudit(home, {
    action: "contract_created", contract_id: contract.id, from: contract.from, to: contract.to,
    deliverables: contract.deliverables.length, checks: contract.checks.length, max_rounds: contract.maxRounds,
  });
  return contract;
}

export function getHandoverContract(home: string, id: string): HandoverContract | null {
  return loadHandoverContractStore(home).contracts.find((c) => c.id === id) ?? null;
}

export function listHandoverContracts(home: string, filter?: { status?: HandoverContractStatus; from?: string; to?: string }): HandoverContract[] {
  return loadHandoverContractStore(home).contracts.filter((c) => {
    if (filter?.status && c.status !== filter.status) return false;
    if (filter?.from && c.from !== filter.from) return false;
    if (filter?.to && c.to !== filter.to) return false;
    return true;
  });
}

function saveOne(home: string, contract: HandoverContract): void {
  const store = loadHandoverContractStore(home);
  const idx = store.contracts.findIndex((c) => c.id === contract.id);
  if (idx < 0) throw new HandoverContractError(`找不到交接契约 ${contract.id}`);
  contract.updatedAt = nowIso();
  store.contracts[idx] = contract;
  saveHandoverContractStore(home, store);
}

/** 把交接契约挂到一份 GROK-4 交接包上（包 id 只记元数据，不复制包内容）。 */
export function linkHandoverPackage(home: string, contractId: string, packageId: string): HandoverContract {
  const contract = getHandoverContract(home, contractId);
  if (!contract) throw new HandoverContractError(`找不到交接契约 ${contractId}`);
  if (contract.status !== "pending") throw new HandoverContractError(`交接契约 ${contractId} 不是待验收（当前 ${HANDOVER_CONTRACT_STATUS_LABELS[contract.status]}），不能再挂包`);
  if (contract.packageId) throw new HandoverContractError(`交接契约 ${contractId} 已挂到包 ${contract.packageId} 上，一份契约只挂一个包`);
  contract.packageId = packageId;
  saveOne(home, contract);
  appendHandoverContractAudit(home, { action: "contract_linked", contract_id: contract.id, package_id: packageId });
  return contract;
}

/** 交付物核对：存在、是普通文件、不是符号链接、非空。realpath 只用于越界比较，不改写返回值。 */
function checkDeliverable(workdir: string, d: HandoverDeliverable): HandoverCheckItem {
  const base: HandoverCheckItem = { id: d.id, label: `交付物 ${d.id}：${d.description}`, kind: "deliverable", passed: false, detail: "", evidence: null };
  const lexical = resolve(workdir, d.path.split("/").join(sep));
  let real: string;
  let realWorkdir: string;
  try {
    if (!existsSync(lexical)) return { ...base, detail: `文件不在工作目录里：${d.path}` };
    real = realpathSync(lexical);
    realWorkdir = realpathSync(workdir);
  } catch {
    return { ...base, detail: `文件读不到：${d.path}` };
  }
  // 与缺口 25 修补第二轮 + Pi Bot 第 1 条修补同口径：realpath 只用于越界比较，
  // 返回值与证据一律用词法路径（下游按字符串比路径；macOS 上 /var 与 /private/var 是同一目录）。
  if (real !== realWorkdir && !real.startsWith(realWorkdir + sep)) {
    return { ...base, detail: `文件越界（.. 不许逃出工作目录）：${d.path}` };
  }
  let st;
  try {
    st = lstatSync(lexical);
  } catch {
    return { ...base, detail: `文件读不到：${d.path}` };
  }
  if (st.isSymbolicLink()) return { ...base, detail: `文件是符号链接，不跟（防工作目录外偷渡）：${d.path}` };
  if (!st.isFile()) return { ...base, detail: `不是普通文件：${d.path}` };
  if (st.size === 0) return { ...base, detail: `文件是空的：${d.path}` };
  return { ...base, passed: true, detail: `文件在工作目录里，非空（${st.size} 字节）：${d.path}`, evidence: d.path };
}

export interface CheckHandoverInput {
  /** 成员的工作目录（交付物与 file-exists 类验收的核对地）。 */
  workdir: string;
  /** 任务最终输出文本（output-contains 的核对对象；不给则为空串）。 */
  outputText?: string;
  /** 工具轨迹：按执行顺序的工具名（trajectory-contains / no-tool 的核对对象）。 */
  trajectory?: string[];
}

export interface CheckHandoverOpts {
  /** 有 runId 时把结论写进该运行记录并记事件；没有时只写账本与审计（与缺口 29 的 verifyContract 同口径）。 */
  runId?: string | null;
}

export interface CheckHandoverResult {
  contract: HandoverContract;
  attempt: HandoverAttempt;
  verdict: HandoverVerdict;
  /** 给统筹 / 成员看的一句话（过了是唤醒，打回是待改清单，停下是等人定夺）。 */
  text: string;
  /** 信任阶梯记没记（未登记的主体不记，只对已登记的主体生效）。 */
  trustRecorded: boolean;
}

function checkerInputFor(contract: HandoverContract, input: CheckHandoverInput): CheckerInput {
  return {
    workdir: input.workdir,
    worktreePath: null,
    changedFiles: contract.deliverables.map((d) => d.path),
    diffStat: null,
    title: contract.task,
    summary: (input.outputText ?? "").slice(0, 500),
    outputText: input.outputText ?? "",
    trajectory: input.trajectory ?? [],
    spentUsd: null,
  };
}

/** 信任阶梯记一笔：验收通过记成功、打回或停下记违规（清零本级连续成功计数）。未登记的主体不记、也不抛错。 */
function recordTrust(home: string, agent: string, outcome: "success" | "violation", action: string, runId: string | null | undefined): boolean {
  try {
    recordEvidence(home, "agent", agent, outcome, { action, note: `交接契约验收：${action}`, runId: runId ?? null });
    return true;
  } catch (err: unknown) {
    if (err instanceof TrustLadderError) return false;
    throw err;
  }
}

function emitVerdictEvent(home: string, runId: string | null | undefined, contract: HandoverContract, attempt: HandoverAttempt): void {
  if (!runId) return;
  const type = attempt.verdict === "accepted"
    ? "handover_contract_accepted"
    : attempt.verdict === "sent-back"
      ? "handover_contract_sent_back"
      : "handover_contract_stopped";
  try {
    const store = new RunStore(join(home, "runs"));
    store.appendEvent(runId, type, {
      contract_id: contract.id, from: contract.from, to: contract.to,
      round: attempt.round, passed: attempt.passedCount, total: attempt.total,
    });
  } catch { /* 运行记录写失败不推翻验收结论本身；账本与审计里有 attempt */ }
}

/**
 * 程序验收一次交接契约（确定性，不调模型、不花 token）：
 * 交付物逐件核对（存在、普通文件、非符号链接、非空）+ 验收项逐项跑 checker。
 * 全过 → 已接受（唤醒统筹）；不过且还有轮次 → 已打回（轮次 +1）；不过且
 * 轮次用完 → 已停下等人。结论记 attempt（最近 20 条）+ 审计 +（有 runId
 * 时）运行事件；打回与停下同时记一次信任阶梯违规，通过记一次成功。
 */
export function checkHandoverContract(
  home: string,
  contractId: string,
  input: CheckHandoverInput,
  opts: CheckHandoverOpts = {},
): CheckHandoverResult {
  const contract = getHandoverContract(home, contractId);
  if (!contract) throw new HandoverContractError(`找不到交接契约 ${contractId}`);
  if (contract.status !== "pending" && contract.status !== "sent-back") {
    throw new HandoverContractError(`交接契约 ${contractId} 当前是${HANDOVER_CONTRACT_STATUS_LABELS[contract.status]}，不能再验收（停下等人的须先 resolve 或 close）`);
  }
  if (!input.workdir || !existsSync(input.workdir)) {
    throw new HandoverContractError(`工作目录不存在：${input.workdir ?? ""}（验收须给 --workdir）`);
  }
  const round = contract.roundsUsed + 1;
  const items: HandoverCheckItem[] = [];
  for (const d of contract.deliverables) items.push(checkDeliverable(input.workdir, d));
  const ci = checkerInputFor(contract, input);
  for (const c of contract.checks) {
    const r = runChecker(c.checker, ci);
    items.push({ id: c.id, label: c.label, kind: "acceptance", passed: r.passed, detail: r.detail, evidence: r.evidence });
  }
  const passedCount = items.filter((i) => i.passed).length;
  const allPass = passedCount === items.length;
  const verdict: HandoverVerdict = allPass ? "accepted" : round <= contract.maxRounds ? "sent-back" : "stopped";
  if (verdict === "sent-back") contract.roundsUsed = round;
  if (verdict === "stopped") contract.roundsUsed = Math.max(contract.roundsUsed, round);
  const attempt: HandoverAttempt = {
    at: nowIso(), round, passed: allPass, passedCount, total: items.length, items, verdict,
  };
  contract.attempts.push(attempt);
  if (contract.attempts.length > MAX_ATTEMPTS_PER_CONTRACT) contract.attempts = contract.attempts.slice(-MAX_ATTEMPTS_PER_CONTRACT);
  contract.status = verdict === "accepted" ? "accepted" : verdict === "sent-back" ? "sent-back" : "stopped";
  saveOne(home, contract);
  appendHandoverContractAudit(home, {
    action: "contract_checked", contract_id: contract.id, from: contract.from, to: contract.to,
    round, verdict, passed: passedCount, total: items.length,
    failed: items.filter((i) => !i.passed).map((i) => i.id),
  });
  emitVerdictEvent(home, opts.runId, contract, attempt);
  const trustRecorded = recordTrust(
    home, contract.from,
    verdict === "accepted" ? "success" : "violation",
    verdict === "accepted" ? "handover_contract_accepted" : verdict === "sent-back" ? "handover_contract_sent_back" : "handover_contract_stopped",
    opts.runId,
  );
  const failed = items.filter((i) => !i.passed);
  const text = verdict === "accepted"
    ? `统筹请看：${contract.from} 交的活已通过程序验收（${passedCount}/${items.length} 项全过，第 ${round} 轮），可以汇总了。`
    : verdict === "sent-back"
      ? `打回给 ${contract.from}（第 ${round}/${contract.maxRounds} 轮）：${failed.map((i) => `${i.label}——${i.detail}`).join("；")}。改完再交，轮次用完就停下等人。`
      : `停下等人：${contract.from} 交的活第 ${round} 轮仍没过（${failed.map((i) => `${i.label}——${i.detail}`).join("；")}），修正轮次已用完，须人看一眼再定夺（nyra handover contract resolve ${contract.id} --yes 认下，或 close 放弃）。`;
  return { contract, attempt, verdict, text, trustRecorded };
}

/** 人工定夺：停下等人的契约由人看过后认下（终态；人说了算，程序不再拦）。 */
export function resolveHandoverContract(home: string, contractId: string, by: string): HandoverContract {
  const contract = getHandoverContract(home, contractId);
  if (!contract) throw new HandoverContractError(`找不到交接契约 ${contractId}`);
  if (contract.status !== "stopped") {
    throw new HandoverContractError(`交接契约 ${contractId} 当前是${HANDOVER_CONTRACT_STATUS_LABELS[contract.status]}，只有“已停下等人”的才能 resolve`);
  }
  contract.status = "resolved";
  saveOne(home, contract);
  appendHandoverContractAudit(home, { action: "contract_resolved", contract_id: contract.id, from: contract.from, to: contract.to, by });
  return contract;
}

/** 放弃一份契约（终态；待验收、已打回、已停下等人的都能放弃）。 */
export function closeHandoverContract(home: string, contractId: string, by: string): HandoverContract {
  const contract = getHandoverContract(home, contractId);
  if (!contract) throw new HandoverContractError(`找不到交接契约 ${contractId}`);
  if (contract.status === "accepted" || contract.status === "resolved" || contract.status === "closed") {
    throw new HandoverContractError(`交接契约 ${contractId} 已经是${HANDOVER_CONTRACT_STATUS_LABELS[contract.status]}，不能再放弃`);
  }
  contract.status = "closed";
  saveOne(home, contract);
  appendHandoverContractAudit(home, { action: "contract_closed", contract_id: contract.id, from: contract.from, to: contract.to, by });
  return contract;
}

/** 契约内容指纹（任务 + 交付物 + 验收项；时间戳与状态不进指纹）。 */
export function handoverContractHash(contract: Pick<HandoverContract, "task" | "deliverables" | "checks">): string {
  const body = JSON.stringify({
    task: contract.task,
    deliverables: contract.deliverables,
    checks: contract.checks.map((c) => ({ id: c.id, label: c.label, checker: c.checker })),
  });
  return createHash("sha256").update(body, "utf-8").digest("hex");
}

export function formatHandoverContract(contract: HandoverContract): string {
  const lines = [
    `交接契约 ${contract.id} [${HANDOVER_CONTRACT_STATUS_LABELS[contract.status]}]`,
    ` ${contract.from} → ${contract.to}；任务：${contract.task}`,
    ` 内容指纹：${handoverContractHash(contract).slice(0, 12)}…`,
    ` 修正轮次：已用 ${contract.roundsUsed}/${contract.maxRounds} 轮`,
    ...(contract.packageId ? [` 挂到的交接包：${contract.packageId}`] : []),
    ` 交付物（${contract.deliverables.length} 件）：`,
    ...contract.deliverables.map((d) => `  - ${d.id}：${d.path}——${d.description}`),
    ` 验收项（${contract.checks.length} 项，确定性、不调模型）：`,
    ...contract.checks.map((c) => `  - ${c.id} ${c.label}（checker：${c.checker}）`),
  ];
  const latest = contract.attempts[contract.attempts.length - 1];
  if (latest) {
    lines.push(` 最近一次验收（第 ${latest.round} 轮，${HANDOVER_VERDICT_LABELS[latest.verdict]}，${latest.passedCount}/${latest.total} 项通过）：`);
    for (const item of latest.items) {
      lines.push(`  - ${item.passed ? "通过" : "未过"} ${item.label}——${item.detail}`);
    }
  } else {
    lines.push(" 未验收过。");
  }
  return lines.join("\n");
}
