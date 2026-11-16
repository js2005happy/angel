"""Safe, versioned editing of Angel's file-backed persistent memories.

Reads and writes use the same in-process lock as memory_append. A caller must
supply the exact revision read earlier, so a Web UI save cannot unknowingly
overwrite an intervening Agent append. This is not a cross-process lock.
"""

import hashlib
import os
from pathlib import Path
import re
import stat
import tempfile

from . import memory as memory_module

MAX_MEMORY_BYTES = 64 * 1024
_REVISION = re.compile(r"(?:missing|[0-9a-f]{64})\Z")


class MemoryBrowserError(ValueError):
    """Invalid target, version conflict, or memory content."""


class MemoryConflict(MemoryBrowserError):
    """The memory changed since it was last loaded."""


def _validate_target(path: Path, *, root: Path | None = None) -> Path:
    path = Path(path)
    # The group room, bots directory, bot directory, and memory file must not
    # be symlinks. Otherwise room A could expose room B or arbitrary files.
    if root is not None:
        canonical_root = Path(root)
        if canonical_root.is_symlink():
            raise MemoryBrowserError("机器人记忆根目录不能是符号链接")
        if not path.is_relative_to(canonical_root):
            raise MemoryBrowserError("记忆文件超出机器人目录")
        for node in (path, *path.parents):
            if node == canonical_root:
                break
            if node.is_symlink():
                raise MemoryBrowserError("拒绝通过符号链接访问机器人记忆")
        if path.resolve() != canonical_root.resolve() / path.relative_to(canonical_root):
            raise MemoryBrowserError("机器人记忆路径不安全")
    elif path.is_symlink():
        raise MemoryBrowserError("拒绝通过符号链接编辑全局记忆")
    if path.exists() and not path.is_file():
        raise MemoryBrowserError("记忆路径不是普通文件")
    return path


def _current(path: Path) -> tuple[str, str, bool]:
    if not path.exists():
        return "", "missing", False
    if path.stat().st_size > MAX_MEMORY_BYTES:
        raise MemoryBrowserError("记忆文件超过 64 KiB，网页暂不支持编辑")
    content = path.read_bytes()
    if len(content) > MAX_MEMORY_BYTES:
        raise MemoryBrowserError("记忆文件超过 64 KiB，网页暂不支持编辑")
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MemoryBrowserError("记忆文件不是有效的 UTF-8 文本") from exc
    return text, hashlib.sha256(content).hexdigest(), True


def inspect_memory(path: Path, *, root: Path | None = None) -> dict:
    """Return editable plaintext and a revision token. Protected by UI auth."""
    with memory_module.MEMORY_LOCK:
        safe = _validate_target(path, root=root)
        text, revision, exists = _current(safe)
        return {
            "content": text, "revision": revision, "exists": exists,
            "bytes": len(text.encode("utf-8")),
            "summary_lines": min(40, len(text.splitlines())),
        }


def replace_memory(path: Path, revision: str, content: str, *,
                   root: Path | None = None) -> dict:
    """Atomic replace with optimistic SHA-256 check and in-process locking."""
    if not isinstance(revision, str) or not _REVISION.fullmatch(revision):
        raise MemoryBrowserError("记忆版本号无效，请刷新后再保存")
    if not isinstance(content, str) or "\x00" in content:
        raise MemoryBrowserError("记忆内容无效")
    data = content.encode("utf-8")
    if len(data) > MAX_MEMORY_BYTES:
        raise MemoryBrowserError("记忆不能超过 64 KiB")
    with memory_module.MEMORY_LOCK:
        safe = _validate_target(path, root=root)
        _, latest_revision, exists = _current(safe)
        if latest_revision != revision:
            raise MemoryConflict("记忆已被其他任务更新，未覆盖任何内容；请刷新并合并改动")

        safe.parent.mkdir(parents=True, exist_ok=True)
        # Validate once more after mkdir to reject a newly-created symlink.
        _validate_target(safe, root=root)
        fd, temporary = tempfile.mkstemp(prefix=".angel-memory-", dir=safe.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            # Retain existing mode; new memory is private to the user.
            os.chmod(temporary, stat.S_IMODE(safe.stat().st_mode) if exists else 0o600)
            _validate_target(safe, root=root)
            _, current_revision, _ = _current(safe)
            if current_revision != revision:
                raise MemoryConflict("记忆在保存期间发生变化，请刷新后再编辑")
            os.replace(temporary, safe)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {
            "content": content, "revision": hashlib.sha256(data).hexdigest(),
            "exists": True, "bytes": len(data),
            "summary_lines": min(40, len(content.splitlines())),
        }
