// src/scriptPreauth.ts — Pi Bot 借鉴第 1 条：摘要预授权（script:<摘要>）。
//
// 例行（工作流）可以预授权一份确定内容的脚本：摘要对上号才走快路径，
// 内容一改摘要就变、授权自动失效；而且这授权只在例行里有效，绝不会
// 变成聊天里的“记住批准”——checkScriptFastPath 只在 ctx.routineId
// 已设时才跑，聊天里 routineId 永远是空的。
//
// 账本 ~/.nyra/script-preauth.json（原子写 0600，损坏先备份再抛错，
// 与 trust-ladder.json 同款）；审计 ~/.nyra/script-preauth-audit.jsonl
//（append-only 0600，写失败返回 null 不拦运行，与 model-switch-audit
// 同款）；审计也进 SIEM 导出（costCaps.ts 的 AUDIT_SOURCES 第 9 个来源）。
//
// 钉摘要的口径：只钉“纯脚本 + 不含模板变量 + 没指定 cwd”的步骤。
// 含模板的步骤命令每次跑都可能不一样，钉死定义文本没有意义；指定了
// cwd 的步骤钉死时按工作目录解析文件，跑时按步骤的 cwd 解析，同一份
// 文件可能解析出两处——钉了也是错的，所以不钉。
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  judgeScript,
  scriptDigest,
  parseShellScript,
  type ScriptLanguage,
} from "./scriptPurity.ts";

export class ScriptPreauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptPreauthError";
  }
}

export const SCRIPT_PREAUTH_FILE = "script-preauth.json";
export const SCRIPT_PREAUTH_AUDIT_FILE = "script-preauth-audit.jsonl";

/** 例行 id：工作流是 `workflow:<名字>`（以后定时任务接进来再加前缀）。 */
export function workflowRoutineId(name: string): string {
  return `workflow:${name}`;
}

export interface ScriptPreauthEntry {
  /** 哪个例行（如 workflow:日报）。 */
  routine: string;
  /** 例行里的哪一步（工作流步骤 id）；钉死按步查，摘要对不上只拦这一步。 */
  stepId: string;
  language: ScriptLanguage;
  /** 脚本正文的 SHA-256（hex），范围 id 是 script:<digest>。 */
  digest: string;
  /** 文件脚本时的文件绝对路径（内联脚本为 null）。 */
  file: string | null;
  grantedAt: string;
}

export interface ScriptPreauthLedger {
  version: 1;
  entries: ScriptPreauthEntry[];
}

export function preauthPath(home: string): string {
  return join(home, SCRIPT_PREAUTH_FILE);
}

function preauthAuditPath(home: string): string {
  return join(home, SCRIPT_PREAUTH_AUDIT_FILE);
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadPreauth(home: string): ScriptPreauthLedger {
  const p = preauthPath(home);
  if (!existsSync(p)) return { version: 1, entries: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    backupCorrupt(p);
    throw new ScriptPreauthError("脚本预授权账本损坏，已备份，请检查后重新授权");
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as ScriptPreauthLedger).entries)) {
    backupCorrupt(p);
    throw new ScriptPreauthError("脚本预授权账本格式无效，已备份，请检查后重新授权");
  }
  const entries: ScriptPreauthEntry[] = [];
  for (const e of (raw as ScriptPreauthLedger).entries) {
    if (!e || typeof e !== "object") continue;
    const r = e as unknown as Record<string, unknown>;
    if (typeof r.routine !== "string" || typeof r.stepId !== "string" || typeof r.digest !== "string") continue;
    entries.push({
      routine: r.routine as string,
      stepId: r.stepId as string,
      language: (r.language as ScriptLanguage) ?? "python",
      digest: r.digest as string,
      file: (r.file as string | null) ?? null,
      grantedAt: (r.grantedAt as string) ?? "",
    });
  }
  return { version: 1, entries };
}

