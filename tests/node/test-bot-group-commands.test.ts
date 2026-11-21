// tests/node/test-bot-group-commands.test.ts
//
// 缺口 42 第三批（群聊 @ 门对齐）测试：
//   - mentionOnly 检查移到确定性指令之前：群聊里指令没 @ 直接忽略；
//   - 之前是漏的：/new、/stop 没做角色限制，群里任何人不用 @ 就能清会话、
//     停任务（文档一直写着指令同样要过这道门，这次以文档为准对齐代码）；
//   - 审批按钮回调不受影响（Telegram 回调统一置 isMentioned，见
//     src/bot/channels/telegram.ts 的 toCallback）；私聊不受影响。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { BotRunner, type AgentRunResult } from "../../src/bot/index.ts";
import { memorySessionIdFor, sessionKeyFor, type ChannelAdapter, type InboundMessage, type OutgoingMessage } from "../../src/bot/types.ts";
import { sessionPath } from "../../src/memory.ts";

class FakeAdapter implements ChannelAdapter {
  readonly channel = "telegram" as const;
  botUsername: string | null = "FakeBot";
  readonly sent: { chatId: string; threadId: string | null; text: string; id: string }[] = [];
  readonly edited: { chatId: string; messageId: string; text: string }[] = [];
  readonly answered: { callbackId: string; text: string }[] = [];
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

  async deleteMessage(_chatId: string, _messageId: string): Promise<void> {}

  async answerCallback(callbackId: string, text: string): Promise<void> {
    this.answered.push({ callbackId, text });
  }
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-bot-group-commands-"));
}

function groupMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: "telegram",
    chatId: "100",
    threadId: null,
    senderId: "3",
    senderRole: "member",
    isMentioned: false,
    messageId: "msg1",
    text: "/help",
    attachments: [],
    chatType: "group",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeRunner(home: string): { runner: BotRunner; adapter: FakeAdapter } {
  const adapter = new FakeAdapter();
  const runner = new BotRunner({
    home,
    workdir: home,
    config: { bot: { owner: "1", admins: ["2"] } },
    adapter,
    agentRun: async (): Promise<AgentRunResult> => ({ text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: 0.001 }),
  });
  return { runner, adapter };
}

function readAudit(home: string): Record<string, unknown>[] {
  try {
    return readFileSync(join(home, "bot-audit.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** 在 home 里给群聊会话种一个会话文件（/new 会删它）。 */
function seedSessionFile(home: string): string {
  const msg = groupMsg();
  const path = sessionPath(memorySessionIdFor(sessionKeyFor(msg)), home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ messages: [{ role: "user", content: "之前的内容" }] }), "utf-8");
  return path;
}

describe("群聊 @ 门对指令同样适用（缺口 42 第三批）", () => {
  test("群聊 /new 没 @：被忽略，会话文件还在，不回消息", async () => {
    const home = tmpHome();
    try {
      const { runner, adapter } = makeRunner(home);
      const path = seedSessionFile(home);
      await runner.handleMessage(groupMsg({ messageId: "m1", text: "/new" }));
      expect(adapter.sent).toEqual([]);
      expect(readAudit(home).map((r) => r.outcome)).toContain("ignored:not-mentioned");
      expect(readAudit(home).map((r) => r.outcome)).not.toContain("command:new");
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("群聊 /help 没 @：被忽略，不回消息", async () => {
    const home = tmpHome();
    try {
      const { runner, adapter } = makeRunner(home);
      await runner.handleMessage(groupMsg({ messageId: "m2", text: "/help" }));
      expect(adapter.sent).toEqual([]);
      expect(readAudit(home).map((r) => r.outcome)).toContain("ignored:not-mentioned");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("群聊 @ 了 /help：正常回帮助", async () => {
    const home = tmpHome();
    try {
      const { runner, adapter } = makeRunner(home);
      await runner.handleMessage(groupMsg({ messageId: "m3", text: "/help", isMentioned: true }));
      expect(adapter.sent.map((m) => m.text).join("\n")).toContain("/help — 本帮助");
      expect(readAudit(home).map((r) => r.outcome)).toContain("command:help");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("群聊 @ 了 /new：清会话并回确认", async () => {
    const home = tmpHome();
    try {
      const { runner, adapter } = makeRunner(home);
      const path = seedSessionFile(home);
      await runner.handleMessage(groupMsg({ messageId: "m4", text: "/new", isMentioned: true }));
      expect(existsSync(path)).toBe(false);
      expect(adapter.sent.map((m) => m.text).join("\n")).toContain("已开启新会话");
      expect(readAudit(home).map((r) => r.outcome)).toContain("command:new");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("私聊 /help 没 @：不受影响，正常回", async () => {
    const home = tmpHome();
    try {
      const { runner, adapter } = makeRunner(home);
      await runner.handleMessage(groupMsg({ messageId: "m5", text: "/help", chatType: "private", chatId: "3" }));
      expect(adapter.sent.map((m) => m.text).join("\n")).toContain("/help — 本帮助");
      expect(readAudit(home).map((r) => r.outcome)).toContain("command:help");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("群聊审批按钮回调：isMentioned 为真，仍能批", async () => {
    const home = tmpHome();
    try {
      const { runner, adapter } = makeRunner(home);
      const item = await runner.bridge.requestApproval({
        sessionKey: "telegram:100", chatId: "100", threadId: null, tool: "write_file",
        summary: "写文件 a.txt", argsHash: "abcdef123456", requestedBy: "1", requestedByRole: "owner",
      });
      await runner.handleMessage(groupMsg({
        messageId: "m6", senderId: "2", text: `/approve ${item.id}`,
        isMentioned: true, viaCallback: true, callbackId: "cb-1",
      }));
      expect(runner.bridge.pending(item.id)?.status).toBe("approved");
      expect(adapter.answered).toEqual([{ callbackId: "cb-1", text: "已批准" }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
