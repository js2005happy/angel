// tests/node/test-steer-schema.test.ts — H-2 单点引导 + H-4 结构化输出契约。
//
// 覆盖：
//   - outputSchema 校验器（抽 JSON / 类型 / 必填 / 多余字段 / enum / 长度与数值）
//   - steer 排队与消费（往返、终态行拒绝、空文本与超长拒绝、消费幂等）
//   - 委派检查点（引导在下一轮模型调用前消费，不打断在跑的工具调用；
//     已请求停止时停在当轮、不再往下跑）
//   - delegate 调用点自动注册（行状态、父子 parentRunId、跑完标 completed；
//     已请求停止的提前交回不标 completed）
//   - 契约校验 + 一次有界纠正轮（一次纠正后通过、纠正后仍失败标 schema_valid: false、
//     契约本身写坏委派前拒绝）
//   - 两个新事件进 EVENT_FIELDS 与时间线渲染；subagent steer CLI。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import {
  checkOutputSchema, extractJsonCandidate, validateOutputSchema,
} from "../../src/outputSchema.ts";
import {
  consumeSteers, finishSubagentRun, getSubagentRun, handleSubagent,
  listSubagentRuns, queueSteer, registerSubagentRun,
  requestSubagentStop,
} from "../../src/resume.ts";
import { RunStore, type RunState } from "../../src/runs.ts";
import { buildTimeline } from "../../src/timeline.ts";
import { saveSession } from "../../src/memory.ts";

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  calls: Record<string, unknown>[][] = [];
  script: Record<string, unknown>[];
  idx = 0;
  onChat: ((n: number) => void) | null = null;
  constructor(script: Record<string, unknown>[]) { this.script = script; }
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(messages: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    this.calls.push(messages);
    if (this.onChat) this.onChat(this.calls.length);
    const next = this.script[Math.min(this.idx, this.script.length - 1)];
    this.idx += 1;
    return next;
  }
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

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
function setup() {
  const home = tmpHome("nyra-steer-");
  const workdir = tmpHome("nyra-steer-wd-");
  return { home, workdir };
}

/** 在任务队列里建一个指定状态的运行（含空会话）。 */
function makeTaskRun(home: string, status: string): RunState {
  const store = new RunStore(join(home, "tasks"));
  const state = store.create("子 agent 任务", `sess-${Math.random().toString(36).slice(2, 8)}`, home, "auto", 10, status);
  saveSession(state.session_id, [], home);
  return state;
}

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    n: { type: "integer", minimum: 0 },
    tag: { type: "string", enum: ["a", "b"] },
  },
  required: ["name", "n"],
  additionalProperties: false,
};

// ---------- H-4：校验器 ----------

test("SteerSchemaTest.test_extract_json_candidate", () => {
  expect(extractJsonCandidate('{"a": 1}').value).toEqual({ a: 1 });
  expect(extractJsonCandidate('先说两句\n```json\n{"a": 2}\n```\n再说两句').value).toEqual({ a: 2 });
  expect(extractJsonCandidate('结果如下：{"a": 3}，以上').value).toEqual({ a: 3 });
  expect(extractJsonCandidate("这里没有 JSON").found).toBe(false);
  expect(extractJsonCandidate('```\n[1, 2]\n```').value).toEqual([1, 2]);
});

test("SteerSchemaTest.test_validate_output_schema_cases", () => {
  const ok = validateOutputSchema('{"name": "x", "n": 3, "tag": "a"}', SCHEMA);
  expect(ok.valid).toBe(true);
  expect(ok.errors).toEqual([]);
  const missing = validateOutputSchema('{"name": "x"}', SCHEMA);
  expect(missing.valid).toBe(false);
  expect(missing.errors.some((e) => e.includes("缺少必填字段 n"))).toBe(true);
  const wrongType = validateOutputSchema('{"name": "x", "n": "3"}', SCHEMA);
  expect(wrongType.valid).toBe(false);
  expect(wrongType.errors.some((e) => e.includes("应为 integer"))).toBe(true);
  const extra = validateOutputSchema('{"name": "x", "n": 1, "zzz": 2}', SCHEMA);
  expect(extra.valid).toBe(false);
  expect(extra.errors.some((e) => e.includes("多余字段 zzz"))).toBe(true);
  const badEnum = validateOutputSchema('{"name": "x", "n": 1, "tag": "c"}', SCHEMA);
  expect(badEnum.valid).toBe(false);
  expect(badEnum.errors.some((e) => e.includes("enum"))).toBe(true);
  const noJson = validateOutputSchema("纯文字，没有 JSON", SCHEMA);
  expect(noJson.valid).toBe(false);
  expect(noJson.errors[0]).toContain("没找到 JSON");
  expect(checkOutputSchema(SCHEMA)).toBeNull();
  expect(checkOutputSchema({ type: "bogus" })).toContain("type 必须是");
  expect(checkOutputSchema("not-an-object")).toContain("必须是 JSON Schema 对象");
  expect(checkOutputSchema({ required: "name" })).toContain("required 必须是字符串数组");
});

