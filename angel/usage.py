"""Track provider-reported token usage without inventing unavailable data.

OpenAI-compatible providers may omit usage entirely. Only reported counters
are totaled; context windows are user supplied, never guessed from model names.
"""

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import threading
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


def _money(value: Any) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    raw = str(value).strip()
    if not raw or len(raw) > 128:
        return None
    try:
        amount = Decimal(raw)
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite() or amount < 0 or amount.adjusted() > 30:
        return None
    return amount


def _shown_money(value: Decimal | None) -> str | None:
    return format(value, "f") if value is not None else None


class CostLedger:
    """Track user-priced model spend and optionally stop later calls at a threshold.

    The threshold is checked between calls. A request already in flight can exceed it.
    """

    def __init__(self, pricing: Any = None, budget_usd: Any = None) -> None:
        self.pricing: dict[str, tuple[Decimal, Decimal]] = {}
        if isinstance(pricing, dict):
            for model_key, rates in pricing.items():
                if not isinstance(model_key, str) or not model_key.strip() or not isinstance(rates, dict):
                    continue
                input_rate = _money(rates.get("input_usd_per_million"))
                output_rate = _money(rates.get("output_usd_per_million"))
                if input_rate is not None and output_rate is not None:
                    self.pricing[model_key] = (input_rate, output_rate)

        self.budget_configured = budget_usd is not None
        self.budget = _money(budget_usd)
        self.budget_error = self.budget_configured and self.budget is None
        self.spent = Decimal(0)
        self.calls = 0
        self.priced_calls = 0
        self.model_spend: dict[str, Decimal] = {}
        self.unknown_reason: str | None = None
        self._lock = threading.Lock()

    def mark_unknown(self, reason: str = "missing_usage") -> None:
        with self._lock:
            self.unknown_reason = reason

    def record(self, response: Any, provider: str | None, model: str | None) -> None:
        key = f"{provider}/{model}" if provider and model else ""
        with self._lock:
            self.calls += 1
            rates = self.pricing.get(key)
            usage = response.get("usage") if isinstance(response, dict) else None
            prompt = _count(usage.get("prompt_tokens")) if isinstance(usage, dict) else None
            if prompt is None and isinstance(usage, dict):
                prompt = _count(usage.get("input_tokens"))
            completion = _count(usage.get("completion_tokens")) if isinstance(usage, dict) else None
            if completion is None and isinstance(usage, dict):
                completion = _count(usage.get("output_tokens"))
            if rates is None:
                self.unknown_reason = "missing_model_price"
            elif prompt is None or completion is None:
                self.unknown_reason = "missing_token_usage"
            else:
                input_rate, output_rate = rates
                cost = (
                    Decimal(prompt) * input_rate + Decimal(completion) * output_rate
                ) / Decimal(1_000_000)
                self.spent += cost
                self.model_spend[key] = self.model_spend.get(key, Decimal(0)) + cost
                self.priced_calls += 1

    def stop_reason(self, provider: str | None, model: str | None) -> str | None:
        if not self.budget_configured:
            return None
        if self.budget_error:
            return "cost_budget_usd 配置无效；为避免无预算保护地继续调用模型，已停止"
        with self._lock:
            if self.unknown_reason:
                return "实际费用已无法完整核算；预算保护已停止后续模型请求"
            if (
                self.budget is not None
                and self.spent >= self.budget
                and (self.calls > 0 or self.budget == 0)
            ):
                return "已达到配置的费用阈值；已停止后续模型请求"
            key = f"{provider}/{model}" if provider and model else ""
            if key not in self.pricing:
                return f"未配置 {key or '当前模型'} 的输入/输出单价；预算保护已阻止模型请求"
        return None

    def snapshot(self) -> dict:
        with self._lock:
            known = self.calls > 0 and self.unknown_reason is None and self.priced_calls == self.calls
            budget = self.budget
            return {
                "cost_usd": _shown_money(self.spent) if known else None,
                "cost_status": "known" if known else "unknown" if self.unknown_reason else "not_started",
                "cost_calls": self.calls,
                "cost_priced_calls": self.priced_calls,
                "cost_unknown_reason": self.unknown_reason,
                "cost_by_model_usd": {
                    key: _shown_money(value) for key, value in sorted(self.model_spend.items())
                },
                "cost_budget_usd": _shown_money(budget),
                "cost_budget_configured": self.budget_configured and not self.budget_error,
                "cost_budget_invalid": self.budget_error,
                "cost_budget_reached": (
                    self.budget is not None and known and self.spent >= self.budget
                ),
                "cost_budget_remaining_usd": (
                    _shown_money(max(Decimal(0), self.budget - self.spent))
                    if self.budget is not None and known else None
                ),
                "cost_budget_is_hard_cap": False,
            }


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
    cost_ledger: CostLedger | None = None

    def record(
        self,
        response: Any,
        provider: str | None = None,
        model: str | None = None,
    ) -> None:
        """Record the actual provider response, never a tokenizer approximation."""
        self.calls += 1
        if self.cost_ledger is not None:
            self.cost_ledger.record(response, provider, model)
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
        snapshot = {
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
        if self.cost_ledger is not None:
            snapshot.update(self.cost_ledger.snapshot())
        return snapshot


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
    if snapshot.get("cost_status") == "known":
        lines.append(f"按用户配置单价核算：${snapshot['cost_usd']} USD")
    elif snapshot.get("cost_status") == "unknown":
        lines.append("模型费用：未知（单价或 API 用量不完整）。")
    elif snapshot.get("cost_status") == "not_started":
        lines.append("模型费用：尚无可核算的模型调用。")
    if snapshot.get("cost_budget_invalid"):
        lines.append("费用阈值配置无效；模型请求将被阻止。")
    if snapshot.get("cost_budget_configured"):
        lines.append(
            f"费用阈值：${snapshot['cost_budget_usd']} USD；"
            f"当前为每次模型回复后核算并停止后续调用，单次在途请求可能超出。"
        )
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
