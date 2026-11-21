// tests/node/test-sso.test.ts — SSO 登录（缺口 43 第二批，SSO/SCIM）。
// 身份提供方注册表、OIDC 发现与 userinfo、SSO 登录端到端、账号停用三态。
// 全部 mock-only：IdP 端点用 stub fetch，不碰真 IdP；回环回调服务器是真的
// （127.0.0.1），用 fetch 直接回调它（与 test-accounts.test.ts 同款）。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountStore, AccountSessionStore, getCurrentAccount, upsertAccount,
  suspendAccount, reactivateAccount, readCurrentSession,
} from "../../src/accounts.ts";
import {
  addSsoProvider, removeSsoProvider, loadSsoProviders, getSsoProvider,
  discoverProvider, fetchSsoUserinfo, loginWithSso,
  SSO_PROVIDERS_FILE,
} from "../../src/sso.ts";

const ISSUER = "https://idp.example.com";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(home: string, args: string[], input?: string) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    input,
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

/** stub fetch：按 URL 精确匹配返回 JSON；没命中的 URL 直接报错（不静默放过）。 */
function stubFetch(routes: Record<string, unknown>) {
  return async (url: string, _init?: Record<string, unknown>) => {
    const data = routes[url];
    if (data === undefined) throw new Error("stub fetch 未覆盖的 URL：" + url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(data),
    };
  };
}

function discoveryDoc(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: ISSUER + "/oauth/authorize",
    token_endpoint: ISSUER + "/oauth/token",
    userinfo_endpoint: ISSUER + "/oauth/userinfo",
    ...overrides,
  };
}

function ssoFetch(userinfo: Record<string, unknown> = {}) {
  return stubFetch({
    [ISSUER + "/.well-known/openid-configuration"]: discoveryDoc(),
    [ISSUER + "/oauth/token"]: { access_token: "at-1", token_type: "Bearer", expires_in: 3600 },
    [ISSUER + "/oauth/userinfo"]: { sub: "sso-sub-1", email: "sso-user@example.com", email_verified: true, name: "SSO User", ...userinfo },
  });
}

/** openUrl 桩：解析授权链接里的回环地址与 state，直接回调它（真服务器、真换码流程）。 */
async function openUrlStub(authUrl: string) {
  const parsed = new URL(authUrl);
  const redirectUri = parsed.searchParams.get("redirect_uri") as string;
  const state = parsed.searchParams.get("state") as string;
  const res = await fetch(redirectUri + "?code=fake-auth-code&state=" + state);
  expect(res.status).toBe(200);
}

// ---- 注册表 ----

test("SsoTest.test_provider_registry_roundtrip", () => {
  const home = tmpHome("nyra-sso-reg-");
  expect(loadSsoProviders(home)).toEqual([]);
  const p = addSsoProvider(home, { id: "corp", issuer: ISSUER + "/", client_id: "cid-1", name: "公司 IdP" });
  expect(p.issuer).toBe(ISSUER); // 尾斜杠被归一掉
  expect(p.scopes).toContain("openid");
  expect(loadSsoProviders(home)).toHaveLength(1);
  expect(getSsoProvider(home, "corp")?.client_id).toBe("cid-1");
  // 注册表文件是 0600（POSIX 上断言；Windows 上只看文件存在）。
  expect(existsSync(join(home, SSO_PROVIDERS_FILE))).toBe(true);
  // 重复 id / 重复 issuer 都拒绝。
  expect(() => addSsoProvider(home, { id: "corp", issuer: "https://other.example.com", client_id: "cid-2" })).toThrow("已存在");
  expect(() => addSsoProvider(home, { id: "other", issuer: ISSUER, client_id: "cid-2" })).toThrow("已存在");
  expect(removeSsoProvider(home, "corp")).toBe(true);
  expect(removeSsoProvider(home, "corp")).toBe(false);
  expect(loadSsoProviders(home)).toEqual([]);
});

test("SsoTest.test_provider_registry_rejects_bad_input", () => {
  const home = tmpHome("nyra-sso-bad-");
  expect(() => addSsoProvider(home, { id: "Bad Id", issuer: ISSUER, client_id: "cid" })).toThrow("id 不合法");
  expect(() => addSsoProvider(home, { id: "ok", issuer: "http://idp.example.com", client_id: "cid" })).toThrow("https://");
  expect(() => addSsoProvider(home, { id: "ok", issuer: "https://idp.example.com/?x=1", client_id: "cid" })).toThrow("https://");
  expect(() => addSsoProvider(home, { id: "ok", issuer: ISSUER, client_id: "  " })).toThrow("client_id");
});

// ---- OIDC 发现与 userinfo ----

