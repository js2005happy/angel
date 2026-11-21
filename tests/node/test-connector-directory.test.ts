// tests/node/test-connector-directory.test.ts — 缺口 44 第一批：原生业务连接器目录（安装/卸载/用量）+ 一键连接入口。
// 全部用临时 home 与假 API，不连真实业务系统、不碰真实 token。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTOR_DIRECTORY_FILE,
  CONNECTOR_USAGE_FILE,
  ConnectorDirectoryError,
  ConnectorDirectoryStore,
  getAllUsage,
  getConnectorUsage,
  installConnector,
  isConnectorInstalled,
  listDirectory,
  recordConnectorCall,
  uninstallConnector,
} from "../../src/connectors/directory.ts";
import {
  CONNECTOR_AUDIT_FILE,
  markConnectorAuthorized,
  peekConnectorState,
} from "../../src/connectors/registry.ts";
import { RunStore } from "../../src/runs.ts";
import { handleConnector } from "../../src/cli.ts";
import { createSlackClient, SLACK_VAULT_CREDENTIALS_ENTRY } from "../../src/connectors/slack.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import { Vault } from "../../src/vault.ts";
import { expectPerms } from "./fsPerms.ts";

const USER = "local";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-connector-dir-"));
}

function cleanup(home: string): void {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

function readAudit(home: string): string {
  return existsSync(join(home, CONNECTOR_AUDIT_FILE)) ? readFileSync(join(home, CONNECTOR_AUDIT_FILE), "utf-8") : "";
}

function makeRun(home: string): string {
  const store = new RunStore(join(home, "runs"));
  return store.create("目录测试任务", "sess-1", home, "normal", 10).run_id;
}

function runEvents(home: string, runId: string): { type: string; [key: string]: unknown }[] {
  const store = new RunStore(join(home, "runs"));
  return store.readEvents(runId) as { type: string; [key: string]: unknown }[];
}

function captureStdout(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
  return { logs, restore: () => { process.stdout.write = orig; } };
}

function seedSlackVault(home: string, password: string): void {
  const vault = new Vault(join(home, "vault.json"));
  vault.init(password);
  vault.unlock(password);
  vault.add(SLACK_VAULT_CREDENTIALS_ENTRY, JSON.stringify({ token: "xoxb-fake-token-for-test", team: "hollow-scale" }), true);
  saveConfig(home, { connectors: { slack: { enabled: true } } });
  process.env.NYRA_VAULT_PASSWORD = password;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---- 安装 ----

test("安装未知连接器直接拒绝", () => {
  const home = tempHome();
  try {
    expect(() => installConnector(home, "not-a-connector", USER)).toThrow(ConnectorDirectoryError);
    expect(() => installConnector(home, "not-a-connector", USER)).toThrow("未知连接器");
  } finally { cleanup(home); }
});

test("安装 gmail：记录字段齐全、账本 0600、审计记 installed", () => {
  const home = tempHome();
  try {
    const rec = installConnector(home, "gmail", USER);
    expect(rec.connectorId).toBe("gmail");
    expect(rec.installedBy).toBe(USER);
    expect(rec.installedAt.length).toBeGreaterThan(10);
    expect(existsSync(join(home, CONNECTOR_DIRECTORY_FILE))).toBe(true);
    expectPerms(join(home, CONNECTOR_DIRECTORY_FILE), 0o600);
    expect(isConnectorInstalled(home, "gmail")).toBe(true);
    expect(readAudit(home)).toContain('"action":"installed"');
    expect(readAudit(home)).toContain('"connector":"gmail"');
  } finally { cleanup(home); }
});

test("重复安装是幂等的：不改第一次的安装时间、不重复记审计", () => {
  const home = tempHome();
  try {
    const first = installConnector(home, "slack", USER);
    const second = installConnector(home, "slack", USER);
    expect(second.installedAt).toBe(first.installedAt);
    expect(new ConnectorDirectoryStore(home).load().installed["slack"]).toEqual(first);
    expect(readAudit(home).split("\n").filter((l) => l.includes('"installed"')).length).toBe(1);
  } finally { cleanup(home); }
});

// ---- 卸载 ----

test("卸载没装的连接器直接拒绝", () => {
  const home = tempHome();
  try {
    expect(() => uninstallConnector(home, "gmail", USER)).toThrow(ConnectorDirectoryError);
    expect(() => uninstallConnector(home, "gmail", USER)).toThrow("还没安装");
    expect(() => uninstallConnector(home, "not-a-connector", USER)).toThrow("未知连接器");
  } finally { cleanup(home); }
});

test("卸载：目录里拿掉 + 授权同时撤销 + 审计记 uninstalled", () => {
  const home = tempHome();
  try {
    installConnector(home, "shopify", USER);
    markConnectorAuthorized(home, "shopify", USER);
    expect(peekConnectorState(home, "shopify", USER)).toBe("authorized");
    const removed = uninstallConnector(home, "shopify", USER);
    expect(removed.connectorId).toBe("shopify");
    expect(isConnectorInstalled(home, "shopify")).toBe(false);
    expect(peekConnectorState(home, "shopify", USER)).toBe("revoked");
    expect(readAudit(home)).toContain('"action":"uninstalled"');
    expect(readAudit(home)).toContain('"action":"revoked"');
  } finally { cleanup(home); }
});

test("卸载后用量历史保留（审计与用量账本是历史，不跟着删）", () => {
  const home = tempHome();
  try {
    installConnector(home, "slack", USER);
    recordConnectorCall(home, { connector: "slack", operation: "list_channels", records: 2, durationMs: 5 });
    uninstallConnector(home, "slack", USER);
    expect(getConnectorUsage(home, "slack").totalCalls).toBe(1);
  } finally { cleanup(home); }
});

// ---- 目录列表 ----

test("listDirectory：一行含声明、安装状态、授权状态与用量", () => {
  const home = tempHome();
  try {
    installConnector(home, "gmail", USER);
    recordConnectorCall(home, { connector: "gmail", operation: "labels", records: 3, durationMs: 7 });
    const rows = listDirectory(home, USER);
    expect(rows.map((r) => r.declaration.id)).toEqual(["gmail", "shopify", "slack"]);
    const gmail = rows[0];
    expect(gmail.installed).toBe(true);
    expect(gmail.authState).toBe("unauthorized");
    expect(gmail.usage.totalCalls).toBe(1);
    expect(rows[1].installed).toBe(false);
    expect(rows[1].usage.totalCalls).toBe(0);
  } finally { cleanup(home); }
});

// ---- 用量 ----

test("recordConnectorCall：未知连接器不记，返回 null", () => {
  const home = tempHome();
  try {
    expect(recordConnectorCall(home, { connector: "not-a-connector", operation: "x" })).toBeNull();
    expect(existsSync(join(home, CONNECTOR_USAGE_FILE))).toBe(false);
  } finally { cleanup(home); }
});

test("recordConnectorCall：总次数、分操作次数、最后调用时间都记", () => {
  const home = tempHome();
  try {
    recordConnectorCall(home, { connector: "shopify", operation: "list_products", records: 2, durationMs: 10 });
    recordConnectorCall(home, { connector: "shopify", operation: "list_products", records: 2, durationMs: 12 });
    recordConnectorCall(home, { connector: "shopify", operation: "get_product", records: 1, durationMs: 3 });
    const usage = getConnectorUsage(home, "shopify");
    expect(usage.totalCalls).toBe(3);
    expect(usage.operations).toEqual({ list_products: 2, get_product: 1 });
    expect(usage.lastCalledAt).not.toBeNull();
    expect(existsSync(join(home, CONNECTOR_USAGE_FILE))).toBe(true);
    expectPerms(join(home, CONNECTOR_USAGE_FILE), 0o600);
    expect(getAllUsage(home)["shopify"].totalCalls).toBe(3);
  } finally { cleanup(home); }
});

test("recordConnectorCall 有 runId 时写 connector_call 运行事件", () => {
  const home = tempHome();
  try {
    const runId = makeRun(home);
    const entry = recordConnectorCall(home, { connector: "gmail", operation: "labels", runId, records: 4, durationMs: 9 });
    expect(entry?.totalCalls).toBe(1);
    const calls = runEvents(home, runId).filter((e) => e.type === "connector_call");
    expect(calls.length).toBe(1);
    expect(calls[0].connector).toBe("gmail");
    expect(calls[0].operation).toBe("labels");
    expect(calls[0].records).toBe(4);
    expect(calls[0].duration_ms).toBe(9);
  } finally { cleanup(home); }
});

test("recordConnectorCall 没 runId 时走证据文件回落，不抛错", () => {
  const home = tempHome();
  try {
    const entry = recordConnectorCall(home, { connector: "gmail", operation: "labels", records: 1, durationMs: 1 });
    expect(entry?.totalCalls).toBe(1);
    const evidenceDir = join(home, "evidence", "connector");
    expect(existsSync(evidenceDir)).toBe(true);
    expect(readdirSync(evidenceDir).length).toBeGreaterThan(0);
  } finally { cleanup(home); }
});

// ---- 账本损坏 ----

test("目录账本损坏：先备份再抛错", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, CONNECTOR_DIRECTORY_FILE), "{ 坏掉的 json", "utf-8");
    expect(() => installConnector(home, "gmail", USER)).toThrow("账本损坏，已备份");
    const backups = readdirSync(home).filter((f) => f.startsWith(`${CONNECTOR_DIRECTORY_FILE}.corrupt-`));
    expect(backups.length).toBe(1);
  } finally { cleanup(home); }
});

