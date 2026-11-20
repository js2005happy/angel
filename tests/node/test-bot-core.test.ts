// tests/node/test-bot-core.test.ts — Bot 方向 Phase 1：核心骨架。
// 覆盖 sessionKey 与会话隔离 id、策略默认值、会话队列串行与取消、
// 去重（落盘/TTL/上限）、配额三档、分片与围栏、确定性指令解析。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  botPolicyFromConfig,
  memorySessionIdFor,
  sessionKeyFor,
  type InboundMessage,
} from "../../src/bot/types.ts";
import { SessionQueue } from "../../src/bot/sessionQueue.ts";
import { DedupStore, QuotaStore } from "../../src/bot/dedupAndQuota.ts";
import { escapeMarkdownV2, splitMessage } from "../../src/bot/formatter.ts";
import { parseBotCommand } from "../../src/bot/index.ts";

function tempHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeMsg(over: Partial<InboundMessage>): InboundMessage {
  return {
    channel: "telegram",
    chatId: "100",
    threadId: null,
    senderId: "7",
    senderRole: "member",
    isMentioned: false,
    messageId: "1",
    text: "hi",
    attachments: [],
    chatType: "private",
    timestamp: Date.now(),
    ...over,
  };
}

test("sessionKey：私聊按发信人，群聊按群与话题", () => {
  expect(sessionKeyFor(makeMsg({ chatType: "private", senderId: "42" }))).toBe("telegram:42");
  expect(sessionKeyFor(makeMsg({ chatType: "group", chatId: "-100", threadId: null }))).toBe("telegram:-100:0");
  expect(sessionKeyFor(makeMsg({ chatType: "group", chatId: "-100", threadId: "5" }))).toBe("telegram:-100:5");
  expect(sessionKeyFor(makeMsg({ chatType: "supergroup", chatId: "-200", threadId: "9" }))).toBe("telegram:-200:9");
});

test("memorySessionId：不含冒号，不同 sessionKey 不撞", () => {
  const a = memorySessionIdFor("telegram:42");
  const b = memorySessionIdFor("telegram:-100:0");
  const c = memorySessionIdFor("telegram:-100:5");
  expect(a).toBe("bot-telegram-42");
  expect(b).toBe("bot-telegram--100-0");
  expect(c).toBe("bot-telegram--100-5");
  expect(new Set([a, b, c]).size).toBe(3);
  for (const id of [a, b, c]) {
    expect(id).not.toContain(":");
    expect(id).not.toContain("/");
  }
});

test("策略默认值：mentionOnly 开、12 轮、120 秒超时、配额 100/10", () => {
  const p = botPolicyFromConfig({});
  expect(p.mentionOnly).toBe(true);
  expect(p.maxTurns).toBe(12);
  expect(p.timeoutMs).toBe(120000);
  expect(p.perUserDailyLimit).toBe(100);
  expect(p.perChatPerMinuteLimit).toBe(10);
  expect(p.dailyTokenBudgetUsd).toBeNull();
  expect(p.telegram.enabled).toBe(false);
});

test("策略解析：非法值回默认值，合法值生效", () => {
  const p = botPolicyFromConfig({
    bot: {
      mention_only: false, max_turns: 0, timeout_ms: -5,
      per_user_daily_limit: 3, daily_token_budget_usd: 0.5,
      admins: ["11", 22, "33"], telegram: { enabled: true, username: "@MyBot" },
    },
  });
  expect(p.mentionOnly).toBe(false);
  expect(p.maxTurns).toBe(12);
  expect(p.timeoutMs).toBe(120000);
  expect(p.perUserDailyLimit).toBe(3);
  expect(p.dailyTokenBudgetUsd).toBe(0.5);
  expect(p.admins).toEqual(["11", "33"]);
  expect(p.telegram.enabled).toBe(true);
  expect(p.telegram.username).toBe("MyBot");
});

test("队列：同一会话串行执行，不同会话互不阻塞", async () => {
  const q = new SessionQueue();
  const order: string[] = [];
  const slow = async () => { await new Promise((r) => setTimeout(r, 30)); order.push("slow"); };
  const fast = async () => { order.push("fast"); };
  const p1 = q.enqueue("telegram:1", slow);
  const p2 = q.enqueue("telegram:1", fast);
  const p3 = q.enqueue("telegram:2", fast);
  expect(q.depth("telegram:1")).toBe(2);
  expect(q.totalDepth()).toBe(3);
  await Promise.all([p1, p2, p3]);
  expect(order).toEqual(["fast", "slow", "fast"]);
  expect(q.totalDepth()).toBe(0);
});

test("队列：取消排队任务直接出队，取消原因分得清", async () => {
  const q = new SessionQueue();
  let started = false;
  const blocker = q.enqueue("telegram:1", async () => {
    started = true;
    await new Promise((r) => setTimeout(r, 50));
  });
  const queued = q.enqueue("telegram:1", async () => {});
  expect(started).toBe(true);
  const { cancelledActive, cancelledQueued } = q.cancel("telegram:1");
  expect(cancelledActive).toBe(true);
  expect(cancelledQueued).toBe(1);
  expect(await queued).toBe("cancelled");
  expect(q.abortReason("telegram:1")).toBe("stop");
  await blocker;
  expect(q.totalDepth()).toBe(0);
});

