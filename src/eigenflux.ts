// src/eigenflux.ts — EigenFlux 本机 CLI 包装（原生 Node 移植，与 Python 版同语义）。
//
// 对应 Python：nyra/eigenflux_adapter.py（doctor / home_for_agent）与
// nyra/eigenflux_policy.py 中与本文件有关的并发防护部分。
//
// 语义红线（与 Python 一致）：
// - 只包装本机已装的 eigenflux CLI，不重新实现它，不安装、不认证、不外发、
//   不建计划任务、不做任何联网操作。
// - doctor 默认只做本地规划（status "not_checked"），不执行 CLI；只有显式
//   check=true 时才跑仅有的两个白名单诊断：`version` 与
//   `skills path --host terminal`。
// - 入网（onboarding）须用户前台逐项确认：本模块只报告每步状态与所需确认，
//   永不自动执行入网步骤，onboarding_complete 恒为 false。
// - 每个 Nyra 运行时身份（主 Agent 或群内机器人）各用一个稳定、隔离的
//   EigenFlux Home；重建同名群不得复用旧身份（instance_id 隔离）。
//
// 与 Python 主线的已知差异（见文件末尾注释与测试）：
// - Python 主线 eigenflux_policy.py 的并发防护只有进程内 threading.RLock
//   + 乐观版本号（revision / sha256）；跨进程锁文件加固只在未合入分支
//   fix/eigenflux-policy-cross-process-lock-20261116 上（提交 4b0d85f，
//   待用户决定，未合入）。本文件的策略锁（EigenfluxPolicyLock 系函数）
//   是按该分支意图 + 本仓库已有 WorkerLock 模式（src/tasks.ts：openSync
//   "wx" 建锁文件、pid 持有者校验、死进程回收）实现的**新增**能力，
//   并补了 Python 主线没有的 TTL 过期处理；它不是对 Python 主线行为的
//   逐行翻译，接线方不要把它当成“Python 已有、Node 照抄”。
// - 本文件不移植 NetworkPolicy 账本本身（show/allow/deny/audit、revision
//   校验、128 KiB 上限、审计历史）：那是另一个移植单元的工作；策略锁只
//   保护“同一时刻只有一个写账本者”。
import {
  accessSync, chmodSync, closeSync, constants as fsConstants, existsSync,
  fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  rmSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join, resolve, sep } from "node:path";
import { resolveHome } from "./config.ts";

export class EigenFluxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EigenFluxError";
  }
}

/** 诊断子命令超时（毫秒），与 Python _TIME_LIMIT = 8 秒一致。 */
export const DIAGNOSTIC_TIMEOUT_MS = 8000;
/** 诊断输出保留上限（字符），与 Python _MAX_OUTPUT = 600 一致。 */
export const MAX_OUTPUT_CHARS = 600;
/** 策略锁默认 TTL（毫秒）：持有者超时未释放即视为过期，可被回收。 */
export const DEFAULT_POLICY_LOCK_TTL_MS = 60_000;
/** 策略锁文件名，放在策略账本 network-policy.json 同目录。 */
export const POLICY_LOCK_NAME = "network-policy.lock";
/** 策略账本文件名（本文件只用它定位锁，不读写账本本身）。 */
export const POLICY_FILE_NAME = "network-policy.json";

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const INSTANCE_PATTERN = /^[0-9a-f]{32}$/;

/** 传给 eigenflux 子进程的最小环境白名单，与 Python _minimal_environment 一致。 */
const ALLOWED_ENV_VARS = [
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "SystemRoot", "WINDIR",
  "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
] as const;

export interface AgentIdentity {
  room?: string | null;
  bot?: string | null;
}

interface GroupRecord {
  id: string;
  instanceId?: string;
  bots: string[];
}

/** 读 <root>/groups/<room>/room.json 的最小只读视图（只取身份判定所需字段）。 */
function readGroup(root: string, room: string): GroupRecord {
  const file = join(root, "groups", room, "room.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    throw new EigenFluxError(`群 ${room} 不存在`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new EigenFluxError("群数据格式无效");
  }
  if (!data || typeof data !== "object" || (data as Record<string, unknown>).id !== room) {
    throw new EigenFluxError("群数据格式无效");
  }
  const record = data as Record<string, unknown>;
  const botsRaw = Array.isArray(record.bots) ? record.bots : [];
  const bots: string[] = [];
  for (const item of botsRaw) {
    if (item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
      bots.push((item as Record<string, unknown>).id as string);
    }
  }
  const out: GroupRecord = { id: room, bots };
  if (typeof record.instance_id === "string") out.instanceId = record.instance_id;
  return out;
}

