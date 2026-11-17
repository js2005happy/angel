"""Model auto-fallback tests (stdlib unittest only, no network, no keys).

Covers: ProviderError classification (recoverable vs auth), FallbackProvider
switching behaviour, fallback chain resolution from config/env, real
Provider.chat error mapping with a mocked opener, and the Agent loop
running on a FallbackProvider.
"""

import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from angel.agent import Agent  # noqa: E402
from angel.config import (  # noqa: E402
    ProviderConfig,
    resolve_fallback_chain,
)
from angel.providers import (  # noqa: E402
    FallbackProvider,
    Provider,
    ProviderError,
    build_provider_chain,
    is_recoverable_provider_error,
)


def assistant_message(content="", calls=None):
    msg = {"role": "assistant", "content": content}
    if calls:
        msg["tool_calls"] = calls
    return {"choices": [{"message": msg}]}


class ScriptedProvider:
    """A fake provider with a scripted outcome per chat() call."""

    def __init__(self, name, model, outcomes):
        self.name = name
        self.model = model
        self.base_url = f"https://{name}.example.com/v1"
        self.outcomes = list(outcomes)
        self.calls = 0
        self._has_credentials = True

    def has_credentials(self):
        return self._has_credentials

    def _redact(self, text, request=None):
        return text

    def chat(self, messages, tools=None, timeout=120):
        self.calls += 1
        if not self.outcomes:
            return assistant_message("没有更多预设回复。")
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _quota_error():
    return ProviderError("余额不足 (HTTP 402)：请充值后再试。", status=402, kind="quota")


def _auth_error():
    return ProviderError(
        "认证失败 (HTTP 401)：API Key 无效或无权限，请检查凭证。",
        status=401,
        kind="auth",
    )


class ProviderErrorClassificationTest(unittest.TestCase):
    def test_quota_rate_limit_server_timeout_network_are_recoverable(self):
        for exc in (
            ProviderError("x", status=402, kind="quota"),
            ProviderError("x", status=429, kind="rate_limit"),
            ProviderError("x", status=500, kind="server"),
            ProviderError("x", status=503, kind="server"),
            ProviderError("x", kind="timeout"),
            ProviderError("x", kind="network"),
        ):
            self.assertTrue(exc.recoverable, exc.kind)
            self.assertTrue(is_recoverable_provider_error(exc))

    def test_auth_config_parse_client_redirect_are_not_recoverable(self):
        for exc in (
            ProviderError("x", status=401, kind="auth"),
            ProviderError("x", status=403, kind="auth"),
            ProviderError("x", kind="config"),
            ProviderError("x", kind="parse"),
            ProviderError("x", status=400, kind="client"),
            ProviderError("x", status=404, kind="client"),
            ProviderError("x", kind="redirect"),
            ProviderError("x"),  # plain message, no classification
        ):
            self.assertFalse(exc.recoverable, exc.kind)
            self.assertFalse(is_recoverable_provider_error(exc))

    def test_non_provider_error_is_not_recoverable(self):
        self.assertFalse(is_recoverable_provider_error(ValueError("x")))
        self.assertFalse(is_recoverable_provider_error(None))

    def test_plain_message_still_works(self):
        # Existing call sites raise ProviderError("...") with one argument.
        exc = ProviderError("认证失败 (HTTP 401)：API Key 无效")
        self.assertEqual(str(exc), "认证失败 (HTTP 401)：API Key 无效")
        self.assertIsNone(exc.status)
        self.assertEqual(exc.kind, "unknown")


