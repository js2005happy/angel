// src/responsibilities.ts — 常驻责任制 + 无人值守强制只读（缺口 8）。
//
// 责任 = 目标 + 复查节奏 + 汇报条件 + 权限上限（永远只读）。
// 调度器从“到点跑一个任务”升级为“领一份持续责任、自己定复查节奏”：
// 守护进程每轮跑一次到期的责任，巡查只读、发现先记证据链再汇报、动手改
// 永远要等人来批——别家是“发现了就干”，Nyra 是“发现了先记、汇报了再干”。
//
// 无人值守强制只读是架构级硬约束，不是靠模型自觉：
//   - 责任没有模式字段：校验层就拒绝任何 `mode` 键，巡查没有“可写”的档位；
//   - 巡查任务以 `unattended: true` + `readonly` 入队（见 tasks.addTask），
//     写操作在 `checkApproval` 里直接拒绝（连权限规则 allow 都打不开，
//     见 src/tools.ts），并记 `patrol_write_blocked` 事件；
//   - 巡查中途 `Agent.setMode` 不得离开 readonly（纵深防御）。
// 与任务队列的区别：队列里的任务（事件触发、邮件入口、人工 `task add`）
// 是“排队等执行”，写操作挂起等人工审批（awaiting_approval）；巡查是
// “没人看着的自动跑”，所以根本不给写操作留审批口子——没人能批，就不写。
// 巡查跑完：结论进证据链（`patrol_report` 事件）+ 按汇报条件写收件箱；
// 没发现的巡查同样留一条报告事件（证据不缺席，只是不打扰人）。
import { randomBytes } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import type { Provider } from "./providers.ts";
import { reviewPatrolReport, type ReviewerLike } from "./reviewer.ts";
import { RunStore } from "./runs.ts";
import { addTask, appendInbox, buildProvider, nyraHome, runOne, TASKS_DIR } from "./tasks.ts";

export class ResponsibilityError extends Error {
  constructor(message: string) { super(message); this.name = "ResponsibilityError"; }
}

export type ResponsibilityReport = "on-finding" | "always";

export interface Responsibility {
  id: string;
  name: string;
  goal: string;
  every_seconds: number;
  report: ResponsibilityReport;
  enabled: boolean;
  workdir?: string | null;
  max_turns: number;
  last_check?: string | null;
  last_status?: string | null;
  last_summary?: string | null;
}

export interface ResponsibilityData { responsibilities: Responsibility[]; }

export const RESPONSIBILITIES_FILE = "responsibilities.json";
export const MAX_GOAL_CHARS = 8000;
export const MIN_CHECK_SECONDS = 60;

export function responsibilitiesPath(home?: string): string {
  return join(nyraHome(home), RESPONSIBILITIES_FILE);
}

export function validateResponsibility(raw: Record<string, unknown>): Responsibility {
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > 100) {
    throw new ResponsibilityError("责任名不能为空且不超过 100 字符");
  }
  if (typeof raw.goal !== "string" || !raw.goal.trim() || raw.goal.length > MAX_GOAL_CHARS) {
    throw new ResponsibilityError("责任目标不能为空且不超过 8000 字符");
  }
  const every = raw.every_seconds;
  if (typeof every !== "number" || !Number.isInteger(every) || every < MIN_CHECK_SECONDS) {
    throw new ResponsibilityError("--every 必须是不小于 60 的整数秒数");
  }
  const report = (raw.report as string) ?? "on-finding";
  if (report !== "on-finding" && report !== "always") {
    throw new ResponsibilityError("汇报条件只允许 on-finding（有发现才汇报）或 always（每次都汇报）");
  }
  // 缺口 8 的硬约束：责任没有模式——巡查永远只读。任何想给巡查加模式的
  // 写法都在校验层拒绝，不留“可写巡查”的口子。
  if ("mode" in raw && raw.mode !== undefined && raw.mode !== null) {
    throw new ResponsibilityError("巡查责任没有模式——巡查永远只读，写操作须有人在场审批");
  }
  if (raw.workdir !== null && raw.workdir !== undefined && typeof raw.workdir !== "string") {
    throw new ResponsibilityError("工作目录无效");
  }
  const maxTurns = (raw.max_turns as number) ?? 20;
  if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new ResponsibilityError("--max-turns 必须为正整数");
  }
  return {
    id: typeof raw.id === "string" && /^[0-9a-f]{16}$/.test(raw.id) ? raw.id : randomBytes(8).toString("hex"),
    name: raw.name.trim(),
    goal: raw.goal.trim(),
    every_seconds: every,
    report,
    enabled: raw.enabled !== false,
    workdir: (raw.workdir as string | null) ?? null,
    max_turns: maxTurns,
    last_check: (raw.last_check as string | null) ?? null,
    last_status: (raw.last_status as string | null) ?? null,
    last_summary: (raw.last_summary as string | null) ?? null,
  };
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadResponsibilities(path?: string): ResponsibilityData {
  const p = path ?? responsibilitiesPath();
  if (!existsSync(p)) return { responsibilities: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    backupCorrupt(p);
    throw new ResponsibilityError("责任文件损坏，已备份，请检查后重新添加");
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).responsibilities)) {
    backupCorrupt(p);
    throw new ResponsibilityError("责任文件格式无效，已备份");
  }
  const responsibilities: Responsibility[] = [];
  const names = new Set<string>();
  for (const item of (raw as ResponsibilityData).responsibilities) {
    try {
      const resp = validateResponsibility(item as unknown as Record<string, unknown>);
      if (names.has(resp.name)) throw new ResponsibilityError(`已存在同名责任：${resp.name}`);
      responsibilities.push(resp);
      names.add(resp.name);
    } catch (err: unknown) {
      process.stderr.write(`跳过无效责任：${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }
  }
  return { responsibilities };
}

export function saveResponsibilities(data: ResponsibilityData, path?: string): string {
  const p = path ?? responsibilitiesPath();
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = join(join(p, ".."), `.responsibilities-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, p); } catch (err) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw err; }
  return p;
}

