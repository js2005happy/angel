// src/poppy.ts — Poppy 1.0 原生 Node 移植，与 Python 版同语义：
//   nyra/poppy.py（发现）、nyra/poppy_identity.py（OAuth 元数据核验）、
//   nyra/poppy_permissions.py（本地权限意向账本）。
// 三个工具都是只读：只读元数据，不登录、不发 token、不连接 MCP/OpenAPI/UCP，
// 不购买、不下单、不执行远端工具。账本只记录本地用户授权意向，grant/revoke
// 只能由显式 CLI 调用（permissionCheck 工具本身永远只读）。
//
// 与 Python 版的已知差异（实测口径，见文件末尾注释与测试）：
//  1. Python 用裸 socket + 固定解析 IP 做 TLS（DNS 钉选，防 SSRF/重绑定）。
//     Node 全局 fetch 无法钉选连接 IP；这里只在真实 fetch 前做一次 DNS
//     预检（全部解析地址必须全球可路由，否则 fail-closed），fetch 本身仍
//     可能重新解析——TOCTOU 缺口如实存在，注入 fetchFn（测试）时跳过预检。
//  2. Python 显式禁用代理与 cookie；Node fetch 默认不带 cookie jar，但代
//     理环境变量是否生效取决于运行时，本模块不另行保证。
//  3. Python 用 urlsplit 保留原始路径，Node URL 会规范化 "/../"、"/./"；
//     issuer 的路径穿越检查因此在原始字符串上另做一次（见 _rawPath）。
//  4. 超时在 Python 里表现为 TimeoutError 类型名；这里统一报“超时”。

import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveHome } from "./config.ts";

export class PoppyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoppyError";
  }
}

export class IdentityError extends PoppyError {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

export class PermissionConflict extends PermissionError {
  constructor(message: string) {
    super(message);
    this.name = "PermissionConflict";
  }
}

export const DISCOVERY_PATH = "/.well-known/poppy.json";
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTH_SERVER_WELL_KNOWN = "/.well-known/oauth-authorization-server";
export const IMPLEMENTED_VERSION = "1.0";
export const MAX_BYTES = 128 * 1024;
export const MAX_REDIRECTS = 4;
export const MAX_CAPABILITIES = 20;
export const MAX_SCOPES = 30;
export const IDENTITY_MAX_SCOPES = 100;
export const TIMEOUT_MS = 6000;
export const MAX_LEDGER_BYTES = 256 * 1024;
export const MAX_SITES = 100;
export const MAX_SCOPES_PER_IDENTITY = 100;
export const MAX_AUDIT_EVENTS = 300;

const VERSION_RE = /^[0-9]{1,3}\.[0-9]{1,3}$/;
const DNS_NAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SCOPE_RE = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const REVISION_RE = /^[0-9a-f]{64}$/;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface PoppyOptions {
  /** 测试注入：替代全局 fetch；注入时跳过真实 DNS 预检（不触网）。 */
  fetchFn?: typeof fetch;
  /** 超时毫秒，默认 6000（与 Python TIMEOUT=6 一致）。 */
  timeoutMs?: number;
}

export interface IdentityOptions extends PoppyOptions {
  /** 测试注入：替代 discoverPoppy；不传则用默认发现流程。 */
  discoverFn?: (site: string, opts?: PoppyOptions) => Promise<PoppyDiscovery>;
}

export interface PermissionOptions {
  /** 账本文件路径；不传则用默认路径（见 defaultLedgerPath）。 */
  ledgerPath?: string;
  /** 传给 resolveHome 的覆盖值，仅在未给 ledgerPath 时用于算默认路径。 */
  home?: string;
  /** permissionCheck 的 scope 风险分类提示（与 Python check 的 hint 同义）。 */
  hint?: Record<string, unknown> | null;
}

export interface PoppyChannel {
  type: string;
  url?: string;
  description?: string;
  disabled?: boolean;
  requires_session: boolean;
}

export interface PoppyScopeEntry {
  scope: string;
  description: string;
  changes: string;
  personal_data: boolean | null;
  unknown_hints: boolean;
  requires_human_approval: boolean;
}

export interface PoppyDiscovery {
  discovery_url: string;
  version: string;
  interpreted_as: string;
  organization: { name: string; domain: string };
  channels: PoppyChannel[];
  scopes: PoppyScopeEntry[];
  auth_advertised: boolean;
  auth_disabled: boolean;
  auth_issuer_hint: string | null;
  read_only_discovery: boolean;
  status: string;
  warning: string;
}

export interface IdentityResult {
  company: string;
  identifier: string;
  issuer: string | null;
  issuer_link_verified: boolean;
  status: string;
  signed_in_available: boolean;
  protected_resource_status: string;
  session_ready: boolean;
  oauth_ready: boolean;
  remote_calls_allowed: boolean;
  sign_in_disabled_by_company?: boolean;
  sign_in_hints?: { direct: boolean; device: boolean };
  scopes_supported?: string[];
  warning?: string;
}

export interface ScopeRisk {
  changes: string;
  personal_data: boolean | null;
  unknown_hints: boolean;
  requires_human_approval: boolean;
}

export interface PermissionCheckResult {
  site: string;
  identity: string;
  scope: string;
  local_intent: "recorded" | "denied";
  oauth_grant_verified: boolean;
  poppy_session_verified: boolean;
  may_execute_remote_action: boolean;
  risk: ScopeRisk;
  reason: string;
  ledger_revision: string;
}

export interface PermissionGrant {
  site: string;
  identity: string;
  scope: string;
  kind: "local_intent";
}

export interface PermissionListResult {
  revision: string;
  grants: PermissionGrant[];
  count: number;
}

export interface LedgerEvent {
  at: string;
  actor: string;
  operation: string;
  site: string;
  identity: string;
  scope: string;
}

interface LedgerData {
  version: 1;
  sites: Record<string, Record<string, Record<string, { kind: string }>>>;
  events: LedgerEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeoutMsOf(opts: PoppyOptions | undefined): number {
  return opts?.timeoutMs ?? TIMEOUT_MS;
}

// ---- URL 校验（与 Python _checked_https 同语义） ----

/** 从原始字符串取 path 段（问号/井号之前、netloc 之后），供穿越检查用。 */
function rawPathOf(raw: string): string {
  const afterScheme = raw.split("://")[1] ?? raw;
  const slash = afterScheme.indexOf("/");
  if (slash < 0) return "";
  const rest = afterScheme.slice(slash);
  const end = rest.search(/[?#]/);
  return end < 0 ? rest : rest.slice(0, end);
}

function checkedHttps(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PoppyError("无效的 HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" || !parsed.hostname ||
    parsed.username || parsed.password ||
    (parsed.port !== "" && parsed.port !== "443") || parsed.hash
  ) {
    throw new PoppyError("Poppy 仅允许无凭证、无片段的 HTTPS 域名和默认端口");
  }
  // URL 已做 IDNA/punycode 与小写化；再按 Python 的 DNS 名正则验收。
  if (!DNS_NAME_RE.test(parsed.hostname)) {
    throw new PoppyError("Poppy 仅允许有效的公开 DNS 域名，拒绝 IP 和内网名称");
  }
  const afterScheme = raw.split("://")[1] ?? "";
  const netloc = afterScheme.split(/[\/?#]/)[0] ?? "";
  if (netloc.startsWith("[") || netloc.toLowerCase().includes("%2f")) {
    throw new PoppyError("不安全的域名格式");
  }
  return parsed;
}

function siteUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) {
    throw new PoppyError("站点地址无效");
  }
  const target = value.includes("://") ? value : "https://" + value;
  const parsed = checkedHttps(target);
  return `https://${parsed.hostname}${DISCOVERY_PATH}`;
}

// ---- DNS 预检：仅真实 fetch 时跑；注入 fetchFn（测试）时跳过 ----

function expandIPv6(ip: string): number[] | null {
  let head = ip;
  let tail4: number[] | null = null;
  if (ip.includes(".")) {
    const lastColon = ip.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4 = ip.slice(lastColon + 1);
    if (isIP(v4) !== 4) return null;
    const octets = v4.split(".").map(Number);
    tail4 = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    head = ip.slice(0, lastColon + 1) + "0:0";
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const parseGroup = (s: string): number | null => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(s)) return null;
    return parseInt(s, 16);
  };
  const left = halves[0] === "" ? [] : halves[0]!.split(":").map(parseGroup);
  const right = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":").map(parseGroup)) : [];
  if (left.includes(null) || right.includes(null)) return null;
  const groups = [...(left as number[])];
  const total = tail4 ? 6 : 8;
  while (groups.length + right.length < total) groups.push(0);
  groups.push(...(right as number[]));
  if (groups.length !== total) return null;
  if (tail4) groups.push(...tail4);
  return groups;
}

function isGlobalIPv4(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 共享地址空间
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && o[2] === 0) return false; // 192.0.0/24
  if (a === 192 && b === 0 && o[2] === 2) return false; // 192.0.2/24 文档
  if (a === 192 && b === 168) return false;
  if (a === 198 && b >= 18 && b <= 19) return false; // 198.18/15 基准测试
  if (a === 198 && b === 51 && o[2] === 100) return false; // 198.51.100/24 文档
  if (a === 203 && b === 0 && o[2] === 113) return false; // 203.0.113/24 文档
  if (a >= 224) return false; // 组播与保留
  return true;
}

