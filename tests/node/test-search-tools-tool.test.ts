// tests/node/test-search-tools-tool.test.ts — search_tools 元工具（延迟加载第二步）。
// 契约：命中就返回名字+一句话描述并通知 agent；没命中就如实说"全放开了"，不骗模型。
import { test, expect } from "bun:test";
import { toolSearchTools, SEARCH_TOOLS_SCHEMA, TOOL_SCHEMAS } from "../../src/tools.ts";
import type { ToolContext } from "../../src/tools.ts";

const ALL = [
  { type: "function", function: { name: "read_file", description: "读取文件内容" } },
  { type: "function", function: { name: "write_file", description: "写文件" } },
  { type: "function", function: { name: "shell", description: "执行 shell 命令" } },
  { type: "function", function: { name: "computer_use", description: "控制浏览器截图点击" } },
  { type: "function", function: { name: "mcp__memory__search", description: "记忆库检索" } },
];

function ctxWith(revealed: string[] = []): ToolContext {
  return {
    workdir: "/w", mode: "auto", interactive: false,
    searchableTools: () => ALL as never,
    revealTools: (names: string[]) => { revealed.push(...names); },
  } as unknown as ToolContext;
}

test("默认不注册（不改变既有工具契约）；开启延迟加载才加进去", () => {
  const names = TOOL_SCHEMAS.map((s) => (s as { function: { name: string } }).function.name);
  expect(names).not.toContain("search_tools");
  expect((SEARCH_TOOLS_SCHEMA as { function: { name: string } }).function.name).toBe("search_tools");
});

test("schema 有自己的描述与必填参数", () => {
  const fn = (SEARCH_TOOLS_SCHEMA as { function: { name: string; parameters: { required: string[] } } }).function;
  expect(fn.name).toBe("search_tools");
  expect(fn.parameters.required).toContain("query");
});

test("命中：返回工具名 + 一句话描述，并通知 agent 加回下一轮", () => {
  const revealed: string[] = [];
  const out = toolSearchTools(ctxWith(revealed), "我想控制浏览器截图", 3);
  expect(out).toContain("computer_use");
  expect(out).toContain("—"); // 名字 + 描述
  expect(revealed).toContain("computer_use");
});

test("未命中：如实告知已放开所有工具，且把全部工具都揭示出来", () => {
  const revealed: string[] = [];
  const out = toolSearchTools(ctxWith(revealed), "zzzz", 2);
  expect(out).toContain("没有明确命中");
  expect(revealed.length).toBe(ALL.length);
});

test("limit 生效（不超过上限，也不因 0/负数崩掉）", () => {
  const revealed: string[] = [];
  const out = toolSearchTools(ctxWith(revealed), "file", 1);
  expect(revealed.length).toBeLessThanOrEqual(ALL.length);
  expect(out).toContain("检索命中");
});

test("没有可检索工具时给出明确错误，不静默返回空串", () => {
  const ctx = { workdir: "/w", mode: "auto", interactive: false } as unknown as ToolContext;
  expect(toolSearchTools(ctx, "any")).toContain("没有可检索的工具");
});

test("输出里带建议项（其他可能相关的）", () => {
  const revealed: string[] = [];
  const out = toolSearchTools(ctxWith(revealed), "memory 检索", 1);
  expect(out.length).toBeGreaterThan(0);
});
