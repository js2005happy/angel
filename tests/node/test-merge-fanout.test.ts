// tests/node/test-merge-fanout.test.ts — H-5 + H-6：合并成一份交付物 + 后台扇出落任务板。
// 只测能确定性验证的部分：合并确定性检查、合并步接线（假 provider）、后台扇出
// 的 handle/回填/任务板落点、fanout 账本与回收、Heartbeat 兜底、事件与时间线、
// 工具层 background 默认值；不测真实模型调用。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Agent } from "../../src/agent.ts";
import {
  runParallelDelegate, formatParallelResults,
  type ParallelDelegateResult, type ParallelThreadResult,
} from "../../src/parallelDelegate.ts";
import {
  buildMergeTask, extractMergedText, extractListedFiles, verifyMergedDeliverable,
  formatMergedDeliverable, type MergedDeliverable,
} from "../../src/merge.ts";
import {
  createFanout, getFanout, listFanouts, updateFanout, recoverFanouts,
  handleFanout,
} from "../../src/fanout.ts";
import { getKanbanTask, createKanbanTask, startKanbanTask } from "../../src/kanban.ts";
import { runChecks } from "../../src/heartbeat.ts";
import { loadInbox } from "../../src/tasks.ts";
import { listReviewItems } from "../../src/reviewQueue.ts";
import { RunStore, type RunState } from "../../src/runs.ts";
import { buildTimeline } from "../../src/timeline.ts";
import { saveSession } from "../../src/memory.ts";
import { echoProvider, fakeProvider } from "./fake-provider.ts";
import { executeTool, newToolContext, TOOL_SCHEMAS } from "../../src/tools.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setup() {
  return { home: tmpHome("nyra-merge-"), workdir: tmpHome("nyra-merge-wd-") };
}

function newAgent(workdir: string, home: string, provider: unknown): Agent {
  return new Agent(provider as never, {
    workdir, mode: "auto", maxTurns: 2, interactive: false,
    home, sessionId: null, skillsDirs: [], checkpointStore: null,
  } as never);
}

function threadEvidence(over: Partial<ParallelThreadResult["evidence"]> = {}): ParallelThreadResult["evidence"] {
  return {
    changedFiles: [], diffStat: null, worktreePath: null,
    verification: { status: "not-verified", note: "未验收" }, spentUsd: null,
    ...over,
  };
}

function thread(index: number, task: string, status: ParallelThreadResult["status"], summary: string | null, over: Partial<ParallelThreadResult> = {}): ParallelThreadResult {
  return {
    index, task, status, summary, error: status === "ok" ? null : "线程失败",
    durationMs: 100, model: "fake-1", evidence: threadEvidence(), schemaValid: null,
    ...over,
  };
}

function batch(threads: ParallelThreadResult[]): ParallelDelegateResult {
  return {
    results: threads,
    succeeded: threads.filter((t) => t.status === "ok").length,
    failed: threads.filter((t) => t.status === "failed").length,
    timedOut: threads.filter((t) => t.status === "timeout").length,
    rejected: threads.filter((t) => t.status === "rejected").length,
    totalSpentUsd: null, totalDurationMs: 200, maxConcurrency: 5, timeoutMs: 600000,
    maxConcurrencyClamped: false, reviewEnqueued: [], reviewEnqueueError: null, merged: null,
  };
}

// ---------- H-5：合并任务文本 ----------

test("MergeFanoutTest.test_build_merge_task_has_thread_markers_and_schema_json", () => {
  const r = batch([
    thread(0, "写登录", "ok", '```json\n{"name": "甲", "n": 1}\n```', { schemaValid: true }),
    thread(1, "写注册", "failed", null, { schemaValid: null }),
  ]);
  const task = buildMergeTask(r, "合并交付物", "report");
  expect(task).toContain("线程 1");
  expect(task).toContain("线程 2");
  expect(task).toContain('"name": "甲"');
  expect(task).toContain("失败");
  expect(task).toContain("不要把没跑完的线程写成已完成");
  expect(task).toContain("只列下面各线程证据里出现的文件");
});

