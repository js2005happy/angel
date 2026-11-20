// tests/node/test-timeline-stage.test.ts — DSH-5 工单阶段表（缺口 21 时间线小修）。
// 钉住的事：
//   - deriveRunStage 五态判定与优先级（等审批 > 卡住 > 等审阅 > 进行中 > 空闲）；
//   - stageDisplay 渲染（等谁：等什么）；
//   - failedStepSummaries 失败口径（与回归测例库共用，见 test-regression-cases）；
//   - buildTimeline 端到端：阶段从事件闭合情况推出来，进文本输出。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, deriveRunStage, failedStepSummaries, formatTimelineText, stageDisplay, type StageInputs, type Timeline } from "../../src/timeline.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-stage-test-"));
}

function seedRun(home: string): { store: RunStore; runId: string } {
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  return { store, runId: state.run_id };
}

const BASE: StageInputs = { status: "running", approvalsPending: [], delegatesPending: [], toolsPending: [], lastFailureTitle: null };

test("TimelineStageTest.test_waiting_answer_on_pending_approval", () => {
  const s = deriveRunStage({ ...BASE, approvalsPending: ["write_file"] });
  expect(s.stage).toBe("waiting-answer");
  expect(s.label).toBe("等回答");
  expect(s.waitingOn).toBe("审批人");
  expect(s.waitingFor).toContain("write_file");
  expect(stageDisplay(s)).toBe("等回答（等审批人：审批 write_file）");
});

test("TimelineStageTest.test_approval_beats_blocked", () => {
  // 优先级：等审批 > 卡住——运行失败了但还有审批没回，先等回答。
  const s = deriveRunStage({ ...BASE, status: "failed", approvalsPending: ["gmail_send"], lastFailureTitle: "工具 gmail_send（失败）" });
  expect(s.stage).toBe("waiting-answer");
});

test("TimelineStageTest.test_blocked_on_failed_status", () => {
  for (const status of ["failed", "interrupted", "verify_failed", "incomplete"]) {
    const s = deriveRunStage({ ...BASE, status, lastFailureTitle: "工具 write_file（失败）" });
    expect(s.stage).toBe("blocked");
    expect(s.label).toBe("已卡住");
    expect(s.waitingFor).toBe("工具 write_file（失败）");
    expect(stageDisplay(s)).toBe("已卡住（工具 write_file（失败））");
  }
  // 没记到失败步骤时，等的是运行状态本身。
  const s = deriveRunStage({ ...BASE, status: "failed" });
  expect(s.waitingFor).toBe("运行状态 failed");
});

test("TimelineStageTest.test_waiting_review_on_completed_unverified", () => {
  const s = deriveRunStage({ ...BASE, status: "completed_unverified" });
  expect(s.stage).toBe("waiting-review");
  expect(s.label).toBe("等审阅");
  expect(s.waitingOn).toBe("审阅者");
  expect(stageDisplay(s)).toBe("等审阅（等审阅者：跑完了但没有验证证据，需人工逐项批）");
  // 同样已完成，但已验证了就是空闲。
  expect(deriveRunStage({ ...BASE, status: "verified" }).stage).toBe("idle");
});

test("TimelineStageTest.test_working_on_pending_delegate_or_tool", () => {
  const d = deriveRunStage({ ...BASE, delegatesPending: ["task-aaaa"] });
  expect(d.stage).toBe("working");
  expect(stageDisplay(d)).toBe("进行中（等子任务 task-aaaa：未结束）");
  const t = deriveRunStage({ ...BASE, toolsPending: ["write_file"] });
  expect(t.stage).toBe("working");
  expect(stageDisplay(t)).toBe("进行中（工具 write_file 无结果）");
});

test("TimelineStageTest.test_awaiting_approval_and_idle", () => {
  expect(deriveRunStage({ ...BASE, status: "awaiting_approval" }).stage).toBe("waiting-answer");
  const idle = deriveRunStage({ ...BASE, status: "verified" });
  expect(idle.stage).toBe("idle");
  expect(idle.label).toBe("空闲（无待办）");
  expect(stageDisplay(idle)).toBe("空闲（无待办）");
  // 默认：运行中、无待办，就是进行中。
  expect(deriveRunStage(BASE).stage).toBe("working");
});

