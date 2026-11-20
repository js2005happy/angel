// tests/node/test-connector-gmail-deep.test.ts — 缺口 44 第三批：Gmail 深化
// （附件只读下载 + 标签 + 标已读/未读 + 进回收站 + OAuth 合并）。
// 全部用假 Gmail API / 本地夹具 / stub fetch，不连真实 Gmail、不碰真实 token。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GmailApiTransport, GmailError, GmailAuthError,
  downloadGmailAttachment, formatGmailLabels, formatGmailAttachmentOutcome,
  gmailWriteRefusal, refuseGmailPermanentDelete, GMAIL_WRITE_COMMANDS,
  GMAIL_SCOPES, GMAIL_ATTACHMENT_MAX_BYTES,
  startLoopbackCallbackServer, buildAuthUrl, createGmailTransport,
  GMAIL_VAULT_CLIENT_ENTRY, GMAIL_VAULT_TOKENS_ENTRY,
  type GmailTokens,
} from "../../src/connectors/gmail.ts";
import {
  getDeclaration, markConnectorAuthorized, markConnectorExpired, markConnectorRevoked,
  CONNECTOR_AUDIT_FILE,
} from "../../src/connectors/registry.ts";
import { handleGmail } from "../../src/cli.ts";
import { Vault, vaultPath } from "../../src/vault.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";

const FAKE_CLIENT = { client_id: "test-client.apps.googleusercontent.com", client_secret: "test-secret" };
const FAKE_TOKENS: GmailTokens = {
  access_token: "ya29.fake-access",
  refresh_token: "1//fake-refresh",
  expires_at: Date.now() + 3600_000,
  scope: GMAIL_SCOPES.join(" "),
  token_type: "Bearer",
};

function b64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const ATTACHMENT_DATA: Record<string, { data: string; size: number }> = {
  "att-txt": { data: b64("这是附件里的文字。"), size: 24 },
  "att-png": { data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), size: 8 },
  "att-pdf": { data: b64("%PDF-1.4 假内容"), size: 15 },
  "att-exe": { data: b64("MZ 假可执行文件"), size: 18 },
  "att-empty": { data: "", size: 0 },
};

function messageWithAttachments(): Record<string, unknown> {
  return {
    id: "msg-1",
    threadId: "thread-1",
    snippet: "带附件的测试邮件",
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      headers: [{ name: "Subject", value: "附件测试" }],
      parts: [
        { mimeType: "text/plain", body: { data: b64("正文") } },
        { mimeType: "text/plain", filename: "note.txt", body: { attachmentId: "att-txt" } },
        { mimeType: "image/png", filename: "pic.png", body: { attachmentId: "att-png" } },
        { mimeType: "application/pdf", filename: "doc.pdf", body: { attachmentId: "att-pdf" } },
        { mimeType: "application/octet-stream", filename: "run.exe", body: { attachmentId: "att-exe" } },
        { mimeType: "text/plain", filename: "empty.txt", body: { attachmentId: "att-empty" } },
      ],
    },
  };
}

type StubCall = { method: string; path: string; body?: unknown };

/** 假 Gmail API：按路径路由，记录每次调用（断言路径与写请求体用）。 */
function makeStubFetch() {
  const calls: StubCall[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/gmail\/v1/, "");
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string" && init.body) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ method, path, body });
    const json = (status: number, data: unknown): Response =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/users/me/labels") {
      return json(200, { labels: [
        { id: "INBOX", name: "收件箱", type: "system" },
        { id: "UNREAD", name: "未读", type: "system" },
        { id: "Label_1", name: "工作", type: "user" },
      ] });
    }
    const modifyMatch = path.match(/^\/users\/me\/messages\/([^/]+)\/modify$/);
    if (modifyMatch && method === "POST") {
      const b = (body ?? {}) as Record<string, unknown>;
      const add = Array.isArray(b.addLabelIds) ? (b.addLabelIds as string[]) : [];
      const remove = Array.isArray(b.removeLabelIds) ? (b.removeLabelIds as string[]) : [];
      const labelIds = ["INBOX", "UNREAD", ...add].filter((l) => !remove.includes(l));
      return json(200, { id: modifyMatch[1], labelIds });
    }
    const trashMatch = path.match(/^\/users\/me\/messages\/([^/]+)\/trash$/);
    if (trashMatch && method === "POST") return json(200, { id: trashMatch[1] });
    const attachMatch = path.match(/^\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/);
    if (attachMatch) {
      const att = ATTACHMENT_DATA[attachMatch[2]];
      if (!att) return json(404, { error: { message: "not found" } });
      return json(200, { data: att.data, size: att.size });
    }
    const msgMatch = path.match(/^\/users\/me\/messages\/([^/]+)$/);
    if (msgMatch) return json(200, messageWithAttachments());
    return json(404, { error: { message: `no stub for ${method} ${path}` } });
  };
  return { fetchFn: fetchFn as unknown as (url: string, init?: RequestInit) => Promise<Response>, calls };
}

