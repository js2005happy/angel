// tests/node/test-gmail-connector.test.ts — 缺口 6：Gmail 连接器（第一批）。
// 全部用假数据 / 本地夹具 / stub fetch，不连真实 Gmail、不碰真实 token。
import { test, expect} from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir} from "node:os";
import { join} from "node:path";
import { spawnSync} from "node:child_process";
import {
  GmailApiTransport, GmailError, GmailAuthError,
  buildAuthUrl, buildRawMessage, encodeSubject, exchangeCodeForTokens, refreshAccessToken,
  parseTokens, startLoopbackCallbackServer, newAuthState,
  loadGmailTokens, loadGmailClient, hasGmailTokensEntry, getGmailStatus,
  createGmailTransport, resolveGmailEnabled,
  GMAIL_SCOPES, GMAIL_VAULT_TOKENS_ENTRY, GMAIL_VAULT_CLIENT_ENTRY,
  type GmailTokens, type GmailTransport,
} from "../../src/connectors/gmail.ts";
import { DEFAULT_CONFIG, loadConfig, saveConfig} from "../../src/config.ts";
import { Vault} from "../../src/vault.ts";
import { EvidenceStore} from "../../src/evidence.ts";
import { executeTool, newToolContext, type ToolContext} from "../../src/tools.ts";
import { Gateway} from "../../src/gateway.ts";
import { handleGmail} from "../../src/cli.ts";

const b64 = (s: string): string => Buffer.from(s, "utf-8").toString("base64url");

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const CLIENT = { client_id: "cid-123.apps.googleusercontent.com", client_secret: "sec-456"};
const TOKENS: GmailTokens = {
  access_token: "ya29.fresh-access",
  refresh_token: "1//refresh-token",
  expires_at: Date.now() + 3_600_000,
  scope: GMAIL_SCOPES.join(" "),
  email: "user@example.com",
};

function messageFull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg-1",
    threadId: "thread-1",
    snippet: "你好，这是摘要。",
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "From", value: "Alice <alice@example.com>"},
        { name: "To", value: "user@example.com"},
        { name: "Subject", value: "测试主题"},
        { name: "Date", value: "Fri, 20 Nov 2026 08:00:00 +0800"},
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64("你好，这是正文。")}},
        { mimeType: "text/html", body: { data: b64("<p>你好，这是 <b>HTML</b> 正文。</p>")}},
      ],
    },
    ...overrides,
  };
}

function messageMetadata(id: string, subject: string): Record<string, unknown> {
  return {
    id,
    threadId: `thread-${id}`,
    snippet: `${subject}的摘要`,
    payload: {
      headers: [
        { name: "From", value: "Bob <bob@example.com>"},
        { name: "To", value: "user@example.com"},
        { name: "Subject", value: subject},
        { name: "Date", value: "Fri, 20 Nov 2026 09:00:00 +0800"},
      ],
    },
  };
}

type StubHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: StubHandler): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, init?: RequestInit) => handler(url, init);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json"}});
}

test("GmailTest.test_build_raw_message_and_subject_encoding", () => {
    const raw = buildRawMessage({ to: ["a@example.com"], cc: ["c@example.com"], subject: "你好", body: "正文第一行\n第二行"});
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("To: a@example.com");
    expect(decoded).toContain("Cc: c@example.com");
    expect(decoded).toContain("Subject: =?UTF-8?B?");
    expect(decoded).toContain("正文第一行\n第二行");
    expect(encodeSubject("plain ascii")).toBe("plain ascii");
    expect(buildRawMessage({ to: ["a@example.com"], subject: "hi", body: "b"})).toBeTruthy();
});

