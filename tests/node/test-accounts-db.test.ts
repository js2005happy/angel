// tests/node/test-accounts-db.test.ts — 用户账号登录（缺口 41 第二批）：
// 账号/会话的 Postgres 后端（Neon 免费档起步；以后迁阿里云 RDS 走 pg_dump/pg_restore）。
// 全部 mock-only：SQL 走 FakeDb 替身（只断言发了什么 SQL、参数怎么绑、行怎么映射）；
// 唯一碰真网络的是 checkDatabaseConnection/openPostgresAccounts 的失败路径，
// 目标是本机已关闭端口（127.0.0.1:1），连接被拒立即失败，不连任何真库。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNTS_SCHEMA_STATEMENTS,
  ACCOUNTS_SCHEMA_VERSION,
  PostgresAccountStore,
  PostgresAccountSessionStore,
  PostgresMagicLinkStore,
  appendPostgresAccountAudit,
  checkDatabaseConnection,
  createPostgresAccounts,
  ensureAccountsSchema,
  openPostgresAccounts,
  resolveAccountsBackend,
  resolveDatabaseUrl,
  type SqlClient,
} from "../../src/accountsDb.ts";
import { Vault } from "../../src/vault.ts";
import { nowIso } from "../../src/accounts.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 假 SQL 客户端：按 SQL 前缀匹配返回 canned 行，并记下每次调用（断言参数绑定用）。 */
class FakeDb implements SqlClient {
  queries: { text: string; params: unknown[] }[] = [];
  closed = false;
  private handlers: Array<{ match: (text: string) => boolean; run: (text: string, params: unknown[]) => { rows: Record<string, unknown>[] } | never }> = [];

  on(match: (text: string) => boolean, run: (text: string, params: unknown[]) => { rows: Record<string, unknown>[] }): this {
    this.handlers.push({ match, run });
    return this;
  }

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.queries.push({ text, params });
    for (const h of this.handlers) if (h.match(text)) return h.run(text, params);
    return { rows: [] };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  inserts(): { text: string; params: unknown[] }[] {
    return this.queries.filter((q) => q.text.startsWith("INSERT"));
  }

  updates(): { text: string; params: unknown[] }[] {
    return this.queries.filter((q) => q.text.startsWith("UPDATE"));
  }
}

const starts = (prefix: string) => (text: string) => text.startsWith(prefix);

function accountRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a-1",
    email: "user@example.com",
    name: "User",
    role: "owner",
    created_at: new Date(1_700_000_000 * 1000),
    last_seen: new Date(1_700_000_000 * 1000),
    ...overrides,
  };
}

function identityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "google",
    sub: "g-1",
    email: "user@example.com",
    name: "User",
    linked_at: new Date(1_700_000_000 * 1000),
    ...overrides,
  };
}

/** 给账号读路径（findById/loadAccount）挂上 canned 行。 */
function accountReadHandlers(db: FakeDb, account: Record<string, unknown>, identities: Record<string, unknown>[]): void {
  db.on(starts("SELECT id, email, name, role, created_at, last_seen FROM accounts WHERE id"), () => ({ rows: [account] }));
  db.on(starts("SELECT provider, sub, email, name, linked_at FROM account_identities"), () => ({ rows: identities }));
}

// ---- 表结构 ----

test("AccountsDbTest.test_schema_statements", () => {
  expect(ACCOUNTS_SCHEMA_VERSION).toBe(1);
  const joined = ACCOUNTS_SCHEMA_STATEMENTS.join("\n");
  for (const table of ["accounts", "account_identities", "account_sessions", "magic_links", "account_audit", "schema_migrations"]) {
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS " + table);
  }
  // 迁移友好：不用扩展、不用 citext、不依赖序列——pg_dump 迁 RDS 不多出依赖。
  expect(joined).not.toContain("CREATE EXTENSION");
  expect(joined.toLowerCase()).not.toContain("citext");
  expect(joined).not.toContain("serial");
  // 机主唯一（部分唯一索引）与 magic link 原子认领都在 DDL/语句里。
  expect(joined).toContain("accounts_single_owner");
  expect(joined).toContain("WHERE role = 'owner'");
  expect(joined).toContain("ON CONFLICT (version) DO NOTHING");
});

