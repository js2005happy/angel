// src/vault.ts — 密码箱，与 Python 版 nyra/vault.py 字节级兼容（格式见下）。
// 算法：
// - PBKDF2-HMAC-SHA256，600,000 次（0.4.1 起；OWASP 对 SHA-256 的建议值。
//   旧密码箱是 200,000 次，文件里没有 iterations 字段即按 200k 读；
//   下次成功解锁时自动在后台重算升级到 600k 再保存，用户无感——
//   拍板依据：审查报告第 1 项；解锁是低频操作，一次多花约 0.2 秒
//   换全量条目更难离线破解，值得。性能在常用路径上不受影响，
//   因为解锁只在进程启动/显式解锁时算一次，之后全走内存密钥）。
// - 32 字节随机 salt，64 字节派生密钥：前 32 字节加密，后 32 字节认证。
// - 加密是 HMAC 计数器模式：keystream = HMAC-SHA256(enc_key, nonce || counter_be32)
//   逐块异或明文；nonce 每条 16 随机字节。**不是 AES-256-CTR**（第 1 阶段探针
//   的 AES 结论只验证了 PBKDF2 向量，加密原语以 vault.py 为准）。
// - 认证 HMAC-SHA256(mac_key, nonce || ciphertext)，解密前先验，失败只报同一错。
// - 密码校验子：HMAC-SHA256(mac_key, b"nyra-vault-verifier-v1")。
// - 文件格式：{version:1, salt:hex, verifier:hex, iterations?:number, entries:{name:{nonce,data,mac} hex}}，
//   JSON indent 2 + sort_keys + 末尾换行；原子写（tmp + replace），文件 0600、父目录 0700。
// - 主密码（审查报告第 2 项）：新建/改密码时至少 8 位；已有弱口令密码箱照常用，
//   不把老用户锁在门外。解锁输错 5 次后锁死一段时间（递进延迟，最长 15 分钟），
//   限流状态记在密码箱旁的 vault.attempts.json 里（0600），跨进程也生效；
//   锁死期间直接拒绝，不烧 CPU 重算 PBKDF2。
// - 条目名明文存储（list_names 无需解锁）；密钥值绝不进日志/报错。
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const VAULT_VERSION = 1;
/** 新密码箱的 PBKDF2 次数（OWASP 对 SHA-256 的建议值，审查报告第 1 项）。 */
export const PBKDF2_ITERATIONS = 600_000;
/** 0.4.0 及之前密码箱的次数：文件里没有 iterations 字段时按此读。 */
export const PBKDF2_ITERATIONS_LEGACY = 200_000;
/** 主密码最小长度（新建与改密码时 enforcing；已有密码箱不受影响，审查报告第 2 项）。 */
export const MIN_MASTER_PASSWORD_LENGTH = 8;
/** 解锁连续输错多少次后开始锁死（审查报告第 2 项）。 */
export const MAX_UNLOCK_ATTEMPTS = 5;
/** 锁死基础时长（毫秒）；之后每次再错翻倍，上限见下。 */
export const UNLOCK_LOCKOUT_BASE_MS = 60_000;
/** 锁死时长上限（毫秒）。 */
export const UNLOCK_LOCKOUT_MAX_MS = 15 * 60_000;
export const SALT_LEN = 32;
export const NONCE_LEN = 16;
export const DERIVED_KEY_LEN = 64;
export const ENC_KEY_LEN = 32;
export const VERIFIER_MESSAGE = Buffer.from("nyra-vault-verifier-v1", "utf-8");
export const VAULT_FILENAME = "vault.json";
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export function vaultPath(home: string): string {
  return join(home, VAULT_FILENAME);
}

export function vaultExists(home: string): boolean {
  return existsSync(vaultPath(home));
}

export function deriveKeys(password: string, salt: Buffer, iterations: number = PBKDF2_ITERATIONS): { encKey: Buffer; macKey: Buffer } {
  const key = pbkdf2Sync(password, salt, iterations, DERIVED_KEY_LEN, "sha256");
  return { encKey: key.subarray(0, ENC_KEY_LEN), macKey: key.subarray(ENC_KEY_LEN) };
}

