// src/trustLadder.ts — GROK-6：信任阶梯（缺口 43 治理深化）。
//
// 报告 ~/workspace/research_notes/nyra-hermes-subagents-grokbot-team-20261121.md
// §3 GROK-6 口径：新 agent / 新技能默认只读跑，攒够验证证据（N 次成功 +
// 零违规）才升一级：起草 → 发送 / 购买；每级升级记审计；降级随时可做；
// 须配随机抽查防“刷证据”。
//
// 落地口径（报告没写死的部分，这里定死，文档里也写明）：
//   - 级别四档：readonly（只读）→ draft（起草）→ send（发送）→ purchase（购买），
//     一次只升一级；升级是显式动作（nyra trust promote --yes），攒够证据
//     不自动升级——放手仍须人点头。
//   - 证据：一次成功 +1（连续成功才算数，一次违规清零本级计数）；升级要 N 次
//     连续成功且自进本级以来零违规。N 默认 5，config.json 的
//     trust_ladder.required_successes 可配 1–20，非法回 5。
//   - 随机抽查：每次记成功时按概率抽查（默认 10%，trust_ladder.spot_check_rate
//     可配 0–0.5，非法回 0.1）。被抽中的证据先挂起（不计入升级计数），须人
//     复核（nyra trust review --approve/--reject）：通过才计入，驳回按一次
//     违规算（计数清零、违规总数 +1）。有待复核的抽查时不许升级——先审完再说。
//   - 降级随时可做（nyra trust demote --to <更低一级> --yes），立即生效，
//     本级计数清零，记审计。
//   - 门（enforcement）：checkTrustGate 只对“已登记”的主体生效。未登记的
//     agent/skill 不在阶梯里，行为与以前完全一致——老用户与既有测试不受影响；
//     登记即进阶梯，从只读起步。门按业务动作定级（复用缺口 51 的
//     businessActionForTool）：draft 动作要 draft 级、send_message/delete
//     要 send 级、pay/sign/transfer/change_password 要 purchase 级；查询与
//     本地读写不在门内。门接在 checkApproval 里 Soul invariant 之后、团队门
//     之前；被拦记 trust_blocked 事件与审计，文案写清当前级别与还差几次成功。
//   - 账本 ~/.nyra/trust-ladder.json（原子写 0600，损坏先备份再抛错，不静默
//     重建）与审计 ~/.nyra/trust-ladder-audit.jsonl（append-only 0600，写失败
//     不抛错）；每主体最多留 100 条证据，超了丢最老的（只记元数据，不记原文）。
//   - 技能级主体只记账本、只供 CLI 与程序调用方查门；工具层的 checkApproval
//     只认 agent（ctx 里没有“当前技能”），技能在工具调用点的强制门是后续
//     批次的事，文档已知局限里写明。
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { resolveHome, loadConfig } from "./config.ts";
import { RunStore } from "./runs.ts";
import { SOUL_AGENT_ID_RE } from "./soul.ts";
import { businessActionForTool, type BusinessAction } from "./businessRedlines.ts";

export class TrustLadderError extends Error {}

export type TrustLevel = "readonly" | "draft" | "send" | "purchase";
export type TrustKind = "agent" | "skill";

/** 级别顺序（数值越大权限越高）。 */
export const TRUST_LEVELS: readonly TrustLevel[] = ["readonly", "draft", "send", "purchase"];
export const TRUST_LEVEL_ORDER: Record<TrustLevel, number> = {
  readonly: 0, draft: 1, send: 2, purchase: 3,
};
export const TRUST_LEVEL_LABELS: Record<TrustLevel, string> = {
  readonly: "只读", draft: "起草", send: "发送", purchase: "购买",
};

export const TRUST_LADDER_FILE = "trust-ladder.json";
export const TRUST_LADDER_AUDIT_FILE = "trust-ladder-audit.jsonl";
export const DEFAULT_REQUIRED_SUCCESSES = 5;
export const DEFAULT_SPOT_CHECK_RATE = 0.1;
export const MAX_EVIDENCE_PER_SUBJECT = 100;