export function listResponsibilities(home?: string): Responsibility[] {
  return [...loadResponsibilities(responsibilitiesPath(home)).responsibilities];
}

/** 网关 /api/responsibilities：只给元数据，不含责任目标（与事件触发器同口径）。 */
export function listResponsibilitiesPublic(home?: string): Array<Pick<Responsibility, "id" | "name" | "every_seconds" | "report" | "enabled" | "last_check" | "last_status">> {
  return listResponsibilities(home).map((r) => ({
        id: r.id, name: r.name, every_seconds: r.every_seconds, report: r.report,
        enabled: r.enabled, last_check: r.last_check ?? null, last_status: r.last_status ?? null,
      }));
}

export function addResponsibility(data: ResponsibilityData, raw: Record<string, unknown>): Responsibility {
  const cleaned = validateResponsibility(raw);
  if (data.responsibilities.some((r) => r.name === cleaned.name)) throw new ResponsibilityError(`已存在同名责任：${cleaned.name}`);
  data.responsibilities.push(cleaned);
  return cleaned;
}

export function removeResponsibility(data: ResponsibilityData, name: string): boolean {
  const idx = data.responsibilities.findIndex((r) => r.name === name);
  if (idx < 0) return false;
  data.responsibilities.splice(idx, 1);
  return true;
}

export function setResponsibilityEnabled(data: ResponsibilityData, name: string, enabled: boolean): boolean {
  const resp = data.responsibilities.find((r) => r.name === name);
  if (!resp) return false;
  resp.enabled = enabled;
  return true;
}

export function isResponsibilityDue(resp: Responsibility, now: Date = new Date()): boolean {
  if (resp.enabled === false) return false;
  if (!resp.last_check) return true;
  const last = new Date(resp.last_check);
  if (Number.isNaN(last.getTime())) return true;
  return (now.getTime() - last.getTime()) / 1000 >= resp.every_seconds;
}

export function dueResponsibilities(data: ResponsibilityData, now: Date = new Date()): Responsibility[] {
  return data.responsibilities.filter((r) => isResponsibilityDue(r, now));
}

/** 巡查提示词：目标 + 只读硬约束 + 结论格式（最后一行固定写法，供解析）。 */
export function buildPatrolPrompt(resp: Responsibility): string {
  return [
    `你是 Nyra 的巡查员，正在执行常驻责任「${resp.name}」。`,
    `目标：${resp.goal}`,
    `规则（硬约束，不是建议）：`,
    `1. 只读巡查：你只能读取文件、联网查询、调用只读工具；任何写入、发送、执行命令都会被系统直接拒绝，不要尝试。`,
    `2. 发现问题先记录、再汇报，不要直接动手改；需要动手改的，写进结论里等人来批。`,
    `3. 结束时用最后一行给出结论，格式固定为：「巡查结论：有发现」或「巡查结论：无发现」。`,
    `4. 有发现时，在结论前列出每条发现（一行一条，以“- ”开头），只写事实与证据，不写推测。`,
  ].join("\n");
}

const PATROL_CONCLUSION_RE = /^巡查结论：(有发现|无发现)\s*$/;

