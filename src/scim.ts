// src/scim.ts — SCIM 2.0 账号开通（缺口 43 第二批，SSO/SCIM）。
//
// RFC 7643（Schema）+ RFC 7644（Protocol）：
//   - Users 映射到缺口 41 的账号：userName = 邮箱，active = status !== "suspended"。
//     SCIM 里建的用户没有 provider 身份（IdP 只给邮箱与外部 id），
//     登录仍要走 SSO/Google/GitHub/邮箱任一方式链身份——SCIM 只开通，不发凭证；
//   - Groups 是自有账本 `~/.nyra/scim-groups.json`（0600、原子写），
//     群组可选 role：进 owner 组提权（user → owner），进 user 组不降级、
//     也不静默降权；离组不降级（降权必须管理员显式做）；
//   - 鉴权：Bearer token（`nyra sso scim token` 签发，随机 32 字节，
//     磁盘只存 SHA-256，原文只打印一次；timingSafeEqual 比对，
//     未配 token 或验不过一律 401）；
//   - handleScimRequest 是纯函数（不依赖 server，返回 { status, body }），
//     网关在 /api/ 通用鉴权之前挂载 /scim/v2（见 gateway.ts）。
//
// 删除 = 停用 + 清 externalId + 移出全部群组：账号记录保留备审计，不硬删。
// 停用后立即失能（suspendAccount 撤销全部会话，见 accounts.ts）。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNyraHome, atomicTmpPath } from "./memory.ts";
import {
  AccountError,
  AccountStore,
  reactivateAccount,
  suspendAccount,
  type Account,
  type AccountRole,
  type AccountsStores,
} from "./accounts.ts";
import { appendSsoAudit, mirrorEvent, type SsoAuditAction } from "./sso.ts";

export class ScimError extends Error {
  readonly status: number;
  readonly scimType?: string;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.name = "ScimError";
    this.status = status;
    this.scimType = scimType;
  }
}

/** SCIM 群组账本（0600、原子写）。 */
export const SCIM_GROUPS_FILE = "scim-groups.json";
/** SCIM Bearer token（只存 SHA-256，0600）。 */
export const SCIM_TOKEN_FILE = "scim-token.json";
export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

export interface ScimGroup {
  id: string;
  displayName: string;
  /** 群组角色：进 owner 组提权；user 组不降级。 */
  role?: AccountRole;
  members: string[];
  created_at: string;
  updated_at: string;
}

function newId(): string {
  return randomBytes(12).toString("hex");
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = atomicTmpPath(path);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 1), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function readJsonFile<T>(path: string, label: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    const backup = path + ".corrupt-" + String(process.pid) + "-" + randomBytes(4).toString("hex");
    try {
      writeFileSync(backup, raw, { encoding: "utf-8", mode: 0o600 });
    } catch {
      /* 备份写不进去也不拦抛错本身 */
    }
    throw new ScimError(500, label + "损坏（已备份到 " + backup + "），请检查后恢复或删除重建");
  }
}

function isGroup(item: unknown): item is ScimGroup {
  return !!item && typeof item === "object" &&
    typeof (item as ScimGroup).id === "string" &&
    typeof (item as ScimGroup).displayName === "string" &&
    Array.isArray((item as ScimGroup).members);
}

function groupsPath(home: string): string {
  return join(resolveNyraHome(home), SCIM_GROUPS_FILE);
}

export function loadScimGroups(home: string): ScimGroup[] {
  const data = readJsonFile<{ groups?: unknown }>(groupsPath(home), "SCIM 群组账本");
  if (!data) return [];
  const items = Array.isArray(data.groups) ? data.groups : [];
  return items.filter(isGroup);
}

function saveScimGroups(home: string, groups: ScimGroup[]): void {
  atomicWriteJson(groupsPath(home), { version: 1, groups });
}

function audit(home: string, action: SsoAuditAction, fields: Record<string, unknown>): void {
  appendSsoAudit(home, { action, ...fields });
  mirrorEvent(home, null, action, fields);
}

// ---- SCIM Bearer token --------------------------------------------------

