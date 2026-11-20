// src/bot/computer.ts — 缺口 42 第一批：每 Bot 一台持久电脑（持久 workspace +
// 浏览器 profile + 凭证 Vault + 隔离分级）。
//
// 每个 Bot（Soul 身份）拥有一台自己的持久电脑：自己的工作目录
// （`~/.nyra/computers/<id>/workspace`）、自己的浏览器配置目录
// （`.../profile/`，含登录态清单）、自己的 shell（落在现有 bwrap 沙箱上）。
// 电脑挂在 Soul 身份下（缺口 28 是先决）：没有 Soul 就没有电脑可挂。
// 本批不做容器后端（缺口 18 未做）：隔离靠目录 + 权限边界兜底，容器后端
// 与 gVisor 等重件放后几批；也不做真正的浏览器操作（缺口 50 的事）：
// profile 只管配置与登录态清单，打开页面、看屏幕是下一批。
//
// 三条硬口径（与报告 §6 缺口 42 的“怎么做得更好”一一对应）：
//   - 隔离分级先行：默认每 Bot 独占电脑；共享电脑只允许用户显式 opt-in
//     的受信场景（创建时记下谁接受的），共享时默认只读、写操作须经审批。
//   - 凭证 Vault：Bot 看不到密码，由应用代填；凭证只存密码箱（未解锁时
//     走 keys.json，与模型 Key 同口径），永不进日志、永不进事件与审计原文，
//     列表与状态只给掩码与来源。
//   - 成本账先算：创建时声明内存/CPU 上限与闲置休眠；已声明内存超过系统
//     内存 80% 时创建直接拒绝（超限不静默扩容）；CPU 超配只告警不拒绝
//     （CPU 份额可超分，内存不能）。
//   - 电脑即证据：电脑里做的每一步（浏览器访问、文件、shell、生命周期、
//     凭证存取）都记进活动账本 `~/.nyra/bot-computer-activity.jsonl`，
//     有运行上下文时再镜像一条运行事件（`bot_computer_*`，只记元数据）。
// 账本口径与本仓其他账本一致：原子写 0600、目录 0700、损坏先备份再抛错。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { totalmem, cpus } from "node:os";
import { soulExists, validateSoulAgentId, SOUL_AGENT_ID_RE } from "../soul.ts";
import { RunStore } from "../runs.ts";
import { runSandboxed, SandboxUnavailableError } from "../sandbox.ts";
import { getFileKey, keyStatus, openVault, removeKey, setKey } from "../keystore.ts";

export class ComputerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerError";
  }
}

/** 隔离档位：dedicated（独占，默认）/ shared（共享，须用户显式 opt-in）。 */
export type ComputerIsolation = "dedicated" | "shared";
/** 电脑状态：active（醒着）/ sleeping（休眠；文件与登录态都在，shell 与写操作停掉）。 */
export type ComputerState = "active" | "sleeping";
/** 浏览器 profile 认哪种浏览器（本批只记配置、不真正启动浏览器，启动是缺口 50 的事）。 */
export type ComputerBrowser = "chromium" | "firefox";

export const COMPUTERS_DIRNAME = "computers";
export const COMPUTER_STORE_FILE = "bot-computers.json";
export const COMPUTER_ACTIVITY_FILE = "bot-computer-activity.jsonl";
export const COMPUTER_ID_RE = /^cmp_[0-9a-f]{12}$/;
/** 凭证账号名：与 Soul agent 名同款口径（小写字母开头、字母数字/下划线/连字符、最长 32 字）。 */
export const COMPUTER_ACCOUNT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export const DEFAULT_MEMORY_MB = 1024;
export const MIN_MEMORY_MB = 256;
export const MAX_MEMORY_MB = 8192;
export const DEFAULT_CPU_PERCENT = 50;
export const MIN_CPU_PERCENT = 10;
export const MAX_CPU_PERCENT = 100;
/** 默认闲置 15 分钟后可休眠；0 = 永不自动休眠。 */
export const DEFAULT_IDLE_SLEEP_MINUTES = 15;
export const MAX_IDLE_SLEEP_MINUTES = 1440;
/** 已声明内存上限：系统总内存的 80%（超了创建直接拒绝，不静默扩容）。 */
export const MAX_MEMORY_SHARE = 0.8;
export const COMPUTER_NAME_MAX = 64;
export const COMPUTER_NOTES_MAX = 500;

export interface BotComputer {
  id: string;
  /** 挂在哪台 Soul 身份下（电脑的主人）。 */
  agent: string;
  name: string;
  state: ComputerState;
  isolation: ComputerIsolation;
  /** 共享电脑是谁显式接受的（共享时必填：opt-in 的人；独占时为 null）。 */
  sharedAcceptedBy: string | null;
  /** 相对 home 的路径（如 "computers/<id>/workspace"），绝不记绝对路径。 */
  workspace: string;
  /** 相对 home 的路径（如 "computers/<id>/profile"），绝不记绝对路径。 */
  profile: string;
  /** 内存上限 MB（创建时声明）。 */
  memoryMb: number;
  /** CPU 上限百分比（创建时声明；本批只记声明、不做 cgroup 强制执行）。 */
  cpuPercent: number;
  /** 闲置多少分钟后可休眠（0 = 永不自动休眠）。 */
  idleSleepMinutes: number;
  browser: ComputerBrowser;
  createdAt: string;
  lastActiveAt: string;
  sleepAt: string | null;
  wakeAt: string | null;
  notes: string;
}

export interface ComputerStore {
  version: 1;
  computers: BotComputer[];
}

export type ComputerActivityKind = "browser" | "file" | "shell" | "lifecycle" | "credential";

/** 电脑活动账本的一行：只记元数据——目标只记 host/相对路径/命令摘要，绝不记凭证、绝不记绝对路径、绝不记文件内容。 */
export interface ComputerActivity {
  id: string;
  computerId: string;
  at: string;
  kind: ComputerActivityKind;
  action: string;
  target: string;
  runId: string | null;
  approvedBy: string | null;
  spentUsd: number | null;
  ok: boolean;
  detail: string | null;
}

export interface ComputerProfile {
  version: 1;
  computerId: string;
  agent: string;
  browser: ComputerBrowser;
  /** 存了凭证的账号（只记名字与去处，凭证本身在密码箱/keys.json 里）。 */
  accounts: { name: string; stored: "vault" | "file" }[];
  /** 上次访问的 host（只记 host，不记完整 URL）。 */
  lastVisitedHost: string | null;
  updatedAt: string;
}

