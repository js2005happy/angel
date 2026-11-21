// tests/node/test-bot-runner-computer.test.ts
//
// 缺口 42 第二批（BotRunner 接线）测试：
//   - 绑定三态：已有电脑直接用 / 有 Soul 没电脑自动建 / 没 Soul 回退到启动目录；
//   - bot.agent 非法值回默认 "nyra"；
//   - Agent 的工作目录落在电脑的 workspace 里（task.run 活动 + 实际落盘证明）；
//   - /computer-shell：own 成功（Linux 假 bwrap；非 Linux 断言 fail-closed 含
//     "bwrap"）、guest 拒绝、用法提示、凭证没存报错、凭证代填只给掩码不给明文；
//   - 跨电脑写操作：deny 不建审批、ask 批准后跑（approvedBy 进活动）、ask 拒绝不跑；
//   - 消息到时唤醒休眠电脑；sweepSleepDue() 休眠闲置到点的电脑；
//   - task.run 活动只记会话 key 与花费，不记用户原文；
//   - nyra bot status 标出本 Bot 的电脑。
//
// 平台口径（第一批 CI #432 的教训）：真 bwrap 只在 Linux 上有，假 bwrap shim
// 只在 Linux 上用；非 Linux 平台上 shell 路径统一断言 fail-closed（报错里含
// "bwrap"），不跑 shim。凭证代填的活动账本断言全平台一致（代填在 bwrap 之前）。
import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botPolicyFromConfig } from "../../src/bot/types.ts";
import { BotRunner, handleBotStatus, parseBotCommand, type AgentRunResult } from "../../src/bot/index.ts";
import {
  createComputer,
  computerWorkspacePath,
  getComputer,
  listComputers,
  loadComputerStore,
  readComputerActivity,
  saveComputerStore,
  sleepComputer,
  storeComputerCredential,
  type BotComputer,
} from "../../src/bot/computer.ts";
import { defaultSoul, saveSoul } from "../../src/soul.ts";
import type { ChannelAdapter, InboundMessage, OutgoingMessage } from "../../src/bot/types.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-bot-runner-computer-"));
}

// 与 test-bot-runner.test.ts 同款假适配器：sendText 返回字符串 id、editText
// 记下来（handleMessage 的最终回复走 editText，只看 sent 会只看到占位
// “处理中…”）。
class FakeAdapter implements ChannelAdapter {
  readonly channel = "telegram" as const;
  botUsername: string | null = "FakeBot";
  readonly sent: { chatId: string; threadId: string | null; text: string; id: string }[] = [];
  readonly edited: { chatId: string; messageId: string; text: string }[] = [];
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
  async sendPhoto(_msg: OutgoingMessage, _photo: { path: string }): Promise<string> {
    return "photo";
  }
}

/** /computer-shell 这类确定性指令的回复走 sendText（占位 + 回复都在 sent 里）。 */
function sentText(adapter: FakeAdapter): string {
  return adapter.sent.map((m) => m.text).join("\n");
}

/** 普通消息的最终回复走 editText（占位“处理中…”被编辑成正文）。 */
function editedText(adapter: FakeAdapter): string {
  return adapter.edited.map((m) => m.text).join("\n");
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: "telegram",
    chatId: "7",
    threadId: null,
    senderId: "7",
    senderRole: "member",
    isMentioned: false,
    messageId: "msg1",
    text: "hi",
    attachments: [],
    chatType: "private",
    timestamp: Date.now(),
    ...overrides,
  };
}

function ownerConfig(): Record<string, unknown> {
  return { bot: { owner: "7" } };
}

function makeRunner(home: string, agentRun?: (key: string, text: string, signal: AbortSignal) => Promise<AgentRunResult>, agent?: string): BotRunner {
  const runner = new BotRunner({
    home,
    workdir: join(home, "launch-dir"),
    config: ownerConfig(),
    adapter: new FakeAdapter(),
    agentRun: agentRun ?? (async () => ({ text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: 0.001 })),
    agent,
  });
  return runner;
}

