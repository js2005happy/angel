"""Tests for nyra.multi_model — all offline, fake providers only."""

import io
import json
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from nyra import multi_model
from nyra.multi_model import parse_model_spec, research
from nyra.tools import (
    MUTATING_TOOLS,
    TOOL_SCHEMAS,
    ToolContext,
    execute_tool,
)


class FakeProvider:
    """A stand-in provider: sleeps, then answers or raises."""

    def __init__(
        self,
        name,
        model,
        answer="ok",
        error=None,
        delay=0.0,
        usage=None,
    ):
        self.name = name
        self.model = model
        self.answer = answer
        self.error = error
        self.delay = delay
        self.usage = usage if usage is not None else {"total_tokens": 7}
        self.seen_messages = []

    def chat(self, messages, timeout=120.0):
        self.seen_messages.append(messages)
        if self.delay:
            time.sleep(self.delay)
        if self.error is not None:
            raise RuntimeError(self.error)
        return {
            "choices": [{"message": {"content": self.answer}}],
            "usage": dict(self.usage),
        }


def make_factory(specs, default_models=None):
    """specs: {(name, model|None): FakeProvider}. Returns factory + registry."""
    registry = {}

    def factory(name, model):
        key = (name, model)
        if key in specs:
            provider = specs[key]
        else:
            resolved = model or (default_models or {}).get(name, "default-model")
            provider = FakeProvider(name, resolved, answer=f"{name} says hi")
        registry[(name, provider.model)] = provider
        return provider

    return factory, registry


