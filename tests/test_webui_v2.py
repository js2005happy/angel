"""Tests for the desktop v2 web UI additions.

Session-scoped approvals ("本会话始终允许"), sessions grouped by project,
plan mode from the page, packaged fonts, and the page itself. Everything
runs against a mock provider on a random local port: no key, no network.
"""

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nyra import webui  # noqa: E402
from nyra.plan_mode import approved_execution_task  # noqa: E402
from nyra.tools import (  # noqa: E402
    APPROVE_ALWAYS, SESSION_GRANT_TOOLS, ToolContext, ToolError, _check_approval,
)
from tests.test_server import ApiTestCase  # noqa: E402
from tests.test_webui import WebUITestCase, reply  # noqa: E402


class SessionGrantToolTests(unittest.TestCase):
    """tools._check_approval with an approve_fn that may answer "always"."""

    def ctx(self, answers, root):
        calls = []

        def approve(tool, summary):
            calls.append((tool, summary))
            return answers.pop(0)

        ctx = ToolContext(
            workdir=root, mode="auto", interactive=True,
            memory_path=root / "M.md", skills_dir=root / "skills",
            approve_fn=approve,
        )
        return ctx, calls

    def test_always_grants_same_file_only(self):
        root = Path(".").resolve()
        ctx, calls = self.ctx([APPROVE_ALWAYS, True], root)
        _check_approval(ctx, "write_file", "写 a", file_target=root / "a.txt")
        _check_approval(ctx, "write_file", "写 a 再次", file_target=root / "a.txt")
        self.assertEqual(len(calls), 1)
        # A different file still asks.
        _check_approval(ctx, "write_file", "写 b", file_target=root / "b.txt")
        self.assertEqual(len(calls), 2)

    def test_always_for_shell_is_scoped_to_identical_command(self):
        root = Path(".").resolve()
        ctx, calls = self.ctx([APPROVE_ALWAYS, False], root)
        _check_approval(ctx, "shell", "ls", command="ls", cwd=str(root), timeout=60)
        _check_approval(ctx, "shell", "ls", command="ls", cwd=str(root), timeout=60)
        self.assertEqual(len(calls), 1)
        with self.assertRaises(ToolError):
            _check_approval(ctx, "shell", "rm", command="rm x", cwd=str(root), timeout=60)
        # Same command with another timeout is a different scope.
        self.assertEqual(len(calls), 2)

    def test_plain_true_grants_nothing(self):
        root = Path(".").resolve()
        ctx, calls = self.ctx([True, True], root)
        _check_approval(ctx, "write_file", "写", file_target=root / "a.txt")
        _check_approval(ctx, "write_file", "写", file_target=root / "a.txt")
        self.assertEqual(len(calls), 2)
        self.assertEqual(ctx.approve_fn_grants, set())

    def test_terminal_grants_do_not_bypass_web_gate(self):
        root = Path(".").resolve()
        ctx, calls = self.ctx([False], root)
        scope = ("write_file", str(root / "a.txt"), str(root), id(None))
        ctx.approved_file_tools.add(scope)
        with self.assertRaises(ToolError):
            _check_approval(ctx, "write_file", "写", file_target=root / "a.txt")
        self.assertEqual(len(calls), 1)

    def test_readonly_still_refuses_even_with_grant(self):
        root = Path(".").resolve()
        ctx, _ = self.ctx([], root)
        ctx.approve_fn_grants.add(("write_file", str(root / "a.txt"), str(root), id(None)))
        ctx.mode = "readonly"
        with self.assertRaises(ToolError):
            _check_approval(ctx, "write_file", "写", file_target=root / "a.txt")

    def test_grant_tools(self):
        self.assertEqual(SESSION_GRANT_TOOLS, {"write_file", "edit_file", "plan", "shell"})


