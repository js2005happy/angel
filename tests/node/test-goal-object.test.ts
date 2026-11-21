// tests/node/test-goal-object.test.ts — GROK-5：长目标对象（缺口 26/30 深化）。
// 钉住的事：
//   - 目标账本往返（原子写 0600、损坏先备份再抛错、不静默重建）、创建校验；
//   - 清单状态机：pending → in_progress → verified/failed，失败可重做；
//   - 逐项验证：人工证据口径 + 供 --files 时接 verifier 确定性检查（检查不过
//     时声称的 passed 也不认，强制记 failed）；
//   - 完成门：清单全过才标完成（任务板行全 done 不算、模型自述不算），
//     空清单标不上去、paused 须先恢复；
//   - 暂停/恢复/取消：暂停保留进度，恢复前重验证（证据失效的项退回待做），
//     取消是终态；
//   - 中途加指令不丢目标（不重置清单、不动已验证项）；
//   - 任务板接线：拆/关联任务板任务，两边完成边界各算各的；
//   - 10 个新事件已注册进 EVENT_FIELDS（appendEvent 不抛错），时间线能渲染。
// 全部用临时 home，不连真实服务、不花真实 token。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import {
  createGoal, getGoalById, listGoals, addChecklistItem, startChecklistItem,
  verifyChecklistItem, goalCompletionStatus, completeGoal, pauseGoal, resumeGoal,
  cancelGoal, addInstruction, linkChecklistItem, splitChecklistItem,
  goalPath, goalProgress, GoalError,
} from "../../src/goal.ts";
import {
  startKanbanTask, verifyKanbanTask, completeKanbanTask, removeKanbanTask,
  KanbanError,
} from "../../src/kanban.ts";

function tmpHome(prefix = "nyra-goal-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function tmpWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "nyra-goal-wd-"));
}

