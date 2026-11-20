// tests/node/test-bot-approval.test.ts — Bot 方向 Phase 2：聊天内审批闭环。
// 假发送/假编辑 + 真 Agent + 假 provider（FakeProvider），不联网、不调真模型。
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import { ApprovalBridge, approvalArgsHash, type PendingApproval } from "../../src/bot/approvalBridge.ts";
import { botPolicyFromConfig } from "../../src/bot/types.ts";
import { isToolAllowed, profileForRole } from "../../src/bot/router.ts";
import { checkApproval, newToolContext } from "../../src/tools.ts";

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  script: Record<string, unknown>[];
  idx = 0;
  calls: Record<string, unknown>[][] = [];
  constructor(script: Record<string, unknown>[]) { this.script = script; }
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(messages: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    this.calls.push(messages);
    const next = this.script[Math.min(this.idx, this.script.length - 1)];
    this.idx += 1;
    return next;
  }
}

function textReply(text: string): Record<string, unknown> {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}
function toolReply(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

function tempHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface SentMsg { chatId: string; threadId: string | null; text: string; buttons?: { text: string; callbackData: string }[][]; id: string }
interface FakeSender {
  sent: SentMsg[];
  edited: { chatId: string; messageId: string; text: string }[];
  send: (chatId: string, threadId: string | null, text: string, buttons?: { text: string; callbackData: string }[][]) => Promise<string>;
  edit: (chatId: string, messageId: string, text: string) => Promise<void>;
}

function makeSender(): FakeSender {
  const sent: SentMsg[] = [];
  const edited: { chatId: string; messageId: string; text: string }[] = [];
  let nextId = 1;
  return {
    sent,
    edited,
    send: async (chatId, threadId, text, buttons) => {
      const id = String(nextId++);
      sent.push({ chatId, threadId, text, buttons, id });
      return id;
    },
    edit: async (chatId, messageId, text) => {
      edited.push({ chatId, messageId, text });
    },
  };
}

function makeBridge(home: string, sender: FakeSender, opts: { owner?: string; admins?: string[]; ttlMs?: number } = {}) {
  const policy = botPolicyFromConfig({ bot: { owner: opts.owner ?? "1", admins: opts.admins ?? ["2"], approval_timeout_ms: 60000 } });
  const audit: { outcome: string; extra: Record<string, unknown> }[] = [];
  const bridge = new ApprovalBridge({
    home,
    policy,
    ttlMs: opts.ttlMs,
    send: sender.send,
    edit: sender.edit,
    audit: (outcome, extra) => { audit.push({ outcome, extra }); },
  });
  return { bridge, policy, audit };
}

async function requestOne(bridge: ApprovalBridge, over: Partial<Parameters<ApprovalBridge["requestApproval"]>[0]> = {}): Promise<PendingApproval> {
  return bridge.requestApproval({
    sessionKey: "telegram:7",
    chatId: "7",
    threadId: null,
    tool: "write_file",
    summary: "写文件 a.txt",
    argsHash: approvalArgsHash({ tool: "write_file", fileTarget: "a.txt" }),
    requestedBy: "1",
    requestedByRole: "owner",
    ...over,
  });
}

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("发起审批：提示带 id、工具、说明与批准/拒绝按钮；重复请求复用同一条", async () => {
  const home = tempHome("nyra-bot-appr-");
  try {
    const sender = makeSender();
    const { bridge } = makeBridge(home, sender);
    const first = await requestOne(bridge);
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].text).toContain(first.id);
    expect(sender.sent[0].text).toContain("write_file");
    expect(sender.sent[0].buttons?.[0]?.map((b) => b.callbackData)).toEqual([`bot:approve:${first.id}`, `bot:reject:${first.id}`]);
    const second = await requestOne(bridge);
    expect(second.id).toBe(first.id);
    expect(sender.sent.length).toBe(1);
    expect(bridge.pendingCount()).toBe(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("批准：管理员 /approve 放行，等待者收到 approved，提示消息被改成已批准", async () => {
  const home = tempHome("nyra-bot-appr2-");
  try {
    const sender = makeSender();
    const { bridge, audit } = makeBridge(home, sender);
    const item = await requestOne(bridge);
    const waiting = bridge.waitForDecision(item.id);
    const res = await bridge.decide(item.id, true, "2", "command");
    expect(res.ok).toBe(true);
    expect((await waiting).approved).toBe(true);
    expect(sender.edited.length).toBe(1);
    expect(sender.edited[0].text).toContain("已批准");
    expect(audit.map((a) => a.outcome)).toContain("approval:approved");
    expect(bridge.pending(item.id)?.status).toBe("approved");
    // 批过一次不能再批。
    expect((await bridge.decide(item.id, false, "2", "command")).ok).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("拒绝：管理员 /reject 拒绝，等待者收到原因；非白名单的人批了无效", async () => {
  const home = tempHome("nyra-bot-appr3-");
  try {
    const sender = makeSender();
    const { bridge, audit } = makeBridge(home, sender);
    const item = await requestOne(bridge);
    // guest（不在 owner/admins 里）点批准无效，挂起项还在。
    const bad = await bridge.decide(item.id, true, "99", "button");
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("not-approver");
    expect(bridge.pending(item.id)?.status).toBe("pending");
    expect(audit.map((a) => a.outcome)).toContain("approval:denied-not-approver");
    // 管理员拒绝。
    const waiting = bridge.waitForDecision(item.id);
    const res = await bridge.decide(item.id, false, "1", "button");
    expect(res.ok).toBe(true);
    const decision = await waiting;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("拒绝");
    // 不存在的 id。
    expect((await bridge.decide("deadbeef", true, "1", "command")).reason).toBe("not-found");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("超时：没人批自动拒绝，等待者收到超时原因，提示消息被改成已超时", async () => {
  const home = tempHome("nyra-bot-appr4-");
  try {
    const sender = makeSender();
    const { bridge } = makeBridge(home, sender, { ttlMs: 50 });
    const item = await requestOne(bridge);
    const decision = await bridge.waitForDecision(item.id);
    expect(decision.approved).toBe(false);
    expect(decision.via).toBe("timeout");
    expect(decision.reason).toContain("超时");
    expect(bridge.pending(item.id)?.status).toBe("expired");
    await waitFor(() => sender.edited.some((e) => e.text.includes("超时")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("取消：/stop 取消同会话挂起项，等待者收到已取消", async () => {
  const home = tempHome("nyra-bot-appr5-");
  try {
    const sender = makeSender();
    const { bridge } = makeBridge(home, sender);
    const item = await requestOne(bridge);
    const waiting = bridge.waitForDecision(item.id);
    bridge.cancelSession("telegram:7", "任务已停止，审批已取消。");
    const decision = await waiting;
    expect(decision.approved).toBe(false);
    expect(decision.via).toBe("cancelled");
    expect(bridge.pending(item.id)?.status).toBe("cancelled");
    expect(bridge.pendingCount()).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("审批事件：结论写进 evidence/bot/（没有对应运行目录时走回落，不静默丢）", async () => {
  const home = tempHome("nyra-bot-appr6-");
  try {
    const sender = makeSender();
    const { bridge } = makeBridge(home, sender);
    const item = await requestOne(bridge);
    await bridge.decide(item.id, true, "1", "command");
    const dir = join(home, "evidence", "bot");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
    expect(files.length).toBeGreaterThanOrEqual(2);
    const all = files.map((f) => readFileSync(join(dir, f), "utf-8")).join("\n");
    expect(all).toContain("bot_approval_requested");
    expect(all).toContain("bot_approval_decided");
    expect(all).toContain(item.id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("全链路：真 Agent 调 write_file → approveFn 建审批 → 管理员批准后文件真的写出来了", async () => {
  const home = tempHome("nyra-bot-appr7-");
  const workdir = tempHome("nyra-bot-appr7-wd-");
  try {
    const sender = makeSender();
    const { bridge, policy } = makeBridge(home, sender);
    const profile = profileForRole("owner", policy);
    // 与 BotRunner.buildAgent 同款的 approveFn 接法：白名单先拦一次，再走桥。
    const approveFn = async (tool: string, summary: string, details?: Record<string, unknown>) => {
      if (!isToolAllowed(profile, tool)) return { approved: false, feedback: `工具 ${tool} 不在白名单里。` };
      const approval = await bridge.requestApproval({
        sessionKey: "telegram:7", chatId: "7", threadId: null, tool, summary,
        argsHash: approvalArgsHash({ tool, command: details?.command, fileTarget: details?.fileTarget, cwd: details?.cwd }),
        requestedBy: "1", requestedByRole: "owner",
      });
      const decision = await bridge.waitForDecision(approval.id);
      return decision.approved ? true : { approved: false, feedback: decision.reason };
    };
    const provider = new FakeProvider([
      toolReply("c1", "write_file", { path: "a.txt", content: "hi\n" }),
      textReply("写好了"),
    ]);
    const agent = new Agent(provider as never, {
      workdir, home, mode: "auto", interactive: true, maxTurns: 5, skillsDirs: [],
      sessionId: "20261120-000000-botappr",
      approveFn,
    });
    const runPromise = agent.run("写 a.txt");
    await waitFor(() => sender.sent.length > 0);
    const pending = bridge.pendingForSession("telegram:7");
    expect(pending.length).toBe(1);
    expect(pending[0].tool).toBe("write_file");
    const res = await bridge.decide(pending[0].id, true, "1", "command");
    expect(res.ok).toBe(true);
    const out = await runPromise;
    expect(out).toContain("写好了");
    expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("hi\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("全链路：管理员拒绝后 checkApproval 抛错，文件没写出来", async () => {
  const home = tempHome("nyra-bot-appr8-");
  const workdir = tempHome("nyra-bot-appr8-wd-");
  try {
    const sender = makeSender();
    const { bridge, policy } = makeBridge(home, sender);
    const profile = profileForRole("owner", policy);
    const approveFn = async (tool: string, summary: string, details?: Record<string, unknown>) => {
      if (!isToolAllowed(profile, tool)) return { approved: false, feedback: "不在白名单。" };
      const approval = await bridge.requestApproval({
        sessionKey: "telegram:7", chatId: "7", threadId: null, tool, summary,
        argsHash: approvalArgsHash({ tool, command: details?.command, fileTarget: details?.fileTarget, cwd: details?.cwd }),
        requestedBy: "1", requestedByRole: "owner",
      });
      const decision = await bridge.waitForDecision(approval.id);
      return decision.approved ? true : { approved: false, feedback: decision.reason };
    };
    const provider = new FakeProvider([
      toolReply("c1", "write_file", { path: "a.txt", content: "hi\n" }),
      textReply("写好了"),
    ]);
    const agent = new Agent(provider as never, {
      workdir, home, mode: "auto", interactive: true, maxTurns: 5, skillsDirs: [],
      sessionId: "20261120-000000-botappr2",
      approveFn,
    });
    const runPromise = agent.run("写 a.txt");
    await waitFor(() => sender.sent.length > 0);
    const pending = bridge.pendingForSession("telegram:7");
    await bridge.decide(pending[0].id, false, "1", "command");
    await runPromise;
    expect(existsSync(join(workdir, "a.txt"))).toBe(false);
    // 拒绝原因回到了模型上下文（第二轮 provider 收到的工具结果里有“拒绝”）。
    expect(JSON.stringify(provider.calls)).toContain("拒绝");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("全链路：白名单外的工具不建审批，直接拒绝", async () => {
  const home = tempHome("nyra-bot-appr9-");
  const workdir = tempHome("nyra-bot-appr9-wd-");
  try {
    const sender = makeSender();
    const { policy } = makeBridge(home, sender);
    const profile = profileForRole("admin", policy);
    const ctx = newToolContext({ workdir, home, mode: "auto", interactive: true });
    // admin 的 approveFn：白名单先拦一次（shell 不在 admin 白名单里）。
    const approveFn = async (tool: string, _summary: string) => {
      if (!isToolAllowed(profile, tool)) return { approved: false, feedback: `工具 ${tool} 不在白名单里。` };
      return true;
    };
    const ctxWithFn = newToolContext({ workdir, home, mode: "auto", interactive: true, approveFn });
    await expect(checkApproval(ctxWithFn, "shell", "跑命令", { command: "ls", cwd: workdir })).rejects.toThrow("不在白名单");
    expect(sender.sent.length).toBe(0);
    // 同一个上下文里只读工具直接放行，不走审批。
    await checkApproval(ctx, "read_file", "读文件", { fileTarget: "a.txt" });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
