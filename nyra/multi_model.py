"""多模型调研：一次向多个模型提问，并行跑，汇总成一份报告。

`research()` 接受多个模型（"provider" 或 "provider:model"），用仓库
现有的 provider 机制（config.resolve_provider + Provider / CliProvider，
与兜底链建单个 provider 的方式一致）逐个构造，并行调用，失败的模型
只记录、不兜底、不拖垮其他模型。可选一个综合模型，把各家的回答按
模型署名拼成一份合并报告（共识 / 分歧 / 各家独特观点）。

只做纯文本调研（v1）。视觉模型也可以列进 models，但图片输入不在
这里接线（那是 nyra/vision.py 的事）。

入口：python3 -m nyra.multi_model research --models a,b --prompt "..."
"""

import argparse
import json
import threading
import time

MAX_MODELS = 5

SYNTHESIS_INSTRUCTIONS = (
    "以下是多个模型对同一问题的独立回答，每份都已注明来源模型，"
    "请综合成一份中文报告，只按以下三节写，不要编造没有出现的观点：\n"
    "1. 共识：所有模型都同意的点；\n"
    "2. 分歧：模型之间说得不一样的点，逐条注明是谁说的；\n"
    "3. 独特观点：只有个别模型提到的点，注明是哪个模型提的。\n"
    "如果某个模型的回答缺失（调用失败），不要替它补观点，只按已有的回答写。"
)


def parse_model_spec(spec: str) -> tuple[str, str | None]:
    """Split "provider" or "provider:model" into (provider, model|None).

    Model names may themselves contain ":", e.g. ollama "qwen2.5:7b",
    so only the first ":" separates provider from model.
    """
    text = (spec or "").strip()
    if not text:
        raise ValueError("模型名不能为空")
    if ":" in text:
        name, model = text.split(":", 1)
        name = name.strip()
        model = model.strip() or None
    else:
        name, model = text, None
    if not name:
        raise ValueError(f"模型写法不对：{spec!r}（应为 provider 或 provider:model）")
    return name, model


def _default_provider_factory(name: str, model: str | None):
    """Build one provider exactly the way the fallback chain builds one.

    CLI providers (Codex) cannot be constructed via plain Provider
    (Provider.__new__ refuses them); they go through CliProvider.
    """
    from nyra.config import resolve_provider
    from nyra.providers import CliProvider, Provider

    cfg = resolve_provider(name, model)
    if getattr(cfg, "auth", None) == "cli":
        return CliProvider(cfg)
    return Provider(cfg)


