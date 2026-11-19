// tests/node/test-poppy.test.ts — Poppy 原生 Node 移植验收，
// 对应 tests/test_poppy.py、test_poppy_identity.py、test_poppy_permissions.py。
// 全部 mock fetch（注入 fetchFn），不调真实网络；DNS 预检只在真实 fetch 时跑，
// 注入时跳过，因此这里只用 assertPublicDns/isGlobalIp 的离线用例覆盖它。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPublicDns,
  checkPermission,
  classifyScope,
  discover,
  discoverPoppy,
  identityCheck,
  inspectPoppyIdentity,
  // inspectPoppyIdentity 在下方结构化变体测试中使用
  isGlobalIp,
  parseJsonNoDuplicates,
  permissionCheck,
  PermissionConflict,
  PermissionError,
  PermissionLedger,
  PoppyError,
} from "../../src/poppy.ts";

const SITE = "https://example.com";
const WELL_KNOWN = "https://example.com/.well-known/poppy.json";

function validDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol_version: "1.0",
    organization: { name: "Example", domain: "example.com" },
    web: {},
    auth: {
      scopes: { "read:profile": "读取公开资料" },
      scope_hints: { "read:profile": { changes: "none", personal_data: false } },
    },
    apis: [{ type: "mcp", url: "https://example.com/mcp", description: "MCP 服务" }],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

/** 按 URL 分发响应的 mock fetch；记录收到的 URL 供断言。 */
function routingFetch(routes: Record<string, Response | ((url: string) => Response)>, seen: string[] = []): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    seen.push(u);
    const route = routes[u];
    if (route === undefined) return jsonResponse({ error: "no route" }, 404);
    return typeof route === "function" ? route(u) : route;
  }) as unknown as typeof fetch;
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "nyra-poppy-")), "poppy", "permissions.json");
}

// ---- discover：正常路径 ----

test("poppy.discover bare domain fetches well-known and returns read-only summary", async () => {
  const seen: string[] = [];
  const out = await discover("example.com", {
    fetchFn: routingFetch({ [WELL_KNOWN]: jsonResponse(validDoc()) }, seen),
  });
  expect(seen).toEqual([WELL_KNOWN]);
  const result = JSON.parse(out) as Record<string, unknown>;
  expect(result.version).toBe("1.0");
  expect(result.discovery_url).toBe(WELL_KNOWN);
  expect(result.read_only_discovery).toBe(true);
  expect(result.status).toBe("metadata_only");
  expect(result.auth_advertised).toBe(true);
  expect(result.auth_disabled).toBe(false);
  expect(result.auth_issuer_hint).toBeNull();
  expect(result.warning as string).toContain("尚未建立 Poppy Session");
  expect(result.warning as string).toContain("UCP");
  const channels = result.channels as { type: string; requires_session: boolean }[];
  expect(channels.map((c) => c.type).sort()).toEqual(["mcp", "web"]);
  expect(channels.every((c) => c.requires_session)).toBe(true);
  const scopes = result.scopes as { scope: string; requires_human_approval: boolean }[];
  expect(scopes).toEqual([{
    scope: "read:profile", description: "读取公开资料", changes: "none",
    personal_data: false, unknown_hints: false, requires_human_approval: false,
  }]);
});

test("poppy.discover https url with path still uses canonical well-known url", async () => {
  const seen: string[] = [];
  await discover("https://example.com/some/page", {
    fetchFn: routingFetch({ [WELL_KNOWN]: jsonResponse(validDoc()) }, seen),
  });
  expect(seen).toEqual([WELL_KNOWN]);
});

test("poppy.discover unknown scope hints fail closed to irreversible", async () => {
  const doc = validDoc({
    auth: {
      scopes: { "write:cart": "改购物车" },
      scope_hints: { "write:cart": { changes: "maybe" } },
    },
  });
  const out = await discover(SITE, { fetchFn: routingFetch({ [WELL_KNOWN]: jsonResponse(doc) }) });
  const scopes = (JSON.parse(out) as Record<string, unknown>).scopes as Record<string, unknown>[];
  expect(scopes[0]).toMatchObject({
    changes: "irreversible", personal_data: null,
    unknown_hints: true, requires_human_approval: true,
  });
});

