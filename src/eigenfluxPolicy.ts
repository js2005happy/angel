// src/eigenfluxPolicy.ts — EigenFlux 网络策略账本（原生 Node 移植，与 Python 版同语义）。
//
// 对应 Python：nyra/eigenflux_policy.py（NetworkPolicy / show / audit / change）。
//
// 语义红线（与 Python 一致）：
// - 账本只是本地上限记录，绝不激活 EigenFlux CLI、绝不等于联网授权：show()
//   的每个 capability 都返回 effective_network_permission: false、
//   network_actions_enabled: false，并附 reason 说明。
// - allow 必须用户显式 --confirm（change() 的 confirmed 参数；未确认时抛错，
//   绝不默认允许）；deny 不需要确认。
// - expectedRevision 乐观锁：不符时抛 NetworkPolicyConflict；格式无效也抛错。
// - 群重建后不得继承旧权限：instance 标记不符即视为 stale，旧 allowed 全部作废。
// - 审计历史最多 250 条，账本文件超 128 KiB 拒绝读写。
// - 写操作（change）必须持跨进程策略锁（src/eigenflux.ts 的
//   acquirePolicyLock / releasePolicyLock），拿不到锁就报错不写；锁只保护
//   账本写互斥，不代表任何网络授权。
// - 账本文件 0600、原子写（临时文件 + rename），账本目录 0700。
//
// 与 Python 主线的已知差异（接线方注意）：
// - Python 主线的并发防护只有进程内 threading.RLock + 乐观 revision；跨进程
//   锁文件是本仓库 eigenflux.ts 按未合入分支意图新增的能力。Node 版 change()
//   在 Python 的 RLock 位置上改持跨进程策略锁：同进程内仍是单线程串行，
//   跨进程则多一层互斥。锁争用时抛 NetworkPolicyError，不写账本。
// - Python _resolve_identity 里 home_for_agent 抛的是 EigenFluxAdapterError
//   （ValueError 子类）；Node 版把 homeForAgent 抛出的 EigenFluxError 原文包
//   装为 NetworkPolicyError，调用方只处理 NetworkPolicyError /
//   NetworkPolicyConflict 即可。
// - Python 的 change() 在无变化时直接返回，不写文件；Node 版同样如此，
//   但锁仍会在整个 change() 调用期间持有，返回前释放。
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, statSync,
  unlinkSync, writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { resolveHome } from "./config.ts";
import {
  acquirePolicyLock, EigenFluxError, homeForAgent, releasePolicyLock,
  type AcquireLockResult,
} from "./eigenflux.ts";

export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

export class NetworkPolicyConflict extends NetworkPolicyError {
  constructor(message: string) {
    super(message);
    this.name = "NetworkPolicyConflict";
  }
}

/** 固定能力清单，与 Python CAPABILITIES 顺序一致。 */
export const CAPABILITIES = [
  "feed_read",
  "public_broadcast",
  "direct_message",
  "relationship_request",
  "recurring_check",
  "profile_prefill",
] as const;

export type NetworkCapability = (typeof CAPABILITIES)[number];

/** 账本文件上限（字节），与 Python MAX_BYTES = 128 KiB 一致。 */
export const MAX_BYTES = 128 * 1024;
/** 最多记录的 Agent 身份数，与 Python MAX_AGENTS 一致。 */
export const MAX_AGENTS = 100;
/** 审计历史上限（条），与 Python MAX_AUDIT 一致。 */
export const MAX_AUDIT = 250;

const REVISION_PATTERN = /^(?:missing|[0-9a-f]{64})$/;
const IDENTITY_PATTERN = /^(?:main|room:[a-z][a-z0-9_-]{0,31}\/bot:[a-z][a-z0-9_-]{0,31})$/;
const TEMP_PREFIX = ".network-policy-";

export const POLICY_REASON =
  "本地许可仅定义 Nyra 的额外上限；仍需 EigenFlux 官方onboarding、实际身份凭据与行为逐项授权，当前未执行联网操作。";

/** 默认账本路径：<root>/eigenflux/network-policy.json。 */
export function defaultPolicyPath(root: string): string {
  return join(resolve(root), "eigenflux", "network-policy.json");
}

export type LocalIntent = "allowed" | "denied";

export interface CapabilityState {
  local_intent: LocalIntent;
  effective_network_permission: false;
}

export interface ShowReport {
  identity: string;
  revision: string;
  policy_version: 1;
  stale_identity_policy_ignored: boolean;
  capabilities: Record<NetworkCapability, CapabilityState>;
  official_onboarding_verified: false;
  network_actions_enabled: false;
  reason: string;
}

export interface AuditEvent {
  at: string;
  actor: "explicit_cli_user";
  operation: "allow" | "deny";
  identity: string;
  capability: NetworkCapability;
}

