"""Versioned persistent memory browser and local API security regressions."""

from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
from urllib.parse import quote

import angel.agent as agent_module
import angel.memory as memory_module
from angel.agent import Agent
from angel.memory_browser import (
    MemoryBrowserError, MemoryConflict, inspect_memory, replace_memory,
)
from angel.webui_page import PAGE_HTML
from tests.test_webui import WebUITestCase


class MemoryStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root / "MEMORY.md"

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_memory_can_be_saved_and_read_with_sha_revision(self):
        initial = inspect_memory(self.path)
        self.assertFalse(initial["exists"])
        self.assertEqual(initial["revision"], "missing")
        saved = replace_memory(self.path, "missing", "# Permanent facts\n\n- fact 1\n")
        self.assertTrue(saved["exists"])
        self.assertEqual(inspect_memory(self.path), saved)
        self.assertIn("Permanent facts", self.path.read_text(encoding="utf-8"))

    def test_stale_editor_cannot_overwrite_agent_append(self):
        self.path.write_text("- user preference\n", encoding="utf-8")
        viewed = inspect_memory(self.path)
        with mock.patch.object(memory_module, "MEMORY_PATH", self.path):
            memory_module.append_memory("new agent fact")
        with self.assertRaisesRegex(MemoryConflict, "其他任务更新"):
            replace_memory(self.path, viewed["revision"], "- edited manually\n")
        final = inspect_memory(self.path)
        self.assertIn("new agent fact", final["content"])
        self.assertIn("user preference", final["content"])

    def test_stale_conflict_two_browser_clients(self):
        rev = inspect_memory(self.path)["revision"]
        first = replace_memory(self.path, rev, "first\n")
        with self.assertRaises(MemoryConflict):
            replace_memory(self.path, rev, "second\n")
        self.assertEqual(inspect_memory(self.path)["content"], "first\n")
        saved = replace_memory(self.path, first["revision"], "merged\n")
        self.assertEqual(saved["content"], "merged\n")

    def test_invalid_revision_nontext_and_oversize_rejected_without_write(self):
        for rev in (None, "", "abc", "A" * 64):
            with self.subTest(rev=rev), self.assertRaises(MemoryBrowserError):
                replace_memory(self.path, rev, "unsafe")
        for text in (None, "\x00", "x" * 65537):
            with self.subTest(text=str(text)[:10]), self.assertRaises(MemoryBrowserError):
                replace_memory(self.path, "missing", text)
        self.assertFalse(self.path.exists())

    def test_existing_binary_or_oversized_files_cannot_be_edited(self):
        self.path.write_bytes(b"\xff\xfe")
        with self.assertRaisesRegex(MemoryBrowserError, "UTF-8"):
            inspect_memory(self.path)
        self.path.write_bytes(b"x" * 65537)
        with self.assertRaisesRegex(MemoryBrowserError, "64 KiB"):
            inspect_memory(self.path)

    def test_symlink_memory_cannot_be_read_or_overwritten(self):
        outside = self.root / "private.txt"
        outside.write_text("private content\n", encoding="utf-8")
        link = self.path
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("symlink unavailable")
        with self.assertRaisesRegex(MemoryBrowserError, "符号链接"):
            inspect_memory(link)
        with self.assertRaisesRegex(MemoryBrowserError, "符号链接"):
            replace_memory(link, "missing", "attack")
        self.assertEqual(outside.read_text(), "private content\n")

    def test_group_path_symlink_cannot_switch_bots(self):
        root = self.root / "groups"
        room = root / "demo"
        bot1, bot2 = room / "bots" / "lead", room / "bots" / "builder"
        bot1.mkdir(parents=True)
        bot2.mkdir(parents=True)
        target = bot2 / "MEMORY.md"
        target.write_text("builder private", encoding="utf-8")
        link = bot1 / "MEMORY.md"
        try:
            link.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest("symlink unavailable")
        with self.assertRaises(MemoryBrowserError):
            inspect_memory(link, root=root)
        self.assertEqual(target.read_text(), "builder private")

    def test_file_mode_is_private_on_new_save(self):
        replace_memory(self.path, "missing", "private")
        if not __import__("os").name == "nt":
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_auto_compact_does_not_change_persistent_memory(self):
        class Provider:
            def __init__(self):
                self.calls = 0
            def chat(self, messages, tools=None, timeout=120):
                self.calls += 1
                return {"choices": [{"message": {
                    "role": "assistant",
                    "content": "historical summary" if self.calls == 1 else "finished",
                }}]}
        self.path.write_text("- permanent cross-session agreement\n", encoding="utf-8")
        original = self.path.read_bytes()
        provider = Provider()
        previous = [
            {"role": "user" if i % 2 == 0 else "assistant",
             "content": ("historical line %s " % i) * 100}
            for i in range(6)
        ]
        with mock.patch.object(agent_module, "ANGEL_HOME", self.root / "home"), \
             mock.patch.object(memory_module, "SESSIONS_DIR", self.root / "sessions"):
            agent = Agent(provider, workdir=self.root, mode="readonly",
                          memory_path=self.path, messages=previous,
                          interactive=False, skills_dirs=[],
                          auto_compact_enabled=True, context_window_tokens=1000)
            agent.usage.record({"usage": {
                "prompt_tokens": 850, "completion_tokens": 20,
                "total_tokens": 870,
            }})
            self.assertEqual(agent.run("continue"), "finished")
            self.assertEqual(agent.auto_compact_count, 1)
            self.assertEqual(self.path.read_bytes(), original)
            self.assertIn("permanent cross-session agreement",
                          agent.build_system_prompt("another task"))

    def test_manual_compact_does_not_touch_global_memory(self):
        from angel.memory import load_memory_summary
        class Provider:
            def chat(self, messages, tools=None, timeout=120):
                return {"choices": [{"message": {
                    "role": "assistant", "content": "Summary only",
                }}]}
        self.path.write_text("- [2026-11-16] important permanent memory\n",
                             encoding="utf-8")
        original = self.path.read_bytes()
        with mock.patch.object(agent_module, "ANGEL_HOME", self.root / "home"), \
             mock.patch.object(memory_module, "SESSIONS_DIR", self.root / "sessions"):
            agent = Agent(
                Provider(), workdir=self.root, mode="readonly",
                memory_path=self.path, messages=[
                    {"role": "user", "content": "start"},
                    {"role": "assistant", "content": "ack"},
                    {"role": "user", "content": "continue"},
                    {"role": "assistant", "content": "ack again"},
                ], interactive=False, skills_dirs=[],
            )
            agent.compact()
            self.assertEqual(self.path.read_bytes(), original)
            self.assertIn("important permanent memory", agent.build_system_prompt("continue"))
            self.assertIn("important permanent memory", load_memory_summary(path=self.path))


