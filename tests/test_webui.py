"""Tests for the local web UI (`python3 -m nyra ui`).

Everything runs against a mock provider on a random local port; no model,
key or network access is needed.
"""

import io
import json
import os
import re
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
from nyra import webui  # noqa: E402
from nyra.memory import save_session  # noqa: E402


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


class ScriptedProvider:
    """A fake provider whose scripted outcomes may raise ProviderError."""

    def __init__(self, name, model, outcomes):
        self.name = name
        self.model = model
        self.base_url = f"https://{name}.example.com/v1"
        self.outcomes = list(outcomes)
        self.calls = 0

    def has_credentials(self):
        return True

    def chat(self, messages, tools=None, timeout=120):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


# Never send requests through an environment proxy in these tests.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class WebUITestCase(unittest.TestCase):
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

    def start(self, responses=(), mode="auto"):
        self.provider = MockProvider(responses)
        state = webui.UIState(
            self.workdir, mode=mode, provider_factory=lambda: self.provider, max_turns=6
        )
        server = webui.make_server("127.0.0.1", 0, state, warn_stream=io.StringIO())
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.servers.append(server)
        self.state = state
        self.base = f"http://127.0.0.1:{server.server_address[1]}"
        return server

    def request(self, path, method="GET", body=None, token=True, headers=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
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
            _, view = self.get_json(f"/api/sessions/{sid}")
            if predicate(view):
                return view
            time.sleep(0.05)
        self.fail(f"timed out waiting; last view: {view}")


class TokenAndHostTests(WebUITestCase):
    def test_page_requires_token(self):
        self.start()
        status, raw, _ = self.request("/", token=False)
        self.assertEqual(status, 403)
        self.assertNotIn(self.state.token, raw.decode("utf-8"))
        status, raw, headers = self.request(f"/?token={self.state.token}", token=False)
        self.assertEqual(status, 200)
        self.assertIn("Nyra", raw.decode("utf-8"))
        self.assertIn("default-src 'none'", headers.get("Content-Security-Policy", ""))
        self.assertEqual(headers.get("Referrer-Policy"), "no-referrer")

    def test_api_rejects_missing_or_wrong_token(self):
        self.start()
        self.assertEqual(self.request("/api/sessions", token=False)[0], 403)
        self.assertEqual(self.request("/api/sessions", token="nope")[0], 403)
        # The token in the query string is accepted only for the page itself.
        status, _, _ = self.request(f"/api/sessions?token={self.state.token}", token=False)
        self.assertEqual(status, 403)
        self.assertEqual(
            self.request("/api/sessions", method="POST", body={}, token="nope")[0], 403
        )
        self.assertEqual(self.request("/api/sessions")[0], 200)

    def test_tokens_are_random_per_launch(self):
        a = webui.UIState(self.workdir)
        b = webui.UIState(self.workdir)
        self.assertNotEqual(a.token, b.token)
        self.assertGreaterEqual(len(a.token), 24)

    def test_default_provider_uses_fallback_chain(self):
        from types import SimpleNamespace

        from nyra.providers import FallbackProvider, ProviderError

        primary = ScriptedProvider(
            "deepseek", "deepseek-flash",
            [ProviderError("余额不足", status=402, kind="quota")],
        )
        backup = ScriptedProvider("xai", "grok-4.3", [reply("备用模型答复")])
        fakes = {"deepseek": primary, "xai": backup}
        config = {
            "fallback_enabled": True,
            "fallback_providers": ["xai"],
            "profiles": {},
        }

        class _ProviderFactory:
            """Stand-in for webui.Provider: returns scripted fakes by name.

            A real class (not a Mock) so info()'s isinstance check keeps
            working while the wiring under test stays real.
            """

            def __new__(cls, cfg):
                return fakes[cfg.name]

        with mock.patch.object(webui, "load_config", return_value=config), \
            mock.patch.object(webui, "resolve_profile", return_value={
                "provider": "deepseek", "model": "deepseek-flash", "mode": "auto",
            }), \
            mock.patch.object(webui, "resolve_provider", side_effect=(
                lambda name, model=None: SimpleNamespace(
                    name=name, model=model or f"{name}-model")
            )), \
            mock.patch.object(webui, "Provider", new=_ProviderFactory):
            state = webui.UIState(self.workdir, mode="auto", max_turns=6)
            provider = state.provider()
            self.assertIsInstance(provider, FallbackProvider)
            result = provider.chat([{"role": "user", "content": "hi"}])
            self.assertEqual(result["choices"][0]["message"]["content"], "备用模型答复")
            self.assertEqual(primary.calls, 1)
            self.assertEqual(backup.calls, 1)
            # info() names the provider that actually answered, and
            # surfaces the switch instead of implying the primary did.
            info = state.info()
            self.assertEqual(info["provider"], "xai")
            self.assertEqual(info["model"], "grok-4.3")
            self.assertEqual(len(info.get("model_switches", [])), 1)
            self.assertEqual(info["model_switches"][0]["from"], "deepseek")
            self.assertEqual(info["model_switches"][0]["to"], "xai")

    def test_default_provider_does_not_switch(self):
        from types import SimpleNamespace

        from nyra.providers import FallbackProvider, ProviderError

        primary = ScriptedProvider(
            "deepseek", "deepseek-flash",
            [ProviderError("余额不足", status=402, kind="quota")],
        )
        backup = ScriptedProvider("xai", "grok-4.3", [reply("备用模型答复")])
        fakes = {"deepseek": primary, "xai": backup}
        # No fallback_enabled key: the default is off.
        config = {"fallback_providers": ["xai"], "profiles": {}}

        class _ProviderFactory:
            def __new__(cls, cfg):
                return fakes[cfg.name]

        with mock.patch.object(webui, "load_config", return_value=config), \
            mock.patch.object(webui, "resolve_profile", return_value={
                "provider": "deepseek", "model": "deepseek-flash", "mode": "auto",
            }), \
            mock.patch.object(webui, "resolve_provider", side_effect=(
                lambda name, model=None: SimpleNamespace(
                    name=name, model=model or f"{name}-model")
            )), \
            mock.patch.object(webui, "Provider", new=_ProviderFactory):
            state = webui.UIState(self.workdir, mode="auto", max_turns=6)
            provider = state.provider()
            self.assertNotIsInstance(provider, FallbackProvider)
            with self.assertRaises(ProviderError):
                provider.chat([{"role": "user", "content": "hi"}])
            self.assertEqual(primary.calls, 1)
            self.assertEqual(backup.calls, 0)

    def test_model_switch_event_appears_in_session_poll(self):
        from types import SimpleNamespace

        from nyra.providers import ProviderError

        primary = ScriptedProvider(
            "deepseek", "deepseek-flash",
            [ProviderError("余额不足", status=402, kind="quota")],
        )
        backup = ScriptedProvider("xai", "grok-4.3", [reply("备用模型答复")])
        fakes = {"deepseek": primary, "xai": backup}
        config = {
            "fallback_enabled": True,
            "fallback_providers": ["xai"],
            "profiles": {},
        }

        class _ProviderFactory:
            def __new__(cls, cfg):
                return fakes[cfg.name]

        with mock.patch.object(webui, "load_config", return_value=config), \
            mock.patch.object(webui, "resolve_profile", return_value={
                "provider": "deepseek", "model": "deepseek-flash", "mode": "auto",
            }), \
            mock.patch.object(webui, "resolve_provider", side_effect=(
                lambda name, model=None: SimpleNamespace(
                    name=name, model=model or f"{name}-model")
            )), \
            mock.patch.object(webui, "Provider", new=_ProviderFactory):
            state = webui.UIState(self.workdir, mode="auto", max_turns=6)
            server = webui.make_server(
                "127.0.0.1", 0, state, warn_stream=io.StringIO()
            )
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.servers.append(server)
            self.state = state
            self.base = f"http://127.0.0.1:{server.server_address[1]}"
            status, created = self.get_json("/api/sessions", method="POST", body={})
            self.assertEqual(status, 201)
            sid = created["id"]
            status, _ = self.get_json(
                f"/api/sessions/{sid}/messages",
                method="POST", body={"text": "打个招呼"},
            )
            self.assertEqual(status, 202)
            view = self.wait_for(sid, lambda v: v["status"] == "done")
            switches = [
                e for e in view["events"] if e["type"] == "model_switch"
            ]
            self.assertEqual(len(switches), 1)
            self.assertEqual(switches[0]["data"]["from"], "deepseek")
            self.assertEqual(switches[0]["data"]["to"], "xai")
            self.assertEqual(
                view["messages"][1]["content"], "备用模型答复"
            )

    def test_foreign_host_header_rejected(self):
        self.start()
        status, _, _ = self.request("/api/sessions", headers={"Host": "evil.example:8765"})
        self.assertEqual(status, 421)

    def test_cross_origin_preflight_refused(self):
        self.start()
        status, _, headers = self.request("/api/sessions", method="OPTIONS", token=False)
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)