/** 是否全球可路由（Python ipaddress.is_global 的近似；见文件头差异说明）。 */
export function isGlobalIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isGlobalIPv4(ip);
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice("::ffff:".length);
      return isIP(v4) === 4 ? isGlobalIPv4(v4) : false;
    }
    const g = expandIPv6(lower);
    if (g === null) return false;
    if (g.every((n) => n === 0)) return false; // ::
    if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return false; // ::1
    if ((g[0]! & 0xffc0) === 0xfe80) return false; // fe80::/10 链路本地
    if ((g[0]! & 0xfe00) === 0xfc00) return false; // fc00::/7 唯一本地
    if ((g[0]! & 0xff00) === 0xff00) return false; // ff00::/8 组播
    if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // 2001:db8::/32 文档
    if (g[0] === 0x0064 && g[1] === 0xff9b) return false; // 64:ff9b::/96 NAT64
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // 100::/64 丢弃
    if (g[0] === 0x2001 && g[1] === 0x0000) return false; // 2001::/32 Teredo
    if (g[0] === 0x2001 && g[1] === 0x0002) return false; // 2001:2::/48 基准测试
    if (g[0] === 0x2001 && (g[1]! & 0xfff0) === 0x0010) return false; // 2001:10::/28 ORCHID
    return true;
  }
  return false;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Fail-closed：全部解析地址必须全球可路由（Python _public_addresses 同语义）。 */
export async function assertPublicDns(host: string): Promise<void> {
  let addresses: { address: string }[];
  try {
    addresses = await withTimeout(
      dnsPromises.lookup(host, { all: true, verbatim: true }) as Promise<{ address: string }[]>,
      TIMEOUT_MS,
    );
  } catch {
    throw new PoppyError("无法解析 Poppy 站点的 DNS");
  }
  if (!addresses.length) throw new PoppyError("未找到可连接的公开 IP");
  for (const entry of addresses) {
    if (!isGlobalIp(entry.address)) {
      throw new PoppyError("拒绝访问内网、环回、保留或链路本地 IP");
    }
  }
}