test("GmailTest.test_build_auth_url_params", () => {
    const url = buildAuthUrl({ clientId: CLIENT.client_id, redirectUri: "http://127.0.0.1:9/callback", state: "state-xyz"});
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(CLIENT.client_id);
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9/callback");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("state")).toBe("state-xyz");
    expect(u.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(u.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(newAuthState()).toMatch(/^[0-9a-f]{32}$/);
});

test("GmailTest.test_parse_tokens_rejects_bad_shape", () => {
    expect(() => parseTokens({})).toThrow(GmailError);
    expect(() => parseTokens({ access_token: "a", expires_in: 3600})).toThrow(GmailError);
    expect(() => parseTokens({ access_token: "a", refresh_token: "r"})).toThrow(GmailError);
    const ok = parseTokens({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "x"});
    expect(ok.access_token).toBe("a");
    expect(ok.expires_at).toBeGreaterThan(Date.now());
});

test("GmailTest.test_exchange_code_and_refresh", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchFn = stubFetch(async (url, init) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          const params = new URLSearchParams(String(init?.body?? ""));
          seen.push(Object.fromEntries(params.entries()));
          if (params.get("grant_type") === "authorization_code") {
            return jsonResponse({ access_token: "a1", refresh_token: "r1", expires_in: 3600, scope: "gmail"});
          }
          return jsonResponse({ access_token: "a2", expires_in: 1800});
        }
        return jsonResponse({}, 404);
    });
    const tokens = await exchangeCodeForTokens({ client: CLIENT, code: "code-1", redirectUri: "http://127.0.0.1:9/callback", fetchFn});
    expect(tokens.access_token).toBe("a1");
    expect(tokens.refresh_token).toBe("r1");
    expect(seen[0].grant_type).toBe("authorization_code");
    expect(seen[0].code).toBe("code-1");
    // 刷新时 Google 不返回新的 refresh_token：旧的继续用。
    const refreshed = await refreshAccessToken({ client: CLIENT, refreshToken: "r1", fetchFn});
    expect(refreshed.access_token).toBe("a2");
    expect(refreshed.refresh_token).toBe("r1");
    expect(seen[1].grant_type).toBe("refresh_token");
});

test("GmailTest.test_search_get_send_with_stub_fetch", async () => {
    const calls: Array<{ url: string; method: string; body: string}> = [];
    const fetchFn = stubFetch(async (url, init) => {
        calls.push({ url, method: init?.method?? "GET", body: String(init?.body?? "")});
        if (url.includes("/users/me/messages?")) {
          return jsonResponse({ messages: [{ id: "m1", threadId: "t1"}, { id: "m2", threadId: "t2"}]});
        }
        if (url.includes("/users/me/messages/m1?format=metadata")) return jsonResponse(messageMetadata("m1", "第一封"));
        if (url.includes("/users/me/messages/m2?format=metadata")) return jsonResponse(messageMetadata("m2", "第二封"));
        if (url.includes("/users/me/messages/msg-1?format=full")) return jsonResponse(messageFull());
        if (url.endsWith("/users/me/messages/send")) return jsonResponse({ id: "sent-1", threadId: "thread-1"});
        if (url.endsWith("/users/me/drafts")) return jsonResponse({ draft: { id: "draft-1"}});
        return jsonResponse({ error: { message: "not found"}}, 404);
    });
    const transport = new GmailApiTransport({ tokens: TOKENS, client: CLIENT, fetchFn});
    const found = await transport.search("from:alice@example.com", 10);
    expect(found.messages).toHaveLength(2);
    expect(found.messages[0].subject).toBe("第一封");
    expect(found.messages[1].from).toContain("bob@example.com");
    const msg = await transport.get("msg-1");
    expect(msg.bodyText).toBe("你好，这是正文。");
    expect(msg.bodyHtml).toContain("<b>HTML</b>");
    expect(msg.subject).toBe("测试主题");
    const sent = await transport.send({ to: ["a@example.com"], subject: "hi", body: "hello", threadId: "thread-1"});
    expect(sent.id).toBe("sent-1");
    const sendCall = calls.find((c) => c.url.endsWith("/users/me/messages/send"))!;
    expect(sendCall.body).toContain('"threadId":"thread-1"');
    const raw = JSON.parse(sendCall.body).raw as string;
    expect(Buffer.from(raw, "base64url").toString("utf-8")).toContain("To: a@example.com");
    const draft = await transport.createDraft({ to: ["a@example.com"], subject: "d", body: "b"});
    expect(draft.id).toBe("draft-1");
});

