// tests/node/fake-mcp-server.ts — 测试用假 MCP 服务器脚本（stdio JSON-RPC）。
// FAKE_MCP_MODE=legacy 时 discover 报错，客户端回退旧版 initialize。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const FAKE_MCP_SERVER = `
let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "notifications/initialized") continue;
    if (msg.method === undefined) continue;
    const mode = process.env.FAKE_MCP_MODE || "modern";
    const reply = (result) => { const out = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n"; process.stdout.write(out); };
    const replyErr = (code, message, data) => { const out = JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message, data } }) + "\\n"; process.stdout.write(out); };
    if (msg.method === "server/discover") {
      if (mode === "legacy") { replyErr(-32601, "Method not found"); continue; }
      reply({ supportedVersions: ["2026-07-28"], _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake-modern", version: "1" } } });
      continue;
    }
    if (msg.method === "initialize") {
      reply({ protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fake-legacy", version: "1" } });
      continue;
    }
    if (msg.method === "tools/list") {
      const cursor = msg.params && msg.params.cursor;
      if (!cursor) reply({ tools: [{ name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } }], nextCursor: "page2" });
      else reply({ tools: [{ name: "add", description: "加法", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }] });
      continue;
    }
    if (msg.method === "tools/call") {
      const name = msg.params && msg.params.name;
      if (name === "need-more") { reply({ resultType: "input_required", inputRequests: { extra: "需要补充" } }); continue; }
      reply({ content: [{ type: "text", text: "called " + name + " " + JSON.stringify(msg.params.arguments || {}) }] });
      continue;
    }
    replyErr(-32601, "Method not found");
  }
});
`;

export function writeFakeMcpServer(): string {
  const dir = mkdtempSync(join(tmpdir(), "nyra-mcp-"));
  const p = join(dir, "fake-mcp.mjs");
  writeFileSync(p, FAKE_MCP_SERVER, "utf-8");
  return p;
}
