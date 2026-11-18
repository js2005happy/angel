"""SQLite conversation store with retrieval (long-term memory).

Standard library only (sqlite3). One database per Nyra home:
``NYRA_HOME/conversations.db`` (0600 on creation).

Schema (version 1):
- ``meta`` — key/value, holds ``schema_version``.
- ``messages`` — one row per recorded message: session, role, text,
  optional tool name, creation time.
- ``messages_fts`` — FTS5 full-text index over ``messages.text`` using
  the trigram tokenizer, so Chinese substring search works too. It is
  kept in sync by triggers. When the local sqlite3 has no FTS5, the
  store falls back to a LIKE-based keyword search (same API).

Nothing here calls a model or the network. Text is scrubbed with
``nyra.memory_exchange.scrub_secrets`` before it is stored, so a line
that looks like a credential never reaches the database. All SQL is
parameterized; user text is never interpolated into a query.

This module is deliberately standalone: callers record messages and call
``retrieve_context()`` before a run. It is NOT wired into ``agent.py``
(frozen) or ``server.py`` (owned by another worker).
"""

import os
import re
import sqlite3
import threading
import time
from pathlib import Path

from .config import NYRA_HOME
from .memory_exchange import scrub_secrets

SCHEMA_VERSION = 1
_DB_NAME = "conversations.db"

# Word-ish runs: ASCII words and CJK runs alike (\w is Unicode-aware).
_TOKEN_RE = re.compile(r"[\w]+", re.UNICODE)

# FTS5 with the trigram tokenizer only matches terms of 3+ characters;
# shorter terms silently match nothing, so they go through the LIKE path.
_FTS5_MIN_TOKEN_LEN = 3

# Per-message cap inside retrieve_context(); the total is capped by max_chars.
_SNIPPET_MAX_CHARS = 300

_ROLES = ("user", "assistant", "tool", "system")


def _tokens(query: str) -> list[str]:
    """Split a query into searchable tokens; [] when there is nothing to search."""
    if not isinstance(query, str):
        return []
    return _TOKEN_RE.findall(query)


def _fts5_supported() -> bool:
    """True when this sqlite3 can build a trigram FTS5 table."""
    try:
        probe = sqlite3.connect(":memory:")
        try:
            probe.execute(
                "CREATE VIRTUAL TABLE _probe USING fts5(x, tokenize='trigram')"
            )
        finally:
            probe.close()
    except sqlite3.Error:
        return False
    return True


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "role": row["role"],
        "text": row["text"],
        "tool_name": row["tool_name"],
        "created_at": row["created_at"],
    }