function makeTransport(home?: string, userId?: string) {
  const stub = makeStubFetch();
  const transport = new GmailApiTransport({
    tokens: FAKE_TOKENS,
    client: FAKE_CLIENT,
    fetchFn: stub.fetchFn,
    ...(home ? { home } : {}),
    ...(userId ? { userId } : {}),
  });
  return { transport, stub };
}

/** 给 CLI 端到端测试准备一个已启用 + 已授权的临时 home。
 * 密码箱用本文件统一的测试密码；createGmailTransport / handleGmail 读
 * token 要解锁密码箱，所以这里把 NYRA_VAULT_PASSWORD 一并设好。 */
const VAULT_PASSWORD = "pw-test-gmail-deep";
function seedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "nyra-gmail-deep-"));
  saveConfig(home, { connectors: { gmail: { enabled: true } } });
  const vault = new Vault(vaultPath(home));
  vault.init(VAULT_PASSWORD);
  vault.unlock(VAULT_PASSWORD);
  vault.add(GMAIL_VAULT_CLIENT_ENTRY, JSON.stringify(FAKE_CLIENT), true);
  vault.add(GMAIL_VAULT_TOKENS_ENTRY, JSON.stringify(FAKE_TOKENS), true);
  process.env.NYRA_VAULT_PASSWORD = VAULT_PASSWORD;
  return home;
}

function stubGlobalFetch(stub: (url: string, init?: RequestInit) => Promise<Response>) {
  const prev = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  return () => { globalThis.fetch = prev; };
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const origWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
    out += String(chunk);
    return true;
  };
  try {
    const code = await fn();
    return { code, out };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = origWrite;
  }
}

async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const origWrite = process.stderr.write.bind(process.stderr);
  let err = "";
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
    err += String(chunk);
    return true;
  };
  try {
    const code = await fn();
    return { code, err };
  } finally {
    (process.stderr as unknown as { write: unknown }).write = origWrite;
  }
}

// ---------- 权限声明 ----------

test("GmailDeepTest.test_declaration_covers_new_capabilities", () => {
  const gmail = getDeclaration("gmail");
  expect(gmail).toBeTruthy();
  // 读 scope 与写 scope 分开列；改标签/标已读/进回收站要 gmail.modify。
  expect(gmail!.scopes.write).toContain("https://www.googleapis.com/auth/gmail.modify");
  expect(gmail!.scopes.read).toContain("https://www.googleapis.com/auth/gmail.readonly");
  expect(GMAIL_SCOPES).toContain("https://www.googleapis.com/auth/gmail.modify");
  // 四个新能力都在工具组里。
  const groupNames = gmail!.toolGroups.map((g) => g.name);
  expect(groupNames).toContain("附件");
  expect(groupNames).toContain("标签");
  expect(groupNames).toContain("已读");
  expect(groupNames).toContain("回收站");
  // 永远须人批：改标签、改已读、进回收站。
  expect(gmail!.alwaysRequireApproval).toContain("gmail_label");
  expect(gmail!.alwaysRequireApproval).toContain("gmail_mark_read");
  expect(gmail!.alwaysRequireApproval).toContain("gmail_trash");
  // 永远禁做：永久删除、转发给外部、改他人标签。
  expect(gmail!.alwaysForbidden).toContain("永久删除邮件（只支持进回收站）");
  expect(gmail!.alwaysForbidden).toContain("转发给外部");
  expect(gmail!.alwaysForbidden).toContain("改他人标签");
});

// ---------- 标签 / 已读 / 回收站 ----------

test("GmailDeepTest.test_list_labels", async () => {
  const { transport } = makeTransport();
  const labels = await transport.listLabels();
  expect(labels.length).toBe(3);
  expect(labels[0]).toEqual({ id: "INBOX", name: "收件箱", type: "system" });
  expect(labels[2]).toEqual({ id: "Label_1", name: "工作", type: "user" });
  expect(formatGmailLabels(labels)).toContain("收件箱（INBOX）");
});

