// tests/node/test-eigenflux.test.ts — EigenFlux 原生 Node 移植（src/eigenflux.ts）。
// 对应 Python：tests/test_eigenflux_adapter.py（12 项）与
// tests/test_eigenflux_policy.py 中与锁/身份有关的部分。
// 全部 mock：CLI 探测与诊断经 deps 注入的 findCli/runProbe，不调真实
// eigenflux 二进制、不联网；唯一执行真实子进程的是 defaultRunProbe 对
// 临时目录里现写的假脚本（fake-eigenflux.sh）的调用，用于验证最小环境
// 与超时映射，绝不调用真实 eigenflux。
import { test, expect, afterEach } from "bun:test";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquirePolicyLock, doctor, doctorExitCode, EigenFluxError, findEigenfluxCli,
  homeForAgent, minimalEnvironment, onboardingSteps, parseEigenfluxVersion,
  policyLockPath, readPolicyLockHolder, releasePolicyLock, defaultRunProbe,
  type ProbeResult,
} from "../../src/eigenflux.ts";

const INSTANCE = "0123456789abcdef0123456789abcdef";
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nyra-eigenflux-"));
  roots.push(root);
  return root;
}

function makeRoom(root: string, room: string, opts: { instanceId?: string | null; bots?: string[] } = {}): void {
  const dir = join(root, "groups", room);
  mkdirSync(dir, { recursive: true });
  const data: Record<string, unknown> = {
    id: room, name: room,
    bots: (opts.bots ?? ["lead", "builder"]).map((id) => ({ id, mode: "readonly" })),
    messages: [], created_at: "2026-11-19T00:00:00Z",
  };
  if (opts.instanceId !== undefined && opts.instanceId !== null) data.instance_id = opts.instanceId;
  writeFileSync(join(dir, "room.json"), JSON.stringify(data), "utf-8");
}

function okProbe(output = "EigenFlux v1.0.2\nextra\n"): ProbeResult {
  return { status: "ok", exitCode: 0, output: output.trim().split("\n")[0] ?? "", version: parseEigenfluxVersion(output) };
}

async function deadPid(): Promise<number> {
  // Windows 没有 true 命令：用当前运行时自身（bun/node）跑 --version 立即退出取死 pid。
  const child = spawn(process.execPath, ["--version"]);
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return pid;
}

// --- homeForAgent：身份隔离 ---

test("EigenFluxHomeTest.test_main_home_is_stable_and_creates_nothing", () => {
  const root = makeRoot();
  const first = homeForAgent({ root });
  expect(first).toBe(join(root, "eigenflux", "agents", "main", ".eigenflux"));
  expect(homeForAgent({ root })).toBe(first);
  expect(existsSync(join(root, "eigenflux"))).toBe(false);
});

test("EigenFluxHomeTest.test_group_bots_get_separate_persistent_homes", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: INSTANCE });
  makeRoom(root, "beta", { instanceId: "fedcba9876543210fedcba9876543210" });
  const aLead = homeForAgent({ root, room: "alpha", bot: "lead" });
  const aBuilder = homeForAgent({ root, room: "alpha", bot: "builder" });
  const bLead = homeForAgent({ root, room: "beta", bot: "lead" });
  const main = homeForAgent({ root });
  expect(new Set([aLead, aBuilder, bLead, main]).size).toBe(4);
  expect(aLead).toBe(join(root, "eigenflux", "agents", "rooms", "alpha", "instances", INSTANCE, "bots", "lead", ".eigenflux"));
  expect(existsSync(join(root, "eigenflux"))).toBe(false);
});

test("EigenFluxHomeTest.test_unknown_bot_room_and_partial_ids_fail_closed", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: INSTANCE });
  const bad: Array<{ room?: string | null; bot?: string | null }> = [
    { room: "alpha", bot: "visitor" },
    { room: "missing", bot: "lead" },
    { room: "alpha", bot: null },
    { room: null, bot: "lead" },
    { room: "../alpha", bot: "lead" },
    { room: "alpha", bot: "../builder" },
    { room: "Alpha", bot: "lead" },
  ];
  for (const args of bad) {
    expect(() => homeForAgent({ root, ...args })).toThrow(EigenFluxError);
  }
});

test("EigenFluxHomeTest.test_symlink_homes_rejected", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: INSTANCE });
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(root, "eigenflux"), "dir");
  expect(() => homeForAgent({ root })).toThrow(/符号链接/);
  expect(() => homeForAgent({ root, room: "alpha", bot: "lead" })).toThrow(/符号链接/);
});