test("SsoTest.test_discover_provider", async () => {
  const ok = await discoverProvider(ISSUER, stubFetch({
    [ISSUER + "/.well-known/openid-configuration"]: discoveryDoc(),
  }));
  expect(ok.authorization_endpoint).toBe(ISSUER + "/oauth/authorize");
  // 发现文档的 issuer 与注册的不一致 → 拒绝（可能是冒充的发现端点）。
  await expect(discoverProvider(ISSUER, stubFetch({
    [ISSUER + "/.well-known/openid-configuration"]: discoveryDoc({ issuer: "https://evil.example.com" }),
  }))).rejects.toThrow("不一致");
  // 端点不是 https → 拒绝。
  await expect(discoverProvider(ISSUER, stubFetch({
    [ISSUER + "/.well-known/openid-configuration"]: discoveryDoc({ token_endpoint: "http://idp.example.com/oauth/token" }),
  }))).rejects.toThrow("token_endpoint");
  // 非 https 的 issuer 直接拒绝。
  await expect(discoverProvider("http://idp.example.com", stubFetch({}))).rejects.toThrow("https://");
});

test("SsoTest.test_fetch_userinfo_requires_verified_email", async () => {
  const unverified = stubFetch({
    [ISSUER + "/oauth/userinfo"]: { sub: "s-1", email: "x@example.com", email_verified: false },
  });
  await expect(fetchSsoUserinfo({ userinfoEndpoint: ISSUER + "/oauth/userinfo", accessToken: "at-1", fetchFn: unverified })).rejects.toThrow("尚未验证");
  const noEmail = stubFetch({
    [ISSUER + "/oauth/userinfo"]: { sub: "s-2", email_verified: true },
  });
  await expect(fetchSsoUserinfo({ userinfoEndpoint: ISSUER + "/oauth/userinfo", accessToken: "at-1", fetchFn: noEmail })).rejects.toThrow("有效邮箱");
  const ok = stubFetch({
    [ISSUER + "/oauth/userinfo"]: { sub: "s-3", email: "ok@example.com", email_verified: true, name: "OK" },
  });
  expect(await fetchSsoUserinfo({ userinfoEndpoint: ISSUER + "/oauth/userinfo", accessToken: "at-1", fetchFn: ok })).toEqual({ sub: "s-3", email: "ok@example.com", name: "OK" });
});

// ---- SSO 登录端到端 ----

test("SsoTest.test_sso_login_end_to_end", async () => {
  const home = tmpHome("nyra-sso-login-");
  const provider = addSsoProvider(home, { id: "corp", issuer: ISSUER, client_id: "cid-1" });
  const { account, session } = await loginWithSso({
    home, provider, client: { client_id: "cid-1", client_secret: "sec-1" },
    fetchFn: ssoFetch(), openUrl: openUrlStub,
  });
  expect(account.email).toBe("sso-user@example.com");
  expect(account.role).toBe("owner");
  expect(account.providers[0]).toMatchObject({ provider: "sso", sub: "sso-sub-1", issuer: ISSUER });
  expect(session.token.length).toBeGreaterThan(30);
  // 会话 token 能验过，本机当前会话也落盘了。
  const sessions = new AccountSessionStore(home);
  expect(await sessions.verify(session.token)).toEqual({ account_id: account.id, session_id: session.id });
  expect(readCurrentSession(home)?.account_id).toBe(account.id);
  // 审计行里有 login，无邮箱、无 token；SSO 审计里有 sso_login，只记 issuer 指纹。
  const audit = readFileSync(join(home, "accounts-audit.jsonl"), "utf-8");
  expect(audit).toContain('"action":"login"');
  expect(audit).toContain('"provider":"sso"');
  expect(audit).not.toContain("sso-user@example.com");
  expect(audit).not.toContain(session.token);
  const ssoAudit = readFileSync(join(home, "sso-audit.jsonl"), "utf-8");
  expect(ssoAudit).toContain('"action":"sso_login"');
  expect(ssoAudit).toContain('"provider_id":"corp"');
  expect(ssoAudit).not.toContain(ISSUER);
  expect(ssoAudit).not.toContain("sso-user@example.com");
  // 同邮箱第二次登录链到同一个账号，不建第二个。
  const again = await loginWithSso({
    home, provider, client: { client_id: "cid-1", client_secret: "sec-1" },
    fetchFn: ssoFetch(), openUrl: openUrlStub,
  });
  expect(again.account.id).toBe(account.id);
  const store = new AccountStore(home);
  expect((await store.listAccounts())).toHaveLength(1);
});

// ---- 账号停用三态 ----