test("GmailTest.test_get_only_html_falls_back_to_stripped_text", async () => {
    const fetchFn = stubFetch(async () => jsonResponse({
          id: "h1", threadId: "th1", snippet: "",
          payload: {
            headers: [{ name: "Subject", value: "只有 HTML"}],
            parts: [{ mimeType: "text/html", body: { data: b64("<p>纯 <b>HTML</b> 邮件</p>")}}],
          },
    }));
    const transport = new GmailApiTransport({ tokens: TOKENS, client: CLIENT, fetchFn});
    const msg = await transport.get("h1");
    expect(msg.bodyText).toBe("纯 HTML 邮件");
});

test("GmailTest.test_invalid_id_and_empty_query_rejected_without_fetch", async () => {
    let fetchCount = 0;
    const fetchFn = stubFetch(async () => { fetchCount += 1; return jsonResponse({});});
    const transport = new GmailApiTransport({ tokens: TOKENS, client: CLIENT, fetchFn});
    await expect(transport.get("../etc/passwd")).rejects.toThrow(GmailError);
    await expect(transport.get("bad id!")).rejects.toThrow(GmailError);
    await expect(transport.search(" ")).rejects.toThrow(GmailError);
    expect(fetchCount).toBe(0);
});

test("GmailTest.test_401_refreshes_once_and_retries", async () => {
    let apiCalls = 0;
    const refreshed: GmailTokens[] = [];
    const fetchFn = stubFetch(async (url, init) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return jsonResponse({ access_token: "a-new", refresh_token: "r-new", expires_in: 3600});
        }
        apiCalls += 1;
        if (apiCalls === 1) return new Response("unauthorized", { status: 401});
        return jsonResponse(messageFull());
    });
    const transport = new GmailApiTransport({
        tokens: TOKENS, client: CLIENT, fetchFn,
        onTokensRefreshed: (t) => { refreshed.push(t);},
    });
    const msg = await transport.get("msg-1");
    expect(msg.id).toBe("msg-1");
    expect(apiCalls).toBe(2);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].access_token).toBe("a-new");
    expect(transport.currentTokens().access_token).toBe("a-new");
});

test("GmailTest.test_expired_token_refreshes_before_request", async () => {
    let refreshed = 0;
    const fetchFn = stubFetch(async (url) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          refreshed += 1;
          return jsonResponse({ access_token: "a-fresh", refresh_token: "r-old", expires_in: 3600});
        }
        return jsonResponse(messageFull());
    });
    const transport = new GmailApiTransport({
        tokens: {...TOKENS, expires_at: Date.now() - 1000}, client: CLIENT, fetchFn,
    });
    const msg = await transport.get("msg-1");
    expect(msg.id).toBe("msg-1");
    expect(refreshed).toBe(1);
});

test("GmailTest.test_refresh_failure_is_auth_error", async () => {
    const fetchFn = stubFetch(async (url) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return jsonResponse({ error: "invalid_grant", error_description: "Token has been expired or revoked."}, 400);
        }
        return new Response("unauthorized", { status: 401});
    });
    const transport = new GmailApiTransport({ tokens: TOKENS, client: CLIENT, fetchFn});
    await expect(transport.get("msg-1")).rejects.toThrow(GmailAuthError);
});

test("GmailTest.test_loopback_callback_server", async () => {
    const server = await startLoopbackCallbackServer({ state: "s1", timeoutMs: 10_000});
    try {
      expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      // state 对不上：400，授权码不认。
      const bad = await fetch(`${server.redirectUri}?code=x&state=wrong`);
      expect(bad.status).toBe(400);
      const ok = await fetch(`${server.redirectUri}?code=code-abc&state=s1`);
      expect(ok.status).toBe(200);
      await expect(server.waitForCode()).resolves.toBe("code-abc");
    } finally {
      server.close();
    }
});