function runCli(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

test("GoalObjectTest.test_create_fields_and_validation", () => {
  const home = tmpHome();
  const goal = createGoal(home, { statement: "上线 0.5.4", agent: "nyra", items: ["跑通全量测试", "推上 main"] });
  expect(goal.id).toMatch(/^goal_[0-9a-f]{12}$/);
  expect(goal.status).toBe("active");
  expect(goal.agent).toBe("nyra");
  expect(goal.checklist).toHaveLength(2);
  expect(goal.checklist[0].id).toMatch(/^chk_[0-9a-f]{8}$/);
  expect(goal.checklist[0].status).toBe("pending");
  expect(goal.checklist[0].verification).toBeNull();
  expect(goal.checklist[0].kanbanTaskId).toBeNull();
  expect(goal.completedAt).toBeNull();
  expect(goal.cancelReason).toBeNull();
  expect(() => createGoal(home, { statement: "" })).toThrow(GoalError);
  expect(() => createGoal(home, { statement: "x".repeat(1001) })).toThrow(GoalError);
  expect(() => createGoal(home, { statement: "t", agent: "Bad Agent" })).toThrow(GoalError);
  expect(() => createGoal(home, { statement: "t", items: ["x".repeat(201)] })).toThrow(GoalError);
  expect(() => createGoal(home, { statement: "t", items: Array.from({ length: 51 }, (_, i) => `项 ${i}`) })).toThrow(GoalError);
});

test("GoalObjectTest.test_store_roundtrip_perms_and_corrupt_backup", () => {
  const home = tmpHome();
  createGoal(home, { statement: "目标 A", items: ["第一项"] });
  const store = JSON.parse(readFileSync(goalPath(home), "utf-8")) as { version: number; goals: unknown[]; history: unknown[] };
  expect(store.version).toBe(1);
  expect(store.goals).toHaveLength(1);
  expect(store.history).toHaveLength(1);
  expectPerms(goalPath(home), 0o600);
  writeFileSync(goalPath(home), "{ 不是 json");
  expect(() => listGoals(home)).toThrow(GoalError);
  const backups = readdirSync(home).filter((f) => f.startsWith("goals.json.corrupt-"));
  expect(backups).toHaveLength(1);
  expect(existsSync(join(home, backups[0]))).toBe(true);
});

test("GoalObjectTest.test_checklist_state_machine", () => {
  const home = tmpHome();
  const goal = createGoal(home, { statement: "做一件事" });
  const item = addChecklistItem(home, goal.id, "第一步");
  expect(item.status).toBe("pending");
  expect(() => addChecklistItem(home, goal.id, "")).toThrow(GoalError);
  expect(() => addChecklistItem(home, goal.id, "x".repeat(201))).toThrow(GoalError);
  let cur = startChecklistItem(home, goal.id, item.id);
  expect(cur.status).toBe("in_progress");
  expect(() => startChecklistItem(home, goal.id, item.id)).toThrow(GoalError);
  // 未通过 → 重做：failed → start → 再验。
  let res = verifyChecklistItem(home, goal.id, item.id, { method: "bun test", summary: "3 败", passed: false });
  expect(res.item.status).toBe("failed");
  expect(res.checks).toBeNull();
  cur = startChecklistItem(home, goal.id, item.id);
  expect(cur.status).toBe("in_progress");
  res = verifyChecklistItem(home, goal.id, item.id, { method: "bun test", summary: "全过", passed: true });
  expect(res.item.status).toBe("verified");
  expect(res.item.verification?.method).toBe("bun test");
  expect(res.item.verification?.passed).toBe(true);
  // 已验证的项可以重验（新证据推翻旧结论）。
  res = verifyChecklistItem(home, goal.id, item.id, { method: "人工复核", summary: "复核发现漏了一项", passed: false });
  expect(res.item.status).toBe("failed");
  expect(() => verifyChecklistItem(home, goal.id, item.id, { method: "", summary: "x", passed: true })).toThrow(GoalError);
  expect(() => verifyChecklistItem(home, goal.id, item.id, { method: "m", summary: "", passed: true })).toThrow(GoalError);
  expect(() => verifyChecklistItem(home, goal.id, "chk_不存在", { method: "m", summary: "x", passed: true })).toThrow(GoalError);
});

test("GoalObjectTest.test_verify_with_files_wires_deterministic_checks", () => {
  const home = tmpHome();
  const wd = tmpWorkdir();
  writeFileSync(join(wd, "a.txt"), "hello\n");
  const goal = createGoal(home, { statement: "改点东西" });
  const item = addChecklistItem(home, goal.id, "改 a.txt");
  // 文件存在 + diff 摘要齐全 → 确定性检查全过，项通过。
  let res = verifyChecklistItem(home, goal.id, item.id, {
    method: "bun test", summary: "a.txt 已改，全量通过", passed: true,
    files: ["a.txt"], workdir: wd, diffStat: "1 file changed",
  });
  expect(res.checks).not.toBeNull();
  expect(res.checks?.every((c) => c.passed)).toBe(true);
  expect(res.item.status).toBe("verified");
  expect(res.item.verification?.evidence?.files).toEqual(["a.txt"]);
  // 缺 diff 摘要 → diff-stat 检查不过，声称的 passed 也不认，强制记 failed。
  const item2 = addChecklistItem(home, goal.id, "再改 a.txt");
  res = verifyChecklistItem(home, goal.id, item2.id, {
    method: "bun test", summary: "改了", passed: true,
    files: ["a.txt"], workdir: wd,
  });
  expect(res.checks?.find((c) => c.id === "diff-stat")?.passed).toBe(false);
  expect(res.item.status).toBe("failed");
  expect(res.item.verification?.passed).toBe(false);
  expect(res.item.verification?.summary).toContain("确定性检查未通过");
  // 文件不存在 → files-exist 检查不过，同样强制 failed。
  const item3 = addChecklistItem(home, goal.id, "改不存在的文件");
  res = verifyChecklistItem(home, goal.id, item3.id, {
    method: "bun test", summary: "改了", passed: true,
    files: ["nope.txt"], workdir: wd, diffStat: "1 file changed",
  });
  expect(res.checks?.find((c) => c.id === "files-exist")?.passed).toBe(false);
  expect(res.item.status).toBe("failed");
});

test("GoalObjectTest.test_complete_gate_lists_remaining", () => {
  const home = tmpHome();
  const empty = createGoal(home, { statement: "空目标" });
  expect(() => completeGoal(home, empty.id)).toThrow(/清单是空的/);
  const goal = createGoal(home, { statement: "三件事", items: ["甲", "乙", "丙"] });
  const [a, b, c] = goal.checklist;
  verifyChecklistItem(home, goal.id, a.id, { method: "人工", summary: "甲好了", passed: true });
  startChecklistItem(home, goal.id, b.id);
  verifyChecklistItem(home, goal.id, c.id, { method: "人工", summary: "丙不行", passed: false });
  let err: Error | null = null;
  try {
    completeGoal(home, goal.id);
  } catch (e) {
    err = e as Error;
  }
  expect(err).not.toBeNull();
  expect(err?.message).toContain("1/3 项已验证");
  expect(err?.message).toContain("进行中");
  expect(err?.message).toContain("未通过");
  const st = goalCompletionStatus(getGoalById(home, goal.id));
  expect(st.complete).toBe(false);
  expect(st.verified).toBe(1);
  // 全过才能标完成。
  verifyChecklistItem(home, goal.id, b.id, { method: "人工", summary: "乙好了", passed: true });
  verifyChecklistItem(home, goal.id, c.id, { method: "人工", summary: "丙好了", passed: true });
  const done = completeGoal(home, goal.id);
  expect(done.status).toBe("completed");
  expect(done.completedAt).not.toBeNull();
  expect(() => completeGoal(home, goal.id)).toThrow(GoalError);
  expect(() => addChecklistItem(home, goal.id, "事后加一项")).toThrow(GoalError);
  expect(() => addInstruction(home, goal.id, "事后加指令")).toThrow(GoalError);
});

test("GoalObjectTest.test_pause_requires_resume_before_complete", () => {
  const home = tmpHome();
  const goal = createGoal(home, { statement: "暂停一下", items: ["甲"] });
  verifyChecklistItem(home, goal.id, goal.checklist[0].id, { method: "人工", summary: "甲好了", passed: true });
  const paused = pauseGoal(home, goal.id);
  expect(paused.status).toBe("paused");
  expect(() => pauseGoal(home, goal.id)).toThrow(GoalError);
  expect(() => completeGoal(home, goal.id)).toThrow(/先恢复/);
  const { goal: resumed, resetItems } = resumeGoal(home, goal.id);
  expect(resumed.status).toBe("active");
  expect(resetItems).toEqual([]);
  const done = completeGoal(home, goal.id);
  expect(done.status).toBe("completed");
});

test("GoalObjectTest.test_resume_reverifies_linked_kanban_task", () => {
  const home = tmpHome();
  const goal = createGoal(home, { statement: "带任务板的目标", items: ["甲"] });
  const item = goal.checklist[0];
  verifyChecklistItem(home, goal.id, item.id, { method: "人工", summary: "甲好了", passed: true });
  const { task } = splitChecklistItem(home, goal.id, item.id, "甲的任务板任务");
  expect(getGoalById(home, goal.id).checklist[0].kanbanTaskId).toBe(task.id);
  // 关联的任务板任务被删了 → 恢复时证据失效，项退回待做。
  removeKanbanTask(home, task.id);
  pauseGoal(home, goal.id);
  const { goal: resumed, resetItems } = resumeGoal(home, goal.id);
  expect(resumed.status).toBe("active");
  expect(resetItems).toEqual(["甲"]);
  const cur = getGoalById(home, goal.id).checklist[0];
  expect(cur.status).toBe("pending");
  expect(cur.verification).toBeNull();
});

test("GoalObjectTest.test_resume_reverifies_file_evidence", () => {
  const home = tmpHome();
  const wd = tmpWorkdir();
  writeFileSync(join(wd, "b.txt"), "v1\n");
  const goal = createGoal(home, { statement: "带文件证据的目标", items: ["改 b.txt"] });
  const item = goal.checklist[0];
  verifyChecklistItem(home, goal.id, item.id, {
    method: "bun test", summary: "b.txt 已改", passed: true,
    files: ["b.txt"], workdir: wd, diffStat: "1 file changed",
  });
  expect(getGoalById(home, goal.id).checklist[0].status).toBe("verified");
  // 文件被删了 → 恢复时重跑确定性检查不过，项退回待做。
  rmSync(join(wd, "b.txt"));
  pauseGoal(home, goal.id);
  const { resetItems } = resumeGoal(home, goal.id);
  expect(resetItems).toEqual(["改 b.txt"]);
  expect(getGoalById(home, goal.id).checklist[0].status).toBe("pending");
});

test("GoalObjectTest.test_cancel_is_terminal", () => {
  const home = tmpHome();
  const goal = createGoal(home, { statement: "不做了", items: ["甲", "乙", "丙"] });
  const [a, b, c] = goal.checklist;
  verifyChecklistItem(home, goal.id, a.id, { method: "人工", summary: "甲好了", passed: true });
  startChecklistItem(home, goal.id, b.id);
  verifyChecklistItem(home, goal.id, c.id, { method: "人工", summary: "丙不行", passed: false });
  expect(() => cancelGoal(home, goal.id, "")).toThrow(GoalError);
  const cancelled = cancelGoal(home, goal.id, "方向变了，不做了");
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.cancelReason).toBe("方向变了，不做了");
  const items = getGoalById(home, goal.id).checklist;
  // 已验证的项保留“已验证”（证据本身还成立），未终态的项跟着取消。
  expect(items[0].status).toBe("verified");
  expect(items[1].status).toBe("cancelled");
  expect(items[2].status).toBe("cancelled");
  expect(() => cancelGoal(home, goal.id, "再取消一次")).toThrow(GoalError);
  expect(() => completeGoal(home, goal.id)).toThrow(GoalError);
  expect(() => pauseGoal(home, goal.id)).toThrow(GoalError);
  expect(() => addChecklistItem(home, goal.id, "事后加一项")).toThrow(GoalError);
  expect(() => verifyChecklistItem(home, goal.id, b.id, { method: "人工", summary: "x", passed: true })).toThrow(GoalError);
  // 已完成的目标不能取消。
  const done = createGoal(home, { statement: "做完了", items: ["甲"] });
  verifyChecklistItem(home, done.id, done.checklist[0].id, { method: "人工", summary: "好了", passed: true });
  completeGoal(home, done.id);
  expect(() => cancelGoal(home, done.id, "晚了")).toThrow(GoalError);
});