test("poppy.discover structured variant throws PoppyError", async () => {
  await expect(discoverPoppy("http://example.com", {
    fetchFn: routingFetch({}),
  })).rejects.toBeInstanceOf(PoppyError);
});

// ---- discover：URL 与文档校验 ----

test("poppy.discover rejects http, credentials, non-default port, IP and empty site", async () => {
  const fetchFn = routingFetch({});
  expect(await discover("http://example.com", { fetchFn })).toContain("错误：Poppy 仅允许无凭证");
  expect(await discover("https://user:pass@example.com", { fetchFn })).toContain("错误：Poppy 仅允许无凭证");
  expect(await discover("https://example.com:8443", { fetchFn })).toContain("错误：Poppy 仅允许无凭证");
  expect(await discover("https://127.0.0.1", { fetchFn })).toContain("错误：Poppy 仅允许有效的公开 DNS 域名");
  expect(await discover("https://example.com#frag", { fetchFn })).toContain("错误：Poppy 仅允许无凭证");
  expect(await discover("", { fetchFn })).toBe("错误：站点地址无效");
});

test("poppy.discover non-200 is a clear error, not an empty document", async () => {
  const out = await discover(SITE, {
    fetchFn: routingFetch({ [WELL_KNOWN]: jsonResponse({}, 403) }),
  });
  expect(out).toBe("错误：站点元数据读取失败（HTTP 403）");
});

test("poppy.discover invalid json, non-object root, missing version, org mismatch, no channel", async () => {
  const fetchFnFor = (body: unknown) => routingFetch({ [WELL_KNOWN]: jsonResponse(body) });
  expect(await discover(SITE, { fetchFn: fetchFnFor("not json{") })).toBe("错误：Poppy 文件不是合法 UTF-8 JSON");
  expect(await discover(SITE, { fetchFn: fetchFnFor([1, 2]) })).toBe("错误：Poppy 文件根元素必须是 JSON 对象");
  const noVersion = validDoc(); delete noVersion.protocol_version;
  expect(await discover(SITE, { fetchFn: fetchFnFor(noVersion) })).toBe("错误：Poppy 文件缺少有效 protocol_version");
  const wrongOrg = validDoc({ organization: { name: "Example", domain: "other.com" } });
  expect(await discover(SITE, { fetchFn: fetchFnFor(wrongOrg) })).toBe("错误：organization.domain 与实际提供文件的主机不一致");
  const noChannel = validDoc(); delete noChannel.web; delete noChannel.apis;
  expect(await discover(SITE, { fetchFn: fetchFnFor(noChannel) })).toBe("错误：Poppy 文件没有声明任何交互渠道");
});

// ---- discover：重定向与版本备选 ----

test("poppy.discover follows same-host redirect to the exact well-known path", async () => {
  const seen: string[] = [];
  // 首跳 302 回到同一 URL：第二跳由同一路由返回 200 文档
  const out = await discover(SITE, {
    fetchFn: (async (url: unknown) => {
      const u = String(url);
      seen.push(u);
      if (seen.filter((x) => x === WELL_KNOWN).length === 1) {
        return new Response("", { status: 302, headers: { location: WELL_KNOWN } });
      }
      return jsonResponse(validDoc());
    }) as unknown as typeof fetch,
  });
  expect(JSON.parse(out).version).toBe("1.0");
  expect(seen.length).toBe(2);
});

test("poppy.identityCheck structured variant throws IdentityError", async () => {
  await expect(inspectPoppyIdentity(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: jsonResponse(validDoc({ auth: { issuer: ISSUER } })),
      [PROTECTED_URL]: jsonResponse({}, 404),
    }),
  })).rejects.toThrow("站点声明 auth.issuer，但资源元数据返回 404");
});

