"""Artifacts: rich outputs (code / HTML / Markdown) produced by the agent.

An artifact is a chunk of agent output worth showing in its own panel
instead of inline in the chat: a fenced code block, an HTML document, or
a Markdown document. Artifacts are stored as JSON files under
``NYRA_HOME/artifacts/<session_id>/`` so the web UI (or any later
client) can list and fetch them; the web page itself derives the same
list client-side from the already-polled session messages (see
webui_page.py), because webui.py has no route hook to add an endpoint.

Security: artifact content is never executed by this module. HTML
artifacts render only inside a sandboxed iframe (see webui_page.py);
`markdown_to_html` escapes HTML in the source before applying any
Markdown transform, exactly like the page's own md().
"""

import html
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import config as config_module

MAX_CONTENT_BYTES = 1_048_576  # 1 MB per artifact
MAX_PER_SESSION = 50  # oldest artifacts are dropped past this
KINDS = ("markdown", "html", "code")

# Same shape as webui.py SESSION_ID_RE: session ids come from
# memory.new_session_id() ("20261118-123456-ab12").
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
_ARTIFACT_ID_RE = re.compile(r"^[0-9a-f]{12}$")

# Fenced code block: ```lang\n ... \n``` with both fences at line start
# (up to 3 spaces of indentation). Unterminated fences do not match, so
# they stay in the text instead of being swallowed.
_FENCE_RE = re.compile(
    r"^[ \t]{0,3}```([^\s`]*)[ \t]*\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$",
    re.MULTILINE,
)
_HTML_START_RE = re.compile(
    r"^\s*<(?:!DOCTYPE\s+html|html|body|div|section|article|main|table"
    r"|ul|ol|form|svg|details|blockquote|pre|h[1-6]|p)\b",
    re.IGNORECASE,
)
_HTML_CLOSE_RE = re.compile(r"</[A-Za-z][A-Za-z0-9]*\s*>")


def _home() -> Path:
    """Nyra home, read dynamically so tests can patch config.NYRA_HOME."""
    return Path(config_module.NYRA_HOME)


def _ensure_dir(path: Path) -> None:
    existed = path.exists()
    path.mkdir(parents=True, exist_ok=True)
    if not existed:
        try:
            os.chmod(path, 0o700)
        except OSError:
            pass


def _check_session_id(session_id: str) -> str:
    if not isinstance(session_id, str) or not SESSION_ID_RE.match(session_id):
        raise ValueError(f"无效的会话 id：{session_id!r}")
    return session_id


def _session_dir(session_id: str) -> Path:
    _check_session_id(session_id)
    return _home() / "artifacts" / session_id