test("EigenFluxHomeTest.test_group_room_symlink_not_accepted", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: INSTANCE });
  const outside = join(root, "external");
  mkdirSync(outside);
  rmSync(join(root, "groups", "alpha"), { recursive: true, force: true });
  symlinkSync(outside, join(root, "groups", "alpha"), "dir");
  expect(() => homeForAgent({ root, room: "alpha", bot: "lead" })).toThrow(/符号链接/);
});

test("EigenFluxHomeTest.test_legacy_room_without_instance_keeps_previous_home", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: null });
  expect(homeForAgent({ root, room: "alpha", bot: "lead" })).toBe(
    join(root, "eigenflux", "agents", "rooms", "alpha", "bots", "lead", ".eigenflux"),
  );
});

test("EigenFluxHomeTest.test_recreated_room_gets_new_home", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: INSTANCE });
  const before = homeForAgent({ root, room: "alpha", bot: "lead" });
  rmSync(join(root, "groups", "alpha"), { recursive: true, force: true });
  makeRoom(root, "alpha", { instanceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  expect(homeForAgent({ root, room: "alpha", bot: "lead" })).not.toBe(before);
});

test("EigenFluxHomeTest.test_invalid_instance_marker_rejected", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: "not-hex" });
  expect(() => homeForAgent({ root, room: "alpha", bot: "lead" })).toThrow(/群实例标记无效/);
});

// --- 版本解析 ---

test("EigenFluxVersionTest.test_parse_version", () => {
  expect(parseEigenfluxVersion("EigenFlux v1.0.2\nextra\n")).toBe("1.0.2");
  expect(parseEigenfluxVersion("eigenflux 2.3.1-beta")).toBe("2.3.1-beta");
  expect(parseEigenfluxVersion("EigenFlux v10.20.30+build.1")).toBe("10.20.30+build.1");
  expect(parseEigenfluxVersion("no version here")).toBeNull();
  expect(parseEigenfluxVersion("")).toBeNull();
});

// --- doctor：默认不执行 CLI ---

test("EigenFluxDoctorTest.test_default_dry_run_never_executes_cli", () => {
  const root = makeRoot();
  let findCalls = 0;
  let probeCalls = 0;
  const report = doctor({ root }, {
    findCli: () => { findCalls++; return "/usr/bin/eigenflux"; },
    runProbe: () => { probeCalls++; return okProbe(); },
  });
  expect(report.status).toBe("not_checked");
  expect(report.checked).toBe(false);
  expect(report.network_actions_allowed).toBe(false);
  expect(report.broadcast_enabled).toBe(false);
  expect(report.scheduled_checks_enabled).toBe(false);
  expect(report.onboarding_complete).toBe(false);
  expect(report.home_exists).toBe(false);
  expect(findCalls).toBe(0);
  expect(probeCalls).toBe(0);
  expect(existsSync(join(root, "eigenflux"))).toBe(false);
  expect(doctorExitCode(report.status)).toBe(0);
});

test("EigenFluxDoctorTest.test_opt_in_check_when_binary_missing", () => {
  const root = makeRoot();
  let probeCalls = 0;
  const report = doctor({ root, check: true }, {
    findCli: () => null,
    runProbe: () => { probeCalls++; return okProbe(); },
  });
  expect(report.status).toBe("cli_not_installed");
  expect(report.checked).toBe(true);
  expect(report.network_actions_allowed).toBe(false);
  expect(probeCalls).toBe(0);
  expect(doctorExitCode(report.status)).toBe(1);
});

test("EigenFluxDoctorTest.test_opt_in_runs_only_two_allowlisted_probes", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: INSTANCE });
  const calls: Array<{ binary: string; home: string; args: string[] }> = [];
  const report = doctor({ root, room: "alpha", bot: "lead", check: true }, {
    findCli: () => "/usr/bin/eigenflux",
    runProbe: (binary, home, args) => { calls.push({ binary, home, args }); return okProbe(); },
  });
  expect(report.status).toBe("local_cli_verified");
  expect(report.identity).toBe("room:alpha/bot:lead");
  expect(calls.length).toBe(2);
  expect(calls[0]).toEqual({ binary: "/usr/bin/eigenflux", home: report.home, args: ["version"] });
  expect(calls[1]).toEqual({ binary: "/usr/bin/eigenflux", home: report.home, args: ["skills", "path", "--host", "terminal"] });
  expect(report.diagnostics?.version.version).toBe("1.0.2");
  expect(doctorExitCode(report.status)).toBe(0);
});

