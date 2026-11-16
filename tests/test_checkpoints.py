"""Local file checkpoint recovery with tamper and external-edit protection."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import angel.agent as agent_module
import angel.memory as memory_module
from angel.agent import Agent
from angel.checkpoints import (
    CheckpointError, CheckpointStore, MAX_FILE_BYTES,
)
from angel.tools import ToolContext, execute_tool


def response(content="", calls=None):
    message = {"role": "assistant", "content": content}
    if calls is not None:
        message["tool_calls"] = calls
    return {"choices": [{"message": message}]}


def call(tool, args, cid="c1"):
    return {
        "id": cid, "type": "function",
        "function": {"name": tool, "arguments": json.dumps(args, ensure_ascii=False)},
    }


class Scripted:
    def __init__(self, responses):
        self.responses = list(responses)

    def chat(self, messages, tools=None, timeout=120):
        return self.responses.pop(0)


class CheckpointCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.workdir = self.home / "work"
        self.workdir.mkdir()
        self.store = CheckpointStore(self.home / "backups", "session-one", self.workdir)
        self.ctx = ToolContext(
            workdir=self.workdir, mode="full", interactive=False,
            memory_path=self.home / "memory", skills_dir=self.home / "skills",
            checkpoint=self.store,
        )
        self.store.begin_turn()

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, content):
        return execute_tool("write_file", {"path": name, "content": content}, self.ctx)

    def test_create_then_undo_deletes_only_matching_created_file(self):
        self.assertIn("已写入", self.write("created.txt", "hello"))
        self.assertEqual(len(self.store.history()), 1)
        self.assertEqual(self.store.undo(), {"turns": 1, "files": 1})
        self.assertFalse((self.workdir / "created.txt").exists())
        self.assertEqual(self.store.history(), [])

    def test_overwrite_preserves_original_binary_bytes(self):
        path = self.workdir / "binary.dat"
        before = bytes([0, 1, 255, 200, 13, 10])
        path.write_bytes(before)
        self.assertIn("已写入", self.write("binary.dat", "plain UTF8"))
        self.store.undo()
        self.assertEqual(path.read_bytes(), before)

    def test_same_task_multiple_writes_capture_first_original_only(self):
        path = self.workdir / "notes.txt"
        path.write_text("old", encoding="utf-8")
        self.write("notes.txt", "middle")
        self.write("notes.txt", "new")
        self.assertEqual(len(self.store.history()), 1)
        self.store.undo()
        self.assertEqual(path.read_text(encoding="utf-8"), "old")

    def test_different_tools_participate_in_same_checkpoint(self):
        self.write("a.txt", "hello")
        self.assertIn("已编辑", execute_tool("edit_file", {
            "path": "a.txt", "old_text": "hello", "new_text": "new",
        }, self.ctx))
        self.assertIn("已写入计划", execute_tool("plan", {
            "title": "任务", "steps": ["测试"], "path": "plan.md",
        }, self.ctx))
        info = self.store.undo()
        self.assertEqual(info["files"], 2)
        self.assertFalse((self.workdir / "a.txt").exists())
        self.assertFalse((self.workdir / "plan.md").exists())

    def test_rewind_multiple_turns_with_overlapping_paths(self):
        path = self.workdir / "target.txt"
        path.write_text("original", encoding="utf-8")
        self.write("target.txt", "step-1")
        self.store.begin_turn()
        self.write("target.txt", "step-2")
        self.write("extra.txt", "additional")
        self.store.begin_turn()
        self.write("target.txt", "step-3")
        self.assertEqual(len(self.store.history()), 3)
        self.assertEqual(self.store.undo(2), {"turns": 2, "files": 2})
        self.assertEqual(path.read_text(encoding="utf-8"), "step-1")
        self.assertFalse((self.workdir / "extra.txt").exists())
        self.assertEqual(len(self.store.history()), 1)
        self.assertEqual(self.store.undo(1), {"turns": 1, "files": 1})
        self.assertEqual(path.read_text(encoding="utf-8"), "original")

    def test_external_changes_abort_without_touching_any_file(self):
        self.write("one.txt", "one")
        self.write("two.txt", "two")
        (self.workdir / "two.txt").write_text("someone else's edit", encoding="utf-8")
        with self.assertRaisesRegex(CheckpointError, "外部修改"):
            self.store.undo()
        self.assertEqual((self.workdir / "one.txt").read_text(encoding="utf-8"), "one")
        self.assertEqual(
            (self.workdir / "two.txt").read_text(encoding="utf-8"), "someone else's edit"
        )

    def test_rewind_all_or_nothing_when_older_file_is_changed(self):
        self.write("first.txt", "first")
        self.store.begin_turn()
        self.write("second.txt", "second")
        (self.workdir / "first.txt").write_text("external", encoding="utf-8")
        with self.assertRaisesRegex(CheckpointError, "外部修改"):
            self.store.undo(2)
        self.assertTrue((self.workdir / "second.txt").exists())
        self.assertEqual((self.workdir / "first.txt").read_text(), "external")

    def test_created_file_replaced_by_symlink_is_not_deleted(self):
        external = self.home / "external.txt"
        external.write_text("outside", encoding="utf-8")
        self.write("link.txt", "initial")
        (self.workdir / "link.txt").unlink()
        try:
            (self.workdir / "link.txt").symlink_to(external)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unsupported")
        with self.assertRaisesRegex(CheckpointError, "符号链接"):
            self.store.undo()
        self.assertEqual(external.read_text(encoding="utf-8"), "outside")

    def test_persistent_across_store_recreation_but_private_per_session(self):
        self.write("persist.txt", "saved")
        reopened = CheckpointStore(self.home / "backups", "session-one", self.workdir)
        self.assertEqual(len(reopened.history()), 1)
        other = CheckpointStore(self.home / "backups", "session-two", self.workdir)
        self.assertEqual(other.history(), [])
        reopened.undo()
        self.assertFalse((self.workdir / "persist.txt").exists())

    def test_untracked_external_write_after_first_write_aborts_same_turn(self):
        self.write("tracked.txt", "tracked")
        (self.workdir / "tracked.txt").write_text("external", encoding="utf-8")
        with self.assertRaisesRegex(CheckpointError, "其他操作"):
            self.store.write_text(self.workdir / "tracked.txt", "agent overwrite")
        self.assertEqual((self.workdir / "tracked.txt").read_text(), "external")

    def test_oversized_backup_and_write_are_rejected_before_change(self):
        big = self.workdir / "large.txt"
        big.write_bytes(b"x" * (MAX_FILE_BYTES + 1))
        self.assertIn("2 MiB", self.write("large.txt", "new"))
        self.assertEqual(big.stat().st_size, MAX_FILE_BYTES + 1)
        self.assertIn("2 MiB", self.write("small.txt", "y" * (MAX_FILE_BYTES + 1)))
        self.assertFalse((self.workdir / "small.txt").exists())

    def test_invalid_rewind_counts_fail_without_side_effects(self):
        self.write("file.txt", "hello")
        for count in (0, 11, -1, True, "1"):
            with self.subTest(count=count), self.assertRaises(CheckpointError):
                self.store.undo(count)
        self.assertTrue((self.workdir / "file.txt").exists())

    def test_readonly_and_noninteractive_auto_write_does_not_checkpoint(self):
        for mode in ("readonly", "auto"):
            self.ctx.mode = mode
            self.ctx.interactive = False
            self.assertTrue(
                execute_tool("write_file", {
                    "path": mode + ".txt", "content": "no",
                }, self.ctx).startswith("错误：")
            )
        self.assertEqual(self.store.history(), [])

    def test_remote_file_writes_do_not_create_local_checkpoints(self):
        class Backend:
            def write_file(self, path, content):
                return "已写入 remote"
        self.ctx.mode = "full"
        self.ctx.backend = Backend()
        self.ctx.workdir = Path("/home/user")
        self.assertIn("remote", self.write("remote.txt", "hi"))
        self.assertEqual(self.store.history(), [])

    def test_metadata_tampering_is_rejected_before_restoration(self):
        self.write("important.txt", "hello")
        manifest = next(self.store.directory.glob("*.json"))
        record = json.loads(manifest.read_text(encoding="utf-8"))
        item = next(iter(record["files"].values()))
        item["before"] = "Y29ycnVwdA=="
        manifest.write_text(json.dumps(record), encoding="utf-8")
        with self.assertRaisesRegex(CheckpointError, "校验失败"):
            self.store.undo()
        self.assertEqual((self.workdir / "important.txt").read_text(), "hello")


class CheckpointAgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.workdir = self.root / "project"
        self.workdir.mkdir()
        self.patches = [
            patch.object(agent_module, "ANGEL_HOME", self.root / "home"),
            patch.object(memory_module, "SESSIONS_DIR", self.root / "sessions"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_agent_creates_one_checkpoint_per_turn_and_can_undo(self):
        provider = Scripted([
            response(calls=[
                call("write_file", {"path": "a.txt", "content": "a"}, "c1"),
                call("write_file", {"path": "b.txt", "content": "b"}, "c2"),
            ]),
            response("done"),
            response(calls=[call("edit_file", {
                "path": "a.txt", "old_text": "a", "new_text": "updated",
            })]),
            response("updated"),
        ])
        agent = Agent(provider, workdir=self.workdir, mode="full",
                      interactive=False, skills_dirs=[])
        self.assertEqual(agent.run("create"), "done")
        self.assertEqual(agent.run("edit"), "updated")
        self.assertEqual([x["files"] for x in agent.checkpoints.history()], [2, 1])
        agent.checkpoints.undo()
        self.assertEqual((self.workdir / "a.txt").read_text(), "a")
        self.assertTrue((self.workdir / "b.txt").exists())
        agent.checkpoints.undo()
        self.assertFalse((self.workdir / "a.txt").exists())
        self.assertFalse((self.workdir / "b.txt").exists())

    def test_child_agent_shares_parent_checkpoint_for_delegated_work(self):
        provider = Scripted([
            response(calls=[call("delegate", {"task": "write", "max_turns": 2})]),
            response(calls=[call("write_file", {
                "path": "child.txt", "content": "from child",
            })]),
            response("child done"),
            response("parent done"),
        ])
        agent = Agent(provider, workdir=self.workdir, mode="full",
                      interactive=False, skills_dirs=[])
        self.assertEqual(agent.run("delegate child"), "parent done")
        self.assertEqual(len(agent.checkpoints.history()), 1)
        agent.checkpoints.undo()
        self.assertFalse((self.workdir / "child.txt").exists())


if __name__ == "__main__":
    unittest.main()
