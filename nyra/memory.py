"""Manage Nyra's persistent memory, instruction files, and session history."""

from datetime import datetime
import json
from pathlib import Path
import secrets
import threading

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


def save_session(session_id: str, messages: list[dict]) -> Path:
    """Write messages as UTF-8 JSON Lines and return the session path."""
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    path = SESSIONS_DIR / f"{session_id}.jsonl"

    with path.open("w", encoding="utf-8") as handle:
        for message in messages:
            handle.write(json.dumps(message, ensure_ascii=False) + "\n")

    return path


def load_session(session_id: str) -> list[dict] | None:
    """Load session message dictionaries, skipping malformed JSON lines."""
    path = SESSIONS_DIR / f"{session_id}.jsonl"
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