test("队列：超时自动 abort，原因是 timeout", async () => {
  const q = new SessionQueue();
  let sawAbort = false;
  const p = q.enqueue("telegram:1", async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { sawAbort = true; resolve(); }, { once: true });
    });
  }, { timeoutMs: 20 });
  expect(await p).toBe("cancelled");
  expect(sawAbort).toBe(true);
});

test("去重：同一 key 只认一次，重启后仍有效", () => {
  const home = tempHome("nyra-bot-dedup-");
  try {
    const a = new DedupStore(home);
    expect(a.checkAndMark("telegram:10")).toBe(false);
    expect(a.checkAndMark("telegram:10")).toBe(true);
    expect(a.checkAndMark("telegram:11")).toBe(false);
    const b = new DedupStore(home);
    expect(b.has("telegram:10")).toBe(true);
    expect(b.checkAndMark("telegram:10")).toBe(true);
    expect(b.size()).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("去重：过期记录不算重复，超上限丢最旧", () => {
  const home = tempHome("nyra-bot-dedup2-");
  try {
    const a = new DedupStore(home, { ttlMs: 10, maxEntries: 2 });
    expect(a.checkAndMark("telegram:1")).toBe(false);
    expect(a.checkAndMark("telegram:2")).toBe(false);
    expect(a.checkAndMark("telegram:3")).toBe(false);
    expect(a.size()).toBe(2);
    expect(a.has("telegram:1")).toBe(false);
    // 等 TTL 过期
    const start = Date.now();
    while (Date.now() - start < 15) { /* 忙等 15ms */ }
    expect(a.checkAndMark("telegram:2")).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("配额：单用户每天、单群聊每分钟、当天预算三档", () => {
  const home = tempHome("nyra-bot-quota-");
  try {
    const q = new QuotaStore(home);
    expect(q.userAllowed("telegram:7", 2)).toBe(true);
    q.recordUser("telegram:7");
    q.recordUser("telegram:7");
    expect(q.userAllowed("telegram:7", 2)).toBe(false);
    expect(q.userAllowed("telegram:8", 2)).toBe(true);
    expect(q.chatMinuteAllowed("telegram:-100:0", 1)).toBe(true);
    expect(q.chatMinuteAllowed("telegram:-100:0", 1)).toBe(false);
    expect(q.budgetAllowed(1)).toBe(true);
    q.recordSpent(0.6);
    expect(q.dailySpentUsd()).toBeCloseTo(0.6);
    expect(q.budgetAllowed(1)).toBe(true);
    q.recordSpent(0.5);
    expect(q.budgetAllowed(1)).toBe(false);
    expect(q.budgetAllowed(null)).toBe(true);
    q.recordSpent(null);
    expect(q.dailySpentUsd()).toBeCloseTo(1.1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("配额：换天自动归零", () => {
  const home = tempHome("nyra-bot-quota2-");
  try {
    const q = new QuotaStore(home);
    q.recordUser("telegram:7");
    q.recordSpent(2);
    // 把账本日期改成昨天，再读就该归零
    const path = join(home, "bot-quota.json");
    const state = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const yesterday = new Date(Date.now() - 86400000);
    const pad = (n: number) => String(n).padStart(2, "0");
    state.date = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
    writeFileSync(path, JSON.stringify(state));
    const q2 = new QuotaStore(home);
    expect(q2.userCount("telegram:7")).toBe(0);
    expect(q2.dailySpentUsd()).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("分片：短文本一片，超长按段落边界切", () => {
  const short = "hello";
  expect(splitMessage(short)).toEqual(["hello"]);
  expect(splitMessage("")).toEqual([]);
  const para1 = "a".repeat(1500);
  const para2 = "b".repeat(1500);
  const para3 = "c".repeat(1500);
  const text = [para1, para2, para3].join("\n\n");
  const chunks = splitMessage(text, 2000);
  expect(chunks.length).toBe(3);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  expect(chunks.join("")).toBe(text);
});

test("分片：代码围栏切开时自动补收尾与重开", () => {
  const head = "说明文字\n```ts\n";
  const code = "x".repeat(3000);
  const tail = "\n```\n收尾";
  const chunks = splitMessage(head + code + tail, 1000);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) {
    const marks = c.split("```").length - 1;
    expect(marks % 2).toBe(0);
  }
  expect(chunks[0]).toContain("```");
  expect(chunks[chunks.length - 1]).toContain("收尾");
});

test("分片：无断点时硬切，不丢字符", () => {
  const text = "z".repeat(2500);
  const chunks = splitMessage(text, 1000);
  expect(chunks.join("")).toBe(text);
  expect(chunks.length).toBe(3);
});

test("MarkdownV2 转义：特殊字符全转义", () => {
  expect(escapeMarkdownV2("a*b_c[d]")).toBe("a\\*b\\_c\\[d\\]");
});

test("指令解析：行首指令认，带 @Bot 名也认，正文里的斜杠不算", () => {
  expect(parseBotCommand("/help")).toEqual({ command: "help", args: "" });
  expect(parseBotCommand("/help@MyBot")).toEqual({ command: "help", args: "" });
  expect(parseBotCommand("/approve 123")).toEqual({ command: "approve", args: "123" });
  expect(parseBotCommand("/STOP")).toEqual({ command: "stop", args: "" });
  expect(parseBotCommand("你好 /help")).toBeNull();
  expect(parseBotCommand("/")).toBeNull();
  expect(parseBotCommand("")).toBeNull();
});