// ---- 有界 HTTPS 抓取（Python _fetch_public_https 同语义） ----

interface FetchOutcome {
  url: string;
  body: Uint8Array | null;
}

async function fetchPublicHttps(
  startUrl: string,
  opts: { allowRedirect: boolean; allowNotFound: boolean; fetchFn?: typeof fetch; timeoutMs: number },
): Promise<FetchOutcome> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const checkDns = opts.fetchFn === undefined;
  let current = startUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const parsed = checkedHttps(current);
    if (checkDns) await assertPublicDns(parsed.hostname);
    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      try {
        res = await fetchFn(current, {
          method: "GET",
          headers: {
            "User-Agent": "Nyra-Poppy-Discovery/0.1",
            Accept: "application/json",
            Connection: "close",
          },
          redirect: "manual",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new PoppyError("无法安全读取 Poppy 元数据（超时）");
      }
      throw new PoppyError(`无法安全读取 Poppy 元数据（${err instanceof Error ? err.name : "Error"}）`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (!opts.allowRedirect || redirects >= MAX_REDIRECTS) {
        throw new PoppyError("Poppy 发现重定向不被允许或超过次数限制");
      }
      const destination = res.headers.get("location");
      if (!destination) throw new PoppyError("Poppy 重定向缺少 Location");
      try {
        current = new URL(destination, current).toString();
      } catch {
        throw new PoppyError("Poppy 重定向目标无效");
      }
      checkedHttps(current);
      continue;
    }
    if (res.status === 404 && opts.allowNotFound) {
      return { url: current, body: null };
    }
    if (res.status !== 200) {
      throw new PoppyError(`站点元数据读取失败（HTTP ${res.status}）`);
    }
    const length = res.headers.get("content-length");
    if (length !== null) {
      const declared = Number(length);
      if (!Number.isInteger(declared)) {
        throw new PoppyError("Poppy 响应的 Content-Length 无效");
      }
      if (declared < 0 || declared > MAX_BYTES) {
        throw new PoppyError("Poppy 文件大小无效或超过 128 KiB");
      }
    }
    let buf: ArrayBuffer;
    try {
      buf = await res.arrayBuffer();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new PoppyError("无法安全读取 Poppy 元数据（超时）");
      }
      throw new PoppyError(`无法安全读取 Poppy 元数据（${err instanceof Error ? err.name : "Error"}）`);
    }
    if (buf.byteLength > MAX_BYTES) {
      throw new PoppyError("Poppy 文件超过 128 KiB");
    }
    return { url: current, body: new Uint8Array(buf) };
  }
  throw new PoppyError("Poppy 发现重定向次数超限");
}

function parseDoc(raw: Uint8Array, host: string, expectedVersion?: string): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new PoppyError("Poppy 文件不是合法 UTF-8 JSON");
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PoppyError("Poppy 文件不是合法 UTF-8 JSON");
  }
  if (!isRecord(data)) throw new PoppyError("Poppy 文件根元素必须是 JSON 对象");
  const version = data.protocol_version;
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    throw new PoppyError("Poppy 文件缺少有效 protocol_version");
  }
  if (expectedVersion !== undefined && version !== expectedVersion) {
    throw new PoppyError("所选版本文件的 protocol_version 不匹配");
  }
  const organization = data.organization;
  if (
    !isRecord(organization) ||
    typeof organization.name !== "string" || !organization.name.trim() ||
    typeof organization.domain !== "string" ||
    organization.domain.toLowerCase() !== host.toLowerCase()
  ) {
    throw new PoppyError("organization.domain 与实际提供文件的主机不一致");
  }
  if (!("agent" in data || "apis" in data || "web" in data)) {
    throw new PoppyError("Poppy 文件没有声明任何交互渠道");
  }
  return data;
}