test("GmailDeepTest.test_modify_labels_add_and_remove", async () => {
  const { transport, stub } = makeTransport();
  const added = await transport.modifyLabels("msg-1", ["Label_1"], []);
  expect(added.id).toBe("msg-1");
  expect(added.labelIds).toContain("Label_1");
  expect(stub.calls[0]).toEqual({
    method: "POST",
    path: "/users/me/messages/msg-1/modify",
    body: { addLabelIds: ["Label_1"], removeLabelIds: [] },
  });
  const removed = await transport.modifyLabels("msg-1", [], ["UNREAD"]);
  expect(removed.labelIds).not.toContain("UNREAD");
});

test("GmailDeepTest.test_modify_rejects_bad_ids_without_fetch", async () => {
  const { transport, stub } = makeTransport();
  await expect(transport.modifyLabels("../escape", ["Label_1"], [])).rejects.toBeInstanceOf(GmailError);
  await expect(transport.modifyLabels("msg-1", ["../escape"], [])).rejects.toBeInstanceOf(GmailError);
  expect(stub.calls.length).toBe(0);
});

test("GmailDeepTest.test_mark_read_and_unread", async () => {
  const { transport, stub } = makeTransport();
  const read = await transport.markRead("msg-1");
  expect(read.labelIds).not.toContain("UNREAD");
  expect(stub.calls[0].body).toEqual({ addLabelIds: [], removeLabelIds: ["UNREAD"] });
  const unread = await transport.markUnread("msg-1");
  expect(unread.labelIds).toContain("UNREAD");
  expect(stub.calls[1].body).toEqual({ addLabelIds: ["UNREAD"], removeLabelIds: [] });
});

test("GmailDeepTest.test_trash_moves_to_trash", async () => {
  const { transport, stub } = makeTransport();
  const result = await transport.trash("msg-1");
  expect(result.id).toBe("msg-1");
  expect(stub.calls[0]).toEqual({ method: "POST", path: "/users/me/messages/msg-1/trash", body: undefined });
  await expect(transport.trash("../escape")).rejects.toBeInstanceOf(GmailError);
});

// ---------- 附件 ----------

test("GmailDeepTest.test_get_attachment_returns_bytes_and_meta", async () => {
  const { transport } = makeTransport();
  const att = await transport.getAttachment("msg-1", "att-txt");
  expect(att.filename).toBe("note.txt");
  expect(att.mimeType).toBe("text/plain");
  expect(att.size).toBe(att.bytes.length);
  expect(att.bytes.toString("utf-8")).toBe("这是附件里的文字。");
});

test("GmailDeepTest.test_get_attachment_unknown_part_rejected", async () => {
  const { transport } = makeTransport();
  await expect(transport.getAttachment("msg-1", "att-nope")).rejects.toBeInstanceOf(GmailError);
  await expect(transport.getAttachment("../escape", "att-txt")).rejects.toBeInstanceOf(GmailError);
});

test("GmailDeepTest.test_download_text_attachment_extracted", async () => {
  const { transport } = makeTransport();
  const outcome = await downloadGmailAttachment(transport, "msg-1", "att-txt");
  expect(outcome.kind).toBe("text");
  expect(outcome.extractedText).toBe("这是附件里的文字。");
  expect(formatGmailAttachmentOutcome(outcome)).toContain("这是附件里的文字。");
  expect(outcome.meta.filename).toBe("note.txt");
});

test("GmailDeepTest.test_download_image_records_meta_only", async () => {
  const { transport } = makeTransport();
  const outcome = await downloadGmailAttachment(transport, "msg-1", "att-png");
  expect(outcome.kind).toBe("image");
  expect(outcome.extractedText).toBeUndefined();
  expect(outcome.notice).toContain("图片");
  expect(outcome.meta.sizeBytes).toBe(8);
});

test("GmailDeepTest.test_download_unsupported_types_refused", async () => {
  const { transport } = makeTransport();
  const pdf = await downloadGmailAttachment(transport, "msg-1", "att-pdf");
  expect(pdf.kind).toBe("unsupported");
  expect(pdf.notice).toContain("暂不支持解析");
  const exe = await downloadGmailAttachment(transport, "msg-1", "att-exe");
  expect(exe.kind).toBe("unsupported");
  expect(exe.notice).toContain("暂不支持解析");
  const empty = await downloadGmailAttachment(transport, "msg-1", "att-empty");
  expect(empty.kind).toBe("unsupported");
  expect(empty.notice).toContain("空文件");
});

