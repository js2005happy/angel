// tests/node/test-bot-runner.test.ts — Bot 方向 Phase 1：消息处理主链路。
// 假适配器 + 假模型执行，不联网、不用真实 token、不调真模型。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRunner, type AgentRunResult } from "../../src/bot/index.ts";
import { sessionKeyFor, type ChannelAdapter, type InboundMessage, type OutgoingMessage } from "../../src/bot/types.ts";

class FakeAdapter implements ChannelAdapter {
  readonly channel = "telegram" as const;
  botUsername: string | null = "FakeBot";
  sent: { chatId: string; threadId: string | null; text: string; id: string }[] = [];
  edited: { chatId: string; messageId: string; text: string }[] = [];
  private nextId = 1;

  async getMe(): Promise<{ id: number; username: string | null }> {
    return { id: 1, username: "FakeBot" };
  }

  async pollOnce(): Promise<InboundMessage[]> {
    return [];
  }

  async sendText(msg: OutgoingMessage): Promise<string> {
    const id = String(this.nextId++);
    this.sent.push({ chatId: msg.chatId, threadId: msg.threadId, text: msg.text, id });
    return id;
  }

  async editText(chatId: string, messageId: string, text: string): Promise<void> {
    this.edited.push({ chatId, messageId, text });
  }
}

function tempHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeMsg(over: Partial<InboundMessage>): InboundMessage {
  return {
    channel: "telegram",
    chatId: "7",
    threadId: null,
    senderId: "7",
    senderRole: "member",
    isMentioned: false,
    messageId: "1",
    text: "你好",
    attachments: [],
    chatType: "private",
    timestamp: Date.now(),
    ...over,
  };
}

function makeRunner(home: string, agentRun: (key: string, text: string, signal: AbortSignal) => Promise<AgentRunResult>, config: Record<string, unknown> = {}) {
  const adapter = new FakeAdapter();
  const runner = new BotRunner({ home, workdir: home, config, adapter, agentRun });
  return { runner, adapter };
}