function summarize(data: Record<string, unknown>, finalUrl: string): PoppyDiscovery {
  const version = data.protocol_version as string;
  const organization = data.organization as Record<string, unknown>;
  const auth = isRecord(data.auth) ? data.auth : {};
  const scopes = isRecord(auth.scopes) ? auth.scopes : {};
  const hints = isRecord(auth.scope_hints) ? auth.scope_hints : {};
  const channels: PoppyChannel[] = [];
  const entries = Array.isArray(data.apis) ? data.apis : [];
  for (const entry of entries.slice(0, MAX_CAPABILITIES)) {
    if (isRecord(entry) && (entry.type === "mcp" || entry.type === "openapi")) {
      const endpoint = entry.url;
      if (typeof endpoint === "string" && endpoint.startsWith("https://")) {
        channels.push({
          type: entry.type as string,
          url: endpoint.slice(0, 1200),
          description: String(entry.description ?? "").slice(0, 300),
          requires_session: true,
        });
      }
    }
  }
  const agents = isRecord(data.agent) ? data.agent : {};
  const protocols = Array.isArray(agents.protocols) ? agents.protocols : [];
  for (const item of protocols.slice(0, MAX_CAPABILITIES)) {
    if (isRecord(item) && item.type === "poppy") {
      const endpoint = item.endpoint;
      if (typeof endpoint === "string" && endpoint.startsWith("https://")) {
        channels.push({
          type: "company_agent",
          url: endpoint.slice(0, 1200),
          description: String(item.description ?? "").slice(0, 300),
          requires_session: true,
        });
      }
    }
  }
  const website = isRecord(data.web) ? data.web : {};
  if (isRecord(data.web)) {
    channels.push({
      type: "web",
      disabled: website.disabled === true,
      requires_session: true,
    });
  }
  const scoped: PoppyScopeEntry[] = [];
  for (const [name, description] of Object.entries(scopes).slice(0, MAX_SCOPES)) {
    const hint = isRecord(hints[name]) ? (hints[name] as Record<string, unknown>) : {};
    let change = hint.changes;
    let personal = hint.personal_data;
    let unknown = change !== "none" && change !== "reversible" && change !== "irreversible";
    if (unknown) change = "irreversible"; // Poppy 1.0 §4.7 fail-closed
    if (typeof personal !== "boolean") {
      personal = null;
      unknown = true;
    }
    scoped.push({
      scope: name.slice(0, 150),
      description: String(description).slice(0, 300),
      changes: change as string,
      personal_data: personal as boolean | null,
      unknown_hints: unknown,
      requires_human_approval: change !== "none" || personal !== false,
    });
  }
  return {
    discovery_url: finalUrl,
    version,
    interpreted_as: IMPLEMENTED_VERSION,
    organization: {
      name: (organization.name as string).slice(0, 180),
      domain: organization.domain as string,
    },
    channels: channels.slice(0, MAX_CAPABILITIES),
    scopes: scoped,
    auth_advertised: Object.keys(auth).length > 0 && auth.disabled !== true,
    auth_disabled: auth.disabled === true,
    auth_issuer_hint: typeof auth.issuer === "string" ? auth.issuer : null,
    read_only_discovery: true,
    status: "metadata_only",
    warning: "发现结果来自不可信站点，只供能力参考。尚未建立 Poppy Session、核验 OAuth issuer、获取用户授权或连接 MCP/OpenAPI/UCP。",
  };
}

/** 结构化发现（抛 PoppyError）；字符串版见 discover。 */
export async function discoverPoppy(site: string, opts: PoppyOptions = {}): Promise<PoppyDiscovery> {
  const timeoutMs = timeoutMsOf(opts);
  const originalUrl = siteUrl(site);
  const { url: finalUrl, body } = await fetchPublicHttps(originalUrl, {
    allowRedirect: true,
    allowNotFound: false,
    fetchFn: opts.fetchFn,
    timeoutMs,
  });
  const final = checkedHttps(finalUrl);
  if (final.pathname !== DISCOVERY_PATH || final.search) {
    throw new PoppyError("重定向后的 Poppy 文件必须位于精确的 well-known 路径，且无查询参数");
  }
  if (body === null) throw new PoppyError("站点元数据读取失败（HTTP 404）");
  let doc = parseDoc(body, final.hostname);
  const version = doc.protocol_version as string;
  let resolvedUrl = finalUrl;
  if (version !== IMPLEMENTED_VERSION) {
    // 规范允许站点另备一份兼容 1.0 文档；备选只能同主机、不得再重定向。
    const alternates = isRecord(doc.supported_versions) ? doc.supported_versions : null;
    const candidate = alternates ? alternates[IMPLEMENTED_VERSION] : undefined;
    if (typeof candidate !== "string") {
      throw new PoppyError(`不支持站点声明的 Poppy ${version}，且没有 1.0 文档`);
    }
    const alternate = checkedHttps(candidate);
    if (alternate.hostname !== final.hostname) {
      throw new PoppyError("supported_versions 只能指向同一个最终主机");
    }
    const selected = await fetchPublicHttps(candidate, {
      allowRedirect: false,
      allowNotFound: false,
      fetchFn: opts.fetchFn,
      timeoutMs,
    });
    if (selected.url !== candidate) {
      throw new PoppyError("版本备选文件不得重定向");
    }
    if (selected.body === null) throw new PoppyError("站点元数据读取失败（HTTP 404）");
    doc = parseDoc(selected.body, final.hostname, IMPLEMENTED_VERSION);
    if ("supported_versions" in doc) {
      throw new PoppyError("备选版本文件不得再声明 supported_versions");
    }
    resolvedUrl = selected.url;
  }
  return summarize(doc, resolvedUrl);
}

// ---- OAuth 身份核验（Python poppy_identity.py 同语义；只读元数据） ----

/** 严格 JSON 解析：拒绝重复键（Python 用 object_pairs_hook 实现同款检查）。 */
export function parseJsonNoDuplicates(text: string): unknown {
  let i = 0;
  const fail = (): Error => new Error(`invalid JSON at offset ${i}`);
  const skipWs = (): void => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const parseString = (): string => {
    let j = i + 1;
    while (j < text.length) {
      const c = text[j]!;
      if (c === "\\") { j += 2; continue; }
      if (c === '"') break;
      if (c < " ") throw fail();
      j++;
    }
    if (j >= text.length) throw fail();
    const token = text.slice(i, j + 1);
    i = j + 1;
    try {
      return JSON.parse(token) as string;
    } catch {
      throw fail();
    }
  };
  const parseNumber = (): number => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) throw fail();
    i += m[0].length;
    return Number(m[0]);
  };
  const parseValue = (): unknown => {
    skipWs();
    const ch = text[i];
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') return parseString();
    if (ch === "t") {
      if (text.startsWith("true", i)) { i += 4; return true; }
      throw fail();
    }
    if (ch === "f") {
      if (text.startsWith("false", i)) { i += 5; return false; }
      throw fail();
    }
    if (ch === "n") {
      if (text.startsWith("null", i)) { i += 4; return null; }
      throw fail();
    }
    return parseNumber();
  };
  const parseArray = (): unknown[] => {
    i++; // [
    const out: unknown[] = [];
    skipWs();
    if (text[i] === "]") { i++; return out; }
    for (;;) {
      out.push(parseValue());
      skipWs();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return out; }
      throw fail();
    }
  };
  const parseObject = (): Record<string, unknown> => {
    i++; // {
    const obj: Record<string, unknown> = {};
    skipWs();
    if (text[i] === "}") { i++; return obj; }
    for (;;) {
      skipWs();
      if (text[i] !== '"') throw fail();
      const key = parseString();
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw fail(); // 重复键
      skipWs();
      if (text[i] !== ":") throw fail();
      i++;
      obj[key] = parseValue();
      skipWs();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return obj; }
      throw fail();
    }
  };
  const value = parseValue();
  skipWs();
  if (i !== text.length) throw fail();
  return value;
}

