// tests/node/test-bot-whatsapp.test.ts — Bot 方向：WhatsApp 渠道适配器（Cloud API）。
// 全部用注入的假 fetch（Graph API）与假签名密钥，不联网、不用真实 token。
import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { WhatsAppAdapter } from "../../src/bot/channels/whatsapp.ts";

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

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf-8").digest("hex")}`;
}

test("WhatsApp：verifyWebhook 握手回显 challenge，token 不匹配拒绝", () => {
  const adapter = new WhatsAppAdapter({ token: "wa-token", phoneNumberId: "123456" });
  expect(adapter.verifyWebhook({ mode: "subscribe", token: "my-verify", challenge: "abc123" }, "my-verify")).toBe("abc123");
  expect(adapter.verifyWebhook({ mode: "subscribe", token: "wrong", challenge: "abc123" }, "my-verify")).toBeNull();
  expect(adapter.verifyWebhook({ mode: "subscribe", challenge: "abc123" }, "my-verify")).toBeNull();
});

test("WhatsApp：handleWebhook 验签后归一化文本消息", async () => {
  const secret = "app-secret";
  const adapter = new WhatsAppAdapter({ token: "wa-token", phoneNumberId: "123456", appSecret: secret });
  const body = JSON.stringify({
    entry: [{
      changes: [{
        value: {
          messaging_product: "whatsapp",
          messages: [
            { from: "5511999999999", id: "wamid-1", timestamp: "1700000000", type: "text", text: { body: "你好" } },
          ],
        },
      }],
    }],
  });
  expect(adapter.handleWebhook(body, sign(body, secret))).toBe(true);
  const msgs = await adapter.pollOnce();
  expect(msgs.length).toBe(1);
  expect(msgs[0].channel).toBe("whatsapp");
  expect(msgs[0].chatId).toBe("5511999999999");
  expect(msgs[0].chatType).toBe("private");
  expect(msgs[0].text).toBe("你好");
});

test("WhatsApp：验签失败返回 false，不消费消息", async () => {
  const adapter = new WhatsAppAdapter({ token: "wa-token", phoneNumberId: "123456", appSecret: "secret" });
  const body = JSON.stringify({ entry: [] });
  expect(adapter.handleWebhook(body, "sha256=badbadbad")).toBe(false);
  expect((await adapter.pollOnce()).length).toBe(0);
});

test("WhatsApp：群聊消息 chatType=group 且 isMentioned=false，按钮回发取标题", async () => {
  const adapter = new WhatsAppAdapter({ token: "wa-token", phoneNumberId: "123456" });
  const body = JSON.stringify({
    entry: [{
      changes: [{
        value: {
          messaging_product: "whatsapp",
          messages: [
            { from: "5511999999999-123456@g.us", id: "wamid-2", timestamp: "1700000001", type: "text", text: { body: "群里消息" } },
            { from: "5511888888888", id: "wamid-3", timestamp: "1700000002", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "批准" } } },
          ],
        },
      }],
    }],
  });
  expect(adapter.handleWebhook(body, null)).toBe(true);
  const msgs = await adapter.pollOnce();
  expect(msgs.length).toBe(2);
  expect(msgs[0].chatType).toBe("group");
  expect(msgs[0].isMentioned).toBe(false);
  expect(msgs[1].text).toBe("批准");
});

test("WhatsApp：sendText 走 messages 端点，token 只进 Authorization 头", async () => {
  const { fetchImpl, seen } = fakeFetch(() => ({ messages: [{ id: "wamid-out-1" }] }));
  const adapter = new WhatsAppAdapter({ token: "wa-secret-token", phoneNumberId: "123456", fetchImpl });

  const id = await adapter.sendText({ chatId: "5511999999999", threadId: null, text: "你好" });
  expect(id).toBe("wamid-out-1");

  const post = seen[0];
  expect(post.url).toBe("https://graph.facebook.com/v19.0/123456/messages");
  const auth = (post.init?.headers as Record<string, string>)?.Authorization;
  expect(auth).toBe("Bearer wa-secret-token");
  expect(post.url).not.toContain("wa-secret-token");
  const body = JSON.parse(String(post.init?.body)) as Record<string, unknown>;
  expect(body.to).toBe("5511999999999");
  expect(body.type).toBe("text");
});

test("WhatsApp：空 token 或空号码 id 拒绝构造", () => {
  expect(() => new WhatsAppAdapter({ token: "", phoneNumberId: "123" })).toThrow("access token 为空");
  expect(() => new WhatsAppAdapter({ token: "t", phoneNumberId: "" })).toThrow("号码 id 为空");
});

test("WhatsApp：editText 退化为补发一条回复", async () => {
  const { fetchImpl, seen } = fakeFetch(() => ({ messages: [{ id: "wamid-out-2" }] }));
  const adapter = new WhatsAppAdapter({ token: "t", phoneNumberId: "123456", fetchImpl });
  await adapter.editText("5511999999999", "wamid-old", "改过了");
  const body = JSON.parse(String(seen[0].init?.body)) as Record<string, unknown>;
  expect(body.text.body).toBe("改过了");
  expect(body.context.message_id).toBe("wamid-old");
});
