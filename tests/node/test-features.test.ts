// tests/node/test-features.test.ts — 功能开关（对齐 Codex 的 [features] + --enable/--disable）。
// 关键契约：优先级 CLI > config > 默认；未知开关名必须告警（不静默忽略）。
import { test, expect } from "bun:test";
import { resolveFeatures, featureOn, formatFeatures, FEATURES } from "../../src/features.ts";

test("默认值：未配置时按登记的默认值", () => {
  const r = resolveFeatures({});
  expect(r.features.length).toBe(FEATURES.length);
  for (const f of r.features) {
    expect(f.enabled).toBe(f.defaultEnabled);
    expect(f.source).toBe("default");
  }
  expect(featureOn(r, "tool_search")).toBe(false); // 改变模型行为的能力默认关
  expect(featureOn(r, "resume_idempotent")).toBe(true);
});

test("config.features 生效，来源标成 config", () => {
  const r = resolveFeatures({ features: { tool_search: true } });
  expect(featureOn(r, "tool_search")).toBe(true);
  expect(r.features.find((f) => f.name === "tool_search")?.source).toBe("config");
});

test("CLI 覆盖 config", () => {
  const r = resolveFeatures({ features: { tool_search: true } }, { disable: ["tool_search"] });
  expect(featureOn(r, "tool_search")).toBe(false);
  expect(r.features.find((f) => f.name === "tool_search")?.source).toBe("cli");
});

test("CLI enable 能打开默认关的开关", () => {
  const r = resolveFeatures({}, { enable: ["tool_search"] });
  expect(featureOn(r, "tool_search")).toBe(true);
});

test("同名同时 enable 与 disable → disable 优先（关掉更安全）", () => {
  const r = resolveFeatures({}, { enable: ["tool_search"], disable: ["tool_search"] });
  expect(featureOn(r, "tool_search")).toBe(false);
});

test("未知开关名进 warnings，不静默忽略", () => {
  const r = resolveFeatures({ features: { tool_serch: true } }, { enable: ["nope"] });
  expect(r.warnings.some((w) => w.includes("tool_serch"))).toBe(true);
  expect(r.warnings.some((w) => w.includes("nope"))).toBe(true);
});

test("非布尔值与畸形 features 都被告警", () => {
  expect(resolveFeatures({ features: { tool_search: "yes" } }).warnings.length).toBeGreaterThan(0);
  expect(resolveFeatures({ features: [] }).warnings.length).toBeGreaterThan(0);
});

test("featureOn 对未登记的名字返回 false（不猜测）", () => {
  const r = resolveFeatures({});
  expect(featureOn(r, "not_a_feature")).toBe(false);
});

test("大小写与空白不敏感", () => {
  const r = resolveFeatures({ features: { TOOL_SEARCH: true } });
  expect(featureOn(r, "tool_search")).toBe(true);
});

test("formatFeatures 列出状态/来源/说明与警告", () => {
  const text = formatFeatures(resolveFeatures({ features: { tool_search: true, bad_key: 1 } }));
  expect(text).toContain("tool_search");
  expect(text).toContain("配置文件");
  expect(text).toContain("⚠️");
  expect(text).toMatch(/✅|⬜/);
});