class BindWarningTests(WebUITestCase):
    def test_non_loopback_bind_warns(self):
        state = webui.UIState(self.workdir)
        stream = io.StringIO()
        server = webui.make_server("0.0.0.0", 0, state, warn_stream=stream)
        server.server_close()
        self.assertIn("警告", stream.getvalue())
        self.assertIn("0.0.0.0", stream.getvalue())

    def test_loopback_bind_is_quiet(self):
        state = webui.UIState(self.workdir)
        stream = io.StringIO()
        server = webui.make_server("127.0.0.1", 0, state, warn_stream=stream)
        server.server_close()
        self.assertEqual(stream.getvalue(), "")

    def test_is_loopback_host(self):
        for host in ("127.0.0.1", "localhost", "::1", "127.0.0.2"):
            self.assertTrue(webui.is_loopback_host(host), host)
        for host in ("0.0.0.0", "", "192.168.1.5", "example.com"):
            self.assertFalse(webui.is_loopback_host(host), host)

    def test_default_host_is_loopback(self):
        args = webui.build_parser().parse_args([])
        self.assertEqual(args.host, "127.0.0.1")
        self.assertEqual(args.port, 8765)
        self.assertFalse(args.open)


class SessionApiTests(WebUITestCase):
    def test_lists_existing_sessions(self):
        save_session("20260101-000000-abcd", [{"role": "user", "content": "旧任务"}])
        self.start()
        status, data = self.get_json("/api/sessions")
        self.assertEqual(status, 200)
        ids = [s["id"] for s in data["sessions"]]
        self.assertIn("20260101-000000-abcd", ids)
        status, view = self.get_json("/api/sessions/20260101-000000-abcd")
        self.assertEqual(view["messages"][0]["content"], "旧任务")

    def test_rejects_bad_session_id(self):
        self.start()
        status, _ = self.get_json("/api/sessions/..%2F..%2Fetc")
        self.assertEqual(status, 400)
        status, _ = self.get_json(
            "/api/sessions/..%2Fx/messages", method="POST", body={"text": "hi"}
        )
        self.assertEqual(status, 400)

    def test_send_message_with_mock_provider(self):
        self.start([reply("你好，我是 Nyra。")])
        status, created = self.get_json("/api/sessions", method="POST", body={})
        self.assertEqual(status, 201)
        sid = created["id"]
        status, sent = self.get_json(
            f"/api/sessions/{sid}/messages", method="POST", body={"text": "打个招呼"}
        )
        self.assertEqual(status, 202)
        view = self.wait_for(sid, lambda v: v["status"] == "done")
        roles = [m["role"] for m in view["messages"]]
        self.assertEqual(roles, ["user", "assistant"])
        self.assertEqual(view["messages"][1]["content"], "你好，我是 Nyra。")
        self.assertTrue((memory_module.SESSIONS_DIR / f"{sid}.jsonl").exists())
        _, listed = self.get_json("/api/sessions")
        self.assertIn(sid, [s["id"] for s in listed["sessions"]])

    def test_resume_existing_session_keeps_history(self):
        save_session("20260101-000000-beef", [
            {"role": "user", "content": "第一句"},
            {"role": "assistant", "content": "收到"},
        ])
        self.start([reply("继续")])
        self.get_json(
            "/api/sessions/20260101-000000-beef/messages", method="POST", body={"text": "第二句"}
        )
        view = self.wait_for("20260101-000000-beef", lambda v: v["status"] == "done")
        self.assertEqual(
            [m["content"] for m in view["messages"]], ["第一句", "收到", "第二句", "继续"]
        )

    def test_empty_message_rejected(self):
        self.start()
        _, created = self.get_json("/api/sessions", method="POST", body={})
        status, _ = self.get_json(
            f"/api/sessions/{created['id']}/messages", method="POST", body={"text": "  "}
        )
        self.assertEqual(status, 400)


