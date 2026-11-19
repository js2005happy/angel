// tests/node/test-status.test.ts — 缺口 19：/status 诊断清单。
// 只读检查：临时 home/workdir + 造坏配置，断言每类问题都能被检出、
// 好配置不误报、检查本身不改任何文件。CLI 子进程真测用 NYRA_HOME 隔离。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runStatusChecks, formatStatusReport } from "../../src/status.ts";

let home: string;
let workdir: string;
const savedPath = process.env.PATH;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nyra-status-home-"));
  workdir = mkdtempSync(join(tmpdir(), "nyra-status-work-"));
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

function writeConfig(obj: Record<string, unknown>): void {
  writeFileSync(join(home, "config.json"), JSON.stringify(obj), "utf-8");
}

function writeSkill(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, "utf-8");
}

const GOOD_SKILL = "---\nname: good\ndescription: 好的技能\n---\n\n做事。\n";

test("Status.test_clean_home_passes", () => {
  writeSkill(join(home, "skills"), "good.md", GOOD_SKILL);
  const report = runStatusChecks({ home, workdir });
  expect(report.errors).toBe(0);
  expect(report.ok).toBe(true);
  const text = formatStatusReport(report);
  expect(text).toContain("0 个错误");
  expect(text).toContain("[skills]");
});

test("Status.test_broken_skill_file_detected", () => {
  writeSkill(join(workdir, "skills"), "bad.md", "没有 frontmatter\n");
  writeSkill(join(workdir, "skills"), "good.md", GOOD_SKILL);
  const report = runStatusChecks({ home, workdir });
  expect(report.errors).toBe(1);
  const bad = report.checks.find((c) => c.id.startsWith("skill:"));
  expect(bad?.level).toBe("error");
  expect(bad?.message).toContain("bad.md");
  expect(bad?.fix).toContain("frontmatter");
});

test("Status.test_broken_command_and_agent_files_detected", () => {
  mkdirSync(join(home, "commands"), { recursive: true });
  writeFileSync(join(home, "commands", "empty.md"), "", "utf-8");
  mkdirSync(join(home, "agents"), { recursive: true });
  writeFileSync(join(home, "agents", "bad.md"), "---\ndescription: 缺 name\n---\n", "utf-8");
  const report = runStatusChecks({ home, workdir });
  expect(report.errors).toBe(2);
  expect(report.checks.some((c) => c.category === "commands" && c.level === "error")).toBe(true);
  expect(report.checks.some((c) => c.category === "agents" && c.level === "error")).toBe(true);
});

test("Status.test_missing_concepts_reported_as_info_not_error", () => {
  const report = runStatusChecks({ home, workdir });
  expect(report.errors).toBe(0);
  expect(report.checks.find((c) => c.category === "agents")?.level).toBe("info");
  expect(report.checks.find((c) => c.category === "output-styles")?.level).toBe("info");
  expect(report.checks.find((c) => c.category === "keybindings")?.level).toBe("info");
});

test("Status.test_bad_keybinding_detected", () => {
  writeConfig({ keybindings: { "ctrl-x": "nope", "ctrl-s": "status" } });
  const report = runStatusChecks({ home, workdir });
  expect(report.errors).toBe(1);
  expect(report.checks.some((c) => c.category === "keybindings" && c.level === "error" && c.message.includes("ctrl-x"))).toBe(true);
});

test("Status.test_ignored_permission_rules_detected", () => {
  writeConfig({
    permissions: {
      allow: ["Bash(git *)", "Frobnicate(x)", "这不是规则"],
      deny: ["Bash"],
    },
  });
  const report = runStatusChecks({ home, workdir });
  // 未知工具 1 条 + 解析失败 1 条 + 被 deny 覆盖的 allow 1 条（警告）。
  const errors = report.checks.filter((c) => c.category === "permissions" && c.level === "error");
  expect(errors.some((c) => c.message.includes("Frobnicate"))).toBe(true);
  expect(errors.some((c) => c.message.includes("无法解析") || c.message.includes("这不是规则"))).toBe(true);
  expect(report.checks.some((c) => c.category === "permissions" && c.level === "warn" && c.message.includes("Bash(git *)"))).toBe(true);
});

