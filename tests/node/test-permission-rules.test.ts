// tests/node/test-permission-rules.test.ts — P0-5 权限规则语言（表驱动）。
// 这是安全关键模块，任何改动都要先跑这里。覆盖：
//   1) 解析：Tool / Tool(spec) / mcp__* / 无效行
//   2) 求值次序：deny > ask > allow（安全关键）
//   3) 匹配：命令通配、路径 glob、domain:、MCP 通配、裸工具名
//   4) 空规则集 = 零影响（返回 null，走默认审批）
import { test, expect } from "bun:test";
import {
  parseRule, parseRules, ruleMatches, evaluate, isEmpty, describeRules,
} from "../../src/permissionRules.ts";

test("解析：各种合法形态", () => {
  expect(parseRule("Bash")).toEqual({ raw: "Bash", tool: "Bash", specifier: null });
  expect(parseRule("Bash(git *)")).toEqual({ raw: "Bash(git *)", tool: "Bash", specifier: "git *" });
  expect(parseRule("Edit(src/**)")?.specifier).toBe("src/**");
  expect(parseRule("mcp__memory__search")?.tool).toBe("mcp__memory__search");
  expect(parseRule("  Bash(npm run build)  ")?.raw).toBe("Bash(npm run build)");
  expect(parseRule("Bash()")?.specifier).toBeNull();
});

test("解析：无效行被丢弃且不影响其他规则", () => {
  const rs = parseRules({ allow: ["Bash(git *)", 123, "这不是规则", "Edit(src/**)"], deny: ["Bash(rm -rf *)"] });
  expect(rs.allow.length).toBe(2);
  expect(rs.deny.length).toBe(1);
  expect(rs.warnings.length).toBe(2);
  expect(describeRules(rs)).toContain("warning:");
});

test("空规则集：isEmpty 为真，evaluate 返回 null（零影响）", () => {
  const rs = parseRules(null);
  expect(isEmpty(rs)).toBe(true);
  expect(evaluate(rs, { tool: "Bash", target: "rm -rf /" })).toBeNull();
});

test("命令通配：Bash(git *) 命中 git status，不命中 gitk 与裸 git", () => {
  const rs = parseRules({ allow: ["Bash(git *)"] });
  expect(evaluate(rs, { tool: "Bash", target: "git status" })?.action).toBe("allow");
  expect(evaluate(rs, { tool: "Bash", target: "git push origin main" })?.action).toBe("allow");
  // "git *" 要求 "git" 后面还有内容，裸 git 不命中（要命中裸 git 请写 Bash(git*) 或 Bash）
  expect(evaluate(rs, { tool: "Bash", target: "git" })).toBeNull();
  expect(evaluate(rs, { tool: "Bash", target: "gitk" })).toBeNull();
  expect(evaluate(rs, { tool: "Bash", target: "npm install" })).toBeNull();
});

test("路径 glob：Edit(src/**) 命中子目录，不命中 lib", () => {
  const rs = parseRules({ allow: ["Edit(src/**)"] });
  const wd = "/repo";
  expect(evaluate(rs, { tool: "Edit", target: "/repo/src/a.ts", workdir: wd })?.action).toBe("allow");
  expect(evaluate(rs, { tool: "Edit", target: "/repo/src/deep/b.ts", workdir: wd })?.action).toBe("allow");
  expect(evaluate(rs, { tool: "Edit", target: "/repo/lib/a.ts", workdir: wd })).toBeNull();
});

test("具体文件：Read(./.env) 只命中该文件", () => {
  const rs = parseRules({ deny: ["Read(./.env)"] });
  expect(evaluate(rs, { tool: "Read", target: "/repo/.env", workdir: "/repo" })?.action).toBe("deny");
  expect(evaluate(rs, { tool: "Read", target: "/repo/.env.local", workdir: "/repo" })).toBeNull();
});

test("domain 匹配：WebFetch(domain:example.com) 含子域，不含伪后缀", () => {
  const rs = parseRules({ allow: ["WebFetch(domain:example.com)"] });
  expect(evaluate(rs, { tool: "WebFetch", target: "https://example.com/a" })?.action).toBe("allow");
  expect(evaluate(rs, { tool: "WebFetch", target: "https://api.example.com/a" })?.action).toBe("allow");
  expect(evaluate(rs, { tool: "WebFetch", target: "https://evil-example.com/a" })).toBeNull();
});

test("MCP 通配：mcp__memory__* 命中该 server 的所有工具", () => {
  const rs = parseRules({ allow: ["mcp__memory__*"] });
  expect(evaluate(rs, { tool: "mcp__memory__search" })?.action).toBe("allow");
  expect(evaluate(rs, { tool: "mcp__fetch__get" })).toBeNull();
});

test("裸工具名命中该工具全部调用", () => {
  const rs = parseRules({ ask: ["WebFetch"] });
  expect(evaluate(rs, { tool: "WebFetch", target: "https://any" })?.action).toBe("ask");
  expect(evaluate(rs, { tool: "Bash", target: "ls" })).toBeNull();
});

test("求值次序 deny > ask > allow（安全关键）", () => {
  const rs = parseRules({
    allow: ["Bash", "Bash(git *)"],
    ask: ["Bash(git push *)"],
    deny: ["Bash(git push --force *)"],
  });
  // 同时命中三者：deny 必须赢
  expect(evaluate(rs, { tool: "Bash", target: "git push --force origin main" })?.action).toBe("deny");
  // 命中 ask 与 allow：ask 赢
  expect(evaluate(rs, { tool: "Bash", target: "git push origin main" })?.action).toBe("ask");
  // 只命中 allow
  expect(evaluate(rs, { tool: "Bash", target: "git status" })?.action).toBe("allow");
});

test("ruleMatches：specifier 与 target 都为空时不误命中", () => {
  const rs = parseRules({ allow: ["Bash(git *)"] });
  expect(ruleMatches(rs.allow[0], { tool: "Bash", target: "" })).toBe(false);
});
