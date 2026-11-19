// tests/node/test-tool-model.test.ts — Tool Model（工具续跑轮走便宜模型）。
//
// 对齐 Alma 的 Tool Model：一轮 agent 循环里，读工具结果、继续调工具这些「机械续跑」
// 对模型能力要求低，按主模型价格计费不划算。但**面向用户的最终答复不能降级**。
//
// 边界（宁可少省，不可写坏答复）：
//   T1 首轮（还没有 assistant 消息）→ 主模型
//   T2 上一条 assistant 有正文 → 已经答过用户，新意图回主模型
//   T3 上一条 assistant 只有 tool_calls（无正文）→ 机械续跑，走 tool_model
//   T4 没配 tool_model → 永远 false（默认关）
//   T5 配成与主模型相同 → 视为没配（忽略，不假优化）
import { test, expect } from "bun:test";
import { shouldUseToolModel, resolveAuxRouting } from "../../src/modelRouting.ts";

const user = (t: string) => ({ role: "user", content: t });
const assistantText = (t: string) => ({ role: "assistant", content: t });
const assistantCalls = (n = 1) => ({ role: "assistant", content: "", tool_calls: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })) });
const toolResult = (t: string) => ({ role: "tool", content: t });

test("T1 首轮：还没有 assistant 消息 → 主模型", () => {
  expect(shouldUseToolModel([user("读一下 README")], "cheap")).toBe(false);
});

test("T2 上一条 assistant 有正文 → 回主模型（这是新意图）", () => {
  expect(shouldUseToolModel([user("你好"), assistantText("你好，有什么可以帮"), user("再改一下")], "cheap")).toBe(false);
});

test("T3 上一条 assistant 只有 tool_calls → 走 tool_model", () => {
  expect(shouldUseToolModel([user("跑测试"), assistantCalls(2), toolResult("ok")], "cheap")).toBe(true);
});

test("T4 没配 tool_model → 永远 false（默认关）", () => {
  const msgs = [user("跑测试"), assistantCalls(1), toolResult("ok")];
  expect(shouldUseToolModel(msgs, null)).toBe(false);
  expect(shouldUseToolModel(msgs, undefined)).toBe(false);
  expect(shouldUseToolModel(msgs, "")).toBe(false);
});

test("T5 tool_model 配成与主模型相同 → 路由里被忽略（不假优化）", () => {
  const r = resolveAuxRouting({ tool_model: "same-model", compact_model: "cheap", delegate_model: "cheap" }, "same-model");
  expect(r.tool).toBeUndefined();
  expect(r.ignored.map((i) => i.key)).toContain("tool_model");
});

test("tool_model 与主模型不同 → 正常路由", () => {
  const r = resolveAuxRouting({ tool_model: "cheap-tool" }, "main-model");
  expect(r.tool).toBe("cheap-tool");
});

test("只看最后一条 assistant：中间有正文不影响（工具循环中途的思考不算答复）", () => {
  const msgs = [
    user("跑测试"),
    assistantText("我先看看目录"),   // 较早的正文
    assistantCalls(1),               // 之后还在调工具
    toolResult("ok"),
  ];
  expect(shouldUseToolModel(msgs, "cheap")).toBe(true);
});

test("assistant 正文是空白串时仍按「无正文」处理（空内容不算答复）", () => {
  expect(shouldUseToolModel([user("x"), { role: "assistant", content: "   ", tool_calls: [{ id: "c" }] }, toolResult("ok")], "cheap")).toBe(true);
});

test("没有 tool_calls 也没有正文的 assistant 消息 → 不启用（保守）", () => {
  expect(shouldUseToolModel([user("x"), { role: "assistant", content: "" }], "cheap")).toBe(false);
});

test("消息里有非 assistant 角色穿插时也能定位到最后一条 assistant", () => {
  const msgs = [user("a"), assistantCalls(1), toolResult("r1"), toolResult("r2")];
  expect(shouldUseToolModel(msgs, "cheap")).toBe(true);
});
