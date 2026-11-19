// tests/node/test-hook-decisions.test.ts — P0-4：hooks 的结构化决策与参数改写。
// 覆盖：
//   1) parseHookStdout：合法 allow/deny/ask、updatedInput、平铺 decision 写法
//   2) 非法输入一律 null（非 JSON / 数组 / 未知决策值 / updatedInput 非对象）——
//      钩子写错格式不能影响主流程，更不能被当成"放行"
//   3) pickStricter：deny > ask > allow，平级保留先到者
import { test, expect } from "bun:test";
import { parseHookStdout, pickStricter } from "../../src/hooks.ts";

test("解析 allow / deny / ask", () => {
  expect(parseHookStdout('{"permissionDecision":"allow"}')?.decision).toBe("allow");
  expect(parseHookStdout('{"permissionDecision":"deny","permissionDecisionReason":"危险"}')?.decision).toBe("deny");
  expect(parseHookStdout('{"permissionDecision":"ask"}')?.decision).toBe("ask");
  expect(parseHookStdout('{"permissionDecision":"deny","permissionDecisionReason":"危险"}')?.reason).toBe("危险");
});

test("解析平铺写法 decision / reason", () => {
  const r = parseHookStdout('{"decision":"deny","reason":"别动"}');
  expect(r?.decision).toBe("deny");
  expect(r?.reason).toBe("别动");
});

test("解析 updatedInput（含下划线别名）", () => {
  expect(parseHookStdout('{"updatedInput":{"path":"safe.txt"}}')?.updatedInput).toEqual({ path: "safe.txt" });
  expect(parseHookStdout('{"updated_input":{"cmd":"ls"}}')?.updatedInput).toEqual({ cmd: "ls" });
});

test("非法输入一律返回 null", () => {
  for (const bad of [
    "",
    "   ",
    "not json",
    "exit 0 之类的人类可读输出",
    "[1,2,3]",
    '"just a string"',
    '{"permissionDecision":"maybe"}',
    '{"updatedInput":"not-an-object"}',
    '{"updatedInput":[1,2]}',
    '{"unrelated":"x"}',
  ]) {
    expect(parseHookStdout(bad)).toBeNull();
  }
});

test("既有决策又有 updatedInput 时两者都保留", () => {
  const r = parseHookStdout('{"permissionDecision":"allow","updatedInput":{"path":"a.txt"}}');
  expect(r?.decision).toBe("allow");
  expect(r?.updatedInput).toEqual({ path: "a.txt" });
});

test("pickStricter：deny > ask > allow", () => {
  expect(pickStricter(undefined, { decision: "allow" }).decision).toBe("allow");
  expect(pickStricter({ decision: "allow" }, { decision: "ask" }).decision).toBe("ask");
  expect(pickStricter({ decision: "ask" }, { decision: "deny" }).decision).toBe("deny");
  // 反向不降级
  expect(pickStricter({ decision: "deny" }, { decision: "allow" }).decision).toBe("deny");
  expect(pickStricter({ decision: "ask" }, { decision: "allow" }).decision).toBe("ask");
});

test("pickStricter：平级保留先到者（先声明者优先）", () => {
  const first = { decision: "deny" as const, reason: "第一个", hook: "/a.sh" };
  const second = { decision: "deny" as const, reason: "第二个", hook: "/b.sh" };
  expect(pickStricter(first, second).reason).toBe("第一个");
});