class ApprovalTests(WebUITestCase):
    def _run_write(self, approve):
        self.start([
            reply("先写文件", [("write_file", {"path": "ui.txt", "content": "hi"})]),
            reply("完成"),
        ])
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        self.get_json(f"/api/sessions/{sid}/messages", method="POST", body={"text": "写文件"})
        view = self.wait_for(sid, lambda v: v["pending"] is not None)
        pending = view["pending"]
        self.assertEqual(pending["tool"], "write_file")
        self.assertIn("ui.txt", pending["summary"])
        types = [e["type"] for e in view["events"]]
        self.assertIn("tool_start", types)
        self.assertIn("approval", types)
        status, _ = self.get_json(
            f"/api/approvals/{pending['id']}", method="POST", body={"approve": approve}
        )
        self.assertEqual(status, 200)
        return self.wait_for(sid, lambda v: v["status"] == "done")

    def test_approve_runs_tool(self):
        view = self._run_write(True)
        self.assertEqual((self.workdir / "ui.txt").read_text(encoding="utf-8"), "hi")
        tool_msgs = [m for m in view["messages"] if m["role"] == "tool"]
        self.assertFalse(tool_msgs[0]["content"].startswith("错误"))

    def test_deny_blocks_tool(self):
        view = self._run_write(False)
        self.assertFalse((self.workdir / "ui.txt").exists())
        tool_msgs = [m for m in view["messages"] if m["role"] == "tool"]
        self.assertIn("用户拒绝执行", tool_msgs[0]["content"])

    def test_unknown_approval_id(self):
        self.start()
        status, _ = self.get_json(
            "/api/approvals/0123456789abcdef", method="POST", body={"approve": True}
        )
        self.assertEqual(status, 404)

    def test_readonly_mode_never_asks(self):
        self.start([
            reply("", [("write_file", {"path": "no.txt", "content": "x"})]),
            reply("好"),
        ], mode="readonly")
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        self.get_json(f"/api/sessions/{sid}/messages", method="POST", body={"text": "写"})
        view = self.wait_for(sid, lambda v: v["status"] == "done")
        self.assertFalse((self.workdir / "no.txt").exists())
        self.assertNotIn("approval", [e["type"] for e in view["events"]])

    def test_mode_switch_api(self):
        self.start()
        status, data = self.get_json("/api/mode", method="POST", body={"mode": "full"})
        self.assertEqual((status, data["mode"]), (200, "full"))
        status, _ = self.get_json("/api/mode", method="POST", body={"mode": "root"})
        self.assertEqual(status, 400)