export interface TrustEvidence {
  id: string;
  at: string;
  action: string;
  outcome: "success" | "violation";
  note: string;
  spot_check: boolean;
  spot_status: "pending" | "approved" | "rejected" | "na";
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface TrustSubject {
  kind: TrustKind;
  id: string;
  level: TrustLevel;
  level_since: string;
  successes_at_level: number;
  violations_total: number;
  evidence: TrustEvidence[];
}

export interface TrustStore {
  version: 1;
  subjects: Record<string, TrustSubject>;
}

export interface TrustLadderSettings {
  requiredSuccesses: number;
  spotCheckRate: number;
}

/** 从 config（已加载的 config.json 内容）解析阶梯参数；非法值回默认值。 */
export function resolveTrustLadderSettings(config: Record<string, unknown>): TrustLadderSettings {
  const raw = (config.trust_ladder ?? {}) as Record<string, unknown>;
  const n = raw.required_successes;
  const requiredSuccesses = typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 20
    ? n : DEFAULT_REQUIRED_SUCCESSES;
  const r = raw.spot_check_rate;
  const spotCheckRate = typeof r === "number" && Number.isFinite(r) && r >= 0 && r <= 0.5
    ? r : DEFAULT_SPOT_CHECK_RATE;
  return { requiredSuccesses, spotCheckRate };
}

export function trustLadderPath(home: string): string {
  return join(resolveHome(home), TRUST_LADDER_FILE);
}

export function subjectKey(kind: TrustKind, id: string): string {
  return `${kind}:${id}`;
}

export function isTrustLevel(value: unknown): value is TrustLevel {
  return typeof value === "string" && (TRUST_LEVELS as readonly string[]).includes(value);
}

export function isTrustKind(value: unknown): value is TrustKind {
  return value === "agent" || value === "skill";
}

const SKILL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 主体 id 校验：agent 沿用 Soul 的 id 口径，skill 只认小写字母数字下划线连字符。 */
export function validateSubjectId(kind: TrustKind, id: string): void {
  if (kind === "agent") {
    if (!SOUL_AGENT_ID_RE.test(id)) throw new TrustLadderError(`agent id 非法：${id}（只认小写字母开头、字母数字下划线连字符，最长 32 字）`);
  } else if (!SKILL_ID_RE.test(id)) {
    throw new TrustLadderError(`skill id 非法：${id}（只认小写字母数字开头、字母数字下划线连字符，最长 64 字）`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function newEvidenceId(): string {
  return `ev_${randomBytes(6).toString("hex")}`;
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

/** 原子写 0600：先写同目录临时文件再 rename；旧文件是符号链接就拒绝。 */
function saveJsonAtomic(home: string, file: string, data: unknown): void {
  const path = join(resolveHome(home), file);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new TrustLadderError(`${file} 不能是符号链接`);
  }
  const tmp = join(dirname(path), `.${file}-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function isTrustStore(raw: unknown): raw is TrustStore {
  return !!raw && typeof raw === "object" && (raw as TrustStore).version === 1 &&
    typeof (raw as TrustStore).subjects === "object" && (raw as TrustStore).subjects !== null;
}

export function loadTrustStore(home: string): TrustStore {
  const path = join(resolveHome(home), TRUST_LADDER_FILE);
  if (!existsSync(path)) return { version: 1, subjects: {} };
  if (lstatSync(path).isSymbolicLink()) throw new TrustLadderError(`${TRUST_LADDER_FILE} 不能是符号链接`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new TrustLadderError(`${TRUST_LADDER_FILE} 损坏，已备份，请检查后恢复`);
  }
  if (!isTrustStore(raw)) {
    backupCorrupt(path);
    throw new TrustLadderError(`${TRUST_LADDER_FILE} 格式无效，已备份`);
  }
  return raw;
}

function saveTrustStore(home: string, store: TrustStore): void {
  saveJsonAtomic(home, TRUST_LADDER_FILE, store);
}

/** 审计链：append-only jsonl，0600。写失败不抛错（审计丢了不该拦住正事），但返回 false。 */
export function appendTrustLadderAudit(home: string, entry: Record<string, unknown>): boolean {
  try {
    const path = join(resolveHome(home), TRUST_LADDER_AUDIT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return false;
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify({ at: nowIso(), ...entry }) + "\n", null, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** 有运行上下文时，把信任阶梯事件镜像进运行事件（tasks 目录优先，runs 次之）。 */
function mirrorEvent(home: string, runId: string | null | undefined, type: string, fields: Record<string, unknown>): void {
  if (!runId) return;
  for (const dir of ["tasks", "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      store.load(runId);
      store.appendEvent(runId, type, fields);
      return;
    } catch { /* 该目录下没有这个运行，换下一个目录试 */ }
  }
}

export interface TrustOpts {
  by?: string;
  runId?: string | null;
}

/** 登记新主体：默认只读起步。已登记过直接抛错（不要静默覆盖级别）。 */
export function registerSubject(home: string, kind: TrustKind, id: string, opts: TrustOpts = {}): TrustSubject {
  validateSubjectId(kind, id);
  const store = loadTrustStore(home);
  const key = subjectKey(kind, id);
  if (store.subjects[key]) throw new TrustLadderError(`${kind} ${id} 已登记在信任阶梯里（当前 ${TRUST_LEVEL_LABELS[store.subjects[key].level]}级），不要重复登记`);
  const subject: TrustSubject = {
    kind, id, level: "readonly", level_since: nowIso(),
    successes_at_level: 0, violations_total: 0, evidence: [],
  };
  store.subjects[key] = subject;
  saveTrustStore(home, store);
  appendTrustLadderAudit(home, { action: "trust_registered", kind, subject_id: id, level: "readonly", by: opts.by ?? null });
  mirrorEvent(home, opts.runId, "trust_registered", { kind, subject_id: id, level: "readonly" });
  return subject;
}

export function getSubject(home: string, kind: TrustKind, id: string): TrustSubject | null {
  return loadTrustStore(home).subjects[subjectKey(kind, id)] ?? null;
}

export function listSubjects(home: string, filter?: { kind?: TrustKind }): TrustSubject[] {
  const all = Object.values(loadTrustStore(home).subjects);
  const list = filter?.kind ? all.filter((s) => s.kind === filter.kind) : all;
  return list.sort((a, b) => subjectKey(a.kind, a.id).localeCompare(subjectKey(b.kind, b.id)));
}

function pendingSpotChecks(subject: TrustSubject): TrustEvidence[] {
  return subject.evidence.filter((e) => e.spot_check && e.spot_status === "pending");
}

export interface RecordEvidenceOpts extends TrustOpts {
  action?: string;
  note?: string;
  /** 随机数来源（默认 Math.random；测试里传确定性函数）。 */
  random?: () => number;
}

export interface RecordEvidenceResult {
  subject: TrustSubject;
  evidence: TrustEvidence;
  spotChecked: boolean;
}

/**
 * 记一条验证证据。成功：没被抽查就本级计数 +1；被抽查就挂起待复核（不计数）。
 * 违规：本级计数清零、违规总数 +1。note 只记元数据，不记原文，超 200 字截断。
 */
export function recordEvidence(
  home: string, kind: TrustKind, id: string,
  outcome: "success" | "violation", opts: RecordEvidenceOpts = {},
): RecordEvidenceResult {
  validateSubjectId(kind, id);
  const store = loadTrustStore(home);
  const subject = store.subjects[subjectKey(kind, id)];
  if (!subject) throw new TrustLadderError(`${kind} ${id} 还没登记在信任阶梯里（先 nyra trust register 登记，默认只读起步）`);
  const settings = resolveTrustLadderSettings(loadConfig(home));
  const random = opts.random ?? Math.random;
  const spotChecked = outcome === "success" && settings.spotCheckRate > 0 && random() < settings.spotCheckRate;
  const evidence: TrustEvidence = {
    id: newEvidenceId(),
    at: nowIso(),
    action: (opts.action ?? "").slice(0, 120),
    outcome,
    note: (opts.note ?? "").slice(0, 200),
    spot_check: spotChecked,
    spot_status: spotChecked ? "pending" : "na",
    reviewed_by: null,
    reviewed_at: null,
  };
  subject.evidence.push(evidence);
  if (subject.evidence.length > MAX_EVIDENCE_PER_SUBJECT) {
    subject.evidence.splice(0, subject.evidence.length - MAX_EVIDENCE_PER_SUBJECT);
  }
  if (outcome === "violation") {
    subject.successes_at_level = 0;
    subject.violations_total += 1;
  } else if (!spotChecked) {
    subject.successes_at_level += 1;
  }
  saveTrustStore(home, store);
  appendTrustLadderAudit(home, { action: "trust_evidence_recorded", kind, subject_id: id, evidence_id: evidence.id, outcome, spot_check: spotChecked, by: opts.by ?? null });
  mirrorEvent(home, opts.runId, "trust_evidence_recorded", { kind, subject_id: id, evidence_id: evidence.id, outcome });
  if (spotChecked) {
    appendTrustLadderAudit(home, { action: "trust_spot_check_flagged", kind, subject_id: id, evidence_id: evidence.id });
    mirrorEvent(home, opts.runId, "trust_spot_check_flagged", { kind, subject_id: id, evidence_id: evidence.id });
  }
  return { subject, evidence, spotChecked };
}

/** 复核一条被抽查的证据：通过才计入升级计数；驳回按一次违规算。 */
export function reviewSpotCheck(
  home: string, evidenceId: string, decision: "approve" | "reject",
  by: string, opts: TrustOpts = {},
): { subject: TrustSubject; evidence: TrustEvidence } {
  const store = loadTrustStore(home);
  let found: { subject: TrustSubject; evidence: TrustEvidence } | null = null;
  for (const subject of Object.values(store.subjects)) {
    const evidence = subject.evidence.find((e) => e.id === evidenceId);
    if (evidence) { found = { subject, evidence }; break; }
  }
  if (!found) throw new TrustLadderError(`证据 ${evidenceId} 不存在`);
  const { subject, evidence } = found;
  if (!evidence.spot_check || evidence.spot_status !== "pending") {
    throw new TrustLadderError(`证据 ${evidenceId} 不是待复核的抽查（当前状态 ${evidence.spot_status}），不用复核`);
  }
  evidence.spot_status = decision === "approve" ? "approved" : "rejected";
  evidence.reviewed_by = by;
  evidence.reviewed_at = nowIso();
  if (decision === "approve") {
    subject.successes_at_level += 1;
  } else {
    subject.successes_at_level = 0;
    subject.violations_total += 1;
  }
  saveTrustStore(home, store);
  appendTrustLadderAudit(home, { action: "trust_spot_check_reviewed", evidence_id: evidence.id, decision, kind: subject.kind, subject_id: subject.id, by });
  mirrorEvent(home, opts.runId, "trust_spot_check_reviewed", { evidence_id: evidence.id, decision });
  return { subject, evidence };
}

export interface PromotionCheck {
  eligible: boolean;
  reason: string;
  needed: number;
  pendingSpotChecks: number;
}

/** 升级判定：本级连续成功满 N 次、且没有待复核的抽查，才能升一级。 */
export function checkPromotion(home: string, kind: TrustKind, id: string): PromotionCheck {
  const subject = getSubject(home, kind, id);
  if (!subject) throw new TrustLadderError(`${kind} ${id} 还没登记在信任阶梯里`);
  if (subject.level === "purchase") {
    return { eligible: false, reason: "已是最高级（购买），没有更高一级", needed: 0, pendingSpotChecks: 0 };
  }
  const pending = pendingSpotChecks(subject).length;
  if (pending > 0) {
    return { eligible: false, reason: `有 ${pending} 条抽查待复核，先审完再升级`, needed: 0, pendingSpotChecks: pending };
  }
  const settings = resolveTrustLadderSettings(loadConfig(home));
  const needed = settings.requiredSuccesses - subject.successes_at_level;
  if (needed > 0) {
    return { eligible: false, reason: `本级连续成功 ${subject.successes_at_level}/${settings.requiredSuccesses} 次，还差 ${needed} 次`, needed, pendingSpotChecks: 0 };
  }
  return { eligible: true, reason: "已攒够证据，可以升级", needed: 0, pendingSpotChecks: 0 };
}

/** 升级：一次只升一级；条件不够直接拒绝（不静默升级、不跳级）。 */
export function promoteSubject(home: string, kind: TrustKind, id: string, by: string, opts: TrustOpts = {}): TrustSubject {
  const check = checkPromotion(home, kind, id);
  if (!check.eligible) throw new TrustLadderError(`不能升级：${check.reason}`);
  const store = loadTrustStore(home);
  const subject = store.subjects[subjectKey(kind, id)]!;
  const next = TRUST_LEVELS[TRUST_LEVEL_ORDER[subject.level] + 1];
  const from = subject.level;
  subject.level = next;
  subject.level_since = nowIso();
  subject.successes_at_level = 0;
  saveTrustStore(home, store);
  appendTrustLadderAudit(home, { action: "trust_promoted", kind, subject_id: id, from, to: next, by });
  mirrorEvent(home, opts.runId, "trust_promoted", { kind, subject_id: id, level: next });
  return subject;
}

/** 降级：随时可做、立即生效；只能往更低一级降，不许平级或升级。 */
export function demoteSubject(home: string, kind: TrustKind, id: string, to: TrustLevel, by: string, opts: TrustOpts = {}): TrustSubject {
  validateSubjectId(kind, id);
  const store = loadTrustStore(home);
  const subject = store.subjects[subjectKey(kind, id)];
  if (!subject) throw new TrustLadderError(`${kind} ${id} 还没登记在信任阶梯里`);
  if (TRUST_LEVEL_ORDER[to] >= TRUST_LEVEL_ORDER[subject.level]) {
    throw new TrustLadderError(`降级只能降到比当前更低的级（当前 ${TRUST_LEVEL_LABELS[subject.level]}级，要降到 ${TRUST_LEVEL_LABELS[to]}级）`);
  }
  const from = subject.level;
  subject.level = to;
  subject.level_since = nowIso();
  subject.successes_at_level = 0;
  saveTrustStore(home, store);
  appendTrustLadderAudit(home, { action: "trust_demoted", kind, subject_id: id, from, to, by });
  mirrorEvent(home, opts.runId, "trust_demoted", { kind, subject_id: id, level: to });
  return subject;
}

/**
 * 工具 → 信任级别：复用缺口 51 的业务动作映射。起草动作要起草级、发消息/删
 * 除要发送级、付款/签署/转账/改密码要购买级；查询与没有业务动作的工具
 * （本地读写、shell 等）不在门内，返回 null。
 */
export function requiredLevelForTool(toolName: string): TrustLevel | null {
  const mapped = businessActionForTool(toolName);
  if (!mapped) return null;
  const action: BusinessAction = mapped.action;
  switch (action) {
    case "draft": return "draft";
    case "send_message":
    case "delete": return "send";
    case "pay":
    case "sign":
    case "transfer":
    case "change_password": return "purchase";
    default: return null;
  }
}

export interface TrustGateBlock {
  agent: string;
  tool: string;
  level: TrustLevel;
  required: TrustLevel;
  reason: string;
}

/**
 * 信任门：只对已登记的 agent 生效。未登记 → null（不在阶梯里，行为不变）；
 * 级别够 → null；级别不够 → 拦住的原因（含当前级别、还差几次成功、待复核
 * 抽查数）。调用方只读账本，不写。
 */
export function checkTrustGate(home: string, agent: string, toolName: string): TrustGateBlock | null {
  const required = requiredLevelForTool(toolName);
  if (!required) return null;
  const subject = getSubject(home, "agent", agent);
  if (!subject) return null;
  if (TRUST_LEVEL_ORDER[subject.level] >= TRUST_LEVEL_ORDER[required]) return null;
  const pending = pendingSpotChecks(subject).length;
  const settings = resolveTrustLadderSettings(loadConfig(home));
  const needed = Math.max(0, settings.requiredSuccesses - subject.successes_at_level);
  const reason = `agent ${agent} 当前为「${TRUST_LEVEL_LABELS[subject.level]}」级，${toolName} 需要「${TRUST_LEVEL_LABELS[required]}」级` +
    `（本级连续成功 ${subject.successes_at_level}/${settings.requiredSuccesses} 次，还差 ${needed} 次` +
    `${pending > 0 ? `，另有 ${pending} 条抽查待复核` : ""}` +
    `${subject.level === "readonly" && required !== "draft" ? "；先升到起草级，再攒证据往上升" : ""}）`;
  return { agent, tool: toolName, level: subject.level, required, reason };
}

/** 信任门事件与审计也进 governance 审计链（缺口 43 的审计导出已覆盖它）。 */
export function appendTrustGateAudit(home: string, block: TrustGateBlock): boolean {
  return appendTrustLadderAudit(home, {
    action: "trust_blocked", agent: block.agent, tool: block.tool,
    level: block.level, required_level: block.required,
  });
}

const USAGE =
  "用法：nyra trust <register|list|show|evidence|promote|demote|review|check> [选项]\n" +
  "  register agent <名字> | register skill <名字>   登记新主体，默认只读起步\n" +
  "  list [--kind agent|skill] [--json]   列出已登记的主体与级别\n" +
  "  show agent <名字> | show skill <名字> [--json]   看一个主体的级别与证据进度\n" +
  "  evidence agent <名字> <success|violation> [--action <动作名>] [--note <说明>] --yes   记一条验证证据\n" +
  "  promote agent <名字> --yes   攒够证据升一级（一次只升一级）\n" +
  "  demote agent <名字> --to readonly|draft|send --yes   随时降级，立即生效\n" +
  "  review <证据 id> --approve|--reject --yes   复核一条被抽查的证据\n" +
  "  check agent <名字> <工具名>   只判信任门，不执行\n" +
  "信任阶梯（GROK-6，缺口 43 治理深化）：新 agent / 新技能默认只读，攒够 N 次连续成功且零违规才升一级；\n" +
  "每次记成功有概率被随机抽查（默认 10%），被抽中的须人复核才计入；降级随时可做。详见 docs/trust-ladder.md。\n";

function hasYes(argv: string[]): boolean {
  return argv.includes("--yes");
}

function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function formatSubject(s: TrustSubject): string {
  return `${s.kind} ${s.id}：${TRUST_LEVEL_LABELS[s.level]}级（本级连续成功 ${s.successes_at_level} 次，累计违规 ${s.violations_total} 次，待复核抽查 ${pendingSpotChecks(s).length} 条）`;
}

export function handleTrust(argv: string[], home: string): number {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action) {
    process.stdout.write(USAGE);
    return 2;
  }
  const kindAt = (i: number): TrustKind => {
    const k = argv[i];
    if (!isTrustKind(k)) throw new TrustLadderError(`主体类型只认 agent 或 skill（收到 ${k ?? "（空）"}）`);
    return k;
  };
  try {
    if (action === "register") {
      const kind = kindAt(1);
      const id = argv[2] ?? "";
      if (!hasYes(argv)) throw new TrustLadderError("登记进信任阶梯须加 --yes（登记即从只读起步、对外动作受门约束）");
      const s = registerSubject(resolvedHome, kind, id, { by: "cli" });
      process.stdout.write(`已登记：${formatSubject(s)}\n`);
      return 0;
    }
    if (action === "list") {
      const kindRaw = getFlag(argv, "--kind");
      const kind = kindRaw === undefined ? undefined : isTrustKind(kindRaw) ? kindRaw : null;
      if (kind === null) throw new TrustLadderError(`--kind 只认 agent 或 skill（收到 ${kindRaw}）`);
      const list = listSubjects(resolvedHome, kind ? { kind } : undefined);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(list, null, 2) + "\n");
        return 0;
      }
      if (!list.length) {
        process.stdout.write("信任阶梯里还没有登记的主体（nyra trust register agent <名字> 登记，默认只读起步）。\n");
        return 0;
      }
      for (const s of list) process.stdout.write(`${formatSubject(s)}\n`);
      return 0;
    }
    if (action === "show") {
      const kind = kindAt(1);
      const id = argv[2] ?? "";
      const s = getSubject(resolvedHome, kind, id);
      if (!s) throw new TrustLadderError(`${kind} ${id} 还没登记在信任阶梯里`);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(s, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(`${formatSubject(s)}\n`);
      process.stdout.write(`进本级时间：${s.level_since}\n`);
      for (const e of s.evidence.slice(-10)) {
        process.stdout.write(`  ${e.id} ${e.at.slice(0, 19)} ${e.outcome === "success" ? "成功" : "违规"}${e.action ? ` ${e.action}` : ""}${e.spot_check ? ` 抽查:${e.spot_status}` : ""}\n`);
      }
      return 0;
    }
    if (action === "evidence") {
      const kind = kindAt(1);
      const id = argv[2] ?? "";
      const outcome = argv[3];
      if (outcome !== "success" && outcome !== "violation") {
        throw new TrustLadderError(`证据结果只认 success 或 violation（收到 ${outcome ?? "（空）"}）`);
      }
      if (!hasYes(argv)) throw new TrustLadderError("记证据须加 --yes");
      const r = recordEvidence(resolvedHome, kind, id, outcome, {
        action: getFlag(argv, "--action"), note: getFlag(argv, "--note"), by: "cli",
      });
      process.stdout.write(`已记证据 ${r.evidence.id}（${outcome === "success" ? "成功" : "违规"}）${r.spotChecked ? "——被随机抽查选中，待复核才计入升级" : ""}；${formatSubject(r.subject)}\n`);
      return 0;
    }
    if (action === "promote") {
      const kind = kindAt(1);
      const id = argv[2] ?? "";
      if (!hasYes(argv)) throw new TrustLadderError("升级须加 --yes");
      const s = promoteSubject(resolvedHome, kind, id, "cli");
      process.stdout.write(`已升级：${formatSubject(s)}\n`);
      return 0;
    }
    if (action === "demote") {
      const kind = kindAt(1);
      const id = argv[2] ?? "";
      const to = getFlag(argv, "--to");
      if (!isTrustLevel(to)) throw new TrustLadderError(`--to 只认 readonly|draft|send（收到 ${to ?? "（空）"}）`);
      if (!hasYes(argv)) throw new TrustLadderError("降级须加 --yes");
      const s = demoteSubject(resolvedHome, kind, id, to, "cli");
      process.stdout.write(`已降级：${formatSubject(s)}\n`);
      return 0;
    }
    if (action === "review") {
      const evidenceId = argv[1] ?? "";
      const decision = argv.includes("--approve") ? "approve" : argv.includes("--reject") ? "reject" : null;
      if (!decision) throw new TrustLadderError("复核须加 --approve 或 --reject");
      if (!hasYes(argv)) throw new TrustLadderError("复核须加 --yes");
      const r = reviewSpotCheck(resolvedHome, evidenceId, decision, "cli");
      process.stdout.write(`已复核证据 ${evidenceId}（${decision === "approve" ? "通过，计入升级" : "驳回，按一次违规算"}）；${formatSubject(r.subject)}\n`);
      return 0;
    }
    if (action === "check") {
      const kind = kindAt(1);
      if (kind !== "agent") throw new TrustLadderError("check 只认 agent（工具层的门只看执行 agent）");
      const id = argv[2] ?? "";
      const tool = argv[3] ?? "";
      if (!tool) throw new TrustLadderError("check 须给工具名（nyra trust check agent <名字> <工具名>）");
      const block = checkTrustGate(resolvedHome, id, tool);
      if (!block) {
        process.stdout.write(`放行：${tool} 不受信任阶梯约束，或 agent ${id} 的级别已够\n`);
        return 0;
      }
      process.stdout.write(`拦截：${block.reason}\n`);
      return 2;
    }
    process.stdout.write(USAGE);
    return 2;
  } catch (err) {
    if (err instanceof TrustLadderError) {
      process.stderr.write(`信任阶梯：${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
