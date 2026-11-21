// src/resume.ts — 缺口 30：崩溃自续与持久子 agent。
//
// Nyra 的 delegate 失败即失败：子 agent 没有自己的持久行，网关一崩，
// 中断的轮次、做到哪一步、为什么停，全丢了。本批补持久层：
//   - 注册表 ~/.nyra/subagents.json（原子写 0600，损坏先备份再抛错）：
//     每个子 agent 运行一行——状态 + 停止原因 + 心跳检查点 + 续跑次数；
//   - 启动扫荡（sweep）：活着的 worker 在跑时不动（WorkerLock 在谁手里
//     就跳过，fail-closed）；重启后 running 的行标 resume_pending、
//     停止原因 crashed；同一运行连崩 3 次仍活跃 → suspended（防毒消息
//     无限崩网关，Hermes 同款刹车）；
//   - 续跑先验状态再动手：读运行记录 + 事件 + 工作目录，验不过不续跑，
//     续跑动作本身进运行事件；auto_resume 默认关（须显式开）；
//     无人值守续跑强制只读复查（缺口 8 的硬约束）——写操作须人批。
//
// 注意：delegate 子任务目前没有独立的 RunStore 运行（只在父运行的事件里
// 记 delegate_start/end），所以注册表挂的是任务队列 / 主运行的 runId。
// delegate 调用点自动注册是下一批（须改 agent.ts 的 delegate 路径），
// 本批先立持久层 + CLI + 扫荡，任务队列的运行可直接注册续跑。
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHome } from "./config.ts";
import { RunStore, prepareResume, type RunState } from "./runs.ts";
import { WorkerLock, TASKS_DIR, WORKER_LOCK, buildProvider, runOne } from "./tasks.ts";
import { checkAutoAllowed, getAgentMode, recordDryRun, revalidateMandateForResume } from "./governance.ts";

export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

export type SubagentStatus = "running" | "resume_pending" | "suspended" | "completed" | "failed";
export type StopReason = "completed" | "crashed" | "timeout" | "approval_blocked" | "cancelled" | "unknown";

/** Hermes 的刹车：跨 3 次连续重启仍活跃的会话挂起。 */
export const MAX_RESTARTS_BEFORE_SUSPEND = 3;
/** 启动扫荡只认 120 秒内的心跳为“活着”——超过即视为已崩（Hermes 同款 120 秒）。 */
export const STALE_HEARTBEAT_MS = 120_000;

