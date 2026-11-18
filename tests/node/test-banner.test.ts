// tests/node/test-banner.test.ts — 对应 tests/test_banner.py（10 个唯一测试）。
import { test, expect } from "bun:test";
import { WORDMARK, wordmarkLines, renderBanner } from "../../src/banner.ts";

test("BannerTest.test_wordmark_is_11_rows_42_cols", () => {
  expect(WORDMARK.length).toBe(11);
  for (const line of WORDMARK) {
    expect(line.length).toBeLessThanOrEqual(42);
  }
  expect(WORDMARK.join("\n")).toContain("###");
  // 居中后：每行在 60 列字段内，左右留白一致（与 Python 版同语义）。
  const lines = wordmarkLines(false);
  expect(lines.length).toBe(11);
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(60);
  }
  const pads = lines.map((l) => l.length - l.trimStart().length);
  expect(new Set(pads).size).toBe(1);
  expect(lines.map((l) => l.trim())).toEqual(WORDMARK.map((l) => l.trim()));
});

test("BannerTest.test_wordmark_colored_has_ansi", () => {
  const colored = wordmarkLines(true);
  expect(colored.join("\n")).toContain("\x1b[");
  const plain = wordmarkLines(false);
  expect(plain.join("\n")).not.toContain("\x1b[");
  // 同字形：去 ANSI 后一致。
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  expect(colored.map(strip)).toEqual(plain);
});

test("BannerTest.test_banner_contains_version_and_provider", () => {
  const out = renderBanner("0.3.0", "deepseek · deepseek-flash", "auto", "sess-1", false);
  expect(out).toContain("0.3.0");
  expect(out).toContain("deepseek");
  expect(out).toContain("全能 AI 助手");
});

test("BannerTest.test_banner_model_line_below_wordmark", () => {
  const out = renderBanner("0.3.0", "deepseek · deepseek-flash", "auto", "sess-1", false);
  const lines = out.split("\n");
  const wordmarkEnd = lines.findIndex((l) => l.includes("###"));
  expect(wordmarkEnd).toBeGreaterThanOrEqual(0);
  const modelIdx = lines.findIndex((l) => l.includes("deepseek"));
  expect(modelIdx).toBeGreaterThan(wordmarkEnd);
});

test("BannerTest.test_banner_centered_within_60_cols", () => {
  const out = renderBanner("0.3.0", "deepseek · deepseek-flash", "auto", "sess-1", false);
  for (const line of out.split("\n")) {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
    expect(visible.length).toBeLessThanOrEqual(60);
  }
});

test("BannerTest.test_banner_no_color_has_no_ansi", () => {
  const out = renderBanner("0.3.0", "deepseek", "auto", "sess-1", false);
  expect(out).not.toContain("\x1b[");
});

test("BannerTest.test_banner_colored_has_ansi", () => {
  const out = renderBanner("0.3.0", "deepseek", "auto", "sess-1", true);
  expect(out).toContain("\x1b[");
});

test("BannerTest.test_banner_mode_shown", () => {
  const out = renderBanner("0.3.0", "deepseek", "readonly", "sess-1", false);
  expect(out).toContain("readonly");
});

test("BannerTest.test_banner_session_id_shown", () => {
  const out = renderBanner("0.3.0", "deepseek", "auto", "20261118-123456-abcd12", false);
  expect(out).toContain("20261118-123456-abcd12");
});

test("BannerTest.test_banner_runtime_label_is_node", () => {
  const out = renderBanner("0.3.0", "deepseek", "auto", "sess-1", false);
  expect(out).toContain("Node");
  expect(out).not.toContain("Python 标准库");
});