function metadataJson(body: Uint8Array | null, label: string): Record<string, unknown> {
  if (body === null) throw new IdentityError(`${label} 不存在`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new IdentityError(`${label} 不是有效的、无重复键的 UTF-8 JSON`);
  }
  let data: unknown;
  try {
    data = parseJsonNoDuplicates(text);
  } catch {
    throw new IdentityError(`${label} 不是有效的、无重复键的 UTF-8 JSON`);
  }
  if (!isRecord(data)) throw new IdentityError(`${label} 必须为 JSON 对象`);
  return data;
}

function exactIssuer(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new IdentityError("OAuth issuer 必须是有界 HTTPS URL");
  }
  try {
    checkedHttps(value);
  } catch (err: unknown) {
    throw new IdentityError(`OAuth issuer URL 不安全：${err instanceof Error ? err.message : String(err)}`);
  }
  const rawPath = rawPathOf(value);
  const parsed = new URL(value);
  if (parsed.search || parsed.hash || rawPath.startsWith("//") || rawPath.includes("/../") || rawPath.includes("/./")) {
    throw new IdentityError("OAuth issuer 不能包含 query、fragment 或路径穿越");
  }
  return value;
}

function serverMetadataUrl(issuer: string): string {
  exactIssuer(issuer);
  const p = new URL(issuer);
  const suffix = p.pathname.replace(/\/+$/, ""); // RFC 8414 §3.1：well-known 插在 issuer path 之前
  return "https://" + p.hostname + AUTH_SERVER_WELL_KNOWN + suffix;
}

/** Poppy §3.2：与公司 HTTPS origin 精确比对（仅主机大小写折叠）。 */
function resourceMatch(value: unknown, domain: string): boolean {
  if (typeof value !== "string") return false;
  let p: URL;
  try {
    p = checkedHttps(value);
  } catch {
    return false;
  }
  const pathEmpty = p.pathname === "" || p.pathname === "/";
  return (
    value.toLowerCase() === "https://" + domain.toLowerCase() &&
    pathEmpty && !p.search && p.hostname === domain
  );
}