// ---------- H-5：确定性检查 ----------

test("MergeFanoutTest.test_verify_merged_all_pass", () => {
  const r = batch([
    thread(0, "写登录", "ok", "登录做完了。", { evidence: threadEvidence({ changedFiles: ["a.txt"] }) }),
    thread(1, "写注册", "ok", "注册做完了。", { evidence: threadEvidence({ changedFiles: ["b.txt"] }) }),
  ]);
  const merged = [
    "线程 1：写登录，登录做完了。",
    "线程 2：写注册，注册做完了。",
    "改动文件：",
    "- a.txt",
    "- b.txt",
    "合并说明：2 个线程都成功。",
  ].join("\n");
  const checks = verifyMergedDeliverable(merged, r);
  expect(checks.every((c) => c.passed)).toBe(true);
  expect(checks.map((c) => c.id)).toEqual(["not-empty", "threads-covered", "failed-listed", "schema-flags-kept", "files-consistent"]);
});

test("MergeFanoutTest.test_verify_merged_missing_thread_fails", () => {
  const r = batch([
    thread(0, "写登录", "ok", "登录做完了。"),
    thread(1, "写注册", "ok", "注册做完了。"),
  ]);
  const checks = verifyMergedDeliverable("线程 1：写登录做完了。", r);
  expect(checks.find((c) => c.id === "threads-covered")!.passed).toBe(false);
});

test("MergeFanoutTest.test_verify_merged_dropped_failure_fails", () => {
  const r = batch([
    thread(0, "写登录", "ok", "登录做完了。"),
    thread(1, "写注册", "failed", null),
  ]);
  const checks = verifyMergedDeliverable("线程 1：写登录做完了。合并说明：全部成功。", r);
  expect(checks.find((c) => c.id === "failed-listed")!.passed).toBe(false);
  // 把失败写成成功也不行——失败线程没被提到就是丢掉。
  expect(checks.find((c) => c.id === "failed-listed")!.detail).toContain("线程 2");
});

test("MergeFanoutTest.test_verify_merged_schema_flag_missing_fails", () => {
  const r = batch([
    thread(0, "写登录", "ok", '{"name": "甲"}', { schemaValid: false }),
    thread(1, "写注册", "ok", '{"name": "乙", "n": 2}', { schemaValid: true }),
  ]);
  const noFlag = verifyMergedDeliverable("线程 1：写登录。\n线程 2：写注册。", r);
  expect(noFlag.find((c) => c.id === "schema-flags-kept")!.passed).toBe(false);
  const flagged = verifyMergedDeliverable("线程 1：写登录，契约未通过（schema_valid: false），原文保留待人核。\n线程 2：写注册。", r);
  expect(flagged.find((c) => c.id === "schema-flags-kept")!.passed).toBe(true);
});

test("MergeFanoutTest.test_verify_merged_invented_file_fails", () => {
  const r = batch([
    thread(0, "写登录", "ok", "登录做完了。", { evidence: threadEvidence({ changedFiles: ["a.txt"] }) }),
  ]);
  const checks = verifyMergedDeliverable("线程 1：写登录。\n改动文件：\n- a.txt\n- c.txt\n", r);
  expect(checks.find((c) => c.id === "files-consistent")!.passed).toBe(false);
  expect(checks.find((c) => c.id === "files-consistent")!.detail).toContain("c.txt");
  // 没列清单时该项放过（不是失败）。
  const noList = verifyMergedDeliverable("线程 1：写登录做完了。", r);
  expect(noList.find((c) => c.id === "files-consistent")!.passed).toBe(true);
});

test("MergeFanoutTest.test_verify_merged_empty_fails", () => {
  const r = batch([thread(0, "写登录", "ok", "登录做完了。")]);
  expect(verifyMergedDeliverable("  ", r).find((c) => c.id === "not-empty")!.passed).toBe(false);
});