class AlwaysApprovalApiTests(WebUITestCase):
    def test_always_skips_second_prompt_for_same_file(self):
        self.start([
            reply("", [("write_file", {"path": "a.txt", "content": "1"})]),
            reply("", [("write_file", {"path": "a.txt", "content": "2"})]),
            reply("完成"),
        ])
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        self.get_json(f"/api/sessions/{sid}/messages", method="POST", body={"text": "写两次"})
        view = self.wait_for(sid, lambda v: v["pending"] is not None)
        self.assertTrue(view["pending"]["always"])
        approval = [e for e in view["events"] if e["type"] == "approval"][0]
        self.assertTrue(approval["data"]["always"])
        status, _ = self.get_json(
            f"/api/approvals/{view['pending']['id']}", method="POST",
            body={"approve": True, "always": True},
        )
        self.assertEqual(status, 200)
        view = self.wait_for(sid, lambda v: v["status"] == "done")
        self.assertEqual((self.workdir / "a.txt").read_text(encoding="utf-8"), "2")
        types = [e["type"] for e in view["events"]]
        self.assertEqual(types.count("approval"), 1)
        result = [e for e in view["events"] if e["type"] == "approval_result"][0]
        self.assertTrue(result["data"]["approved"])
        self.assertTrue(result["data"]["always"])

    def test_always_refused_for_tool_without_session_scope(self):
        self.start([
            reply("", [("memory_append", {"text": "记一下"})]),
            reply("好"),
        ])
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        self.get_json(f"/api/sessions/{sid}/messages", method="POST", body={"text": "记"})
        view = self.wait_for(sid, lambda v: v["pending"] is not None)
        self.assertFalse(view["pending"]["always"])
        status, data = self.get_json(
            f"/api/approvals/{view['pending']['id']}", method="POST",
            body={"approve": True, "always": True},
        )
        self.assertEqual(status, 400)
        self.assertIn("始终允许", data["error"])
        # Still pending: answer it once so the run can finish.
        status, _ = self.get_json(
            f"/api/approvals/{view['pending']['id']}", method="POST", body={"approve": False},
        )
        self.assertEqual(status, 200)
        self.wait_for(sid, lambda v: v["status"] == "done")

    def test_deny_with_always_flag_is_a_plain_deny(self):
        self.start([
            reply("", [("write_file", {"path": "n.txt", "content": "x"})]),
            reply("好"),
        ])
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        self.get_json(f"/api/sessions/{sid}/messages", method="POST", body={"text": "写"})
        view = self.wait_for(sid, lambda v: v["pending"] is not None)
        self.get_json(
            f"/api/approvals/{view['pending']['id']}", method="POST",
            body={"approve": False, "always": True},
        )
        view = self.wait_for(sid, lambda v: v["status"] == "done")
        self.assertFalse((self.workdir / "n.txt").exists())
        result = [e for e in view["events"] if e["type"] == "approval_result"][0]
        self.assertFalse(result["data"]["always"])


class ServerAlwaysTests(ApiTestCase):
    def test_decide_endpoint_accepts_always(self):
        self.start([
            reply("", [("write_file", {"path": "s.txt", "content": "1"})]),
            reply("", [("write_file", {"path": "s.txt", "content": "2"})]),
            reply("完成"),
        ])
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        self.get_json(f"/api/sessions/{sid}/send", method="POST", body={"text": "写"})
        view = self.wait_for(sid, lambda v: v["pending"] is not None)
        status, _ = self.get_json(
            f"/api/approvals/{view['pending']['id']}/decide", method="POST",
            body={"approve": True, "always": True},
        )
        self.assertEqual(status, 200)
        view = self.wait_for(sid, lambda v: v["status"] == "done")
        self.assertEqual((self.workdir / "s.txt").read_text(encoding="utf-8"), "2")


