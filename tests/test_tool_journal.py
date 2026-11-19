"""Authored regression tests for opt-in journal; not executed in this change."""
import json
import os
from pathlib import Path
import tempfile
import stat
import unittest
from unittest import mock

from angel.tool_journal import JournalError, ToolJournal


class JournalTests(unittest.TestCase):
    def test_finish_rejects_competing_intent_in_final_snapshot(self):
        journal = ToolJournal("finish-final-snapshot-race", root=self.root)
        cid = journal.begin("shell")
        original_records = journal._records
        reads = 0

        def competing_snapshot():
            nonlocal reads
            reads += 1
            if reads == 2:
                journal._write("intent", "c" * 32, "http_post")
            return original_records()

        with mock.patch.object(journal, "_records", side_effect=competing_snapshot):
            with self.assertRaisesRegex(JournalError, "结果提交前发现并发"):
                journal.finish(cid, "shell", success=True)
        self.assertEqual(journal.inspect()["unknown_outcomes"], 2)

    def test_begin_requires_own_intent_still_pending(self):
        # A competing process can finish our intent while leaving exactly
        # one different intent unresolved; the global count alone is unsafe.
        journal = ToolJournal("own-intent-pending", root=self.root)
        original_write = journal._write

        def race(event, call_id, tool):
            original_write(event, call_id, tool)
            if event == "intent":
                original_write("result_ok", call_id, tool)
                original_write("intent", "b" * 32, "http_post")

        with mock.patch.object(journal, "_write", side_effect=race):
            with self.assertRaisesRegex(JournalError, "本次调用意图已变化"):
                journal.begin("shell")
        self.assertEqual(journal.inspect()["unknown_outcomes"], 1)

    def test_begin_rechecks_concurrent_intent_before_dispatch(self):
        # A competing intent appearing immediately after our event is
        # persisted must stop begin() before it returns a dispatchable ID.
        journal = ToolJournal("concurrent-pending-begin", root=self.root)
        original_write = journal._write

        def concurrent_write(event, call_id, tool):
            original_write(event, call_id, tool)
            if event == "intent":
                original_write("intent", "a" * 32, "http_post")

        with mock.patch.object(journal, "_write", side_effect=concurrent_write):
            with self.assertRaisesRegex(JournalError, "禁止执行工具"):
                journal.begin("shell")
        status = journal.inspect()
        self.assertEqual(status["unknown_outcomes"], 2)
        self.assertFalse(status["journal_ambiguous"])

    def test_posix_final_directory_fstat_denied_fails_closed(self):
        # Mock the final directory-handle probe on an empty journal.
        # No tests are executed as part of this change.
        from angel import tool_journal as module
        if os.name != "posix" or os.open not in os.supports_dir_fd:
            self.skipTest("POSIX directory descriptors unavailable")
        journal = ToolJournal("final-fstat-denied", root=self.root)
        journal.path.mkdir(mode=0o700)
        original_fstat = module.os.fstat
        directory_probes = 0

        def deny_final_directory_probe(fd):
            nonlocal directory_probes
            info = original_fstat(fd)
            if stat.S_ISDIR(info.st_mode):
                directory_probes += 1
                if directory_probes == 3:
                    raise PermissionError("access denied")
            return info

        with mock.patch.object(module.os, "fstat",
                               side_effect=deny_final_directory_probe):
            with self.assertRaisesRegex(JournalError, "无法复核末次日志目录句柄"):
                journal.inspect()

    def test_posix_final_dirfd_enumeration_denied_fails_closed(self):
        # Simulate a denied second enumeration without changing permissions.
        from angel import tool_journal as module
        journal = ToolJournal("posix-final-enumeration-denied", root=self.root)
        journal.begin("shell")
        original_listdir = module.os.listdir
        calls = 0

        def denied_second_listdir(path):
            nonlocal calls
            if isinstance(path, int):
                calls += 1
                if calls == 2:
                    raise PermissionError("access denied")
            return original_listdir(path)

        with mock.patch.object(module.os, "listdir", side_effect=denied_second_listdir):
            with self.assertRaisesRegex(JournalError, "无法复核日志目录枚举"):
                journal.inspect()

    def test_path_fallback_symlink_probe_denied_fails_closed(self):
        # A denied metadata probe must not escape as an unclassified OSError.
        from angel import tool_journal as module
        journal = ToolJournal("symlink-probe-denied", root=self.root)
        journal.begin("shell")
        original = Path.is_symlink

        def denied(path):
            if path.parent == journal.path and path.suffix == ".json":
                raise PermissionError("access denied")
            return original(path)

        with mock.patch.object(module.os, "supports_dir_fd", set()):
            with mock.patch.object(Path, "is_symlink", denied):
                with self.assertRaisesRegex(JournalError, "无法核验事件文件是否为符号链接"):
                    journal.inspect()

    def test_ancestor_symlink_probe_denied_fails_closed(self):
        from angel import tool_journal as module
        target = self.root / "nested" / "journal"
        original = Path.is_symlink

        def denied(path):
            if path == self.root:
                raise PermissionError("access denied")
            return original(path)

        with mock.patch.object(Path, "is_symlink", denied):
            with self.assertRaisesRegex(JournalError, "无法核验日志目录祖先"):
                module._safe_directory(target)

    def test_safe_directory_permission_denied_is_not_missing(self):
        # No filesystem mutation: deny metadata lookup at the session path.
        from angel import tool_journal as module
        target = self.root / "denied-directory"
        original = Path.lstat

        def denied(path, *args, **kwargs):
            if path == target:
                raise PermissionError("access denied")
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, "lstat", denied):
            with self.assertRaisesRegex(JournalError, "无法核验日志目录类型"):
                module._safe_directory(target)


    def test_path_fallback_rejects_concurrent_new_entry(self):
        # Force the path fallback on POSIX without running on Windows.
        from angel import tool_journal as module
        journal = ToolJournal("fallback-snapshot-race", root=self.root)
        cid = journal.begin("shell")
        journal.finish(cid, "shell", success=True)
        original_iterdir = Path.iterdir
        calls = 0

        def changing_iterdir(path):
            nonlocal calls
            entries = list(original_iterdir(path))
            if path == journal.path:
                calls += 1
                if calls == 2:
                    return iter(entries + [path / ("intent-" + "a" * 32 + ".json")])
            return iter(entries)

        with mock.patch.object(module.os, "supports_dir_fd", set()):
            with mock.patch.object(Path, "iterdir", changing_iterdir):
                with self.assertRaisesRegex(JournalError, "并发变化"):
                    journal.inspect()

    def test_directory_identity_permission_error_is_not_empty_journal(self):
        from angel import tool_journal as module
        journal = ToolJournal("permission-error", root=self.root)
        journal.path.mkdir(mode=0o700)
        original_lstat = Path.lstat

        def denied(path, *args, **kwargs):
            if path == journal.path:
                raise PermissionError("access denied")
            return original_lstat(path, *args, **kwargs)

        with mock.patch.object(Path, "lstat", denied):
            with self.assertRaisesRegex(JournalError, "无法核验日志目录身份"):
                module._directory_identity(journal.path)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_windows_postwrite_entry_reparse_is_rejected(self):
        # No Windows host or actual junction required: test the metadata gate.
        from angel import tool_journal as module
        from unittest.mock import Mock
        normal = os.stat(self.root)
        written = Mock(st_dev=normal.st_dev, st_ino=normal.st_ino,
                       st_size=12, st_mode=stat.S_IFREG | 0o600)
        entry = Mock(st_dev=normal.st_dev, st_ino=normal.st_ino,
                     st_size=12, st_mode=stat.S_IFREG | 0o600,
                     st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)
        with mock.patch.object(module.os, "name", "nt"):
            with mock.patch.object(module.os, "lstat", return_value=entry):
                with self.assertRaisesRegex(JournalError, "重解析点"):
                    module._verify_written_windows_entry(self.root / "event.json", written)

    def test_windows_postwrite_entry_metadata_change_is_rejected(self):
        # Model an in-place modification after fsync: identity and size
        # still match, but metadata must invalidate the commit claim.
        from angel import tool_journal as module
        from types import SimpleNamespace
        written = SimpleNamespace(st_dev=1, st_ino=2, st_size=12,
                                  st_mtime_ns=100, st_ctime_ns=100)
        for changed in ("st_mtime_ns", "st_ctime_ns", "st_nlink"):
            fields = dict(st_dev=1, st_ino=2, st_size=12,
                          st_mode=stat.S_IFREG | 0o600,
                          st_file_attributes=0, st_nlink=1,
                          st_mtime_ns=100, st_ctime_ns=100)
            fields[changed] = 2 if changed == "st_nlink" else 101
            with self.subTest(changed=changed):
                with mock.patch.object(module.os, "name", "nt"):
                    with mock.patch.object(module.os, "lstat",
                                           return_value=SimpleNamespace(**fields)):
                        with self.assertRaisesRegex(JournalError, "替换或修改"):
                            module._verify_written_windows_entry(
                                self.root / "event.json", written)

    def test_windows_postwrite_entry_identity_mismatch_is_rejected(self):
        from angel import tool_journal as module
        from unittest.mock import Mock
        written = Mock(st_dev=1, st_ino=2, st_size=12)
        entry = Mock(st_dev=1, st_ino=3, st_size=12,
                     st_mode=stat.S_IFREG | 0o600, st_file_attributes=0)
        with mock.patch.object(module.os, "name", "nt"):
            with mock.patch.object(module.os, "lstat", return_value=entry):
                with self.assertRaisesRegex(JournalError, "已被替换"):
                    module._verify_written_windows_entry(self.root / "event.json", written)

    def test_directory_anchor_is_checked_for_symlinks(self):
        # Even the filesystem anchor must be inspected, rather than skipped
        # by the ancestor walk. Use a mock to avoid touching the real root.
        from angel import tool_journal as module
        anchor = Path(self.root.anchor)
        original = Path.is_symlink

        def fake_symlink(path):
            if path == anchor:
                return True
            return original(path)

        with mock.patch.object(Path, "is_symlink", fake_symlink):
            with self.assertRaisesRegex(JournalError, "符号链接"):
                module._safe_directory(self.root)

    def test_anchor_check_runs_for_anchor_itself(self):
        # The anchor is both the start and end of the ancestor walk.
        from angel import tool_journal as module
        anchor = Path(self.root.anchor)
        with mock.patch.object(Path, "is_symlink", autospec=True, side_effect=lambda p: p == anchor):
            with self.assertRaisesRegex(JournalError, "符号链接"):
                module._safe_directory(anchor)

    def test_read_permission_denied_is_not_an_empty_journal(self):
        # Simulate a platform where exists() would conceal access denied.
        from angel import tool_journal as module
        journal = ToolJournal("read-permission-denied", root=self.root)
        journal.begin("shell")
        original_identity = module._directory_identity

        def deny(path):
            if path == journal.path:
                raise JournalError("无法核验日志目录身份")
            return original_identity(path)

        with mock.patch.object(module, "_directory_identity", side_effect=deny):
            with self.assertRaisesRegex(JournalError, "无法核验"):
                journal.inspect()

    def test_begin_rejects_pending_unknown_intent(self):
        # An unfinished side effect is not safe to silently run past.
        journal = ToolJournal("pending-before-begin", root=self.root)
        pending_id = journal.begin("shell")
        before = sorted(journal.path.iterdir())
        with self.assertRaisesRegex(JournalError, "结果未知"):
            journal.begin("http_post")
        self.assertEqual(sorted(journal.path.iterdir()), before)
        self.assertEqual(journal.inspect()["unknown_outcomes"], 1)
        # A legitimate result can still be recorded, then new work proceeds.
        journal.finish(pending_id, "shell", success=True)
        self.assertEqual(journal.inspect()["unknown_outcomes"], 0)
        self.assertTrue(journal.begin("http_post"))

    def test_finish_rejects_second_unresolved_intent(self):
        # Simulate another process recording an intent between begin and finish.
        journal = ToolJournal("concurrent-pending-finish", root=self.root)
        first = journal.begin("shell")
        journal._write("intent", "a" * 32, "http_post")
        before = sorted(journal.path.iterdir())
        with self.assertRaisesRegex(JournalError, "其他结果未知"):
            journal.finish(first, "shell", success=True)
        self.assertEqual(sorted(journal.path.iterdir()), before)
        self.assertEqual(journal.inspect()["unknown_outcomes"], 2)
        self.assertFalse(journal.inspect()["safe_to_auto_resume"])

    def test_finish_rejects_unrelated_orphan_result(self):
        journal = ToolJournal("orphan-before-finish", root=self.root)
        pending_id = journal.begin("shell")
        journal._write("result_error", "b" * 32, "http_post")
        before = sorted(journal.path.iterdir())
        with self.assertRaisesRegex(JournalError, "日志存在歧义"):
            journal.finish(pending_id, "shell", success=True)
        self.assertEqual(sorted(journal.path.iterdir()), before)
        self.assertTrue(journal.inspect()["journal_ambiguous"])

    def test_ambiguous_journal_does_not_report_partial_success(self):
        # An unrelated orphan must invalidate the apparent success totals.
        journal = ToolJournal("global-ambiguity-counts", root=self.root)
        cid = journal.begin("shell")
        journal.finish(cid, "shell", success=True)
        journal._write("result_error", "f" * 32, "http_post")
        status = journal.inspect()
        self.assertTrue(status["journal_ambiguous"])
        self.assertEqual(status["reported_ok"], 0)
        self.assertEqual(status["reported_errors"], 0)
        self.assertEqual(status["unknown_outcomes"], 2)
        self.assertFalse(status["safe_to_auto_resume"])

    def test_begin_rejects_orphan_result_without_creating_intent(self):
        journal = ToolJournal("orphan-before-begin", root=self.root)
        journal._write("result_ok", "a" * 32, "shell")
        before = sorted(journal.path.iterdir())
        with self.assertRaisesRegex(JournalError, "日志存在歧义"):
            journal.begin("shell")
        self.assertEqual(sorted(journal.path.iterdir()), before)
        self.assertTrue(journal.inspect()["journal_ambiguous"])

    def test_write_rejects_unexpected_post_write_file_size(self):
        # Simulate a concurrent truncate after fsync without running it.
        from angel import tool_journal as module
        journal = ToolJournal("post-write-size", root=self.root)
        original_fstat = module.os.fstat
        original_fsync = module.os.fsync
        synced = set()

        def tracked_fsync(fd):
            synced.add(fd)
            return original_fsync(fd)

        def changed_fstat(fd):
            info = original_fstat(fd)
            if fd in synced and stat.S_ISREG(info.st_mode):
                values = list(info)
                values[6] = info.st_size + 1
                return os.stat_result(values)
            return info

        with mock.patch.object(module.os, "fsync", side_effect=tracked_fsync):
            with mock.patch.object(module.os, "fstat", side_effect=changed_fstat):
                with self.assertRaisesRegex(JournalError, "元数据不安全"):
                    journal.begin("shell")

    def test_windows_writer_rejects_opened_reparse_handle_before_path_check(self):
        # A clean pathname cannot certify an unsafe opened write handle.
        from angel import tool_journal as module
        from types import SimpleNamespace
        written = SimpleNamespace(
            st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT,
        )
        with mock.patch.object(module.os, "name", "nt"):
            with mock.patch.object(module.os, "lstat", side_effect=AssertionError("path checked first")):
                with self.assertRaisesRegex(JournalError, "重解析点"):
                    module._verify_written_windows_entry(self.root / "event.json", written)

    def test_opened_windows_event_handle_reparse_is_rejected(self):
        # Simulate a Windows handle whose fstat reports a reparse point,
        # even when path-based checks appeared ordinary before open.
        from angel import tool_journal as module
        from types import SimpleNamespace
        opened = SimpleNamespace(
            st_mode=stat.S_IFREG | 0o600, st_size=10, st_nlink=1,
            st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT,
        )
        with mock.patch.object(module.os, "name", "nt"):
            with self.assertRaisesRegex(JournalError, "重解析点"):
                module._reject_windows_event_reparse(opened)

    def test_windows_event_reparse_point_rejected(self):
        # A reparse point can appear to be a regular file; reject its
        # Windows attribute independently of the POSIX mode bits.
        from angel import tool_journal as module
        from types import SimpleNamespace
        fake = SimpleNamespace(st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)
        with mock.patch.object(module.os, "name", "nt"):
            with self.assertRaisesRegex(JournalError, "事件文件不能是 Windows 重解析点"):
                module._reject_windows_event_reparse(fake)
            with self.assertRaisesRegex(JournalError, "无法核验"):
                module._reject_windows_event_reparse(SimpleNamespace())
        with mock.patch.object(module.os, "name", "posix"):
            module._reject_windows_event_reparse(fake)

    def test_windows_dangling_reparse_point_is_not_skipped(self):
        # exists() can be false for dangling reparse entries. The Windows
        # security check must use lstat independently of exists().
        from angel import tool_journal as module
        from unittest.mock import Mock
        original_lstat = Path.lstat
        original_exists = Path.exists

        def fake_exists(path, *args, **kwargs):
            if path == self.root:
                return False
            return original_exists(path, *args, **kwargs)

        def fake_lstat(path, *args, **kwargs):
            info = original_lstat(path, *args, **kwargs)
            if path == self.root:
                fake = Mock(wraps=info)
                fake.st_file_attributes = stat.FILE_ATTRIBUTE_REPARSE_POINT
                return fake
            fake = Mock(wraps=info)
            fake.st_file_attributes = 0
            return fake

        with mock.patch.object(module.os, "name", "nt"):
            with mock.patch.object(Path, "exists", fake_exists):
                with mock.patch.object(Path, "lstat", fake_lstat):
                    with mock.patch.object(Path, "is_junction", None, create=True):
                        with self.assertRaisesRegex(JournalError, "重解析点"):
                            ToolJournal("dangling-reparse", root=self.root)

    def test_windows_reparse_point_without_is_junction(self):
        from angel import tool_journal as module
        from unittest.mock import Mock
        original_lstat = Path.lstat

        def fake_lstat(path, *args, **kwargs):
            info = original_lstat(path, *args, **kwargs)
            fake = Mock(wraps=info)
            fake.st_file_attributes = (
                stat.FILE_ATTRIBUTE_REPARSE_POINT if path == self.root else 0
            )
            return fake

        with mock.patch.object(module.os, "name", "nt"):
            with mock.patch.object(Path, "lstat", fake_lstat):
                with mock.patch.object(Path, "is_junction", None, create=True):
                    with self.assertRaisesRegex(JournalError, "重解析点"):
                        ToolJournal("reparse-session", root=self.root)
        self.assertFalse((self.root / "reparse-session").exists())

    def test_directory_junction_is_rejected_when_supported(self):
        # Simulate a Windows NTFS junction without requiring Windows or
        # creating an actual reparse point on the test host.
        from angel import tool_journal as module
        original = getattr(Path, "is_junction", None)

        def junction(path):
            if path == self.root:
                return True
            return original(path) if original is not None else False

        with mock.patch.object(Path, "is_junction", junction, create=True):
            with self.assertRaisesRegex(JournalError, "目录联接"):
                ToolJournal("junction-session", root=self.root)
        self.assertFalse((self.root / "junction-session").exists())

    @unittest.skipUnless(os.name == "posix" and hasattr(os, "O_NONBLOCK"), "POSIX nonblocking open only")
    def test_event_open_uses_nonblocking_flag_before_type_check(self):
        journal = ToolJournal("nonblocking-event", root=self.root)
        journal.begin("shell")
        original_open = os.open
        event_flags = []

        def tracked_open(path, flags, *args, **kwargs):
            if str(path).endswith(".json"):
                event_flags.append(flags)
            return original_open(path, flags, *args, **kwargs)

        with mock.patch("angel.tool_journal.os.open", side_effect=tracked_open):
            journal.inspect()
        self.assertTrue(event_flags)
        self.assertTrue(all(flags & os.O_NONBLOCK for flags in event_flags))

    def test_short_event_read_is_rejected_even_if_json_is_valid(self):
        # A short read can omit trailing whitespace yet leave parseable JSON.
        from angel import tool_journal as module
        journal = ToolJournal("short-read", root=self.root)
        journal.begin("shell")
        original_fdopen = module.os.fdopen

        class ShortReader:
            def __init__(self, handle):
                self.handle = handle

            def __enter__(self):
                self.handle.__enter__()
                return self

            def __exit__(self, *args):
                return self.handle.__exit__(*args)

            def fileno(self):
                return self.handle.fileno()

            def read(self, limit):
                data = self.handle.read(limit)
                return data[:-1] if data.endswith(b"\\n") else data

        def shortened(fd, mode):
            handle = original_fdopen(fd, mode)
            return ShortReader(handle) if mode == "rb" else handle

        with mock.patch.object(module.os, "fdopen", side_effect=shortened):
            with self.assertRaisesRegex(JournalError, "读取字节数"):
                journal.inspect()

    def test_event_entry_swap_during_read_is_rejected(self):
        from angel import tool_journal as module
        journal = ToolJournal("entry-swap", root=self.root)
        journal.begin("shell")
        original = module.os.stat
        seen = [0]

        def changed(path, *args, **kwargs):
            value = original(path, *args, **kwargs)
            if str(path).endswith(".json") and kwargs.get("follow_symlinks") is False:
                seen[0] += 1
                if seen[0] == 2:
                    from unittest.mock import Mock
                    fake = Mock(wraps=value)
                    fake.st_ino = value.st_ino + 1
                    return fake
            return value

        with mock.patch.object(module.os, "stat", side_effect=changed):
            with self.assertRaisesRegex(JournalError, "替换"):
                journal.inspect()
        self.assertEqual(seen[0], 2)

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

    def test_read_rejects_final_entry_metadata_change(self):
        journal = ToolJournal("final-entry-metadata", root=self.root)
        journal.begin("shell")
        original_lstat = os.lstat
        calls = [0]

        def changed_final_entry(path, *args, **kwargs):
            info = original_lstat(path, *args, **kwargs)
            if str(path).endswith(".json"):
                calls[0] += 1
                if calls[0] == 2:
                    values = list(info)
                    values[6] += 1  # st_size differs, inode remains identical
                    return os.stat_result(values)
            return info

        # Force path fallback so the entry check is patchable on POSIX too.
        with mock.patch("angel.tool_journal.os.supports_dir_fd", set()):
            with mock.patch("angel.tool_journal.os.lstat", side_effect=changed_final_entry):
                with self.assertRaises(JournalError):
                    journal.inspect()

    def test_path_fallback_rechecks_directory_after_final_enumeration(self):
        # The final path-based walk can race with a directory replacement.
        # Verify that a final identity check is made before trusting records.
        from angel import tool_journal as module
        journal = ToolJournal("fallback-final-identity", root=self.root)
        journal.begin("shell")
        original_verify = module._verify_directory
        checks = [0]

        def changed_on_final_check(path, expected):
            checks[0] += 1
            if checks[0] == 3:
                raise JournalError("日志目录在操作期间被替换")
            return original_verify(path, expected)

        with mock.patch.object(module.os, "supports_dir_fd", set()):
            with mock.patch.object(module, "_verify_directory", side_effect=changed_on_final_check):
                with self.assertRaisesRegex(JournalError, "被替换"):
                    journal.inspect()
        self.assertEqual(checks[0], 3)

    @unittest.skipUnless(os.name == "posix" and os.open in os.supports_dir_fd, "POSIX dir_fd only")
    def test_posix_reader_rechecks_directory_fd_after_final_enumeration(self):
        # A concurrent chmod during the second listdir must fail closed.
        from angel import tool_journal as module
        from unittest.mock import Mock
        journal = ToolJournal("final-fd-enumeration", root=self.root)
        journal.begin("shell")
        original_listdir = module.os.listdir
        original_fstat = module.os.fstat
        final_enumerated = [False]

        def widened_after_enumeration(fd):
            info = original_fstat(fd)
            if (final_enumerated[0] and stat.S_ISDIR(info.st_mode)):
                changed = Mock(wraps=info)
                changed.st_mode = (info.st_mode & ~0o777) | 0o755
                return changed
            return info

        # Only simulate the permission change after the second enumeration.
        enumerations = [0]
        def counted_listdir(path):
            result = original_listdir(path)
            if isinstance(path, int):
                enumerations[0] += 1
                final_enumerated[0] = enumerations[0] >= 2
            return result

        with mock.patch.object(module.os, "listdir", side_effect=counted_listdir):
            with mock.patch.object(module.os, "fstat", side_effect=widened_after_enumeration):
                with self.assertRaisesRegex(JournalError, "末次枚举后"):
                    journal.inspect()
        self.assertEqual(enumerations[0], 2)


    @unittest.skipUnless(os.name == "posix" and os.open in os.supports_dir_fd, "POSIX dir_fd only")
    def test_posix_writer_rechecks_directory_fd_after_sync(self):
        # Simulate a concurrent chmod after the directory fsync, without
        # changing permissions on the actual test host.
        from angel import tool_journal as module
        from unittest.mock import Mock
        journal = ToolJournal("write-final-fd-check", root=self.root)
        original_fsync = module.os.fsync
        original_fstat = module.os.fstat
        synced_directory = [False]

        def tracked_fsync(fd):
            info = original_fstat(fd)
            if stat.S_ISDIR(info.st_mode):
                synced_directory[0] = True
            return original_fsync(fd)

        def widened_after_sync(fd):
            info = original_fstat(fd)
            if synced_directory[0] and stat.S_ISDIR(info.st_mode):
                fake = Mock(wraps=info)
                fake.st_mode = (info.st_mode & ~0o777) | 0o755
                return fake
            return info

        with mock.patch.object(module.os, "fsync", side_effect=tracked_fsync):
            with mock.patch.object(module.os, "fstat", side_effect=widened_after_sync):
                with self.assertRaisesRegex(JournalError, "同步后发生变化"):
                    journal.begin("shell")
        self.assertTrue(synced_directory[0])

    def test_mismatched_result_tool_is_unknown_not_reported_success(self):
        journal = ToolJournal("mismatched-tool", root=self.root)
        call = journal.begin("shell")
        journal.finish(call, "shell", success=True)
        result_path = journal.path / ("result-" + call + ".json")
        record = json.loads(result_path.read_text(encoding="utf-8"))
        record["tool"] = "http_post"
        result_path.write_text(json.dumps(record), encoding="utf-8")
        status = journal.inspect()
        self.assertTrue(status["journal_ambiguous"])
        self.assertEqual(status["unknown_outcomes"], 1)
        self.assertEqual(status["reported_ok"], 0)
        self.assertFalse(status["safe_to_auto_resume"])

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

    def test_posix_reader_rejects_changed_entry_set_after_enumeration(self):
        # A concurrent writer can add an intent after the initial listdir.
        # Fail closed instead of returning an incomplete journal snapshot.
        if os.name != "posix" or os.open not in os.supports_dir_fd:
            self.skipTest("POSIX dir_fd unavailable")
        from angel import tool_journal as module
        journal = ToolJournal("changed-entry-set", root=self.root)
        journal.begin("shell")
        original_listdir = module.os.listdir
        calls = [0]

        def changed(fd):
            names = original_listdir(fd)
            calls[0] += 1
            if calls[0] == 2:
                return names + ["intent-" + "a" * 32 + ".json"]
            return names

        with mock.patch.object(module.os, "listdir", side_effect=changed):
            with self.assertRaisesRegex(JournalError, "并发变化"):
                journal.inspect()
        self.assertEqual(calls[0], 2)

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

    def test_posix_writer_rejects_replaced_entry_after_sync(self):
        # Simulate a rename/swap between the opened file's fsync and
        # directory fsync. The intent must not authorize tool execution.
        if os.name != "posix" or os.open not in os.supports_dir_fd:
            self.skipTest("POSIX dir_fd unavailable")
        from angel import tool_journal as module
        journal = ToolJournal("write-entry-swap", root=self.root)
        original_stat = module.os.stat

        def swapped(path, *args, **kwargs):
            info = original_stat(path, *args, **kwargs)
            if (str(path).startswith("intent-")
                    and kwargs.get("dir_fd") is not None
                    and kwargs.get("follow_symlinks") is False):
                from unittest.mock import Mock
                changed = Mock(wraps=info)
                changed.st_ino = info.st_ino + 1
                return changed
            return info

        with mock.patch.object(module.os, "stat", side_effect=swapped):
            with self.assertRaisesRegex(JournalError, "目录项已被替换"):
                journal.begin("shell")
        self.assertFalse(journal.inspect()["safe_to_auto_resume"])

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

    def test_empty_journal_rechecks_directory_fd_after_enumeration(self):
        # POSIX only: an empty journal has no per-entry validation pass.
        if os.name != "posix" or os.open not in os.supports_dir_fd:
            self.skipTest("directory fd unavailable")
        from angel import tool_journal as module
        journal = ToolJournal("empty-fd-check", root=self.root)
        journal.path.mkdir(mode=0o700)
        original = module.os.fstat
        directory_checks = [0]

        class ChangedDirectoryStat:
            def __init__(self, value):
                self._value = value

            def __getattr__(self, name):
                if name == "st_mode":
                    return self._value.st_mode | 0o077
                return getattr(self._value, name)

        def changed(fd):
            value = original(fd)
            if __import__("stat").S_ISDIR(value.st_mode):
                directory_checks[0] += 1
                if directory_checks[0] >= 2:
                    return ChangedDirectoryStat(value)
            return value

        with mock.patch.object(module.os, "fstat", side_effect=changed):
            with self.assertRaisesRegex(JournalError, "枚举后发生变化"):
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

    def test_orphan_result_counts_as_unknown_outcome(self):
        # Missing intent is ambiguous, not proof of a completed operation.
        journal = ToolJournal("orphan", root=self.root)
        call = journal.begin("shell")
        journal.finish(call, "shell", success=True)
        (journal.path / ("intent-" + call + ".json")).unlink()
        report = journal.inspect()
        self.assertTrue(report["journal_ambiguous"])
        self.assertEqual(report["unknown_outcomes"], 1)
        self.assertEqual(report["tool_intents"], 0)
        self.assertFalse(report["safe_to_auto_resume"])

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


    def test_path_fallback_initial_enumeration_permission_denied(self):
        journal = ToolJournal("a", root=self.root)
        journal.path.mkdir(parents=True)
        with mock.patch("angel.tool_journal.os.name", "nt"):
            with mock.patch.object(Path, "iterdir", side_effect=PermissionError("denied")):
                with self.assertRaises(JournalError):
                    journal._records()

    def test_path_fallback_final_enumeration_permission_denied(self):
        journal = ToolJournal("a", root=self.root)
        journal.path.mkdir(parents=True)
        with mock.patch("angel.tool_journal.os.name", "nt"):
            with mock.patch.object(Path, "iterdir", side_effect=[iter(()), PermissionError("denied")]):
                with self.assertRaises(JournalError):
                    journal._records()

    def test_begin_final_snapshot_rejects_new_competing_intent(self):
        from angel import tool_journal as module
        journal = ToolJournal("late-competitor", root=self.root)
        original = journal._records
        calls = [0]

        def late_snapshot():
            calls[0] += 1
            if calls[0] == 3:
                journal._write("intent", "a" * 32, "shell")
            return original()

        with mock.patch.object(journal, "_records", side_effect=late_snapshot):
            with self.assertRaisesRegex(JournalError, "最终日志快照"):
                journal.begin("shell")
        self.assertEqual(journal.inspect()["unknown_outcomes"], 2)

if __name__ == "__main__":
    unittest.main()