test("MergeFanoutTest.test_extract_merged_text_strips_head_and_verdict", () => {
  const raw = "[子任务 task-ab12cd34 已完成]\n（子任务模型：fake-1）\n合并正文：线程 1 做完了。\n\n验收：未验收——未开启验收";
  expect(extractMergedText(raw)).toBe("合并正文：线程 1 做完了。");
  expect(extractMergedText("只有正文，没有任务头。")).toBe("只有正文，没有任务头。");
});

test("MergeFanoutTest.test_extract_listed_files_ignores_fenced_blocks", () => {
  const text = "改动文件：\n- a.txt\n```\n- not-a-file.txt\n```\n";
  expect(extractListedFiles(text)).toEqual(["a.txt"]);
});

test("MergeFanoutTest.test_format_merged_deliverable_lines", () => {
  const r = batch([thread(0, "写登录", "ok", "登录做完了。")]);
  const merged: MergedDeliverable = {
    ok: true, title: "合并交付物", text: "线程 1：写登录做完了。", error: null,
    verified: true,
    checks: verifyMergedDeliverable("线程 1：写登录做完了。", r),
    reviewItemId: "0123456789abcdef", reviewEnqueueError: null,
    mergeSpentUsd: 0.01, mergeModel: "fake-1", file: "merged/mg_0123456789ab.md",
  };
  const out = formatMergedDeliverable(merged, r);
  expect(out).toContain("合并交付物：合并交付物");
  expect(out).toContain("确定性检查");
  expect(out).toContain("审阅队列：0123456789abcdef");
  expect(out).toContain("merged/mg_0123456789ab.md");
});

// ---------- 并行层透传：schemaValid 与 onThreadDone ----------

test("MergeFanoutTest.test_runner_plumbs_schema_valid_and_on_thread_done", async () => {
  const seen: number[] = [];
  const r = await runParallelDelegate(async (spec, index) => ({
    ok: true, summary: `做了：${spec.task}`, spentUsd: null, model: "fake-1",
    worktreePath: null, changedFiles: [], diffStat: null, schemaValid: index === 0,
  }), [{ task: "甲" }, { task: "乙" }], {
    onThreadDone: (t) => { seen.push(t.index); },
  });
  expect(r.results[0].schemaValid).toBe(true);
  expect(r.results[1].schemaValid).toBe(false);
  expect(seen.sort()).toEqual([0, 1]);
});

test("MergeFanoutTest.test_format_tolerates_result_without_merged_field", () => {
  // #79 同款容忍：手写结果没有 merged 字段时不抛错；有 merged 时附上合并段。
  const legacy = batch([thread(0, "写登录", "ok", "登录做完了。")]) as unknown as Record<string, unknown>;
  delete legacy.merged;
  expect(() => formatParallelResults(legacy as unknown as ParallelDelegateResult)).not.toThrow();
  const withMerge = batch([thread(0, "写登录", "ok", "登录做完了。")]);
  withMerge.merged = {
    ok: true, title: "合并交付物", text: "线程 1：写登录做完了。", error: null, verified: true,
    checks: verifyMergedDeliverable("线程 1：写登录做完了。", withMerge),
    reviewItemId: null, reviewEnqueueError: null, mergeSpentUsd: null, mergeModel: null, file: null,
  };
  expect(formatParallelResults(withMerge)).toContain("合并交付物");
});

// ---------- Agent 层：合并步 ----------

test("MergeFanoutTest.test_agent_merge_all_pass_enqueues_review_and_writes_file", async () => {
  const { home, workdir } = setup();
  const provider = fakeProvider([
    { content: "甲做完了。" },
    { content: "乙做完了。" },
    { content: "合并交付物正文：\n线程 1：甲做完了。\n线程 2：乙做完了。\n改动文件：无\n合并说明：2 个线程都成功。" },
  ]);
  const agent = newAgent(workdir, home, provider);
  const result = await agent.delegateParallel([{ task: "做甲" }, { task: "做乙" }], { merge: true, mergeTitle: "甲乙合并" });
  expect(result.succeeded).toBe(2);
  expect(result.merged).not.toBeNull();
  expect(result.merged!.ok).toBe(true);
  expect(result.merged!.verified).toBe(true);
  expect(result.merged!.reviewItemId).not.toBeNull();
  expect(result.merged!.file).not.toBeNull();
  expect(existsSync(join(home, result.merged!.file!))).toBe(true);
  expect(readFileSync(join(home, result.merged!.file!), "utf-8")).toContain("线程 1");
  const items = listReviewItems(home);
  expect(items).toHaveLength(1);
  expect(items[0].verification.method).toBe("merge-deterministic");
  expect(items[0].verification.status).toBe("verified");
  expect(formatParallelResults(result)).toContain("合并交付物");
});

