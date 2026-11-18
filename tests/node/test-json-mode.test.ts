// tests/node/test-json-mode.test.ts — 对应 tests/test_json_mode.py（16 个唯一测试）。
import { test, expect } from "bun:test";
import { Writable } from "node:stream";
import {
  SCHEMA_VERSION, EXIT_SUCCESS, EXIT_RUNTIME, EXIT_ARGUMENT, EXIT_INCOMPLETE,
  EXIT_VERIFY, EXIT_INTERRUPTED, JsonLines, invalidArguments,
} from "../../src/jsonMode.ts";

class CollectStream extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.chunks.push(chunk.toString("utf-8"));
    cb();
  }
  lines(): Record<string, unknown>[] {
    return this.chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

test("JsonModeTest.test_schema_version_and_exit_codes", () => {
  expect(SCHEMA_VERSION).toBe(1);
  expect(EXIT_SUCCESS).toBe(0);
  expect(EXIT_RUNTIME).toBe(1);
  expect(EXIT_ARGUMENT).toBe(2);
  expect(EXIT_INCOMPLETE).toBe(3);
  expect(EXIT_VERIFY).toBe(4);
  expect(EXIT_INTERRUPTED).toBe(130);
});

test("JsonModeTest.test_emit_seq_increments", () => {
  const stream = new CollectStream();
  const jl = new JsonLines(stream as unknown as NodeJS.WriteStream);
  jl.emit("run_started", { task: "x" });
  jl.emit("run_completed", { result: "ok" });
  const lines = stream.lines();
  expect(lines.length).toBe(2);
  expect(lines[0].seq).toBe(1);
  expect(lines[1].seq).toBe(2);
  expect(lines[0].schema_version).toBe(1);
  expect(lines[0].type).toBe("run_started");
});

test("JsonModeTest.test_agent_event_filters_usage_only", () => {
  const stream = new CollectStream();
  const jl = new JsonLines(stream as unknown as NodeJS.WriteStream);
  jl.agentEvent("usage", { calls: 1 });
  jl.agentEvent("auto_compact", { before: 10, after: 4 });
  const lines = stream.lines();
  expect(lines.map((l) => l.type)).toEqual(["usage", "auto_compact"]);
  expect(lines[0].calls).toBe(1);
});

test("JsonModeTest.test_agent_event_tool_start_only_id_name", () => {
  const stream = new CollectStream();
  const jl = new JsonLines(stream as unknown as NodeJS.WriteStream);
  jl.agentEvent("tool_start", { id: "c1", name: "read_file", extra: "secret" });
  const lines = stream.lines();
  expect(lines[0]).toEqual({ schema_version: 1, seq: 1, type: "tool_start", id: "c1", name: "read_file" });
});

test("JsonModeTest.test_agent_event_tool_result_only_ok_bool", () => {
  const stream = new CollectStream();
  const jl = new JsonLines(stream as unknown as NodeJS.WriteStream);
  jl.agentEvent("tool_result", { id: "c1", name: "read_file", result: "文件内容含密钥 sk-abc" });
  jl.agentEvent("tool_result", { id: "c2", name: "write_file", result: "错误：写入失败" });
  const lines = stream.lines();
  expect(lines[0].ok).toBe(true);
  expect(lines[1].ok).toBe(false);
  expect(JSON.stringify(lines)).not.toContain("sk-abc");
  expect(JSON.stringify(lines)).not.toContain("写入失败");
});

test("JsonModeTest.test_agent_event_assistant_and_max_turns", () => {
  const stream = new CollectStream();
  const jl = new JsonLines(stream as unknown as NodeJS.WriteStream);
  jl.agentEvent("assistant", { content: "你好" });
  jl.agentEvent("max_turns", {});
  const lines = stream.lines();
  expect(lines[0].content).toBe("你好");
  expect(lines[1].type).toBe("turn_limit");
});

test("JsonModeTest.test_agent_event_drops_unknown", () => {
  const stream = new CollectStream();
  const jl = new JsonLines(stream as unknown as NodeJS.WriteStream);
  jl.agentEvent("tool_stream", { name: "shell", text: "x" });
  jl.agentEvent("something_else", {});
  expect(stream.lines().length).toBe(0);
});

test("JsonModeTest.test_verify_events", () => {
  const stream = new CollectStream();
  const jl = new JsonLines(stream as unknown as NodeJS.WriteStream);
  jl.agentEvent("verify_started", { command: "make test" });
  jl.agentEvent("verify_result", { command: "make test", exit_code: 0, passed: true, attempt: 1, tests_modified: false });
  const lines = stream.lines();
  expect(lines[0].command).toBe("make test");
  expect(lines[1].passed).toBe(true);
  expect(lines[1].exit_code).toBe(0);
});

test("JsonModeTest.test_invalid_arguments", () => {
  const stream = new CollectStream();
  const code = invalidArguments(stream as unknown as NodeJS.WriteStream, "需要任务文本");
  expect(code).toBe(2);
  const lines = stream.lines();
  expect(lines[0].type).toBe("run_failed");
  expect(JSON.stringify(lines[0])).toContain("需要任务文本");
});