export function savePreauth(home: string, ledger: ScriptPreauthLedger): string {
  const p = preauthPath(home);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = join(dirname(p), `.script-preauth-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(ledger, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, p);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
  return p;
}

/** 授权：一例行一步只留一条（重复授权按最新算，旧的直接换掉）。 */
export function grantPreauth(
  home: string,
  routine: string,
  grants: Array<{ stepId: string; language: ScriptLanguage; digest: string; file: string | null }>,
): ScriptPreauthEntry[] {
  const ledger = loadPreauth(home);
  const now = new Date().toISOString();
  const out: ScriptPreauthEntry[] = [];
  for (const g of grants) {
    const entry: ScriptPreauthEntry = { routine, stepId: g.stepId, language: g.language, digest: g.digest, file: g.file, grantedAt: now };
    const idx = ledger.entries.findIndex((e) => e.routine === routine && e.stepId === g.stepId);
    if (idx >= 0) ledger.entries[idx] = entry;
    else ledger.entries.push(entry);
    out.push(entry);
  }
  savePreauth(home, ledger);
  for (const e of out) appendScriptPreauthAudit(home, { kind: "granted", routine, stepId: e.stepId, language: e.language, digest: e.digest });
  return out;
}

/** 撤销：只传 routine 撤整例行；传 digest 只撤那一条。返回撤掉的条数。 */
export function revokePreauth(home: string, routine: string, digest?: string): number {
  const ledger = loadPreauth(home);
  const kept: ScriptPreauthEntry[] = [];
  const removed: ScriptPreauthEntry[] = [];
  for (const e of ledger.entries) {
    if (e.routine === routine && (digest === undefined || e.digest === digest)) removed.push(e);
    else kept.push(e);
  }
  if (removed.length === 0) return 0;
  savePreauth(home, { version: 1, entries: kept });
  for (const e of removed) appendScriptPreauthAudit(home, { kind: "revoked", routine, stepId: e.stepId, language: e.language, digest: e.digest });
  return removed.length;
}

export function listPreauth(home: string, routine?: string): ScriptPreauthEntry[] {
  const ledger = loadPreauth(home);
  return routine === undefined ? [...ledger.entries] : ledger.entries.filter((e) => e.routine === routine);
}

export function findPreauth(home: string, routine: string, digest: string): ScriptPreauthEntry | null {
  return listPreauth(home, routine).find((e) => e.digest === digest) ?? null;
}

export interface ScriptPreauthAuditEntry {
  at: string;
  kind: "granted" | "revoked" | "used" | "refused";
  routine: string;
  stepId: string | null;
  language: ScriptLanguage | null;
  digest: string | null;
  detail: string | null;
}

/** 审计：写失败返回 null，不拦运行（与 model-switch-audit 同款）。 */
export function appendScriptPreauthAudit(
  home: string,
  entry: { kind: ScriptPreauthAuditEntry["kind"]; routine: string; stepId?: string | null; language?: ScriptLanguage | null; digest?: string | null; detail?: string | null },
): ScriptPreauthAuditEntry | null {
  try {
    const path = preauthAuditPath(home);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return null;
    const full: ScriptPreauthAuditEntry = {
      at: new Date().toISOString(),
      kind: entry.kind,
      routine: entry.routine,
      stepId: entry.stepId ?? null,
      language: entry.language ?? null,
      digest: entry.digest ?? null,
      detail: entry.detail ?? null,
    };
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify(full) + "\n", null, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return full;
  } catch {
    return null;
  }
}

export function readScriptPreauthAudit(home: string): ScriptPreauthAuditEntry[] {
  try {
    const path = preauthAuditPath(home);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return [];
    const out: ScriptPreauthAuditEntry[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ScriptPreauthAuditEntry;
        if (e && typeof e === "object" && typeof e.kind === "string") out.push(e);
      } catch { /* 损坏行跳过 */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// 钉摘要：从工作流定义里收 shell 步骤，纯的钉，不纯的跳过（附理由）。
// 只钉定义文本里的步骤——协调者运行中现生成的步骤没经过 trial/activate，
// 本来就不该钉，跑时按“没钉摘要”走（激活审批兜底，只记纯度判定）。

/** 工作流步骤的结构子集（不 import workflow.ts，避免循环）。 */
export interface ScriptStepLike {
  id: string;
  type: string;
  tool?: string;
  args?: Record<string, unknown>;
  branches?: ScriptStepLike[][];
}

export interface PinResult {
  pinned: Array<{ stepId: string; language: ScriptLanguage; digest: string; file: string | null }>;
  skipped: Array<{ stepId: string; reason: string }>;
}

function collectShellSteps(steps: ScriptStepLike[], out: ScriptStepLike[]): void {
  for (const step of steps) {
    if (step.type === "tool" && step.tool === "shell") out.push(step);
    if (step.branches) {
      for (const branch of step.branches) collectShellSteps(branch, out);
    }
  }
}

export function pinWorkflowScripts(home: string, workdir: string, routine: string, steps: ScriptStepLike[]): PinResult {
  const shellSteps: ScriptStepLike[] = [];
  collectShellSteps(steps, shellSteps);
  const pinned: PinResult["pinned"] = [];
  const skipped: PinResult["skipped"] = [];
  for (const step of shellSteps) {
    const command = step.args?.command;
    if (typeof command !== "string" || !command.trim()) {
      skipped.push({ stepId: step.id, reason: "命令不是字符串" });
      continue;
    }
    if (command.includes("{{")) {
      skipped.push({ stepId: step.id, reason: "含模板变量，不钉摘要" });
      continue;
    }
    if (typeof step.args?.cwd === "string" && (step.args.cwd as string).trim() !== "") {
      skipped.push({ stepId: step.id, reason: "指定了 cwd，不钉摘要" });
      continue;
    }
    const parsed = parseShellScript(command, workdir, workdir);
    if (!parsed) {
      skipped.push({ stepId: step.id, reason: "不是单条脚本调用" });
      continue;
    }
    const verdict = judgeScript(parsed.language, parsed.code);
    if (!verdict.pure) {
      skipped.push({ stepId: step.id, reason: verdict.reason });
      continue;
    }
    pinned.push({ stepId: step.id, language: parsed.language, digest: scriptDigest(parsed.code), file: parsed.file });
  }
  if (pinned.length) grantPreauth(home, routine, pinned);
  return { pinned, skipped };
}

// ---------------------------------------------------------------------------------------------
// 快路径判定（checkApproval 里调）：只在例行上下文里跑，返回三态——
// allow（纯脚本或预授权摘要对上号，直接放行）、pass（不是单条脚本调用，
// 落回正常审批）、refuse（钉过摘要的步骤内容变了，直接拒绝，fail-closed）。
export type ScriptFastPathResult =
  | { decision: "allow"; via: "unpinned" | "preauth"; language: ScriptLanguage; digest: string; pure: boolean; reason: string }
  | { decision: "pass"; reason: string }
  | { decision: "refuse"; reason: string };

export function checkScriptFastPath(args: {
  home: string | null;
  routineId: string;
  routineStepId: string | null;
  workdir: string;
  command: string;
  cwd: string;
  onEvent?: ((kind: string, data: Record<string, unknown>) => void) | null;
}): ScriptFastPathResult {
  const { home, routineId, routineStepId, workdir, command, cwd, onEvent } = args;
  if (!home) return { decision: "pass", reason: "没有家目录" };
  const parsed = parseShellScript(command, cwd, workdir);
  if (!parsed) return { decision: "pass", reason: "不是单条脚本调用" };
  const verdict = judgeScript(parsed.language, parsed.code);
  const digest = scriptDigest(parsed.code);
  let grants: ScriptPreauthEntry[];
  try {
    grants = listPreauth(home, routineId);
  } catch (err) {
    return { decision: "refuse", reason: `脚本预授权账本损坏，已备份：${err instanceof Error ? err.message : String(err)}（修好账本再跑）` };
  }
  // 摘要对上号（同一例行、这一步、同一份内容）→ 预授权快路径。
  const match = grants.find(
    (g) => g.digest === digest && (routineStepId === null || g.stepId === routineStepId),
  );
  if (match) {
    try {
      onEvent?.("script_preauth_used", { language: parsed.language, digest, step: routineStepId ?? "" });
    } catch { /* 事件写失败不破坏放行 */ }
    appendScriptPreauthAudit(home, { kind: "used", routine: routineId, stepId: routineStepId, language: parsed.language, digest });
    return { decision: "allow", via: "preauth", language: parsed.language, digest, pure: verdict.pure, reason: verdict.reason };
  }
  // 这一步钉过摘要，但内容变了 → 直接拒绝。非交互例行里没人可问，
  // 停下比悄悄跑改过的脚本安全；用户重新 trial + activate 即可重钉。
  if (routineStepId !== null && grants.some((g) => g.stepId === routineStepId)) {
    const reason = `步骤 ${routineStepId} 的脚本内容变了，预授权失效（摘要对不上钉死的版本），请重新 trial + activate`;
    appendScriptPreauthAudit(home, { kind: "refused", routine: routineId, stepId: routineStepId, language: parsed.language, digest, detail: reason });
    return { decision: "refuse", reason };
  }
  // 没钉摘要：按激活审批执行，只把纯度判定写进证据链。
  try {
    onEvent?.("script_pure", { language: parsed.language, digest, pure: verdict.pure, reason: verdict.reason });
  } catch { /* 事件写失败不破坏放行 */ }
  return { decision: "allow", via: "unpinned", language: parsed.language, digest, pure: verdict.pure, reason: verdict.reason };
}
