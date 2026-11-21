// tests/node/test-scim.test.ts — SCIM 2.0 账号开通（缺口 43 第二批，SSO/SCIM）。
// Bearer token 签发/校验/吊销、Users 增删改查与停用/恢复、Groups 增删改查与
// 角色映射、handleScimRequest 端到端。全部 mock-only：不碰真 IdP、不碰真
// SCIM 客户端、不碰真 Postgres（文件版 store）。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, AccountSessionStore } from "../../src/accounts.ts";
import {
  issueScimToken, scimTokenConfigured, revokeScimToken, verifyScimToken,
  handleScimRequest, createScimGroup, loadScimGroups,
  type ScimRequest,
} from "../../src/scim.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function setup() {
  const home = tmpHome("nyra-scim-");
  const directory = new AccountStore(home);
  const owner = await directory.create({ email: "owner@example.com", name: "机主" });
  const user = await directory.create({ email: "user@example.com", name: "普通用户" });
  const { token } = issueScimToken(home);
  return { home, directory, owner, user, token };
}

function call(home: string, token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req: ScimRequest = {
    method,
    path,
    home,
    headers: token ? { authorization: "Bearer " + token } : {},
    ...(body !== undefined ? { bodyText: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  };
  return handleScimRequest(req);
}

// ---- Bearer token ----

test("ScimTest.test_token_issue_verify_revoke", () => {
  const home = tmpHome("nyra-scim-token-");
  expect(scimTokenConfigured(home)).toBe(false);
  expect(verifyScimToken(home, "Bearer anything")).toBe(false);
  const { token, sha256 } = issueScimToken(home);
  expect(token.length).toBeGreaterThanOrEqual(40);
  expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(scimTokenConfigured(home)).toBe(true);
  expect(verifyScimToken(home, "Bearer " + token)).toBe(true);
  expect(verifyScimToken(home, "Bearer " + token + "x")).toBe(false);
  expect(verifyScimToken(home, null)).toBe(false);
  expect(verifyScimToken(home, "Basic abc")).toBe(false);
  // 磁盘上只有 SHA-256，没有 token 原文。
  const stored = readFileSync(join(home, "scim-token.json"), "utf-8");
  expect(stored).toContain(sha256);
  expect(stored).not.toContain(token);
  // 重签发会换掉 token（旧 token 立即失效）。
  const second = issueScimToken(home);
  expect(verifyScimToken(home, "Bearer " + token)).toBe(false);
  expect(verifyScimToken(home, "Bearer " + second.token)).toBe(true);
  expect(revokeScimToken(home)).toBe(true);
  expect(revokeScimToken(home)).toBe(false);
  expect(scimTokenConfigured(home)).toBe(false);
  expect(verifyScimToken(home, "Bearer " + second.token)).toBe(false);
});

// ---- Users 生命周期 ----

test("ScimTest.test_users_lifecycle", async () => {
  const { home, directory, owner, token } = await setup();
  const sessions = new AccountSessionStore(home);
  const session = await sessions.issue(owner.id);

  // 无 token / 错 token → 401。
  expect((await call(home, null, "GET", "/scim/v2/Users")).status).toBe(401);
  expect((await call(home, "bad-token", "GET", "/scim/v2/Users")).status).toBe(401);

  // 建用户：201，active 默认 true；重复邮箱 → 409。
  const created = await call(home, token, "POST", "/scim/v2/Users", {
    userName: "new@example.com", displayName: "新人", externalId: "ext-100",
  });
  expect(created.status).toBe(201);
  const newId = created.body.id as string;
  expect(created.body.userName).toBe("new@example.com");
  expect(created.body.active).toBe(true);
  expect(created.body.externalId).toBe("ext-100");
  const dup = await call(home, token, "POST", "/scim/v2/Users", { userName: "new@example.com" });
  expect(dup.status).toBe(409);
  const noName = await call(home, token, "POST", "/scim/v2/Users", { displayName: "没邮箱" });
  expect(noName.status).toBe(400);

  // 查：单个 + 列表 + filter + 分页。
  const one = await call(home, token, "GET", "/scim/v2/Users/" + newId);
  expect(one.status).toBe(200);
  expect(one.body.emails).toEqual([{ value: "new@example.com", primary: true }]);
  const list = await call(home, token, "GET", "/scim/v2/Users");
  expect(list.status).toBe(200);
  expect(list.body.totalResults).toBe(3);
  const filtered = await call(home, token, "GET", '/scim/v2/Users?filter=userName%20eq%20%22new%40example.com%22');
  expect(filtered.body.totalResults).toBe(1);
  const activeOnly = await call(home, token, "GET", "/scim/v2/Users?filter=active%20eq%20true");
  expect(activeOnly.body.totalResults).toBe(3);
  const paged = await call(home, token, "GET", "/scim/v2/Users?startIndex=2&count=1");
  expect(paged.body.itemsPerPage).toBe(1);
  expect(paged.body.startIndex).toBe(2);
  const badFilter = await call(home, token, "GET", "/scim/v2/Users?filter=name%20sw%20%22a%22");
  expect(badFilter.status).toBe(400);
  const missing = await call(home, token, "GET", "/scim/v2/Users/no-such-id");
  expect(missing.status).toBe(404);

  // PATCH 停用：active=false → 账号停用 + 旧会话同步撤销（别人的会话不受影响）。
  const newSession = await sessions.issue(newId);
  expect(await sessions.verify(newSession.token)).not.toBeNull();
  const deactivated = await call(home, token, "PATCH", "/scim/v2/Users/" + newId, {
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  expect(deactivated.status).toBe(200);
  expect(deactivated.body.active).toBe(false);
  const suspended = await directory.findById(newId);
  expect(suspended?.status).toBe("suspended");
  expect(await sessions.verify(newSession.token)).toBeNull();
  expect(await sessions.verify(session.token)).not.toBeNull();

  // PATCH 恢复：active=true（空路径整对象形式）→ 账号恢复（旧会话不恢复）。
  const reactivated = await call(home, token, "PATCH", "/scim/v2/Users/" + newId, {
    Operations: [{ op: "replace", value: { active: true } }],
  });
  expect(reactivated.status).toBe(200);
  expect(reactivated.body.active).toBe(true);
  expect((await directory.findById(newId))?.status).toBe("active");
  expect(await sessions.verify(newSession.token)).toBeNull();

  // userName / 邮箱不可改。
  const rename = await call(home, token, "PATCH", "/scim/v2/Users/" + newId, {
    Operations: [{ op: "replace", path: "userName", value: "other@example.com" }],
  });
  expect(rename.status).toBe(400);
  const putRename = await call(home, token, "PUT", "/scim/v2/Users/" + newId, {
    userName: "other@example.com", active: true,
  });
  expect(putRename.status).toBe(400);

  // DELETE：账号仍在（备审计），但已停用 + externalId 已清。
  const deleted = await call(home, token, "DELETE", "/scim/v2/Users/" + newId);
  expect(deleted.status).toBe(204);
  const afterDelete = await directory.findById(newId);
  expect(afterDelete).not.toBeNull();
  expect(afterDelete?.status).toBe("suspended");
  expect(afterDelete?.external_id).toBeUndefined();
  const getAfterDelete = await call(home, token, "GET", "/scim/v2/Users/" + newId);
  expect(getAfterDelete.status).toBe(200);
  expect(getAfterDelete.body.active).toBe(false);
});

test("ScimTest.test_scim_errors_and_metadata", async () => {
  const { home, token } = await setup();
  // 坏 JSON → 400；未知路由 → 404；未知资源 → 404。
  const badJson = await call(home, token, "POST", "/scim/v2/Users", "{not json");
  expect(badJson.status).toBe(400);
  expect((badJson.body.schemas as string[])[0]).toContain("Error");
  const unknownRoute = await call(home, token, "GET", "/scim/v2/Whatever");
  expect(unknownRoute.status).toBe(404);
  const unknownPath = await call(home, token, "GET", "/other/path");
  expect(unknownPath.status).toBe(404);
  const wrongMethod = await call(home, token, "PUT", "/scim/v2/Users");
  expect(wrongMethod.status).toBe(405);
  // 元数据端点。
  const config = await call(home, token, "GET", "/scim/v2/ServiceProviderConfig");
  expect(config.status).toBe(200);
  expect((config.body.authenticationSchemes as { type: string }[])[0].type).toBe("oauthbearertoken");
  const types = await call(home, token, "GET", "/scim/v2/ResourceTypes");
  expect(types.status).toBe(200);
  expect(types.body.totalResults).toBe(2);
  const schemas = await call(home, token, "GET", "/scim/v2/Schemas");
  expect(schemas.status).toBe(200);
  expect(schemas.body.totalResults).toBe(2);
});

// ---- Groups 与角色映射 ----

test("ScimTest.test_groups_lifecycle_and_role_mapping", async () => {
  const { home, directory, owner, user, token } = await setup();
  expect(owner.role).toBe("owner");
  expect(user.role).toBe("user");

  // 建 owner 组带成员 → 成员提权。
  const admins = await call(home, token, "POST", "/scim/v2/Groups", {
    displayName: "Admins", role: "owner", members: [{ value: user.id }],
  });
  expect(admins.status).toBe(201);
  const adminsId = admins.body.id as string;
  expect((await directory.findById(user.id))?.role).toBe("owner");

  // 建 user 组带成员 → 不降级（owner 还是 owner）。
  const staff = await call(home, token, "POST", "/scim/v2/Groups", {
    displayName: "Staff", role: "user", members: [{ value: user.id }],
  });
  expect(staff.status).toBe(201);
  expect((await directory.findById(user.id))?.role).toBe("owner");
  // 同名群组 → 409；成员不存在 → 400。
  const dup = await call(home, token, "POST", "/scim/v2/Groups", { displayName: "Admins" });
  expect(dup.status).toBe(409);
  const badMember = await call(home, token, "POST", "/scim/v2/Groups", {
    displayName: "Ghost", members: [{ value: "no-such-account" }],
  });
  expect(badMember.status).toBe(400);

  // 查：单个 + 列表。
  const one = await call(home, token, "GET", "/scim/v2/Groups/" + adminsId);
  expect(one.status).toBe(200);
  expect((one.body.members as { value: string }[]).map((m) => m.value)).toContain(user.id);
  const list = await call(home, token, "GET", "/scim/v2/Groups");
  expect(list.body.totalResults).toBe(2);

  // PATCH 加成员进 owner 组 → 提权；PATCH 移除成员 → 离组不降级。
  const third = await directory.create({ email: "third@example.com", name: "第三人" });
  expect(third.role).toBe("user");
  const added = await call(home, token, "PATCH", "/scim/v2/Groups/" + adminsId, {
    Operations: [{ op: "add", path: "members", value: [{ value: third.id }] }],
  });
  expect(added.status).toBe(200);
  expect((await directory.findById(third.id))?.role).toBe("owner");
  const removed = await call(home, token, "PATCH", "/scim/v2/Groups/" + adminsId, {
    Operations: [{ op: "remove", path: `members[value eq "${third.id}"]` }],
  });
  expect(removed.status).toBe(200);
  expect((removed.body.members as { value: string }[]).map((m) => m.value)).not.toContain(third.id);
  expect((await directory.findById(third.id))?.role).toBe("owner"); // 离组不降级

  // PUT 全量替换成员。
  const put = await call(home, token, "PUT", "/scim/v2/Groups/" + adminsId, {
    displayName: "Admins", members: [{ value: owner.id }],
  });
  expect(put.status).toBe(200);
  expect((put.body.members as { value: string }[]).map((m) => m.value)).toEqual([owner.id]);

  // DELETE 群组 → 204；再查 → 404。
  const deleted = await call(home, token, "DELETE", "/scim/v2/Groups/" + adminsId);
  expect(deleted.status).toBe(204);
  const gone = await call(home, token, "GET", "/scim/v2/Groups/" + adminsId);
  expect(gone.status).toBe(404);
});

test("ScimTest.test_delete_user_removes_from_groups", async () => {
  const { home, directory, user, token } = await setup();
  const group = await createScimGroup(home, { displayName: "Team", members: [user.id] });
  expect(loadScimGroups(home).find((g) => g.id === group.id)?.members).toContain(user.id);
  const deleted = await call(home, token, "DELETE", "/scim/v2/Users/" + user.id);
  expect(deleted.status).toBe(204);
  expect(loadScimGroups(home).find((g) => g.id === group.id)?.members).not.toContain(user.id);
  // 账号记录保留备审计。
  expect(await directory.findById(user.id)).not.toBeNull();
});

test("ScimTest.test_scim_audit_writes_no_email_no_token", async () => {
  const { home, token } = await setup();
  await call(home, token, "POST", "/scim/v2/Users", { userName: "audit@example.com", externalId: "ext-9" });
  await call(home, token, "POST", "/scim/v2/Groups", { displayName: "AuditGroup" });
  const audit = readFileSync(join(home, "sso-audit.jsonl"), "utf-8");
  expect(audit).toContain('"action":"scim_user_created"');
  expect(audit).toContain('"action":"scim_group_created"');
  expect(audit).not.toContain("audit@example.com");
  expect(audit).not.toContain(token);
});
