// tests/node/test-subagent-resume.test.ts — 缺口 30 崩溃自续与持久子 agent。
// 钉住的事：
//   - 注册表往返（原子写 0600、损坏先备份再抛错）、注册去重、心跳检查点；
//   - 启动扫荡：心跳超 120 秒标 resume_pending、连崩 3 次挂起、近期心跳不动、
//     活着的 worker 持锁时整个扫荡跳过；
//   - 先验状态再续跑：运行记录找不到 / 状态不可续 / 挂起没 --force /
//     工作目录没了，全部拒绝且不动运行；无人值守续跑强制只读；
//   - 续跑执行（假 runner）：终态回写注册表（完成/失败/等审批/中断）；
//   - 挂起与 CLI 端到端。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { RunStore, type RunState } from "../../src/runs.ts";
import { saveSession } from "../../src/memory.ts";
import {
  registerSubagentRun, getSubagentRun, listSubagentRuns, heartbeatSubagent,
  sweepSubagents, prepareSubagentResume, resumeSubagentRun, suspendSubagentRun,
  subagentRegistryPath, loadSubagentRegistry, saveSubagentRegistry, ResumeError,
  STALE_HEARTBEAT_MS,
} from "../../src/resume.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

/** 在任务队列里建一个指定状态的运行（含空会话，prepareResume 才读得到）。 */
function makeTaskRun(home: string, status: string): RunState {
  const store = new RunStore(join(home, "tasks"));
  const state = store.create("子 agent 任务", `sess-${Math.random().toString(36).slice(2, 8)}`, home, "auto", 10, status);
  saveSession(state.session_id, [], home);
  return state;
}

function setRegistryStatus(home: string, runId: string, status: string, extra: Record<string, unknown> = {}): void {
  const registry = loadSubagentRegistry(home);
  const row = registry.runs.find((r) => r.runId === runId)!;
  Object.assign(row, { status, ...extra });
  saveSubagentRegistry(home, registry);
}

function fakeRunner(finalStatus: string) {
  return async (state: RunState): Promise<[RunState, string]> => {
    return [{ ...state, status: finalStatus }, `假执行：${finalStatus}`];
  };
}

test("SubagentResumeTest.test_register_list_and_duplicate", () => {
  const home = tmpHome("nyra-subagent-");
  const row = registerSubagentRun(home, { runId: "run-1", agent: "nyra", sessionId: "sess-1", autoResume: true });
  expect(row.status).toBe("running");
  expect(row.autoResume).toBe(true);
  expect(row.restarts).toBe(0);
  expect(listSubagentRuns(home)).toHaveLength(1);
  expect(getSubagentRun(home, "run-1").runId).toBe("run-1");
  expectPerms(subagentRegistryPath(home), 0o600);
  expect(() => registerSubagentRun(home, { runId: "run-1" })).toThrow(ResumeError);
  expect(() => getSubagentRun(home, "run-missing")).toThrow(ResumeError);
});

test("SubagentResumeTest.test_registry_corrupt_backup", () => {
  const home = tmpHome("nyra-subagent-");
  registerSubagentRun(home, { runId: "run-1" });
  writeFileSync(subagentRegistryPath(home), "{ 坏了");
  expect(() => listSubagentRuns(home)).toThrow(ResumeError);
  const backups = readdirSync(home).filter((f) => f.startsWith("subagents.json.corrupt-"));
  expect(backups).toHaveLength(1);
  expect(existsSync(join(home, backups[0]))).toBe(true);
});

test("SubagentResumeTest.test_heartbeat_records_step_and_terminal_refuses", () => {
  const home = tmpHome("nyra-subagent-");
  registerSubagentRun(home, { runId: "run-1" });
  const row = heartbeatSubagent(home, "run-1", "写完了第二章");
  expect(row.lastStep).toBe("写完了第二章");
  expect(row.lastHeartbeatAt).not.toBeNull();
  setRegistryStatus(home, "run-1", "completed");
  expect(() => heartbeatSubagent(home, "run-1", "还想写")).toThrow(ResumeError);
});

test("SubagentResumeTest.test_sweep_marks_stale_and_suspends_after_three_restarts", async () => {
  const home = tmpHome("nyra-subagent-");
  const old = new Date(Date.now() - STALE_HEARTBEAT_MS - 1000).toISOString();
  registerSubagentRun(home, { runId: "run-old" });
  setRegistryStatus(home, "run-old", "running", { lastHeartbeatAt: old });
  registerSubagentRun(home, { runId: "run-poison" });
  setRegistryStatus(home, "run-poison", "running", { lastHeartbeatAt: old, restarts: 3 });
  registerSubagentRun(home, { runId: "run-fresh" });
  heartbeatSubagent(home, "run-fresh", "刚心跳过");
  const report = await sweepSubagents(home, {});
  expect(report.markedPending).toEqual(["run-old"]);
  expect(report.suspended).toEqual(["run-poison"]);
  expect(getSubagentRun(home, "run-old").status).toBe("resume_pending");
  expect(getSubagentRun(home, "run-old").stopReason).toBe("crashed");
  expect(getSubagentRun(home, "run-poison").status).toBe("suspended");
  expect(getSubagentRun(home, "run-fresh").status).toBe("running");
});

