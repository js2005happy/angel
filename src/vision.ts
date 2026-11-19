// src/vision.ts — 视觉模型看屏 plumbing，与 Python 版 nyra/vision.py 同语义。
const VISION_SUBSTRINGS = [
  "vision", "vl", "gpt-4o", "gpt-4.1", "gpt-5", "claude", "gemini",
  "qwen-vl", "qwen2-vl", "qwen2.5-vl", "glm-4v", "doubao-seed",
];

export const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * 当前生效的视觉模型子串表：环境变量 NYRA_VISION_MODELS（逗号分隔）
 * 设置后完全替代内置表（不是追加），匹配时忽略大小写——与 Python
 * 版 _vision_substrings() 同语义。未设置或只含空白时用内置表。
 */
export function visionSubstrings(): string[] {
  const override = (process.env.NYRA_VISION_MODELS ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return override.length > 0 ? override : [...VISION_SUBSTRINGS];
}

/**
 * 对应 Python supports_vision(provider_name, model)。
 * TS 侧历史签名是 supportsVision(model)，保持兼容：第一个参数仍是
 * model；model 为空时回退到 providerName。匹配忽略大小写。
 * 注意与 Python 内置表的两处有意差异（现有 Node 测试已锁定）：
 * Python 表含 "grok-4"，本表不含，所以 grok-4.3 在这里返回 false；
 * Python 表用 "claude-sonnet"/"claude-opus"，本表用更宽的 "claude"。
 */
export function supportsVision(model: string, providerName?: string): boolean {
  const target = (model || "").trim().toLowerCase()
    || (providerName || "").trim().toLowerCase();
  if (!target) return false;
  return visionSubstrings().some((s) => target.includes(s));
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

/**
 * 对应 Python image_part(png_bytes)：只接受 PNG 字节，非 PNG 抛错
 * （审查修复 F-L1 的口径）。与上面接收 base64 字符串的 imagePart
 * 并存：老调用方传字符串，新调用方（computer_screenshot 的 Buffer）
 * 走这里。
 */
export function imagePartFromBytes(pngBytes: Uint8Array | Buffer): Record<string, unknown> {
  if (!(pngBytes instanceof Uint8Array)) {
    throw new Error("image_part 需要 PNG 字节");
  }
  const data = Buffer.from(pngBytes);
  if (!data.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error("image_part 需要 PNG 字节，收到的数据不是 PNG");
  }
  return imagePart(data.toString("base64"), "image/png");
}

/** 对应 Python build_image_message(text, png_bytes)。 */
export function buildImageMessageFromBytes(text: string, pngBytes: Uint8Array | Buffer): Record<string, unknown> {
  return {
    role: "user",
    content: [
      { type: "text", text },
      imagePartFromBytes(pngBytes),
    ],
  };
}