test("MergeFanoutTest.test_agent_merge_failed_checks_still_enqueued_as_failed", async () => {
  const { home, workdir } = setup();
  const provider = fakeProvider([
    { content: "甲做完了。" },
    { content: "乙做完了。" },
    { content: "合并交付物正文：\n线程 1：甲做完了。\n合并说明：全部成功。" },
  ]);
  const agent = newAgent(workdir, home, provider);
  const result = await agent.delegateParallel([{ task: "做甲" }, { task: "做乙" }], { merge: true });
  expect(result.merged!.ok).toBe(true);
  expect(result.merged!.verified).toBe(false);
  expect(result.merged!.reviewItemId).not.toBeNull();
  const items = listReviewItems(home);
  expect(items).toHaveLength(1);
  expect(items[0].verification.status).toBe("failed");
  expect(formatParallelResults(result)).toContain("须人批复后再用");
});

test("MergeFanoutTest.test_agent_merge_schema_failed_threads_flagged", async () => {
  const { home, workdir } = setup();
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, n: { type: "integer" } },
    required: ["name", "n"],
    additionalProperties: false,
  };
  // 两个线程都给缺字段的 JSON：纠正轮也拿不到好 JSON（所有步骤都是坏 JSON），
  // 两线程都以 schemaValid: false 结束；合并文本里两处都标了契约未通过。
  const provider = fakeProvider([
    { content: '{"name": "甲"}' },
    { content: '{"name": "乙"}' },
    { content: '{"name": "甲"}' },
    { content: '{"name": "乙"}' },
    { content: "合并交付物正文：\n线程 1：甲，契约未通过（schema_valid: false），原文保留待人核。\n线程 2：乙，契约未通过（schema_valid: false），原文保留待人核。\n合并说明：2 个线程都跑完了，契约都未通过。" },
  ]);
  const agent = newAgent(workdir, home, provider);
  const result = await agent.delegateParallel(
    [{ task: "做甲", outputSchema: schema }, { task: "做乙", outputSchema: schema }],
    { merge: true },
  );
  expect(result.results[0].schemaValid).toBe(false);
  expect(result.results[1].schemaValid).toBe(false);
  expect(result.merged!.verified).toBe(true);
});

test("MergeFanoutTest.test_agent_merge_no_ok_threads_skips_merger", async () => {
  const { home, workdir } = setup();
  const boom = {
    ...echoProvider("x"),
    chat: async (): Promise<never> => { throw new Error("boom"); },
  };
  const agent = newAgent(workdir, home, boom);
  const result = await agent.delegateParallel([{ task: "做甲" }, { task: "做乙" }], { merge: true });
  expect(result.succeeded).toBe(0);
  expect(result.merged!.ok).toBe(false);
  expect(result.merged!.error).toContain("没有成功线程可合并");
});

// ---------- 工具层：background 默认 true ----------

test("MergeFanoutTest.test_tool_schema_background_default_true_merge_default_false", () => {
  const s = TOOL_SCHEMAS.find((x) => (x as { function?: { name?: string } }).function?.name === "delegate_parallel");
  const props = (s as unknown as { function: { parameters: { properties: Record<string, Record<string, unknown>> } } }).function.parameters.properties;
  expect(props.background.default).toBe(true);
  expect(props.merge.default).toBe(false);
  expect((props.backfill as { enum: string[] }).enum).toEqual(["single", "per-group"]);
});