test("GoalObjectTest.test_instruct_keeps_goal_and_progress", () => {
  const home = tmpHome();
  const goal = createGoal(home, { statement: "写个东西", items: ["甲", "乙"] });
  verifyChecklistItem(home, goal.id, goal.checklist[0].id, { method: "人工", summary: "甲好了", passed: true });
  const ins = addInstruction(home, goal.id, "顺带把乙的格式也统一了");
  expect(ins.text).toBe("顺带把乙的格式也统一了");
  const cur = getGoalById(home, goal.id);
  expect(cur.status).toBe("active");
  expect(cur.checklist).toHaveLength(2);
  expect(cur.checklist[0].status).toBe("verified");
  expect(cur.checklist[1].status).toBe("pending");
  expect(cur.instructions).toHaveLength(1);
  expect(goalProgress(cur).verified).toBe(1);
  // 暂停中也能加指令，同样不重置清单。
  pauseGoal(home, goal.id);
  addInstruction(home, goal.id, "暂停期间补充一句");
  const paused = getGoalById(home, goal.id);
  expect(paused.instructions).toHaveLength(2);
  expect(paused.checklist[0].status).toBe("verified");
  expect(() => addInstruction(home, goal.id, "")).toThrow(GoalError);
  expect(() => addInstruction(home, goal.id, "x".repeat(1001))).toThrow(GoalError);
});