/**
 * 把路径解析为规范形式：对已存在的最近祖先 realpath，其余部分按字面拼接。
 * 与 Python Path.resolve()（非严格模式）对应：不存在的尾部不报错。
 */
function canonicalize(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = resolve(current, "..");
    if (parent === current) break;
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}

function isWithinRoot(canonicalPath: string, canonicalRoot: string): boolean {
  return canonicalPath === canonicalRoot || canonicalPath.startsWith(canonicalRoot + sep);
}

/**
 * 解析一个 Nyra 运行时身份的稳定 EigenFlux Home，不创建、不写任何文件。
 * 与 Python home_for_agent 同语义：主 Agent 为
 * <root>/eigenflux/agents/main/.eigenflux；群机器人为
 * <root>/eigenflux/agents/rooms/<room>/instances/<instance_id>/bots/<bot>/.eigenflux
 *（无 instance_id 的旧群用无 instances 段的旧路径，保持兼容）。
 * 末尾固定是 ".eigenflux"，因为 EigenFlux 会在 --homedir 不以该名结尾时自动追加。
 */
export function homeForAgent(opts: { root?: string; room?: string | null; bot?: string | null } = {}): string {
  const root = resolve(opts.root ?? resolveHome());
  const { room = null, bot = null } = opts;
  if ((room === null) !== (bot === null)) {
    throw new EigenFluxError("--room 与 --bot 必须同时提供");
  }
  let target: string;
  if (room !== null && bot !== null) {
    if (!ID_PATTERN.test(room) || !ID_PATTERN.test(bot)) {
      throw new EigenFluxError("群与机器人 ID 格式无效");
    }
    const groupRoot = join(root, "groups");
    const roomFolder = join(groupRoot, room);
    if (isSymlink(groupRoot) || isSymlink(roomFolder)) {
      throw new EigenFluxError("群目录不能是符号链接");
    }
    const group = readGroup(root, room);
    if (!group.bots.includes(bot)) {
      throw new EigenFluxError("该群中没有指定机器人");
    }
    if (group.instanceId !== undefined) {
      if (!INSTANCE_PATTERN.test(group.instanceId)) {
        throw new EigenFluxError("群实例标记无效，拒绝访问网络身份");
      }
      target = join(root, "eigenflux", "agents", "rooms", room, "instances", group.instanceId, "bots", bot, ".eigenflux");
    } else {
      target = join(root, "eigenflux", "agents", "rooms", room, "bots", bot, ".eigenflux");
    }
  } else {
    target = join(root, "eigenflux", "agents", "main", ".eigenflux");
  }
  // root 本身是用户管理的 ~/.nyra 重定位，允许是符号链接；其下每一级都必须是实体路径。
  // 只检查 root 之下的各级：root 之上是系统路径（macOS 的 /var → /private/var、
  // Windows 的 8.3 短名），那些符号链接与身份隔离无关，不能因此拒绝。
  // 注意循环用逻辑路径比较：canonicalize 会把 /var 解析成 /private/var、
  // 把 8.3 短名解析成长名，用规范化路径比较时循环永远走不到 root。
  const logicalRoot = resolve(root);
  let current = resolve(target);
  while (current !== logicalRoot && current !== resolve(current, "..")) {
    if (isSymlink(current)) {
      throw new EigenFluxError("EigenFlux Home 路径包含符号链接，拒绝共享身份");
    }
    current = resolve(current, "..");
  }
  const canonicalRoot = canonicalize(root);
  const canonicalTarget = canonicalize(target);
  if (!isWithinRoot(canonicalTarget, canonicalRoot)) {
    throw new EigenFluxError("EigenFlux Home 超出 Nyra 数据目录");
  }
  // 返回逻辑路径（join(root, ...) 的形式）：调用方按传入的 root 拼路径，
  // 规范化路径（/private/var、8.3 短名解析后）与之不等，会导致身份比对失败。
  return resolve(target);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 最小子进程环境：白名单变量 + EIGENFLUX_HOME，不继承模型 Key 等身份信息。 */
export function minimalEnvironment(home: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ALLOWED_ENV_VARS) {
    if (env[name] !== undefined) out[name] = env[name] as string;
  }
  out.EIGENFLUX_HOME = home;
  return out;
}