function readAudit(home: string): Record<string, unknown>[] {
  const path = join(home, "bot-audit.jsonl");
  try {
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

test("去重：重复 messageId 只处理一次", async () => {
  const home = tempHome("nyra-bot-run-");
  try {
    let calls = 0;
    const { runner } = makeRunner(home, async () => {
      calls++;
      return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    const msg = makeMsg({ messageId: "42", text: "hi" });
    await runner.handleMessage(msg);
    await runner.handleMessage(msg);
    expect(calls).toBe(1);
    expect(readAudit(home).map((r) => r.outcome)).toContain("duplicate");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("串行：同一会话两条消息按序执行", async () => {
  const home = tempHome("nyra-bot-run2-");
  try {
    const order: string[] = [];
    const { runner } = makeRunner(home, async (_key, text, _signal) => {
      if (text === "slow") await new Promise((r) => setTimeout(r, 40));
      order.push(text);
      return { text: `回：${text}`, promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    await Promise.all([
      runner.handleMessage(makeMsg({ messageId: "1", text: "slow" })),
      runner.handleMessage(makeMsg({ messageId: "2", text: "fast" })),
    ]);
    expect(order).toEqual(["slow", "fast"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("隔离：不同 chatId 走不同 sessionKey", async () => {
  const home = tempHome("nyra-bot-run3-");
  try {
    const seenKeys: string[] = [];
    const { runner } = makeRunner(home, async (key) => {
      seenKeys.push(key);
      return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    await runner.handleMessage(makeMsg({ messageId: "1", chatId: "7", senderId: "7", text: "a" }));
    await runner.handleMessage(makeMsg({ messageId: "2", chatId: "8", senderId: "8", text: "b" }));
    expect(seenKeys).toEqual(["telegram:7", "telegram:8"]);
    expect(sessionKeyFor(makeMsg({ chatType: "private", senderId: "7" }))).not.toBe(
      sessionKeyFor(makeMsg({ chatType: "private", senderId: "8" })),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("确定性指令：/help 不调模型，直接回帮助", async () => {
  const home = tempHome("nyra-bot-run4-");
  try {
    let calls = 0;
    const { runner, adapter } = makeRunner(home, async () => {
      calls++;
      return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    await runner.handleMessage(makeMsg({ messageId: "1", text: "/help" }));
    expect(calls).toBe(0);
    expect(adapter.sent.length).toBe(1);
    expect(adapter.sent[0].text).toContain("/status");
    expect(readAudit(home)[0].outcome).toBe("command:help");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("群聊 mentionOnly：没 @ 直接忽略，@ 了才处理", async () => {
  const home = tempHome("nyra-bot-run5-");
  try {
    let calls = 0;
    const { runner, adapter } = makeRunner(home, async () => {
      calls++;
      return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    const group = { chatType: "group" as const, chatId: "-100", senderId: "8" };
    await runner.handleMessage(makeMsg({ ...group, messageId: "1", text: "没 @ 的话", isMentioned: false }));
    expect(calls).toBe(0);
    expect(adapter.sent.length).toBe(0);
    await runner.handleMessage(makeMsg({ ...group, messageId: "2", text: "@FakeBot 在吗", isMentioned: true }));
    expect(calls).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("占位与分片：先发处理中，超长回复编辑占位再续发", async () => {
  const home = tempHome("nyra-bot-run6-");
  try {
    const long = "y".repeat(5000);
    const { runner, adapter } = makeRunner(home, async () => {
      return { text: long, promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    await runner.handleMessage(makeMsg({ messageId: "1", text: "说点长的" }));
    expect(adapter.sent[0].text).toBe("处理中…");
    expect(adapter.edited.length).toBe(1);
    expect(adapter.edited[0].messageId).toBe(adapter.sent[0].id);
    expect(adapter.edited[0].text.length).toBeLessThanOrEqual(4000);
    expect(adapter.sent.length).toBe(2);
    expect(adapter.edited[0].text + adapter.sent[1].text).toBe(long);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("配额：单用户当天超限回提示，不调模型", async () => {
  const home = tempHome("nyra-bot-run7-");
  try {
    let calls = 0;
    const { runner, adapter } = makeRunner(
      home,
      async () => {
        calls++;
        return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null };
      },
      { bot: { per_user_daily_limit: 1 } },
    );
    await runner.handleMessage(makeMsg({ messageId: "1", text: "第一条" }));
    expect(calls).toBe(1);
    await runner.handleMessage(makeMsg({ messageId: "2", text: "第二条" }));
    expect(calls).toBe(1);
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("额度已用完");
    expect(readAudit(home).map((r) => r.outcome)).toContain("blocked:quota-user");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/new 清除会话：之后的消息走同一 key 但可重新开始", async () => {
  const home = tempHome("nyra-bot-run8-");
  try {
    const { runner, adapter } = makeRunner(home, async () => {
      return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    await runner.handleMessage(makeMsg({ messageId: "1", text: "/new" }));
    expect(adapter.sent[0].text).toContain("新会话");
    await runner.handleMessage(makeMsg({ messageId: "2", text: "继续聊" }));
    expect(adapter.sent.some((s) => s.text === "处理中…")).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/stop：没有在跑的任务时老实说", async () => {
  const home = tempHome("nyra-bot-run9-");
  try {
    const { runner, adapter } = makeRunner(home, async () => {
      return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    await runner.handleMessage(makeMsg({ messageId: "1", text: "/stop" }));
    expect(adapter.sent[0].text).toContain("没有正在处理");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("纯附件消息（渠道不支持下载）：回一句说明，不调模型", async () => {
  const home = tempHome("nyra-bot-run10-");
  try {
    let calls = 0;
    const { runner, adapter } = makeRunner(home, async () => {
      calls++;
      return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    await runner.handleMessage(makeMsg({
      messageId: "1", text: "",
      attachments: [{ kind: "photo", fileId: "abc" }],
    }));
    expect(calls).toBe(0);
    // Phase 3：附件走下载流程；这个假适配器没有 downloadFile，所以回
    // “不支持下载附件”的说明（旧文案“暂不支持解析图片/文件内容”已作废）。
    expect(adapter.sent[0].text).toContain("不支持下载附件");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("模型报错时占位改成失败文案，不抛错", async () => {
  const home = tempHome("nyra-bot-run11-");
  try {
    const { runner, adapter } = makeRunner(home, async () => {
      throw new Error("模型挂了");
    });
    await runner.handleMessage(makeMsg({ messageId: "1", text: "hi" }));
    expect(adapter.edited[0].text).toContain("处理失败");
    expect(adapter.edited[0].text).toContain("模型挂了");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
