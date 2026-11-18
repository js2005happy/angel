"""Tests for live shell output streaming (tool_stream events)."""

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nyra.tools import ToolContext, execute_tool  # noqa: E402


def _ctx(tmp: Path, stream: bool):
    events: list[dict] = []

    def on_event(kind: str, data: dict) -> None:
        events.append({"kind": kind, "data": data})

    ctx = ToolContext(
        workdir=tmp,
        mode="auto",
        interactive=True,
        memory_path=tmp / "MEMORY.md",
        skills_dir=tmp / "skills",
        approve_fn=lambda *a: True,
        stream_tool_output=stream,
        on_event=on_event,
    )
    return ctx, events


class ShellStreamTests(unittest.TestCase):
    def test_streams_lines_live_and_returns_full_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, events = _ctx(Path(tmp), stream=True)
            cmd = (
                f'"{sys.executable}" -c '
                "\"import sys; print('one'); print('two', file=sys.stderr)\""
            )
            result = execute_tool("shell", {"command": cmd}, ctx)
            self.assertIn("one", result)
            self.assertIn("标准错误：", result)
            self.assertIn("two", result)
            streamed = [
                e["data"]
                for e in events
                if e["kind"] == "tool_stream"
            ]
            # stdout/stderr arrive on separate reader threads, so their
            # relative order is racy by design; the set is what matters.
            self.assertEqual(
                sorted((d["stream"], d["text"]) for d in streamed),
                [("stderr", "two"), ("stdout", "one")],
            )

    def test_no_stream_when_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, events = _ctx(Path(tmp), stream=False)
            result = execute_tool(
                "shell", {"command": "echo 42"}, ctx
            )
            self.assertIn("42", result)
            self.assertEqual(
                [e for e in events if e["kind"] == "tool_stream"], []
            )

    def test_timeout_kills_process_and_reports_partial_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx, events = _ctx(Path(tmp), stream=True)
            cmd = (
                f'"{sys.executable}" -c '
                "\"import sys, time; print('before'); sys.stdout.flush(); "
                "time.sleep(30)\""
            )
            started = time.monotonic()
            result = execute_tool(
                "shell", {"command": cmd, "timeout": 1}, ctx
            )
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 10)
            self.assertTrue(result.startswith("错误：命令超时"))
            self.assertIn("before", result)
            streamed = [
                e["data"]["text"]
                for e in events
                if e["kind"] == "tool_stream"
            ]
            self.assertIn("before", streamed)


if __name__ == "__main__":
    unittest.main()
