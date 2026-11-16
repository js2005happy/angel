"""Plan mode: read-only inspection, immutable review hash, safe execution gate."""

import hashlib
import io
import json
from pathlib import Path
import re
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

import angel.cli as cli
from angel.plan_mode import (
    PlanError, approved_execution_task, build_plan, read_approved_plan,
    render_plan, save_plan,
)


def response(text="", calls=None):
    message = {"role": "assistant", "content": text}
    if calls is not None:
        message["tool_calls"] = calls
    return {"choices": [{"message": message}]}


def call(name, arguments, cid="call-1"):
    return {
        "id": cid, "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


class FakePlanner:
    name = "mock"
    model = "fake-model"

    def __init__(self, responses=None):
        self.responses = list(responses or [response("1. 修改单元测试\n2. 验证全部通过")])
        self.calls = []

    def has_credentials(self):
        return True

    def chat(self, messages, tools=None, timeout=120):
        self.calls.append((list(messages), tools))
        return self.responses.pop(0)


class PlanCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "sample.py").write_text("print('original')\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_model_can_read_workspace_but_cannot_run_tools(self):
        planner = FakePlanner([
            response(calls=[call("read_file", {"path": "sample.py"})]),
            response("1. 修复 sample.py\n2. 运行 unittest"),
        ])
        details = build_plan(planner, "修复 sample.py", self.root)
        self.assertIn("修复", details)
        self.assertEqual(len(planner.calls), 2)
        schemas = planner.calls[0][1]
        self.assertEqual(
            {s["function"]["name"] for s in schemas},
            {"read_file", "list_dir"},
        )
        history = planner.calls[1][0]
        self.assertTrue(any(
            m["role"] == "tool" and "original" in m["content"]
            for m in history
        ))
        self.assertEqual((self.root / "sample.py").read_text(encoding="utf-8"),
                         "print('original')\n")
        self.assertFalse((self.root / "plan.md").exists())

        plan = render_plan("修复 sample.py", details)
        digest = save_plan(self.root, plan)
        self.assertEqual(len(digest), 64)
        self.assertEqual(read_approved_plan(self.root, digest), plan)
        self.assertEqual(
            hashlib.sha256((self.root / "plan.md").read_bytes()).hexdigest(),
            digest,
        )
        self.assertEqual(
            sorted(p.name for p in self.root.iterdir()),
            ["plan.md", "sample.py"],
        )

    def test_shell_and_other_mutating_tools_are_never_invoked(self):
        for name in ("shell", "write_file", "mcp_untrusted_run", "plan"):
            with self.subTest(name=name):
                planner = FakePlanner([
                    response(calls=[call(name, {"path": "sample.py"})]),
                ])
                with mock.patch("angel.plan_mode.execute_tool") as execute:
                    with self.assertRaisesRegex(PlanError, "拒绝"):
                        build_plan(planner, "检查项目", self.root)
                    execute.assert_not_called()
                self.assertFalse((self.root / "plan.md").exists())

    def test_escaping_absolute_path_and_symlinks_are_rejected(self):
        outside = self.root.parent / (self.root.name + "-external.txt")
        outside.write_text("PRIVATE", encoding="utf-8")
        try:
            for path in ("../" + outside.name, str(outside)):
                with self.subTest(path=path):
                    planner = FakePlanner([
                        response(calls=[call("read_file", {"path": path})]),
                    ])
                    with self.assertRaisesRegex(PlanError, "工作目录之外"):
                        build_plan(planner, "检查项目", self.root)
            symlink = self.root / "outside"
            try:
                symlink.symlink_to(outside)
            except (OSError, NotImplementedError):
                return
            planner = FakePlanner([
                response(calls=[call("read_file", {"path": "outside"})]),
            ])
            with self.assertRaisesRegex(PlanError, "工作目录之外"):
                build_plan(planner, "检查项目", self.root)
            self.assertFalse((self.root / "plan.md").exists())
        finally:
            outside.unlink(missing_ok=True)

    def test_plan_symlink_cannot_be_overwritten(self):
        outside = self.root.parent / (self.root.name + "-target.txt")
        outside.write_text("keep me", encoding="utf-8")
        try:
            link = self.root / "plan.md"
            try:
                link.symlink_to(outside)
            except (OSError, NotImplementedError):
                return
            with self.assertRaisesRegex(PlanError, "符号链接"):
                save_plan(self.root, render_plan("task", "step"))
            self.assertEqual(outside.read_text(encoding="utf-8"), "keep me")
        finally:
            outside.unlink(missing_ok=True)

    def test_sha_approval_invalidated_by_any_edit(self):
        digest = save_plan(self.root, render_plan("原任务", "步骤一"))
        self.assertEqual(read_approved_plan(self.root, digest),
                         (self.root / "plan.md").read_text(encoding="utf-8"))
        (self.root / "plan.md").write_text(
            render_plan("原任务", "修改后的步骤"), encoding="utf-8",
        )
        with self.assertRaisesRegex(PlanError, "已变更|不匹配"):
            read_approved_plan(self.root, digest)
        with self.assertRaisesRegex(PlanError, "64 位"):
            read_approved_plan(self.root, digest[:12])

    def test_failed_planning_does_not_modify_previous_plan(self):
        original = render_plan("task", "existing steps")
        save_plan(self.root, original)
        provider = FakePlanner([response("")])
        with self.assertRaisesRegex(PlanError, "没有生成"):
            build_plan(provider, "新任务", self.root)
        self.assertEqual((self.root / "plan.md").read_text(encoding="utf-8"),
                         original)

    def test_invalid_or_excessive_tool_calls_fail_closed(self):
        provider = FakePlanner([
            response(calls=[call("list_dir", {"path": ".", "command": "rm -rf ."}
                                )])
        ])
        with self.assertRaisesRegex(PlanError, "不支持"):
            build_plan(provider, "inspect", self.root)
        provider = FakePlanner([
            response(calls=[call("read_file", {"path": "sample.py"})] * 13),
        ])
        with self.assertRaisesRegex(PlanError, "上限"):
            build_plan(provider, "inspect", self.root)
        self.assertFalse((self.root / "plan.md").exists())

    def test_execution_task_does_not_grant_permission(self):
        message = approved_execution_task(render_plan("task", "step"))
        self.assertIn("仍然必须遵守当前的工具权限", message)
        self.assertIn("plan.md", message)


class PlanCLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cfg = {
            "provider": "mock", "model": "mock-model",
            "mode": "full", "sandbox": "e2b",
            "max_turns": 3, "profiles": {},
        }

    def tearDown(self):
        self.temp.cleanup()

    def _main(self, argv, planner=None):
        out = io.StringIO()
        err = io.StringIO()
        planner = planner or FakePlanner()
        with mock.patch.object(cli, "load_config", return_value=self.cfg), \
             mock.patch.object(cli, "resolve_provider", return_value=SimpleNamespace(
                 name="mock", model="fake-model"
             )), \
             mock.patch.object(cli, "Provider", return_value=planner), \
             mock.patch("sys.stdout", out), mock.patch("sys.stderr", err):
            code = cli.main(["--workdir", str(self.root), *argv])
        return code, out.getvalue(), err.getvalue()

    def test_plan_command_never_constructs_agent_mcp_or_sandbox(self):
        with mock.patch.object(cli, "Agent") as agent, \
             mock.patch.object(cli, "build_mcp_manager") as mcp, \
             mock.patch.object(cli, "connect_backend") as backend:
            code, output, _ = self._main(["--plan", "规划工作"])
        self.assertEqual(code, 0)
        self.assertIn("SHA-256：", output)
        agent.assert_not_called()
        mcp.assert_not_called()
        backend.assert_not_called()
        self.assertTrue((self.root / "plan.md").exists())
        self.assertEqual([p.name for p in self.root.iterdir()], ["plan.md"])

    def test_invalid_or_missing_approval_does_not_start_agent(self):
        save_plan(self.root, render_plan("task", "step"))
        with mock.patch.object(cli, "Agent") as agent:
            code, _, _ = self._main(["--execute-plan"])
            self.assertEqual(code, 2)
            code, _, _ = self._main([
                "--execute-plan", "--approve-plan", "0" * 64
            ])
            self.assertEqual(code, 2)
            agent.assert_not_called()

    def test_execute_uses_approved_text_but_defaults_to_auto(self):
        text = render_plan("user task", "step one")
        digest = save_plan(self.root, text)
        fake_agent = mock.MagicMock()
        fake_agent.run.return_value = "已按审批执行"
        fake_agent.usage.snapshot.return_value = {
            "calls": 0, "reported_calls": 0, "missing_calls": 0,
            "prompt_tokens": None, "completion_tokens": None,
            "total_tokens": None, "context_window_tokens": None,
            "last_prompt_tokens": None, "context_remaining_tokens": None,
        }
        with mock.patch.object(cli, "Agent", return_value=fake_agent) as agent_class, \
             mock.patch.object(cli, "build_mcp_manager", return_value=None), \
             mock.patch.object(cli, "connect_backend") as backend:
            code, output, _ = self._main([
                "--execute-plan", "--approve-plan", digest
            ])
        self.assertEqual(code, 0)
        self.assertIn("已按审批执行", output)
        self.assertEqual(agent_class.call_args.kwargs["mode"], "auto")
        task = fake_agent.run.call_args.args[0]
        self.assertIn(text, task)
        backend.assert_not_called()

    def test_readonly_execution_and_sandbox_planning_are_rejected(self):
        with mock.patch.object(cli, "Agent") as agent:
            code, _, _ = self._main([
                "--plan", "--sandbox", "e2b", "task"
            ])
            self.assertEqual(code, 2)
            digest = save_plan(self.root, render_plan("task", "steps"))
            code, _, _ = self._main([
                "--execute-plan", "--approve-plan", digest,
                "--mode", "readonly",
            ])
            self.assertEqual(code, 2)
            agent.assert_not_called()

    def test_plan_and_json_mode_conflict_is_machine_readable(self):
        stdout = io.StringIO()
        with mock.patch("sys.stdout", stdout):
            code = cli.main(["--json", "--plan", "task"])
        self.assertEqual(code, 2)
        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(events[0]["type"], "run_failed")


if __name__ == "__main__":
    unittest.main()
