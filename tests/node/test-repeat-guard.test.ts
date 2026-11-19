// tests/node/test-repeat-guard.test.ts — 循环检测守卫（OpenMausBot B 项）。
import { test, expect } from "bun:test";
import {
  RepeatGuard, repeatCallKey, normalizeToolArgs, digestResult,
  isToolErrorResult, isSkippedRepeatResult,
  REPEAT_FAIL_REFUSE_AFTER, REPEAT_SUCCESS_WARN_AFTER, REPEAT_SUCCESS_STOP_AFTER,
  REPEAT_DIGEST_TRUNCATE_CHARS,
} from "../../src/repeatGuard.ts";

test("RepeatGuard.test_args_key_order_does_not_matter", () => {
  expect(normalizeToolArgs({ b: 2, a: 1 })).toBe(normalizeToolArgs({ a: 1, b: 2 }));
  expect(repeatCallKey("read_file", { path: "a.txt" })).toBe(repeatCallKey("read_file", { path: "a.txt" }));
  expect(repeatCallKey("read_file", { path: "a.txt" })).not.toBe(repeatCallKey("read_file", { path: "b.txt" }));
});

test("RepeatGuard.test_long_text_digest_stable_after_truncation", () => {
  const head = "x".repeat(REPEAT_DIGEST_TRUNCATE_CHARS);
  // 截断点之后不同 → 摘要相同；截断点之前不同 → 摘要不同。
  expect(digestResult(head + "AAAA")).toBe(digestResult(head + "BBBB"));
  expect(digestResult(head + "AAAA")).not.toBe(digestResult("y" + head.slice(1) + "AAAA"));
  expect(digestResult("短文本")).not.toBe(digestResult("另一段短文本"));
});

test("RepeatGuard.test_is_tool_error_result", () => {
  expect(isToolErrorResult("错误：文件不存在")).toBe(true);
  expect(isToolErrorResult("执行失败：Error: boom")).toBe(true);
  expect(isToolErrorResult("已写入 a.txt")).toBe(false);
  expect(isToolErrorResult("")).toBe(false);
});

test("RepeatGuard.test_failed_call_refused_after_3", () => {
  const guard = new RepeatGuard();
  const args = { path: "missing.txt" };
  expect(guard.refuseCall("read_file", args)).toBeNull();
  for (let i = 0; i < REPEAT_FAIL_REFUSE_AFTER; i++) {
    expect(guard.noteAfter("read_file", args, "错误：文件不存在").stop).toBe(false);
  }
  const note = guard.refuseCall("read_file", args);
  expect(note).not.toBeNull();
  expect(note).toContain("换一个输入");
  expect(note).toContain("换一种方法");
  expect(note).toContain("说出卡点");
  expect(guard.refusedCalls()).toEqual([{ name: "read_file", count: 1 }]);
  expect(guard.failedCalls()).toEqual([{ name: "read_file", count: 3 }]);
  expect(guard.failureSummary()).toContain("失败的调用：read_file（3 次）");
  expect(guard.failureSummary()).toContain("被守卫拒绝的调用：read_file（1 次）");
});

test("RepeatGuard.test_success_same_answer_warns_at_3_stops_at_10", () => {
  const guard = new RepeatGuard();
  const args = { path: "a.txt" };
  for (let i = 1; i < REPEAT_SUCCESS_STOP_AFTER; i++) {
    const note = guard.noteAfter("read_file", args, "文件内容：hello");
    if (i < REPEAT_SUCCESS_WARN_AFTER) expect(note.warn).toBeUndefined();
    if (i === REPEAT_SUCCESS_WARN_AFTER) expect(note.warn).toContain("原地打转");
    expect(note.stop).toBe(false);
    expect(guard.stopped).toBe(false);
  }
  const last = guard.noteAfter("read_file", args, "文件内容：hello");
  expect(last.stop).toBe(true);
  expect(last.warn).toContain("本轮已停掉");
  expect(guard.stopped).toBe(true);
});

test("RepeatGuard.test_alternating_calls_still_count", () => {
  const guard = new RepeatGuard();
  const a = { path: "a.txt" };
  const b = { path: "b.txt" };
  // 两个卡住的调用交替出现也算，不要求连续。
  for (let i = 0; i < REPEAT_FAIL_REFUSE_AFTER; i++) {
    guard.noteAfter("read_file", a, "错误：a 失败");
    guard.noteAfter("read_file", b, "错误：b 失败");
  }
  expect(guard.refuseCall("read_file", a)).not.toBeNull();
  expect(guard.refuseCall("read_file", b)).not.toBeNull();
});

test("RepeatGuard.test_different_args_do_not_count_as_repeat", () => {
  const guard = new RepeatGuard();
  for (let i = 0; i < REPEAT_FAIL_REFUSE_AFTER; i++) {
    guard.noteAfter("read_file", { path: `f${i}.txt` }, "错误：文件不存在");
  }
  // 每个参数只失败 1 次，谁也不该被拒。
  expect(guard.refuseCall("read_file", { path: "f0.txt" })).toBeNull();
  expect(guard.refuseCall("read_file", { path: "new.txt" })).toBeNull();
  // 成功答案不同也不累计。
  const g2 = new RepeatGuard();
  for (let i = 0; i < REPEAT_SUCCESS_WARN_AFTER; i++) {
    expect(g2.noteAfter("read_file", { path: "a.txt" }, `内容 ${i}`).warn).toBeUndefined();
  }
});

test("RepeatGuard.test_screenshot_results_are_skipped", () => {
  expect(isSkippedRepeatResult("browser_screenshot", "已截图并保存：x.png（PNG，123 字节）")).toBe(true);
  expect(isSkippedRepeatResult("computer_screenshot", "已截屏并保存：y.png")).toBe(true);
  expect(isSkippedRepeatResult("read_file", "data:image/png;base64,iVBORw0KGgo=")).toBe(true);
  expect(isSkippedRepeatResult("read_file", "普通文本结果")).toBe(false);
  const guard = new RepeatGuard();
  for (let i = 0; i < REPEAT_SUCCESS_STOP_AFTER + 2; i++) {
    const note = guard.noteAfter("browser_screenshot", {}, "已截图并保存：x.png（PNG，123 字节）");
    expect(note.stop).toBe(false);
    expect(note.warn).toBeUndefined();
  }
  expect(guard.stopped).toBe(false);
  expect(guard.failedCalls()).toEqual([]);
});

test("RepeatGuard.test_disabled_guard_does_nothing", () => {
  const guard = new RepeatGuard(false);
  for (let i = 0; i < 5; i++) guard.noteAfter("read_file", { path: "a.txt" }, "错误：失败");
  expect(guard.refuseCall("read_file", { path: "a.txt" })).toBeNull();
  expect(guard.failureSummary()).toBe("");
});

test("RepeatGuard.test_honest_failure_text_lists_calls", () => {
  const guard = new RepeatGuard();
  guard.noteAfter("shell", { command: "boom" }, "错误：命令失败");
  guard.noteAfter("shell", { command: "boom" }, "错误：命令失败");
  const text = guard.honestFailureText("已达到最大轮数");
  expect(text).toContain("已达到最大轮数");
  expect(text).toContain("任务未完成");
  expect(text).toContain("失败的调用：shell（2 次）");
  const empty = new RepeatGuard();
  expect(empty.honestFailureText("已达到最大轮数")).toContain("没有记录到失败或被拒的工具调用");
});