test("MergeFanoutTest.test_tool_delegate_parallel_background_routing", async () => {
  // 默认（不传 background）走后台：只有后台入口时回 handle。
  const bgCtx = newToolContext({
    workdir: tmpHome("nyra-merge-tool-wd-"),
    delegateParallelBackgroundFn: async (tasks) => `后台跑，等回填：已派发 ${tasks.length} 个子任务`,
  } as never);
  const handle = await executeTool("delegate_parallel", { tasks: [{ task: "甲" }] }, bgCtx);
  expect(handle).toContain("后台跑，等回填");
  // 默认且两个入口都没接：报后台不可用（不是并行不可用）。
  const noCtx = newToolContext({ workdir: tmpHome("nyra-merge-tool-wd2-") });
  const noBg = await executeTool("delegate_parallel", { tasks: [{ task: "甲" }] }, noCtx);
  expect(noBg).toContain("后台并行子 agent 不可用");
  // 显式 background: false 走同步入口。
  const syncCtx = newToolContext({
    workdir: tmpHome("nyra-merge-tool-wd3-"),
    delegateParallelFn: async (tasks) => `并行完成 ${tasks.length} 个`,
  });
  const ok = await executeTool("delegate_parallel", { tasks: [{ task: "甲" }], background: false }, syncCtx);
  expect(ok).toContain("并行完成 1 个");
});

// ---------- H-6：后台扇出 ----------

