"""Crash-aware local file checkpoints with conflict-safe undo/rewind.

Only Angel's built-in local write_file, edit_file, and plan text writes use
this store. Shell, MCP, E2B, memory/skill data and arbitrary other filesystem
side effects are NOT captured. A checkpoint is one top-level Agent.run task.
"""

import base64
from .patches import unified_preview
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import stat
import tempfile
import threading
import time

MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TURN_FILES = 20
MAX_REWIND = 10


class CheckpointError(Exception):
    """Checkpoint capacity, path, external-change or I/O safety failure."""


def _digest(data: bytes | None) -> str | None:
    return hashlib.sha256(data).hexdigest() if data is not None else None


def _atomic_write(path: Path, payload: bytes) -> None:
    """Write via a same-directory temporary file and atomic file replacement."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".angel-write-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        if path.exists():
            os.chmod(temp, stat.S_IMODE(path.stat().st_mode))
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


class CheckpointStore:
    """Local per-session and per-workspace checkpoints, persisted outside workdir."""

    def __init__(self, base_dir: Path, session_id: str, workdir: Path):
        self.workdir = Path(workdir).resolve()
        if not self.workdir.is_dir():
            raise CheckpointError("工作目录不存在")
        fingerprint = hashlib.sha256(
            (session_id + "\0" + str(self.workdir)).encode("utf-8")
        ).hexdigest()[:32]
        self.directory = Path(base_dir) / fingerprint
        self._lock = threading.RLock()
        self._active: dict | None = None
        self._active_path: Path | None = None

    def begin_turn(self) -> None:
        """One checkpoint per top-level run, lazily created on first file write."""
        with self._lock:
            self._active = None
            self._active_path = None

    def _new_record(self) -> tuple[Path, dict]:
        self.directory.mkdir(parents=True, exist_ok=True)
        name = f"{time.time_ns():020d}-{secrets.token_hex(6)}.json"
        return self.directory / name, {
            "version": 1, "workdir": str(self.workdir),
            "undone": False, "files": {},
        }

    def _safe_path(self, relative: str) -> Path:
        if not isinstance(relative, str):
            raise CheckpointError("检查点文件路径无效")
        p = PurePosixPath(relative)
        if p.is_absolute() or not p.parts or any(x in (".", "..") for x in p.parts):
            raise CheckpointError("检查点文件路径超出工作目录")
        raw = self.workdir.joinpath(*p.parts)
        if raw.is_symlink():
            raise CheckpointError("文件已被替换为符号链接，不执行撤销")
        resolved = raw.resolve()
        if resolved == self.workdir or not resolved.is_relative_to(self.workdir):
            raise CheckpointError("目标路径不在工作目录内")
        return raw

    def _relative(self, path: Path) -> str:
        target = Path(path)
        if target.is_symlink():
            raise CheckpointError("拒绝对符号链接执行检查点写入")
        resolved = target.resolve()
        if resolved == self.workdir or not resolved.is_relative_to(self.workdir):
            raise CheckpointError("目标路径不在工作目录内")
        return resolved.relative_to(self.workdir).as_posix()

    def _content(self, path: Path) -> bytes | None:
        if path.is_symlink():
            raise CheckpointError("文件已变成符号链接")
        if not path.exists():
            return None
        if not path.is_file():
            raise CheckpointError("检查点只能处理普通文件")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise CheckpointError("文件超过 2 MiB 检查点限制")
        content = path.read_bytes()
        if len(content) > MAX_FILE_BYTES:
            raise CheckpointError("文件超过 2 MiB 检查点限制")
        return content

    def _save(self, path: Path, record: dict) -> None:
        if path.is_symlink():
            raise CheckpointError("检查点元数据路径不安全")
        encoded = json.dumps(record, ensure_ascii=False, sort_keys=True).encode("utf-8")
        _atomic_write(path, encoded)

    def _records(self) -> list[tuple[Path, dict]]:
        if not self.directory.exists():
            return []
        found = []
        for path in sorted(self.directory.glob("*.json")):
            if path.is_symlink():
                raise CheckpointError("检查点元数据不能是符号链接")
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise CheckpointError("检查点元数据损坏") from exc
            if (
                not isinstance(record, dict)
                or record.get("version") != 1
                or record.get("workdir") != str(self.workdir)
                or not isinstance(record.get("files"), dict)
            ):
                raise CheckpointError("检查点元数据与当前工作目录不一致")
            found.append((path, record))
        return found

    def write_text(self, path: Path, content: str) -> None:
        """Capture original bytes BEFORE a successful atomic built-in file write.

        Manifest is persisted *before* the file replacement; interrupted writes
        are fail-closed on undo because their current hash does not match.
        """
        payload = content.encode("utf-8")
        if len(payload) > MAX_FILE_BYTES:
            raise CheckpointError("写入超过 2 MiB 检查点限制")
        with self._lock:
            relative = self._relative(path)
            safe_path = self._safe_path(relative)
            before = self._content(safe_path)
            if self._active is None:
                # No backup should be silently discarded.
                records = self._records()
                if sum(not rec["undone"] for _, rec in records) >= 20:
                    raise CheckpointError("未撤销的检查点已达 20 个，请先备份或整理")
                self._active_path, self._active = self._new_record()

            items = self._active["files"]
            if relative not in items and len(items) >= MAX_TURN_FILES:
                raise CheckpointError("单次任务最多修改 20 个有检查点的文件")
            previous = dict(self._active)
            previous["files"] = dict(items)
            entry = dict(items.get(relative, {}))
            if not entry:
                entry = {
                    "before": (base64.b64encode(before).decode("ascii")
                               if before is not None else None),
                    "before_sha": _digest(before),
                }
            # If a prior tool write has been externally changed during this
            # turn, stop instead of silently overwriting or losing that edit.
            elif _digest(before) != entry["after_sha"]:
                raise CheckpointError("文件已被其他操作修改，拒绝继续覆盖")
            entry["after_sha"] = _digest(payload)
            self._active["files"][relative] = entry
            self._save(self._active_path, self._active)
            try:
                # Verify scope again after any directory creation.
                safe_path.parent.mkdir(parents=True, exist_ok=True)
                safe_path = self._safe_path(relative)
                _atomic_write(safe_path, payload)
            except Exception:
                # If the attempted write made no change, roll metadata back.
                if _digest(self._content(safe_path)) == _digest(before):
                    self._active = previous
                    if previous["files"]:
                        self._save(self._active_path, previous)
                    else:
                        self._active_path.unlink(missing_ok=True)
                        self._active = None
                        self._active_path = None
                raise

    def history(self) -> list[dict]:
        with self._lock:
            return [
                {"id": path.stem, "files": len(record["files"])}
                for path, record in self._records() if not record["undone"]
            ]

    def latest_diff(self, max_chars: int = 12000) -> str:
        """Show changes from the newest not-undone checkpoint only.

        If any target was altered after Angel wrote it, report a conflict
        instead of presenting somebody else's edits as Angel's own diff.
        """
        with self._lock:
            active = [(p, r) for p, r in self._records() if not r["undone"]]
            if not active:
                return "（当前会话没有可查看的本地文件检查点）"
            manifest, record = active[-1]
            pieces = [f"最近检查点：{manifest.stem}（{len(record['files'])} 个文件）"]
            for relative, entry in sorted(record["files"].items()):
                target = self._safe_path(relative)
                current = self._content(target)
                if _digest(current) != entry.get("after_sha"):
                    pieces.append(f"{relative}：冲突——文件已被外部修改，无法可靠展示 Angel 的最终 diff")
                    continue
                raw = entry.get("before")
                try:
                    original = base64.b64decode(raw, validate=True) if isinstance(raw, str) else None
                except (ValueError, TypeError) as exc:
                    raise CheckpointError("检查点备份数据损坏") from exc
                if _digest(original) != entry.get("before_sha"):
                    raise CheckpointError("检查点备份数据校验失败")
                pieces.append(unified_preview(relative, original, current, max_chars=6000))
            result = "\n\n".join(pieces)
            if len(result) > max_chars:
                result = result[:max_chars] + "\n...（检查点 diff 总长度过长，已截断）"
            return result

    def undo(self, count: int = 1) -> dict:
        """Fail closed if ANY affected file changed since its last Angel write.

        Preflight all selected turns *before* modifying any file, including
        overlapping paths across turns. This is not a cross-file OS transaction.
        """
        if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_REWIND:
            raise CheckpointError("撤销轮数必须在 1 到 10 之间")
        with self._lock:
            active = [
                (path, r) for path, r in self._records() if not r["undone"]
            ]
            if len(active) < count:
                raise CheckpointError("没有足够的可撤销检查点")
            selected = list(reversed(active[-count:]))
            simulated: dict[str, str | None] = {}
            restore = []
            for path, record in selected:
                for rel, entry in record["files"].items():
                    target = self._safe_path(rel)
                    current = simulated.get(rel, _digest(self._content(target)))
                    if current != entry.get("after_sha"):
                        raise CheckpointError(
                            f"文件 {rel} 已被外部修改，撤销已取消且未覆盖任何文件"
                        )
                    encoded = entry.get("before")
                    try:
                        original = (
                            base64.b64decode(encoded, validate=True)
                            if isinstance(encoded, str) else None
                        )
                    except (ValueError, TypeError) as exc:
                        raise CheckpointError("检查点备份数据损坏") from exc
                    if _digest(original) != entry.get("before_sha"):
                        raise CheckpointError("检查点备份数据校验失败")
                    simulated[rel] = _digest(original)
                    restore.append((target, original))
            # All files checked before applying any restoration. Re-check on
            # each actual write in case a symlink changed during preflight.
            for target, original in restore:
                rel = target.relative_to(self.workdir).as_posix()
                target = self._safe_path(rel)
                if original is None:
                    target.unlink()
                else:
                    _atomic_write(target, original)
            for path, record in selected:
                record["undone"] = True
                self._save(path, record)
            self._active = None
            self._active_path = None
            return {
                "turns": len(selected),
                "files": len(set(p.as_posix() for p, _ in restore)),
            }
