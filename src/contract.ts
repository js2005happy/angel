// src/contract.ts — 缺口 29：交付契约——任务接单时先定验收标准，跑完逐项打分。
//
// 别家（Proto）的交付契约只做到“验收”；Nyra 做到“验收标准事前可审、逐项结果
// 事后可查”：
//   - 接单时把验收标准写成结构化契约（交付物 + 必填属性 + 检查清单），
//     draft → activate（--yes 人工确认）→ attach 到运行；契约本身带 SHA-256，
//     存进 run 记录（contract_id / contract_hash），改了契约就是另一份；
//   - 验收（verify）逐项打分：确定性项走 checker（可复跑 --repeat 测 flaky），
//     模型项一次批量调模型逐项判，人工项须人先 mark-item；每项附证据出处；
//   - 结论只有“全部通过才算被接受”：有 fail → rejected；有 skipped/pending/flaky
//     但无 fail → pending（等人工看，不算接受）；全过 → accepted；
//   - 每次验收记一条 attempt（最近 20 条）：run 报告顶部读它出“检查通过率 +
//     每被接受任务成本 + 三次复核一致性”；
//   - 契约进证据链：attach / verify 记 contract_attached / contract_verified
//     事件（见 runs.ts EVENT_FIELDS）。
//
// 本模块 import runs.ts（RunStore）与 verifier.ts（验收模型）；runs.ts 不静态
// import 本模块（RunRecorder.run 里的收尾打分走动态 import，见 runs.ts），
// 不成循环。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { loadConfig, resolveHome } from "./config.ts";
import { RunStore } from "./runs.ts";
import { isKnownChecker, runChecker, type CheckerInput, type CheckerResult } from "./checkers.ts";
import { buildVerifierRunner } from "./verifier.ts";
import type { ReviewerLike } from "./reviewer.ts";

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export type ContractCheckKind = "deterministic" | "model" | "manual";
export type ContractStatus = "draft" | "active" | "accepted" | "rejected";
export type ContractVerdict = "accepted" | "rejected" | "pending";
export type ContractItemStatus = "pass" | "fail" | "pending" | "flaky" | "skipped";

export interface ContractCheck {
  id: string;
  label: string;
  kind: ContractCheckKind;
  /** 确定性项的 checker id（model/manual 项为空）。 */
  checker: string | null;
  /** 人工项的人工结论（mark-item 写；verify 时采用）。 */
  manual?: { status: "pass" | "fail"; evidence: string; at: string };
}

export interface ContractDeliverable {
  id: string;
  description: string;
  attributes: { name: string; value: string }[];
}

export interface ContractItemResult {
  checkId: string;
  label: string;
  kind: ContractCheckKind;
  status: ContractItemStatus;
  detail: string;
  evidence: string | null;
}

export interface ContractAttempt {
  at: string;
  runId: string | null;
  passed: number;
  total: number;
  flaky: number;
  skipped: number;
  pending: number;
  verdict: ContractVerdict;
  spentUsd: number | null;
  items: ContractItemResult[];
}

export interface DeliveryContract {
  id: string;
  task: string;
  deliverables: ContractDeliverable[];
  checks: ContractCheck[];
  status: ContractStatus;
  /** 契约正文（任务 + 交付物 + 检查清单）的 SHA-256；改了就是另一份。 */
  contractHash: string;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
  attempts: ContractAttempt[];
}

export interface ContractStore {
  version: 1;
  contracts: DeliveryContract[];
}