test("AccountsDbTest.test_ensure_schema_runs_all_statements_in_order", async () => {
  const db = new FakeDb();
  await ensureAccountsSchema(db);
  expect(db.queries.map((q) => q.text)).toEqual(ACCOUNTS_SCHEMA_STATEMENTS);
  expect(db.queries.every((q) => q.params.length === 0)).toBe(true);
});

// ---- 连接串解析 ----

test("AccountsDbTest.test_resolve_database_url_priority", async () => {
  const home = tmpHome("nyra-db-home-");
  const prevEnv = process.env.NYRA_DATABASE_URL;
  const prevVaultPw = process.env.NYRA_VAULT_PASSWORD;
  try {
    delete process.env.NYRA_DATABASE_URL;
    delete process.env.NYRA_VAULT_PASSWORD;
    expect(resolveDatabaseUrl(home)).toBeNull();
    // config.json 的 database.url。
    writeFileSync(join(home, "config.json"), JSON.stringify({ database: { url: "postgres://cfg/db" } }), "utf-8");
    expect(resolveDatabaseUrl(home)).toBe("postgres://cfg/db");
    // 环境变量优先于配置。
    process.env.NYRA_DATABASE_URL = "postgres://env/db";
    expect(resolveDatabaseUrl(home)).toBe("postgres://env/db");
    // 密码箱是第三来源（前两者都没有时）。
    delete process.env.NYRA_DATABASE_URL;
    writeFileSync(join(home, "config.json"), JSON.stringify({}), "utf-8");
    const vault = new Vault(join(home, "vault.json"));
    vault.init("test-master-pw-123");
    if (!vault.unlock("test-master-pw-123")) throw new Error("测试密码箱解锁失败");
    vault.add("database-url", "postgres://vault/db", true);
    process.env.NYRA_VAULT_PASSWORD = "test-master-pw-123";
    expect(resolveDatabaseUrl(home)).toBe("postgres://vault/db");
    // 后端选择：有串走 Postgres，没串走本地文件。
    expect(resolveAccountsBackend(home)).toEqual({ kind: "postgres", url: "postgres://vault/db" });
    delete process.env.NYRA_VAULT_PASSWORD;
    expect(resolveAccountsBackend(home)).toEqual({ kind: "file" });
  } finally {
    if (prevEnv === undefined) delete process.env.NYRA_DATABASE_URL;
    else process.env.NYRA_DATABASE_URL = prevEnv;
    if (prevVaultPw === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = prevVaultPw;
  }
});

// ---- 账号目录（Postgres） ----

test("AccountsDbTest.test_pg_account_find_and_create", async () => {
  const db = new FakeDb();
  accountReadHandlers(db, accountRow(), [identityRow()]);
  db.on(starts("SELECT id FROM accounts WHERE lower(email)"), () => ({ rows: [{ id: "a-1" }] }));
  const store = new PostgresAccountStore(db, { clock: () => 1_700_000_000 });
  const found = await store.findByEmail("User@Example.com");
  expect(found?.id).toBe("a-1");
  expect(found?.email).toBe("user@example.com");
  expect(found?.providers[0]).toMatchObject({ provider: "google", sub: "g-1" });
  // 邮箱先在 JS 里归一成小写再绑定（SQL 里的 lower() 是第二层防线，
  // 防其他路径写入的大小写不一致的行）；值绝不拼进 SQL 文本。
  expect(db.queries[0].params).toEqual(["user@example.com"]);
  expect(db.queries[0].text).toContain("lower(email) = lower($1)");

  // 创建：第一个账号是 owner。
  const db2 = new FakeDb();
  db2.on(starts("SELECT 1 FROM accounts WHERE lower(email)"), () => ({ rows: [] }));
  db2.on(starts("SELECT COUNT(*)"), () => ({ rows: [{ n: 0 }] }));
  const store2 = new PostgresAccountStore(db2, { clock: () => 1_700_000_000 });
  const first = await store2.create({ email: "Owner@Example.com", name: "机主" });
  expect(first.role).toBe("owner");
  expect(first.email).toBe("owner@example.com");
  const insert = db2.inserts().find((q) => q.text.startsWith("INSERT INTO accounts"));
  expect(insert?.params[3]).toBe("owner");
  expect(insert?.text).toContain("VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6))");

  // 第二个账号是 user；重复邮箱在 INSERT 之前就拒绝。
  const db3 = new FakeDb();
  db3.on(starts("SELECT 1 FROM accounts WHERE lower(email)"), () => ({ rows: [] }));
  db3.on(starts("SELECT COUNT(*)"), () => ({ rows: [{ n: 1 }] }));
  const store3 = new PostgresAccountStore(db3, { clock: () => 1_700_000_000 });
  const second = await store3.create({ email: "user2@example.com" });
  expect(second.role).toBe("user");
  const db4 = new FakeDb();
  db4.on(starts("SELECT 1 FROM accounts WHERE lower(email)"), () => ({ rows: [{ 1: 1 }] }));
  const store4 = new PostgresAccountStore(db4, { clock: () => 1_700_000_000 });
  await expect(store4.create({ email: "user@example.com" })).rejects.toThrow("已有账号");
  expect(db4.inserts()).toEqual([]);
});

test("AccountsDbTest.test_pg_account_create_owner_race_retries_as_user", async () => {
  const db = new FakeDb();
  db.on(starts("SELECT 1 FROM accounts WHERE lower(email)"), () => ({ rows: [] }));
  db.on(starts("SELECT COUNT(*)"), () => ({ rows: [{ n: 0 }] }));
  let attempts = 0;
  db.on(starts("INSERT INTO accounts"), (_text, _params) => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error("duplicate key value violates unique constraint \"accounts_single_owner\"") as Error & { code: string };
      err.code = "23505";
      throw err;
    }
    return { rows: [] };
  });
  const store = new PostgresAccountStore(db, { clock: () => 1_700_000_000 });
  const created = await store.create({ email: "race@example.com" });
  expect(created.role).toBe("user");
  expect(attempts).toBe(2);
  const inserts = db.inserts();
  expect(inserts[0].params[3]).toBe("owner");
  expect(inserts[1].params[3]).toBe("user");
});