class FallbackProviderTest(unittest.TestCase):
    def test_402_switches_to_next_and_succeeds(self):
        primary = ScriptedProvider("deepseek", "deepseek-flash", [_quota_error()])
        backup = ScriptedProvider("xai", "grok-4.3", [assistant_message("备用模型答复")])
        seen = []
        fb = FallbackProvider([primary, backup], on_switch=seen.append)
        result = fb.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(result["choices"][0]["message"]["content"], "备用模型答复")
        self.assertEqual(primary.calls, 1)
        self.assertEqual(backup.calls, 1)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["from"], "deepseek")
        self.assertEqual(seen[0]["to"], "xai")
        self.assertEqual(seen[0]["kind"], "quota")
        self.assertEqual(seen[0]["status"], 402)
        self.assertEqual(len(fb.switches), 1)
        # The active provider is now the one that answered.
        self.assertEqual(fb.name, "xai")
        self.assertEqual(fb.model, "grok-4.3")

    def test_401_does_not_switch(self):
        primary = ScriptedProvider("deepseek", "deepseek-flash", [_auth_error()])
        backup = ScriptedProvider("xai", "grok-4.3", [assistant_message("不该被调用")])
        seen = []
        fb = FallbackProvider([primary, backup], on_switch=seen.append)
        with self.assertRaises(ProviderError) as ctx:
            fb.chat([{"role": "user", "content": "hi"}])
        self.assertIn("401", str(ctx.exception))
        self.assertEqual(primary.calls, 1)
        self.assertEqual(backup.calls, 0)
        self.assertEqual(seen, [])
        self.assertEqual(fb.switches, [])

    def test_403_does_not_switch(self):
        primary = ScriptedProvider(
            "deepseek",
            "deepseek-flash",
            [ProviderError("认证失败 (HTTP 403)", status=403, kind="auth")],
        )
        backup = ScriptedProvider("xai", "grok-4.3", [assistant_message("不该被调用")])
        fb = FallbackProvider([primary, backup])
        with self.assertRaises(ProviderError):
            fb.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(backup.calls, 0)

    def test_rate_limit_timeout_and_5xx_switch(self):
        for error in (
            ProviderError("x", status=429, kind="rate_limit"),
            ProviderError("x", kind="timeout"),
            ProviderError("x", status=500, kind="server"),
            ProviderError("x", kind="network"),
        ):
            primary = ScriptedProvider("deepseek", "deepseek-flash", [error])
            backup = ScriptedProvider("ollama", "qwen2.5:7b", [assistant_message("ok")])
            fb = FallbackProvider([primary, backup])
            result = fb.chat([{"role": "user", "content": "hi"}])
            self.assertEqual(
                result["choices"][0]["message"]["content"], "ok", error.kind
            )
            self.assertEqual(backup.calls, 1, error.kind)

    def test_all_providers_fail_raises_clear_error(self):
        first = ScriptedProvider("deepseek", "deepseek-flash", [_quota_error()])
        second = ScriptedProvider(
            "xai", "grok-4.3", [ProviderError("x", status=429, kind="rate_limit")]
        )
        third = ScriptedProvider("ollama", "qwen2.5:7b", [ProviderError("x", kind="network")])
        fb = FallbackProvider([first, second, third])
        with self.assertRaises(ProviderError) as ctx:
            fb.chat([{"role": "user", "content": "hi"}])
        message = str(ctx.exception)
        self.assertIn("全部 3 个模型都失败了", message)
        self.assertIn("deepseek", message)
        self.assertIn("xai", message)
        self.assertIn("ollama", message)
        self.assertEqual(first.calls, 1)
        self.assertEqual(second.calls, 1)
        self.assertEqual(third.calls, 1)
        self.assertEqual(len(fb.switches), 2)
        self.assertFalse(ctx.exception.recoverable)

    def test_next_call_starts_from_primary_again(self):
        primary = ScriptedProvider(
            "deepseek", "deepseek-flash", [_quota_error(), assistant_message("主模型恢复")]
        )
        backup = ScriptedProvider("xai", "grok-4.3", [assistant_message("备用")])
        fb = FallbackProvider([primary, backup])
        first = fb.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(first["choices"][0]["message"]["content"], "备用")
        second = fb.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(second["choices"][0]["message"]["content"], "主模型恢复")
        self.assertEqual(primary.calls, 2)
        self.assertEqual(backup.calls, 1)

    def test_empty_chain_rejected(self):
        with self.assertRaises(ValueError):
            FallbackProvider([])

    def test_attributes_delegate_to_active_provider(self):
        primary = ScriptedProvider("deepseek", "deepseek-flash", [assistant_message("ok")])
        backup = ScriptedProvider("xai", "grok-4.3", [assistant_message("ok")])
        fb = FallbackProvider([primary, backup])
        self.assertEqual(fb.name, "deepseek")
        self.assertEqual(fb.model, "deepseek-flash")
        self.assertTrue(fb.has_credentials())
        from angel.providers import describe_provider

        self.assertIn("deepseek", describe_provider(fb))