test("用量账本损坏：先备份再从空开始，不拦调用", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, CONNECTOR_USAGE_FILE), "{ 坏掉的 json", "utf-8");
    const entry = recordConnectorCall(home, { connector: "slack", operation: "list_channels", records: 2, durationMs: 4 });
    expect(entry?.totalCalls).toBe(1);
    const backups = readdirSync(home).filter((f) => f.startsWith(`${CONNECTOR_USAGE_FILE}.corrupt-`));
    expect(backups.length).toBe(1);
  } finally { cleanup(home); }
});

// ---- 事件注册 ----

test("三个新事件已注册进 EVENT_FIELDS：appendEvent 不抛错", () => {
  const home = tempHome();
  try {
    const runId = makeRun(home);
    const store = new RunStore(join(home, "runs"));
    expect(() => store.appendEvent(runId, "connector_installed", { connector: "gmail", user_id: USER })).not.toThrow();
    expect(() => store.appendEvent(runId, "connector_uninstalled", { connector: "gmail", user_id: USER })).not.toThrow();
    expect(() => store.appendEvent(runId, "connector_call", { connector: "gmail", operation: "labels", records: 1, duration_ms: 2 })).not.toThrow();
    const types = runEvents(home, runId).map((e) => e.type);
    expect(types).toContain("connector_installed");
    expect(types).toContain("connector_uninstalled");
    expect(types).toContain("connector_call");
  } finally { cleanup(home); }
});