class ProjectGroupingTests(WebUITestCase):
    def test_sessions_carry_project_of_web_runs_only(self):
        self.start([reply("好")])
        # A session written outside the web UI (e.g. the CLI).
        webui.memory_module.save_session(
            "20260101-000000-c0de", [{"role": "user", "content": "命令行"}]
        )
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        self.get_json(f"/api/sessions/{sid}/messages", method="POST", body={"text": "你好"})
        self.wait_for(sid, lambda v: v["status"] == "done")
        status, data = self.get_json("/api/sessions")
        self.assertEqual(status, 200)
        self.assertEqual(data["project"]["workdir"], str(self.workdir.resolve()))
        self.assertEqual(data["project"]["name"], self.workdir.name)
        by_id = {s["id"]: s for s in data["sessions"]}
        self.assertEqual(by_id[sid]["workdir"], str(self.workdir.resolve()))
        self.assertEqual(by_id[sid]["project"], self.workdir.name)
        self.assertIsNone(by_id["20260101-000000-c0de"]["workdir"])
        self.assertIsNone(by_id["20260101-000000-c0de"]["project"])
        # The index lives beside the sessions but is not itself a session.
        self.assertTrue((self.home / "sessions" / webui.PROJECTS_FILE).is_file())
        self.assertNotIn(webui.PROJECTS_FILE.split(".")[0], by_id)

    def test_corrupt_index_is_ignored(self):
        self.start()
        (self.home / "sessions").mkdir(parents=True, exist_ok=True)
        (self.home / "sessions" / webui.PROJECTS_FILE).write_text("[1,2", encoding="utf-8")
        webui.memory_module.save_session("20260101-000000-aaaa", [{"role": "user", "content": "x"}])
        status, data = self.get_json("/api/sessions")
        self.assertEqual(status, 200)
        self.assertIsNone(data["sessions"][0]["project"])

    def test_index_rejects_bad_ids_and_values(self):
        self.start()
        (self.home / "sessions").mkdir(parents=True, exist_ok=True)
        (self.home / "sessions" / webui.PROJECTS_FILE).write_text(
            json.dumps({"../x": "/tmp", "20260101-000000-bbbb": 5}), encoding="utf-8"
        )
        self.assertEqual(self.state._load_projects(), {})


class PlanModeApiTests(WebUITestCase):
    def _plan(self, text="整理 README"):
        _, created = self.get_json("/api/sessions", method="POST", body={})
        sid = created["id"]
        status, _ = self.get_json(f"/api/sessions/{sid}/plan", method="POST", body={"text": text})
        self.assertEqual(status, 202)
        view = self.wait_for(sid, lambda v: v["status"] != "running")
        return sid, view

    def test_plan_writes_plan_md_and_reports_hash(self):
        self.start([reply("1. 读 README\n2. 改标题")])
        sid, view = self._plan()
        self.assertEqual(view["status"], "done", view.get("error"))
        ready = [e for e in view["events"] if e["type"] == "plan_ready"][0]["data"]
        text = (self.workdir / "plan.md").read_text(encoding="utf-8")
        self.assertEqual(ready["plan"], text)
        self.assertRegex(ready["sha256"], r"^[0-9a-f]{64}$")
        user = [e for e in view["events"] if e["type"] == "user"][0]["data"]
        self.assertTrue(user["plan"])
        # Planning never touches the transcript.
        self.assertEqual(view["messages"], [])

    def test_execute_requires_matching_hash_and_runs(self):
        self.start([reply("1. 写 notes"), reply("执行完毕")])
        sid, view = self._plan()
        digest = [e for e in view["events"] if e["type"] == "plan_ready"][0]["data"]["sha256"]
        status, data = self.get_json(
            f"/api/sessions/{sid}/plan/execute", method="POST", body={"sha256": "0" * 64}
        )
        self.assertEqual(status, 400)
        status, _ = self.get_json(
            f"/api/sessions/{sid}/plan/execute", method="POST", body={"sha256": "abc"}
        )
        self.assertEqual(status, 400)
        status, _ = self.get_json(
            f"/api/sessions/{sid}/plan/execute", method="POST", body={"sha256": digest}
        )
        self.assertEqual(status, 202)
        view = self.wait_for(sid, lambda v: v["status"] == "done")
        first_user = [m for m in view["messages"] if m["role"] == "user"][0]["content"]
        self.assertTrue(first_user.startswith(webui_prefix()))

    def test_execute_refused_in_readonly(self):
        self.start([reply("1. 看看")], mode="readonly")
        sid, view = self._plan()
        digest = [e for e in view["events"] if e["type"] == "plan_ready"][0]["data"]["sha256"]
        status, data = self.get_json(
            f"/api/sessions/{sid}/plan/execute", method="POST", body={"sha256": digest}
        )
        self.assertEqual(status, 400)
        self.assertIn("只读", data["error"])

    def test_plan_failure_is_reported(self):
        self.start([reply("")])  # empty plan -> PlanError
        sid, view = self._plan()
        self.assertEqual(view["status"], "error")
        self.assertIn("规划失败", view["error"])
        self.assertFalse((self.workdir / "plan.md").exists())

    def test_empty_plan_text_rejected(self):
        self.start()
        _, created = self.get_json("/api/sessions", method="POST", body={})
        status, _ = self.get_json(
            f"/api/sessions/{created['id']}/plan", method="POST", body={"text": " "}
        )
        self.assertEqual(status, 400)


