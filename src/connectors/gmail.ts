// src/connectors/gmail.ts — 原生应用连接器：Gmail（缺口 6，第一批）。
//
// 设计（见 docs/connectors-gmail.md）：
// - 连接器只读用户授权的范围；token 只存密码箱（vault.json 的 gmail-oauth
//   条目），绝不进配置文件与日志；client_id / client_secret 同样只存密码箱
//   （gmail-oauth-client 条目），配置文件里只有 enabled 开关。
// - OAuth 走标准授权码流程 + 本机回环回调（Desktop app 类型客户端）；
//   不用任何 Google SDK，只用全局 fetch 调 Gmail REST API，不引新依赖。
// - 收（search/read）是只读工具，不走审批；发（send/draft）走与 write_file
//   同级的显式审批（见 tools.ts），且每次代发都写一条证据记录。
// - 邮件正文是不可信外部数据：工具层用 wrapUntrusted 框起来再交给模型，
//   这里只负责原样取回，不做清洗、不执行其中任何指令性文字。
// - 本模块不做网络上的任何“聪明事”：URL 全部由固定 host + 校验过的
//   message id 拼成，用户输入永远成不了 URL 的 host；token 刷新失败即
//   报“授权失效、请重新授权”，不静默降级、不重试三次以上。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { getCredential, Vault, vaultPath } from "../vault.ts";

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
export const GMAIL_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** 申请的 scope：读邮件 + 发邮件 + 建草稿（缺口 6 第一批的全部能力）。 */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
];
/** 密码箱条目名：token 与 OAuth 客户端各一条，名字明文、值加密（见 vault.ts）。 */
export const GMAIL_VAULT_TOKENS_ENTRY = "gmail-oauth";
export const GMAIL_VAULT_CLIENT_ENTRY = "gmail-oauth-client";
/** 单次 search 最多返回的条数（硬顶：既是 Gmail API 的合理页大小， */
/** 也是防模型一次吞太多邮件正文的上限；多翻页用 pageToken 接着取）。 */
export const GMAIL_MAX_SEARCH_RESULTS = 25;
export const GMAIL_DEFAULT_SEARCH_RESULTS = 10;
/** 单次 API 请求超时（毫秒）；token 刷新、收发都走同一口径。 */
export const GMAIL_REQUEST_TIMEOUT_MS = 30_000;
/** 回环回调等待授权码的最长时长（毫秒）：用户要在浏览器里点完同意。 */
export const GMAIL_AUTH_TIMEOUT_MS = 5 * 60_000;

export class GmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailError";
  }
}

/** 授权失效（refresh token 坏了/被撤销/过期）：唯一的出路是重新跑 nyra gmail auth。 */
export class GmailAuthError extends GmailError {
  constructor(message: string) {
    super(message);
    this.name = "GmailAuthError";
  }
}

export interface GmailTokens {
  access_token: string;
  refresh_token: string;
  /** access_token 过期时刻（毫秒 epoch，由 expires_in 算出）。 */
  expires_at: number;
  scope?: string;
  /** 授权时从 profile 取回的邮箱地址（只作展示，不作身份判定）。 */
  email?: string;
}

export interface GmailClient {
  client_id: string;
  client_secret: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labels?: string[];
}

export interface GmailMessage extends GmailMessageSummary {
  /** 正文纯文本（有 text/plain 优先用它；只有 HTML 时由 HTML 去标签得到）。 */
  bodyText: string;
  /** 原始 HTML 正文（有才给；模型不直接读它，读 bodyText）。 */
  bodyHtml?: string;
}

export interface GmailSendOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** 回复时传原邮件的 threadId，Gmail 会把这封归进同一串。 */
  threadId?: string;
}

