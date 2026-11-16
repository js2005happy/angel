"""Automatic context compaction guards and Agent/CLI/UI integration."""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import angel.agent as agent_module
import angel.memory as memory_module
from angel.agent import Agent
from angel.compact import (
    compact_messages, should_auto_compact, validate_auto_compact_threshold
)


def response(content="done", prompt_tokens=None, tool_calls=None):
    message = {"role": "assistant", "content": content}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
    result = {"choices": [{"message": message}]}
    if prompt_tokens is not None:
        result["usage"] = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": 20,
            "total_tokens": prompt_tokens + 20,
        }
    return result


class ScriptedProvider:
    name = "mock"
    model = "mock"

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def has_credentials(self):
        return True

    def chat(self, messages, tools=None, timeout=120):
        self.calls.append((list(messages), tools))
        result = self.replies.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class AutoCompactRulesTest(unittest.TestCase):
    def test_threshold_from_reported_usage_only(self):
        ok = {
            "last_prompt_tokens": 800, "context_window_tokens": 1000
        }
        self.assertTrue(should_auto_compact(ok, 5))
        self.assertFalse(should_auto_compact(ok, 4))
        self.assertFalse(should_auto_compact({**ok, "last_prompt_tokens": None}, 5))
        self.assertFalse(should_auto_compact({**ok, "context_window_tokens": None}, 5))
        self.assertFalse(should_auto_compact({**ok, "last_prompt_tokens": 799}, 5))
        self.assertFalse(should_auto_compact({**ok, "last_prompt_tokens": True}, 5))
        self.assertFalse(should_auto_compact({**ok, "context_window_tokens": True}, 5))

    def test_threshold_validation_rejects_invalid_values(self):
        for value in (0, 0.1, 1, 80, True, None, "0.8", float("nan")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_auto_compact_threshold(value)
        self.assertEqual(validate_auto_compact_threshold(0.65), 0.65)

    def test_strict_failure_keeps_original_and_manual_fallback_remains(self):
        messages = [{"role": "user", "content": "重要数据"}] * 6
        failed = ScriptedProvider([RuntimeError("provider unavailable")])
        with self.assertRaises(RuntimeError):
            compact_messages(failed, messages, keep_last=0, strict=True)
        self.assertEqual(len(messages), 6)
        recovered = ScriptedProvider([RuntimeError("provider unavailable")])
        reduced, info = compact_messages(recovered, messages, keep_last=2)
        self.assertEqual(info["method"], "fallback")
        self.assertIn("压缩失败", reduced[0]["content"])


class AgentAutoCompactTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workdir = Path(self.tmp.name)
        self.p1 = mock.patch.object(agent_module, "ANGEL_HOME", self.workdir / "home")
        self.p2 = mock.patch.object(memory_module, "SESSIONS_DIR", self.workdir / "sessions")
        self.p1.start()
        self.p2.start()
        self.previous = [
            {"role": "user" if idx % 2 == 0 else "assistant",
             "content": ("prior context %s " % idx) * 90}
            for idx in range(6)
        ]

    def tearDown(self):
        self.p2.stop()
        self.p1.stop()
        self.tmp.cleanup()

    def agent(self, provider, enabled=True, window=1000, events=None):
        a = Agent(
            provider, workdir=self.workdir, mode="readonly", interactive=False,
            skills_dirs=[], messages=list(self.previous), max_turns=5,
            auto_compact_enabled=enabled, context_window_tokens=window,
            on_event=(lambda kind, data: events.append((kind, data))) if events is not None else None,
        )
        a.usage.record(response("history", prompt_tokens=830))
        return a

    def test_success_compacts_before_next_request_and_preserves_session(self):
        events = []
        provider = ScriptedProvider([
            response("已完成：保留目标和关键事实", prompt_tokens=500),
            response("继续成功", prompt_tokens=200),
        ])
        agent = self.agent(provider, events=events)
        self.assertEqual(agent.run("现在继续"), "继续成功")
        self.assertEqual(agent.auto_compact_count, 1)
        self.assertEqual(len(provider.calls), 2)
        self.assertIsNone(provider.calls[0][1])  # model summary; no tools
        self.assertIsNotNone(provider.calls[1][1])  # normal agent
        summary = provider.calls[1][0][1]
        self.assertTrue(summary["content"].startswith("[此前会话摘要]"))
        self.assertNotIn("prior context 0", str(provider.calls[1][0]))
        persisted = memory_module.load_session(agent.session_id)
        self.assertEqual(persisted[0]["content"], summary["content"])
        self.assertEqual(persisted[-1]["content"], "继续成功")
        self.assertIn("auto_compact", [e[0] for e in events])
        self.assertEqual(agent.usage.snapshot()["calls"], 3)  # includes paid summary

    def test_summary_failure_preserves_transcript_and_continues(self):
        events = []
        provider = ScriptedProvider([
            RuntimeError("do not show secret internal exception"),
            response("已答复"),
        ])
        agent = self.agent(provider, events=events)
        self.assertEqual(agent.run("继续"), "已答复")
        self.assertEqual(agent.auto_compact_count, 0)
        normal_request = provider.calls[1][0]
        self.assertTrue(any("prior context 0" in m["content"] for m in normal_request))
        self.assertTrue(any("prior context 0" in m["content"] for m in agent.messages))
        self.assertIn("auto_compact_failed", [e[0] for e in events])
        self.assertNotIn("secret internal", str(events))

    def test_no_usage_or_no_window_does_not_make_extra_call(self):
        for window in (None, 1000):
            provider = ScriptedProvider([response("answer")])
            agent = self.agent(provider, window=window)
            if window is not None:
                agent.usage.last_prompt_tokens = None
            self.assertEqual(agent.run("now"), "answer")
            self.assertEqual(len(provider.calls), 1)
            self.assertEqual(agent.auto_compact_count, 0)

    def test_opt_out_does_not_call_summary(self):
        provider = ScriptedProvider([response("answer")])
        agent = self.agent(provider, enabled=False)
        self.assertEqual(agent.run("now"), "answer")
        self.assertEqual(len(provider.calls), 1)

    def test_summary_larger_than_history_is_not_applied(self):
        provider = ScriptedProvider([
            response("oversized summary " * 2000),
            response("answer"),
        ])
        agent = self.agent(provider)
        self.assertEqual(agent.run("continue"), "answer")
        self.assertEqual(agent.auto_compact_count, 0)
        self.assertIn("prior context 0", str(provider.calls[1][0]))

    def test_single_compaction_per_run_even_if_usage_stays_high(self):
        call = {
            "id": "test-call",
            "type": "function",
            "function": {"name": "list_dir", "arguments": '{"path":"."}'},
        }
        provider = ScriptedProvider([
            response("compressed"),
            response("", prompt_tokens=850, tool_calls=[call]),
            response("final answer", prompt_tokens=900),
        ])
        agent = self.agent(provider)
        self.assertEqual(agent.run("continue"), "final answer")
        self.assertEqual(agent.auto_compact_count, 1)
        self.assertEqual(len(provider.calls), 3)

    def test_ui_can_show_count(self):
        from angel.webui import UIState
        from angel.webui_page import PAGE_HTML
        state = UIState(
            self.workdir, auto_compact_enabled=True,
            auto_compact_threshold=0.75, context_window_tokens=1000,
            provider_factory=lambda: ScriptedProvider([response("hi")]),
        )
        view = state.session_view("no-agent")
        self.assertEqual(view["auto_compact_count"], 0)
        self.assertIn("自动压缩次数", PAGE_HTML)
        self.assertEqual(state.auto_compact_threshold, 0.75)
        self.assertTrue(state.auto_compact_enabled)


if __name__ == "__main__":
    unittest.main()
