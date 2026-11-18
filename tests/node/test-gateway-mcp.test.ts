// tests/node/test-gateway-mcp.test.ts — gateway 的 MCP 成本显示与上限（第 3 阶段）。
// 调用前显示预估成本；超上限停手并报信；花费记账可查。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { writeFakeMcpServer } from "./fake-mcp-server.ts";

test("GatewayMcpCostTest.test_estimate_shown_before_call_and_limit_blocks", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-gmcp-"));
  const server = writeFakeMcpServer();
  const gw = new Gateway({
    home, workdir: "/tmp", host: "127.0.0.1", port: 0, mode: "full",
    config: {
      mcp_enabled: true,
      mcp_servers: { fake: { command: "node", args: [server], cost_per_call_usd: 0.02 } },
      mcp_cost_limit_usd: 0.05,
      mcp_presets: [],
      fallback_enabled: false,
    },
  });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const headers = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    // 工具列表里调用前就有预估成本。
    const toolsRes = await fetch(`${base}/api/mcp/tools`, { headers });
    expect(toolsRes.status).toBe(200);
    const tools = await toolsRes.json() as { tools: { name: string; estimate_usd: number; estimate_line: string }[] };
    expect(tools.tools.map((t) => t.name)).toEqual(["mcp_fake_echo", "mcp_fake_add"]);
    expect(tools.tools[0].estimate_usd).toBe(0.02);
    expect(tools.tools[0].estimate_line).toContain("预估 $0.0200");
    // 两次调用成功（累计 0.04），第三次超上限停手。
    const call = async () => fetch(`${base}/api/mcp/call`, {
      method: "POST", headers, body: JSON.stringify({ tool: "mcp_fake_echo", arguments: {} }),
    });
    const r1 = await call();
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as { ok: boolean; estimate_line: string; total_usd_after: number };
    expect(b1.ok).toBe(true);
    expect(b1.estimate_line).toContain("预估 $0.0200");
    expect(b1.total_usd_after).toBeCloseTo(0.02, 10);
    expect((await call()).status).toBe(200);
    const r3 = await call();
    expect(r3.status).toBe(409);
    const b3 = await r3.json() as { error: string };
    expect(b3.error).toContain("成本上限已到");
    expect(b3.error).toContain("已停手");
    // 花费记账可查。
    const spend = await fetch(`${base}/api/mcp/spend`, { headers });
    const sb = await spend.json() as { limit_usd: number; spent_usd: number };
    expect(sb.limit_usd).toBe(0.05);
    expect(sb.spent_usd).toBeCloseTo(0.04, 10);
  } finally {
    await gw.stop();
  }
});
