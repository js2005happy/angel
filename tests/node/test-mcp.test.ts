// tests/node/test-mcp.test.ts — MCP 原生客户端专项（第 3 阶段）。
// 假 MCP 服务器（stdio JSON-RPC）：现代版 discover、旧版 initialize 回退、
// tools/list 分页、tools/call、多轮往返报错；预置清单；成本上限停手。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFakeMcpServer as fakeServerPath } from "./fake-mcp-server.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MCPClient, MCPServerConfig, MCPToolManager, loadMcpServers,
} from "../../src/mcp.ts";
import { MCP_PRESETS, DEFAULT_MCP_PRESETS, getPreset, listPresets, resolvePreset } from "../../src/mcpPresets.ts";
import { McpCostTracker, estimateToolCost, costLimitUsd } from "../../src/mcpCost.ts";




test("McpPresetsTest.test_ten_presets_and_defaults", () => {
  expect(Object.keys(MCP_PRESETS).length).toBe(10);
  expect(listPresets().length).toBe(10);
  expect([...DEFAULT_MCP_PRESETS]).toEqual(["memory", "sequential-thinking", "fetch", "time"]);
  expect(getPreset("memory")?.command).toBe("npx");
  expect(getPreset("nope")).toBe(null);
  const [raw, reason] = resolvePreset("github", {}, {});
  expect(raw).toBe(null);
  expect(reason).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
  const [raw2] = resolvePreset("filesystem", { filesystem: ["/tmp/docs"] }, {});
  expect((raw2 as { args: string[] }).args).toContain("/tmp/docs");
  const [raw3, reason3] = resolvePreset("filesystem", {}, {});
  expect(raw3).toBe(null);
  expect(reason3).toContain("mcp_preset_args");
});

test("McpClientTest.test_modern_discover_and_paginated_tools", async () => {
  const server = fakeServerPath();
  const client = new MCPClient(new MCPServerConfig("fake", "node", [server]), 10);
  try {
    client.start();
    const tools = await client.listTools();
    expect(client.era).toBe("modern");
    expect(client.negotiatedVersion).toBe("2026-07-28");
    expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
    const out = await client.callTool("echo", { x: 1 });
    expect(out).toContain("called echo");
  } finally {
    client.stop();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("McpClientTest.test_legacy_initialize_fallback", async () => {
  const server = fakeServerPath();
  const client = new MCPClient(new MCPServerConfig("fake", "node", [server]), 10);
  const prev = process.env.FAKE_MCP_MODE;
  process.env.FAKE_MCP_MODE = "legacy";
  try {
    client.start();
    const tools = await client.listTools();
    expect(client.era).toBe("legacy");
    expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
  } finally {
    client.stop();
    await new Promise((r) => setTimeout(r, 300));
    if (prev === undefined) delete process.env.FAKE_MCP_MODE;
    else process.env.FAKE_MCP_MODE = prev;
  }
});

test("McpClientTest.test_input_required_reports_clearly", async () => {
  // 客户端请求超时是 10 秒；零字节丢失时会再重试一次（最长又 10 秒），
  // 测试超时放宽到 25 秒，让客户端自己的报错先出来，不要只剩光秃秃
  // 的测试超时。
  const server = fakeServerPath();
  const client = new MCPClient(new MCPServerConfig("fake", "node", [server]), 10);
  try {
    client.start();
    await client.listTools();
    await expect(client.callTool("need-more", {})).rejects.toThrow("多轮往返");
  } finally {
    client.stop();
    await new Promise((r) => setTimeout(r, 300));
  }
}, 25000);

test("McpManagerTest.test_start_all_routes_and_execute", async () => {
  const server = fakeServerPath();
  const manager = new MCPToolManager({
    fake: MCPServerConfig.fromDict("fake", { command: "node", args: [server] }),
  }, 10);
  try {
    await manager.startAll();
    expect(manager.hasTools()).toBe(true);
    expect(manager.toolSchemas.map((s) => s.function.name)).toEqual(["mcp_fake_echo", "mcp_fake_add"]);
    const out = await manager.execute("mcp_fake_add", { a: 1, b: 2 });
    expect(out).toContain("called add");
    expect(await manager.execute("mcp_fake_nope", {})).toContain("未知 MCP 工具");
  } finally {
    manager.stopAll();
    await new Promise((r) => setTimeout(r, 300));
  }
});

test("McpCostTest.test_estimate_limit_and_block", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-mcp-cost-"));
  const tracker = new McpCostTracker(home);
  const config = {
    mcp_cost_limit_usd: 0.05,
    mcp_tool_costs: { "fake.echo": 0.02 },
    mcp_servers: { fake: { command: "node", args: [], cost_per_call_usd: 0.03 } },
  };
  const est = estimateToolCost(config, "fake", "echo");
  expect(est.estimate_usd).toBe(0.02);
  expect(est.priced).toBe(true);
  const unpriced = estimateToolCost(config, "other", "x");
  expect(unpriced.priced).toBe(false);
  expect(unpriced.estimate_usd).toBe(0);
  expect(costLimitUsd(config)).toBe(0.05);
  expect(costLimitUsd({})).toBe(null);
  // 调用前检查：两次 0.02 可过，第三次超上限停手。
  expect(tracker.checkBeforeCall(config, "fake", "echo").blocked).toBe(null);
  tracker.record("fake", "echo", 0.02, "called");
  tracker.record("fake", "echo", 0.02, "called");
  expect(tracker.totalUsd()).toBeCloseTo(0.04, 10);
  const blocked = tracker.checkBeforeCall(config, "fake", "echo");
  expect(blocked.blocked).toContain("成本上限已到");
  expect(tracker.estimateLine(config, "fake", "echo")).toContain("预估 $0.0200");
});

test("McpServersTest.test_load_servers_presets_then_user_wins", () => {
  const servers = loadMcpServers({ mcp_presets: ["memory"], mcp_servers: { memory: { command: "node", args: ["x"] } } });
  expect(servers.memory.command).toBe("node");
  const defaults = loadMcpServers({});
  expect(Object.keys(defaults).sort()).toEqual(["fetch", "memory", "sequential-thinking", "time"]);
  const none = loadMcpServers({ mcp_presets: [] });
  expect(Object.keys(none)).toEqual([]);
});
