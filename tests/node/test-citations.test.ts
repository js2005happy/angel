// tests/node/test-citations.test.ts — 方案 2.6 第 1 条：引用台账专项。
import { test, expect } from "bun:test";
import { CitationLedger } from "../../src/citations.ts";

test("CitationsTest.test_register_reuses_number_for_same_url", () => {
  const ledger = new CitationLedger();
  const a = ledger.register("https://example.com/a", "原文一", "标题 A");
  const b = ledger.register("https://example.com/b", "原文二");
  const a2 = ledger.register("https://example.com/a", "原文一改了");
  expect(a).toBe(1);
  expect(b).toBe(2);
  expect(a2).toBe(1);
  expect(ledger.get(1)?.title).toBe("标题 A");
  expect(ledger.list().length).toBe(2);
});

test("CitationsTest.test_verify_requires_registered_source", () => {
  const ledger = new CitationLedger();
  ledger.register("https://example.com/a", "关键数据是 42");
  const ok = ledger.verify("结论是 42 [1]", "证据文本：关键数据是 42。");
  expect(ok.ok).toBe(true);
  const missing = ledger.verify("结论 [2]", "证据文本");
  expect(missing.ok).toBe(false);
  expect(missing.problems[0]).toContain("[2]");
});

test("CitationsTest.test_verify_requires_verbatim_quote_in_evidence", () => {
  const ledger = new CitationLedger();
  ledger.register("https://example.com/a", "关键数据是 42");
  const bad = ledger.verify("结论是 42 [1]", "证据文本里没有那句话。");
  expect(bad.ok).toBe(false);
  expect(bad.problems[0]).toContain("逐字引用");
});

test("CitationsTest.test_verify_ignores_unreferenced_sources", () => {
  const ledger = new CitationLedger();
  ledger.register("https://example.com/a", "甲");
  ledger.register("https://example.com/b", "乙");
  const ok = ledger.verify("只引用 [1]", "甲");
  expect(ok.ok).toBe(true);
});

test("CitationsTest.test_mark_unverified", () => {
  expect(CitationLedger.markUnverified("据记忆，用户喜欢猫")).toBe("据记忆，用户喜欢猫 [unverified]");
});

test("CitationsTest.test_render_bibliography", () => {
  const ledger = new CitationLedger();
  ledger.register("https://example.com/a", "甲", "标题 A");
  ledger.register("https://example.com/b", "乙");
  const bib = ledger.renderBibliography();
  expect(bib).toContain("[1] 标题 A — https://example.com/a");
  expect(bib).toContain("[2] https://example.com/b");
});

test("CitationsTest.test_verify_no_refs_is_ok", () => {
  const ledger = new CitationLedger();
  expect(ledger.verify("没有引用的草稿", "证据").ok).toBe(true);
});
