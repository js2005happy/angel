// tests/node/test-roster-stop.test.ts — H-1 实时花名册 + H-3 单点停止。
// 钉住的事：
//   - 花名册只读快照：状态 + 已耗时 + 当前动作；列表里不出现 token/费用；
//   - 阶段口径复用 DSH-5（新鲜心跳 = 进行中，心跳超 120 秒 = 已卡住，
//     resume_pending/suspended = 已卡住，终态 = 空闲，任务板 review = 等审阅）；
//   - 停止是“请求”不是“已停”：请求只记账本 + 事件 + 任务板送 review，
//     停没停下以 confirm-stopped 为准；子树沿 parentRunId 递归；
//   - 已请求停止的行不续跑、不自动续跑；取消请求后恢复正常；
//   - 3 个新事件注册进 EVENT_FIELDS，时间线能渲染。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore, type RunState } from "../../src/runs.ts";
import { saveSession } from "../../src/memory.ts";
import { buildTimeline } from "../../src/timeline.ts";
import {
  registerSubagentRun, getSubagentRun, heartbeatSubagent,
  sweepSubagents, prepareSubagentResume, loadSubagentRegistry, saveSubagentRegistry,
  requestSubagentStop, acknowledgeSubagentStop, cancelSubagentStop, isStopRequested,
  STALE_HEARTBEAT_MS,
} from "../../src/resume.ts";
import { createKanbanTask, startKanbanTask, getKanbanTask } from "../../src/kanban.ts";
import { buildRoster, formatRosterText, getRosterDetail, formatRosterDetailText } from "../../src/roster.ts";

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

/** 在任务队列里建一个指定状态的运行（含空会话）。 */
function makeTaskRun(home: string, status: string): RunState {
  const store = new RunStore(join(home, "tasks"));
  const state = store.create("子 agent 任务", `sess-${Math.random().toString(36).slice(2, 8)}`, home, "auto", 10, status);
  saveSession(state.session_id, [], home);
  return state;
}

function setRegistryRow(home: string, runId: string, extra: Record<string, unknown>): void {
  const registry = loadSubagentRegistry(home);
  const row = registry.runs.find((r) => r.runId === runId)!;
  Object.assign(row, extra);
  saveSubagentRegistry(home, registry);
}

test("RosterStopTest.test_empty_roster", () => {
  const home = tmpHome("nyra-roster-");
  expect(buildRoster(home)).toHaveLength(0);
  expect(formatRosterText([])).toContain("花名册是空的");
});

test("RosterStopTest.test_running_row_stage_and_elapsed", () => {
  const home = tmpHome("nyra-roster-");
  const row = registerSubagentRun(home, { runId: "run-1", agent: "nyra" });
  heartbeatSubagent(home, "run-1", "写完了第二章");
  const created = new Date(row.createdAt).getTime();
  const rows = buildRoster(home, { now: new Date(created + 90_000) });
  expect(rows).toHaveLength(1);
  expect(rows[0].stage.stage).toBe("working");
  expect(rows[0].elapsedMs).toBe(90_000);
  expect(rows[0].currentAction).toBe("写完了第二章");
  expect(rows[0].stopRequested).toBe(false);
  const text = formatRosterText(rows);
  expect(text).toContain("run-1");
  expect(text).toContain("进行中");
  expect(text).toContain("1m 30s");
  expect(text).toContain("写完了第二章");
  // 列表里不出现 token/费用（桌面取舍原则：只放状态 + 耗时 + 当前动作）。
  const json = JSON.stringify(rows);
  expect(json).not.toContain("token");
  expect(json).not.toContain("spent_usd");
  expect(json).not.toContain("cost");
});

test("RosterStopTest.test_stale_heartbeat_blocked_and_terminal_hidden", () => {
  const home = tmpHome("nyra-roster-");
  const old = new Date(Date.now() - STALE_HEARTBEAT_MS - 1000).toISOString();
  registerSubagentRun(home, { runId: "run-old" });
  setRegistryRow(home, "run-old", { lastHeartbeatAt: old });
  registerSubagentRun(home, { runId: "run-done" });
  setRegistryRow(home, "run-done", { status: "completed" });
  const rows = buildRoster(home);
  expect(rows.map((r) => r.id)).toEqual(["run-old"]);
  expect(rows[0].stage.stage).toBe("blocked");
  expect(rows[0].stage.waitingFor).toContain("心跳超时");
  const all = buildRoster(home, { includeTerminal: true });
  expect(all.map((r) => r.id).sort()).toEqual(["run-done", "run-old"]);
  expect(all.find((r) => r.id === "run-done")!.stage.stage).toBe("idle");
});