test("poppy.discover redirect to a non-well-known path is rejected", async () => {
  const out = await discover(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: new Response("", { status: 302, headers: { location: "https://example.com/other.json" } }),
      "https://example.com/other.json": jsonResponse(validDoc()),
    }),
  });
  expect(out).toBe("错误：重定向后的 Poppy 文件必须位于精确的 well-known 路径，且无查询参数");
});

test("poppy.discover redirect to http is rejected", async () => {
  const out = await discover(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: new Response("", { status: 302, headers: { location: "http://example.com/.well-known/poppy.json" } }),
    }),
  });
  expect(out).toContain("错误：Poppy 仅允许无凭证");
});

test("poppy.discover redirect loop beyond 4 is rejected", async () => {
  const out = await discover(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: new Response("", { status: 302, headers: { location: WELL_KNOWN } }),
    }),
  });
  expect(out).toBe("错误：Poppy 发现重定向不被允许或超过次数限制");
});

test("poppy.discover supported_versions selects same-host 1.0 alternate", async () => {
  const alternate = "https://example.com/poppy-1.0.json";
  const doc2 = validDoc({ protocol_version: "2.0", supported_versions: { "1.0": alternate } });
  const out = await discover(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: jsonResponse(doc2),
      [alternate]: jsonResponse(validDoc()),
    }),
  });
  const result = JSON.parse(out) as Record<string, unknown>;
  expect(result.version).toBe("1.0");
  expect(result.discovery_url).toBe(alternate);
});

test("poppy.discover version mismatch without alternate, cross-host alternate, redirecting alternate, nested alternate", async () => {
  const fetchFnFor = (doc: Record<string, unknown>, alt?: Response) => routingFetch({
    [WELL_KNOWN]: jsonResponse(doc),
    ...(alt ? { "https://example.com/poppy-1.0.json": alt } : {}),
  });
  const v2 = validDoc({ protocol_version: "2.0" });
  expect(await discover(SITE, { fetchFn: fetchFnFor(v2) })).toBe("错误：不支持站点声明的 Poppy 2.0，且没有 1.0 文档");
  const crossHost = validDoc({
    protocol_version: "2.0",
    supported_versions: { "1.0": "https://other.com/poppy-1.0.json" },
  });
  expect(await discover(SITE, { fetchFn: fetchFnFor(crossHost) })).toBe("错误：supported_versions 只能指向同一个最终主机");
  const redirecting = validDoc({
    protocol_version: "2.0",
    supported_versions: { "1.0": "https://example.com/poppy-1.0.json" },
  });
  const redirectAlt = new Response("", { status: 302, headers: { location: WELL_KNOWN } });
  expect(await discover(SITE, { fetchFn: fetchFnFor(redirecting, redirectAlt) }))
    .toBe("错误：Poppy 发现重定向不被允许或超过次数限制");
  const nested = validDoc({
    protocol_version: "2.0",
    supported_versions: { "1.0": "https://example.com/poppy-1.0.json" },
  });
  const nestedAlt = jsonResponse(validDoc({ supported_versions: { "1.0": "https://example.com/x.json" } }));
  expect(await discover(SITE, { fetchFn: fetchFnFor(nested, nestedAlt) }))
    .toBe("错误：备选版本文件不得再声明 supported_versions");
});

// ---- discover：超时 / 网络错误 / 大小 ----

test("poppy.discover timeout aborts and reports a chinese timeout error", async () => {
  const hanging = ((_: unknown, init?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
  })) as unknown as typeof fetch;
  const started = Date.now();
  const out = await discover(SITE, { fetchFn: hanging, timeoutMs: 50 });
  expect(out).toBe("错误：无法安全读取 Poppy 元数据（超时）");
  expect(Date.now() - started).toBeLessThan(3000);
});

test("poppy.discover network failure reports a chinese fetch error", async () => {
  const failing = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  expect(await discover(SITE, { fetchFn: failing })).toBe("错误：无法安全读取 Poppy 元数据（TypeError）");
});