function tokenPath(home: string): string {
  return join(resolveNyraHome(home), SCIM_TOKEN_FILE);
}

function readTokenHash(home: string): string | null {
  const data = readJsonFile<{ sha256?: unknown }>(tokenPath(home), "SCIM token 文件");
  return typeof data?.sha256 === "string" && data.sha256 ? data.sha256 : null;
}

/** 签发 SCIM Bearer token（随机 32 字节；磁盘只存 SHA-256，原文只返回这一次）。 */
export function issueScimToken(home: string): { token: string; sha256: string } {
  const token = randomBytes(32).toString("base64url");
  const sha256 = createHash("sha256").update(token, "utf-8").digest("hex");
  atomicWriteJson(tokenPath(home), { sha256 });
  return { token, sha256 };
}

export function scimTokenConfigured(home: string): boolean {
  return readTokenHash(home) !== null;
}

export function revokeScimToken(home: string): boolean {
  const path = tokenPath(home);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** 验 Authorization: Bearer（未配 token 或验不过都按 false；timingSafeEqual，比对前先比长度防抛错）。 */
export function verifyScimToken(home: string, authorization: string | null | undefined): boolean {
  const stored = readTokenHash(home);
  if (!stored) return false;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const given = authorization.slice("Bearer ".length).trim();
  if (!given) return false;
  const givenHash = createHash("sha256").update(given, "utf-8").digest("hex");
  const a = Buffer.from(givenHash, "utf-8");
  const b = Buffer.from(stored, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---- SCIM 资源序列化 ----------------------------------------------------

export function toScimUser(account: Account, groups: ScimGroup[]): Record<string, unknown> {
  const memberships = groups
    .filter((g) => g.members.includes(account.id))
    .map((g) => ({ value: g.id, display: g.displayName }));
  const out: Record<string, unknown> = {
    schemas: [SCIM_USER_SCHEMA],
    id: account.id,
    userName: account.email,
    displayName: account.name,
    active: account.status !== "suspended",
    emails: [{ value: account.email, primary: true }],
    meta: {
      resourceType: "User",
      created: account.created_at,
      lastModified: account.last_seen,
    },
    ...(memberships.length ? { groups: memberships } : {}),
  };
  if (account.external_id) out.externalId = account.external_id;
  return out;
}

export function toScimGroup(group: ScimGroup, accounts: Account[]): Record<string, unknown> {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    displayName: group.displayName,
    members: group.members
      .map((id) => accounts.find((a) => a.id === id))
      .filter((a): a is Account => !!a)
      .map((a) => ({ value: a.id, display: a.name })),
    meta: {
      resourceType: "Group",
      created: group.created_at,
      lastModified: group.updated_at,
    },
  };
}

// ---- 群组 CRUD（带角色映射） --------------------------------------------

export async function createScimGroup(
  home: string,
  input: { displayName: string; role?: AccountRole; members?: string[] },
  opts?: { stores?: AccountsStores },
): Promise<ScimGroup> {
  const name = (input.displayName ?? "").trim();
  if (!name) throw new ScimError(400, "displayName 不能为空", "invalidValue");
  if (input.role && input.role !== "owner" && input.role !== "user") throw new ScimError(400, "role 只允许 owner 或 user", "invalidValue");
  const directory = opts?.stores?.directory ?? new AccountStore(home);
  // 成员先全部校验存在，再建组（避免建了一半才发现成员不存在）。
  for (const memberId of input.members ?? []) {
    const member = await directory.findById(memberId);
    if (!member) throw new ScimError(400, "成员账号不存在：" + memberId, "invalidValue");
  }
  const groups = loadScimGroups(home);
  if (groups.some((g) => g.displayName === name)) throw new ScimError(409, "已存在同名群组", "uniqueness");
  const now = new Date().toISOString();
  const group: ScimGroup = {
    id: newId(),
    displayName: name,
    ...(input.role ? { role: input.role } : {}),
    members: [],
    created_at: now,
    updated_at: now,
  };
  groups.push(group);
  saveScimGroups(home, groups);
  for (const memberId of input.members ?? []) {
    addGroupMemberToLedger(home, group.id, memberId);
  }
  // 进 owner 组提权（user → owner）；进 user 组不降级、离组不降级。
  if (input.role === "owner") {
    for (const memberId of input.members ?? []) {
      const member = await directory.findById(memberId);
      if (member && member.role !== "owner") await directory.setRole(memberId, "owner");
    }
  }
  audit(home, "scim_group_created", { group_id: group.id });
  return loadScimGroups(home).find((g) => g.id === group.id) ?? group;
}

export function deleteScimGroup(home: string, groupId: string): boolean {
  const groups = loadScimGroups(home);
  const next = groups.filter((g) => g.id !== groupId);
  if (next.length === groups.length) return false;
  saveScimGroups(home, next);
  audit(home, "scim_group_deleted", { group_id: groupId });
  return true;
}

/** 纯账本写：把账号 id 加进群组成员（调用方须先校验群组与账号都存在）。 */
function addGroupMemberToLedger(home: string, groupId: string, accountId: string): ScimGroup {
  const groups = loadScimGroups(home);
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw new ScimError(404, "群组不存在", "invalidValue");
  if (!group.members.includes(accountId)) group.members.push(accountId);
  group.updated_at = new Date().toISOString();
  saveScimGroups(home, groups);
  return group;
}

/**
 * 成员进组：账号不存在直接报错；进 owner 组提权（user → owner），
 * 进 user 组不降级、离组不降级——降权必须管理员显式做，不静默降权。
 */
export async function addGroupMember(
  home: string,
  groupId: string,
  accountId: string,
  opts?: { stores?: AccountsStores },
): Promise<ScimGroup> {
  const directory = opts?.stores?.directory ?? new AccountStore(home);
  const account = await directory.findById(accountId);
  if (!account) throw new ScimError(400, "成员账号不存在：" + accountId, "invalidValue");
  const group = addGroupMemberToLedger(home, groupId, accountId);
  if (group.role === "owner" && account.role !== "owner") {
    await directory.setRole(accountId, "owner");
  }
  return group;
}

export function removeGroupMember(home: string, groupId: string, accountId: string): ScimGroup | null {
  const groups = loadScimGroups(home);
  const group = groups.find((g) => g.id === groupId);
  if (!group) return null;
  group.members = group.members.filter((m) => m !== accountId);
  group.updated_at = new Date().toISOString();
  saveScimGroups(home, groups);
  return group;
}

export function removeAccountFromAllGroups(home: string, accountId: string): void {
  const groups = loadScimGroups(home);
  let changed = false;
  for (const g of groups) {
    const next = g.members.filter((m) => m !== accountId);
    if (next.length !== g.members.length) {
      g.members = next;
      g.updated_at = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveScimGroups(home, groups);
}

// ---- SCIM 协议处理（纯函数：不依赖 server，返回 { status, body }） -------

export interface ScimRequest {
  method: string;
  path: string;
  /** 请求头（值可能是 string[]，取 Authorization 时只取首个）。 */
  headers?: Record<string, string | string[] | undefined>;
  bodyText?: string;
  home: string;
  stores?: AccountsStores;
  clock?: () => number;
}

export interface ScimResponse {
  status: number;
  body: Record<string, unknown>;
}

function scimError(status: number, detail: string, scimType?: string): ScimResponse {
  const body: Record<string, unknown> = {
    schemas: [SCIM_ERROR_SCHEMA],
    detail,
    status: String(status),
  };
  if (scimType) body.scimType = scimType;
  return { status, body };
}

function listResponse(resources: Record<string, unknown>[], startIndex: number, totalResults: number): ScimResponse {
  return {
    status: 200,
    body: {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    },
  };
}

function parseBody(bodyText: string | undefined): Record<string, unknown> {
  if (!bodyText) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new ScimError(400, "请求体不是合法 JSON", "invalidSyntax");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ScimError(400, "请求体必须是 JSON 对象", "invalidValue");
  }
  return parsed as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** 解析 list 的 filter：只支持 userName eq / emails.value eq / active eq（其余回 400，不猜）。 */
function applyUserFilter(accounts: Account[], filter: string | null): Account[] {
  if (!filter) return accounts;
  const quoted = filter.match(/^([A-Za-z.]+)\s+eq\s+"([^"]*)"$/);
  const active = filter.match(/^active\s+eq\s+(true|false)$/);
  if (active) {
    const want = active[1] === "true";
    return accounts.filter((a) => (a.status !== "suspended") === want);
  }
  if (!quoted) throw new ScimError(400, "只支持 userName eq / emails.value eq / active eq 这三种 filter", "invalidFilter");
  const [, attr, value] = quoted;
  if (attr === "userName" || attr === "emails.value") {
    return accounts.filter((a) => a.email.toLowerCase() === value.toLowerCase());
  }
  throw new ScimError(400, "不支持的 filter 属性：" + attr, "invalidFilter");
}

function parsePaging(query: URLSearchParams): { startIndex: number; count: number } {
  const startIndex = Math.max(1, Number.parseInt(query.get("startIndex") ?? "1", 10) || 1);
  const count = Math.min(200, Math.max(1, Number.parseInt(query.get("count") ?? "100", 10) || 100));
  return { startIndex, count };
}

async function setUserActive(
  home: string,
  account: Account,
  active: boolean,
  opts: { stores?: AccountsStores; clock?: () => number },
): Promise<Account> {
  const isActive = account.status !== "suspended";
  if (active === isActive) return account;
  if (active) {
    const reactivated = await reactivateAccount(home, account.id, opts);
    audit(home, "scim_user_reactivated", { account_id: account.id });
    return reactivated;
  }
  const { account: suspended } = await suspendAccount(home, account.id, opts);
  audit(home, "scim_user_deactivated", { account_id: account.id });
  return suspended;
}

async function deleteUser(
  home: string,
  account: Account,
  opts: { stores?: AccountsStores; clock?: () => number },
): Promise<void> {
  // DELETE = 停用 + 清 externalId + 移出全部群组；账号记录保留备审计，不硬删。
  if (account.status !== "suspended") await suspendAccount(home, account.id, opts);
  const directory = opts.stores?.directory ?? new AccountStore(home);
  if (account.external_id) await directory.updateExternalId(account.id, null);
  removeAccountFromAllGroups(home, account.id);
  audit(home, "scim_user_deleted", { account_id: account.id });
}

export async function handleScimRequest(req: ScimRequest): Promise<ScimResponse> {
  const home = req.home;
  const method = req.method.toUpperCase();
  const [rawPath, rawQuery] = req.path.split("?");
  const path = rawPath.replace(/\/+$/, "") || "/";
  const query = new URLSearchParams(rawQuery ?? "");

  // SCIM 用自己的 Bearer token，不走 X-Nyra-Token。
  const authHeaderRaw = req.headers?.authorization ?? req.headers?.Authorization;
  const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;
  if (!verifyScimToken(home, authHeader)) {
    return scimError(401, "需要有效的 SCIM Bearer token");
  }

  const directory = req.stores?.directory ?? new AccountStore(home);
  const opts = { stores: req.stores, clock: req.clock };

  try {
    // ---- 元数据端点 ----
    if (path === "/scim/v2/ServiceProviderConfig" && method === "GET") {
      return {
        status: 200,
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
          documentationUri: "https://www.rfc-editor.org/rfc/rfc7644",
          patch: { supported: true },
          bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
          filter: { supported: true, maxResults: 200 },
          changePassword: { supported: false },
          sort: { supported: false },
          etag: { supported: false },
          authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token", description: "SCIM Bearer token（nyra sso scim token 签发）", specUri: "https://www.rfc-editor.org/rfc/rfc6750", primary: true }],
          meta: { resourceType: "ServiceProviderConfig", location: "/scim/v2/ServiceProviderConfig" },
        },
      };
    }
    if (path === "/scim/v2/ResourceTypes" && method === "GET") {
      return {
        status: 200,
        body: {
          schemas: [SCIM_LIST_SCHEMA],
          totalResults: 2,
          startIndex: 1,
          itemsPerPage: 2,
          Resources: [
            { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", description: "Nyra 账号", schema: SCIM_USER_SCHEMA, meta: { resourceType: "ResourceType", location: "/scim/v2/ResourceTypes/User" } },
            { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", description: "SCIM 群组", schema: SCIM_GROUP_SCHEMA, meta: { resourceType: "ResourceType", location: "/scim/v2/ResourceTypes/Group" } },
          ],
        },
      };
    }
    if (path === "/scim/v2/Schemas" && method === "GET") {
      return {
        status: 200,
        body: {
          schemas: [SCIM_LIST_SCHEMA],
          totalResults: 2,
          startIndex: 1,
          itemsPerPage: 2,
          Resources: [
            { id: SCIM_USER_SCHEMA, name: "User", description: "Nyra 账号", attributes: [{ name: "userName", type: "string", required: true }, { name: "active", type: "boolean" }, { name: "displayName", type: "string" }, { name: "externalId", type: "string" }, { name: "emails", type: "complex", multiValued: true }] },
            { id: SCIM_GROUP_SCHEMA, name: "Group", description: "SCIM 群组", attributes: [{ name: "displayName", type: "string", required: true }, { name: "members", type: "complex", multiValued: true }] },
          ],
        },
      };
    }

    const segments = path.split("/").filter(Boolean);
    if (segments[0] !== "scim" || segments[1] !== "v2") return scimError(404, "未知路由：" + path);
    const resource = segments[2];
    const resourceId = segments[3];
    if (segments.length > 4) return scimError(404, "未知路由：" + path);

    // ---- Users ----
    if (resource === "Users") {
      if (!resourceId) {
        if (method === "GET") {
          const accounts = await directory.listAccounts();
          const filtered = applyUserFilter(accounts, query.get("filter"));
          const { startIndex, count } = parsePaging(query);
          const page = filtered.slice(startIndex - 1, startIndex - 1 + count);
          const groups = loadScimGroups(home);
          return listResponse(page.map((a) => toScimUser(a, groups)), startIndex, filtered.length);
        }
        if (method === "POST") {
          const body = parseBody(req.bodyText);
          const userName = asString(body.userName);
          if (!userName) throw new ScimError(400, "userName（邮箱）不能为空", "invalidValue");
          const email = userName.trim().toLowerCase();
          if (!email.includes("@")) throw new ScimError(400, "userName 必须是邮箱", "invalidValue");
          const existing = await directory.findByEmail(email);
          if (existing) throw new ScimError(409, "该邮箱已有账号", "uniqueness");
          const displayName = asString(body.displayName);
          const externalId = asString(body.externalId);
          const active = body.active === undefined ? true : body.active === true;
          let account = await directory.create({
            email,
            ...(displayName ? { name: displayName } : {}),
            ...(externalId ? { external_id: externalId } : {}),
          });
          if (!active) {
            const suspended = await suspendAccount(home, account.id, opts);
            account = suspended.account;
          }
          audit(home, "scim_user_created", { account_id: account.id, ...(externalId ? { external_id: externalId } : {}) });
          const groups = loadScimGroups(home);
          return { status: 201, body: toScimUser(account, groups) };
        }
        return scimError(405, "Users 集合只支持 GET / POST");
      }

      const account = await directory.findById(resourceId);
      if (!account) return scimError(404, "用户不存在");
      const groups = loadScimGroups(home);

      if (method === "GET") {
        return { status: 200, body: toScimUser(account, groups) };
      }
      if (method === "DELETE") {
        await deleteUser(home, account, opts);
        return { status: 204, body: {} };
      }
      if (method === "PUT") {
        const body = parseBody(req.bodyText);
        const userName = asString(body.userName);
        if (userName && userName.trim().toLowerCase() !== account.email.toLowerCase()) {
          throw new ScimError(400, "userName（邮箱）不可改", "mutability");
        }
        let updated = account;
        const externalId = asString(body.externalId);
        // PUT 全量替换：displayName 不可通过 SCIM 改（没有改名接口，拒绝而不是静默丢弃），
        // externalId 为空按清除处理，active 缺省按当前状态。
        if ("displayName" in body) {
          throw new ScimError(400, "PUT 不改 displayName（改名请在 Nyra 里改）", "invalidValue");
        }
        if (externalId !== null || "externalId" in body) {
          updated = await directory.updateExternalId(account.id, externalId);
        }
        if (body.active !== undefined && typeof body.active === "boolean") {
          updated = await setUserActive(home, updated, body.active, opts);
        }
        if (Array.isArray(body.groups)) {
          // PUT 全量替换成员关系：先清出全部群组，再按新列表加回。
          removeAccountFromAllGroups(home, account.id);
          for (const item of body.groups as unknown[]) {
            const gid = typeof item === "object" && item !== null ? asString((item as Record<string, unknown>).value) : null;
            if (gid) {
              const target = loadScimGroups(home).find((g) => g.id === gid);
              if (!target) throw new ScimError(400, "群组不存在：" + gid, "invalidValue");
              await addGroupMember(home, gid, account.id, opts);
              if (target.role === "owner" && updated.role !== "owner") {
                updated = await directory.setRole(account.id, "owner");
              }
            }
          }
        }
        audit(home, "scim_user_updated", { account_id: account.id });
        return { status: 200, body: toScimUser(updated, loadScimGroups(home)) };
      }
      if (method === "PATCH") {
        const body = parseBody(req.bodyText);
        const operations = body.Operations;
        if (!Array.isArray(operations) || !operations.length) throw new ScimError(400, "PATCH 需要 Operations 数组", "invalidValue");
        let updated = account;
        for (const raw of operations as unknown[]) {
          if (!raw || typeof raw !== "object") throw new ScimError(400, "Operation 必须是对象", "invalidValue");
          const op = raw as Record<string, unknown>;
          const opName = String(op.op ?? "").toLowerCase();
          const opPath = typeof op.path === "string" ? op.path : "";
          const value = op.value;
          if (opName === "replace" && (opPath === "" || opPath === "active")) {
            const active = opPath === "" ? (value as Record<string, unknown> | undefined)?.active : value;
            if (typeof active !== "boolean") throw new ScimError(400, "active 必须是布尔值", "invalidValue");
            updated = await setUserActive(home, updated, active, opts);
            continue;
          }
          if (opName === "replace" && opPath === "displayName") {
            // 改名：同 PUT 的限制——没有改名接口，拒绝而不是静默丢弃。
            throw new ScimError(400, "displayName 不可通过 SCIM 改（请在 Nyra 里改名）", "mutability");
          }
          if ((opName === "replace" || opName === "add") && (opPath === "externalId" || (opPath === "" && value && typeof value === "object" && "externalId" in (value as Record<string, unknown>)))) {
            const ext = opPath === "externalId" ? asString(value) : asString((value as Record<string, unknown>).externalId);
            updated = await directory.updateExternalId(account.id, ext);
            continue;
          }
          if (opName === "remove" && opPath === "externalId") {
            updated = await directory.updateExternalId(account.id, null);
            continue;
          }
          if (opName === "add" && opPath === "groups") {
            const items = Array.isArray(value) ? value : [value];
            for (const item of items) {
              const gid = typeof item === "object" && item !== null ? asString((item as Record<string, unknown>).value) : null;
              if (!gid) throw new ScimError(400, "groups 成员需要 value（群组 id）", "invalidValue");
              const target = loadScimGroups(home).find((g) => g.id === gid);
              if (!target) throw new ScimError(400, "群组不存在：" + gid, "invalidValue");
              await addGroupMember(home, gid, account.id, opts);
              if (target.role === "owner" && updated.role !== "owner") updated = await directory.setRole(account.id, "owner");
            }
            continue;
          }
          if (opName === "remove" && opPath === "groups") {
            const items = Array.isArray(value) ? value : [value];
            for (const item of items) {
              const gid = typeof item === "object" && item !== null ? asString((item as Record<string, unknown>).value) : null;
              if (gid) removeGroupMember(home, gid, account.id);
            }
            continue;
          }
          if (opName === "replace" && opPath === "emails") {
            // 邮箱是账号标识，不可通过 SCIM 改。
            throw new ScimError(400, "emails（邮箱）不可改", "mutability");
          }
          if (opPath === "userName") throw new ScimError(400, "userName（邮箱）不可改", "mutability");
          throw new ScimError(400, "不支持的 PATCH 操作：" + opName + " " + opPath, "invalidValue");
        }
        audit(home, "scim_user_updated", { account_id: account.id });
        return { status: 200, body: toScimUser(updated, loadScimGroups(home)) };
      }
      return scimError(405, "Users 只支持 GET / PUT / PATCH / DELETE");
    }

    // ---- Groups ----
    if (resource === "Groups") {
      if (!resourceId) {
        if (method === "GET") {
          const groups = loadScimGroups(home);
          const { startIndex, count } = parsePaging(query);
          const accounts = await directory.listAccounts();
          const page = groups.slice(startIndex - 1, startIndex - 1 + count);
          return listResponse(page.map((g) => toScimGroup(g, accounts)), startIndex, groups.length);
        }
        if (method === "POST") {
          const body = parseBody(req.bodyText);
          const displayName = asString(body.displayName);
          if (!displayName) throw new ScimError(400, "displayName 不能为空", "invalidValue");
          const roleRaw = asString(body.role);
          const role: AccountRole | undefined = roleRaw === "owner" || roleRaw === "user" ? roleRaw : undefined;
          if (roleRaw && !role) throw new ScimError(400, "role 只允许 owner 或 user", "invalidValue");
          const memberIds: string[] = [];
          if (Array.isArray(body.members)) {
            for (const item of body.members as unknown[]) {
              const value = typeof item === "object" && item !== null ? asString((item as Record<string, unknown>).value) : null;
              if (!value) throw new ScimError(400, "members 成员需要 value（账号 id）", "invalidValue");
              const member = await directory.findById(value);
              if (!member) throw new ScimError(400, "成员账号不存在：" + value, "invalidValue");
              memberIds.push(value);
            }
          }
          const group = await createScimGroup(home, { displayName, ...(role ? { role } : {}), members: memberIds }, opts);
          const accounts = await directory.listAccounts();
          return { status: 201, body: toScimGroup(group, accounts) };
        }
        return scimError(405, "Groups 集合只支持 GET / POST");
      }

      const groups = loadScimGroups(home);
      const group = groups.find((g) => g.id === resourceId);
      if (!group) return scimError(404, "群组不存在");
      const accounts = await directory.listAccounts();

      if (method === "GET") {
        return { status: 200, body: toScimGroup(group, accounts) };
      }
      if (method === "DELETE") {
        deleteScimGroup(home, resourceId);
        return { status: 204, body: {} };
      }
      if (method === "PUT") {
        const body = parseBody(req.bodyText);
        const displayName = asString(body.displayName);
        if (!displayName) throw new ScimError(400, "displayName 不能为空", "invalidValue");
        const roleRaw = asString(body.role);
        const role: AccountRole | undefined = roleRaw === "owner" || roleRaw === "user" ? roleRaw : undefined;
        if (roleRaw && !role) throw new ScimError(400, "role 只允许 owner 或 user", "invalidValue");
        const memberIds: string[] = [];
        if (Array.isArray(body.members)) {
          for (const item of body.members as unknown[]) {
            const value = typeof item === "object" && item !== null ? asString((item as Record<string, unknown>).value) : null;
            if (!value) throw new ScimError(400, "members 成员需要 value（账号 id）", "invalidValue");
            const member = await directory.findById(value);
            if (!member) throw new ScimError(400, "成员账号不存在：" + value, "invalidValue");
            memberIds.push(value);
          }
        }
        const next = loadScimGroups(home);
        const target = next.find((g) => g.id === resourceId);
        if (!target) return scimError(404, "群组不存在");
        target.displayName = displayName;
        if (role) target.role = role;
        else delete target.role;
        target.members = memberIds;
        target.updated_at = new Date().toISOString();
        saveScimGroups(home, next);
        if (role === "owner") {
          for (const memberId of memberIds) {
            const member = await directory.findById(memberId);
            if (member && member.role !== "owner") await directory.setRole(memberId, "owner");
          }
        }
        audit(home, "scim_group_updated", { group_id: resourceId });
        const updatedAccounts = await directory.listAccounts();
        return { status: 200, body: toScimGroup(target, updatedAccounts) };
      }
      if (method === "PATCH") {
        const body = parseBody(req.bodyText);
        const operations = body.Operations;
        if (!Array.isArray(operations) || !operations.length) throw new ScimError(400, "PATCH 需要 Operations 数组", "invalidValue");
        let target = loadScimGroups(home).find((g) => g.id === resourceId);
        if (!target) return scimError(404, "群组不存在");
        for (const raw of operations as unknown[]) {
          if (!raw || typeof raw !== "object") throw new ScimError(400, "Operation 必须是对象", "invalidValue");
          const op = raw as Record<string, unknown>;
          const opName = String(op.op ?? "").toLowerCase();
          const opPath = typeof op.path === "string" ? op.path : "";
          const value = op.value;
          if (opName === "replace" && opPath === "displayName") {
            const name = asString(value);
            if (!name) throw new ScimError(400, "displayName 不能为空", "invalidValue");
            const next = loadScimGroups(home);
            const t = next.find((g) => g.id === resourceId);
            if (!t) return scimError(404, "群组不存在");
            t.displayName = name;
            t.updated_at = new Date().toISOString();
            saveScimGroups(home, next);
            target = t;
            continue;
          }
          if (opName === "add" && (opPath === "members" || opPath === "")) {
            const items = Array.isArray(value) ? value : [value];
            for (const item of items) {
              const memberId = typeof item === "object" && item !== null ? asString((item as Record<string, unknown>).value) : null;
              if (!memberId) throw new ScimError(400, "members 成员需要 value（账号 id）", "invalidValue");
              const member = await directory.findById(memberId);
              if (!member) throw new ScimError(400, "成员账号不存在：" + memberId, "invalidValue");
              await addGroupMember(home, resourceId, memberId, opts);
              const refreshed = loadScimGroups(home).find((g) => g.id === resourceId);
              if (refreshed?.role === "owner" && member.role !== "owner") await directory.setRole(memberId, "owner");
            }
            target = loadScimGroups(home).find((g) => g.id === resourceId) ?? target;
            continue;
          }
          if (opName === "remove" && opPath.startsWith("members")) {
            // 形如 members[value eq "abc"] 或 members：前者只删指定成员，后者清全部。
            const match = opPath.match(/^members\[value eq "([^"]+)"\]$/);
            if (match) {
              removeGroupMember(home, resourceId, match[1]);
            } else if (opPath === "members") {
              const next = loadScimGroups(home);
              const t = next.find((g) => g.id === resourceId);
              if (t) {
                t.members = [];
                t.updated_at = new Date().toISOString();
                saveScimGroups(home, next);
              }
            } else {
              throw new ScimError(400, "不支持的 members remove 路径：" + opPath, "invalidValue");
            }
            target = loadScimGroups(home).find((g) => g.id === resourceId) ?? target;
            continue;
          }
          throw new ScimError(400, "不支持的 PATCH 操作：" + opName + " " + opPath, "invalidValue");
        }
        audit(home, "scim_group_updated", { group_id: resourceId });
        const updatedAccounts = await directory.listAccounts();
        return { status: 200, body: toScimGroup(target, updatedAccounts) };
      }
      return scimError(405, "Groups 只支持 GET / PUT / PATCH / DELETE");
    }

    return scimError(404, "未知资源：" + resource);
  } catch (err) {
    if (err instanceof ScimError) return scimError(err.status, err.message, err.scimType);
    if (err instanceof AccountError) return scimError(400, err.message, "invalidValue");
    throw err;
  }
}
