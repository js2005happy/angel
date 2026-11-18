// tests/node/test-gateway-compact.test.ts — 网关压缩分层专项（第 3 阶段，方案 2.6 第 7 条）。
// 网关阈值 85%：用量比 ≥85% 时先剪旧工具结果（不调 LLM）；低于阈值不触发。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import { Gateway, type SessionRun } from "../../src/gateway.ts";
import { echoProvider } from "./fake-provider.ts";

function makeRun(home: string, promptTokens: number): SessionRun {
  const gw = new Gateway({ home, workdir: "/tmp", host: "127.0.0.1", port: 0, config: {} });
  const agent = new Agent(echoProvider("ok"), {
    workdir: "/tmp", mode: "full", sessionId: "s-compact", home,
    contextWindowTokens: 10000,
  });
  agent.usage.record({ usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } });
  agent.messages = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", content: "旧工具结果：一大段文件内容……", tool_call_id: "c1" },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", content: "最新工具结果", tool_call_id: "c2" },
  ];
  const run: SessionRun = {
    sessionId: "s-compact", agent, events: [], status: "done", error: "", pending: null, baseMessages: [],
  };
  return run;
}

test("GatewayCompactTest.test_below_threshold_no_trigger", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-gc-"));
  const gw = new Gateway({ home, workdir: "/tmp", host: "127.0.0.1", port: 0, config: {} });
  const run = makeRun(home, 4000); // 40% < 85%
  const result = gw.gatewayCompactCheck(run);
  expect(result.triggered).toBe(false);
  expect(result.ratio).toBeCloseTo(0.4, 10);
  expect((run.agent!.messages[2] as { content: string }).content).toContain("旧工具结果");
});

test("GatewayCompactTest.test_at_85_trims_old_tool_results_without_llm", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-gc-"));
  const gw = new Gateway({ home, workdir: "/tmp", host: "127.0.0.1", port: 0, config: {} });
  const run = makeRun(home, 8500); // 85%
  const before = run.agent!.messages.length;
  const result = gw.gatewayCompactCheck(run);
  expect(result.triggered).toBe(true);
  expect(result.ratio).toBeCloseTo(0.85, 10);
  expect(result.before).toBe(before);
  // 旧工具结果被折叠，最新一轮的不动；全程没调模型（fake provider 调用数为 0）。
  expect((run.agent!.messages[2] as { content: string }).content).toBe("（已压缩：旧工具结果已折叠）");
  expect((run.agent!.messages[5] as { content: string }).content).toBe("最新工具结果");
  expect(run.events.some((e) => e.type === "gateway_compact")).toBe(true);
});

test("GatewayCompactTest.test_agent_threshold_is_50", async () => {
  const { AGENT_COMPACT_THRESHOLD, GATEWAY_COMPACT_THRESHOLD } = await import("../../src/compact.ts");
  expect(AGENT_COMPACT_THRESHOLD).toBe(0.5);
  expect(GATEWAY_COMPACT_THRESHOLD).toBe(0.85);
});
