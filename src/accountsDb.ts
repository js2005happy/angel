// 账号/会话的 Postgres 后端（控制面数据进库，见 docs/accounts.md §8）。
//
// 定位：用户 2026-11-20 拍板，先用 Neon 免费档起步（Postgres，新加坡）；
// 以后上线迁阿里云 RDS PG Serverless 时走 pg_dump / pg_restore，PG 系之间
// 能平滑迁。所以表结构只用最标准的 Postgres 类型，不用任何扩展（不用 citext、
// 不用 pgcrypto、不装任何插件），id 全部由应用层生成（不依赖序列）。
//
// 连接方式：Bun 自带的 SQL 客户端（Bun.sql，全局就有，不用再装 pg 驱动）。
// 连接串绝不硬编码，来源按优先级：
//   1. 环境变量 NYRA_DATABASE_URL（托管/服务形态的标准做法，首选）；
//   2. config.json 的 database.url（用户明确要求支持配置来源）；
//   3. 密码箱条目 database-url（NYRA_VAULT_PASSWORD 解锁时才读得到，
//      盘上最安全的放法；读不到就静默跳过，不报错）。
// 三处都没有 → 本地文件后端（默认行为不变）。
//
// 没有连接串时本模块只定义接口与 SQL，不连任何库；接上连接串就能跑——
// CLI 在 NYRA_DATABASE_URL 存在时自动改走 Postgres（并先建表），
// 网关接线在下一批（见 docs/accounts.md §9）。

import { randomBytes } from "node:crypto";
import { getCredential } from "./vault.ts";
import { loadConfig } from "./config.ts";
import {
  ACCOUNT_SESSION_INACTIVITY_TTL_SECONDS,
  ACCOUNT_SESSION_TTL_SECONDS,
  MAGIC_LINK_TTL_SECONDS,
  hashToken,
  newId,
  normalizeEmail,
  nowIso,
  type Account,
  type AccountAuditAction,
  type AccountDirectory,
  type AccountProvider,
  type AccountSession,
  type AccountSessionDirectory,
  type LinkedIdentity,
  type MagicLinkDirectory,
  AccountError,
} from "./accounts.ts";

export const DATABASE_URL_ENV = "NYRA_DATABASE_URL";
export const DATABASE_VAULT_ENTRY = "database-url";
export const ACCOUNTS_SCHEMA_VERSION = 1;

/** 最小 SQL 客户端接口：PostgresAccountStore 等只依赖它，测试用替身上。 */
export interface SqlClient {
  /** 带参查询：SQL 文本里用 $1、$2… 占位，参数单独传——值绝不拼进 SQL 文本。 */
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
}

/** Bun 自带 SQL 客户端的适配器（Bun.sql 全局就有，无需额外依赖；懒连接）。 */
export class BunSqlClient implements SqlClient {
  private sql: InstanceType<typeof Bun.SQL>;

  constructor(url: string) {
    this.sql = new Bun.SQL(url);
  }

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const rows = await this.sql.unsafe(text, params);
    return { rows: rows as Record<string, unknown>[] };
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}

/**
 * 账号表结构 v1（逐条执行，全部幂等；顺序即依赖顺序）。
 * 字段与本地文件实现一一对应（见 docs/accounts.md §3）：
 * accounts + account_identities 存账号，account_sessions 存会话，
 * magic_links 存邮箱登录令牌，account_audit 存审计行（只记动作/provider/账号 id）。
 */