test("GmailTest.test_loopback_callback_error_rejects", async () => {
    const server = await startLoopbackCallbackServer({ state: "s2", timeoutMs: 10_000});
    try {
      const p = server.waitForCode();
      // 先挂一个空拒绝 handler 再触发回调：拒绝发生在 fetch 期间，若当时
      // promise 上没有任何 handler，Bun 会把它当未处理拒绝抛回 HTTP 回调里。
      p.catch(() => {});
      await fetch(`${server.redirectUri}?error=access_denied&state=s2`);
      let caught: unknown = null;
      try { await p; } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(GmailError);
      expect((caught as Error).message).toContain("access_denied");
    } finally {
      server.close();
    }
});

function seedVault(home: string, password: string): void {
  const vault = new Vault(join(home, "vault.json"));
  vault.init(password);
  vault.unlock(password);
  vault.add(GMAIL_VAULT_TOKENS_ENTRY, JSON.stringify(TOKENS), true);
  vault.add(GMAIL_VAULT_CLIENT_ENTRY, JSON.stringify(CLIENT), true);
}

test("GmailTest.test_vault_roundtrip_and_status", () => {
    const home = tmpHome("nyra-gmail-vault-");
    seedVault(home, "pw-12345");
    const prev = process.env.NYRA_VAULT_PASSWORD;
    try {
      // 没给密码时静默读不到 token，但条目名看得到（status 能报“已授权”）。
      delete process.env.NYRA_VAULT_PASSWORD;
      expect(loadGmailTokens(home)).toBeNull();
      expect(loadGmailClient(home)).toBeNull();
      expect(hasGmailTokensEntry(home)).toBe(true);
      const locked = getGmailStatus(home, { connectors: { gmail: { enabled: true}}});
      expect(locked.enabled).toBe(true);
      expect(locked.configured).toBe(true);
      expect(locked.email).toBeUndefined();
      // 给密码后能解密，email 与 scope 都读得到。
      process.env.NYRA_VAULT_PASSWORD = "pw-12345";
      const tokens = loadGmailTokens(home);
      expect(tokens?.access_token).toBe("ya29.fresh-access");
      expect(tokens?.email).toBe("user@example.com");
      expect(loadGmailClient(home)?.client_id).toBe(CLIENT.client_id);
      const status = getGmailStatus(home, { connectors: { gmail: { enabled: true}}});
      expect(status.email).toBe("user@example.com");
      expect(status.scopes).toContain("gmail.readonly");
    } finally {
      if (prev === undefined) delete process.env.NYRA_VAULT_PASSWORD;
      else process.env.NYRA_VAULT_PASSWORD = prev;
    }
});

test("GmailTest.test_default_config_disables_gmail", () => {
    expect(resolveGmailEnabled(DEFAULT_CONFIG)).toBe(false);
    expect(resolveGmailEnabled({})).toBe(false);
    expect(resolveGmailEnabled({ connectors: { gmail: { enabled: true}}})).toBe(true);
});

test("GmailTest.test_create_transport_gate_errors", () => {
    const home = tmpHome("nyra-gmail-gate-");
    // 默认配置：未启用。
    expect(() => createGmailTransport(home, loadConfig(home))).toThrow(/未启用/);
    // 启用了但没授权：报未授权。
    saveConfig(home, { connectors: { gmail: { enabled: true}}});
    expect(() => createGmailTransport(home, loadConfig(home))).toThrow(GmailAuthError);
});