test("poppy.discover oversized document is rejected by content-length and by body", async () => {
  const big = "x".repeat(MAX_DOC_BYTES + 1);
  const byLength = await discover(SITE, {
    fetchFn: routingFetch({ [WELL_KNOWN]: jsonResponse(big, 200, { "content-length": String(big.length) }) }),
  });
  expect(byLength).toBe("错误：Poppy 文件大小无效或超过 128 KiB");
  // 无 content-length 时按实际 body 字节数拒绝
  const fakeBody = {
    status: 200,
    headers: new Headers({}),
    arrayBuffer: async () => new TextEncoder().encode(big).buffer,
  } as unknown as Response;
  const byBody = await discover(SITE, {
    fetchFn: (async () => fakeBody) as unknown as typeof fetch,
  });
  expect(byBody).toBe("错误：Poppy 文件超过 128 KiB");
  const badLength = await discover(SITE, {
    fetchFn: routingFetch({ [WELL_KNOWN]: jsonResponse(validDoc(), 200, { "content-length": "abc" }) }),
  });
  expect(badLength).toBe("错误：Poppy 响应的 Content-Length 无效");
});

const MAX_DOC_BYTES = 128 * 1024;

// ---- DNS 预检（离线用例；真实解析不在测试里触网） ----

test("poppy.isGlobalIp classifies private, loopback, link-local and public addresses", () => {
  expect(isGlobalIp("8.8.8.8")).toBe(true);
  expect(isGlobalIp("1.1.1.1")).toBe(true);
  expect(isGlobalIp("10.0.0.1")).toBe(false);
  expect(isGlobalIp("172.16.0.1")).toBe(false);
  expect(isGlobalIp("172.31.255.255")).toBe(false);
  expect(isGlobalIp("192.168.1.1")).toBe(false);
  expect(isGlobalIp("127.0.0.1")).toBe(false);
  expect(isGlobalIp("169.254.1.1")).toBe(false);
  expect(isGlobalIp("100.64.0.1")).toBe(false);
  expect(isGlobalIp("192.0.2.1")).toBe(false);
  expect(isGlobalIp("198.51.100.1")).toBe(false);
  expect(isGlobalIp("203.0.113.1")).toBe(false);
  expect(isGlobalIp("224.0.0.1")).toBe(false);
  expect(isGlobalIp("::1")).toBe(false);
  expect(isGlobalIp("fe80::1")).toBe(false);
  expect(isGlobalIp("fc00::1")).toBe(false);
  expect(isGlobalIp("fd12:3456::1")).toBe(false);
  expect(isGlobalIp("2001:db8::1")).toBe(false);
  expect(isGlobalIp("2606:4700:4700::1111")).toBe(true);
  expect(isGlobalIp("::ffff:8.8.8.8")).toBe(true);
  expect(isGlobalIp("::ffff:10.0.0.1")).toBe(false);
  expect(isGlobalIp("not-an-ip")).toBe(false);
});

test("poppy.assertPublicDns rejects localhost without touching the network", async () => {
  await expect(assertPublicDns("localhost")).rejects.toThrow("拒绝访问内网、环回、保留或链路本地 IP");
  // 不可解析的域名必须 fail-closed；具体是“无法解析”还是解析出非全球 IP
  // 取决于本机解析器（本沙箱对 .invalid 返回非全球 IP），两种都是拒绝。
  await expect(assertPublicDns("nonexistent.invalid")).rejects.toBeInstanceOf(PoppyError);
});

// ---- identityCheck ----

const ISSUER = "https://auth.example.com";
const PROTECTED_URL = "https://example.com/.well-known/oauth-protected-resource";
const ISSUER_META_URL = "https://auth.example.com/.well-known/oauth-authorization-server";