export const ACCOUNTS_SCHEMA_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS accounts (id text PRIMARY KEY, email text NOT NULL, name text NOT NULL, role text NOT NULL CHECK (role IN ('owner', 'user')), created_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now())",
  // 邮箱唯一按小写比（不用 citext 扩展，pg_dump 迁 RDS 不会多出依赖）。
  "CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_lower_unique ON accounts (lower(email))",
  // 机主只能有一个：并发首登时后到的 INSERT 会报 23505，见 create() 的重试。
  "CREATE UNIQUE INDEX IF NOT EXISTS accounts_single_owner ON accounts (role) WHERE role = 'owner'",
  "CREATE TABLE IF NOT EXISTS account_identities (account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, provider text NOT NULL, sub text NOT NULL, email text NOT NULL, name text, linked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (provider, sub))",
  "CREATE UNIQUE INDEX IF NOT EXISTS account_identities_account_provider_unique ON account_identities (account_id, provider)",
  "CREATE TABLE IF NOT EXISTS account_sessions (id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, token_sha256 text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL)",
  "CREATE INDEX IF NOT EXISTS account_sessions_account_idx ON account_sessions (account_id)",
  "CREATE TABLE IF NOT EXISTS magic_links (id text PRIMARY KEY, email text NOT NULL, token_sha256 text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, used_at timestamptz)",
  "CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links (email)",
  "CREATE TABLE IF NOT EXISTS account_audit (ts timestamptz NOT NULL DEFAULT now(), action text NOT NULL, provider text, account_id text)",
  "INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING",
];

/** 建表（幂等；CLI 每次用 Postgres 后端时先跑一遍，空库第一次就建好）。 */
export async function ensureAccountsSchema(client: SqlClient): Promise<void> {
  for (const statement of ACCOUNTS_SCHEMA_STATEMENTS) {
    await client.query(statement);
  }
}

/** 解析连接串：环境变量 → config.json database.url → 密码箱 database-url。 */
export function resolveDatabaseUrl(home?: string): string | null {
  const fromEnv = (process.env[DATABASE_URL_ENV] ?? "").trim();
  if (fromEnv) return fromEnv;
  const cfg = loadConfig(home);
  const db = cfg.database as Record<string, unknown> | undefined;
  const fromConfig = typeof db?.url === "string" ? db.url.trim() : "";
  if (fromConfig) return fromConfig;
  const fromVault = getCredential(DATABASE_VAULT_ENTRY, home);
  if (fromVault && fromVault.trim()) return fromVault.trim();
  return null;
}

export type AccountsBackend = { kind: "file" } | { kind: "postgres"; url: string };

/** 选后端：有连接串就走 Postgres，没有就走本地文件（默认行为不变）。 */
export function resolveAccountsBackend(home?: string): AccountsBackend {
  const url = resolveDatabaseUrl(home);
  return url ? { kind: "postgres", url } : { kind: "file" };
}

/** 试连一次（只发 SELECT 1；连不上返回 ok:false，不抛错）。 */
export async function checkDatabaseConnection(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = new BunSqlClient(url);
  try {
    await client.query("SELECT 1 AS ok");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      await client.close();
    } catch {
      /* 关连接失败不影响结论 */
    }
  }
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  return new Date().toISOString();
}

function toEpoch(value: unknown): number {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  const ms = date.getTime();
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

async function loadAccount(client: SqlClient, id: string): Promise<Account | null> {
  const { rows } = await client.query(
    "SELECT id, email, name, role, created_at, last_seen FROM accounts WHERE id = $1",
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const identities = await client.query(
    "SELECT provider, sub, email, name, linked_at FROM account_identities WHERE account_id = $1 ORDER BY provider",
    [id],
  );
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name ?? ""),
    role: row.role === "owner" ? "owner" : "user",
    providers: identities.rows.map((r): LinkedIdentity => ({
      provider: r.provider as AccountProvider,
      sub: String(r.sub),
      email: String(r.email),
      ...(typeof r.name === "string" && r.name ? { name: r.name } : {}),
      linked_at: toIso(r.linked_at),
    })),
    created_at: toIso(row.created_at),
    last_seen: toIso(row.last_seen),
  };
}

export class PostgresAccountStore implements AccountDirectory {
  private clock: () => number;

  constructor(
    private client: SqlClient,
    opts?: { clock?: () => number },
  ) {
    this.clock = opts?.clock ?? (() => Date.now() / 1000);
  }

