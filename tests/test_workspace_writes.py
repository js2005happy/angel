"""Workspace-bounded built-in writes and explicit session approval tests.

These tests never modify files outside TemporaryDirectory except a test-owned
sibling file used to prove no boundary escape.
"""

import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from angel.tools import ToolContext, ToolError, _check_approval, execute_tool


class RecordingBackend:
    def __init__(self):
        self.files = {}
        self.commands = []

    def write_file(self, path, content):
        self.files[path] = content
        return "已写入"

    def read_file(self, path):
        return self.files.get(path, "错误：文件不存在")

    def list_dir(self, path):
        return ""

    def run_command(self, command, cwd=None, timeout=60):
        self.commands.append((command, cwd))
        return "ok"


class WorkspaceWriteTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.workdir = self.root / "project"
        self.workdir.mkdir()
        self.outside = self.root / "outside.txt"
        self.outside.write_text("unchanged", encoding="utf-8")
        self.ctx = ToolContext(
            workdir=self.workdir, mode="full", interactive=False,
            memory_path=self.root / "memory.md",
            skills_dir=self.root / "skills",
        )

    def tearDown(self):
        self.temp.cleanup()

    def _write(self, tool, path):
        if tool == "write_file":
            return execute_tool(tool, {"path": path, "content": "changed"}, self.ctx)
        if tool == "edit_file":
            return execute_tool(tool, {
                "path": path, "old_text": "unchanged", "new_text": "changed"
            }, self.ctx)
        return execute_tool(tool, {
            "title": "Plans", "steps": ["step"], "path": path
        }, self.ctx)

    def test_local_file_writers_reject_parent_and_external_absolute_paths(self):
        for tool in ("write_file", "edit_file", "plan"):
            for path in ("../outside.txt", str(self.outside)):
                with self.subTest(tool=tool, path=path):
                    result = self._write(tool, path)
                    self.assertIn("工作目录之外", result)
                    self.assertEqual(
                        self.outside.read_text(encoding="utf-8"), "unchanged"
                    )

    def test_write_and_edit_inside_workspace_still_work(self):
        nested = "src/nested.txt"
        self.assertIn("已写入", self._write("write_file", nested))
        self.assertEqual((self.workdir / nested).read_text(encoding="utf-8"), "changed")
        (self.workdir / nested).write_text("unchanged", encoding="utf-8")
        self.assertIn("已编辑", self._write("edit_file", nested))
        self.assertEqual((self.workdir / nested).read_text(encoding="utf-8"), "changed")
        self.assertIn("已写入计划", self._write("plan", "notes/plan.md"))
        self.assertTrue((self.workdir / "notes/plan.md").is_file())

    def test_existing_symlink_to_outside_refused_for_all_file_writers(self):
        link = self.workdir / "link.txt"
        directory_link = self.workdir / "external-dir"
        try:
            link.symlink_to(self.outside)
            directory_link.symlink_to(self.root, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are unavailable")
        for tool in ("write_file", "edit_file", "plan"):
            for path in ("link.txt", "external-dir/outside.txt"):
                with self.subTest(tool=tool, path=path):
                    self.assertIn("工作目录之外", self._write(tool, path))
        self.assertEqual(self.outside.read_text(encoding="utf-8"), "unchanged")

    def test_inside_symlink_is_allowed_but_never_escape(self):
        dest = self.workdir / "real.txt"
        dest.write_text("unchanged", encoding="utf-8")
        link = self.workdir / "inside.txt"
        try:
            link.symlink_to(dest)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are unavailable")
        self.assertIn("已编辑", self._write("edit_file", "inside.txt"))
        self.assertEqual(dest.read_text(encoding="utf-8"), "changed")

    def test_root_or_empty_target_never_written(self):
        for path in ("", ".", str(self.workdir)):
            with self.subTest(path=path):
                result = self._write("write_file", path)
                self.assertTrue(result.startswith("错误："))

    def test_restricted_writes_prevent_prompt_for_invalid_paths(self):
        ctx = ToolContext(
            workdir=self.workdir, mode="auto", interactive=True,
            memory_path=self.root / "mem", skills_dir=self.root / "skills",
        )
        with patch("builtins.input") as prompt:
            result = execute_tool("write_file", {
                "path": "../outside.txt", "content": "changed",
            }, ctx)
        self.assertIn("工作目录之外", result)
        prompt.assert_not_called()
        self.assertEqual(self.outside.read_text(encoding="utf-8"), "unchanged")

    def test_backend_writes_have_lexical_workspace_boundary(self):
        backend = RecordingBackend()
        ctx = ToolContext(
            workdir=Path("/home/user"),
            mode="full", interactive=False, backend=backend,
            memory_path=self.root / "memory", skills_dir=self.root / "skills",
        )
        for tool, args in (
            ("write_file", {"path": "../other/file.txt", "content": "bad"}),
            ("edit_file", {"path": "/etc/passwd", "old_text": "x", "new_text": "y"}),
            ("plan", {"title": "test", "steps": [], "path": "../../escape.md"}),
        ):
            with self.subTest(tool=tool):
                self.assertIn("工作目录之外", execute_tool(tool, args, ctx))
        self.assertEqual(backend.files, {})
        ok = execute_tool("write_file", {
            "path": "src/readme.md", "content": "ok",
        }, ctx)
        self.assertIn("已写入", ok)
        self.assertEqual(backend.files, {"/home/user/src/readme.md": "ok"})


class ScopedApprovalTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.ctx = ToolContext(
            workdir=self.root, mode="auto", interactive=True,
            memory_path=self.root / "memory.md", skills_dir=self.root / "skills",
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_file_tool_always_is_scoped_to_canonical_target_and_tool(self):
        with patch("builtins.input", side_effect=["a", "y", "n"]) as prompts, \
             patch("sys.stdout", new_callable=io.StringIO):
            self.assertIn("已写入", execute_tool("write_file", {
                "path": "one.txt", "content": "1",
            }, self.ctx))
            self.assertIn("已写入", execute_tool("write_file", {
                "path": str(self.root / "one.txt"), "content": "2",
            }, self.ctx))  # Same canonical target: no second prompt.
            self.assertIn("已写入", execute_tool("write_file", {
                "path": "two.txt", "content": "2",
            }, self.ctx))  # Different target: prompt.
            result = execute_tool("edit_file", {
                "path": "one.txt", "old_text": "2", "new_text": "3",
            }, self.ctx)  # Different tool: prompt.
        self.assertIn("用户拒绝", result)
        self.assertEqual(prompts.call_count, 3)
        self.assertEqual(
            self.ctx.approved_file_tools,
            {("write_file", str(self.root / "one.txt"), str(self.root), id(None))},
        )
        fresh = ToolContext(
            workdir=self.root, mode="auto", interactive=True,
            memory_path=self.root / "mem", skills_dir=self.root / "skills",
        )
        with patch("builtins.input", return_value="n") as prompts, \
             patch("sys.stdout", new_callable=io.StringIO):
            result = execute_tool("write_file", {
                "path": "three.txt", "content": "no",
            }, fresh)
        self.assertIn("用户拒绝", result)
        prompts.assert_called_once()
        self.assertFalse((self.root / "three.txt").exists())

    def test_shell_always_requires_same_command_cwd_timeout_and_backend(self):
        other = self.root / "other"
        other.mkdir()
        with patch("builtins.input", side_effect=["always", "n", "n", "n"]) as prompts, \
             patch("sys.stdout", new_callable=io.StringIO):
            for command in ("echo 42", "echo 42", "echo 43"):
                execute_tool("shell", {"command": command}, self.ctx)
            # Different canonical working directory is a separate grant.
            different_dir = execute_tool("shell", {
                "command": "echo 42", "cwd": "other",
            }, self.ctx)
            # Different timeout must never reuse the previous grant.
            different_timeout = execute_tool("shell", {
                "command": "echo 42", "timeout": 120,
            }, self.ctx)
        self.assertIn("用户拒绝", different_dir)
        self.assertIn("用户拒绝", different_timeout)
        self.assertEqual(prompts.call_count, 4)
        self.assertEqual(self.ctx.approved_shell_commands, {
            ("echo 42", str(self.root), str(self.root), 60, id(None))
        })

    def test_auto_noninteractive_and_readonly_cannot_use_cached_grants(self):
        self.ctx.approved_file_tools.add(
            ("write_file", str(self.root / "blocked.txt"), str(self.root), id(None))
        )
        self.ctx.approved_shell_commands.add(
            ("echo 42", str(self.root), str(self.root), 60, id(None))
        )
        for mode, interactive in (("auto", False), ("readonly", True)):
            with self.subTest(mode=mode, interactive=interactive):
                self.ctx.mode = mode
                self.ctx.interactive = interactive
                result = execute_tool("write_file", {
                    "path": "blocked.txt", "content": "bad",
                }, self.ctx)
                self.assertTrue(result.startswith("错误："))
                self.assertFalse((self.root / "blocked.txt").exists())

    def test_no_remember_for_mcp_http_or_memory_even_when_user_types_a(self):
        for name in ("mcp", "http_post", "memory_append", "save_skill"):
            with self.subTest(name=name):
                with patch("builtins.input", return_value="a") as prompt, \
                     patch("sys.stdout", new_callable=io.StringIO):
                    with self.assertRaisesRegex(ToolError, "拒绝"):
                        _check_approval(self.ctx, name, "do something")
                prompt.assert_called_once()
        self.assertEqual(self.ctx.approved_file_tools, set())
        self.assertEqual(self.ctx.approved_shell_commands, set())

    def test_callback_always_runs_even_when_grants_are_already_cached(self):
        self.ctx.approved_file_tools.add(
            ("write_file", str(self.root / "test.txt"), str(self.root), id(None))
        )
        approvals = []
        self.ctx.approve_fn = lambda name, summary: approvals.append(name) or False
        result = execute_tool("write_file", {
            "path": "test.txt", "content": "should not write",
        }, self.ctx)
        self.assertIn("用户拒绝", result)
        self.assertEqual(approvals, ["write_file"])
        self.assertFalse((self.root / "test.txt").exists())


if __name__ == "__main__":
    unittest.main()
