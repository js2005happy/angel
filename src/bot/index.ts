// src/bot/index.ts — Bot 方向 Phase 3：notifier 主动推送 + 附件处理。
//
// 主链路（Phase 3）：
//   验签与解析（适配器）→ 幂等去重 → 角色路由（router：owner/admin/member/
//   guest）→ 确定性指令优先（/approve、/reject 接真逻辑）→ 群聊 @ 过滤 →
//   配额（用户/天、群聊/分钟、当天预算）→ 月度硬顶预检 → 附件处理
//   （文本文档提取进上下文，图片只记元信息）→ 会话排队 → 占位
//   “处理中…” → Agent 执行（画像定 mode：guest/member 只读，owner/
//   admin 的写操作逐次走 approvalBridge 聊天内审批）→ 分片回发。
//   另有一条不进主链路的推送线：notifier（Heartbeat 静默巡查 + Watch
//   文件变化 + 定时/队列任务结果），默认全关，见 notifier.ts。
//
// 取消与超时的诚实边界：与 Phase 1 相同（/stop 与超时不能真中断在跑的
// 模型调用，只能不等结果、不回发、丢弃 Agent 实例、按取消前快照恢复会话
// 文件）；本批多了一条：取消时同会话的挂起审批一并取消（bridge.
// cancelSession），免得晚一步点的“批准”复活已经没了的任务。审批本身
// 也有 TTL（默认 60 秒，可配），超时自动拒绝。
//
// 权限：角色只认 config 的 bot.owner / bot.admins / bot.members（见
// router.ts）；白名单两道门（Agent 的 disabledTools 不让工具进模型，
// approveFn 里再查一次 isToolAllowed）；审批默认关闭——owner/admin
// 都没配时谁也批不了，写操作一律拒绝。模型兜底链不进 Bot（单 provider，
// 绝不自动换模型）；月度硬顶与单次硬顶走 Agent 自带的 checkCost，另加
// 一道执行前预检（本月已花 ≥ 上限时直接回绝、不进模型）。
//
// 证据：每条处理过的消息写一行 `~/.nyra/bot-audit.jsonl`（只记 channel、
// sessionKey、messageId、结论、字数、花费、错误原因，不记用户原文与
// token；与 mcp-server-audit.jsonl 同款做法）；审批结论另记运行事件
// bot_approval_requested / bot_approval_decided（有运行目录时写它的
// events.jsonl，没有时写 evidence/bot/ 下的证据文件，见 approvalBridge.ts
// 的 recordBotEvent）。
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type ApproveFn } from "../agent.ts";
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
import { ApprovalBridge, approvalArgsHash } from "./approvalBridge.ts";
import { processAttachments } from "./attachments.ts";
import { DedupStore, QuotaStore } from "./dedupAndQuota.ts";
import { splitMessage } from "./formatter.ts";
import { BotNotifier } from "./notifier.ts";
import { computerResourceSummary, handleComputer, listComputers } from "./computer.ts";
import { botToolRedlineVerdict, handleBusinessRedlines } from "../businessRedlines.ts";

/** 给 schedule daemon / task worker 共用（buildNotifierFromConfig 的返回类型）。 */
export { BotNotifier } from "./notifier.ts";
import { agentOptionsForProfile, isToolAllowed, profileForRole, resolveRole, type BotProfile, type BotRole } from "./router.ts";
import { SessionQueue } from "./sessionQueue.ts";
import { TelegramAdapter } from "./channels/telegram.ts";
import { DiscordAdapter } from "./channels/discord.ts";
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
export const BOT_DISCORD_PID_FILE = "bot-discord.pid";
export const TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";
export const DISCORD_TOKEN_ENV = "DISCORD_BOT_TOKEN";
/**
 * 密码箱/keys.json 里的条目名就是环境变量名（与 keystore 的口径一致：
 * `telegram-bot-token` 这种小写连字符名过不了 validEnvName，进不了
 * keys.json；webhook-secret 这类例外只走密码箱，不走 keys.json）。
 */
