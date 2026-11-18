"""Tests for the machine-readable start line the desktop app reads.

`nyra ui --port 0 --print-url-json --exit-on-stdin-close` prints one JSON
line on stdout (address + token), moves the human text to stderr, and stops
when the parent closes stdin. Everything runs on 127.0.0.1 with no model.
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from nyra import webui  # noqa: E402

# Talk to 127.0.0.1 directly even when the machine sets HTTP(S)_PROXY.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class ParserTests(unittest.TestCase):
    def test_flags_default_off(self):
        args = webui.build_parser().parse_args([])
        self.assertFalse(args.print_url_json)
        self.assertFalse(args.exit_on_stdin_close)
        self.assertEqual(args.host, "127.0.0.1")

    def test_flags_parse(self):
        args = webui.build_parser().parse_args(
            ["--port", "0", "--print-url-json", "--exit-on-stdin-close"]
        )
        self.assertTrue(args.print_url_json)
        self.assertTrue(args.exit_on_stdin_close)
        self.assertEqual(args.port, 0)


class UrlJsonTests(unittest.TestCase):
    def test_line_matches_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = webui.UIState(Path(tmp), token="tok-abc")
            server = webui.make_server("127.0.0.1", 0, state)
            try:
                line = webui.url_json(server)
                self.assertNotIn("\n", line)
                data = json.loads(line)
                port = server.server_address[1]
                self.assertEqual(data["nyra"], "ui")
                self.assertEqual(data["host"], "127.0.0.1")
                self.assertEqual(data["port"], port)
                self.assertEqual(data["token"], "tok-abc")
                self.assertEqual(data["url"], f"http://127.0.0.1:{port}/?token=tok-abc")
                self.assertEqual(data["url"], webui.ui_url(server))
            finally:
                server.server_close()


class StdinWatchTests(unittest.TestCase):
    def test_calls_back_on_eof(self):
        fired = threading.Event()
        thread = webui.watch_stdin_close(fired.set, stream=io.BytesIO(b"some bytes"))
        thread.join(5)
        self.assertTrue(fired.is_set())

    def test_closed_stream_still_fires(self):
        stream = io.BytesIO()
        stream.close()
        fired = threading.Event()
        webui.watch_stdin_close(fired.set, stream=stream).join(5)
        self.assertTrue(fired.is_set())


class SubprocessTests(unittest.TestCase):
    """End to end, the way the desktop shell drives it."""

    def test_print_json_then_exit_on_stdin_close(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            work = Path(tmp) / "work"
            home.mkdir()
            work.mkdir()
            env = dict(os.environ)
            env.update({"HOME": str(home), "USERPROFILE": str(home), "PYTHONIOENCODING": "utf-8"})
            env.pop("NYRA_PROFILE", None)
            proc = subprocess.Popen(
                [sys.executable, "-m", "nyra", "ui", "--port", "0", "--workdir", str(work),
                 "--print-url-json", "--exit-on-stdin-close"],
                cwd=str(ROOT), env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            try:
                first = proc.stdout.readline().decode("utf-8")
                data = json.loads(first)
                url = urllib.parse.urlsplit(data["url"])
                self.assertEqual(url.hostname, "127.0.0.1")
                self.assertEqual(url.port, data["port"])
                self.assertNotEqual(data["port"], 0)
                with _OPENER.open(data["url"], timeout=10) as resp:
                    self.assertEqual(resp.status, 200)
                    self.assertIn("Content-Security-Policy", resp.headers)
                # Without the token the page is still refused.
                bare = f"http://127.0.0.1:{data['port']}/"
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    _OPENER.open(bare, timeout=10)
                self.assertEqual(ctx.exception.code, 403)
                proc.stdin.close()
                self.assertEqual(proc.wait(timeout=20), 0)
                rest = proc.stdout.read().decode("utf-8")
                self.assertNotIn("网页界面已启动", rest)
                err = proc.stderr.read().decode("utf-8")
                self.assertIn("网页界面已启动", err)
                # stderr 的人类可读行不得带真实 token（桌面端会显示它）；
                # token 只应出现在 stdout 的 JSON 行里。
                self.assertNotIn(data["token"], err)
                self.assertIn("<redacted>", err)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(5)
                for pipe in (proc.stdout, proc.stderr):
                    pipe.close()


if __name__ == "__main__":
    unittest.main()