  async findByEmail(email: string): Promise<Account | null> {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const { rows } = await this.client.query("SELECT id FROM accounts WHERE lower(email) = lower($1) LIMIT 1",
      [normalized],
    );
    if (!rows.length) return null;
    return loadAccount(this.client, String(rows[0].id));
  }

  async findByProvider(provider: AccountProvider, sub: string): Promise<Account | null> {
    const { rows } = await this.client.query("SELECT account_id FROM account_identities WHERE provider = $1 AND sub = $2 LIMIT 1",
      [provider, sub],
    );
    if (!rows.length) return null;
    return loadAccount(this.client, String(rows[0].account_id));
  }

  async findById(id: string): Promise<Account | null> {
    return loadAccount(this.client, id);
  }

  async listAccounts(): Promise<Account[]> {
    const { rows } = await this.client.query("SELECT id FROM accounts ORDER BY created_at",
    );
    const accounts: Account[] = [];
    for (const row of rows) {
      const account = await loadAccount(this.client, String(row.id));
      if (account) accounts.push(account);
    }
    return accounts;
  }

  async create(input: { email: string; name?: string }): Promise<Account> {
    const email = normalizeEmail(input.email);
    if (!email) throw new AccountError("邮箱格式无效");
    const dup = await this.client.query("SELECT 1 FROM accounts WHERE lower(email) = lower($1) LIMIT 1",
      [email],
    );
    if (dup.rows.length) throw new AccountError("该邮箱已有账号（请直接登录，不要重复创建）");
    const now = this.clock();
    const account: Account = {
      id: newId(),
      email,
      name: (input.name ?? "").trim() || email.split("@")[0],
      // 第一个账号自动是 owner（单机场景第一个登录的人就是机主；托管时同理）。
      role: "user",
      providers: [],
      created_at: nowIso(now),
      last_seen: nowIso(now),
    };
    const count = await this.client.query("SELECT COUNT(*)::int AS n FROM accounts");
    if (Number(count.rows[0]?.n ?? 0) === 0) account.role = "owner";
    const insert = "INSERT INTO accounts (id, email, name, role, created_at, last_seen) VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6))";
    const params = [account.id, account.email, account.name, account.role, now, now];
    try {
      await this.client.query(insert, params);
    } catch (err) {
      if (isUniqueViolation(err) && account.role === "owner") {
        // 并发首登：另一个进程先抢到了 owner 位，重试为普通用户。
        account.role = "user";
        await this.client.query(insert, [account.id, account.email, account.name, "user", now, now]);
      } else {
        throw err;
      }
    }
    return account;
  }

  async linkIdentity(accountId: string, identity: Omit<LinkedIdentity, "linked_at">): Promise<Account> {
    const email = normalizeEmail(identity.email);
    if (!email) throw new AccountError("邮箱格式无效");
    if (!identity.sub) throw new AccountError("登录方没有返回用户标识");
    const account = await loadAccount(this.client, accountId);
    if (!account) throw new AccountError("账号不存在");
    const other = await this.client.query("SELECT account_id FROM account_identities WHERE provider = $1 AND sub = $2 AND account_id <> $3 LIMIT 1",
      [identity.provider, identity.sub, accountId],
    );
    if (other.rows.length) throw new AccountError("这个 " + identity.provider + " 身份已经绑定到另一个账号了");
    const existing = account.providers.find((p) => p.provider === identity.provider);
    const now = this.clock();
    if (existing) {
      if (existing.sub !== identity.sub) throw new AccountError("该账号已经绑定了另一个 " + identity.provider + " 身份");
      await this.client.query("UPDATE account_identities SET email = $1, name = $2, linked_at = to_timestamp($3) WHERE account_id = $4 AND provider = $5",
        [email, identity.name ?? existing.name ?? null, now, accountId, identity.provider],
      );
    } else {
      await this.client.query("INSERT INTO account_identities (account_id, provider, sub, email, name, linked_at) VALUES ($1, $2, $3, $4, $5, to_timestamp($6))",
        [accountId, identity.provider, identity.sub, email, identity.name ?? null, now],
      );
    }
    await this.client.query("UPDATE accounts SET last_seen = to_timestamp($1) WHERE id = $2",
      [now, accountId],
    );
    const updated = await loadAccount(this.client, accountId);
    if (!updated) throw new AccountError("账号不存在");
    return updated;
  }