class ResearchTests(unittest.TestCase):
    def test_parallel_all_called_and_order(self):
        fakes = {
            ("a", None): FakeProvider("a", "m-a", answer="A", delay=0.3),
            ("b", None): FakeProvider("b", "m-b", answer="B", delay=0.1),
            ("c", None): FakeProvider("c", "m-c", answer="C", delay=0.2),
        }
        factory, _ = make_factory(fakes)
        started = time.monotonic()
        result = research(["a", "b", "c"], "hi?", provider_factory=factory)
        elapsed = time.monotonic() - started
        self.assertEqual(
            [r["model"] for r in result["results"]],
            ["a:m-a", "b:m-b", "c:m-c"],
        )
        self.assertEqual(
            [r["answer"] for r in result["results"]], ["A", "B", "C"]
        )
        self.assertTrue(all(r["error"] is None for r in result["results"]))
        # Sequential would take 0.6s; parallel takes ~max (0.3s).
        self.assertLess(elapsed, 0.55)
        self.assertIsNone(result["synthesis"])

    def test_one_failure_does_not_affect_others(self):
        fakes = {
            ("a", None): FakeProvider("a", "m-a", answer="A"),
            ("b", None): FakeProvider("b", "m-b", error="boom 402"),
            ("c", None): FakeProvider("c", "m-c", answer="C"),
        }
        factory, _ = make_factory(fakes)
        result = research(["a", "b", "c"], "hi?", provider_factory=factory)
        by_model = {r["model"]: r for r in result["results"]}
        self.assertEqual(by_model["a:m-a"]["answer"], "A")
        self.assertEqual(by_model["c:m-c"]["answer"], "C")
        self.assertIsNone(by_model["b:m-b"]["answer"])
        self.assertIn("boom 402", by_model["b:m-b"]["error"])

    def test_construction_failure_recorded(self):
        def factory(name, model):
            if name == "bad":
                raise ValueError("Unknown provider: bad")
            return FakeProvider(name, "m", answer="ok")

        result = research(["bad", "good"], "hi?", provider_factory=factory)
        by_model = {r["model"]: r for r in result["results"]}
        self.assertIn("Unknown provider", by_model["bad"]["error"])
        self.assertEqual(by_model["good:m"]["answer"], "ok")

    def test_timeout_recorded_others_unaffected(self):
        fakes = {
            ("slow", None): FakeProvider("slow", "m-s", delay=5.0),
            ("fast", None): FakeProvider("fast", "m-f", answer="fast!"),
        }
        factory, _ = make_factory(fakes)
        started = time.monotonic()
        result = research(
            ["slow", "fast"], "hi?", timeout=0.5, provider_factory=factory
        )
        elapsed = time.monotonic() - started
        by_model = {r["model"]: r for r in result["results"]}
        self.assertIn("超时", by_model["slow:m-s"]["error"])
        self.assertIsNone(by_model["slow:m-s"]["answer"])
        self.assertEqual(by_model["fast:m-f"]["answer"], "fast!")
        self.assertLess(elapsed, 3.0)

    def test_dedupe_exact_and_resolved(self):
        fakes = {
            ("deepseek", None): FakeProvider(
                "deepseek", "deepseek-flash", answer="D"
            ),
            ("deepseek", "deepseek-flash"): FakeProvider(
                "deepseek", "deepseek-flash", answer="D"
            ),
        }
        factory, _ = make_factory(
            fakes, default_models={"deepseek": "deepseek-flash"}
        )
        result = research(
            ["deepseek", "deepseek", "deepseek:deepseek-flash", "xai"],
            "hi?",
            provider_factory=factory,
        )
        self.assertEqual(
            [r["model"] for r in result["results"]],
            ["deepseek:deepseek-flash", "xai:default-model"],
        )

    def test_empty_list_error(self):
        with self.assertRaises(ValueError):
            research([], "hi?")

    def test_over_cap_error(self):
        with self.assertRaises(ValueError):
            research(["a", "b", "c", "d", "e", "f"], "hi?")

    def test_system_prompt_passed(self):
        provider = FakeProvider("a", "m-a", answer="A")
        factory, registry = make_factory({("a", None): provider})
        research(["a"], "hi?", system="be terse", provider_factory=factory)
        messages = provider.seen_messages[0]
        self.assertEqual(messages[0], {"role": "system", "content": "be terse"})
        self.assertEqual(messages[1], {"role": "user", "content": "hi?"})

    def test_synthesis_attributions_and_failures(self):
        synth = FakeProvider("s", "m-s", answer="merged")
        fakes = {
            ("a", None): FakeProvider("a", "m-a", answer="cats are great"),
            ("b", None): FakeProvider("b", "m-b", answer="cats are awful"),
            ("c", None): FakeProvider("c", "m-c", error="down"),
            ("s", None): synth,
        }
        factory, _ = make_factory(fakes)
        result = research(
            ["a", "b", "c"],
            "are cats great?",
            synthesizer="s",
            provider_factory=factory,
        )
        self.assertEqual(result["synthesis"], "merged")
        self.assertIsNone(result["synthesis_error"])
        synth_prompt = synth.seen_messages[0][0]["content"]
        self.assertIn("a:m-a", synth_prompt)
        self.assertIn("cats are great", synth_prompt)
        self.assertIn("b:m-b", synth_prompt)
        self.assertIn("cats are awful", synth_prompt)
        self.assertIn("c:m-c", synth_prompt)
        self.assertIn("调用失败", synth_prompt)

    def test_synthesis_truncates_huge_answers(self):
        from nyra.multi_model import MAX_SYNTHESIS_ANSWER_CHARS

        synth = FakeProvider("s", "m-s", answer="merged")
        long_answer = "x" * (MAX_SYNTHESIS_ANSWER_CHARS + 5000)
        fakes = {
            ("a", None): FakeProvider("a", "m-a", answer=long_answer),
            ("s", None): synth,
        }
        factory, _ = make_factory(fakes)
        result = research(
            ["a"], "hi?", synthesizer="s", provider_factory=factory
        )
        self.assertEqual(result["synthesis"], "merged")
        # The full answer is still returned to the caller; only the
        # copy pasted into the synthesis prompt is bounded.
        self.assertEqual(result["results"][0]["answer"], long_answer)
        synth_prompt = synth.seen_messages[0][0]["content"]
        self.assertIn("已截断", synth_prompt)
        self.assertLess(
            len(synth_prompt),
            len(long_answer) + len("原问题：hi?") + 2000,
        )

    def test_synthesizer_failure_recorded(self):
        fakes = {
            ("a", None): FakeProvider("a", "m-a", answer="A"),
            ("s", None): FakeProvider("s", "m-s", error="synth exploded"),
        }
        factory, _ = make_factory(fakes)
        result = research(
            ["a"], "hi?", synthesizer="s", provider_factory=factory
        )
        self.assertIsNone(result["synthesis"])
        self.assertIn("synth exploded", result["synthesis_error"])
        self.assertEqual(result["results"][0]["answer"], "A")

    def test_bad_synthesizer_spec_recorded(self):
        factory, _ = make_factory(
            {("a", None): FakeProvider("a", "m-a", answer="A")}
        )
        result = research(["a"], "hi?", synthesizer=":x", provider_factory=factory)
        self.assertIsNone(result["synthesis"])
        self.assertIsNotNone(result["synthesis_error"])

    def test_parse_model_spec(self):
        self.assertEqual(parse_model_spec("xai:grok-4"), ("xai", "grok-4"))
        self.assertEqual(
            parse_model_spec("ollama:qwen2.5:7b"), ("ollama", "qwen2.5:7b")
        )
        self.assertEqual(parse_model_spec("deepseek"), ("deepseek", None))
        self.assertEqual(parse_model_spec("  kimi  "), ("kimi", None))
        with self.assertRaises(ValueError):
            parse_model_spec("")
        with self.assertRaises(ValueError):
            parse_model_spec(":x")


