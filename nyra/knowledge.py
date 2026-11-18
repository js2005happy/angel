"""Local AI knowledge base for Nyra.

Usage mirrors the "turn a creator's content into your AI knowledge
base" flow (create a base -> paste links/content -> notes with dated
titles -> ask the AI over the base), but everything runs locally:
text / files / web pages are chunked into notes, stored as JSONL,
retrieved with stdlib BM25, and the top notes are handed to the
model when answering. No third-party service, no video download.

Layout: ``NYRA_HOME/knowledge/<name>/`` holds ``kb.json``
(``{name, description, created_at}``) and ``notes.jsonl`` (one note
per line: ``{id, title, source, date, text, created_at}``).

Limits, stated plainly:
- ``add_url`` fetches the raw HTML and strips tags; JavaScript-heavy
  pages (Douyin, Xiaohongshu, ...) only yield their server-rendered
  title / description / meta text, not the spoken video content.
  There is no transcription and no video download here.
- Retrieval is BM25 over the notes in one base (English words plus
  Chinese single characters and bigrams). It ranks by word overlap,
  it does not understand meaning.
- The model only ever sees the retrieved notes; it is instructed to
  say it does not know when the base has nothing relevant.
"""

from __future__ import annotations

import argparse
import html
import json
import math
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

NAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$\Z")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Largest web page add_url will read: anything bigger is rejected
# instead of being buffered unbounded into memory.
MAX_PAGE_BYTES = 2 * 1024 * 1024

# One note holds at most about this many characters; shorter pieces
# are merged into the next note so the base is not full of fragments.
MAX_NOTE_CHARS = 1500
MIN_NOTE_CHARS = 200

_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0 Safari/537.36"
)

ASK_SYSTEM_PROMPT = (
    "你是 Nyra 的知识库问答助手。只根据下面提供的库内笔记回答问题；"
    "回答末尾注明依据了哪几条笔记（写笔记标题）；如果库内笔记没有"
    "相关内容，就直说不知道，不要编造；不要使用笔记之外的知识。"
)


class KnowledgeError(Exception):
    """Raised for knowledge-base errors; never includes note content."""


def _default_base() -> Path:
    """Default base directory: NYRA_HOME/knowledge.

    Resolved lazily (function-level import) so tests can patch
    ``nyra.config.NYRA_HOME`` and so this module stays importable
    without the config layer.
    """
    from nyra.config import NYRA_HOME

    return NYRA_HOME / "knowledge"


def _today() -> str:
    return datetime.now().date().isoformat()


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _check_name(name: str) -> str:
    if not isinstance(name, str) or not NAME_PATTERN.match(name):
        raise KnowledgeError("知识库名只允许字母、数字、下划线、点、横线")
    if name in (".", ".."):
        # "." / ".." pass the pattern but resolve to the base directory
        # itself / its parent, so a base would be created outside the
        # knowledge directory (kb.json written to the parent dir).
        raise KnowledgeError("知识库名不能是 . 或 ..")
    return name


def _check_date(date: str | None) -> str:
    if date is None:
        return _today()
    if not isinstance(date, str) or not DATE_PATTERN.match(date):
        raise KnowledgeError("日期须为 YYYY-MM-DD 格式")
    return date


def _tokenize(text: str) -> list[str]:
    """English words plus Chinese single characters and bigrams."""
    text = text.lower()
    tokens = re.findall(r"[a-z0-9]+", text)
    for run in re.findall(r"[\u4e00-\u9fff]+", text):
        tokens.extend(run)
        tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
    return tokens


def _split_long(text: str, limit: int = MAX_NOTE_CHARS) -> list[str]:
    """Split one over-long paragraph, preferably at sentence ends."""
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    rest = text
    ends = ".。!！?？；;\n"
    while len(rest) > limit:
        cut = max(rest.rfind(ch, 0, limit) for ch in ends)
        if cut < limit // 2:
            cut = limit
        else:
            cut += 1
        parts.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        parts.append(rest)
    return [p for p in parts if p]