// ---------- H-2：排队与消费 ----------

test("SteerSchemaTest.test_queue_and_consume_steer", () => {
  const { home } = setup();
  registerSubagentRun(home, { runId: "run-1" });
  const s1 = queueSteer(home, "run-1", "先别管格式，把数字算对", { by: "tester" });
  expect(s1.id.startsWith("steer-")).toBe(true);
  expect(s1.consumedAt).toBeNull();
  const s2 = queueSteer(home, "run-1", "第二条引导", { by: "tester" });
  expect(getSubagentRun(home, "run-1").steerQueue).toHaveLength(2);
  const consumed = consumeSteers(home, "run-1");
  expect(consumed.map((s) => s.id)).toEqual([s1.id, s2.id]);
  expect(consumed.every((s) => s.consumedAt !== null)).toBe(true);
  // 再消费一次是空的（幂等，不重复消费）。
  expect(consumeSteers(home, "run-1")).toEqual([]);
  expect(getSubagentRun(home, "run-1").steerQueue).toHaveLength(2);
});

test("SteerSchemaTest.test_queue_steer_rejects", () => {
  const { home } = setup();
  expect(() => queueSteer(home, "run-missing", "引导")).toThrow("注册表里没有");
  registerSubagentRun(home, { runId: "run-1" });
  expect(() => queueSteer(home, "run-1", "   ")).toThrow("引导文本不能为空");
  expect(() => queueSteer(home, "run-1", "x".repeat(1001))).toThrow("引导文本太长");
  finishSubagentRun(home, "run-1", "completed");
  expect(() => queueSteer(home, "run-1", "晚了")).toThrow("只能给 running/resume_pending");
});

// ---------- H-2：检查点 ----------

test("SteerSchemaTest.test_checkpoint_consumes_steer_before_next_turn", async () => {
  const { home, workdir } = setup();
  registerSubagentRun(home, { runId: "run-child" });
  queueSteer(home, "run-child", "先别管格式，把数字算对", { by: "tester" });
  const provider = new FakeProvider([
    toolReply("c1", "list_dir", { path: "." }),
    textReply("子任务做完了"),
  ]);
  const child = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 6, skillsDirs: [], subagentRunId: "run-child",
  });
  const out = await child.run("数一数文件");
  expect(out).toContain("子任务做完了");
  // 引导在第 2 轮模型调用前已递进上下文（第 2 次 chat 的消息里有引导文本）。
  expect(provider.calls.length).toBe(2);
  expect(JSON.stringify(provider.calls[1])).toContain("先别管格式，把数字算对");
  // 消费已落盘，心跳也记了本轮动作。
  const row = getSubagentRun(home, "run-child");
  expect(row.steerQueue[0].consumedAt).not.toBeNull();
  expect(row.lastStep ?? "").toContain("list_dir");
});

test("SteerSchemaTest.test_checkpoint_stops_at_current_turn", async () => {
  const { home, workdir } = setup();
  registerSubagentRun(home, { runId: "run-child" });
  requestSubagentStop(home, "run-child", { by: "tester" });
  const provider = new FakeProvider([
    toolReply("c1", "list_dir", { path: "." }),
    textReply("这句不该跑到"),
  ]);
  const child = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 6, skillsDirs: [], subagentRunId: "run-child",
  });
  const out = await child.run("数一数文件");
  expect(out).toContain("已请求停止");
  expect(out).not.toContain("这句不该跑到");
  // 只调了一次模型：工具跑完就停，没有第 2 轮。
  expect(provider.calls.length).toBe(1);
});

test("SteerSchemaTest.test_no_checkpoint_without_subagent_run_id", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    toolReply("c1", "list_dir", { path: "." }),
    textReply("主任务做完了"),
  ]);
  const agent = new Agent(provider as never, { workdir, home, mode: "full", maxTurns: 6, skillsDirs: [] });
  const out = await agent.run("数一数文件");
  expect(out).toContain("主任务做完了");
  expect(provider.calls.length).toBe(2);
});

