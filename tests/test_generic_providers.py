"""Generic provider support tests (stdlib unittest only, no network, no keys).

Covers: built-in presets for major vendors (verified public endpoints),
custom providers from config (tolerant parsing, clear errors), fallback
chains that include custom names, Provider.list_models() with a mocked
opener, and the CLI --list-providers / --list-models flags.
"""

import io
import json
import os
import sys
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from angel.cli import main  # noqa: E402
from angel.config import (  # noqa: E402
    DEFAULT_CONFIG,
    ProviderConfig,
    get_provider_presets,
    known_provider_names,
    resolve_fallback_chain,
    resolve_provider,
)
from angel.providers import (  # noqa: E402
    FallbackProvider,
    Provider,
    ProviderError,
    build_provider_chain,
)


def _config(**overrides):
    config = dict(DEFAULT_CONFIG)
    config.update(overrides)
    return config


def _custom_config():
    return _config(
        custom_providers={
            "myllm": {
                "base_url": "https://llm.example.com/v1",
                "default_model": "myllm-1",
                "env_key": "MYLLM_API_KEY",
                "models": ["myllm-1", "myllm-2"],
                "unknown_field": "ignored",
            }
        }
    )


class TestBuiltinPresets(unittest.TestCase):
    def test_new_presets_present_with_verified_endpoints(self):
        presets = get_provider_presets({})
        expected = {
            "qwen": (
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "qwen-plus",
                "DASHSCOPE_API_KEY",
            ),
            "kimi": (
                "https://api.moonshot.cn/v1",
                "kimi-k3",
                "MOONSHOT_API_KEY",
            ),
            "glm": (
                "https://open.bigmodel.cn/api/paas/v4",
                "glm-5.3",
                "ZHIPU_API_KEY",
            ),
            "gemini": (
                "https://generativelanguage.googleapis.com/v1beta/openai",
                "gemini-2.5-flash",
                "GEMINI_API_KEY",
            ),
            "mistral": (
                "https://api.mistral.ai/v1",
                "mistral-small-latest",
                "MISTRAL_API_KEY",
            ),
            "groq": (
                "https://api.groq.com/openai/v1",
                "llama-3.3-70b-versatile",
                "GROQ_API_KEY",
            ),
            "together": (
                "https://api.together.xyz/v1",
                "meta-llama/Llama-3.3-70B-Instruct-Turbo",
                "TOGETHER_API_KEY",
            ),
        }
        for name, (base_url, model, env_key) in expected.items():
            with self.subTest(provider=name):
                self.assertIn(name, presets)
                self.assertEqual(presets[name]["base_url"], base_url)
                self.assertEqual(presets[name]["default_model"], model)
                self.assertEqual(presets[name]["env_key"], env_key)

    def test_every_preset_has_http_base_url_and_default_model(self):
        presets = get_provider_presets({})
        for name, preset in presets.items():
            with self.subTest(provider=name):
                if name == "custom":
                    self.assertIsNone(preset["base_url"])
                    continue
                self.assertTrue(
                    preset["base_url"].startswith(("http://", "https://")),
                    name,
                )
                self.assertTrue(preset["default_model"], name)
                if preset.get("models"):
                    self.assertIn(preset["default_model"], preset["models"], name)

    def test_old_presets_still_there(self):
        presets = get_provider_presets({})
        for name in ("deepseek", "xai", "openrouter", "ollama", "openai", "custom"):
            self.assertIn(name, presets)