test("GmailDeepTest.test_download_oversize_refused", async () => {
  const { transport } = makeTransport();
  const outcome = await downloadGmailAttachment(transport, "msg-1", "att-txt", { maxBytes: 4 });
  expect(outcome.kind).toBe("unsupported");
  expect(outcome.notice).toContain("太大");
  expect(outcome.notice).toContain("上限");
  expect(GMAIL_ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
});

test("GmailDeepTest.test_download_text_truncates", async () => {
  const { transport } = makeTransport();
  const outcome = await downloadGmailAttachment(transport, "msg-1", "att-txt", { textChars: 3 });
  expect(outcome.kind).toBe("text");
  expect(outcome.extractedText).toBe("这是附");
  expect(outcome.notice).toContain("只取前 3 字");
});

// ---------- 永久删除硬拒绝 ----------

test("GmailDeepTest.test_permanent_delete_refused", () => {
  expect(GMAIL_WRITE_COMMANDS).toContain("delete");
  expect(GMAIL_WRITE_COMMANDS).toContain("purge");
  const msg = gmailWriteRefusal("delete");
  expect(msg).toContain("永久删除本批不提供");
  expect(msg).toContain("nyra gmail trash");
  expect(() => refuseGmailPermanentDelete("delete")).toThrow(GmailError);
  expect(() => refuseGmailPermanentDelete("delete")).toThrow("永久删除本批不提供");
});

// ---------- 审计只记元数据 ----------

test("GmailDeepTest.test_audit_records_metadata_only", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-gmail-audit-"));
  const { transport } = makeTransport(home, "local");
  await transport.listLabels();
  await transport.markRead("msg-1");
  await transport.trash("msg-1");
  await transport.getAttachment("msg-1", "att-txt");
  const auditPath = join(home, CONNECTOR_AUDIT_FILE);
  expect(existsSync(auditPath)).toBe(true);
  const lines = readFileSync(auditPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.length).toBe(4);
  for (const line of lines) {
    expect(line.action).toBe("call");
    expect(line.connector).toBe("gmail");
    expect(typeof line.operation).toBe("string");
    expect(typeof line.records).toBe("number");
    expect(typeof line.duration_ms).toBe("number");
  }
  expect(lines.map((l) => l.operation)).toEqual(["labels", "mark_read", "trash", "attachment"]);
  const raw = readFileSync(auditPath, "utf-8");
  expect(raw).not.toContain("ya29.fake-access");
  expect(raw).not.toContain("1//fake-refresh");
  expect(raw).not.toContain("这是附件里的文字。");
  expect(raw).not.toContain("附件测试");
});

// ---------- 授权门：未授权 / 过期 / 撤销 ----------

test("GmailDeepTest.test_create_transport_requires_auth", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-gmail-noauth-"));
  // 连接器默认关闭：先报“未启用”（GmailError），不是授权错误。
  expect(() => createGmailTransport(home, loadConfig(home))).toThrow(GmailError);
  expect(() => createGmailTransport(home, loadConfig(home))).toThrow("未启用");
});

test("GmailDeepTest.test_expired_auth_blocks_calls", () => {
  const home = seedHome();
  // markConnectorExpired 只在已有已授权记录时才标过期：先授权，再标过期。
  markConnectorAuthorized(home, "gmail", "local");
  markConnectorExpired(home, "gmail", "local", "测试标过期");
  expect(() => createGmailTransport(home, loadConfig(home))).toThrow(GmailAuthError);
  expect(() => createGmailTransport(home, loadConfig(home))).toThrow("已过期");
});

test("GmailDeepTest.test_revoked_auth_blocks_calls_immediately", () => {
  const home = seedHome();
  markConnectorRevoked(home, "gmail", "local");
  // 状态门已关：即使密码箱里的 token 还在，调用方也不能绕过状态直接用。
  expect(() => createGmailTransport(home, loadConfig(home))).toThrow(GmailAuthError);
  expect(() => createGmailTransport(home, loadConfig(home))).toThrow("已被撤销");
  // token 本身还在密码箱里（撤销只关状态门，不删凭证——彻底作废须去 Google 账号页）。
  expect(new Vault(vaultPath(home)).listNames()).toContain(GMAIL_VAULT_TOKENS_ENTRY);
});

// ---------- OAuth 合并后 auth 路径不变 ----------

