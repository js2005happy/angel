// Bun API 兼容性探针 1：MCP stdio —— 子进程 JSON-RPC 往返。
// 做法：spawn 一个会回显 JSON-RPC 的子进程（node -e 内联脚本），
// 发 initialize 请求，读回 result；再发一个 notifications/initialized。
// 影响：MCP 客户端（nyra/mcp.py，stdio JSON-RPC）第 2 阶段移植的前提。
import { spawn } from "node:child_process";

const childScript = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id,
      result: { protocolVersion: "2026-07-28", capabilities: {}, serverInfo: { name: "probe", version: "0" } } }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  }
});
`;

const child = spawn(process.execPath, ["-e", childScript], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const got = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout 5s")), 5000);
  child.stdout.on("data", (d) => {
    buf += d.toString();
    if (buf.includes("\n")) { clearTimeout(timer); resolve(buf.trim()); }
  });
  child.on("error", reject);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "nyra-probe", version: "0" } } }) + "\n");
});
const parsed = JSON.parse(got as string);
if (parsed.result?.protocolVersion !== "2026-07-28") throw new Error("unexpected reply: " + got);
child.kill();
console.log("PASS mcp-stdio: initialize 往返成功 protocolVersion=" + parsed.result.protocolVersion);
process.exit(0);