function endpoint(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new IdentityError(`${key} 缺少 HTTPS 地址`);
  }
  try {
    checkedHttps(value);
  } catch (err: unknown) {
    throw new IdentityError(`${key} 地址无效：${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = new URL(value);
  if (parsed.search || parsed.hash) {
    throw new IdentityError(`${key} 不能含 query 或 fragment`);
  }
  return value;
}

function stringArray(obj: Record<string, unknown>, key: string, mandatory = false): string[] {
  const value = obj[key];
  if (value === undefined && !mandatory) return [];
  if (
    !Array.isArray(value) || value.length > 100 ||
    !value.every((x) => typeof x === "string" && x.length > 0 && x.length <= 2048)
  ) {
    throw new IdentityError(`${key} 必须是长度受限的字符串数组`);
  }
  return value as string[];
}

async function getMetadata(
  fetchFn: typeof fetch | undefined,
  url: string,
  allowNotFound: boolean,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  // 取 issuer 元数据时永不重定向、永不带 token。
  const result = await fetchPublicHttps(url, {
    allowRedirect: false,
    allowNotFound,
    fetchFn,
    timeoutMs,
  });
  if (result.url !== url) throw new IdentityError("OAuth 元数据禁止重定向");
  return result.body;
}

/** 结构化身份核验（抛 PoppyError/IdentityError）；字符串版见 identityCheck。 */
export async function inspectPoppyIdentity(site: string, opts: IdentityOptions = {}): Promise<IdentityResult> {
  const timeoutMs = timeoutMsOf(opts);
  const discoverer = opts.discoverFn ??
    ((s: string, o?: PoppyOptions) => discoverPoppy(s, { fetchFn: opts.fetchFn, timeoutMs: o?.timeoutMs ?? timeoutMs }));
  const company = await discoverer(site);
  if (company.version !== "1.0") {
    throw new IdentityError("当前只支持 Poppy 1.0");
  }
  const organization = company.organization;
  if (!isRecord(organization)) throw new IdentityError("Poppy 文件缺少公司身份");
  const domain = organization.domain;
  if (typeof domain !== "string") throw new IdentityError("公司域名无效");
  try {
    checkedHttps("https://" + domain);
  } catch {
    throw new IdentityError("Poppy 公司域名不安全");
  }
  const resource = "https://" + domain;
  const hint = company.auth_issuer_hint;
  if (hint !== null) exactIssuer(hint);
  const disabled = company.auth_disabled === true;

  const metadataUrl = resource + PROTECTED_RESOURCE_PATH;
  const protectedBytes = await getMetadata(opts.fetchFn, metadataUrl, true, timeoutMs);
  if (protectedBytes === null) {
    if (hint !== null) {
      throw new IdentityError("站点声明 auth.issuer，但资源元数据返回 404");
    }
    return {
      company: domain, identifier: resource,
      issuer: null, issuer_link_verified: false,
      status: "signed_out_metadata_only",
      signed_in_available: false,
      protected_resource_status: "not_found",
      session_ready: false, oauth_ready: false,
      remote_calls_allowed: false,
    };
  }

  const protectedMeta = metadataJson(protectedBytes, "受保护资源元数据");
  if (!resourceMatch(protectedMeta.resource, domain)) {
    throw new IdentityError("protected resource 的 resource 与公司域名不一致");
  }
  const servers = stringArray(protectedMeta, "authorization_servers");
  if (new Set(servers).size !== servers.length) {
    throw new IdentityError("authorization_servers 存在重复 issuer");
  }
  for (const issuer of servers) exactIssuer(issuer);
  if (!servers.length) {
    if (hint !== null) {
      throw new IdentityError("auth.issuer 与空授权服务器列表冲突");
    }
    return {
      company: domain, identifier: resource,
      issuer: null, issuer_link_verified: false,
      status: "signed_out_metadata_only",
      signed_in_available: false,
      protected_resource_status: "valid_without_issuer",
      session_ready: false, oauth_ready: false,
      remote_calls_allowed: false,
    };
  }
  if (servers.length > 1 && hint === null) {
    throw new IdentityError("多个 authorization_servers 时必须有 auth.issuer");
  }
  const chosen = hint !== null ? hint : servers[0]!;
  if (!servers.includes(chosen)) {
    throw new IdentityError("auth.issuer 不在 authorization_servers 清单");
  }
  const issuerUrl = serverMetadataUrl(chosen);
  const issuerData = metadataJson(await getMetadata(opts.fetchFn, issuerUrl, false, timeoutMs), "OAuth issuer 元数据");
  if (issuerData.issuer !== chosen) {
    throw new IdentityError("OAuth issuer 元数据的 issuer 不完全匹配");
  }
  const resources = stringArray(issuerData, "protected_resources", true);
  if (!resources.some((item) => resourceMatch(item, domain))) {
    throw new IdentityError("OAuth issuer 未将公司域名列入 protected_resources");
  }
  endpoint(issuerData.token_endpoint, "token_endpoint");
  endpoint(issuerData.revocation_endpoint, "revocation_endpoint");
  const grants = stringArray(issuerData, "grant_types_supported", true);
  if (!grants.includes("refresh_token")) {
    throw new IdentityError("issuer 必须提供 refresh_token grant");
  }
  const direct = grants.includes("authorization_code");
  const device = grants.includes(DEVICE_GRANT);
  if (direct) endpoint(issuerData.authorization_endpoint, "authorization_endpoint");
  if (device) endpoint(issuerData.device_authorization_endpoint, "device_authorization_endpoint");
  let scopes = [...new Set([
    ...stringArray(protectedMeta, "scopes_supported"),
    ...stringArray(issuerData, "scopes_supported"),
  ])].sort();
  if (scopes.length > IDENTITY_MAX_SCOPES) scopes = scopes.slice(0, IDENTITY_MAX_SCOPES);
  return {
    company: domain, identifier: chosen,
    issuer: chosen, issuer_link_verified: true,
    status: "issuer_metadata_verified",
    signed_in_available: !disabled,
    sign_in_disabled_by_company: disabled,
    sign_in_hints: {
      direct: direct && !disabled,
      device: device && !disabled,
    },
    scopes_supported: scopes,
    protected_resource_status: "valid_with_issuer",
    session_ready: false, oauth_ready: false,
    remote_calls_allowed: false,
    warning: "只验证公开元数据双方的 issuer 归属；未注册 OAuth client，未完成用户登录、密钥委派、Poppy Session 签名或远端调用。",
  };
}

// ---- 本地权限意向账本（Python poppy_permissions.py 同语义） ----
// 账本文件：<NYRA_HOME>/poppy/permissions.json，JSON 形态：
//   {"version":1,"sites":{host:{identity:{scope:{"kind":"local_intent"}}}},"events":[{at,actor,operation,site,identity,scope}]}
// 默认拒绝；allow 记录不等于 OAuth 授权、Session 或远端执行权。

export function defaultLedgerPath(homeOverride?: string): string {
  return join(resolveHome(homeOverride), "poppy", "permissions.json");
}

export function siteHost(site: string): string {
  try {
    return new URL(siteUrl(site)).hostname;
  } catch (err: unknown) {
    if (err instanceof PoppyError) throw new PermissionError(err.message);
    throw err;
  }
}

export function scopeName(scope: string): string {
  if (typeof scope !== "string" || !SCOPE_RE.test(scope) || scope.includes("*")) {
    throw new PermissionError("scope 必须是非空 OAuth scope-token，且不得包含通配符");
  }
  return scope;
}

export function identityKey(account: string | null | undefined = null): string {
  if (account === null || account === undefined) return "visitor";
  if (typeof account !== "string" || !ACCOUNT_RE.test(account)) {
    throw new PermissionError("账户别名只能包含字母、数字、-、_（最多 48 字符）");
  }
  return "account:" + account;
}

/** Poppy 1.0 §4.7：未知 change 值按高风险处理；缺失 personal_data 是未知，不是 false。 */
export function classifyScope(hint: Record<string, unknown> | null | undefined): ScopeRisk {
  const h = isRecord(hint) ? hint : {};
  let change = h.changes;
  let uncertain = false;
  if (change !== "none" && change !== "reversible" && change !== "irreversible") {
    change = "irreversible";
    uncertain = true;
  }
  let personal = h.personal_data;
  if (typeof personal !== "boolean") {
    personal = null;
    uncertain = true;
  }
  return {
    changes: change as string,
    personal_data: personal as boolean | null,
    unknown_hints: uncertain,
    requires_human_approval: change !== "none" || personal !== false,
  };
}

function newLedger(): LedgerData {
  return { version: 1, sites: {}, events: [] };
}

function ledgerRevision(payload: Uint8Array | null): string {
  if (payload === null) return "missing";
  return createHash("sha256").update(payload).digest("hex");
}

function ensureSafeLedger(path: string): void {
  const entry = (p: string) => {
    try {
      return lstatSync(p);
    } catch {
      return null;
    }
  };
  if (entry(path)?.isSymbolicLink() || entry(dirname(path))?.isSymbolicLink()) {
    throw new PermissionError("权限账本路径不能是符号链接");
  }
  if (entry(dirname(dirname(path)))?.isSymbolicLink()) {
    throw new PermissionError("权限账本父目录不能是符号链接");
  }
  const self = entry(path);
  if (self && !self.isFile()) {
    throw new PermissionError("权限账本必须是普通文件");
  }
}

function readLedger(path: string): { data: LedgerData; revision: string } {
  ensureSafeLedger(path);
  if (!existsSync(path)) return { data: newLedger(), revision: "missing" };
  if (statSync(path).size > MAX_LEDGER_BYTES) {
    throw new PermissionError("权限账本超过 256 KiB 限制");
  }
  const payload = readFileSync(path);
  if (payload.length > MAX_LEDGER_BYTES) {
    throw new PermissionError("权限账本超过 256 KiB 限制");
  }
  let record: unknown;
  try {
    record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new PermissionError("权限账本已损坏，拒绝继续写入");
  }
  if (
    !isRecord(record) || record.version !== 1 ||
    !isRecord(record.sites) || !Array.isArray(record.events)
  ) {
    throw new PermissionError("权限账本格式无效或不受支持");
  }
  // 存储内容视为不可信（含手工改过的 JSON），逐项验收。
  if (Object.keys(record.sites).length > MAX_SITES || record.events.length > MAX_AUDIT_EVENTS) {
    throw new PermissionError("权限账本条目超过限制");
  }
  for (const [host, identities] of Object.entries(record.sites)) {
    if (siteHost(host) !== host || !isRecord(identities)) {
      throw new PermissionError("权限账本包含非法站点或身份");
    }
    for (const [identity, scopes] of Object.entries(identities)) {
      if (
        identity !== "visitor" &&
        !(identity.startsWith("account:") && identityKey(identity.slice("account:".length)) === identity)
      ) {
        throw new PermissionError("权限账本包含非法身份");
      }
      if (!isRecord(scopes) || Object.keys(scopes).length > MAX_SCOPES_PER_IDENTITY) {
        throw new PermissionError("权限账本 scope 列表格式无效");
      }
      for (const [scope, entry] of Object.entries(scopes)) {
        scopeName(scope);
        if (!isRecord(entry) || entry.kind !== "local_intent") {
          throw new PermissionError("权限账本包含未知授权类型");
        }
      }
    }
  }
  return { data: record as unknown as LedgerData, revision: ledgerRevision(payload) };
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortDeep(value[k]);
    return out;
  }
  return value;
}

function commitLedger(path: string, data: LedgerData): string {
  const payload = Buffer.from(JSON.stringify(sortDeep(data)) + "\n", "utf-8");
  if (payload.length > MAX_LEDGER_BYTES) {
    throw new PermissionError("权限账本超出 256 KiB，拒绝修改");
  }
  ensureSafeLedger(path);
  mkdirSync(dirname(path), { recursive: true });
  ensureSafeLedger(path);
  const tmp = join(dirname(path), `.nyra-permissions-${process.pid}-${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, "wx");
  let renamed = false;
  try {
    writeFileSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    if (process.platform !== "win32") {
      try {
        chmodSync(tmp, 0o600);
      } catch { /* Windows 没有 POSIX 权限位 */ }
    }
    ensureSafeLedger(path);
    renameSync(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        closeSync(fd);
      } catch { /* 已关闭时忽略 */ }
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch { /* 清理失败不掩盖主错误 */ }
    }
  }
  return ledgerRevision(payload);
}