test("EigenFluxDoctorTest.test_failed_probe_is_partial_not_success", () => {
  const root = makeRoot();
  const report = doctor({ root, check: true }, {
    findCli: () => "/usr/bin/eigenflux",
    runProbe: (_binary, _home, args) => args[0] === "skills"
      ? { status: "failed", exitCode: 1, output: "" }
      : okProbe(),
  });
  expect(report.status).toBe("incomplete");
  expect(report.diagnostics?.skills.status).toBe("failed");
  expect(report.diagnostics?.skills.output).toBe("");
  expect(JSON.stringify(report)).not.toContain("broken config");
  expect(report.network_actions_allowed).toBe(false);
  expect(doctorExitCode(report.status)).toBe(1);
});

test("EigenFluxDoctorTest.test_timeout_probe_does_not_claim_success", () => {
  const root = makeRoot();
  const report = doctor({ root, check: true }, {
    findCli: () => "/usr/bin/eigenflux",
    runProbe: () => ({ status: "failed", exitCode: null, output: "", reason: "TimeoutExpired" }),
  });
  expect(report.status).toBe("incomplete");
  expect(report.diagnostics?.version.reason).toBe("TimeoutExpired");
});

// --- defaultRunProbe：只对临时假脚本做真实 spawn ---

// 假 CLI：POSIX 写 .sh，Windows 写 .cmd（Windows 不能直接执行 .sh；
// .cmd/.bat 由 defaultRunProbe 经 cmd.exe /d /c 调用）。
// 注意超时用例的 cmd 版用 ping 计时：timeout.exe 在 stdin 重定向时会立即返回，
// 造不出超时；ping -n 11 约等 10 秒，超过 8 秒探针超时。
function writeFakeEigenflux(root: string, shBody: string, cmdBody: string): string {
  if (process.platform === "win32") {
    const path = join(root, "fake-eigenflux.cmd");
    writeFileSync(path, `${cmdBody}\r\n`, "utf-8");
    return path;
  }
  const path = join(root, "fake-eigenflux.sh");
  writeFileSync(path, `#!/bin/sh\n${shBody}\n`, "utf-8");
  chmodSync(path, 0o755);
  return path;
}

test("EigenFluxProbeTest.test_default_probe_minimal_env_and_version", () => {
  const root = makeRoot();
  const home = homeForAgent({ root });
  const fake = writeFakeEigenflux(root, [
    "mkdir -p \"$2\"",
    "env > \"$2/env-dump.txt\"",
    "if [ \"$3\" = \"version\" ]; then echo \"EigenFlux v1.2.3\"; echo \"extra line\"; exit 0; fi",
    "echo \"/somewhere/.eigenflux/skills\"",
    "exit 0",
  ].join("\n"), [
    "@echo off",
    "mkdir \"%~2\" 2>nul",
    "set > \"%~2\\env-dump.txt\"",
    "if \"%~3\"==\"version\" (",
    "echo EigenFlux v1.2.3",
    "echo extra line",
    "exit /b 0",
    ")",
    "echo /somewhere/.eigenflux/skills",
    "exit /b 0",
  ].join("\r\n"));
  process.env.OPENAI_API_KEY = "SECRET";
  process.env.EIGENFLUX_TOKEN = "ANOTHER_SECRET";
  try {
    const report = doctor({ root, check: true }, { findCli: () => fake });
    expect(report.status).toBe("local_cli_verified");
    expect(report.diagnostics?.version.output).toBe("EigenFlux v1.2.3");
    expect(report.diagnostics?.version.version).toBe("1.2.3");
    const dump = readFileSync(join(home, "env-dump.txt"), "utf-8");
    expect(dump).toContain(`EIGENFLUX_HOME=${home}`);
    expect(dump).not.toContain("OPENAI_API_KEY");
    expect(dump).not.toContain("EIGENFLUX_TOKEN");
    expect(dump).not.toContain("SECRET");
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.EIGENFLUX_TOKEN;
  }
});

test("EigenFluxProbeTest.test_default_probe_missing_binary_fails_closed", () => {
  const root = makeRoot();
  const home = homeForAgent({ root });
  const result = defaultRunProbe("/nonexistent/eigenflux", home, ["version"]);
  expect(result.status).toBe("failed");
  expect(result.exitCode).toBeNull();
  expect(result.reason).toBe("ENOENT");
  expect(result.output).toBe("");
});

