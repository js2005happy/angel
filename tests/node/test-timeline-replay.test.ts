// tests/node/test-timeline-replay.test.ts — 缺口 21：多 agent 执行时间线 + 会话回放。
// 时间线从 state.json + events.jsonl 重建；回放与导出只读，不重新执行。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore, RunRecorder } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText, formatReplayText, formatTimelineMarkdown, exportTimelineMarkdown } from "../../src/timeline.ts";
import { Agent } from "../../src/agent.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-timeline-test-"));
}

function tmpWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "nyra-timeline-wd-"));
}

function seedRun(home: string): { store: RunStore; runId: string } {
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  return { store, runId: state.run_id };
}

/** 手写 events.jsonl（带显式 at，供排序测试用）。 */
function writeEvents(home: string, runId: string, lines: Record<string, unknown>[]): void {
  writeFileSync(join(home, "runs", runId, "events.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function atAfter(createdAt: string, seconds: number): string {
  return new Date(Date.parse(createdAt) + seconds * 1000).toISOString();
}

test("TimelineTest.test_orders_by_time_even_when_file_is_out_of_order", () => {
  const home = tmpHome();
  const { store, runId } = seedRun(home);
  const created = store.load(runId).created_at;
  // 文件里结果在前、开始在后；时间线必须按时间重排，且按 id 配对成一步。
  writeEvents(home, runId, [
    { at: atAfter(created, 0), type: "run_started" },
    { at: atAfter(created, 2), type: "tool_result", id: "c1", name: "read_file", ok: true, args_hash: "abc123" },
    { at: atAfter(created, 1), type: "tool_start", id: "c1", name: "read_file", args_hash: "abc123" },
  ]);
  const tl = buildTimeline(store, runId);
  expect(tl.steps.length).toBe(2);
  expect(tl.steps[0].title).toContain("运行开始");
  expect(tl.steps[1].title).toContain("read_file");
  expect(tl.steps[1].ok).toBe(true);
  expect(tl.steps[1].durationMs).toBe(1000);
  expect(tl.toolCalls).toBe(1);
  expect(tl.toolErrors).toBe(0);
});

test("TimelineTest.test_dangling_tool_call_is_marked_not_hidden", () => {
  const home = tmpHome();
  const { store, runId } = seedRun(home);
  store.appendEvent(runId, "tool_start", { id: "c9", name: "write_file", args_hash: "zzz" });
  const tl = buildTimeline(store, runId);
  expect(tl.steps.some((s) => s.title.includes("write_file") && s.title.includes("无结果"))).toBe(true);
  expect(tl.toolCalls).toBe(1);
});

test("TimelineTest.test_llm_span_counts_and_turn_fallback", () => {
  const home = tmpHome();
  // 只有 turn 事件的旧运行：模型调用数退回 turn 计数。
  const old = seedRun(home);
  old.store.appendEvent(old.runId, "turn", { turn: 1 });
  old.store.appendEvent(old.runId, "turn", { turn: 2 });
  expect(buildTimeline(old.store, old.runId).llmCalls).toBe(2);
  // 有 llm_span 的新运行：按 span 计数，token 进详情。
  const next = seedRun(home);
  next.store.appendEvent(next.runId, "llm_span", { model: "fake-1", duration_ms: 1200, prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, ok: true });
  next.store.appendEvent(next.runId, "llm_span", { model: "fake-1", duration_ms: 800, prompt_tokens: 80, completion_tokens: 40, total_tokens: 120, ok: true });
  const tl = buildTimeline(next.store, next.runId);
  expect(tl.llmCalls).toBe(2);
  const text = formatTimelineText(tl, { verbose: true });
  expect(text).toContain("fake-1");
  expect(text).toContain("prompt 100 / completion 50 / 合计 150");
});

test("TimelineTest.test_delegate_pairing_and_dangling", () => {
  const home = tmpHome();
  const { store, runId } = seedRun(home);
  store.appendEvent(runId, "delegate_start", { task_id: "task-aaaa", model: "fake-1", max_turns: 3 });
  store.appendEvent(runId, "delegate_end", { task_id: "task-aaaa", ok: true, turns: 2, spent_usd: 0.01, verification: "verified" });
  store.appendEvent(runId, "delegate_start", { task_id: "task-bbbb", model: "fake-1", max_turns: 3 });
  const tl = buildTimeline(store, runId);
  const done = tl.steps.find((s) => s.title.includes("task-aaaa"));
  expect(done).toBeDefined();
  expect(done?.ok).toBe(true);
  expect(done?.detail).toContain("验收：verified");
  expect(tl.steps.some((s) => s.title.includes("task-bbbb") && s.title.includes("未结束"))).toBe(true);
});

test("TimelineTest.test_long_token_strings_are_redacted", () => {
  const home = tmpHome();
  const { store, runId } = seedRun(home);
  const leaked = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  store.appendEvent(runId, "verifier_verdict", { target: "task-1", verdict: "failed", reason: `密钥是 ${leaked} 导致失败`, verifier_model: "fake", source: "verifier", checks_passed: 1, checks_failed: 2 });
  const text = formatTimelineText(buildTimeline(store, runId), { verbose: true });
  expect(text).not.toContain(leaked);
  expect(text).toContain("未通过");
});

test("TimelineTest.test_fresh_run_only_has_run_started", () => {
  const home = tmpHome();
  const { store, runId } = seedRun(home);
  const tl = buildTimeline(store, runId);
  // store.create 会写一条 run_started，所以全新运行恰好只有这一步。
  expect(tl.steps.length).toBe(1);
  expect(tl.steps[0].kind).toBe("run");
  expect(tl.toolCalls).toBe(0);
  expect(tl.llmCalls).toBe(null);
  expect(formatTimelineText(tl)).toContain("运行开始");
});

test("TimelineTest.test_replay_groups_by_turn_and_is_readonly", () => {
  const home = tmpHome();
  const { store, runId } = seedRun(home);
  store.appendEvent(runId, "turn", { turn: 1 });
  store.appendEvent(runId, "tool_start", { id: "c1", name: "read_file", args_hash: "a" });
  store.appendEvent(runId, "tool_result", { id: "c1", name: "read_file", ok: true, args_hash: "a" });
  store.appendEvent(runId, "turn", { turn: 2 });
  store.appendEvent(runId, "verifier_verdict", { target: "task-1", verdict: "verified", reason: "都过了", verifier_model: "fake", source: "verifier", checks_passed: 2, checks_failed: 0 });
  const eventsBefore = readFileSync(join(home, "runs", runId, "events.jsonl"), "utf-8");
  const stateBefore = readFileSync(join(home, "runs", runId, "state.json"), "utf-8");
  const tl = buildTimeline(store, runId);
  const replay = formatReplayText(tl);
  expect(replay).toContain("只读");
  expect(replay).toContain("== 第 1 轮 ==");
  expect(replay).toContain("== 第 2 轮 ==");
  expect(replay).toContain("验收");
  expect(replay).toContain("回放结束");
  // 回放不写任何东西：事件与状态文件字节级不变。
  expect(readFileSync(join(home, "runs", runId, "events.jsonl"), "utf-8")).toBe(eventsBefore);
  expect(readFileSync(join(home, "runs", runId, "state.json"), "utf-8")).toBe(stateBefore);
});

test("TimelineTest.test_export_markdown_contains_headline_and_steps", () => {
  const home = tmpHome();
  const { store, runId } = seedRun(home);
  store.appendEvent(runId, "turn", { turn: 1 });
  store.appendEvent(runId, "tool_start", { id: "c1", name: "read_file", args_hash: "a" });
  store.appendEvent(runId, "tool_result", { id: "c1", name: "read_file", ok: false, args_hash: "a" });
  const outPath = join(home, "timeline-report.md");
  exportTimelineMarkdown(store, runId, outPath);
  const md = readFileSync(outPath, "utf-8");
  expect(md).toContain("# 运行时间线");
  expect(md).toContain("| 状态 |");
  expect(md).toContain("| 花费 |");
  expect(md).toContain("read_file");
  expect(md).toContain("失败");
  expect(md).toContain("只读回放");
  if (process.platform !== "win32") expectPerms(outPath, 0o600);
  // formatTimelineMarkdown 与导出文件内容一致。
  expect(formatTimelineMarkdown(buildTimeline(store, runId))).toBe(md);
});

test("TimelineTest.test_unknown_run_throws", () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  expect(() => buildTimeline(store, "20261120-000000-abcdef")).toThrow();
  expect(() => exportTimelineMarkdown(store, "20261120-000000-abcdef", join(home, "x.md"))).toThrow();
  expect(existsSync(join(home, "x.md"))).toBe(false);
});

// ---- 端到端：真 Agent + RunRecorder 埋点 ----

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  script: Record<string, unknown>[];
  idx = 0;
  constructor(script: Record<string, unknown>[]) { this.script = script; }
  hasCredentials() { return true; }
  async chat(): Promise<Record<string, unknown>> {
    const next = this.script[Math.min(this.idx, this.script.length - 1)];
    this.idx += 1;
    return next;
  }
}