export interface GmailTransport {
  search(query: string, maxResults?: number, pageToken?: string): Promise<{ messages: GmailMessageSummary[]; nextPageToken?: string }>;
  get(id: string): Promise<GmailMessage>;
  send(opts: GmailSendOptions): Promise<{ id: string; threadId: string }>;
  createDraft(opts: GmailSendOptions): Promise<{ id: string }>;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function b64urlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf.toString("base64url");
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/** Gmail message id 只允许 URL 安全字符：用户输入永远拼不成越界路径。 */
export function isValidGmailMessageId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function assertMessageId(id: string): void {
  if (!isValidGmailMessageId(id)) throw new GmailError(`邮件 id 不合法：${id}`);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Subject 含非 ASCII 时按 RFC 2047 编成 =?UTF-8?B?...?=，否则 Gmail 会乱码。 */
export function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

/** 发件/草稿的 RFC 822 原文（纯文本 UTF-8），再整体 base64url 编码给 Gmail API。 */
export function buildRawMessage(opts: GmailSendOptions): string {
  const lines: string[] = [];
  lines.push(`To: ${opts.to.join(", ")}`);
  if (opts.cc?.length) lines.push(`Cc: ${opts.cc.join(", ")}`);
  if (opts.bcc?.length) lines.push(`Bcc: ${opts.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeSubject(opts.subject)}`);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: 8bit");
  lines.push("");
  lines.push(opts.body);
  return b64urlEncode(lines.join("\r\n"));
}

export function buildAuthUrl(opts: { clientId: string; redirectUri: string; state: string; scopes?: string[] }): string {
  const url = new URL(GMAIL_AUTH_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (opts.scopes ?? GMAIL_SCOPES).join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", opts.state);
  return url.toString();
}

/** token 端点返回的 JSON 转 GmailTokens：缺字段即报错，不猜、不补默认值。 */
export function parseTokens(data: unknown): GmailTokens {
  if (!data || typeof data !== "object") throw new GmailError("token 端点返回了无法识别的内容");
  const d = data as Record<string, unknown>;
  if (typeof d.access_token !== "string" || !d.access_token) throw new GmailError("token 端点没有返回 access_token");
  if (typeof d.refresh_token !== "string" || !d.refresh_token) throw new GmailError("token 端点没有返回 refresh_token（请确认授权时选了 offline 访问）");
  if (typeof d.expires_in !== "number" || d.expires_in <= 0) throw new GmailError("token 端点没有返回有效的 expires_in");
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: Date.now() + d.expires_in * 1000,
    ...(typeof d.scope === "string" && d.scope ? { scope: d.scope } : {}),
  };
}

async function postForm(url: string, params: Record<string, string>, fetchFn: FetchFn): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GMAIL_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 响应按错误处理 */ }
    if (!res.ok) {
      const detail = data && typeof data === "object" && typeof (data as Record<string, unknown>).error_description === "string"
        ? String((data as Record<string, unknown>).error_description)
        : `HTTP ${res.status}`;
      throw new GmailError(`token 端点请求失败：${detail}`);
    }
    return data;
  } catch (err: unknown) {
    if (err instanceof GmailError) throw err;
    throw new GmailError(`token 端点请求失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangeCodeForTokens(opts: {
  client: GmailClient; code: string; redirectUri: string; fetchFn?: FetchFn;
}): Promise<GmailTokens> {
  const data = await postForm(GMAIL_OAUTH_TOKEN_URL, {
    code: opts.code,
    client_id: opts.client.client_id,
    client_secret: opts.client.client_secret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
  }, opts.fetchFn ?? fetch);
  return parseTokens(data);
}

export async function refreshAccessToken(opts: {
  client: GmailClient; refreshToken: string; fetchFn?: FetchFn;
}): Promise<GmailTokens> {
  let data: unknown;
  try {
    data = await postForm(GMAIL_OAUTH_TOKEN_URL, {
      refresh_token: opts.refreshToken,
      client_id: opts.client.client_id,
      client_secret: opts.client.client_secret,
      grant_type: "refresh_token",
    }, opts.fetchFn ?? fetch);
  } catch (err: unknown) {
    // 刷新失败就是授权失效（refresh token 坏了/被撤销/过期），直接报 auth 错误。
    throw new GmailAuthError(`刷新 token 失败：${err instanceof Error ? err.message : String(err)}（请重新运行 nyra gmail auth）`);
  }
  if (!data || typeof data !== "object") throw new GmailAuthError("刷新 token 失败：token 端点返回了无法识别的内容");
  const d = data as Record<string, unknown>;
  if (typeof d.access_token !== "string" || !d.access_token) {
    throw new GmailAuthError("刷新 token 失败：没有返回新的 access_token（refresh token 可能已被撤销，请重新运行 nyra gmail auth）");
  }
  if (typeof d.expires_in !== "number" || d.expires_in <= 0) throw new GmailAuthError("刷新 token 失败：没有返回有效的 expires_in");
  return {
    access_token: d.access_token,
    // 刷新时 Google 通常不返回新的 refresh_token：旧的继续用。
    refresh_token: typeof d.refresh_token === "string" && d.refresh_token ? d.refresh_token : opts.refreshToken,
    expires_at: Date.now() + d.expires_in * 1000,
    ...(typeof d.scope === "string" && d.scope ? { scope: d.scope } : {}),
  };
}

/** 吊销 refresh token（尽力而为：Google  unreachable 时只报错，不拦本地清理）。 */
export async function revokeRefreshToken(opts: { token: string; fetchFn?: FetchFn }): Promise<void> {
  await postForm(GMAIL_OAUTH_REVOKE_URL, { token: opts.token }, opts.fetchFn ?? fetch);
}

function headerValue(headers: Array<{ name?: string; value?: string }>, name: string): string {
  const found = headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase());
  return found?.value ?? "";
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function collectBodies(part: GmailPart, out: { text?: string; html?: string }): void {
  if (part.mimeType === "text/plain" && part.body?.data && out.text === undefined) {
    out.text = b64urlDecode(part.body.data).toString("utf-8");
  } else if (part.mimeType === "text/html" && part.body?.data && out.html === undefined) {
    out.html = b64urlDecode(part.body.data).toString("utf-8");
  }
  for (const sub of part.parts ?? []) collectBodies(sub, out);
}

function parseMessage(data: unknown): GmailMessage {
  if (!data || typeof data !== "object") throw new GmailError("Gmail 返回了无法识别的邮件内容");
  const d = data as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id) throw new GmailError("Gmail 返回的邮件没有 id");
  const payload = (d.payload ?? {}) as { headers?: Array<{ name?: string; value?: string }>; body?: { data?: string }; parts?: GmailPart[] };
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  const bodies: { text?: string; html?: string } = {};
  collectBodies(payload as GmailPart, bodies);
  if (bodies.text === undefined && bodies.html !== undefined) bodies.text = stripTags(bodies.html);
  return {
    id: d.id,
    threadId: typeof d.threadId === "string" ? d.threadId : "",
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    subject: headerValue(headers, "Subject"),
    date: headerValue(headers, "Date"),
    snippet: typeof d.snippet === "string" ? d.snippet : "",
    labels: Array.isArray(d.labelIds) ? (d.labelIds as unknown[]).filter((x): x is string => typeof x === "string") : [],
    bodyText: bodies.text ?? "",
    ...(bodies.html !== undefined ? { bodyHtml: bodies.html } : {}),
  };
}

function parseMessageList(data: unknown): { messages: Array<{ id: string; threadId: string }>; nextPageToken?: string } {
  if (!data || typeof data !== "object") throw new GmailError("Gmail 返回了无法识别的邮件列表");
  const d = data as Record<string, unknown>;
  const list = Array.isArray(d.messages) ? d.messages : [];
  const messages = list
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && typeof (m as Record<string, unknown>).id === "string")
    .map((m) => ({ id: m.id as string, threadId: typeof m.threadId === "string" ? m.threadId : "" }));
  return {
    messages,
    ...(typeof d.nextPageToken === "string" && d.nextPageToken ? { nextPageToken: d.nextPageToken } : {}),
  };
}

/**
 * Gmail REST API 传输层：只调固定 host（gmail.googleapis.com /
 * oauth2.googleapis.com），不接受调用方传入任意 URL；401 时用 refresh token
 * 换一次并重试一次，刷新失败即报 GmailAuthError。
 */
export class GmailApiTransport implements GmailTransport {
  private tokens: GmailTokens;
  private readonly client: GmailClient;
  private readonly fetchFn: FetchFn;
  private readonly onTokensRefreshed?: (tokens: GmailTokens) => void;

  constructor(opts: {
    tokens: GmailTokens;
    client: GmailClient;
    fetchFn?: FetchFn;
    onTokensRefreshed?: (tokens: GmailTokens) => void;
  }) {
    this.tokens = opts.tokens;
    this.client = opts.client;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.onTokensRefreshed = opts.onTokensRefreshed;
  }

  /** 当前 token（测试与 CLI 状态展示用；调用方绝不能把它写进日志）。 */
  currentTokens(): GmailTokens {
    return this.tokens;
  }

  private async refresh(): Promise<void> {
    const next = await refreshAccessToken({
      client: this.client,
      refreshToken: this.tokens.refresh_token,
      fetchFn: this.fetchFn,
    });
    this.tokens = { ...next, ...(this.tokens.email ? { email: this.tokens.email } : {}) };
    try { this.onTokensRefreshed?.(this.tokens); } catch { /* 回调失败不破坏刷新本身 */ }
  }

  private async request(path: string, init: RequestInit, retryOnAuth = true): Promise<unknown> {
    if (this.tokens.expires_at - Date.now() < 60_000) {
      try { await this.refresh(); } catch (err: unknown) {
        if (err instanceof GmailAuthError) throw err;
        throw new GmailAuthError(`刷新 token 失败：${err instanceof Error ? err.message : String(err)}（请重新运行 nyra gmail auth）`);
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GMAIL_REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchFn(`${GMAIL_API_BASE}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.tokens.access_token}`, ...(init.headers ?? {}) },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      throw new GmailError(`Gmail 请求失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 && retryOnAuth) {
      try { await this.refresh(); } catch (err: unknown) {
        if (err instanceof GmailAuthError) throw err;
        throw new GmailAuthError(`刷新 token 失败：${err instanceof Error ? err.message : String(err)}（请重新运行 nyra gmail auth）`);
      }
      return this.request(path, init, false);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const data = JSON.parse(text) as { error?: { message?: string } };
        if (typeof data?.error?.message === "string" && data.error.message) detail = data.error.message;
      } catch { /* 非 JSON 错误体直接用状态码 */ }
      throw new GmailError(`Gmail 请求失败：${detail}`);
    }
    try { return JSON.parse(text) as unknown; } catch { throw new GmailError("Gmail 返回了无法识别的内容"); }
  }

  async search(query: string, maxResults: number = GMAIL_DEFAULT_SEARCH_RESULTS, pageToken?: string): Promise<{ messages: GmailMessageSummary[]; nextPageToken?: string }> {
    const q = query.trim();
    if (!q) throw new GmailError("gmail_search 需要查询词（Gmail 搜索语法，如 from:xxx、subject:xxx、is:unread）");
    const n = Math.min(Math.max(Math.floor(maxResults) || GMAIL_DEFAULT_SEARCH_RESULTS, 1), GMAIL_MAX_SEARCH_RESULTS);
    const params = new URLSearchParams({ q, maxResults: String(n) });
    if (pageToken) params.set("pageToken", pageToken);
    const list = parseMessageList(await this.request(`/users/me/messages?${params.toString()}`, { method: "GET" }));
    const summaries: GmailMessageSummary[] = [];
    for (const m of list.messages) {
      const full = await this.request(
        `/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        { method: "GET" },
      );
      const parsed = parseMessage(full);
      summaries.push({
        id: parsed.id, threadId: parsed.threadId, from: parsed.from, to: parsed.to,
        subject: parsed.subject, date: parsed.date, snippet: parsed.snippet, labels: parsed.labels,
      });
    }
    return { messages: summaries, ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}) };
  }

  async get(id: string): Promise<GmailMessage> {
    assertMessageId(id);
    return parseMessage(await this.request(`/users/me/messages/${id}?format=full`, { method: "GET" }));
  }

  async send(opts: GmailSendOptions): Promise<{ id: string; threadId: string }> {
    const body: Record<string, unknown> = { raw: buildRawMessage(opts) };
    if (opts.threadId) body.threadId = opts.threadId;
    const data = await this.request("/users/me/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as Record<string, unknown>;
    if (typeof data.id !== "string" || !data.id) throw new GmailError("Gmail 发送后没有返回邮件 id");
    return { id: data.id, threadId: typeof data.threadId === "string" ? data.threadId : "" };
  }

  async createDraft(opts: GmailSendOptions): Promise<{ id: string }> {
    const data = await this.request("/users/me/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw: buildRawMessage(opts), ...(opts.threadId ? { threadId: opts.threadId } : {}) } }),
    }) as Record<string, unknown>;
    const draft = (data.draft ?? data) as Record<string, unknown>;
    if (typeof draft.id !== "string" || !draft.id) throw new GmailError("Gmail 建草稿后没有返回草稿 id");
    return { id: draft.id };
  }

  /** 授权时取回的账号邮箱（GET /users/me/profile），只作状态展示。 */
  async profileEmail(): Promise<string> {
    const data = await this.request("/users/me/profile", { method: "GET" }) as Record<string, unknown>;
    if (typeof data.emailAddress !== "string" || !data.emailAddress) throw new GmailError("Gmail 没有返回账号邮箱");
    return data.emailAddress;
  }
}

/** 密码箱里静默读 token：无箱、无密码、密码错、条目缺失、内容损坏一律返回 null，不抛错。 */
export function loadGmailTokens(home: string): GmailTokens | null {
  const raw = getCredential(GMAIL_VAULT_TOKENS_ENTRY, home);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_at !== "number") return null;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      ...(typeof data.scope === "string" ? { scope: data.scope } : {}),
      ...(typeof data.email === "string" ? { email: data.email } : {}),
    };
  } catch {
    return null;
  }
}

/** 密码箱里静默读 OAuth 客户端（client_id + client_secret），读不到返回 null。 */
export function loadGmailClient(home: string): GmailClient | null {
  const raw = getCredential(GMAIL_VAULT_CLIENT_ENTRY, home);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.client_id !== "string" || !data.client_id || typeof data.client_secret !== "string" || !data.client_secret) return null;
    return { client_id: data.client_id, client_secret: data.client_secret };
  } catch {
    return null;
  }
}

/**
 * 刷新后把新 token 写回密码箱（尽力而为）：只有 NYRA_VAULT_PASSWORD 在时
 * 才能解锁写回；写不进去也不破坏本次运行——内存里的新 token 照常用，
 * 下次运行再刷新一次即可（refresh token 本身不变）。
 */
export function persistGmailTokens(home: string, tokens: GmailTokens): boolean {
  const password = process.env.NYRA_VAULT_PASSWORD;
  if (!password) return false;
  try {
    const vault = new Vault(vaultPath(home));
    if (!vault.unlock(password)) return false;
    vault.add(GMAIL_VAULT_TOKENS_ENTRY, JSON.stringify(tokens), true);
    return true;
  } catch {
    return false;
  }
}

export interface GmailConnectorStatus {
  /** config.connectors.gmail.enabled：默认关，显式开才可用。 */
  enabled: boolean;
  /** 密码箱里有 token 条目（只看条目名、不解密；内容损坏时工具调用仍会报错）。 */
  configured: boolean;
  email?: string;
  scopes?: string;
}

/** 密码箱里有没有 gmail-oauth 条目（只看条目名，不用解锁——status 能直接报）。 */
export function hasGmailTokensEntry(home: string): boolean {
  try {
    return new Vault(vaultPath(home)).listNames().includes(GMAIL_VAULT_TOKENS_ENTRY);
  } catch {
    return false;
  }
}

export function resolveGmailEnabled(config: Record<string, unknown>): boolean {
  const section = (config as { connectors?: unknown }).connectors;
  if (!section || typeof section !== "object") return false;
  const gmail = (section as { gmail?: unknown }).gmail;
  if (!gmail || typeof gmail !== "object") return false;
  return (gmail as { enabled?: unknown }).enabled === true;
}

export function getGmailStatus(home: string, config: Record<string, unknown>): GmailConnectorStatus {
  const enabled = resolveGmailEnabled(config);
  const tokens = loadGmailTokens(home);
  return {
    enabled,
    configured: hasGmailTokensEntry(home),
    ...(tokens?.email ? { email: tokens.email } : {}),
    ...(tokens?.scope ? { scopes: tokens.scope } : {}),
  };
}

/** 代发证据正文（工具与 CLI 共用）：发了什么、按哪条规则发的、谁批准的。 */
export function buildGmailSendEvidence(opts: {
  to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string;
  threadId?: string; draft: boolean; resultId: string; approvalChannel: string; mode: string;
}): string {
  const lines = [
    `工具：gmail_send${opts.draft ? "（只存草稿，未发送）" : ""}`,
    `收件人：${opts.to.join(", ")}`,
    ...(opts.cc?.length ? [`抄送：${opts.cc.join(", ")}`] : []),
    ...(opts.bcc?.length ? [`密送：${opts.bcc.join(", ")}`] : []),
    `主题：${opts.subject}`,
    ...(opts.threadId ? [`回复原串 threadId：${opts.threadId}`] : []),
    `批准：用户经${opts.approvalChannel}批准（${opts.mode} 模式）`,
    opts.draft ? `草稿 id：${opts.resultId}` : `邮件 id：${opts.resultId}`,
    "正文：",
    opts.body,
  ];
  return lines.join("\n");
}

/**
 * 建一个能用的 Gmail 传输层：未启用、没配 token、没配客户端时直接抛错，
 * 调用方把错误原样告诉用户（里面已经写清下一步该跑什么命令）。
 * fetchFn 只供测试注入；生产永远用全局 fetch。
 */
export function createGmailTransport(home: string, config: Record<string, unknown>, opts?: { fetchFn?: FetchFn }): GmailTransport {
  if (!resolveGmailEnabled(config)) {
    throw new GmailError("Gmail 连接器未启用：先运行 nyra gmail auth 完成授权（授权成功会自动启用）");
  }
  const tokens = loadGmailTokens(home);
  if (!tokens) throw new GmailAuthError("Gmail 未授权：密码箱里没有 token，请运行 nyra gmail auth");
  const client = loadGmailClient(home);
  if (!client) throw new GmailAuthError("Gmail 未授权：密码箱里没有 OAuth 客户端，请重新运行 nyra gmail auth");
  return new GmailApiTransport({
    tokens,
    client,
    fetchFn: opts?.fetchFn,
    onTokensRefreshed: (next) => { persistGmailTokens(home, next); },
  });
}

/**
 * 回环回调服务器（nyra gmail auth 用）：在 127.0.0.1 上起一个临时 HTTP
 * 服务等 Google 把授权码送回来；state 对不上直接拒绝（防 CSRF）。
 * 只在交互式授权时用，测试里同样可以起一个真服务再用 fetch 回调它。
 * 注意：函数返回时服务器已经 listen 好了，redirectUri 可以直接用。
 */
export async function startLoopbackCallbackServer(opts: { state: string; timeoutMs?: number }): Promise<{
  redirectUri: string;
  waitForCode(): Promise<string>;
  close(): void;
}> {
  let server: ReturnType<typeof createServer> | null = null;
  let settled = false;
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (err: Error) => void = () => {};
  const promise = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveCode = resolvePromise;
    rejectCode = rejectPromise;
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      try { server?.close(); } catch { /* ignore */ }
      rejectCode(new GmailError("等待授权回调超时（5 分钟）：请重新运行 nyra gmail auth，在浏览器里完成 Google 授权"));
    }
  }, opts.timeoutMs ?? GMAIL_AUTH_TIMEOUT_MS);
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      if (settled) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<p>授权已完成，可以关掉这个页面了。</p>");
        return;
      }
      const errParam = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (errParam) {
        settled = true;
        clearTimeout(timer);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<p>授权被拒绝或失败，可以关掉这个页面了。</p>");
        rejectCode(new GmailError(`Google 授权失败：${errParam}`));
        return;
      }
      if (state !== opts.state || !code) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("state 不匹配或缺少授权码");
        return;
      }
      settled = true;
      clearTimeout(timer);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<p>授权成功，可以关掉这个页面、回到终端了。</p>");
      resolveCode(code);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server error");
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server!.once("error", rejectListen);
    server!.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    clearTimeout(timer);
    try { server.close(); } catch { /* ignore */ }
    throw new GmailError("回环回调服务器启动失败");
  }
  return {
    redirectUri: `http://127.0.0.1:${addr.port}/callback`,
    waitForCode: () => promise,
    close: () => {
      clearTimeout(timer);
      try { server?.close(); } catch { /* ignore */ }
    },
  };
}

/** 授权流程用的随机 state（防 CSRF）。 */
export function newAuthState(): string {
  return randomBytes(16).toString("hex");
}

/** 搜索结果格式化（纯文本；调用方再按需包 wrapUntrusted——邮件元数据也是外部数据）。 */
export function formatGmailSearchResults(messages: GmailMessageSummary[], nextPageToken?: string): string {
  if (!messages.length) return "没有找到相关邮件。";
  const lines = messages.map((m, i) => {
    const head = `${i + 1}. [${m.id}] ${m.subject || "（无主题）"}`;
    const meta = `发件人：${m.from || "未知"}；时间：${m.date || "未知"}`;
    return m.snippet ? `${head}\n   ${meta}\n   摘要：${m.snippet}` : `${head}\n   ${meta}`;
  });
  if (nextPageToken) lines.push("（还有更多结果，翻页见 pageToken）");
  return lines.join("\n");
}

/** 单封邮件格式化：头信息 + 正文（调用方再包 wrapUntrusted）。 */
export function formatGmailMessage(msg: GmailMessage): string {
  const head = [
    `发件人：${msg.from || "未知"}`,
    `收件人：${msg.to || "未知"}`,
    `主题：${msg.subject || "（无主题）"}`,
    `时间：${msg.date || "未知"}`,
    `邮件 id：${msg.id}`,
    `threadId：${msg.threadId}`,
  ].join("\n");
  return `${head}\n\n${msg.bodyText || "（正文为空）"}`;
}

