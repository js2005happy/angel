"""Strict local unified patching, approval previews and checkpoint integration."""

import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from angel.agent import Agent
from angel.checkpoints import CheckpointStore
from angel.patches import PatchError, apply_unified_patch, unified_preview
from angel.tools import ToolContext, execute_tool
from angel.webui_page import PAGE_HTML


def patch_text(path, hunks):
    return "--- a/" + path + "\n+++ b/" + path + "\n" + hunks


class ParserTest(unittest.TestCase):
    def test_exact_context_replace(self):
        diff = patch_text("src/code.py", (
            "@@ -1,3 +1,3 @@\n"
            " first\n"
            "-old\n"
            "+new\n"
            " last\n"
        ))
        self.assertEqual(apply_unified_patch(
            "first\nold\nlast\n", diff, "src/code.py"
        ), "first\nnew\nlast\n")

    def test_multiple_hunks_and_insert_delete(self):
        diff = patch_text("a.txt", (
            "@@ -1 +1 @@\n"
            "-one\n"
            "+ONE\n"
            "@@ -4 +4 @@\n"
            "-four\n"
            "+FOUR\n"
        ))
        self.assertEqual(apply_unified_patch(
            "one\ntwo\nthree\nfour\n", diff, "a.txt"
        ), "ONE\ntwo\nthree\nFOUR\n")
        diff = patch_text("a.txt", "@@ -2,0 +3 @@\n+inserted\n")
        self.assertEqual(apply_unified_patch(
            "one\ntwo\nthree\n", diff, "a.txt"
        ), "one\ntwo\ninserted\nthree\n")
        diff = patch_text("a.txt", "@@ -2 +1,0 @@\n-two\n")
        self.assertEqual(apply_unified_patch(
            "one\ntwo\nthree\n", diff, "a.txt"
        ), "one\nthree\n")

    def test_rejects_stale_wrong_path_out_of_order_and_malformed(self):
        original = "a\nb\nc\n"
        cases = (
            patch_text("a.txt", "@@ -1 +1 @@\n-OLD\n+new\n"),
            patch_text("other.txt", "@@ -1 +1 @@\n-a\n+new\n"),
            patch_text("a.txt", "@@ -10 +10 @@\n-a\n+new\n"),
            patch_text("a.txt", "@@ -1 +1 @@\n-a\n+new\n"
                                  "@@ -1 +1 @@\n-a\n+bad\n"),
            patch_text("a.txt", "@@ -1,2 +1,1 @@\n-a\n+new\n"),
            "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+new\n"
            "--- a/evil.txt\n+++ b/evil.txt\n@@ -1 +1 @@\n-a\n+bad\n",
        )
        for diff in cases:
            with self.subTest(diff=diff), self.assertRaises(PatchError):
                apply_unified_patch(original, diff, "a.txt")

    def test_windows_crlf_and_missing_final_newline(self):
        diff = patch_text("a.txt", "@@ -1,2 +1,2 @@\n a\n-b\n+B\n")
        self.assertEqual(apply_unified_patch(
            "a\r\nb\r\n", diff, "a.txt"
        ), "a\r\nB\r\n")
        no_eof = patch_text("a.txt", (
            "@@ -1 +1 @@\n-old\n+new\n"
            "\\ No newline at end of file\n"
        ))
        self.assertEqual(apply_unified_patch("old", no_eof, "a.txt"), "new")
        preserved = patch_text("a.txt", "@@ -1 +1 @@\n-a\n+A\n")
        self.assertEqual(apply_unified_patch("a\nb", preserved, "a.txt"), "A\nb")

    def test_no_change_mixed_newline_and_oversize_rejected(self):
        with self.assertRaises(PatchError):
            apply_unified_patch(
                "a\n", patch_text("a.txt", "@@ -1 +1 @@\n a\n"), "a.txt"
            )
        with self.assertRaises(PatchError):
            apply_unified_patch(
                "a\r\nb\n", patch_text("a.txt", "@@ -1 +1 @@\n-a\n+A\n"), "a.txt"
            )
        with self.assertRaises(PatchError):
            apply_unified_patch(
                "old\n", patch_text("a.txt", "@@ -1 +1 @@\n-old\n+new\n") + "x"*65000,
                "a.txt",
            )

    def test_diff_preview_displays_changes_and_truncation(self):
        p = unified_preview("a.txt", b"old\n", b"new\n")
        self.assertIn("-old", p)
        self.assertIn("+new", p)
        self.assertIn("--- a/a.txt", p)
        self.assertIn("+++ b/a.txt", p)
        self.assertIn("已截断", unified_preview(
            "a.txt", b"A\n" * 400, b"B\n" * 400, max_chars=80
        ))
        self.assertIn("二进制", unified_preview("binary", b"\x00", b"abc"))
        self.assertIn("128 KiB", unified_preview(
            "huge.txt", b"a" * 200000, b"b" * 200000,
        ))


class ToolPatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.workdir = self.root / "work"
        self.workdir.mkdir()
        (self.workdir / "file.txt").write_text("one\nold\nlast\n", encoding="utf-8")
        self.checkpoints = CheckpointStore(self.root / "backups", "test-session", self.workdir)
        self.checkpoints.begin_turn()
        self.ctx = ToolContext(
            workdir=self.workdir, mode="full", interactive=False,
            memory_path=self.root / "memory", skills_dir=self.root / "skills",
            checkpoint=self.checkpoints,
        )
        self.diff = patch_text("file.txt", (
            "@@ -1,3 +1,3 @@\n one\n-old\n+new\n last\n"
        ))

    def tearDown(self):
        self.tmp.cleanup()

    def apply(self, path="file.txt", diff=None):
        return execute_tool("apply_patch", {
            "path": path, "patch": self.diff if diff is None else diff
        }, self.ctx)

    def test_apply_patch_is_undoable_and_shows_latest_diff(self):
        self.assertIn("已应用补丁", self.apply())
        self.assertEqual(
            (self.workdir / "file.txt").read_text(encoding="utf-8"), "one\nnew\nlast\n"
        )
        rendered = self.checkpoints.latest_diff()
        self.assertIn("-old", rendered)
        self.assertIn("+new", rendered)
        self.assertEqual(self.checkpoints.undo(), {"turns": 1, "files": 1})
        self.assertEqual(
            (self.workdir / "file.txt").read_text(encoding="utf-8"), "one\nold\nlast\n"
        )
        self.assertIn("没有可查看", self.checkpoints.latest_diff())

    def test_rejects_path_escape_and_rejects_stale_context(self):
        outside = self.root / "outside.txt"
        outside.write_text("outside\n", encoding="utf-8")
        self.assertIn("工作目录之外", self.apply("../outside.txt"))
        self.assertIn("补丁无效", self.apply(diff=patch_text(
            "file.txt", "@@ -2 +2 @@\n-other\n+wrong\n"
        )))
        self.assertEqual(outside.read_text(encoding="utf-8"), "outside\n")
        self.assertEqual(self.checkpoints.history(), [])

    def test_readonly_and_unattended_auto_cannot_patch(self):
        for mode in ("readonly", "auto"):
            self.ctx.mode = mode
            self.ctx.interactive = False
            self.assertTrue(self.apply().startswith("错误："))
        self.assertEqual(self.checkpoints.history(), [])

    def test_auto_approval_shows_diff_and_rejection_leaves_file_unchanged(self):
        self.ctx.mode = "auto"
        self.ctx.interactive = True
        summaries = []
        self.ctx.approve_fn = lambda name, summary: summaries.append((name, summary)) or False
        response = self.apply()
        self.assertIn("用户拒绝", response)
        self.assertEqual(summaries[0][0], "apply_patch")
        self.assertIn("-old", summaries[0][1])
        self.assertIn("+new", summaries[0][1])
        self.assertEqual((self.workdir / "file.txt").read_text(), "one\nold\nlast\n")
        self.assertEqual(self.checkpoints.history(), [])

    def test_approval_file_race_rejects_outdated_patch(self):
        self.ctx.mode = "auto"
        self.ctx.interactive = True
        def change_during_approval(name, summary):
            (self.workdir / "file.txt").write_text("external\n", encoding="utf-8")
            return True
        self.ctx.approve_fn = change_during_approval
        self.assertIn("审批期间", self.apply())
        self.assertEqual((self.workdir / "file.txt").read_text(), "external\n")
        self.assertEqual(self.checkpoints.history(), [])

    def test_cached_grant_on_other_tool_does_not_skip_patch_approval(self):
        self.ctx.mode = "auto"
        self.ctx.interactive = True
        self.ctx.approved_file_tools.add((
            "write_file", str((self.workdir / "file.txt").resolve()),
            str(self.workdir.resolve()), id(None),
        ))
        with patch("builtins.input", return_value="n") as prompt, \
             patch("sys.stdout", new_callable=io.StringIO):
            result = self.apply()
        self.assertIn("用户拒绝", result)
        prompt.assert_called_once()

    def test_existing_file_mutators_show_diff_in_callbacks(self):
        self.ctx.mode = "auto"
        self.ctx.interactive = True
        approvals = []
        self.ctx.approve_fn = lambda name, summary: approvals.append((name, summary)) or False
        for tool, args in (
            ("write_file", {"path": "file.txt", "content": "replacement\n"}),
            ("edit_file", {
                "path": "file.txt", "old_text": "old", "new_text": "different"
            }),
            ("plan", {"title": "Test", "steps": ["first"], "path": "file.txt"}),
        ):
            result = execute_tool(tool, args, self.ctx)
            self.assertIn("用户拒绝", result)
        self.assertEqual(len(approvals), 3)
        for name, summary in approvals:
            self.assertIn("--- a/file.txt", summary)
            self.assertIn("+++ b/file.txt", summary)
            self.assertIn("-old", summary)

    def test_conflicting_external_edit_is_not_displayed_as_angel_diff(self):
        self.ctx.mode = "full"
        self.assertIn("已应用补丁", self.apply())
        (self.workdir / "file.txt").write_text("external work\n", encoding="utf-8")
        self.assertIn("冲突", self.checkpoints.latest_diff())
        self.assertNotIn("+external work", self.checkpoints.latest_diff())

    def test_e2b_rejected_without_external_writes(self):
        class Backend:
            def __init__(self):
                self.writes = []
            def write_file(self, name, content):
                self.writes.append((name, content))
        backend = Backend()
        self.ctx.backend = backend
        self.ctx.workdir = Path("/home/user")
        self.assertIn("只支持本地", self.apply())
        self.assertEqual(backend.writes, [])

    def test_local_only_tool_is_not_advertised_for_remote_backend(self):
        local = Agent(object(), workdir=self.workdir, mode="readonly",
                      interactive=False, skills_dirs=[])
        remote = Agent(object(), workdir=self.workdir, mode="readonly",
                       interactive=False, skills_dirs=[], backend=object())
        self.assertIn("apply_patch", [
            x["function"]["name"] for x in local.tool_schemas()
        ])
        self.assertNotIn("apply_patch", [
            x["function"]["name"] for x in remote.tool_schemas()
        ])

    def test_web_ui_supports_multiline_approval_previews(self):
        self.assertIn("white-space:pre-wrap", PAGE_HTML)


if __name__ == "__main__":
    unittest.main()
