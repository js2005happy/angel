// tests/node/test-evidence-chain.test.ts — P1-2：证据链落盘与独立复核。
// 三元组（工具调用 → 产物 → 校验结果）从底层记录重算，不信任 status 字段本身；
// 缺证据的完成声明直接失败（与 P1-1 的降级逻辑一致）。
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore, verifyEvidenceChain } from "../../src/runs.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-evidence-chain-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-evidence-wd-"));
  return { home, workdir };
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function check(result: ReturnType<typeof verifyEvidenceChain>, name: string) {
  return result.checks.find((c) => c.name === name);
}

/** 建一个“已验证通过”的运行：两个工具调用闭合、一个产物文件、哈希一致。 */
function makeVerifiedRun(home: string, workdir: string) {
  const store = new RunStore(join(home, "runs"));
  const state = store.create("写个文件", "sess-1", workdir, "auto", 5, "running", "true");
  writeFileSync(join(workdir, "a.txt"), "hello\n");
  store.appendEvent(state.run_id, "tool_start", { id: "c1", name: "write_file" });
  store.appendEvent(state.run_id, "tool_result", { id: "c1", name: "write_file", ok: true });
  store.appendEvent(state.run_id, "tool_start", { id: "c2", name: "read_file" });
  store.appendEvent(state.run_id, "tool_result", { id: "c2", name: "read_file", ok: true });
  store.update(state.run_id, {
    changed_files: ["a.txt"],
    file_hashes: { "a.txt": sha("hello\n") },
    verify_result: { exit_code: 0, passed: true, attempt: 1, tests_modified: false },
  });
  store.setStatus(state.run_id, "verified");
  return { store, runId: state.run_id };
}

test("EvidenceChain.test_verified_run_passes", () => {
  const { home, workdir } = setup();
  const { store, runId } = makeVerifiedRun(home, workdir);
  const r = verifyEvidenceChain(store, runId);
  expect(r.passed).toBe(true);
  expect(r.status).toBe("verified");
  expect(check(r, "verify-result")?.ok).toBe(true);
  expect(check(r, "tool-calls-closed")?.ok).toBe(true);
  expect(check(r, "artifacts-present")?.ok).toBe(true);
  expect(check(r, "artifacts-hash")?.ok).toBe(true);
});

test("EvidenceChain.test_tampered_artifact_fails_hash", () => {
  const { home, workdir } = setup();
  const { store, runId } = makeVerifiedRun(home, workdir);
  writeFileSync(join(workdir, "a.txt"), "tampered\n");
  const r = verifyEvidenceChain(store, runId);
  expect(r.passed).toBe(false);
  expect(check(r, "artifacts-hash")?.ok).toBe(false);
  expect(check(r, "artifacts-present")?.ok).toBe(true);
  expect(check(r, "verify-result")?.ok).toBe(true);
});

test("EvidenceChain.test_missing_artifact_fails", () => {
  const { home, workdir } = setup();
  const { store, runId } = makeVerifiedRun(home, workdir);
  rmSync(join(workdir, "a.txt"));
  const r = verifyEvidenceChain(store, runId);
  expect(r.passed).toBe(false);
  expect(check(r, "artifacts-present")?.ok).toBe(false);
  expect(check(r, "artifacts-hash")?.ok).toBe(false);
});

test("EvidenceChain.test_dangling_tool_call_fails", () => {
  const { home, workdir } = setup();
  const { store, runId } = makeVerifiedRun(home, workdir);
  store.appendEvent(runId, "tool_start", { id: "c3", name: "shell" });
  const r = verifyEvidenceChain(store, runId);
  expect(r.passed).toBe(false);
  const c = check(r, "tool-calls-closed");
  expect(c?.ok).toBe(false);
  expect(c?.detail).toContain("c3");
});

test("EvidenceChain.test_unverified_completion_fails", () => {
  const { home, workdir } = setup();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", workdir, "auto", 5);
  store.appendEvent(state.run_id, "tool_start", { id: "c1", name: "read_file" });
  store.appendEvent(state.run_id, "tool_result", { id: "c1", name: "read_file", ok: true });
  store.setStatus(state.run_id, "completed_unverified");
  const r = verifyEvidenceChain(store, state.run_id);
  expect(r.passed).toBe(false);
  expect(check(r, "verify-result")?.ok).toBe(false);
  expect(check(r, "verify-result")?.detail).toContain("未验证");
});

