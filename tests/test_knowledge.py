"""Tests for nyra.knowledge: local AI knowledge base.

All offline: no real provider calls, no network (urlopen is mocked).
"""

import io
import json
import os
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from nyra.knowledge import KnowledgeBase, KnowledgeError, main


class KnowledgeBaseTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = KnowledgeBase(Path(self._tmp.name))

    def test_create_list_duplicate_illegal_name(self):
        meta = self.store.create("creator", "博主内容库")
        self.assertEqual(meta["name"], "creator")
        self.assertEqual(meta["description"], "博主内容库")
        bases = self.store.list_bases()
        self.assertEqual(len(bases), 1)
        self.assertEqual(bases[0]["name"], "creator")
        self.assertEqual(bases[0]["notes"], 0)
        with self.assertRaises(KnowledgeError):
            self.store.create("creator")
        for bad in ("", "a b", "a/b", "中文名", "a:b"):
            with self.assertRaises(KnowledgeError, msg=bad):
                self.store.create(bad)

    def test_add_text_short_and_chunking(self):
        self.store.create("kb")
        notes = self.store.add_text(
            "kb", "这是一段短内容。", "短文", "手动输入"
        )
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["title"], "短文")
        self.assertEqual(notes[0]["source"], "手动输入")
        self.assertTrue(notes[0]["text"].startswith("这是一段短内容"))

        long_para = "工业机器人调试。" * 400  # 约 3200 字，无标题、无空行
        text = "# 调试手册\n\n" + long_para
        notes = self.store.add_text("kb", text, "手册", "手动输入")
        self.assertGreaterEqual(len(notes), 2)
        for note in notes:
            self.assertLessEqual(len(note["text"]), 1500)
            self.assertTrue(note["title"].startswith("调试手册"))
            self.assertEqual(note["source"], "手动输入")
        joined = "".join(n["text"] for n in notes)
        self.assertIn("工业机器人调试", joined)

    def test_add_text_empty_and_date(self):
        self.store.create("kb")
        with self.assertRaises(KnowledgeError):
            self.store.add_text("kb", "   ", "空", "手动输入")
        notes = self.store.add_text(
            "kb", "有内容", "标题", "手动输入", date="2026-11-18"
        )
        self.assertEqual(notes[0]["date"], "2026-11-18")
        with self.assertRaises(KnowledgeError):
            self.store.add_text("kb", "有内容", "标题", "手动输入", date="18/11/2026")

    def test_add_file_and_dir(self):
        self.store.create("kb")
        root = Path(self._tmp.name) / "docs"
        (root / "sub").mkdir(parents=True)
        (root / "a.md").write_text(
            "# 机器人\n\n工业机器人由机械臂与控制器组成。\n", encoding="utf-8"
        )
        (root / "sub" / "b.txt").write_text(
            "猫咪每天需要新鲜的水。\n", encoding="utf-8"
        )
        (root / "skip.bin").write_bytes(b"\x00\x01")
        notes = self.store.add_dir("kb", root)
        self.assertEqual(len(notes), 2)
        titles = [n["title"] for n in notes]
        self.assertIn("机器人", titles)
        self.assertIn("b.txt", titles)
        sources = [n["source"] for n in notes]
        self.assertTrue(any(str(root / "a.md") in s for s in sources))
        self.assertTrue(any(str(root / "sub" / "b.txt") in s for s in sources))
        with self.assertRaises(KnowledgeError):
            self.store.add_file("kb", root / "skip.bin")
        with self.assertRaises(KnowledgeError):
            self.store.add_file("kb", root / "nope.md")

    def test_search_ranking_and_empty(self):
        self.store.create("kb")
        self.assertEqual(self.store.search("kb", "机器人"), [])
        self.store.add_text(
            "kb",
            "工业机器人调试：先检查电源，再校准零点，最后跑空载程序。",
            "机器人调试",
            "手动输入",
        )
        self.store.add_text(
            "kb", "猫咪养护：每天换水，定期梳毛，喂食定时定量。", "养猫", "手动输入"
        )
        self.store.add_text(
            "kb", "机器人保养：定期检查机械臂润滑。", "机器人保养", "手动输入"
        )
        results = self.store.search("kb", "工业机器人调试方法")
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0][1]["title"], "机器人调试")
        self.assertEqual(results[1][1]["title"], "机器人保养")
        self.assertGreater(results[0][0], results[1][0])
        results = self.store.search("kb", "猫咪喂食")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][1]["title"], "养猫")
        self.assertEqual(self.store.search("kb", ""), [])
        self.assertEqual(self.store.search("kb", "   "), [])

    def test_ask_uses_retrieved_notes(self):
        self.store.create("kb")
        self.store.add_text(
            "kb",
            "工业机器人调试：先检查电源，再校准零点，最后跑空载程序。",
            "机器人调试",
            "手动输入",
        )
        self.store.add_text(
            "kb", "猫咪养护：每天换水，定期梳毛。", "养猫", "手动输入"
        )
        seen = {}

        def fake_chat(messages):
            seen["messages"] = messages
            return "按调试笔记：先查电源、校零点、跑空载。"

        answer, used = self.store.ask("kb", "机器人怎么调试？", chat_fn=fake_chat)
        self.assertIn("校零点", answer)
        self.assertEqual([n["title"] for n in used], ["机器人调试"])
        user_msg = seen["messages"][1]["content"]
        self.assertIn("工业机器人调试", user_msg)
        self.assertIn("先检查电源", user_msg)
        self.assertIn("机器人调试", user_msg)
        system_msg = seen["messages"][0]["content"]
        self.assertIn("不知道", system_msg)

    def test_ask_no_relevant_notes(self):
        self.store.create("kb")
        self.store.add_text("kb", "猫咪养护：每天换水。", "养猫", "手动输入")
        seen = {}

        def fake_chat(messages):
            seen["messages"] = messages
            return "不知道，库里没有相关内容。"

        answer, used = self.store.ask("kb", "量子计算机原理？", chat_fn=fake_chat)
        self.assertEqual(used, [])
        user_msg = seen["messages"][1]["content"]
        self.assertIn("库内没有与该问题相关的笔记", user_msg)

    def test_add_url_extracts_text(self):
        self.store.create("kb")
        page_html = """<html><head><title>博主：机器人日常</title>
        <meta name="description" content="分享工业机器人调试日常。">
        <style>.x{color:red}</style>
        <script>var secret = 1;</script></head>
        <body><h1>第一期</h1><p>今天讲零点校准的方法。</p></body></html>"""

        class FakeResponse:
            headers = {"Content-Type": "text/html; charset=utf-8"}

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return page_html.encode("utf-8")

        with patch(
            "nyra.knowledge.urllib.request.urlopen",
            return_value=FakeResponse(),
        ):
            notes = self.store.add_url("kb", "https://example.com/video/1")
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["title"], "博主：机器人日常")
        self.assertEqual(notes[0]["source"], "https://example.com/video/1")
        self.assertIn("零点校准", notes[0]["text"])
        self.assertNotIn("secret", notes[0]["text"])
        self.assertNotIn("color:red", notes[0]["text"])

    def test_add_url_failure(self):
        self.store.create("kb")
        with patch(
            "nyra.knowledge.urllib.request.urlopen",
            side_effect=urllib.error.URLError("no route"),
        ):
            with self.assertRaises(KnowledgeError):
                self.store.add_url("kb", "https://example.com/x")

        class FakeResponse:
            headers = {"Content-Type": "application/pdf"}

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b"%PDF-1.4"

        with patch(
            "nyra.knowledge.urllib.request.urlopen",
            return_value=FakeResponse(),
        ):
            with self.assertRaises(KnowledgeError):
                self.store.add_url("kb", "https://example.com/f.pdf")

    def test_notes_persisted_as_jsonl(self):
        self.store.create("kb")
        self.store.add_text("kb", "持久化检查", "检查", "手动输入")
        notes_path = Path(self._tmp.name) / "kb" / "notes.jsonl"
        lines = notes_path.read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), 1)
        note = json.loads(lines[0])
        self.assertEqual(note["text"], "持久化检查")
        reopened = KnowledgeBase(Path(self._tmp.name))
        self.assertEqual(len(reopened.search("kb", "持久化检查")), 1)


class KnowledgeCliTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def _run(self, argv, chat_fn=None):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = main(argv, base=self.base, chat_fn=chat_fn)
        return code, buf.getvalue()

    def test_cli_create_add_search_ask(self):
        code, out = self._run(["create", "creator", "--description", "博主库"])
        self.assertEqual(code, 0)
        self.assertIn("creator", out)

        code, out = self._run(
            ["add", "creator", "--text", "工业机器人调试先查电源再校零点。",
             "--title", "调试"],
        )
        self.assertEqual(code, 0)
        self.assertIn("1 条笔记", out)

        code, out = self._run(["search", "creator", "机器人调试"])
        self.assertEqual(code, 0)
        self.assertIn("调试", out)

        code, out = self._run(
            ["ask", "creator", "怎么调试机器人？"],
            chat_fn=lambda messages: "先查电源，再校零点。",
        )
        self.assertEqual(code, 0)
        self.assertIn("先查电源", out)
        self.assertIn("调试", out)

        code, out = self._run(["list"])
        self.assertEqual(code, 0)
        self.assertIn("creator", out)
        self.assertIn("1 条笔记", out)

    def test_cli_remove_needs_confirmation(self):
        self._run(["create", "tmp"])
        with patch("builtins.input", return_value="no"):
            code, out = self._run(["remove", "tmp"])
        self.assertEqual(code, 1)
        self.assertTrue(KnowledgeBase(self.base).exists("tmp"))
        with patch("builtins.input", return_value="yes"):
            code, out = self._run(["remove", "tmp"])
        self.assertEqual(code, 0)
        self.assertFalse(KnowledgeBase(self.base).exists("tmp"))

        self._run(["create", "tmp2"])
        code, out = self._run(["remove", "tmp2", "--yes"])
        self.assertEqual(code, 0)
        self.assertFalse(KnowledgeBase(self.base).exists("tmp2"))

    def test_cli_errors(self):
        code, out = self._run(["search", "nope", "x"])
        self.assertEqual(code, 1)
        code, out = self._run(["create", "bad/name"])
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
