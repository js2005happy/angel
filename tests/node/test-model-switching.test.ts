// tests/node/test-model-switching.test.ts — 缺口 5：每 agent 模型选择器 +
// 用量触顶自动换模型。
//
// 覆盖：触发分类（402/429 配额文案 = 用量触顶）、触顶自动换且留痕、
// 兜底默认关闭、每机器人显式 opt-in（true/false/null 三态）、手动换模型
// 不丢历史与工具状态、只切允许列表、队列/定时任务里不自动换、换模型进
// 证据链（events.jsonl + --json 事件流）、REPL /model 真测。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  ProviderError, FallbackProvider, Provider, buildProviderChain, httpError,
  isQuotaExhaustionError, switchTriggerFor, type ProviderLike,
} from "../../src/providers.ts";
import {
  DEFAULT_CONFIG, resolveFallbackChain, resolveSwitchAllowlist, saveConfig,
} from "../../src/config.ts";
import { Agent, AgentError } from "../../src/agent.ts";
import { RunStore, RunRecorder } from "../../src/runs.ts";
import { GroupStore, parseBot } from "../../src/groups.ts";
import { buildProvider } from "../../src/tasks.ts";
import { JsonLines } from "../../src/jsonMode.ts";
import { fakeProvider } from "./fake-provider.ts";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** 指定 kind/status 失败的假 provider（成功时回固定文本）。 */
function failProvider(
  name: string,
  failTimes: number,
  err: ProviderError,
  opts?: { model?: string; hasCredentials?: boolean },
): ProviderLike & { calls: number } {
  let calls = 0;
  const provider = {
    name,
    model: opts?.model ?? `${name}-model`,
    baseUrl: `https://${name}.example.com/v1`,
    calls: 0,
    hasCredentials: () => opts?.hasCredentials ?? true,
    async chat(): Promise<Record<string, unknown>> {
      calls += 1;
      provider.calls = calls;
      if (calls <= failTimes) throw err;
      return { choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    },
    async listModels(): Promise<string[]> { return [provider.model]; },
    redact: (t: string) => t,
  };
  return provider;
}

function okProvider(name: string, model?: string): ProviderLike & { calls: number } {
  return failProvider(name, 0, new ProviderError("unused"), { model });
}

// ---- 触发分类：用量触顶 vs 单纯限流 --------------------------------------

test("quota: 402 与配额文案的 429 都判用量触顶，单纯 429 不判", () => {
  expect(isQuotaExhaustionError(httpError(402, "no balance"))).toBe(true);
  expect(isQuotaExhaustionError(httpError(429, "You've hit your weekly limit"))).toBe(true);
  expect(isQuotaExhaustionError(httpError(429, "用量已用完，请充值"))).toBe(true);
  expect(isQuotaExhaustionError(httpError(429, "slow down"))).toBe(false);
  expect(isQuotaExhaustionError(httpError(401, "bad key"))).toBe(false);
  expect(isQuotaExhaustionError(new Error("plain"))).toBe(false);
  expect(httpError(429, "You've hit your weekly limit").kind).toBe("quota");
  expect(httpError(429, "slow down").kind).toBe("rate_limit");
});

test("switchTriggerFor: kind 直通触发原因，无法归类的落 other", () => {
  expect(switchTriggerFor("quota")).toBe("quota");
  expect(switchTriggerFor("rate_limit")).toBe("rate_limit");
  expect(switchTriggerFor("server")).toBe("server");
  expect(switchTriggerFor("timeout")).toBe("timeout");
  expect(switchTriggerFor("network")).toBe("network");
  expect(switchTriggerFor("auth")).toBe("other");
  expect(switchTriggerFor("client")).toBe("other");
  expect(switchTriggerFor("unknown")).toBe("other");
});

// ---- 兜底链：触顶自动换 ---------------------------------------------------

test("quota 错误直接换下一家，切换记录带 trigger=quota", async () => {
  const primary = failProvider("deepseek", 1, new ProviderError("用量上限", { kind: "quota", status: 429 }));
  const secondary = okProvider("xai");
  const switches: unknown[] = [];
  const fb = new FallbackProvider([primary, secondary], (r) => switches.push(r), { retryDelaysMs: [0, 0] });
  const result = await fb.chat([{ role: "user", content: "hi" }]);
  expect((result.choices as { message: { content: string } }[])[0].message.content).toBe("ok");
  expect(primary.calls).toBe(1); // 用量触顶不重试同一家，直接换
  expect(secondary.calls).toBe(1);
  expect(fb.switches).toHaveLength(1);
  expect(fb.switches[0].trigger).toBe("quota");
  expect(fb.switches[0].kind).toBe("quota");
  expect(fb.switches[0].status).toBe(429);
  expect((switches[0] as { trigger: string }).trigger).toBe("quota");
});

test("402 余额不足同样触发切换（trigger=quota）", async () => {
  const primary = failProvider("deepseek", 1, httpError(402, "insufficient balance"));
  const secondary = okProvider("xai");
  const fb = new FallbackProvider([primary, secondary], null, { retryDelaysMs: [0, 0] });
  await fb.chat([{ role: "user", content: "hi" }]);
  expect(fb.switches).toHaveLength(1);
  expect(fb.switches[0].trigger).toBe("quota");
  expect(fb.switches[0].status).toBe(402);
});

test("单纯 429 先重试同一家、重试无果再换，trigger=rate_limit", async () => {
  const primary = failProvider("deepseek", 10, new ProviderError("slow down", { kind: "rate_limit", status: 429 }));
  const secondary = okProvider("xai");
  const fb = new FallbackProvider([primary, secondary], null, { retryDelaysMs: [0, 0], sleep: async () => {} });
  await fb.chat([{ role: "user", content: "hi" }]);
  expect(primary.calls).toBe(3); // 首次 + 2 次同 provider 重试
  expect(fb.switches).toHaveLength(1);
  expect(fb.switches[0].trigger).toBe("rate_limit");
});

test("认证错不切换，直接抛回原错", async () => {
  const primary = failProvider("deepseek", 1, new ProviderError("bad key", { kind: "auth", status: 401 }));
  const secondary = okProvider("xai");
  const fb = new FallbackProvider([primary, secondary], null, { retryDelaysMs: [0, 0] });
  await expect(fb.chat([{ role: "user", content: "hi" }])).rejects.toThrow("bad key");
  expect(fb.switches).toHaveLength(0);
  expect(secondary.calls).toBe(0);
});

test("单 provider 链上触顶仍失败，不静默换", async () => {
  const only = failProvider("deepseek", 1, new ProviderError("用量上限", { kind: "quota", status: 429 }));
  const fb = new FallbackProvider([only], null, { retryDelaysMs: [0, 0] });
  await expect(fb.chat([{ role: "user", content: "hi" }])).rejects.toThrow("用量上限");
  expect(fb.switches).toHaveLength(0);
});

// ---- 每 agent 兜底 opt-in（config 层）--------------------------------------

test("resolveFallbackChain: 机器人显式 true 胜过全局关闭", () => {
  const config = { ...DEFAULT_CONFIG, fallback_enabled: false, fallback_providers: ["xai"] };
  expect(resolveFallbackChain(config, "deepseek", true, ["xai"])).toEqual(["deepseek", "xai"]);
});

test("resolveFallbackChain: 机器人显式 false 胜过全局开启", () => {
  const config = { ...DEFAULT_CONFIG, fallback_enabled: true, fallback_providers: ["xai", "ollama"] };
  expect(resolveFallbackChain(config, "deepseek", false)).toEqual(["deepseek"]);
});

test("resolveFallbackChain: 机器人自己的备用链覆盖全局链", () => {
  const config = { ...DEFAULT_CONFIG, fallback_enabled: true, fallback_providers: ["xai"] };
  expect(resolveFallbackChain(config, "deepseek", true, ["groq"])).toEqual(["deepseek", "groq"]);
});

test("resolveFallbackChain: 未知名字与 CLI provider 照样跳过", () => {
  const config = { ...DEFAULT_CONFIG, fallback_enabled: true };
  expect(resolveFallbackChain(config, "deepseek", true, ["nope", "codex", "ollama"])).toEqual(["deepseek", "ollama"]);
});

test("resolveFallbackChain: 机器人显式空链 = 无兜底", () => {
  const config = { ...DEFAULT_CONFIG, fallback_enabled: true, fallback_providers: ["xai"] };
  expect(resolveFallbackChain(config, "deepseek", true, [])).toEqual(["deepseek"]);
});

test("resolveFallbackChain: 默认关闭时只剩 primary", () => {
  expect(resolveFallbackChain({ ...DEFAULT_CONFIG }, "deepseek")).toEqual(["deepseek"]);
});

test("resolveSwitchAllowlist: 手动换模型名单不受 fallback 开关影响", () => {
  const off = { ...DEFAULT_CONFIG, fallback_enabled: false };
  expect(resolveSwitchAllowlist(off, "deepseek")).toEqual(["deepseek", "xai", "ollama"]);
  const empty = { ...DEFAULT_CONFIG, fallback_enabled: false, fallback_providers: [] };
  expect(resolveSwitchAllowlist(empty, "deepseek")).toEqual(["deepseek"]);
  const custom = { ...DEFAULT_CONFIG, fallback_enabled: false, fallback_providers: ["groq"] };
  expect(resolveSwitchAllowlist(custom, "xai")).toEqual(["xai", "groq"]);
});

// ---- 对话中途换模型（Agent.switchModel）-----------------------------------

test("switchModel: 历史、工具状态、用量累计原样保留，并发 model_switch 事件", async () => {
  const home = tmpRoot("nyra-switch-");
  try {
    const events: [string, Record<string, unknown>][] = [];
    const agent = new Agent(fakeProvider([{ content: "第一轮答复。" }], { name: "deepseek", model: "deepseek-flash" }), {
      workdir: home, home,
      onEvent: (kind, data) => events.push([kind, data]),
      modelSwitchAllowlist: ["deepseek", "xai"],
    });
    await agent.run("你好");
    expect(agent.usage.calls).toBe(1);
    const beforeMessages = JSON.parse(JSON.stringify(agent.messages));
    const ctxBefore = agent.ctx;
    const usageBefore = agent.usage.snapshot();
    const switched = agent.switchModel(fakeProvider([{ content: "第二轮答复。" }], { name: "xai", model: "grok-4.3" }), {
      reason: "测试切换",
      contextWindowTokens: 500000, contextWindowSource: "builtin", contextWindowModel: "grok-4.3",
    });
    expect(switched).toEqual({ from: "deepseek / deepseek-flash", to: "xai / grok-4.3" });
    expect(agent.provider.name).toBe("xai");
    expect(agent.messages).toEqual(beforeMessages); // 一字不丢
    expect(agent.ctx).toBe(ctxBefore); // 工具状态同一份
    expect(agent.usage.calls).toBe(usageBefore.calls);
    expect(agent.usage.prompt_tokens).toBe(usageBefore.prompt_tokens);
    expect(agent.usage.snapshot().context_window_tokens).toBe(500000);
    expect(agent.usage.snapshot().context_window_model).toBe("grok-4.3");
    const sw = events.filter(([k]) => k === "model_switch");
    expect(sw).toHaveLength(1);
    expect(sw[0][1].from).toBe("deepseek / deepseek-flash");
    expect(sw[0][1].to).toBe("xai / grok-4.3");
    expect(sw[0][1].reason).toBe("测试切换");
    expect(sw[0][1].trigger).toBe("manual");
    expect(typeof sw[0][1].spent_usd === "number" || sw[0][1].spent_usd === null).toBe(true);
    // 换完的模型能接着同一段对话跑下去。
    const reply = await agent.run("继续");
    expect(reply).toBe("第二轮答复。");
  } finally {
    cleanup(home);
  }
});

test("switchModel: 目标不在允许列表内拒绝", () => {
  const home = tmpRoot("nyra-switch-");
  try {
    const agent = new Agent(fakeProvider([{ content: "hi" }], { name: "deepseek", model: "deepseek-flash" }), {
      workdir: home, home, modelSwitchAllowlist: ["deepseek"],
    });
    expect(() => agent.switchModel(okProvider("xai", "grok-4.3"))).toThrow("不在允许列表内");
    expect(agent.provider.name).toBe("deepseek");
  } finally {
    cleanup(home);
  }
});

test("switchModel: CLI provider 不能中途接入或切出", () => {
  const home = tmpRoot("nyra-switch-");
  try {
    const agent = new Agent(fakeProvider([{ content: "hi" }], { name: "deepseek", model: "deepseek-flash" }), {
      workdir: home, home, modelSwitchAllowlist: ["deepseek", "codex"],
    });
    const codexLike = okProvider("codex", "codex-default");
    (codexLike as { baseUrl: string }).baseUrl = "cli://codex";
    expect(() => agent.switchModel(codexLike)).toThrow("Codex CLI provider 不能中途切换");
    const cliAgent = new Agent({ ...fakeProvider([{ content: "hi" }]), baseUrl: "cli://codex", name: "codex" }, {
      workdir: home, home, modelSwitchAllowlist: ["deepseek", "codex"],
    });
    expect(() => cliAgent.switchModel(okProvider("deepseek", "deepseek-flash"))).toThrow("Codex CLI provider 不能中途切换");
  } finally {
    cleanup(home);
  }
});

test("switchModel: 目标没有凭证拒绝", () => {
  const home = tmpRoot("nyra-switch-");
  try {
    const agent = new Agent(fakeProvider([{ content: "hi" }], { name: "deepseek", model: "deepseek-flash" }), {
      workdir: home, home, modelSwitchAllowlist: ["deepseek", "xai"],
    });
    const noKey = failProvider("xai", 0, new ProviderError("unused"), { hasCredentials: false });
    expect(() => agent.switchModel(noKey)).toThrow("没有可用凭证");
    expect(agent.provider.name).toBe("deepseek");
  } finally {
    cleanup(home);
  }
});

// ---- 换模型进证据链 ---------------------------------------------------------

test("model_switch 事件写进 events.jsonl（RunRecorder）", () => {
  const home = tmpRoot("nyra-switch-evidence-");
  try {
    const store = new RunStore(join(home, "runs"));
    const agent = new Agent(fakeProvider([{ content: "hi" }], { name: "deepseek", model: "deepseek-flash" }), {
      workdir: home, home, modelSwitchAllowlist: ["deepseek", "xai"],
    });
    const recorder = new RunRecorder(store, agent, "换模型测试");
    agent.switchModel(fakeProvider([{ content: "hi2" }], { name: "xai", model: "grok-4.3" }), { reason: "用户在对话中途手动切换模型" });
    const events = store.readEvents(recorder.runId);
    const sw = events.find((e) => (e as Record<string, unknown>).type === "model_switch") as Record<string, unknown> | undefined;
    expect(sw).toBeDefined();
    expect(sw!.from).toBe("deepseek / deepseek-flash");
    expect(sw!.to).toBe("xai / grok-4.3");
    expect(sw!.reason).toBe("用户在对话中途手动切换模型");
    expect(sw!.trigger).toBe("manual");
    expect(typeof sw!.at).toBe("string");
  } finally {
    cleanup(home);
  }
});

test("model_switch 进 --json 事件流，超长原因截断", () => {
  const lines: string[] = [];
  const stream = { write: (chunk: string) => { lines.push(chunk); return true; } } as unknown as NodeJS.WriteStream;
  const jl = new JsonLines(stream);
  jl.agentEvent("model_switch", {
    from: "deepseek / deepseek-flash", to: "xai / grok-4.3",
    reason: "x".repeat(200), trigger: "quota", spent_usd: 0.01,
  });
  expect(lines).toHaveLength(1);
  const ev = JSON.parse(lines[0]) as Record<string, unknown>;
  expect(ev.type).toBe("model_switch");
  expect(ev.from).toBe("deepseek / deepseek-flash");
  expect(ev.to).toBe("xai / grok-4.3");
  expect(ev.trigger).toBe("quota");
  expect(ev.spent_usd).toBe(0.01);
  expect((ev.reason as string).length).toBeLessThanOrEqual(121);
  expect((ev.reason as string).endsWith("…")).toBe(true);
});

// ---- 群聊机器人：每机器人 opt-in -------------------------------------------

test("parseBot: 接受 fallback_enabled / fallback_providers，类型不对拒绝", () => {
  const bot = parseBot({
    id: "b1", name: "B", role: "R", instructions: "I",
    provider: "deepseek", fallback_enabled: true, fallback_providers: ["xai"],
  });
  expect(bot.fallback_enabled).toBe(true);
  expect(bot.fallback_providers).toEqual(["xai"]);
  const plain = parseBot({ id: "b2", name: "B", role: "R", instructions: "I" });
  expect(plain.fallback_enabled).toBeNull();
  expect(plain.fallback_providers).toBeNull();
  expect(() => parseBot({ id: "b3", name: "B", role: "R", instructions: "I", fallback_enabled: "yes" })).toThrow();
  expect(() => parseBot({ id: "b3", name: "B", role: "R", instructions: "I", fallback_providers: "xai" })).toThrow();
  expect(() => parseBot({ id: "b3", name: "B", role: "R", instructions: "I", fallback_providers: [""] })).toThrow();
});

test("providerForBot: 机器人 false 关掉全局兜底，true 在全局关闭时也能换", () => {
  const home = tmpRoot("nyra-switch-groups-");
  const prevDeepseek = process.env.DEEPSEEK_API_KEY;
  const prevFallback = process.env.NYRA_FALLBACK;
  const prevChain = process.env.NYRA_FALLBACK_PROVIDERS;
  try {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    delete process.env.NYRA_FALLBACK;
    delete process.env.NYRA_FALLBACK_PROVIDERS;
    // 全局开、机器人关 → 不换。
    saveConfig(home, { fallback_enabled: true, fallback_providers: ["ollama"] });
    const store = new GroupStore(join(home, "groups"), { home });
    const off = parseBot({
      id: "b1", name: "B", role: "R", instructions: "I",
      provider: "deepseek", fallback_enabled: false,
    });
    const pOff = store.providerForBot(off);
    expect(pOff).toBeInstanceOf(Provider);
    expect(pOff).not.toBeInstanceOf(FallbackProvider);
    // 全局关、机器人开 → 换。
    saveConfig(home, { fallback_enabled: false, fallback_providers: ["ollama"] });
    const store2 = new GroupStore(join(home, "groups"), { home });
    const on = parseBot({
      id: "b2", name: "B", role: "R", instructions: "I",
      provider: "deepseek", fallback_enabled: true,
    });
    const pOn = store2.providerForBot(on);
    expect(pOn).toBeInstanceOf(FallbackProvider);
    // 不写机器人字段 = 沿用全局（全局关 → 不换）。
    const plain = parseBot({ id: "b3", name: "B", role: "R", instructions: "I", provider: "deepseek" });
    const pPlain = store2.providerForBot(plain);
    expect(pPlain).toBeInstanceOf(Provider);
    expect(pPlain).not.toBeInstanceOf(FallbackProvider);
  } finally {
    if (prevDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevDeepseek;
    if (prevFallback === undefined) delete process.env.NYRA_FALLBACK;
    else process.env.NYRA_FALLBACK = prevFallback;
    if (prevChain === undefined) delete process.env.NYRA_FALLBACK_PROVIDERS;
    else process.env.NYRA_FALLBACK_PROVIDERS = prevChain;
    cleanup(home);
  }
});

// ---- 队列/定时任务：永不自动换 ----------------------------------------------

test("tasks.buildProvider: 全局兜底开了也只给单个 Provider（队列里不切换）", () => {
  const home = tmpRoot("nyra-switch-tasks-");
  const prevDeepseek = process.env.DEEPSEEK_API_KEY;
  const prevFallback = process.env.NYRA_FALLBACK;
  const prevChain = process.env.NYRA_FALLBACK_PROVIDERS;
  try {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    delete process.env.NYRA_FALLBACK;
    delete process.env.NYRA_FALLBACK_PROVIDERS;
    const config = { ...DEFAULT_CONFIG, fallback_enabled: true, fallback_providers: ["xai", "ollama"] };
    const [provider] = buildProvider(config, home);
    expect(provider).toBeInstanceOf(Provider);
    expect(provider).not.toBeInstanceOf(FallbackProvider);
    expect(provider.name).toBe("deepseek");
  } finally {
    if (prevDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevDeepseek;
    if (prevFallback === undefined) delete process.env.NYRA_FALLBACK;
    else process.env.NYRA_FALLBACK = prevFallback;
    if (prevChain === undefined) delete process.env.NYRA_FALLBACK_PROVIDERS;
    else process.env.NYRA_FALLBACK_PROVIDERS = prevChain;
    cleanup(home);
  }
});

// ---- REPL /model 真测 ---------------------------------------------------------
//
// 注意：readline 的 question 只接下一个 line 事件——输入一次全灌进去时，
// 还没轮到 question 的行会被丢掉。所以这里逐行写、每行等下一个 "> "
// 提示符出现再写下一行（与真人逐行输入同节奏）。

async function runReplLines(lines: string[], home: string): Promise<{ code: number | null; out: string }> {
  const child = spawn("bun", ["run", "src/cli.ts", "--lang", "zh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      NYRA_HOME: join(home, ".nyra"),
      DEEPSEEK_API_KEY: "sk-test-deepseek",
      XAI_API_KEY: "sk-test-xai",
      NYRA_FALLBACK: undefined,
      NYRA_FALLBACK_PROVIDERS: undefined,
    },
  });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
  child.stderr?.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
  const done = new Promise<number | null>((resolvePromise) => child.on("close", (code) => resolvePromise(code)));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const countPrompts = () => out.split("> ").length - 1;
  const waitPrompt = async (target: number, timeoutMs = 15000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (countPrompts() >= target) return true;
      await sleep(100);
    }
    return false;
  };
  try {
    await waitPrompt(1);
    for (const line of lines) {
      const before = countPrompts();
      child.stdin?.write(line + "\n");
      if (line === "/exit") break;
      await waitPrompt(before + 1);
    }
  } finally {
    child.stdin?.end();
  }
  const code = await Promise.race([
    done,
    sleep(10000).then(() => { child.kill(); return -1; }),
  ]);
  return { code, out };
}

test("REPL /model: 查看当前模型、切到 xai、切回 deepseek，历史不丢", async () => {
  const home = tmpRoot("nyra-switch-repl-");
  try {
    const r = await runReplLines(["/model", "/model xai", "/model", "/model deepseek:deepseek-flash", "/exit"], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("当前模型：deepseek / deepseek-flash");
    expect(r.out).toContain("允许切换：deepseek、xai、ollama");
    expect(r.out).toContain("用量触顶自动换：未开启");
    expect(r.out).toContain("已切换模型：deepseek / deepseek-flash → xai / grok-4.3");
    expect(r.out).toContain("当前模型：xai / grok-4.3");
    expect(r.out).toContain("已切换模型：xai / grok-4.3 → deepseek / deepseek-flash");
  } finally {
    cleanup(home);
  }
});

test("REPL /model: 不在允许列表的 provider 拒绝切换", async () => {
  const home = tmpRoot("nyra-switch-repl-");
  try {
    const r = await runReplLines(["/model openai", "/model nope", "/exit"], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("切换模型失败");
    expect(r.out).toContain("不在允许列表内");
    expect(r.out).toContain("Unknown provider: nope");
  } finally {
    cleanup(home);
  }
});
