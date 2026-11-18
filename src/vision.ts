// src/vision.ts — 视觉模型看屏 plumbing，与 Python 版 nyra/vision.py 同语义。
const VISION_SUBSTRINGS = [
  "vision", "gpt-4o", "gpt-4.1", "gpt-5", "claude", "gemini",
  "qwen-vl", "qwen2-vl", "qwen2.5-vl", "glm-4v", "doubao-seed",
];

export function supportsVision(model: string): boolean {
  const m = (model || "").toLowerCase();
  return VISION_SUBSTRINGS.some((s) => m.includes(s));
}

export function imagePart(imageBase64: string, mimeType = "image/png"): Record<string, unknown> {
  return { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } };
}

export function buildImageMessage(text: string, imageBase64: string, mimeType = "image/png"): Record<string, unknown> {
  return {
    role: "user",
    content: [
      { type: "text", text },
      imagePart(imageBase64, mimeType),
    ],
  };
}