test("EvidenceChain.test_verified_without_verify_result_fails", () => {
  const { home, workdir } = setup();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", workdir, "auto", 5);
  store.appendEvent(state.run_id, "tool_start", { id: "c1", name: "read_file" });
  store.appendEvent(state.run_id, "tool_result", { id: "c1", name: "read_file", ok: true });
  store.setStatus(state.run_id, "verified");
  const r = verifyEvidenceChain(store, state.run_id);
  expect(r.passed).toBe(false);
  expect(check(r, "verify-result")?.ok).toBe(false);
  expect(check(r, "verify-result")?.detail).toContain("记录不一致");
});

test("EvidenceChain.test_no_artifacts_verified_passes", () => {
  const { home, workdir } = setup();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("只读任务", "sess-1", workdir, "auto", 5, "running", "true");
  store.appendEvent(state.run_id, "tool_start", { id: "c1", name: "read_file" });
  store.appendEvent(state.run_id, "tool_result", { id: "c1", name: "read_file", ok: true });
  store.update(state.run_id, {
    verify_result: { exit_code: 0, passed: true, attempt: 1, tests_modified: false },
  });
  store.setStatus(state.run_id, "verified");
  const r = verifyEvidenceChain(store, state.run_id);
  expect(r.passed).toBe(true);
  expect(check(r, "artifacts-present")?.detail).toContain("无产物文件");
});

test("EvidenceChain.test_missing_hashes_fails", () => {
  const { home, workdir } = setup();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("写个文件", "sess-1", workdir, "auto", 5, "running", "true");
  writeFileSync(join(workdir, "a.txt"), "hello\n");
  store.appendEvent(state.run_id, "tool_start", { id: "c1", name: "write_file" });
  store.appendEvent(state.run_id, "tool_result", { id: "c1", name: "write_file", ok: true });
  store.update(state.run_id, {
    changed_files: ["a.txt"],
    verify_result: { exit_code: 0, passed: true, attempt: 1, tests_modified: false },
  });
  store.setStatus(state.run_id, "verified");
  const r = verifyEvidenceChain(store, state.run_id);
  expect(r.passed).toBe(false);
  expect(check(r, "artifacts-hash")?.ok).toBe(false);
  expect(check(r, "artifacts-hash")?.detail).toContain("缺少产物哈希证据");
});

test("EvidenceChain.test_tests_modified_is_noted_not_failed", () => {
  const { home, workdir } = setup();
  const { store, runId } = makeVerifiedRun(home, workdir);
  store.update(runId, {
    changed_files: ["a.txt", "tests/node/test-x.test.ts"],
    verify_result: { exit_code: 0, passed: true, attempt: 1, tests_modified: true },
  });
  mkdirSync(join(workdir, "tests/node"), { recursive: true });
  writeFileSync(join(workdir, "tests/node/test-x.test.ts"), "x\n");
  // 补上新文件的哈希，否则哈希检查会因缺哈希而失败。
  store.update(runId, {
    file_hashes: { "a.txt": sha("hello\n"), "tests/node/test-x.test.ts": sha("x\n") },
  });
  const r = verifyEvidenceChain(store, runId);
  expect(r.passed).toBe(true);
  expect(check(r, "tests-modified")?.detail).toContain("人工复核");
});

test("EvidenceChain.test_verify_failed_status_fails", () => {
  const { home, workdir } = setup();
  const { store, runId } = makeVerifiedRun(home, workdir);
  store.update(runId, { verify_result: { exit_code: 1, passed: false, attempt: 3, tests_modified: false } });
  store.setStatus(runId, "verify_failed");
  const r = verifyEvidenceChain(store, runId);
  expect(r.passed).toBe(false);
  expect(check(r, "verify-result")?.detail).toContain("验证未通过");
});

function runCli(args: string[], home: string): { code: number; out: string } {
  const r = spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra") },
    encoding: "utf-8", timeout: 60000,
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("EvidenceChain.test_cli_verify_pass_and_fail", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-evidence-cli-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-evidence-cli-wd-"));
  const nyraHome = join(home, ".nyra");
  const { store, runId } = makeVerifiedRun(nyraHome, workdir);
  void store;
  const ok = runCli(["evidence", "verify", runId], home);
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("结论：通过");
  writeFileSync(join(workdir, "a.txt"), "tampered\n");
  const bad = runCli(["evidence", "verify", runId], home);
  expect(bad.code).toBe(4);
  expect(bad.out).toContain("结论：失败");
  const missing = runCli(["evidence", "verify", "20990101-000000-abcdef"], home);
  expect(missing.code).toBe(1);
  expect(missing.out).toContain("错误");
  const usage = runCli(["evidence", "bogus"], home);
  expect(usage.code).toBe(2);
});