test("EigenFluxProbeTest.test_default_probe_nonzero_exit_is_failed", () => {
  const root = makeRoot();
  const home = homeForAgent({ root });
  const fake = writeFakeEigenflux(root, "exit 3", "@echo off\r\nexit /b 3");
  const result = defaultRunProbe(fake, home, ["version"]);
  expect(result.status).toBe("failed");
  expect(result.exitCode).toBe(3);
  expect(result.output).toBe("");
});

test("EigenFluxProbeTest.test_default_probe_timeout_maps_to_timeout_expired", () => {
  const root = makeRoot();
  const home = homeForAgent({ root });
  const fake = writeFakeEigenflux(root, "sleep 10; echo \"EigenFlux v1.0.0\"", "@echo off\r\nping -n 11 127.0.0.1 >nul\r\necho EigenFlux v1.0.0");
  const result = defaultRunProbe(fake, home, ["version"]);
  expect(result.status).toBe("failed");
  expect(result.exitCode).toBeNull();
  expect(result.reason).toBe("TimeoutExpired");
}, 15000);

test("EigenFluxEnvTest.test_minimal_environment_strips_secrets", () => {
  const env = minimalEnvironment("/tmp/home", {
    PATH: "/usr/bin", OPENAI_API_KEY: "SECRET", EIGENFLUX_TOKEN: "X", LANG: "zh_CN.UTF-8",
  } as NodeJS.ProcessEnv);
  expect(env.EIGENFLUX_HOME).toBe("/tmp/home");
  expect(env.PATH).toBe("/usr/bin");
  expect(env.LANG).toBe("zh_CN.UTF-8");
  expect("OPENAI_API_KEY" in env).toBe(false);
  expect("EIGENFLUX_TOKEN" in env).toBe(false);
});

test("EigenFluxCliTest.test_find_cli_returns_null_when_absent", () => {
  expect(findEigenfluxCli({ PATH: "/nonexistent-dir-xyz" })).toBeNull();
});

// --- 策略锁 ---

test("EigenFluxPolicyLockTest.test_acquire_and_release", () => {
  const root = makeRoot();
  const lockPath = policyLockPath(root);
  const first = acquirePolicyLock(root, { owner: "test-1" });
  expect(first.acquired).toBe(true);
  expect(first.holder?.pid).toBe(process.pid);
  expect(first.holder?.owner).toBe("test-1");
  expect(existsSync(lockPath)).toBe(true);
  if (process.platform !== "win32") {
    expectPerms(lockPath, 0o600);
  }
  const second = acquirePolicyLock(root, { owner: "test-2" });
  expect(second.acquired).toBe(false);
  expect(second.reason).toBe("held_by_other");
  expect(second.holder?.pid).toBe(process.pid);
  expect(second.holder?.owner).toBe("test-1");
  // 非持有者解不了锁，锁还在。
  expect(releasePolicyLock(lockPath, { pid: process.pid + 999999 })).toBe(false);
  expect(existsSync(lockPath)).toBe(true);
  expect(releasePolicyLock(lockPath, { owner: "test-1" })).toBe(true);
  expect(existsSync(lockPath)).toBe(false);
  expect(releasePolicyLock(lockPath)).toBe(false);
  expect(readPolicyLockHolder(lockPath)).toBeNull();
});

test("EigenFluxPolicyLockTest.test_dead_holder_lock_is_reclaimed", async () => {
  const root = makeRoot();
  const lockPath = policyLockPath(root);
  const pid = await deadPid();
  mkdirSync(join(root, "eigenflux"), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({
    pid, owner: "dead-owner", acquiredAt: new Date().toISOString(),
    acquiredAtMs: Date.now(), ttlMs: 60000,
  }), "utf-8");
  const result = acquirePolicyLock(root, { owner: "test-reclaim" });
  expect(result.acquired).toBe(true);
  expect(result.holder?.owner).toBe("test-reclaim");
  expect(releasePolicyLock(lockPath, { owner: "test-reclaim" })).toBe(true);
});

test("EigenFluxPolicyLockTest.test_expired_lock_is_reclaimed_even_with_live_holder", () => {
  const root = makeRoot();
  const lockPath = policyLockPath(root);
  mkdirSync(join(root, "eigenflux"), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, owner: "old-owner", acquiredAt: new Date(Date.now() - 120000).toISOString(),
    acquiredAtMs: Date.now() - 120000, ttlMs: 1000,
  }), "utf-8");
  const result = acquirePolicyLock(root, { owner: "test-expired" });
  expect(result.acquired).toBe(true);
  expect(result.holder?.owner).toBe("test-expired");
  expect(releasePolicyLock(lockPath, { owner: "test-expired" })).toBe(true);
});