function withSoulAndComputer(home: string, agent: string, opts: { isolation?: "dedicated" | "shared"; acceptedBy?: string } = {}): BotComputer {
  saveSoul(home, defaultSoul(agent));
  return createComputer(home, { agent, name: `${agent}-pc`, isolation: opts.isolation ?? "dedicated", sharedAcceptedBy: opts.acceptedBy });
}

// 假 bwrap shim（只在 Linux 上用）：把最后一个参数当 shell 命令跑（与
// test-bot-computer.test.ts 同款）。runSandboxed 拼的 bwrap 参数以
// `-- sh -c <命令>` 结尾，last 就是那条命令。
function makeBwrapShim(dir: string): string {
  const shim = join(dir, "bwrap");
  writeFileSync(shim, "#!/bin/sh\nfor last; do :; done\nsh -c \"$last\"\n", "utf-8");
  chmodSync(shim, 0o755);
  return dir;
}

const isLinux = process.platform === "linux";

describe("bot.agent 解析", () => {
  test("非法值回默认 nyra，合法值原样保留", () => {
    expect(botPolicyFromConfig({ bot: { agent: "Bad Name" } }).agent).toBe("nyra");
    expect(botPolicyFromConfig({ bot: { agent: "" } }).agent).toBe("nyra");
    expect(botPolicyFromConfig({ bot: { agent: "helper" } }).agent).toBe("helper");
    expect(botPolicyFromConfig({}).agent).toBe("nyra");
  });
});

describe("parseBotCommand 连字符", () => {
  test("/computer-shell 能解析成命令（缺口 42 第二批放宽了正则）", () => {
    expect(parseBotCommand("/computer-shell own echo hi")).toEqual({ command: "computer-shell", args: "own echo hi" });
    expect(parseBotCommand("/computer-shell@MyBot own echo hi")).toEqual({ command: "computer-shell", args: "own echo hi" });
    expect(parseBotCommand("/foo--bar")).toEqual({ command: "foo--bar", args: "" });
    expect(parseBotCommand("/-foo")).toBeNull();
    expect(parseBotCommand("/foo bar/baz")).toEqual({ command: "foo", args: "bar/baz" });
  });
});

describe("resolveBotComputer 绑定三态", () => {
  let home = "";

  beforeEach(() => {
    home = tmpHome();
  });

  test("已有电脑：直接用，工作目录是电脑的 workspace", () => {
    const computer = withSoulAndComputer(home, "nyra");
    const runner = makeRunner(home);
    expect(runner.boundComputer?.id).toBe(computer.id);
    expect(runner.agent).toBe("nyra");
    expect(runner.agentWorkdir).toBe(computerWorkspacePath(home, computer));
    expect(existsSync(runner.agentWorkdir)).toBe(true);
  });

  test("有 Soul 没电脑：自动建一台", () => {
    saveSoul(home, defaultSoul("nyra"));
    const runner = makeRunner(home);
    expect(runner.boundComputer).not.toBeNull();
    expect(runner.boundComputer?.agent).toBe("nyra");
    expect(listComputers(home)).toHaveLength(1);
  });

  test("没 Soul：不接电脑，工作目录仍是启动目录", () => {
    const runner = makeRunner(home);
    expect(runner.boundComputer).toBeNull();
    expect(runner.agentWorkdir).toBe(join(home, "launch-dir"));
    expect(listComputers(home)).toHaveLength(0);
  });

  test("agent 覆盖：绑定的是指定身份的电脑", () => {
    withSoulAndComputer(home, "helper");
    const runner = makeRunner(home, undefined, "helper");
    expect(runner.agent).toBe("helper");
    expect(runner.boundComputer?.agent).toBe("helper");
  });
});