class InfoAndPageTests(WebUITestCase):
    def test_info_never_echoes_key(self):
        secret = "sk-test-SECRET-value-123456"
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": secret}):
            self.start()
            status, raw, _ = self.request("/api/info")
        self.assertEqual(status, 200)
        text = raw.decode("utf-8")
        self.assertNotIn(secret, text)
        info = json.loads(text)
        deepseek = [k for k in info["keys"] if k["provider"] == "deepseek"][0]
        self.assertTrue(deepseek["configured"])
        self.assertEqual(info["provider"], "mock")

    def test_page_has_no_external_resources(self):
        html_text = webui.PAGE_HTML
        self.assertTrue(html_text.strip().startswith("<!doctype html>"))
        self.assertIsNone(re.search(r"""(src|href)\s*=\s*["']?\s*(https?:)?//""", html_text, re.I))
        self.assertIsNone(re.search(r"@import|url\(\s*['\"]?(https?:)?//", html_text, re.I))
        self.assertNotRegex(html_text, r"<link\b")
        self.assertNotRegex(html_text, r"<script[^>]+src=")

    def test_evidence_and_plan_in_view(self):
        sid = "20260101-000000-cafe"
        ev_dir = self.home / "evidence" / sid
        ev_dir.mkdir(parents=True)
        (ev_dir / "001_web_fetch_example-com.md").write_text(
            "# 证据 1\n\n- 来源：https://example.com/\n- 抓取时间：2026-01-01 00:00:00\n- 类型：web_fetch\n\n正文",
            encoding="utf-8",
        )
        save_session(sid, [
            {"role": "user", "content": "查"},
            {"role": "assistant", "content": "", "tool_calls": [{
                "id": "c1", "type": "function",
                "function": {"name": "plan", "arguments": json.dumps({"title": "调研", "steps": ["搜索", "核对"]})},
            }]},
            {"role": "tool", "tool_call_id": "c1", "content": "已写入计划 plan.md（2 步）"},
            {"role": "assistant", "content": "完成"},
        ])
        self.start()
        _, view = self.get_json(f"/api/sessions/{sid}")
        self.assertEqual(view["evidence"][0]["source"], "https://example.com/")
        self.assertEqual(view["evidence"][0]["kind"], "web_fetch")
        self.assertEqual(view["plan"]["title"], "调研")
        self.assertEqual(view["plan"]["steps"], ["搜索", "核对"])
        self.assertEqual(view["plan"]["state"], "finished")

    def test_list_evidence_missing_dir_creates_nothing(self):
        self.assertEqual(webui.list_evidence("20260101-000000-0000"), [])
        self.assertFalse((self.home / "evidence" / "20260101-000000-0000").exists())