function identityRoutes(overrides: Record<string, unknown> = {}): Record<string, Response> {
  const doc = validDoc({ auth: { issuer: ISSUER, scopes: { "read:profile": "x" } }, ...overrides });
  const protectedMeta = {
    resource: "https://example.com",
    authorization_servers: [ISSUER],
    scopes_supported: ["read:profile"],
  };
  const issuerMeta = {
    issuer: ISSUER,
    protected_resources: ["https://example.com"],
    token_endpoint: "https://auth.example.com/token",
    revocation_endpoint: "https://auth.example.com/revoke",
    grant_types_supported: ["refresh_token", "authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
    authorization_endpoint: "https://auth.example.com/authorize",
    device_authorization_endpoint: "https://auth.example.com/device",
    scopes_supported: ["write:cart"],
  };
  return {
    [WELL_KNOWN]: jsonResponse(doc),
    [PROTECTED_URL]: jsonResponse({ ...protectedMeta, ...(overrides.protected as Record<string, unknown> ?? {}) }),
    [ISSUER_META_URL]: jsonResponse({ ...issuerMeta, ...(overrides.issuerMeta as Record<string, unknown> ?? {}) }),
  };
}

test("poppy.identityCheck verifies two-sided issuer metadata", async () => {
  const out = await identityCheck(SITE, { fetchFn: routingFetch(identityRoutes()) });
  const result = JSON.parse(out) as Record<string, unknown>;
  expect(result).toMatchObject({
    company: "example.com",
    identifier: ISSUER,
    issuer: ISSUER,
    issuer_link_verified: true,
    status: "issuer_metadata_verified",
    signed_in_available: true,
    protected_resource_status: "valid_with_issuer",
    session_ready: false,
    oauth_ready: false,
    remote_calls_allowed: false,
  });
  expect(result.scopes_supported).toEqual(["read:profile", "write:cart"]);
  expect(result.sign_in_hints).toEqual({ direct: true, device: true });
  expect(result.warning as string).toContain("未注册 OAuth client");
});

test("poppy.identityCheck 404 without a claimed issuer is signed-out only, not a session", async () => {
  const doc = validDoc({ auth: {} });
  const out = await identityCheck(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: jsonResponse(doc),
      [PROTECTED_URL]: jsonResponse({}, 404),
    }),
  });
  expect(JSON.parse(out)).toMatchObject({
    company: "example.com",
    issuer: null,
    issuer_link_verified: false,
    status: "signed_out_metadata_only",
    signed_in_available: false,
    protected_resource_status: "not_found",
    session_ready: false,
    oauth_ready: false,
    remote_calls_allowed: false,
  });
});

test("poppy.identityCheck 404 never falls back when the company claims an issuer", async () => {
  const out = await identityCheck(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: jsonResponse(validDoc({ auth: { issuer: ISSUER } })),
      [PROTECTED_URL]: jsonResponse({}, 404),
    }),
  });
  expect(out).toBe("错误：站点声明 auth.issuer，但资源元数据返回 404");
});

test("poppy.identityCheck 403 is not interpreted as no issuer", async () => {
  const out = await identityCheck(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: jsonResponse(validDoc()),
      [PROTECTED_URL]: jsonResponse({}, 403),
    }),
  });
  expect(out).toBe("错误：站点元数据读取失败（HTTP 403）");
});

test("poppy.identityCheck rejects resource mismatch, multiple issuers, unlisted hint, issuer mismatch", async () => {
  const base = identityRoutes();
  const mismatch = await identityCheck(SITE, {
    fetchFn: routingFetch({ ...base, [PROTECTED_URL]: jsonResponse({ resource: "https://other.com", authorization_servers: [ISSUER] }) }),
  });
  expect(mismatch).toBe("错误：protected resource 的 resource 与公司域名不一致");
  const multi = await identityCheck(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: jsonResponse(validDoc({ auth: {} })),
      [PROTECTED_URL]: jsonResponse({ resource: "https://example.com", authorization_servers: [ISSUER, "https://auth2.example.com"] }),
    }),
  });
  expect(multi).toBe("错误：多个 authorization_servers 时必须有 auth.issuer");
  const unlisted = await identityCheck(SITE, {
    fetchFn: routingFetch({
      ...base,
      [WELL_KNOWN]: jsonResponse(validDoc({ auth: { issuer: "https://auth2.example.com" } })),
    }),
  });
  expect(unlisted).toBe("错误：auth.issuer 不在 authorization_servers 清单");
  const issuerMismatch = await identityCheck(SITE, {
    fetchFn: routingFetch(identityRoutes({ issuerMeta: { issuer: "https://auth2.example.com" } })),
  });
  expect(issuerMismatch).toBe("错误：OAuth issuer 元数据的 issuer 不完全匹配");
});

