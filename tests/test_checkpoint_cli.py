"""End-to-end REPL commands for local checkpoint undo and rewind."""

import io
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

import angel.agent as agent_module
import angel.cli as cli
import angel.memory as memory_module


def call(path, value, cid):
    return {
        "id": cid, "type": "function",
        "function": {"name": "write_file", "arguments": json.dumps({
            "path": path, "content": value,
        })},
    }


class FakeProvider:
    name = "mock"
    model = "mock"

    def __init__(self, tasks):
        self.tasks = list(tasks)

    def has_credentials(self):
        return True

    def chat(self, messages, tools=None, timeout=120):
        item = self.tasks.pop(0)
        return {"choices": [{"message": item}]}


class CheckpointCLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.project = self.root / "project"
        self.project.mkdir()
        self.patchers = [
            mock.patch.object(agent_module, "ANGEL_HOME", self.root / "home"),
            mock.patch.object(cli, "ANGEL_HOME", self.root / "home"),
            mock.patch.object(memory_module, "SESSIONS_DIR", self.root / "sessions"),
        ]
        for p in self.patchers:
            p.start()

    def tearDown(self):
        for p in reversed(self.patchers):
            p.stop()
        self.temp.cleanup()

    def run_cli(self, lines, messages):
        config = {
            "provider": "deepseek", "model": "mock",
            "mode": "full", "max_turns": 4, "profiles": {},
            "context_window_tokens": None,
            "auto_compact_enabled": False, "auto_compact_threshold": 0.8,
        }
        provider = FakeProvider(messages)
        stdout = io.StringIO()
        with mock.patch.object(cli, "load_config", return_value=config), \
             mock.patch.object(cli, "resolve_provider", return_value=SimpleNamespace(
                 name="mock", model="mock",
             )), \
             mock.patch.object(cli, "Provider", return_value=provider), \
             mock.patch.object(cli, "describe_provider", return_value="mock"), \
             mock.patch.object(cli, "build_mcp_manager", return_value=None), \
             mock.patch("builtins.input", side_effect=lines), \
             mock.patch("sys.stdin", io.StringIO()), \
             mock.patch("sys.stdout", stdout):
            return cli.main(["--workdir", str(self.project), "--mode", "full"]), stdout.getvalue()

    def test_undo_restores_file_and_appends_notice_to_model_history(self):
        code, output = self.run_cli(
            ["create", "/undo", "/exit"],
            [
                {"content": "", "tool_calls": [call("item.txt", "created", "c1")]},
                {"content": "written"},
            ],
        )
        self.assertEqual(code, 0)
        self.assertIn("已撤销 1 轮", output)
        self.assertFalse((self.project / "item.txt").exists())
        sessions = list((self.root / "sessions").glob("*.jsonl"))
        self.assertEqual(len(sessions), 1)
        self.assertIn("此前工具执行结果可能已失效", sessions[0].read_text(encoding="utf-8"))

    def test_rewind_two_turns_and_prevent_undo_after_new_session(self):
        code, output = self.run_cli(
            ["first", "second", "/rewind 2", "/new", "/undo", "/exit"],
            [
                {"content": "", "tool_calls": [call("first.txt", "one", "c1")]},
                {"content": "first done"},
                {"content": "", "tool_calls": [call("second.txt", "two", "c2")]},
                {"content": "second done"},
            ],
        )
        self.assertEqual(code, 0)
        self.assertIn("已撤销 2 轮", output)
        self.assertIn("没有足够的可撤销检查点", output)
        self.assertFalse((self.project / "first.txt").exists())
        self.assertFalse((self.project / "second.txt").exists())

    def test_invalid_rewind_count_never_modifies_file(self):
        code, output = self.run_cli(
            ["create", "/rewind nope", "/rewind 99", "/exit"],
            [
                {"content": "", "tool_calls": [call("one.txt", "one", "c1")]},
                {"content": "done"},
            ],
        )
        self.assertEqual(code, 0)
        self.assertIn("用法：/rewind", output)
        self.assertIn("1 到 10", output)
        self.assertTrue((self.project / "one.txt").exists())


if __name__ == "__main__":
    unittest.main()
