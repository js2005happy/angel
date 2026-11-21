// tests/node/test-gateway-scim.test.ts — 缺口 43 第二批：SCIM 网关挂载。
// 走真实 Gateway.start() + fetch：Bearer 对上能调、错 token 401、无 token 401，
// SCIM 不走 X-Nyra-Token。mock-only：token 与账号预置在临时 home 里。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { AccountStore } from "../../src/accounts.ts";
import { issueScimToken } from "../../src/scim.ts";

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-gw-scim-"));
}

async function startGateway(home: string, workdir: string) {
  const gw = new Gateway({
    home, workdir, host: "127.0.0.1", port: 0, mode: "full",
    config: { mcp_enabled: false, fallback_enabled: false },
  });
  const info = await gw.start();
  return { gw, info };
}

test("GatewayScimTest.test_scim_bearer_auth_via_gateway", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-scim-wd-"));
  const directory = new AccountStore(home);
  const account = await directory.create({ email: "owner@example.com", name: "机主" });
  const { token } = issueScimToken(home);

  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;

    // 1. 无 token → 401。
    const noToken = await fetch(`${base}/scim/v2/Users`);
    expect(noToken.status).toBe(401);

    // 2. 错 token → 401。
    const badToken = await fetch(`${base}/scim/v2/Users`, { headers: { Authorization: "Bearer wrong-token" } });
    expect(badToken.status).toBe(401);

    // 3. X-Nyra-Token 不是 SCIM 的凭证 → 401（SCIM 只认自己的 Bearer token）。
    const wrongScheme = await fetch(`${base}/scim/v2/Users`, { headers: { "X-Nyra-Token": token } });
    expect(wrongScheme.status).toBe(401);

    // 4. 正确 Bearer → 200，列表里有预置账号。
    const list = await fetch(`${base}/scim/v2/Users`, { headers: { Authorization: "Bearer " + token } });
    expect(list.status).toBe(200);
    const listBody = await list.json() as { totalResults: number; Resources: { id: string; userName: string }[] };
    expect(listBody.totalResults).toBe(1);
    expect(listBody.Resources[0].userName).toBe("owner@example.com");

    // 5. 经网关建用户 → 201，再查得到。
    const created = await fetch(`${base}/scim/v2/Users`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ userName: "gw-user@example.com", displayName: "网关用户" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { id: string; userName: string };
    expect(createdBody.userName).toBe("gw-user@example.com");

    const one = await fetch(`${base}/scim/v2/Users/${createdBody.id}`, { headers: { Authorization: "Bearer " + token } });
    expect(one.status).toBe(200);

    // 6. 元数据端点同样要 Bearer。
    const configNoToken = await fetch(`${base}/scim/v2/ServiceProviderConfig`);
    expect(configNoToken.status).toBe(401);
    const config = await fetch(`${base}/scim/v2/ServiceProviderConfig`, { headers: { Authorization: "Bearer " + token } });
    expect(config.status).toBe(200);

    // 7. 网关里建的用户落到文件版 store 里了。
    expect((await directory.findByEmail("gw-user@example.com"))?.id).toBe(createdBody.id);
    expect(account.id).toBeTruthy();
  } finally {
    await gw.stop();
  }
});

test("GatewayScimTest.test_scim_without_token_configured_is_401", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-scim-wd2-"));
  // 不签发 token：任何 Bearer 都 401（未配 token 时不放行）。
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const res = await fetch(`${base}/scim/v2/Users`, { headers: { Authorization: "Bearer anything" } });
    expect(res.status).toBe(401);
  } finally {
    await gw.stop();
  }
});
