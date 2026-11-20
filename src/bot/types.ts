// src/bot/types.ts — Bot 方向 Phase 1：双场景共用的 Bot 内核类型。
//
// 用户 2026-11-20 给的双场景架构：场景 A（外部社群/客服/办公 IM Bot）与
// 场景 B（个人/业务自动化监控与任务 Bot）复用同一套 Bot Core（会话队列 +
// 幂等去重 + 权限策略 + 模型/工具执行 + 成本计量），只在入口、策略与推送
// 上区分。本批只做 Phase 1：核心骨架 + Telegram 渠道；场景 B 的 notifier
// 与 Phase 2 的 router / approvalBridge 不在本批。
//
// 两条 key 的区分（不要混用）：
//   - sessionKey：Bot 内的会话标识，`telegram:<chatId>:<threadId>`（群聊）
//     或 `telegram:<senderId>`（私聊）；只用于队列、去重、配额与审计。
//   - memorySessionId：Agent 会话文件的 id，必须过 sessionPath 的校验
//     （不含 `:` `/` `\` 与 `..`），由 sessionKey 派生：`bot-telegram-…`。
//     会话历史与长期记忆按 memorySessionId 隔离，A 用户的上下文绝不进
//     B 用户的 Agent（Agent 自己按 sessionId 读写会话文件）。

export type BotChannel = "telegram";

export type BotChatType = "private" | "group" | "supergroup" | "channel";

export type BotSenderRole = "owner" | "admin" | "member" | "unknown";

/** 渠道归一化后的入站消息（各平台原始 payload 由适配器转成这一个形状）。 */
export interface InboundMessage {
  channel: BotChannel;
  /** 群聊：群 id；私聊：发信人 id（Telegram 私聊里 chatId 即 senderId）。 */
  chatId: string;
  /** 话题/子线程 id（Telegram 的 message_thread_id）；无话题时为 null。 */
  threadId: string | null;
  senderId: string;
  senderRole: BotSenderRole;
  /** 群聊里是否 @ 了本 Bot（mentionOnly 为 true 时的放行条件）。 */
  isMentioned: boolean;
  /** 平台侧消息 id（去重的键；平台超时重试会重发同一 id）。 */
  messageId: string;
  /** 正文（无正文时为空串；纯附件消息走 attachments）。 */
  text: string;
  /** 附件：只记类型与平台侧 file_id，Phase 1 不下载、不解析内容。 */
  attachments: { kind: string; fileId: string; name?: string }[];
  chatType: BotChatType;
  /** 平台侧时间戳（毫秒）。 */
  timestamp: number;
}

/** Bot 发出的消息（适配器按平台限制落地）。 */
export interface OutgoingMessage {
  chatId: string;
  threadId: string | null;
  text: string;
  replyToMessageId?: string;
}

/** 渠道适配器：收（轮询或回调归一化）与发（文本/编辑）两件事。 */
export interface ChannelAdapter {
  readonly channel: BotChannel;
  /** 本 Bot 的用户名（群聊 @ 判定用；未拿到时为 null，mentionOnly 退化为看文本里的 @）。 */
  botUsername: string | null;
  /** 拉一次新消息并归一化（长轮询一批；回调渠道由网关调 handleMessage）。 */
  pollOnce(signal?: AbortSignal): Promise<InboundMessage[]>;
  /** 拿一次 Bot 自己的信息（id 与 username，供群聊 @ 判定）。 */
  getMe(): Promise<{ id: number; username: string | null }>;
  /** 发一条文本；返回平台侧消息 id（占位消息后续靠它编辑）。 */
  sendText(msg: OutgoingMessage): Promise<string>;
  /** 编辑一条已发消息（占位“处理中…”完成后更新）。 */
  editText(chatId: string, messageId: string, text: string): Promise<void>;
}

/** Bot 动作（Phase 2 的 approvalBridge 与 router 共用这一个动作表）。 */
export type BotAction =
  | { kind: "reply"; text: string }
  | { kind: "edit"; messageId: string; text: string }
  | { kind: "ignore"; reason: string }
  | { kind: "notice"; text: string };

