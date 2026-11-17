"""Authored regression tests for opt-in journal; not executed in this change."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from angel.tool_journal import JournalError, ToolJournal


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_posix_writer_creates_event_with_directory_descriptor(self):
        import os
        if os.name != "posix" or os.open not in os.supports_dir_fd:
            self.skipTest("POSIX dir_fd unavailable")
        journal = ToolJournal("session1", root=self.root)
        call_id = journal.begin("shell")
        self.assertTrue((journal.path / ("intent-" + call_id + ".json")).is_file())
        self.assertFalse(journal.inspect()["safe_to_auto_resume"])

    def test_posix_directory_handle_mismatch_rejects_event_write(self):
        import os
        from angel import tool_journal as module
        if os.name != "posix" or os.open not in os.supports_dir_fd:
            self.skipTest("POSIX dir_fd unavailable")
        journal = ToolJournal("session1", root=self.root)
        original = module.os.fstat

        def changed(fd):
            value = original(fd)
            class FakeStat:
                st_mode = value.st_mode
                st_dev = value.st_dev
                st_ino = value.st_ino + 1
            return FakeStat()

        with mock.patch.object(module.os, "fstat", side_effect=changed):
            with self.assertRaisesRegex(JournalError, "句柄"):
                journal.begin("shell")
        self.assertEqual(journal.inspect()["event_count"], 0)

    def test_directory_replacement_during_read_fails_closed(self):
        from angel import tool_journal as module
        journal = ToolJournal("session1", root=self.root)
        journal.begin("shell")
        original = module._directory_identity
        calls = [0]

        def changed(path):
            calls[0] += 1
            actual = original(path)
            if calls[0] >= 2 and actual is not None:
                return (actual[0], actual[1] + 1)
            return actual

        with mock.patch.object(module, "_directory_identity", side_effect=changed):
            with self.assertRaisesRegex(JournalError, "替换"):
                journal.inspect()

    def test_directory_replacement_after_write_reports_failure(self):
        from angel import tool_journal as module
        journal = ToolJournal("session1", root=self.root)
        original = module._directory_identity
        calls = [0]

        def changed(path):
            calls[0] += 1
            actual = original(path)
            if calls[0] >= 2 and actual is not None:
                return (actual[0], actual[1] + 1)
            return actual

        with mock.patch.object(module, "_directory_identity", side_effect=changed):
            with self.assertRaisesRegex(JournalError, "替换"):
                journal.begin("shell")
        # A failed report does not justify replaying the tool.
        self.assertFalse(journal.inspect()["safe_to_auto_resume"])

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

    def test_result_filename_is_single_commit_slot(self):
        journal = ToolJournal("a", root=self.root)
        call = journal.begin("shell")
        journal.finish(call, "shell", success=True)
        self.assertTrue((journal.path / ("result-" + call + ".json")).is_file())
        with self.assertRaises(JournalError):
            journal.finish(call, "shell", success=False)
        self.assertEqual(journal.inspect()["reported_ok"], 1)
        self.assertEqual(journal.inspect()["reported_errors"], 0)

    def test_stale_finish_cannot_overwrite_existing_result(self):
        journal = ToolJournal("a", root=self.root)
        call = journal.begin("shell")
        # Simulate two workers that have already read the same intent.
        journal.finish(call, "shell", success=True)
        with self.assertRaises(JournalError):
            journal._write("result_error", call, "shell")
        self.assertEqual(journal.inspect()["event_count"], 2)
        self.assertFalse(journal.inspect()["journal_ambiguous"])

    def test_event_order_not_based_on_filename_order(self):
        journal = ToolJournal("a", root=self.root)
        call = journal.begin("shell")
        journal.finish(call, "shell", success=True)
        # Deterministic intent/result filenames are validated and grouping
        # must remain independent of directory iteration order.
        report = journal.inspect()
        self.assertEqual(report["reported_ok"], 1)
        self.assertEqual(report["event_count"], 2)
        self.assertFalse(report["journal_ambiguous"])

    def test_renamed_result_cannot_bypass_exclusive_result_slot(self):
        journal = ToolJournal("a", root=self.root)
        call = journal.begin("shell")
        journal.finish(call, "shell", success=True)
        result = journal.path / ("result-" + call + ".json")
        result.rename(journal.path / ("renamed-" + call + ".json"))
        with self.assertRaises(JournalError):
            journal.inspect()
        with self.assertRaises(JournalError):
            journal.finish(call, "shell", success=False)

    def test_mismatched_filename_and_embedded_call_id_rejected(self):
        journal = ToolJournal("a", root=self.root)
        call = journal.begin("shell")
        intent = journal.path / ("intent-" + call + ".json")
        payload = json.loads(intent.read_text())
        payload["call_id"] = "a" * 32 if call != "a" * 32 else "b" * 32
        intent.write_text(json.dumps(payload))
        with self.assertRaises(JournalError):
            journal.inspect()

    def test_duplicate_intent_file_with_different_name_rejected(self):
        journal = ToolJournal("a", root=self.root)
        call = journal.begin("shell")
        intent = journal.path / ("intent-" + call + ".json")
        duplicate = journal.path / ("intent-" + "f" * 32 + ".json")
        duplicate.write_bytes(intent.read_bytes())
        with self.assertRaises(JournalError):
            journal.inspect()

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
