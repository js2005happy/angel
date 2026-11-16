"""Session diagnosis tests; these tests are authored but not executed here."""

import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from angel import cli
from angel.session_diagnostics import inspect_session, SessionDiagnosisError


class SessionDiagnosisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, name, messages):
        path = self.root / (name + ".jsonl")
        path.write_text(
            "".join(json.dumps(m) + "\n" for m in messages), encoding="utf-8"
        )
        return path

    def test_completed_conversation_is_not_execution_verification(self):
        self.write("done", [
            {"role": "user", "content": "secret"},
            {"role": "assistant", "content": "finished"},
        ])
        report = inspect_session("done", root=self.root)
        self.assertEqual(report["state"], "conversation_ended")
        self.assertFalse(report["execution_verified"])
        self.assertFalse(report["safe_to_auto_resume"])
        self.assertNotIn("secret", str(report))
        self.assertNotIn("finished", str(report))

    def test_missing_tool_result_requires_review(self):
        self.write("pending", [
            {"role": "user", "content": "write something"},
            {"role": "assistant", "tool_calls": [
                {"id": "call-1", "function": {"name": "shell", "arguments": "secret"}}
            ]},
        ])
        report = inspect_session("pending", root=self.root)
        self.assertEqual(report["state"], "needs_review")
        self.assertEqual(report["unmatched_tool_calls"], 1)
        self.assertNotIn("secret", str(report))

    def test_tool_response_without_final_assistant_requires_review(self):
        self.write("tool-last", [
            {"role": "user", "content": "run"},
            {"role": "assistant", "tool_calls": [{"id": "c1"}]},
            {"role": "tool", "tool_call_id": "c1", "content": "secret"},
        ])
        report = inspect_session("tool-last", root=self.root)
        self.assertEqual(report["tool_calls"], 1)
        self.assertEqual(report["tool_responses"], 1)
        self.assertEqual(report["unmatched_tool_calls"], 0)
        self.assertEqual(report["state"], "needs_review")

    def test_corrupt_transcript_and_unpaired_tool_fail_closed(self):
        path = self.write("corrupt", [{"role": "user", "content": "a"}])
        with path.open("a", encoding="utf-8") as f:
            f.write("{invalid\n")
        with self.assertRaises(SessionDiagnosisError):
            inspect_session("corrupt", root=self.root)
        self.write("orphan", [{"role": "tool", "tool_call_id": "c1"}])
        with self.assertRaises(SessionDiagnosisError):
            inspect_session("orphan", root=self.root)

    def test_invalid_id_symlink_and_large_file_rejected(self):
        for name in ("../private", "/etc/passwd", "", "bad.jsonl/../x"):
            with self.subTest(name=name), self.assertRaises(SessionDiagnosisError):
                inspect_session(name, root=self.root)
        self.write("large", [{"role": "user", "content": "x" * (8 * 1024 * 1024)}])
        with self.assertRaises(SessionDiagnosisError):
            inspect_session("large", root=self.root)
        self.write("source", [{"role": "user", "content": "x"}])
        try:
            (self.root / "alias.jsonl").symlink_to(self.root / "source.jsonl")
        except (OSError, NotImplementedError):
            return
        with self.assertRaises(SessionDiagnosisError):
            inspect_session("alias", root=self.root)


    def test_empty_final_or_missing_user_requires_review(self):
        for name, messages in (
            ("empty", []),
            ("blank", [{"role": "user", "content": "x"}, {"role": "assistant", "content": " "}]),
            ("no-user", [{"role": "assistant", "content": "done"}]),
        ):
            with self.subTest(name=name):
                self.write(name, messages)
                self.assertEqual(inspect_session(name, root=self.root)["state"], "needs_review")

    def test_reused_call_id_after_prior_result_is_rejected(self):
        self.write("reuse", [
            {"role": "user", "content": "x"},
            {"role": "assistant", "tool_calls": [{"id": "one"}]},
            {"role": "tool", "tool_call_id": "one", "content": "ok"},
            {"role": "assistant", "tool_calls": [{"id": "one"}]},
            {"role": "tool", "tool_call_id": "one", "content": "ok"},
            {"role": "assistant", "content": "done"},
        ])
        with self.assertRaises(SessionDiagnosisError):
            inspect_session("reuse", root=self.root)

    def test_out_of_order_assistant_marks_sequence_ambiguous(self):
        self.write("ambiguous", [
            {"role": "user", "content": "x"},
            {"role": "assistant", "tool_calls": [{"id": "one"}]},
            {"role": "assistant", "content": "early"},
            {"role": "tool", "tool_call_id": "one", "content": "ok"},
            {"role": "assistant", "content": "done"},
        ])
        report = inspect_session("ambiguous", root=self.root)
        self.assertTrue(report["ambiguous_tool_sequence"])
        self.assertEqual(report["state"], "needs_review")
        self.assertEqual(report["unmatched_tool_calls"], 0)

    def test_complete_tool_sequence_is_only_conversation_ended(self):
        self.write("normal", [
            {"role": "user", "content": "x"},
            {"role": "assistant", "tool_calls": [{"id": "one"}]},
            {"role": "tool", "tool_call_id": "one", "content": "ok"},
            {"role": "assistant", "content": "done"},
        ])
        report = inspect_session("normal", root=self.root)
        self.assertEqual(report["state"], "conversation_ended")
        self.assertFalse(report["execution_verified"])

    def test_symlinked_parent_directory_is_rejected(self):
        target = self.root / "real"
        target.mkdir()
        (target / "x.jsonl").write_text('{"role":"user"}\n', encoding="utf-8")
        alias = self.root / "alias"
        try:
            alias.symlink_to(target, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with self.assertRaises(SessionDiagnosisError):
            inspect_session("x", root=alias)

    def test_cli_short_circuit_no_provider_or_network(self):
        self.write("done", [
            {"role": "user", "content": "a"},
            {"role": "assistant", "content": "b"},
        ])
        import angel.session_diagnostics as module
        with mock.patch.object(module, "ANGEL_HOME", self.root.parent), \
             mock.patch.object(module, "inspect_session",
                               return_value=inspect_session("done", root=self.root)) as inspect, \
             mock.patch.object(cli, "Provider") as provider, \
             mock.patch.object(cli, "build_mcp_manager") as mcp, \
             mock.patch("sys.stdout", new_callable=io.StringIO) as stdout:
            result = cli.main(["session-status", "done"])
        self.assertEqual(result, 0)
        self.assertFalse(json.loads(stdout.getvalue())["execution_verified"])
        inspect.assert_called_once_with("done")
        provider.assert_not_called()
        mcp.assert_not_called()


if __name__ == "__main__":
    unittest.main()
