// tests/node/test-evidence.test.ts — 对应 tests/test_evidence_files.py（3 个唯一测试）。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, MAX_EVIDENCE_CHARS } from "../../src/evidence.ts";

function store(): EvidenceStore {
  return new EvidenceStore(mkdtempSync(join(tmpdir(), "nyra-ev-")), "sess1");
}

test("EvidenceTest.test_save_creates_numbered_file", () => {
  const s = store();
  const path = s.save("fetch", "https://example.com/page", "正文内容");
  expect(path).toContain("001_fetch_");
  expect(path.endsWith(".md")).toBe(true);
  const content = readFileSync(path, "utf-8");
  expect(content).toContain("来源：https://example.com/page");
  expect(content).toContain("类型：fetch");
  expect(content).toContain("正文内容");
});

test("EvidenceTest.test_save_does_not_overwrite", () => {
  const s = store();
  const p1 = s.save("fetch", "https://example.com/a", "一");
  const p2 = s.save("fetch", "https://example.com/a", "二");
  expect(p1).not.toBe(p2);
  expect(p2).toContain("002_");
  expect(readFileSync(p1, "utf-8")).toContain("一");
  expect(readFileSync(p2, "utf-8")).toContain("二");
});

test("EvidenceTest.test_save_with_query_and_truncation", () => {
  const s = store();
  const path = s.save("search", "https://example.com", "x".repeat(MAX_EVIDENCE_CHARS + 5000), "机器人");
  const content = readFileSync(path, "utf-8");
  expect(content).toContain("搜索词：机器人");
  expect(content.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS + 1000);
});

test("EvidenceTest.test_list_and_read", () => {
  const s = store();
  s.save("fetch", "https://example.com/a", "一");
  s.save("search", "https://example.com/b", "二");
  expect(s.list().length).toBe(2);
  const first = s.list()[0].split("/").pop()!;
  expect(s.read(first)).toContain("一");
  expect(s.read("不存在.md")).toBeNull();
});

test("EvidenceTest.test_resume_continues_numbering", () => {
  const base = mkdtempSync(join(tmpdir(), "nyra-ev-"));
  const s1 = new EvidenceStore(base, "sess1");
  s1.save("fetch", "https://example.com/a", "一");
  const s2 = new EvidenceStore(base, "sess1");
  const p2 = s2.save("fetch", "https://example.com/b", "二");
  expect(p2).toContain("002_");
});

test("EvidenceTest.test_max_chars", () => {
  expect(MAX_EVIDENCE_CHARS).toBe(20000);
});