async function waitForFanout(home: string, id: string, timeoutMs = 15000): Promise<ReturnType<typeof getFanout>> {
  const started = Date.now();
  for (;;) {
    const record = getFanout(home, id);
    if (record.status !== "running") return record;
    if (Date.now() - started > timeoutMs) throw new Error(`扇出 ${id} 在 ${timeoutMs}ms 内没跑完（状态仍为 running）`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("MergeFanoutTest.test_agent_background_returns_handle_then_backfills", async () => {
  const { home, workdir } = setup();
  const agent = newAgent(workdir, home, echoProvider("子任务完成。"));
  const handle = await agent.delegateParallelBackground([{ task: "做甲" }, { task: "做乙" }], {});
  expect(handle).toContain("后台跑，等回填");
  const match = handle.match(/fanout (fo_[0-9a-f]{12})/);
  expect(match).not.toBeNull();
  const id = match![1];
  const record = await waitForFanout(home, id);
  expect(record.status).toBe("done");
  expect(record.delivered).toBe(true);
  expect(record.succeeded).toBe(2);
  expect(record.kanbanTaskId).not.toBeNull();
  expect(getKanbanTask(home, record.kanbanTaskId!).status).toBe("done");
  const inbox = loadInbox(home).filter((m) => (m as Record<string, unknown>).run_id === id);
  expect(inbox.some((m) => (m as Record<string, unknown>).status === "fanout")).toBe(true);
});

test("MergeFanoutTest.test_agent_background_per_group_backfills_each_thread", async () => {
  const { home, workdir } = setup();
  const agent = newAgent(workdir, home, echoProvider("子任务完成。"));
  const handle = await agent.delegateParallelBackground([{ task: "做甲" }, { task: "做乙" }], { backfill: "per-group" });
  const id = handle.match(/fanout (fo_[0-9a-f]{12})/)![1];
  const record = await waitForFanout(home, id);
  expect(record.status).toBe("done");
  const inbox = loadInbox(home).filter((m) => (m as Record<string, unknown>).run_id === id);
  expect(inbox.filter((m) => (m as Record<string, unknown>).status === "fanout-thread")).toHaveLength(2);
  expect(inbox.filter((m) => (m as Record<string, unknown>).status === "fanout")).toHaveLength(1);
});

test("MergeFanoutTest.test_agent_background_with_merge_backfills_review_item", async () => {
  const { home, workdir } = setup();
  const provider = fakeProvider([
    { content: "甲做完了。" },
    { content: "乙做完了。" },
    { content: "合并交付物正文：\n线程 1：甲做完了。\n线程 2：乙做完了。\n改动文件：无\n合并说明：2 个线程都成功。" },
  ]);
  const agent = newAgent(workdir, home, provider);
  const handle = await agent.delegateParallelBackground([{ task: "做甲" }, { task: "做乙" }], { merge: true });
  const id = handle.match(/fanout (fo_[0-9a-f]{12})/)![1];
  const record = await waitForFanout(home, id);
  expect(record.status).toBe("done");
  expect(record.merged).toBe(true);
  expect(record.reviewItemIds).toHaveLength(1);
  const inbox = loadInbox(home).filter((m) => (m as Record<string, unknown>).run_id === id);
  expect(inbox.some((m) => String((m as Record<string, unknown>).summary).includes("审阅队列"))).toBe(true);
});

test("MergeFanoutTest.test_agent_background_all_failed_marks_failed_and_kanban_fail", async () => {
  const { home, workdir } = setup();
  const boom = {
    ...echoProvider("x"),
    chat: async (): Promise<never> => { throw new Error("boom"); },
  };
  const agent = newAgent(workdir, home, boom);
  const handle = await agent.delegateParallelBackground([{ task: "做甲" }, { task: "做乙" }], {});
  const id = handle.match(/fanout (fo_[0-9a-f]{12})/)![1];
  const record = await waitForFanout(home, id);
  expect(record.status).toBe("failed");
  expect(record.delivered).toBe(true);
  expect(getKanbanTask(home, record.kanbanTaskId!).attempts).toBe(1);
  const inbox = loadInbox(home).filter((m) => (m as Record<string, unknown>).run_id === id);
  expect(inbox.length).toBeGreaterThanOrEqual(1);
});

// ---------- fanout 账本与回收 ----------

test("MergeFanoutTest.test_fanout_ledger_validation", () => {
  const { home } = setup();
  expect(() => createFanout(home, { title: "  ", tasksCount: 1 })).toThrow("标题不能为空");
  expect(() => createFanout(home, { title: "x", tasksCount: 0 })).toThrow("正整数");
  const record = createFanout(home, { title: "扇出甲", tasksCount: 2, backfill: "per-group" });
  expect(record.id).toMatch(/^fo_[0-9a-f]{12}$/);
  expect(record.status).toBe("running");
  expect(record.backfill).toBe("per-group");
  expect(getFanout(home, record.id).id).toBe(record.id);
  expect(listFanouts(home)).toHaveLength(1);
  expect(() => getFanout(home, "fo_000000000000")).toThrow("找不到后台扇出");
  const updated = updateFanout(home, record.id, { status: "done", delivered: true });
  expect(updated.status).toBe("done");
  expect(updated.delivered).toBe(true);
});

test("MergeFanoutTest.test_fanout_recover_marks_interrupted_and_kanban_fails", () => {
  const { home } = setup();
  const running = createFanout(home, { title: "跑一半", tasksCount: 2 });
  const done = createFanout(home, { title: "已跑完", tasksCount: 1 });
  updateFanout(home, done.id, { status: "done", delivered: true });
  // 任务板行：running 的那条处于 working，回收应走 fail 路径。
  const kb = createKanbanTask(home, { title: "后台并行委派：跑一半", kind: "delegate" });
  startKanbanTask(home, kb.id);
  updateFanout(home, running.id, { kanbanTaskId: kb.id });
  const { interrupted, notified } = recoverFanouts(home);
  expect(interrupted).toEqual([running.id]);
  expect(notified).toEqual([running.id]);
  expect(getFanout(home, running.id).status).toBe("interrupted");
  expect(getFanout(home, running.id).error).toContain("进程不在了");
  expect(getKanbanTask(home, kb.id).attempts).toBe(1);
  expect(getFanout(home, done.id).status).toBe("done");
  expect(recoverFanouts(home).interrupted).toEqual([]);
});

// ---------- Heartbeat 兜底 ----------

test("MergeFanoutTest.test_heartbeat_fanout_unfinished", () => {
  const { home } = setup();
  expect(runChecks(home, ["fanout_unfinished"])).toHaveLength(0);
  const bad = createFanout(home, { title: "中断的", tasksCount: 1 });
  updateFanout(home, bad.id, { status: "interrupted" });
  const undelivered = createFanout(home, { title: "跑完没回填", tasksCount: 1 });
  updateFanout(home, undelivered.id, { status: "done", delivered: false });
  const done = createFanout(home, { title: "跑完已回填", tasksCount: 1 });
  updateFanout(home, done.id, { status: "done", delivered: true });
  const findings = runChecks(home, ["fanout_unfinished"]);
  expect(findings).toHaveLength(1);
  expect(findings[0].count).toBe(2);
  expect(findings[0].summary).toContain(bad.id);
  expect(findings[0].summary).toContain(undelivered.id);
  expect(findings[0].summary).not.toContain(done.id);
});

// ---------- 事件与时间线 ----------

function makeTaskRun(home: string, status: string): RunState {
  const store = new RunStore(join(home, "tasks"));
  const state = store.create("后台扇出任务", `sess-${Math.random().toString(36).slice(2, 8)}`, home, "auto", 10, status);
  saveSession(state.session_id, [], home);
  return state;
}

test("MergeFanoutTest.test_merge_fanout_events_registered_and_timeline_renders", () => {
  const { home } = setup();
  const run = makeTaskRun(home, "running");
  const store = new RunStore(join(home, "tasks"));
  // 没注册进 EVENT_FIELDS 会抛错。
  store.appendEvent(run.run_id, "merge_started", { threads: 2, format: "report" });
  store.appendEvent(run.run_id, "merge_finished", { verified: true, checks_passed: 5, checks_failed: 0, review_item_id: "0123456789abcdef" });
  store.appendEvent(run.run_id, "fanout_started", { fanout_id: "fo_0123456789ab", tasks: 2 });
  store.appendEvent(run.run_id, "fanout_finished", { fanout_id: "fo_0123456789ab", status: "done", succeeded: 2, failed: 0 });
  store.appendEvent(run.run_id, "fanout_backfilled", { fanout_id: "fo_0123456789ab", kind: "single" });
  store.appendEvent(run.run_id, "fanout_interrupted", { fanout_id: "fo_0123456789ab", reason: "进程不在了" });
  const tl = buildTimeline(store, run.run_id);
  const titles = tl.steps.map((s) => s.title);
  expect(titles.some((t) => t.includes("合并步开始"))).toBe(true);
  expect(titles.some((t) => t.includes("合并完成"))).toBe(true);
  expect(titles.some((t) => t.includes("后台扇出开始"))).toBe(true);
  expect(titles.some((t) => t.includes("后台扇出 fo_0123456789ab已完成"))).toBe(true);
  expect(titles.some((t) => t.includes("已回填"))).toBe(true);
  expect(titles.some((t) => t.includes("已中断"))).toBe(true);
});

// ---------- CLI ----------

function runCli(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

test("MergeFanoutTest.test_fanout_cli", () => {
  const { home } = setup();
  const empty = runCli(home, ["fanout", "list"]);
  expect(empty.status).toBe(0);
  expect(empty.stdout).toContain("没有后台扇出");
  const record = createFanout(home, { title: "CLI 扇出", tasksCount: 2 });
  const listed = runCli(home, ["fanout", "list"]);
  expect(listed.stdout).toContain(record.id);
  const shown = runCli(home, ["fanout", "show", record.id]);
  expect(shown.status).toBe(0);
  expect(shown.stdout).toContain("跑着");
  expect(runCli(home, ["fanout", "show", "fo_000000000000"]).status).toBe(1);
  const recovered = runCli(home, ["fanout", "recover"]);
  expect(recovered.status).toBe(0);
  expect(recovered.stdout).toContain("已回收 1 个");
  expect(getFanout(home, record.id).status).toBe("interrupted");
  expect(runCli(home, ["fanout", "nope"]).status).toBe(2);
  expect(runCli(home, ["fanout"]).status).toBe(2);
});