test("poppy.identityCheck issuer must confirm company resource and offer refresh_token plus endpoints", async () => {
  const noResource = await identityCheck(SITE, {
    fetchFn: routingFetch(identityRoutes({ issuerMeta: { protected_resources: ["https://other.com"] } })),
  });
  expect(noResource).toBe("错误：OAuth issuer 未将公司域名列入 protected_resources");
  const noRefresh = await identityCheck(SITE, {
    fetchFn: routingFetch(identityRoutes({ issuerMeta: { grant_types_supported: ["authorization_code"] } })),
  });
  expect(noRefresh).toBe("错误：issuer 必须提供 refresh_token grant");
  const noToken = await identityCheck(SITE, {
    fetchFn: routingFetch(identityRoutes({ issuerMeta: { token_endpoint: undefined } })),
  });
  expect(noToken).toBe("错误：token_endpoint 缺少 HTTPS 地址");
});

test("poppy.identityCheck duplicate json keys and metadata redirect are rejected", async () => {
  const dupBody = '{"resource":"https://example.com","resource":"https://example.com","authorization_servers":[]}';
  const dup = await identityCheck(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: jsonResponse(validDoc()),
      [PROTECTED_URL]: jsonResponse(dupBody),
    }),
  });
  expect(dup).toBe("错误：受保护资源元数据 不是有效的、无重复键的 UTF-8 JSON");
  expect(() => parseJsonNoDuplicates('{"a":1,"a":2}')).toThrow();
  expect(parseJsonNoDuplicates('{"a":{"b":1},"c":[1,2,"x"]}')).toEqual({ a: { b: 1 }, c: [1, 2, "x"] });
  const redirected = await identityCheck(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: jsonResponse(validDoc()),
      [PROTECTED_URL]: new Response("", { status: 302, headers: { location: PROTECTED_URL } }),
    }),
  });
  expect(redirected).toBe("错误：Poppy 发现重定向不被允许或超过次数限制");
});

test("poppy.identityCheck issuer with path uses RFC 8414 well-known position", async () => {
  const pathIssuer = "https://auth.example.com/tenant";
  const metaUrl = "https://auth.example.com/.well-known/oauth-authorization-server/tenant";
  const seen: string[] = [];
  const out = await identityCheck(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: jsonResponse(validDoc({ auth: { issuer: pathIssuer } })),
      [PROTECTED_URL]: jsonResponse({ resource: "https://example.com", authorization_servers: [pathIssuer] }),
      [metaUrl]: jsonResponse({
        issuer: pathIssuer,
        protected_resources: ["https://example.com"],
        token_endpoint: "https://auth.example.com/token",
        revocation_endpoint: "https://auth.example.com/revoke",
        grant_types_supported: ["refresh_token"],
      }),
    }, seen),
  });
  expect(seen).toContain(metaUrl);
  expect((JSON.parse(out) as Record<string, unknown>).issuer_link_verified).toBe(true);
});

test("poppy.identityCheck disabled sign-in keeps issuer verified but unavailable", async () => {
  const out = await identityCheck(SITE, {
    fetchFn: routingFetch(identityRoutes({ auth: { issuer: ISSUER, disabled: true } })),
  });
  const result = JSON.parse(out) as Record<string, unknown>;
  expect(result).toMatchObject({
    issuer_link_verified: true,
    signed_in_available: false,
    sign_in_disabled_by_company: true,
  });
  expect(result.sign_in_hints).toEqual({ direct: false, device: false });
});

test("poppy.identityCheck empty authorization_servers without hint is valid without issuer", async () => {
  const out = await identityCheck(SITE, {
    fetchFn: routingFetch({
      [WELL_KNOWN]: jsonResponse(validDoc({ auth: {} })),
      [PROTECTED_URL]: jsonResponse({ resource: "https://example.com", authorization_servers: [] }),
    }),
  });
  expect(JSON.parse(out)).toMatchObject({
    issuer: null,
    protected_resource_status: "valid_without_issuer",
    session_ready: false,
  });
});

