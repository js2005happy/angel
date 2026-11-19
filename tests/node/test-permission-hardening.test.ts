// tests/node/test-permission-hardening.test.ts — 对齐 Codex 的两项权限加固（2026-11 竞品对齐）。
//
// 1) 复合命令拆分：`Bash(git *)` 不能放行 `git status && rm -rf /`
//    —— 这是规则引擎的真实绕过（旧实现整串匹配，白名单规则可被夹带私货）
// 2) 读侧禁读清单 deny_read_globs（学 Codex requirements.toml）
//    —— 写侧有受保护路径，读侧原来什么都没有，.env / 私钥照样能被读进上下文
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRules, evaluate, splitCompound } from "../../src/permissionRules.ts";
import { workspaceReadPath, resetDenyReadCache } from "../../src/tools.ts";
import type { ToolContext } from "../../src/tools.ts";

let home: string;
let workdir: string;

function ctx(): ToolContext {
  return { workdir, home, mode: "auto", interactive: false } as unknown as ToolContext;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nyra-perm-home-"));
  workdir = mkdtempSync(join(tmpdir(), "nyra-perm-wd-"));
  resetDenyReadCache();
});

afterEach(() => {
  resetDenyReadCache();
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

// ---- 1) 复合命令 ----

test("复合命令：白名单规则不能夹带私货（旧实现的绕过）", () => {
  const rules = parseRules({ allow: ["Bash(git *)"] });
  expect(evaluate(rules, { tool: "Bash", target: "git status && rm -rf /" })).toBeNull();
  expect(evaluate(rules, { tool: "Bash", target: "git status" })?.action).toBe("allow");
});

test("复合命令：每段都允许才允许", () => {
  const rules = parseRules({ allow: ["Bash(git *)", "Bash(ls *)"] });
  expect(evaluate(rules, { tool: "Bash", target: "git status && ls -la" })?.action).toBe("allow");
});

test("复合命令：任一段 ask 就 ask，任一段 deny 就 deny", () => {
  const rules = parseRules({ allow: ["Bash"], ask: ["Bash(git push *)"], deny: ["Bash(rm *)"] });
  expect(evaluate(rules, { tool: "Bash", target: "npm i && git push origin main" })?.action).toBe("ask");
  expect(evaluate(rules, { tool: "Bash", target: "npm i && rm -rf dist" })?.action).toBe("deny");
});

test("复合命令：分隔符全覆盖（&& || ; | 换行）", () => {
  expect(splitCompound("a && b").length).toBe(2);
  expect(splitCompound("a || b").length).toBe(2);
  expect(splitCompound("a ; b").length).toBe(2);
  expect(splitCompound("a | b").length).toBe(2);
  expect(splitCompound("a\nb").length).toBe(2);
});

test("复合命令：单段与非命令类工具不受影响", () => {
  const rules = parseRules({ allow: ["Bash(git *)"], deny: ["Bash(rm *)"] });
  expect(evaluate(rules, { tool: "Bash", target: "git log" })?.action).toBe("allow");
  expect(evaluate(rules, { tool: "Edit", target: "src/a.ts" })).toBeNull();
});

// ---- 2) 读侧禁读清单 ----

test("deny_read_globs：命中即拒读，错误信息说明原因", () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ deny_read_globs: ["**/.env", "secrets/**"] }), "utf-8");
  writeFileSync(join(workdir, ".env"), "OPENAI_KEY=sk-test", "utf-8");
  mkdirSync(join(workdir, "secrets"));
  writeFileSync(join(workdir, "secrets", "key.pem"), "-----BEGIN", "utf-8");
  mkdirSync(join(workdir, "src"));
  writeFileSync(join(workdir, "src", "a.ts"), "export const a = 1;", "utf-8");

  expect(() => workspaceReadPath(ctx(), ".env")).toThrow(/拒绝读取敏感路径/);
  expect(() => workspaceReadPath(ctx(), "secrets/key.pem")).toThrow(/deny_read_globs/);
  // 普通文件照常放行
  expect(() => workspaceReadPath(ctx(), "src/a.ts")).not.toThrow();
});

test("deny_read_globs：没配就是不限制（零配置零影响）", () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({}), "utf-8");
  writeFileSync(join(workdir, ".env"), "x=1", "utf-8");
  expect(() => workspaceReadPath(ctx(), ".env")).not.toThrow();
});

test("deny_read_globs：配置损坏时按「不限制」处理，不把 agent 卡死", () => {
  writeFileSync(join(home, "config.json"), "{ 坏 json", "utf-8");
  writeFileSync(join(workdir, "a.txt"), "x", "utf-8");
  expect(() => workspaceReadPath(ctx(), "a.txt")).not.toThrow();
});

test("deny_read_globs：改配置后 resetDenyReadCache 生效", () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ deny_read_globs: ["**/.env"] }), "utf-8");
  writeFileSync(join(workdir, ".env"), "x=1", "utf-8");
  expect(() => workspaceReadPath(ctx(), ".env")).toThrow();

  // 改成不拦截 → 清缓存后应放行
  writeFileSync(join(home, "config.json"), JSON.stringify({}), "utf-8");
  resetDenyReadCache();
  expect(() => workspaceReadPath(ctx(), ".env")).not.toThrow();
});