test("GoalObjectTest.test_kanban_link_and_split_boundaries", () => {
  const home = tmpHome();
  const goal = createGoal(home, { statement: "拆任务", items: ["甲", "乙"] });
  const [a, b] = goal.checklist;
  // 关联不存在的任务板任务直接拒绝。
  expect(() => linkChecklistItem(home, goal.id, a.id, "kb_不存在")).toThrow(KanbanError);
  // 拆：任务板上建一行并关联。
  const { item, task } = splitChecklistItem(home, goal.id, a.id, "甲的任务板任务");
  expect(item.kanbanTaskId).toBe(task.id);
  expect(task.status).toBe("queued");
  // 任务板行 done 了 ≠ 清单项通过了：行走完自己的完成边界，项还是待验证。
  startKanbanTask(home, task.id);
  verifyKanbanTask(home, task.id, { method: "bun test", summary: "全过", passed: true });
  completeKanbanTask(home, task.id);
  expect(getGoalById(home, goal.id).checklist[0].status).toBe("pending");
  expect(() => completeGoal(home, goal.id)).toThrow(GoalError);
  // 反过来：项通过了，任务板行不会自动变——两边各按各的边界走。
  const { task: taskB } = splitChecklistItem(home, goal.id, b.id, "乙的任务板任务");
  verifyChecklistItem(home, goal.id, a.id, { method: "人工", summary: "甲好了", passed: true });
  verifyChecklistItem(home, goal.id, b.id, { method: "人工", summary: "乙好了", passed: true });
  completeGoal(home, goal.id);
  const store = JSON.parse(readFileSync(join(home, "kanban.json"), "utf-8")) as { tasks: { id: string; status: string }[] };
  expect(store.tasks.find((t) => t.id === taskB.id)?.status).toBe("queued");
});

