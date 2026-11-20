// tests/node/test-bot-multimodal.test.ts — Bot 方向 Phase 3：附件处理。
// 假适配器（假下载）+ 假模型执行，不联网、不用真实 token、不调真模型。
import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processAttachment, processAttachments, sniffImageKind } from "../../src/bot/attachments.ts";
import { BotRunner, type AgentRunResult } from "../../src/bot/index.ts";
import type { ChannelAdapter, InboundMessage, OutgoingMessage } from "../../src/bot/types.ts";

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 0),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 0)]);

class FakeAdapter implements ChannelAdapter {
  readonly channel = "telegram" as const;
  botUsername: string | null = "FakeBot";
  sent: { chatId: string; threadId: string | null; text: string; id: string }[] = [];
  edited: { chatId: string; messageId: string; text: string }[] = [];
  downloads: string[] = [];
  files = new Map<string, Buffer | Error>();
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

  async downloadFile(fileId: string): Promise<{ bytes: Buffer; fileName?: string; mimeType?: string }> {
    this.downloads.push(fileId);
    const v = this.files.get(fileId);
    if (v instanceof Error) throw v;
    if (!v) throw new Error("文件不存在");
    return { bytes: v };
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

function makeRunner(
  home: string,
  adapter: FakeAdapter,
  agentRun: (key: string, text: string, signal: AbortSignal) => Promise<AgentRunResult>,
  config: Record<string, unknown> = {},
) {
  const runner = new BotRunner({ home, workdir: home, config, adapter, agentRun });
  return { runner, adapter };
}

function leftoverTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("nyra-bot-attachment-"));
}

test("sniffImageKind：认四种图片 magic，非图片返回 null", () => {
  expect(sniffImageKind(PNG_BYTES)).toBe("png");
  expect(sniffImageKind(JPEG_BYTES)).toBe("jpeg");
  expect(sniffImageKind(Buffer.concat([Buffer.from("RIFFxxxxWEBP"), Buffer.alloc(10)]))).toBe("webp");
  expect(sniffImageKind(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(10)]))).toBe("gif");
  expect(sniffImageKind(Buffer.from("hello world, this is text"))).toBeNull();
});

test("文本文档：提取内容进上下文，说明里有文件名", async () => {
  const adapter = new FakeAdapter();
  adapter.files.set("f1", Buffer.from("hello world\n第二行", "utf-8"));
  const out = await processAttachment(adapter, { kind: "document", fileId: "f1", name: "notes.txt" }, { maxBytes: 1024 * 1024, textChars: 20000 });
  expect(out.kind).toBe("text");
  expect(out.extractedText).toBe("hello world\n第二行");
  expect(out.notice).toContain("notes.txt");
  expect(out.notice).toContain("已读取文档");
});

test("文本文档过长：只取前 N 字并注明", async () => {
  const adapter = new FakeAdapter();
  adapter.files.set("f1", Buffer.from("a".repeat(300), "utf-8"));
  const out = await processAttachment(adapter, { kind: "document", fileId: "f1", name: "long.txt" }, { maxBytes: 1024 * 1024, textChars: 100 });
  expect(out.kind).toBe("text");
  expect(out.extractedText?.length).toBe(100);
  expect(out.notice).toContain("只取前 100 字");
});

test("图片：只记元信息，不进模型，老实说暂不支持看图", async () => {
  const adapter = new FakeAdapter();
  adapter.files.set("p1", PNG_BYTES);
  const out = await processAttachment(
    adapter,
    { kind: "photo", fileId: "p1", width: 1280, height: 720, sizeBytes: PNG_BYTES.length },
    { maxBytes: 1024 * 1024, textChars: 20000 },
  );
  expect(out.kind).toBe("image");
  expect(out.extractedText).toBeUndefined();
  expect(out.notice).toContain("1280×720");
  expect(out.notice).toContain("暂不支持看图");
});

test("不支持的类型：pdf 不解析，回明确说明", async () => {
  const adapter = new FakeAdapter();
  adapter.files.set("d1", Buffer.from("%PDF-1.4 fake pdf bytes", "utf-8"));
  const out = await processAttachment(adapter, { kind: "document", fileId: "d1", name: "a.pdf" }, { maxBytes: 1024 * 1024, textChars: 20000 });
  expect(out.kind).toBe("unsupported");
  expect(out.notice).toContain("暂不支持解析");
  expect(out.extractedText).toBeUndefined();
});

test("超限：超过上限直接跳过，不下载内容", async () => {
  const adapter = new FakeAdapter();
  adapter.files.set("d1", Buffer.alloc(5000, 0x61));
  const out = await processAttachment(adapter, { kind: "document", fileId: "d1", name: "big.txt" }, { maxBytes: 1024, textChars: 20000 });
  expect(out.kind).toBe("unsupported");
  expect(out.notice).toContain("太大");
});

test("下载失败与渠道不支持下载：都回明确说明，不抛错", async () => {
  const adapter = new FakeAdapter();
  adapter.files.set("d1", new Error("Telegram API 调用失败：getFile（HTTP 404）"));
  const out = await processAttachment(adapter, { kind: "document", fileId: "d1", name: "x.txt" }, { maxBytes: 1024 * 1024, textChars: 20000 });
  expect(out.kind).toBe("unsupported");
  expect(out.notice).toContain("下载失败");
  const noDownload: ChannelAdapter = {
    channel: "telegram",
    botUsername: "FakeBot",
    getMe: async () => ({ id: 1, username: "FakeBot" }),
    pollOnce: async () => [],
    sendText: async () => "1",
    editText: async () => {},
  };
  const out2 = await processAttachment(noDownload, { kind: "document", fileId: "d1", name: "x.txt" }, { maxBytes: 1024 * 1024, textChars: 20000 });
  expect(out2.kind).toBe("unsupported");
  expect(out2.notice).toContain("不支持下载附件");
});

