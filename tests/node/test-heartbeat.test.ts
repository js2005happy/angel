// tests/node/test-heartbeat.test.ts — 缺口 31 Heartbeat 静默巡查 + 推断承诺。
// 钉住的事：
//   - monitor 增删改查与校验（间隔 5–1440 分钟、检查项白名单、去重）；
//   - 检查项只读：未读收件箱、任务板熔断、待续跑子 agent、已中断运行；
//   - 无事安静：没发现不写收件箱、只记审计；有发现先记证据再写收件箱；
//     未到间隔跳过、--force 重跑、停用的跳过；
//   - 推断承诺：提议态须确认一次才生效、确认两次拒绝、过期自动失效、
//     到期提醒一次且只进收件箱、过期不进记忆（账本里就是 expired）。
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../../src/runs.ts";
import { saveSession } from "../../src/memory.ts";
import { appendInbox, loadInbox, markInboxRead } from "../../src/tasks.ts";
import { createKanbanTask, startKanbanTask, failKanbanTask } from "../../src/kanban.ts";
import { registerSubagentRun, loadSubagentRegistry, saveSubagentRegistry, sweepSubagents, STALE_HEARTBEAT_MS } from "../../src/resume.ts";
import {
  addHeartbeatMonitor, listHeartbeatMonitors, setHeartbeatEnabled, removeHeartbeatMonitor,
  runHeartbeat, runChecks, runDueHeartbeats,
  proposeCommitment, confirmCommitment, doneCommitment, listCommitments,
  expireCommitments, remindDueCommitments, HeartbeatError,
} from "../../src/heartbeat.ts";

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

function isoIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

test("HeartbeatTest.test_monitor_crud_and_validation", () => {
  const home = tmpHome("nyra-heartbeat-");
  const m = addHeartbeatMonitor(home, { agent: "nyra", intervalMinutes: 30 });
  expect(m.enabled).toBe(true);
  expect(m.checks).toEqual(["inbox_unread", "kanban_blocked", "resume_pending", "stale_runs", "fanout_unfinished"]);
  expect(listHeartbeatMonitors(home)).toHaveLength(1);
  expect(() => addHeartbeatMonitor(home, { agent: "nyra" })).toThrow(HeartbeatError);
  expect(() => addHeartbeatMonitor(home, { agent: "x", intervalMinutes: 4 })).toThrow(HeartbeatError);
  expect(() => addHeartbeatMonitor(home, { agent: "x", intervalMinutes: 1441 })).toThrow(HeartbeatError);
  expect(() => addHeartbeatMonitor(home, { agent: "x", checks: ["nope" as never] })).toThrow(HeartbeatError);
  expect(setHeartbeatEnabled(home, "nyra", false).enabled).toBe(false);
  expect(setHeartbeatEnabled(home, "nyra", true).enabled).toBe(true);
  expect(() => setHeartbeatEnabled(home, "ghost", true)).toThrow(HeartbeatError);
  expect(removeHeartbeatMonitor(home, "nyra")).toBe(true);
  expect(removeHeartbeatMonitor(home, "nyra")).toBe(false);
});

test("HeartbeatTest.test_checks_are_readonly_findings", async () => {
  const home = tmpHome("nyra-heartbeat-");
  expect(runChecks(home, ["inbox_unread", "kanban_blocked", "resume_pending", "stale_runs"])).toEqual([]);
  appendInbox("run-1", "failed", "失败了", home);
  let findings = runChecks(home, ["inbox_unread"]);
  expect(findings).toHaveLength(1);
  expect(findings[0].summary).toContain("1 条未读");
  markInboxRead(home);
  expect(runChecks(home, ["inbox_unread"])).toEqual([]);
  // 任务板熔断：失败 3 次进 blocked。
  const task = createKanbanTask(home, { title: "总失败" });
  startKanbanTask(home, task.id);
  failKanbanTask(home, task.id, "炸1");
  startKanbanTask(home, task.id);
  failKanbanTask(home, task.id, "炸2");
  startKanbanTask(home, task.id);
  failKanbanTask(home, task.id, "炸3");
  findings = runChecks(home, ["kanban_blocked"]);
  expect(findings).toHaveLength(1);
  expect(findings[0].summary).toContain(task.id);
  // 待续跑子 agent：心跳旧了也不算——须扫荡标 pending 后才算。
  registerSubagentRun(home, { runId: "run-sub" });
  const registry = loadSubagentRegistry(home);
  registry.runs[0].lastHeartbeatAt = new Date(Date.now() - STALE_HEARTBEAT_MS - 1000).toISOString();
  saveSubagentRegistry(home, registry);
  expect(runChecks(home, ["resume_pending"])).toEqual([]);
  await sweepSubagents(home, {});
  findings = runChecks(home, ["resume_pending"]);
  expect(findings).toHaveLength(1);
  expect(findings[0].summary).toContain("1 个子 agent 等续跑");
  // 已中断运行：直接标 interrupted。
  const store = new RunStore(join(home, "tasks"));
  const state = store.create("中断的任务", "sess-9", home, "auto", 10, "running");
  saveSession(state.session_id, [], home);
  store.setStatus(state.run_id, "interrupted");
  findings = runChecks(home, ["stale_runs"]);
  expect(findings).toHaveLength(1);
  expect(findings[0].summary).toContain("1 个运行已中断");
});