test("GoalObjectTest.test_list_filter_and_show_progress", () => {
  const home = tmpHome();
  const g1 = createGoal(home, { statement: "目标一", agent: "nyra", items: ["甲"] });
  const g2 = createGoal(home, { statement: "目标二", agent: "nyra" });
  cancelGoal(home, g2.id, "不做了");
  expect(listGoals(home)).toHaveLength(2);
  expect(listGoals(home, { status: "active" })).toHaveLength(1);
  expect(listGoals(home, { status: "cancelled" })[0].id).toBe(g2.id);
  expect(listGoals(home, { agent: "nyra" })).toHaveLength(2);
  expect(listGoals(home, { agent: "别人" })).toHaveLength(0);
  expect(() => getGoalById(home, "goal_不存在")).toThrow(GoalError);
  const p = goalProgress(getGoalById(home, g1.id));
  expect(p).toEqual({ total: 1, verified: 0, pending: 1, inProgress: 0, failed: 0, cancelled: 0 });
});

// ---- 事件注册与时间线渲染 ----

test("GoalObjectTest.test_goal_events_registered", () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  // 没注册进 EVENT_FIELDS 会抛错（见 appendEvent 的守卫）。
  const events: [string, Record<string, unknown>][] = [
    ["goal_created", { goal_id: "goal_aaaaaaaaaaaa" }],
    ["goal_item_added", { goal_id: "goal_aaaaaaaaaaaa", item_id: "chk_aaaaaaaa" }],
    ["goal_item_started", { goal_id: "goal_aaaaaaaaaaaa", item_id: "chk_aaaaaaaa" }],
    ["goal_item_verified", { goal_id: "goal_aaaaaaaaaaaa", item_id: "chk_aaaaaaaa", method: "bun test", passed: true }],
    ["goal_completed", { goal_id: "goal_aaaaaaaaaaaa", items: 2 }],
    ["goal_paused", { goal_id: "goal_aaaaaaaaaaaa" }],
    ["goal_resumed", { goal_id: "goal_aaaaaaaaaaaa", reset_items: 0 }],
    ["goal_cancelled", { goal_id: "goal_aaaaaaaaaaaa", reason_hash: "abc123def456" }],
    ["goal_instruction_added", { goal_id: "goal_aaaaaaaaaaaa" }],
    ["goal_item_linked", { goal_id: "goal_aaaaaaaaaaaa", item_id: "chk_aaaaaaaa", task_id: "kb_aaaaaaaaaaaa" }],
  ];
  for (const [type, fields] of events) {
    expect(() => store.appendEvent(state.run_id, type, fields)).not.toThrow();
  }
});

