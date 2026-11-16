"""Authored-only regression checks for the opt-in execution journal boundary.

Not executed as part of this change.
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from angel.agent import Agent, AgentError
from angel.tool_journal import ToolJournal, JournalError


class FakeProvider:
    def __init__(self, name="read_file"):
        self.name = name
        self.calls = 0

    def chat(self, messages, tools=None):
        self.calls += 1
        if self.calls == 1:
            return {"choices": [{"message": {"content": "", "tool_calls": [{
                "id": "call_one",
                "type": "function",
                "function": {"name": self.name, "arguments": "{}"},
            }]}}]}
        return {"choices": [{"message": {"content": "done"}}]}


class JournalBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.journal = ToolJournal("sessionone", root=self.root / "journal")

    def agent(self, journal):
        return Agent(
            provider=FakeProvider(), workdir=self.root, mode="readonly",
            interactive=False, session_id="sessionone",
            tool_journal=journal, skills_dirs=[],
        )

    def test_default_disabled_does_not_write_journal(self):
        with mock.patch("angel.agent.execute_tool", return_value="ok"), \
             mock.patch("angel.agent.save_session"):
            result = self.agent(None).run("read")
        self.assertEqual(result, "done")
        self.assertFalse(self.journal.path.exists())

    def test_opt_in_persists_intent_before_tool_and_result_after(self):
        seen = []
        def fake_execute(name, args, ctx):
            seen.append(self.journal.inspect())
            return "ok"
        with mock.patch("angel.agent.execute_tool", side_effect=fake_execute), \
             mock.patch("angel.agent.save_session"):
            result = self.agent(self.journal).run("read")
        self.assertEqual(result, "done")
        self.assertEqual(seen[0]["tool_intents"], 1)
        self.assertEqual(seen[0]["unknown_outcomes"], 1)
        report = self.journal.inspect()
        self.assertEqual(report["reported_ok"], 1)
        self.assertEqual(report["unknown_outcomes"], 0)
        self.assertFalse(report["safe_to_auto_resume"])
        self.assertFalse(report["execution_verified"])

    def test_failed_intent_blocks_execution(self):
        with mock.patch.object(self.journal, "begin", side_effect=JournalError("disk")), \
             mock.patch("angel.agent.execute_tool") as execute, \
             mock.patch("angel.agent.save_session"):
            with self.assertRaisesRegex(AgentError, "未执行"):
                self.agent(self.journal).run("read")
        execute.assert_not_called()

    def test_failed_result_write_stops_and_reports_unknown(self):
        with mock.patch.object(self.journal, "finish", side_effect=JournalError("disk")), \
             mock.patch("angel.agent.execute_tool", return_value="ok") as execute, \
             mock.patch("angel.agent.save_session"):
            with self.assertRaisesRegex(AgentError, "状态未知"):
                self.agent(self.journal).run("read")
        execute.assert_called_once()
        self.assertEqual(self.journal.inspect()["unknown_outcomes"], 1)

    def test_tool_exception_is_logged_as_error_and_stops_without_retry(self):
        with mock.patch(
            "angel.agent.execute_tool",
            side_effect=RuntimeError("secret=DO_NOT_DISCLOSE"),
        ) as execute, mock.patch("angel.agent.save_session"):
            with self.assertRaises(AgentError) as captured:
                self.agent(self.journal).run("read")
        execute.assert_called_once()
        self.assertNotIn("DO_NOT_DISCLOSE", str(captured.exception))
        self.assertIn("禁止自动重试", str(captured.exception))
        report = self.journal.inspect()
        self.assertEqual(report["reported_errors"], 1)
        self.assertEqual(report["unknown_outcomes"], 0)
        self.assertFalse(report["execution_verified"])
        self.assertFalse(report["safe_to_auto_resume"])

    def test_exception_result_write_failure_remains_unknown(self):
        with mock.patch(
            "angel.agent.execute_tool", side_effect=RuntimeError("secret"),
        ) as execute, mock.patch.object(
            self.journal, "finish", side_effect=JournalError("disk full"),
        ), mock.patch("angel.agent.save_session"):
            with self.assertRaisesRegex(AgentError, "状态未知"):
                self.agent(self.journal).run("read")
        execute.assert_called_once()
        self.assertEqual(self.journal.inspect()["unknown_outcomes"], 1)

    def test_exception_without_journal_still_fails_closed(self):
        with mock.patch(
            "angel.agent.execute_tool", side_effect=RuntimeError("private"),
        ) as execute, mock.patch("angel.agent.save_session"):
            with self.assertRaisesRegex(AgentError, "禁止自动重试"):
                self.agent(None).run("read")
        execute.assert_called_once()
        self.assertFalse(self.journal.path.exists())

    def test_tool_error_is_not_reported_as_success(self):
        with mock.patch("angel.agent.execute_tool", return_value="错误：permission denied"), \
             mock.patch("angel.agent.save_session"):
            self.agent(self.journal).run("read")
        self.assertEqual(self.journal.inspect()["reported_errors"], 1)
        self.assertFalse(self.journal.inspect()["execution_verified"])


if __name__ == "__main__":
    unittest.main()
