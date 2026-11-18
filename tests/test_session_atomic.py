"""会话原子保存与工具执行中断的回归测试（unittest，CI 用 unittest discover）。"""

import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from nyra import memory
from nyra.agent import Agent


SID = "20260101-000000-abcd"


class SessionAtomicTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.sessions = self.tmp / "sessions"
        patcher = patch.object(memory, "SESSIONS_DIR", self.sessions)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._tmp.cleanup)

    def test_replace_failure_preserves_old_session(self):
        old = [{"role": "user", "content": "原会话"}]
        path = memory.save_session(SID, old)
        original = path.read_bytes()
        with patch("nyra.memory.os.replace", side_effect=OSError("模拟替换失败")):
            with self.assertRaises(OSError):
                memory.save_session(SID, [{"role": "user", "content": "新会话"}])
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(memory.load_session(SID), old)
        self.assertEqual(list(self.sessions.iterdir()), [path])

    def test_tool_crash_preserves_pending_calls_and_first_result(self):
        for crash in (KeyboardInterrupt, RuntimeError):
            with self.subTest(crash=crash.__name__):
                self._run_crash(crash)

    def _run_crash(self, crash):
        calls = [
            {"id": str(i), "type": "function", "function": {
                "name": "read_file", "arguments": '{"path": "test.txt"}'}}
            for i in range(2)
        ]

        class FakeProvider:
            def chat(self, messages, tools):
                return {"choices": [{"message": {
                    "content": "正在读取", "tool_calls": calls}}]}

        seen = []

        def execute(name, args, ctx):
            saved = memory.load_session(SID)
            seen.append(saved)
            # 首次执行前就应能读到完整的工具调用；第二次执行前已有首个结果。
            if len(seen) == 1:
                return "第一个结果"
            raise crash("模拟工具中断")

        with patch("nyra.agent.NYRA_HOME", self.tmp), patch.object(
            Agent, "build_system_prompt", return_value="系统提示"
        ), patch("nyra.agent.execute_tool", side_effect=execute):
            agent = Agent(FakeProvider(), workdir=self.tmp, session_id=SID, skills_dirs=[])
            with self.assertRaises(crash):
                agent.run("读取文件")
        self.assertEqual(seen[0][-1]["tool_calls"], calls)
        self.assertEqual(seen[1][-1]["tool_call_id"], "0")
        text = (self.sessions / f"{SID}.jsonl").read_text(encoding="utf-8")
        raw = [json.loads(line) for line in text.splitlines()]
        self.assertEqual(raw, [
            {"role": "user", "content": "读取文件"},
            {"role": "assistant", "content": "正在读取", "tool_calls": calls},
            {"role": "tool", "tool_call_id": "0", "content": "第一个结果"},
        ])

    @unittest.skipIf(os.name == "nt", "POSIX 权限检查")
    def test_private_session_permissions(self):
        path = memory.save_session(SID, [])
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.sessions.stat().st_mode), 0o700)
        path.chmod(0o644)
        memory.save_session(SID, [])
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_load_session_directory_entry_returns_none(self):
        # A directory squatting on "<id>.jsonl" used to raise
        # IsADirectoryError; load_session documents None for anything
        # that is not a readable session file.
        (self.sessions / f"{SID}.jsonl").mkdir(parents=True)
        self.assertIsNone(memory.load_session(SID))

    def test_invalid_session_ids_rejected(self):
        for sid in ("", "..", "../escape", "a/b", "a\\b", "a..b",
                    "/tmp/escape", "C:\\escape", "bad\x00id"):
            with self.subTest(sid=sid):
                with self.assertRaises(ValueError):
                    memory.save_session(sid, [])
                # 读取侧与不存在的会话一致，返回 None 而不是抛异常。
                self.assertIsNone(memory.load_session(sid))
                self.assertFalse(self.sessions.exists())


if __name__ == "__main__":
    unittest.main()