export function contractStorePath(home: string): string {
  return join(home, "contracts.json");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function newContractId(): string {
  return `ct_${randomBytes(6).toString("hex")}`;
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

/** 读契约账本；不存在返回空库；损坏先备份再抛错（不静默重建）。 */
export function loadContractStore(home: string): ContractStore {
  const path = contractStorePath(home);
  if (!existsSync(path)) return { version: 1, contracts: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new ContractError(`契约账本损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as ContractStore).contracts)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new ContractError(`契约账本格式无效，已备份到 ${backup}`);
  }
  return raw as ContractStore;
}

export function saveContractStore(home: string, store: ContractStore): void {
  atomicWriteJson(contractStorePath(home), store);
}

/** 契约正文的规范哈希（任务 + 交付物 + 检查清单；时间戳与状态不进哈希）。 */
export function contractHash(contract: Pick<DeliveryContract, "task" | "deliverables" | "checks">): string {
  const body = JSON.stringify({
    task: contract.task,
    deliverables: contract.deliverables,
    checks: contract.checks.map((c) => ({ id: c.id, label: c.label, kind: c.kind, checker: c.checker })),
  });
  return createHash("sha256").update(body, "utf-8").digest("hex");
}

function validateChecks(checks: ContractCheck[]): void {
  if (!checks.length) throw new ContractError("契约至少要有一项检查（--check）");
  const ids = new Set<string>();
  for (const c of checks) {
    if (!c.id || !c.label) throw new ContractError("检查项要有 id 与标签");
    if (ids.has(c.id)) throw new ContractError(`检查 id 重复：${c.id}`);
    ids.add(c.id);
    if (c.kind === "deterministic") {
      if (!c.checker || !isKnownChecker(c.checker)) throw new ContractError(`确定性检查 ${c.id} 的 checker 未知：${c.checker ?? ""}`);
    } else if (c.checker) {
      throw new ContractError(`${c.kind} 检查 ${c.id} 不应带 checker`);
    }
  }
}

export function createContract(
  home: string,
  input: { task: string; deliverables: ContractDeliverable[]; checks: ContractCheck[] },
): DeliveryContract {
  if (!input.task.trim()) throw new ContractError("契约要有任务描述（--task）");
  if (!input.deliverables.length) throw new ContractError("契约至少要有一件交付物（--deliverable）");
  const dIds = new Set<string>();
  for (const d of input.deliverables) {
    if (!d.id || !d.description) throw new ContractError("交付物要有 id 与描述");
    if (dIds.has(d.id)) throw new ContractError(`交付物 id 重复：${d.id}`);
    dIds.add(d.id);
  }
  validateChecks(input.checks);
  const at = nowIso();
  const contract: DeliveryContract = {
    id: newContractId(),
    task: input.task,
    deliverables: input.deliverables,
    checks: input.checks,
    status: "draft",
    contractHash: "",
    runId: null,
    createdAt: at,
    updatedAt: at,
    attempts: [],
  };
  contract.contractHash = contractHash(contract);
  const store = loadContractStore(home);
  store.contracts.push(contract);
  saveContractStore(home, store);
  return contract;
}

export function getContract(home: string, id: string): DeliveryContract | null {
  return loadContractStore(home).contracts.find((c) => c.id === id) ?? null;
}

export function listContracts(home: string): DeliveryContract[] {
  return loadContractStore(home).contracts;
}

function saveOne(home: string, contract: DeliveryContract): void {
  const store = loadContractStore(home);
  const idx = store.contracts.findIndex((c) => c.id === contract.id);
  if (idx < 0) throw new ContractError(`找不到契约 ${contract.id}`);
  contract.updatedAt = nowIso();
  store.contracts[idx] = contract;
  saveContractStore(home, store);
}

/** draft → active：验收标准事前须人工确认（--yes），草稿不能挂到运行上。 */
export function activateContract(home: string, id: string): DeliveryContract {
  const contract = getContract(home, id);
  if (!contract) throw new ContractError(`找不到契约 ${id}`);
  if (contract.status !== "draft") throw new ContractError(`契约 ${id} 已是 ${contract.status}，不用再激活`);
  contract.status = "active";
  saveOne(home, contract);
  return contract;
}

export function removeContract(home: string, id: string): boolean {
  const store = loadContractStore(home);
  const idx = store.contracts.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  store.contracts.splice(idx, 1);
  saveContractStore(home, store);
  return true;
}

/**
 * 把契约挂到一次运行上：契约须是 active；run 记录里写 contract_id / hash，
 * 结论字段先清零；记 contract_attached 事件。挂错运行可以重挂（覆盖）。
 */
export function attachContractToRun(home: string, runId: string, contractId: string): DeliveryContract {
  const contract = getContract(home, contractId);
  if (!contract) throw new ContractError(`找不到契约 ${contractId}`);
  if (contract.status !== "active") throw new ContractError(`契约 ${contractId} 是 ${contract.status}，只有 active 的契约能挂到运行上（先 activate）`);
  const store = new RunStore(join(home, "runs"));
  const state = store.load(runId);
  void state;
  store.update(runId, {
    contract_id: contract.id,
    contract_hash: contract.contractHash,
    contract_verdict: null,
    contract_passed: null,
    contract_total: null,
  });
  store.appendEvent(runId, "contract_attached", { contract_id: contract.id, contract_hash: contract.contractHash });
  contract.runId = runId;
  saveOne(home, contract);
  return contract;
}

/** 人工项的人工结论：--pass/--fail + 证据出处；之后 verify 采用它。 */
export function markContractItem(home: string, contractId: string, checkId: string, pass: boolean, evidence: string): DeliveryContract {
  const contract = getContract(home, contractId);
  if (!contract) throw new ContractError(`找不到契约 ${contractId}`);
  const check = contract.checks.find((c) => c.id === checkId);
  if (!check) throw new ContractError(`契约 ${contractId} 里没有检查 ${checkId}`);
  if (check.kind !== "manual") throw new ContractError(`检查 ${checkId} 是 ${check.kind}，只有 manual 项能人工标记`);
  check.manual = { status: pass ? "pass" : "fail", evidence: evidence || "（未附证据）", at: nowIso() };
  saveOne(home, contract);
  return contract;
}

// ---- 打分 ----

export interface ScoreInput {
  workdir: string | null;
  changedFiles: string[];
  diffStat: string | null;
  /** 任务标题（内置检查用）。 */
  title: string;
  /** 任务最终输出文本（output-contains 与模型项的核对对象）。 */
  outputText: string;
  summary: string;
  trajectory: string[];
  spentUsd: number | null;
}

export interface ScoreOptions {
  /** 确定性项复跑次数（默认 1；>1 时测 flaky：全过才算过，全不过算不过，中间态算 flaky）。 */
  repeat?: number;
  /** 模型项的运行实例；不传/为 null 时模型项记 skipped（fail-closed：不得接受）。 */
  runner?: ReviewerLike | null;
  /** 测试注入：覆盖 checker 执行（生产不传）。 */
  checkerRunner?: (id: string, input: CheckerInput) => CheckerResult;
  runId?: string | null;
  spentUsd?: number | null;
}

function checkerInput(input: ScoreInput): CheckerInput {
  return {
    workdir: input.workdir,
    changedFiles: input.changedFiles,
    diffStat: input.diffStat,
    title: input.title,
    summary: input.summary,
    outputText: input.outputText,
    trajectory: input.trajectory,
    spentUsd: input.spentUsd,
  };
}

const MODEL_SYSTEM_PROMPT =
  "你是一个逐项验收者，只按清单打分，不改代码、不跑命令。\n" +
  "下面给你一次任务的摘要、改动文件与一批模型检查项；你对每项只判通过或不通过，" +
  "并给一句话理由。拿不准判不通过，不要放行。\n" +
  "只输出一个 JSON 对象：{\"results\": [{\"id\": \"<检查 id>\", \"passed\": true 或 false, \"reason\": \"一句话理由\"}]}，" +
  "不要输出其他内容。";

/** 模型项一次批量打分（一个模型调用判全部模型项；拿不到有效结论时全记 skipped）。 */
export async function scoreModelItems(
  runner: ReviewerLike | null | undefined,
  checks: ContractCheck[],
  input: ScoreInput,
): Promise<Map<string, { passed: boolean; reason: string }>> {
  const out = new Map<string, { passed: boolean; reason: string }>();
  if (!checks.length) return out;
  if (!runner) return out;
  const lines = [
    `任务：${trunc(input.title, 200)}`,
    `摘要：\n${trunc(input.summary, 2000)}`,
    `改动文件（${input.changedFiles.length}）：${input.changedFiles.slice(0, 50).join("、") || "无"}`,
    `diff 摘要：\n${trunc(input.diffStat ?? "", 2000) || "无"}`,
    `检查项：\n${checks.map((c) => `- ${c.id}：${c.label}`).join("\n")}`,
  ];
  try {
    const response = await runner.chat(
      [
        { role: "system", content: MODEL_SYSTEM_PROMPT },
        { role: "user", content: lines.join("\n\n") },
      ],
      null,
      60,
    );
    const content = ((response.choices as Record<string, unknown>[])?.[0]?.message as Record<string, unknown>)?.content;
    if (typeof content !== "string") return out;
    const parsed = JSON.parse(content) as { results?: { id?: unknown; passed?: unknown; reason?: unknown }[] };
    if (!parsed || !Array.isArray(parsed.results)) return out;
    for (const r of parsed.results) {
      if (typeof r.id !== "string" || typeof r.passed !== "boolean") continue;
      if (!checks.some((c) => c.id === r.id)) continue;
      out.set(r.id, { passed: r.passed, reason: typeof r.reason === "string" && r.reason.trim() ? trunc(r.reason.trim(), 200) : "（模型未给理由）" });
    }
  } catch {
    return out;
  }
  return out;
}

/** 对一份契约逐项打分（不写账本；写账本走 verifyContract）。 */
export async function scoreContract(
  contract: DeliveryContract,
  input: ScoreInput,
  opts: ScoreOptions = {},
): Promise<ContractAttempt> {
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));
  const runCheck = opts.checkerRunner ?? ((id: string, ci: CheckerInput) => runChecker(id, ci));
  const modelChecks = contract.checks.filter((c) => c.kind === "model");
  const modelResults = await scoreModelItems(opts.runner ?? null, modelChecks, input);
  const items: ContractItemResult[] = [];
  for (const check of contract.checks) {
    if (check.kind === "deterministic") {
      if (!check.checker) {
        items.push({ checkId: check.id, label: check.label, kind: check.kind, status: "skipped", detail: "确定性检查没挂 checker", evidence: null });
        continue;
      }
      const runs: CheckerResult[] = [];
      for (let i = 0; i < repeat; i++) runs.push(runCheck(check.checker, checkerInput(input)));
      const passedCount = runs.filter((r) => r.passed).length;
      if (passedCount === repeat) {
        const last = runs[runs.length - 1];
        items.push({ checkId: check.id, label: check.label, kind: check.kind, status: "pass", detail: repeat > 1 ? `${repeat} 次都通过：${last.detail}` : last.detail, evidence: last.evidence });
      } else if (passedCount === 0) {
        const last = runs[runs.length - 1];
        items.push({ checkId: check.id, label: check.label, kind: check.kind, status: "fail", detail: repeat > 1 ? `${repeat} 次都没通过：${last.detail}` : last.detail, evidence: last.evidence });
      } else {
        items.push({ checkId: check.id, label: check.label, kind: check.kind, status: "flaky", detail: `${repeat} 次里通过 ${passedCount} 次，结果不稳定，先不算通过`, evidence: null });
      }
      continue;
    }
    if (check.kind === "model") {
      const r = modelResults.get(check.id);
      if (!r) {
        items.push({ checkId: check.id, label: check.label, kind: check.kind, status: "skipped", detail: "模型项未评分（无验收模型，或模型返回无法解析）", evidence: null });
      } else {
        items.push({ checkId: check.id, label: check.label, kind: check.kind, status: r.passed ? "pass" : "fail", detail: r.reason, evidence: r.reason });
      }
      continue;
    }
    const m = check.manual;
    if (!m) {
      items.push({ checkId: check.id, label: check.label, kind: check.kind, status: "pending", detail: "人工项待标记（nyra contract mark-item）", evidence: null });
    } else {
      items.push({ checkId: check.id, label: check.label, kind: check.kind, status: m.status, detail: m.status === "pass" ? `人工确认通过：${m.evidence}` : `人工确认不通过：${m.evidence}`, evidence: m.evidence });
    }
  }
  const passed = items.filter((i) => i.status === "pass").length;
  const flaky = items.filter((i) => i.status === "flaky").length;
  const skipped = items.filter((i) => i.status === "skipped").length;
  const pending = items.filter((i) => i.status === "pending").length;
  const failed = items.filter((i) => i.status === "fail").length;
  const verdict: ContractVerdict = failed > 0 ? "rejected" : passed === items.length && items.length > 0 ? "accepted" : "pending";
  return {
    at: nowIso(),
    runId: opts.runId ?? null,
    passed,
    total: items.length,
    flaky,
    skipped,
    pending,
    verdict,
    spentUsd: opts.spentUsd ?? input.spentUsd ?? null,
    items,
  };
}

/**
 * 验收一次契约并写账本：记 attempt（最近 20 条），按结论改契约状态
 *（accepted/rejected 是结论，pending 时状态不动）；有 runId 时把结论写进
 * run 记录并记 contract_verified 事件。
 */
export async function verifyContract(
  home: string,
  contractId: string,
  input: ScoreInput,
  opts: ScoreOptions = {},
): Promise<{ contract: DeliveryContract; attempt: ContractAttempt }> {
  const contract = getContract(home, contractId);
  if (!contract) throw new ContractError(`找不到契约 ${contractId}`);
  if (contract.status === "draft") throw new ContractError(`契约 ${contractId} 还是草稿，先 activate 再验收`);
  const attempt = await scoreContract(contract, input, opts);
  contract.attempts.push(attempt);
  if (contract.attempts.length > 20) contract.attempts = contract.attempts.slice(-20);
  if (attempt.verdict === "accepted") contract.status = "accepted";
  else if (attempt.verdict === "rejected") contract.status = "rejected";
  saveOne(home, contract);
  if (opts.runId) {
    const store = new RunStore(join(home, "runs"));
    try {
      store.update(opts.runId, {
        contract_verdict: attempt.verdict,
        contract_passed: attempt.passed,
        contract_total: attempt.total,
      });
      store.appendEvent(opts.runId, "contract_verified", {
        contract_id: contract.id, verdict: attempt.verdict, passed: attempt.passed, total: attempt.total,
      });
    } catch { /* 运行记录写失败不推翻验收结论本身；账本里有 attempt */ }
  }
  return { contract, attempt };
}

/** 三次复核一致性：最近 ≤3 次 attempt 里与最新结论相同的占几成。 */
export function contractConsistency(contract: DeliveryContract): { agree: number; total: number; label: string } {
  const recent = contract.attempts.slice(-3);
  if (!recent.length) return { agree: 0, total: 0, label: "未验收过" };
  const latest = recent[recent.length - 1].verdict;
  const agree = recent.filter((a) => a.verdict === latest).length;
  return { agree, total: recent.length, label: `${agree}/${recent.length} 一致（最新结论：${latest}）` };
}

/** 每被接受任务成本：已接受契约的最近一次 attempt 花费均值；没计价过返回 null。 */
export function costPerAcceptedTask(home: string): number | null {
  const accepted = listContracts(home).filter((c) => c.status === "accepted");
  const spent: number[] = [];
  for (const c of accepted) {
    const latest = [...c.attempts].reverse().find((a) => a.verdict === "accepted");
    if (latest && typeof latest.spentUsd === "number") spent.push(latest.spentUsd);
  }
  if (!spent.length) return null;
  return spent.reduce((a, b) => a + b, 0) / spent.length;
}

/** run 报告顶部的契约三数（RunRecorder.run 里调；无契约时全为 null）。 */
export function contractHeaderForRun(home: string, state: Record<string, unknown>): {
  passRate: string | null;
  costPerAccepted: string | null;
  consistency: string | null;
} {
  const empty = { passRate: null, costPerAccepted: null, consistency: null };
  const contractId = state.contract_id;
  if (typeof contractId !== "string" || !contractId) return empty;
  const passed = typeof state.contract_passed === "number" ? state.contract_passed : null;
  const total = typeof state.contract_total === "number" ? state.contract_total : null;
  const contract = getContract(home, contractId);
  const cost = costPerAcceptedTask(home);
  return {
    passRate: passed !== null && total !== null ? `${passed}/${total}` : null,
    costPerAccepted: cost === null ? null : `$${cost.toFixed(4)}`,
    consistency: contract ? contractConsistency(contract).label : null,
  };
}

// ---- 呈现 ----

export function formatContractReport(contract: DeliveryContract, attempt: ContractAttempt): string {
  const mark = (s: ContractItemStatus): string =>
    s === "pass" ? "✓" : s === "fail" ? "✗" : s === "flaky" ? "~" : s === "pending" ? "?" : "–";
  const verdictWord = attempt.verdict === "accepted" ? "已接受" : attempt.verdict === "rejected" ? "未接受" : "待定（等人工看）";
  const lines = [
    `交付契约 ${contract.id}：${contract.task}`,
    `状态：${contract.status}（哈希 ${contract.contractHash.slice(0, 12)}…）`,
    `检查 ${attempt.passed}/${attempt.total} 通过，结论：${verdictWord}`,
    ...attempt.items.map((i) => `  ${mark(i.status)} [${i.kind}] ${i.label} —— ${i.detail}${i.evidence ? `（证据：${trunc(i.evidence, 80)}）` : ""}`),
  ];
  if (attempt.flaky) lines.push(`不稳定项 ${attempt.flaky} 个：复跑结果不一致，先不算通过`);
  if (attempt.skipped) lines.push(`未评分 ${attempt.skipped} 项：模型项无验收模型或返回无法解析`);
  if (attempt.pending) lines.push(`待人工 ${attempt.pending} 项：nyra contract mark-item 先标记再验收`);
  lines.push(`三次复核一致性：${contractConsistency(contract).label}`);
  return lines.join("\n");
}

export function formatContractStats(home: string): string {
  const contracts = listContracts(home);
  const byStatus = (s: ContractStatus): number => contracts.filter((c) => c.status === s).length;
  const cost = costPerAcceptedTask(home);
  const lines = [
    `交付契约共 ${contracts.length} 份：草稿 ${byStatus("draft")}、进行中 ${byStatus("active")}、已接受 ${byStatus("accepted")}、未接受 ${byStatus("rejected")}`,
    `每被接受任务成本：${cost === null ? "未计价" : `$${cost.toFixed(4)}`}`,
  ];
  for (const c of contracts) {
    const latest = c.attempts[c.attempts.length - 1];
    lines.push(`  ${c.id} [${c.status}] ${c.task.slice(0, 60)}${latest ? ` 最近验收 ${latest.passed}/${latest.total}（${latest.verdict}），一致性 ${contractConsistency(c).label}` : " 未验收过"}`);
  }
  return lines.join("\n");
}

// ---- 子命令：contract（缺口 29：交付契约） ----

const USAGE = "用法：nyra contract <create|list|show|activate|attach|verify|mark-item|remove|stats> [选项]\n"
  + "  create --task \"<任务>\" --deliverable \"<id>:<描述>\" [--deliverable ...] [--attr \"<交付物 id>:<名>=<值>\"] --check \"<kind>:<checker>[:<标签>]\" [--check ...]\n"
  + "    kind 是 deterministic（第二段是 checker id）| model | manual（第二段是检查 id）；第三段是标签，可省\n"
  + "  list [--json]  列出契约\n"
  + "  show <契约 id>  看契约全文与最近一次验收\n"
  + "  activate <契约 id> --yes  人工确认验收标准，草稿转进行中\n"
  + "  attach <契约 id> --run <运行 ID>  把契约挂到一次运行上\n"
  + "  verify <契约 id> [--run <运行 ID>] [--repeat N] [--output-file <路径>]  逐项打分\n"
  + "  mark-item <契约 id> <检查 id> --pass|--fail [--evidence \"<出处>\"]  人工项人工标记\n"
  + "  remove <契约 id> --yes  删除契约\n"
  + "  stats [--json]  契约统计：通过率、每被接受任务成本、一致性\n";

function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`${flag}=`)) out.push(argv[i].slice(flag.length + 1));
  }
  return out;
}

function flagValue(argv: string[], flag: string): string | null {
  const values = flagValues(argv, flag);
  return values.length ? values[values.length - 1] : null;
}

function parseCheckFlag(raw: string): ContractCheck {
  const first = raw.indexOf(":");
  if (first < 0) throw new ContractError(`--check 格式不对：${raw}（应为 <kind>:<checker 或 id>[:<标签>]）`);
  const kind = raw.slice(0, first);
  if (kind !== "deterministic" && kind !== "model" && kind !== "manual") {
    throw new ContractError(`--check 的 kind 不对：${kind}（应为 deterministic|model|manual）`);
  }
  const rest = raw.slice(first + 1);
  const second = rest.indexOf(":");
  const token = (second < 0 ? rest : rest.slice(0, second)).trim();
  const label = second < 0 ? "" : rest.slice(second + 1).trim();
  if (!token) throw new ContractError(`--check 要有 checker（确定性项）或 id（模型/人工项）：${raw}`);
  // id 就是冒号第二段：确定性项是 checker id 本身，模型/人工项是用户起的检查 id。
  if (kind === "deterministic") return { id: token, label: label || token, kind, checker: token };
  return { id: token, label: label || token, kind, checker: null };
}

function parseDeliverableFlag(raw: string): ContractDeliverable {
  const i = raw.indexOf(":");
  if (i < 0) throw new ContractError(`--deliverable 格式不对：${raw}（应为 <id>:<描述>）`);
  return { id: raw.slice(0, i).trim(), description: raw.slice(i + 1).trim(), attributes: [] };
}

function trajectoryFromRun(home: string, runId: string): string[] {
  try {
    const store = new RunStore(join(home, "runs"));
    return store.readEvents(runId)
      .filter((e) => e.type === "tool_start" && typeof (e as Record<string, unknown>).name === "string")
      .map((e) => (e as Record<string, unknown>).name as string);
  } catch {
    return [];
  }
}

export async function handleContract(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action) {
    process.stdout.write(USAGE);
    return 2;
  }
  try {
    if (action === "list") {
      const contracts = listContracts(resolvedHome);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(contracts, null, 2) + "\n");
        return 0;
      }
      if (!contracts.length) {
        process.stdout.write("没有交付契约（先 nyra contract create 立一份）。\n");
        return 0;
      }
      for (const c of contracts) {
        process.stdout.write(`${c.id} [${c.status}] ${c.task.slice(0, 80)}（检查 ${c.checks.length} 项，交付物 ${c.deliverables.length} 件）\n`);
      }
      return 0;
    }
    if (action === "create") {
      const task = flagValue(argv, "--task") ?? "";
      const deliverables = flagValues(argv, "--deliverable").map(parseDeliverableFlag);
      for (const rawAttr of flagValues(argv, "--attr")) {
        const i = rawAttr.indexOf(":");
        const eq = rawAttr.indexOf("=");
        if (i < 0 || eq < 0 || eq < i) throw new ContractError(`--attr 格式不对：${rawAttr}（应为 <交付物 id>:<名>=<值>）`);
        const d = deliverables.find((x) => x.id === rawAttr.slice(0, i).trim());
        if (!d) throw new ContractError(`--attr 指的交付物不存在：${rawAttr.slice(0, i)}`);
        d.attributes.push({ name: rawAttr.slice(i + 1, eq).trim(), value: rawAttr.slice(eq + 1).trim() });
      }
      const checks = flagValues(argv, "--check").map(parseCheckFlag);
      const contract = createContract(resolvedHome, { task, deliverables, checks });
      process.stdout.write(`契约已立：${contract.id}（草稿，哈希 ${contract.contractHash.slice(0, 12)}…）。先 nyra contract show 看一遍，再 activate --yes 确认验收标准。\n`);
      return 0;
    }
    if (action === "show") {
      const id = argv[1] ?? "";
      const contract = id ? getContract(resolvedHome, id) : null;
      if (!contract) {
        process.stderr.write(`错误：用法：nyra contract show <契约 id>\n`);
        return 2;
      }
      const lines = [
        `交付契约 ${contract.id} [${contract.status}]`,
        `任务：${contract.task}`,
        `哈希：${contract.contractHash}`,
        `交付物：`,
        ...contract.deliverables.map((d) => `  - ${d.id}：${d.description}${d.attributes.length ? `（${d.attributes.map((a) => `${a.name}=${a.value}`).join("、")}）` : ""}`),
        `检查清单：`,
        ...contract.checks.map((c) => `  - ${c.id} [${c.kind}] ${c.label}${c.checker ? `（checker：${c.checker}）` : ""}${c.manual ? `（人工：${c.manual.status}，${c.manual.evidence}）` : ""}`),
      ];
      const latest = contract.attempts[contract.attempts.length - 1];
      if (latest) lines.push("", formatContractReport(contract, latest));
      else lines.push("未验收过。");
      process.stdout.write(lines.join("\n") + "\n");
      return 0;
    }
    if (action === "activate") {
      const id = argv[1] ?? "";
      if (!id || !argv.includes("--yes")) {
        process.stderr.write("错误：用法：nyra contract activate <契约 id> --yes\n");
        return 2;
      }
      const contract = activateContract(resolvedHome, id);
      process.stdout.write(`契约 ${contract.id} 已激活，可以挂到运行上了。\n`);
      return 0;
    }
    if (action === "attach") {
      const id = argv[1] ?? "";
      const runId = flagValue(argv, "--run") ?? "";
      if (!id || !runId) {
        process.stderr.write("错误：用法：nyra contract attach <契约 id> --run <运行 ID>\n");
        return 2;
      }
      attachContractToRun(resolvedHome, runId, id);
      process.stdout.write(`契约 ${id} 已挂到运行 ${runId} 上。\n`);
      return 0;
    }
    if (action === "verify") {
      const id = argv[1] ?? "";
      if (!id) {
        process.stderr.write("错误：用法：nyra contract verify <契约 id> [--run <运行 ID>] [--repeat N] [--output-file <路径>]\n");
        return 2;
      }
      const contract = getContract(resolvedHome, id);
      if (!contract) {
        process.stderr.write(`找不到契约 ${id}\n`);
        return 1;
      }
      const runId = flagValue(argv, "--run");
      const repeatRaw = flagValue(argv, "--repeat");
      const repeat = repeatRaw ? parseInt(repeatRaw, 10) : 1;
      if (repeatRaw && (!Number.isInteger(repeat) || repeat < 1 || repeat > 5)) {
        process.stderr.write("错误：--repeat 是 1–5 的整数\n");
        return 2;
      }
      const outputFile = flagValue(argv, "--output-file");
      let outputText = "";
      if (outputFile) {
        try {
          outputText = readFileSync(outputFile, "utf-8");
        } catch {
          process.stderr.write(`读不到输出文件：${outputFile}\n`);
          return 1;
        }
      }
      let workdir: string | null = null;
      let changedFiles: string[] = [];
      let diffStat: string | null = null;
      let trajectory: string[] = [];
      let spentUsd: number | null = null;
      if (runId) {
        try {
          const store = new RunStore(join(resolvedHome, "runs"));
          const state = store.load(runId);
          workdir = state.workdir;
          changedFiles = state.changed_files ?? [];
          const hashes = state.file_hashes ?? {};
          diffStat = Object.entries(hashes).map(([f, h]) => `${f} (${String(h).slice(0, 8)})`).join("\n") || null;
          trajectory = trajectoryFromRun(resolvedHome, runId);
          const summary = state.usage_summary as Record<string, unknown> | null | undefined;
          spentUsd = typeof summary?.spent_usd === "number" ? (summary.spent_usd as number) : null;
        } catch {
          process.stderr.write(`找不到运行 ${runId}\n`);
          return 1;
        }
      } else {
        workdir = process.cwd();
      }
      const config = loadConfig(resolvedHome);
      const runner = buildVerifierRunner(config, resolvedHome);
      const { contract: updated, attempt } = await verifyContract(resolvedHome, id, {
        workdir,
        changedFiles,
        diffStat,
        title: contract.task,
        outputText,
        summary: outputText || contract.task,
        trajectory,
        spentUsd,
      }, { runId: runId ?? null, repeat, runner, spentUsd });
      process.stdout.write(formatContractReport(updated, attempt) + "\n");
      return attempt.verdict === "accepted" ? 0 : 1;
    }
    if (action === "mark-item") {
      const contractId = argv[1] ?? "";
      const checkId = argv[2] ?? "";
      const pass = argv.includes("--pass");
      const fail = argv.includes("--fail");
      if (!contractId || !checkId || pass === fail) {
        process.stderr.write("错误：用法：nyra contract mark-item <契约 id> <检查 id> --pass|--fail [--evidence \"<出处>\"]\n");
        return 2;
      }
      const evidence = flagValue(argv, "--evidence") ?? "";
      markContractItem(resolvedHome, contractId, checkId, pass, evidence);
      process.stdout.write(`检查 ${checkId} 已人工标记为${pass ? "通过" : "不通过"}。\n`);
      return 0;
    }
    if (action === "remove") {
      const id = argv[1] ?? "";
      if (!id || !argv.includes("--yes")) {
        process.stderr.write("错误：用法：nyra contract remove <契约 id> --yes\n");
        return 2;
      }
      if (!removeContract(resolvedHome, id)) {
        process.stderr.write(`找不到契约 ${id}\n`);
        return 1;
      }
      process.stdout.write(`已删除契约 ${id}。\n`);
      return 0;
    }
    if (action === "stats") {
      if (argv.includes("--json")) {
        const contracts = listContracts(resolvedHome);
        process.stdout.write(JSON.stringify({
          total: contracts.length,
          byStatus: {
            draft: contracts.filter((c) => c.status === "draft").length,
            active: contracts.filter((c) => c.status === "active").length,
            accepted: contracts.filter((c) => c.status === "accepted").length,
            rejected: contracts.filter((c) => c.status === "rejected").length,
          },
          costPerAcceptedTask: costPerAcceptedTask(resolvedHome),
        }, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(formatContractStats(resolvedHome) + "\n");
      return 0;
    }
    process.stderr.write(`错误：未知子命令 contract ${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