test("SubagentResumeTest.test_sweep_skips_when_worker_lock_held", async () => {
  const home = tmpHome("nyra-subagent-");
  mkdirSync(join(home, "tasks"), { recursive: true });
  const lockPath = join(home, "tasks", "worker.lock");
  const fd = openSync(lockPath, "w", 0o600);
  writeSync(fd, String(process.pid), null, "utf-8");
  closeSync(fd);
  registerSubagentRun(home, { runId: "run-1" });
  const report = await sweepSubagents(home, {});
  expect(report.skipped).toContain("已有 worker 在运行");
  expect(report.markedPending).toHaveLength(0);
  expect(getSubagentRun(home, "run-1").status).toBe("running");
});

test("SubagentResumeTest.test_prepare_verifies_before_resume", () => {
  const home = tmpHome("nyra-subagent-");
  // 运行记录找不到：拒绝。
  registerSubagentRun(home, { runId: "run-ghost" });
  setRegistryStatus(home, "run-ghost", "resume_pending");
  expect(() => prepareSubagentResume(home, "run-ghost")).toThrow(/找不到运行记录/);
  // 状态不可续（verified）：拒绝，且注册表不动。
  const verified = makeTaskRun(home, "verified");
  registerSubagentRun(home, { runId: verified.run_id });
  setRegistryStatus(home, verified.run_id, "resume_pending");
  expect(() => prepareSubagentResume(home, verified.run_id)).toThrow(/不能续跑/);
  expect(getSubagentRun(home, verified.run_id).status).toBe("resume_pending");
  // 挂起没 --force：拒绝；有 --force：验过。
  const failed = makeTaskRun(home, "failed");
  registerSubagentRun(home, { runId: failed.run_id });
  setRegistryStatus(home, failed.run_id, "suspended");
  expect(() => prepareSubagentResume(home, failed.run_id)).toThrow(/--force/);
  const prepared = prepareSubagentResume(home, failed.run_id, { force: true });
  expect(prepared.restarts).toBe(1);
  expect(getSubagentRun(home, failed.run_id).status).toBe("running");
  // 工作目录没了：拒绝。
  const gone = makeTaskRun(home, "failed");
  registerSubagentRun(home, { runId: gone.run_id });
  setRegistryStatus(home, gone.run_id, "resume_pending");
  const registry = loadSubagentRegistry(home);
  const found = new RunStore(join(home, "tasks"));
  found.update(gone.run_id, { workdir: join(home, "no-such-dir") });
  void registry;
  expect(() => prepareSubagentResume(home, gone.run_id)).toThrow(/工作目录不存在/);
});

test("SubagentResumeTest.test_prepare_unattended_forces_readonly", () => {
  const home = tmpHome("nyra-subagent-");
  const failed = makeTaskRun(home, "failed");
  registerSubagentRun(home, { runId: failed.run_id, unattended: true });
  setRegistryStatus(home, failed.run_id, "resume_pending");
  const prepared = prepareSubagentResume(home, failed.run_id);
  expect(prepared.nextState.mode).toBe("readonly");
  const store = new RunStore(join(home, "tasks"));
  expect(store.readEvents(failed.run_id).some((e) => e.type === "subagent_resumed" && e.mode === "readonly")).toBe(true);
});

test("SubagentResumeTest.test_resume_finalizes_registry_by_outcome", async () => {
  const home = tmpHome("nyra-subagent-");
  const cases: Array<[string, string, string]> = [
    ["verified", "completed", "completed"],
    ["failed", "failed", "unknown"],
    ["awaiting_approval", "resume_pending", "approval_blocked"],
    ["interrupted", "resume_pending", "crashed"],
  ];
  for (const [finalStatus, wantStatus, wantReason] of cases) {
    const run = makeTaskRun(home, "failed");
    registerSubagentRun(home, { runId: run.run_id });
    setRegistryStatus(home, run.run_id, "resume_pending");
    const result = await resumeSubagentRun(home, run.run_id, { runner: fakeRunner(finalStatus) });
    expect(result.status).toBe(finalStatus);
    const row = getSubagentRun(home, run.run_id);
    expect(row.status).toBe(wantStatus);
    expect(row.stopReason).toBe(wantReason);
  }
});

test("SubagentResumeTest.test_suspend_rules", () => {
  const home = tmpHome("nyra-subagent-");
  registerSubagentRun(home, { runId: "run-1" });
  const row = suspendSubagentRun(home, "run-1");
  expect(row.status).toBe("suspended");
  setRegistryStatus(home, "run-1", "completed");
  expect(() => suspendSubagentRun(home, "run-1")).toThrow(ResumeError);
});

test("SubagentResumeTest.test_cli_end_to_end", async () => {
  const home = tmpHome("nyra-subagent-");
  const run = makeTaskRun(home, "failed");
  expect(runCli(home, ["subagent", "register", run.run_id]).status).toBe(0);
  expect(runCli(home, ["subagent", "heartbeat", run.run_id, "做到一半"]).status).toBe(0);
  expect(runCli(home, ["subagent", "list"]).stdout).toContain(run.run_id);
  // 扫荡：心跳刚记过，不到期不动；改旧心跳后扫荡标 pending。
  const registry = loadSubagentRegistry(home);
  const row = registry.runs.find((r) => r.runId === run.run_id)!;
  row.lastHeartbeatAt = new Date(Date.now() - STALE_HEARTBEAT_MS - 1000).toISOString();
  saveSubagentRegistry(home, registry);
  const swept = runCli(home, ["subagent", "sweep"]);
  expect(swept.status).toBe(0);
  expect(swept.stdout).toContain("标 resume_pending 1 个");
  expect(getSubagentRun(home, run.run_id).status).toBe("resume_pending");
  expect(runCli(home, ["subagent", "nope"]).status).toBe(2);
});