/**
* 解析巡查结论：取最后一个结论行；没有结论行时按“有发现”处理——
* 宁可多汇报一次，也不让一次没结论的巡查悄悄过去（fail-closed 向汇报）。
*/
export function parsePatrolConclusion(output: string): boolean {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = PATROL_CONCLUSION_RE.exec(lines[i].trim());
    if (m) return m[1] === "有发现";
  }
  return true;
}

export interface PatrolResult {
  name: string;
  status: string;
  summary: string;
  runId: string | null;
  hasFindings: boolean;
  reported: boolean;
}

/**
* 跑一次巡查：经任务队列落盘（run 记录 + 证据链），只读、无人值守。
* 结论进 `patrol_report` 事件；按汇报条件写收件箱（没发现的巡查不打扰人，
* 但证据链里同样留一条报告事件）。
*/
export async function runPatrol(
  resp: Responsibility,
  opts: { home: string; workdir: string; provider?: Provider; config?: Record<string, unknown> | null; reviewerRunner?: ReviewerLike | null },
): Promise<PatrolResult> {
  const home = opts.home;
  const workdir = opts.workdir;
  const config = opts.config ?? loadConfig(home);
  const provider = opts.provider ?? buildProvider(config, home)[0];
  const store = new RunStore(join(nyraHome(home), TASKS_DIR));
  const state = addTask(buildPatrolPrompt(resp), {
      workdir, mode: "readonly", unattended: true,
      maxTurns: resp.max_turns, store, config, home,
    });
  const [final, output] = await runOne(state, {
      store, provider, config, interactive: false, home, quietInbox: true,
    });
  // 只读巡查不应走到审批：如果挂起了，说明有写操作绕过了只读拒绝——
  // 大声报错，不要把它当成一次“有发现”汇报。
  if (final.status === "awaiting_approval") {
    throw new ResponsibilityError(`巡查「${resp.name}」意外挂起等审批（只读巡查不应走到审批）`);
  }
  const hasFindingsBeforeReview = parsePatrolConclusion(output);
  // 缺口 10：巡查结论先过一层独立审查再汇报（缺口 8 的巡查报告原先由模型
  // 自己写、自己判）。审查结论进 reviewer_verdict 事件；审查拦截（结论与
  // 发现不符、有发现被掩盖、审查失败）时按“有发现”处理（fail-closed 向汇报）。
  // 审查层未开启时 reviewPatrolReport 直接返回 skipped，不调模型、不记事件。
  let hasFindings = hasFindingsBeforeReview;
  const review = await reviewPatrolReport({
    config, goal: resp.goal, output, hasFindings: hasFindingsBeforeReview, home,
    ...(opts.reviewerRunner !== undefined ? { runner: opts.reviewerRunner } : {}),
  });
  if (review.source !== "skipped") {
    store.appendEvent(final.run_id, "reviewer_verdict", {
      tool: "patrol_report", decision: review.decision, reason: review.reason,
      reviewer_model: review.reviewerModel ?? "", rule: review.rule ?? "",
    });
    if (review.decision === "BLOCK") hasFindings = true;
  }
  const shouldReport = resp.report === "always" || hasFindings;
  store.appendEvent(final.run_id, "patrol_report", {
      responsibility_id: resp.id, responsibility_name: resp.name, run_id: final.run_id,
      findings: hasFindings, reported: shouldReport,
    });
  const firstLine = output.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
  const summary = (hasFindings ? "有发现" : "无发现") + (firstLine ? `：${firstLine.slice(0, 160)}` : "");
  if (shouldReport) {
    appendInbox(final.run_id, final.status, `巡查「${resp.name}」${summary}`, home);
  }
  resp.last_check = new Date().toISOString();
  resp.last_status = final.status;
  resp.last_summary = summary.slice(0, 200);
  return {
    name: resp.name, status: final.status, summary,
    runId: final.run_id, hasFindings, reported: shouldReport,
  };
}

/** 跑所有到期的责任（守护进程每轮调一次）；单个责任失败不破坏整轮。 */
export async function runDueResponsibilities(
  data: ResponsibilityData,
  opts: { home: string; workdir: string; provider?: Provider; now?: Date },
): Promise<PatrolResult[]> {
  const now = opts.now ?? new Date();
  const results: PatrolResult[] = [];
  for (const resp of dueResponsibilities(data, now)) {
    try {
      results.push(await runPatrol(resp, { home: opts.home, workdir: opts.workdir, provider: opts.provider }));
    } catch (err: unknown) {
      const msg = `失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      resp.last_check = now.toISOString();
      resp.last_status = "error";
      resp.last_summary = msg;
      results.push({ name: resp.name, status: "error", summary: msg, runId: null, hasFindings: false, reported: false });
    }
  }
  return results;
}
