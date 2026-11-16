"""Track provider-reported token usage without inventing unavailable data.

OpenAI-compatible providers may omit usage entirely. Only reported counters
are totaled; context windows are user supplied, never guessed from model names.
"""

from dataclasses import dataclass
from typing import Any


def context_limit(value: Any) -> int | None:
    """Return a positive configured window, never a guessed default."""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def _count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


@dataclass
class UsageTracker:
    configured_window: int | None = None
    calls: int = 0
    reported_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    prompt_samples: int = 0
    completion_samples: int = 0
    total_samples: int = 0
    last_prompt_tokens: int | None = None

    def record(self, response: Any) -> None:
        """Record the actual provider response, never a tokenizer approximation."""
        self.calls += 1
        usage = response.get("usage") if isinstance(response, dict) else None
        if not isinstance(usage, dict):
            return
        prompt = _count(usage.get("prompt_tokens"))
        if prompt is None:
            prompt = _count(usage.get("input_tokens"))
        completion = _count(usage.get("completion_tokens"))
        if completion is None:
            completion = _count(usage.get("output_tokens"))
        total = _count(usage.get("total_tokens"))
        if prompt is None and completion is None and total is None:
            return

        self.reported_calls += 1
        if prompt is not None:
            self.prompt_tokens += prompt
            self.prompt_samples += 1
            self.last_prompt_tokens = prompt
        if completion is not None:
            self.completion_tokens += completion
            self.completion_samples += 1
        if total is not None:
            self.total_tokens += total
            self.total_samples += 1
        elif prompt is not None and completion is not None:
            # Exact sum of two provider-reported counts.
            self.total_tokens += prompt + completion
            self.total_samples += 1

    def snapshot(self) -> dict:
        window = context_limit(self.configured_window)
        last = self.last_prompt_tokens
        remaining = max(0, window - last) if window is not None and last is not None else None
        return {
            "calls": self.calls,
            "reported_calls": self.reported_calls,
            "missing_calls": self.calls - self.reported_calls,
            "prompt_tokens": self.prompt_tokens if self.prompt_samples else None,
            "completion_tokens": self.completion_tokens if self.completion_samples else None,
            "total_tokens": self.total_tokens if self.total_samples else None,
            "prompt_samples": self.prompt_samples,
            "completion_samples": self.completion_samples,
            "total_samples": self.total_samples,
            "last_prompt_tokens": last,
            "context_window_tokens": window,
            "context_remaining_tokens": remaining,
        }


def format_usage(snapshot: dict) -> str:
    """Compact report for /status and one-shot stderr."""
    def shown(value: int | None) -> str:
        return f"{value:,}" if isinstance(value, int) else "未报告"

    calls = snapshot["calls"]
    reported = snapshot["reported_calls"]
    lines = [
        f"模型调用：{calls} 次；返回用量：{reported} 次",
        f"Token（已报告）：输入 {shown(snapshot['prompt_tokens'])} / "
        f"输出 {shown(snapshot['completion_tokens'])} / "
        f"合计 {shown(snapshot['total_tokens'])}",
    ]
    if snapshot["missing_calls"]:
        lines.append(f"注：{snapshot['missing_calls']} 次响应未返回 token 用量，累计值不完整。")
    window = snapshot["context_window_tokens"]
    recent = snapshot["last_prompt_tokens"]
    remaining = snapshot["context_remaining_tokens"]
    if window is None:
        lines.append("上下文剩余：未知（未配置该模型的 context_window_tokens）。")
    elif recent is None:
        lines.append(f"上下文剩余：未知（配置上限 {window:,}，尚无可用输入 token 数据）。")
    else:
        lines.append(
            f"最近请求输入：{recent:,} / 配置窗口：{window:,} tokens；"
            f"参考余量约 {remaining:,}（不含本轮生成和下一次输入）。"
        )
    return "\n".join(lines)
