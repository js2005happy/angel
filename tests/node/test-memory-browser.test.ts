// tests/node/test-memory-browser.test.ts — 记忆浏览器专项（第 3 阶段）。
// revision 乐观锁、64 KiB 上限、符号链接拒绝、范围校验。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectMemory, replaceMemory, memoryView, memorySave, memoryScopes,
  MemoryConflict, MAX_MEMORY_BYTES,
} from "../../src/memoryBrowser.ts";

test("MemoryBrowserTest.test_inspect_missing_and_replace", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-mb-"));
  const path = join(home, "MEMORY.md");
  const first = inspectMemory(path);
  expect(first.exists).toBe(false);
  expect(first.revision).toBe("missing");
  const saved = replaceMemory(path, "missing", "# 记忆\n- 事实 A\n");
  expect(saved.exists).toBe(true);
  expect(saved.content).toContain("事实 A");
  const again = inspectMemory(path);
  expect(again.revision).toBe(saved.revision);
  const saved2 = replaceMemory(path, again.revision, "# 记忆\n- 事实 B\n");
  expect(saved2.content).toContain("事实 B");
});

test("MemoryBrowserTest.test_revision_conflict", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-mb-"));
  const path = join(home, "MEMORY.md");
  writeFileSync(path, "v1\n", "utf-8");
  const view = inspectMemory(path);
  writeFileSync(path, "v2（别人改过）\n", "utf-8");
  expect(() => replaceMemory(path, view.revision, "v3\n")).toThrow(MemoryConflict);
});

test("MemoryBrowserTest.test_symlink_refused", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-mb-"));
  const target = join(home, "real.md");
  writeFileSync(target, "真文件\n", "utf-8");
  const link = join(home, "link.md");
  symlinkSync(target, link);
  expect(() => inspectMemory(link)).toThrow("符号链接");
});

test("MemoryBrowserTest.test_size_cap", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-mb-"));
  const path = join(home, "MEMORY.md");
  expect(() => replaceMemory(path, "missing", "x".repeat(MAX_MEMORY_BYTES + 1))).toThrow("64 KiB");
});

test("MemoryBrowserTest.test_global_scope_via_home", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-mb-"));
  const view = memoryView(home, "global");
  expect(view.exists).toBe(false);
  const saved = memorySave(home, "global", null, null, "missing", "全局记忆\n");
  expect(saved.content).toBe("全局记忆\n");
  expect(() => memoryView(home, "bot", "room1", "bot1")).toThrow("机器人群不存在");
  const scopes = memoryScopes(home);
  expect(scopes).toEqual([{ scope: "global", label: "Nyra · 全局记忆" }]);
});

test("MemoryBrowserTest.test_bot_scope_requires_room_and_member", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-mb-"));
  const roomDir = join(home, "groups", "room1");
  mkdirSync(roomDir, { recursive: true });
  writeFileSync(join(roomDir, "room.json"), JSON.stringify({ id: "room1", name: "群一", bots: [{ id: "bot1", name: "助手" }] }), "utf-8");
  const view = memoryView(home, "bot", "room1", "bot1");
  expect(view.exists).toBe(false);
  expect(() => memoryView(home, "bot", "room1", "bot2")).toThrow("不属于该群");
  const scopes = memoryScopes(home);
  expect(scopes.length).toBe(2);
  expect(scopes[1]).toEqual({ scope: "bot", room: "room1", bot: "bot1", label: "群一 · 助手" });
});
