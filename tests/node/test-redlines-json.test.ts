// tests/node/test-redlines-json.test.ts — `nyra redlines --json` 的机器可读契约。
//
// 红线的 `code` 本来就是"稳定短码，方便 CI/脚本判定"，但输出一直只有人读的文本。
// 这组测试锁住：CI 能按 code 白名单放行、能统计等级分布，不必去解析中文表格。
//
// 关键设计：等级映射成**布尔**（`has_fail` / `has_warn`）+ **计数**（`counts`），
// 让 CI 不用自己数字符串——自定义判定逻辑越少，误判越少。
import { test, expect } from "bun:test";
import { checkRedlines, toRedlinesJson, REDLINES_JSON_SCHEMA } from "../../src/redlines.ts";

const CLEAN = {
  config: {},
  sandbox: { level: "bwrap", backend: "bwrap" },
  hasCostLimit: true,
  knownTools: ["shell"],
};

/** danger-full-access 是确定的 fail 来源（sandbox-danger-mode）。 */
const DIRTY = { ...CLEAN, config: { sandbox_mode: "danger-full-access" } };

test("R1 schema_version 是显式常量", () => {
  expect(REDLINES_JSON_SCHEMA).toBe(1);
  expect(toRedlinesJson(checkRedlines(CLEAN as never)).schema_version).toBe(1);
});

test("R2 字段顺序稳定（契约：只加不改）", () => {
  expect(Object.keys(toRedlinesJson(checkRedlines(CLEAN as never)))).toEqual([
    "schema_version", "ok", "verdict", "has_fail", "has_warn", "counts", "findings",
  ]);
});

test("R3 干净配置：ok / has_fail=false / counts.fail=0", () => {
  const j = toRedlinesJson(checkRedlines(CLEAN as never));
  expect(j.ok).toBe(true);
  expect(j.has_fail).toBe(false);
  expect(j.counts.fail).toBe(0);
});

test("R4 踩红线（danger-full-access）：ok=false 且 has_fail=true", () => {
  const j = toRedlinesJson(checkRedlines(DIRTY as never));
  expect(j.ok).toBe(false);
  expect(j.has_fail).toBe(true);
  expect(j.findings.some((f) => f.level === "fail" && f.code === "sandbox-danger-mode")).toBe(true);
});

test("R5 counts 与 findings 逐条一致（不会各说各话）", () => {
  const j = toRedlinesJson(checkRedlines(DIRTY as never));
  const tally = { ok: 0, warn: 0, fail: 0 };
  for (const f of j.findings) tally[f.level] += 1;
  expect(j.counts).toEqual(tally);
});

test("R6 每条 finding 都带稳定 code（CI 白名单靠它）", () => {
  const j = toRedlinesJson(checkRedlines(DIRTY as never));
  expect(j.findings.length).toBeGreaterThan(0);
  for (const f of j.findings) {
    expect(typeof f.code).toBe("string");
    expect(f.code.length).toBeGreaterThan(0);
  }
});

test("R7 fix 缺省时是 null（不是 undefined，JSON 里不能丢字段）", () => {
  const j = toRedlinesJson(checkRedlines(DIRTY as never));
  for (const f of j.findings) {
    expect(f.fix === null || typeof f.fix === "string").toBe(true);
    expect("fix" in f).toBe(true);
  }
});

test("R8 可 JSON.stringify / parse（CI 消费）", () => {
  const round = JSON.parse(JSON.stringify(toRedlinesJson(checkRedlines(DIRTY as never))));
  expect(round.has_fail).toBe(true);
  expect(Array.isArray(round.findings)).toBe(true);
});
