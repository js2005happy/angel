"""Private, bounded persistence and inspection for opt-in execution traces."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import threading
import time

from .config import ANGEL_HOME


TRACE_HOME = ANGEL_HOME / "traces"
MAX_TRACE_FILES = 500
MAX_TRACE_AGE_SECONDS = 30 * 24 * 60 * 60
MAX_TRACE_FILE_BYTES = 256 * 1024
MAX_TRACE_RECORD_BYTES = 4096
_TRACE_ID = re.compile(r"^[0-9a-f]{32}$")
_SAFE_LABEL = re.compile(r"^[A-Za-z0-9_./:+ -]{1,120}$")
_SECRETISH = re.compile(r"(?i)(api[_-]?key|access[_-]?token|secret|bearer|sk-[a-z0-9]{16,})")
_KINDS = {"agent", "model", "tool"}
_STATUSES = {"ok", "completed", "error", "incomplete"}
_LOCK = threading.RLock()


class TraceStoreError(Exception):
    """A trace could not be stored or safely read."""


def _safe_label(value: object, limit: int = 120) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if (
        not value or len(value) > limit
        or not _SAFE_LABEL.fullmatch(value)
        or _SECRETISH.search(value)
    ):
        return None
    return value


def _clean_event(event: dict) -> dict:
    """Keep trace metadata only; deliberately exclude prompts, args and results."""
    clean: dict = {}
    for key in ("trace_id", "span_id", "parent_span_id"):
        value = event.get(key)
        if value is None and key == "parent_span_id":
            clean[key] = None
        elif isinstance(value, str) and _TRACE_ID.fullmatch(value):
            clean[key] = value
        elif key != "trace_id":
            label = _safe_label(value, 32)
            if label:
                clean[key] = label

    kind = event.get("kind")
    if kind in _KINDS:
        clean["kind"] = kind
    for key in ("name", "provider", "model", "error_type", "failure_reason"):
        value = _safe_label(event.get(key))
        if value:
            clean[key] = value
    status = event.get("status")
    if status in _STATUSES:
        clean["status"] = status
    duration = event.get("duration_ms")
    if isinstance(duration, (int, float)) and not isinstance(duration, bool):
        try:
            if math.isfinite(duration) and 0 <= duration <= 7 * 24 * 60 * 60 * 1000:
                clean["duration_ms"] = round(duration, 2)
        except (OverflowError, TypeError, ValueError):
            pass
    status_code = event.get("status_code")
    if isinstance(status_code, int) and not isinstance(status_code, bool):
        if 100 <= status_code <= 599:
            clean["status_code"] = status_code

    usage = event.get("usage")
    if isinstance(usage, dict):
        counters = {}
        for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
            value = usage.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                counters[key] = value
        if counters:
            clean["usage"] = counters

    attempts = event.get("attempts")
    if isinstance(attempts, list):
        safe_attempts = []
        for item in attempts[:8]:
            if not isinstance(item, dict):
                continue
            attempt = {}
            for key in ("provider", "model", "reason"):
                value = _safe_label(item.get(key))
                if value:
                    attempt[key] = value
            code = item.get("status_code")
            if isinstance(code, int) and not isinstance(code, bool) and 100 <= code <= 599:
                attempt["status_code"] = code
            if attempt:
                safe_attempts.append(attempt)
        if safe_attempts:
            clean["attempts"] = safe_attempts
    return clean


class TraceStore:
    """Append sanitized trace events to private local JSONL files."""

    def __init__(self, root: str | Path = TRACE_HOME) -> None:
        self.root = Path(root)

    def _ensure_root(self) -> None:
        if self.root.is_symlink():
            raise TraceStoreError("追踪目录不能是符号链接")
        try:
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.root.is_symlink() or not self.root.is_dir():
                raise TraceStoreError("追踪路径不是普通目录")
            if os.name != "nt":
                self.root.chmod(0o700)
        except OSError as exc:
            raise TraceStoreError(f"无法创建本地追踪目录：{type(exc).__name__}") from exc

    @staticmethod
    def _trace_path(trace_id: str) -> str:
        if not isinstance(trace_id, str) or not _TRACE_ID.fullmatch(trace_id):
            raise TraceStoreError("追踪 ID 格式无效")
        return trace_id + ".jsonl"

    def append(self, event_type: str, event: dict) -> Path | None:
        if event_type not in {"trace_start", "trace_span"} or not isinstance(event, dict):
            return None
        clean = _clean_event(event)
        trace_id = clean.get("trace_id")
        filename = self._trace_path(trace_id)
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "type": event_type,
            "event": clean,
        }
        payload = (json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
        if len(payload) > MAX_TRACE_RECORD_BYTES:
            raise TraceStoreError("追踪事件超过单条存储上限")

        with _LOCK:
            self._ensure_root()
            path = self.root / filename
            if path.is_symlink():
                raise TraceStoreError("追踪文件不能是符号链接")
            flags = os.O_CREAT | os.O_APPEND | os.O_WRONLY
            flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
            try:
                fd = os.open(path, flags, 0o600)
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode):
                        raise TraceStoreError("追踪目标不是普通文件")
                    if info.st_size + len(payload) > MAX_TRACE_FILE_BYTES:
                        raise TraceStoreError("本次追踪已达到单文件大小上限")
                    if hasattr(os, "fchmod"):
                        os.fchmod(fd, 0o600)
                    view = memoryview(payload)
                    while view:
                        written = os.write(fd, view)
                        if written <= 0:
                            raise OSError("short trace write")
                        view = view[written:]
                finally:
                    os.close(fd)
            except TraceStoreError:
                raise
            except OSError as exc:
                raise TraceStoreError(f"无法写入本地追踪：{type(exc).__name__}") from exc
            if event_type == "trace_start":
                self._prune()
            return path

    def _read_path(self, path: Path) -> list[dict]:
        if path.is_symlink() or not path.is_file():
            return []
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        try:
            fd = os.open(path, flags)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_TRACE_FILE_BYTES:
                    return []
                chunks = []
                remaining = MAX_TRACE_FILE_BYTES + 1
                while remaining:
                    chunk = os.read(fd, min(65536, remaining))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                raw = b"".join(chunks)
            finally:
                os.close(fd)
        except OSError:
            return []
        if len(raw) > MAX_TRACE_FILE_BYTES:
            return []
        records = []
        for line in raw.splitlines():
            try:
                value = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(value, dict) or not isinstance(value.get("event"), dict):
                continue
            if value.get("type") not in {"trace_start", "trace_span"}:
                continue
            try:
                event = _clean_event(value["event"])
            except (OverflowError, TypeError, ValueError):
                continue
            if event.get("trace_id") != path.stem:
                continue
            timestamp = value.get("timestamp")
            if not isinstance(timestamp, str):
                continue
            try:
                timestamp = datetime.fromisoformat(timestamp).astimezone(timezone.utc).isoformat(
                    timespec="milliseconds"
                )
            except ValueError:
                continue
            records.append({"timestamp": timestamp, "type": value["type"], "event": event})
        return records

    def read(self, trace_id: str) -> list[dict]:
        path = self.root / self._trace_path(trace_id)
        if self.root.is_symlink():
            raise TraceStoreError("追踪目录不能是符号链接")
        return self._read_path(path)

    def list_recent(self, limit: int = 20) -> list[dict]:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise TraceStoreError("--limit 必须在 1 到 100 之间")
        if self.root.is_symlink():
            raise TraceStoreError("追踪目录不能是符号链接")
        if not self.root.is_dir():
            return []
        candidates = []
        for path in self.root.glob("*.jsonl"):
            if not _TRACE_ID.fullmatch(path.stem) or path.is_symlink():
                continue
            try:
                candidates.append((path.stat().st_mtime_ns, path))
            except OSError:
                continue
        candidates.sort(reverse=True, key=lambda pair: pair[0])
        summaries = []
        for _mtime, path in candidates[:MAX_TRACE_FILES]:
            records = self._read_path(path)
            if not records:
                continue
            spans = [r["event"] for r in records if r.get("type") == "trace_span"]
            root = next((e for e in reversed(spans) if e.get("kind") == "agent"), {})
            models = [e for e in spans if e.get("kind") == "model"]
            tokens = 0
            for event in models:
                usage = event.get("usage")
                if not isinstance(usage, dict):
                    continue
                total = usage.get("total_tokens")
                if isinstance(total, int):
                    tokens += total
                else:
                    tokens += usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0)
            summaries.append({
                "trace_id": path.stem,
                "started_at": records[0].get("timestamp", ""),
                "status": root.get("status", "incomplete"),
                "duration_ms": root.get("duration_ms"),
                "model_calls": len(models),
                "total_tokens": tokens,
            })
            if len(summaries) >= limit:
                break
        return summaries

    def _prune(self) -> None:
        cutoff = time.time() - MAX_TRACE_AGE_SECONDS
        paths = []
        for path in self.root.glob("*.jsonl"):
            if not _TRACE_ID.fullmatch(path.stem) or path.is_symlink():
                continue
            try:
                info = path.stat()
            except OSError:
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            if info.st_mtime < cutoff:
                try:
                    path.unlink()
                except OSError:
                    pass
            else:
                paths.append((info.st_mtime_ns, path))
        paths.sort(reverse=True, key=lambda pair: pair[0])
        for _mtime, path in paths[MAX_TRACE_FILES:]:
            try:
                path.unlink()
            except OSError:
                pass


def _format_duration(value) -> str:
    return f"{value:g} ms" if isinstance(value, (int, float)) else "未知耗时"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="angel trace", description="查看本地执行追踪")
    actions = parser.add_subparsers(dest="action", required=True)
    listing = actions.add_parser("list", help="列出最近的追踪记录")
    listing.add_argument("--limit", type=int, default=20, help="最多显示 100 条，默认 20")
    show = actions.add_parser("show", help="查看一次执行的 spans")
    show.add_argument("trace_id", help="由 --trace 输出的 32 位追踪 ID")
    args = parser.parse_args(argv)
    store = TraceStore()
    try:
        if args.action == "list":
            rows = store.list_recent(args.limit)
            if not rows:
                print("没有本地追踪记录；运行任务时加 --trace 以保存。")
                return 0
            for row in rows:
                duration = _format_duration(row.get("duration_ms"))
                print(
                    f"{row['trace_id']}  {row['status']:<10}  {duration:<14}  "
                    f"模型 {row['model_calls']} 次  Token {row['total_tokens']}  "
                    f"{row['started_at']}"
                )
            return 0

        records = store.read(args.trace_id)
        if not records:
            print("追踪记录不存在或不可读取。", file=sys.stderr)
            return 1
        events = [row["event"] for row in records]
        print(f"Trace {args.trace_id}")
        span_rows = [e for e in events if e.get("kind")]
        parents = {
            e.get("span_id"): e.get("parent_span_id")
            for e in span_rows if e.get("span_id")
        }
        for event in span_rows:
            parent = event.get("parent_span_id")
            depth = 0
            seen = set()
            while parent in parents and parent not in seen:
                seen.add(parent)
                depth += 1
                parent = parents.get(parent)
            label = event.get("name", event.get("kind", "span"))
            details = [event.get("status", "start"), _format_duration(event.get("duration_ms"))]
            if event.get("provider") or event.get("model"):
                details.append(f"{event.get('provider', '?')} / {event.get('model', '?')}")
            usage = event.get("usage") or {}
            if usage:
                details.append(f"{usage.get('total_tokens', '?')} tokens")
            if event.get("attempts"):
                details.append(f"兜底尝试 {len(event['attempts'])} 次")
            if event.get("error_type"):
                details.append(event["error_type"])
            if event.get("status_code"):
                details.append(f"HTTP {event['status_code']}")
            if event.get("failure_reason"):
                details.append(event["failure_reason"])
            print(f"{'  ' * min(depth, 12)}- {label}: {' · '.join(details)}")
        return 0
    except TraceStoreError as exc:
        print(f"追踪记录错误：{exc}", file=sys.stderr)
        return 1