class BuildProviderChainTest(unittest.TestCase):
    def _primary_cfg(self):
        return ProviderConfig(
            name="deepseek",
            base_url="https://api.deepseek.com/v1",
            model="deepseek-flash",
            api_key=None,
            auth="connector",
            connector_name="custom.deepseek",
            allowed_hosts=["api.deepseek.com"],
        )

    def test_single_provider_returns_plain_provider(self):
        provider = build_provider_chain(self._primary_cfg(), ["deepseek"])
        self.assertIsInstance(provider, Provider)
        self.assertNotIsInstance(provider, FallbackProvider)

    def test_multiple_providers_returns_fallback_provider(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            provider = build_provider_chain(
                self._primary_cfg(), ["deepseek", "xai", "ollama"]
            )
        self.assertIsInstance(provider, FallbackProvider)
        self.assertEqual(
            [p.name for p in provider.providers], ["deepseek", "xai", "ollama"]
        )

    def test_unknown_names_are_skipped(self):
        provider = build_provider_chain(
            self._primary_cfg(), ["deepseek", "nope", "ollama"]
        )
        self.assertIsInstance(provider, FallbackProvider)
        self.assertEqual(
            [p.name for p in provider.providers], ["deepseek", "ollama"]
        )

    def test_injected_factory_and_resolver_are_used(self):
        """Callers (cli.py) pass their own namespace bindings so tests can
        substitute fakes; the chain must use them, not the real classes."""
        made = []

        class Fake:
            def __init__(self, cfg):
                self.name = cfg.name
                self.model = cfg.model
                made.append(cfg.name)

            def has_credentials(self):
                return True

        def fake_resolver(name, model=None):
            return ProviderConfig(
                name=name,
                base_url=f"https://{name}.example.com/v1",
                model=f"{name}-model",
                api_key=None,
                auth="none",
                connector_name=None,
                allowed_hosts=[],
            )

        provider = build_provider_chain(
            self._primary_cfg(),
            ["deepseek", "xai", "ollama"],
            provider_cls=Fake,
            resolver=fake_resolver,
        )
        self.assertIsInstance(provider, FallbackProvider)
        self.assertEqual(made, ["deepseek", "xai", "ollama"])
        self.assertEqual(
            [p.name for p in provider.providers], ["deepseek", "xai", "ollama"]
        )


class ResolveFallbackChainTest(unittest.TestCase):
    def test_default_chain_for_deepseek(self):
        chain = resolve_fallback_chain("deepseek", config={})
        self.assertEqual(chain, ["deepseek", "xai", "ollama"])

    def test_primary_first_for_other_providers(self):
        self.assertEqual(
            resolve_fallback_chain("xai", config={}), ["xai", "deepseek", "ollama"]
        )
        self.assertEqual(
            resolve_fallback_chain("ollama", config={}),
            ["ollama", "deepseek", "xai"],
        )

    def test_config_disables_fallback(self):
        chain = resolve_fallback_chain(
            "deepseek", config={"fallback_enabled": False}
        )
        self.assertEqual(chain, ["deepseek"])

    def test_config_chain_order(self):
        chain = resolve_fallback_chain(
            "deepseek",
            config={"fallback_providers": ["ollama", "xai"]},
        )
        self.assertEqual(chain, ["deepseek", "ollama", "xai"])

    def test_unknown_names_in_config_are_skipped(self):
        chain = resolve_fallback_chain(
            "deepseek", config={"fallback_providers": ["nope", "xai"]}
        )
        self.assertEqual(chain, ["deepseek", "xai"])

    def test_env_disables_fallback(self):
        with mock.patch.dict(os.environ, {"ANGEL_FALLBACK": "0"}):
            chain = resolve_fallback_chain("deepseek", config={})
        self.assertEqual(chain, ["deepseek"])

    def test_env_overrides_chain(self):
        with mock.patch.dict(
            os.environ, {"ANGEL_FALLBACK_PROVIDERS": "ollama, xai"}
        ):
            chain = resolve_fallback_chain("deepseek", config={})
        self.assertEqual(chain, ["deepseek", "ollama", "xai"])

    def test_explicit_enabled_argument_wins_over_env(self):
        with mock.patch.dict(os.environ, {"ANGEL_FALLBACK": "0"}):
            chain = resolve_fallback_chain("deepseek", config={}, enabled=True)
        self.assertEqual(chain, ["deepseek", "xai", "ollama"])
        chain = resolve_fallback_chain("deepseek", config={}, enabled=False)
        self.assertEqual(chain, ["deepseek"])


class RealProviderErrorMappingTest(unittest.TestCase):
    """Provider.chat maps HTTP/timeout/network failures to kinds."""

    def _provider(self):
        cfg = ProviderConfig(
            name="deepseek",
            base_url="https://api.deepseek.com/v1",
            model="deepseek-flash",
            api_key="test-key",
            auth="env",
            connector_name=None,
            allowed_hosts=["api.deepseek.com"],
        )
        return Provider(cfg)

    def _fake_opener(self, action):
        class FakeOpener:
            def open(self, request, timeout=None):
                return action(request)

        return FakeOpener()

    def _http_error(self, code):
        return urllib.error.HTTPError(
            "https://api.deepseek.com/v1/chat/completions",
            code,
            "error",
            {},
            io.BytesIO(b'{"error": "boom"}'),
        )

    def _run_chat_with(self, action):
        provider = self._provider()
        with mock.patch(
            "angel.providers.build_opener_for",
            return_value=self._fake_opener(action),
        ):
            with self.assertRaises(ProviderError) as ctx:
                provider.chat([{"role": "user", "content": "hi"}])
        return ctx.exception

    def test_http_402_is_quota_and_recoverable(self):
        exc = self._run_chat_with(
            lambda request: (_ for _ in ()).throw(self._http_error(402))
        )
        self.assertEqual(exc.status, 402)
        self.assertEqual(exc.kind, "quota")
        self.assertTrue(exc.recoverable)
        self.assertIn("402", str(exc))

    def test_http_401_is_auth_and_not_recoverable(self):
        exc = self._run_chat_with(
            lambda request: (_ for _ in ()).throw(self._http_error(401))
        )
        self.assertEqual(exc.status, 401)
        self.assertEqual(exc.kind, "auth")
        self.assertFalse(exc.recoverable)

    def test_http_500_is_server_and_recoverable(self):
        exc = self._run_chat_with(
            lambda request: (_ for _ in ()).throw(self._http_error(500))
        )
        self.assertEqual(exc.status, 500)
        self.assertEqual(exc.kind, "server")
        self.assertTrue(exc.recoverable)

    def test_http_429_is_rate_limit_and_recoverable(self):
        exc = self._run_chat_with(
            lambda request: (_ for _ in ()).throw(self._http_error(429))
        )
        self.assertEqual(exc.kind, "rate_limit")
        self.assertTrue(exc.recoverable)

    def test_timeout_is_recoverable(self):
        def action(request):
            raise urllib.error.URLError(TimeoutError("timed out"))

        exc = self._run_chat_with(action)
        self.assertEqual(exc.kind, "timeout")
        self.assertTrue(exc.recoverable)

    def test_network_error_is_recoverable(self):
        def action(request):
            raise urllib.error.URLError(ConnectionError("unreachable"))

        exc = self._run_chat_with(action)
        self.assertEqual(exc.kind, "network")
        self.assertTrue(exc.recoverable)


class AgentFallbackIntegrationTest(unittest.TestCase):
    def test_agent_answer_comes_from_fallback_after_402(self):
        tmp = Path(tempfile.mkdtemp())
        primary = ScriptedProvider("deepseek", "deepseek-flash", [_quota_error()])
        backup = ScriptedProvider("xai", "grok-4.3", [assistant_message("备用模型答复")])
        seen = []
        fb = FallbackProvider([primary, backup], on_switch=seen.append)
        agent = Agent(provider=fb, workdir=tmp, mode="full", interactive=False)
        try:
            result = agent.run("你好")
        finally:
            session_file = Path.home() / ".angel" / "sessions" / f"{agent.session_id}.jsonl"
            if session_file.exists():
                session_file.unlink()
        self.assertEqual(result, "备用模型答复")
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["from"], "deepseek")
        self.assertEqual(seen[0]["to"], "xai")


if __name__ == "__main__":
    unittest.main()