export interface SubagentRun {
  runId: string;
  agent: string;
  sessionId: string;
  workdir: string;
  mode: string;
  status: SubagentStatus;
  stopReason: StopReason;
  lastStep: string | null;
  lastHeartbeatAt: string | null;
  restarts: number;
  autoResume: boolean;
  unattended: boolean;
  /** 缺口 43：绑定的治理授权 id（可空）。续跑前按当前 Policy 重验证。 */
  mandateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentRegistry {
  version: 1;
  runs: SubagentRun[];
}

export function subagentRegistryPath(home: string): string {
  return join(home, "subagents.json");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadSubagentRegistry(home: string): SubagentRegistry {
  const path = subagentRegistryPath(home);
  if (!existsSync(path)) return { version: 1, runs: [] };
  if (lstatSync(path).isSymbolicLink()) throw new ResumeError("子 agent 注册表不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new ResumeError("子 agent 注册表损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as SubagentRegistry).version !== 1 || !Array.isArray((raw as SubagentRegistry).runs)) {
    backupCorrupt(path);
    throw new ResumeError("子 agent 注册表格式无效，已备份");
  }
  return raw as SubagentRegistry;
}

export function saveSubagentRegistry(home: string, registry: SubagentRegistry): void {
  const path = subagentRegistryPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new ResumeError("子 agent 注册表不能是符号链接");
  const tmp = join(dirname(path), `.subagents-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(registry, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

function getRun(registry: SubagentRegistry, runId: string): SubagentRun {
  const row = registry.runs.find((r) => r.runId === runId);
  if (!row) throw new ResumeError(`注册表里没有子 agent 运行 ${runId}`);
  return row;
}

/** 找运行记录：先任务队列（tasks/），再主运行（runs/）。 */
export function findRunStore(home: string, runId: string): { store: RunStore; state: RunState; dir: string } | null {
  for (const dir of [TASKS_DIR, "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      const state = store.load(runId);
      return { store, state, dir };
    } catch { /* 不在这个目录 */ }
  }
  return null;
}

export function registerSubagentRun(
  home: string,
  opts: { runId: string; agent?: string; sessionId?: string; workdir?: string; mode?: string; autoResume?: boolean; unattended?: boolean; mandateId?: string },
): SubagentRun {
  const registry = loadSubagentRegistry(home);
  const existing = registry.runs.find((r) => r.runId === opts.runId);
  if (existing) throw new ResumeError(`子 agent 运行 ${opts.runId} 已在注册表里`);
  const at = nowIso();
  const row: SubagentRun = {
    runId: opts.runId, agent: opts.agent ?? "nyra",
    sessionId: opts.sessionId ?? "", workdir: opts.workdir ?? process.cwd(),
    mode: opts.mode ?? "auto", status: "running", stopReason: "unknown",
    lastStep: null, lastHeartbeatAt: null, restarts: 0,
    autoResume: opts.autoResume ?? false, unattended: opts.unattended ?? false,
    mandateId: opts.mandateId ?? null,
    createdAt: at, updatedAt: at,
  };
  registry.runs.push(row);
  saveSubagentRegistry(home, registry);
  return row;
}

export function getSubagentRun(home: string, runId: string): SubagentRun {
  return getRun(loadSubagentRegistry(home), runId);
}

export function listSubagentRuns(home: string, filter?: { status?: SubagentStatus; agent?: string }): SubagentRun[] {
  const registry = loadSubagentRegistry(home);
  return registry.runs
    .filter((r) => (!filter?.status || r.status === filter.status) && (!filter?.agent || r.agent === filter.agent))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 心跳检查点：做到哪一步 + 什么时候。只记摘要（≤300 字），不记正文。 */
export function heartbeatSubagent(home: string, runId: string, lastStep: string): SubagentRun {
  const registry = loadSubagentRegistry(home);
  const row = getRun(registry, runId);
  if (row.status === "completed" || row.status === "failed" || row.status === "suspended") {
    throw new ResumeError(`子 agent 运行 ${runId} 已终态（${row.status}），不再接受心跳`);
  }
  row.lastStep = String(lastStep).slice(0, 300);
  row.lastHeartbeatAt = nowIso();
  row.updatedAt = nowIso();
  saveSubagentRegistry(home, registry);
  return row;
}

export interface SweepReport {
  markedPending: string[];
  suspended: string[];
  skipped: string | null;
  resumed: string[];
  /** 缺口 43：observe 模式或月度硬顶挡下的自动续跑，只记干跑、不真干。 */
  dryRuns: string[];
}

/** 启动扫荡：running 的行按心跳年龄标 resume_pending（crashed）；连崩
 * 满 3 次的挂起（suspended）。活着的 worker 持有锁时整个扫荡跳过——
 * 扫荡只在启动时跑，不跟活着的 worker 抢。auto 时只续跑 autoResume=true
 * 的行（其余留给人）；续跑本身走 resumeSubagentRun（先验状态）。 */
export async function sweepSubagents(
  home: string,
  opts?: { auto?: boolean; now?: Date },
): Promise<SweepReport> {
  const report: SweepReport = { markedPending: [], suspended: [], skipped: null, resumed: [], dryRuns: [] };
  mkdirSync(join(home, TASKS_DIR), { recursive: true });
  const lock = new WorkerLock(join(home, TASKS_DIR, WORKER_LOCK));
  if (!lock.acquire()) {
    report.skipped = "已有 worker 在运行，扫荡跳过（启动时再跑）";
    return report;
  }
  try {
    const registry = loadSubagentRegistry(home);
    const nowMs = (opts?.now ?? new Date()).getTime();
    for (const row of registry.runs) {
      if (row.status !== "running") continue;
      const lastBeat = row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).getTime() : 0;
      if (nowMs - lastBeat < STALE_HEARTBEAT_MS && row.lastHeartbeatAt) continue;
      row.stopReason = "crashed";
      row.updatedAt = nowIso();
      if (row.restarts >= MAX_RESTARTS_BEFORE_SUSPEND) {
        row.status = "suspended";
        report.suspended.push(row.runId);
      } else {
        row.status = "resume_pending";
        report.markedPending.push(row.runId);
      }
      const found = findRunStore(home, row.runId);
      if (found) {
        try { found.store.appendEvent(row.runId, "subagent_resume_pending", { run_id: row.runId, reason: "crashed" }); } catch { /* 事件写不上不破坏扫荡 */ }
      }
    }
    saveSubagentRegistry(home, registry);
    if (opts?.auto) {
      for (const runId of [...report.markedPending]) {
        const row = getRun(loadSubagentRegistry(home), runId);
        if (!row.autoResume) continue;
        // 缺口 43（DSH-2）：自动续跑先过接单模式与月度硬顶。observe 模式只记
        // 干跑、不真干；月度硬顶已触顶也不续跑，同样只记干跑。
        if (getAgentMode(home, row.agent) === "observe") {
          recordDryRun(home, {
            agent: row.agent, kind: "resume_subagent", action: "resume", target: runId,
            reason: "observe 模式：评估通过，只记干跑，不真干",
          });
          report.dryRuns.push(runId);
          continue;
        }
        const cap = checkAutoAllowed(home, row.agent);
        if (!cap.allowed) {
          recordDryRun(home, {
            agent: row.agent, kind: "resume_subagent", action: "resume", target: runId,
            reason: cap.reason,
          });
          report.dryRuns.push(runId);
          continue;
        }
        try {
          await resumeSubagentRun(home, runId, {});
          report.resumed.push(runId);
        } catch (err: unknown) {
          process.stderr.write(`自动续跑 ${runId} 失败：${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
    return report;
  } finally {
    lock.release();
  }
}

export interface PreparedResume {
  nextState: RunState;
  messages: Record<string, unknown>[];
  interruptedToolCalls: number;
  restarts: number;
  store: RunStore;
}

/** 先验状态再动手（可单独测的一半）：验四样——注册表状态、运行记录可续
 * 跑、工作目录还在、会话能读；任一不过就抛错、不动运行。无人值守续跑
 * 强制只读（mode 压成 readonly，写操作须人批，缺口 8 硬约束）。
 * suspended 的行须 --force 才续。验过后注册表标 running、restarts+1、
 * 续跑事件进运行记录；执行本身是调用方（resumeSubagentRun）的事。 */
export function prepareSubagentResume(
  home: string,
  runId: string,
  opts?: { force?: boolean },
): PreparedResume {
  const registry = loadSubagentRegistry(home);
  const row = getRun(registry, runId);
  if (row.status === "suspended" && !opts?.force) {
    throw new ResumeError(`子 agent 运行 ${runId} 已挂起（连崩 ${row.restarts} 次），续跑须加 --force 并由人确认`);
  }
  if (row.status !== "resume_pending" && row.status !== "suspended") {
    throw new ResumeError(`只能续跑 resume_pending/suspended 状态的子 agent 运行，当前为 ${row.status}`);
  }
  // 缺口 43（DSH-1）：绑了授权的运行，续跑前按当前 Policy 重验证。冲突、
  // 撤销、不存在时直接抛错、拒绝续跑；换发了新授权就更新注册表上的绑定。
  if (row.mandateId) {
    const currentMandateId = revalidateMandateForResume(home, row.mandateId);
    if (currentMandateId !== row.mandateId) row.mandateId = currentMandateId;
  }
  const found = findRunStore(home, runId);
  if (!found) throw new ResumeError(`找不到运行记录 ${runId}（任务队列与主运行里都没有），无法验状态`);
  const { store, state } = found;
  if (!["interrupted", "failed", "incomplete", "awaiting_approval", "verify_failed"].includes(state.status)) {
    throw new ResumeError(`运行 ${runId} 当前状态为 ${state.status}，不能续跑`);
  }
  const workdir = state.workdir;
  if (!existsSync(workdir)) throw new ResumeError(`原工作目录不存在：${workdir}`);
  // 先验状态：prepareResume 会修会话（补中断调用的占位结果）、校验模式与
  // 步数，验不过直接抛错；续跑本身从这里才开始。
  const mode = row.unattended ? "readonly" : undefined;
  const [nextState, messages, count] = prepareResume(store, runId, { home, mode });
  row.status = "running";
  row.restarts += 1;
  row.updatedAt = nowIso();
  saveSubagentRegistry(home, registry);
  try {
    store.appendEvent(runId, "subagent_resumed", { run_id: runId, mode: nextState.mode });
  } catch { /* 事件写不上不破坏续跑 */ }
  return { nextState, messages, interruptedToolCalls: count, restarts: row.restarts, store };
}

export interface ResumeResult {
  runId: string;
  status: string;
  output: string;
  interruptedToolCalls: number;
  restarts: number;
}

export type ResumeRunner = (
  state: RunState,
  opts: { store: RunStore; provider: unknown; home: string },
) => Promise<[RunState, string]>;

/** 续跑（执行一半）：prepareSubagentResume 验过状态后，用 runner 真跑
 * 一遍，再按终态回写注册表。runner 默认是 tasks.runOne（真执行）；测试
 * 传假 runner 只验状态机，不碰模型。 */
export async function resumeSubagentRun(
  home: string,
  runId: string,
  opts?: { force?: boolean; runner?: ResumeRunner },
): Promise<ResumeResult> {
  const prepared = prepareSubagentResume(home, runId, { force: opts?.force });
  const { nextState, interruptedToolCalls, restarts, store } = prepared;
  const runner: ResumeRunner = opts?.runner ?? (async (state, o) => {
    const [provider] = buildProvider(undefined, o.home);
    return runOne(state, { store: o.store, provider, interactive: false, home: o.home, resume: true });
  });
  const [final, output] = await runner(nextState, { store, provider: null, home });
  const registry2 = loadSubagentRegistry(home);
  const row2 = getRun(registry2, runId);
  if (final.status === "verified" || final.status === "completed_unverified") {
    row2.status = "completed";
    row2.stopReason = "completed";
  } else if (final.status === "failed") {
    row2.status = "failed";
    row2.stopReason = "unknown";
  } else if (final.status === "awaiting_approval") {
    row2.status = "resume_pending";
    row2.stopReason = "approval_blocked";
  } else if (final.status === "interrupted") {
    row2.status = "resume_pending";
    row2.stopReason = "crashed";
  } else {
    row2.status = "running";
  }
  row2.updatedAt = nowIso();
  saveSubagentRegistry(home, registry2);
  return { runId, status: final.status, output, interruptedToolCalls, restarts };
}

export function suspendSubagentRun(home: string, runId: string, reason = "人工挂起"): SubagentRun {
  const registry = loadSubagentRegistry(home);
  const row = getRun(registry, runId);
  if (row.status === "completed" || row.status === "failed") throw new ResumeError(`子 agent 运行 ${runId} 已终态（${row.status}），不能挂起`);
  row.status = "suspended";
  row.updatedAt = nowIso();
  saveSubagentRegistry(home, registry);
  const found = findRunStore(home, runId);
  if (found) {
    try { found.store.appendEvent(runId, "subagent_suspended", { run_id: runId, restarts: row.restarts }); } catch { /* ignore */ }
  }
  void reason;
  return row;
}

const USAGE =
  "用法：nyra subagent <list|show|register|heartbeat|sweep|resume|suspend> [选项]\n" +
  "  list [--status running|resume_pending|suspended|completed|failed] [--agent <名字>] [--json]\n" +
  "  show <运行 id> [--json]\n" +
  "  register <运行 id> [--agent <名字>] [--workdir <目录>] [--mode readonly|auto] [--auto-resume] [--unattended]\n" +
  "  heartbeat <运行 id> \"<做到哪一步>\"\n" +
  "  sweep [--auto]        启动扫荡：running 的行按心跳标 resume_pending/挂起；--auto 只续跑 autoResume=true 的行\n" +
  "  resume <运行 id> [--force]   先验状态再续跑；无人值守的行强制只读；挂起的行须 --force\n" +
  "  suspend <运行 id>\n";

export async function handleSubagent(argv: string[], home: string): Promise<number> {
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
      const rows = listSubagentRuns(resolvedHome, {
        status: get("--status") as SubagentStatus | undefined,
        agent: get("--agent"),
      });
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return 0;
      }
      if (!rows.length) {
        process.stdout.write("注册表里没有子 agent 运行（nyra subagent register <运行 id> 注册）。\n");
        return 0;
      }
      for (const r of rows) {
        process.stdout.write(`${r.runId} [${r.status}] ${r.agent} 续跑 ${r.restarts} 次${r.autoResume ? " auto" : ""}${r.lastStep ? ` 上一步：${r.lastStep.slice(0, 50)}` : ""}\n`);
      }
      return 0;
    }
    if (action === "show") {
      const row = getSubagentRun(resolvedHome, argv[1] ?? "");
      process.stdout.write(JSON.stringify(row, null, 2) + "\n");
      return 0;
    }
    if (action === "register") {
      const runId = argv[1] ?? "";
      if (!runId) {
        process.stderr.write("错误：用法：nyra subagent register <运行 id> [--agent <名字>] [--auto-resume] [--unattended] [--mandate <授权 id>]\n");
        return 2;
      }
      const row = registerSubagentRun(resolvedHome, {
        runId, agent: get("--agent"), workdir: get("--workdir"),
        mode: get("--mode"), autoResume: argv.includes("--auto-resume"),
        unattended: argv.includes("--unattended"), mandateId: get("--mandate") ?? undefined,
      });
      process.stdout.write(`已注册子 agent 运行 ${row.runId}（${row.status}）。\n`);
      return 0;
    }
    if (action === "heartbeat") {
      const runId = argv[1] ?? "";
      const step = argv[2] ?? "";
      if (!runId || !step) {
        process.stderr.write("错误：用法：nyra subagent heartbeat <运行 id> \"<做到哪一步>\"\n");
        return 2;
      }
      const row = heartbeatSubagent(resolvedHome, runId, step);
      process.stdout.write(`${row.runId} 心跳已记：${row.lastStep}\n`);
      return 0;
    }
    if (action === "sweep") {
      const report = await sweepSubagents(resolvedHome, { auto: argv.includes("--auto") });
      if (report.skipped) {
        process.stdout.write(`${report.skipped}\n`);
        return 0;
      }
      process.stdout.write(`扫荡完成：标 resume_pending ${report.markedPending.length} 个，挂起 ${report.suspended.length} 个，自动续跑 ${report.resumed.length} 个。\n`);
      return 0;
    }
    if (action === "resume") {
      const runId = argv[1] ?? "";
      if (!runId) {
        process.stderr.write("错误：用法：nyra subagent resume <运行 id> [--force]\n");
        return 2;
      }
      const result = await resumeSubagentRun(resolvedHome, runId, { force: argv.includes("--force") });
      process.stdout.write(`续跑完成：${runId} 状态 ${result.status}（续跑 ${result.restarts} 次，中断调用补了 ${result.interruptedToolCalls} 个占位结果）。\n${result.output}\n`);
      return result.status === "failed" || result.status === "verify_failed" ? 4 : 0;
    }
    if (action === "suspend") {
      const row = suspendSubagentRun(resolvedHome, argv[1] ?? "");
      process.stdout.write(`${row.runId} 已挂起（${row.status}）。\n`);
      return 0;
    }
    process.stderr.write(`错误：未知子命令 subagent ${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
