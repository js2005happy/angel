"""Read-only, conservative diagnosis of persisted Angel session transcripts.

This does NOT claim a task completed or replay tools. The transcript is a
conversation log, not an execution journal; missing tool results or terminal
answers mean human review is needed before any retry.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
from pathlib import Path
import re
import sys

from .config import ANGEL_HOME

_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
MAX_SESSION_BYTES = 8 * 1024 * 1024
MAX_MESSAGES = 20000


class SessionDiagnosisError(ValueError):
    """Unsafe session path or transcript not suitable for inspection."""


def inspect_session(session_id: str, *, root: Path | None = None) -> dict:
    """Inspect metadata only: never expose prompts, tool arguments or results."""
    if not isinstance(session_id, str) or not _SESSION_ID.fullmatch(session_id):
        raise SessionDiagnosisError("会话 ID 格式无效")
    base = Path(root) if root is not None else ANGEL_HOME / "sessions"
    # Refuse symlinked ancestors as well as the final session file.
    current = base
    while current != current.parent:
        if current.is_symlink():
            raise SessionDiagnosisError("会话路径不能包含符号链接")
        current = current.parent
    path = base / (session_id + ".jsonl")
    if path.is_symlink():
        raise SessionDiagnosisError("会话文件不能是符号链接")
    if not path.is_file():
        raise SessionDiagnosisError("会话文件不存在或不是普通文件")
    if path.stat().st_size > MAX_SESSION_BYTES:
        raise SessionDiagnosisError("会话文件超过 8 MiB，只读检查已拒绝")

    count = 0
    last_role = None
    pending: set[str] = set()
    seen_calls: set[str] = set()
    total_bytes = 0
    last_assistant_final = False
    structural_ambiguity = False
    tool_calls = 0
    tool_responses = 0
    user_messages = 0
    assistant_final_messages = 0
    try:
        # O_NOFOLLOW (when available) closes the final-component symlink
        # race between path inspection and opening. Never follow aliases.
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(path, flags)
        with os.fdopen(fd, "rb") as handle:
            metadata = os.fstat(handle.fileno())
            if not stat.S_ISREG(metadata.st_mode):
                raise SessionDiagnosisError("会话不是普通文件")
            if metadata.st_size > MAX_SESSION_BYTES:
                raise SessionDiagnosisError("会话文件超过 8 MiB，只读检查已拒绝")
            for raw in handle:
                total_bytes += len(raw)
                if total_bytes > MAX_SESSION_BYTES:
                    raise SessionDiagnosisError("读取过程中会话超过 8 MiB")
                count += 1
                if count > MAX_MESSAGES:
                    raise SessionDiagnosisError("会话超过 20000 条记录")
                if len(raw) > MAX_SESSION_BYTES:
                    raise SessionDiagnosisError("会话包含过大记录")
                try:
                    msg = json.loads(raw.decode("utf-8"))
                except (UnicodeError, ValueError) as exc:
                    raise SessionDiagnosisError(
                        "会话包含损坏记录，不能可靠判断进度"
                    ) from exc
                if not isinstance(msg, dict):
                    raise SessionDiagnosisError("会话包含非消息对象")
                role = msg.get("role")
                if role not in ("user", "assistant", "tool", "system"):
                    raise SessionDiagnosisError("会话包含未知消息角色")
                # Any message following a final assistant response means
                # that response is no longer a terminal completion marker.
                last_assistant_final = False
                if role == "user":
                    user_messages += 1
                if role == "assistant" and pending:
                    structural_ambiguity = True
                last_role = role
                if role == "assistant":
                    calls = msg.get("tool_calls", [])
                    if not isinstance(calls, list):
                        raise SessionDiagnosisError("tool_calls 格式错误")
                    if calls:
                        for call in calls:
                            if not isinstance(call, dict) or not isinstance(call.get("id"), str):
                                raise SessionDiagnosisError("工具调用缺少 ID")
                            identifier = call["id"]
                            if not identifier or identifier in seen_calls:
                                raise SessionDiagnosisError("重复或空工具调用 ID")
                            seen_calls.add(identifier)
                            pending.add(identifier)
                            tool_calls += 1
                    elif isinstance(msg.get("content"), str) and msg["content"].strip():
                        assistant_final_messages += 1
                        last_assistant_final = True
                if role == "tool":
                    identifier = msg.get("tool_call_id")
                    if not isinstance(identifier, str) or identifier not in pending:
                        raise SessionDiagnosisError("工具结果缺少匹配的调用 ID")
                    pending.remove(identifier)
                    tool_responses += 1
    except OSError as exc:
        raise SessionDiagnosisError("无法读取会话") from exc

    # A final assistant message is only a conversational marker, never proof
    # that an external side effect happened or its verification passed.
    needs_review = (
        count == 0 or user_messages == 0 or bool(pending)
        or structural_ambiguity or not last_assistant_final
    )
    return {
        "session_id": session_id,
        "source": "local_session_jsonl",
        "message_count": count,
        "user_messages": user_messages,
        "tool_calls": tool_calls,
        "tool_responses": tool_responses,
        "unmatched_tool_calls": len(pending),
        "ambiguous_tool_sequence": structural_ambiguity,
        "assistant_text_messages": assistant_final_messages,
        "last_role": last_role,
        "state": "needs_review" if needs_review else "conversation_ended",
        "execution_verified": False,
        "safe_to_auto_resume": False,
        "reason": (
            "会话为空、缺少明确最终回复或工具链存在歧义；不得自动重试副作用"
            if needs_review else
            "只确认会话有助手末尾消息，无法据此证明任务或外部副作用完成"
        ),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="angel session-status",
        description="只读检查会话是否需要人工核对；不恢复执行，不调用模型",
    )
    parser.add_argument("session_id", help="本地会话 ID，不是文件路径")
    args = parser.parse_args(argv)
    try:
        result = inspect_session(args.session_id)
    except SessionDiagnosisError as exc:
        print("会话检查失败：" + str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0
