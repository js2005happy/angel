// tests/node/test-config-transfer.test.ts — 配置导出/导入（对齐 Alma Settings Export/Import）。
// 两条安全纪律要锁死：导出默认剔除密钥；导入默认忽略会削弱安全的字段。
import { test, expect } from "bun:test";
import {
  exportConfig, previewImport, formatImportPreview, redactSecrets, CONFIG_FORMAT, CONFIG_FORMAT_VERSION,
} from "../../src/configTransfer.ts";

const CONFIG = {
  model: "deepseek-v4-pro",
  max_cost_usd: 5,
  permissions: { allow: ["Bash(git *)"], deny: ["Bash(rm -rf *)"] },
  custom_providers: {
    mine: { base_url: "http://x", api_key: "sk-secret-123", env_key: "MY_KEY" },
  },
  vault_token: "tok-abc",
  nested: { deeper: { password: "p@ss" } },
};

test("导出默认剔除密钥（含嵌套），并列出被剔除的路径", () => {
  const { payload, redacted } = exportConfig(CONFIG, { now: "2026-01-01T00:00:00Z" });
  const json = JSON.stringify(payload);
  expect(json).not.toContain("sk-secret-123");
  expect(json).not.toContain("tok-abc");
  expect(json).not.toContain("p@ss");
  // env_key 是变量名不是密钥，应保留
  expect(json).toContain("MY_KEY");
  expect(redacted.length).toBe(3);
  expect(redacted.some((p) => p.includes("api_key"))).toBe(true);
});

test("导出头部带 format/version/时间戳", () => {
  const { payload } = exportConfig(CONFIG, { now: "2026-01-01T00:00:00Z" });
  expect(payload.format).toBe(CONFIG_FORMAT);
  expect(payload.version).toBe(CONFIG_FORMAT_VERSION);
  expect(payload.exported_at).toBe("2026-01-01T00:00:00Z");
});

test("--include-secrets 时保留密钥（自担风险）", () => {
  const { payload, redacted } = exportConfig(CONFIG, { includeSecrets: true });
  expect(JSON.stringify(payload)).toContain("sk-secret-123");
  expect(redacted).toEqual([]);
});

test("redactSecrets 不改原对象", () => {
  const copy = JSON.parse(JSON.stringify(CONFIG));
  redactSecrets(CONFIG);
  expect(CONFIG).toEqual(copy);
});

test("导入：格式不对直接拒绝", () => {
  expect(previewImport({ model: "x" }, {}).ok).toBe(false);
  expect(previewImport("字符串", {}).ok).toBe(false);
  expect(previewImport(null, {}).ok).toBe(false);
});

test("导入：版本高于本程序 → 拒绝并提示升级", () => {
  const p = previewImport({ format: CONFIG_FORMAT, version: CONFIG_FORMAT_VERSION + 1, config: {} }, {});
  expect(p.ok).toBe(false);
  expect(p.errors[0]).toContain("升级");
});

test("导入：危险字段默认忽略，需 --allow-dangerous", () => {
  const incoming = { format: CONFIG_FORMAT, version: 1, config: { sandbox: "local", permissions: { deny: [] }, model: "cheap" } };
  const blocked = previewImport(incoming, { sandbox: "bwrap", permissions: { deny: ["x"] }, model: "main" });
  expect(blocked.ok).toBe(true);
  expect(blocked.merged.sandbox).toBe("bwrap"); // 未被覆盖
  expect(blocked.merged.model).toBe("cheap");   // 普通字段照常导入
  expect(blocked.warnings.length).toBe(2);

  const allowed = previewImport(incoming, { sandbox: "bwrap" }, { allowDangerous: true });
  expect(allowed.merged.sandbox).toBe("local");
});

test("导入：密钥字段永不覆盖本机凭据", () => {
  const p = previewImport(
    { format: CONFIG_FORMAT, version: 1, config: { api_key: "attacker-key" } },
    { api_key: "real-key" },
    { allowDangerous: true },
  );
  expect(p.merged.api_key).toBe("real-key");
  expect(p.warnings.some((w) => w.includes("密钥"))).toBe(true);
});

test("导入：区分覆盖与新增", () => {
  const p = previewImport(
    { format: CONFIG_FORMAT, version: 1, config: { model: "new", brand_new: 1 } },
    { model: "old" },
  );
  expect(p.willOverwrite).toEqual(["model"]);
  expect(p.willAdd).toEqual(["brand_new"]);
});

test("formatImportPreview：拒绝时不打印覆盖清单", () => {
  const text = formatImportPreview(previewImport({}, {}), "x.json");
  expect(text).toContain("不可导入");
  expect(text).not.toContain("将覆盖");
});

test("formatImportPreview：可导入时打印覆盖/新增/警告", () => {
  const p = previewImport(
    { format: CONFIG_FORMAT, version: 1, config: { model: "new", sandbox: "local" } },
    { model: "old", sandbox: "bwrap" },
  );
  const text = formatImportPreview(p, "x.json");
  expect(text).toContain("将覆盖：model");
  expect(text).toContain("⚠️");
});