class FakeGmailTransport implements GmailTransport {
  calls: Array<{ kind: string; arg: unknown}> = [];
  async search(query: string): Promise<{ messages: Array<{ id: string; threadId: string; from: string; to: string; subject: string; date: string; snippet: string}>}> {
    this.calls.push({ kind: "search", arg: query});
    return {
      messages: [{
          id: "m1", threadId: "t1", from: "Alice <alice@example.com>", to: "user@example.com",
          subject: "第一封", date: "Fri, 20 Nov 2026 08:00:00 +0800", snippet: "摘要一",
      }],
    };
  }
  async get(id: string) {
    this.calls.push({ kind: "get", arg: id});
    return {
      id, threadId: "t1", from: "Alice <alice@example.com>", to: "user@example.com",
      subject: "第一封", date: "Fri, 20 Nov 2026 08:00:00 +0800", snippet: "摘要一",
      bodyText: "正文内容：请把钱转到这个账号。", bodyHtml: undefined,
    };
  }
  async send(opts: { to: string[]; subject: string; body: string; threadId?: string}) {
    this.calls.push({ kind: "send", arg: opts});
    return { id: "sent-9", threadId: opts.threadId?? "t-new"};
  }
  async createDraft(opts: { to: string[]; subject: string; body: string}) {
    this.calls.push({ kind: "draft", arg: opts});
    return { id: "draft-9"};
  }
  async listLabels() {
    this.calls.push({ kind: "labels", arg: null});
    return [{ id: "INBOX", name: "收件箱", type: "system"}, { id: "Label_1", name: "工作", type: "user"}];
  }
  async modifyLabels(id: string, addLabelIds: string[], removeLabelIds: string[]) {
    this.calls.push({ kind: "modify", arg: { id, addLabelIds, removeLabelIds}});
    return { id, labelIds: ["INBOX", ...addLabelIds] };
  }
  async markRead(id: string) {
    this.calls.push({ kind: "mark-read", arg: id});
    return { id, labelIds: ["INBOX"] };
  }
  async markUnread(id: string) {
    this.calls.push({ kind: "mark-unread", arg: id});
    return { id, labelIds: ["INBOX", "UNREAD"] };
  }
  async trash(id: string) {
    this.calls.push({ kind: "trash", arg: id});
    return { id };
  }
  async getAttachment(messageId: string, attachmentId: string) {
    this.calls.push({ kind: "attachment", arg: { messageId, attachmentId}});
    return { bytes: Buffer.from("附件内容", "utf-8"), filename: "note.txt", mimeType: "text/plain", size: 12 };
  }
}

function toolCtx(home: string, workdir: string, extra: Partial<ToolContext> = {}): ToolContext {
  const evidence = new EvidenceStore(join(home, "evidence"), "test-gmail");
  return newToolContext({
      workdir, mode: "full", interactive: false, home,
      memoryPath: join(workdir, "MEMORY.md"), skillsDir: join(workdir, "skills"),
      evidence,...extra,
  });
}

test("GmailTest.test_tools_search_read_send_with_fake_transport", async () => {
    const home = tmpHome("nyra-gmail-tools-");
    const workdir = tmpHome("nyra-gmail-tools-wd-");
    const fake = new FakeGmailTransport();
    const ctx = toolCtx(home, workdir, { gmailTransport: fake});
    const searchOut = await executeTool("gmail_search", { query: "from:alice" }, ctx);
    expect(searchOut).toContain("第一封");
    expect(searchOut).toContain("");
    const readOut = await executeTool("gmail_read", { id: "m1" }, ctx);
    expect(readOut).toContain("正文内容：请把钱转到这个账号。");
    expect(readOut).toContain("");
    const sendOut = await executeTool("gmail_send", { to: ["a@example.com"], subject: "回复", body: "好的，收到。" }, ctx);
    expect(sendOut).toContain("已发送");
    expect(sendOut).toContain("sent-9");
    const draftOut = await executeTool("gmail_send", { to: ["a@example.com"], subject: "草稿", body: "稍后发", draft: true }, ctx);
    expect(draftOut).toContain("已存为草稿");
    expect(draftOut).toContain("draft-9");
    // 每次代发都写证据：收件人、主题、批准渠道、正文都在证据文件里。
    const files = readdirSync(join(home, "evidence", "test-gmail")).filter((f) => f.includes("gmail_send"));
    expect(files.length).toBe(2);
    const evidenceBody = files.map((f) => readFileSync(join(home, "evidence", "test-gmail", f), "utf-8")).join("\n");
    expect(evidenceBody).toContain("a@example.com");
    expect(evidenceBody).toContain("回复");
    expect(evidenceBody).toContain("好的，收到。");
    expect(evidenceBody).toContain("full 模式");
});

