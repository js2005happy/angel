"""会话压缩：尾部必须按轮次对齐，会话文件必须原子替换。"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from nyra.compact import (
    build_compact_messages, compact_messages, compact_session_file,
)


def user(content):
    return {"role": "user", "content": content}


def assistant(content="", calls=None):
    message = {"role": "assistant", "content": content}
    if calls is not None:
        message["tool_calls"] = calls
    return message


def call(cid, name="read_file"):
    return {"id": cid, "type": "function",
            "function": {"name": name, "arguments": "{}"}}


def tool_result(cid, content="ok"):
    return {"role": "tool", "tool_call_id": cid, "content": content}


class FakeProvider:
    def __init__(self, summary="摘要要点"):
        self.summary = summary

    def chat(self, messages, tools=None, timeout=120):
        return {"choices": [{"message": {"role": "assistant",
                                         "content": self.summary}}]}


class AlignedTailTests(unittest.TestCase):
    def test_tail_starting_at_tool_message_keeps_its_call(self):
        messages = [
            user("a"), assistant("b"),
            user("c"), assistant("", calls=[call("c1")]),
            tool_result("c1"), assistant("done"),
        ]
        # keep_last=2 会正好切在 tool 消息上：必须把发调用的 assistant 补回来。
        reduced, _ = compact_messages(FakeProvider(), messages, keep_last=2)
        kept = reduced[2:]
        self.assertEqual(kept[0]["role"], "assistant")
        self.assertEqual(kept[0].get("tool_calls"), [call("c1")])
        self.assertEqual(kept[1], tool_result("c1"))

    def test_tail_starting_at_tool_without_call_drops_orphan(self):
        messages = [user("a"), tool_result("c1"), assistant("done")]
        reduced, _ = compact_messages(FakeProvider(), messages, keep_last=2)
        kept = reduced[2:]
        self.assertNotEqual(kept[0].get("role"), "tool")

    def test_trailing_incomplete_tool_exchange_is_dropped(self):
        messages = [
            user("a"), assistant("b"),
            user("c"), assistant("", calls=[call("c1"), call("c2")]),
            tool_result("c1"),  # c2 的结果缺失：本轮未完成
        ]
        reduced, _ = compact_messages(FakeProvider(), messages, keep_last=3)
        kept = reduced[2:]
        for message in kept:
            self.assertNotEqual(message.get("tool_calls"), [call("c1"), call("c2")])
        self.assertNotIn("c2", json.dumps(kept, ensure_ascii=False))

    def test_complete_exchange_is_kept_whole(self):
        messages = [
            user("a"), assistant("", calls=[call("c1")]),
            tool_result("c1"), assistant("done"),
        ]
        reduced, _ = compact_messages(FakeProvider(), messages, keep_last=3)
        kept = reduced[2:]
        self.assertEqual(
            kept,
            [assistant("", calls=[call("c1")]), tool_result("c1"), assistant("done")],
        )

    def test_fallback_tail_is_aligned_too(self):
        class Failing:
            def chat(self, messages, tools=None, timeout=120):
                raise RuntimeError("no model")

        messages = [
            user("first"), assistant("b"),
            user("c"), assistant("", calls=[call("c1")]),
            tool_result("c1"), assistant("done"),
        ]
        reduced, info = compact_messages(Failing(), messages, keep_last=2)
        self.assertEqual(info["method"], "fallback")
        roles = [m.get("role") for m in reduced]
        self.assertNotIn("tool", roles[:1])  # 不以孤儿 tool 开头
        self.assertIn("first", json.dumps(reduced, ensure_ascii=False))

    def test_build_compact_messages_keeps_summary_first(self):
        messages = [user("a"), assistant("b")]
        out = build_compact_messages(messages, "要点", keep_last=1)
        self.assertTrue(out[0]["content"].startswith("[此前会话摘要]"))
        self.assertEqual(out[-1], assistant("b"))


class CompactSessionFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_session(self, session_id, messages):
        path = self.dir / f"{session_id}.jsonl"
        path.write_text(
            "".join(json.dumps(m, ensure_ascii=False) + "\n" for m in messages),
            encoding="utf-8",
        )
        return path

    def test_compact_rewrites_session(self):
        path = self._write_session("s1", [user("a"), assistant("b")])
        info = compact_session_file("s1", FakeProvider(), sessions_dir=self.dir)
        self.assertEqual(info["method"], "model")
        lines = path.read_text(encoding="utf-8").splitlines()
        self.assertTrue(lines[0].startswith('{"role": "user", "content": "[此前会话摘要]'))
        self.assertEqual(
            [name for name in os.listdir(self.dir)],
            ["s1.jsonl"],  # 无残留临时文件
        )

    def test_failed_replace_keeps_original_session(self):
        # os.replace 失败时原文件必须原样保留（旧 open("w") 实现会先截断）。
        original = [user("a"), assistant("b")]
        path = self._write_session("s1", original)
        before = path.read_bytes()
        with mock.patch("os.replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                compact_session_file("s1", FakeProvider(), sessions_dir=self.dir)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(
            [name for name in os.listdir(self.dir)], ["s1.jsonl"],
        )

    def test_missing_session_raises(self):
        with self.assertRaises(FileNotFoundError):
            compact_session_file("nope", FakeProvider(), sessions_dir=self.dir)


if __name__ == "__main__":
    unittest.main()