  async touchLastSeen(accountId: string): Promise<void> {
    await this.client.query("UPDATE accounts SET last_seen = to_timestamp($1) WHERE id = $2",
      [this.clock(), accountId],
    );
  }
}

export class PostgresAccountSessionStore implements AccountSessionDirectory {
  private clock: () => number;
  private lastSeenWritten: Record<string, number> = {};

  constructor(
    private client: SqlClient,
    opts?: { clock?: () => number },
  ) {
    this.clock = opts?.clock ?? (() => Date.now() / 1000);
  }

  /** 签发会话：token 原文只在这里返回一次，库里只存 SHA-256。 */
  async issue(accountId: string, ttlSeconds: number = ACCOUNT_SESSION_TTL_SECONDS): Promise<{ id: string; token: string; expires_at: string }> {
    const now = this.clock();
    const token = randomBytes(32).toString("base64url");
    const id = newId();
    await this.client.query("INSERT INTO account_sessions (id, account_id, token_sha256, created_at, last_seen, expires_at) VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($4), to_timestamp($5))",
      [id, accountId, hashToken(token), now, now + ttlSeconds],
    );
    return { id, token, expires_at: nowIso(now + ttlSeconds) };
  }

  /** 校验会话 token：过期或 30 天没用过 → 失效并删掉，返回 null。 */
  async verify(token: string): Promise<{ account_id: string; session_id: string } | null> {
    if (!token || typeof token !== "string" || token.length > 200) return null;
    const digest = hashToken(token);
    const { rows } = await this.client.query("SELECT id, account_id, created_at, last_seen, expires_at FROM account_sessions WHERE token_sha256 = $1",
      [digest],
    );
    const found = rows[0];
    if (!found) return null;
    const now = this.clock();
    if (toEpoch(found.expires_at) <= now || now - toEpoch(found.last_seen) > ACCOUNT_SESSION_INACTIVITY_TTL_SECONDS) {
      await this.client.query("DELETE FROM account_sessions WHERE id = $1", [String(found.id)]);
      delete this.lastSeenWritten[String(found.id)];
      return null;
    }
    const last = this.lastSeenWritten[String(found.id)];
    if (last === undefined || now - last >= 60) {
      this.lastSeenWritten[String(found.id)] = now;
      try {
        await this.client.query("UPDATE account_sessions SET last_seen = to_timestamp($1) WHERE id = $2",
          [now, String(found.id)],
        );
      } catch {
        /* last_seen 写不进去不拦本次校验 */
      }
    }
    return { account_id: String(found.account_id), session_id: String(found.id) };
  }

  /** 列出某账号的会话（不含 token 哈希）。 */
  async listSessions(accountId: string): Promise<Omit<AccountSession, "token_sha256">[]> {
    const { rows } = await this.client.query("SELECT id, account_id, created_at, last_seen, expires_at FROM account_sessions WHERE account_id = $1 ORDER BY created_at DESC",
      [accountId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      account_id: String(r.account_id),
      created_at: toIso(r.created_at),
      last_seen: toIso(r.last_seen),
      expires_at: toIso(r.expires_at),
    }));
  }

  async revoke(sessionId: string): Promise<boolean> {
    const { rows } = await this.client.query("DELETE FROM account_sessions WHERE id = $1 RETURNING id",
      [sessionId],
    );
    delete this.lastSeenWritten[sessionId];
    return rows.length > 0;
  }

  async revokeAllForAccount(accountId: string): Promise<number> {
    const { rows } = await this.client.query("DELETE FROM account_sessions WHERE account_id = $1 RETURNING id",
      [accountId],
    );
    for (const row of rows) delete this.lastSeenWritten[String(row.id)];
    return rows.length;
  }
}

