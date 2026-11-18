"""Tests for the REPL polish: banner, prompt, help table and tool grouping."""

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nyra import cli  # noqa: E402
from nyra.agent import Agent  # noqa: E402
from nyra.console import ToolPrinter, one_line, style, use_color  # noqa: E402
from nyra.tools import ToolContext, ToolError, _check_approval  # noqa: E402

ANSI = "\033["


class FakeTTY(io.StringIO):
    def isatty(self):
        return True


class ColorTests(unittest.TestCase):
    def test_no_color_env_disables(self):
        with mock.patch.dict(os.environ, {"NO_COLOR": "1", "TERM": "xterm"}):
            self.assertFalse(use_color(FakeTTY()))

    def test_non_tty_disables(self):
        with mock.patch.dict(os.environ, {"TERM": "xterm"}, clear=False):
            os.environ.pop("NO_COLOR", None)
            self.assertFalse(use_color(io.StringIO()))

    def test_dumb_terminal_disables(self):
        env = {"TERM": "dumb"}
        with mock.patch.dict(os.environ, env):
            os.environ.pop("NO_COLOR", None)
            self.assertFalse(use_color(FakeTTY()))

    def test_tty_enables(self):
        with mock.patch.dict(os.environ, {"TERM": "xterm-256color"}):
            os.environ.pop("NO_COLOR", None)
            self.assertTrue(use_color(FakeTTY()))

    def test_style_plain_when_disabled(self):
        self.assertEqual(style("x", "gold", enabled=False), "x")
        self.assertIn(ANSI, style("x", "gold", enabled=True))


class ReplTextTests(unittest.TestCase):
    def test_help_lists_every_command_plain(self):
        text = cli.format_repl_help(color=False)
        self.assertNotIn(ANSI, text)
        for cmd in ("/help", "/mode", "/skills", "/sessions", "/compact", "/clear", "/new", "/exit"):
            self.assertIn(cmd, text)
        self.assertEqual(cli.REPL_HELP, text)

    def test_help_columns_align(self):
        lines = [l for l in cli.format_repl_help().splitlines() if l.startswith("  /")]
        starts = set()
        for line, (cmd, desc) in zip(lines, cli.REPL_COMMANDS):
            prefix = line[: line.index(desc)]
            starts.add(cli._display_width(prefix))
        self.assertEqual(len(starts), 1)

    def test_banner_and_prompt(self):
        banner = cli.format_banner("mock / m1 @ http://x", "auto", "sid-1")
        self.assertIn("Nyra", banner)
        self.assertIn("mock / m1", banner)
        self.assertIn("sid-1", banner)
        self.assertNotIn(ANSI, banner)
        self.assertEqual(cli.repl_prompt("auto"), "nyra[auto] › ")
        self.assertIn(ANSI, cli.repl_prompt("full", color=True))

    def test_repl_status_line(self):
        snapshot = {
            "context_window_tokens": 100000,
            "last_prompt_tokens": 25000,
        }
        status = cli.format_repl_status(
            "deepseek-v4-pro", Path("/home/u/nyra"), snapshot, "auto"
        )
        self.assertEqual(
            status, "[deepseek-v4-pro] | nyra · 上下文 25% · auto"
        )

    def test_repl_status_unknown_context(self):
        status = cli.format_repl_status(
            "m1", Path("/tmp"), {"context_window_tokens": None,
                                 "last_prompt_tokens": None}, "full"
        )
        self.assertIn("上下文 --", status)

    def test_repl_prompt_with_status(self):
        prompt = cli.repl_prompt(
            "auto", status="[m1] | nyra · 上下文 25% · auto"
        )
        self.assertEqual(
            prompt, "[m1] | nyra · 上下文 25% · auto\nnyra[auto] › "
        )


class ToolPrinterTests(unittest.TestCase):
    def test_stream_lines(self):
        out = io.StringIO()
        printer = ToolPrinter(stream=out, color=False)
        printer("tool_stream", {"name": "shell", "stream": "stdout", "text": "hello"})
        printer("tool_stream", {"name": "shell", "stream": "stderr", "text": "oops"})
        lines = out.getvalue().splitlines()
        self.assertEqual(lines[0], "│ hello")
        self.assertEqual(lines[1], "│ oops")

    def test_groups_start_and_result(self):
        out = io.StringIO()
        printer = ToolPrinter(stream=out, color=False)
        printer("tool_start", {"name": "write_file", "arguments": {"path": "a.txt", "content": "x" * 300}})
        printer("tool_result", {"name": "write_file", "result": "已写入 a.txt"})
        printer("tool_result", {"name": "shell", "result": "错误：用户拒绝执行"})
        printer("final", {"content": "ignored"})
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 3)
        self.assertTrue(lines[0].startswith("┌ write_file path=a.txt"))
        self.assertLessEqual(len(lines[0]), 90)
        self.assertTrue(lines[1].startswith("└ ✓"))
        self.assertTrue(lines[2].startswith("└ ✗"))
        self.assertNotIn(ANSI, out.getvalue())

    def test_one_line(self):
        self.assertEqual(one_line("a\n b"), "a b")
        self.assertEqual(len(one_line("x" * 200, 20)), 20)


class AgentEventTests(unittest.TestCase):
    def test_agent_emits_events_and_survives_bad_observer(self):
        class P:
            def __init__(self):
                self.r = [
                    {"choices": [{"message": {"role": "assistant", "content": "", "tool_calls": [
                        {"id": "c1", "type": "function", "function": {"name": "list_dir", "arguments": json.dumps({"path": "."})}}]}}]},
                    {"choices": [{"message": {"role": "assistant", "content": "好了"}}]},
                ]

            def chat(self, messages, tools=None, timeout=120):
                return self.r.pop(0)

        seen = []

        def observer(kind, data):
            seen.append(kind)
            raise RuntimeError("observer bug")

        with tempfile.TemporaryDirectory() as tmp:
            agent = Agent(P(), workdir=tmp, mode="readonly", interactive=False, on_event=observer)
            try:
                self.assertEqual(agent.run("列目录"), "好了")
            finally:
                from nyra.config import NYRA_HOME
                (NYRA_HOME / "sessions" / f"{agent.session_id}.jsonl").unlink(missing_ok=True)
        self.assertEqual(seen, ["tool_start", "tool_result", "final"])

    def test_approve_fn_replaces_terminal_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            asked = []
            ctx = ToolContext(
                workdir=Path(tmp), mode="auto", interactive=True,
                memory_path=Path(tmp) / "M.md", skills_dir=Path(tmp) / "s",
                approve_fn=lambda tool, summary: asked.append(tool) or False,
            )
            with mock.patch("builtins.input", side_effect=AssertionError("must not prompt")):
                with self.assertRaises(ToolError):
                    _check_approval(ctx, "shell", "执行命令：ls")
            self.assertEqual(asked, ["shell"])
            ctx.approve_fn = lambda tool, summary: True
            _check_approval(ctx, "shell", "执行命令：ls")


if __name__ == "__main__":
    unittest.main()
