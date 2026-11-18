"""Tests for the HTTP API server (`nyra/server.py`): JSON API + SSE stream.

Everything runs against a mock provider on a random local port; no model,
key or network access is needed.
"""

import http.client
import io
import json
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import nyra.agent as agent_module  # noqa: E402
import nyra.config as config_module  # noqa: E402
import nyra.memory as memory_module  # noqa: E402
from nyra import server as server_module  # noqa: E402


def reply(content="", calls=None):
    message = {"role": "assistant", "content": content}
    if calls:
        message["tool_calls"] = [
            {
                "id": f"call-{i}",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
            for i, (name, args) in enumerate(calls, start=1)
        ]
    return {"choices": [{"message": message}]}


class MockProvider:
    name = "mock"
    model = "mock-1"

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0

    def has_credentials(self):
        return True

    def chat(self, messages, tools=None, timeout=120):
        self.calls += 1
        if not self.responses:
            return reply("（没有更多脚本回复）")
        return self.responses.pop(0)


class BlockingProvider(MockProvider):
    """A mock provider whose chat() blocks until released (for 409 tests)."""

    def __init__(self, responses):
        super().__init__(responses)
        self.entered = threading.Event()
        self.release = threading.Event()

    def chat(self, messages, tools=None, timeout=120):
        self.calls += 1
        self.entered.set()
        self.release.wait(timeout=30)
        if not self.responses:
            return reply("（没有更多脚本回复）")
        return self.responses.pop(0)


# Never send requests through an environment proxy in these tests.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        home = Path(self.tmp.name) / "home"
        self.workdir = Path(self.tmp.name) / "work"
        self.workdir.mkdir()
        self.patches = [
            mock.patch.object(config_module, "NYRA_HOME", home),
            mock.patch.object(agent_module, "NYRA_HOME", home),
            mock.patch.object(memory_module, "SESSIONS_DIR", home / "sessions"),
            mock.patch.object(memory_module, "MEMORY_PATH", home / "MEMORY.md"),
            mock.patch.object(memory_module, "GLOBAL_AGENTS_PATH", home / "AGENTS.md"),
        ]
        for patch in self.patches:
            patch.start()
        self.home = home
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def start(self, responses=(), mode="auto", provider=None):
        self.provider = provider if provider is not None else MockProvider(responses)
        state = server_module.UIState(
            self.workdir, mode=mode, provider_factory=lambda: self.provider, max_turns=6
        )
        server = server_module.make_server(
            "127.0.0.1", 0, state, warn_stream=io.StringIO()
        )
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.servers.append(server)
        self.state = state
        self.base = f"http://127.0.0.1:{server.server_address[1]}"
        return server

    def request(self, path, method="GET", body=None, raw_body=None, token=True, headers=None):
        if raw_body is not None:
            data = raw_body
        elif body is None:
            data = None
        else:
            data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if token is True:
            req.add_header("X-Nyra-Token", self.state.token)
        elif token:
            req.add_header("X-Nyra-Token", token)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with _OPENER.open(req, timeout=10) as resp:
                raw = resp.read()
                return resp.status, raw, dict(resp.headers)
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            exc.close()
            return exc.code, raw, dict(exc.headers)

    def get_json(self, path, **kw):
        status, raw, _ = self.request(path, **kw)
        return status, json.loads(raw.decode("utf-8"))

    def wait_for(self, sid, predicate, timeout=10.0):
        deadline = time.time() + timeout
        view = None
        while time.time() < deadline:
            _, view = self.get_json(f"/api/sessions/{sid}/messages")
            if predicate(view):
                return view
            time.sleep(0.05)
        self.fail(f"timed out waiting; last view: {view}")

    def read_sse(self, path, token=True, timeout=15.0):
        """Open an SSE stream and read it to EOF; return (status, events, raw)."""
        host, port = self.base.rsplit(":", 1)
        port = int(port)
        host = host.split("://", 1)[1]
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        headers = {}
        if token is True:
            headers["X-Nyra-Token"] = self.state.token
        elif token:
            headers["X-Nyra-Token"] = token
        conn.request("GET", path, headers=headers)
        resp = conn.getresponse()
        status = resp.status
        ctype = resp.getheader("Content-Type")
        events = []
        raw_lines = []
        deadline = time.time() + timeout
        try:
            while time.time() < deadline:
                try:
                    line = resp.readline()
                except (socket.timeout, TimeoutError):
                    break
                if not line:
                    break
                raw_lines.append(line)
                text = line.decode("utf-8", "replace").rstrip("\n")
                if text.startswith("data: "):
                    events.append(json.loads(text[6:]))
        finally:
            conn.close()
        return status, ctype, events, raw_lines


class HealthTests(ApiTestCase):
    def test_health_needs_no_token(self):
        self.start()
        status, data = self.get_json("/api/health", token=False)
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertIn("version", data)

    def test_health_ignores_wrong_token(self):
        self.start()
        status, _ = self.get_json("/api/health", token="nope")
        self.assertEqual(status, 200)


class TokenTests(ApiTestCase):
    def test_missing_or_wrong_token_rejected(self):
        self.start()
        for path, method in (
            ("/api/sessions", "GET"),
            ("/api/sessions", "POST"),
            ("/api/sessions/20260101-000000-beef/messages", "GET"),
            ("/api/sessions/20260101-000000-beef/events", "GET"),
            ("/api/approvals/0123456789abcdef/decide", "POST"),
        ):
            self.assertEqual(self.request(path, method=method, token=False)[0], 403, path)
            self.assertEqual(self.request(path, method=method, token="nope")[0], 403, path)

    def test_query_token_not_accepted_for_api(self):
        self.start()
        status, _, _ = self.request(
            f"/api/sessions?token={self.state.token}", token=False
        )
        self.assertEqual(status, 403)


class HostAndCorsTests(ApiTestCase):
    def test_foreign_host_header_rejected(self):
        self.start()
        status, _, _ = self.request(
            "/api/health", headers={"Host": "evil.example:8766"}
        )
        self.assertEqual(status, 421)

    def test_cross_origin_preflight_refused(self):
        self.start()
        status, _, headers = self.request("/api/sessions", method="OPTIONS", token=False)
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_unknown_path_is_404(self):
        self.start()
        status, _, _ = self.request("/api/nope")
        self.assertEqual(status, 404)
        status, _, _ = self.request("/not-api")
        self.assertEqual(status, 404)


class SessionTests(ApiTestCase):
    def test_create_and_read_empty_session(self):
        self.start()
        status, created = self.get_json("/api/sessions", method="POST", body={})
        self.assertEqual(status, 201)
        sid = created["id"]
        self.assertRegex(sid, r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
        status, view = self.get_json(f"/api/sessions/{sid}/messages")
        self.assertEqual(status, 200)
        self.assertEqual(view["id"], sid)
        self.assertEqual(view["messages"], [])
        self.assertEqual(view["status"], "idle")
        self.assertEqual(view["events"], [])
        self.assertEqual(view["next"], 0)

    def test_invalid_session_id_rejected(self):
        self.start()
        # Single-segment ids that fail SESSION_ID_RE; multi-segment paths
        # are simply different routes (404), not invalid ids.
        for bad in ("a%20b", "a!b", "-abc", "x" * 81):
            status, _ = self.get_json(f"/api/sessions/{bad}/messages")
            self.assertEqual(status, 400, bad)

    def test_unknown_session_is_404(self):
        self.start()
        unknown = "20260101-000000-dead"
        status, _ = self.get_json(f"/api/sessions/{unknown}/messages")
        self.assertEqual(status, 404)
        status, _ = self.get_json(
            f"/api/sessions/{unknown}/send", method="POST", body={"text": "hi"}
        )
        self.assertEqual(status, 404)
        status, _, _, _ = self.read_sse(f"/api/sessions/{unknown}/events")
        self.assertEqual(status, 404)


class SendRoundTripTests(ApiTestCase):
    def test_send_returns_immediately_then_completes(self):
        self.start([reply("你好，我是 Nyra。")])
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        status, sent = self.get_json(
            f"/api/sessions/{sid}/send", method="POST", body={"text": "打个招呼"}
        )
        self.assertEqual(status, 202)
        self.assertEqual(sent["id"], sid)
        view = self.wait_for(sid, lambda v: v["status"] == "done")
        roles = [m["role"] for m in view["messages"]]
        self.assertEqual(roles, ["user", "assistant"])
        self.assertEqual(view["messages"][1]["content"], "你好，我是 Nyra。")
        self.assertEqual(view["messages"][0]["content"], "打个招呼")
        self.assertTrue((memory_module.SESSIONS_DIR / f"{sid}.jsonl").exists())

    def test_empty_message_rejected(self):
        self.start()
        _, created = self.get_json("/api/sessions", method="POST", body={})
        status, _ = self.get_json(
            f"/api/sessions/{created['id']}/send", method="POST", body={"text": "  "}
        )
        self.assertEqual(status, 400)

    def test_second_send_while_running_is_conflict(self):
        provider = BlockingProvider([reply("稍等片刻")])
        self.start(provider=provider)
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        status, _ = self.get_json(
            f"/api/sessions/{sid}/send", method="POST", body={"text": "第一句"}
        )
        self.assertEqual(status, 202)
        self.assertTrue(provider.entered.wait(timeout=10))
        status, _ = self.get_json(
            f"/api/sessions/{sid}/send", method="POST", body={"text": "第二句"}
        )
        self.assertEqual(status, 409)
        provider.release.set()
        view = self.wait_for(sid, lambda v: v["status"] == "done")
        self.assertEqual(view["messages"][-1]["content"], "稍等片刻")


class SSETests(ApiTestCase):
    def test_stream_delivers_events_after_connect(self):
        self.start([reply("流式答复")])
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        result = {}

        def _read():
            result["out"] = self.read_sse(f"/api/sessions/{sid}/events")

        thread = threading.Thread(target=_read, daemon=True)
        thread.start()
        time.sleep(0.3)  # let the stream open while the session is idle
        status, _ = self.get_json(
            f"/api/sessions/{sid}/send", method="POST", body={"text": "你好"}
        )
        self.assertEqual(status, 202)
        thread.join(timeout=15)
        self.assertFalse(thread.is_alive(), "SSE stream did not end after the run")
        status, ctype, events, _ = result["out"]
        self.assertEqual(status, 200)
        self.assertIn("text/event-stream", ctype)
        types = [e["type"] for e in events]
        self.assertIn("user", types)
        self.assertIn("final", types)
        self.assertEqual(events[-1]["type"], "run_finished")
        self.assertEqual(events[-1]["data"]["status"], "done")
        user = [e for e in events if e["type"] == "user"][0]
        self.assertEqual(user["data"]["content"], "你好")
        seqs = [e.get("seq") for e in events if "seq" in e]
        self.assertEqual(seqs, sorted(seqs))

    def test_missed_events_replayed_from_cursor(self):
        self.start([reply("已完成的答复")])
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        self.get_json(
            f"/api/sessions/{sid}/send", method="POST", body={"text": "先跑完"}
        )
        view = self.wait_for(sid, lambda v: v["status"] == "done")
        total = view["next"]
        self.assertGreater(total, 0)
        # Full replay from the start.
        _, _, events, _ = self.read_sse(f"/api/sessions/{sid}/events?since=0")
        live = [e for e in events if e["type"] != "run_finished"]
        self.assertEqual(len(live), total)
        self.assertEqual(events[-1]["type"], "run_finished")
        # Already caught up: only the terminal event.
        _, _, events, _ = self.read_sse(f"/api/sessions/{sid}/events?since={total}")
        self.assertEqual([e["type"] for e in events], ["run_finished"])
        # A bad cursor falls back to the start.
        _, _, events, _ = self.read_sse(f"/api/sessions/{sid}/events?since=abc")
        self.assertEqual(len([e for e in events if e["type"] != "run_finished"]), total)

    def test_sse_requires_token_and_known_session(self):
        self.start()
        status, _, _, _ = self.read_sse("/api/sessions/20260101-000000-beef/events", token=False)
        self.assertEqual(status, 403)
        status, _, _, _ = self.read_sse("/api/sessions/20260101-000000-beef/events", token="nope")
        self.assertEqual(status, 403)


class ApprovalTests(ApiTestCase):
    def _run_write(self, approve):
        self.start([
            reply("先写文件", [("write_file", {"path": "api.txt", "content": "hi"})]),
            reply("完成"),
        ])
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        self.get_json(f"/api/sessions/{sid}/send", method="POST", body={"text": "写文件"})
        view = self.wait_for(sid, lambda v: v["pending"] is not None)
        pending = view["pending"]
        self.assertEqual(pending["tool"], "write_file")
        status, _ = self.get_json(
            f"/api/approvals/{pending['id']}/decide", method="POST", body={"approve": approve}
        )
        self.assertEqual(status, 200)
        return self.wait_for(sid, lambda v: v["status"] == "done")

    def test_approve_runs_tool(self):
        view = self._run_write(True)
        self.assertEqual((self.workdir / "api.txt").read_text(encoding="utf-8"), "hi")
        tool_msgs = [m for m in view["messages"] if m["role"] == "tool"]
        self.assertFalse(tool_msgs[0]["content"].startswith("错误"))

    def test_deny_blocks_tool(self):
        view = self._run_write(False)
        self.assertFalse((self.workdir / "api.txt").exists())
        tool_msgs = [m for m in view["messages"] if m["role"] == "tool"]
        self.assertIn("用户拒绝执行", tool_msgs[0]["content"])

    def test_unknown_approval_id_is_404(self):
        self.start()
        status, _ = self.get_json(
            "/api/approvals/0123456789abcdef/decide", method="POST", body={"approve": True}
        )
        self.assertEqual(status, 404)
        status, _ = self.get_json(
            "/api/approvals/not-hex/decide", method="POST", body={"approve": True}
        )
        self.assertEqual(status, 404)


class MalformedRequestTests(ApiTestCase):
    def test_malformed_json_returns_400_and_server_survives(self):
        self.start()
        status, _, _ = self.request(
            "/api/sessions", method="POST", raw_body=b"{not json"
        )
        self.assertEqual(status, 400)
        status, _, _ = self.request(
            "/api/sessions", method="POST", raw_body=b"[1, 2]"
        )
        self.assertEqual(status, 400)
        status, data = self.get_json("/api/health", token=False)
        self.assertEqual((status, data["ok"]), (200, True))
        # The next well-formed request still works.
        status, created = self.get_json("/api/sessions", method="POST", body={})
        self.assertEqual(status, 201)
        self.assertIn("id", created)

    def test_missing_text_field_is_400(self):
        self.start()
        _, created = self.get_json("/api/sessions", method="POST", body={})
        status, _ = self.get_json(
            f"/api/sessions/{created['id']}/send", method="POST", body={}
        )
        self.assertEqual(status, 400)

    def test_negative_content_length_is_400_and_server_survives(self):
        # 负 Content-Length 会让旧代码 rfile.read(-5) 读到连接关闭
        # （挂起）；现在必须立刻 400，且服务仍可用。
        self.start()
        host, port = self.base.rsplit(":", 1)
        host = host.split("://", 1)[1]
        port = int(port)
        sock = socket.create_connection((host, port), timeout=5)
        try:
            sock.sendall(
                (
                    "POST /api/sessions HTTP/1.1\r\n"
                    f"Host: 127.0.0.1:{port}\r\n"
                    f"X-Nyra-Token: {self.state.token}\r\n"
                    "Content-Type: application/json\r\n"
                    "Content-Length: -5\r\n"
                    "Connection: close\r\n\r\n"
                ).encode("utf-8")
            )
            sock.settimeout(5)
            raw = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                raw += chunk
        finally:
            sock.close()
        self.assertTrue(raw.startswith(b"HTTP/1.1 400"), raw[:100])
        status, data = self.get_json("/api/health", token=0)
        self.assertEqual((status, data["ok"]), (200, True))


class ConcurrencyTests(ApiTestCase):
    def test_concurrent_sessions_do_not_interfere(self):
        self.start([reply("答复一"), reply("答复二")])
        _, first = self.get_json("/api/sessions", method="POST", body={})
        _, second = self.get_json("/api/sessions", method="POST", body={})
        sid1, sid2 = first["id"], second["id"]

        def _send(sid, text):
            self.get_json(
                f"/api/sessions/{sid}/send", method="POST", body={"text": text}
            )

        threads = [
            threading.Thread(target=_send, args=(sid1, "第一"), daemon=True),
            threading.Thread(target=_send, args=(sid2, "第二"), daemon=True),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        view1 = self.wait_for(sid1, lambda v: v["status"] == "done")
        view2 = self.wait_for(sid2, lambda v: v["status"] == "done")
        self.assertEqual([m["content"] for m in view1["messages"] if m["role"] == "user"], ["第一"])
        self.assertEqual([m["content"] for m in view2["messages"] if m["role"] == "user"], ["第二"])
        replies = {
            view1["messages"][-1]["content"],
            view2["messages"][-1]["content"],
        }
        self.assertEqual(replies, {"答复一", "答复二"})


if __name__ == "__main__":
    unittest.main()