test("RosterStopTest.test_resume_pending_and_suspended_blocked", () => {
  const home = tmpHome("nyra-roster-");
  registerSubagentRun(home, { runId: "run-pending" });
  setRegistryRow(home, "run-pending", { status: "resume_pending" });
  registerSubagentRun(home, { runId: "run-susp" });
  setRegistryRow(home, "run-susp", { status: "suspended", restarts: 3 });
  const rows = buildRoster(home);
  expect(rows.find((r) => r.id === "run-pending")!.stage.stage).toBe("blocked");
  expect(rows.find((r) => r.id === "run-susp")!.stage.waitingFor).toContain("连崩 3 次");
});

test("RosterStopTest.test_kanban_delegate_task_row", () => {
  const home = tmpHome("nyra-roster-");
  const task = createKanbanTask(home, { title: "写第三章", kind: "delegate" });
  startKanbanTask(home, task.id);
  const rows = buildRoster(home);
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("delegate-task");
  expect(rows[0].stage.stage).toBe("working");
  expect(rows[0].currentAction).toBe("写第三章");
  expect(formatRosterText(rows)).toContain("任务板任务");
  // 绑了注册表行的任务挂到同一行上，不另起一行。
  registerSubagentRun(home, { runId: "run-1" });
  const task2 = createKanbanTask(home, { title: "写第四章", kind: "delegate" });
  startKanbanTask(home, task2.id, "run-1");
  const rows2 = buildRoster(home);
  expect(rows2).toHaveLength(2);
  expect(rows2.find((r) => r.id === "run-1")!.kanbanTaskId).toBe(task2.id);
});

test("RosterStopTest.test_stop_request_marks_row_routes_kanban_to_review_and_recurses", () => {
  const home = tmpHome("nyra-roster-");
  const run = makeTaskRun(home, "running");
  registerSubagentRun(home, { runId: run.run_id, agent: "nyra" });
  heartbeatSubagent(home, run.run_id, "写到第三步");
  registerSubagentRun(home, { runId: "run-child", parentRunId: run.run_id });
  const task = createKanbanTask(home, { title: "写第三章", kind: "delegate" });
  startKanbanTask(home, task.id, run.run_id);
  const report = requestSubagentStop(home, run.run_id, { by: "tester", reason: "跑偏了" });
  expect(report.requested.sort()).toEqual(["run-child", run.run_id].sort());
  expect(report.skipped).toHaveLength(0);
  const row = getSubagentRun(home, run.run_id);
  expect(row.status).toBe("running");
  expect(row.stopRequestedAt).not.toBeNull();
  expect(row.stopRequestedBy).toBe("tester");
  expect(row.stopNote).toBe("跑偏了");
  expect(isStopRequested(home, run.run_id)).toBe(true);
  expect(isStopRequested(home, "run-child")).toBe(true);
  // 花名册上标“已请求停止”，阶段仍是进行中（请求不是已停）。
  const rows = buildRoster(home);
  expect(rows.find((r) => r.id === run.run_id)!.stopRequested).toBe(true);
  expect(formatRosterText(rows)).toContain("已请求停止");
  // 任务板任务走了 partial 路径：working → review，备注写清停在哪步。
  const after = getKanbanTask(home, task.id);
  expect(after.status).toBe("review");
  expect(after.review?.note).toContain("写到第三步");
  // 事件进运行记录。
  const store = new RunStore(join(home, "tasks"));
  const events = store.readEvents(run.run_id);
  expect(events.some((e) => (e as Record<string, unknown>).type === "subagent_stop_requested")).toBe(true);
});

