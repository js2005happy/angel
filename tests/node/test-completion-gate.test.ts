// tests/node/test-completion-gate.test.ts — P1-1：完成即自证。
// 规则：没通过验证命令的运行，无论模型怎么说，输出里都不能出现"已完成"这种断言；
// 做法是保留原文但在最前面插入未验证声明（降级而非删除）。
import { test, expect } from "bun:test";
import { downgradeCompletionClaim, COMPLETION_CLAIM_RE } from "../../src/runs.ts";

test("verified 状态：原样返回，不做任何改动", () => {
  const text = "已修复登录问题，测试全部通过。";
  const r = downgradeCompletionClaim(text, "verified", "验证命令未通过");
  expect(r.downgraded).toBe(false);
  expect(r.text).toBe(text);
});

test("verify_failed + 声明完成：插入未验证横幅并保留原文", () => {
  const text = "已完成重构，代码已提交。";
  const r = downgradeCompletionClaim(text, "verify_failed", "验证命令未通过");
  expect(r.downgraded).toBe(true);
  expect(r.text).toContain("【未验证】");
  expect(r.text).toContain("验证命令未通过");
  expect(r.text).toContain(text); // 原文保留
  expect(r.text.indexOf("【未验证】")).toBeLessThan(r.text.indexOf(text));
});

test("completed_unverified + 声明完成：同样降级", () => {
  const r = downgradeCompletionClaim("任务已完成。", "completed_unverified", "未配置或未执行验证命令");
  expect(r.downgraded).toBe(true);
  expect(r.text).toContain("【未验证】");
});

test("未验证但没有完成断言：不打扰，原样返回", () => {
  const text = "我看了下 src/tools.ts，发现三个可疑点，需要你确认。";
  const r = downgradeCompletionClaim(text, "completed_unverified", "未配置验证命令");
  expect(r.downgraded).toBe(false);
  expect(r.text).toBe(text);
});

test("英文断言也能识别", () => {
  for (const t of ["Done — refactored the parser.", "All tests passed.", "Completed the migration."]) {
    expect(downgradeCompletionClaim(t, "verify_failed", "验证命令未通过").downgraded).toBe(true);
  }
});

test("中文多种口径都能识别：已完成 / 搞定了 / 全部通过 / 已修复", () => {
  for (const t of ["已完成", "搞定了", "全部通过", "已修复", "已经完成"]) {
    expect(COMPLETION_CLAIM_RE.test(t)).toBe(true);
    expect(downgradeCompletionClaim(t, "incomplete", "运行未正常结束").downgraded).toBe(true);
  }
});

test("incomplete 状态同样降级（运行未正常结束，更不能自称完成）", () => {
  const r = downgradeCompletionClaim("已经完成了你要的重构。", "incomplete", "运行未正常结束");
  expect(r.downgraded).toBe(true);
  expect(r.text).toContain("运行未正常结束");
});

test("空文本不崩、不误报", () => {
  const r = downgradeCompletionClaim("", "verify_failed", "验证命令未通过");
  expect(r.downgraded).toBe(false);
  expect(r.text).toBe("");
});

test("横幅里给出补验证的具体命令", () => {
  const r = downgradeCompletionClaim("完成了。", "verify_failed", "验证命令未通过");
  expect(r.text).toContain('nyra --verify');
});
