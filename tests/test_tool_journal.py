"""Authored regression tests for opt-in journal; not executed in this change."""
import json
import os
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

    def test_writer_fdopen_failure_closes_event_descriptor(self):
        # Both POSIX dir_fd and Windows path fallback share this ownership rule.
        journal = ToolJournal("write-fdopen-failure", root=self.root)
        opened = []

        def fail_fdopen(fd, mode):
            opened.append(fd)
            raise OSError("simulated writer fdopen failure")

        with mock.patch("angel.tool_journal.os.fdopen", side_effect=fail_fdopen):
            with self.assertRaises(JournalError):
                journal.begin("shell")
        self.assertEqual(len(opened), 1)
        with self.assertRaises(OSError):
            os.fstat(opened[0])
        # The failed intent cannot authorize execution or automatic replay.
        self.assertFalse(journal.inspect()["safe_to_auto_resume"])

    def test_fdopen_failure_closes_opened_event_descriptor(self):
        journal = ToolJournal("fdopen-failure", root=self.root)
        journal.begin("shell")
        opened = []

        def fail_fdopen(fd, mode):
            opened.append(fd)
            raise OSError("simulated fdopen failure")

        with mock.patch("angel.tool_journal.os.fdopen", side_effect=fail_fdopen):
            with self.assertRaises(JournalError):
                journal.inspect()
        self.assertEqual(len(opened), 1)
        with self.assertRaises(OSError):
            os.fstat(opened[0])

    def test_new_session_directory_is_private_on_posix(self):
        # POSIX mkdir mode is reduced by umask, never widened by it.
        if os.name != "posix":
            self.skipTest("POSIX permissions only")
        journal = ToolJournal("private-session", root=self.root)
        journal.begin("shell")
        mode = __import__("stat").S_IMODE(journal.path.stat().st_mode)
        self.assertEqual(mode & 0o077, 0)

    def test_existing_permissive_session_directory_is_rejected_on_posix(self):
        if os.name != "posix":
            self.skipTest("POSIX permissions only")
        path = self.root / "existing-session"
        path.mkdir(mode=0o700)
        path.chmod(0o755)
        journal = ToolJournal("existing-session", root=self.root)
        with self.assertRaisesRegex(JournalError, "权限过宽"):
            journal.inspect()
        with self.assertRaisesRegex(JournalError, "权限过宽"):
            journal.begin("shell")
        # Fail closed without silently changing a pre-existing directory.
        self.assertEqual(__import__("stat").S_IMODE(path.stat().st_mode), 0o755)

    def test_security_validation_reason_is_not_masked_as_corruption(self):
        # JournalError subclasses ValueError; the reader must not swallow it.
        journal = ToolJournal("preserve-reason", root=self.root)
        call = journal.begin("shell")
        event = journal.path / ("intent-" + call + ".json")
        raw = event.read_text(encoding="utf-8").strip()
        event.write_text(raw[:-1] + ',"tool":"shell"}', encoding="utf-8")
        with self.assertRaisesRegex(JournalError, "事件 JSON 存在重复字段"):
            journal.inspect()

    def test_existing_permissive_event_file_is_rejected_on_posix(self):
        if os.name != "posix":
            self.skipTest("POSIX permissions only")
        journal = ToolJournal("event-permissions", root=self.root)
        call = journal.begin("shell")
        event = journal.path / ("intent-" + call + ".json")
        event.chmod(0o644)
        with self.assertRaisesRegex(JournalError, "事件文件权限过宽"):
            journal.inspect()
        with self.assertRaisesRegex(JournalError, "事件文件权限过宽"):
            journal.begin("shell")
        self.assertEqual(__import__("stat").S_IMODE(event.stat().st_mode), 0o644)

    def test_posix_directory_fd_permissions_rechecked_after_open(self):
        # Simulate chmod after pathname validation but before fd validation.
        if os.name != "posix" or os.open not in os.supports_dir_fd:
            self.skipTest("POSIX dir_fd unavailable")
        from angel import tool_journal as module
        journal = ToolJournal("fd-permissions", root=self.root)
        journal.begin("shell")
        original = module.os.fstat

        def widened(fd):
            info = original(fd)
            if not __import__("stat").S_ISDIR(info.st_mode):
                return info
            class FakeStat:
                st_mode = (info.st_mode & ~0o777) | 0o755
                st_dev = info.st_dev
                st_ino = info.st_ino
            return FakeStat()

        with mock.patch.object(module.os, "fstat", side_effect=widened):
            with self.assertRaisesRegex(JournalError, "权限过宽"):
                journal.inspect()
            with self.assertRaisesRegex(JournalError, "权限过宽"):
                journal.begin("shell")

    def test_posix_reader_uses_directory_relative_file_open(self):
        import os
        from angel import tool_journal as module
        if os.name != "posix" or os.open not in os.supports_dir_fd:
            self.skipTest("POSIX dir_fd unavailable")
        journal = ToolJournal("session1", root=self.root)
        call = journal.begin("shell")
        journal.finish(call, "shell", success=True)
        original = module.os.open
        relative = []

        def observed(path, *args, **kwargs):
            if str(path).endswith(".json"):
                relative.append(("dir_fd" in kwargs, str(path)))
            return original(path, *args, **kwargs)

        with mock.patch.object(module.os, "open", side_effect=observed):
            result = journal.inspect()
        self.assertEqual(result["reported_ok"], 1)
        self.assertEqual(len(relative), 2)
        self.assertTrue(all(used for used, _ in relative))

    def test_posix_reader_detects_mismatched_directory_handle(self):
        import os
        from angel import tool_journal as module
        if os.name != "posix" or os.open not in os.supports_dir_fd:
            self.skipTest("POSIX dir_fd unavailable")
        journal = ToolJournal("session1", root=self.root)
        journal.begin("shell")
        original = module.os.fstat

        def altered(fd):
            value = original(fd)
            if os.path.isdir(journal.path) and fd != -1 and __import__("stat").S_ISDIR(value.st_mode):
                class FakeStat:
                    st_mode = value.st_mode
                    st_dev = value.st_dev
                    st_ino = value.st_ino + 1
                return FakeStat()
            return value

        with mock.patch.object(module.os, "fstat", side_effect=altered):
            with self.assertRaisesRegex(JournalError, "句柄"):
                journal.inspect()

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

    def test_hardlinked_event_is_rejected(self):
        journal = ToolJournal("session1", root=self.root)
        call = journal.begin("shell")
        event = journal.path / ("intent-" + call + ".json")
        other = self.root / "outside-event.json"
        try:
            os.link(event, other)
        except (OSError, NotImplementedError):
            self.skipTest("hard links unavailable")
        with self.assertRaises(JournalError):
            journal.inspect()

    def test_replaced_event_entry_is_rejected(self):
        from angel import tool_journal as module
        journal = ToolJournal("session1", root=self.root)
        journal.begin("shell")
        original = module.os.stat
        def swapped(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if kwargs.get("follow_symlinks") is False:
                class Changed:
                    st_mode = result.st_mode
                    st_dev = result.st_dev
                    st_ino = result.st_ino + 1
                return Changed()
            return result
        with mock.patch.object(module.os, "stat", side_effect=swapped):
            with self.assertRaises(JournalError):
                journal.inspect()

    def test_duplicate_json_keys_are_rejected(self):
        journal = ToolJournal("session1", root=self.root)
        call = journal.begin("shell")
        file = journal.path / ("intent-" + call + ".json")
        raw = file.read_text(encoding="utf-8").strip()
        file.write_text(raw[:-1] + ',"tool":"shell"}', encoding="utf-8")
        with self.assertRaises(JournalError):
            journal.inspect()

    def test_invalid_event_timestamps_are_rejected(self):
        # Journal timestamps are UTC with second precision; neither arbitrary
        # strings nor local/shifted times may masquerade as journal metadata.
        for invalid in ("not-a-time", "2026-02-30T00:00:00+00:00",
                        "2026-11-17T12:00:00", "2026-11-17T12:00:00+08:00",
                        "2026-11-17T12:00:00.123456+00:00"):
            with self.subTest(timestamp=invalid):
                journal = ToolJournal("timestamps", root=self.root)
                if journal.path.exists():
                    for event in journal.path.iterdir():
                        event.unlink()
                call = journal.begin("shell")
                event = journal.path / ("intent-" + call + ".json")
                record = json.loads(event.read_text(encoding="utf-8"))
                record["at"] = invalid
                event.write_text(json.dumps(record), encoding="utf-8")
                with self.assertRaisesRegex(JournalError, "事件时间戳无效"):
                    journal.inspect()

    def test_event_chmod_during_read_is_rejected(self):
        if os.name != "posix":
            self.skipTest("POSIX permission bits required")
        journal = ToolJournal("chmod_during_read", root=self.root)
        call = journal.begin("shell")
        event = journal.path / ("intent-" + call + ".json")
        original = event.stat().st_mode
        real_read = os.fdopen

        class ReadWrapper:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                self.stream.__enter__()
                return self

            def __exit__(self, *args):
                return self.stream.__exit__(*args)

            def fileno(self):
                return self.stream.fileno()

            def read(self, size):
                content = self.stream.read(size)
                event.chmod(0o644)
                return content

        def changed_read(fd, mode):
            return ReadWrapper(real_read(fd, mode))

        try:
            with mock.patch("angel.tool_journal.os.fdopen", side_effect=changed_read):
                with self.assertRaisesRegex(JournalError, "事件文件在读取期间发生变化"):
                    journal.inspect()
        finally:
            event.chmod(original & 0o777)

    def test_same_size_in_place_edit_during_read_is_rejected(self):
        # Metadata timestamps catch a class of same-length in-place edits
        # that identity/size checks alone cannot observe. This is not a
        # tamper-proof guarantee against a same-user writer.
        from angel import tool_journal as module
        journal = ToolJournal("same-size-edit", root=self.root)
        journal.begin("shell")
        original = module.os.fstat
        file_checks = [0]

        class ChangedStat:
            def __init__(self, value):
                self._value = value

            def __getattr__(self, name):
                if name == "st_mtime_ns":
                    return self._value.st_mtime_ns + 1
                return getattr(self._value, name)

        def modified(fd):
            value = original(fd)
            if __import__("stat").S_ISREG(value.st_mode):
                file_checks[0] += 1
                if file_checks[0] >= 2:
                    return ChangedStat(value)
            return value

        with mock.patch.object(module.os, "fstat", side_effect=modified):
            with self.assertRaisesRegex(JournalError, "读取期间发生变化"):
                journal.inspect()

    def test_boolean_version_is_rejected(self):
        journal = ToolJournal("session1", root=self.root)
        call = journal.begin("shell")
        file = journal.path / ("intent-" + call + ".json")
        record = json.loads(file.read_text(encoding="utf-8"))
        record["version"] = True
        file.write_text(json.dumps(record), encoding="utf-8")
        with self.assertRaises(JournalError):
            journal.inspect()

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