test("RosterStopTest.test_stop_idempotent_and_terminal_skipped", () => {
  const home = tmpHome("nyra-roster-");
  registerSubagentRun(home, { runId: "run-1" });
  registerSubagentRun(home, { runId: "run-done" });
  setRegistryRow(home, "run-done", { status: "completed" });
  const first = requestSubagentStop(home, "run-1", { by: "tester" });
  expect(first.requested).toEqual(["run-1"]);
  const second = requestSubagentStop(home, "run-1", { by: "tester" });
  expect(second.requested).toHaveLength(0);
  expect(second.alreadyRequested).toEqual(["run-1"]);
  const done = requestSubagentStop(home, "run-done", { by: "tester" });
  expect(done.requested).toHaveLength(0);
  expect(done.skipped[0].reason).toContain("已终态");
  expect(() => requestSubagentStop(home, "run-missing", { by: "tester" })).not.toThrow();
  expect(requestSubagentStop(home, "run-missing", { by: "tester" }).skipped[0].reason).toContain("没有这个运行");
});

test("RosterStopTest.test_stop_blocks_resume_and_auto_resume", async () => {
  const home = tmpHome("nyra-roster-");
  const old = new Date(Date.now() - STALE_HEARTBEAT_MS - 1000).toISOString();
  registerSubagentRun(home, { runId: "run-1", autoResume: true });
  setRegistryRow(home, "run-1", { lastHeartbeatAt: old });
  requestSubagentStop(home, "run-1", { by: "tester" });
  // 续跑拒绝（先取消请求或确认停下）。
  expect(() => prepareSubagentResume(home, "run-1", {})).toThrow("已请求停止");
  // 扫荡标 resume_pending，但自动续跑跳过已请求停止的行。
  const report = await sweepSubagents(home, { auto: true });
  expect(report.markedPending).toEqual(["run-1"]);
  expect(report.resumed).toHaveLength(0);
  expect(getSubagentRun(home, "run-1").status).toBe("resume_pending");
  // 取消请求后，请求清掉、钩子复位。
  const row = cancelSubagentStop(home, "run-1", { by: "tester" });
  expect(row.stopRequestedAt).toBeNull();
  expect(isStopRequested(home, "run-1")).toBe(false);
  expect(() => cancelSubagentStop(home, "run-1", { by: "tester" })).toThrow("没有待处理的停止请求");
});

test("RosterStopTest.test_confirm_stopped_settles_and_blocks_heartbeat", () => {
  const home = tmpHome("nyra-roster-");
  const run = makeTaskRun(home, "running");
  registerSubagentRun(home, { runId: run.run_id });
  heartbeatSubagent(home, run.run_id, "写到第五步");
  requestSubagentStop(home, run.run_id, { by: "tester" });
  const row = acknowledgeSubagentStop(home, run.run_id, { by: "tester" });
  expect(row.status).toBe("stopped");
  expect(row.stopReason).toBe("cancelled");
  expect(row.stoppedAt).not.toBeNull();
  expect(row.lastStep).toBe("写到第五步");
  expect(() => heartbeatSubagent(home, run.run_id, "还想写")).toThrow("已终态");
  expect(() => acknowledgeSubagentStop(home, run.run_id, { by: "tester" })).toThrow("只能确认 running/resume_pending");
  const store = new RunStore(join(home, "tasks"));
  const events = store.readEvents(run.run_id);
  expect(events.some((e) => (e as Record<string, unknown>).type === "subagent_stopped")).toBe(true);
  // 终态行默认不出花名册，--all 才出，阶段是空闲。
  expect(buildRoster(home).map((r) => r.id)).not.toContain(run.run_id);
  const all = buildRoster(home, { includeTerminal: true });
  expect(all.find((r) => r.id === run.run_id)!.stage.stage).toBe("idle");
});

test("RosterStopTest.test_events_registered_and_timeline_renders", () => {
  const home = tmpHome("nyra-roster-");
  const run = makeTaskRun(home, "running");
  const store = new RunStore(join(home, "tasks"));
  // 三个新事件写得进证据链（没注册进 EVENT_FIELDS 会抛错）。
  store.appendEvent(run.run_id, "subagent_stop_requested", { run_id: run.run_id, by: "tester", step: "写到第二步" });
  store.appendEvent(run.run_id, "subagent_stopped", { run_id: run.run_id, by: "tester", step: "写到第二步" });
  store.appendEvent(run.run_id, "subagent_stop_cancelled", { run_id: run.run_id, by: "tester" });
  const tl = buildTimeline(store, run.run_id);
  const titles = tl.steps.map((s) => s.title);
  expect(titles.some((t) => t.includes("已请求停止"))).toBe(true);
  expect(titles.some((t) => t.includes("已确认停下"))).toBe(true);
  expect(titles.some((t) => t.includes("停止请求已取消"))).toBe(true);
});