// ---------- delegate 调用点自动注册 ----------

test("SteerSchemaTest.test_delegate_auto_registers_and_finishes", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    toolReply("c1", "delegate", { task: "数一数", max_turns: 3 }),
    textReply("子任务结果：42"),
    textReply("父级收尾：42"),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261121-000000-parent",
  });
  const out = await agent.run("派个子任务数一数");
  expect(out).toContain("父级收尾");
  const rows = listSubagentRuns(home);
  expect(rows).toHaveLength(1);
  expect(rows[0].runId.startsWith("task-")).toBe(true);
  expect(rows[0].status).toBe("completed");
  expect(rows[0].parentRunId).toBeNull();
});

test("SteerSchemaTest.test_delegate_nested_parent_run_id", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    toolReply("c1", "delegate", { task: "子任务", max_turns: 6 }),
    toolReply("c2", "delegate", { task: "孙任务", max_turns: 3 }),
    textReply("孙任务结果"),
    textReply("子任务结果"),
    textReply("父级收尾"),
  ]);
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261121-000000-parent2",
  });
  const out = await agent.run("派个子任务");
  expect(out).toContain("父级收尾");
  const rows = listSubagentRuns(home);
  expect(rows).toHaveLength(2);
  const child = rows.find((r) => r.parentRunId === null)!;
  const grandchild = rows.find((r) => r.parentRunId === child.runId)!;
  expect(grandchild).toBeDefined();
  expect(child.status).toBe("completed");
  expect(grandchild.status).toBe("completed");
});

test("SteerSchemaTest.test_delegate_steer_consumed_mid_run", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    toolReply("c1", "delegate", { task: "数一数", max_turns: 3 }),
    toolReply("c2", "list_dir", { path: "." }),
    textReply("子任务做完了"),
    textReply("父级收尾"),
  ]);
  // 子 agent 第 1 轮模型调用时（行已注册）排一条引导；检查点在工具跑完后消费。
  provider.onChat = (n) => {
    if (n !== 2) return;
    const running = listSubagentRuns(home, { status: "running" });
    if (running.length === 1) queueSteer(home, running[0].runId, "先别管格式，把数字算对", { by: "tester" });
  };
  const parentEvents: { kind: string; data: Record<string, unknown> }[] = [];
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261121-000000-parent3",
    onEvent: (kind, data) => { parentEvents.push({ kind, data }); },
  });
  const out = await agent.run("派个子任务数一数");
  expect(out).toContain("父级收尾");
  // 第 3 次 chat 是子 agent 第 2 轮，消息里已有引导文本。
  expect(JSON.stringify(provider.calls[2])).toContain("先别管格式，把数字算对");
  // 消费事件补进了父级证据链。
  expect(parentEvents.some((e) => e.kind === "subagent_steer_consumed")).toBe(true);
});

test("SteerSchemaTest.test_delegate_stop_mid_run_keeps_row_running", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    toolReply("c1", "delegate", { task: "数一数", max_turns: 3 }),
    toolReply("c2", "list_dir", { path: "." }),
    textReply("父级收尾"),
  ]);
  // 子 agent 第 1 轮模型调用时（行已注册）请求停止；检查点在工具跑完后停下。
  provider.onChat = (n) => {
    if (n !== 2) return;
    const running = listSubagentRuns(home, { status: "running" });
    if (running.length === 1) requestSubagentStop(home, running[0].runId, { by: "tester" });
  };
  const parentEvents: { kind: string; data: Record<string, unknown> }[] = [];
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    sessionId: "20261121-000000-parent4",
    onEvent: (kind, data) => { parentEvents.push({ kind, data }); },
  });
  const out = await agent.run("派个子任务数一数");
  expect(out).toContain("父级收尾");
  const delegateResult = parentEvents.find((e) => e.kind === "tool_result" && (e.data.name as string) === "delegate");
  expect(String(delegateResult?.data.result ?? "")).toContain("已请求停止");
  // 只调了 3 次模型：父级第 1 轮、子级第 1 轮、父级收尾轮；子级没有第 2 轮。
  expect(provider.calls.length).toBe(3);
  // 提前交回的行不标 completed——停没停下以人的 confirm-stopped 为准。
  const rows = listSubagentRuns(home);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("running");
  expect(rows[0].stopRequestedAt).not.toBeNull();
});