class UIv2Tests(WebUITestCase):
    """UI v2: new sage-green palette, plush mascot, 14 providers / 15 tools."""

    def test_info_includes_providers_tools_skills(self):
        self.start()
        status, info = self.get_json("/api/info")
        self.assertEqual(status, 200)
        self.assertEqual(info["provider_count"], 14)
        self.assertEqual(len(info["providers"]), 14)
        self.assertEqual(
            {p["name"] for p in info["providers"]},
            {"deepseek", "xai", "openrouter", "ollama", "openai", "qwen",
             "kimi", "glm", "gemini", "mistral", "groq", "together", "custom",
             "codex"},
        )
        self.assertEqual(info["tool_count"], 15)
        self.assertEqual(len(info["tools"]), 15)
        by_name = {t["name"]: t for t in info["tools"]}
        for name in ("write_file", "edit_file", "apply_patch", "shell",
                     "http_post", "memory_append", "save_skill", "plan"):
            self.assertTrue(by_name[name]["needs_approval"], name)
        for name in ("read_file", "list_dir", "web_fetch", "web_search",
                     "grep_search", "git_status", "delegate"):
            self.assertFalse(by_name[name]["needs_approval"], name)
        self.assertEqual(
            {s["name"] for s in info["skills"]},
            {"file-organizer", "verify-research", "web-research"},
        )

    def test_page_uses_new_palette_and_mascot(self):
        html_text = webui.PAGE_HTML
        # New palette tokens (light + dark).
        for token in ("#F3F5F4", "#5F7D5C", "#6B8CAE", "#E07856", "#1F2420"):
            self.assertIn(token, html_text, token)
        # Old ink/gold brand colours are retired: they must not appear as
        # actual CSS values. They may still be named in the brand view's
        # "retired" usage rule, which explicitly says not to use them.
        style = re.search(r"<style>(.*?)</style>", html_text, re.S).group(1)
        self.assertNotIn("#111A42", style)
        self.assertNotIn("#EAC45F", style)
        self.assertIn("已退役", html_text)
        # Mascot is embedded as a data URI (self-contained, no external image).
        self.assertIn("data:image/jpeg;base64,", html_text)
        self.assertNotIn("MASCOT_BUNNY", html_text)
        # Six views exist in the page.
        for view in ("view-chat", "view-skills", "view-schedule",
                     "view-group", "view-brand", "view-settings"):
            self.assertIn(view, html_text, view)

    def test_schedule_endpoints(self):
        import nyra.scheduler as scheduler_module

        with mock.patch.object(
            scheduler_module, "SCHEDULE_PATH", self.home / "schedule.json"
        ):
            self.start()
            status, data = self.get_json("/api/schedule")
            self.assertEqual((status, data["tasks"]), (200, []))
            # Web add is paused until the task queue (E) merges: 409,
            # and nothing is stored.
            status, body = self.get_json("/api/schedule", method="POST", body={
                "action": "add",
                "task": {"name": "t1", "prompt": "做点事", "at": "09:00"},
            })
            self.assertEqual(status, 409)
            self.assertIn("暂缓开放", body.get("error", ""))
            status, data = self.get_json("/api/schedule")
            self.assertEqual(data["tasks"], [])
            # Toggle/remove/list still work for tasks added another way
            # (e.g. `nyra schedule add`).
            data = scheduler_module.load_schedule()
            scheduler_module.add_task(
                data, {"name": "t1", "prompt": "做点事", "at": "09:00"}
            )
            scheduler_module.save_schedule(data)
            status, toggled = self.get_json("/api/schedule", method="POST", body={
                "action": "toggle", "name": "t1",
            })
            self.assertEqual(status, 200)
            self.assertFalse(toggled["task"]["enabled"])
            status, removed = self.get_json("/api/schedule", method="POST", body={
                "action": "remove", "name": "t1",
            })
            self.assertEqual((status, removed["ok"]), (200, True))
            status, data = self.get_json("/api/schedule")
            self.assertEqual(data["tasks"], [])
            status, _ = self.get_json("/api/schedule", method="POST", body={
                "action": "remove", "name": "nope",
            })
            self.assertEqual(status, 404)

    def test_group_page_reskinned(self):
        self.start()
        status, raw, _ = self.request("/groups")
        self.assertEqual(status, 200)
        html_text = raw.decode("utf-8")
        for token in ("#F3F5F4", "#5F7D5C", "#E07856"):
            self.assertIn(token, html_text, token)
        self.assertNotIn("#EAC45F", html_text)
        self.assertNotIn("#0b1128", html_text)
        self.assertIn("data:image/jpeg;base64,", html_text)
        self.assertIsNone(re.search(
            r"""(src|href)\s*=\s*["']?\s*(https?:)?//""", html_text, re.I
        ))

    def test_group_js_lists_all_providers(self):
        self.start()
        status, raw, _ = self.request("/group-ui.js")
        self.assertEqual(status, 200)
        js = raw.decode("utf-8")
        for name in ("deepseek", "xai", "openrouter", "ollama", "openai",
                     "qwen", "kimi", "glm", "gemini", "mistral", "groq",
                     "together", "custom"):
            self.assertIn(f'"{name}"', js, name)
        self.assertIn("/api/info", js)

    def test_info_lists_models_and_fallback_chain(self):
        self.start()
        status, info = self.get_json("/api/info")
        self.assertEqual(status, 200)
        by_name = {p["name"]: p for p in info["providers"]}
        self.assertEqual(
            by_name["deepseek"]["models"], ["deepseek-flash", "deepseek-v4-pro"])
        self.assertEqual(by_name["ollama"]["models"], ["qwen2.5:7b"])
        self.assertEqual(by_name["custom"]["models"], [])
        # Injected mock factory: single provider, chain is just itself.
        self.assertEqual(info["fallback_chain"], ["mock"])

    def test_info_keys_include_custom_providers(self):
        self.home.mkdir(parents=True, exist_ok=True)
        (self.home / "config.json").write_text(json.dumps({
            "custom_providers": {
                "myllm": {
                    "base_url": "https://llm.example.com/v1",
                    "default_model": "myllm-1",
                    "env_key": "MYLLM_API_KEY",
                    "models": ["myllm-1"],
                },
            },
        }), encoding="utf-8")
        self.start()
        status, info = self.get_json("/api/info")
        self.assertEqual(status, 200)
        self.assertEqual(info["provider_count"], 15)
        by_name = {p["name"]: p for p in info["providers"]}
        self.assertEqual(by_name["myllm"]["models"], ["myllm-1"])
        keys = {k["provider"]: k for k in info["keys"]}
        self.assertIn("myllm", keys)
        self.assertEqual(keys["myllm"]["env"], "MYLLM_API_KEY")
        self.assertFalse(keys["myllm"]["configured"])
        self.assertTrue(keys["myllm"]["needs_key"])

    def test_settings_view_has_usable_provider_controls(self):
        html_text = webui.PAGE_HTML
        # Provider select is enabled now (was disabled in v2.0), with a
        # model input, an apply button and a status line.
        self.assertIn('id="provider-select"', html_text)
        self.assertNotIn('id="provider-select" disabled', html_text)
        self.assertIn('id="model-input"', html_text)
        self.assertIn('id="apply-provider"', html_text)
        self.assertIn('id="provider-status"', html_text)
        self.assertIn("已有会话保持原 provider", html_text)
        # Schedule add form is paused until the task queue (E) merges:
        # no form in the page, a notice instead.
        self.assertNotIn('id="sched-form"', html_text)
        self.assertNotIn('id="sched-provider"', html_text)
        self.assertNotIn('id="sched-model"', html_text)
        self.assertIn("暂缓开放", html_text)
        self.assertIn("任务队列合并", html_text)
        # Group "open" links carry the room id for deep-linking.
        self.assertIn("&room=", html_text)

    def test_group_js_opens_room_from_query(self):
        self.start()
        status, raw, _ = self.request("/group-ui.js")
        self.assertEqual(status, 200)
        js = raw.decode("utf-8")
        self.assertIn('get("room")', js)
        self.assertIn("activeId = roomParam", js)

    def test_schedule_add_with_provider_and_model(self):
        import nyra.scheduler as scheduler_module

        with mock.patch.object(
            scheduler_module, "SCHEDULE_PATH", self.home / "schedule.json"
        ):
            self.start()
            # Web add is paused until the task queue (E) merges, even
            # with provider/model attached: 409, nothing stored.
            status, body = self.get_json("/api/schedule", method="POST", body={
                "action": "add",
                "task": {"name": "t2", "prompt": "做点事", "at": "09:00",
                         "provider": "ollama", "model": "qwen2.5:7b"},
            })
            self.assertEqual(status, 409)
            self.assertIn("暂缓开放", body.get("error", ""))
            status, data = self.get_json("/api/schedule")
            self.assertEqual(data["tasks"], [])
            # Provider/model still round-trip when the task is added
            # another way (e.g. `nyra schedule add`).
            stored = scheduler_module.load_schedule()
            scheduler_module.add_task(
                stored, {"name": "t2", "prompt": "做点事", "at": "09:00",
                         "provider": "ollama", "model": "qwen2.5:7b"}
            )
            scheduler_module.save_schedule(stored)
            status, data = self.get_json("/api/schedule")
            self.assertEqual(data["tasks"][0]["provider"], "ollama")
            self.assertEqual(data["tasks"][0]["model"], "qwen2.5:7b")