test("AccountsDbTest.test_pg_account_link_identity", async () => {
  // 同一个 provider + sub 在另一个账号 → 拒绝，不写库。
  const db = new FakeDb();
  accountReadHandlers(db, accountRow(), [identityRow()]);
  db.on(starts("SELECT account_id FROM account_identities WHERE provider"), () => ({ rows: [{ account_id: "other" }] }));
  const store = new PostgresAccountStore(db, { clock: () => 1_700_000_000 });
  await expect(store.linkIdentity("a-1", { provider: "google", sub: "g-1", email: "x@example.com" })).rejects.toThrow("另一个账号");
  expect(db.inserts()).toEqual([]);
  expect(db.updates()).toEqual([]);

  // 同一个账号绑另一个 Google 身份 → 拒绝。
  const db2 = new FakeDb();
  accountReadHandlers(db2, accountRow(), [identityRow({ sub: "g-old" })]);
  db2.on(starts("SELECT account_id FROM account_identities WHERE provider"), () => ({ rows: [] }));
  const store2 = new PostgresAccountStore(db2, { clock: () => 1_700_000_000 });
  await expect(store2.linkIdentity("a-1", { provider: "google", sub: "g-new", email: "x@example.com" })).rejects.toThrow("另一个 google 身份");

  // 同一个身份再链 → 幂等（UPDATE，不 INSERT）。
  const db3 = new FakeDb();
  accountReadHandlers(db3, accountRow(), [identityRow()]);
  db3.on(starts("SELECT account_id FROM account_identities WHERE provider"), () => ({ rows: [] }));
  const store3 = new PostgresAccountStore(db3, { clock: () => 1_700_000_000 });
  const again = await store3.linkIdentity("a-1", { provider: "google", sub: "g-1", email: "user@example.com" });
  expect(again.providers.length).toBe(1);
  expect(db3.inserts().filter((q) => q.text.startsWith("INSERT INTO account_identities"))).toEqual([]);
  expect(db3.updates().some((q) => q.text.startsWith("UPDATE account_identities"))).toBe(true);

  // 新登录方式 → INSERT 一条身份。
  const db4 = new FakeDb();
  accountReadHandlers(db4, accountRow(), [identityRow()]);
  db4.on(starts("SELECT account_id FROM account_identities WHERE provider"), () => ({ rows: [] }));
  const store4 = new PostgresAccountStore(db4, { clock: () => 1_700_000_000 });
  const linked = await store4.linkIdentity("a-1", { provider: "github", sub: "gh-9", email: "user@example.com" });
  expect(linked.providers.length).toBe(1); // fake 只回了旧身份行，映射以 fake 为准
  const identityInsert = db4.inserts().find((q) => q.text.startsWith("INSERT INTO account_identities"));
  expect(identityInsert?.params).toEqual(["a-1", "github", "gh-9", "user@example.com", null, 1_700_000_000]);
});