test("Status.test_claude_style_rules_not_falsely_flagged", () => {
  // 缺口 19 的归一化修法：按文档写的 Bash/Edit 规则现在能命中，不应误报"未知工具"。
  writeConfig({ permissions: { allow: ["Bash(git *)", "Edit(src/**)"] } });
  const report = runStatusChecks({ home, workdir });
  expect(report.checks.filter((c) => c.category === "permissions" && c.level === "error")).toEqual([]);
});

test("Status.test_never_matching_hook_matcher_detected", () => {
  const script = join(workdir, "block.sh");
  writeFileSync(script, "#!/bin/sh\nexit 2\n", "utf-8");
  chmodSync(script, 0o755);
  writeConfig({ hooks: { PreToolUse: [{ type: "command", command: script, tools: ["no_such_tool"] }] } });
  const report = runStatusChecks({ home, workdir });
  expect(report.checks.some((c) => c.category === "hooks" && c.level === "error" && c.message.includes("永不匹配"))).toBe(true);
});

test("Status.test_missing_hook_script_and_unknown_event_detected", () => {
  writeConfig({ hooks: { PreTool: ["x.sh"], PreToolUse: [join(workdir, "missing.sh")] } });
  const report = runStatusChecks({ home, workdir });
  expect(report.checks.some((c) => c.message.includes("未知的钩子事件") && c.message.includes("PreTool"))).toBe(true);
  expect(report.checks.some((c) => c.message.includes("钩子脚本不存在"))).toBe(true);
});

test("Status.test_invalid_hook_entry_detected", () => {
  writeConfig({ hooks: { Stop: [{ type: "agent" }] } });
  const report = runStatusChecks({ home, workdir });
  expect(report.checks.some((c) => c.category === "hooks" && c.level === "error" && c.message.includes("无效的钩子配置"))).toBe(true);
});

test("Status.test_unavailable_sandbox_detected", () => {
  // 本机没有 bwrap：把 PATH 指到空目录，显式要求 bwrap 时必须报不可用。
  const emptyBin = mkdtempSync(join(tmpdir(), "nyra-status-emptybin-"));
  try {
    process.env.PATH = emptyBin;
    writeConfig({ sandbox: "bwrap" });
    const report = runStatusChecks({ home, workdir });
    expect(report.checks.some((c) => c.category === "sandbox" && c.level === "error")).toBe(true);
  } finally {
    rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("Status.test_broken_config_json_detected", () => {
  writeFileSync(join(home, "config.json"), "{ 不是 json", "utf-8");
  const report = runStatusChecks({ home, workdir });
  expect(report.checks.some((c) => c.category === "config" && c.level === "error")).toBe(true);
});

test("Status.test_check_is_readonly", () => {
  writeSkill(join(home, "skills"), "good.md", GOOD_SKILL);
  const before = readdirSync(home).sort();
  runStatusChecks({ home, workdir });
  expect(readdirSync(home).sort()).toEqual(before);
  expect(existsSync(join(home, "config.json"))).toBe(false);
});

test("Status.test_cli_status_subcommand", () => {
  // CLI 的 home 是 NYRA_HOME（~/.nyra），技能放在它下面。
  const nyraHome = join(home, ".nyra");
  writeSkill(join(nyraHome, "skills"), "bad.md", "没有 frontmatter\n");
  const r = spawnSync("bun", ["run", "src/cli.ts", "status"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NYRA_HOME: nyraHome, NYRA_LANG: "zh" },
    encoding: "utf-8",
  });
  expect(r.stdout).toContain("状态诊断");
  expect(r.stdout).toContain("损坏的技能文件");
  expect(r.status).toBe(1);
});