def _chunk_text(text: str, fallback_title: str) -> list[tuple[str, str]]:
    """Split text into (title, text) notes.

    Sections start at Markdown headings (# / ## / ###); inside a
    section, blank lines separate paragraphs. Short pieces are
    merged until they reach a useful size; over-long paragraphs are
    split. Returns at least one chunk for non-empty text.
    """
    sections: list[tuple[str, list[str]]] = []
    heading: str | None = None
    body: list[str] = []

    def flush_section() -> None:
        nonlocal body, heading
        sections.append((heading, body))
        body = []
        heading = None

    for line in text.splitlines():
        match = re.match(r"^#{1,3}\s+(.*\S)\s*$", line)
        if match:
            flush_section()
            heading = match.group(1).strip()
            continue
        body.append(line)
    flush_section()

    chunks: list[tuple[str, str]] = []
    for section_title, lines in sections:
        title = section_title or fallback_title
        # Paragraphs: blank-line separated, non-empty.
        paragraphs: list[str] = []
        current: list[str] = []
        for line in lines:
            if line.strip():
                current.append(line.strip())
            elif current:
                paragraphs.append(" ".join(current))
                current = []
        if current:
            paragraphs.append(" ".join(current))
        buffer = ""
        for para in paragraphs:
            for piece in _split_long(para):
                if buffer and len(buffer) + 1 + len(piece) > MAX_NOTE_CHARS:
                    chunks.append((title, buffer))
                    buffer = piece
                else:
                    buffer = f"{buffer} {piece}".strip() if buffer else piece
        if buffer:
            chunks.append((title, buffer))
        elif not paragraphs and section_title:
            # A heading with no body still records the heading.
            chunks.append((title, title))
    # Merge a short tail chunk into the previous note of the same
    # section where that keeps notes from being fragments.
    merged: list[tuple[str, str]] = []
    for title, body_text in chunks:
        if (
            merged
            and merged[-1][0] == title
            and len(body_text) < MIN_NOTE_CHARS
            and len(merged[-1][1]) + 1 + len(body_text) <= MAX_NOTE_CHARS
        ):
            prev_title, prev_text = merged[-1]
            merged[-1] = (prev_title, f"{prev_text} {body_text}")
        else:
            merged.append((title, body_text))
    # Number extra notes that share one section title.
    seen: dict[str, int] = {}
    numbered: list[tuple[str, str]] = []
    for title, body_text in merged:
        seen[title] = seen.get(title, 0) + 1
        if seen[title] > 1:
            title = f"{title}（{seen[title]}）"
        numbered.append((title, body_text))
    return numbered