describe("/computer-shell", () => {
  let home = "";

  beforeEach(() => {
    home = tmpHome();
  });

  test("guest 拒绝：只有机主/管理员能用", async () => {
    withSoulAndComputer(home, "nyra");
    const adapter = new FakeAdapter();
    const runner = new BotRunner({
      home,
      workdir: join(home, "launch-dir"),
      config: ownerConfig(),
      adapter,
      agentRun: async () => ({ text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: 0 }),
    });
    await runner.handleMessage(makeMsg({ senderId: "9", chatId: "9", text: "/computer-shell own echo hi" }));
    expect(sentText(adapter)).toContain("只有机主/管理员能用");
    // 拒绝发生在 runComputerShell 之前：账本里只有建电脑的 computer.created，没有 shell.run。
    expect(readComputerActivity(home).some((a) => a.action === "shell.run")).toBe(false);
  });

  test("用法提示：缺目标或缺命令时回用法", async () => {
    withSoulAndComputer(home, "nyra");
    const adapter = new FakeAdapter();
    const runner = new BotRunner({
      home,
      workdir: join(home, "launch-dir"),
      config: ownerConfig(),
      adapter,
      agentRun: async () => ({ text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: 0 }),
    });
    await runner.handleMessage(makeMsg({ text: "/computer-shell" }));
    expect(sentText(adapter)).toContain("用法：/computer-shell");
  });

  test("own 成功：落在自己电脑的 workspace 里跑（Linux 假 bwrap；非 Linux 断言 fail-closed）", async () => {
    const computer = withSoulAndComputer(home, "nyra");
    const adapter = new FakeAdapter();
    const runner = new BotRunner({
      home,
      workdir: join(home, "launch-dir"),
      config: ownerConfig(),
      adapter,
      agentRun: async () => ({ text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: 0 }),
    });
    if (isLinux) {
      const shimDir = mkdtempSync(join(tmpdir(), "nyra-fake-bwrap-"));
      try {
        makeBwrapShim(shimDir);
        const old = process.env.PATH ?? "";
        process.env.PATH = `${shimDir}:${old}`;
        try {
          await runner.handleMessage(makeMsg({ text: "/computer-shell own echo hi > hello.txt && echo done" }));
        } finally {
          process.env.PATH = old;
        }
        const reply = sentText(adapter);
        expect(reply).toContain("退出码 0");
        expect(reply).toContain("done");
        expect(readFileSync(join(computerWorkspacePath(home, computer), "hello.txt"), "utf-8")).toBe("hi\n");
        const shellRun = readComputerActivity(home).find((a) => a.action === "shell.run");
        expect(shellRun?.ok).toBe(true);
      } finally {
        rmSync(shimDir, { recursive: true, force: true });
      }
    } else {
      await runner.handleMessage(makeMsg({ text: "/computer-shell own echo hi" }));
      const reply = sentText(adapter);
      expect(reply).toContain("执行失败");
      expect(reply).toContain("bwrap");
    }
  });

  test("跨电脑 deny：他人独占电脑直接拒绝，不建审批", async () => {
    withSoulAndComputer(home, "nyra");
    withSoulAndComputer(home, "helper");
    const adapter = new FakeAdapter();
    const runner = new BotRunner({
      home,
      workdir: join(home, "launch-dir"),
      config: ownerConfig(),
      adapter,
      agentRun: async () => ({ text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: 0 }),
      agent: "helper",
    });
    const nyraComputer = listComputers(home).find((c) => c.agent === "nyra")!;
    await runner.handleMessage(makeMsg({ text: `/computer-shell ${nyraComputer.id} echo hi` }));
    const reply = sentText(adapter);
    expect(reply).toContain("独占");
    expect(runner.bridge.pendingForSession("telegram:7")).toHaveLength(0);
    expect(readComputerActivity(home).some((a) => a.action === "shell.run")).toBe(false);
  });

  test("跨电脑 ask：批准后跑，批的人记进 shell.run 的 approvedBy", async () => {
    const nyraComputer = withSoulAndComputer(home, "nyra", { isolation: "shared", acceptedBy: "机主" });
    withSoulAndComputer(home, "helper");
    const adapter = new FakeAdapter();
    const runner = new BotRunner({
      home,
      workdir: join(home, "launch-dir"),
      config: ownerConfig(),
      adapter,
      agentRun: async () => ({ text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: 0 }),
      agent: "helper",
    });
    const runFlow = async (): Promise<void> => {
      const p = runner.handleMessage(makeMsg({ text: `/computer-shell ${nyraComputer.id} echo hi` }));
      await new Promise((r) => setTimeout(r, 50));
      const pending = runner.bridge.pendingForSession("telegram:7");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.tool).toBe("computer-shell");
      await runner.bridge.decide(pending[0]!.id, true, "7", "command");
      await p;
    };
    if (isLinux) {
      const shimDir = mkdtempSync(join(tmpdir(), "nyra-fake-bwrap-"));
      try {
        makeBwrapShim(shimDir);
        const old = process.env.PATH ?? "";
        process.env.PATH = `${shimDir}:${old}`;
        try {
          await runFlow();
        } finally {
          process.env.PATH = old;
        }
        const reply = sentText(adapter);
        expect(reply).toContain("退出码 0");
        const shellRun = readComputerActivity(home).find((a) => a.action === "shell.run");
        expect(shellRun?.approvedBy).toBe("7");
      } finally {
        rmSync(shimDir, { recursive: true, force: true });
      }
    } else {
      // 非 Linux：审批通过后仍 fail-closed（bwrap 不可用），但审批流本身已验证。
      await runFlow();
      const reply = sentText(adapter);
      expect(reply).toContain("bwrap");
    }
  });

  test("跨电脑 ask：拒绝后不跑", async () => {
    const nyraComputer = withSoulAndComputer(home, "nyra", { isolation: "shared", acceptedBy: "机主" });
    withSoulAndComputer(home, "helper");
    const adapter = new FakeAdapter();
    const runner = new BotRunner({
      home,
      workdir: join(home, "launch-dir"),
      config: ownerConfig(),
      adapter,
      agentRun: async () => ({ text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: 0 }),
      agent: "helper",
    });
    const p = runner.handleMessage(makeMsg({ text: `/computer-shell ${nyraComputer.id} echo hi` }));
    await new Promise((r) => setTimeout(r, 50));
    const pending = runner.bridge.pendingForSession("telegram:7");
    expect(pending).toHaveLength(1);
    await runner.bridge.decide(pending[0]!.id, false, "7", "command", "不给跑");
    await p;
    const reply = sentText(adapter);
    expect(reply).toContain("审批未通过");
    expect(readComputerActivity(home).some((a) => a.action === "shell.run")).toBe(false);
  });

  test("凭证没存：直接报错，命令不跑", async () => {
    withSoulAndComputer(home, "nyra");
    const adapter = new FakeAdapter();
    const runner = new BotRunner({
      home,
      workdir: join(home, "launch-dir"),
      config: ownerConfig(),
      adapter,
      agentRun: async () => ({ text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: 0 }),
    });
    await runner.handleMessage(makeMsg({ text: "/computer-shell own echo $NYRA_CRED_GITHUB --cred github" }));
    const reply = sentText(adapter);
    expect(reply).toContain("执行失败");
    expect(reply).toContain("凭证 github 没存");
    expect(readComputerActivity(home).some((a) => a.action === "shell.run")).toBe(false);
  });

  test("凭证代填：明文进沙箱环境变量，回显与活动账本里只有掩码", async () => {
    const computer = withSoulAndComputer(home, "nyra");
    storeComputerCredential(home, computer.id, "github", "ghp_testsecret1234");
    const adapter = new FakeAdapter();
    const runner = new BotRunner({
      home,
      workdir: join(home, "launch-dir"),
      config: ownerConfig(),
      adapter,
      agentRun: async () => ({ text: "ok", promptTokens: 0, completionTokens: 0, spentUsd: 0 }),
    });
    if (isLinux) {
      const shimDir = mkdtempSync(join(tmpdir(), "nyra-fake-bwrap-"));
      try {
        makeBwrapShim(shimDir);
        const old = process.env.PATH ?? "";
        process.env.PATH = `${shimDir}:${old}`;
        try {
          await runner.handleMessage(makeMsg({ text: "/computer-shell own echo $NYRA_CRED_GITHUB --cred github" }));
        } finally {
          process.env.PATH = old;
        }
        const reply = sentText(adapter);
        expect(reply).toContain("***");
        expect(reply).not.toContain("ghp_testsecret1234");
      } finally {
        rmSync(shimDir, { recursive: true, force: true });
      }
    } else {
      // 非 Linux：bwrap 不可用，命令跑不成，但代填步骤已在 bwrap 之前完成并记了活动。
      await runner.handleMessage(makeMsg({ text: "/computer-shell own echo $NYRA_CRED_GITHUB --cred github" }));
      const reply = sentText(adapter);
      expect(reply).toContain("bwrap");
      expect(reply).not.toContain("ghp_testsecret1234");
    }
    const used = readComputerActivity(home).find((a) => a.action === "credential.used");
    expect(used?.target).toBe("github");
    expect(used?.detail).toContain("1234");
    expect(JSON.stringify(readComputerActivity(home))).not.toContain("ghp_testsecret1234");
  });
});

