"""Plaintext http:// API-key leak guard tests (stdlib unittest only).

Covers: http:// is only allowed for loopback hosts (localhost, 127.0.0.1,
::1); an http:// URL on any other host is rejected at config parse time
(custom_providers and the ANGEL_BASE_URL env custom provider) and again
in Provider.chat()/list_models() before any request is sent. The two
rejections use the same message text.
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from angel.config import (  # noqa: E402
    DEFAULT_CONFIG,
    ProviderConfig,
    get_provider_presets,
    plaintext_http_error,
    resolve_provider,
)
from angel.providers import FallbackProvider, Provider, ProviderError  # noqa: E402


def _config(**overrides):
    config = dict(DEFAULT_CONFIG)
    config.update(overrides)
    return config


def _provider(name="bad", base_url="http://api.example.com/v1"):
    return Provider(
        ProviderConfig(
            name=name,
            base_url=base_url,
            model="m1",
            api_key="sk-test",
            auth="env",
            connector_name=None,
            allowed_hosts=[],
        )
    )


def _never_send(*args, **kwargs):
    raise AssertionError("must not send a request for plaintext http")


class TestPlaintextHttpError(unittest.TestCase):
    def test_http_external_rejected_with_clear_message(self):
        message = plaintext_http_error("myllm", "http://api.example.com/v1")
        self.assertIsNotNone(message)
        self.assertIn("myllm", message)
        self.assertIn("http://api.example.com/v1", message)
        self.assertIn("https://", message)
        self.assertIn("明文", message)

    def test_http_loopback_allowed(self):
        for url in (
            "http://localhost:11434/v1",
            "http://LOCALHOST:11434/v1",
            "http://localhost./v1",
            "http://127.0.0.1:8080/v1",
            "http://[::1]:11434/v1",
        ):
            with self.subTest(url=url):
                self.assertIsNone(plaintext_http_error("x", url))

    def test_https_external_allowed(self):
        self.assertIsNone(
            plaintext_http_error("x", "https://api.example.com/v1")
        )

    def test_http_userinfo_trick_does_not_bypass(self):
        # The real target host is evil.com, not the loopback in userinfo.
        self.assertIsNotNone(
            plaintext_http_error("x", "http://127.0.0.1@evil.com/v1")
        )
        # The real target host really is loopback: allowed.
        self.assertIsNone(
            plaintext_http_error("x", "http://user@127.0.0.1:8080/v1")
        )

    def test_builtin_presets_all_comply(self):
        # Ollama's http://localhost:11434 is loopback; the rest are https.
        presets = get_provider_presets({})
        for name, preset in presets.items():
            with self.subTest(provider=name):
                if preset["base_url"] is None:
                    continue
                self.assertIsNone(
                    plaintext_http_error(name, preset["base_url"])
                )


class TestCustomProviderParse(unittest.TestCase):
    def test_custom_http_external_rejected_at_parse(self):
        cfg = _config(
            custom_providers={
                "bad": {
                    "base_url": "http://api.example.com/v1",
                    "default_model": "m1",
                }
            }
        )
        with self.assertRaises(ValueError) as ctx:
            get_provider_presets(cfg)
        self.assertIn("bad", str(ctx.exception))
        self.assertIn("https://", str(ctx.exception))

    def test_custom_http_loopback_accepted_at_parse(self):
        cfg = _config(
            custom_providers={
                "local": {
                    "base_url": "http://localhost:11434/v1",
                    "default_model": "qwen2.5:7b",
                },
                "loop": {
                    "base_url": "http://127.0.0.1:8080/v1",
                    "default_model": "m1",
                },
            }
        )
        presets = get_provider_presets(cfg)
        self.assertEqual(
            presets["local"]["base_url"], "http://localhost:11434/v1"
        )
        self.assertEqual(
            presets["loop"]["base_url"], "http://127.0.0.1:8080/v1"
        )

    def test_custom_https_external_accepted_at_parse(self):
        cfg = _config(
            custom_providers={
                "ok": {
                    "base_url": "https://api.example.com/v1",
                    "default_model": "m1",
                }
            }
        )
        presets = get_provider_presets(cfg)
        self.assertEqual(
            presets["ok"]["base_url"], "https://api.example.com/v1"
        )


class TestEnvCustomProvider(unittest.TestCase):
    def test_env_custom_http_external_rejected(self):
        cfg = _config()
        with mock.patch("angel.config.load_config", return_value=cfg):
            with mock.patch.dict(
                os.environ,
                {
                    "ANGEL_BASE_URL": "http://api.example.com/v1",
                    "ANGEL_MODEL": "m1",
                },
                clear=True,
            ):
                with self.assertRaises(ValueError) as ctx:
                    resolve_provider("custom")
        self.assertIn("https://", str(ctx.exception))

    def test_env_custom_http_localhost_resolves(self):
        cfg = _config()
        with mock.patch("angel.config.load_config", return_value=cfg):
            with mock.patch.dict(
                os.environ,
                {
                    "ANGEL_BASE_URL": "http://localhost:11434/v1",
                    "ANGEL_MODEL": "m1",
                },
                clear=True,
            ):
                resolved = resolve_provider("custom")
        self.assertEqual(resolved.base_url, "http://localhost:11434/v1")
        self.assertEqual(resolved.model, "m1")


class TestProviderRequestGuard(unittest.TestCase):
    def test_chat_http_external_raises_config_without_sending(self):
        provider = _provider()
        with mock.patch(
            "angel.providers.build_opener_for", side_effect=_never_send
        ):
            with self.assertRaises(ProviderError) as ctx:
                provider.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(ctx.exception.kind, "config")
        self.assertFalse(ctx.exception.recoverable)
        self.assertIn("https://", str(ctx.exception))

    def test_list_models_http_external_raises_config_without_sending(self):
        provider = _provider()
        with mock.patch(
            "angel.providers.build_opener_for", side_effect=_never_send
        ):
            with self.assertRaises(ProviderError) as ctx:
                provider.list_models()
        self.assertEqual(ctx.exception.kind, "config")

    def test_parse_and_request_errors_share_message(self):
        cfg = _config(
            custom_providers={
                "bad": {
                    "base_url": "http://api.example.com/v1",
                    "default_model": "m1",
                }
            }
        )
        with self.assertRaises(ValueError) as parse_ctx:
            get_provider_presets(cfg)
        provider = _provider()
        with mock.patch(
            "angel.providers.build_opener_for", side_effect=_never_send
        ):
            with self.assertRaises(ProviderError) as request_ctx:
                provider.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(str(parse_ctx.exception), str(request_ctx.exception))

    def test_fallback_does_not_switch_on_plaintext_config_error(self):
        primary = _provider()
        backup = Provider(
            ProviderConfig(
                name="deepseek",
                base_url="https://api.deepseek.com/v1",
                model="deepseek-flash",
                api_key="sk-test",
                auth="env",
                connector_name=None,
                allowed_hosts=[],
            )
        )
        chain = FallbackProvider([primary, backup])
        with mock.patch(
            "angel.providers.build_opener_for", side_effect=_never_send
        ):
            with self.assertRaises(ProviderError) as ctx:
                chain.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(ctx.exception.kind, "config")
        # A misconfiguration must fail loudly, not silently fall back.
        self.assertEqual(chain.switches, [])


if __name__ == "__main__":
    unittest.main()
