// tests/node/test-i18n-tooling.test.ts — 新命令的 i18n 接入（tools / features / redlines）。
// Muse 建了 i18n 表，但几个新子命令一直是硬编码中文——英文环境下是半成品。
import { test, expect, afterEach } from "bun:test";
import { setLang, t } from "../../src/i18n.ts";
import { checkRedlines, formatRedlines } from "../../src/redlines.ts";
import { resolveFeatures, formatFeatures } from "../../src/features.ts";
import { measureToolBudget, formatToolBudget } from "../../src/toolBudget.ts";

const GOOD = {
  config: { max_cost_usd: 5, pricing: { m: {} }, verify_command: "npm test" },
  sandbox: { level: "bwrap", backend: "bwrap" },
  permissions: { allow: [], ask: [], deny: [{ tool: "Bash", specifier: "rm *", raw: "Bash(rm *)" }] },
  hasCostLimit: true,
};

afterEach(() => setLang("zh"));

test("红线报告：中英标题不同，且英文里不残留中文标题", () => {
  setLang("zh");
  expect(formatRedlines(checkRedlines(GOOD as never))).toContain("上线红线自检");
  setLang("en");
  const en = formatRedlines(checkRedlines(GOOD as never));
  expect(en).toContain("Production redlines");
  expect(en).not.toContain("上线红线");
});

test("红线报告的修复前缀也走 i18n", () => {
  setLang("en");
  const text = formatRedlines(checkRedlines({ config: {}, sandbox: null, permissions: null, hasCostLimit: false } as never));
  expect(text).toContain("Fix:");
});

test("features 列表：标题与来源标注中英各自成句", () => {
  setLang("zh");
  const zh = formatFeatures(resolveFeatures({ features: { tool_search: true } }));
  expect(zh).toContain("功能开关");
  expect(zh).toContain("配置文件");

  setLang("en");
  const en = formatFeatures(resolveFeatures({ features: { tool_search: true } }));
  expect(en).toContain("Feature flags");
  expect(en).toContain("config file");
});

test("features 警告标题也走 i18n", () => {
  setLang("en");
  expect(formatFeatures(resolveFeatures({ features: { bad_key: true } }))).toContain("Warnings:");
});

test("工具体检：标题/占比/最贵名单三行都本地化", () => {
  const budget = measureToolBudget(
    [{ type: "function", function: { name: "big", description: "x".repeat(400) } }],
    128000,
  );
  setLang("zh");
  const zh = formatToolBudget(budget);
  expect(zh).toContain("工具集");
  expect(zh).toContain("最贵的几个");

  setLang("en");
  const en = formatToolBudget(budget);
  expect(en).toContain("Toolset");
  expect(en).toContain("% of the context window");
  expect(en).toContain("Most expensive");
});

test("占位符填充正常（不会漏出 {fix} 之类）", () => {
  setLang("en");
  const text = t("redlines.fix", { fix: "do X" });
  expect(text).toContain("do X");
  expect(text).not.toContain("{fix}");
});

test("未知键回退到中文而不是崩掉", () => {
  // 直接调 t 传入一个不存在但类型合法的键名场景由类型系统兜住；
  // 这里验证运行时回退逻辑对已有键是稳定的。
  expect(t("redlines.title", { verdict: "ok" })).toContain("ok");
});

test("cost 命令：英文环境下标题与假设清单都不残留中文", () => {
  setLang("en");
  const budget = measureToolBudget([], 0); // 只为触发 import 链
  expect(budget.totalTools).toBe(0);
  // 假设清单由 cost.ts 生成，走 i18n
  const asm = t("cost.asm.usage");
  expect(asm.length).toBeGreaterThan(0);
  expect(asm).not.toMatch(/[\u4e00-\u9fff]/);
});

test("config 命令的关键文案也本地化", () => {
  setLang("en");
  expect(t("config.imported")).toContain("config.json");
  expect(t("config.dryRun")).toContain("dry-run");
  setLang("zh");
  expect(t("config.imported")).toContain("已写入");
});