test("HeartbeatTest.test_quiet_writes_audit_not_inbox_findings_write_inbox", () => {
  const home = tmpHome("nyra-heartbeat-");
  addHeartbeatMonitor(home, { agent: "nyra", intervalMinutes: 30 });
  const quiet = runHeartbeat(home, "nyra", { force: true });
  expect(quiet.quiet).toBe(true);
  expect(quiet.findings).toEqual([]);
  expect(loadInbox(home)).toHaveLength(0);
  const auditDir = join(home, "evidence", "heartbeat");
  expect(existsSync(auditDir)).toBe(true);
  expect(readdirSync(auditDir)).toHaveLength(1);
  const lines = readFileSync(join(auditDir, readdirSync(auditDir)[0]), "utf-8").trim().split("\n");
  expect(JSON.parse(lines[0]).findings).toBe(0);
  // 有发现：写收件箱。
  appendInbox("run-1", "failed", "失败了", home);
  const loud = runHeartbeat(home, "nyra", { force: true });
  expect(loud.quiet).toBe(false);
  expect(loud.findings).toHaveLength(1);
  const inbox = loadInbox(home);
  expect(inbox.some((i) => String(i.run_id).startsWith("heartbeat-nyra"))).toBe(true);
  // 未到间隔跳过；--force 重跑。
  const skipped = runHeartbeat(home, "nyra", {});
  expect(skipped.skipped).toBe("未到间隔");
  expect(runHeartbeat(home, "nyra", { force: true }).skipped).toBeNull();
  // 停用的跳过。
  setHeartbeatEnabled(home, "nyra", false);
  expect(runHeartbeat(home, "nyra", { force: true }).skipped).toBe("已停用");
});

test("HeartbeatTest.test_run_due_only_runs_due_monitors", () => {
  const home = tmpHome("nyra-heartbeat-");
  addHeartbeatMonitor(home, { agent: "nyra", intervalMinutes: 30 });
  addHeartbeatMonitor(home, { agent: "other", intervalMinutes: 30, checks: [] });
  const results = runDueHeartbeats(home);
  expect(results).toHaveLength(2);
  expect(results.every((r) => r.quiet)).toBe(true);
  expect(runDueHeartbeats(home)).toHaveLength(0); // 都未到间隔
});

test("HeartbeatTest.test_commitment_propose_confirm_expire_remind", () => {
  const home = tmpHome("nyra-heartbeat-");
  expect(() => proposeCommitment(home, { text: "", remindAt: isoIn(60), expiresAt: isoIn(120) })).toThrow(HeartbeatError);
  expect(() => proposeCommitment(home, { text: "x", remindAt: isoIn(120), expiresAt: isoIn(60) })).toThrow(/提醒时间须早于过期时间/);
  expect(() => proposeCommitment(home, { text: "x", remindAt: isoIn(-120), expiresAt: isoIn(-60) })).toThrow(/过期时间须在未来/);
  const c = proposeCommitment(home, { text: "下周二提醒我看报价", remindAt: isoIn(60), expiresAt: isoIn(24 * 60) });
  expect(c.id).toMatch(/^cm_[0-9a-f]{12}$/);
  expect(c.status).toBe("proposed");
  expect(() => doneCommitment(home, c.id)).toThrow(HeartbeatError);
  const confirmed = confirmCommitment(home, c.id);
  expect(confirmed.status).toBe("confirmed");
  expect(() => confirmCommitment(home, c.id)).toThrow(HeartbeatError);
  // 到期提醒：还没到时间不提醒；到了提醒一次，只进收件箱。
  expect(remindDueCommitments(home, new Date(Date.now() + 30 * 60_000))).toHaveLength(0);
  const reminded = remindDueCommitments(home, new Date(Date.now() + 61 * 60_000));
  expect(reminded).toHaveLength(1);
  expect(reminded[0].status).toBe("reminded");
  expect(loadInbox(home).some((i) => String(i.run_id) === `commitment-${c.id}`)).toBe(true);
  expect(remindDueCommitments(home, new Date(Date.now() + 62 * 60_000))).toHaveLength(0); // 不重复提醒
  expect(doneCommitment(home, c.id).status).toBe("done");
  // 过期自动失效：提议态过了期就是 expired，不进记忆、不提醒。
  const c2 = proposeCommitment(home, { text: "过期的跟进", remindAt: isoIn(60), expiresAt: isoIn(120) });
  const { expired } = expireCommitments(home, new Date(Date.now() + 121 * 60_000));
  expect(expired).toContain(c2.id);
  expect(listCommitments(home, { status: "expired" })).toHaveLength(1);
  expect(() => confirmCommitment(home, c2.id)).toThrow(HeartbeatError);
});

test("HeartbeatTest.test_cli_end_to_end", () => {
  const home = tmpHome("nyra-heartbeat-");
  expect(runCli(home, ["heartbeat", "add", "--agent", "nyra"]).status).toBe(0);
  expect(runCli(home, ["heartbeat", "list"]).stdout).toContain("nyra");
  const run = runCli(home, ["heartbeat", "run", "--agent", "nyra", "--force"]);
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("无事安静");
  const proposed = runCli(home, ["heartbeat", "commitments", "propose", "提醒我看报价", "--remind-at", isoIn(60), "--expires-at", isoIn(120)]);
  expect(proposed.status).toBe(0);
  const id = proposed.stdout.trim().split("（")[0];
  expect(id).toMatch(/^cm_[0-9a-f]{12}$/);
  expect(runCli(home, ["heartbeat", "commitments", "confirm", id]).status).toBe(0);
  expect(runCli(home, ["heartbeat", "commitments", "list"]).stdout).toContain(id);
  expect(runCli(home, ["heartbeat", "nope"]).status).toBe(2);
});