/** 在 PATH 里找 eigenflux（Python shutil.which 的等价实现；不执行它）。 */
export function findEigenfluxCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const pathVar = env.PATH ?? "";
  const names = process.platform === "win32"
    ? ["eigenflux.exe", "eigenflux.cmd", "eigenflux.bat", "eigenflux"]
    : ["eigenflux"];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* 不可执行或不存在，继续找 */ }
    }
  }
  return null;
}

/** 从诊断输出首行解析版本号，如 "EigenFlux v1.0.2" -> "1.0.2"；无版本号返回 null。 */
export function parseEigenfluxVersion(output: string): string | null {
  const firstLine = (output ?? "").trim().split("\n")[0] ?? "";
  const m = firstLine.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1] : null;
}

export type ProbeStatus = "ok" | "failed";

export interface ProbeResult {
  status: ProbeStatus;
  exitCode: number | null;
  /** 成功时为 stdout 首行（至多 600 字符）；失败时为空串，不回显 stderr。 */
  output: string;
  /** 仅在子进程未能启动/超时时出现：超时为 "TimeoutExpired"，其余为系统错误码。 */
  reason?: string;
  /** 仅 version 探针：从 output 解析出的版本号（无则 null）。Node 侧附加字段。 */
  version?: string | null;
}

export type RunProbeFn = (binary: string, home: string, args: string[]) => ProbeResult;

/** 默认探针：spawnSync 直调官方 CLI（shell=false、8 秒超时、最小环境）。 */
export function defaultRunProbe(binary: string, home: string, args: string[]): ProbeResult {
  // Windows 上 .cmd/.bat shim 不能直接 CreateProcess，须经 cmd.exe /d /c 调用；
  // 原生 .exe 不受影响。EigenFlux 若以 npm/pip shim 形式安装，同样走这条路。
  const isWinCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
  const file = isWinCmd ? "cmd.exe" : binary;
  const argv = isWinCmd ? ["/d", "/c", binary, "--homedir", home, ...args] : ["--homedir", home, ...args];
  let result;
  try {
    result = spawnSync(file, argv, {
      shell: false, encoding: "utf-8", timeout: DIAGNOSTIC_TIMEOUT_MS,
      env: minimalEnvironment(home),
    });
  } catch (err) {
    return { status: "failed", exitCode: null, output: "", reason: err instanceof Error ? err.name : "Error" };
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code ?? "";
    const timedOut = code === "ETIMEDOUT" || /timed out/i.test(result.error.message);
    return { status: "failed", exitCode: null, output: "", reason: timedOut ? "TimeoutExpired" : (code || result.error.name) };
  }
  // 先切行再 trim 首行：Windows .cmd 的 echo 输出是 CRLF，整串 trim 只能去掉
  // 末尾换行，中间行的行尾 \r 会残留在首行里（"v1.2.3\r"）。
  const firstLine = (((result.stdout as string | null) ?? "").split("\n")[0] ?? "").trim();
  const probe: ProbeResult = {
    status: result.status === 0 ? "ok" : "failed",
    exitCode: result.status,
    output: result.status === 0 && firstLine ? firstLine.slice(0, MAX_OUTPUT_CHARS) : "",
  };
  if (args[0] === "version") probe.version = parseEigenfluxVersion(firstLine);
  return probe;
}

export type DoctorStatus = "not_checked" | "cli_not_installed" | "local_cli_verified" | "incomplete";

export interface DoctorReport {
  adapter: "eigenflux-bare-cli";
  identity: string;
  home: string;
  home_exists: boolean;
  skill_host: "terminal";
  installer_mode: "skip-agent-setup";
  network_actions_allowed: false;
  broadcast_enabled: false;
  onboarding_complete: false;
  scheduled_checks_enabled: false;
  requires_human_onboarding: true;
  checked: boolean;
  status: DoctorStatus;
  next_step: string;
  diagnostics?: { version: ProbeResult; skills: ProbeResult };
}

export interface DoctorDeps {
  findCli?: (env?: NodeJS.ProcessEnv) => string | null;
  runProbe?: RunProbeFn;
}

/**
 * 本地准备情况诊断，不授予任何 EigenFlux 网络操作。
 * 默认（check=false）不碰 CLI、不创建身份目录，只做本地规划；
 * check=true 时只跑两个白名单诊断：version 与 skills path --host terminal。
 */
