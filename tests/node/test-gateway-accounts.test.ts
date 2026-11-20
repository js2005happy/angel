// tests/node/test-gateway-accounts.test.ts — 缺口 41 下一批：账号会话网关接线。
// 覆盖三路鉴权（owner / 设备 / 账号会话）、GET /api/account、POST /api/account/magic-link 兑换。
// mock-only：账号与会话预置在临时 home 里，不碰真 OAuth / 真邮件。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { AccountStore, AccountSessionStore, MagicLinkStore } from "../../src/accounts.ts";

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-gw-acct-"));
}

async function startGateway(home: string, workdir: string) {
  const gw = new Gateway({
    home, workdir, host: "127.0.0.1", port: 0, mode: "full",
    config: { mcp_enabled: false, fallback_enabled: false },
  });
  const info = await gw.start();
  return { gw, info };
}

test("GatewayAccountsTest.test_account_session_auth_and_get_account", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-acct-wd-"));
  // 预置一个账号 + 会话：owner 角色账号（等同 owner token）。
  const directory = new AccountStore(home);
  const account = await directory.create({ email: "owner@example.com", name: "机主" });
  const sessions = new AccountSessionStore(home);
  const session = await sessions.issue(account.id);

  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;

    // 1. 账号会话 token 鉴权：GET /api/account 返回当前账号。
    const acctRes = await fetch(`${base}/api/account`, { headers: { "X-Nyra-Token": session.token } });
    expect(acctRes.status).toBe(200);
    const acctBody = await acctRes.json() as { account: { id: string; email: string; role: string } | null };
    expect(acctBody.account).not.toBeNull();
    expect(acctBody.account!.email).toBe("owner@example.com");
    expect(acctBody.account!.role).toBe("owner");

    // 2. 无 token：/api/account 返回 account:null（而非 403，因为该端点本身需要
    //    先过 apiAuth？不——这里走通用鉴权，无 token 应 403）。
    const noToken = await fetch(`${base}/api/account`);
    expect(noToken.status).toBe(403);

    // 3. owner 角色账号等同 owner：能访问 owner-only 端点（如 /api/devices）。
    const devicesRes = await fetch(`${base}/api/devices`, { headers: { "X-Nyra-Token": session.token } });
    expect(devicesRes.status).toBe(200);

    // 4. 无效会话 token：403。
    const badToken = await fetch(`${base}/api/account`, { headers: { "X-Nyra-Token": "not-a-valid-token" } });
    expect(badToken.status).toBe(403);
  } finally {
    await gw.stop();
  }
});

test("GatewayAccountsTest.test_user_role_account_is_readonly", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-acct-wd-"));
  // 预置一个 user 角色账号（先建 owner，再建 user）。
  const directory = new AccountStore(home);
  await directory.create({ email: "owner@example.com" }); // 第一个是 owner
  const user = await directory.create({ email: "user@example.com" });
  expect(user.role).toBe("user");
  const sessions = new AccountSessionStore(home);
  const session = await sessions.issue(user.id);

  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;

    // user 角色账号：/api/account 能看自己（200），但 owner-only 端点 403。
    const acctRes = await fetch(`${base}/api/account`, { headers: { "X-Nyra-Token": session.token } });
    expect(acctRes.status).toBe(200);
    const acctBody = await acctRes.json() as { account: { role: string } | null };
    expect(acctBody.account!.role).toBe("user");

    // owner-only 端点（/api/devices 需要 isOwner）：user 角色应 403。
    const devicesRes = await fetch(`${base}/api/devices`, { headers: { "X-Nyra-Token": session.token } });
    expect(devicesRes.status).toBe(403);
  } finally {
    await gw.stop();
  }
});

test("GatewayAccountsTest.test_magic_link_exchange_endpoint", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-acct-wd-"));
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;

    // 预置一个 magic link（模拟 requestMagicLink 已发出）。
    const magicLinks = new MagicLinkStore(home);
    const issued = await magicLinks.issue("new@example.com");

    // 用 query 里的 token 兑换（模拟邮件链接点开）。
    const res = await fetch(`${base}/api/account/magic-link?token=${encodeURIComponent(issued.token)}`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { account: { email: string; role: string }; session: { token: string; expires_at: string } };
    expect(body.account.email).toBe("new@example.com");
    expect(body.account.role).toBe("owner"); // 第一个账号是 owner
    expect(body.session.token.length).toBeGreaterThan(0);
    expect(body.session.expires_at.length).toBeGreaterThan(0);

    // 重放同一 token：401（一次性）。
    const replay = await fetch(`${base}/api/account/magic-link?token=${encodeURIComponent(issued.token)}`, { method: "POST" });
    expect(replay.status).toBe(401);

    // 无效 token：401。
    const bad = await fetch(`${base}/api/account/magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(bad.status).toBe(401);

    // 缺 token：400。
    const noToken = await fetch(`${base}/api/account/magic-link`, { method: "POST" });
    expect(noToken.status).toBe(400);
  } finally {
    await gw.stop();
  }
});
