// tests/node/test-permission-rule-lint.test.ts — 规则体检：找出「写了但永远不会命中」的规则。
//
// 来由：本仓库连续踩了两次同类问题——shell 命令规则带 workdir 永不命中（#94）、
// 裸主机名规则永不命中（#96）。两次的共同点是 **规则写了、人以为挡住了、实际不生效**。
//
// 既然能机械判定，就让工具去说。这里锁的是 lintRules 的判定边界：
//   L1 拼错工具名 → unknown-tool（这条规则永远不命中）
//   L2 `domain:` 用在非 URL 工具 → 不会命中
//   L3 裸域名用在路径工具 → 被当文件名，不会按域名匹配
//   L4 `Bash()` 空括号 → 与裸工具名等价（提醒确认意图）
//   L5 正确用法一律不报（MCP 名前缀、路径 glob、domain:）
//   L6 不传 knownTools 时跳过 unknown-tool（避免误报）
import { test, expect } from "bun:test";
import { parseRules, lintRules, formatRuleLint } from "../../src/permissionRules.ts";
import { checkRedlines } from "../../src/redlines.ts";

const KNOWN = [
  "shell", "read_file", "write_file", "edit_file", "apply_patch", "list_dir",
  "grep_search", "web_fetch", "http_post", "browser_navigate",
  "Bash", "Edit", "Write", "Read", "sh", "zsh", "powershell",
];

const lint = (cfg: Record<string, unknown>, knownTools: readonly string[] | null = KNOWN) =>
  lintRules(parseRules(cfg), { knownTools });

test("L1 拼错工具名 → unknown-tool", () => {
  const f = lint({ deny: ["Bashh(rm *)"] });
  expect(f).toHaveLength(1);
  expect(f[0].code).toBe("unknown-tool");
  expect(f[0].raw).toBe("Bashh(rm *)");
});

test("L2 domain: 只对 URL 工具生效，用在路径工具上报错", () => {
  expect(lint({ deny: ["read_file(domain:evil.com)"] }).map((x) => x.code)).toContain("domain-on-non-url-tool");
  expect(lint({ deny: ["web_fetch(domain:evil.com)"] })).toEqual([]);
});

test("L3 裸域名用在路径工具 → 会被当文件名", () => {
  expect(lint({ deny: ["read_file(example.com)"] }).map((x) => x.code)).toContain("bare-host-on-path-tool");
  // 用在 URL 工具上是正确写法（#96 支持的裸主机名）
  expect(lint({ deny: ["web_fetch(example.com)"] })).toEqual([]);
});

test("L4 Bash() 空括号 → 提醒（与裸工具名等价）", () => {
  expect(lint({ deny: ["Bash()"] }).map((x) => x.code)).toContain("empty-specifier");
  // 裸工具名不该被提醒
  expect(lint({ deny: ["Bash"] })).toEqual([]);
});

test("L5 正确用法一律不报：MCP 名前缀 / 路径 glob / 壳命令 / domain:", () => {
  expect(lint({ deny: ["mcp__server__search"] })).toEqual([]);
  expect(lint({ deny: ["mcp__server__*"] })).toEqual([]);
  expect(lint({ allow: ["read_file(src/**)"] })).toEqual([]);
  expect(lint({ deny: ["Bash(rm *)"] })).toEqual([]);
  expect(lint({ ask: ["Bash(git push *)"] })).toEqual([]);
  expect(lint({ deny: ["web_fetch(domain:evil.com)"] })).toEqual([]);
});

test("L6 不传 knownTools 时跳过 unknown-tool（避免把 MCP/插件工具误报成拼错）", () => {
  const f = lintRules(parseRules({ deny: ["Bashh(rm *)"] }), {});
  expect(f.some((x) => x.code === "unknown-tool")).toBe(false);
});

test("L7 formatRuleLint：干净时明说「没有发现永不命中的规则」", () => {
  expect(formatRuleLint([])).toContain("没有发现永不命中的规则");
  expect(formatRuleLint(lint({ deny: ["Bashh(x)"] }))).toContain("Bashh(x)");
});

test("L8 接进 redlines：有死规则报 warn，没有则报 ok，未配权限时零影响", () => {
  const base = { config: {}, sandbox: { level: "bwrap", backend: "bwrap" }, hasCostLimit: true, knownTools: KNOWN };
  const dead = checkRedlines({
    ...base,
    permissions: { allow: [], ask: [], deny: [{ raw: "Bashh(rm *)", tool: "Bashh", specifier: "rm *" }] },
  } as never);
  expect(dead.findings.some((x) => x.code === "permission-rules-dead" && x.level === "warn")).toBe(true);

  const ok = checkRedlines({
    ...base,
    permissions: { allow: [], ask: [], deny: [{ raw: "shell(rm *)", tool: "shell", specifier: "rm *" }] },
  } as never);
  expect(ok.findings.some((x) => x.code === "permission-rules-lint" && x.level === "ok")).toBe(true);

  const none = checkRedlines({ ...base, permissions: null } as never);
  expect(none.findings.some((x) => x.code.startsWith("permission-rules"))).toBe(false);
});