// ---- CLI ----

test("CLI install：装 gmail 成功，输出含权限声明；装未知连接器返回 2", async () => {
  const home = tempHome();
  try {
    const cap = captureStdout();
    try {
      expect(await handleConnector(["install", "gmail"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("已安装 Gmail 到目录");
      expect(cap.logs.join("")).toContain("永远禁做");
      expect(cap.logs.join("")).toContain("nyra connector auth gmail");
    } finally { cap.restore(); }
    expect(await handleConnector(["install", "not-a-connector"], home)).toBe(2);
    expect(await handleConnector(["install"], home)).toBe(2);
  } finally { cleanup(home); }
});

test("CLI usage：没装也能看用量（全 0），指定连接器只列它", async () => {
  const home = tempHome();
  try {
    recordConnectorCall(home, { connector: "slack", operation: "list_channels", records: 2, durationMs: 4 });
    const cap = captureStdout();
    try {
      expect(await handleConnector(["usage"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("Slack");
      expect(cap.logs.join("")).toContain("调用 1 次");
      expect(cap.logs.join("")).toContain("list_channels：1 次");
    } finally { cap.restore(); }
    const cap2 = captureStdout();
    try {
      expect(await handleConnector(["usage", "gmail"], home)).toBe(0);
      expect(cap2.logs.join("")).toContain("调用 0 次");
    } finally { cap2.restore(); }
    expect(await handleConnector(["usage", "not-a-connector"], home)).toBe(2);
  } finally { cleanup(home); }
});

test("CLI uninstall --yes：目录里拿掉 + 授权撤销；没装的返回 1", async () => {
  const home = tempHome();
  try {
    installConnector(home, "gmail", USER);
    const cap = captureStdout();
    try {
      expect(await handleConnector(["uninstall", "gmail", "--yes"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("已从目录卸载");
    } finally { cap.restore(); }
    expect(isConnectorInstalled(home, "gmail")).toBe(false);
    expect(peekConnectorState(home, "gmail", USER)).toBe("revoked");
    expect(await handleConnector(["uninstall", "gmail", "--yes"], home)).toBe(1);
    expect(await handleConnector(["uninstall"], home)).toBe(2);
  } finally { cleanup(home); }
});

test("CLI auth：未知连接器返回 2；缺参数返回 2", async () => {
  const home = tempHome();
  try {
    expect(await handleConnector(["auth", "not-a-connector"], home)).toBe(2);
    expect(await handleConnector(["auth"], home)).toBe(2);
  } finally { cleanup(home); }
});

test("CLI list/status：输出含安装状态与调用次数", async () => {
  const home = tempHome();
  try {
    installConnector(home, "gmail", USER);
    recordConnectorCall(home, { connector: "gmail", operation: "labels", records: 1, durationMs: 1 });
    const cap = captureStdout();
    try {
      expect(await handleConnector(["list"], home)).toBe(0);
      expect(cap.logs.join("")).toContain("已安装");
      expect(cap.logs.join("")).toContain("调用 1 次");
    } finally { cap.restore(); }
    const cap2 = captureStdout();
    try {
      expect(await handleConnector(["status", "gmail"], home)).toBe(0);
      expect(cap2.logs.join("")).toContain("安装于：");
      expect(cap2.logs.join("")).toContain("最后调用：");
    } finally { cap2.restore(); }
  } finally { cleanup(home); }
});

// ---- 客户端接线：真实调用走用量账本 ----

test("Slack 真实调用（假 API）：listChannels 后用量 +1", async () => {
  const home = tempHome();
  const prevPassword = process.env.NYRA_VAULT_PASSWORD;
  try {
    seedSlackVault(home, "test-password-123");
    markConnectorAuthorized(home, "slack", USER);
    const stubFetch = async (): Promise<Response> => jsonResponse({
      ok: true,
      channels: [{ id: "C0123456789", name: "general", is_private: false, num_members: 12 }],
      response_metadata: { next_cursor: "" },
    });
    const client = createSlackClient(home, loadConfig(home), { fetchFn: stubFetch });
    const { channels } = await client.listChannels();
    expect(channels.length).toBe(1);
    const usage = getConnectorUsage(home, "slack");
    expect(usage.totalCalls).toBe(1);
    expect(usage.operations["list_channels"]).toBe(1);
    expect(readAudit(home)).toContain('"action":"call"');
  } finally {
    if (prevPassword === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = prevPassword;
    cleanup(home);
  }
});
