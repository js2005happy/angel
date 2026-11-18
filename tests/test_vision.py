"""Tests for nyra.vision and the provider part-list pass-through.

Mock-only: the provider test captures the HTTP request body with a
fake opener; no real model is called.
"""

import base64
import json
import os
import unittest
from unittest import mock

from nyra.providers import (
    Provider,
    ProviderConfig,
    _normalize_messages,
    _serialize_codex_prompt,
)
from nyra.vision import build_image_message, image_part, supports_vision

PNG_MAGIC = bytes((0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
PNG = PNG_MAGIC + b"fake-png-body"


class _FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _CaptureOpener:
    def __init__(self):
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append(request)
        body = json.dumps(
            {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}
        ).encode("utf-8")
        return _FakeResponse(body)


class TestImagePart(unittest.TestCase):
    def test_data_url_format(self):
        part = image_part(PNG)
        self.assertEqual(part["type"], "image_url")
        url = part["image_url"]["url"]
        self.assertTrue(url.startswith("data:image/png;base64,"))
        self.assertEqual(
            base64.b64decode(url[len("data:image/png;base64,"):]), PNG
        )

    def test_rejects_non_png(self):
        with self.assertRaises(ValueError):
            image_part(b"not a png")
        with self.assertRaises(ValueError):
            image_part(b"")
        with self.assertRaises(ValueError):
            image_part("not bytes")

    def test_build_image_message(self):
        message = build_image_message("看这张图，按钮在哪？", PNG)
        self.assertEqual(message["role"], "user")
        content = message["content"]
        self.assertEqual(len(content), 2)
        self.assertEqual(
            content[0], {"type": "text", "text": "看这张图，按钮在哪？"}
        )
        self.assertEqual(content[1]["type"], "image_url")
        self.assertTrue(
            content[1]["image_url"]["url"].startswith("data:image/png;base64,")
        )


class TestSupportsVision(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ)
        self.env.start()
        os.environ.pop("NYRA_VISION_MODELS", None)
        self.addCleanup(self.env.stop)

    def test_builtin_table_positive(self):
        for model in (
            "gpt-4o", "gpt-4o-mini", "gpt-4-vision-preview",
            "grok-4", "grok-4.1",
            "claude-sonnet-4", "claude-opus-4",
            "qwen-vl", "qwen2-vl-7b", "deepseek-vl",
            "gemini-1.5-pro", "internvl2-8b",
        ):
            self.assertTrue(supports_vision("any", model), model)

    def test_builtin_table_negative(self):
        for model in (
            "deepseek-chat", "gpt-3.5-turbo", "claude-2",
            "llama-3-70b", "qwen2.5-72b", "grok-3",
        ):
            self.assertFalse(supports_vision("any", model), model)

    def test_case_insensitive_and_provider_fallback(self):
        self.assertTrue(supports_vision("openai", "GPT-4O"))
        self.assertFalse(supports_vision(None, None))
        self.assertFalse(supports_vision("openai", ""))
        self.assertFalse(supports_vision("", ""))

    def test_env_override_replaces_table(self):
        os.environ["NYRA_VISION_MODELS"] = "my-vision-1, other-vl"
        self.assertTrue(supports_vision("any", "my-vision-1"))
        self.assertTrue(supports_vision("any", "OTHER-VL-2"))
        self.assertFalse(supports_vision("any", "gpt-4o"))

    def test_env_blank_means_builtin(self):
        os.environ["NYRA_VISION_MODELS"] = "  ,  "
        self.assertTrue(supports_vision("any", "gpt-4o"))
        self.assertFalse(supports_vision("any", "deepseek-chat"))


class TestNormalizeMessages(unittest.TestCase):
    def test_str_unchanged(self):
        messages = [{"role": "user", "content": "hi"}]
        self.assertEqual(_normalize_messages(messages), messages)

    def test_list_passed_through(self):
        parts = [
            {"type": "text", "text": "看图"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,xx"}},
        ]
        out = _normalize_messages([{"role": "user", "content": parts}])
        self.assertEqual(out[0]["content"], parts)

    def test_malformed_parts_dropped(self):
        parts = [
            {"type": "text", "text": "ok"},
            {"no-type": True},
            "not-a-dict",
            {"type": "image_url", "image_url": {"url": "data:,"}},
        ]
        out = _normalize_messages([{"role": "user", "content": parts}])
        self.assertEqual(out[0]["content"], [parts[0], parts[3]])

    def test_other_content_coerced(self):
        out = _normalize_messages([{"role": "user", "content": 42}])
        self.assertEqual(out[0]["content"], "42")
        out = _normalize_messages([{"role": "user", "content": None}])
        self.assertIsNone(out[0]["content"])

    def test_non_dict_message_passed_through(self):
        self.assertEqual(_normalize_messages(["weird"]), ["weird"])


class TestProviderPassThrough(unittest.TestCase):
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

    def _chat(self, provider, messages):
        opener = _CaptureOpener()
        with mock.patch(
            "nyra.providers.build_opener_for", return_value=opener
        ):
            provider.chat(messages)
        return json.loads(opener.requests[0].data.decode("utf-8"))

    def test_part_list_reaches_wire(self):
        parts = [
            {"type": "text", "text": "看这张图"},
            image_part(PNG),
        ]
        sent = self._chat(
            self._provider(),
            [{"role": "user", "content": parts}],
        )
        self.assertEqual(sent["messages"][0]["content"], parts)
        self.assertEqual(sent["model"], "myllm-1")

    def test_str_still_plain(self):
        sent = self._chat(
            self._provider(),
            [{"role": "user", "content": "hello"}],
        )
        self.assertEqual(sent["messages"][0]["content"], "hello")

    def test_codex_prompt_flattens_parts_to_text(self):
        parts = [
            {"type": "text", "text": "看图"},
            image_part(PNG),
        ]
        prompt = _serialize_codex_prompt(
            [{"role": "user", "content": parts}]
        )
        self.assertIn("[user]", prompt)
        self.assertIn("看图", prompt)
        self.assertNotIn("data:image/png", prompt)


if __name__ == "__main__":
    unittest.main()