/** 访问判定：allow（直接做）/ ask（须经审批）/ deny（禁做）。 */
export type ComputerAccess = "allow" | "ask" | "deny";
export interface ComputerAccessResult {
  decision: ComputerAccess;
  reason: string;
}

export function computerStorePath(home: string): string {
  return join(home, COMPUTER_STORE_FILE);
}

export function computersDir(home: string): string {
  return join(home, COMPUTERS_DIRNAME);
}

export function computerDir(home: string, id: string): string {
  validateComputerId(id);
  return join(computersDir(home), id);
}

/** 电脑的工作目录（绝对路径；账本里只记相对路径）。 */
export function computerWorkspacePath(home: string, computer: BotComputer): string {
  return join(home, computer.workspace);
}

/** 电脑的浏览器配置目录（绝对路径；账本里只记相对路径）。 */
export function computerProfilePath(home: string, computer: BotComputer): string {
  return join(home, computer.profile);
}

export function newComputerId(): string {
  return `cmp_${randomBytes(6).toString("hex")}`;
}

export function newActivityId(): string {
  return `act_${randomBytes(6).toString("hex")}`;
}

export function validateComputerId(id: string): void {
  if (!COMPUTER_ID_RE.test(id)) {
    throw new ComputerError(`电脑 id 只认 cmp_ + 12 位十六进制，当前是 ${JSON.stringify(id)}`);
  }
}

