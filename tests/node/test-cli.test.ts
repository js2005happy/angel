// tests/node/test-cli.test.ts — 对应 tests/test_cli_providers.py（35 唯一）+ test_commands.py（19 唯一）的核心项，
// 外加 vault 子命令、信任、自定义命令与 --json/--plan 冒烟。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseArgs, isTrusted, addTrusted, listCustomCommands, handleVault, USAGE,
} from "../../src/cli.ts";
import { VERSION } from "../../src/config.ts";

test("CliTest.test_version_string", () => {
  expect(VERSION).toBe("0.3.0");
  expect(USAGE).toContain("0.3.0");
});

test("CliTest.test_parse_args_flags", () => {
  const a = parseArgs(["--help"]);
  expect(a.help).toBe(true);
  const b = parseArgs(["--version"]);
  expect(b.version).toBe(true);
  const c = parseArgs(["--list-providers", "--list-skills", "--list-sessions"]);
  expect(c.listProviders).toBe(true);
  expect(c.listSkills).toBe(true);
  expect(c.listSessions).toBe(true);
});

test("CliTest.test_parse_args_value_flags", () => {
  const a = parseArgs(["--provider", "xai", "--model", "grok-4.3", "--mode", "auto", "--max-turns", "5"]);
  expect(a.provider).toBe("xai");
  expect(a.model).toBe("grok-4.3");
  expect(a.mode).toBe("auto");
  expect(a.maxTurns).toBe(5);
  const b = parseArgs(["--provider=xai", "--model=grok-4.3", "--max-turns=3"]);
  expect(b.provider).toBe("xai");
  expect(b.model).toBe("grok-4.3");
  expect(b.maxTurns).toBe(3);
});

test("CliTest.test_parse_args_task_positional", () => {
  const a = parseArgs(["帮我写个脚本"]);
  expect(a.task).toBe("帮我写个脚本");
  const b = parseArgs(["--json", "做点事"]);
  expect(b.jsonMode).toBe(true);
  expect(b.task).toBe("做点事");
});

test("CliTest.test_parse_args_subcommand_first", () => {
  const a = parseArgs(["schedule", "list"]);
  expect(a.subcommand).toBe("schedule");
  expect(a.subArgs).toEqual(["list"]);
  const b = parseArgs(["kb", "list"]);
  expect(b.subcommand).toBe("kb");
  const c = parseArgs(["vault", "list"]);
  expect(c.subcommand).toBe("vault");
});

test("CliTest.test_parse_args_unknown_flag", () => {
  const a = parseArgs(["--no-such-flag"]);
  expect(a.unknown).toBe("--no-such-flag");
  const b = parseArgs(["--provider"]);
  expect(b.unknown).toBe("--provider");
});

test("CliTest.test_parse_args_plan_and_verify", () => {
  const a = parseArgs(["--plan", "做计划", "--verify", "true", "--verify-timeout", "60", "--verify-retries", "2"]);
  expect(a.planMode).toBe(true);
  expect(a.verify).toBe("true");
  expect(a.verifyTimeout).toBe(60);
  expect(a.verifyRetries).toBe(2);
  const b = parseArgs(["--execute-plan", "--approve-plan", "abc123"]);
  expect(b.executePlan).toBe(true);
  expect(b.approvePlan).toBe("abc123");
});

test("CliTest.test_parse_args_resume", () => {
  const a = parseArgs(["--resume", "20261118-000000-ab12"]);
  expect(a.resume).toBe("20261118-000000-ab12");
  const b = parseArgs(["--resume-run", "20261118-000000-ab12"]);
  expect(b.resumeRun).toBe("20261118-000000-ab12");
});

test("CliTest.test_trust_add_and_check", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-trust-"));
  const wd = mkdtempSync(join(tmpdir(), "nyra-trust-wd-"));
  expect(isTrusted(wd, home)).toBe(false);
  addTrusted(wd, home);
  expect(isTrusted(wd, home)).toBe(true);
  expect(existsSync(join(home, "trusted_workspaces.json"))).toBe(true);
  // 再次添加不重复、不报错。
  addTrusted(wd, home);
  expect(isTrusted(wd, home)).toBe(true);
});

test("CliTest.test_list_custom_commands", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cmd-"));
  const wd = mkdtempSync(join(tmpdir(), "nyra-cmd-wd-"));
  mkdirSync(join(wd, ".nyra", "commands"), { recursive: true });
  writeFileSync(join(wd, ".nyra", "commands", "deploy.md"), "# 部署\n");
  writeFileSync(join(wd, ".nyra", "commands", "review.md"), "# 评审\n");
  const cmds = listCustomCommands(wd, home);
  expect(cmds).toContain("deploy");
  expect(cmds).toContain("review");
});

