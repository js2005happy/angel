// tests/node/test-artifacts.test.ts — 产物专项（第 3 阶段）。
// 存储/上限/检测/渲染，与 Python 版 artifacts.py 同语义。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createArtifact, getArtifact, listArtifacts, detectArtifacts, markdownToHtml,
} from "../../src/artifacts.ts";

test("ArtifactsTest.test_create_list_get", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-art-"));
  const rec = createArtifact("20261119-000000-ab12", "示例代码", "code", "print(1)\n", "python", home);
  expect(rec.id).toMatch(/^[0-9a-f]{12}$/);
  expect(rec.truncated).toBe(false);
  const list = listArtifacts("20261119-000000-ab12", home);
  expect(list.length).toBe(1);
  expect(list[0].title).toBe("示例代码");
  expect("content" in list[0]).toBe(false); // 列表只给元数据，不给内容
  expect(getArtifact(rec.id, home)?.content).toBe("print(1)\n");
  expect(getArtifact("000000000000", home)).toBe(null);
  expect(getArtifact("not-an-id", home)).toBe(null);
});

test("ArtifactsTest.test_session_cap_keeps_newest_50", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-art-"));
  for (let i = 0; i < 55; i++) createArtifact("s-cap", `第 ${i} 个`, "code", `x=${i}`, null, home);
  expect(listArtifacts("s-cap", home).length).toBe(50);
});

test("ArtifactsTest.test_detect_fences_and_html_blocks", () => {
  const [remaining, found] = detectArtifacts("先说一句\n```python\nprint(1)\n```\n再说一句\n<div>\n<p>你好</p>\n</div>\n结尾");
  expect(found.length).toBe(2);
  expect(found[0].kind).toBe("code");
  expect(found[0].lang).toBe("python");
  expect(found[0].content).toBe("print(1)\n");
  expect(found[1].kind).toBe("html");
  expect(remaining).toContain("[产物：python 代码]");
  expect(remaining).toContain("[产物：HTML 页面]");
  // 未闭合的围栏不吞掉。
  const [r2, f2] = detectArtifacts("```python\nprint(1)\n");
  expect(f2).toEqual([]);
  expect(r2).toContain("print(1)");
});

test("ArtifactsTest.test_markdown_escapes_html_first", () => {
  const html = markdownToHtml("# 标题\n<script>alert(1)</script>\n**粗体** [链接](https://example.com)");
  expect(html).toContain("<h3>标题</h3>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("<strong>粗体</strong>");
  expect(html).toContain('href="https://example.com"');
});