class TestCustomProviders(unittest.TestCase):
    def test_custom_provider_resolves_with_env_key(self):
        cfg = _custom_config()
        with mock.patch("angel.config.load_config", return_value=cfg):
            with mock.patch.dict(
                os.environ, {"MYLLM_API_KEY": "sk-test"}, clear=False
            ):
                resolved = resolve_provider("myllm")
        self.assertEqual(resolved.name, "myllm")
        self.assertEqual(resolved.base_url, "https://llm.example.com/v1")
        self.assertEqual(resolved.model, "myllm-1")
        self.assertEqual(resolved.api_key, "sk-test")
        self.assertEqual(resolved.auth, "env")

    def test_custom_provider_unknown_fields_ignored(self):
        cfg = _custom_config()
        with mock.patch("angel.config.load_config", return_value=cfg):
            with mock.patch.dict(
                os.environ, {"MYLLM_API_KEY": "sk-test"}, clear=False
            ):
                resolved = resolve_provider("myllm")
        self.assertEqual(resolved.model, "myllm-1")

    def test_custom_provider_missing_base_url_errors_clearly(self):
        cfg = _config(
            custom_providers={"broken": {"default_model": "m1"}}
        )
        with self.assertRaises(ValueError) as ctx:
            get_provider_presets(cfg)
        self.assertIn("broken", str(ctx.exception))
        self.assertIn("base_url", str(ctx.exception))

    def test_custom_provider_missing_default_model_errors_clearly(self):
        cfg = _config(
            custom_providers={
                "broken": {"base_url": "https://x.example.com/v1"}
            }
        )
        with self.assertRaises(ValueError) as ctx:
            get_provider_presets(cfg)
        self.assertIn("broken", str(ctx.exception))
        self.assertIn("default_model", str(ctx.exception))

    def test_custom_provider_non_http_base_url_rejected(self):
        cfg = _config(
            custom_providers={
                "broken": {
                    "base_url": "file:///etc/passwd",
                    "default_model": "m1",
                }
            }
        )
        with self.assertRaises(ValueError) as ctx:
            get_provider_presets(cfg)
        self.assertIn("http", str(ctx.exception))

    def test_custom_provider_not_an_object_rejected(self):
        cfg = _config(custom_providers={"broken": "https://x.example.com/v1"})
        with self.assertRaises(ValueError) as ctx:
            get_provider_presets(cfg)
        self.assertIn("broken", str(ctx.exception))

    def test_custom_provider_overrides_builtin_same_name(self):
        # Config's top-level provider must differ, otherwise the saved
        # top-level model wins over the preset default (existing rule).
        cfg = _config(
            provider="xai",
            model=None,
            custom_providers={
                "deepseek": {
                    "base_url": "https://proxy.example.com/v1",
                    "default_model": "my-deepseek",
                    "env_key": "DEEPSEEK_API_KEY",
                }
            },
        )
        with mock.patch("angel.config.load_config", return_value=cfg):
            with mock.patch.dict(
                os.environ, {"DEEPSEEK_API_KEY": "sk-test"}, clear=False
            ):
                resolved = resolve_provider("deepseek")
        self.assertEqual(resolved.base_url, "https://proxy.example.com/v1")
        self.assertEqual(resolved.model, "my-deepseek")

    def test_custom_provider_without_env_key_uses_angel_api_key(self):
        cfg = _config(
            custom_providers={
                "keyless": {
                    "base_url": "https://k.example.com/v1",
                    "default_model": "k-1",
                }
            }
        )
        with mock.patch("angel.config.load_config", return_value=cfg):
            with mock.patch.dict(
                os.environ, {"ANGEL_API_KEY": "sk-fallback"}, clear=False
            ):
                resolved = resolve_provider("keyless")
        self.assertEqual(resolved.api_key, "sk-fallback")
        self.assertEqual(resolved.auth, "env")

    def test_custom_provider_missing_key_is_config_error_on_chat(self):
        cfg = _custom_config()
        with mock.patch("angel.config.load_config", return_value=cfg):
            with mock.patch.dict(os.environ, {}, clear=True):
                resolved = resolve_provider("myllm")
        provider = Provider(resolved)
        self.assertFalse(provider.has_credentials())
        with self.assertRaises(ProviderError) as ctx:
            provider.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(ctx.exception.kind, "config")

    def test_known_provider_names_include_custom(self):
        names = known_provider_names(_custom_config())
        self.assertIn("myllm", names)
        self.assertIn("deepseek", names)


