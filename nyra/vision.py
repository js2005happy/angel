"""Vision plumbing: screenshots as model-visible image parts.

把 computer_screenshot 的 PNG 变成视觉模型能直接看的 OpenAI 兼容
content part。只用标准库。

接线点（只写文档，不动代码）：
- agent.py 主循环在工具结果处（约 372 行，
  ``{"role": "tool", "content": ...}``）拿到 computer_screenshot
  的结果后，读证据目录里那张 PNG 的字节，用 build_image_message
  拼一条 ``{"role": "user", "content": [文本 part, 图片 part]}``
  的消息，挂进下一次模型请求。
- agent.py 目前冻结，这一步等 A–E 合并后再接；本模块只把
  plumbing（part 构造 + 模型是否视觉 + provider 透传）做好。
- providers.py 的 Provider.chat 已能透传 content 为 part 列表
  的消息（str 照旧、list 原样送出，OpenAI 兼容端点直接收）；
  Codex CLI 是纯文本，_serialize_codex_prompt 会把 part 列表
  展平成文本（图片 part 不出声），不走这条路。

环境变量 NYRA_VISION_MODELS：逗号分隔的模型名子串，设置后
完全替代内置表（不是追加），匹配时忽略大小写。
"""

import base64
import os

# Built-in vision-model substrings (matched case-insensitively
# against the model name). Kept small and explicit; anything new
# goes here or in NYRA_VISION_MODELS.
_VISION_MODEL_SUBSTRINGS = (
    "vision",  # gpt-4-vision, llava-vision, gemini-vision, ...
    "vl",  # qwen-vl, qwen2-vl, internvl, deepseek-vl, ...
    "gpt-4o",  # multimodal by default
    "grok-4",  # Grok 4 is multimodal
    "claude-sonnet",
    "claude-opus",
    "gemini",  # all Gemini models are multimodal
)

_PNG_MAGIC = bytes((0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))


def _vision_substrings() -> tuple[str, ...]:
    override = os.environ.get("NYRA_VISION_MODELS", "")
    parts = tuple(
        part.strip().lower()
        for part in override.split(",")
        if part.strip()
    )
    if parts:
        return parts
    return _VISION_MODEL_SUBSTRINGS


def supports_vision(provider_name: str | None, model: str | None) -> bool:
    """True when the named model can take image parts.

    Matches the built-in substring table against the model name
    (case-insensitive); when the model is empty, the provider name
    is checked instead. NYRA_VISION_MODELS, when set, replaces the
    built-in table entirely.
    """
    target = (model or "").strip().lower()
    if not target:
        target = (provider_name or "").strip().lower()
    if not target:
        return False
    return any(sub in target for sub in _vision_substrings())


def image_part(png_bytes: bytes) -> dict:
    """Build an OpenAI-compatible image content part from PNG bytes."""
    if not isinstance(png_bytes, (bytes, bytearray)):
        raise ValueError("image_part 需要 PNG 字节")
    data = bytes(png_bytes)
    if not data.startswith(_PNG_MAGIC):
        raise ValueError("image_part 需要 PNG 字节，收到的数据不是 PNG")
    encoded = base64.b64encode(data).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64," + encoded},
    }


def build_image_message(text: str, png_bytes: bytes) -> dict:
    """Build a user message carrying text plus a screenshot image."""
    return {
        "role": "user",
        "content": [
            {"type": "text", "text": text},
            image_part(png_bytes),
        ],
    }
