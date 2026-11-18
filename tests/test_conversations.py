"""Tests for nyra.conversations: sqlite conversation store with retrieval.

All offline: a temp dir is used as NYRA_HOME, so the real ~/.nyra is
never touched. No model calls, no network.
"""

import os
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path

from nyra.conversations import ConversationStore, _fts5_supported

SECRET_LINE = 'api_key = "sk-abcdefgh12345678"'
FAKE_SECRET = "sk-abcdefgh12345678"


def _seed(store):
    """Three sessions of mixed content; returns the session ids."""
    store.record("s-robot", "user", "工业机器人调试需要校准夹具和示教器")
    store.record("s-robot", "assistant", "先检查夹具定位，再做 TCP 标定")
    store.record("s-robot", "user", "机器人调试时报错 E042 是什么原因")
    store.record("s-python", "user", "Python 编程学习笔记：列表推导式")
    store.record("s-python", "assistant", "列表推导式比循环更简洁")
    store.record("s-weather", "user", "今天天气不错，适合出去散步")
    return ["s-robot", "s-python", "s-weather"]


class ConversationStoreTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = ConversationStore(Path(self._tmp.name))
        self.addCleanup(self.store.close)

    def test_migration_creates_tables_and_version(self):
        self.assertEqual(self.store.schema_version, 1)
        rows = self.store._conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')"
        ).fetchall()
        names = {r[0] for r in rows}
        self.assertIn("messages", names)
        self.assertIn("meta", names)
        self.assertIn("idx_messages_session", names)
        if self.store.fts5_available:
            self.assertIn("messages_fts", names)

    def test_fts5_flag_matches_probe(self):
        self.assertIsInstance(self.store.fts5_available, bool)
        self.assertEqual(self.store.fts5_available, _fts5_supported())

    # Windows 文件系统没有 POSIX 权限位：os.chmod(0o600) 在 NTFS 上只影响
    # 只读标志，stat 看到的 mode 仍是 0o666；与 test_vault.py 的 0600
    # 测试同例跳过。
    @unittest.skipIf(sys.platform == "win32", "POSIX permission bits do not exist on Windows")
    def test_db_file_is_0600(self):
        mode = stat.S_IMODE(os.stat(self.store.db_path).st_mode)
        self.assertEqual(mode, 0o600)

    def test_record_history_roundtrip(self):
        _seed(self.store)
        history = self.store.history("s-robot")
        self.assertEqual(len(history), 3)
        self.assertEqual([m["role"] for m in history],
                         ["user", "assistant", "user"])
        self.assertIn("夹具", history[0]["text"])
        self.assertIn("TCP", history[1]["text"])
        self.assertEqual(history[0]["session_id"], "s-robot")
        # limit keeps the most recent messages, still chronological.
        self.assertEqual(len(self.store.history("s-robot", limit=2)), 2)
        self.assertEqual(self.store.history("s-robot", limit=2)[-1]["role"], "user")
        self.assertEqual(self.store.history("no-such-session"), [])

    def test_record_tool_name(self):
        row_id = self.store.record(
            "s-tools", "tool", "读取文件成功", tool_name="read_file"
        )
        self.assertIsInstance(row_id, int)
        history = self.store.history("s-tools")
        self.assertEqual(history[0]["tool_name"], "read_file")
        self.assertEqual(history[0]["role"], "tool")

    def test_record_validation(self):
        for bad in (
            ("", "user", "hi"),
            ("s", "", "hi"),
            ("s", "user", ""),
            ("s", "user", "   "),
            ("s", "narrator", "hi"),
        ):
            with self.assertRaises(ValueError, msg=str(bad)):
                self.store.record(*bad)

    def test_sessions(self):
        _seed(self.store)
        sessions = self.store.sessions()
        self.assertEqual(len(sessions), 3)
        by_id = {s["session_id"]: s for s in sessions}
        self.assertEqual(by_id["s-robot"]["count"], 3)
        self.assertEqual(by_id["s-python"]["count"], 2)
        self.assertEqual(by_id["s-weather"]["count"], 1)
        # Newest activity first.
        self.assertEqual(sessions[0]["session_id"], "s-weather")

    def test_search_fts5_ranking(self):
        if not self.store.fts5_available:
            self.skipTest("no FTS5 in this sqlite3")
        _seed(self.store)
        hits = self.store.search("机器人调试", limit=5)
        self.assertGreaterEqual(len(hits), 2)
        self.assertIn("机器人", hits[0]["text"])
        self.assertGreater(hits[0]["score"], 0)
        hits = self.store.search("Python 编程", limit=5)
        self.assertGreaterEqual(len(hits), 1)
        self.assertIn("Python", hits[0]["text"])
        # Irrelevant query finds nothing.
        self.assertEqual(self.store.search("火星探测器着陆"), [])

    def test_search_fallback_ranking(self):
        store = ConversationStore(Path(self._tmp.name) / "fallback",
                                  use_fts5=False)
        self.addCleanup(store.close)
        self.assertFalse(store.fts5_available)
        _seed(store)
        hits = store.search("机器人调试", limit=5)
        self.assertGreaterEqual(len(hits), 2)
        self.assertIn("机器人", hits[0]["text"])
        # A message matching both query tokens outranks one matching one.
        hits = store.search("机器人 Python", limit=5)
        texts = [h["text"] for h in hits]
        self.assertTrue(any("机器人" in t for t in texts))
        self.assertTrue(any("Python" in t for t in texts))
        hits = store.search("Python", limit=5)
        self.assertEqual(len(hits), 1)
        self.assertIn("Python", hits[0]["text"])
        # A token shared by two messages finds both.
        hits = store.search("列表推导式", limit=5)
        self.assertEqual(len(hits), 2)
        self.assertEqual(store.search("火星探测器着陆"), [])
        # Short tokens (which trigram FTS5 cannot match) work here too.
        store.record("s-short", "user", "AI 模型调用失败了")
        hits = store.search("AI 模型", limit=5)
        self.assertGreaterEqual(len(hits), 1)
        self.assertIn("AI 模型", hits[0]["text"])

    def test_search_empty_query(self):
        _seed(self.store)
        for query in ("", "   ", "!!!", "..."):
            self.assertEqual(self.store.search(query), [], msg=query)

    def test_search_short_token_uses_fallback(self):
        # A 2-char token cannot match through trigram FTS5, so the
        # store must route it to the LIKE path instead of returning [].
        _seed(self.store)
        self.store.record("s-short", "user", "AI 模型调用失败了")
        hits = self.store.search("AI 模型", limit=5)
        self.assertGreaterEqual(len(hits), 1)
        self.assertIn("AI 模型", hits[0]["text"])

    def test_retrieve_context(self):
        _seed(self.store)
        block = self.store.retrieve_context("机器人调试", limit=5, max_chars=2000)
        self.assertIn("过往对话", block)
        self.assertIn("[user]", block)
        self.assertIn("机器人", block)
        self.assertLessEqual(len(block), 2000)
        # Tight budget is respected.
        small = self.store.retrieve_context("机器人调试", limit=5, max_chars=80)
        self.assertLessEqual(len(small), 80)
        self.assertIn("过往对话", small)
        # No match -> empty string.
        self.assertEqual(self.store.retrieve_context("火星探测器着陆"), "")
        # limit=1 keeps only the best hit.
        one = self.store.retrieve_context("机器人调试", limit=1, max_chars=2000)
        self.assertEqual(one.count("- ["), 1)

    def test_retrieve_context_long_message_truncated(self):
        long_text = "工业机器人调试步骤。" * 100  # ~1000 chars
        self.store.record("s-long", "user", long_text)
        block = self.store.retrieve_context("机器人调试", limit=1, max_chars=500)
        self.assertLessEqual(len(block), 500)
        self.assertIn("…", block)

    def test_scrub_secrets_applied(self):
        text = "我的 key 如下：\n" + SECRET_LINE + "\n请帮我调试机器人"
        row_id = self.store.record("s-secret", "user", text)
        self.assertIsNotNone(row_id)
        stored = self.store.history("s-secret")[0]["text"]
        self.assertNotIn(FAKE_SECRET, stored)
        self.assertNotIn("api_key", stored)
        self.assertIn("请帮我调试机器人", stored)
        # A message that is only a secret line is not stored at all.
        self.assertIsNone(self.store.record("s-secret", "user", SECRET_LINE))
        self.assertEqual(len(self.store.history("s-secret")), 1)

    def test_prune(self):
        now = time.time()
        self.store.record("s-old", "user", "三个月前的旧对话",
                          created_at=now - 100 * 86400)
        self.store.record("s-old", "user", "昨天的对话",
                          created_at=now - 86400)
        self.store.record("s-old", "user", "刚才的对话", created_at=now)
        self.assertEqual(self.store.prune(days=90), 1)
        remaining = [m["text"] for m in self.store.history("s-old")]
        self.assertEqual(len(remaining), 2)
        self.assertNotIn("三个月前的旧对话", " ".join(remaining))
        # Pruning again removes nothing; negative days is an error.
        self.assertEqual(self.store.prune(days=90), 0)
        with self.assertRaises(ValueError):
            self.store.prune(days=-1)

    def test_prune_keeps_fts_index_in_sync(self):
        if not self.store.fts5_available:
            self.skipTest("no FTS5 in this sqlite3")
        now = time.time()
        self.store.record("s-old", "user", "三个月前的机器人旧对话",
                          created_at=now - 100 * 86400)
        self.store.record("s-new", "user", "今天的机器人新对话", created_at=now)
        self.store.prune(days=90)
        hits = self.store.search("机器人", limit=5)
        self.assertEqual(len(hits), 1)
        self.assertIn("今天", hits[0]["text"])

    def test_reopen_reuses_database(self):
        _seed(self.store)
        self.store.close()
        reopened = ConversationStore(Path(self._tmp.name))
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.schema_version, 1)
        self.assertEqual(len(reopened.history("s-robot")), 3)
        self.assertEqual(len(reopened.sessions()), 3)
        # Search still works after reopen (index intact).
        hits = reopened.search("机器人调试", limit=5)
        self.assertGreaterEqual(len(hits), 2)

    def test_force_fts5_off_still_persists(self):
        store = ConversationStore(Path(self._tmp.name) / "nofts",
                                  use_fts5=False)
        self.addCleanup(store.close)
        store.record("s", "user", "工业机器人调试")
        self.assertEqual(len(store.history("s")), 1)


if __name__ == "__main__":
    unittest.main()
