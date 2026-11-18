"""Tests for the Artifacts store and detection (nyra/artifacts.py) and the
artifacts panel in the embedded web UI (nyra/webui_page.py).

Standard library only; no network, no paid-model calls. The artifact
store is exercised against a temporary NYRA_HOME by patching
nyra.config.NYRA_HOME, which artifacts.py reads dynamically.
"""

import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from nyra import artifacts
from nyra.artifacts import (
    MAX_CONTENT_BYTES,
    MAX_PER_SESSION,
    create_artifact,
    detect_artifacts,
    get_artifact,
    list_artifacts,
    markdown_to_html,
)
from nyra.webui_page import PAGE_HTML

SID = "20261118-120000-ab12"


class StoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self._patch = mock.patch("nyra.config.NYRA_HOME", self.home)
        self._patch.start()
        self.addCleanup(self._patch.stop)
        self.addCleanup(self._tmp.cleanup)

    def test_create_get_list_round_trip(self):
        rec = create_artifact(SID, "Hello", "markdown", "# Hi\n\ntext", lang="md")
        self.assertEqual(rec["session_id"], SID)
        self.assertEqual(rec["title"], "Hello")
        self.assertEqual(rec["kind"], "markdown")
        self.assertEqual(rec["content"], "# Hi\n\ntext")
        self.assertFalse(rec["truncated"])
        self.assertTrue(rec["created_at"])
        # Stored as JSON under ~/.nyra/artifacts/<session_id>/.
        path = self.home / "artifacts" / SID / f"{rec['id']}.json"
        self.assertTrue(path.is_file())
        with path.open(encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["title"], "Hello")
        self.assertEqual(get_artifact(rec["id"]), rec)
        items = list_artifacts(SID)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], rec["id"])
        self.assertEqual(items[0]["title"], "Hello")
        self.assertNotIn("content", items[0])  # list is metadata only

    def test_unknown_and_empty(self):
        self.assertIsNone(get_artifact("0123456789ab"))
        self.assertIsNone(get_artifact("not-an-id"))
        self.assertIsNone(get_artifact("../etc/passwd"))
        self.assertEqual(list_artifacts(SID), [])

    def test_invalid_session_and_kind(self):
        for bad in ("", "../evil", "a/b", "a b", "x" * 81):
            with self.assertRaises(ValueError, msg=bad):
                create_artifact(bad, "t", "code", "x")
        with self.assertRaises(ValueError):
            create_artifact(SID, "t", "pdf", "x")
        with self.assertRaises(ValueError):
            create_artifact(SID, "t", "code", 123)

    def test_per_session_cap_drops_oldest(self):
        ids = [
            create_artifact(SID, f"n{i}", "code", f"code {i}")["id"]
            for i in range(MAX_PER_SESSION + 2)
        ]
        items = list_artifacts(SID)
        self.assertEqual(len(items), MAX_PER_SESSION)
        kept = {item["id"] for item in items}
        self.assertNotIn(ids[0], kept)
        self.assertNotIn(ids[1], kept)
        self.assertIn(ids[-1], kept)
        self.assertIsNone(get_artifact(ids[0]))
        # Other sessions are untouched.
        other = create_artifact("20261118-130000-cd34", "o", "code", "x")
        self.assertEqual(len(list_artifacts("20261118-130000-cd34")), 1)
        self.assertIsNotNone(get_artifact(other["id"]))

    def test_one_mb_content_cap(self):
        big = "x" * (2 * MAX_CONTENT_BYTES)
        rec = create_artifact(SID, "big", "code", big)
        self.assertTrue(rec["truncated"])
        self.assertEqual(len(rec["content"].encode("utf-8")), MAX_CONTENT_BYTES)
        self.assertEqual(get_artifact(rec["id"])["content"], rec["content"])

    def test_title_defaults_and_trims(self):
        rec = create_artifact(SID, "   ", "code", "x")
        self.assertEqual(rec["title"], "未命名产物")
        self.assertEqual(create_artifact(SID, "  t  ", "code", "x")["title"], "t")


class DetectTests(unittest.TestCase):
    def test_fenced_code_block(self):
        text = "先看这段代码：\n```python\nprint('hi')\n```\n再看结论。"
        remaining, found = detect_artifacts(text)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["kind"], "code")
        self.assertEqual(found[0]["lang"], "python")
        self.assertEqual(found[0]["title"], "python 代码")
        self.assertEqual(found[0]["content"], "print('hi')\n")
        self.assertIn("[产物：python 代码]", remaining)
        self.assertIn("先看这段代码：", remaining)
        self.assertIn("再看结论。", remaining)
        self.assertNotIn("print('hi')", remaining)

    def test_html_fence_and_bare_html_block(self):
        text = (
            "```html\n<div><p>hi</p></div>\n```\n"
            "中间文字\n"
            "<section>\n<p>裸 HTML</p>\n</section>\n尾巴"
        )
        _, found = detect_artifacts(text)
        self.assertEqual(len(found), 2)
        self.assertEqual([a["kind"] for a in found], ["html", "html"])
        self.assertEqual(found[0]["content"], "<div><p>hi</p></div>\n")
        self.assertIn("<section>", found[1]["content"])
        self.assertIn("裸 HTML", found[1]["content"])

    def test_no_blocks_and_unterminated_fence(self):
        text = "普通文本 a < b，没有代码块。\n```python\nprint(1)\n"
        remaining, found = detect_artifacts(text)
        self.assertEqual(found, [])
        self.assertEqual(remaining, text)
        self.assertEqual(detect_artifacts(""), ("", []))
        self.assertEqual(detect_artifacts("plain text")[1], [])

    def test_html_without_closing_tag_stays(self):
        text = "<div>\n<p>没闭合\n\n继续正文"
        remaining, found = detect_artifacts(text)
        self.assertEqual(found, [])
        self.assertEqual(remaining, text)

    def test_multiple_blocks_and_text_preserved(self):
        text = (
            "开头\n```js\nconst a = 1;\n```\n中间\n"
            "```\nplain\n```\n结尾\n<div>\n<span>x</span>\n</div>"
        )
        remaining, found = detect_artifacts(text)
        self.assertEqual(len(found), 3)
        self.assertEqual([a["kind"] for a in found], ["code", "code", "html"])
        self.assertEqual(found[0]["title"], "js 代码")
        self.assertEqual(found[1]["title"], "代码片段")
        # No text is lost: every artifact's content is an exact
        # substring of the original, and the prose survives.
        for art in found:
            self.assertIn(art["content"], text)
        for prose in ("开头", "中间", "结尾"):
            self.assertIn(prose, remaining)
        self.assertEqual(remaining.count("[产物："), 3)