export function doctor(
  opts: { root?: string; room?: string | null; bot?: string | null; check?: boolean } = {},
  deps: DoctorDeps = {},
): DoctorReport {
  const home = homeForAgent({ root: opts.root, room: opts.room, bot: opts.bot });
  const identity = opts.room == null ? "main" : `room:${opts.room}/bot:${opts.bot}`;
  const report: DoctorReport = {
    adapter: "eigenflux-bare-cli",
    identity,
    home,
    home_exists: existsSync(home) && statSync(home).isDirectory(),
    skill_host: "terminal",
    installer_mode: "skip-agent-setup",
    network_actions_allowed: false,
    broadcast_enabled: false,
    onboarding_complete: false,
    scheduled_checks_enabled: false,
    requires_human_onboarding: true,
    checked: false,
    status: "not_checked",
    next_step: "显式指定 --check 可运行本地 CLI version 与 skills path 诊断",
  };
  if (!opts.check) return report;
  const findCli = deps.findCli ?? findEigenfluxCli;
  const runProbe = deps.runProbe ?? defaultRunProbe;
  report.checked = true;
  const binary = findCli();
  if (!binary) {
    report.status = "cli_not_installed";
    report.next_step = "仅当用户明确要求安装时，按照官方 install.md 运行 bare-CLI 安装器；不要改动其他 Agent 宿主";
    return report;
  }
  const probes = {
    version: runProbe(binary, home, ["version"]),
    skills: runProbe(binary, home, ["skills", "path", "--host", "terminal"]),
  };
  report.diagnostics = probes;
  report.status = Object.values(probes).every((p) => p.status === "ok") ? "local_cli_verified" : "incomplete";
  report.next_step = report.status === "local_cli_verified"
    ? "核对身份是否已有认证；新账户须由用户前台同意 ef-onboarding 权限与资料"
    : "检查官方 CLI、已安装 ef-* Skills 和所选 Home；不得报连接成功";
  return report;
}

