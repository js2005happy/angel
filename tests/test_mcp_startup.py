"""Regression tests for MCP server *startup* authorization.

Tool-call approval alone is insufficient: starting an untrusted process
may already have side effects, before any MCP tool is invoked.
"""

import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call

from angel.agent import build_mcp_manager


FAKE_SERVER = r'''
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text("started", encoding="utf-8")
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "serverInfo": {"name": "test", "version": "1"},
        }
    elif method == "tools/list":
        result = {"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": "ok"}]}
    else:
        result = {}
    sys.stdout.write(json.dumps({
        "jsonrpc": "2.0", "id": request["id"], "result": result
    }) + "\n")
    sys.stdout.flush()
'''


class MCPStartupPolicyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.script = self.root / "fake_server.py"
        self.script.write_text(FAKE_SERVER, encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def config(self, *names):
        return {
            "mcp_enabled": True,
            "mcp_servers": {
                name: {
                    "command": sys.executable,
                    "args": ["-u", str(self.script), str(self.root / (name + ".started"))],
                    "env": {"DUMMY_SECRET": "do-not-display"},
                }
                for name in names
            },
        }

    def test_readonly_never_loads_or_starts_external_processes(self):
        with patch("angel.agent.load_config", return_value=self.config("bad")) as load:
            result = build_mcp_manager(mode="readonly", interactive=True)
        self.assertIsNone(result)
        load.assert_not_called()
        self.assertFalse((self.root / "bad.started").exists())

    def test_unattended_auto_does_not_start_servers(self):
        with patch("angel.agent.load_config", return_value=self.config("bad")) as load:
            result = build_mcp_manager(mode="auto", interactive=False)
        self.assertIsNone(result)
        load.assert_not_called()
        self.assertFalse((self.root / "bad.started").exists())

    def test_interactive_auto_denial_prevents_startup(self):
        with patch("angel.agent.load_config", return_value=self.config("no")), \
             patch("builtins.input", return_value="n") as answer, \
             patch("sys.stdout", new_callable=io.StringIO) as output:
            result = build_mcp_manager(mode="auto", interactive=True)
        self.assertIsNone(result)
        answer.assert_called_once()
        self.assertIn("no", output.getvalue())
        self.assertNotIn("do-not-display", output.getvalue())
        self.assertFalse((self.root / "no.started").exists())

    def test_interactive_auto_starts_only_approved_servers(self):
        with patch("angel.agent.load_config", return_value=self.config("no", "yes")), \
             patch("builtins.input", side_effect=["no", "yes"]) as answer:
            manager = build_mcp_manager(mode="auto", interactive=True)
        self.assertIsNotNone(manager)
        try:
            self.assertEqual(answer.call_count, 2)
            self.assertFalse((self.root / "no.started").exists())
            self.assertTrue((self.root / "yes.started").exists())
            self.assertEqual(len(manager.tool_schemas), 1)
            self.assertEqual(manager.tool_schemas[0]["function"]["name"], "mcp_yes_echo")
        finally:
            manager.stop_all()

    def test_full_mode_starts_without_prompt(self):
        with patch("angel.agent.load_config", return_value=self.config("yes")), \
             patch("builtins.input", side_effect=AssertionError("unexpected prompt")):
            manager = build_mcp_manager(mode="full", interactive=False)
        self.assertIsNotNone(manager)
        try:
            self.assertTrue((self.root / "yes.started").exists())
        finally:
            manager.stop_all()

    def test_legacy_windows_console_does_not_crash_on_consent_prompt(self):
        raw = io.BytesIO()
        terminal = io.TextIOWrapper(raw, encoding="cp1252", errors="strict")
        with patch("angel.agent.load_config", return_value=self.config("legacy")), \
             patch("builtins.input", return_value="n"), \
             patch("sys.stdout", terminal):
            result = build_mcp_manager(mode="auto", interactive=True)
        terminal.flush()
        self.assertIsNone(result)
        self.assertIn(b"\\u", raw.getvalue())
        self.assertFalse((self.root / "legacy.started").exists())

    def test_unknown_mode_fails_closed(self):
        with patch("angel.agent.load_config", return_value=self.config("bad")) as load:
            result = build_mcp_manager(mode="unrecognized", interactive=True)
        self.assertIsNone(result)
        load.assert_not_called()

    def test_repl_switch_from_full_to_readonly_stops_existing_server(self):
        from angel.cli import main

        manager = MagicMock()
        manager.tool_schemas = [{"function": {"name": "mcp_fake_echo"}}]
        agent = MagicMock()
        agent.mode = "full"
        agent.ctx.mode = "full"
        agent.session_id = "test-session"
        with patch("angel.cli.load_config", return_value={
            "provider": "deepseek", "model": "deepseek-flash",
            "mode": "full", "max_turns": 3, "profiles": {},
        }), \
             patch("angel.cli.Provider") as provider_class, \
             patch("angel.cli.Agent", return_value=agent), \
             patch("angel.cli.build_mcp_manager", side_effect=[manager, None]) as start, \
             patch("builtins.input", side_effect=["/mode readonly", "/exit"]), \
             patch("sys.stdout", new_callable=io.StringIO):
            provider_class.return_value.has_credentials.return_value = True
            provider_class.return_value.name = "deepseek"
            code = main(["--mode", "full", "--provider", "deepseek"])
        self.assertEqual(code, 0)
        self.assertEqual(start.call_args_list, [
            call(mode="full", interactive=False),
            call(mode="readonly", interactive=False),
        ])
        manager.stop_all.assert_called_once()
        self.assertIsNone(agent.mcp_manager)
        self.assertEqual(agent.mode, "readonly")
        self.assertEqual(agent.ctx.mode, "readonly")


if __name__ == "__main__":
    unittest.main()