test("GoalObjectTest.test_goal_events_render_on_timeline", () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  store.appendEvent(state.run_id, "goal_created", { goal_id: "goal_aaaaaaaaaaaa" });
  store.appendEvent(state.run_id, "goal_item_verified", { goal_id: "goal_aaaaaaaaaaaa", item_id: "chk_aaaaaaaa", method: "bun test", passed: true });
  store.appendEvent(state.run_id, "goal_completed", { goal_id: "goal_aaaaaaaaaaaa", items: 2 });
  store.appendEvent(state.run_id, "goal_resumed", { goal_id: "goal_aaaaaaaaaaaa", reset_items: 1 });
  const text = formatTimelineText(buildTimeline(store, state.run_id), { verbose: true });
  expect(text).toContain("目标 goal_aaaaaaaaaaaa 已建");
  expect(text).toContain("清单项验证通过");
  expect(text).toContain("已完成（清单 2 项全过）");
  expect(text).toContain("1 项证据失效退回待做");
});

// ---- CLI 端到端 ----

test("GoalObjectTest.test_cli_end_to_end", () => {
  const home = tmpHome();
  let r = runCli(home, ["goal", "create", "上线 0.5.4", "--item", "跑通全量", "--item", "推上 main"]);
  expect(r.status).toBe(0);
  const goalId = r.stdout.trim();
  expect(goalId).toMatch(/^goal_[0-9a-f]{12}$/);
  r = runCli(home, ["goal", "list"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(goalId);
  expect(r.stdout).toContain("0/2 项已验证");
  r = runCli(home, ["goal", "show", goalId]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("上线 0.5.4");
  expect(r.stdout).toContain("跑通全量");
  const store = JSON.parse(readFileSync(goalPath(home), "utf-8")) as { goals: { checklist: { id: string }[] }[] };
  const [item1, item2] = store.goals[0].checklist;
  r = runCli(home, ["goal", "verify-item", goalId, item1.id, "--method", "人工", "--summary", "跑通了", "--passed"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("验证通过");
  // 没全过标不上去。
  r = runCli(home, ["goal", "complete", goalId]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("标不上去");
  // 取消不加 --yes 拒绝。
  r = runCli(home, ["goal", "cancel", goalId, "不做了"]);
  expect(r.status).toBe(2);
  r = runCli(home, ["goal", "instruct", goalId, "顺带把文档也补了"]);
  expect(r.status).toBe(0);
  r = runCli(home, ["goal", "start-item", goalId, item2.id]);
  expect(r.status).toBe(0);
  r = runCli(home, ["goal", "verify-item", goalId, item2.id, "--method", "人工", "--summary", "推上去了"]);
  expect(r.status).toBe(0);
  r = runCli(home, ["goal", "complete", goalId]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("已完成");
  r = runCli(home, ["goal", "show", goalId, "--json"]);
  expect(r.status).toBe(0);
  const shown = JSON.parse(r.stdout) as { status: string; instructions: unknown[] };
  expect(shown.status).toBe("completed");
  expect(shown.instructions).toHaveLength(1);
  // 未知子命令退出码 2；空子命令打印用法退出码 2。
  r = runCli(home, ["goal", "不存在"]);
  expect(r.status).toBe(2);
  r = runCli(home, ["goal"]);
  expect(r.status).toBe(2);
  expect(r.stdout).toContain("nyra goal");
});