test("GmailDeepTest.test_build_auth_url_unchanged_after_oauth_merge", () => {
  const url = buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:9/callback", state: "s1" });
  const u = new URL(url);
  expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(u.searchParams.get("client_id")).toBe("cid");
  expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9/callback");
  expect(u.searchParams.get("response_type")).toBe("code");
  expect(u.searchParams.get("access_type")).toBe("offline");
  expect(u.searchParams.get("prompt")).toBe("consent");
  expect(u.searchParams.get("state")).toBe("s1");
  const scopes = u.searchParams.get("scope") ?? "";
  expect(scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
  expect(scopes).toContain("https://www.googleapis.com/auth/gmail.send");
  expect(scopes).toContain("https://www.googleapis.com/auth/gmail.modify");
});

test("GmailDeepTest.test_loopback_timeout_error_unchanged_after_oauth_merge", async () => {
  const server = await startLoopbackCallbackServer({ state: "s1", timeoutMs: 50 });
  try {
    await expect(server.waitForCode()).rejects.toThrow("请重新运行 nyra gmail auth");
    let caught: unknown;
    try {
      await server.waitForCode();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GmailError);
  } finally {
    server.close();
  }
});

// ---------- CLI ----------

test("GmailDeepTest.test_cli_delete_refused_without_transport", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-gmail-cli-"));
  const { code, err } = await captureStderr(() => handleGmail(["delete", "msg-1"], home));
  expect(code).toBe(1);
  expect(err).toContain("永久删除本批不提供");
  const { code: code2, err: err2 } = await captureStderr(() => handleGmail(["purge", "msg-1"], home));
  expect(code2).toBe(1);
  expect(err2).toContain("永久删除本批不提供");
});

test("GmailDeepTest.test_cli_missing_args_usage", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-gmail-cli-"));
  const { code: c1, err: e1 } = await captureStderr(() => handleGmail(["label"], home));
  expect(c1).toBe(2);
  expect(e1).toContain("nyra gmail label");
  const { code: c2, err: e2 } = await captureStderr(() => handleGmail(["attachment"], home));
  expect(c2).toBe(2);
  expect(e2).toContain("nyra gmail attachment");
});

test("GmailDeepTest.test_cli_label_with_yes_end_to_end", async () => {
  const home = seedHome();
  const stub = makeStubFetch();
  const restore = stubGlobalFetch(stub.fetchFn);
  try {
    const { code, out } = await captureStdout(() => handleGmail(["label", "msg-1", "Label_1", "--yes"], home));
    expect(code).toBe(0);
    expect(out).toContain("加标签");
    expect(out).toContain("Label_1");
    expect(stub.calls.some((c) => c.path.endsWith("/modify"))).toBe(true);
  } finally {
    restore();
  }
});

test("GmailDeepTest.test_cli_trash_with_interactive_confirm", async () => {
  const home = seedHome();
  const stub = makeStubFetch();
  const restore = stubGlobalFetch(stub.fetchFn);
  try {
    const { code, out } = await captureStdout(() => handleGmail(["trash", "msg-1"], home, { passwords: ["y"] }));
    expect(code).toBe(0);
    expect(out).toContain("移进回收站");
    expect(stub.calls.some((c) => c.path.endsWith("/trash"))).toBe(true);
  } finally {
    restore();
  }
});

test("GmailDeepTest.test_cli_trash_declined_does_not_call_api", async () => {
  const home = seedHome();
  const stub = makeStubFetch();
  const restore = stubGlobalFetch(stub.fetchFn);
  try {
    const { code, out } = await captureStdout(() => handleGmail(["trash", "msg-1"], home, { passwords: ["n"] }));
    expect(code).toBe(1);
    expect(out).toContain("已取消");
    expect(stub.calls.some((c) => c.path.endsWith("/trash"))).toBe(false);
  } finally {
    restore();
  }
});

test("GmailDeepTest.test_cli_attachment_end_to_end", async () => {
  const home = seedHome();
  const stub = makeStubFetch();
  const restore = stubGlobalFetch(stub.fetchFn);
  try {
    const { code, out } = await captureStdout(() => handleGmail(["attachment", "msg-1", "att-txt"], home));
    expect(code).toBe(0);
    expect(out).toContain("这是附件里的文字。");
    const outPath = join(home, "saved-note.txt");
    const { code: code2, out: out2 } = await captureStdout(() => handleGmail(["attachment", "msg-1", "att-txt", "--out", outPath], home));
    expect(code2).toBe(0);
    expect(out2).toContain("已保存到");
    expect(readFileSync(outPath, "utf-8")).toBe("这是附件里的文字。");
    // --out 落盘的附件文件是 0600（Windows 不认 POSIX mode，跳过断言）。
    if (process.platform !== "win32") {
      expect(statSync(outPath).mode & 0o777).toBe(0o600);
    }
    // 附件临时目录处理完即删：tmp 里不留 nyra-gmail-attachment-*。
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("nyra-gmail-attachment-"))).toEqual([]);
  } finally {
    restore();
  }
});
