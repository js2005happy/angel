"""Nyra 的会话压缩：把长会话总结成要点摘要，只保留摘要和最近几条消息。

会话消息存在 ~/.nyra/sessions/<id>.jsonl（每行一条 JSON）。
压缩时调用模型做摘要；模型不可用时本地回退为保留首尾消息，绝不编造内容。
"""

import json
from pathlib import Path
from typing import Callable


COMPACT_SYSTEM_INSTRUCTION = (
    "你是会话压缩助手。把以下对话压缩成一份要点摘要（中文，不超过 800 字），"
    "保留：关键事实、已做的决定、已完成的工作、待办事项、涉及的重要文件路径和命令及其结果。"
    "不要编造对话中没有的内容，不要写客套话。"
    "只输出摘要本身，不要加标题以外的多余格式。"
)


def _aligned_tail(messages: list[dict], keep_last: int) -> list[dict]:
    """Return the last ``keep_last`` messages, aligned to a turn boundary.

    A suffix that starts with a ``tool`` message (its assistant call was
    cut off) or ends with an assistant ``tool_calls`` whose results are
    not all retained is rejected by OpenAI-compatible APIs as orphaned
    tool messages, so: back up to the assistant that issued leading
    tool results, and drop a trailing incomplete tool exchange.
    """
    if keep_last <= 0 or not messages:
        return []
    start = max(0, len(messages) - keep_last)
    tail = list(messages[start:])
    while tail and tail[0].get("role") == "tool":
        prev = messages[start - 1] if start > 0 else None
        if (
            isinstance(prev, dict)
            and prev.get("role") == "assistant"
            and prev.get("tool_calls")
        ):
            tail.insert(0, prev)
            start -= 1
        else:
            tail.pop(0)
            start += 1
    while tail:
        idx = next(
            (
                i
                for i in range(len(tail) - 1, -1, -1)
                if tail[i].get("role") == "assistant" and tail[i].get("tool_calls")
            ),
            None,
        )
        if idx is None:
            break
        if any(
            m.get("role") == "assistant" and not m.get("tool_calls")
            for m in tail[idx + 1:]
        ):
            break  # A later plain answer closes the exchange.
        call_ids = {
            c.get("id", "")
            for c in tail[idx].get("tool_calls") or []
            if isinstance(c, dict)
        }
        result_ids = {
            m.get("tool_call_id")
            for m in tail[idx + 1:]
            if m.get("role") == "tool"
        }
        if call_ids and call_ids <= result_ids:
            break
        del tail[idx:]
    return tail


def build_compact_messages(
    messages: list[dict], summary: str, keep_last: int = 4
) -> list[dict]:
    new_messages = [
        {"role": "user", "content": "[此前会话摘要]\n" + summary},
        {"role": "assistant", "content": "已压缩会话，继续。"},
    ]
    if keep_last > 0:
        new_messages.extend(_aligned_tail(messages, keep_last))
    return new_messages


def summarize_with_provider(
    provider, messages: list[dict], on_response: Callable[[dict], None] | None = None
) -> str:
    request_messages = [
        {"role": "system", "content": COMPACT_SYSTEM_INSTRUCTION},
        *messages,
        {"role": "user", "content": "请按以上要求压缩这段对话。"},
    ]
    response = provider.chat(request_messages, tools=None, timeout=120)
    if on_response is not None:
        on_response(response)
    choices = response.get("choices") if isinstance(response, dict) else None
    if not isinstance(choices, list) or not choices:
        raise ValueError("模型返回了无法解析的响应（缺少 choices）")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    summary = (content or "").strip()
    if not summary:
        raise ValueError("模型返回了空摘要")
    return summary


def compact_messages(
    provider, messages: list[dict], keep_last: int = 4, *,
    strict: bool = False,
    on_response: Callable[[dict], None] | None = None,
) -> tuple[list[dict], dict]:
    before = len(messages)
    if not messages:
        return [], {
            "method": "none",
            "summary_chars": 0,
            "before": 0,
            "after": 0,
        }

    try:
        summary = summarize_with_provider(provider, messages, on_response=on_response)
    except Exception:
        if strict:
            # Automatic compaction must never discard history if its
            # summarization call fails. Manual compaction retains its fallback.
            raise
        fallback_messages = [
            {
                "role": "user",
                "content": "[压缩失败：模型摘要不可用，仅保留首尾消息]",
            }
        ]
        tail = _aligned_tail(messages, keep_last)

        # 首条用户消息若已包含在末尾消息中，就不重复添加。
        for message in messages:
            if message.get("role") == "user":
                if not any(kept is message for kept in tail):
                    fallback_messages.append(message)
                break

        fallback_messages.extend(tail)

        return fallback_messages, {
            "method": "fallback",
            "summary_chars": 0,
            "before": before,
            "after": len(fallback_messages),
        }

    new_messages = build_compact_messages(messages, summary, keep_last)
    return new_messages, {
        "method": "model",
        "summary_chars": len(summary),
        "before": before,
        "after": len(new_messages),
    }


def compact_session_file(
    session_id: str,
    provider,
    keep_last: int = 4,
    sessions_dir: Path | None = None,
) -> dict:
    if sessions_dir is None:
        from .config import NYRA_HOME

        sessions_dir = NYRA_HOME / "sessions"

    path = sessions_dir / f"{session_id}.jsonl"
    messages = []

    try:
        with path.open("r", encoding="utf-8") as session_file:
            for line in session_file:
                if not line.strip():
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(message, dict):
                    messages.append(message)
    except FileNotFoundError:
        raise FileNotFoundError(f"找不到会话：{session_id}") from None

    new_messages, info = compact_messages(provider, messages, keep_last)

    # 原子替换：先写同目录临时文件再 os.replace，写一半崩溃也不会
    # 截断原会话文件（旧代码 open("w") 会先截断，写失败即丢会话）。
    import os
    import tempfile

    payload = "".join(
        json.dumps(message, ensure_ascii=False) + "\n" for message in new_messages
    )
    fd, temp = tempfile.mkstemp(prefix=".nyra-compact-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as session_file:
            session_file.write(payload)
            session_file.flush()
            os.fsync(session_file.fileno())
        if os.name != "nt":
            try:
                os.chmod(temp, 0o600)
            except OSError:
                pass
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)

    info["session_id"] = session_id
    info["path"] = str(path)
    return info


DEFAULT_AUTO_COMPACT_THRESHOLD = 0.80
MIN_AUTO_COMPACT_MESSAGES = 5


def validate_auto_compact_threshold(value: float) -> float:
    """Accept conservative fractions; reject accidental 80 or boolean values."""
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not 0.5 <= value <= 0.95
    ):
        raise ValueError("自动压缩阈值必须在 0.50 到 0.95 之间")
    return float(value)


def should_auto_compact(
    usage: dict, message_count: int, threshold: float = DEFAULT_AUTO_COMPACT_THRESHOLD
) -> bool:
    """Trigger only with *reported* input tokens and an explicit context limit."""
    validate_auto_compact_threshold(threshold)
    last = usage.get("last_prompt_tokens")
    window = usage.get("context_window_tokens")
    if (
        isinstance(last, bool) or not isinstance(last, int)
        or isinstance(window, bool) or not isinstance(window, int)
        or last < 0 or window <= 0 or message_count < MIN_AUTO_COMPACT_MESSAGES
    ):
        return False
    return last / window >= threshold