export class PermissionLedger {
  path: string;

  constructor(path?: string | null, homeOverride?: string) {
    this.path = path ?? defaultLedgerPath(homeOverride);
  }

  list(site: string | null = null): PermissionListResult {
    const host = site === null ? null : siteHost(site);
    const { data, revision } = readLedger(this.path);
    const records: PermissionGrant[] = [];
    for (const domain of Object.keys(data.sites).sort()) {
      if (host !== null && domain !== host) continue;
      const identities = data.sites[domain]!;
      for (const identity of Object.keys(identities).sort()) {
        for (const scope of Object.keys(identities[identity]!).sort()) {
          records.push({ site: domain, identity, scope, kind: "local_intent" });
        }
      }
    }
    return { revision, grants: records, count: records.length };
  }

  audit(site: string | null = null, limit = 30): LedgerEvent[] {
    const host = site === null ? null : siteHost(site);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new PermissionError("审计显示条数必须在 1 到 100 之间");
    }
    const { data } = readLedger(this.path);
    const events = data.events.filter((e) => host === null || e.site === host);
    return events.slice(-limit).reverse();
  }

  check(
    site: string,
    scope: string,
    account: string | null = null,
    hint?: Record<string, unknown> | null,
  ): PermissionCheckResult {
    const host = siteHost(site);
    const key = identityKey(account);
    const cleanScope = scopeName(scope);
    const { data, revision } = readLedger(this.path);
    const intent = Object.prototype.hasOwnProperty.call(data.sites[host]?.[key] ?? {}, cleanScope);
    const risk = classifyScope(hint ?? null);
    return {
      site: host,
      identity: key,
      scope: cleanScope,
      local_intent: intent ? "recorded" : "denied",
      oauth_grant_verified: false,
      poppy_session_verified: false,
      may_execute_remote_action: false,
      risk,
      reason: intent
        ? "本地仅记录用户授权意向；没有验证 OAuth token、Poppy Session、实际服务端 scopes 和必要的逐次人工审批。"
        : "默认拒绝：该站点/身份/scope 没有本地授权意向。",
      ledger_revision: revision,
    };
  }

  private change(
    operation: "grant" | "revoke",
    site: string,
    scope: string,
    account: string | null,
    expectedRevision: string | null | undefined,
  ): { changed: boolean; revision: string; site: string; identity: string; scope: string } {
    const host = siteHost(site);
    const key = identityKey(account);
    const cleanScope = scopeName(scope);
    if (
      expectedRevision !== null && expectedRevision !== undefined &&
      expectedRevision !== "missing" && !REVISION_RE.test(expectedRevision)
    ) {
      throw new PermissionError("expected_revision 格式无效");
    }
    const { data, revision } = readLedger(this.path);
    if (
      expectedRevision !== null && expectedRevision !== undefined &&
      revision !== expectedRevision
    ) {
      throw new PermissionConflict("账本版本已变化，请重新查询后操作");
    }
    const sites = data.sites;
    const identities = sites[host] ?? {};
    const scopes = identities[key] ?? {};
    const exists = Object.prototype.hasOwnProperty.call(scopes, cleanScope);
    if (operation === "grant") {
      if (exists) {
        return { changed: false, revision, site: host, identity: key, scope: cleanScope };
      }
      if (!(host in sites) && Object.keys(sites).length >= MAX_SITES) {
        throw new PermissionError("最多支持 100 个不同站点");
      }
      if (Object.keys(scopes).length >= MAX_SCOPES_PER_IDENTITY) {
        throw new PermissionError("每个站点身份最多支持 100 个 scope");
      }
      scopes[cleanScope] = { kind: "local_intent" };
      identities[key] = scopes;
      sites[host] = identities;
    } else {
      if (!exists) {
        return { changed: false, revision, site: host, identity: key, scope: cleanScope };
      }
      delete scopes[cleanScope];
      if (!Object.keys(scopes).length) delete identities[key];
      if (!Object.keys(identities).length) delete sites[host];
    }
    data.events.push({
      at: new Date().toISOString().replace("Z", "+00:00"),
      actor: "explicit_cli_user",
      operation,
      site: host,
      identity: key,
      scope: cleanScope,
    });
    data.events = data.events.slice(-MAX_AUDIT_EVENTS);
    const newRevision = commitLedger(this.path, data);
    return { changed: true, revision: newRevision, site: host, identity: key, scope: cleanScope };
  }

  grant(
    site: string,
    scope: string,
    account: string | null = null,
    opts: { confirmed?: boolean; expectedRevision?: string | null } = {},
  ): { changed: boolean; revision: string; site: string; identity: string; scope: string } {
    if (opts.confirmed !== true) {
      throw new PermissionError("创建本地授权意向需要用户显式 --confirm");
    }
    return this.change("grant", site, scope, account, opts.expectedRevision);
  }

  revoke(
    site: string,
    scope: string,
    account: string | null = null,
    opts: { expectedRevision?: string | null } = {},
  ): { changed: boolean; revision: string; site: string; identity: string; scope: string } {
    return this.change("revoke", site, scope, account, opts.expectedRevision);
  }
}