export interface AuditReport {
  identity: string;
  revision: string;
  events: AuditEvent[];
}

export interface ChangeReport {
  identity: string;
  capability: NetworkCapability;
  changed: boolean;
  revision: string;
  local_intent: LocalIntent;
  network_actions_enabled: false;
}

export interface ChangeOptions {
  room?: string | null;
  bot?: string | null;
  confirmed?: boolean;
  /** Python 侧参数名 expected_revision；不传则不校验 revision。 */
  expectedRevision?: string | null;
}

export interface IdentityOptions {
  room?: string | null;
  bot?: string | null;
}

interface AgentEntry {
  instance: string;
  allowed: NetworkCapability[];
}

interface PolicyRecord {
  version: 1;
  agents: Record<string, AgentEntry>;
  events: AuditEvent[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

/**
 * 把路径解析为规范形式：对已存在的最近祖先 realpath，其余部分按字面拼接。
 * 与 eigenflux.ts 的 canonicalize（Python Path.resolve() 非严格模式）一致。
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

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 与 Python _capability 一致：只接受固定能力清单里的值。 */
export function checkCapability(value: unknown): NetworkCapability {
  if (typeof value !== "string" || !(CAPABILITIES as readonly string[]).includes(value)) {
    throw new NetworkPolicyError("未知 EigenFlux 网络行为，只允许固定能力清单");
  }
  return value as NetworkCapability;
}

/** Python datetime.now(timezone.utc).isoformat(timespec="seconds")，如 2026-11-19T07:00:00+00:00。 */
function utcStamp(): string {
  return new Date().toISOString().slice(0, 19) + "+00:00";
}

/** JSON 序列化：键排序、无空格，与 Python json.dumps(sort_keys=True, separators=(",", ":")) 一致。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(record[k])).join(",") + "}";
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export class NetworkPolicy {
  readonly root: string;
  readonly path: string;

  constructor(opts: { root?: string; path?: string } = {}) {
    // Python __init__ 对 root 做 Path.resolve()；path 保持原样，相对路径由
    // _safeFile 在读写时拒绝（与 Python "策略路径必须是绝对路径"一致）。
    this.root = canonicalize(resolve(opts.root ?? resolveHome()));
    this.path = opts.path ?? defaultPolicyPath(this.root);
  }

  /** 与 Python _safe_file 一致：绝对路径、位于 root 内、无符号链接、是普通文件。 */
  private safeFile(path: string): void {
    if (!isAbsolute(path)) {
      throw new NetworkPolicyError("策略路径必须是绝对路径");
    }
    const canonicalRoot = canonicalize(this.root);
    const canonicalPath = canonicalize(path);
    if (!isWithinRoot(canonicalPath, canonicalRoot)) {
      throw new NetworkPolicyError("策略文件必须位于 Nyra 数据目录内");
    }
    let current = resolve(path);
    while (current !== canonicalRoot && current !== dirname(current)) {
      if (isSymlink(current)) {
        throw new NetworkPolicyError("网络策略不能通过符号链接读写");
      }
      current = dirname(current);
    }
    if (existsSync(path) && !statSync(path).isFile()) {
      throw new NetworkPolicyError("网络策略不是普通文件");
    }
  }

  private newRecord(): PolicyRecord {
    return { version: 1, agents: {}, events: [] };
  }

  /** 与 Python _read 一致：不存在返回空账本 + revision "missing"，否则校验并返回记录与 SHA-256。 */
  private read(): { record: PolicyRecord; revision: string } {
    this.safeFile(this.path);
    if (!existsSync(this.path)) {
      return { record: this.newRecord(), revision: "missing" };
    }
    if (statSync(this.path).size > MAX_BYTES) {
      throw new NetworkPolicyError("网络权限账本超过 128 KiB");
    }
    const raw = readFileSync(this.path);
    if (raw.length > MAX_BYTES) {
      throw new NetworkPolicyError("网络权限账本超过 128 KiB");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new NetworkPolicyError("网络权限账本损坏，拒绝读取和变更");
    }
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      throw new NetworkPolicyError("网络权限账本损坏，拒绝读取和变更");
    }
    if (!isPlainObject(record) || !hasExactKeys(record, ["version", "agents", "events"])) {
      throw new NetworkPolicyError("网络策略格式错误");
    }
    if (record.version !== 1 || !isPlainObject(record.agents)) {
      throw new NetworkPolicyError("网络策略版本或 Agent 列表无效");
    }
    if (!Array.isArray(record.events) || record.events.length > MAX_AUDIT) {
      throw new NetworkPolicyError("网络策略审计历史无效");
    }
    const agents = record.agents as Record<string, unknown>;
    if (Object.keys(agents).length > MAX_AGENTS) {
      throw new NetworkPolicyError("网络策略 Agent 数量超限");
    }
    for (const [identity, entry] of Object.entries(agents)) {
      if (!IDENTITY_PATTERN.test(identity)) {
        throw new NetworkPolicyError("策略中包含非法机器人标识");
      }
      if (!isPlainObject(entry) || !hasExactKeys(entry, ["instance", "allowed"])) {
        throw new NetworkPolicyError("策略中的授权结构无效");
      }
      if (typeof entry.instance !== "string" || entry.instance.length < 1 || entry.instance.length > 100) {
        throw new NetworkPolicyError("机器人实例标记无效");
      }
      if (!Array.isArray(entry.allowed)) {
        throw new NetworkPolicyError("策略中包含重复网络行为");
      }
      const asStrings = (entry.allowed as unknown[]).map((v) => String(v));
      if (asStrings.length !== new Set(asStrings).size) {
        throw new NetworkPolicyError("策略中包含重复网络行为");
      }
      for (const cap of entry.allowed) {
        checkCapability(cap);
      }
    }
    for (const item of record.events as unknown[]) {
      if (
        !isPlainObject(item)
        || !hasExactKeys(item, ["at", "actor", "operation", "identity", "capability"])
        || typeof item.at !== "string" || item.at.length > 50
        || item.actor !== "explicit_cli_user"
        || (item.operation !== "allow" && item.operation !== "deny")
        || typeof item.identity !== "string" || !IDENTITY_PATTERN.test(item.identity)
      ) {
        throw new NetworkPolicyError("审计记录格式无效");
      }
      checkCapability(item.capability);
    }
    return { record: record as unknown as PolicyRecord, revision: sha256Hex(raw) };
  }