test("EigenFluxPolicyLockTest.test_unexpired_live_lock_is_not_reclaimed", () => {
  const root = makeRoot();
  const lockPath = policyLockPath(root);
  mkdirSync(join(root, "eigenflux"), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, owner: "live-owner", acquiredAt: new Date().toISOString(),
    acquiredAtMs: Date.now(), ttlMs: 60000,
  }), "utf-8");
  const result = acquirePolicyLock(root, { owner: "other" });
  expect(result.acquired).toBe(false);
  expect(result.reason).toBe("held_by_other");
  expect(result.holder?.owner).toBe("live-owner");
});

test("EigenFluxPolicyLockTest.test_corrupt_lock_fails_closed", () => {
  const root = makeRoot();
  const lockPath = policyLockPath(root);
  mkdirSync(join(root, "eigenflux"), { recursive: true });
  writeFileSync(lockPath, "not-json", "utf-8");
  expect(() => readPolicyLockHolder(lockPath)).toThrow(/损坏/);
  const result = acquirePolicyLock(root);
  expect(result.acquired).toBe(false);
  expect(result.reason).toBe("lock_holder_invalid");
  expect(readFileSync(lockPath, "utf-8")).toBe("not-json");
});

test("EigenFluxPolicyLockTest.test_symlink_lock_rejected", () => {
  const root = makeRoot();
  const lockPath = policyLockPath(root);
  mkdirSync(join(root, "eigenflux"), { recursive: true });
  const target = join(root, "outside-lock.json");
  writeFileSync(target, "{}", "utf-8");
  symlinkSync(target, lockPath);
  expect(() => acquirePolicyLock(root)).toThrow(/符号链接/);
  expect(() => readPolicyLockHolder(lockPath)).toThrow(/符号链接/);
  expect(readFileSync(target, "utf-8")).toBe("{}");
});

// --- onboarding：只报告，不执行 ---

test("EigenFluxOnboardingTest.test_steps_report_only_never_execute", () => {
  const root = makeRoot();
  let findCalls = 0;
  let probeCalls = 0;
  const report = onboardingSteps({ root }, {
    findCli: () => { findCalls++; return null; },
    runProbe: () => { probeCalls++; return okProbe(); },
  });
  expect(report.blocked).toBe(true);
  expect(report.onboardingComplete).toBe(false);
  expect(report.networkActionsAllowed).toBe(false);
  expect(report.requiresHumanOnboarding).toBe(true);
  expect(report.steps.length).toBe(6);
  expect(report.steps.map((s) => s.id)).toEqual([
    "cli_installed", "identity_home", "ef_onboarding_permission",
    "identity_credentials", "skills_installed", "network_capabilities",
  ]);
  const gated = report.steps.filter((s) => s.requiresHumanConfirmation);
  expect(gated.map((s) => s.id)).toEqual([
    "ef_onboarding_permission", "identity_credentials", "network_capabilities",
  ]);
  for (const step of gated) {
    expect(step.status).toBe("awaiting_confirmation");
    expect(step.confirmationRequired.length).toBeGreaterThan(0);
  }
  expect(report.steps[0].status).toBe("missing");
  expect(report.steps[4].status).toBe("not_checked");
  expect(findCalls).toBe(1);
  expect(probeCalls).toBe(0);
  expect(report.note).toContain("须用户前台逐项确认");
});

test("EigenFluxOnboardingTest.test_check_fills_cli_and_skills_status", () => {
  const root = makeRoot();
  const report = onboardingSteps({ root, check: true }, {
    findCli: () => "/usr/bin/eigenflux",
    runProbe: () => okProbe("EigenFlux v1.0.2\n"),
  });
  expect(report.steps[0].status).toBe("ready");
  expect(report.steps[0].detail).toContain("1.0.2");
  expect(report.steps[4].status).toBe("ready");
  // 即使诊断全过，入网确认门仍在：仍 blocked、仍未完成。
  expect(report.blocked).toBe(true);
  expect(report.onboardingComplete).toBe(false);
  expect(report.steps[2].status).toBe("awaiting_confirmation");
});

test("EigenFluxOnboardingTest.test_check_without_cli_blocks_skills_step", () => {
  const root = makeRoot();
  const report = onboardingSteps({ root, check: true }, {
    findCli: () => null,
    runProbe: () => okProbe(),
  });
  expect(report.steps[0].status).toBe("missing");
  expect(report.steps[4].status).toBe("blocked");
  expect(report.blocked).toBe(true);
});
