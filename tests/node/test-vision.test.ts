// tests/node/test-vision.test.ts — 对应 tests/test_vision.py（16 个唯一测试）的核心项。
import { test, expect } from "bun:test";
import {
  supportsVision,
  imagePart,
  buildImageMessage,
  imagePartFromBytes,
  buildImageMessageFromBytes,
  visionSubstrings,
} from "../../src/vision.ts";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([PNG_MAGIC, Buffer.from("fake-png-body")]);

test("VisionTest.test_supports_vision_models", () => {
  expect(supportsVision("gpt-4o")).toBe(true);
  expect(supportsVision("claude-sonnet-4")).toBe(true);
  expect(supportsVision("gemini-2.0-flash")).toBe(true);
  expect(supportsVision("deepseek-flash")).toBe(false);
  expect(supportsVision("grok-4.3")).toBe(false);
  expect(supportsVision("qwen2.5:7b")).toBe(false);
});

test("VisionTest.test_image_part_shape", () => {
  const part = imagePart("aGVsbG8=", "image/png");
  expect(part.type).toBe("image_url");
  expect((part.image_url as Record<string, unknown>).url).toContain("data:image/png;base64,aGVsbG8=");
});

test("VisionTest.test_image_part_default_png", () => {
  const part = imagePart("xyz");
  expect((part.image_url as Record<string, unknown>).url).toContain("image/png");
});

test("VisionTest.test_build_image_message", () => {
  const msg = buildImageMessage("看这张图", "aGVsbG8=");
  expect(msg.role).toBe("user");
  const content = msg.content as unknown[];
  expect(content.length).toBe(2);
  expect((content[0] as Record<string, unknown>).type).toBe("text");
  expect((content[0] as Record<string, unknown>).text).toBe("看这张图");
  expect((content[1] as Record<string, unknown>).type).toBe("image_url");
});

// ---- 新增行为（第 4 阶段移植）：与 Python nyra/vision.py 对应的
// bytes 入口、provider 回退、NYRA_VISION_MODELS 环境变量覆盖 ----

test("VisionTest.test_supports_vision_vl_generic", () => {
  expect(supportsVision("deepseek-vl")).toBe(true);
  expect(supportsVision("internvl2-8b")).toBe(true);
});

test("VisionTest.test_supports_vision_provider_fallback", () => {
  expect(supportsVision("", "gemini-2.0")).toBe(true);
  expect(supportsVision("", "openai")).toBe(false);
  expect(supportsVision("", "")).toBe(false);
  expect(supportsVision("GPT-4O")).toBe(true);
});

test("VisionTest.test_supports_vision_env_override_replaces_table", () => {
  const prev = process.env.NYRA_VISION_MODELS;
  try {
    process.env.NYRA_VISION_MODELS = "my-vision-1, other-vl";
    expect(visionSubstrings()).toEqual(["my-vision-1", "other-vl"]);
    expect(supportsVision("my-vision-1")).toBe(true);
    expect(supportsVision("OTHER-VL-2")).toBe(true);
    expect(supportsVision("gpt-4o")).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.NYRA_VISION_MODELS;
    else process.env.NYRA_VISION_MODELS = prev;
  }
});

test("VisionTest.test_supports_vision_env_blank_means_builtin", () => {
  const prev = process.env.NYRA_VISION_MODELS;
  try {
    process.env.NYRA_VISION_MODELS = "  ,  ";
    expect(supportsVision("gpt-4o")).toBe(true);
    expect(supportsVision("deepseek-chat")).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.NYRA_VISION_MODELS;
    else process.env.NYRA_VISION_MODELS = prev;
  }
});

test("VisionTest.test_image_part_from_bytes", () => {
  const part = imagePartFromBytes(PNG);
  expect(part.type).toBe("image_url");
  const url = (part.image_url as Record<string, unknown>).url as string;
  expect(url.startsWith("data:image/png;base64,")).toBe(true);
  expect(Buffer.from(url.slice("data:image/png;base64,".length), "base64").equals(PNG)).toBe(true);
});

test("VisionTest.test_image_part_from_bytes_rejects_non_png", () => {
  expect(() => imagePartFromBytes(Buffer.from("not a png"))).toThrow(
    "image_part 需要 PNG 字节，收到的数据不是 PNG",
  );
  expect(() => imagePartFromBytes(Buffer.from(""))).toThrow(
    "image_part 需要 PNG 字节，收到的数据不是 PNG",
  );
  expect(() => imagePartFromBytes("not bytes" as never)).toThrow(
    "image_part 需要 PNG 字节",
  );
});

test("VisionTest.test_build_image_message_from_bytes", () => {
  const msg = buildImageMessageFromBytes("看这张图，按钮在哪？", PNG);
  expect(msg.role).toBe("user");
  const content = msg.content as unknown[];
  expect(content.length).toBe(2);
  expect(content[0]).toEqual({ type: "text", text: "看这张图，按钮在哪？" });
  expect((content[1] as Record<string, unknown>).type).toBe("image_url");
});
