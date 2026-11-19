// tests/node/test-memory.test.ts — 对应 tests/test_session_atomic.py（4 唯一）+ 记忆/会话行为。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveNyraHome, loadMemorySummary, appendMemory, loadAgentsMd,
  newSessionId, sessionPath, saveSession, loadSession, listSessions,
} from "../../src/memory.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "nyra-mem-"));
}

test("MemoryTest.test_resolve_nyra_home", () => {
  expect(resolveNyraHome("/tmp/custom")).toBe("/tmp/custom");
  expect(resolveNyraHome()).toContain(".nyra");
});

test("MemoryTest.test_append_and_load_summary", () => {
  const h = home();
  appendMemory("第一条记忆", undefined, h);
  appendMemory("第二条记忆", undefined, h);
  const summary = loadMemorySummary(40, undefined, h);
  expect(summary).toContain("第一条记忆");
  expect(summary).toContain("第二条记忆");
  expect(summary).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
});

test("MemoryTest.test_append_folds_multiline", () => {
  const h = home();
  appendMemory("第一行\n第二行", undefined, h);
  const summary = loadMemorySummary(40, undefined, h);
  expect(summary).toContain("第一行 第二行");
  expect(summary.split("\n").length).toBe(1);
});

test("MemoryTest.test_load_summary_max_lines", () => {
  const h = home();
  for (let i = 0; i < 10; i++) appendMemory(`记忆 ${i}`, undefined, h);
  expect(loadMemorySummary(3, undefined, h).split("\n").length).toBe(3);
  expect(loadMemorySummary(3, undefined, h)).toContain("记忆 9");
  expect(loadMemorySummary(0, undefined, h)).toBe("");
});

test("MemoryTest.test_load_agents_md_project_and_global", () => {
  const h = home();
  const wd = mkdtempSync(join(tmpdir(), "nyra-mem-wd-"));
  writeFileSync(join(wd, "AGENTS.md"), "项目说明\n");
  writeFileSync(join(h, "AGENTS.md"), "全局说明\n");
  const out = loadAgentsMd(wd, h);
  expect(out).toContain("项目说明");
  expect(out).toContain("全局说明");
});

test("MemoryTest.test_new_session_id_format", () => {
  // newSessionId 用本地时间分量；期望值也按本地分量算，测试在任何时区都通过。
  const d = new Date("2026-11-18T12:34:56Z");
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const id = newSessionId(d);
  expect(id).toMatch(new RegExp(`^${stamp}-[0-9a-f]{4}$`));
  expect(newSessionId()).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
});

test("MemoryTest.test_session_path_rejects_traversal", () => {
  const h = home();
  expect(() => sessionPath("../escape", h)).toThrow();
  expect(() => sessionPath("a/b", h)).toThrow();
  expect(() => sessionPath("a:b", h)).toThrow();
  expect(sessionPath("20261118-000000-ab12", h)).toContain("20261118-000000-ab12.jsonl");
});

test("MemoryTest.test_save_load_session_roundtrip", () => {
  const h = home();
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好呀" },
  ];
  const path = saveSession("20261118-000000-test1", messages, h);
  expect(existsSync(path)).toBe(true);
  if (process.platform !== "win32") {
    expectPerms(path, 0o600);
  }
  const loaded = loadSession("20261118-000000-test1", h);
  expect(loaded).toEqual(messages);
});

test("MemoryTest.test_save_session_python_json_format", () => {
  const h = home();
  saveSession("20261118-000000-test2", [{ role: "user", content: "中文内容" }], h);
  const raw = readFileSync(join(h, "sessions", "20261118-000000-test2.jsonl"), "utf-8");
  expect(raw).toContain("中文内容");
  expect(raw).not.toContain("\\u4e2d");
  expect(JSON.parse(raw.trim())).toEqual({ role: "user", content: "中文内容" });
});

test("MemoryTest.test_load_session_corrupt_lines_skipped", () => {
  const h = home();
  const dir = join(h, "sessions");
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "20261118-000000-test3.jsonl"), '{"role": "user", "content": "好"}\n不是 json\n{"role": "assistant", "content": "收到"}\n');
  const loaded = loadSession("20261118-000000-test3", h);
  expect(loaded?.length).toBe(2);
});

test("MemoryTest.test_load_session_unknown_returns_null", () => {
  const h = home();
  expect(loadSession("20261118-000000-nope", h)).toBeNull();
  expect(loadSession("../escape", h)).toBeNull();
});

test("MemoryTest.test_list_sessions_newest_first_with_preview", () => {
  const h = home();
  saveSession("20261118-000000-aaa1", [{ role: "user", content: "第一个会话的内容" }], h);
  saveSession("20261118-000001-bbb2", [{ role: "user", content: "第二个会话" }], h);
  const list = listSessions(h);
  expect(list.length).toBe(2);
  expect(list[0].id).toBe("20261118-000001-bbb2");
  expect(list[0].preview).toContain("第二个会话");
});