describe("消息任务与电脑", () => {
  let home = "";

  beforeEach(() => {
    home = tmpHome();
  });

  test("消息到时唤醒休眠电脑，跑完记 task.run（只记会话 key 与花费，不记原文）", async () => {
    const computer = withSoulAndComputer(home, "nyra");
    sleepComputer(home, computer.id);
    expect(getComputer(home, computer.id).state).toBe("sleeping");
    const adapter = new FakeAdapter();
    const runner = new BotRunner({
      home,
      workdir: join(home, "launch-dir"),
      config: ownerConfig(),
      adapter,
      agentRun: async () => ({ text: "done", promptTokens: 0, completionTokens: 0, spentUsd: 0.002 }),
    });
    await runner.handleMessage(makeMsg({ text: "帮我看看今天的日程" }));
    expect(getComputer(home, computer.id).state).toBe("active");
    const task = readComputerActivity(home).find((a) => a.action === "task.run");
    expect(task?.kind).toBe("task");
    expect(task?.target).toBe("telegram:7");
    expect(task?.ok).toBe(true);
    expect(task?.spentUsd).toBe(0.002);
    expect(JSON.stringify(readComputerActivity(home))).not.toContain("帮我看看今天的日程");
  });

  test("sweepSleepDue() 休眠闲置到点的电脑，闲置为 0 的不睡", () => {
    const computer = withSoulAndComputer(home, "nyra", {});
    const store = loadComputerStore(home);
    const entry = store.computers.find((c) => c.id === computer.id)!;
    entry.idleSleepMinutes = 1;
    entry.lastActiveAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    saveComputerStore(home, store);
    const runner = makeRunner(home);
    runner.sweepSleepDue();
    expect(getComputer(home, computer.id).state).toBe("sleeping");
    // 闲置为 0 的电脑：即使 24 小时没动也不睡（建电脑先要有 Soul）。
    saveSoul(home, defaultSoul("helper"));
    const second = createComputer(home, { agent: "helper", name: "helper-pc", idleSleepMinutes: 0 });
    const store2 = loadComputerStore(home);
    store2.computers.find((c) => c.id === second.id)!.lastActiveAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    saveComputerStore(home, store2);
    runner.sweepSleepDue();
    expect(getComputer(home, second.id).state).toBe("active");
  });

  test("没接电脑时：消息照常跑，不记 task.run", async () => {
    const adapter = new FakeAdapter();
    const runner = new BotRunner({
      home,
      workdir: join(home, "launch-dir"),
      config: ownerConfig(),
      adapter,
      agentRun: async () => ({ text: "done", promptTokens: 0, completionTokens: 0, spentUsd: 0 }),
    });
    await runner.handleMessage(makeMsg({ text: "hi" }));
    expect(editedText(adapter)).toContain("done");
    expect(readComputerActivity(home)).toHaveLength(0);
  });
});

describe("nyra bot status 标注本 Bot 的电脑", () => {
  test("agent 相同的电脑行带“（本 Bot 的电脑）”", async () => {
    const home = tmpHome();
    withSoulAndComputer(home, "nyra");
    withSoulAndComputer(home, "helper");
    writeFileSync(join(home, "config.json"), JSON.stringify({ bot: { agent: "nyra" } }));
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await handleBotStatus(home);
    } finally {
      process.stdout.write = orig;
    }
    const text = out.join("");
    expect(text).toContain("本 Bot 的电脑");
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    const nyraLine = lines.find((l) => l.includes("nyra-pc"));
    const helperLine = lines.find((l) => l.includes("helper-pc"));
    expect(nyraLine).toContain("本 Bot 的电脑");
    expect(helperLine).not.toContain("本 Bot 的电脑");
  });
});
