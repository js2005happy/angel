// src/bot/index.ts — Bot 方向 Phase 1：消息处理主链路 + CLI 入口。
//
// 主链路（按用户给的架构，Phase 1 的部分）：
//   验签与解析（适配器）→ 幂等去重 → 确定性指令优先 → 群聊 @ 过滤 →
//   配额 → 会话排队 → 占位“处理中…” → Agent 执行 → 分片回发。
//
// 取消与超时的诚实边界：Agent.run 本身不支持 AbortSignal（provider 的
// chat 只在重试等待里认信号），所以 /stop 与超时只能做到：
//   1. 排队中的任务直接出队；
//   2. 在跑的任务：不再等它的结果、不回发；后台的模型调用会跑完，但结
//      果丢弃、Agent 实例丢弃；
//   3. 会话文件按下达取消前的快照恢复（取消瞬间恢复一次；后台调用结束
//      后若没有更新的任务再恢复一次，免得半截对话污染历史）。
//   彻底的中断要等 Agent 层接 AbortSignal（以后单独一批），不是本批
//   假装能做到的事。
//
// 权限：Bot 的 Agent 强制 readonly（外部用户默认最小权限：只读/知识库/
// 查询）；高危写操作本批不开放，/approve 与 /reject 只回“Phase 2 再做”
// 的说明，不放行任何动作。模型兜底链不进 Bot（单 provider，绝不自动换
// 模型）；月度硬顶与单次硬顶走 Agent 自带的 checkCost，与 CLI 同口径。
//
// 证据：每条处理过的消息写一行 `~/.nyra/bot-audit.jsonl`（只记 channel、
// sessionKey、messageId、结论、字数、花费、错误原因，不记用户原文与
// token；与 mcp-server-audit.jsonl 同款做法）。本批不发 RunStore 事件，
// 所以不在 EVENT_FIELDS 里加新事件（没发出的事件不需要注册）。
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "../agent.ts";
import { loadConfig, resolveHome, resolveProvider, resolveSandbox } from "../config.ts";
import { resolveEnforced } from "../enforcedConfig.ts";
import { getFileKey, maskKey } from "../keystore.ts";
import { getCredential } from "../vault.ts";
import { resolvePricing, resolveMonthlyLimit } from "../cost.ts";
import { McpCostTracker } from "../mcpCost.ts";
import { loadSession, resolveNyraHome, saveSession, sessionPath } from "../memory.ts";
import { buildProviderChain } from "../providers.ts";
import { resolveReviewerModel } from "../reviewer.ts";
import { monthKeyString, UsageLedger } from "../usageLedger.ts";
import type { UsageSnapshot } from "../usage.ts";
import { DedupStore, QuotaStore } from "./dedupAndQuota.ts";
import { splitMessage } from "./formatter.ts";
import { SessionQueue } from "./sessionQueue.ts";
import { TelegramAdapter } from "./channels/telegram.ts";
import {
  botPolicyFromConfig,
  memorySessionIdFor,
  sessionKeyFor,
  type BotPolicy,
  type ChannelAdapter,
  type InboundMessage,
} from "./types.ts";

export const BOT_AUDIT_FILE = "bot-audit.jsonl";
export const BOT_TELEGRAM_PID_FILE = "bot-telegram.pid";
export const TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";
/**
 * 密码箱/keys.json 里的条目名就是环境变量名（与 keystore 的口径一致：
 * `telegram-bot-token` 这种小写连字符名过不了 validEnvName，进不了
 * keys.json；webhook-secret 这类例外只走密码箱，不走 keys.json）。
 */
export const TELEGRAM_TOKEN_KEY = "TELEGRAM_BOT_TOKEN";

export interface AgentRunResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  spentUsd: number | null;
}

export type AgentRunFn = (sessionKey: string, text: string, signal: AbortSignal) => Promise<AgentRunResult>;

export interface BotRunnerOptions {
  home: string;
  workdir: string;
  config: Record<string, unknown>;
  adapter: ChannelAdapter;
  /** 注入的模型执行（测试用假 runner；不传用真 Agent）。 */
  agentRun?: AgentRunFn;
}

export interface BotStatus {
  running: boolean;
  model: string | null;
  queueDepth: number;
  activeSessions: string[];
  todaySpentUsd: number;
  dedupSize: number;
  monthlySpentUsd: number | null;
  monthlyLimitUsd: number | null;
}