class MarkdownTests(unittest.TestCase):
    def test_headings_bold_italic_code(self):
        out = markdown_to_html("# 标题\n## 二级\n**粗体** 与 *斜体* 还有 `代码`")
        self.assertIn("<h3>标题</h3>", out)
        self.assertIn("<h3>二级</h3>", out)
        self.assertIn("<strong>粗体</strong>", out)
        self.assertIn("<em>斜体</em>", out)
        self.assertIn("<code>代码</code>", out)

    def test_fenced_code_block_and_lists(self):
        out = markdown_to_html("```python\nprint(1)\n```\n- 苹果\n- 香蕉\n1. 第一步\n2. 第二步")
        self.assertIn("<pre><code>print(1)\n</code></pre>", out)
        self.assertIn("<ul>", out)
        self.assertIn("<li>苹果</li>", out)
        self.assertIn("<ol>", out)
        self.assertIn("<li>第一步</li>", out)

    def test_links_and_bare_urls(self):
        out = markdown_to_html("看 [Nyra](https://example.com) 和 https://example.org/x")
        self.assertIn(
            '<a href="https://example.com" target="_blank" rel="noopener noreferrer">Nyra</a>',
            out,
        )
        self.assertIn('href="https://example.org/x"', out)

    def test_html_is_escaped_never_executed(self):
        out = markdown_to_html("<script>alert(1)</script>\n\n**x** <img src=x onerror=alert(2)>")
        self.assertNotIn("<script>", out)
        self.assertNotIn("<img", out)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", out)
        self.assertIn("&lt;img", out)
        self.assertIn("<strong>x</strong>", out)

    def test_javascript_links_are_not_linked(self):
        out = markdown_to_html("[点我](javascript:alert(1))")
        self.assertNotIn('href="javascript', out)
        self.assertNotIn("<a ", out)


def _artifact_js_block() -> str:
    """The artifacts panel JS inside PAGE_HTML (between its banner comment
    and the next unrelated function)."""
    start = PAGE_HTML.index("/* --- Artifacts panel ---")
    end = PAGE_HTML.index("function setBusy(b)", start)
    return PAGE_HTML[start:end]


class PagePanelTests(unittest.TestCase):
    def test_panel_markup_present(self):
        for token in (
            'id="tab-artifacts"',
            'id="pane-artifacts"',
            'id="artifact-list"',
            'id="artifact-view"',
            'id="artifact-body"',
            'id="artifact-title"',
            'id="artifact-note"',
        ):
            self.assertIn(token, PAGE_HTML)

    def test_artifact_code_paths_never_use_inner_html(self):
        block = _artifact_js_block()
        # Comments mention innerHTML by name (saying it is forbidden);
        # strip them and check the code itself never uses it.
        code = re.sub(r"/\*[\s\S]*?\*/", "", block)
        self.assertNotIn("innerHTML", code)

    def test_sandboxed_iframe_and_dom_rendering(self):
        block = _artifact_js_block()
        self.assertIn('createElement("iframe")', block)
        self.assertIn('"sandbox","allow-scripts"', block)
        self.assertIn('"srcdoc"', block)
        self.assertIn("textContent", block)
        self.assertIn("createElement(\"pre\")", block)
        self.assertIn("mdArtifact", block)
        self.assertIn("scanArtifacts", block)
        self.assertIn("renderArtifactList", block)

    def test_markdown_renderer_is_dom_only_and_escapes(self):
        block = _artifact_js_block()
        self.assertIn("function mdArtifact", block)
        self.assertIn("function mdText", block)
        self.assertIn("function mdBlocks", block)
        # Headings, bold/italic, code, lists, links all handled.
        for fragment in ('"h3"', '"strong"', '"em"', '"code"', '"ul"', '"ol"', '"a"'):
            self.assertIn(fragment, block)
        # Links are http(s)-only with rel noopener.
        self.assertIn('https?:\\/\\/', block)
        self.assertIn('"noopener noreferrer"', block)

    def test_panel_hooks_into_existing_polling(self):
        # Artifacts are scanned from the already-polled session_view data:
        # full transcripts and live assistant events.
        self.assertIn("scanArtifacts(m.content)", PAGE_HTML)
        self.assertIn("scanArtifacts(d.content)", PAGE_HTML)
        self.assertIn("resetArtifacts(sid)", PAGE_HTML)


if __name__ == "__main__":
    unittest.main()
