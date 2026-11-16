"""Regression tests for provider token usage and honest context budgets."""

import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import angel.agent as agent_module
import angel.cli as cli
import angel.memory as memory_module
from angel.agent import Agent
from angel.usage import UsageTracker, context_limit, format_usage


def reply(content, usage=None):
    response = {"choices": [{"message": {"role": "assistant", "content": content}}]}
    if usage is not None:
        response["usage"] = usage
    return response


class Provider:
    name = "mock"
    model = "mock-model"

    def __init__(self, responses=None):
        self.responses = list(responses or [reply("完成")])

    def has_credentials(self):
        return True

    def chat(self, messages, tools=None, timeout=120):
        return self.responses.pop(0)


class UsageTest(unittest.TestCase):
    def test_provider_reported_tokens_and_configured_window(self):
        tracker = UsageTracker(configured_window=8192)
        tracker.record(reply("ok", {
            "prompt_tokens": 1000, "completion_tokens": 200,
            "total_tokens": 1200,
        }))
        value = tracker.snapshot()
        self.assertEqual((value["calls"], value["reported_calls"]), (1, 1))
        self.assertEqual(value["total_tokens"], 1200)
        self.assertEqual(value["last_prompt_tokens"], 1000)
        self.assertEqual(value["context_remaining_tokens"], 7192)
        self.assertIn("7,192", format_usage(value))

    def test_missing_usage_is_not_fabricated(self):
        tracker = UsageTracker()
        tracker.record(reply("无 token 统计"))
        value = tracker.snapshot()
        self.assertEqual(value["missing_calls"], 1)
        self.assertIsNone(value["prompt_tokens"])
        self.assertIsNone(value["total_tokens"])
        self.assertIsNone(value["context_remaining_tokens"])
        self.assertIn("未知", format_usage(value))
        self.assertIn("累计值不完整", format_usage(value))

    def test_partial_usage_and_alias_fields(self):
        tracker = UsageTracker(configured_window=4000)
        tracker.record(reply("first", {"input_tokens": 8, "output_tokens": 5}))
        tracker.record(reply("second", {"prompt_tokens": 7}))
        tracker.record(reply("third"))
        value = tracker.snapshot()
        self.assertEqual(value["prompt_tokens"], 15)
        self.assertEqual(value["completion_tokens"], 5)
        self.assertEqual(value["total_tokens"], 13)
        self.assertEqual(value["reported_calls"], 2)
        self.assertEqual(value["missing_calls"], 1)
        self.assertEqual(value["context_remaining_tokens"], 3993)
        self.assertEqual(value["total_samples"], 1)

    def test_invalid_numbers_never_count(self):
        tracker = UsageTracker(configured_window=100)
        tracker.record(reply("fake", {
            "prompt_tokens": True, "completion_tokens": -20, "total_tokens": "99"
        }))
        self.assertEqual(tracker.snapshot()["reported_calls"], 0)
        self.assertIsNone(tracker.snapshot()["total_tokens"])
        self.assertEqual(context_limit(True), None)
        self.assertEqual(context_limit(0), None)
        self.assertEqual(context_limit("8000"), None)
        tracker.record(reply("valid", {"prompt_tokens": 150, "completion_tokens": 3}))
        self.assertEqual(tracker.snapshot()["context_remaining_tokens"], 0)

    def test_no_context_limit_does_not_guess_model_capacity(self):
        tracker = UsageTracker()
        tracker.record(reply("ok", {"prompt_tokens": 40, "completion_tokens": 5}))
        self.assertIsNone(tracker.snapshot()["context_remaining_tokens"])
        self.assertIn("未配置", format_usage(tracker.snapshot()))


class RuntimeUsageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patches = [
            mock.patch.object(agent_module, "ANGEL_HOME", self.root / "home"),
            mock.patch.object(memory_module, "SESSIONS_DIR", self.root / "sessions"),
        ]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patches):
            patcher.stop()
        self.tmp.cleanup()

    def test_agent_tracks_reported_calls_and_emits_usage(self):
        events = []
        p = Provider([reply("hello", {
            "prompt_tokens": 70, "completion_tokens": 12, "total_tokens": 82
        })])
        agent = Agent(p, workdir=self.root, mode="readonly", interactive=False,
                      skills_dirs=[], context_window_tokens=200,
                      on_event=lambda k, d: events.append((k, d)))
        self.assertEqual(agent.run("你好"), "hello")
        self.assertEqual(agent.usage.snapshot()["total_tokens"], 82)
        self.assertEqual(agent.usage.snapshot()["context_remaining_tokens"], 130)
        self.assertEqual([k for k, _ in events], ["usage", "final"])

    def test_cli_status_and_one_shot_stderr_not_stdout(self):
        config = {
            "provider": "deepseek", "model": "deepseek-flash", "mode": "readonly",
            "max_turns": 3, "profiles": {}, "context_window_tokens": 2048
        }

        class CLIProvider(Provider):
            def __init__(self, cfg):
                super().__init__([reply("final", {
                    "prompt_tokens": 80, "completion_tokens": 20, "total_tokens": 100,
                })])

        with mock.patch.object(cli, "load_config", return_value=config), \
             mock.patch.object(cli, "Provider", CLIProvider), \
             mock.patch.object(cli, "build_mcp_manager", return_value=None), \
             mock.patch.object(cli, "describe_provider", return_value="mock"), \
             mock.patch("sys.stdout", new_callable=io.StringIO) as out, \
             mock.patch("sys.stderr", new_callable=io.StringIO) as err:
            code = cli.main(["--provider", "deepseek", "--mode", "readonly",
                             "--context-window", "2048", "hello"])
            self.assertEqual(code, 0)
            self.assertIn("final", out.getvalue())
            self.assertNotIn("Token", out.getvalue())
            self.assertIn("输入 80", err.getvalue())
            self.assertIn("1,968", err.getvalue())

        with mock.patch.object(cli, "load_config", return_value=config), \
             mock.patch.object(cli, "Provider", CLIProvider), \
             mock.patch.object(cli, "build_mcp_manager", return_value=None), \
             mock.patch.object(cli, "describe_provider", return_value="mock"), \
             mock.patch("sys.stdin", io.StringIO()), \
             mock.patch("builtins.input", side_effect=["/status", "/exit"]), \
             mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            self.assertEqual(cli.main(["--provider", "deepseek", "--mode", "readonly"]), 0)
            self.assertIn("模型调用：0 次", out.getvalue())
            self.assertIn("上下文剩余：未知", out.getvalue())

    def test_ui_exposes_per_session_usage_and_page_status(self):
        from angel.webui import UIState
        from angel.webui_page import PAGE_HTML

        state = UIState(self.root, context_window_tokens=4096,
                        provider_factory=lambda: Provider([reply("hi", {
                            "prompt_tokens": 66, "completion_tokens": 9,
                            "total_tokens": 75,
                        })]))
        run = state.send("status-room", "hello")
        run.thread.join(timeout=5)
        self.assertEqual(run.status, "done")
        view = state.session_view("status-room")
        self.assertEqual(view["usage"]["total_tokens"], 75)
        self.assertEqual(view["usage"]["context_remaining_tokens"], 4030)
        self.assertIn('id="usage-kv"', PAGE_HTML)
        self.assertIn("renderUsage(v.usage,v.auto_compact_count||0)", PAGE_HTML)


if __name__ == "__main__":
    unittest.main()