test("CliTest.test_vault_init_add_get_list_remove", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-vault-cli-"));
  const input = { passwords: ["pw-123", "pw-123"], secrets: ["sk-test-abc"] };
  expect(await handleVault(["init"], home, input)).toBe(0);
  expect(await handleVault(["add", "DEEPSEEK_API_KEY"], home, input)).toBe(0);
  expect(await handleVault(["list"], home, input)).toBe(0);
  expect(await handleVault(["get", "DEEPSEEK_API_KEY"], home, input)).toBe(0);
  expect(await handleVault(["get", "NO_SUCH_KEY"], home, input)).toBe(1);
  expect(await handleVault(["remove", "DEEPSEEK_API_KEY"], home, input)).toBe(0);
  expect(await handleVault(["list"], home, input)).toBe(0);
});

test("CliTest.test_vault_rejects_password_from_argv", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-vault-cli-"));
  const input = { passwords: ["pw-123", "pw-123"], secrets: [] };
  // add 多一个 argv 参数即返回 2（密钥绝不从 argv 读）。
  expect(await handleVault(["add", "K", "secret-from-argv"], home, input)).toBe(2);
  expect(await handleVault(["bogus-cmd"], home, input)).toBe(2);
});

function runCli(args: string[], home: string): { code: number; out: string } {
  const r = spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra") },
    encoding: "utf-8", timeout: 60000,
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("CliTest.test_binary_help_and_version", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-smoke-"));
  const help = runCli(["--help"], home);
  expect(help.code).toBe(0);
  expect(help.out).toContain("nyra");
  const ver = runCli(["--version"], home);
  expect(ver.code).toBe(0);
  expect(ver.out).toContain("0.3.0");
});

test("CliTest.test_binary_list_providers_skills_sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-smoke-"));
  const prov = runCli(["--list-providers"], home);
  expect(prov.code).toBe(0);
  expect(prov.out).toContain("deepseek");
  const skills = runCli(["--list-skills"], home);
  expect(skills.code).toBe(0);
  expect(skills.out).toContain("debugging");
  const sessions = runCli(["--list-sessions"], home);
  expect(sessions.code).toBe(0);
});

test("CliTest.test_binary_json_no_task_exit_2", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-smoke-"));
  const r = runCli(["--json"], home);
  expect(r.code).toBe(2);
  expect(r.out).toContain("schema_version");
  expect(r.out).toContain("invalid_arguments");
});

test("CliTest.test_parse_args_subcommand_provider_prescan", () => {
  // 回归：parseArgs 在子命令 early-return 前先扫 --provider/--model，
  // 否则 setup --provider nope 里的 provider 恒为 undefined，向导按配置跑。
  const a = parseArgs(["setup", "--provider", "nope"]);
  expect(a.subcommand).toBe("setup");
  expect(a.subArgs).toEqual(["--provider", "nope"]);
  expect(a.provider).toBe("nope");
  const b = parseArgs(["setup", "--provider=nope", "--model", "m1"]);
  expect(b.provider).toBe("nope");
  expect(b.model).toBe("m1");
  const c = parseArgs(["setup"]);
  expect(c.subcommand).toBe("setup");
  expect(c.provider).toBeUndefined();
  // schedule/task 等仍从 subArgs 取自己的参数，预扫不影响它们。
  const d = parseArgs(["schedule", "list"]);
  expect(d.subcommand).toBe("schedule");
  expect(d.subArgs).toEqual(["list"]);
  expect(d.provider).toBeUndefined();
  const e = parseArgs(["task", "list"]);
  expect(e.subcommand).toBe("task");
  expect(e.subArgs).toEqual(["list"]);
});

test("CliTest.test_binary_setup_unknown_provider_one_line_error", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-setup-"));
  const r = runCli(["setup", "--provider", "nope"], home);
  expect(r.code).toBe(1);
  expect(r.out).toContain("模型配置有问题");
  expect(r.out).not.toContain("at ");
  expect(r.out).not.toContain(".ts:");
  const ex = runCli(["--example", "--provider", "nope"], home);
  expect(ex.code).toBe(1);
  expect(ex.out).toContain("模型配置有问题");
  expect(ex.out).not.toContain("at ");
});

test("CliTest.test_binary_setup_no_flag_unchanged", () => {
  // 无 flag 的 setup 仍进向导（管道 stdin EOF 时按默认一路走完），不报配置错。
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-setup-"));
  const r = runCli(["setup"], home);
  expect(r.out).toContain("欢迎使用 Nyra");
  expect(r.out).not.toContain("模型配置有问题");
});

test("CliTest.test_binary_memory_export_import_roundtrip", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-cli-smoke-"));
  const nyraHome = join(home, ".nyra");
  mkdirSync(nyraHome, { recursive: true });
  writeFileSync(join(nyraHome, "MEMORY.md"), "## 事实\n\n- 用户是学生\n\n## 偏好\n\n- 喜欢中文\n");
  const exp = runCli(["memory", "export"], home);
  expect(exp.code).toBe(0);
  expect(exp.out).toContain("用户是学生");
  const imp = runCli(["memory", "import"], home);
  expect(imp.code).toBe(0);
});