// ---- permissionCheck 与账本读写 ----

test("poppy.permissionCheck denied by default and claims no real authorization", async () => {
  const out = await permissionCheck(SITE, "read:profile", null, { ledgerPath: tmpLedgerPath() });
  const result = JSON.parse(out) as Record<string, unknown>;
  expect(result).toMatchObject({
    site: "example.com",
    identity: "visitor",
    scope: "read:profile",
    local_intent: "denied",
    oauth_grant_verified: false,
    poppy_session_verified: false,
    may_execute_remote_action: false,
    ledger_revision: "missing",
  });
  expect(result.reason as string).toContain("默认拒绝");
});

test("poppy.permissionCheck structured variant throws on invalid scope", () => {
  expect(() => checkPermission(SITE, "read:*", null, { ledgerPath: tmpLedgerPath() }))
    .toThrow("scope 必须是非空 OAuth scope-token，且不得包含通配符");
  expect(() => checkPermission(SITE, "", null, { ledgerPath: tmpLedgerPath() })).toThrow(PermissionError);
  expect(() => checkPermission(SITE, "read:profile", "bad alias!", { ledgerPath: tmpLedgerPath() }))
    .toThrow("账户别名只能包含字母、数字、-、_");
});

test("poppy.ledger grant requires explicit confirmation, then check/list/audit/revoke round-trip", () => {
  const path = tmpLedgerPath();
  const ledger = new PermissionLedger(path);
  expect(() => ledger.grant(SITE, "read:profile")).toThrow("创建本地授权意向需要用户显式 --confirm");
  const granted = ledger.grant(SITE, "read:profile", null, { confirmed: true });
  expect(granted.changed).toBe(true);
  expect(granted.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(ledger.check(SITE, "read:profile").local_intent).toBe("recorded");
  expect(ledger.check(SITE, "read:profile").reason).toContain("本地仅记录用户授权意向");
  expect(ledger.check(SITE, "write:cart").local_intent).toBe("denied");
  const listed = ledger.list();
  expect(listed.count).toBe(1);
  expect(listed.grants).toEqual([{ site: "example.com", identity: "visitor", scope: "read:profile", kind: "local_intent" }]);
  expect(listed.revision).toBe(granted.revision);
  const events = ledger.audit();
  expect(events.length).toBe(1);
  expect(events[0]).toMatchObject({ actor: "explicit_cli_user", operation: "grant", site: "example.com", scope: "read:profile" });
  // 账本文件形态：Python 同款 JSON，600 权限，revision 为文件 SHA-256
  const raw = readFileSync(path);
  const stored = JSON.parse(raw.toString("utf-8")) as Record<string, unknown>;
  expect(stored.version).toBe(1);
  expect(stored.sites).toEqual({ "example.com": { visitor: { "read:profile": { kind: "local_intent" } } } });
  expect((statSync(path).mode & 0o777)).toBe(0o600);
  // 幂等 grant 与 revoke
  expect(ledger.grant(SITE, "read:profile", null, { confirmed: true }).changed).toBe(false);
  expect(ledger.revoke(SITE, "read:profile").changed).toBe(true);
  expect(ledger.check(SITE, "read:profile").local_intent).toBe("denied");
  expect(ledger.list().count).toBe(0);
  expect(ledger.revoke(SITE, "read:profile").changed).toBe(false);
  // 重新打开同一文件，意向仍在（revoke 事件也留档）
  const reopened = new PermissionLedger(path);
  expect(reopened.audit().length).toBe(2);
  expect(reopened.audit()[0]?.operation).toBe("revoke");
});

test("poppy.ledger visitor and account alias are isolated", () => {
  const path = tmpLedgerPath();
  const ledger = new PermissionLedger(path);
  ledger.grant(SITE, "read:profile", "personal", { confirmed: true });
  expect(ledger.check(SITE, "read:profile").local_intent).toBe("denied");
  expect(ledger.check(SITE, "read:profile", "personal").local_intent).toBe("recorded");
  expect(ledger.list(SITE).count).toBe(1);
  expect(ledger.list("https://other.com").count).toBe(0);
});

test("poppy.ledger revision CAS prevents stale changes", () => {
  const path = tmpLedgerPath();
  const ledger = new PermissionLedger(path);
  const first = ledger.grant(SITE, "read:profile", null, { confirmed: true });
  expect(() => ledger.grant(SITE, "write:cart", null, { confirmed: true, expectedRevision: "missing" }))
    .toThrow(PermissionConflict);
  expect(() => ledger.grant(SITE, "write:cart", null, { confirmed: true, expectedRevision: "xyz" }))
    .toThrow("expected_revision 格式无效");
  const second = ledger.grant(SITE, "write:cart", null, { confirmed: true, expectedRevision: first.revision });
  expect(second.changed).toBe(true);
  expect(ledger.list().count).toBe(2);
});

test("poppy.ledger corrupt file, oversized file, symlink and malformed content fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-poppy-"));
  const corrupt = join(dir, "permissions.json");
  writeFileSync(corrupt, "{not json", "utf-8");
  expect(() => new PermissionLedger(corrupt).check(SITE, "read:profile"))
    .toThrow("权限账本已损坏，拒绝继续写入");
  const big = join(dir, "big.json");
  writeFileSync(big, "x".repeat(256 * 1024 + 1), "utf-8");
  expect(() => new PermissionLedger(big).check(SITE, "read:profile"))
    .toThrow("权限账本超过 256 KiB 限制");
  const target = join(dir, "real.json");
  writeFileSync(target, JSON.stringify({ version: 1, sites: {}, events: [] }), "utf-8");
  const link = join(dir, "link.json");
  symlinkSync(target, link);
  expect(() => new PermissionLedger(link).check(SITE, "read:profile"))
    .toThrow("权限账本路径不能是符号链接");
  const badKind = join(dir, "badkind.json");
  writeFileSync(badKind, JSON.stringify({
    version: 1,
    sites: { "example.com": { visitor: { "read:profile": { kind: "oauth_grant" } } } },
    events: [],
  }), "utf-8");
  expect(() => new PermissionLedger(badKind).check(SITE, "read:profile"))
    .toThrow("权限账本包含未知授权类型");
  const badSite = join(dir, "badsite.json");
  writeFileSync(badSite, JSON.stringify({
    version: 1,
    sites: { "EXAMPLE.com": { visitor: {} } },
    events: [],
  }), "utf-8");
  expect(() => new PermissionLedger(badSite).check(SITE, "read:profile"))
    .toThrow("权限账本包含非法站点或身份");
});

test("poppy.ledger audit limit is validated", () => {
  const ledger = new PermissionLedger(tmpLedgerPath());
  expect(() => ledger.audit(null, 0)).toThrow("审计显示条数必须在 1 到 100 之间");
  expect(() => ledger.audit(null, 101)).toThrow("审计显示条数必须在 1 到 100 之间");
  expect(ledger.audit(null, 1)).toEqual([]);
});

test("poppy.classifyScope never marks unknown hints safe", () => {
  expect(classifyScope(null)).toEqual({
    changes: "irreversible", personal_data: null,
    unknown_hints: true, requires_human_approval: true,
  });
  expect(classifyScope({ changes: "none", personal_data: false })).toEqual({
    changes: "none", personal_data: false,
    unknown_hints: false, requires_human_approval: false,
  });
  expect(classifyScope({ changes: "reversible", personal_data: true }).requires_human_approval).toBe(true);
});

test("poppy.permissionCheck string wrapper never throws, returns chinese error string", async () => {
  const out = await permissionCheck(SITE, "read:*", null, { ledgerPath: tmpLedgerPath() });
  expect(out.startsWith("错误：")).toBe(true);
  expect(out).toContain("通配符");
});