  /**
   * 与 Python _persist 一致：排序键紧凑 JSON + 换行，超 128 KiB 拒绝；
   * 临时文件 + fsync + 0600 + rename 原子写，账本目录 0700。
   */
  private persist(record: PolicyRecord): string {
    const payload = Buffer.from(stableStringify(record) + "\n", "utf-8");
    if (payload.length > MAX_BYTES) {
      throw new NetworkPolicyError("网络策略写入超出 128 KiB");
    }
    this.safeFile(this.path);
    const parent = dirname(resolve(this.path));
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (parent !== canonicalize(this.root) && process.platform !== "win32") {
      try { chmodSync(parent, 0o700); } catch { /* 已是期望权限时忽略 */ }
    }
    this.safeFile(this.path);
    let temporary = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = join(parent, TEMP_PREFIX + randomBytes(8).toString("hex"));
      try {
        const fd = openSync(candidate, "wx", 0o600);
        try {
          writeSync(fd, payload);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        temporary = candidate;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      }
    }
    if (!temporary) {
      throw new NetworkPolicyError("网络策略写入失败：无法创建临时文件");
    }
    try {
      if (process.platform !== "win32") {
        try { chmodSync(temporary, 0o600); } catch { /* Windows 没有 POSIX 权限位 */ }
      }
      this.safeFile(this.path);
      renameSync(temporary, this.path);
    } finally {
      if (existsSync(temporary)) {
        try { unlinkSync(temporary); } catch { /* 已 rename 成功时不存在 */ }
      }
    }
    return sha256Hex(payload);
  }