test("临时文件清理：处理前后都不留 nyra-bot-attachment-* 目录", async () => {
  const before = leftoverTempDirs();
  const adapter = new FakeAdapter();
  adapter.files.set("f1", Buffer.from("text", "utf-8"));
  adapter.files.set("p1", PNG_BYTES);
  await processAttachments(adapter, [
    { kind: "document", fileId: "f1", name: "a.txt" },
    { kind: "photo", fileId: "p1", width: 10, height: 10 },
  ], { maxBytes: 1024 * 1024, textChars: 20000 });
  const after = leftoverTempDirs();
  expect(after).toEqual(before);
});

test("processAttachments：超过 5 个只处理前 5 个并注明", async () => {
  const adapter = new FakeAdapter();
  const atts: InboundMessage["attachments"] = [];
  for (let i = 0; i < 6; i++) {
    adapter.files.set(`f${i}`, Buffer.from(`content-${i}`, "utf-8"));
    atts.push({ kind: "document", fileId: `f${i}`, name: `a${i}.txt` });
  }
  const res = await processAttachments(adapter, atts, { maxBytes: 1024 * 1024, textChars: 20000 });
  expect(res.outcomes.length).toBe(5);
  expect(res.notices[res.notices.length - 1]).toContain("只处理了前 5 个");
  expect(adapter.downloads.length).toBe(5);
});

test("Runner：纯图片消息只回元信息说明，不调模型", async () => {
  const home = tempHome("nyra-bot-mm1-");
  try {
    const adapter = new FakeAdapter();
    adapter.files.set("p1", PNG_BYTES);
    let calls = 0;
    const { runner } = makeRunner(home, adapter, async () => {
      calls++;
      return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    await runner.handleMessage(makeMsg({
      messageId: "1",
      text: "",
      attachments: [{ kind: "photo", fileId: "p1", width: 640, height: 480 }],
    }));
    expect(calls).toBe(0);
    expect(adapter.sent.length).toBe(1);
    expect(adapter.sent[0].text).toContain("暂不支持看图");
    expect(adapter.sent[0].text).toContain("640×480");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Runner：正文 + 文本文档，提取内容进模型，回复前贴已读取说明", async () => {
  const home = tempHome("nyra-bot-mm2-");
  try {
    const adapter = new FakeAdapter();
    adapter.files.set("f1", Buffer.from("文档里的关键内容", "utf-8"));
    let seenText = "";
    const { runner } = makeRunner(home, adapter, async (_key, text) => {
      seenText = text;
      return { text: "答复", promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    await runner.handleMessage(makeMsg({
      messageId: "1",
      text: "帮我总结一下",
      attachments: [{ kind: "document", fileId: "f1", name: "notes.txt" }],
    }));
    expect(seenText).toContain("帮我总结一下");
    expect(seenText).toContain("文档里的关键内容");
    expect(seenText).toContain("[附件 notes.txt 的内容]");
    expect(adapter.edited.length).toBe(1);
    expect(adapter.edited[0].text).toContain("已读取文档 notes.txt");
    expect(adapter.edited[0].text).toContain("答复");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Runner：正文 + 不支持的 pdf，模型只收到原文，回复前贴不支持说明", async () => {
  const home = tempHome("nyra-bot-mm3-");
  try {
    const adapter = new FakeAdapter();
    adapter.files.set("d1", Buffer.from("%PDF-1.4 fake", "utf-8"));
    let seenText = "";
    const { runner } = makeRunner(home, adapter, async (_key, text) => {
      seenText = text;
      return { text: "答复", promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    await runner.handleMessage(makeMsg({
      messageId: "1",
      text: "看看这个",
      attachments: [{ kind: "document", fileId: "d1", name: "a.pdf" }],
    }));
    expect(seenText).toBe("看看这个");
    expect(adapter.edited[0].text).toContain("暂不支持解析");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Runner：纯不支持文档（没正文）只回说明，不调模型", async () => {
  const home = tempHome("nyra-bot-mm4-");
  try {
    const adapter = new FakeAdapter();
    adapter.files.set("d1", Buffer.from("%PDF-1.4 fake", "utf-8"));
    let calls = 0;
    const { runner } = makeRunner(home, adapter, async () => {
      calls++;
      return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null };
    });
    await runner.handleMessage(makeMsg({
      messageId: "1",
      text: "",
      attachments: [{ kind: "document", fileId: "d1", name: "a.pdf" }],
    }));
    expect(calls).toBe(0);
    expect(adapter.sent.length).toBe(1);
    expect(adapter.sent[0].text).toContain("暂不支持解析");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Runner：用户额度用完时附件消息直接被拦，不下载", async () => {
  const home = tempHome("nyra-bot-mm5-");
  try {
    const adapter = new FakeAdapter();
    adapter.files.set("f1", Buffer.from("x", "utf-8"));
    const { runner } = makeRunner(home, adapter, async () => {
      return { text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: null };
    }, { bot: { per_user_daily_limit: 1 } });
    await runner.handleMessage(makeMsg({ messageId: "1", text: "hi" }));
    expect(adapter.downloads.length).toBe(0);
    await runner.handleMessage(makeMsg({
      messageId: "2",
      text: "",
      attachments: [{ kind: "document", fileId: "f1", name: "a.txt" }],
    }));
    expect(adapter.downloads.length).toBe(0);
    expect(adapter.sent[adapter.sent.length - 1].text).toContain("额度已用完");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