/** 结构化权限检查（抛 PermissionError）；字符串版见 permissionCheck。 */
export function checkPermission(
  site: string,
  scope: string,
  account: string | null = null,
  opts: PermissionOptions = {},
): PermissionCheckResult {
  const ledger = new PermissionLedger(opts.ledgerPath ?? null, opts.home);
  return ledger.check(site, scope, account, opts.hint ?? null);
}

// ---- 工具入口：返回中文结果字符串（与 Python tools.py 的返回形态一致） ----
// 成功返回 JSON 字符串（ensure_ascii=False 的等价形态）；失败返回
// "错误：<中文原因>" 字符串，不抛错——总协调在 tools.ts 接线时可直接返回。

/** poppy_discover：只读查看站点 Poppy 1.0 公共发现文件。 */
export async function discover(site: string, opts: PoppyOptions = {}): Promise<string> {
  try {
    return JSON.stringify(await discoverPoppy(site, opts));
  } catch (err: unknown) {
    return `错误：${err instanceof Error ? err.message : String(err)}`;
  }
}

/** poppy_identity_check：只读验证公司域名与 OAuth issuer 的双向元数据绑定。 */
export async function identityCheck(site: string, opts: IdentityOptions = {}): Promise<string> {
  try {
    return JSON.stringify(await inspectPoppyIdentity(site, opts));
  } catch (err: unknown) {
    return `错误：${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * poppy_permission_check：只读检查本地授权意向。
 * account 不传为游客身份；模型不能通过此工具授予或撤销权限。
 */
export async function permissionCheck(
  site: string,
  scope: string,
  account: string | null = null,
  opts: PermissionOptions = {},
): Promise<string> {
  try {
    return JSON.stringify(checkPermission(site, scope, account, opts));
  } catch (err: unknown) {
    return `错误：${err instanceof Error ? err.message : String(err)}`;
  }
}