function keystream(encKey: Buffer, nonce: Buffer, length: number): Buffer {
  const out: Buffer[] = [];
  let counter = 0;
  let produced = 0;
  while (produced < length) {
    const ctr = Buffer.alloc(4);
    ctr.writeUInt32BE(counter, 0);
    out.push(createHmac("sha256", encKey).update(Buffer.concat([nonce, ctr])).digest());
    produced += 32;
    counter += 1;
  }
  return Buffer.concat(out).subarray(0, length);
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

export interface VaultEntry {
  nonce: string;
  data: string;
  mac: string;
}

export interface VaultDoc {
  version: number;
  salt: string;
  verifier: string;
  /** PBKDF2 次数；0.4.0 及之前的旧文件没有该字段，按 200k 读（见 load）。 */
  iterations?: number;
  entries: Record<string, VaultEntry>;
}

export function encryptEntry(encKey: Buffer, macKey: Buffer, plaintext: Buffer): VaultEntry {
  const nonce = randomBytes(NONCE_LEN);
  const ciphertext = xor(plaintext, keystream(encKey, nonce, plaintext.length));
  const mac = createHmac("sha256", macKey).update(Buffer.concat([nonce, ciphertext])).digest();
  return { nonce: nonce.toString("hex"), data: ciphertext.toString("hex"), mac: mac.toString("hex") };
}

export function decryptEntry(encKey: Buffer, macKey: Buffer, entry: VaultEntry): Buffer {
  let nonce: Buffer;
  let ciphertext: Buffer;
  let mac: Buffer;
  try {
    nonce = Buffer.from(entry.nonce, "hex");
    ciphertext = Buffer.from(entry.data, "hex");
    mac = Buffer.from(entry.mac, "hex");
  } catch {
    throw new VaultError("密码箱条目已损坏");
  }
  if (!entry || typeof entry.nonce !== "string" || typeof entry.data !== "string" || typeof entry.mac !== "string") {
    throw new VaultError("密码箱条目已损坏");
  }
  const expected = createHmac("sha256", macKey).update(Buffer.concat([nonce, ciphertext])).digest();
  if (mac.length !== expected.length || !timingSafeEqual(expected, mac)) {
    // 不区分密码错误与内容被改：两种情况只报同一个错。
    throw new VaultError("密码箱校验失败：主密码错误或内容已被修改");
  }
  return xor(ciphertext, keystream(encKey, nonce, ciphertext.length));
}

export function verifier(macKey: Buffer): string {
  return createHmac("sha256", macKey).update(VERIFIER_MESSAGE).digest("hex");
}

export interface VaultOptions {
  /** 测试注入时钟（默认 Date.now）；生产不要传。 */
  clock?: () => number;
  /** 测试注入锁死基础时长毫秒（默认 UNLOCK_LOCKOUT_BASE_MS）；生产不要传。 */
  lockoutBaseMs?: number;
}

export class Vault {
  readonly path: string;
  private encKey: Buffer | null = null;
  private macKey: Buffer | null = null;
  private salt: Buffer | null = null;
  private clock: () => number;
  private lockoutBaseMs: number;

  constructor(path?: string, opts?: VaultOptions) {
    this.path = path ?? vaultPath(process.env.NYRA_HOME ?? "");
    this.clock = opts?.clock ?? (() => Date.now());
    this.lockoutBaseMs = opts?.lockoutBaseMs ?? UNLOCK_LOCKOUT_BASE_MS;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  get isLocked(): boolean {
    return this.encKey === null;
  }

  private requireUnlocked(): void {
    if (this.isLocked) throw new VaultError("密码箱未解锁，请先解锁");
  }

  // -- 解锁限流（审查报告第 2 项）：状态落盘，跨进程生效 --
  private attemptsPath(): string {
    return `${this.path}.attempts.json`;
  }

  private readAttempts(): { failed: number; lockoutUntil: number } {
    try {
      const raw = JSON.parse(readFileSync(this.attemptsPath(), "utf-8")) as { failed?: unknown; lockoutUntil?: unknown };
      return {
        failed: typeof raw.failed === "number" && raw.failed > 0 ? Math.floor(raw.failed) : 0,
        lockoutUntil: typeof raw.lockoutUntil === "number" && raw.lockoutUntil > 0 ? raw.lockoutUntil : 0,
      };
    } catch {
      return { failed: 0, lockoutUntil: 0 };
    }
  }

  private writeAttempts(state: { failed: number; lockoutUntil: number }): void {
    try {
      const tmp = `${this.attemptsPath()}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state) + "\n", "utf-8");
      if (process.platform !== "win32") {
        try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
      }
      renameSync(tmp, this.attemptsPath());
    } catch { /* 限流状态写不进去也不影响解锁本身 */ }
  }

  /** 锁死剩余毫秒（0 = 没锁死）。锁死期间解锁直接拒绝，不烧 CPU 重算 PBKDF2。 */
  lockoutRemainingMs(): number {
    const state = this.readAttempts();
    const remaining = state.lockoutUntil - this.clock();
    return remaining > 0 ? remaining : 0;
  }

  private recordFailedAttempt(): void {
    const now = this.clock();
    const state = this.readAttempts();
    // 失败计数不清零（只在成功解锁时清）：锁死期过后再错，锁死时长翻倍。
    const failed = state.failed + 1;
    let lockoutUntil = state.lockoutUntil;
    if (failed >= MAX_UNLOCK_ATTEMPTS) {
      const backoff = Math.min(
        this.lockoutBaseMs * 2 ** (failed - MAX_UNLOCK_ATTEMPTS),
        UNLOCK_LOCKOUT_MAX_MS,
      );
      lockoutUntil = now + backoff;
    }
    this.writeAttempts({ failed, lockoutUntil });
  }

  private clearFailedAttempts(): void {
    try { rmSync(this.attemptsPath(), { force: true }); } catch { /* ignore */ }
  }

  /** 旧密码箱（200k）成功解锁后自动升级到 600k：重算全部条目再保存。 */
  private upgradeIterations(password: string, doc: VaultDoc): void {
    try {
      const oldIterations = doc.iterations ?? PBKDF2_ITERATIONS_LEGACY;
      const oldSalt = Buffer.from(doc.salt, "hex");
      const oldKeys = deriveKeys(password, oldSalt, oldIterations);
      const plaintexts: Record<string, Buffer> = {};
      for (const [name, entry] of Object.entries(doc.entries)) {
        plaintexts[name] = decryptEntry(oldKeys.encKey, oldKeys.macKey, entry);
      }
      const newSalt = randomBytes(SALT_LEN);
      const newKeys = deriveKeys(password, newSalt, PBKDF2_ITERATIONS);
      doc.salt = newSalt.toString("hex");
      doc.verifier = verifier(newKeys.macKey);
      doc.iterations = PBKDF2_ITERATIONS;
      doc.entries = {};
      for (const [name, plain] of Object.entries(plaintexts)) {
        doc.entries[name] = encryptEntry(newKeys.encKey, newKeys.macKey, plain);
      }
      this.save(doc);
      this.encKey = newKeys.encKey;
      this.macKey = newKeys.macKey;
      this.salt = newSalt;
    } catch (err: unknown) {
      // 升级失败不影响本次解锁：旧密码箱照常用，下次解锁再试一次。
      console.error(`密码箱升级到 ${PBKDF2_ITERATIONS} 次 PBKDF2 失败（下次解锁再试）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private load(): VaultDoc {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new VaultError("密码箱不存在，请先运行 `python3 -m nyra.vault init`");
      }
      throw new VaultError("密码箱文件已损坏，无法读取");
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new VaultError("密码箱文件已损坏，无法读取");
    }
    if (!doc || typeof doc !== "object" || (doc as VaultDoc).version !== VAULT_VERSION) {
      throw new VaultError("密码箱版本不受支持或文件已损坏");
    }
    const d = doc as VaultDoc;
    for (const field of ["salt", "verifier", "entries"] as const) {
      if (!(field in d)) throw new VaultError("密码箱文件已损坏：缺少字段");
    }
    if (!d.entries || typeof d.entries !== "object") {
      throw new VaultError("密码箱文件已损坏：entries 不是对象");
    }
    return d;
  }

  private save(doc: VaultDoc): void {
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true });
    if (process.platform !== "win32") {
      try { chmodSync(parent, 0o700); } catch { /* ignore */ }
    }
    const tmp = join(parent, `.${"vault.json"}.tmp-${process.pid}`);
    try {
      // Python 版：json.dump(indent=2, sort_keys=True) + "\n"。
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(doc).sort()) sorted[k] = (doc as unknown as Record<string, unknown>)[k];
      // entries 内部也按 key 排序（与 Python sort_keys 递归一致）。
      const entriesSorted: Record<string, VaultEntry> = {};
      for (const k of Object.keys(doc.entries).sort()) entriesSorted[k] = doc.entries[k];
      sorted.entries = entriesSorted;
      writeFileSync(tmp, JSON.stringify(sorted, null, 2) + "\n", "utf-8");
      if (process.platform !== "win32") {
        try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
      }
      renameSync(tmp, this.path);
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
    if (process.platform !== "win32") {
      try { chmodSync(this.path, 0o600); } catch { /* ignore */ }
    }
  }

  init(password: string): void {
    if (!password || password.length < MIN_MASTER_PASSWORD_LENGTH) {
      throw new VaultError(`主密码至少 ${MIN_MASTER_PASSWORD_LENGTH} 位`);
    }
    if (existsSync(this.path)) throw new VaultError(`密码箱已存在：${this.path}`);
    const salt = randomBytes(SALT_LEN);
    const { encKey, macKey } = deriveKeys(password, salt, PBKDF2_ITERATIONS);
    const doc: VaultDoc = { version: VAULT_VERSION, salt: salt.toString("hex"), verifier: verifier(macKey), iterations: PBKDF2_ITERATIONS, entries: {} };
    this.save(doc);
    this.encKey = encKey;
    this.macKey = macKey;
    this.salt = salt;
  }

  /** 密码错误返回 false（不留密钥）；结构损坏抛 VaultError。 */
  unlock(password: string): boolean {
    if (!password || !existsSync(this.path)) return false;
    // 锁死期间直接拒绝，不烧 CPU 重算 PBKDF2（审查报告第 2 项）。
    if (this.lockoutRemainingMs() > 0) return false;
    const doc = this.load();
    let salt: Buffer;
    try {
      salt = Buffer.from(doc.salt, "hex");
    } catch {
      throw new VaultError("密码箱文件已损坏：salt 无效");
    }
    const iterations = doc.iterations ?? PBKDF2_ITERATIONS_LEGACY;
    const { encKey, macKey } = deriveKeys(password, salt, iterations);
    const expected = Buffer.from(doc.verifier, "hex");
    const actual = Buffer.from(verifier(macKey), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      this.encKey = this.macKey = this.salt = null;
      this.recordFailedAttempt();
      return false;
    }
    this.clearFailedAttempts();
    this.encKey = encKey;
    this.macKey = macKey;
    this.salt = salt;
    // 旧密码箱（200k）后台自动升级到 600k，用户无感（审查报告第 1 项）。
    if (iterations < PBKDF2_ITERATIONS) this.upgradeIterations(password, doc);
    return true;
  }

  lock(): void {
    this.encKey = this.macKey = this.salt = null;
  }

  add(name: string, secret: string, overwrite = false): void {
    this.requireUnlocked();
    if (!NAME_PATTERN.test(name)) {
      throw new VaultError(`名字不合法：${name}（只允许字母、数字、_ . -）`);
    }
    const doc = this.load();
    if (name in doc.entries && !overwrite) {
      throw new VaultError(`已存在：${name}（覆盖请用 overwrite=True）`);
    }
    doc.entries[name] = encryptEntry(this.encKey!, this.macKey!, Buffer.from(secret, "utf-8"));
    this.save(doc);
  }

  get(name: string): string | null {
    this.requireUnlocked();
    const doc = this.load();
    const entry = doc.entries[name];
    if (!entry) return null;
    return decryptEntry(this.encKey!, this.macKey!, entry).toString("utf-8");
  }

  remove(name: string): void {
    this.requireUnlocked();
    const doc = this.load();
    if (!(name in doc.entries)) throw new VaultError(`没有这条：${name}`);
    delete doc.entries[name];
    this.save(doc);
  }

  /** 只列名字（明文存储），无需解锁，绝不暴露密钥值。 */
  listNames(): string[] {
    if (!existsSync(this.path)) {
      throw new VaultError("密码箱不存在，请先运行 `python3 -m nyra.vault init`");
    }
    return Object.keys(this.load().entries).sort();
  }

  changePassword(oldPassword: string, newPassword: string): void {
    if (!newPassword || newPassword.length < MIN_MASTER_PASSWORD_LENGTH) {
      throw new VaultError(`新主密码至少 ${MIN_MASTER_PASSWORD_LENGTH} 位`);
    }
    const doc = this.load();
    let oldSalt: Buffer;
    try {
      oldSalt = Buffer.from(doc.salt, "hex");
    } catch {
      throw new VaultError("密码箱文件已损坏：salt 无效");
    }
    const oldIterations = doc.iterations ?? PBKDF2_ITERATIONS_LEGACY;
    const oldKeys = deriveKeys(oldPassword, oldSalt, oldIterations);
    const expected = Buffer.from(doc.verifier, "hex");
    const actual = Buffer.from(verifier(oldKeys.macKey), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new VaultError("旧主密码错误");
    }
    const plaintexts: Record<string, Buffer> = {};
    for (const [name, entry] of Object.entries(doc.entries)) {
      plaintexts[name] = decryptEntry(oldKeys.encKey, oldKeys.macKey, entry);
    }
    const newSalt = randomBytes(SALT_LEN);
    const newKeys = deriveKeys(newPassword, newSalt, PBKDF2_ITERATIONS);
    doc.salt = newSalt.toString("hex");
    doc.verifier = verifier(newKeys.macKey);
    doc.iterations = PBKDF2_ITERATIONS;
    doc.entries = {};
    for (const [name, plain] of Object.entries(plaintexts)) {
      doc.entries[name] = encryptEntry(newKeys.encKey, newKeys.macKey, plain);
    }
    this.save(doc);
    this.encKey = newKeys.encKey;
    this.macKey = newKeys.macKey;
    this.salt = newSalt;
  }
}

/**
 * 静默读一条凭据：无 vault 文件、无 NYRA_VAULT_PASSWORD、密码错误、
 * 条目缺失、文件损坏时一律返回 null，绝不抛错（config 回退用）。
 */
export function getCredential(name: string, home?: string): string | null {
  const password = process.env.NYRA_VAULT_PASSWORD;
  if (!password) return null;
  const path = vaultPath(home ?? process.env.NYRA_HOME ?? "");
  if (!existsSync(path)) return null;
  try {
    const vault = new Vault(path);
    if (!vault.unlock(password)) return null;
    return vault.get(name);
  } catch {
    return null;
  }
}

export function vaultUsage(): string {
  return (
    "用法：nyra vault <命令> [参数]\n\n命令：\n  init             创建密码箱\n  add NAME         存一条密钥\n  get NAME         显示一条密钥\n  list             只列出名字，不显示密钥\n  remove NAME      删除一条\n  change-password  改主密码\n"
  );
}
