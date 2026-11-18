// tests/node/test-memory-exchange.test.ts — 对应 tests/test_memory_exchange.py（34 个唯一测试）。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SNAPSHOT_SECTIONS, scrubSecrets, parseMarkdownSections,
  exportSnapshot, importSnapshot, importChatZip,
  readLocalCodex, readLocalClaude, readLocalDir, EXPORT_PROMPT,
  SnapshotError, LocalMemoryNotFound, ChatZipError,
} from "../../src/memoryExchange.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "nyra-memx-"));
}

test("MemoryExchangeTest.test_snapshot_sections", () => {
  expect([...SNAPSHOT_SECTIONS]).toEqual(["身份", "事实", "偏好", "目标与承诺", "关系"]);
});

test("MemoryExchangeTest.test_scrub_secrets_patterns", () => {
  const [cleaned, removed] = scrubSecrets("api_key: sk-abcdefgh12345678\n正常行\npassword: hunter2\n");
  expect(removed).toBe(2);
  expect(cleaned).toContain("正常行");
  expect(cleaned).not.toContain("sk-abcdefgh12345678");
  expect(cleaned).not.toContain("hunter2");
  const [c2, r2] = scrubSecrets("Bearer abcdefghijklmnop\n正常\n");
  expect(r2).toBe(1);
  expect(c2).toContain("正常");
});

test("MemoryExchangeTest.test_scrub_keeps_benign_lines", () => {
  const [cleaned, removed] = scrubSecrets("今天天气不错\n- 喜欢机器人\n");
  expect(removed).toBe(0);
  expect(cleaned).toContain("喜欢机器人");
});

test("MemoryExchangeTest.test_parse_markdown_sections", () => {
  const text = "# 记忆快照\n\n## 身份\n- 我是学生\n\n## 事实\n- 在铜陵上学\n\n## 偏好\n- 喜欢直接说事\n\n## 目标与承诺\n- 完成迁移\n\n## 关系\n- 老师梅小龙\n";
  const sections = parseMarkdownSections(text);
  expect(sections["身份"]).toContain("我是学生");
  expect(sections["事实"]).toContain("在铜陵上学");
  expect(sections["偏好"]).toContain("喜欢直接说事");
  expect(sections["目标与承诺"]).toContain("完成迁移");
  expect(sections["关系"]).toContain("老师梅小龙");
});

test("MemoryExchangeTest.test_parse_english_aliases", () => {
  const text = "## Identity\n- I am a student\n\n## Facts\n- Studying robotics\n";
  const sections = parseMarkdownSections(text);
  expect(sections["身份"]).toContain("I am a student");
  expect(sections["事实"]).toContain("Studying robotics");
});

test("MemoryExchangeTest.test_parse_drops_placeholders", () => {
  const text = "## 事实\n- 待补充\n- 真实的一条\n";
  const sections = parseMarkdownSections(text);
  expect(sections["事实"] ?? []).not.toContain("待补充");
  expect(sections["事实"]).toContain("真实的一条");
});

test("MemoryExchangeTest.test_export_import_roundtrip", () => {
  const h = home();
  const memPath = join(h, "MEMORY.md");
  writeFileSync(memPath, "## 事实\n- 在铜陵上学\n");
  const snapshot = exportSnapshot(memPath);
  expect(snapshot).toContain("在铜陵上学");
  const h2 = home();
  const memPath2 = join(h2, "MEMORY.md");
  const result = importSnapshot(snapshot, memPath2);
  expect(result.added).toBeGreaterThanOrEqual(1);
  expect(readFileSync(memPath2, "utf-8")).toContain("在铜陵上学");
});

test("MemoryExchangeTest.test_import_is_append_only_no_overwrite", () => {
  const h = home();
  const memPath = join(h, "MEMORY.md");
  writeFileSync(memPath, "## 事实\n- 已有的一条\n");
  const result = importSnapshot("## 事实\n- 新的一条\n", memPath);
  expect(result.added).toBe(1);
  const content = readFileSync(memPath, "utf-8");
  expect(content).toContain("已有的一条");
  expect(content).toContain("新的一条");
});

