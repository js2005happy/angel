// Bun API 兼容性探针 4：WebSocket —— 内置全局 WebSocket 客户端 + 服务端往返。
// 做法：Bun.serve 起 ws 服务（upgrade + message 回显），全局 WebSocket 客户端连上收发。
// 影响：cdp_browser.py / websocket.py（CDP 只连本机 Chrome 9222）的第 2 阶段移植。
// 注意：Bun.serve 是 Bun 专属 API；若改走 Node SEA 需换成 `ws` 包或 node:http +
// 手写升级——探针结论里写明这一处不可直接移植。
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    if (srv.upgrade(req)) return undefined;
    return new Response("not a websocket", { status: 400 });
  },
  websocket: {
    message(ws, msg) { ws.send("echo:" + msg); },
  },
});
const port = server.port;
const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
const reply = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout 5s")), 5000);
  ws.onmessage = (ev) => { clearTimeout(timer); resolve(String(ev.data)); };
  ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  ws.onopen = () => ws.send("ping-nyra");
});
if (reply !== "echo:ping-nyra") throw new Error("unexpected reply: " + reply);
ws.close();
server.stop();
console.log("PASS websocket: 全局 WebSocket 客户端 + Bun.serve 服务端往返成功（" + reply + "）");
process.exit(0);
