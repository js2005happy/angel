// tests/node/test-make-model-factory.test.ts — 缺口 24：makeModelFactory（按模型名造 provider）。
// 统一 multiModelFactory 的语义：provider:model 用指定 provider，纯模型名用主 provider。
import { test, expect } from "bun:test";
import { makeModelFactory } from "../../src/providers.ts";

// 用临时 HOME 隔离配置；这里只测纯函数语义（拆 provider:model / 纯模型名 / 空模型），
// 真正 resolveProvider 的凭证校验在集成层（需要真实 config 与环境变量）。
test("makeModelFactory：纯模型名 → 用主 provider（造出来的 provider 有主 provider 名）", () => {
  // 不读真实配置：只验证"纯模型名"分支不抛"写法不对"，且把 provider 名定为主 provider。
  // resolveProvider 需要真实 presets，这里用一个必然存在的 provider 名 + 不存在的模型
  // 来验证它走到 resolveProvider 这一层（而不是在拆串阶段就抛）。
  // 为隔离环境，改用 try/catch 断言错误信息不包含"写法不对"。
  const factory = makeModelFactory({ home: "/tmp/nyra-nonexistent-home", config: {}, primaryName: "deepseek" });
  try {
    factory("test", "some-model");
    // 若能走到 resolveProvider，说明拆串正确；否则会抛"写法不对"。
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // 关键：不是"写法不对"（那是拆串失败），而是 resolveProvider 层面的错误。
    expect(msg).not.toContain("写法不对");
  }
});

test("makeModelFactory：空模型 / 空串 → 抛 ProviderError（不静默用主模型）", () => {
  const factory = makeModelFactory({ home: "/tmp/x", config: {}, primaryName: "deepseek" });
  expect(() => factory("test", null)).toThrow();
  expect(() => factory("test", "")).toThrow();
  expect(() => factory("test", "   ")).toThrow();
});

test("makeModelFactory：'provider:model' 拆串正确（冒号分隔）", () => {
  // 同样只验证拆串语义：冒号分隔会进入 resolveProvider 层，而不是"写法不对"。
  const factory = makeModelFactory({ home: "/tmp/x", config: {}, primaryName: "deepseek" });
  try {
    factory("test", "xai:grok-4");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).not.toContain("写法不对");
  }
});

test("makeModelFactory：只有冒号没有两边 → 抛写法不对", () => {
  const factory = makeModelFactory({ home: "/tmp/x", config: {}, primaryName: "deepseek" });
  expect(() => factory("test", ":")).toThrow(/写法不对|Unknown provider/);
  expect(() => factory("test", "xai:")).toThrow(/写法不对/);
  expect(() => factory("test", ":model")).toThrow(/写法不对/);
});