test("MemoryExchangeTest.test_import_dedup_case_insensitive_substring", () => {
  const h = home();
  const memPath = join(h, "MEMORY.md");
  writeFileSync(memPath, "## 事实\n- 在铜陵上学\n");
  const result = importSnapshot("## 事实\n- 在铜陵上学\n", memPath);
  expect(result.added).toBe(0);
  expect(result.skipped).toBe(1);
});

test("MemoryExchangeTest.test_import_scrubs_secrets", () => {
  const h = home();
  const memPath = join(h, "MEMORY.md");
  const result = importSnapshot("## 事实\n- api_key: sk-abcdefgh12345678\n- 正常的一条\n", memPath);
  expect(result.removed).toBe(1);
  expect(readFileSync(memPath, "utf-8")).not.toContain("sk-abcdefgh12345678");
  expect(readFileSync(memPath, "utf-8")).toContain("正常的一条");
});

test("MemoryExchangeTest.test_export_missing_memory_throws", () => {
  const h = home();
  expect(() => exportSnapshot(join(h, "MEMORY.md"))).toThrow(SnapshotError);
});

test("MemoryExchangeTest.test_export_prompt_content", () => {
  expect(EXPORT_PROMPT).toContain("便携式记忆快照");
  for (const section of SNAPSHOT_SECTIONS) expect(EXPORT_PROMPT).toContain(section);
  expect(EXPORT_PROMPT).toContain("不要编造");
});

test("MemoryExchangeTest.test_read_local_codex_missing", () => {
  const h = home();
  expect(() => readLocalCodex(h)).toThrow(LocalMemoryNotFound);
});

test("MemoryExchangeTest.test_read_local_codex_empty_db_not_found", () => {
  // 本机真实 Codex 库只有 stage1_outputs（0 行）、没有 memories 表：
  // 应报 LocalMemoryNotFound，而不是原始 sqlite 错误。
  expect(() => readLocalCodex()).toThrow(LocalMemoryNotFound);
});

test("MemoryExchangeTest.test_read_local_claude_missing", () => {
  const h = home();
  expect(() => readLocalClaude(h)).toThrow(LocalMemoryNotFound);
});

test("MemoryExchangeTest.test_read_local_dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-memx-dir-"));
  writeFileSync(join(dir, "MEMORY.md"), "## 事实\n- 目录里的记忆\n");
  const out = readLocalDir(dir);
  expect(out).toContain("目录里的记忆");
  expect(() => readLocalDir(join(dir, "nope"))).toThrow(LocalMemoryNotFound);
});

test("MemoryExchangeTest.test_import_chat_zip_minimal", () => {
  // 最小 ZIP：stored 方式存一个 conversations.json。
  const h = home();
  const payload = JSON.stringify([{ title: "t", messages: [{ role: "user", content: "hi" }] }]);
  const name = "conversations.json";
  const data = Buffer.from(payload, "utf-8");
  const crc = crc32(data);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(data.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(name.length, 26);
  localHeader.writeUInt16LE(0, 28);
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(data.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralHeader.length, 12);
  endRecord.writeUInt32LE(localHeader.length + name.length + data.length, 16);
  endRecord.writeUInt16LE(0, 20);
  const zip = Buffer.concat([localHeader, Buffer.from(name), data, centralHeader, Buffer.from(name), endRecord]);
  const zipPath = join(h, "chat.zip");
  writeFileSync(zipPath, zip);
  const result = importChatZip(zipPath, h);
  expect(result.conversations).toBe(1);
  expect(existsSync(result.archived)).toBe(true);
  // MEMORY.md 只记一行导入记录，不自动提炼事实。
  const memory = readFileSync(join(h, "MEMORY.md"), "utf-8");
  expect(memory).toContain("从聊天导出导入 1 条对话");
  expect(memory).toContain("memory-imports");
  expect(memory).not.toContain("hi");
});

test("MemoryExchangeTest.test_import_chat_zip_invalid_throws", () => {
  const h = home();
  const bad = join(h, "bad.zip");
  writeFileSync(bad, "not a zip");
  expect(() => importChatZip(bad, h)).toThrow(ChatZipError);
});

function crc32(buf: Buffer): number {
  let table: number[] | null = null;
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = (table as number[])[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
