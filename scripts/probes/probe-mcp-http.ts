// Bun API 兼容性探针 2：MCP HTTP —— 本地 HTTP 服务器 + fetch POST。
// 做法：node:http 起一个 JSON-RPC 服务，fetch 发 tools/list，校验回包。
// 影响：MCP 的 HTTP 传输（Streamable HTTP）与 provider 的 HTTP 调用共用这条路。
import { createServer } from "node:http";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const msg = JSON.parse(body || "{}");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null,
      result: { tools: [{ name: "probe_tool", description: "probe" }] } }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
});
if (!resp.ok) throw new Error("HTTP " + resp.status);
const data = await resp.json() as { result?: { tools?: { name: string }[] } };
if (data.result?.tools?.[0]?.name !== "probe_tool") throw new Error("unexpected body: " + JSON.stringify(data));
server.close();
console.log("PASS mcp-http: fetch POST tools/list 往返成功，端口 " + port);
process.exit(0);