// ---------- H-4：契约校验 + 纠正轮 ----------

test("SteerSchemaTest.test_delegate_schema_corrected_once", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    textReply("不是 JSON"),
    textReply('{"name": "a", "n": 2}'),
  ]);
  const agent = new Agent(provider as never, { workdir, home, mode: "full", skillsDirs: [] });
  const result = await agent.delegateDetailed("做个小任务", 6, { outputSchema: SCHEMA });
  expect(result.ok).toBe(true);
  expect(result.schema?.valid).toBe(true);
  expect(result.schema?.corrected).toBe(true);
  expect(result.text).toContain("schema_valid: true");
  expect(result.text).toContain("纠正 1 次后通过");
  expect(provider.calls.length).toBe(2);
});

test("SteerSchemaTest.test_delegate_schema_still_invalid_after_correction", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    textReply("nope"),
    textReply("still nope"),
  ]);
  const agent = new Agent(provider as never, { workdir, home, mode: "full", skillsDirs: [] });
  const result = await agent.delegateDetailed("做个小任务", 6, { outputSchema: SCHEMA });
  expect(result.ok).toBe(true);
  expect(result.schema?.valid).toBe(false);
  expect(result.schema?.corrected).toBe(true);
  // 失败按失败走：验收结论是 failed，原文保留，不静默接受。
  expect(result.verification.status).toBe("failed");
  expect(result.text).toContain("schema_valid: false");
  expect(result.text).toContain("still nope");
  // 只纠正一次：两次模型调用，没有第三次。
  expect(provider.calls.length).toBe(2);
});

test("SteerSchemaTest.test_delegate_schema_valid_first_try", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([
    textReply('```json\n{"name": "a", "n": 2}\n```'),
  ]);
  const agent = new Agent(provider as never, { workdir, home, mode: "full", skillsDirs: [] });
  const result = await agent.delegateDetailed("做个小任务", 6, { outputSchema: SCHEMA });
  expect(result.schema?.valid).toBe(true);
  expect(result.schema?.corrected).toBe(false);
  expect(provider.calls.length).toBe(1);
});

test("SteerSchemaTest.test_delegate_schema_rejected_before_run", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([textReply("不会跑到")]);
  const agent = new Agent(provider as never, { workdir, home, mode: "full", skillsDirs: [] });
  const result = await agent.delegateDetailed("做个小任务", 6, { outputSchema: { type: "bogus" } });
  expect(result.ok).toBe(false);
  expect(result.text).toContain("output_schema");
  expect(provider.calls.length).toBe(0);
});

// ---------- 事件与 CLI ----------

test("SteerSchemaTest.test_steer_events_registered_and_timeline_renders", () => {
  const { home } = setup();
  const parent = makeTaskRun(home, "running");
  registerSubagentRun(home, { runId: "run-child", parentRunId: parent.run_id });
  queueSteer(home, "run-child", "先别管格式", { by: "tester" });
  const store = new RunStore(join(home, "tasks"));
  // 排队事件已写进父运行的链（没注册进 EVENT_FIELDS 会抛错）。
  const parentEvents = store.readEvents(parent.run_id);
  expect(parentEvents.some((e) => (e as Record<string, unknown>).type === "subagent_steer_queued")).toBe(true);
  // 消费事件同样注册且可渲染。
  store.appendEvent(parent.run_id, "subagent_steer_consumed", { run_id: "run-child", by: "tester", steer_id: "steer-x" });
  const tl = buildTimeline(store, parent.run_id);
  const titles = tl.steps.map((s) => s.title);
  expect(titles.some((t) => t.includes("收到引导"))).toBe(true);
  expect(titles.some((t) => t.includes("已消费引导"))).toBe(true);
});

test("SteerSchemaTest.test_subagent_steer_cli", async () => {
  const { home } = setup();
  registerSubagentRun(home, { runId: "run-1" });
  // 没 --yes 拒绝。
  expect(await handleSubagent(["steer", "run-1", "引导文本"], home)).toBe(2);
  expect(getSubagentRun(home, "run-1").steerQueue).toHaveLength(0);
  // 正常排队。
  expect(await handleSubagent(["steer", "run-1", "引导文本", "--yes", "--by", "tester"], home)).toBe(0);
  expect(getSubagentRun(home, "run-1").steerQueue).toHaveLength(1);
  // 不存在的行报错。
  expect(await handleSubagent(["steer", "run-missing", "引导", "--yes"], home)).toBe(1);
});
