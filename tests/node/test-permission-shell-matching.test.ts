// tests/node/test-permission-shell-matching.test.ts — shell 命令规则必须真的命中（回归防线）。
//
// 修的真缺陷：`normalizeTarget()` 把**所有**工具的目标都当文件系统路径处理——
// `resolve("rm file.txt")` 会按 process.cwd() 拼成绝对路径，于是 `Bash(rm *)` /
// `shell(rm *)` 这类规则在**带 workdir 时永不命中**。
//
// 后果不是"少拦一次"，而是 **deny 规则静默失效**：配了 `Bash(rm -rf *)` 以为挡住了，
// 实际全放行。这比没有规则更危险——人以为自己配了。
//
// 测试分三层：
//   S1 三种 workdir（Windows 风格 / POSIX 绝对 / 相对）下 shell 规则都命中
//   S2 `Bash(...)` 与 `shell(...)` 两种写法等价（normalizeToolName 双向归一）
//   S3 非路径目标（URL / MCP 名）不被路径化；路径工具仍归一化（回归保护）
import { test, expect } from "bun:test";
import { parseRules, evaluate, ruleMatches, normalizeToolName } from "../../src/permissionRules.ts";

const deny = (spec: string) => parseRules({ deny: [spec] }).deny[0] as never;

test("S1 shell 规则在任意 workdir 下都命中（修复前带 workdir 一律不命中）", () => {
  const rule = deny("shell(rm *)");
  for (const workdir of ["C:\\work", "/work", "/tmp/x", "relative/dir"]) {
    expect(ruleMatches(rule, { tool: "shell", target: "rm file.txt", workdir } as never)).toBe(true);
  }
});

test("S1 不带 workdir 也命中（老行为不能回退）", () => {
  expect(ruleMatches(deny("shell(rm *)"), { tool: "shell", target: "rm file.txt" } as never)).toBe(true);
});

test("S2 Bash(...) 与 shell(...) 两种写法等价", () => {
  const target = { tool: "shell", target: "rm -rf build", workdir: "/work" } as never;
  expect(ruleMatches(deny("Bash(rm *)"), target)).toBe(true);
  expect(ruleMatches(deny("shell(rm *)"), target)).toBe(true);
  expect(normalizeToolName("Bash")).toBe("shell");
});

test("S2 不匹配的命令仍然不命中（别把修复做成「全都放行」）", () => {
  expect(ruleMatches(deny("shell(rm *)"), { tool: "shell", target: "git status", workdir: "/work" } as never)).toBe(false);
});

test("S3 复合命令夹带私货不放行：allow(git *) 不覆盖 rm 段", () => {
  const rules = parseRules({ allow: ["shell(git *)"] });
  expect(evaluate(rules, { tool: "shell", target: "git status && rm -rf /", workdir: "/work" })).toBeNull();
});

test("S3 复合命令里命中 deny 时整串 deny", () => {
  const rules = parseRules({ allow: ["shell(git *)"], deny: ["shell(rm -rf *)"] });
  expect(evaluate(rules, { tool: "shell", target: "git status && rm -rf /", workdir: "/work" })?.action).toBe("deny");
});

test("S3 路径类工具仍然做归一化（相对/绝对都能匹配）", () => {
  const rules = parseRules({ deny: ["write_file(**/*.env)"] });
  expect(evaluate(rules, { tool: "write_file", target: "/work/keys/a.env", workdir: "/work" })?.action).toBe("deny");
  expect(evaluate(rules, { tool: "write_file", target: "keys/a.env", workdir: "/work" })?.action).toBe("deny");
});

test("S3 URL 目标不被当路径：域名规则照常命中", () => {
  const rules = parseRules({ deny: ["web_fetch(domain:evil.com)"] });
  expect(evaluate(rules, { tool: "web_fetch", target: "https://evil.com/x", workdir: "/work" })?.action).toBe("deny");
  expect(evaluate(rules, { tool: "web_fetch", target: "https://api.evil.com/x", workdir: "/work" })?.action).toBe("deny");
  expect(evaluate(rules, { tool: "web_fetch", target: "https://good.com/x", workdir: "/work" })).toBeNull();
});
