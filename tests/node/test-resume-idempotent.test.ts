// tests/node/test-resume-idempotent.test.ts — P1-4：断点续跑不重复副作用（幂等键）。
// 同一写调用（工具名 + 参数哈希）在中断前已成功、且读回仍证明生效时，续跑跳过；
// 任一条件不满足都正常重执行。shell/apply_patch 等无法读回核查的工具不在此列。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import { RunStore, RunRecorder, loadCompletedWriteKeys } from "../../src/runs.ts";
import { idempotencyKey, stableStringify, RESUME_IDEMPOTENT_TOOLS } from "../../src/tools.ts";

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  script: Record<string, unknown>[];
  idx = 0;
  constructor(script: Record<string, unknown>[]) { this.script = script; }
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(): Promise<Record<string, unknown>> {
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

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-resume-idem-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-resume-wd-"));
  return { home, workdir };
}

test("ResumeIdempotent.test_key_is_content_based", () => {
  const a = idempotencyKey("write_file", { path: "a.txt", content: "hi\n" });
  const b = idempotencyKey("write_file", { content: "hi\n", path: "a.txt" });
  expect(a).toBe(b); // 键名顺序不同，同一调用
  expect(idempotencyKey("write_file", { path: "a.txt", content: "bye\n" })).not.toBe(a);
  expect(idempotencyKey("edit_file", { path: "a.txt", content: "hi\n" })).not.toBe(a);
  expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  expect(RESUME_IDEMPOTENT_TOOLS.has("write_file")).toBe(true);
  expect(RESUME_IDEMPOTENT_TOOLS.has("shell")).toBe(false);
  expect(RESUME_IDEMPOTENT_TOOLS.has("apply_patch")).toBe(false);
});

test("ResumeIdempotent.test_load_keys_from_events", () => {
  const { home, workdir } = setup();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("任务", "sess-1", workdir, "auto", 5);
  const k1 = idempotencyKey("write_file", { path: "a.txt", content: "hi\n" });
  const k2 = idempotencyKey("edit_file", { path: "a.txt", old_text: "x", new_text: "y" });
  const k3 = idempotencyKey("shell", { command: "echo hi" });
  store.appendEvent(state.run_id, "tool_start", { id: "c1", name: "write_file", args_hash: k1 });
  store.appendEvent(state.run_id, "tool_result", { id: "c1", name: "write_file", ok: true, args_hash: k1 });
  store.appendEvent(state.run_id, "tool_start", { id: "c2", name: "edit_file", args_hash: k2 });
  store.appendEvent(state.run_id, "tool_result", { id: "c2", name: "edit_file", ok: false, args_hash: k2 });
  store.appendEvent(state.run_id, "tool_start", { id: "c3", name: "shell", args_hash: k3 });
  store.appendEvent(state.run_id, "tool_result", { id: "c3", name: "shell", ok: true, args_hash: k3 });
  store.appendEvent(state.run_id, "tool_start", { id: "c4", name: "write_file" });
  store.appendEvent(state.run_id, "tool_result", { id: "c4", name: "write_file", ok: true });
  const keys = loadCompletedWriteKeys(store, state.run_id);
  expect([...keys]).toEqual([k1]); // 只有成功的、可核查的、带键的写调用
});

async function runWriteAgent(home: string, workdir: string, keys: Set<string>, preContent: string | null): Promise<{ file: string | null; toolResults: string[] }> {
  if (preContent !== null) writeFileSync(join(workdir, "a.txt"), preContent);
  const results: string[] = [];
  const agent = new Agent(
    new FakeProvider([
      toolReply("c1", "write_file", { path: "a.txt", content: "new\n" }),
      textReply("done"),
    ]) as never,
    { workdir, home, mode: "full", skillsDirs: [] },
  );
  agent.ctx.resumeCompletedWriteKeys = keys;
  agent.onEvent = (kind, data) => {
    if (kind === "tool_result") results.push(String(data.result ?? ""));
  };
  await agent.run("写文件");
  let file: string | null = null;
  try { file = readFileSync(join(workdir, "a.txt"), "utf-8"); } catch { file = null; }
  return { file, toolResults: results };
}

test("ResumeIdempotent.test_skip_completed_write_on_resume", async () => {
  const { home, workdir } = setup();
  const key = idempotencyKey("write_file", { path: "a.txt", content: "new\n" });
  // 中断前已成功写入 new\n：文件现状与参数一致，读回核查通过，跳过。
  const r = await runWriteAgent(home, workdir, new Set([key]), "new\n");
  expect(r.file).toBe("new\n");
  expect(r.toolResults.length).toBe(1);
  expect(r.toolResults[0]).toContain("幂等键命中");
  expect(r.toolResults[0]).toContain("跳过重复执行");
});

test("ResumeIdempotent.test_no_keys_executes_normally", async () => {
  const { home, workdir } = setup();
  const r = await runWriteAgent(home, workdir, new Set(), "original\n");
  expect(r.file).toBe("new\n");
  expect(r.toolResults[0]).not.toContain("幂等键命中");
});

test("ResumeIdempotent.test_externally_modified_reexecutes", async () => {
  const { home, workdir } = setup();
  const key = idempotencyKey("write_file", { path: "a.txt", content: "new\n" });
  // 键命中，但文件被外部改成 other\n：读回核查失败，必须重执行，不能撒谎说“已执行过”。
  const r = await runWriteAgent(home, workdir, new Set([key]), "other\n");
  expect(r.file).toBe("new\n");
  expect(r.toolResults[0]).not.toContain("幂等键命中");
});

test("ResumeIdempotent.test_deleted_file_reexecutes", async () => {
  const { home, workdir } = setup();
  const key = idempotencyKey("write_file", { path: "a.txt", content: "new\n" });
  // 键命中，但文件已被删：读回核查失败，重执行（文件重新出现）。
  const r = await runWriteAgent(home, workdir, new Set([key]), null);
  expect(r.file).toBe("new\n");
  expect(r.toolResults[0]).not.toContain("幂等键命中");
});

test("ResumeIdempotent.test_recorder_round_trip", async () => {
  const { home, workdir } = setup();
  const agent = new Agent(
    new FakeProvider([
      toolReply("c1", "write_file", { path: "a.txt", content: "hi\n" }),
      textReply("done"),
    ]) as never,
    { workdir, home, mode: "full", maxTurns: 5, sessionId: "20261119-000000-test1", skillsDirs: [] },
  );
  const store = new RunStore(join(home, "runs"));
  const recorder = new RunRecorder(store, agent, "写文件", {});
  await recorder.run("写文件");
  const events = store.readEvents(recorder.runId);
  const start = events.find((e) => e.type === "tool_start");
  const result = events.find((e) => e.type === "tool_result");
  const key = idempotencyKey("write_file", { path: "a.txt", content: "hi\n" });
  expect(start?.args_hash).toBe(key);
  expect(result?.args_hash).toBe(key);
  expect(result?.ok).toBe(true);
  expect([...loadCompletedWriteKeys(store, recorder.runId)]).toEqual([key]);
  // 产物哈希也应落盘（P1-2）。
  const state = store.load(recorder.runId);
  expect(typeof state.file_hashes?.["a.txt"]).toBe("string");
});
