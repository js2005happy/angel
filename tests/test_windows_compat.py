"""Cross-platform MCP stdio and console regression tests (stdlib only)."""

import io
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from angel.console import configure_stream
from angel.mcp import MCPClient, MCPError, MCPServerConfig


class ConsoleEncodingTest(unittest.TestCase):
    def test_legacy_code_page_cannot_crash_on_chinese_output(self):
        output = io.BytesIO()
        stream = io.TextIOWrapper(output, encoding="cp1252", errors="strict")
        configure_stream(stream)
        print("定时任务", file=stream)
        stream.flush()
        self.assertIn(b"\\u5b9a", output.getvalue())

    def test_non_reconfigurable_stream_is_supported(self):
        stream = io.StringIO()
        configure_stream(stream)
        stream.write("中文")
        self.assertEqual(stream.getvalue(), "中文")


class BackendPosixPathTest(unittest.TestCase):
    def test_sandbox_paths_are_posix_even_on_windows(self):
        from angel.tools import _resolve_backend_path

        ctx = SimpleNamespace(workdir=Path("/home/user"))
        self.assertEqual(_resolve_backend_path(ctx, "child.txt"), "/home/user/child.txt")
        self.assertEqual(_resolve_backend_path(ctx, "nested\\\\folder.txt"), "/home/user/nested/folder.txt")
        self.assertEqual(_resolve_backend_path(ctx, "/tmp/../home/user"), "/home/user")


class MCPStdioCompatibilityTest(unittest.TestCase):
    def test_silent_child_times_out_and_is_cleaned_up(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "silent.py"
            script.write_text("import time\ntime.sleep(10)\n", encoding="utf-8")
            config = MCPServerConfig(
                name="silent",
                command=sys.executable,
                args=["-u", str(script)],
            )
            client = MCPClient(config, timeout=0.2)
            started = time.monotonic()
            with self.assertRaisesRegex(MCPError, "超时"):
                client.start()
            self.assertIsNone(client.process)
            self.assertLess(time.monotonic() - started, 5)

    def test_immediate_child_exit_is_reported_and_cleaned_up(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "exit.py"
            script.write_text("import sys\nsys.exit(3)\n", encoding="utf-8")
            config = MCPServerConfig(
                name="exit",
                command=sys.executable,
                args=["-u", str(script)],
            )
            client = MCPClient(config, timeout=3)
            with self.assertRaisesRegex(MCPError, "已退出"):
                client.start()
            self.assertIsNone(client.process)


if __name__ == "__main__":
    unittest.main()
