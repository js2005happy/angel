// tests/node/test-vision.test.ts — 对应 tests/test_vision.py（16 个唯一测试）的核心项。
import { test, expect } from "bun:test";
import { supportsVision, imagePart, buildImageMessage } from "../../src/vision.ts";

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