class TestFallbackChainWithCustom(unittest.TestCase):
    def test_chain_includes_custom_names(self):
        cfg = _custom_config()
        cfg["fallback_providers"] = ["myllm", "deepseek"]
        chain = resolve_fallback_chain("myllm", cfg)
        self.assertEqual(chain, ["myllm", "deepseek"])

    def test_chain_skips_unknown_names(self):
        cfg = _custom_config()
        cfg["fallback_providers"] = ["nope", "deepseek"]
        chain = resolve_fallback_chain("deepseek", cfg)
        self.assertEqual(chain, ["deepseek"])

    def test_build_chain_with_custom_provider(self):
        def fake_resolver(name):
            return ProviderConfig(
                name=name,
                base_url=f"https://{name}.example.com/v1",
                model=f"{name}-1",
                api_key="sk-test",
                auth="env",
                connector_name=None,
                allowed_hosts=[],
            )

        primary = fake_resolver("myllm")
        chain = build_provider_chain(
            primary,
            ["myllm", "deepseek"],
            resolver=fake_resolver,
        )
        self.assertIsInstance(chain, FallbackProvider)
        self.assertEqual([p.name for p in chain.providers], ["myllm", "deepseek"])


class _FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class TestListModels(unittest.TestCase):
    def _provider(self):
        cfg = ProviderConfig(
            name="myllm",
            base_url="https://llm.example.com/v1",
            model="myllm-1",
            api_key="sk-test",
            auth="env",
            connector_name=None,
            allowed_hosts=[],
        )
        return Provider(cfg)

    def _fake_opener(self, action):
        class FakeOpener:
            def open(self, request, timeout=None):
                return action(request)

        return FakeOpener()

    def _run_list_models(self, action):
        provider = self._provider()
        with mock.patch(
            "angel.providers.build_opener_for",
            return_value=self._fake_opener(action),
        ):
            return provider.list_models()

    def test_returns_model_ids_and_skips_bad_entries(self):
        body = json.dumps(
            {"data": [{"id": "a"}, {"id": "b"}, {"id": 3}, {"nope": True}]}
        ).encode("utf-8")
        models = self._run_list_models(lambda request: _FakeResponse(body))
        self.assertEqual(models, ["a", "b"])

    def test_empty_data_returns_empty_list(self):
        body = json.dumps({"data": []}).encode("utf-8")
        self.assertEqual(
            self._run_list_models(lambda request: _FakeResponse(body)), []
        )

    def test_401_is_auth_and_not_recoverable(self):
        def action(request):
            raise urllib.error.HTTPError(
                "https://llm.example.com/v1/models",
                401,
                "error",
                {},
                io.BytesIO(b'{"error": "bad key"}'),
            )

        with self.assertRaises(ProviderError) as ctx:
            self._run_list_models(action)
        self.assertEqual(ctx.exception.kind, "auth")
        self.assertFalse(ctx.exception.recoverable)

    def test_429_is_rate_limit_and_recoverable(self):
        def action(request):
            raise urllib.error.HTTPError(
                "https://llm.example.com/v1/models",
                429,
                "error",
                {},
                io.BytesIO(b'{"error": "slow down"}'),
            )

        with self.assertRaises(ProviderError) as ctx:
            self._run_list_models(action)
        self.assertEqual(ctx.exception.kind, "rate_limit")
        self.assertTrue(ctx.exception.recoverable)

    def test_network_error_is_network_kind(self):
        def action(request):
            raise urllib.error.URLError(OSError("boom"))

        with self.assertRaises(ProviderError) as ctx:
            self._run_list_models(action)
        self.assertEqual(ctx.exception.kind, "network")

    def test_timeout_is_timeout_kind(self):
        def action(request):
            raise urllib.error.URLError(TimeoutError("slow"))

        with self.assertRaises(ProviderError) as ctx:
            self._run_list_models(action)
        self.assertEqual(ctx.exception.kind, "timeout")

    def test_bad_json_is_parse_error(self):
        models = self._provider()
        with mock.patch(
            "angel.providers.build_opener_for",
            return_value=self._fake_opener(
                lambda request: _FakeResponse(b"not json")
            ),
        ):
            with self.assertRaises(ProviderError) as ctx:
                models.list_models()
        self.assertEqual(ctx.exception.kind, "parse")

    def test_missing_data_is_parse_error(self):
        body = json.dumps({"object": "list"}).encode("utf-8")
        with self.assertRaises(ProviderError) as ctx:
            self._run_list_models(lambda request: _FakeResponse(body))
        self.assertEqual(ctx.exception.kind, "parse")

    def test_fallback_provider_delegates_to_active(self):
        class FakeListed:
            name = "myllm"
            model = "myllm-1"
            base_url = "https://llm.example.com/v1"

            def has_credentials(self):
                return True

            def _redact(self, text, request=None):
                return text

            def list_models(self, timeout=30.0):
                return ["m1", "m2"]

        chain = FallbackProvider([FakeListed()])
        self.assertEqual(chain.list_models(), ["m1", "m2"])


