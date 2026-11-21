// tests/node/test-bot-slack.test.ts — Bot 方向：Slack 渠道适配器。
// 全部用注入的假 fetch（Web API + apps.connections.open）与假 WebSocket（Socket Mode），不联网、不用真实 token。
import { test, expect } from "bun:test";
import { SlackAdapter, type SlackWebSocketLike, type SlackWebSocketFactory } from "../../src/bot/channels/slack.ts";

/** 一个可控的假 WebSocket：记录 send 的帧，可手动触发 onmessage/onclose。 */
function fakeWebSocket() {
  const ws: SlackWebSocketLike & { sent: string[] } = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    sent: [],
    send(data: string) { this.sent.push(data); },
    close() { this.onclose?.({ code: 1000 }); },
  };
  return ws;
}

/** 假 fetch：按 URL 与方法分流，返回 Slack 信封（ok:true 包装）。 */
function fakeFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    seen.push({ url: u, init });
    const result = handler(u, init);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result ?? {}), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function envelope(id: string, type: string, payload?: unknown): string {
  return JSON.stringify({ envelope_id: id, type, payload });
}

test("Slack：apps.connections.open 拿 URL、app_mention 归一化、envelope ack", async () => {
  const ws = fakeWebSocket();
  const factory: SlackWebSocketFactory = () => ws;
  const { fetchImpl, seen } = fakeFetch((url) => {
    if (url.endsWith("/apps.connections.open")) return { ok: true, url: "wss://example.com/socket-mode/abc" };
    if (url.endsWith("/auth.test")) return { ok: true, user_id: "U123", user: "nyrabot" };
    return { ok: true };
  });
  const adapter = new SlackAdapter({ appToken: "xapp-secret", botToken: "xoxb-secret", fetchImpl, webSocketFactory: factory, autoReconnect: false });

  await adapter.pollOnce(); // 触发懒连接
  // 连接 URL 来自 apps.connections.open，app token 只进 Authorization 头
  const open = seen.find((c) => c.url.endsWith("/apps.connections.open"))!;
  const auth = (open.init?.headers as Record<string, string>)?.Authorization;
  expect(auth).toBe("Bearer xapp-secret");
  expect(open.url).not.toContain("xapp-secret");
  expect(ws.sent.length).toBe(0); // 建连后无需 IDENTIFY

  // app_mention：群里 @ 了 bot
  ws.onmessage?.({ data: envelope("e1", "events_api", { type: "app_mention", user: "U1", channel: "C1", ts: "1700000000.000100", text: "<@U123> 你好" }) });
  // 私聊 message.im（channel 以 D 开头）
  ws.onmessage?.({ data: envelope("e2", "events_api", { type: "message", channel: "D1", user: "U2", ts: "1700000000.000200", text: "私聊" }) });
  // 机器人自己发的（bot_id 或 user 是 bot 自己）
  ws.onmessage?.({ data: envelope("e3", "events_api", { type: "message", channel: "D1", user: "U123", bot_id: "B1", ts: "1700000000.000300", text: "自己发的" }) });

  // 每个信封都 ack 了（envelope_id 回给服务器）
  expect(ws.sent.length).toBe(3);
  expect(JSON.parse(ws.sent[0]).envelope_id).toBe("e1");
  expect(JSON.parse(ws.sent[1]).envelope_id).toBe("e2");
  expect(JSON.parse(ws.sent[2]).envelope_id).toBe("e3");

  const msgs = await adapter.pollOnce();
  expect(msgs.length).toBe(2);
  expect(msgs[0].channel).toBe("slack");
  expect(msgs[0].chatId).toBe("C1");
  expect(msgs[0].chatType).toBe("group");
  expect(msgs[0].isMentioned).toBe(true);
  expect(msgs[0].text).toBe("<@U123> 你好");
  expect(msgs[1].chatId).toBe("D1");
  expect(msgs[1].chatType).toBe("private");
  expect(msgs[1].isMentioned).toBe(true);
  adapter.close();
});

test("Slack：发消息与编辑消息走 Web API，bot token 只进 Authorization 头", async () => {
  const ws = fakeWebSocket();
  const factory: SlackWebSocketFactory = () => ws;
  const { fetchImpl, seen } = fakeFetch((url, init) => {
    if (url.endsWith("/apps.connections.open")) return { ok: true, url: "wss://example.com/socket-mode/abc" };
    if (url.endsWith("/chat.postMessage")) return { ok: true, ts: "1700000000.000500" };
    if (url.endsWith("/chat.update")) return { ok: true };
    return { ok: true };
  });
  const adapter = new SlackAdapter({ appToken: "xapp-secret", botToken: "xoxb-bot-secret", fetchImpl, webSocketFactory: factory, autoReconnect: false });

  const sentTs = await adapter.sendText({ chatId: "C1", threadId: null, text: "你好" });
  expect(sentTs).toBe("1700000000.000500");
  await adapter.editText("C1", "1700000000.000500", "改过了");

  const post = seen.find((c) => c.url.endsWith("/chat.postMessage"))!;
  const auth = (post.init?.headers as Record<string, string>)?.Authorization;
  expect(auth).toBe("Bearer xoxb-bot-secret");
  expect(post.url).not.toContain("xoxb-bot-secret");
  adapter.close();
});

test("Slack：token 不进报错文案", async () => {
  const ws = fakeWebSocket();
  const factory: SlackWebSocketFactory = () => ws;
  const { fetchImpl } = fakeFetch((url) => {
    if (url.endsWith("/apps.connections.open")) return { ok: true, url: "wss://example.com/socket-mode/abc" };
    return { ok: false, error: "invalid_auth" };
  });
  const adapter = new SlackAdapter({ appToken: "xapp-secret", botToken: "xoxb-secret", fetchImpl, webSocketFactory: factory, autoReconnect: false });
  // 发消息返回 invalid_auth：错误文案只有错误码，不含 token
  await expect(adapter.sendText({ chatId: "C1", threadId: null, text: "hi" })).rejects.toThrow("invalid_auth");
  adapter.close();
});

test("Slack：空 token 拒绝构造", () => {
  expect(() => new SlackAdapter({ appToken: "", botToken: "xoxb-x" })).toThrow("app token 为空");
  expect(() => new SlackAdapter({ appToken: "xapp-x", botToken: "" })).toThrow("bot token 为空");
});

test("Slack：disconnect 事件触发重连拿新 URL", async () => {
  let socketCount = 0;
  const sockets: ReturnType<typeof fakeWebSocket>[] = [];
  const factory: SlackWebSocketFactory = () => {
    socketCount++;
    const ws = fakeWebSocket();
    sockets.push(ws);
    return ws;
  };
  const { fetchImpl } = fakeFetch((url) => {
    if (url.endsWith("/apps.connections.open")) return { ok: true, url: `wss://example.com/socket-mode/${socketCount}` };
    return { ok: true };
  });
  const adapter = new SlackAdapter({ appToken: "xapp-x", botToken: "xoxb-x", fetchImpl, webSocketFactory: factory });

  await adapter.pollOnce(); // 第一次连接
  expect(socketCount).toBe(1);

  // 服务器发 disconnect（refresh_requested）：拆掉重连拿新 URL
  sockets[0].onmessage?.({ data: envelope("e9", "disconnect", { reason: "refresh_requested" }) });
  // 重连延迟是 SLACK_RECONNECT_DELAY_MS（1000ms），等它触发后建新连接。
  await new Promise((r) => setTimeout(r, 1200));
  expect(socketCount).toBeGreaterThanOrEqual(2);
  adapter.close();
});