def _read_record(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _meta(record: dict) -> dict:
    """The list-view shape: everything except the content itself."""
    content = record.get("content") or ""
    return {
        "id": record.get("id"),
        "session_id": record.get("session_id"),
        "title": record.get("title"),
        "kind": record.get("kind"),
        "lang": record.get("lang") or "",
        "created_at": record.get("created_at"),
        "size": len(content.encode("utf-8", "replace")),
        "truncated": bool(record.get("truncated")),
    }


def create_artifact(
    session_id: str, title: str, kind: str, content: str, lang: str | None = None
) -> dict:
    """Store an artifact and return its full record.

    Content over 1 MB is truncated (``truncated`` is set). Past 50
    artifacts in a session the oldest are deleted.
    """
    if kind not in KINDS:
        raise ValueError(f"未知的产物类型：{kind!r}，可用：{', '.join(KINDS)}")
    if not isinstance(content, str):
        raise ValueError("产物内容必须是字符串")
    session_id = _check_session_id(session_id)
    title = (title or "").strip() or "未命名产物"
    title = title[:200]
    encoded = content.encode("utf-8", "replace")
    truncated = len(encoded) > MAX_CONTENT_BYTES
    if truncated:
        content = encoded[:MAX_CONTENT_BYTES].decode("utf-8", "replace")
    record = {
        "id": uuid.uuid4().hex[:12],
        "session_id": session_id,
        "title": title,
        "kind": kind,
        "lang": (lang or "").strip()[:40],
        "content": content,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "truncated": truncated,
    }
    directory = _session_dir(session_id)
    _ensure_dir(directory)
    path = directory / f"{record['id']}.json"
    tmp = directory / f".{record['id']}.tmp"
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(record, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    _enforce_session_cap(directory)
    return record


def _enforce_session_cap(directory: Path) -> None:
    """Keep at most MAX_PER_SESSION artifacts, dropping the oldest."""
    try:
        paths = sorted(directory.glob("*.json"))
    except OSError:
        return
    if len(paths) <= MAX_PER_SESSION:
        return
    stamped = []
    for path in paths:
        record = _read_record(path)
        stamped.append((record.get("created_at") or "" if record else "", path))
    stamped.sort(key=lambda item: (item[0], item[1].name))
    for _, path in stamped[: len(paths) - MAX_PER_SESSION]:
        try:
            path.unlink()
        except OSError:
            pass


def get_artifact(artifact_id: str) -> dict | None:
    """Return the full record for an id, or None when unknown."""
    if not isinstance(artifact_id, str) or not _ARTIFACT_ID_RE.match(artifact_id):
        return None
    base = _home() / "artifacts"
    if not base.is_dir():
        return None
    for path in base.glob(f"*/{artifact_id}.json"):
        record = _read_record(path)
        if record is not None and record.get("id") == artifact_id:
            return record
    return None


def list_artifacts(session_id: str) -> list[dict]:
    """Metadata (no content) for a session's artifacts, oldest first."""
    directory = _session_dir(session_id)
    if not directory.is_dir():
        return []
    records = []
    for path in sorted(directory.glob("*.json")):
        record = _read_record(path)
        if record is not None:
            records.append(record)
    records.sort(key=lambda r: (r.get("created_at") or "", r.get("id") or ""))
    return [_meta(record) for record in records]


def _scan_html_blocks(lines: list[str]) -> list[tuple[int, int]]:
    """Find bare HTML blocks: (start, end-exclusive) line ranges.

    A block starts at a line opening a block-level HTML tag or doctype
    and must contain at least one closing tag; it ends after that
    closing tag (trailing blank/tag lines belong to the block). Lines
    that merely contain '<' (e.g. "a < b") never start a block.
    """
    blocks: list[tuple[int, int]] = []
    i = 0
    while i < len(lines):
        if not _HTML_START_RE.match(lines[i]):
            i += 1
            continue
        j = i
        seen_close = False
        while j < len(lines):
            if _HTML_CLOSE_RE.search(lines[j]):
                seen_close = True
            if seen_close:
                nxt = lines[j + 1] if j + 1 < len(lines) else ""
                if nxt.strip() == "" or nxt.lstrip().startswith("<"):
                    j += 1
                    continue
                break
            j += 1
        if seen_close:
            blocks.append((i, min(j + 1, len(lines))))
            i = j + 1
        else:
            i += 1
    return blocks


def detect_artifacts(text: str) -> tuple[str, list[dict]]:
    """Split fenced code blocks and HTML blocks out of agent output.

    Returns ``(remaining_text, artifacts)``. Each extracted block is
    replaced in the remaining text by a one-line marker
    (``[产物：<title>]``), so no text is lost: every artifact's content
    is an exact substring of the original, and the markers show where
    each block came from. Unterminated fences and HTML without a
    closing tag are left in the text untouched.
    """
    if not text:
        return "", []
    artifacts: list[dict] = []

    def _replace_fence(match: re.Match) -> str:
        lang = (match.group(1) or "").strip()
        if lang.lower() == "html":
            kind, title = "html", "HTML 页面"
        else:
            kind, title = "code", (f"{lang} 代码" if lang else "代码片段")
        artifacts.append(
            {"title": title, "kind": kind, "lang": lang, "content": match.group(2)}
        )
        return f"[产物：{title}]\n"

    remaining = _FENCE_RE.sub(_replace_fence, text)
    lines = remaining.split("\n")
    blocks = _scan_html_blocks(lines)
    if blocks:
        rebuilt: list[str] = []
        last = 0
        for start, end in blocks:
            rebuilt.extend(lines[last:start])
            content = "\n".join(lines[start:end]).strip("\n")
            artifacts.append(
                {"title": "HTML 页面", "kind": "html", "lang": "html", "content": content}
            )
            rebuilt.append("[产物：HTML 页面]")
            last = end
        rebuilt.extend(lines[last:])
        remaining = "\n".join(rebuilt)
    return remaining, artifacts


def markdown_to_html(text: str) -> str:
    """Escape-first Markdown subset -> HTML string.

    Subset (mirrors the page's md() and the JS mdArtifact renderer):
    headings (#-###, ####-######), bold, italic, inline code, fenced
    code blocks, unordered/ordered lists, http(s) links and bare URLs.
    HTML in the source is escaped before any transform runs, so it can
    never become markup in the output.
    """
    blocks: list[str] = []

    def _fence(match: re.Match) -> str:
        blocks.append(match.group(2))
        return "\x00%d\x00" % (len(blocks) - 1)

    s = _FENCE_RE.sub(_fence, text or "")
    s = html.escape(s)
    s = re.sub(r"`([^`\n]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*\n]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(
        r"\[([^\]\n]+)\]\((https?://[^\s)]+)\)",
        r'<a href="\2" target="_blank" rel="noopener noreferrer">\1</a>',
        s,
    )
    s = re.sub(
        r"(^|[\s(（：:，,])(https?://[^\s<)），。]+)",
        r'\1<a href="\2" target="_blank" rel="noopener noreferrer">\2</a>',
        s,
    )
    out: list[str] = []
    lst: str | None = None
    for line in s.split("\n"):
        match = re.match(r"^\s*[-*]\s+(.*)$", line)
        if match:
            if lst != "ul":
                if lst:
                    out.append(f"</{lst}>")
                out.append("<ul>")
                lst = "ul"
            out.append(f"<li>{match.group(1)}</li>")
            continue
        match = re.match(r"^\s*\d+[.)]\s+(.*)$", line)
        if match:
            if lst != "ol":
                if lst:
                    out.append(f"</{lst}>")
                out.append("<ol>")
                lst = "ol"
            out.append(f"<li>{match.group(1)}</li>")
            continue
        if lst:
            out.append(f"</{lst}>")
            lst = None
        match = re.match(r"^#{1,3}\s+(.*)$", line)
        if match:
            out.append(f"<h3>{match.group(1)}</h3>")
            continue
        match = re.match(r"^#{4,6}\s+(.*)$", line)
        if match:
            out.append(f"<h4>{match.group(1)}</h4>")
            continue
        if line.strip() == "":
            continue
        out.append(f"<p>{line}</p>")
    if lst:
        out.append(f"</{lst}>")
    joined = "\n".join(out)
    return re.sub(
        r"\x00(\d+)\x00",
        lambda m: "<pre><code>" + html.escape(blocks[int(m.group(1))]) + "</code></pre>",
        joined,
    )