class ProviderSwitchTests(WebUITestCase):
    """POST /api/provider switches the provider for new sessions."""

    def test_switch_provider_via_api(self):
        self.start()
        status, switched = self.get_json("/api/provider", method="POST", body={
            "provider": "ollama", "model": "qwen2.5:7b",
        })
        self.assertEqual(status, 200)
        self.assertEqual(switched["provider"], "ollama")
        self.assertEqual(switched["model"], "qwen2.5:7b")
        self.assertEqual(self.state.provider_name, "ollama")
        self.assertEqual(self.state.model, "qwen2.5:7b")
        # Unknown provider and missing provider are rejected.
        status, _ = self.get_json("/api/provider", method="POST", body={
            "provider": "no-such-provider",
        })
        self.assertEqual(status, 400)
        status, _ = self.get_json("/api/provider", method="POST", body={})
        self.assertEqual(status, 400)

    def test_switch_provider_unit_without_factory(self):
        # No injected factory: provider() really builds the new chain.
        state = webui.UIState(self.workdir)
        switched = state.set_provider("ollama", "qwen2.5:7b")
        self.assertEqual(switched, {"provider": "ollama", "model": "qwen2.5:7b"})
        self.assertEqual(state.provider().name, "ollama")
        self.assertEqual(state.provider().model, "qwen2.5:7b")
        info = state.info()
        self.assertEqual(info["provider"], "ollama")
        self.assertIn("ollama", info["fallback_chain"])
        self.assertEqual(info["fallback_chain"][0], "ollama")
        with self.assertRaises(ValueError):
            state.set_provider("no-such-provider")


if __name__ == "__main__":
    unittest.main()