/** 与 Python main() 的退出码口径一致：未检查 / 本地验证通过为 0，其余为 1。 */
export function doctorExitCode(status: DoctorStatus): number {
  return status === "not_checked" || status === "local_cli_verified" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 入网步骤清单：只报告状态与所需确认，永不自动执行入网。
// 任何一步都不能由本模块代用户确认；onboardingComplete 恒为 false。
// ---------------------------------------------------------------------------

export type OnboardingStepStatus = "ready" | "missing" | "blocked" | "not_checked" | "awaiting_confirmation";

export interface OnboardingStep {
  id: string;
  title: string;
  status: OnboardingStepStatus;
  /** 该步是否必须由用户在前台逐项确认（本模块永远不会代为确认）。 */
  requiresHumanConfirmation: boolean;
  detail: string;
  /** 需要用户确认的具体内容；不需确认的步骤为空串。 */
  confirmationRequired: string;
}

export interface OnboardingReport {
  identity: string;
  home: string;
  homeExists: boolean;
  /** 只要还有未确认的步骤或缺失/失败的检查，就为 true；本模块不执行入网，故恒为 true。 */
  blocked: true;
  requiresHumanOnboarding: true;
  networkActionsAllowed: false;
  onboardingComplete: false;
  steps: OnboardingStep[];
  note: string;
}

/**
 * 入网步骤清单。默认只做本地判断（不执行 CLI）；check=true 时复用 doctor()
 * 的两个白名单诊断来填充 CLI 与 Skills 两步的状态。返回的每一步都只说明
 * “当前是什么状态、还缺用户哪项前台确认”，不执行任何入网动作。
 */
export function onboardingSteps(
  opts: { root?: string; room?: string | null; bot?: string | null; check?: boolean } = {},
  deps: DoctorDeps = {},
): OnboardingReport {
  const home = homeForAgent({ root: opts.root, room: opts.room, bot: opts.bot });
  const identity = opts.room == null ? "main" : `room:${opts.room}/bot:${opts.bot}`;
  const homeExists = existsSync(home) && statSync(home).isDirectory();
  const binary = (deps.findCli ?? findEigenfluxCli)();
  let skillsStatus: OnboardingStepStatus = "not_checked";
  let version: string | null = null;
  if (opts.check) {
    const report = doctor(opts, deps);
    if (report.status === "cli_not_installed") {
      skillsStatus = "blocked";
    } else if (report.diagnostics) {
      skillsStatus = report.diagnostics.skills.status === "ok" ? "ready" : "blocked";
      version = report.diagnostics.version.version ?? null;
    }
  }
  const steps: OnboardingStep[] = [
    {
      id: "cli_installed",
      title: "本机 EigenFlux CLI 已安装",
      status: binary ? "ready" : "missing",
      requiresHumanConfirmation: false,
      detail: binary
        ? `已找到 eigenflux：${binary}${version ? `（版本 ${version}）` : ""}`
        : "未在 PATH 中找到 eigenflux；仅当用户明确要求安装时，按照官方 install.md 运行 bare-CLI 安装器；不要改动其他 Agent 宿主",
      confirmationRequired: "",
    },
    {
      id: "identity_home",
      title: "身份隔离的 EigenFlux Home 已确定",
      status: homeExists ? "ready" : "awaiting_confirmation",
      requiresHumanConfirmation: false,
      detail: `稳定 Home：${home}（不创建、不写文件；每个身份独立，重建同名群不复用旧身份）`,
      confirmationRequired: "",
    },
    {
      id: "ef_onboarding_permission",
      title: "用户前台同意 ef-onboarding 权限与资料",
      status: "awaiting_confirmation",
      requiresHumanConfirmation: true,
      detail: "新账户须由用户前台同意 ef-onboarding 权限与资料；未获该同意前不得进行任何入网操作",
      confirmationRequired: "用户在前台逐项确认 ef-onboarding 权限与资料",
    },
    {
      id: "identity_credentials",
      title: "核对身份是否已有认证",
      status: "awaiting_confirmation",
      requiresHumanConfirmation: true,
      detail: "核对所选身份是否已有认证；无认证时不自动注册、不自动登录",
      confirmationRequired: "用户在前台确认该身份的认证状态（已有认证 / 需新建账户并由用户本人完成）",
    },
    {
      id: "skills_installed",
      title: "已安装 ef-* Skills（skills path --host terminal）",
      status: skillsStatus,
      requiresHumanConfirmation: false,
      detail: opts.check
        ? (skillsStatus === "ready" ? "skills path 诊断通过" : "skills path 诊断未通过或 CLI 缺失；检查官方 CLI、已安装 ef-* Skills 和所选 Home；不得报连接成功")
        : "未检查：显式指定 check 后才运行 skills path 诊断",
      confirmationRequired: "",
    },
    {
      id: "network_capabilities",
      title: "逐项确认每项网络行为",
      status: "awaiting_confirmation",
      requiresHumanConfirmation: true,
      detail: "本地策略默认全部拒绝；本地 allow 只定义 Nyra 的额外上限，不代表 EigenFlux 官方授权；每项网络行为（feed_read、public_broadcast、direct_message、relationship_request、recurring_check、profile_prefill）都须用户逐项确认",
      confirmationRequired: "用户逐项确认允许的网络行为清单；未确认的行为保持拒绝",
    },
  ];
  return {
    identity,
    home,
    homeExists,
    blocked: true,
    requiresHumanOnboarding: true,
    networkActionsAllowed: false,
    onboardingComplete: false,
    steps,
    note: "入网须用户前台逐项确认：本清单只报告状态与所需确认，不自动执行任何入网步骤；全部步骤就绪且用户逐项确认完成前，不得进行联网操作。",
  };
}

// ---------------------------------------------------------------------------
// 策略锁：保护 network-policy.json 账本的跨进程写互斥。
// 注意：这是按未合入分支意图 + 本仓库 WorkerLock 模式新增的能力，
// Python 主线没有锁文件（只有进程内 RLock + 乐观 revision）；见文件头注释。
// 锁文件内容为 JSON：{ pid, owner, acquiredAt(ISO), acquiredAtMs, ttlMs }。
// ---------------------------------------------------------------------------

export interface PolicyLockHolder {
  pid: number;
  owner: string;
  acquiredAt: string;
  acquiredAtMs: number;
  ttlMs: number;
  lockPath: string;
}

export interface AcquireLockResult {
  acquired: boolean;
  holder: PolicyLockHolder | null;
  lockPath: string;
  /** 未取得时说明原因：held_by_other（他人持有且未过期）/ lock_holder_invalid（锁文件损坏，fail-closed）。 */
  reason?: "held_by_other" | "lock_holder_invalid";
}

export function policyLockPath(root: string): string {
  return join(resolve(root), "eigenflux", POLICY_LOCK_NAME);
}

function holderIsAlive(holder: PolicyLockHolder): boolean {
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    // EPERM：进程存在但无权发信号，视为存活（fail-closed）。
    return true;
  }
}

function holderIsExpired(holder: PolicyLockHolder, nowMs: number): boolean {
  return nowMs > holder.acquiredAtMs + holder.ttlMs;
}

