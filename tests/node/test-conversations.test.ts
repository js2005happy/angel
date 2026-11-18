// tests/node/test-conversations.test.ts — 对应 tests/test_conversations.py（18 个唯一测试）。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore, tokensOf, fts5Supported } from "../../src/conversations.ts";

function store(): ConversationStore {
  return new ConversationStore(mkdtempSync(join(tmpdir(), "nyra-conv-")));
}

test("ConversationsTest.test_fts5_available", () => {
  expect(fts5Supported()).toBe(true);
});

test("ConversationsTest.test_tokens_of_chinese", () => {
  // 无空格的中文整段是一个 token（Unicode 词切分）；二元组是 knowledge
  // 的 tokenize 做的事，不是这里的 tokensOf。
  const tokens = tokensOf("我在学习工业机器人技术");
  expect(tokens).toEqual(["我在学习工业机器人技术"]);
  const en = tokensOf("Hello World");
  expect(en).toEqual(["Hello", "World"]);
});

test("ConversationsTest.test_record_and_history", () => {
  const s = store();
  s.record("sess1", "user", "你好");
  s.record("sess1", "assistant", "你好呀");
  const history = s.history("sess1");
  expect(history.length).toBe(2);
  expect(history[0].role).toBe("user");
  expect(history[1].text).toBe("你好呀");
  s.close();
});

test("ConversationsTest.test_search_chinese_fts5", () => {
  const s = store();
  s.record("sess1", "user", "你好，我在学习工业机器人");
  s.record("sess1", "user", "今天天气不错");
  const results = s.search("工业机器人");
  expect(results.length).toBeGreaterThanOrEqual(1);
  expect(results[0].text).toContain("工业机器人");
  s.close();
});

test("ConversationsTest.test_search_fallback_like", () => {
  const s = store();
  s.record("sess1", "user", "独特的关键词xyz123");
  const results = s.search("xyz123", 5);
  expect(results.length).toBeGreaterThanOrEqual(1);
  s.close();
});

test("ConversationsTest.test_sessions_list", () => {
  const s = store();
  s.record("sess1", "user", "a");
  s.record("sess2", "user", "b");
  s.record("sess1", "user", "c");
  const sessions = s.sessions();
  expect(sessions.map((x) => x.session_id).sort()).toEqual(["sess1", "sess2"]);
  expect(sessions.find((x) => x.session_id === "sess1")?.count).toBe(2);
  s.close();
});

test("ConversationsTest.test_retrieve_context", () => {
  const s = store();
  s.record("sess1", "user", "工业机器人需要定期保养");
  const ctx = s.retrieveContext("工业机器人");
  expect(ctx).toContain("工业机器人");
  s.close();
});

test("ConversationsTest.test_batch_record_uses_transaction", () => {
  const s = store();
  const rows = Array.from({ length: 100 }, (_, i) => ({ sessionId: "sess1", role: "user", text: `第 ${i} 条` }));
  const ids = s.batchRecord(rows);
  expect(ids.length).toBe(100);
  expect(s.history("sess1", 100).length).toBe(100);
  s.close();
});

test("ConversationsTest.test_prune_old", () => {
  const s = store();
  // created_at 单位是秒（与 Python 版 time.time() 一致），不是毫秒。
  const old = Date.now() / 1000 - 100 * 24 * 3600;
  s.record("sess1", "user", "旧消息", null, old);
  s.record("sess1", "user", "新消息");
  const removed = s.prune(90);
  expect(removed).toBe(1);
  expect(s.history("sess1").map((r) => r.text)).toEqual(["新消息"]);
  s.close();
});

test("ConversationsTest.test_record_scrubs_secrets", () => {
  const s = store();
  // 含密钥的行整行丢弃（record 返回 null、不存库）；正常行保留。
  const id = s.record("sess1", "user", "我的密钥是 sk-abcdefgh12345678 请记住");
  expect(id).toBeNull();
  s.record("sess1", "user", "今天天气不错\napi_key: sk-abcdefgh12345678");
  const history = s.history("sess1");
  expect(history.length).toBe(1);
  expect(history[0].text).toBe("今天天气不错");
  expect(history[0].text).not.toContain("sk-abcdefgh12345678");
  s.close();
});

test("ConversationsTest.test_history_limit", () => {
  const s = store();
  for (let i = 0; i < 10; i++) s.record("sess1", "user", `消息 ${i}`);
  expect(s.history("sess1", 3).length).toBe(3);
  expect(s.history("sess1", 3)[0].text).toContain("消息 7");
  s.close();
});

test("ConversationsTest.test_empty_search", () => {
  const s = store();
  s.record("sess1", "user", "hello");
  expect(s.search("")).toEqual([]);
  expect(s.search("不存在的词zzz")).toEqual([]);
  s.close();
});