/** Bot 安全与配额策略（config.json 的 `bot` 一节，见 botPolicyFromConfig）。 */
export interface BotPolicy {
  /** 群聊里只有被 @ 才响应（默认 true；私聊不受影响）。 */
  mentionOnly: boolean;
  /** 每次 Bot 回复最多走几轮 agent（默认 12；超了诚实收尾，不烧完）。 */
  maxTurns: number;
  /** 单条消息从入队到出结果的超时（毫秒；默认 120000；超时按取消处理）。 */
  timeoutMs: number;
  /** 单用户每天最多发几条进模型的消息（默认 100；确定性指令不计）。 */
  perUserDailyLimit: number;
  /** 单群聊每分钟最多几条进模型的消息（默认 10；防刷屏与洪峰）。 */
  perChatPerMinuteLimit: number;
  /** 每天 token 花费预算（美元；null = 不设；超了当天不再进模型）。 */
  dailyTokenBudgetUsd: number | null;
  /** 管理员的平台侧用户 id（/approve 等管理指令只认他们；Phase 1 先占位）。 */
  admins: string[];
  /** Telegram 渠道开关与用户名（用户名用于群聊 @ 判定）。 */
  telegram: { enabled: boolean; username: string | null };
}

export const DEFAULT_BOT_POLICY: BotPolicy = {
  mentionOnly: true,
  maxTurns: 12,
  timeoutMs: 120000,
  perUserDailyLimit: 100,
  perChatPerMinuteLimit: 10,
  dailyTokenBudgetUsd: null,
  admins: [],
  telegram: { enabled: false, username: null },
};

function asNonNegInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

function asPosInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** 从 config.json 的 `bot` 一节解析策略；缺失/非法值一律回默认值，不抛错。 */
export function botPolicyFromConfig(config: Record<string, unknown>): BotPolicy {
  const raw = (config as Record<string, unknown>).bot;
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const tg = b.telegram && typeof b.telegram === "object" && !Array.isArray(b.telegram)
    ? (b.telegram as Record<string, unknown>)
    : {};
  return {
    mentionOnly: b.mention_only === false ? false : DEFAULT_BOT_POLICY.mentionOnly,
    maxTurns: asPosInt(b.max_turns, DEFAULT_BOT_POLICY.maxTurns),
    timeoutMs: asPosInt(b.timeout_ms, DEFAULT_BOT_POLICY.timeoutMs),
    perUserDailyLimit: asNonNegInt(b.per_user_daily_limit, DEFAULT_BOT_POLICY.perUserDailyLimit),
    perChatPerMinuteLimit: asNonNegInt(b.per_chat_per_minute_limit, DEFAULT_BOT_POLICY.perChatPerMinuteLimit),
    dailyTokenBudgetUsd:
      typeof b.daily_token_budget_usd === "number" && Number.isFinite(b.daily_token_budget_usd) && b.daily_token_budget_usd >= 0
        ? b.daily_token_budget_usd
        : null,
    admins: Array.isArray(b.admins) ? b.admins.filter((x): x is string => typeof x === "string") : [],
    telegram: {
      enabled: tg.enabled === true,
      username: typeof tg.username === "string" && tg.username.trim() ? tg.username.trim().replace(/^@/, "") : null,
    },
  };
}

/** Bot 总开关：`bot.enabled` 或任一渠道开着才算开（默认全关）。 */
export function botEnabled(config: Record<string, unknown>): boolean {
  const raw = (config as Record<string, unknown>).bot;
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const tg = b.telegram && typeof b.telegram === "object" && !Array.isArray(b.telegram)
    ? (b.telegram as Record<string, unknown>)
    : {};
  return b.enabled === true || tg.enabled === true;
}

/** 会话 key：群聊按 channel:chatId:threadId，私聊按 channel:senderId。 */
export function sessionKeyFor(msg: Pick<InboundMessage, "channel" | "chatId" | "threadId" | "senderId" | "chatType">): string {
  if (msg.chatType === "private") return `${msg.channel}:${msg.senderId}`;
  return `${msg.channel}:${msg.chatId}:${msg.threadId ?? "0"}`;
}

/**
 * Agent 会话文件 id：sessionPath 禁 `:` `/` `\` 与 `..`，所以把 sessionKey
 * 里除字母数字与 `-` `_` 之外的字符都换成 `-`，再加 `bot-` 前缀。
 * 同一个 sessionKey 永远得到同一个 id；不同 sessionKey 不会撞上：
 * chatId / threadId / senderId 都是纯整数（群 id 可带一个前导 `-`），
 * 所以 `:` 换成 `-` 后映射仍是单射的——私聊 key 只有一个数字段，
 * 群聊 key 恒有两个数字段，两边不可能拼出同一个 id。
 */
export function memorySessionIdFor(sessionKey: string): string {
  const safe = sessionKey.replace(/[^A-Za-z0-9_-]/g, "-");
  return `bot-${safe}`;
}