// ---- 会话目录（Postgres） ----

test("AccountsDbTest.test_pg_sessions_issue_verify_revoke", async () => {
  const db = new FakeDb();
  const store = new PostgresAccountSessionStore(db, { clock: () => 1_700_000_000 });
  const issued = await store.issue("acct-1");
  expect(issued.token.length).toBeGreaterThan(30);
  const insert = db.inserts()[0];
  // 库里只存 SHA-256（64 位十六进制），不是 token 原文。
  expect(insert.params[2]).toMatch(/^[0-9a-f]{64}$/);
  expect(insert.params[2]).not.toBe(issued.token);
  expect(insert.params[0]).toBe(issued.id);

  // 校验通过：行里的 timestamptz 是 Date，映射回 ISO 串。
  const db2 = new FakeDb();
  db2.on(starts("SELECT id, account_id, created_at, last_seen, expires_at FROM account_sessions"), () => ({
    rows: [{
      id: "s-1",
      account_id: "acct-1",
      created_at: new Date(1_700_000_000 * 1000),
      last_seen: new Date(1_700_000_000 * 1000),
      expires_at: new Date(1_700_000_000 * 1000 + 30 * 24 * 3600 * 1000),
    }],
  }));
  const store2 = new PostgresAccountSessionStore(db2, { clock: () => 1_700_000_000 });
  expect(await store2.verify(issued.token)).toEqual({ account_id: "acct-1", session_id: "s-1" });
  expect(db2.updates().some((q) => q.text.startsWith("UPDATE account_sessions SET last_seen"))).toBe(true);

  // 过期 → 删掉并返回 null；不存在 → null 且不删。
  const db3 = new FakeDb();
  db3.on(starts("SELECT id, account_id"), () => ({
    rows: [{
      id: "s-2", account_id: "acct-1",
      created_at: new Date(1_700_000_000 * 1000),
      last_seen: new Date(1_700_000_000 * 1000),
      expires_at: new Date((1_700_000_000 - 10) * 1000),
    }],
  }));
  const store3 = new PostgresAccountSessionStore(db3, { clock: () => 1_700_000_000 });
  expect(await store3.verify("any-token")).toBeNull();
  expect(db3.queries.some((q) => q.text.startsWith("DELETE FROM account_sessions"))).toBe(true);
  const db4 = new FakeDb();
  db4.on(starts("SELECT id, account_id"), () => ({ rows: [] }));
  const store4 = new PostgresAccountSessionStore(db4, { clock: () => 1_700_000_000 });
  expect(await store4.verify("nope")).toBeNull();
  expect(db4.queries.some((q) => q.text.startsWith("DELETE"))).toBe(false);

  // 撤销与列出：DELETE … RETURNING 的行数即结果；列出不含哈希。
  const db5 = new FakeDb();
  db5.on(starts("DELETE FROM account_sessions WHERE id"), () => ({ rows: [{ id: "s-1" }] }));
  db5.on(starts("DELETE FROM account_sessions WHERE account_id"), () => ({ rows: [{ id: "s-1" }, { id: "s-2" }] }));
  db5.on(starts("SELECT id, account_id, created_at, last_seen, expires_at FROM account_sessions WHERE account_id"), () => ({
    rows: [{ id: "s-1", account_id: "acct-1", created_at: new Date(1_700_000_000 * 1000), last_seen: new Date(1_700_000_000 * 1000), expires_at: new Date(1_700_000_000 * 1000 + 3600 * 1000) }],
  }));
  const store5 = new PostgresAccountSessionStore(db5, { clock: () => 1_700_000_000 });
  expect(await store5.revoke("s-1")).toBe(true);
  expect(await store5.revokeAllForAccount("acct-1")).toBe(2);
  const listed = await store5.listSessions("acct-1");
  expect(listed.length).toBe(1);
  expect("token_sha256" in listed[0]).toBe(false);
  expect(listed[0].expires_at).toBe(new Date((1_700_000_000 + 3600) * 1000).toISOString());
});