/**
 * 读锁持有者：无锁文件返回 null；锁文件是符号链接、损坏或字段非法时抛
 * EigenFluxError（fail-closed，不猜持有者身份）。
 */
export function readPolicyLockHolder(lockPath: string): PolicyLockHolder | null {
  if (isSymlink(lockPath)) {
    throw new EigenFluxError("策略锁不能通过符号链接读写");
  }
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new EigenFluxError(`策略锁无法读取：${err instanceof Error ? err.message : String(err)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new EigenFluxError("策略锁文件损坏，拒绝读取和变更");
  }
  if (!data || typeof data !== "object") {
    throw new EigenFluxError("策略锁文件损坏，拒绝读取和变更");
  }
  const rec = data as Record<string, unknown>;
  if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0
    || typeof rec.owner !== "string" || !rec.owner
    || typeof rec.acquiredAt !== "string" || typeof rec.acquiredAtMs !== "number"
    || typeof rec.ttlMs !== "number" || rec.ttlMs <= 0) {
    throw new EigenFluxError("策略锁文件损坏，拒绝读取和变更");
  }
  return {
    pid: rec.pid, owner: rec.owner,
    acquiredAt: rec.acquiredAt, acquiredAtMs: rec.acquiredAtMs, ttlMs: rec.ttlMs,
    lockPath,
  };
}

/**
 * 加策略锁：原子创建锁文件（openSync "wx"）。已存在时校验持有者：
 * 持有进程已死或已过 TTL 则回收后重试；持有者存活且未过期则返回
 * acquired=false 并附持有者信息；锁文件损坏则 fail-closed，不回收。
 * 锁文件始终落在 <root>/eigenflux/ 内；父目录不存在时创建。
 */
export function acquirePolicyLock(
  root: string,
  opts: { owner?: string; ttlMs?: number; nowMs?: number } = {},
): AcquireLockResult {
  const lockPath = policyLockPath(root);
  const ttlMs = opts.ttlMs ?? DEFAULT_POLICY_LOCK_TTL_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const owner = opts.owner ?? `nyra:${process.pid}`;
  if (ttlMs <= 0) throw new EigenFluxError("策略锁 TTL 必须大于 0");
  mkdirSync(join(resolve(root), "eigenflux"), { recursive: true });
  if (isSymlink(lockPath)) {
    throw new EigenFluxError("策略锁不能通过符号链接读写");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        const holder: PolicyLockHolder = {
          pid: process.pid, owner,
          acquiredAt: new Date(nowMs).toISOString(), acquiredAtMs: nowMs, ttlMs,
          lockPath,
        };
        writeSync(fd, JSON.stringify(holder), null, "utf-8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (process.platform !== "win32") {
        try { chmodSync(lockPath, 0o600); } catch { /* Windows 没有 POSIX 权限位 */ }
      }
      return {
        acquired: true,
        holder: { pid: process.pid, owner, acquiredAt: new Date(nowMs).toISOString(), acquiredAtMs: nowMs, ttlMs, lockPath },
        lockPath,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw new EigenFluxError(`策略锁无法创建：${err instanceof Error ? err.message : String(err)}`);
      }
      let holder: PolicyLockHolder | null;
      try {
        holder = readPolicyLockHolder(lockPath);
      } catch {
        return { acquired: false, holder: null, lockPath, reason: "lock_holder_invalid" };
      }
      if (holder === null) continue; // 竞争中被删，重试
      if (!holderIsAlive(holder) || holderIsExpired(holder, nowMs)) {
        try { unlinkSync(lockPath); } catch { /* 他人已删，重试 */ }
        continue;
      }
      return { acquired: false, holder, lockPath, reason: "held_by_other" };
    }
  }
  return { acquired: false, holder: readPolicyLockHolder(lockPath), lockPath, reason: "held_by_other" };
}

/**
 * 解策略锁：只有锁文件持有者与调用者 pid 一致时才删除；他人持有的锁、
 * 已不存在的锁返回 false，绝不误删。
 */
export function releasePolicyLock(
  lockPath: string,
  opts: { pid?: number; owner?: string } = {},
): boolean {
  let holder: PolicyLockHolder | null;
  try {
    holder = readPolicyLockHolder(lockPath);
  } catch {
    return false;
  }
  if (holder === null) return false;
  if (holder.pid !== (opts.pid ?? process.pid)) return false;
  if (opts.owner !== undefined && holder.owner !== opts.owner) return false;
  try {
    unlinkSync(lockPath);
  } catch {
    return false;
  }
  return true;
}
