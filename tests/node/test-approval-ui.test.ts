// tests/node/test-approval-ui.test.ts — 对应 tests/test_approval_ui.py（14 个唯一测试）。
// Claude 式选择器：编号选项、Enter 确认、Esc 取消，默认选“是”。
import { test, expect } from "bun:test";
import {
  YES, NO, ALWAYS, APPROVAL_FOOTER, approvalOptions, renderApprovalMenu, menuSelect,
} from "../../src/approvalUi.ts";

function runMenu(keys: string[], allowAlways = true): string {
  const options = approvalOptions(allowAlways);
  let i = 0;
  const out: string[] = [];
  return menuSelect(options, () => keys[i++] ?? "enter", (t) => { out.push(t); });
}

test("ApprovalUiTest.test_options_default_is_yes", () => {
  const options = approvalOptions(false);
  expect(options[0][1]).toBe(YES);
  expect(options[0][0]).toContain("是");
  expect(options[1][1]).toBe(NO);
  expect(options.length).toBe(2);
});

test("ApprovalUiTest.test_options_with_always", () => {
  const options = approvalOptions(true);
  expect(options.length).toBe(3);
  expect(options[2][1]).toBe(ALWAYS);
  expect(options[2][0]).toContain("始终允许");
});

test("ApprovalUiTest.test_enter_confirms_default_yes", () => {
  expect(runMenu(["enter"])).toBe(YES);
});

test("ApprovalUiTest.test_esc_cancels", () => {
  expect(runMenu(["esc"])).toBe(NO);
});

test("ApprovalUiTest.test_ctrl_c_cancels_fail_closed", () => {
  expect(runMenu(["ctrl-c"])).toBe(NO);
});

test("ApprovalUiTest.test_arrow_down_then_enter_selects_no", () => {
  expect(runMenu(["down", "enter"])).toBe(NO);
});

test("ApprovalUiTest.test_arrow_up_wraps_to_last", () => {
  expect(runMenu(["up", "enter"])).toBe(ALWAYS);
});

test("ApprovalUiTest.test_y_key_confirms", () => {
  expect(runMenu(["y"])).toBe(YES);
});

test("ApprovalUiTest.test_n_key_rejects", () => {
  expect(runMenu(["n"])).toBe(NO);
});

test("ApprovalUiTest.test_a_key_selects_always", () => {
  expect(runMenu(["a"])).toBe(ALWAYS);
  // 不提供“始终允许”时 a 键拒绝（fail-closed）。
  expect(runMenu(["a"], false)).toBe(NO);
});

test("ApprovalUiTest.test_number_keys_select_option", () => {
  expect(runMenu(["2"])).toBe(NO);
  expect(runMenu(["3"])).toBe(ALWAYS);
  expect(runMenu(["1"])).toBe(YES);
});

test("ApprovalUiTest.test_invalid_number_ignored_then_enter", () => {
  expect(runMenu(["9", "enter"])).toBe(YES);
});

test("ApprovalUiTest.test_menu_renders_selected_inverted", () => {
  const options = approvalOptions(true);
  const out = renderApprovalMenu(options, 0);
  expect(out).toContain("\x1b[7m");
  expect(out).toContain("1.");
  expect(out).toContain("2.");
  expect(out).toContain("3.");
  expect(out).toContain(APPROVAL_FOOTER);
  expect(APPROVAL_FOOTER).toContain("Enter to confirm");
  expect(APPROVAL_FOOTER).toContain("Esc to cancel");
});

test("ApprovalUiTest.test_menu_selection_moves_highlight", () => {
  const options = approvalOptions(true);
  const first = renderApprovalMenu(options, 0);
  const second = renderApprovalMenu(options, 1);
  expect(first).not.toBe(second);
  expect(second.split("\n").find((l) => l.includes("否"))).toContain("\x1b[7m");
});