export class PostgresMagicLinkStore implements MagicLinkDirectory {
  private clock: () => number;

  constructor(
    private client: SqlClient,
    opts?: { clock?: () => number },
  ) {
    this.clock = opts?.clock ?? (() => Date.now() / 1000);
  }

  /** 签发 magic link：token 原文只在这里返回一次，库里只存 SHA-256。 */
  async issue(email: string, ttlSeconds: number = MAGIC_LINK_TTL_SECONDS): Promise<{ id: string; token: string; expires_at: string }> {
    const normalized = normalizeEmail(email);
    if (!normalized) throw new AccountError("邮箱格式无效");
    const now = this.clock();
    const token = randomBytes(32).toString("base64url");
    const id = newId();
    await this.client.query("INSERT INTO magic_links (id, email, token_sha256, created_at, expires_at) VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5))",
      [id, normalized, hashToken(token), now, now + ttlSeconds],
    );
    return { id, token, expires_at: nowIso(now + ttlSeconds) };
  }

  /**
   * 兑换 magic link：过期或已用过 → null；通过后立即标记已用（重放必失败）。
   * 用一条 UPDATE … WHERE used_at IS NULL AND expires_at > now() 原子认领，
   * 并发兑换只有一个能拿到邮箱；过期判断用库时间（与文件实现用的注入时钟不同，
   * 见 docs/accounts.md §8——托管时库时间才是准的）。
   */
  async redeem(token: string): Promise<string | null> {
    if (!token || typeof token !== "string" || token.length > 200) return null;
    const { rows } = await this.client.query("UPDATE magic_links SET used_at = now() WHERE token_sha256 = $1 AND used_at IS NULL AND expires_at > now() RETURNING email",
      [hashToken(token)],
    );
    return rows.length ? String(rows[0].email) : null;
  }
}

/** 审计动作（Postgres 版）：只记动作、provider、账号 id，不记邮箱、不记 token。 */
export async function appendPostgresAccountAudit(
  client: SqlClient,
  entry: { action: AccountAuditAction; provider?: AccountProvider; account_id?: string },
): Promise<void> {
  try {
    await client.query("INSERT INTO account_audit (action, provider, account_id) VALUES ($1, $2, $3)",
      [entry.action, entry.provider ?? null, entry.account_id ?? null],
    );
  } catch {
    /* 审计写不进去不拦登录本身 */
  }
}

/** 一组 Postgres 后端存储（与 AccountsStores 同形，CLI/网关直接注入）。 */
export interface PostgresAccounts {
  client: SqlClient;
  directory: PostgresAccountStore;
  sessions: PostgresAccountSessionStore;
  magicLinks: PostgresMagicLinkStore;
  audit(entry: { action: AccountAuditAction; provider?: AccountProvider; account_id?: string }): Promise<void>;
  close(): Promise<void>;
}

export function createPostgresAccounts(client: SqlClient, opts?: { clock?: () => number }): PostgresAccounts {
  const directory = new PostgresAccountStore(client, opts);
  const sessions = new PostgresAccountSessionStore(client, opts);
  const magicLinks = new PostgresMagicLinkStore(client, opts);
  return {
    client,
    directory,
    sessions,
    magicLinks,
    audit: (entry) => appendPostgresAccountAudit(client, entry),
    close: () => client.close(),
  };
}

/** 打开 Postgres 后端：先建表（幂等），再给存储；建表失败时关掉连接再抛错。 */
export async function openPostgresAccounts(url: string, opts?: { clock?: () => number }): Promise<PostgresAccounts> {
  const client = new BunSqlClient(url);
  try {
    await ensureAccountsSchema(client);
  } catch (err) {
    try {
      await client.close();
    } catch {
      /* 关连接失败不掩盖建表错误 */
    }
    throw err;
  }
  return createPostgresAccounts(client, opts);
}