test("RosterStopTest.test_roster_detail_shows_usage_only_in_detail", () => {
  const home = tmpHome("nyra-roster-");
  const run = makeTaskRun(home, "running");
  const store = new RunStore(join(home, "tasks"));
  store.update(run.run_id, {
    usage_summary: {
      calls: 3, prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
      spent_usd: 0.001, cost_status: "priced", delegate_spent_usd: null,
      delegate_calls: 1, voice_spent_usd: null, voice_calls: 0,
    },
  });
  registerSubagentRun(home, { runId: run.run_id });
  heartbeatSubagent(home, run.run_id, "写完了第一章");
  const detail = getRosterDetail(home, run.run_id);
  expect(detail.usage?.totalTokens).toBe(150);
  expect(detail.usage?.spentUsd).toBe(0.001);
  const text = formatRosterDetailText(detail);
  expect(text).toContain("用量详情");
  expect(text).toContain("150");
  expect(() => getRosterDetail(home, "run-missing")).toThrow("花名册里没有");
});

test("RosterStopTest.test_subtree_depth_indent", () => {
  const home = tmpHome("nyra-roster-");
  registerSubagentRun(home, { runId: "run-parent" });
  registerSubagentRun(home, { runId: "run-child", parentRunId: "run-parent" });
  registerSubagentRun(home, { runId: "run-grandchild", parentRunId: "run-child" });
  const rows = buildRoster(home);
  expect(rows.find((r) => r.id === "run-parent")!.depth).toBe(0);
  expect(rows.find((r) => r.id === "run-child")!.depth).toBe(1);
  expect(rows.find((r) => r.id === "run-grandchild")!.depth).toBe(2);
  const text = formatRosterText(rows);
  expect(text.split("\n").find((l) => l.includes("run-grandchild"))!.startsWith("    ")).toBe(true);
});

test("RosterStopTest.test_cli_end_to_end", () => {
  const home = tmpHome("nyra-roster-");
  const reg = runCli(home, ["subagent", "register", "run-1"]);
  expect(reg.status).toBe(0);
  const hb = runCli(home, ["subagent", "heartbeat", "run-1", "写完了第二章"]);
  expect(hb.status).toBe(0);
  const list = runCli(home, ["roster", "list"]);
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("run-1");
  expect(list.stdout).toContain("进行中");
  expect(list.stdout).toContain("写完了第二章");
  // 行里不出现 token/费用（表头那句“token/费用默认不显示”是口径说明，不是数字）。
  const rowLines = list.stdout.split("\n").filter((l) => l.startsWith("run-1"));
  expect(rowLines).toHaveLength(1);
  expect(rowLines[0]).not.toContain("token");
  // 没 --yes 不给停。
  const noYes = runCli(home, ["subagent", "stop", "run-1"]);
  expect(noYes.status).toBe(2);
  expect(noYes.stderr).toContain("--yes");
  const stop = runCli(home, ["subagent", "stop", "run-1", "--yes", "--reason", "跑偏了"]);
  expect(stop.status).toBe(0);
  expect(stop.stdout).toContain("已请求停止");
  expect(stop.stdout).toContain("请求停止");
  const listed = runCli(home, ["roster", "list"]);
  expect(listed.stdout).toContain("已请求停止");
  const confirm = runCli(home, ["subagent", "confirm-stopped", "run-1"]);
  expect(confirm.status).toBe(0);
  expect(confirm.stdout).toContain("已确认停下");
  const gone = runCli(home, ["roster", "list"]);
  expect(gone.stdout).not.toContain("run-1");
  const all = runCli(home, ["roster", "list", "--all"]);
  expect(all.stdout).toContain("run-1");
  expect(all.stdout).toContain("已停下");
  const show = runCli(home, ["roster", "show", "run-1"]);
  expect(show.status).toBe(0);
  expect(show.stdout).toContain("用量详情");
});
