"""Nyra 记忆模式：与其他 agent 交换记忆。

照 Muse 的记忆导入模式做，有两种读法：

1. 快照导入/导出：把一段提示词贴到别的 AI 聊天里，让对方按固定格式
   输出一份关于用户的便携式记忆快照（Markdown），再粘贴回来导入；
   也可以把 Nyra 自己的记忆导出成快照给别的 AI。
2. 聊天导入：从 ChatGPT / Claude 导出的聊天 .zip 里取对话清单，
   原文存档，MEMORY.md 只记一行导入记录，不自动提炼事实。

另外两种本地读法（只读）：
- 配对读记忆：配对成功后读另一台 Nyra 的记忆快照（GET /memory，
  须 Bearer token，只读、只传脱敏后的快照，绝不传凭据）。
- 本地读记忆：读本机 Codex（~/.codex/memories_1.sqlite）或 Claude
  （~/.claude/CLAUDE.md 等）的记忆文件，或指定目录下的记忆文件。

安全硬规则：
- 导出与导入两端都要过 scrub_secrets：含凭据的行直接删掉并计数。
- 导入只追加不覆盖：已存在的内容（不区分大小写子串判断）跳过。
- 配对只在可信网络用，配对码与 token 明文传输，规则见 pairing.py。
- 不做自动事实提炼：那需要模型调用，会编造；提炼以后用知识库的 ask 做。

用法：
    python3 -m nyra.memory_exchange export            # 导出自己的记忆快照
    python3 -m nyra.memory_exchange export-prompt    # 打印提示词，贴到别的 AI 聊天里
    python3 -m nyra.memory_exchange import [FILE]    # 导入快照（不给文件就读 stdin）
    python3 -m nyra.memory_exchange peer CODE [HOST PORT]  # 配对后读对方记忆并导入
    python3 -m nyra.memory_exchange local codex|claude|dir [PATH]
    python3 -m nyra.memory_exchange import-zip FILE.zip
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
import urllib.parse
import zipfile
from datetime import datetime
from pathlib import Path

from .config import NYRA_HOME
from .memory import MEMORY_PATH, append_memory
from .pairing import PairingClient, PairingError

SNAPSHOT_SECTIONS = ("身份", "事实", "偏好", "目标与承诺", "关系")

# 章节标题别名（小写包含匹配）：别的 agent 的快照/记忆文件可能用
# 英文标题或近义标题，统一归一到上面五个章节；认不出的归入“事实”。
_SECTION_ALIASES = {
    "身份": ("身份", "identity", "关于我", "who", "基本信息"),
    "事实": ("事实", "fact", "背景"),
    "偏好": ("偏好", "preference", "喜好", "习惯"),
    "目标与承诺": ("目标", "承诺", "commitment", "goal", "计划"),
    "关系": ("关系", "people", "relationship", "联系人", "家人", "朋友"),
}

# 只剩占位符的内容：解析时直接丢掉，不算有效内容。
_PLACEHOLDER_RES = (
    re.compile(r"^(暂无|无可靠信息|待补充|占位|不详|未知|n/a|none|—|–|-)\s*[。；;,.]?$", re.IGNORECASE),
)

# 凭据行模式：含赋值号的凭据键、Bearer、已知的 token 前缀、私钥头。
# 只认“键 + 赋值号”或明确的 token 格式， prose 里提到 token 一词
# （如“token 统计”）不会被误删。
_SECRET_RES = (
    re.compile(r"(api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret)\s*[:=：]", re.IGNORECASE),
    re.compile(r"(password|passwd|pwd)\s*[:=：]", re.IGNORECASE),
    re.compile(r"\bbearer\s+[A-Za-z0-9._\-]{8,}", re.IGNORECASE),
    re.compile(r"\btoken\s*[:=：]\s*\S", re.IGNORECASE),
    re.compile(r"(authorization|auth[_-]?token)\s*[:=：]", re.IGNORECASE),
    re.compile(r"(cookie|set-cookie)\s*[:=：]", re.IGNORECASE),
    re.compile(r"(credential|credentials)\s*[:=：]", re.IGNORECASE),
    re.compile(r"private[_-]?key\s*[:=：]", re.IGNORECASE),
    re.compile(r"-----begin (?:rsa |ec |openssh )?private key-----", re.IGNORECASE),
    re.compile(r"sk-[A-Za-z0-9_-]{8,}"),
    re.compile(r"\bgh[opsu]_[A-Za-z0-9]{10,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
)


class SnapshotError(Exception):
    pass


class LocalMemoryNotFound(Exception):
    pass


class ChatZipError(Exception):
    pass


def scrub_secrets(text: str) -> tuple[str, int]:
    """删掉含凭据的行，返回（清理后的文本，删掉的行数）。"""
    kept: list[str] = []
    removed = 0
    for line in text.splitlines():
        if any(pattern.search(line) for pattern in _SECRET_RES):
            removed += 1
            continue
        kept.append(line)
    return "\n".join(kept).strip(), removed


def _is_placeholder(bullet: str) -> bool:
    text = bullet.strip().strip("。；;,.").strip()
    return not text or any(pattern.match(text) for pattern in _PLACEHOLDER_RES)


def _canonical_section(heading: str) -> str | None:
    text = heading.strip().lower()
    for canonical, aliases in _SECTION_ALIASES.items():
        if any(alias in text for alias in aliases):
            return canonical
    return None


def _parse_markdown_sections(text: str) -> dict[str, list[str]]:
    """把 Markdown 按 ## 标题分章节；无标题的内容归入“事实”。

    要点行以 - / * / • / 数字编号开头；普通非空行也当一条要点收
    （记忆文件里很多事实就是 plain 行）。围栏代码块跳过，占位符丢掉。
    """
    sections: dict[str, list[str]] = {}
    current = "事实"
    in_fence = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        heading = re.match(r"^#{1,3}\s+(.*)$", line)
        if heading:
            current = _canonical_section(heading.group(1)) or "事实"
            sections.setdefault(current, [])
            continue
        bullet_match = re.match(r"^(?:[-*•]\s+|\d+[.)]\s+)(.*)$", line)
        bullet = bullet_match.group(1).strip() if bullet_match else line
        if _is_placeholder(bullet):
            continue
        sections.setdefault(current, []).append(bullet)
    return {name: items for name, items in sections.items() if items}


def _export(memory_path: Path) -> tuple[str, int]:
    if not memory_path.exists():
        raise SnapshotError(f"记忆为空：{memory_path} 不存在，先写几条记忆再导出")
    raw = memory_path.read_text(encoding="utf-8", errors="replace")
    cleaned, removed = scrub_secrets(raw)
    sections = _parse_markdown_sections(cleaned)
    if not sections:
        raise SnapshotError("记忆脱敏后没有剩余内容，无法导出快照")
    blocks = []
    for name in SNAPSHOT_SECTIONS:
        items = sections.get(name)
        if not items:
            continue
        blocks.append("## " + name + "\n" + "\n".join(f"- {item}" for item in items))
    return "\n\n".join(blocks), removed


def export_snapshot(memory_path: Path | str | None = None) -> str:
    """把 Nyra 自己的记忆渲染成快照（固定五章，无可靠信息的章节省略）。"""
    path = Path(memory_path) if memory_path is not None else MEMORY_PATH
    text, _removed = _export(path)
    return text


def export_snapshot_report(memory_path: Path | str | None = None) -> dict:
    """导出快照并报告脱敏删掉的行数（配对宿主 /memory 用）。"""
    path = Path(memory_path) if memory_path is not None else MEMORY_PATH
    text, removed = _export(path)
    return {"snapshot": text, "scrubbed": removed}


def export_prompt() -> str:
    """打印提示词：用户贴到别的 AI 聊天里，让对方按快照格式输出。"""
    sections = "\n".join(f"  ## {name}" for name in SNAPSHOT_SECTIONS)
    return (
        "你正在帮助我将背景信息从一个 AI 助手迁移到另一个 AI 助手。\n"
        "你的任务是基于我们过往的对话，整理一份关于我的便携式记忆快照，"
        "仅收录你确切掌握的信息。输出的内容将逐字输入到新 AI 的记忆中，"
        "因此质量比完整性更重要。\n\n"
        "输出规则：\n"
        "- 只输出一个 Markdown 区块，使用以下章节标题（按顺序）：\n"
        f"{sections}\n"
        "- 每个章节下用 \"- \" 列出要点，每条用第三人称写。\n"
        "- 只写你确切知道的信息；不确定的不要写。\n"
        "- 没有可靠信息的章节整个省略，不要留空章节。\n"
        "- 切勿编造占位符，不要写“暂无”“待补充”“未知”之类的内容。\n"
        "- 不要在快照里写任何密码、密钥、token 或其他凭据。\n"
    )


def parse_snapshot(text: str) -> dict[str, list[str]]:
    """解析快照文本；空快照或只剩占位符的拒绝。

    本身不脱敏：调用方（导入/导出/配对/本地）先过 scrub_secrets。
    """
    sections = _parse_markdown_sections(text)
    total = sum(len(items) for items in sections.values())
    if total == 0:
        raise SnapshotError("快照为空：没有可用的内容（可能是空文本，或只剩占位符）")
    ordered = {}
    for name in SNAPSHOT_SECTIONS:
        if sections.get(name):
            ordered[name] = sections[name]
    return ordered


def import_snapshot(
    text: str, memory_path: Path | str | None = None
) -> dict:
    """去重合并快照进 MEMORY.md：只追加不覆盖。

    先脱敏，再解析；已存在的内容（不区分大小写子串判断）跳过。
    返回 {"added": n, "skipped": n, "scrubbed": n, "sections": [...]}。
    """
    cleaned, scrubbed = scrub_secrets(text)
    sections = parse_snapshot(cleaned)
    path = Path(memory_path) if memory_path is not None else MEMORY_PATH
    existing = (
        path.read_text(encoding="utf-8", errors="replace").lower()
        if path.exists()
        else ""
    )
    added = skipped = 0
    seen: set[str] = set()
    for name in SNAPSHOT_SECTIONS:
        for bullet in sections.get(name, []):
            norm = bullet.strip().lower()
            if not norm or norm in seen:
                skipped += 1
                continue
            seen.add(norm)
            if norm in existing:
                skipped += 1
                continue
            append_memory(f"[{name}] {bullet}", path=path)
            existing += "\n" + norm
            added += 1
    return {
        "added": added,
        "skipped": skipped,
        "scrubbed": scrubbed,
        "sections": [name for name in SNAPSHOT_SECTIONS if sections.get(name)],
    }


def _read_codex_sqlite(db: Path) -> dict:
    """只读打开 Codex 记忆库，取记忆文本。

    本机 Codex 版本没有 memories 表，记忆在 stage1_outputs.raw_memory
    里；两种表结构都支持，哪种有内容读哪种，都没有就报未找到。
    """
    uri = "file:" + urllib.parse.quote(str(db)) + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as exc:
        raise LocalMemoryNotFound(f"打不开 Codex 记忆库：{exc}") from exc
    try:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        texts: list[str] = []
        if "memories" in tables:
            cols = [
                row[1] for row in conn.execute("PRAGMA table_info(memories)")
            ]
            text_col = next(
                (
                    col
                    for col in cols
                    if col.lower()
                    in ("content", "memory", "text", "raw_memory", "summary", "note")
                ),
                None,
            )
            if text_col is None:
                text_col = next(
                    (
                        col
                        for col in cols
                        if col.lower()
                        not in ("id", "created_at", "updated_at", "thread_id")
                    ),
                    None,
                )
            if text_col is not None:
                rows = conn.execute(
                    f'SELECT "{text_col}" FROM memories'
                ).fetchall()
                texts = [
                    str(row[0]).strip()
                    for row in rows
                    if row[0] and str(row[0]).strip()
                ]
        if not texts and "stage1_outputs" in tables:
            cols = [
                row[1]
                for row in conn.execute("PRAGMA table_info(stage1_outputs)")
            ]
            for col in ("raw_memory", "rollout_summary"):
                if col not in cols:
                    continue
                rows = conn.execute(
                    f'SELECT "{col}" FROM stage1_outputs '
                    f'WHERE "{col}" IS NOT NULL AND "{col}" != ""'
                ).fetchall()
                texts = [
                    str(row[0]).strip()
                    for row in rows
                    if row[0] and str(row[0]).strip()
                ]
                if texts:
                    break
        if not texts:
            raise LocalMemoryNotFound(f"Codex 记忆库里没有内容：{db}")
        return {
            "source": "codex",
            "kind": "sqlite",
            "text": "\n".join(texts),
            "count": len(texts),
        }
    finally:
        conn.close()


def _read_markdown_files(files: list[Path], source: str) -> dict:
    found = []
    for path in files:
        if path.exists():
            found.append((path, path.read_text(encoding="utf-8", errors="replace")))
    if not found:
        raise LocalMemoryNotFound(
            "未找到记忆文件：" + "、".join(str(path) for path in files)
        )
    text = "\n\n".join(content for _path, content in found)
    return {"source": source, "kind": "markdown", "text": text, "count": len(found)}


def read_local_agent_memory(
    source: str, path: Path | str | None = None, home: Path | str | None = None
) -> dict:
    """只读读取别的 agent 在本机的记忆，返回 {"source","kind","text","count"}。

    source: "codex" | "claude" | "dir"。找不到文件或库里没有内容时
    抛 LocalMemoryNotFound；读到的内容由调用方走 import_snapshot 合并。
    """
    base = Path(home) if home is not None else Path.home()
    if source == "codex":
        db = base / ".codex" / "memories_1.sqlite"
        if not db.exists():
            raise LocalMemoryNotFound(f"未找到 Codex 记忆库：{db}")
        return _read_codex_sqlite(db)
    if source == "claude":
        return _read_markdown_files(
            [base / ".claude" / "CLAUDE.md", base / ".claude" / "MEMORY.md"],
            "claude",
        )
    if source == "dir":
        if path is None:
            raise ValueError("dir 来源需要给目录路径")
        folder = Path(path)
        return _read_markdown_files(
            [folder / "MEMORY.md", folder / "AGENTS.md", folder / "CLAUDE.md"],
            "dir",
        )
    raise ValueError(f"未知来源：{source}（可选 codex / claude / dir）")


def fetch_peer_memory(
    host: str, port: int, token: str, timeout: float = 5.0
) -> tuple[str, int]:
    """读已配对 Nyra 宿主的记忆快照（GET /memory，Bearer token）。

    宿主已脱敏过一次，这里再脱敏一次做纵深防御。返回（快照文本，删掉的行数）。
    """
    client = PairingClient(timeout=timeout)
    client.host, client.port, client.token = host, port, token
    snapshot = client.read_peer_memory()
    return scrub_secrets(snapshot)


def _summarize_chatgpt(conv: dict) -> dict:
    title = conv.get("title") or "未命名"
    created = conv.get("create_time")
    date = (
        datetime.fromtimestamp(created).strftime("%Y-%m-%d")
        if isinstance(created, (int, float))
        else "未知日期"
    )
    mapping = conv.get("mapping") or {}
    count = 0
    for node in mapping.values():
        message = node.get("message") if isinstance(node, dict) else None
        if not isinstance(message, dict):
            continue
        author = message.get("author") or {}
        if author.get("role") not in ("user", "assistant"):
            continue
        content = message.get("content") or {}
        parts = content.get("parts") or []
        if any(isinstance(part, str) and part.strip() for part in parts):
            count += 1
    return {"title": title, "date": date, "messages": count}


def _summarize_claude(conv: dict) -> dict:
    title = conv.get("name") or "未命名"
    created = conv.get("created_at") or ""
    date = created[:10] if isinstance(created, str) and created else "未知日期"
    messages = conv.get("chat_messages") or []
    return {"title": title, "date": date, "messages": len(messages)}


def import_chat_zip(
    path: Path | str,
    memory_path: Path | str | None = None,
    home: Path | str | None = None,
) -> dict:
    """导入 ChatGPT / Claude 的聊天导出 .zip。

    只做清单与存档：解析 conversations.json 里的对话（标题、日期、
    消息数），原文存到 NYRA_HOME/memory-imports/<日期>-<来源>/，
    MEMORY.md 里只追加一行导入记录。不做自动事实提炼（那需要模型
    调用，会编造），提炼以后用知识库的 ask 做。
    """
    zip_path = Path(path)
    if not zip_path.exists():
        raise ChatZipError(f"找不到文件：{zip_path}")
    try:
        archive = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as exc:
        raise ChatZipError(f"不是有效的 .zip：{exc}") from exc
    with archive:
        names = archive.namelist()
        conv_name = next(
            (name for name in names if name.rsplit("/", 1)[-1] == "conversations.json"),
            None,
        )
        if conv_name is None:
            raise ChatZipError(
                "zip 里没有 conversations.json（只支持 ChatGPT / Claude 的聊天导出）"
            )
        raw = archive.read(conv_name)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ChatZipError(f"conversations.json 解析失败：{exc}") from exc
    if not isinstance(data, list) or not data:
        raise ChatZipError("conversations.json 里没有对话")
    first = data[0]
    if isinstance(first, dict) and "mapping" in first:
        source = "chatgpt"
        summaries = [_summarize_chatgpt(conv) for conv in data]
    elif isinstance(first, dict) and "chat_messages" in first:
        source = "claude"
        summaries = [_summarize_claude(conv) for conv in data]
    else:
        raise ChatZipError(
            "无法识别的 conversations.json 格式（既不是 ChatGPT 也不是 Claude 的导出）"
        )
    dest_home = Path(home) if home is not None else NYRA_HOME
    dest = dest_home / "memory-imports" / f"{datetime.now():%Y-%m-%d}-{source}"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "conversations.json").write_bytes(raw)
    total_messages = sum(item["messages"] for item in summaries)
    mem_path = Path(memory_path) if memory_path is not None else MEMORY_PATH
    append_memory(
        f"导入聊天记录：{source}，{len(summaries)} 个对话、{total_messages} 条消息，"
        f"原文在 {dest}",
        path=mem_path,
    )
    return {
        "source": source,
        "conversations": len(summaries),
        "messages": total_messages,
        "dir": str(dest),
        "titles": [item["title"] for item in summaries],
    }


def _print_import_report(report: dict) -> None:
    print(
        f"导入完成：新增 {report['added']} 条，跳过 {report['skipped']} 条"
        f"（已存在），脱敏删掉 {report['scrubbed']} 行；"
        f"涉及章节：{'、'.join(report['sections'])}"
    )


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    usage = (
        "用法：python3 -m nyra.memory_exchange "
        "export | export-prompt | import [FILE] | peer CODE [HOST PORT] | "
        "local codex|claude|dir [PATH] | import-zip FILE.zip"
    )
    if not args:
        print(usage, file=sys.stderr)
        return 2
    cmd = args[0]
    try:
        if cmd == "export":
            print(export_snapshot())
            return 0
        if cmd == "export-prompt":
            print(export_prompt())
            return 0
        if cmd == "import":
            if len(args) > 1:
                text = Path(args[1]).read_text(encoding="utf-8", errors="replace")
            else:
                text = sys.stdin.read()
            _print_import_report(import_snapshot(text))
            return 0
        if cmd == "peer":
            if len(args) < 2:
                print("用法：python3 -m nyra.memory_exchange peer CODE [HOST PORT]", file=sys.stderr)
                return 2
            code = args[1]
            client = PairingClient()
            if len(args) >= 4:
                host, port = args[2], int(args[3])
                client.pair(host, port, code)
            else:
                found = client.discover(code)
                if found is None:
                    print("未发现宿主（配对码可能不对，或不在同一网络）。", file=sys.stderr)
                    return 1
                client.pair(found[0], found[1], code)
            snapshot, removed = fetch_peer_memory(client.host, client.port, client.token)
            print(f"读到对方记忆快照（脱敏删掉 {removed} 行）：")
            print(snapshot)
            _print_import_report(import_snapshot(snapshot))
            return 0
        if cmd == "local":
            if len(args) < 2:
                print("用法：python3 -m nyra.memory_exchange local codex|claude|dir [PATH]", file=sys.stderr)
                return 2
            source = args[1]
            result = read_local_agent_memory(
                source, path=args[2] if len(args) > 2 else None
            )
            print(f"来源：{result['source']}（{result['kind']}，{result['count']} 条/份）：")
            print(result["text"])
            _print_import_report(import_snapshot(result["text"]))
            return 0
        if cmd == "import-zip":
            if len(args) < 2:
                print("用法：python3 -m nyra.memory_exchange import-zip FILE.zip", file=sys.stderr)
                return 2
            report = import_chat_zip(args[1])
            print(
                f"导入聊天记录：{report['source']}，{report['conversations']} 个对话、"
                f"{report['messages']} 条消息，原文在 {report['dir']}"
            )
            return 0
    except (SnapshotError, LocalMemoryNotFound, ChatZipError, PairingError) as exc:
        print(f"失败：{exc}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as exc:
        print(f"失败：{exc}", file=sys.stderr)
        return 1
    print(usage, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