interface AuditRecord {
  ts: string;
  channel: string;
  session_key: string;
  message_id: string;
  outcome: string;
  chars?: number;
  spent_usd?: number | null;
  error?: string;
}

function appendAudit(home: string, rec: AuditRecord): void {
  try {
    const dir = resolveNyraHome(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, BOT_AUDIT_FILE);
    appendFileSync(path, JSON.stringify(rec) + "\n", { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") { try { chmodSync(path, 0o600); } catch { /* ignore */ } }
  } catch { /* 审计写失败不破坏消息处理 */ }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 解析行首的确定性指令：`/help`、`/help@BotName` 都认；正文里的 `/x` 不算。 */
export function parseBotCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const first = trimmed.split(/\s+/)[0] ?? "";
  const body = first.slice(1);
  if (!body) return null;
  const at = body.indexOf("@");
  const command = (at >= 0 ? body.slice(0, at) : body).toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(command)) return null;
  return { command, args: trimmed.slice(first.length).trim() };
}

export class BotRunner {
  readonly home: string;
  readonly workdir: string;
  readonly config: Record<string, unknown>;
  readonly policy: BotPolicy;
  readonly adapter: ChannelAdapter;
  readonly queue = new SessionQueue();
  readonly dedup: DedupStore;
  readonly quota: QuotaStore;
  readonly modelName: string | null;
  private readonly agentRunFn: AgentRunFn;
  private agents = new Map<string, Agent>();
  /** 每会话上次 flush 的用量快照（delta 制记账，与 CLI 的 makeUsageFlusher 同口径）。 */
  private lastSnap = new Map<string, UsageSnapshot>();
  private lastSpent = new Map<string, number | null>();
  private flushedUsd = 0;
  private ledger: UsageLedger;
  /** 取消过的会话（后台调用结束后的恢复守门：epoch 变了说明已有新任务，不恢复）。 */
  private abortEpochs = new Map<string, number>();
  private running = false;
  private stopController: AbortController | null = null;

  constructor(opts: BotRunnerOptions) {
    this.home = opts.home;
    this.workdir = opts.workdir;
    this.config = opts.config;
    this.policy = botPolicyFromConfig(opts.config);
    this.adapter = opts.adapter;
    this.dedup = new DedupStore(opts.home);
    this.quota = new QuotaStore(opts.home);
    this.ledger = new UsageLedger(opts.home);
    let model: string | null = null;
    try {
      const cfg = resolveProvider({ home: opts.home, config: opts.config });
      model = `${cfg.name}:${cfg.model}`;
    } catch { /* 模型名拿不到时 /model 如实说未配置 */ }
    this.modelName = model;
    this.agentRunFn = opts.agentRun ?? ((k, t, s) => this.runRealAgent(k, t, s));
  }

  // -- Agent 执行（复用 agent.ts / tools.ts 的执行路径，不另起执行器） ----

  private buildAgent(sessionKey: string): Agent {
    const sessionId = memorySessionIdFor(sessionKey);
    const primaryCfg = resolveProvider({ home: this.home, config: this.config });
    const provider = buildProviderChain(primaryCfg, [primaryCfg.name], null, {
      resolver: (name: string) => resolveProvider({ home: this.home, config: this.config, providerName: name }),
    });
    const hasCredentials = (provider as unknown as { hasCredentials?: () => boolean }).hasCredentials;
    if (typeof hasCredentials === "function" && !hasCredentials.call(provider)) {
      throw new Error("未找到可用的模型 API 凭据：请先配好 provider 的 Key");
    }
    const sandbox = resolveSandbox(this.config);
    const monthlyLimit = resolveMonthlyLimit(this.config);
    const monthlySpentBeforeUsd = monthlyLimit === null ? null : (): { spentUsd: number; incomplete: boolean } | null => {
      try {
        const llm = this.ledger.monthTotal(monthKeyString());
        const mcp = new McpCostTracker(this.home).monthTotalUsd(monthKeyString());
        return { spentUsd: llm.spentUsd + mcp - this.flushedUsd, incomplete: llm.incomplete };
      } catch {
        return null;
      }
    };
    return new Agent(provider, {
      workdir: this.workdir,
      // 外部用户强制只读：只读/知识库/查询，高危写操作本批不开放。
      mode: "readonly",
      maxTurns: this.policy.maxTurns,
      sessionId,
      interactive: false,
      messages: loadSession(sessionId, this.home),
      channel: this.adapter.channel,
      home: this.home,
      maxCostUsd: (() => {
        const enf = resolveEnforced(this.config).values;
        if (typeof enf.max_cost_usd === "number") return enf.max_cost_usd;
        return typeof this.config.max_cost_usd === "number" ? (this.config.max_cost_usd as number) : null;
      })(),
      pricing: resolvePricing(this.config.pricing, primaryCfg.model),
      monthlyCostLimitUsd: monthlyLimit,
      monthlySpentBeforeUsd,
      reviewerModel: resolveReviewerModel(this.config).model,
      sandbox: { backend: sandbox.backend, mode: sandbox.mode as "read-only" | "workspace-write" | "danger-full-access", allowNet: sandbox.allowNet },
    });
  }

  private getAgent(sessionKey: string): Agent {
    const cached = this.agents.get(sessionKey);
    if (cached) return cached;
    const agent = this.buildAgent(sessionKey);
    this.agents.set(sessionKey, agent);
    return agent;
  }

  private flushUsage(sessionKey: string, agent: Agent): void {
    try {
      const snap = agent.usage.snapshot();
      const spent = agent.lastCost?.status === "priced" ? agent.lastCost.spentUsd : null;
      const rec = this.ledger.recordDelta(snap, this.lastSnap.get(sessionKey) ?? null, spent, this.lastSpent.get(sessionKey) ?? null, agent.provider.model);
      if (rec && rec.spent_usd !== null) this.flushedUsd += rec.spent_usd;
      this.lastSnap.set(sessionKey, snap);
      this.lastSpent.set(sessionKey, spent);
    } catch { /* 账本写失败不破坏回复 */ }
  }

  /**
   * 真 Agent 执行：取消信号与 agent.run race；取消后丢弃结果、丢弃 Agent
   * 实例、恢复取消前的会话快照（恢复守门见 runAgent 的 epoch 逻辑）。
   */
  private async runRealAgent(sessionKey: string, text: string, signal: AbortSignal): Promise<AgentRunResult> {
    const sessionId = memorySessionIdFor(sessionKey);
    const snapshotBefore = loadSession(sessionId, this.home);
    const epoch = (this.abortEpochs.get(sessionKey) ?? 0) + 1;
    this.abortEpochs.set(sessionKey, epoch);
    const agent = this.getAgent(sessionKey);
    const beforeSnap = agent.usage.snapshot();
    const beforeSpent = agent.lastCost?.status === "priced" ? agent.lastCost.spentUsd : null;
    const runPromise = agent.run(text);
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(new Error("已取消"));
      else signal.addEventListener("abort", () => reject(new Error("已取消")), { once: true });
    });
    let resultText: string;
    try {
      resultText = await Promise.race([runPromise, aborted]);
    } catch (err) {
      // 取消后：丢弃 Agent 实例；后台调用结束后再恢复一次快照（epoch 没变才恢复）。
      this.agents.delete(sessionKey);
      try { saveSession(sessionId, snapshotBefore ?? [], this.home); } catch { /* ignore */ }
      void runPromise.then(
        () => { if (this.abortEpochs.get(sessionKey) === epoch) { try { saveSession(sessionId, snapshotBefore ?? [], this.home); } catch { /* ignore */ } } },
        () => {},
      );
      throw err;
    }
    this.flushUsage(sessionKey, agent);
    const snap = agent.usage.snapshot();
    const spent = agent.lastCost?.status === "priced" ? agent.lastCost.spentUsd : null;
    return {
      text: resultText,
      promptTokens: Math.max(0, (snap.prompt_tokens ?? 0) - (beforeSnap.prompt_tokens ?? 0)),
      completionTokens: Math.max(0, (snap.completion_tokens ?? 0) - (beforeSnap.completion_tokens ?? 0)),
      spentUsd: spent !== null && beforeSpent !== null ? Math.max(0, spent - beforeSpent) : spent,
    };
  }

  private restoreSession(sessionKey: string): void {
    const sessionId = memorySessionIdFor(sessionKey);
    try {
      const path = sessionPath(sessionId, this.home);
      if (existsSync(path)) rmSync(path);
    } catch { /* ignore */ }
    this.agents.delete(sessionKey);
    this.lastSnap.delete(sessionKey);
    this.lastSpent.delete(sessionKey);
  }

  // -- 确定性指令（不走模型、不扣 token、不计配额） ----

  private helpText(): string {
    return [
      "Nyra Bot（Phase 1）：外部用户默认只读，只能问答与查询，不能写文件、跑命令。",
      "命令：",
      "/help — 本帮助",
      "/status — 运行状态、队列深度、今日花费",
      "/new — 开新会话（清除当前会话历史）",
      "/stop — 停止当前正在处理的任务",
      "/model — 当前用的模型",
      "/approve <id>、/reject <id> — 审批在 Phase 2 提供，本批暂未开放",
      "群聊里只有 @ 我时才回复；私聊直接发消息就行。",
    ].join("\n");
  }

  private statusText(): string {
    const st = this.status();
    const lines = [
      "Nyra Bot 运行状态：",
      `模型：${st.model ?? "未配置"}`,
      `队列深度：共 ${st.queueDepth}（进行中会话：${st.activeSessions.length ? st.activeSessions.join("、") : "无"}）`,
      `今日 token 花费：${st.todaySpentUsd > 0 ? `$${st.todaySpentUsd.toFixed(4)}` : "无"}`,
      `本月已花：${st.monthlySpentUsd !== null ? `$${st.monthlySpentUsd.toFixed(4)}` : "未知（未计价）"}${st.monthlyLimitUsd !== null ? ` / 上限 $${st.monthlyLimitUsd.toFixed(2)}` : "（未设上限）"}`,
      `去重记录：${st.dedupSize} 条`,
    ];
    return lines.join("\n");
  }

  private async handleCommand(msg: InboundMessage, command: string, args: string): Promise<void> {
    const key = sessionKeyFor(msg);
    const reply = async (text: string): Promise<void> => {
      await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text });
    };
    let outcome = `command:${command}`;
    switch (command) {
      case "help":
        await reply(this.helpText());
        break;
      case "status":
        await reply(this.statusText());
        break;
      case "new": {
        this.restoreSession(key);
        await reply("已开启新会话，之前的内容已清除。");
        break;
      }
      case "stop": {
        const { cancelledActive, cancelledQueued } = this.queue.cancel(key);
        if (!cancelledActive && cancelledQueued === 0) {
          await reply("没有正在处理的任务。");
        } else {
          await reply("已停止当前任务。");
        }
        outcome = "command:stop";
        break;
      }
      case "model":
        await reply(`当前模型：${this.modelName ?? "未配置"}`);
        break;
      case "approve":
      case "reject":
        await reply(`审批功能在 Phase 2（approvalBridge）提供，本批暂未开放${args ? `（收到的 id：${args}）` : ""}。`);
        break;
      default:
        // 未知指令不进模型、不报错刷屏：只回一句帮助入口。
        await reply("未知指令。发 /help 看能用的命令。");
        outcome = "command:unknown";
        break;
    }
    appendAudit(this.home, { ts: new Date().toISOString(), channel: msg.channel, session_key: key, message_id: msg.messageId, outcome });
  }

  // -- 主链路 ----

  status(): BotStatus {
    let monthlySpent: number | null = null;
    try {
      monthlySpent = this.ledger.monthTotal(monthKeyString()).spentUsd;
    } catch { /* ignore */ }
    return {
      running: this.running,
      model: this.modelName,
      queueDepth: this.queue.totalDepth(),
      activeSessions: this.queue.activeKeys(),
      todaySpentUsd: this.quota.dailySpentUsd(),
      dedupSize: this.dedup.size(),
      monthlySpentUsd: monthlySpent,
      monthlyLimitUsd: resolveMonthlyLimit(this.config),
    };
  }

  async handleMessage(msg: InboundMessage): Promise<void> {
    const key = sessionKeyFor(msg);
    const dedupKey = `${msg.channel}:${msg.messageId}`;
    if (this.dedup.checkAndMark(dedupKey)) {
      appendAudit(this.home, { ts: new Date().toISOString(), channel: msg.channel, session_key: key, message_id: msg.messageId, outcome: "duplicate" });
      return;
    }
    const audit = (outcome: string, extra?: Partial<AuditRecord>): void => {
      appendAudit(this.home, { ts: new Date().toISOString(), channel: msg.channel, session_key: key, message_id: msg.messageId, outcome, ...extra });
    };
    // 确定性指令优先：不走模型、不扣 token、不计配额。
    const cmd = parseBotCommand(msg.text);
    if (cmd) {
      await this.handleCommand(msg, cmd.command, cmd.args);
      return;
    }
    // 群聊 @ 过滤（mentionOnly 默认开；私聊不受影响）。
    if ((msg.chatType === "group" || msg.chatType === "supergroup") && this.policy.mentionOnly && !msg.isMentioned) {
      audit("ignored:not-mentioned");
      return;
    }
    // 纯附件、没有正文：Phase 1 不解析附件，老实说。
    if (!msg.text.trim()) {
      if (msg.attachments.length > 0) {
        await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: "收到附件了，但本批暂不支持解析图片/文件内容；请用文字描述你要做的事。" });
        audit("notice:attachment");
      } else {
        audit("ignored:empty");
      }
      return;
    }
    // 配额三档（用户/天、群聊/分钟、当天 token 预算）。
    const senderKey = `${msg.channel}:${msg.senderId}`;
    if (!this.quota.userAllowed(senderKey, this.policy.perUserDailyLimit)) {
      await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: `今天的消息额度已用完（每人每天 ${this.policy.perUserDailyLimit} 条），明天再来。` });
      audit("blocked:quota-user");
      return;
    }
    if (!this.quota.chatMinuteAllowed(key, this.policy.perChatPerMinuteLimit)) {
      audit("blocked:quota-chat");
      return;
    }
    if (!this.quota.budgetAllowed(this.policy.dailyTokenBudgetUsd)) {
      await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: "今天的 token 预算已用完，明天再来。" });
      audit("blocked:quota-budget");
      return;
    }
    // 先发占位，再排队（排队久的用户也知道 Bot 收到了）。
    let placeholderId: string;
    try {
      placeholderId = await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: "处理中…" });
    } catch (err) {
      audit("error:placeholder", { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.quota.recordUser(senderKey);
    const replied = { done: false };
    const result = await this.queue.enqueue(key, async (signal) => {
      try {
        const res = await this.agentRunFn(key, msg.text, signal);
        if (signal.aborted) return;
        this.quota.recordSpent(res.spentUsd);
        const chunks = splitMessage(res.text || "（没有返回内容）");
        await this.adapter.editText(msg.chatId, placeholderId, chunks[0]);
        replied.done = true;
        for (const chunk of chunks.slice(1)) {
          await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: chunk });
        }
        audit("ok", { chars: res.text.length, spent_usd: res.spentUsd });
      } catch (err) {
        const reason = this.queue.abortReason(key);
        if (signal.aborted || reason) {
          const text = reason === "timeout" ? "处理超时，已取消。" : "已停止。";
          try { await this.adapter.editText(msg.chatId, placeholderId, text); } catch { /* ignore */ }
          replied.done = true;
          audit("cancelled", { error: reason ?? "aborted" });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        try { await this.adapter.editText(msg.chatId, placeholderId, `处理失败：${message}`); } catch { /* ignore */ }
        replied.done = true;
        audit("error:agent", { error: message });
      }
    }, { timeoutMs: this.policy.timeoutMs });
    if (result === "cancelled" && !replied.done) {
      // 排队时被 /stop 取消：任务函数没跑过，占位还挂着，这里收尾。
      try { await this.adapter.editText(msg.chatId, placeholderId, "已取消。"); } catch { /* ignore */ }
      audit("cancelled:queued");
    }
  }

  // -- 轮询循环 ----

  async startPolling(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopController = new AbortController();
    try {
      await this.adapter.getMe?.();
    } catch { /* username 拿不到不影响运行：@ 判定退化为看文本里的 @ */ }
    let backoffMs = 1000;
    while (this.running) {
      try {
        const msgs = await this.adapter.pollOnce(this.stopController.signal);
        backoffMs = 1000;
        for (const m of msgs) {
          void this.handleMessage(m).catch((err) => {
            process.stderr.write(`Bot 处理消息失败：${err instanceof Error ? err.message : String(err)}\n`);
          });
        }
      } catch (err) {
        if (!this.running) break;
        process.stderr.write(`Bot 轮询失败（${backoffMs}ms 后重试）：${err instanceof Error ? err.message : String(err)}\n`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
      }
    }
  }

  stopPolling(): void {
    this.running = false;
    this.stopController?.abort();
    this.stopController = null;
  }
}

// -- Token 解析（环境变量 > 密码箱 > keys.json；绝不硬编码、不记日志） ----

export function resolveTelegramToken(home: string): { token: string | null; source: "env" | "vault" | "file" | "missing" } {
  const env = process.env[TELEGRAM_TOKEN_ENV];
  if (env && env.trim()) return { token: env.trim(), source: "env" };
  const vaultToken = getCredential(TELEGRAM_TOKEN_KEY, home);
  if (vaultToken) return { token: vaultToken, source: "vault" };
  const file = getFileKey(TELEGRAM_TOKEN_KEY, home);
  if (file) return { token: file, source: "file" };
  return { token: null, source: "missing" };
}

function pidPath(home: string): string {
  return join(resolveNyraHome(home), BOT_TELEGRAM_PID_FILE);
}

function readPid(home: string): number | null {
  try {
    const raw = readFileSync(pidPath(home), "utf-8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePid(home: string): void {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(pidPath(home), `${process.pid}\n`, { encoding: "utf-8", mode: 0o600 });
}

function removePid(home: string): void {
  try { rmSync(pidPath(home), { force: true }); } catch { /* ignore */ }
}

// -- CLI：nyra bot telegram <start|stop|status> ----

export async function handleBot(argv: string[], home: string): Promise<number> {
  const resolvedHome = home || resolveHome();
  const channel = argv[0];
  const action = argv[1];
  if (channel !== "telegram" || !action) {
    process.stdout.write("用法：nyra bot telegram <start|stop|status>\n");
    return 2;
  }
  if (action === "stop") {
    const pid = readPid(resolvedHome);
    if (pid === null || !pidAlive(pid)) {
      if (pid !== null) removePid(resolvedHome);
      process.stdout.write("Telegram Bot 未在运行。\n");
      return 0;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      process.stderr.write(`停止失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    removePid(resolvedHome);
    process.stdout.write(`已停止 Telegram Bot（pid ${pid}）。\n`);
    return 0;
  }
  if (action === "status") {
    const pid = readPid(resolvedHome);
    const alive = pid !== null && pidAlive(pid);
    const token = resolveTelegramToken(resolvedHome);
    const config = loadConfig(resolvedHome);
    const quota = new QuotaStore(resolvedHome);
    const dedup = new DedupStore(resolvedHome);
    let monthlySpent: number | null = null;
    try {
      monthlySpent = new UsageLedger(resolvedHome).monthTotal(monthKeyString()).spentUsd;
    } catch { /* ignore */ }
    process.stdout.write(`Telegram Bot：${alive ? `运行中（pid ${pid}）` : "未运行"}\n`);
    process.stdout.write(`Token：${token.token ? `已配置（${token.source}，${maskKey(token.token)}）` : "未配置（环境变量 TELEGRAM_BOT_TOKEN，或 nyra vault add TELEGRAM_BOT_TOKEN）"}\n`);
    process.stdout.write(`今日 token 花费：${quota.dailySpentUsd() > 0 ? `$${quota.dailySpentUsd().toFixed(4)}` : "无"}\n`);
    process.stdout.write(`本月已花：${monthlySpent !== null ? `$${monthlySpent.toFixed(4)}` : "未知（未计价）"}\n`);
    process.stdout.write(`去重记录：${dedup.size()} 条\n`);
    process.stdout.write(`详情见 docs/bot.md。\n`);
    return 0;
  }
  if (action === "start") {
    const pid = readPid(resolvedHome);
    if (pid !== null && pidAlive(pid)) {
      process.stderr.write(`Telegram Bot 已在运行（pid ${pid}），先 nyra bot telegram stop 再启动。\n`);
      return 1;
    }
    if (pid !== null) removePid(resolvedHome);
    const token = resolveTelegramToken(resolvedHome);
    if (!token.token) {
      process.stderr.write("未找到 Telegram Bot token：先在 @BotFather 建机器人，再用环境变量 TELEGRAM_BOT_TOKEN 或 nyra vault add TELEGRAM_BOT_TOKEN 存 token（详见 docs/bot.md）。\n");
      return 1;
    }
    const config = loadConfig(resolvedHome);
    const adapter = new TelegramAdapter({ token: token.token });
    const runner = new BotRunner({ home: resolvedHome, workdir: process.cwd(), config, adapter });
    writePid(resolvedHome);
    process.stdout.write(`Telegram Bot 已启动（pid ${process.pid}，模型：${runner.modelName ?? "未配置"}）。Ctrl+C 停止，或 nyra bot telegram stop。\n`);
    const shutdown = (): void => {
      runner.stopPolling();
      removePid(resolvedHome);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await runner.startPolling();
    removePid(resolvedHome);
    return 0;
  }
  process.stdout.write("用法：nyra bot telegram <start|stop|status>\n");
  return 2;
}
