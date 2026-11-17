"""结果自证：只认验证命令的真实退出码。"""
from types import SimpleNamespace
import json
import unittest
from pathlib import Path
import tempfile
from unittest.mock import patch

from nyra import memory
from nyra.agent import Agent
from nyra.runs import (
    RunRecorder, RunStore, format_run_report, resolve_verify_command,
    tests_modified,
)


class VerifyHelperTests(unittest.TestCase):
    def test_resolve_priority_and_agents(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "AGENTS.md").write_text("verify: from-agents\n", encoding="utf-8")
            self.assertEqual(resolve_verify_command("cli", {"verify_command": "cfg"}, root), "cli")
            self.assertEqual(resolve_verify_command(None, {"verify_command": "cfg"}, root), "cfg")
            self.assertEqual(resolve_verify_command(None, {}, root), "from-agents")
            self.assertIsNone(resolve_verify_command(None, {}, root / "missing"))

    def test_test_path_patterns(self):
        self.assertEqual(
            tests_modified(["src/app.py", "tests/test_app.py", "foo_test.py", "README.md", "test_utils.py"]),
            ["tests/test_app.py", "foo_test.py", "test_utils.py"],
        )

    def test_report_never_says_verified_unless_verified(self):
        state = {
            "status": "completed_unverified",
            "changed_files": [],
            "verify_cmd": None,
            "verify_result": None,
        }
        text = format_run_report(state)
        self.assertIn("未验证", text)
        self.assertNotIn("已验证", text)
        state["status"] = "verified"
        state["verify_cmd"] = "true"
        state["verify_result"] = {"exit_code": 0, "passed": True}
        self.assertIn("已验证", format_run_report(state))


class VerifyRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = RunStore(self.root / "runs")
        for target, value in [
            ("nyra.agent.NYRA_HOME", self.root),
            ("nyra.memory.SESSIONS_DIR", self.root / "sessions"),
            ("nyra.runs.NYRA_HOME", self.root),
        ]:
            p = patch(target, value)
            p.start()
            self.addCleanup(p.stop)

    def run_with(self, replies, verify_cmd=None, retries=2, approve=True, **kwargs):
        class Provider:
            def chat(self, messages, tools):
                self.last = messages
                item = replies.pop(0)
                if callable(item):
                    item(messages)
                    item = replies.pop(0)
                return {"choices": [{"message": item}]}

        provider = Provider()
        agent = Agent(provider, self.root, mode="full", max_turns=kwargs.get("max_turns", 6), skills_dirs=[])
        if approve is not True and approve is not False:
            agent.ctx.approve_fn = approve
        recorder = RunRecorder(
            self.store, agent, "任务", verify_cmd=verify_cmd, verify_retries=retries,
        )
        with patch.object(agent, "build_system_prompt", return_value="系统"):
            output = recorder.run("任务")
        return self.store.load(recorder.run_id), output, provider, recorder

    def test_success_is_verified_from_exit_code(self):
        state, output, _, _ = self.run_with([{"content": "做好了"}], verify_cmd="python3 -c 'import sys; sys.exit(0)'")
        self.assertEqual(state["status"], "verified")
        self.assertTrue(state["verify_result"]["passed"])
        self.assertEqual(state["verify_result"]["exit_code"], 0)
        self.assertIn("已验证", output)
        self.assertIn("退出码：0", output)

    def test_model_claim_without_command_stays_unverified(self):
        state, output, _, _ = self.run_with([{"content": "已全部验证通过，测试通过"}])
        self.assertEqual(state["status"], "completed_unverified")
        self.assertIn("未验证", output)
        self.assertNotIn("已验证", output)

    def test_fail_then_fix_retries_and_verified(self):
        marker = self.root / "flag.txt"
        cmd = f"python3 -c \"import pathlib,sys; p=pathlib.Path(r'{marker}'); sys.exit(0 if p.exists() else 1)\""

        def repair(messages):
            # 失败输出必须是 tool 角色，且带不可信标记。
            tools = [m for m in messages if m.get("role") == "tool"]
            self.assertTrue(tools)
            self.assertIn("untrusted_data", tools[-1]["content"])
            self.assertNotEqual(tools[-1].get("role"), "user")
            marker.write_text("ok", encoding="utf-8")

        replies = [{"content": "先交卷"}, repair, {"content": "已修好"}]
        state, output, provider, recorder = self.run_with(replies, verify_cmd=cmd, retries=2)
        self.assertEqual(state["status"], "verified")
        self.assertEqual(state["verify_result"]["attempt"], 2)
        self.assertIn("已验证", output)
        # 确认没有把验证输出当成 user 消息。
        session = memory.load_session(state["session_id"])
        verify_tools = [m for m in session if m.get("role") == "tool" and "untrusted_data" in str(m.get("content"))]
        self.assertEqual(len(verify_tools), 1)
        self.assertFalse(any(m.get("role") == "user" and "验证失败" in str(m.get("content")) for m in session))

    def test_always_fail_is_verify_failed(self):
        state, output, _, recorder = self.run_with(
            [{"content": "一次"}, {"content": "二次"}, {"content": "三次"}],
            verify_cmd="python3 -c 'import sys; sys.exit(7)'",
            retries=2,
        )
        self.assertEqual(state["status"], "verify_failed")
        self.assertEqual(state["verify_result"]["exit_code"], 7)
        self.assertEqual(state["verify_result"]["attempt"], 3)
        self.assertNotIn("已验证", output)
        self.assertIn("退出码：7", output)

    def test_frozen_command_ignores_later_agents_md(self):
        (self.root / "AGENTS.md").write_text("verify: python3 -c 'import sys; sys.exit(0)'\n", encoding="utf-8")
        cmd = resolve_verify_command(None, {}, self.root)
        self.assertEqual(cmd, "python3 -c 'import sys; sys.exit(0)'")

        def rewrite(messages):
            (self.root / "AGENTS.md").write_text("verify: true\n", encoding="utf-8")

        # 命令在建任务时已冻结为 exit 0；即使 AGENTS.md 被改成 true，仍用原命令。
        state, output, _, _ = self.run_with(
            [rewrite, {"content": "改了说明"}],
            verify_cmd=cmd,
        )
        self.assertEqual(state["verify_cmd"], cmd)
        self.assertNotEqual(state["verify_cmd"], "true")
        self.assertEqual(state["status"], "verified")

    def test_modified_tests_are_flagged(self):
        call = {
            "id": "1",
            "function": {"name": "write_file", "arguments": json.dumps({"path": "tests/test_app.py", "content": "x"})},
        }
        state, output, _, _ = self.run_with(
            [{"tool_calls": [call]}, {"content": "写完了"}],
            verify_cmd="python3 -c 'import sys; sys.exit(0)'",
        )
        self.assertEqual(state["changed_files"], ["tests/test_app.py"])
        self.assertTrue(state["verify_result"]["tests_modified"])
        self.assertIn("【测试文件被修改】", output)
        self.assertEqual(state["status"], "verified")


class VerifyCLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for target, value in [
            ("nyra.agent.NYRA_HOME", self.root),
            ("nyra.cli.NYRA_HOME", self.root),
            ("nyra.runs.NYRA_HOME", self.root),
            ("nyra.memory.SESSIONS_DIR", self.root / "sessions"),
        ]:
            p = patch(target, value)
            p.start()
            self.addCleanup(p.stop)

    def invoke(self, argv, replies=None):
        import io
        from contextlib import ExitStack, redirect_stdout, redirect_stderr
        from nyra import cli, json_mode
        from tests.test_json_mode import FakeProvider, assistant
        provider = FakeProvider(replies or [assistant("完成")])
        out, err = io.StringIO(), io.StringIO()
        with ExitStack() as stack:
            stack.enter_context(redirect_stdout(out))
            stack.enter_context(redirect_stderr(err))
            for module in (cli, json_mode):
                stack.enter_context(patch.object(module, "load_config", return_value={"sandbox": "local"}))
                stack.enter_context(patch.object(module, "resolve_profile", return_value={"mode": "full", "provider": None, "model": None}))
                stack.enter_context(patch.object(module, "resolve_provider", return_value=SimpleNamespace(name="mock", model="fake-model")))
                stack.enter_context(patch.object(module, "Provider", return_value=provider))
                stack.enter_context(patch.object(module, "build_mcp_manager", return_value=None))
            stack.enter_context(patch.object(Agent, "build_system_prompt", return_value="系统"))
            code = cli.main(argv + ["--mode", "full", "--workdir", str(self.root)])
        return code, out.getvalue(), err.getvalue()

    def test_json_verify_fail_exit_4(self):
        code, out, err = self.invoke(
            ["--json", "做任务", "--verify", "python3 -c 'import sys; sys.exit(3)'", "--verify-retries", "0"],
        )
        self.assertEqual(code, 4, err + out)
        events = [json.loads(line) for line in out.splitlines() if line.strip()]
        types = [e["type"] for e in events]
        self.assertIn("verify_started", types)
        self.assertIn("verify_result", types)
        failed = [e for e in events if e["type"] == "run_failed"][0]
        self.assertEqual(failed["error"]["code"], "verify_failed")
        self.assertEqual(failed["exit_code"], 4)
        self.assertFalse(failed["verified"])
        self.assertIn("未验证" if False else "verify_failed", failed["output"] + failed.get("status", ""))
        self.assertNotIn("已验证", failed["output"])

    def test_json_verify_pass_and_unverified(self):
        code, out, err = self.invoke(
            ["--json", "做任务", "--verify", "python3 -c 'import sys; sys.exit(0)'"],
        )
        self.assertEqual(code, 0, err + out)
        events = [json.loads(line) for line in out.splitlines() if line.strip()]
        completed = [e for e in events if e["type"] == "run_completed"][0]
        self.assertTrue(completed["verified"])
        self.assertEqual(completed["status"], "verified")
        self.assertIn("已验证", completed["output"])

        code, out, err = self.invoke(["--json", "做任务"])
        self.assertEqual(code, 0, err + out)
        events = [json.loads(line) for line in out.splitlines() if line.strip()]
        completed = [e for e in events if e["type"] == "run_completed"][0]
        self.assertFalse(completed["verified"])
        self.assertEqual(completed["status"], "completed_unverified")
        self.assertIn("未验证", completed["output"])
        self.assertNotIn("已验证", completed["output"])


if __name__ == "__main__":
    unittest.main()
