"""Opt-in, metadata-only tool execution journal (not a resume engine).

Events are committed as separate exclusive-create files. A crash between
intent and result leaves an explicit unknown outcome, never permission to
replay a side-effecting operation. No arguments, prompts, outputs or secrets
are accepted by the API. Nothing is written unless a caller opts in.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import stat

from .config import ANGEL_HOME

_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
_TOOL = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,79}$")
_EVENT = re.compile(r"^[0-9a-f]{32}$")
MAX_EVENTS = 10000
MAX_EVENT_BYTES = 1024
EVENT_TYPES = frozenset(("intent", "result_ok", "result_error"))


class JournalError(ValueError):
    """Invalid or unsafe journal, or an ambiguous event sequence."""


def _safe_directory(path: Path) -> None:
    current = path
    while current != current.parent:
        if current.is_symlink():
            raise JournalError("日志目录不能是符号链接")
        current = current.parent
    if path.exists() and not path.is_dir():
        raise JournalError("日志目录不是文件夹")


def _directory_identity(path: Path) -> tuple[int, int] | None:
    """Snapshot the directory identity; detect replacement during an operation.

    This is a conservative check, not a portable atomic directory capability.
    Windows and POSIX both expose st_dev/st_ino through os.stat.
    """
    _safe_directory(path)
    if not path.exists():
        return None
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode):
        raise JournalError("日志目录不是文件夹")
    # Existing sessions are not chmod-ed implicitly. Reject permissive
    # directories instead of silently exposing tool metadata on POSIX.
    if os.name == "posix" and stat.S_IMODE(info.st_mode) & 0o077:
        raise JournalError("日志目录权限过宽；需要所有者手动检查并收紧权限")
    return info.st_dev, info.st_ino


def _verify_directory(path: Path, expected: tuple[int, int] | None) -> None:
    if _directory_identity(path) != expected:
        raise JournalError("日志目录在操作期间被替换；拒绝信任结果")


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict:
    """Reject ambiguous JSON object keys at every nesting level."""
    result = {}
    for key, value in pairs:
        if key in result:
            raise JournalError("事件 JSON 存在重复字段")
        result[key] = value
    return result


class ToolJournal:
    """Metadata-only event writer; independent from the actual tool runner."""

    def __init__(self, session_id: str, *, root: Path | None = None):
        if not isinstance(session_id, str) or not _ID.fullmatch(session_id):
            raise JournalError("会话 ID 无效")
        self.session_id = session_id
        base = Path(root) if root is not None else ANGEL_HOME / "tool-events"
        self.path = base / session_id
        _safe_directory(self.path)

    def _records(self) -> list[dict]:
        _safe_directory(self.path)
        if not self.path.exists():
            return []
        identity = _directory_identity(self.path)
        # POSIX: enumerate and open relative to one stable directory fd.
        # Windows retains the checked-path fallback; no unsafe dir_fd emulation.
        use_dirfd = os.name == "posix" and os.open in os.supports_dir_fd
        directory_fd = None
        if use_dirfd:
            flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            flags |= getattr(os, "O_NOFOLLOW", 0)
            try:
                directory_fd = os.open(self.path, flags)
                info = os.fstat(directory_fd)
                if (not stat.S_ISDIR(info.st_mode)
                        or (info.st_dev, info.st_ino) != identity):
                    raise JournalError("日志读取目录句柄与路径不一致")
                if stat.S_IMODE(info.st_mode) & 0o077:
                    raise JournalError("日志读取目录句柄权限过宽")
                names = os.listdir(directory_fd)
            except OSError as exc:
                if directory_fd is not None:
                    os.close(directory_fd)
                raise JournalError("无法安全打开日志目录") from exc
            except BaseException:
                if directory_fd is not None:
                    os.close(directory_fd)
                raise
        else:
            names = [p.name for p in self.path.iterdir()]
        if len(names) > MAX_EVENTS:
            if directory_fd is not None:
                os.close(directory_fd)
            raise JournalError("事件数量超限")
        records = []
        try:
            for name in sorted(names):
                if (not name.endswith(".json") or "/" in name or "\\" in name
                        or name in (".", "..")):
                    raise JournalError("日志目录存在不受支持的文件")
                path = self.path / name
                if directory_fd is None and path.is_symlink():
                    raise JournalError("日志目录存在不受支持的文件")
                flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
                # A hostile .json FIFO must not block before fstat rejects it.
                # POSIX O_NONBLOCK is harmless for regular event files.
                flags |= getattr(os, "O_NONBLOCK", 0)
                flags |= getattr(os, "O_NOFOLLOW", 0)
                try:
                    if directory_fd is not None:
                        fd = os.open(name, flags, dir_fd=directory_fd)
                    else:
                        fd = os.open(path, flags)
                    try:
                        handle_context = os.fdopen(fd, "rb")
                    except BaseException:
                        # fdopen can fail after os.open succeeds; do not leak
                        # a descriptor for a sensitive event file.
                        os.close(fd)
                        raise
                    with handle_context as handle:
                        info = os.fstat(handle.fileno())
                        if (not stat.S_ISREG(info.st_mode) or info.st_size > MAX_EVENT_BYTES
                                or info.st_nlink != 1):
                            raise JournalError("事件文件类型、大小或硬链接数量无效")
                        # POSIX event metadata must remain private even when
                        # a pre-existing file has been chmod-ed after creation.
                        if os.name == "posix" and stat.S_IMODE(info.st_mode) & 0o077:
                            raise JournalError("事件文件权限过宽")
                        # Cross-check the opened inode against its directory entry.
                        # This also detects some symlink swaps on Windows.
                        if directory_fd is not None:
                            entry = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                        else:
                            entry = os.lstat(path)
                        if (not stat.S_ISREG(entry.st_mode)
                                or (entry.st_dev, entry.st_ino) != (info.st_dev, info.st_ino)):
                            raise JournalError("事件文件在打开期间被替换")
                        raw = handle.read(MAX_EVENT_BYTES + 1)
                        # Detect concurrent chmod or truncation while reading.
                        after = os.fstat(handle.fileno())
                        if ((after.st_dev, after.st_ino) != (info.st_dev, info.st_ino)
                                or not stat.S_ISREG(after.st_mode)
                                or after.st_nlink != 1
                                or after.st_size != info.st_size
                                or after.st_mtime_ns != info.st_mtime_ns
                                or after.st_ctime_ns != info.st_ctime_ns
                                or (os.name == "posix" and
                                    stat.S_IMODE(after.st_mode) & 0o077)):
                            raise JournalError("事件文件在读取期间发生变化")
                    # Recheck name-to-inode binding after reading.
                    if directory_fd is not None:
                        final_entry = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    else:
                        final_entry = os.lstat(path)
                    if (not stat.S_ISREG(final_entry.st_mode)
                            or (final_entry.st_dev, final_entry.st_ino)
                            != (info.st_dev, info.st_ino)):
                        raise JournalError("事件文件在读取期间被替换")
                    if len(raw) != info.st_size:
                        raise JournalError("事件文件读取字节数与文件大小不一致")
                    if len(raw) > MAX_EVENT_BYTES:
                        raise JournalError("事件文件过大")
                    item = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
                except JournalError:
                    # Preserve explicit fail-closed reasons (permissions, inode,
                    # size, duplicate keys) rather than masking them as corruption.
                    raise
                except (OSError, UnicodeError, ValueError) as exc:
                    raise JournalError("事件文件损坏或不可读取") from exc
                if not isinstance(item, dict) or set(item) != {
                    "version", "event", "call_id", "tool", "at"
                }:
                    raise JournalError("事件字段无效")
                if (type(item["version"]) is not int or item["version"] != 1
                        or not isinstance(item["event"], str)
                        or item["event"] not in EVENT_TYPES
                        or not isinstance(item["call_id"], str)
                        or not _EVENT.fullmatch(item["call_id"])
                        or not isinstance(item["tool"], str)
                        or not _TOOL.fullmatch(item["tool"])
                        or not isinstance(item["at"], str)
                        or len(item["at"]) > 40):
                    raise JournalError("事件值无效")
                # Writer emits second-precision UTC timestamps. Reject malformed
                # or offset-shifted timestamps rather than treating arbitrary
                # strings as trustworthy event metadata.
                try:
                    timestamp = datetime.fromisoformat(item["at"])
                except ValueError as exc:
                    raise JournalError("事件时间戳无效") from exc
                if (timestamp.tzinfo is None
                        or timestamp.utcoffset() != timezone.utc.utcoffset(None)
                        or timestamp.microsecond != 0
                        or timestamp.isoformat(timespec="seconds") != item["at"]):
                    raise JournalError("事件时间戳无效")
                expected = (
                    "intent-" + item["call_id"] + ".json"
                    if item["event"] == "intent"
                    else "result-" + item["call_id"] + ".json"
                )
                if name != expected:
                    raise JournalError("事件文件名与事件类型或调用 ID 不一致")
                records.append(item)
                _verify_directory(self.path, identity)
                if directory_fd is not None:
                    info = os.fstat(directory_fd)
                    if (info.st_dev, info.st_ino) != identity:
                        raise JournalError("日志读取目录句柄发生变化")
                    if stat.S_IMODE(info.st_mode) & 0o077:
                        raise JournalError("日志读取目录句柄权限过宽")
            _verify_directory(self.path, identity)
            return records
        finally:
            if directory_fd is not None:
                os.close(directory_fd)

    def _write(self, event: str, call_id: str, tool: str) -> None:
        if event not in EVENT_TYPES or not isinstance(call_id, str) or not _EVENT.fullmatch(call_id):
            raise JournalError("事件类型或调用 ID 无效")
        if not isinstance(tool, str) or not _TOOL.fullmatch(tool):
            raise JournalError("工具名无效")
        _safe_directory(self.path)
        self.path.mkdir(mode=0o700, parents=True, exist_ok=True)
        _safe_directory(self.path)
        identity = _directory_identity(self.path)
        item = {
            "version": 1, "event": event, "call_id": call_id,
            "tool": tool, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        payload = (json.dumps(item, sort_keys=True, separators=(",", ":")) + "\n").encode()
        # No append-in-place: a process crash never produces a partial JSON event.
        # Both event types have identity-bound filenames. O_EXCL prevents
        # duplicate results; validation prevents renaming a result to evade
        # that exclusive commit slot during a subsequent inspection.
        filename = (
            "intent-" + call_id + ".json" if event == "intent"
            else "result-" + call_id + ".json"
        )
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            # POSIX: bind the file creation to an already-open directory.
            # A rename of the pathname cannot silently redirect this write.
            # Windows lacks portable dir_fd support: retain checked path mode.
            use_dirfd = os.name == "posix" and os.open in os.supports_dir_fd
            if use_dirfd:
                dir_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                dir_flags |= getattr(os, "O_NOFOLLOW", 0)
                directory_fd = os.open(self.path, dir_flags)
                try:
                    directory_stat = os.fstat(directory_fd)
                    if (not stat.S_ISDIR(directory_stat.st_mode)
                            or (directory_stat.st_dev, directory_stat.st_ino) != identity):
                        raise JournalError("日志目录句柄与已核验目录不一致")
                    if stat.S_IMODE(directory_stat.st_mode) & 0o077:
                        raise JournalError("日志写入目录句柄权限过宽")
                    fd = os.open(filename, flags, 0o600, dir_fd=directory_fd)
                    try:
                        stream_context = os.fdopen(fd, "wb")
                    except BaseException:
                        os.close(fd)
                        raise
                    with stream_context as stream:
                        stream.write(payload)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            else:
                fd = os.open(self.path / filename, flags, 0o600)
                try:
                    stream_context = os.fdopen(fd, "wb")
                except BaseException:
                    os.close(fd)
                    raise
                with stream_context as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
            _verify_directory(self.path, identity)
        except OSError as exc:
            raise JournalError("写入事件失败；工具结果必须人工核查") from exc

    def begin(self, tool: str) -> str:
        """Persist intent before a tool is called. Does not execute the tool."""
        if not isinstance(tool, str) or not _TOOL.fullmatch(tool):
            raise JournalError("工具名无效")
        if len(self._records()) >= MAX_EVENTS:
            raise JournalError("事件数量超限")
        call_id = secrets.token_hex(16)
        self._write("intent", call_id, tool)
        return call_id

    def finish(self, call_id: str, tool: str, *, success: bool) -> None:
        """Persist a reported result, without asserting verified side effects."""
        if not isinstance(success, bool):
            raise JournalError("结果状态必须为布尔值")
        records = self._records()
        matches = [r for r in records if r["call_id"] == call_id]
        if len(matches) != 1 or matches[0]["event"] != "intent" or matches[0]["tool"] != tool:
            raise JournalError("调用 ID 未找到、已结束或日志有歧义")
        if len(records) >= MAX_EVENTS:
            raise JournalError("事件数量超限")
        self._write("result_ok" if success else "result_error", call_id, tool)

    def inspect(self) -> dict:
        """Only counts; never expose a transcript, argument, result or call id."""
        records = self._records()
        # Event filenames are random, not chronological. Group by call ID
        # before evaluating; never infer causality from lexical file order.
        groups: dict[str, list[dict]] = {}
        for record in records:
            groups.setdefault(record["call_id"], []).append(record)
        calls: dict[str, dict] = {}
        invalid = False
        for cid, events in groups.items():
            intents = [e for e in events if e["event"] == "intent"]
            results = [e for e in events if e["event"] != "intent"]
            if len(intents) != 1 or len(results) > 1:
                invalid = True
            if not intents:
                continue
            tool = intents[0]["tool"]
            tool_mismatch = any(e["tool"] != tool for e in events)
            if tool_mismatch:
                invalid = True
            # A result for a different tool cannot certify this intent's
            # outcome, even when its event type reports success.
            calls[cid] = {
                "tool": tool,
                "outcome": (
                    results[0]["event"]
                    if len(results) == 1 and not tool_mismatch
                    else "unknown"
                ),
            }
        # Orphan results are unresolved side effects too: do not report zero
        # unknown outcomes merely because an intent event is missing.
        orphan_results = sum(
            1 for events in groups.values()
            if not any(e["event"] == "intent" for e in events)
        )
        pending = sum(x["outcome"] == "unknown" for x in calls.values()) + orphan_results
        return {
            "session_id": self.session_id,
            "event_count": len(records),
            "tool_intents": len(calls),
            "unknown_outcomes": pending,
            "reported_ok": sum(x["outcome"] == "result_ok" for x in calls.values()),
            "reported_errors": sum(x["outcome"] == "result_error" for x in calls.values()),
            "journal_ambiguous": invalid,
            "execution_verified": False,
            "safe_to_auto_resume": False,
            "reason": "事件只记录元数据；未知结果和外部副作用必须人工对账，不自动重放",
        }