def _extract_answer(resp: dict) -> tuple[str, dict | None]:
    """Pull (content, usage) out of an OpenAI-shape chat response."""
    try:
        content = resp["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("模型返回了无法解析的回答") from exc
    usage = resp.get("usage") if isinstance(resp, dict) else None
    return content, usage


def _call_provider(provider, messages: list[dict], timeout: float):
    """One chat call. Returns (answer, usage, error) — never raises."""
    try:
        resp = provider.chat(messages, timeout=timeout)
        answer, usage = _extract_answer(resp)
        return answer, usage, None
    except Exception as exc:  # noqa: BLE001 - recorded per model, not fatal
        return None, None, str(exc)


def _build_synthesis_prompt(prompt: str, results: list[dict]) -> str:
    """Merge prompt: every answer attributed, failures stated plainly."""
    parts = [
        SYNTHESIS_INSTRUCTIONS,
        f"\n原问题：{prompt}\n",
    ]
    failed = [r for r in results if r["error"] is not None]
    for r in results:
        if r["error"] is not None:
            continue
        parts.append(f"\n--- {r['model']} 的回答 ---\n{r['answer']}\n")
    if failed:
        parts.append("\n以下模型调用失败，没有提供回答：\n")
        for r in failed:
            parts.append(f"- {r['model']}：{r['error']}\n")
    return "".join(parts)


def _synthesize(
    synthesizer: str,
    prompt: str,
    results: list[dict],
    timeout: float,
    provider_factory,
) -> tuple[str | None, str | None]:
    """One follow-up call to the synthesizer. Returns (text, error)."""
    try:
        name, model = parse_model_spec(synthesizer)
        provider = provider_factory(name, model)
        label = f"{provider.name}:{provider.model}"
    except Exception as exc:  # noqa: BLE001 - bad spec / no credentials
        return None, f"综合模型 {synthesizer!r} 无法使用：{exc}"
    synth_prompt = _build_synthesis_prompt(prompt, results)
    messages = [{"role": "user", "content": synth_prompt}]
    answer, _usage, error = _call_provider(provider, messages, timeout)
    if error is not None:
        return None, f"综合调用失败（{label}）：{error}"
    return answer, None


def research(
    models: list[str],
    prompt: str,
    system: str | None = None,
    timeout: float = 120.0,
    synthesizer: str | None = None,
    *,
    provider_factory=None,
) -> dict:
    """Ask several models the same question in parallel, synthesize.

    Returns {"results": [...], "synthesis": str|None,
    "synthesis_error": str|None}. Each result is {"model", "answer",
    "error", "usage"} in the caller's model order. A failed model is
    recorded with its error and never replaced by a fallback.
    """
    if not models:
        raise ValueError("至少要指定一个模型")
    specs = []
    for spec in models:
        text = (spec or "").strip()
        if not text:
            raise ValueError("模型名不能为空")
        if text not in specs:
            specs.append(text)
    if len(specs) > MAX_MODELS:
        raise ValueError(f"一次最多 {MAX_MODELS} 个模型，给了 {len(specs)} 个")

    factory = provider_factory or _default_provider_factory
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    # Build providers up front (cheap, no network): construction failures
    # become a recorded per-model error, and identical (provider, model)
    # pairs dedupe to the first occurrence.
    slots: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for spec in specs:
        try:
            name, model = parse_model_spec(spec)
            provider = factory(name, model)
            key = (provider.name, provider.model)
            label = f"{provider.name}:{provider.model}"
            if key in seen:
                continue
            seen.add(key)
        except Exception as exc:  # noqa: BLE001 - recorded, not fatal
            slots.append(
                {"model": spec, "answer": None, "error": str(exc), "usage": None}
            )
            continue
        slots.append(
            {
                "model": label,
                "answer": None,
                "error": None,
                "usage": None,
                "_provider": provider,
            }
        )

    def run(slot: dict) -> None:
        answer, usage, error = _call_provider(
            slot["_provider"], messages, timeout
        )
        if slot.get("_timed_out"):
            return
        slot["answer"] = answer
        slot["usage"] = usage
        slot["error"] = error

    # One thread per model; all share one deadline, so the whole call
    # returns within about `timeout` even if a model hangs. Threads are
    # daemons: a timed-out call keeps running in the background (threads
    # can't be killed) but its result is already final.
    jobs: list[tuple[dict, threading.Thread]] = []
    for slot in slots:
        provider = slot.get("_provider")
        if provider is None:
            continue
        thread = threading.Thread(target=run, args=(slot,), daemon=True)
        thread.start()
        jobs.append((slot, thread))
    deadline = time.monotonic() + timeout
    for _slot, thread in jobs:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        thread.join(timeout=remaining)
    for slot, thread in jobs:
        slot.pop("_provider", None)
        if thread.is_alive():
            slot["_timed_out"] = True
            slot["answer"] = None
            slot["usage"] = None
            slot["error"] = f"超时（{timeout:g} 秒内未返回）"
    results = [
        {
            "model": s["model"],
            "answer": s["answer"],
            "error": s["error"],
            "usage": s["usage"],
        }
        for s in slots
    ]

    synthesis = None
    synthesis_error = None
    if synthesizer is not None:
        synthesis, synthesis_error = _synthesize(
            synthesizer, prompt, results, timeout, factory
        )
    return {
        "results": results,
        "synthesis": synthesis,
        "synthesis_error": synthesis_error,
    }


def _format_text(result: dict) -> str:
    lines: list[str] = []
    for r in result["results"]:
        lines.append(f"== {r['model']} ==")
        if r["error"] is not None:
            lines.append(f"（调用失败：{r['error']}）")
        else:
            lines.append(r["answer"] or "")
        lines.append("")
    if result.get("synthesis") is not None:
        lines.append("== 综合 ==")
        lines.append(result["synthesis"])
        lines.append("")
    if result.get("synthesis_error"):
        lines.append(f"（综合失败：{result['synthesis_error']}）")
    return "\n".join(lines).rstrip() + "\n"


def list_providers() -> list[str]:
    """Available provider names from config presets."""
    from nyra.config import get_provider_presets, load_config

    return sorted(get_provider_presets(load_config()))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="nyra.multi_model",
        description="一次向多个模型提问，并行跑，汇总成一份报告",
    )
    parser.add_argument(
        "--list", action="store_true", help="列出可用的 provider 名字"
    )
    sub = parser.add_subparsers(dest="command")

    research_p = sub.add_parser("research", help="多模型并行调研")
    research_p.add_argument(
        "--models",
        required=True,
        help="逗号分隔的模型：provider 或 provider:model，可多个",
    )
    research_p.add_argument("--prompt", required=True, help="要问的问题")
    research_p.add_argument("--system", default=None, help="系统提示（可选）")
    research_p.add_argument(
        "--synthesizer",
        default=None,
        help="综合模型：provider 或 provider:model（可选）",
    )
    research_p.add_argument(
        "--timeout", type=float, default=120.0, help="单个模型超时秒数"
    )
    research_p.add_argument("--json", action="store_true", help="输出 JSON")

    list_p = sub.add_parser("list", help="列出可用的 provider 名字")
    _ = list_p

    args = parser.parse_args(argv)
    if args.list:
        for name in list_providers():
            print(name)
        return 0
    if args.command == "list":
        for name in list_providers():
            print(name)
        return 0
    if args.command != "research":
        parser.print_help()
        return 2
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    try:
        result = research(
            models,
            args.prompt,
            system=args.system,
            timeout=args.timeout,
            synthesizer=args.synthesizer,
        )
    except ValueError as exc:
        print(f"参数错误：{exc}")
        return 2
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(_format_text(result), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