def _extract_page_text(raw_html: str) -> tuple[str, str]:
    """Return (title, body text) from raw HTML.

    Drops <script>/<style> blocks, then tags; unescapes entities and
    collapses whitespace. Pages that render their content with
    JavaScript only expose their <title> and meta description here.
    """
    title_match = re.search(
        r"<title[^>]*>(.*?)</title>", raw_html, re.IGNORECASE | re.DOTALL
    )
    title = (
        html.unescape(re.sub(r"\s+", " ", title_match.group(1)).strip())
        if title_match
        else ""
    )
    desc_match = re.search(
        r'<meta[^>]+name=["\']description["\'][^>]+content=["\'](.*?)["\']',
        raw_html,
        re.IGNORECASE | re.DOTALL,
    )
    description = (
        html.unescape(desc_match.group(1).strip()) if desc_match else ""
    )
    body = re.sub(
        r"<(script|style)[^>]*>.*?</\1>",
        " ",
        raw_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    body = re.sub(r"<[^>]+>", " ", body)
    body = html.unescape(body)
    body = re.sub(r"[ \t\r\f\v]+", " ", body)
    body = re.sub(r"\n\s*\n+", "\n\n", body)
    text = body.strip()
    if description and description not in text:
        text = f"{description}\n\n{text}" if text else description
    return title, text


class KnowledgeBase:
    """One store holding many local knowledge bases."""

    def __init__(self, base: str | Path | None = None):
        self.base = Path(base) if base is not None else _default_base()

    # -- paths ------------------------------------------------------
    def _kb_dir(self, name: str) -> Path:
        return self.base / _check_name(name)

    def _meta_path(self, name: str) -> Path:
        return self._kb_dir(name) / "kb.json"

    def _notes_path(self, name: str) -> Path:
        return self._kb_dir(name) / "notes.jsonl"

    def exists(self, name: str) -> bool:
        return self._meta_path(name).is_file()

    def _require(self, name: str) -> Path:
        kb_dir = self._kb_dir(name)
        if not self._meta_path(name).is_file():
            raise KnowledgeError(f"知识库不存在：{name}")
        return kb_dir

    # -- persistence -------------------------------------------------
    @staticmethod
    def _atomic_write(path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            os.replace(tmp_name, path)
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def _load_notes(self, name: str) -> list[dict]:
        self._require(name)
        path = self._notes_path(name)
        if not path.is_file():
            return []
        notes = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                notes.append(json.loads(line))
            except ValueError as exc:
                raise KnowledgeError(f"知识库笔记已损坏：{name}") from exc
        return notes

    def _save_notes(self, name: str, notes: list[dict]) -> None:
        data = "".join(
            json.dumps(note, ensure_ascii=False) + "\n" for note in notes
        ).encode("utf-8")
        self._atomic_write(self._notes_path(name), data)

    # -- bases --------------------------------------------------------
    def create(self, name: str, description: str = "") -> dict:
        _check_name(name)
        if self.exists(name):
            raise KnowledgeError(f"知识库已存在：{name}")
        meta = {
            "name": name,
            "description": description,
            "created_at": _now(),
        }
        self._atomic_write(
            self._meta_path(name),
            (json.dumps(meta, ensure_ascii=False, indent=2) + "\n").encode(
                "utf-8"
            ),
        )
        self._atomic_write(self._notes_path(name), b"")
        return meta

    def list_bases(self) -> list[dict]:
        out = []
        if not self.base.is_dir():
            return out
        for meta_path in sorted(self.base.glob("*/kb.json")):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                continue
            name = meta.get("name") or meta_path.parent.name
            try:
                count = len(self._load_notes(name))
            except KnowledgeError:
                count = 0
            out.append({**meta, "notes": count})
        return out

    def remove(self, name: str) -> None:
        kb_dir = self._require(name)
        for path in (self._notes_path(name), self._meta_path(name)):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        try:
            kb_dir.rmdir()
        except OSError:
            pass

    # -- ingest --------------------------------------------------------
    def add_text(
        self,
        name: str,
        text: str,
        title: str,
        source: str,
        date: str | None = None,
    ) -> list[dict]:
        self._require(name)
        if not isinstance(text, str) or not text.strip():
            raise KnowledgeError("内容为空，没有可收录的笔记")
        note_date = _check_date(date)
        created = _now()
        notes = self._load_notes(name)
        new_notes = []
        for chunk_title, chunk_text in _chunk_text(text, title):
            new_notes.append(
                {
                    "id": uuid.uuid4().hex[:12],
                    "title": chunk_title,
                    "source": source,
                    "date": note_date,
                    "text": chunk_text,
                    "created_at": created,
                }
            )
        notes.extend(new_notes)
        self._save_notes(name, notes)
        return new_notes

    def add_file(self, name: str, path: str | Path) -> list[dict]:
        self._require(name)
        file_path = Path(path)
        if not file_path.is_file():
            raise KnowledgeError(f"文件不存在：{file_path}")
        if file_path.suffix.lower() not in (".txt", ".md"):
            raise KnowledgeError("只收录 .txt / .md 文件")
        try:
            text = file_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise KnowledgeError(f"读文件失败：{file_path}") from exc
        date = datetime.fromtimestamp(
            file_path.stat().st_mtime
        ).date().isoformat()
        return self.add_text(
            name, text, file_path.name, str(file_path), date
        )

    def add_dir(self, name: str, path: str | Path) -> list[dict]:
        self._require(name)
        dir_path = Path(path)
        if not dir_path.is_dir():
            raise KnowledgeError(f"目录不存在：{dir_path}")
        files = sorted(
            p
            for p in dir_path.rglob("*")
            if p.is_file() and p.suffix.lower() in (".txt", ".md")
        )
        added: list[dict] = []
        for file_path in files:
            try:
                added.extend(self.add_file(name, file_path))
            except KnowledgeError:
                # 空文件跳过，其他文件继续收录。
                continue
        return added

    def add_url(self, name: str, url: str) -> list[dict]:
        self._require(name)
        request = urllib.request.Request(
            url, headers={"User-Agent": _BROWSER_UA}
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                content_type = response.headers.get("Content-Type") or ""
                declared = response.headers.get("Content-Length")
                if declared is not None:
                    try:
                        if int(declared) > MAX_PAGE_BYTES:
                            raise KnowledgeError(
                                f"页面超过 {MAX_PAGE_BYTES // (1024 * 1024)} MiB，无法收录：{url}"
                            )
                    except ValueError:
                        pass
                raw = response.read(MAX_PAGE_BYTES + 1)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise KnowledgeError(f"抓取失败：{url}") from exc
        if len(raw) > MAX_PAGE_BYTES:
            raise KnowledgeError(
                f"页面超过 {MAX_PAGE_BYTES // (1024 * 1024)} MiB，无法收录：{url}"
            )
        if content_type and "text/html" not in content_type.lower():
            raise KnowledgeError(f"不是网页，无法收录：{url}")
        charset = "utf-8"
        match = re.search(
            r"charset=([A-Za-z0-9_-]+)", content_type, re.IGNORECASE
        )
        if match:
            charset = match.group(1)
        try:
            raw_html = raw.decode(charset, errors="replace")
        except (LookupError, UnicodeDecodeError):
            raw_html = raw.decode("utf-8", errors="replace")
        title, text = _extract_page_text(raw_html)
        if not text.strip():
            raise KnowledgeError(f"页面没有可收录的正文：{url}")
        return self.add_text(
            name, text, title or url, url
        )

    # -- retrieval ------------------------------------------------------
    def search(
        self, name: str, query: str, top_k: int = 5
    ) -> list[tuple[float, dict]]:
        notes = self._load_notes(name)
        query_tokens = _tokenize(query or "")
        if not notes or not query_tokens:
            return []
        doc_tokens = [_tokenize(note.get("text", "")) for note in notes]
        doc_len = [len(tokens) for tokens in doc_tokens]
        avg_len = sum(doc_len) / len(doc_len) or 1.0
        doc_count = len(notes)
        doc_freq: dict[str, int] = {}
        for tokens in doc_tokens:
            for token in set(tokens):
                doc_freq[token] = doc_freq.get(token, 0) + 1
        k1, b = 1.5, 0.75
        scored: list[tuple[float, dict]] = []
        for note, tokens, length in zip(notes, doc_tokens, doc_len):
            counts: dict[str, int] = {}
            for token in tokens:
                counts[token] = counts.get(token, 0) + 1
            score = 0.0
            for token in set(query_tokens):
                df = doc_freq.get(token, 0)
                if df == 0:
                    continue
                idf = math.log(1 + (doc_count - df + 0.5) / (df + 0.5))
                tf = counts.get(token, 0)
                score += (
                    idf
                    * tf
                    * (k1 + 1)
                    / (tf + k1 * (1 - b + b * length / avg_len))
                )
            if score > 0:
                scored.append((score, note))
        scored.sort(key=lambda item: item[0], reverse=True)
        return scored[: max(top_k, 0)]

    # -- question answering ----------------------------------------------
    def ask(
        self,
        name: str,
        question: str,
        chat_fn=None,
    ) -> tuple[str, list[dict]]:
        results = self.search(name, question, top_k=5)
        used = [note for _, note in results]
        if used:
            context = "\n\n".join(
                f"【{note.get('title', '')}】"
                f"（来源：{note.get('source', '')}，"
                f"日期：{note.get('date', '')}）\n{note.get('text', '')}"
                for note in used
            )
            user_content = (
                f"问题：{question}\n\n库内相关笔记：\n{context}"
            )
        else:
            user_content = (
                f"问题：{question}\n\n"
                "库内没有与该问题相关的笔记。"
            )
        messages = [
            {"role": "system", "content": ASK_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ]
        if chat_fn is None:
            chat_fn = _default_chat_fn
        answer = chat_fn(messages)
        if not isinstance(answer, str):
            answer = str(answer)
        return answer, used


def _default_chat_fn(messages: list[dict]) -> str:
    """Ask the configured default provider (lazy imports only)."""
    from nyra.config import load_config, resolve_provider
    from nyra.providers import Provider

    config = load_config()
    provider = Provider(
        resolve_provider(config.get("provider"), config.get("model"))
    )
    resp = provider.chat(messages)
    try:
        return resp["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise KnowledgeError("模型返回了无法解析的回答") from exc


# -- CLI ---------------------------------------------------------------


def _kb_or_error(store: KnowledgeBase, name: str) -> None:
    if not store.exists(name):
        raise KnowledgeError(f"知识库不存在：{name}")


def main(argv=None, base=None, chat_fn=None) -> int:
    parser = argparse.ArgumentParser(
        prog="nyra.knowledge", description="Nyra 本地 AI 知识库"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    create_p = sub.add_parser("create", help="新建知识库")
    create_p.add_argument("name")
    create_p.add_argument("--description", default="")

    sub.add_parser("list", help="列出知识库")

    add_p = sub.add_parser("add", help="收录内容进知识库")
    add_p.add_argument("name")
    group = add_p.add_mutually_exclusive_group(required=True)
    group.add_argument("--file")
    group.add_argument("--dir")
    group.add_argument("--text")
    group.add_argument("--url")
    add_p.add_argument("--title", default=None)

    search_p = sub.add_parser("search", help="检索笔记")
    search_p.add_argument("name")
    search_p.add_argument("query")
    search_p.add_argument("--top-k", type=int, default=5)

    ask_p = sub.add_parser("ask", help="基于库内笔记提问")
    ask_p.add_argument("name")
    ask_p.add_argument("question")

    remove_p = sub.add_parser("remove", help="删除知识库")
    remove_p.add_argument("name")
    remove_p.add_argument("--yes", action="store_true")

    args = parser.parse_args(argv)
    store = KnowledgeBase(base)
    try:
        if args.command == "create":
            meta = store.create(args.name, args.description)
            print(f"已创建知识库：{meta['name']}")
        elif args.command == "list":
            bases = store.list_bases()
            if not bases:
                print("还没有知识库，用 `create <名>` 新建一个。")
            for item in bases:
                print(
                    f"{item['name']}\t{item.get('notes', 0)} 条笔记"
                    + (f"\t{item['description']}" if item.get("description") else "")
                )
        elif args.command == "add":
            _kb_or_error(store, args.name)
            if args.file is not None:
                added = store.add_file(args.name, args.file)
            elif args.dir is not None:
                added = store.add_dir(args.name, args.dir)
            elif args.text is not None:
                added = store.add_text(
                    args.name,
                    args.text,
                    args.title or "手动输入",
                    "手动输入",
                )
            else:
                added = store.add_url(args.name, args.url)
            print(f"已收录 {len(added)} 条笔记进 {args.name}")
        elif args.command == "search":
            _kb_or_error(store, args.name)
            results = store.search(args.name, args.query, top_k=args.top_k)
            if not results:
                print("没有找到相关笔记。")
            for score, note in results:
                print(
                    f"{score:.2f}\t{note.get('title', '')}"
                    f"\t来源：{note.get('source', '')}"
                    f"\t日期：{note.get('date', '')}"
                )
        elif args.command == "ask":
            _kb_or_error(store, args.name)
            answer, used = store.ask(args.name, args.question, chat_fn=chat_fn)
            print(answer)
            if used:
                print("\n依据笔记：")
                for note in used:
                    print(f"- {note.get('title', '')}")
            else:
                print("\n（库内没有相关笔记）")
        elif args.command == "remove":
            _kb_or_error(store, args.name)
            if not args.yes:
                confirm = input(
                    f"确定删除知识库 {args.name} 吗？输入 yes 确认："
                ).strip()
                if confirm.lower() != "yes":
                    print("已取消。")
                    return 1
            store.remove(args.name)
            print(f"已删除知识库：{args.name}")
    except KnowledgeError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
