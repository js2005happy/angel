"""Manage Nyra's persistent memory, instruction files, and session history."""

from datetime import datetime
import json
import os
from pathlib import Path
import secrets
import threading
import tempfile

from .config import NYRA_HOME


# Shared with the web memory editor. Protects append/replace operations in
# this Python process; concurrent separate processes still require caution.
MEMORY_LOCK = threading.RLock()


MEMORY_PATH = NYRA_HOME / "MEMORY.md"
GLOBAL_AGENTS_PATH = NYRA_HOME / "AGENTS.md"
SESSIONS_DIR = NYRA_HOME / "sessions"


def load_memory_summary(max_lines: int = 40, path: Path | None = None) -> str:
    """Return recent lines from the chosen bot's memory (global by default)."""
    target = path if path is not None else MEMORY_PATH
    if not target.exists() or max_lines <= 0:
        return ""

    lines = target.read_text(
        encoding="utf-8", errors="replace"
    ).splitlines()[-max_lines:]

    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()

    return "\n".join(lines)


def append_memory(text: str, path: Path | None = None) -> None:
    """Append to the chosen bot's memory (global by default)."""
    text = " ".join(text.splitlines()).strip()
    if not text:
        return

    target = path if path is not None else MEMORY_PATH
    with MEMORY_LOCK:
        target.parent.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        with target.open("a", encoding="utf-8") as handle:
            handle.write(f"- [{timestamp}] {text}\n")


def load_agents_md(workdir: Path) -> str:
    """Load project instructions followed by user-global instructions."""
    sections: list[str] = []
    sources = (
        (workdir / "AGENTS.md", "# 项目说明（AGENTS.md）\n"),
        (GLOBAL_AGENTS_PATH, "# 全局说明（~/.nyra/AGENTS.md）\n"),
    )

    for path, heading in sources:
        if path.exists():
            content = path.read_text(encoding="utf-8", errors="replace")
            sections.append(heading + content)

    return "\n\n".join(sections)


def new_session_id() -> str:
    """Return a local timestamp followed by four random hexadecimal characters."""
    return datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)


def _session_path(session_id: str) -> Path:
    """校验会话标识，避免跨目录访问及 Windows 特殊路径。"""
    if (
        not isinstance(session_id, str) or not session_id
        or ".." in session_id
        or any(c in session_id for c in '/\\:\x00')
    ):
        raise ValueError("会话 ID 无效")
    return SESSIONS_DIR / f"{session_id}.jsonl"


def save_session(session_id: str, messages: list[dict]) -> Path:
    """在同目录原子替换会话；替换前失败不损坏旧会话。"""
    path = _session_path(session_id)
    SESSIONS_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".nyra-session-", dir=SESSIONS_DIR)
    try:
        # mkstemp 在 POSIX 创建 0600 文件，不继承旧会话的宽松权限。
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for message in messages:
                handle.write(json.dumps(message, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        if os.name == "nt":
            try:
                os.chmod(temp, 0o600)
            except OSError:
                pass  # Windows 权限仅尽力设置。
        # 关闭临时文件后再替换，兼容 Windows。
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return path


def load_session(session_id: str) -> list[dict] | None:
    """Load session message dictionaries, skipping malformed JSON lines.

    非法会话 ID 与不存在的会话一样返回 None，调用方（Web UI、群聊）无需额外捕获。
    """
    try:
        path = _session_path(session_id)
    except ValueError:
        return None
    try:
        handle = path.open("r", encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return None

    messages: list[dict] = []
    with handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(message, dict):
                messages.append(message)

    return messages


def list_sessions() -> list[dict]:
    """Return readable session metadata, ordered by newest modification time."""
    if not SESSIONS_DIR.exists():
        return []

    sessions: list[tuple[float, dict]] = []
    for path in SESSIONS_DIR.glob("*.jsonl"):
        try:
            mtime = path.stat().st_mtime
            lines = path.read_text(
                encoding="utf-8", errors="replace"
            ).splitlines()
        except OSError:
            continue

        count = 0
        preview = ""
        found_user = False
        for line in lines:
            if not line.strip():
                continue
            count += 1

            if found_user:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue

            if isinstance(message, dict) and message.get("role") == "user":
                content = message.get("content", "")
                preview = content[:60] if isinstance(content, str) else ""
                found_user = True

        sessions.append(
            (
                mtime,
                {
                    "id": path.stem,
                    "preview": preview,
                    "count": count,
                    "mtime": datetime.fromtimestamp(mtime).isoformat(
                        timespec="seconds"
                    ),
                },
            )
        )

    sessions.sort(key=lambda entry: entry[0], reverse=True)
    return [metadata for _, metadata in sessions]