function withUsage(reply: Record<string, unknown>): Record<string, unknown> {
  return { ...reply, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
}

function textReply(text: string): Record<string, unknown> {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}

function toolReply(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

test("TimelineTest.test_agent_emits_llm_spans_and_delegate_events", async () => {
  const home = tmpHome();
  const workdir = tmpWorkdir();
  const provider = new FakeProvider([
    withUsage(toolReply("c1", "delegate", { task: "数一数", max_turns: 3 })),
    withUsage(textReply("子任务结果：42")),
    withUsage(textReply("父级收尾：42")),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261118-000000-parent",
  });
  const store = new RunStore(join(home, "runs"));
  const recorder = new RunRecorder(store, agent, "派个子任务", {});
  const out = await agent.run("派个子任务数一数");
  expect(out).toContain("父级收尾");
  const events = store.readEvents(recorder.runId);
  const types = events.map((e) => e.type);
  expect(types).toContain("llm_span");
  expect(types).toContain("delegate_start");
  expect(types).toContain("delegate_end");
  const spans = events.filter((e) => e.type === "llm_span");
  expect(spans.length).toBe(2); // 父级两轮；子级内部调用不进父级事件链
  expect(spans[0].model).toBe("fake-1");
  expect(spans[0].prompt_tokens).toBe(100);
  expect(spans[0].completion_tokens).toBe(50);
  expect(spans[0].ok).toBe(true);
  const end = events.find((e) => e.type === "delegate_end");
  expect(end?.ok).toBe(true);
  expect(end?.verification).toBe("not-verified");
  // 时间线能直接读出这两次埋点。
  const tl = buildTimeline(store, recorder.runId);
  expect(tl.llmCalls).toBe(2);
  expect(tl.steps.some((s) => s.kind === "delegate" && s.title.includes("子任务"))).toBe(true);
});

// ---- CLI 子进程冒烟 ----

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(argv: string[], home: string, workdir: string): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...argv, "--workdir", workdir],
    env: { ...process.env, NYRA_HOME: home, NYRA_CONFIG: join(home, "config.json"), NYRA_LAZY_TOOLS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

test("TimelineTest.test_cli_timeline_replay_and_missing_run", async () => {
  const home = tmpHome();
  const workdir = tmpWorkdir();
  const { store, runId } = seedRun(home);
  store.appendEvent(runId, "turn", { turn: 1 });
  store.appendEvent(runId, "tool_start", { id: "c1", name: "read_file", args_hash: "a" });
  store.appendEvent(runId, "tool_result", { id: "c1", name: "read_file", ok: true, args_hash: "a" });
  const tl = await runCli(["timeline", runId], home, workdir);
  expect(tl.code).toBe(0);
  expect(tl.stdout).toContain(runId);
  expect(tl.stdout).toContain("read_file");
  const rp = await runCli(["replay", runId], home, workdir);
  expect(rp.code).toBe(0);
  expect(rp.stdout).toContain("第 1 轮");
  expect(rp.stdout).toContain("只读");
  const missing = await runCli(["timeline", "20261120-000000-abcdef"], home, workdir);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain("找不到运行");
  const noArg = await runCli(["timeline"], home, workdir);
  expect(noArg.code).toBe(2);
});