export function validateComputerAccount(account: string): void {
  if (!COMPUTER_ACCOUNT_RE.test(account)) {
    throw new ComputerError(`凭证账号名只认小写字母开头、字母数字/下划线/连字符（最长 32 字），当前是 ${JSON.stringify(account)}`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function ensureDir0700(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
  }
}

/** 原子写 JSON（同目录 tmp 0600 + fsync + rename，与 soul.ts / regression.ts 同款）。 */
function atomicWriteJson(path: string, data: unknown): void {
  const dir = dirname(path);
  ensureDir0700(dir);
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function parseComputer(raw: unknown): BotComputer {
  if (!isRecord(raw)) throw new ComputerError("电脑记录不是对象");
  if (typeof raw.id !== "string" || !COMPUTER_ID_RE.test(raw.id)) throw new ComputerError("电脑记录的 id 格式不对");
  if (typeof raw.agent !== "string" || !SOUL_AGENT_ID_RE.test(raw.agent)) throw new ComputerError(`电脑 ${raw.id} 的 agent 格式不对`);
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new ComputerError(`电脑 ${raw.id} 的名字为空`);
  if (raw.state !== "active" && raw.state !== "sleeping") throw new ComputerError(`电脑 ${raw.id} 的状态只认 active / sleeping`);
  if (raw.isolation !== "dedicated" && raw.isolation !== "shared") throw new ComputerError(`电脑 ${raw.id} 的隔离档位只认 dedicated / shared`);
  if (raw.isolation === "shared" && (typeof raw.sharedAcceptedBy !== "string" || !raw.sharedAcceptedBy.trim())) {
    throw new ComputerError(`电脑 ${raw.id} 是共享的，必须记下是谁显式接受的（sharedAcceptedBy）`);
  }
  if (typeof raw.workspace !== "string" || !raw.workspace.startsWith(`computers/${raw.id}/workspace`)) {
    throw new ComputerError(`电脑 ${raw.id} 的 workspace 路径不对`);
  }
  if (typeof raw.profile !== "string" || !raw.profile.startsWith(`computers/${raw.id}/profile`)) {
    throw new ComputerError(`电脑 ${raw.id} 的 profile 路径不对`);
  }
  return {
    id: raw.id,
    agent: raw.agent,
    name: raw.name.trim().slice(0, COMPUTER_NAME_MAX),
    state: raw.state,
    isolation: raw.isolation,
    sharedAcceptedBy: raw.isolation === "shared" ? String(raw.sharedAcceptedBy).trim().slice(0, 64) : null,
    workspace: raw.workspace,
    profile: raw.profile,
    memoryMb: clampInt(raw.memoryMb, DEFAULT_MEMORY_MB, MIN_MEMORY_MB, MAX_MEMORY_MB),
    cpuPercent: clampInt(raw.cpuPercent, DEFAULT_CPU_PERCENT, MIN_CPU_PERCENT, MAX_CPU_PERCENT),
    idleSleepMinutes: clampInt(raw.idleSleepMinutes, DEFAULT_IDLE_SLEEP_MINUTES, 0, MAX_IDLE_SLEEP_MINUTES),
    browser: raw.browser === "firefox" ? "firefox" : "chromium",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    lastActiveAt: typeof raw.lastActiveAt === "string" ? raw.lastActiveAt : "",
    sleepAt: typeof raw.sleepAt === "string" ? raw.sleepAt : null,
    wakeAt: typeof raw.wakeAt === "string" ? raw.wakeAt : null,
    notes: typeof raw.notes === "string" ? raw.notes.slice(0, COMPUTER_NOTES_MAX) : "",
  };
}

export function loadComputerStore(home: string): ComputerStore {
  const path = computerStorePath(home);
  if (!existsSync(path)) return { version: 1, computers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new ComputerError(`电脑账本损坏，已备份到 ${backup.split("/").pop()}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.computers)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new ComputerError(`电脑账本结构不对，已备份到 ${backup.split("/").pop()}，请检查后再试`);
  }
  try {
    return { version: 1, computers: (parsed.computers as unknown[]).map(parseComputer) };
  } catch (err: unknown) {
    if (err instanceof ComputerError) {
      const backup = `${path}.corrupt-${Date.now()}`;
      try { renameSync(path, backup); } catch { /* ignore */ }
    }
    throw err;
  }
}

export function saveComputerStore(home: string, store: ComputerStore): void {
  atomicWriteJson(computerStorePath(home), store);
}

export function getComputer(home: string, id: string): BotComputer {
  validateComputerId(id);
  const found = loadComputerStore(home).computers.find((c) => c.id === id);
  if (!found) throw new ComputerError(`找不到电脑 ${id}（先 nyra bot computer list 看看有哪些电脑）`);
  return found;
}

export function listComputers(home: string, agent?: string): BotComputer[] {
  const all = loadComputerStore(home).computers;
  const filtered = agent ? all.filter((c) => c.agent === agent) : all;
  return [...filtered].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

export function computerForAgent(home: string, agent: string): BotComputer | null {
  return loadComputerStore(home).computers.find((c) => c.agent === agent) ?? null;
}

/** 资源汇总：已声明内存（全部电脑）与系统总内存、CPU 声明与核数（超配只告警）。systemMemoryMb 可注入（测试用；不传时读真实总内存）。 */
export function computerResourceSummary(home: string, systemMemoryMbOverride?: number): {
  computers: number;
  active: number;
  sleeping: number;
  declaredMemoryMb: number;
  memoryCapMb: number;
  systemMemoryMb: number;
  declaredCpuPercent: number;
  cpuCores: number;
  cpuOverSubscribed: boolean;
} {
  const computers = loadComputerStore(home).computers;
  const systemMemoryMb = Math.floor((systemMemoryMbOverride ?? totalmem() / (1024 * 1024)));
  const memoryCapMb = Math.floor(systemMemoryMb * MAX_MEMORY_SHARE);
  const declaredMemoryMb = computers.reduce((s, c) => s + c.memoryMb, 0);
  const declaredCpuPercent = computers.filter((c) => c.state === "active").reduce((s, c) => s + c.cpuPercent, 0);
  const cpuCores = Math.max(1, cpus().length);
  return {
    computers: computers.length,
    active: computers.filter((c) => c.state === "active").length,
    sleeping: computers.filter((c) => c.state === "sleeping").length,
    declaredMemoryMb,
    memoryCapMb,
    systemMemoryMb,
    declaredCpuPercent,
    cpuCores,
    cpuOverSubscribed: declaredCpuPercent > 100 * cpuCores,
  };
}

export interface CreateComputerInput {
  agent: string;
  name?: string;
  isolation?: ComputerIsolation;
  /** 共享时必填：谁显式接受了共享（opt-in 的人，记名字）；独占时忽略。 */
  sharedAcceptedBy?: string;
  memoryMb?: number;
  cpuPercent?: number;
  idleSleepMinutes?: number;
  browser?: ComputerBrowser;
  notes?: string;
}

/**
 * 创建一台电脑：每 agent 只能有一台（“每 Bot 一台电脑”）；Soul 必须已存在
 * （`nyra soul init` 先建身份）；共享必须记下谁显式接受；已声明内存超过
 * 系统总内存 80% 时直接拒绝（超限不静默扩容）。
 */
export function createComputer(home: string, input: CreateComputerInput, opts?: { systemMemoryMb?: number }): BotComputer {
  validateSoulAgentId(input.agent);
  if (!soulExists(home, input.agent)) {
    throw new ComputerError(`agent ${input.agent} 还没有 Soul 身份，先 nyra soul init ${input.agent} 建身份，电脑才能挂上去`);
  }
  const store = loadComputerStore(home);
  if (store.computers.some((c) => c.agent === input.agent)) {
    throw new ComputerError(`agent ${input.agent} 已经有一台电脑了（每 Bot 一台；先删旧的再建新的）`);
  }
  const isolation: ComputerIsolation = input.isolation === "shared" ? "shared" : "dedicated";
  const sharedAcceptedBy = isolation === "shared"
    ? (typeof input.sharedAcceptedBy === "string" && input.sharedAcceptedBy.trim()
      ? input.sharedAcceptedBy.trim().slice(0, 64)
      : null)
    : null;
  if (isolation === "shared" && !sharedAcceptedBy) {
    throw new ComputerError("共享电脑必须记下是谁显式接受的（--accepted-by <名字>）：共享只允许在用户显式 opt-in 的受信场景");
  }
  const memoryMb = clampInt(input.memoryMb, DEFAULT_MEMORY_MB, MIN_MEMORY_MB, MAX_MEMORY_MB);
  const summary = computerResourceSummary(home, opts?.systemMemoryMb);
  if (summary.declaredMemoryMb + memoryMb > summary.memoryCapMb) {
    throw new ComputerError(
      `内存声明超限：已有电脑已声明 ${summary.declaredMemoryMb} MB，加上这台 ${memoryMb} MB 就超过上限 ${summary.memoryCapMb} MB（系统总内存 ${summary.systemMemoryMb} MB 的 80%），超了不静默扩容——先删不用的电脑或调小 --memory-mb`,
    );
  }
  const now = new Date().toISOString();
  const id = newComputerId();
  const computer: BotComputer = {
    id,
    agent: input.agent,
    name: (typeof input.name === "string" && input.name.trim() ? input.name.trim() : input.agent).slice(0, COMPUTER_NAME_MAX),
    state: "active",
    isolation,
    sharedAcceptedBy,
    workspace: `computers/${id}/workspace`,
    profile: `computers/${id}/profile`,
    memoryMb,
    cpuPercent: clampInt(input.cpuPercent, DEFAULT_CPU_PERCENT, MIN_CPU_PERCENT, MAX_CPU_PERCENT),
    idleSleepMinutes: clampInt(input.idleSleepMinutes, DEFAULT_IDLE_SLEEP_MINUTES, 0, MAX_IDLE_SLEEP_MINUTES),
    browser: input.browser === "firefox" ? "firefox" : "chromium",
    createdAt: now,
    lastActiveAt: now,
    sleepAt: null,
    wakeAt: null,
    notes: typeof input.notes === "string" ? input.notes.slice(0, COMPUTER_NOTES_MAX) : "",
  };
  // 落盘顺序：先建目录（workspace + profile），再写账本——目录建失败时账本里不留幽灵电脑。
  ensureDir0700(computerWorkspacePath(home, computer));
  ensureDir0700(computerProfilePath(home, computer));
  saveComputerProfile(home, computer, {
    version: 1,
    computerId: id,
    agent: input.agent,
    browser: computer.browser,
    accounts: [],
    lastVisitedHost: null,
    updatedAt: now,
  });
  store.computers.push(computer);
  saveComputerStore(home, store);
  recordComputerActivity(home, {
    computerId: id,
    kind: "lifecycle",
    action: "computer.created",
    target: computer.name,
    ok: true,
    detail: `隔离 ${isolation}${isolation === "shared" ? `（${sharedAcceptedBy} 接受）` : ""}，内存 ${memoryMb} MB`,
  });
  return computer;
}

export function profileManifestPath(home: string, computer: BotComputer): string {
  return join(computerProfilePath(home, computer), "profile.json");
}

export function loadComputerProfile(home: string, computer: BotComputer): ComputerProfile {
  const path = profileManifestPath(home, computer);
  const fallback: ComputerProfile = {
    version: 1,
    computerId: computer.id,
    agent: computer.agent,
    browser: computer.browser,
    accounts: [],
    lastVisitedHost: null,
    updatedAt: new Date().toISOString(),
  };
  if (!existsSync(path)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (!isRecord(parsed) || parsed.version !== 1) return fallback;
    return {
      version: 1,
      computerId: computer.id,
      agent: computer.agent,
      browser: parsed.browser === "firefox" ? "firefox" : "chromium",
      accounts: Array.isArray(parsed.accounts)
        ? (parsed.accounts as unknown[]).flatMap((a): { name: string; stored: "vault" | "file" }[] => {
          if (typeof a === "string" && COMPUTER_ACCOUNT_RE.test(a)) return [{ name: a, stored: "file" }];
          if (isRecord(a) && typeof a.name === "string" && COMPUTER_ACCOUNT_RE.test(a.name)) {
            return [{ name: a.name, stored: a.stored === "vault" ? "vault" : "file" }];
          }
          return [];
        })
        : [],
      lastVisitedHost: typeof parsed.lastVisitedHost === "string" ? parsed.lastVisitedHost : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt,
    };
  } catch {
    return fallback;
  }
}

export function saveComputerProfile(home: string, computer: BotComputer, profile: ComputerProfile): void {
  atomicWriteJson(profileManifestPath(home, computer), { ...profile, updatedAt: new Date().toISOString() });
}

/** 休眠：只有醒着的电脑能休眠（文件与登录态都在，shell 与写操作停掉）。 */
export function sleepComputer(home: string, id: string, reason?: string): BotComputer {
  const store = loadComputerStore(home);
  const computer = store.computers.find((c) => c.id === id);
  if (!computer) throw new ComputerError(`找不到电脑 ${id}（先 nyra bot computer list 看看有哪些电脑）`);
  if (computer.state === "sleeping") throw new ComputerError(`电脑 ${id} 已经在休眠了`);
  computer.state = "sleeping";
  computer.sleepAt = new Date().toISOString();
  saveComputerStore(home, store);
  recordComputerActivity(home, {
    computerId: id,
    kind: "lifecycle",
    action: "computer.sleep",
    target: computer.name,
    ok: true,
    detail: reason ? reason.slice(0, 120) : null,
  });
  return computer;
}

/** 唤醒：只有休眠的电脑能唤醒。 */
export function wakeComputer(home: string, id: string): BotComputer {
  const store = loadComputerStore(home);
  const computer = store.computers.find((c) => c.id === id);
  if (!computer) throw new ComputerError(`找不到电脑 ${id}（先 nyra bot computer list 看看有哪些电脑）`);
  if (computer.state === "active") throw new ComputerError(`电脑 ${id} 已经醒着了`);
  computer.state = "active";
  computer.wakeAt = new Date().toISOString();
  computer.lastActiveAt = computer.wakeAt;
  saveComputerStore(home, store);
  recordComputerActivity(home, {
    computerId: id,
    kind: "lifecycle",
    action: "computer.wake",
    target: computer.name,
    ok: true,
    detail: null,
  });
  return computer;
}

/**
 * 删除一台电脑：删 workspace 与 profile 目录、清掉这台电脑的全部凭证条目、
 * 从账本摘掉。凭证在密码箱里且密码箱未解锁时拒绝删（免得删完账本却留着
 * 凭证孤儿）；删除不可恢复，CLI 层须经 --yes 或交互确认。
 */
export function removeComputer(home: string, id: string): { removed: BotComputer; credentialsRemoved: string[] } {
  const store = loadComputerStore(home);
  const idx = store.computers.findIndex((c) => c.id === id);
  if (idx < 0) throw new ComputerError(`找不到电脑 ${id}（先 nyra bot computer list 看看有哪些电脑）`);
  const computer = store.computers[idx];
  const profile = loadComputerProfile(home, computer);
  // 先核对凭证去处：密码箱里的条目在密码箱未解锁时删不掉，提前拒绝
  // （免得删完账本与目录却留着凭证孤儿）；keys.json 里的条目 removeKey 能直接删。
  const vaultAccounts = profile.accounts.filter((a) => a.stored === "vault");
  if (vaultAccounts.length > 0 && !openVault(home)) {
    throw new ComputerError(
      `电脑 ${id} 的账号 ${vaultAccounts.map((a) => a.name).join("、")} 的凭证在密码箱里，密码箱未解锁删不掉——先解锁密码箱（设 NYRA_VAULT_PASSWORD）再删，或先逐个删凭证`,
    );
  }
  const credentialsRemoved: string[] = [];
  for (const account of profile.accounts) {
    const entry = computerCredentialEntry(computer.id, account.name);
    if (removeKey(entry, home)) credentialsRemoved.push(account.name);
  }
  try { rmSync(computerDir(home, computer.id), { recursive: true, force: true }); } catch { /* ignore */ }
  store.computers.splice(idx, 1);
  saveComputerStore(home, store);
  recordComputerActivity(home, {
    computerId: id,
    kind: "lifecycle",
    action: "computer.removed",
    target: computer.name,
    ok: true,
    detail: credentialsRemoved.length ? `清掉凭证 ${credentialsRemoved.length} 个（${credentialsRemoved.join("、")}）` : "无凭证",
  });
  return { removed: computer, credentialsRemoved };
}

/** 闲置到点该休眠的电脑（state active、idleSleepMinutes > 0、距上次活动超过阈值）。 */
export function computersDueForSleep(home: string, nowMs: number = Date.now()): BotComputer[] {
  return loadComputerStore(home).computers.filter((c) => {
    if (c.state !== "active" || c.idleSleepMinutes <= 0) return false;
    const last = Date.parse(c.lastActiveAt);
    if (!Number.isFinite(last)) return false;
    return nowMs - last > c.idleSleepMinutes * 60 * 1000;
  });
}

/** 把到点的电脑全部休眠（手动维护命令用；休眠可逆，唤醒即恢复）。 */
export function sleepDueComputers(home: string, nowMs: number = Date.now()): BotComputer[] {
  const due = computersDueForSleep(home, nowMs);
  const slept: BotComputer[] = [];
  for (const c of due) {
    try {
      slept.push(sleepComputer(home, c.id, "闲置超时自动休眠"));
    } catch { /* 已休眠或已删的跳过 */ }
  }
  return slept;
}

/** 电脑干活了：更新 lastActiveAt（只改时间，不改其他字段）。 */
export function touchComputerActivity(home: string, id: string): void {
  const store = loadComputerStore(home);
  const computer = store.computers.find((c) => c.id === id);
  if (!computer) return;
  computer.lastActiveAt = new Date().toISOString();
  saveComputerStore(home, store);
}

/** 目标/摘要截断到 120 字：事件里不记长串（appendEvent 的 redact 会把 ≥32 字连续词串当疑似密钥掩掉）。 */
function trunc120(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s);
  return t.length > 120 ? t.slice(0, 120) : t;
}

const RUN_ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;

/** 运行事件镜像：只在运行真实存在时写（账本是源头，镜像丢了不影响审计）；运行不存在/格式不对时静默跳过。 */
function mirrorToRun(home: string, runId: string | null | undefined, type: string, fields: Record<string, unknown>): void {
  if (!runId || !RUN_ID_RE.test(runId)) return;
  if (!existsSync(join(home, "runs", runId, "state.json"))) return;
  try {
    new RunStore(join(home, "runs")).appendEvent(runId, type, fields);
  } catch { /* 镜像失败不影响账本 */ }
}

export interface RecordActivityInput {
  computerId: string;
  kind: ComputerActivityKind;
  action: string;
  target: string;
  runId?: string | null;
  approvedBy?: string | null;
  spentUsd?: number | null;
  ok?: boolean;
  detail?: string | null;
  /** 镜像到运行事件时用的事件类型与字段（不给时按 kind 推导）。 */
  runEvent?: { type: string; fields: Record<string, unknown> };
}

/**
 * 记一笔电脑活动：活动账本是源头（append-only，0600）；有运行上下文时
 * 再镜像一条运行事件（`bot_computer_*`，只记元数据）。目标只记 host/
 * 相对路径/命令摘要，绝不记凭证、绝不记绝对路径、绝不记文件内容。
 */
export function recordComputerActivity(home: string, input: RecordActivityInput): ComputerActivity {
  validateComputerId(input.computerId);
  const activity: ComputerActivity = {
    id: newActivityId(),
    computerId: input.computerId,
    at: new Date().toISOString(),
    kind: input.kind,
    action: input.action,
    target: trunc120(input.target) ?? "",
    runId: input.runId ?? null,
    approvedBy: input.approvedBy ?? null,
    spentUsd: typeof input.spentUsd === "number" && Number.isFinite(input.spentUsd) ? input.spentUsd : null,
    ok: input.ok !== false,
    detail: trunc120(input.detail),
  };
  const dir = home;
  ensureDir0700(dir);
  const path = join(dir, COMPUTER_ACTIVITY_FILE);
  const line = JSON.stringify(activity) + "\n";
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== "win32") {
    try { chmodSync(path, 0o600); } catch { /* ignore */ }
  }
  if (input.runId) {
    const event = input.runEvent ?? defaultRunEvent(activity);
    if (event) mirrorToRun(home, input.runId, event.type, event.fields);
  }
  return activity;
}

function defaultRunEvent(activity: ComputerActivity): { type: string; fields: Record<string, unknown> } | null {
  switch (activity.kind) {
    case "browser":
    case "file":
    case "shell":
      return {
        type: "bot_computer_action",
        fields: { computer_id: activity.computerId, kind: activity.kind, action: activity.action, target: activity.target, ok: activity.ok },
      };
    case "lifecycle":
      return {
        type: "bot_computer_lifecycle",
        fields: { computer_id: activity.computerId, action: activity.action, reason: activity.detail ?? "" },
      };
    case "credential":
      return {
        type: "bot_computer_credential",
        fields: { computer_id: activity.computerId, account: activity.target, op: activity.action },
      };
    default:
      return null;
  }
}

/** 读活动账本（最新 N 条在后；文件损坏的行跳过、不抛错——账本是审计副本，不是唯一事实源）。 */
export function readComputerActivity(home: string, computerId?: string, limit: number = 50): ComputerActivity[] {
  const path = join(home, COMPUTER_ACTIVITY_FILE);
  if (!existsSync(path)) return [];
  const out: ComputerActivity[] = [];
  try {
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ComputerActivity;
        if (!parsed || typeof parsed !== "object" || typeof parsed.computerId !== "string") continue;
        if (computerId && parsed.computerId !== computerId) continue;
        out.push(parsed);
      } catch { /* 坏行跳过 */ }
    }
  } catch {
    return [];
  }
  return out.slice(-Math.max(1, limit));
}

/**
 * 访问判定（纯函数，隔离分级的执行点）：
 * - 独占电脑：只有主人能碰，别人一律 deny。
 * - 共享电脑：读操作谁都能读；写操作只有主人能直接做，别人须经审批（ask）。
 * - 休眠电脑：读元数据可以，写操作 deny（先 wake）。
 * 判定本身不执行审批：ask 的调用方走已有的审批流（approvalBridge /
 * checkApproval），批了才执行、批了谁记进活动账本的 approvedBy。
 */
export function checkComputerAccess(
  home: string,
  computerId: string,
  agent: string,
  op: "read" | "write",
): ComputerAccessResult {
  const computer = getComputer(home, computerId);
  if (computer.state === "sleeping" && op === "write") {
    return { decision: "deny", reason: `电脑 ${computerId} 在休眠，写操作停了——先 nyra bot computer wake ${computerId}` };
  }
  if (agent === computer.agent) return { decision: "allow", reason: "主人" };
  if (computer.isolation === "dedicated") {
    return { decision: "deny", reason: `这台电脑是 ${computer.agent} 独占的，${agent} 不能碰` };
  }
  if (op === "read") return { decision: "allow", reason: "共享电脑：读操作默认放行" };
  return { decision: "ask", reason: `共享电脑默认只读：${agent} 的写操作须经审批（${computer.agent} 或机主批）` };
}

// ---------------------------------------------------------------------------
// 凭证 Vault（学 Dusk 的 Vault：Bot 看不到密码，由应用代填）
// ---------------------------------------------------------------------------

/** 密码箱里的条目名：`BOTCMP_<12 位大写 hex>_<账号大写>`（与 keystore 的 ENV_NAME_RE 同款口径）。 */
export function computerCredentialEntry(computerId: string, account: string): string {
  validateComputerId(computerId);
  validateComputerAccount(account);
  return `BOTCMP_${computerId.slice(4).toUpperCase()}_${account.toUpperCase()}`;
}

/**
 * 存一条凭证：密码箱已解锁 → 写密码箱，否则写 keys.json（与模型 Key 同口径，
 * 解锁后可搬进密码箱）。返回值只有掩码与去处，绝不回明文。
 */
export function storeComputerCredential(
  home: string,
  computerId: string,
  account: string,
  value: unknown,
): { masked: string; stored: "vault" | "file" } {
  const computer = getComputer(home, computerId);
  validateComputerAccount(account);
  const result = setKey(computerCredentialEntry(computerId, account), value, home);
  const profile = loadComputerProfile(home, computer);
  const idx = profile.accounts.findIndex((a) => a.name === account);
  if (idx >= 0) profile.accounts[idx].stored = result.stored;
  else profile.accounts.push({ name: account, stored: result.stored });
  saveComputerProfile(home, computer, profile);
  recordComputerActivity(home, {
    computerId,
    kind: "credential",
    action: "credential.stored",
    target: account,
    ok: true,
    detail: `已存（${result.stored === "vault" ? "密码箱" : "keys.json"}）`,
  });
  return result;
}

/** 列出这台电脑的凭证账号（只给掩码与来源，绝不给明文）。 */
export function listComputerCredentials(
  home: string,
  computerId: string,
): { account: string; source: string; masked: string }[] {
  const computer = getComputer(home, computerId);
  const profile = loadComputerProfile(home, computer);
  return profile.accounts.map((a) => {
    const status = keyStatus(computerCredentialEntry(computerId, a.name), home);
    return { account: a.name, source: status.source, masked: status.masked };
  });
}

/**
 * 取一条凭证的明文：只供应用层代填（浏览器自动填表）调用——调用方是可信
 * 的应用代码，不是模型；绝不进提示词、绝不进日志、绝不进事件与审计原文。
 * 找不到时返回 null（不抛错，调用方按“没存”处理）。
 */
export function getComputerCredential(home: string, computerId: string, account: string): string | null {
  const computer = getComputer(home, computerId);
  validateComputerAccount(account);
  const entry = computerCredentialEntry(computerId, account);
  const vault = openVault(home);
  if (vault) {
    try {
      const got = vault.get(entry);
      if (got) return got;
    } catch { /* ignore */ }
  }
  return getFileKey(entry, home);
}

/** 删一条凭证（密码箱 + keys.json 都清；profile 清单同步摘掉）。 */
export function removeComputerCredential(home: string, computerId: string, account: string): boolean {
  const computer = getComputer(home, computerId);
  validateComputerAccount(account);
  const removed = removeKey(computerCredentialEntry(computerId, account), home);
  const profile = loadComputerProfile(home, computer);
  const idx = profile.accounts.findIndex((a) => a.name === account);
  if (idx >= 0) {
    profile.accounts.splice(idx, 1);
    saveComputerProfile(home, computer, profile);
  }
  recordComputerActivity(home, {
    computerId,
    kind: "credential",
    action: "credential.removed",
    target: account,
    ok: removed,
    detail: removed ? "已删" : "本来就没存",
  });
  return removed;
}

// ---------------------------------------------------------------------------
// 浏览器访问记录（供缺口 50 的浏览器操作调用；本批不真正打开页面）
// ---------------------------------------------------------------------------

/**
 * 记录一次浏览器访问：只记 host（不记路径、query、fragment、用户名密码）。
 * 带 userinfo 的 URL 直接拒绝（凭证绝不能出现在 URL 里）；非 http/https 拒绝。
 * 本批不真正打开页面——打开页面与看屏幕是缺口 50 的事。
 */
export function recordBrowserVisit(
  home: string,
  computerId: string,
  url: string,
  opts?: { runId?: string | null; approvedBy?: string | null },
): { host: string } {
  const computer = getComputer(home, computerId);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ComputerError(`URL 格式不对：${JSON.stringify(trunc120(url) ?? "")}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ComputerError(`浏览器访问只认 http/https，当前是 ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new ComputerError("URL 里不能带用户名密码（凭证走 Vault，不走 URL）");
  }
  const host = parsed.host.toLowerCase();
  const profile = loadComputerProfile(home, computer);
  profile.lastVisitedHost = host;
  saveComputerProfile(home, computer, profile);
  touchComputerActivity(home, computerId);
  recordComputerActivity(home, {
    computerId,
    kind: "browser",
    action: "browser.open",
    target: host,
    runId: opts?.runId ?? null,
    approvedBy: opts?.approvedBy ?? null,
    ok: true,
    detail: null,
  });
  return { host };
}

// ---------------------------------------------------------------------------
// 电脑里的 shell（落在现有 bwrap 沙箱上，工作目录就是这台电脑的 workspace）
// ---------------------------------------------------------------------------

export interface RunComputerShellOptions {
  /** 以哪个 agent 的名义跑（须过 checkComputerAccess；CLI 上是电脑主人直接执行）。 */
  agent: string;
  runId?: string | null;
  timeout?: number;
  allowNet?: boolean;
}

/**
 * 在电脑的 workspace 里跑一条命令（bwrap 沙箱，workspace-write 档位）。
 * bwrap 不可用时直接抛错（fail-closed，绝不裸奔）；休眠的电脑先 wake；
 * 非主人在共享电脑上写操作须先过审批（这里只判定、不代批）。
 */
export async function runComputerShell(
  home: string,
  computerId: string,
  command: string,
  opts: RunComputerShellOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const computer = getComputer(home, computerId);
  const access = checkComputerAccess(home, computerId, opts.agent, "write");
  if (access.decision === "deny") throw new ComputerError(access.reason);
  if (access.decision === "ask") {
    throw new ComputerError(`${access.reason}——先由 ${computer.agent} 或机主在 Bot 里发起审批，批了再跑`);
  }
  if (!command.trim()) throw new ComputerError("命令不能为空");
  const workdir = computerWorkspacePath(home, computer);
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await runSandboxed(command, {
      workdir,
      allowNet: opts.allowNet ?? false,
      mode: "workspace-write",
      timeout: opts.timeout ?? 60,
    });
  } catch (err) {
    if (err instanceof SandboxUnavailableError) throw new ComputerError(`电脑的 shell 需要 bwrap 沙箱：${err.message}`);
    throw err;
  }
  touchComputerActivity(home, computerId);
  recordComputerActivity(home, {
    computerId,
    kind: "shell",
    action: "shell.run",
    target: command.trim(),
    runId: opts.runId ?? null,
    ok: result.code === 0,
    detail: result.code === 0 ? "退出码 0" : `退出码 ${result.code}`,
  });
  return result;
}

// ---------------------------------------------------------------------------
// CLI：`nyra bot computer ...`（与 `nyra bot redlines` 同款：handler 放在
// 模块里，handleBot 只做分发；secret/confirm 可注入，测试不用 TTY）
// ---------------------------------------------------------------------------

export const COMPUTER_USAGE =
  "用法：nyra bot computer <create|list|status|sleep|wake|remove|credential|shell|sleep-due>\n" +
  "  create --agent <Soul> [--name <名>] [--memory-mb <MB>] [--cpu-percent <%>] [--idle-sleep-minutes <分>] [--browser chromium|firefox] [--shared --accepted-by <名字>] [--notes <备注>]   建一台电脑（每 agent 一台，Soul 须已存在）\n" +
  "  list [--agent <Soul>]                      列出电脑\n" +
  "  status <电脑 id>                           看一台电脑的详情（workspace、profile、凭证清单、资源上限、最近活动）\n" +
  "  sleep <电脑 id> [--reason <原因>]           休眠（文件与登录态都在，shell 与写操作停掉）\n" +
  "  wake <电脑 id>                             唤醒\n" +
  "  remove <电脑 id> [--yes]                    删除（删 workspace 与 profile 目录、清掉这台电脑的全部凭证，不可恢复）\n" +
  "  credential <电脑 id> <store|list|remove> [--account <账号>]   凭证 Vault：存（交互输入，绝不回显到日志）/ 列（只给掩码）/ 删\n" +
  "  shell <电脑 id> <命令...> [--timeout <秒>]   在电脑的 workspace 里跑一条命令（bwrap 沙箱；休眠的电脑先 wake）\n" +
  "  sleep-due                                  把闲置到点的电脑全部休眠（可逆，唤醒即恢复）";

export interface ComputerCliInput {
  /** 读一条秘密（凭证值）：测试注入；没注入时交互读 stdin（与 nyra vault add 同款口径）。 */
  secret?: (prompt: string) => Promise<string>;
  /** 确认：测试注入；没注入时交互读 stdin（y/yes 才算确认）。 */
  confirm?: (prompt: string) => Promise<boolean>;
}

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
}

function flagInt(argv: string[], name: string): number | undefined {
  const raw = flagValue(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

async function readSecret(input: ComputerCliInput | undefined, prompt: string): Promise<string> {
  if (input?.secret) return input.secret(prompt);
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolvePromise) => {
    rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
  });
  return answer;
}

async function readConfirm(input: ComputerCliInput | undefined, prompt: string): Promise<boolean> {
  if (input?.confirm) return input.confirm(prompt);
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolvePromise) => {
    rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
  });
  const v = answer.trim().toLowerCase();
  return v === "y" || v === "yes";
}

function formatComputerLine(c: BotComputer): string {
  return `${c.id}（${c.name}，agent ${c.agent}）— ${c.state === "active" ? "醒着" : "休眠"}，${c.isolation === "dedicated" ? "独占" : `共享（${c.sharedAcceptedBy} 接受）`}，内存 ${c.memoryMb} MB，CPU ${c.cpuPercent}%，闲置 ${c.idleSleepMinutes === 0 ? "永不" : `${c.idleSleepMinutes} 分钟`}休眠`;
}

export async function handleComputer(argv: string[], home: string, input?: ComputerCliInput): Promise<number> {
  const cmd = argv[0];
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(COMPUTER_USAGE + "\n");
      return 0;
    }
    if (cmd === "create") {
      const agent = flagValue(argv, "--agent");
      if (!agent) {
        process.stderr.write("建电脑要指 agent：nyra bot computer create --agent <Soul>\n");
        return 2;
      }
      const isolation = argv.includes("--shared") ? "shared" : "dedicated";
      const computer = createComputer(home, {
        agent,
        name: flagValue(argv, "--name"),
        isolation,
        sharedAcceptedBy: flagValue(argv, "--accepted-by"),
        memoryMb: flagInt(argv, "--memory-mb"),
        cpuPercent: flagInt(argv, "--cpu-percent"),
        idleSleepMinutes: flagInt(argv, "--idle-sleep-minutes"),
        browser: flagValue(argv, "--browser") === "firefox" ? "firefox" : "chromium",
        notes: flagValue(argv, "--notes"),
      });
      process.stdout.write(`电脑已创建：${formatComputerLine(computer)}\n工作目录：${computer.workspace}\n浏览器配置：${computer.profile}\n`);
      return 0;
    }
    if (cmd === "list") {
      const agent = flagValue(argv, "--agent");
      const computers = listComputers(home, agent);
      if (!computers.length) {
        process.stdout.write(agent ? `agent ${agent} 还没有电脑（nyra bot computer create --agent ${agent} 建一台）。\n` : "还没有电脑（nyra bot computer create --agent <Soul> 建一台）。\n");
        return 0;
      }
      for (const c of computers) process.stdout.write(`- ${formatComputerLine(c)}\n`);
      const summary = computerResourceSummary(home);
      process.stdout.write(`共 ${summary.computers} 台（醒着 ${summary.active}，休眠 ${summary.sleeping}），已声明内存 ${summary.declaredMemoryMb} MB / 上限 ${summary.memoryCapMb} MB。\n`);
      return 0;
    }
    if (cmd === "status") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra bot computer status <电脑 id>\n");
        return 2;
      }
      const computer = getComputer(home, id);
      const profile = loadComputerProfile(home, computer);
      const credentials = listComputerCredentials(home, id);
      const activities = readComputerActivity(home, id, 5);
      process.stdout.write(`电脑 ${computer.id}（${computer.name}）\n`);
      process.stdout.write(`agent：${computer.agent}（Soul 身份）\n`);
      process.stdout.write(`状态：${computer.state === "active" ? "醒着" : "休眠"}${computer.state === "sleeping" && computer.sleepAt ? `（自 ${computer.sleepAt}）` : ""}\n`);
      process.stdout.write(`隔离：${computer.isolation === "dedicated" ? "独占（只有主人能碰）" : `共享（${computer.sharedAcceptedBy} 接受；默认只读，写操作须经审批）`}\n`);
      process.stdout.write(`工作目录：${computer.workspace}\n`);
      process.stdout.write(`浏览器配置：${computer.profile}（${profile.browser}，上次访问 ${profile.lastVisitedHost ?? "无"}）\n`);
      process.stdout.write(`资源上限：内存 ${computer.memoryMb} MB，CPU ${computer.cpuPercent}%，闲置 ${computer.idleSleepMinutes === 0 ? "永不" : `${computer.idleSleepMinutes} 分钟`}休眠\n`);
      process.stdout.write(`创建：${computer.createdAt}，上次活动：${computer.lastActiveAt}\n`);
      if (computer.notes) process.stdout.write(`备注：${computer.notes}\n`);
      if (credentials.length) {
        process.stdout.write("凭证（只给掩码，绝不显示明文）：\n");
        for (const c of credentials) process.stdout.write(`- ${c.account}（${c.source}，${c.masked}）\n`);
      } else {
        process.stdout.write("凭证：无（nyra bot computer credential <id> store --account <账号> 存一条）。\n");
      }
      if (activities.length) {
        process.stdout.write("最近活动：\n");
        for (const a of activities) process.stdout.write(`- ${a.at} ${a.action} ${a.target}${a.ok ? "" : "（失败）"}${a.detail ? ` — ${a.detail}` : ""}\n`);
      }
      return 0;
    }
    if (cmd === "sleep") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra bot computer sleep <电脑 id> [--reason <原因>]\n");
        return 2;
      }
      const computer = sleepComputer(home, id, flagValue(argv, "--reason"));
      process.stdout.write(`电脑 ${computer.id} 已休眠（文件与登录态都在，shell 与写操作停了；nyra bot computer wake ${computer.id} 唤醒）。\n`);
      return 0;
    }
    if (cmd === "wake") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra bot computer wake <电脑 id>\n");
        return 2;
      }
      const computer = wakeComputer(home, id);
      process.stdout.write(`电脑 ${computer.id} 已唤醒。\n`);
      return 0;
    }
    if (cmd === "remove") {
      const id = argv[1];
      if (!id) {
        process.stderr.write("用法：nyra bot computer remove <电脑 id> [--yes]\n");
        return 2;
      }
      const computer = getComputer(home, id);
      const yes = argv.includes("--yes") || (await readConfirm(input, `确定删除电脑 ${computer.id}（${computer.name}）吗？workspace 与 profile 目录、这台电脑的全部凭证都会删掉，不可恢复（y/yes 确认）：`));
      if (!yes) {
        process.stdout.write("已取消，没删。\n");
        return 0;
      }
      const { credentialsRemoved } = removeComputer(home, id);
      process.stdout.write(`电脑 ${id} 已删除${credentialsRemoved.length ? `，清掉凭证 ${credentialsRemoved.length} 个（${credentialsRemoved.join("、")}）` : "（无凭证）"}。\n`);
      return 0;
    }
    if (cmd === "credential") {
      const id = argv[1];
      const op = argv[2];
      if (!id || !op || (op !== "store" && op !== "list" && op !== "remove")) {
        process.stderr.write("用法：nyra bot computer credential <电脑 id> <store|list|remove> [--account <账号>]\n");
        return 2;
      }
      if (op === "list") {
        const credentials = listComputerCredentials(home, id);
        if (!credentials.length) {
          process.stdout.write("这台电脑还没存凭证。\n");
          return 0;
        }
        for (const c of credentials) process.stdout.write(`- ${c.account}（${c.source}，${c.masked}）\n`);
        return 0;
      }
      const account = flagValue(argv, "--account");
      if (!account) {
        process.stderr.write("要指账号：--account <账号>（小写字母开头、字母数字/下划线/连字符，最长 32 字）。\n");
        return 2;
      }
      if (op === "store") {
        const value = await readSecret(input, `输入 ${account} 的凭证（输入不回显到日志，只存进密码箱/keys.json）：`);
        if (!value.trim()) {
          process.stderr.write("凭证不能为空。\n");
          return 2;
        }
        const result = storeComputerCredential(home, id, account, value);
        process.stdout.write(`凭证已存：${account}（${result.stored === "vault" ? "密码箱" : "keys.json"}，${result.masked}；Bot 看不到明文，由应用代填）。\n`);
        return 0;
      }
      // remove
      const yes = argv.includes("--yes") || (await readConfirm(input, `确定删除电脑 ${id} 的账号 ${account} 的凭证吗（y/yes 确认）：`));
      if (!yes) {
        process.stdout.write("已取消，没删。\n");
        return 0;
      }
      const removed = removeComputerCredential(home, id, account);
      process.stdout.write(removed ? `凭证已删：${account}。\n` : `账号 ${account} 本来就没存凭证。\n`);
      return 0;
    }
    if (cmd === "shell") {
      const id = argv[1];
      // 先摘掉 --timeout <秒>，剩下的才是命令（不要把超时秒数拼进命令里）。
      const timeout = flagInt(argv, "--timeout");
      const commandParts: string[] = [];
      for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--timeout") { i++; continue; }
        commandParts.push(argv[i]);
      }
      const command = commandParts.join(" ").trim();
      if (!id || !command) {
        process.stderr.write("用法：nyra bot computer shell <电脑 id> <命令...> [--timeout <秒>]\n");
        return 2;
      }
      const computer = getComputer(home, id);
      const result = await runComputerShell(home, id, command, { agent: computer.agent, timeout });
      if (result.stdout) process.stdout.write(result.stdout + (result.stdout.endsWith("\n") ? "" : "\n"));
      if (result.stderr) process.stderr.write(result.stderr + (result.stderr.endsWith("\n") ? "" : "\n"));
      if (result.code !== 0) {
        process.stderr.write(`命令退出码 ${result.code}。\n`);
        return 1;
      }
      return 0;
    }
    if (cmd === "sleep-due") {
      const slept = sleepDueComputers(home);
      if (!slept.length) {
        process.stdout.write("没有闲置到点的电脑。\n");
        return 0;
      }
      for (const c of slept) process.stdout.write(`- ${c.id}（${c.name}）已休眠。\n`);
      return 0;
    }
    process.stdout.write(COMPUTER_USAGE + "\n");
    return 2;
  } catch (err) {
    if (err instanceof ComputerError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