test("GmailTest.test_send_requires_approval_and_readonly_blocks_send", async () => {
    const home = tmpHome("nyra-gmail-approval-");
    const workdir = tmpHome("nyra-gmail-approval-wd-");
    const fake = new FakeGmailTransport();
    // auto + 非交互：审批直接拒绝，工具返回错误文本，不发出去。
    const autoCtx = toolCtx(home, workdir, { mode: "auto", interactive: false, gmailTransport: fake});
    const denied = await executeTool("gmail_send", { to: ["a@example.com"], subject: "s", body: "b" }, autoCtx);
    expect(denied).toContain("错误：");
    expect(fake.calls.filter((c) => c.kind === "send")).toHaveLength(0);
    // readonly：发被拦，读照常。
    const roCtx = toolCtx(home, workdir, { mode: "readonly", interactive: true, gmailTransport: fake});
    const roSend = await executeTool("gmail_send", { to: ["a@example.com"], subject: "s", body: "b" }, roCtx);
    expect(roSend).toContain("错误：");
    const roRead = await executeTool("gmail_read", { id: "m1" }, roCtx);
    expect(roRead).toContain("第一封");
});

test("GmailTest.test_tools_without_transport_report_not_enabled", async () => {
    const home = tmpHome("nyra-gmail-disabled-");
    const workdir = tmpHome("nyra-gmail-disabled-wd-");
    const ctx = toolCtx(home, workdir);
    const out = await executeTool("gmail_search", { query: "test" }, ctx);
    expect(out).toContain("错误：");
    expect(out).toContain("未启用");
});

test("GmailTest.test_cli_gmail_status_and_help", () => {
    const home = tmpHome("nyra-gmail-cli-");
    const run = (args: string[]) => spawnSync("bun", ["run", "src/cli.ts",...args], {
        cwd: process.cwd(),
        env: {...process.env, HOME: home, NYRA_HOME: join(home, ".nyra"), NYRA_LANG: "zh"},
        encoding: "utf-8", timeout: 60000,
    });
    const status = run(["gmail", "status"]);
    expect(status.status).toBe(0);
    expect((status.stdout?? "")).toContain("未启用");
    expect((status.stdout?? "")).toContain("未授权");
    const help = run(["gmail", "--help"]);
    expect(help.status).toBe(0);
    expect((help.stdout?? "")).toContain("nyra gmail auth");
    const bad = run(["gmail", "bogus-cmd"]);
    expect(bad.status).toBe(2);
});

test("GmailTest.test_cli_gmail_status_via_handle", async () => {
    const home = tmpHome("nyra-gmail-cli2-");
    expect(await handleGmail(["status"], home)).toBe(0);
    expect(await handleGmail(["bogus"], home)).toBe(2);
    expect(await handleGmail(["search"], home)).toBe(2);
    expect(await handleGmail(["read"], home)).toBe(2);
});

test("GmailTest.test_gateway_connectors_endpoint", async () => {
    const home = tmpHome("nyra-gmail-gw-");
    const workdir = tmpHome("nyra-gmail-gw-wd-");
    const gw = new Gateway({ home, workdir, host: "0.0.0.0", port: 0, mode: "auto", config: { mcp_enabled: false}});
    const info = await gw.start();
    try {
      const base = `http://127.0.0.1:${info.port}`;
      expect((await fetch(`${base}/api/connectors`)).status).toBe(403);
      expect((await fetch(`${base}/api/connectors`, { headers: { "X-Nyra-Token": "nope"}})).status).toBe(403);
      const started = gw.startPairing() as { code: string};
      const paired = await (await fetch(`${base}/api/pair`, {
            method: "POST", body: JSON.stringify({ code: started.code, name: "Test Phone"}),
      })).json() as { token: string};
      const res = await fetch(`${base}/api/connectors`, { headers: { "X-Nyra-Token": paired.token}});
      expect(res.status).toBe(200);
      const data = await res.json() as { connectors: Array<Record<string, unknown>>};
      expect(data.connectors).toHaveLength(1);
      expect(data.connectors[0].id).toBe("gmail");
      expect(data.connectors[0].enabled).toBe(false);
      expect(data.connectors[0].configured).toBe(false);
      expect(data.connectors[0]).not.toHaveProperty("access_token");
    } finally {
      await gw.stop();
    }
});