// ---- magic link（Postgres） ----

test("AccountsDbTest.test_pg_magic_link_issue_redeem", async () => {
  const db = new FakeDb();
  const store = new PostgresMagicLinkStore(db, { clock: () => 1_700_000_000 });
  const issued = await store.issue("User@Example.com");
  expect(issued.expires_at).toBe(nowIso(1_700_000_000 + 900));
  const insert = db.inserts()[0];
  expect(insert.params[1]).toBe("user@example.com");
  expect(insert.params[2]).toMatch(/^[0-9a-f]{64}$/);
  expect(insert.params[2]).not.toBe(issued.token);
  await expect(store.issue("not-an-email")).rejects.toThrow("邮箱格式无效");

  // 兑换：一条 UPDATE 原子认领（used_at IS NULL + 未过期），拿到邮箱；抢不到 → null。
  const db2 = new FakeDb();
  db2.on(starts("UPDATE magic_links SET used_at"), () => ({ rows: [{ email: "user@example.com" }] }));
  const store2 = new PostgresMagicLinkStore(db2, { clock: () => 1_700_000_000 });
  expect(await store2.redeem(issued.token)).toBe("user@example.com");
  expect(db2.queries[0].text).toContain("used_at IS NULL AND expires_at > now()");
  const db3 = new FakeDb();
  db3.on(starts("UPDATE magic_links SET used_at"), () => ({ rows: [] }));
  const store3 = new PostgresMagicLinkStore(db3, { clock: () => 1_700_000_000 });
  expect(await store3.redeem("spent")).toBeNull();
});

// ---- 审计与 bundle ----

test("AccountsDbTest.test_pg_audit_and_bundle", async () => {
  const db = new FakeDb();
  await appendPostgresAccountAudit(db, { action: "login", provider: "google", account_id: "a-1" });
  expect(db.inserts()[0].params).toEqual(["login", "google", "a-1"]);
  await appendPostgresAccountAudit(db, { action: "logout" });
  expect(db.inserts()[1].params).toEqual(["logout", null, null]);

  const bundle = createPostgresAccounts(db, { clock: () => 1_700_000_000 });
  expect(bundle.directory).toBeInstanceOf(PostgresAccountStore);
  expect(bundle.sessions).toBeInstanceOf(PostgresAccountSessionStore);
  expect(bundle.magicLinks).toBeInstanceOf(PostgresMagicLinkStore);
  expect(bundle.client).toBe(db);
  await bundle.close();
  expect(db.closed).toBe(true);
});

// ---- 真连接失败路径（本机已关闭端口，不连真库） ----

test("AccountsDbTest.test_check_connection_refused_is_fast_failure", async () => {
  const result = await checkDatabaseConnection("postgres://user:pass@127.0.0.1:1/db");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
});

test("AccountsDbTest.test_open_postgres_accounts_schema_failure_closes", async () => {
  await expect(openPostgresAccounts("postgres://user:pass@127.0.0.1:1/db")).rejects.toThrow();
});

// ---- CLI：配了坏连接串 → 明确报错、不挂起 ----

test("AccountsDbTest.test_cli_bad_database_url_fails_cleanly", () => {
  const home = tmpHome("nyra-db-cli-home-");
  const res = spawnSync("bun", ["run", "src/cli.ts", "account", "status"], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh", NYRA_DATABASE_URL: "postgres://user:pass@127.0.0.1:1/db" },
    timeout: 30000,
  });
  expect(res.status).toBe(1);
  expect(res.stderr).toContain("错误：");
});
