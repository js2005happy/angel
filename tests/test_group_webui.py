"""Group chat HTTP APIs and JavaScript page smoke tests without API keys."""

import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from nyra import agent as agent_module, config as config_module, memory as memory_module
from nyra.groups import GroupStore
from nyra.webui import UIState, make_server


class RoomProvider:
    def __init__(self, bot):
        self.bot = bot

    def has_credentials(self):
        return True

    def chat(self, messages, tools=None, timeout=120):
        return {"choices": [{"message": {"content": self.bot.id + ": 已独立分析"}}]}


class GroupAPITest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.workdir = self.base / "work"
        self.workdir.mkdir()
        self.patchers = [
            patch.object(config_module, "NYRA_HOME", self.base / "home"),
            patch.object(agent_module, "NYRA_HOME", self.base / "home"),
            patch.object(memory_module, "SESSIONS_DIR", self.base / "home" / "sessions"),
        ]
        for p in self.patchers:
            p.start()
        self.state = UIState(self.workdir)
        self.state.groups.provider_factory = lambda bot: RoomProvider(bot)
        self.server = make_server("127.0.0.1", 0, self.state, warn_stream=io.StringIO())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        for p in reversed(self.patchers):
            p.stop()
        self.temp.cleanup()

    def fetch(self, path, body=None, token=True):
        headers = {"X-Nyra-Token": self.state.token} if token else {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.url + path,
            headers=headers,
            data=(json.dumps(body).encode("utf-8") if body is not None else None),
            method="POST" if body is not None else "GET",
        )
        try:
            result = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as exc:
            result = exc
        with result:
            return result.status, result.read(), result.headers

    def test_create_group_send_message_and_get_history(self):
        status, body, _ = self.fetch("/api/groups", {"id": "team", "name": "团队"})
        self.assertEqual(status, 201)
        self.assertEqual(len(json.loads(body)["bots"]), 4)
        status, body, _ = self.fetch("/api/groups")
        self.assertEqual(json.loads(body)["groups"][0]["id"], "team")
        status, body, _ = self.fetch("/api/groups/team/messages",
                                     {"text": "@lead 请给出任务计划", "rounds": 1})
        self.assertEqual(status, 200)
        self.assertEqual([m["sender"] for m in json.loads(body)["messages"]],
                         ["user", "lead"])
        status, body, _ = self.fetch("/api/groups/team")
        self.assertEqual(len(json.loads(body)["messages"]), 2)

    def test_access_requires_token_and_invalid_requests_are_rejected(self):
        self.assertEqual(self.fetch("/api/groups", token=False)[0], 403)
        self.assertEqual(self.fetch("/api/groups", {"id": "../bad", "name": "Bad"})[0], 400)
        self.fetch("/api/groups", {"id": "team", "name": "Team"})
        self.assertEqual(self.fetch("/api/groups/team/messages",
                                    {"text": "@nobody test"})[0], 400)
        self.assertEqual(self.fetch("/api/groups/team/messages",
                                    {"text": "hello", "rounds": 999})[0], 400)

    def test_external_js_asset_and_group_page(self):
        status, _, _ = self.fetch("/groups", token=False)
        self.assertEqual(status, 403)
        status, html, headers = self.fetch("/groups?token=" + self.state.token)
        self.assertEqual(status, 200)
        self.assertIn(b"/group-ui.js", html)
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
        status, js, headers = self.fetch("/group-ui.js", token=False)
        self.assertEqual(status, 200)
        self.assertIn(b"X-Nyra-Token", js)
        self.assertIn("javascript", headers["Content-Type"])


if __name__ == "__main__":
    unittest.main()