class ConversationStore:
    """Conversation history in sqlite, with relevance search and retrieval."""

    def __init__(self, home: str | Path | None = None, *, use_fts5: bool | None = None):
        """Open (creating if needed) the store under ``home``.

        ``home`` defaults to ``NYRA_HOME``. ``use_fts5`` forces the
        search path: True requires FTS5 (raises RuntimeError when the
        local sqlite3 lacks it), False forces the LIKE fallback,
        None (default) auto-detects.
        """
        self.home = Path(home) if home is not None else NYRA_HOME
        try:
            self.home.mkdir(parents=True, mode=0o700)
        except FileExistsError:
            pass
        else:
            try:
                os.chmod(self.home, 0o700)
            except OSError:
                pass
        self.db_path = self.home / _DB_NAME
        created = not self.db_path.exists()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._fts5 = False
        self._migrate(use_fts5)
        if created:
            try:
                os.chmod(self.db_path, 0o600)
            except OSError:
                pass

    # -- setup ----------------------------------------------------------

    def _migrate(self, use_fts5: bool | None) -> None:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)"
            )
            cur.execute(
                """CREATE TABLE IF NOT EXISTS messages(
                    id INTEGER PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    text TEXT NOT NULL,
                    tool_name TEXT,
                    created_at REAL NOT NULL)"""
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_session "
                "ON messages(session_id, created_at)"
            )
            row = cur.execute(
                "SELECT value FROM meta WHERE key = 'schema_version'"
            ).fetchone()
            try:
                version = int(row["value"]) if row is not None else 0
            except (TypeError, ValueError):
                # A tampered/corrupt version value must not make the
                # whole store unopenable; treat it as "no migration yet".
                version = 0
            if version < SCHEMA_VERSION:
                # v1 is the base schema: creating the tables above is the
                # whole migration. Future versions add ALTER steps here.
                pass
            self._fts5 = self._enable_fts5(cur, use_fts5)
            cur.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )
            self._conn.commit()

    def _enable_fts5(self, cur: sqlite3.Cursor, use_fts5: bool | None) -> bool:
        """Create the FTS5 index + sync triggers; False when unavailable."""
        if use_fts5 is False:
            return False
        if use_fts5 is None and not _fts5_supported():
            return False
        try:
            existed = cur.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type = 'table' AND name = 'messages_fts'"
            ).fetchone()
            cur.execute("SAVEPOINT nyra_fts5")
            cur.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts "
                "USING fts5(text, content='messages', content_rowid='id', "
                "tokenize='trigram')"
            )
            cur.execute(
                """CREATE TRIGGER IF NOT EXISTS messages_ai
                   AFTER INSERT ON messages BEGIN
                     INSERT INTO messages_fts(rowid, text)
                     VALUES (new.id, new.text);
                   END"""
            )
            cur.execute(
                """CREATE TRIGGER IF NOT EXISTS messages_ad
                   AFTER DELETE ON messages BEGIN
                     INSERT INTO messages_fts(messages_fts, rowid, text)
                     VALUES ('delete', old.id, old.text);
                   END"""
            )
            cur.execute(
                """CREATE TRIGGER IF NOT EXISTS messages_au
                   AFTER UPDATE ON messages BEGIN
                     INSERT INTO messages_fts(messages_fts, rowid, text)
                     VALUES ('delete', old.id, old.text);
                     INSERT INTO messages_fts(rowid, text)
                     VALUES (new.id, new.text);
                   END"""
            )
            # Backfill, only when the index is new: a pre-existing
            # messages table (no FTS before) gets indexed once, instead
            # of only indexing rows inserted afterwards.
            if existed is None:
                cur.execute(
                    "INSERT INTO messages_fts(messages_fts) VALUES('rebuild')"
                )
            cur.execute("RELEASE nyra_fts5")
        except sqlite3.Error:
            try:
                cur.execute("ROLLBACK TO nyra_fts5")
                cur.execute("RELEASE nyra_fts5")
            except sqlite3.Error:
                pass
            if use_fts5 is True:
                raise RuntimeError(
                    "FTS5 was requested but this sqlite3 cannot build it"
                )
            return False
        return True

    # -- properties -----------------------------------------------------

    @property
    def fts5_available(self) -> bool:
        """True when this store searches through the FTS5 index."""
        return self._fts5

    @property
    def schema_version(self) -> int:
        """Schema version recorded in the database."""
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM meta WHERE key = 'schema_version'"
            ).fetchone()
        return int(row["value"]) if row is not None else 0

    def close(self) -> None:
        """Close the database connection."""
        with self._lock:
            self._conn.close()

    def __enter__(self) -> "ConversationStore":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- recording ------------------------------------------------------

    def record(
        self,
        session_id: str,
        role: str,
        text: str,
        tool_name: str | None = None,
        created_at: float | None = None,
    ) -> int | None:
        """Store one message; returns its row id, or None when nothing
        remains after credential scrubbing (e.g. a message that was only
        a secret line)."""
        if not isinstance(session_id, str) or not session_id.strip():
            raise ValueError("session_id must be a non-empty string")
        if not isinstance(role, str) or not role.strip():
            raise ValueError("role must be a non-empty string")
        if role not in _ROLES:
            raise ValueError(f"role must be one of {', '.join(_ROLES)}: {role!r}")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text must be a non-empty string")
        cleaned, _removed = scrub_secrets(text)
        if not cleaned.strip():
            return None
        stamp = time.time() if created_at is None else float(created_at)
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO messages(session_id, role, text, tool_name, created_at)"
                " VALUES(?, ?, ?, ?, ?)",
                (session_id, role, cleaned, tool_name, stamp),
            )
            self._conn.commit()
            return cur.lastrowid

    # -- reading ----------------------------------------------------------

    def history(self, session_id: str, limit: int = 50) -> list[dict]:
        """The session's messages in chronological order (oldest first)."""
        if limit <= 0:
            raise ValueError("limit must be positive")
        with self._lock:
            rows = self._conn.execute(
                """SELECT id, session_id, role, text, tool_name, created_at
                   FROM messages WHERE session_id = ?
                   ORDER BY created_at DESC, id DESC LIMIT ?""",
                (session_id, limit),
            ).fetchall()
        return [_row_to_dict(row) for row in reversed(rows)]

    def sessions(self) -> list[dict]:
        """Sessions with message counts and last activity, newest first."""
        with self._lock:
            rows = self._conn.execute(
                """SELECT session_id, COUNT(*) AS n, MAX(created_at) AS last_at
                   FROM messages GROUP BY session_id ORDER BY last_at DESC"""
            ).fetchall()
        return [
            {
                "session_id": row["session_id"],
                "count": row["n"],
                "last_at": row["last_at"],
            }
            for row in rows
        ]

    # -- search -----------------------------------------------------------

    def search(self, query: str, limit: int = 5) -> list[dict]:
        """Most relevant past messages for ``query``, best first.

        Each result carries the message fields plus ``score`` (higher is
        more relevant: FTS5 bm25 negated, or keyword-overlap count on
        the LIKE fallback path). Returns [] for an empty query.
        """
        if limit <= 0:
            raise ValueError("limit must be positive")
        tokens = _tokens(query)
        if not tokens:
            return []
        if self._fts5 and all(len(t) >= _FTS5_MIN_TOKEN_LEN for t in tokens):
            return self._search_fts5(tokens, limit)
        return self._search_like(tokens, limit)

    def _search_fts5(self, tokens: list[str], limit: int) -> list[dict]:
        # Tokens come from _tokens(), so they hold no quotes or FTS5
        # operators; quoting them is still done defensively.
        match_expr = " OR ".join('"%s"' % t.replace('"', '""') for t in tokens)
        with self._lock:
            rows = self._conn.execute(
                """SELECT m.id, m.session_id, m.role, m.text, m.tool_name,
                          m.created_at, messages_fts.rank AS rank
                   FROM messages_fts
                   JOIN messages m ON m.id = messages_fts.rowid
                   WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?""",
                (match_expr, limit),
            ).fetchall()
        results = []
        for row in rows:
            item = _row_to_dict(row)
            item["score"] = -float(row["rank"])  # bm25 rank is negative
            results.append(item)
        return results

    def _search_like(self, tokens: list[str], limit: int) -> list[dict]:
        lowered = [t.lower() for t in tokens]
        where = " OR ".join("instr(lower(text), ?) > 0" for _ in lowered)
        with self._lock:
            rows = self._conn.execute(
                f"""SELECT id, session_id, role, text, tool_name, created_at
                    FROM messages WHERE {where} LIMIT 200""",
                lowered,
            ).fetchall()
        scored = []
        for row in rows:
            text_lower = row["text"].lower()
            overlap = sum(1 for t in lowered if t in text_lower)
            if overlap:
                item = _row_to_dict(row)
                item["score"] = float(overlap)
                scored.append(item)
        scored.sort(key=lambda item: (-item["score"], -item["created_at"]))
        return scored[:limit]

    # -- retrieval ---------------------------------------------------------

    def retrieve_context(
        self, query: str, limit: int = 5, max_chars: int = 2000
    ) -> str:
        """A prompt-ready block of the most relevant past exchanges.

        Each hit is one ``role: text`` line (whitespace collapsed,
        truncated); the whole block stays within ``max_chars``.
        Returns "" when nothing relevant was found.
        """
        if limit <= 0:
            raise ValueError("limit must be positive")
        if max_chars <= 0:
            raise ValueError("max_chars must be positive")
        hits = self.search(query, limit=limit)
        if not hits:
            return ""
        header = "以下是与当前问题相关的过往对话（仅供参考）："
        if len(header) >= max_chars:
            return header[:max_chars]
        lines = [header]
        used = len(header) + 1
        for hit in hits:
            snippet = " ".join(hit["text"].split())
            if len(snippet) > _SNIPPET_MAX_CHARS:
                snippet = snippet[: _SNIPPET_MAX_CHARS - 1] + "…"
            line = f"- [{hit['role']}] {snippet}"
            if used + len(line) > max_chars:
                room = max_chars - used
                if room < 20:
                    break
                snippet = snippet[: max(room - len(hit["role"]) - 5, 0)]
                line = f"- [{hit['role']}] {snippet}…"
                if len(line) > max_chars - used:
                    break
                lines.append(line)
                break
            lines.append(line)
            used += len(line) + 1
        return "\n".join(lines)

    # -- maintenance ---------------------------------------------------------

    def prune(self, days: int = 90) -> int:
        """Delete messages older than ``days``; returns how many were removed."""
        if days < 0:
            raise ValueError("days must not be negative")
        cutoff = time.time() - days * 86400
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM messages WHERE created_at < ?", (cutoff,)
            )
            self._conn.commit()
            return cur.rowcount