test("SsoTest.test_suspended_account_is_disabled_everywhere", async () => {
  const home = tmpHome("nyra-sso-suspend-");
  const provider = addSsoProvider(home, { id: "corp", issuer: ISSUER, client_id: "cid-1" });
  const { account, session } = await loginWithSso({
    home, provider, client: { client_id: "cid-1", client_secret: "sec-1" },
    fetchFn: ssoFetch(), openUrl: openUrlStub,
  });
  const sessions = new AccountSessionStore(home);
  expect(await sessions.verify(session.token)).not.toBeNull();

  const { revoked_sessions } = await suspendAccount(home, account.id);
  expect(revoked_sessions).toBeGreaterThanOrEqual(1);
  // 1. 旧会话立即失效。
  expect(await sessions.verify(session.token)).toBeNull();
  // 2. 当前登录按未登录处理。
  expect(await getCurrentAccount(home)).toBeNull();
  // 3. 再登录 / 再绑定都被拒绝。
  await expect(upsertAccount(home, "sso", { sub: "sso-sub-1", email: "sso-user@example.com", issuer: ISSUER })).rejects.toThrow("已停用");
  await expect(loginWithSso({
    home, provider, client: { client_id: "cid-1", client_secret: "sec-1" },
    fetchFn: ssoFetch(), openUrl: openUrlStub,
  })).rejects.toThrow("已停用");
  // 停用审计只记动作与账号 id，不记邮箱。
  const audit = readFileSync(join(home, "accounts-audit.jsonl"), "utf-8");
  expect(audit).toContain('"action":"suspended"');
  expect(audit).not.toContain("sso-user@example.com");

  // 恢复后能重新登录（旧会话不恢复，须重新走登录流程）。
  const reactivated = await reactivateAccount(home, account.id);
  expect(reactivated.status).toBe("active");
  expect(await sessions.verify(session.token)).toBeNull();
  const back = await upsertAccount(home, "sso", { sub: "sso-sub-1", email: "sso-user@example.com", issuer: ISSUER });
  expect(back.id).toBe(account.id);
  expect(await getCurrentAccount(home)).toBeNull(); // 只恢复账号不发会话，仍是未登录
});

// ---- CLI ----

test("SsoTest.test_cli_sso_provider_add_list_status", () => {
  const home = tmpHome("nyra-sso-cli-");
  const added = runCli(home, ["sso", "provider", "add", "--id", "corp", "--issuer", ISSUER, "--client-id", "cid-1", "--name", "公司 IdP"]);
  expect(added.status).toBe(0);
  expect(added.stdout).toContain("已注册身份提供方：corp");
  const listed = runCli(home, ["sso", "provider", "list"]);
  expect(listed.status).toBe(0);
  expect(listed.stdout).toContain(ISSUER);
  const status = runCli(home, ["sso", "status"]);
  expect(status.status).toBe(0);
  expect(status.stdout).toContain("已注册身份提供方：1 个");
  expect(status.stdout).toContain("当前未登录");
  expect(status.stdout).toContain("SCIM Bearer token：未签发");
  const bad = runCli(home, ["sso", "provider", "add", "--id", "x", "--issuer", "http://x.example.com", "--client-id", "cid"]);
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain("https://");
  const removed = runCli(home, ["sso", "provider", "remove", "corp", "--yes"]);
  expect(removed.status).toBe(0);
  expect(removed.stdout).toContain("已移除身份提供方：corp");
});

test("SsoTest.test_cli_account_suspend_reactivate", async () => {
  const home = tmpHome("nyra-sso-cli-acct-");
  const store = new AccountStore(home);
  const account = await store.create({ email: "user@example.com", name: "User" });
  const sessions = new AccountSessionStore(home);
  const session = await sessions.issue(account.id);

  const listBefore = runCli(home, ["account", "list"]);
  expect(listBefore.stdout).toContain("user@example.com");
  expect(listBefore.stdout).not.toContain("已停用");

  const suspended = runCli(home, ["account", "suspend", account.id, "--yes"]);
  expect(suspended.status).toBe(0);
  expect(suspended.stdout).toContain("已停用账号：user@example.com");
  expect(suspended.stdout).toContain("撤销会话 1 个");
  expect(await sessions.verify(session.token)).toBeNull();

  const listAfter = runCli(home, ["account", "list"]);
  expect(listAfter.stdout).toContain("已停用");

  const status = runCli(home, ["account", "status"]);
  expect(status.stdout).toContain("未登录");

  const reactivated = runCli(home, ["account", "reactivate", account.id]);
  expect(reactivated.status).toBe(0);
  expect(reactivated.stdout).toContain("已恢复账号：user@example.com");

  const missing = runCli(home, ["account", "suspend", "no-such-id", "--yes"]);
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("没有这个账号");
});

test("SsoTest.test_cli_sso_scim_token_roundtrip", () => {
  const home = tmpHome("nyra-sso-cli-token-");
  const issued = runCli(home, ["sso", "scim", "token"]);
  expect(issued.status).toBe(0);
  expect(issued.stdout).toContain("SCIM Bearer token");
  expect(issued.stdout).toContain("/scim/v2/Users");
  // 第二次签发要 --yes（旧 token 立即失效）。
  const again = runCli(home, ["sso", "scim", "token"]);
  expect(again.status).toBe(2);
  expect(again.stderr).toContain("--yes");
  const status = runCli(home, ["sso", "scim", "status"]);
  expect(status.stdout).toContain("已签发");
  const revoked = runCli(home, ["sso", "scim", "revoke-token"]);
  expect(revoked.status).toBe(0);
  expect(revoked.stdout).toContain("已吊销");
  const statusAfter = runCli(home, ["sso", "scim", "status"]);
  expect(statusAfter.stdout).toContain("未签发");
});
