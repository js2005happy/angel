"""Authored regression tests for opt-in journal; not executed in this change."""
import json
from pathlib import Path
import tempfile
import unittest

from angel.tool_journal import JournalError, ToolJournal


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_no_files_without_explicit_begin(self):
        journal = ToolJournal("session1", root=self.root)
        self.assertFalse(journal.path.exists())
        self.assertEqual(journal.inspect()["unknown_outcomes"], 0)
        self.assertFalse(journal.inspect()["safe_to_auto_resume"])

    def test_intent_without_result_is_unknown_not_retryable(self):
        journal = ToolJournal("session1", root=self.root)
        call = journal.begin("shell")
        report = ToolJournal("session1", root=self.root).inspect()
        self.assertEqual(report["unknown_outcomes"], 1)
        self.assertEqual(report["tool_intents"], 1)
        self.assertFalse(report["execution_verified"])
        self.assertFalse(report["safe_to_auto_resume"])
        self.assertNotIn(call, str(report))

    def test_result_is_only_reported_not_execution_verified(self):
        journal = ToolJournal("session1", root=self.root)
        call = journal.begin("write_file")
        journal.finish(call, "write_file", success=True)
        report = journal.inspect()
        self.assertEqual(report["unknown_outcomes"], 0)
        self.assertEqual(report["reported_ok"], 1)
        self.assertFalse(report["execution_verified"])
        self.assertFalse(report["safe_to_auto_resume"])
        with self.assertRaises(JournalError):
            journal.finish(call, "write_file", success=True)

    def test_failure_and_isolation(self):
        a = ToolJournal("a", root=self.root)
        b = ToolJournal("b", root=self.root)
        call = a.begin("http_post")
        a.finish(call, "http_post", success=False)
        self.assertEqual(a.inspect()["reported_errors"], 1)
        self.assertEqual(b.inspect()["event_count"], 0)

    def test_rejects_unrecognized_fields_and_corrupt_files(self):
        journal = ToolJournal("a", root=self.root)
        journal.begin("shell")
        file = next(journal.path.glob("*.json"))
        item = json.loads(file.read_text())
        item["arguments"] = "SECRET"
        file.write_text(json.dumps(item))
        with self.assertRaises(JournalError):
            journal.inspect()
        with self.assertRaises(JournalError):
            journal.begin("shell")

    def test_no_arbitrary_session_or_tool_names(self):
        for session in ("../secret", "a/b", "", "a" * 81):
            with self.assertRaises(JournalError):
                ToolJournal(session, root=self.root)
        journal = ToolJournal("ok", root=self.root)
        for tool in ("", "../shell", "tool with secret", "x" * 81):
            with self.assertRaises(JournalError):
                journal.begin(tool)

    def test_unknown_id_or_tool_mismatch_fails(self):
        journal = ToolJournal("a", root=self.root)
        call = journal.begin("shell")
        with self.assertRaises(JournalError):
            journal.finish(call, "http_post", success=True)
        with self.assertRaises(JournalError):
            journal.finish("a" * 32, "shell", success=True)

    def test_event_order_not_based_on_random_filenames(self):
        journal = ToolJournal("a", root=self.root)
        call = journal.begin("shell")
        journal.finish(call, "shell", success=True)
        files = list(journal.path.glob("*.json"))
        records = [json.loads(f.read_text()) for f in files]
        for f in files:
            f.unlink()
        # Lexical order intentionally places result before intent.
        intent = next(x for x in records if x["event"] == "intent")
        result = next(x for x in records if x["event"] == "result_ok")
        (journal.path / ("0" * 32 + ".json")).write_text(json.dumps(result))
        (journal.path / ("f" * 32 + ".json")).write_text(json.dumps(intent))
        report = journal.inspect()
        self.assertEqual(report["reported_ok"], 1)
        self.assertFalse(report["journal_ambiguous"])

    def test_symlinked_journal_directory_fails(self):
        journal = ToolJournal("a", root=self.root)
        outside = self.root / "outside"
        outside.mkdir()
        try:
            journal.path.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with self.assertRaises(JournalError):
            journal.begin("shell")


if __name__ == "__main__":
    unittest.main()