test("TimelineStageTest.test_failed_step_summaries_shared_with_regression", () => {
  const tl = {
    runId: "run-1",
    steps: [
      { index: 1, at: "2026-11-21T00:00:00.000Z", offsetMs: 0, turn: 1, kind: "tool", title: "工具 write_file（失败）", detail: "参数指纹 abc…", ok: false, durationMs: null },
      { index: 2, at: "2026-11-21T00:00:01.000Z", offsetMs: 1000, turn: 1, kind: "delegate", title: "子任务 task-aaaa（失败）", detail: null, ok: false, durationMs: null },
      { index: 3, at: "2026-11-21T00:00:02.000Z", offsetMs: 2000, turn: 1, kind: "tool", title: "工具 read_file", detail: null, ok: true, durationMs: null },
      { index: 4, at: "2026-11-21T00:00:03.000Z", offsetMs: 3000, turn: 1, kind: "event", title: "运行错误：Error", detail: null, ok: false, durationMs: null },
    ],
  } as unknown as Timeline;
  const out = failedStepSummaries(tl);
  expect(out).toHaveLength(3);
  expect(out[0]).toEqual({ kind: "tool", label: "工具 write_file（失败）", detail: "参数指纹 abc…" });
  expect(out[1].kind).toBe("delegate");
  // 未分类的失败步骤（event）归为 run，不另造一类。
  expect(out[2].kind).toBe("run");
});

// ---- 端到端：阶段从事件闭合情况推出来 ----

test("TimelineStageTest.test_e2e_dangling_tool_then_idle", () => {
  const home = tmpHome();
  const { store, runId } = seedRun(home);
  store.appendEvent(runId, "tool_start", { id: "c9", name: "write_file", args_hash: "zzz" });
  let tl = buildTimeline(store, runId);
  expect(tl.stage.stage).toBe("working");
  expect(formatTimelineText(tl)).toContain("当前阶段：进行中（工具 write_file 无结果）");
  store.setStatus(runId, "verified");
  tl = buildTimeline(store, runId);
  // 工具仍无结果：进行中（未闭合的等待优先于“已验证”）。
  expect(tl.stage.stage).toBe("working");
  store.appendEvent(runId, "tool_result", { id: "c9", name: "write_file", ok: true, args_hash: "zzz" });
  tl = buildTimeline(store, runId);
  expect(tl.stage.stage).toBe("idle");
  expect(formatTimelineText(tl)).toContain("当前阶段：空闲（无待办）");
});

test("TimelineStageTest.test_e2e_approval_pending_then_done", () => {
  const home = tmpHome();
  const { store, runId } = seedRun(home);
  store.appendEvent(runId, "approval_wait", { tool: "gmail_send" });
  let tl = buildTimeline(store, runId);
  expect(tl.stage.stage).toBe("waiting-answer");
  expect(formatTimelineText(tl)).toContain("当前阶段：等回答（等审批人：审批 gmail_send）");
  store.appendEvent(runId, "approval_done", { tool: "gmail_send", approved: true });
  tl = buildTimeline(store, runId);
  expect(tl.stage.stage).toBe("working");
});

test("TimelineStageTest.test_e2e_completed_unverified_is_waiting_review", () => {
  const home = tmpHome();
  const { store, runId } = seedRun(home);
  store.appendEvent(runId, "verifier_verdict", { target: "task-1", verdict: "not-verified", reason: "无模型可用", verifier_model: "fake", source: "verifier", checks_passed: 2, checks_failed: 0 });
  store.setStatus(runId, "completed_unverified");
  const tl = buildTimeline(store, runId);
  expect(tl.stage.stage).toBe("waiting-review");
  expect(formatTimelineText(tl)).toContain("当前阶段：等审阅");
});

test("TimelineStageTest.test_e2e_failed_run_is_blocked", () => {
  const home = tmpHome();
  const { store, runId } = seedRun(home);
  store.appendEvent(runId, "tool_start", { id: "c1", name: "read_file", args_hash: "a" });
  store.appendEvent(runId, "tool_result", { id: "c1", name: "read_file", ok: false, args_hash: "a" });
  store.setStatus(runId, "failed");
  const tl = buildTimeline(store, runId);
  expect(tl.stage.stage).toBe("blocked");
  expect(tl.stage.waitingFor).toContain("read_file");
  expect(formatTimelineText(tl)).toContain("当前阶段：已卡住");
});