class MemoryHTTPTests(WebUITestCase):
    def test_global_memory_api_requires_token_and_is_editable(self):
        self.start()
        self.assertEqual(self.request("/api/memory", token=False)[0], 403)
        self.assertEqual(self.request("/api/memory", token="bad")[0], 403)
        status, initial = self.get_json("/api/memory")
        self.assertEqual(status, 200)
        self.assertEqual(initial["revision"], "missing")
        self.assertEqual(self.get_json("/api/memory", method="POST",
                          body={"scope":"global","revision":"missing","content":"secret"},
                          token=False)[0], 403)
        status, saved = self.get_json("/api/memory", method="POST", body={
            "scope": "global", "revision": initial["revision"],
            "content": "- [today] remember something\n",
        })
        self.assertEqual(status, 200)
        self.assertEqual(saved["bytes"], len(saved["content"].encode("utf-8")))
        self.assertIn("remember", memory_module.MEMORY_PATH.read_text(encoding="utf-8"))
        status, loaded = self.get_json("/api/memory")
        self.assertEqual(status, 200)
        self.assertEqual(loaded["revision"], saved["revision"])

    def test_http_version_conflict_is_409_not_clobber(self):
        self.start()
        _, initial = self.get_json("/api/memory")
        self.get_json("/api/memory", method="POST", body={
            "revision": initial["revision"], "content": "first version",
        })
        status, error = self.get_json("/api/memory", method="POST", body={
            "revision": initial["revision"], "content": "second version",
        })
        self.assertEqual(status, 409)
        self.assertIn("更新", error["error"])
        self.assertEqual(memory_module.MEMORY_PATH.read_text(), "first version")

    def test_group_member_memories_are_isolated_and_editable(self):
        self.start()
        status, group = self.get_json("/api/groups", method="POST", body={
            "id": "team", "name": "My Group",
        })
        self.assertEqual(status, 201)
        status, scopes = self.get_json("/api/memory/scopes")
        self.assertEqual(status, 200)
        self.assertEqual(len(scopes["scopes"]), 5)
        self.assertIn("lead", [s.get("bot") for s in scopes["scopes"]])
        lead = "/api/memory?scope=bot&room=team&bot=lead"
        builder = "/api/memory?scope=bot&room=team&bot=builder"
        status, existing = self.get_json(lead)
        self.assertEqual(status, 200)
        status, saved = self.get_json("/api/memory", method="POST", body={
            "scope": "bot", "room": "team", "bot": "lead",
            "revision": existing["revision"], "content": "lead plans",
        })
        self.assertEqual(status, 200)
        self.assertEqual(self.get_json(lead)[1]["content"], "lead plans")
        self.assertEqual(self.get_json(builder)[1]["content"], "")
        self.assertFalse((self.home / "MEMORY.md").exists())
        self.assertTrue((self.home / "groups/team/bots/lead/MEMORY.md").exists())
        self.assertFalse((self.home / "groups/team/bots/builder/MEMORY.md").exists())

    def test_reject_unknown_bot_scope_and_traversal(self):
        self.start()
        self.get_json("/api/groups", method="POST", body={"id":"safe","name":"Safe"})
        for path in (
            "/api/memory?scope=bot&room=safe&bot=notmember",
            "/api/memory?scope=bot&room=..%2F..%2Fetc&bot=lead",
            "/api/memory?scope=arbitrary",
            "/api/memory?scope=global&room=safe",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.get_json(path)[0], 400)
        status, _ = self.get_json("/api/memory", method="POST", body={
            "scope": "bot", "room": "safe", "bot": "outsider",
            "revision": "missing", "content": "injected",
        })
        self.assertEqual(status, 400)

    def test_memories_are_not_accidentally_in_info_or_session_payload(self):
        self.start()
        self.get_json("/api/memory", method="POST", body={
            "revision": "missing", "content": "DO-NOT-PUBLISH-MEMORY",
        })
        _, info = self.get_json("/api/info")
        _, sessions = self.get_json("/api/sessions")
        self.assertNotIn("DO-NOT-PUBLISH-MEMORY", str(info))
        self.assertNotIn("DO-NOT-PUBLISH-MEMORY", str(sessions))

    def test_page_includes_editor_and_uses_textarea_not_inner_html(self):
        self.start()
        status, page, _ = self.request("/?token=" + quote(self.state.token), token=False)
        self.assertEqual(status, 200)
        text = page.decode("utf-8")
        self.assertIn('id="open-memory"', text)
        self.assertIn('id="memory-content"', text)
        self.assertIn('id="memory-scope"', text)
        self.assertIn('memoryView.revision', text)
        self.assertIn('textarea', text)
        self.assertIn('api("/api/memory"', text)


if __name__ == "__main__":
    unittest.main()
