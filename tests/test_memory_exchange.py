"""Tests for memory exchange (nyra/memory_exchange.py + pairing /memory).

All offline, no keys, no network (pairing tests use loopback only).
"""

import contextlib
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from nyra import memory_exchange
from nyra.memory_exchange import (
    ChatZipError,
    LocalMemoryNotFound,
    SnapshotError,
    export_prompt,
    export_snapshot,
    fetch_peer_memory,
    import_chat_zip,
    import_snapshot,
    parse_snapshot,
    read_local_agent_memory,
    scrub_secrets,
)
from nyra.pairing import PairingClient, PairingError, PairingHost

SAMPLE_MEMORY = """# 记忆

## Facts
- 用户是学生，铜陵职业技术学院，工业机器人技术专业。
- 目标职业：汽车制造工业机器人调试工程师。

## Preferences
- 回复要像真人说话，有事说事。

## Commitments
- 每天 19:30 发店铺视频。
"""

SNAPSHOT_TEXT = """## 身份
- 用户是学生。

## 事实
- 用户住在铜陵。
- 喜欢喝茶。

## 偏好
- 回复要简短。
"""


class ScrubTest(unittest.TestCase):
    def test_drops_credential_lines_and_counts(self):
        text = (
            "用户是学生。\n"
            "api_key: sk-abc1234567890\n"
            "password= hunter2\n"
            "Authorization: Bearer abcdefgh12345678\n"
            "喜欢喝茶。\n"
        )
        cleaned, removed = scrub_secrets(text)
        self.assertEqual(removed, 3)
        self.assertIn("用户是学生。", cleaned)
        self.assertIn("喜欢喝茶。", cleaned)
        self.assertNotIn("sk-abc", cleaned)
        self.assertNotIn("hunter2", cleaned)
        self.assertNotIn("Bearer", cleaned)

    def test_drops_bare_secret_tokens_and_private_key(self):
        text = "sk-proj-abcdefgh12345678\n-----BEGIN PRIVATE KEY-----\nabc\n"
        cleaned, removed = scrub_secrets(text)
        # 私钥体（BEGIN 后的 base64 行）整块删掉，只删头行会漏私钥本身。
        self.assertEqual(removed, 3)
        self.assertNotIn("sk-proj", cleaned)
        self.assertNotIn("PRIVATE KEY", cleaned)
        self.assertNotIn("abc", cleaned)

    def test_drops_json_quoted_credential_keys(self):
        # JSON 里键与赋值号之间隔着引号，旧模式认不出，会整行漏过去。
        text = (
            '{\n'
            '  "api_key": "sk-abc1234567890",\n'
            '  "password": "hunter2",\n'
            '  "access_token": "tok-abcdefgh1234",\n'
            '  "secret": "s3cr3t-value",\n'
            '  "name": "Alice"\n'
            '}\n'
        )
        cleaned, removed = scrub_secrets(text)
        self.assertEqual(removed, 4)
        self.assertNotIn("sk-abc", cleaned)
        self.assertNotIn("hunter2", cleaned)
        self.assertNotIn("tok-abcdefgh", cleaned)
        self.assertNotIn("s3cr3t-value", cleaned)
        self.assertIn("Alice", cleaned)

    def test_drops_multiline_private_key_body(self):
        text = (
            "用户是学生。\n"
            "-----BEGIN PRIVATE KEY-----\n"
            "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n"
            "AbCdEfGhIjKlMnOpQrStUvWxYz012345\n"
            "-----END PRIVATE KEY-----\n"
            "喜欢喝茶。\n"
        )
        cleaned, removed = scrub_secrets(text)
        self.assertEqual(removed, 4)
        self.assertNotIn("MIIEvQ", cleaned)
        self.assertNotIn("AbCdEf", cleaned)
        self.assertNotIn("PRIVATE KEY", cleaned)
        self.assertIn("用户是学生。", cleaned)
        self.assertIn("喜欢喝茶。", cleaned)

    def test_keeps_prose_mentioning_token(self):
        text = "token 统计是真的，prompt token 比 completion 多。\n"
        cleaned, removed = scrub_secrets(text)
        self.assertEqual(removed, 0)
        self.assertIn("token 统计", cleaned)

    def test_empty_stays_empty(self):
        self.assertEqual(scrub_secrets(""), ("", 0))


class ExportParseImportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mem = Path(self.tmp.name) / "MEMORY.md"
        self.mem.write_text(SAMPLE_MEMORY, encoding="utf-8")

    def test_export_renders_snapshot_sections(self):
        snapshot = export_snapshot(self.mem)
        self.assertIn("## 事实", snapshot)
        self.assertIn("用户是学生，铜陵职业技术学院", snapshot)
        self.assertIn("## 偏好", snapshot)
        self.assertIn("## 目标与承诺", snapshot)
        self.assertNotIn("## 身份", snapshot)  # 无可靠信息，省略
        self.assertNotIn("## 关系", snapshot)

    def test_export_missing_memory_errors(self):
        with self.assertRaises(SnapshotError):
            export_snapshot(Path(self.tmp.name) / "不存在.md")

    def test_export_prompt_has_fixed_sections(self):
        prompt = export_prompt()
        for section in ("## 身份", "## 事实", "## 偏好", "## 目标与承诺", "## 关系"):
            self.assertIn(section, prompt)
        self.assertIn("第三人称", prompt)
        self.assertIn("切勿编造占位符", prompt)

    def test_parse_rejects_empty_and_placeholder_only(self):
        with self.assertRaises(SnapshotError):
            parse_snapshot("")
        with self.assertRaises(SnapshotError):
            parse_snapshot("## 事实\n- 暂无\n- 待补充\n")

    def test_import_roundtrip_and_dedup(self):
        target = Path(self.tmp.name) / "TARGET.md"
        report = import_snapshot(SNAPSHOT_TEXT, memory_path=target)
        self.assertEqual(report["added"], 4)
        self.assertEqual(report["skipped"], 0)
        self.assertEqual(report["scrubbed"], 0)
        self.assertEqual(report["sections"], ["身份", "事实", "偏好"])
        content = target.read_text(encoding="utf-8")
        self.assertIn("[事实] 用户住在铜陵。", content)
        report2 = import_snapshot(SNAPSHOT_TEXT, memory_path=target)
        self.assertEqual(report2["added"], 0)
        self.assertEqual(report2["skipped"], 4)

    def test_import_dedup_is_case_insensitive(self):
        target = Path(self.tmp.name) / "TARGET.md"
        target.write_text("- Likes TEA in the morning.\n", encoding="utf-8")
        report = import_snapshot("## 偏好\n- likes tea in the morning.\n", memory_path=target)
        self.assertEqual(report["added"], 0)
        self.assertEqual(report["skipped"], 1)

    def test_import_scrubs_before_merging(self):
        target = Path(self.tmp.name) / "TARGET.md"
        report = import_snapshot(
            "## 事实\n- 用户住在铜陵。\n- api_key: sk-abc1234567890\n",
            memory_path=target,
        )
        self.assertEqual(report["added"], 1)
        self.assertEqual(report["scrubbed"], 1)
        self.assertNotIn("sk-abc", target.read_text(encoding="utf-8"))


class LocalReadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def test_dir_reads_memory_files(self):
        folder = self.home / "other"
        folder.mkdir()
        (folder / "MEMORY.md").write_text("# 记忆\n- 用户是学生。\n", encoding="utf-8")
        (folder / "AGENTS.md").write_text("用中文回复。\n", encoding="utf-8")
        result = read_local_agent_memory("dir", path=folder)
        self.assertEqual(result["source"], "dir")
        self.assertEqual(result["count"], 2)
        self.assertIn("用户是学生。", result["text"])

    def test_dir_missing_reports_not_found(self):
        with self.assertRaises(LocalMemoryNotFound):
            read_local_agent_memory("dir", path=self.home / "empty")

    def _make_codex_db(self, tables):
        codex = self.home / ".codex"
        codex.mkdir()
        db = codex / "memories_1.sqlite"
        conn = sqlite3.connect(db)
        try:
            for sql in tables:
                conn.execute(sql)
            conn.commit()
        finally:
            conn.close()
        return db

    def test_codex_reads_memories_table(self):
        self._make_codex_db(
            [
                "CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT)",
                "INSERT INTO memories (content) VALUES ('用户喜欢用深色主题。')",
                "INSERT INTO memories (content) VALUES ('目标是做独立开发。')",
            ]
        )
        result = read_local_agent_memory("codex", home=self.home)
        self.assertEqual(result["source"], "codex")
        self.assertEqual(result["count"], 2)
        self.assertIn("深色主题", result["text"])

    def test_codex_falls_back_to_stage1_outputs(self):
        self._make_codex_db(
            [
                "CREATE TABLE stage1_outputs (thread_id TEXT, raw_memory TEXT)",
                "INSERT INTO stage1_outputs VALUES ('t1', '用户每天早上跑步。')",
            ]
        )
        result = read_local_agent_memory("codex", home=self.home)
        self.assertIn("每天早上跑步", result["text"])

    def test_codex_empty_db_reports_not_found(self):
        self._make_codex_db(["CREATE TABLE jobs (kind TEXT)"])
        with self.assertRaises(LocalMemoryNotFound):
            read_local_agent_memory("codex", home=self.home)

    def test_codex_missing_db_reports_not_found(self):
        with self.assertRaises(LocalMemoryNotFound):
            read_local_agent_memory("codex", home=self.home)

    def test_claude_missing_reports_not_found(self):
        with self.assertRaises(LocalMemoryNotFound):
            read_local_agent_memory("claude", home=self.home)

    def test_claude_reads_claude_md(self):
        claude = self.home / ".claude"
        claude.mkdir()
        (claude / "CLAUDE.md").write_text("# Claude\n- 用户用中文。\n", encoding="utf-8")
        result = read_local_agent_memory("claude", home=self.home)
        self.assertEqual(result["source"], "claude")
        self.assertIn("用户用中文。", result["text"])


class PairingMemoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mem = Path(self.tmp.name) / "MEMORY.md"
        self.mem.write_text(
            "## Facts\n- 用户是学生。\n- api_key: sk-abc1234567890\n",
            encoding="utf-8",
        )

    def start_host(self):
        host = PairingHost(runner=lambda task: f"回显：{task}")
        host.start()
        self.addCleanup(host.stop)
        return host

    def _get(self, host, path, headers=None):
        url = f"http://127.0.0.1:{host.port}{path}"
        req = urllib.request.Request(url, method="GET")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        return urllib.request.urlopen(req, timeout=5)

    def test_memory_without_token_401(self):
        host = self.start_host()
        with mock.patch.object(memory_exchange, "MEMORY_PATH", self.mem):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                self._get(host, "/memory")
        self.assertEqual(ctx.exception.code, 401)

    def test_memory_wrong_token_401(self):
        host = self.start_host()
        client = PairingClient()
        with mock.patch.object(memory_exchange, "MEMORY_PATH", self.mem):
            client.pair("127.0.0.1", host.port, host.code)
            client.token = "0" * 64
            with self.assertRaises(PairingError):
                client.read_peer_memory()

    def test_memory_returns_scrubbed_snapshot(self):
        host = self.start_host()
        client = PairingClient()
        with mock.patch.object(memory_exchange, "MEMORY_PATH", self.mem):
            client.pair("127.0.0.1", host.port, host.code)
            snapshot = client.read_peer_memory()
        self.assertIn("用户是学生。", snapshot)
        self.assertNotIn("sk-abc", snapshot)
        self.assertNotIn("api_key", snapshot)

    def test_memory_no_memory_404(self):
        host = self.start_host()
        client = PairingClient()
        missing = Path(self.tmp.name) / "不存在.md"
        with mock.patch.object(memory_exchange, "MEMORY_PATH", missing):
            client.pair("127.0.0.1", host.port, host.code)
            with self.assertRaises(PairingError) as ctx:
                client.read_peer_memory()
        self.assertIn("暂无记忆", str(ctx.exception))

    def test_fetch_peer_memory_scrubs_again(self):
        host = self.start_host()
        client = PairingClient()
        with mock.patch.object(memory_exchange, "MEMORY_PATH", self.mem):
            client.pair("127.0.0.1", host.port, host.code)
            text, removed = fetch_peer_memory(
                "127.0.0.1", host.port, client.token
            )
        self.assertIn("用户是学生。", text)
        self.assertNotIn("sk-abc", text)
        self.assertEqual(removed, 0)  # 宿主已脱敏过，客人侧无新增删除


class ChatZipTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.mem = self.home / "MEMORY.md"

    def _make_zip(self, name, conversations):
        path = self.home / name
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(
                "conversations.json",
                json.dumps(conversations, ensure_ascii=False),
            )
        return path

    def test_chatgpt_zip_import(self):
        convs = [
            {
                "title": "修电脑",
                "create_time": 1763000000,
                "mapping": {
                    "a": {"message": {"author": {"role": "user"}, "content": {"parts": ["电脑开不了机"]}}},
                    "b": {"message": {"author": {"role": "assistant"}, "content": {"parts": ["先检查电源"]}}},
                    "c": {"message": None},
                },
            },
            {
                "title": "做饭",
                "create_time": 1763100000,
                "mapping": {
                    "a": {"message": {"author": {"role": "user"}, "content": {"parts": ["怎么做红烧肉"]}}},
                },
            },
        ]
        path = self._make_zip("chatgpt.zip", convs)
        report = import_chat_zip(path, memory_path=self.mem, home=self.home)
        self.assertEqual(report["source"], "chatgpt")
        self.assertEqual(report["conversations"], 2)
        self.assertEqual(report["messages"], 3)
        dest = Path(report["dir"])
        self.assertTrue((dest / "conversations.json").exists())
        self.assertIn("chatgpt，2 个对话、3 条消息", self.mem.read_text(encoding="utf-8"))

    def test_claude_zip_import(self):
        convs = [
            {
                "name": "写代码",
                "created_at": "2026-11-02T09:00:00Z",
                "chat_messages": [{"uuid": "1"}, {"uuid": "2"}, {"uuid": "3"}],
            }
        ]
        path = self._make_zip("claude.zip", convs)
        report = import_chat_zip(path, memory_path=self.mem, home=self.home)
        self.assertEqual(report["source"], "claude")
        self.assertEqual(report["conversations"], 1)
        self.assertEqual(report["messages"], 3)

    def test_bad_zip_errors(self):
        path = self.home / "bad.zip"
        path.write_text("不是 zip", encoding="utf-8")
        with self.assertRaises(ChatZipError):
            import_chat_zip(path, memory_path=self.mem, home=self.home)

    def test_zip_without_conversations_errors(self):
        path = self.home / "empty.zip"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("readme.txt", "hi")
        with self.assertRaises(ChatZipError):
            import_chat_zip(path, memory_path=self.mem, home=self.home)

    def test_unrecognized_format_errors(self):
        path = self._make_zip("weird.zip", [{"foo": 1}])
        with self.assertRaises(ChatZipError):
            import_chat_zip(path, memory_path=self.mem, home=self.home)


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mem = Path(self.tmp.name) / "MEMORY.md"
        self.mem.write_text(SAMPLE_MEMORY, encoding="utf-8")
        self.patch_mem = mock.patch.object(memory_exchange, "MEMORY_PATH", self.mem)
        self.patch_mem.start()
        self.addCleanup(self.patch_mem.stop)

    def _run(self, argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = memory_exchange.main(argv)
        return code, buf.getvalue()

    def test_export_prompt(self):
        code, out = self._run(["export-prompt"])
        self.assertEqual(code, 0)
        self.assertIn("## 身份", out)
        self.assertIn("第三人称", out)

    def test_export(self):
        code, out = self._run(["export"])
        self.assertEqual(code, 0)
        self.assertIn("## 事实", out)
        self.assertIn("铜陵职业技术学院", out)

    def test_import_file(self):
        snap = Path(self.tmp.name) / "snap.md"
        snap.write_text(SNAPSHOT_TEXT, encoding="utf-8")
        code, out = self._run(["import", str(snap)])
        self.assertEqual(code, 0)
        self.assertIn("新增 4 条", out)
        self.assertIn("[事实] 用户住在铜陵。", self.mem.read_text(encoding="utf-8"))

    def test_no_args_returns_usage(self):
        code, _out = self._run([])
        self.assertEqual(code, 2)

    def test_unknown_command_returns_usage(self):
        code, _out = self._run(["bogus"])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
