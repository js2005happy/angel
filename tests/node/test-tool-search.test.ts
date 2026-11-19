// tests/node/test-tool-search.test.ts — 工具检索选择器（延迟加载第一步）。
// 关键契约：无命中时**全量回退**，绝不让模型手里没有工具。
import { test, expect } from "bun:test";
import {
  tokenizeName, tokenizeQuery, selectTools, describeDeferred, explainSelection,
} from "../../src/toolSearch.ts";

function tool(name: string, desc = "") {
  return { type: "function", function: { name, description: desc, parameters: { type: "object" } } };
}

const TOOLS = [
  tool("read_file", "读取文件内容"),
  tool("write_file", "写入文件"),
  tool("shell", "执行 shell 命令"),
  tool("web_fetch", "抓取网页"),
  tool("computer_use", "控制浏览器与桌面软件点击"),
  tool("mcp__memory__search", "在记忆库里检索"),
  tool("poppy_identity", "身份校验"),
];

test("tokenizeName：snake/kebab/camel 都能拆", () => {
  expect(tokenizeName("read_file")).toContain("read");
  expect(tokenizeName("web-fetch")).toContain("fetch");
  expect(tokenizeName("computerUse")).toContain("computer");
  expect(tokenizeName("mcp__memory__search")).toContain("memory");
});

test("tokenizeQuery：英文词 + 中文 2-gram", () => {
  const t = tokenizeQuery("用 read_file 读一下配置");
  // 下划线保留为整串（read_file），名字侧同样保留整串 → 靠整串命中
  expect(t).toContain("read_file");
  expect(t.some((x) => x.length === 2 && /[\u4e00-\u9fff]/.test(x))).toBe(true);
});

test("清楚的任务：选中相关工具，丢掉无关的", () => {
  const s = selectTools(TOOLS, "用 read_file 看一下 src/app.ts 的实现", { topK: 3, always: ["shell"] });
  expect(s.kept).toContain("read_file");
  expect(s.kept).toContain("shell"); // always 无条件保留
  expect(s.dropped).toContain("computer_use");
});

test("always 列表被无条件保留（即使分数为 0）", () => {
  const s = selectTools(TOOLS, "完全无关的一句话", { topK: 1, always: ["shell", "read_file"] });
  expect(s.kept).toContain("shell");
  expect(s.kept).toContain("read_file");
});

test("无命中 → 全量回退（绝不让模型没工具用）", () => {
  const s = selectTools(TOOLS, "zzz", { topK: 2 });
  expect(s.kept.length).toBe(TOOLS.length);
  expect(s.dropped).toEqual([]);
  expect(explainSelection(s)).toContain("全量发送");
});

test("空任务同样全量回退", () => {
  expect(selectTools(TOOLS, "", { topK: 3 }).kept.length).toBe(TOOLS.length);
});

test("topK 生效，且落选的会给 suggestions", () => {
  const s = selectTools(TOOLS, "file fetch memory", { topK: 2, minScore: 1 });
  expect(s.kept.length).toBeLessThanOrEqual(2);
  expect(s.dropped.length).toBeGreaterThan(0);
  expect(s.suggestions.length).toBeGreaterThan(0);
});

test("名字命中权重高于描述命中", () => {
  const s = selectTools(TOOLS, "shell", { topK: 3 });
  const shellScore = s.scores.find((x) => x.name === "shell")?.score ?? 0;
  const otherScore = s.scores.find((x) => x.name === "poppy_identity")?.score ?? 0;
  expect(shellScore).toBeGreaterThan(otherScore);
});

test("describeDeferred：说清没发多少、怎么拿回来；全发了就返回空串", () => {
  const s = selectTools(TOOLS, "read_file", { topK: 2 });
  expect(describeDeferred(s, TOOLS.length)).toContain("search_tools");
  const full = selectTools(TOOLS, "zzz", { topK: 2 });
  expect(describeDeferred(full, TOOLS.length)).toBe("");
});

test("explainSelection：给出可解释的入选理由", () => {
  const s = selectTools(TOOLS, "用 read_file 读配置", { topK: 3 });
  const text = explainSelection(s);
  expect(text).toContain("read_file");
  expect(text).toMatch(/\d+/);
});

test("结果稳定：同样的输入两次排序一致（便于测试与排障）", () => {
  const a = selectTools(TOOLS, "file read", { topK: 3 });
  const b = selectTools(TOOLS, "file read", { topK: 3 });
  expect(a.kept).toEqual(b.kept);
});
