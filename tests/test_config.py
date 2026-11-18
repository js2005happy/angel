"""配置：默认配置不被调用方污染、custom provider 类型校验、兜底开关。"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import nyra.config as config_module
from nyra.config import (
    DEFAULT_CONFIG, get_provider_presets, load_config, resolve_fallback_chain,
)


class LoadConfigTests(unittest.TestCase):
    def test_nested_defaults_are_not_shared(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            with mock.patch.object(config_module, "NYRA_HOME", home):
                first = load_config()
                first["profiles"]["p1"] = {"provider": "xai"}
                first["fallback_providers"].append("nope")
                first["mcp_presets"].append("nope")
                second = load_config()
                self.assertNotIn("p1", second["profiles"])
                self.assertNotIn("nope", second["fallback_providers"])
                self.assertNotIn("nope", second["mcp_presets"])
                self.assertNotIn("p1", DEFAULT_CONFIG["profiles"])
                self.assertNotIn("nope", DEFAULT_CONFIG["fallback_providers"])

    def test_corrupt_config_falls_back_to_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            (home / "config.json").write_text("{broken", encoding="utf-8")
            with mock.patch.object(config_module, "NYRA_HOME", home):
                config = load_config()
            self.assertEqual(config["provider"], DEFAULT_CONFIG["provider"])


class CustomProviderTests(unittest.TestCase):
    def test_string_models_is_rejected_not_split_into_chars(self):
        config = {"custom_providers": {
            "mine": {"base_url": "https://api.example.com/v1",
                     "default_model": "m1", "models": "m1"},
        }}
        with self.assertRaises(ValueError):
            get_provider_presets(config)

    def test_string_allowed_hosts_is_rejected(self):
        config = {"custom_providers": {
            "mine": {"base_url": "https://api.example.com/v1",
                     "default_model": "m1", "allowed_hosts": "api.example.com"},
        }}
        with self.assertRaises(ValueError):
            get_provider_presets(config)

    def test_list_models_accepted(self):
        config = {"custom_providers": {
            "mine": {"base_url": "https://api.example.com/v1",
                     "default_model": "m1", "models": ["m1", "m2"]},
        }}
        presets = get_provider_presets(config)
        self.assertEqual(presets["mine"]["models"], ["m1", "m2"])


class FallbackFlagTests(unittest.TestCase):
    def test_empty_env_flag_falls_through_to_config(self):
        # NYRA_FALLBACK="" 等于未设置：config 开了就开，没开就不开。
        config = {"fallback_enabled": True, "fallback_providers": ["xai"]}
        with mock.patch.dict(os.environ, {"NYRA_FALLBACK": ""}, clear=False):
            chain = resolve_fallback_chain("deepseek", config)
        self.assertEqual(chain[:2], ["deepseek", "xai"])
        config = {"fallback_enabled": False, "fallback_providers": ["xai"]}
        with mock.patch.dict(os.environ, {"NYRA_FALLBACK": ""}, clear=False):
            self.assertEqual(
                resolve_fallback_chain("deepseek", config), ["deepseek"])

    def test_empty_config_string_does_not_enable_fallback(self):
        config = {"fallback_enabled": "", "fallback_providers": ["xai"]}
        with mock.patch.dict(os.environ, {}, clear=True):
            # 清掉 NYRA_FALLBACK，避免环境干扰（clear=True 也清 PATH 等，
            # 只影响本次调用内的 _env 读取）。
            self.assertEqual(
                resolve_fallback_chain("deepseek", config), ["deepseek"])

    def test_explicit_one_still_enables(self):
        config = {"fallback_enabled": False, "fallback_providers": ["xai"]}
        with mock.patch.dict(os.environ, {"NYRA_FALLBACK": "1"}, clear=False):
            chain = resolve_fallback_chain("deepseek", config)
        self.assertEqual(chain[:2], ["deepseek", "xai"])


if __name__ == "__main__":
    unittest.main()