class _FakeCliProvider:
    def __init__(self, models):
        self.name = "myllm"
        self.model = "myllm-1"
        self.base_url = "https://llm.example.com/v1"
        self._models = models

    def has_credentials(self):
        return True

    def list_models(self, timeout=30.0):
        return self._models


class TestCliFlags(unittest.TestCase):
    def test_list_providers_prints_presets(self):
        cfg = _custom_config()
        with mock.patch("angel.cli.load_config", return_value=cfg):
            out = io.StringIO()
            with redirect_stdout(out):
                code = main(["--list-providers"])
        self.assertEqual(code, 0)
        text = out.getvalue()
        self.assertIn("deepseek", text)
        self.assertIn("qwen", text)
        self.assertIn("myllm", text)
        self.assertIn("deepseek-flash", text)

    def test_list_providers_bad_custom_config_errors(self):
        cfg = _config(custom_providers={"broken": {"default_model": "m1"}})
        with mock.patch("angel.cli.load_config", return_value=cfg):
            out = io.StringIO()
            with redirect_stdout(out):
                code = main(["--list-providers"])
        self.assertEqual(code, 1)
        self.assertIn("broken", out.getvalue())

    def test_list_models_prints_ids(self):
        cfg = _custom_config()
        fake_cfg = ProviderConfig(
            name="myllm",
            base_url="https://llm.example.com/v1",
            model="myllm-1",
            api_key="sk-test",
            auth="env",
            connector_name=None,
            allowed_hosts=[],
        )
        with mock.patch("angel.cli.load_config", return_value=cfg):
            with mock.patch(
                "angel.cli.resolve_provider", return_value=fake_cfg
            ):
                with mock.patch(
                    "angel.cli.build_provider_chain",
                    return_value=_FakeCliProvider(["m1", "m2"]),
                ):
                    out = io.StringIO()
                    with redirect_stdout(out):
                        code = main(["--list-models"])
        self.assertEqual(code, 0)
        self.assertIn("m1", out.getvalue())
        self.assertIn("m2", out.getvalue())

    def test_list_models_error_returns_1(self):
        cfg = _custom_config()
        fake_cfg = ProviderConfig(
            name="myllm",
            base_url="https://llm.example.com/v1",
            model="myllm-1",
            api_key="sk-test",
            auth="env",
            connector_name=None,
            allowed_hosts=[],
        )

        class FailingProvider(_FakeCliProvider):
            def list_models(self, timeout=30.0):
                raise ProviderError("认证失败", kind="auth")

        with mock.patch("angel.cli.load_config", return_value=cfg):
            with mock.patch(
                "angel.cli.resolve_provider", return_value=fake_cfg
            ):
                with mock.patch(
                    "angel.cli.build_provider_chain",
                    return_value=FailingProvider([]),
                ):
                    out = io.StringIO()
                    with redirect_stdout(out):
                        code = main(["--list-models"])
        self.assertEqual(code, 1)
        self.assertIn("认证失败", out.getvalue())


if __name__ == "__main__":
    unittest.main()
