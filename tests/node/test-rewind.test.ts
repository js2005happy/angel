// tests/node/test-rewind.test.ts — /rewind 专项（第 3 阶段）。
// 存档级：回退 / 编辑重发 / fork；gateway 级：三端同一份实现，
// 回退后 live 会话与会话文件与存档一致。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../../src/conversations.ts";
import { rewindTo, rewindEdit, rewindFork } from "../../src/rewind.ts";
import { Gateway } from "../../src/gateway.ts";
import { GatewayClient } from "../../src/gatewayClient.ts";
import { echoProvider } from "./fake-provider.ts";

function seedStore(home: string, sessionId: string): ConversationStore {
  const store = new ConversationStore(home);
  store.record(sessionId, "user", "第一问", null, 1000);
  store.record(sessionId, "assistant", "第一答", null, 1001);
  store.record(sessionId, "user", "第二问", null, 1002);
  store.record(sessionId, "assistant", "第二答", null, 1003);
  store.record(sessionId, "user", "第三问", null, 1004);
  return store;
}

test("RewindTest.test_truncate_keeps_target_and_before", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-rw-"));
  const store = seedStore(home, "s1");
  const rows = store.history("s1", 100);
  expect(rows.length).toBe(5);
  const target = rows[1]; // 第一答
  const result = rewindTo(store, "s1", target.id);
  expect(result.deleted).toBe(3);
  expect(result.kept).toBe(2);
  const after = store.history("s1", 100);
  expect(after.map((r) => r.text)).toEqual(["第一问", "第一答"]);
  store.close();
});

test("RewindTest.test_edit_requires_user_message_and_rewrites", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-rw-"));
  const store = seedStore(home, "s1");
  const rows = store.history("s1", 100);
  // 编辑 assistant 消息应拒绝。
  expect(() => rewindEdit(store, "s1", rows[1].id, "改")).toThrow("只能编辑 user 消息");
  const result = rewindEdit(store, "s1", rows[2].id, "第二问（改过）");
  expect(result.edited_text).toBe("第二问（改过）");
  expect(result.deleted).toBe(2);
  expect(store.history("s1", 100).map((r) => r.text)).toEqual(["第一问", "第一答", "第二问（改过）"]);
  store.close();
});

test("RewindTest.test_fork_copies_prefix_and_leaves_original", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-rw-"));
  const store = seedStore(home, "s1");
  const rows = store.history("s1", 100);
  const result = rewindFork(store, "s1", rows[2].id);
  expect(result.new_session_id).toBeTruthy();
  expect(result.kept).toBe(3);
  expect(store.history("s1", 100).length).toBe(5);
  expect(store.history(result.new_session_id!, 100).map((r) => r.text)).toEqual(["第一问", "第一答", "第二问"]);
  store.close();
});

test("RewindTest.test_unknown_message_and_cross_session_rejected", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-rw-"));
  const store = seedStore(home, "s1");
  expect(() => rewindTo(store, "s1", 999999)).toThrow("消息不存在");
  const rows = store.history("s1", 100);
  expect(() => rewindTo(store, "other", rows[0].id)).toThrow("不属于会话");
  store.close();
});

test("RewindGatewayTest.test_api_rewind_rebuilds_live_session", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-rw-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-rw-wd-"));
  writeFileSync(join(workdir, "a.txt"), "a\n", "utf-8");
  const gw = new Gateway({
    home, workdir, host: "127.0.0.1", port: 0, mode: "full",
    providerFactory: () => echoProvider("好的。"),
    config: { mcp_enabled: false, fallback_enabled: false },
  });
  const info = await gw.start();
  try {
    const client = new GatewayClient({ url: `http://127.0.0.1:${info.port}`, token: gw.token });
    const { id } = await client.createSession();
    await client.send(id, "第一问");
    const start = Date.now();
    for (;;) {
      const v = await client.sessionView(id) as { status: string };
      if (v.status === "done") break;
      if (Date.now() - start > 10000) throw new Error("等待超时");
      await new Promise((r) => setTimeout(r, 100));
    }
    const history = await client.history(id);
    expect(history.messages.length).toBe(2);
    const firstUser = history.messages.find((m) => m.role === "user")!;
    const res = await client.rewind(id, firstUser.id, "edit", "第一问（改过）") as { kept: number; deleted: number };
    expect(res.kept).toBe(1);
    expect(res.deleted).toBe(1);
    // live 会话与存档一致：只剩改过的那条 user 消息。
    const view = await client.sessionView(id) as { messages: { role: string; content: string }[] };
    expect(view.messages.length).toBe(1);
    expect(view.messages[0].content).toBe("第一问（改过）");
    const history2 = await client.history(id);
    expect(history2.messages.map((m) => m.text)).toEqual(["第一问（改过）"]);
  } finally {
    await gw.stop();
  }
});
