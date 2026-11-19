// tests/node/test-enforced-config.test.ts — 管理员锁定段（config.enforced）。
//
// 问题：config.json 是普通文件，agent 自己或用户都能改。于是「红线」只是建议——
// max_cost_usd 删掉就没硬顶，sandbox 改成 local 就没隔离，deny_read_globs 清空就能读 .env。
//
// 这不是强安全边界（能改文件的人仍能改 enforced），但挡住了最现实的一条路：
// agent 顺手改配置绕过硬顶。测试锁的是**优先级**与**不静默**。
import { test, expect } from "bun:test";
import { resolveEnforced, applyEnforced, formatEnforced, ENFORCEABLE_KEYS } from "../../src/enforcedConfig.ts";

test("没有 enforced 段：空值 + 无拒绝键", () => {
  expect(resolveEnforced({})).toEqual({ values: {}, rejectedKeys: [] });
  expect(resolveEnforced(null)).toEqual({ values: {}, rejectedKeys: [] });
});

test("只接受白名单内的键；名单外的报进 rejectedKeys（不静默忽略）", () => {
  const r = resolveEnforced({ enforced: { max_cost_usd: 5, model: "sneaky", theme: "dark" } });
  expect(r.values).toEqual({ max_cost_usd: 5 });
  expect(r.rejectedKeys.sort()).toEqual(["model", "theme"]);
});

test("白名单确实只含安全相关的键（防止 enforced 变成第二份配置）", () => {
  expect(ENFORCEABLE_KEYS).toContain("max_cost_usd");
  expect(ENFORCEABLE_KEYS).toContain("sandbox");
  expect(ENFORCEABLE_KEYS).toContain("deny_read_globs");
  expect(ENFORCEABLE_KEYS).not.toContain("model");
  expect(ENFORCEABLE_KEYS).not.toContain("theme");
});

test("锁定值优先：attempted 被覆盖，并记下被覆盖的原值", () => {
  const { value, ignoredOverrides } = applyEnforced({ max_cost_usd: 100, other: 1 }, { max_cost_usd: 5 });
  expect(value.max_cost_usd).toBe(5);
  expect(value.other).toBe(1);
  expect(ignoredOverrides).toEqual([{ key: "max_cost_usd", attempted: 100, locked: 5 }]);
});

test("attempted 与锁定值相同：不记噪音", () => {
  const { ignoredOverrides } = applyEnforced({ max_cost_usd: 5 }, { max_cost_usd: 5 });
  expect(ignoredOverrides).toEqual([]);
});

test("attempted 没有该键：仍然补上锁定值（锁定是「必须存在」）", () => {
  const { value, ignoredOverrides } = applyEnforced({}, { sandbox: "bwrap" });
  expect(value.sandbox).toBe("bwrap");
  expect(ignoredOverrides).toEqual([]);
});

test("锁定名单外的键不会盖进结果（双保险）", () => {
  const { value } = applyEnforced({ model: "mine" }, { model: "forced" });
  expect(value.model).toBe("mine");
});

test("不改原对象（纯函数）", () => {
  const attempted = { max_cost_usd: 100 };
  applyEnforced(attempted, { max_cost_usd: 5 });
  expect(attempted.max_cost_usd).toBe(100);
});

test("formatEnforced：未配置时明说是「未配置」而不是「全绿」", () => {
  expect(formatEnforced(resolveEnforced({}))).toContain("未配置");
});

test("formatEnforced：列出锁定键与被拒键与被覆盖项", () => {
  const res = resolveEnforced({ enforced: { max_cost_usd: 5, model: "x" } });
  const text = formatEnforced(res, [{ key: "max_cost_usd", attempted: 100, locked: 5 }]);
  expect(text).toContain("🔒 max_cost_usd = 5");
  expect(text).toContain("model 不在可锁名单内");
  expect(text).toContain("被锁定值 5 覆盖");
});