def webui_prefix() -> str:
    return approved_execution_task("")


class FontTests(WebUITestCase):
    def test_fonts_need_header_token(self):
        self.start()
        self.assertEqual(self.request("/assets/fonts/inter-400.woff", token=False)[0], 403)
        status, _, _ = self.request(
            f"/assets/fonts/inter-400.woff?token={self.state.token}", token=False
        )
        self.assertEqual(status, 403)
        for name in ("inter-400.woff", "inter-600.woff", "jbm-400.woff"):
            status, raw, headers = self.request(f"/assets/fonts/{name}")
            self.assertEqual(status, 200, name)
            self.assertEqual(headers.get("Content-Type"), "font/woff")
            self.assertTrue(raw.startswith(b"wOFF"), name)

    def test_unknown_font_is_404(self):
        self.start()
        self.assertEqual(self.request("/assets/fonts/nope.woff")[0], 404)
        self.assertEqual(self.request("/assets/fonts/../webui.py")[0], 404)


class PageV2Tests(WebUITestCase):
    def test_csp_is_unchanged(self):
        self.start()
        _, _, headers = self.request(f"/?token={self.state.token}", token=False)
        csp = headers.get("Content-Security-Policy", "")
        self.assertEqual(csp, webui.CSP)
        self.assertNotIn("font-src", csp)
        self.assertNotIn("unsafe-eval", csp)

    def test_page_has_v2_controls(self):
        html = webui.PAGE_HTML
        for token in (
            'id="plan-toggle"', 'id="model-select"', 'id="mode"', 'id="tab-diff"',
            'id="tab-term"', 'id="run-status"', 'id="usage-pill"', 'id="worked"',
            "本会话始终允许", "允许一次", "拒绝", "prefers-reduced-motion",
            "prefers-color-scheme:dark", "/assets/fonts/", "new FontFace(",
            'id="nyra-mark"',
        ):
            self.assertIn(token, html, token)
        # No fake features from the mockup: no cloud computer, no line comments,
        # no commit / open-in-editor buttons, no splash animation.
        for token in ("云电脑", "Open in editor", ">Commit<", "splash", "逐行评论"):
            self.assertNotIn(token, html, token)
        # The page never asks for or stores a key.
        self.assertNotRegex(html, r'type="password"')
        self.assertNotIn("localStorage", html)

    def test_plan_exec_prefix_matches_core(self):
        match = re.search(r'var PLAN_EXEC_PREFIX="([^"]+)"', webui.PAGE_HTML)
        self.assertIsNotNone(match)
        self.assertTrue(webui_prefix().startswith(match.group(1)))

    def test_no_old_name(self):
        for text in (webui.PAGE_HTML, Path(webui.__file__).read_text(encoding="utf-8")):
            self.assertNotIn("an" + "gel", text.lower())


if __name__ == "__main__":
    unittest.main()
