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
        paths = list(self.path.iterdir())
        if len(paths) > MAX_EVENTS:
            raise JournalError("事件数量超限")
        records = []
        for path in sorted(paths):
            if not path.name.endswith(".json") or path.is_symlink():
                raise JournalError("日志目录存在不受支持的文件")
            if not path.is_file() or path.stat().st_size > MAX_EVENT_BYTES:
                raise JournalError("事件文件无效或超限")
            flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
            flags |= getattr(os, "O_NOFOLLOW", 0)
            try:
                fd = os.open(path, flags)
                with os.fdopen(fd, "rb") as handle:
                    info = os.fstat(handle.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_EVENT_BYTES:
                        raise JournalError("事件文件类型或大小无效")
                    raw = handle.read(MAX_EVENT_BYTES + 1)
                if len(raw) > MAX_EVENT_BYTES:
                    raise JournalError("事件文件过大")
                item = json.loads(raw.decode("utf-8"))
            except (OSError, UnicodeError, ValueError) as exc:
                raise JournalError("事件文件损坏或不可读取") from exc
            if not isinstance(item, dict) or set(item) != {
                "version", "event", "call_id", "tool", "at"
            }:
                raise JournalError("事件字段无效")
            if (item["version"] != 1 or item["event"] not in EVENT_TYPES
                    or not isinstance(item["call_id"], str)
                    or not _EVENT.fullmatch(item["call_id"])
                    or not isinstance(item["tool"], str)
                    or not _TOOL.fullmatch(item["tool"])
                    or not isinstance(item["at"], str)
                    or len(item["at"]) > 40):
                raise JournalError("事件值无效")
            records.append(item)
        return records

    def _write(self, event: str, call_id: str, tool: str) -> None:
        if event not in EVENT_TYPES or not isinstance(call_id, str) or not _EVENT.fullmatch(call_id):
            raise JournalError("事件类型或调用 ID 无效")
        if not isinstance(tool, str) or not _TOOL.fullmatch(tool):
            raise JournalError("工具名无效")
        _safe_directory(self.path)
        self.path.mkdir(parents=True, exist_ok=True)
        _safe_directory(self.path)
        item = {
            "version": 1, "event": event, "call_id": call_id,
            "tool": tool, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        payload = (json.dumps(item, sort_keys=True, separators=(",", ":")) + "\n").encode()
        # No append-in-place: a process crash never produces a partial JSON event.
        # The final event filename is randomly unique; O_EXCL refuses overwrites.
        filename = secrets.token_hex(16) + ".json"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(self.path / filename, flags, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
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
        calls: dict[str, dict] = {}
        invalid = False
        for record in records:
            cid = record["call_id"]
            if record["event"] == "intent":
                if cid in calls:
                    invalid = True
                else:
                    calls[cid] = {"tool": record["tool"], "outcome": "unknown"}
            else:
                current = calls.get(cid)
                if (current is None or current["tool"] != record["tool"]
                        or current["outcome"] != "unknown"):
                    invalid = True
                else:
                    current["outcome"] = record["event"]
        pending = sum(x["outcome"] == "unknown" for x in calls.values())
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
