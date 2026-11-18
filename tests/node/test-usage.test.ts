// tests/node/test-usage.test.ts — 对应 tests/test_usage.py（8 个唯一测试）。
// contextLimit 只接受正整数配置窗口，绝不按模型名猜；无默认值。
import { test, expect } from "bun:test";
import { contextLimit, UsageTracker, formatUsage } from "../../src/usage.ts";

test("UsageTest.test_context_limit_only_configured_window", () => {
  expect(contextLimit(128000)).toBe(128000);
  expect(contextLimit(0)).toBeNull();
  expect(contextLimit(-5)).toBeNull();
  expect(contextLimit(1.5)).toBeNull();
  expect(contextLimit("128000")).toBeNull();
  expect(contextLimit(true)).toBeNull();
  expect(contextLimit(undefined)).toBeNull();
  expect(contextLimit(null)).toBeNull();
});

test("UsageTest.test_tracker_counts_and_samples", () => {
  const t = new UsageTracker();
  t.record({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
  t.record({ usage: { prompt_tokens: 200, completion_tokens: 80 } });
  expect(t.calls).toBe(2);
  expect(t.reported_calls).toBe(2);
  expect(t.prompt_tokens).toBe(300);
  expect(t.completion_tokens).toBe(130);
  expect(t.total_tokens).toBe(430);
  expect(t.last_prompt_tokens).toBe(200);
  expect(t.prompt_samples).toBe(2);
});

test("UsageTest.test_missing_usage_counted_separately", () => {
  const t = new UsageTracker();
  t.record(null);
  t.record({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  expect(t.calls).toBe(2);
  expect(t.reported_calls).toBe(1);
  expect(t.snapshot().missing_calls).toBe(1);
  expect(t.total_tokens).toBe(15);
});

test("UsageTest.test_snapshot_shape_matches_python", () => {
  const t = new UsageTracker(200000);
  t.record({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
  const snap = t.snapshot();
  expect(snap.calls).toBe(1);
  expect(snap.reported_calls).toBe(1);
  expect(snap.missing_calls).toBe(0);
  expect(snap.prompt_tokens).toBe(100);
  expect(snap.completion_tokens).toBe(50);
  expect(snap.total_tokens).toBe(150);
  expect(snap.last_prompt_tokens).toBe(100);
  expect(snap.context_window_tokens).toBe(200000);
  expect(snap.context_remaining_tokens).toBe(199900);
});

test("UsageTest.test_format_usage_chinese", () => {
  const t = new UsageTracker();
  t.record({ usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } });
  const out = formatUsage(t.snapshot());
  expect(out).toContain("1,000");
  expect(out).toContain("200");
  expect(out).toContain("模型调用：1 次");
  const empty = formatUsage(new UsageTracker().snapshot());
  expect(empty).toContain("未报告");
  expect(empty).toContain("上下文剩余：未知");
});

test("UsageTest.test_zero_tokens_still_reported", () => {
  const t = new UsageTracker();
  t.record({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  expect(t.reported_calls).toBe(1);
  expect(t.snapshot().missing_calls).toBe(0);
});

test("UsageTest.test_input_output_token_aliases", () => {
  const t = new UsageTracker();
  t.record({ usage: { input_tokens: 40, output_tokens: 10 } });
  expect(t.reported_calls).toBe(1);
  expect(t.prompt_tokens).toBe(40);
  expect(t.completion_tokens).toBe(10);
  expect(t.total_tokens).toBe(50);
});

test("UsageTest.test_empty_usage_not_reported", () => {
  const t = new UsageTracker();
  t.record({ usage: {} });
  t.record({});
  expect(t.calls).toBe(2);
  expect(t.reported_calls).toBe(0);
  expect(t.snapshot().prompt_tokens).toBeNull();
});