  /**
   * 与 Python _resolve_identity 一致：先由 homeForAgent 校验身份（含群内
   * 机器人归属与符号链接防护），主身份标记为 main-v1；群身份的 instance
   * 标记取 room.json 的 instance_id，无则回退 created_at。
   * homeForAgent 的 EigenFluxError 原文包装为 NetworkPolicyError。
   */
  private resolveIdentity(opts: IdentityOptions): { identity: string; instance: string } {
    const room = opts.room ?? null;
    const bot = opts.bot ?? null;
    try {
      homeForAgent({ root: this.root, room, bot });
    } catch (err) {
      if (err instanceof EigenFluxError) {
        throw new NetworkPolicyError(err.message);
      }
      throw err;
    }
    if (room === null) {
      return { identity: "main", instance: "main-v1" };
    }
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(join(this.root, "groups", room, "room.json"), "utf-8"));
    } catch {
      throw new NetworkPolicyError("群聊缺少稳定的创建标记，不能继承旧权限");
    }
    const rec = (isPlainObject(data) ? data : {}) as Record<string, unknown>;
    const stamp = rec.instance_id !== undefined ? rec.instance_id : rec.created_at;
    if (typeof stamp !== "string" || stamp.length < 1 || stamp.length > 100) {
      throw new NetworkPolicyError("群聊缺少稳定的创建标记，不能继承旧权限");
    }
    return { identity: `room:${room}/bot:${bot}`, instance: stamp };
  }

  /** 与 Python show() 一致：本地上限快照，永不表示联网授权。 */
  show(opts: IdentityOptions = {}): ShowReport {
    const { identity, instance } = this.resolveIdentity(opts);
    const { record, revision } = this.read();
    const entry = record.agents[identity];
    const stale = entry !== undefined && entry.instance !== instance;
    const local = new Set(entry !== undefined && !stale ? entry.allowed : []);
    const capabilities = {} as Record<NetworkCapability, CapabilityState>;
    for (const cap of CAPABILITIES) {
      capabilities[cap] = {
        local_intent: local.has(cap) ? "allowed" : "denied",
        effective_network_permission: false,
      };
    }
    return {
      identity,
      revision,
      policy_version: 1,
      stale_identity_policy_ignored: stale,
      capabilities,
      official_onboarding_verified: false,
      network_actions_enabled: false,
      reason: POLICY_REASON,
    };
  }

  /** 与 Python audit() 一致：只返回该身份的事件，最新在前；limit 须为 1–100 的整数。 */
  audit(opts: IdentityOptions & { limit?: number } = {}): AuditReport {
    const { identity } = this.resolveIdentity(opts);
    const limit = opts.limit === undefined ? 30 : opts.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new NetworkPolicyError("审计查询数量必须是 1–100");
    }
    const { record, revision } = this.read();
    const events = record.events.filter((e) => e.identity === identity);
    return { identity, revision, events: events.slice(-limit).reverse() };
  }

  /**
   * 与 Python change() 一致。写操作全程持跨进程策略锁（拿不到锁抛
   * NetworkPolicyError，不写账本）；无变化时不写文件、不追加审计事件，
   * 但仍返回当前 revision。
   */
  change(operation: string, capability: unknown, opts: ChangeOptions = {}): ChangeReport {
    const cap = checkCapability(capability);
    const { identity, instance } = this.resolveIdentity(opts);
    if (operation !== "allow" && operation !== "deny") {
      throw new NetworkPolicyError("未知网络策略操作");
    }
    if (operation === "allow" && opts.confirmed !== true) {
      throw new NetworkPolicyError("设为允许必须由用户显式提供 --confirm");
    }
    const expectedRevision = opts.expectedRevision ?? null;
    if (expectedRevision !== null
      && (typeof expectedRevision !== "string" || !REVISION_PATTERN.test(expectedRevision))) {
      throw new NetworkPolicyError("策略版本格式无效");
    }

    const owner = `nyra-policy:${process.pid}`;
    let lock: AcquireLockResult;
    try {
      lock = acquirePolicyLock(this.root, { owner });
    } catch (err) {
      if (err instanceof EigenFluxError) {
        throw new NetworkPolicyError(err.message);
      }
      throw err;
    }
    if (!lock.acquired) {
      if (lock.reason === "lock_holder_invalid") {
        throw new NetworkPolicyError("策略锁文件损坏，拒绝读取和变更");
      }
      throw new NetworkPolicyError("网络策略正被其他任务修改，请稍后重试");
    }
    try {
      const { record, revision } = this.read();
      if (expectedRevision !== null && expectedRevision !== revision) {
        throw new NetworkPolicyConflict("策略已被其他任务修改，请重新查看后操作");
      }
      const storedEntry = record.agents[identity];
      // 重建过的群不得继承旧权限：instance 不符即视为 stale，旧 allowed 作废。
      const stale = storedEntry !== undefined && storedEntry.instance !== instance;
      const entry: AgentEntry = storedEntry !== undefined && !stale
        ? storedEntry
        : { instance, allowed: [] };
      const allowed = new Set(entry.allowed);
      const wasAllowed = allowed.has(cap);
      if (operation === "allow") {
        allowed.add(cap);
      } else {
        allowed.delete(cap);
      }
      const changed = allowed.has(cap) !== wasAllowed || (stale && operation === "deny");
      if (!changed) {
        return {
          identity,
          capability: cap,
          changed: false,
          revision,
          local_intent: wasAllowed ? "allowed" : "denied",
          network_actions_enabled: false,
        };
      }
      if (!(identity in record.agents) && Object.keys(record.agents).length >= MAX_AGENTS) {
        throw new NetworkPolicyError("最多允许 100 个机器人策略记录");
      }
      if (allowed.size > 0) {
        record.agents[identity] = { instance, allowed: [...allowed].sort() };
      } else {
        delete record.agents[identity];
      }
      record.events.push({
        at: utcStamp(),
        actor: "explicit_cli_user",
        operation,
        identity,
        capability: cap,
      });
      record.events = record.events.slice(-MAX_AUDIT);
      const newer = this.persist(record);
      return {
        identity,
        capability: cap,
        changed: true,
        revision: newer,
        local_intent: operation === "allow" ? "allowed" : "denied",
        network_actions_enabled: false,
      };
    } finally {
      releasePolicyLock(lock.lockPath, { pid: process.pid, owner });
    }
  }
}