export const TELEGRAM_TOKEN_KEY = "TELEGRAM_BOT_TOKEN";
export const DISCORD_TOKEN_KEY = "DISCORD_BOT_TOKEN";

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
  /** 当前挂起的审批数（/status 里能看到有没有等着批的）。 */
  pendingApprovals: number;
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
  /** 审批审计：审批 id、工具名、决定人、事件落点（events / evidence / none）。 */
  approval_id?: string;
  tool?: string;
  decided_by?: string;
  event_channel?: string;
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
  readonly bridge: ApprovalBridge;
  /** 场景 B 主动推送（Phase 3）：Heartbeat + Watch + 任务结果推送。 */
  readonly notifier: BotNotifier;
  readonly modelName: string | null;
  private readonly agentRunFn: AgentRunFn;
  /** 每会话一个 Agent 实例；角色变了就重建（画像、mode、白名单都跟着角色走）。 */
  private agents = new Map<string, { agent: Agent; role: BotRole }>();
  /** 每会话上次 flush 的用量快照（delta 制记账，与 CLI 的 makeUsageFlusher 同口径）。 */
  private lastSnap = new Map<string, UsageSnapshot>();
  private lastSpent = new Map<string, number | null>();
  private flushedUsd = 0;
  private ledger: UsageLedger;
  /** 取消过的会话（后台调用结束后的恢复守门：epoch 变了说明已有新任务，不恢复）。 */
  private abortEpochs = new Map<string, number>();
  /** 本次排队任务的请求上下文（chatId/threadId/发信人/画像；approveFn 靠它找审批提示该发去哪）。 */
  private sessionCtx = new Map<string, { chatId: string; threadId: string | null; senderId: string; profile: BotProfile }>();
  /** 审批过期扫荡的定时器（startPolling 起、stopPolling 停）。 */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** 主动推送的巡查定时器（startPolling 起、stopPolling 停；notifier 没开时不建）。 */
  private notifyTimer: ReturnType<typeof setInterval> | null = null;
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
    this.bridge = new ApprovalBridge({
      home: opts.home,
      policy: this.policy,
      send: (chatId, threadId, text, buttons) =>
        this.adapter.sendText({ chatId, threadId, text, inlineKeyboard: buttons }),
      edit: (chatId, messageId, text) => this.adapter.editText(chatId, messageId, text),
      audit: (outcome, extra) => {
        appendAudit(this.home, {
          ts: new Date().toISOString(),
          channel: this.adapter.channel,
          session_key: typeof extra.session_key === "string" ? extra.session_key : "",
          message_id: typeof extra.approval_id === "string" ? extra.approval_id : "",
          outcome,
          approval_id: typeof extra.approval_id === "string" ? extra.approval_id : undefined,
          tool: typeof extra.tool === "string" ? extra.tool : undefined,
          decided_by: typeof extra.decided_by === "string" ? extra.decided_by : undefined,
          event_channel: typeof extra.event_channel === "string" ? extra.event_channel : undefined,
        });
      },
    });
    this.ledger = new UsageLedger(opts.home);
    // Phase 3：主动推送（Heartbeat + Watch + 任务结果）。notifier 自己
    // 认 enabled / owner / target_chat_id 三个开的条件，缺一个就不推。
    this.notifier = new BotNotifier({
      home: opts.home,
      policy: this.policy.notifier,
      owner: this.policy.owner,
      send: (chatId, threadId, text) => this.adapter.sendText({ chatId, threadId, text }),
      audit: (outcome, extra) => {
        appendAudit(this.home, {
          ts: new Date().toISOString(),
          channel: this.adapter.channel,
          session_key: typeof extra.session_key === "string" ? extra.session_key : "",
          message_id: "",
          outcome,
        });
      },
      state: () => {
        const monthly = this.monthSpentBeforeUsd();
        return {
          monthlySpentUsd: monthly !== null ? monthly.spentUsd : null,
          monthlyLimitUsd: resolveMonthlyLimit(this.config),
          dailySpentUsd: this.quota.dailySpentUsd(),
          dailyBudgetUsd: this.policy.dailyTokenBudgetUsd,
          pendingApprovals: this.bridge.pendingCount(),
          oldestPendingApprovalMs: this.bridge.oldestPendingAgeMs(),
          queueDepth: this.queue.totalDepth(),
        };
      },
    });
    let model: string | null = null;
    try {
      const cfg = resolveProvider({ home: opts.home, config: opts.config });
      model = `${cfg.name}:${cfg.model}`;
    } catch { /* 模型名拿不到时 /model 如实说未配置 */ }
    this.modelName = model;
    this.agentRunFn = opts.agentRun ?? ((k, t, s) => this.runRealAgent(k, t, s));
  }

  // -- Agent 执行（复用 agent.ts / tools.ts 的执行路径，不另起执行器） ----

  /** 本月已花（用量账本 LLM + MCP − 本进程已 flush 的，避免重复算；算不出返回 null，不挡人）。 */
  private monthSpentBeforeUsd(): { spentUsd: number; incomplete: boolean } | null {
    try {
      const llm = this.ledger.monthTotal(monthKeyString());
      const mcp = new McpCostTracker(this.home).monthTotalUsd(monthKeyString());
      return { spentUsd: llm.spentUsd + mcp - this.flushedUsd, incomplete: llm.incomplete };
    } catch {
      return null;
    }
  }

  /**
   * Agent 的审批回调（checkApproval 经 approveFn 调到这里）：
   * 白名单外的工具直接拒绝、不建审批（第二道门）；白名单内的写操作建挂
   * 起审批、等聊天里的决定。放行只决定这一次调用能不能跑——花费照常
   * 进账本、月度/单次硬顶照常由 checkCost 在轮次里执行，审批绕不过配额。
   */
  private approveViaBridge(sessionKey: string, profile: BotProfile): ApproveFn {
    return async (tool, summary, details) => {
      // 缺口 51：业务动作硬红线——never 档直接拒绝、不建挂起审批（不浪费一次
      // 人工审批；即使已批准也不放行）。approve 档走下面的正常审批链。
      const redline = botToolRedlineVerdict(this.home, tool);
      if (redline?.blocked) {
        return { approved: false, feedback: `业务动作红线拦截：${redline.reason}` };
      }
      if (!isToolAllowed(profile, tool)) {
        return { approved: false, feedback: `工具 ${tool} 不在你的角色（${profile.role}）白名单里，不能执行。` };
      }
      if (!profile.canRequestApproval) {
        return { approved: false, feedback: "你的角色不能发起审批。" };
      }
      const ctx = this.sessionCtx.get(sessionKey);
      if (!ctx) {
        return { approved: false, feedback: "会话上下文丢失，无法发起审批。" };
      }
      const argsHash = approvalArgsHash({
        tool,
        command: (details as Record<string, unknown> | undefined)?.command,
        fileTarget: (details as Record<string, unknown> | undefined)?.fileTarget,
        cwd: (details as Record<string, unknown> | undefined)?.cwd,
      });
      const approval = await this.bridge.requestApproval({
        sessionKey,
        chatId: ctx.chatId,
        threadId: ctx.threadId,
        tool,
        summary,
        argsHash,
        requestedBy: ctx.senderId,
        requestedByRole: profile.role,
      });
      const decision = await this.bridge.waitForDecision(approval.id);
      if (decision.approved) return true;
      return { approved: false, feedback: decision.reason || "审批未通过。" };
    };
  }

  private buildAgent(sessionKey: string, profile: BotProfile): Agent {
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
    const monthlySpentBeforeUsd = monthlyLimit === null ? null : () => this.monthSpentBeforeUsd();
    // 画像定 Agent：mode / interactive / 白名单 / 系统提示词 / 步数都跟着角色走
    //（guest/member 只读；owner/admin 的写操作逐次走 approvalBridge）。
    const ao = agentOptionsForProfile(profile);
    return new Agent(provider, {
      workdir: this.workdir,
      mode: ao.mode,
      maxTurns: ao.maxTurns,
      sessionId,
      interactive: ao.interactive,
      approveFn: ao.interactive ? this.approveViaBridge(sessionKey, profile) : null,
      disabledTools: ao.disabledTools,
      systemInstructions: ao.systemInstructions,
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

  private getAgent(sessionKey: string, profile: BotProfile): Agent {
    const cached = this.agents.get(sessionKey);
    if (cached && cached.role === profile.role) return cached.agent;
    const agent = this.buildAgent(sessionKey, profile);
    this.agents.set(sessionKey, { agent, role: profile.role });
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
    const profile = this.sessionCtx.get(sessionKey)?.profile ?? profileForRole("guest", this.policy);
    const agent = this.getAgent(sessionKey, profile);
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
      // 取消后：丢弃 Agent 实例；同会话的挂起审批一并取消（免得晚一步点的
      // “批准”复活已经没了的任务）；后台调用结束后再恢复一次快照（epoch
      // 没变才恢复）。
      this.agents.delete(sessionKey);
      this.bridge.cancelSession(sessionKey, this.queue.abortReason(sessionKey) === "timeout" ? "处理超时，审批已取消。" : "任务已停止，审批已取消。");
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

  private helpText(profile: BotProfile): string {
    const roleDesc = { owner: "机主（全权）", admin: "管理员", member: "受信任用户", guest: "普通用户（只读）" }[profile.role];
    return [
      `Nyra Bot（Phase 3）：你的角色是${roleDesc}。`,
      "命令：",
      "/help — 本帮助",
      "/status — 运行状态、队列深度、今日花费、挂起审批",
      "/new — 开新会话（清除当前会话历史）",
      "/stop — 停止当前正在处理的任务",
      "/model — 当前用的模型",
      "/approve <id>、/reject <id> — 批准/拒绝一条挂起的审批（只有 owner/admin 能批；也可以点审批提示下的按钮）",
      "群聊里只有 @ 我时才回复；私聊直接发消息就行。",
      "附件：图片只记元信息（本批暂不支持看图），纯文本文档（.txt/.md 等）会提取内容一起处理。",
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
      `挂起审批：${st.pendingApprovals} 条`,
      `去重记录：${st.dedupSize} 条`,
    ];
    return lines.join("\n");
  }

  private async handleCommand(msg: InboundMessage, command: string, args: string, profile: BotProfile): Promise<void> {
    const key = sessionKeyFor(msg);
    const reply = async (text: string): Promise<void> => {
      await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text });
    };
    let outcome = `command:${command}`;
    switch (command) {
      case "help":
        await reply(this.helpText(profile));
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
      case "reject": {
        const id = args.split(/\s+/)[0] ?? "";
        if (!id) {
          await reply("用法：/approve <审批 id> 或 /reject <审批 id>（审批提示里有 id）。");
          outcome = "approval:missing-id";
          break;
        }
        const res = await this.bridge.decide(id, command === "approve", msg.senderId, msg.viaCallback ? "button" : "command");
        if (!res.ok) {
          if (res.reason === "not-approver") {
            await reply("只有管理员（owner/admin）能审批这条请求。");
            outcome = "approval:denied-not-approver";
          } else if (res.reason === "not-found") {
            await reply(`没找到审批 ${id}（可能已被清理）。`);
            outcome = "approval:not-found";
          } else {
            await reply(`审批 ${id} 已处理过，不能再批。`);
            outcome = "approval:not-pending";
          }
        } else {
          await reply(res.decision?.approved ? `已批准 ${id}。` : `已拒绝 ${id}。`);
          outcome = res.decision?.approved ? "approval:approved" : "approval:rejected";
        }
        if (msg.viaCallback && msg.callbackId) {
          try {
            await this.adapter.answerCallback?.(msg.callbackId, res.ok ? (res.decision?.approved ? "已批准" : "已拒绝") : "处理失败");
          } catch { /* 回 ack 失败不改变审批结论 */ }
        }
        break;
      }
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
      pendingApprovals: this.bridge.pendingCount(),
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
    // 角色路由（Phase 2）：画像跟着发信人走，guest 默认只读。
    const profile = profileForRole(resolveRole(msg, this.policy), this.policy, msg.chatId);
    // 确定性指令优先：不走模型、不扣 token、不计配额。
    const cmd = parseBotCommand(msg.text);
    if (cmd) {
      await this.handleCommand(msg, cmd.command, cmd.args, profile);
      return;
    }
    // 群聊 @ 过滤（mentionOnly 默认开；私聊不受影响）。
    if ((msg.chatType === "group" || msg.chatType === "supergroup") && this.policy.mentionOnly && !msg.isMentioned) {
      audit("ignored:not-mentioned");
      return;
    }
    // 空消息（没正文也没附件）直接忽略。
    if (!msg.text.trim() && msg.attachments.length === 0) {
      audit("ignored:empty");
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
    // 月度硬顶预检：本月已花 ≥ 上限时直接回绝、不进模型（轮次里的 checkCost 是第二道门；审批放行绕不过这两道）。
    const monthlyLimit = resolveMonthlyLimit(this.config);
    if (monthlyLimit !== null) {
      const spent = this.monthSpentBeforeUsd();
      if (spent !== null && spent.spentUsd >= monthlyLimit) {
        await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: `本月预算已用完（已花 $${spent.spentUsd.toFixed(4)} / 上限 $${monthlyLimit.toFixed(2)}），本月不再执行新任务。` });
        audit("blocked:monthly-budget");
        return;
      }
    }
    // Phase 3：附件处理（配额与月度预检之后——附件下载也要受配额约束，
    // 否则光发附件就能绕过限额刷下载）。文本文档提取进上下文，图片只
    // 记元信息；没正文、又没提取出可用内容时只回说明，不进模型。
    let effectiveText = msg.text;
    let attachmentNotices: string[] = [];
    if (msg.attachments.length > 0) {
      const attRes = await processAttachments(this.adapter, msg.attachments, {
        maxBytes: this.policy.attachmentMaxBytes,
        textChars: this.policy.attachmentTextChars,
      });
      attachmentNotices = attRes.notices;
      if (attRes.extractedText) {
        effectiveText = effectiveText.trim()
          ? `${effectiveText}\n\n${attRes.extractedText}`
          : attRes.extractedText;
      }
      if (!effectiveText.trim()) {
        await this.adapter.sendText({ chatId: msg.chatId, threadId: msg.threadId, text: attachmentNotices.join("\n") });
        audit("notice:attachment");
        return;
      }
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
    // 请求上下文只在本次任务跑的时候挂在会话上（approveFn 靠它发审批提示）；
    // 同一会话的任务串行，任务开始时挂、结束时摘，不会被后一条消息提前覆盖。
    const ctx = { chatId: msg.chatId, threadId: msg.threadId, senderId: msg.senderId, profile };
    const result = await this.queue.enqueue(key, async (signal) => {
      this.sessionCtx.set(key, ctx);
      try {
        const res = await this.agentRunFn(key, effectiveText, signal);
        if (signal.aborted) return;
        this.quota.recordSpent(res.spentUsd);
        // 附件说明贴在回复前面（“已读取文档 X”“图片暂不支持看图”这类
        // 提示用户要看到；没附件时 notices 为空，回复原样不变）。
        const replyText = attachmentNotices.length
          ? `${attachmentNotices.join("\n")}\n\n${res.text || "（没有返回内容）"}`
          : (res.text || "（没有返回内容）");
        const chunks = splitMessage(replyText);
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
      } finally {
        if (this.sessionCtx.get(key) === ctx) this.sessionCtx.delete(key);
      }
    }, { timeoutMs: profile.timeoutMs });
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
    // 过期扫荡：把没人等、到期的挂起审批标 expired（等人的那个由 waitForDecision 自己的定时器处理）。
    this.bridge.sweepExpired();
    this.sweepTimer = setInterval(() => { this.bridge.sweepExpired(); }, 30000);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    // Phase 3：主动推送巡查（notifier 没开时不建定时器；tick 内部还会再
    // 认一次 enabled / owner / target，缺一个就不推）。
    if (this.policy.notifier.enabled) {
      this.notifyTimer = setInterval(() => {
        void this.notifier.tick().catch((err) => {
          process.stderr.write(`Bot 推送巡查失败：${err instanceof Error ? err.message : String(err)}\n`);
        });
      }, this.policy.notifier.heartbeatIntervalMs);
      if (typeof this.notifyTimer.unref === "function") this.notifyTimer.unref();
    }
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
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.notifyTimer) {
      clearInterval(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.stopController?.abort();
    this.stopController = null;
  }
}

// -- Token 解析（环境变量 > 密码箱 > keys.json；绝不硬编码、不记日志） ----

/**
 * Phase 3：给定时任务守护进程（`nyra schedule daemon`）与任务 worker
 * （`nyra task worker`）用的 notifier。notifier 开的条件（显式开 +
 * 配了 owner + 配了目标会话 + token 能拿到）缺一个就返回 null，调用
 * 方不推、不报错。daemon/worker 进程里没有 BotRunner 的活状态，tick
 * 只跑 watch；任务结果推送走 notifyTaskResult。
 */
export function buildNotifierFromConfig(home: string, config: Record<string, unknown>): BotNotifier | null {
  const policy = botPolicyFromConfig(config);
  if (!policy.notifier.enabled || policy.owner === null || policy.notifier.targetChatId === null) return null;
  const token = resolveTelegramToken(home);
  if (!token.token) return null;
  const adapter = new TelegramAdapter({ token: token.token });
  return new BotNotifier({
    home,
    policy: policy.notifier,
    owner: policy.owner,
    send: (chatId, threadId, text) => adapter.sendText({ chatId, threadId, text }),
    audit: (outcome) => {
      appendAudit(home, { ts: new Date().toISOString(), channel: "telegram", session_key: "", message_id: "", outcome });
    },
  });
}

export function resolveTelegramToken(home: string): { token: string | null; source: "env" | "vault" | "file" | "missing" } {
  const env = process.env[TELEGRAM_TOKEN_ENV];
  if (env && env.trim()) return { token: env.trim(), source: "env" };
  const vaultToken = getCredential(TELEGRAM_TOKEN_KEY, home);
  if (vaultToken) return { token: vaultToken, source: "vault" };
  const file = getFileKey(TELEGRAM_TOKEN_KEY, home);
  if (file) return { token: file, source: "file" };
  return { token: null, source: "missing" };
}

/** Discord Bot token 解析（与 Telegram 同款三来源：环境变量 → 密码箱 → 文件）。 */
export function resolveDiscordToken(home: string): { token: string | null; source: "env" | "vault" | "file" | "missing" } {
  const env = process.env[DISCORD_TOKEN_ENV];
  if (env && env.trim()) return { token: env.trim(), source: "env" };
  const vaultToken = getCredential(DISCORD_TOKEN_KEY, home);
  if (vaultToken) return { token: vaultToken, source: "vault" };
  const file = getFileKey(DISCORD_TOKEN_KEY, home);
  if (file) return { token: file, source: "file" };
  return { token: null, source: "missing" };
}

function pidPath(home: string, channel: "telegram" | "discord"): string {
  const file = channel === "telegram" ? BOT_TELEGRAM_PID_FILE : BOT_DISCORD_PID_FILE;
  return join(resolveNyraHome(home), file);
}

function readPid(home: string, channel: "telegram" | "discord"): number | null {
  try {
    const raw = readFileSync(pidPath(home, channel), "utf-8").trim();
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

function writePid(home: string, channel: "telegram" | "discord"): void {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(pidPath(home, channel), `${process.pid}\n`, { encoding: "utf-8", mode: 0o600 });
}

function removePid(home: string, channel: "telegram" | "discord"): void {
  try { rmSync(pidPath(home, channel), { force: true }); } catch { /* ignore */ }
}

// -- CLI：nyra bot telegram <start|stop|status> ----

/** `nyra bot status`：渠道（Telegram/Discord 运行态 + token 配置）+ 电脑总览（数量、醒/休眠、已声明内存）。 */
export function handleBotStatus(home: string): number {
  const resolvedHome = home || resolveHome();
  const config = loadConfig(resolvedHome);
  for (const channel of ["telegram", "discord"] as const) {
    const label = channel === "telegram" ? "Telegram" : "Discord";
    const pid = readPid(resolvedHome, channel);
    const alive = pid !== null && pidAlive(pid);
    const resolveToken = channel === "telegram" ? resolveTelegramToken : resolveDiscordToken;
    const token = resolveToken(resolvedHome);
    process.stdout.write(`${label} Bot：${alive ? `运行中（pid ${pid}）` : "未运行"}，Token：${token.token ? `已配置（${token.source}，${maskKey(token.token)}）` : "未配置"}\n`);
  }
  const summary = computerResourceSummary(resolvedHome);
  process.stdout.write(`电脑：${summary.computers} 台（醒着 ${summary.active}，休眠 ${summary.sleeping}），已声明内存 ${summary.declaredMemoryMb} MB / 上限 ${summary.memoryCapMb} MB（系统 ${summary.systemMemoryMb} MB 的 80%）\n`);
  if (summary.cpuOverSubscribed) {
    process.stdout.write(`注意：CPU 已超配（醒着的电脑共声明 ${summary.declaredCpuPercent}%，${summary.cpuCores} 核共 ${100 * summary.cpuCores}%），跑满时会互相抢。\n`);
  }
  const computers = listComputers(resolvedHome);
  for (const c of computers) {
    process.stdout.write(`- ${c.id}（${c.name}，agent ${c.agent}）— ${c.state === "active" ? "醒着" : "休眠"}，${c.isolation === "dedicated" ? "独占" : "共享"}\n`);
  }
  process.stdout.write("详情见 docs/bot.md 与 docs/bot-computer.md。\n");
  return 0;
}

export async function handleBot(argv: string[], home: string): Promise<number> {
  const resolvedHome = home || resolveHome();
  const channel = argv[0];
  // 缺口 51：业务动作硬红线表（`nyra bot redlines ...`；`nyra redlines` 是
  // 另一条命令——上线红线自检，不要混用）。
  if (channel === "redlines") {
    return handleBusinessRedlines(argv.slice(1), resolvedHome);
  }
  // 缺口 42 第一批：每 Bot 一台持久电脑（`nyra bot computer ...`）。
  if (channel === "computer") {
    return handleComputer(argv.slice(1), resolvedHome);
  }
  // 缺口 42 第一批：`nyra bot status`——渠道 + 电脑总览。
  if (channel === "status") {
    return handleBotStatus(resolvedHome);
  }
  const action = argv[1];
  if (channel !== "telegram" && channel !== "discord") {
    process.stdout.write("用法：nyra bot telegram <start|stop|status>\n       nyra bot discord <start|stop|status>\n       nyra bot computer <create|list|status|sleep|wake|remove|credential|shell|sleep-due>\n       nyra bot status\n       nyra bot redlines <status|list|show|tighten|loosen|set>\n");
    return 2;
  }
  if (!action) {
    process.stdout.write(`用法：nyra bot ${channel} <start|stop|status>\n`);
    return 2;
  }
  const label = channel === "telegram" ? "Telegram" : "Discord";
  const resolveToken = channel === "telegram" ? resolveTelegramToken : resolveDiscordToken;
  const tokenEnv = channel === "telegram" ? TELEGRAM_TOKEN_ENV : DISCORD_TOKEN_ENV;

  if (action === "stop") {
    const pid = readPid(resolvedHome, channel);
    if (pid === null || !pidAlive(pid)) {
      if (pid !== null) removePid(resolvedHome, channel);
      process.stdout.write(`${label} Bot 未在运行。\n`);
      return 0;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      process.stderr.write(`停止失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    removePid(resolvedHome, channel);
    process.stdout.write(`已停止 ${label} Bot（pid ${pid}）。\n`);
    return 0;
  }
  if (action === "status") {
    const pid = readPid(resolvedHome, channel);
    const alive = pid !== null && pidAlive(pid);
    const token = resolveToken(resolvedHome);
    const config = loadConfig(resolvedHome);
    const quota = new QuotaStore(resolvedHome);
    const dedup = new DedupStore(resolvedHome);
    let monthlySpent: number | null = null;
    try {
      monthlySpent = new UsageLedger(resolvedHome).monthTotal(monthKeyString()).spentUsd;
    } catch { /* ignore */ }
    process.stdout.write(`${label} Bot：${alive ? `运行中（pid ${pid}）` : "未运行"}\n`);
    process.stdout.write(`Token：${token.token ? `已配置（${token.source}，${maskKey(token.token)}）` : `未配置（环境变量 ${tokenEnv}，或 nyra vault add ${tokenEnv}）`}\n`);
    process.stdout.write(`今日 token 花费：${quota.dailySpentUsd() > 0 ? `$${quota.dailySpentUsd().toFixed(4)}` : "无"}\n`);
    process.stdout.write(`本月已花：${monthlySpent !== null ? `$${monthlySpent.toFixed(4)}` : "未知（未计价）"}\n`);
    process.stdout.write(`去重记录：${dedup.size()} 条\n`);
    process.stdout.write(`详情见 docs/bot.md。\n`);
    return 0;
  }
  if (action === "start") {
    const pid = readPid(resolvedHome, channel);
    if (pid !== null && pidAlive(pid)) {
      process.stderr.write(`${label} Bot 已在运行（pid ${pid}），先 nyra bot ${channel} stop 再启动。\n`);
      return 1;
    }
    if (pid !== null) removePid(resolvedHome, channel);
    const token = resolveToken(resolvedHome);
    if (!token.token) {
      const hint = channel === "telegram"
        ? "先在 @BotFather 建机器人"
        : "先在 Discord 开发者门户（discord.com/developers）建应用 + Bot，并开启 Message Content Intent";
      process.stderr.write(`未找到 ${label} Bot token：${hint}，再用环境变量 ${tokenEnv} 或 nyra vault add ${tokenEnv} 存 token（详见 docs/bot.md）。\n`);
      return 1;
    }
    const config = loadConfig(resolvedHome);
    const adapter = channel === "telegram"
      ? new TelegramAdapter({ token: token.token })
      : new DiscordAdapter({ token: token.token });
    const runner = new BotRunner({ home: resolvedHome, workdir: process.cwd(), config, adapter });
    writePid(resolvedHome, channel);
    process.stdout.write(`${label} Bot 已启动（pid ${process.pid}，模型：${runner.modelName ?? "未配置"}）。Ctrl+C 停止，或 nyra bot ${channel} stop。\n`);
    const shutdown = (): void => {
      runner.stopPolling();
      removePid(resolvedHome, channel);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await runner.startPolling();
    removePid(resolvedHome, channel);
    return 0;
  }
  process.stdout.write(`用法：nyra bot ${channel} <start|stop|status>\n`);
  return 2;
}