class CliTests(unittest.TestCase):
    def _fake_factory(self):
        def factory(name, model):
            return FakeProvider(name, model or "m", answer=f"{name} answer")

        return factory

    def test_cli_research_json(self):
        with mock.patch.object(
            multi_model, "_default_provider_factory", self._fake_factory()
        ):
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = multi_model.main(
                    [
                        "research",
                        "--models",
                        "a,b",
                        "--prompt",
                        "hi?",
                        "--json",
                    ]
                )
        self.assertEqual(code, 0)
        data = json.loads(buf.getvalue())
        self.assertEqual(
            [r["model"] for r in data["results"]], ["a:m", "b:m"]
        )
        self.assertEqual(data["results"][0]["answer"], "a answer")

    def test_cli_research_text_and_models_split(self):
        with mock.patch.object(
            multi_model, "_default_provider_factory", self._fake_factory()
        ):
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = multi_model.main(
                    [
                        "research",
                        "--models",
                        "a, b ,c",
                        "--prompt",
                        "hi?",
                    ]
                )
        self.assertEqual(code, 0)
        out = buf.getvalue()
        self.assertIn("== a:m ==", out)
        self.assertIn("== b:m ==", out)
        self.assertIn("== c:m ==", out)
        self.assertIn("a answer", out)

    def test_cli_research_no_models_error(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = multi_model.main(["research", "--models", " , ", "--prompt", "hi?"])
        self.assertEqual(code, 2)

    def test_cli_list_flag(self):
        with mock.patch.object(
            multi_model, "list_providers", return_value=["deepseek", "xai"]
        ):
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = multi_model.main(["--list"])
        self.assertEqual(code, 0)
        self.assertEqual(buf.getvalue(), "deepseek\nxai\n")

    def test_cli_list_subcommand(self):
        with mock.patch.object(
            multi_model, "list_providers", return_value=["deepseek", "xai"]
        ):
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = multi_model.main(["list"])
        self.assertEqual(code, 0)
        self.assertEqual(buf.getvalue(), "deepseek\nxai\n")


class TestMultiModelToolWiring(unittest.TestCase):
    """The agent-facing tool: schema, dispatch, formatting (no real models)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def _ctx(self):
        return ToolContext(
            workdir=self.tmp,
            mode="full",
            interactive=False,
            memory_path=self.tmp / "MEMORY.md",
            skills_dir=self.tmp / "skills",
        )

    def test_schema_registered_and_not_mutating(self):
        names = {s["function"]["name"] for s in TOOL_SCHEMAS}
        self.assertIn("multi_model_research", names)
        # Same precedent as delegate: extra model calls are not gated.
        self.assertNotIn("multi_model_research", MUTATING_TOOLS)

    def test_dispatch_formats_results_and_synthesis(self):
        fake = {
            "results": [
                {"model": "deepseek", "answer": "A 是对的", "error": None, "usage": None},
                {"model": "xai", "answer": None, "error": "402 没额度", "usage": None},
            ],
            "synthesis": "共识：A 是对的。",
            "synthesis_error": None,
        }
        with mock.patch("nyra.tools.multi_model_research", return_value=fake):
            out = execute_tool(
                "multi_model_research",
                {"models": ["deepseek", "xai"], "prompt": "A 对吗？"},
                self._ctx(),
            )
        self.assertIn("== deepseek ==\nA 是对的", out)
        self.assertIn("== xai ==\n（失败：402 没额度）", out)
        self.assertIn("== 综合 ==\n共识：A 是对的。", out)

    def test_dispatch_value_error_becomes_error_string(self):
        with mock.patch(
            "nyra.tools.multi_model_research",
            side_effect=ValueError("至少要指定一个模型"),
        ):
            out = execute_tool(
                "multi_model_research", {"models": [], "prompt": "hi"}, self._ctx()
            )
        self.assertTrue(out.startswith("错误："))


if __name__ == "__main__":
    unittest.main()
