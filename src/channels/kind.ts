// src/channels/kind.ts — DSH-3：SourceKind 式连接器协议（Nyra 自己的 kind 协议）。
//
// dsh-superagent 的 SourceKind（见 docs/008-cookbook.md）是“一个渠道一种
// kind、每种 kind 声明八个接口”的做法：schema / fields / health / scope /
// channel / threadContext / policy / environment。Nyra 不照抄它的代码与提示词，
// 只借这个形状：四个内置渠道（Telegram / Discord / Slack / WhatsApp）各一份
// kind 声明，新渠道按 docs/channels.md 里的 11 步清单接进来。
//
// 本文件不 import bot/index.ts（避免循环导入）：kind 声明是纯数据 + 纯函数，
// token 解析与适配器构造由 src/channels/gateway.ts 做。
import type { BotChannel } from "../bot/types.ts";

/** kind 的一个配置字段：既是校验依据（schema），也是设置表单的依据（fields）。 */
export interface ChannelKindField {
  /** 配置键（如 token 的环境变量名 / 密码箱键名）。 */
  key: string;
  /** 给人看的名字。 */
  label: string;
  type: "text" | "secret" | "boolean" | "number";
  required: boolean;
  /** 秘密值：绝不进日志与事件（只在健康检查里报“已配/未配”）。 */
  secret?: boolean;
  /** 值的格式（正则字面量字符串）；不合格式时校验报错。 */
  pattern?: string;
  hint?: string;
}

/** scope：这个 kind 接收什么范围的消息。 */
export interface ChannelKindScope {
  description: string;
  /** 默认收听口径：mentions（只收 @）或 all（全收）。私聊永远全收。 */
  defaultListen: "mentions" | "all";
}

/** channel：这个 kind 的收发能力（实测过的适配器能力，不写没实现的功能）。 */
export interface ChannelKindChannel {
  /** 长轮询 / Gateway / Socket Mode 拉消息。 */
  supportsPolling: boolean;
  /** 靠公网 webhook 收消息（WhatsApp 只有这一条收消息的路）。 */
  supportsWebhook: boolean;
  /** 发出后还能编辑那条消息。 */
  supportsEdit: boolean;
  /** 审批按钮等交互组件。 */
  supportsButtons: boolean;
  /** 语音消息（转文字当任务）。 */
  supportsVoice: boolean;
}

/** threadContext：会话怎么算一个线程（证据链与回放的口径）。 */
export interface ChannelKindThreadContext {
  /** 会话键的拼法（如 telegram:<chat id>）。 */
  sessionKey: string;
  description: string;
}

/** policy：这个 kind 在策略层面的默认口径。 */
export interface ChannelKindPolicy {
  /** 群里默认只响应 @（true）还是全响应（false）。 */
  mentionDefault: boolean;
  /** 准入说明：admission 表怎么设（见 docs/channels.md）。 */
  admission: string;
}

/** environment：运行这个 kind 需要什么环境。 */
export interface ChannelKindEnvironment {
  /** 是否需要公网可达的回调地址。 */
  needsPublicUrl: boolean;
  notes: string;
}

/** 一个渠道的 kind 声明：DSH-3 的八个接口。 */
export interface ChannelKind {
  /** 稳定 id：也是 Trigger source 与会话键前缀。改了会断开已有记录。 */
  kind: BotChannel;
  title: string;
  description: string;
  /** 配置校验：字段定义与必填/格式。 */
  schema: ChannelKindField[];
  /** 设置表单：给人看的字段定义。内置四种渠道与 schema 相同——以后有
      “只展示不校验”的字段时再分开写。 */
  fields: ChannelKindField[];
  /** 健康检查条目名（见 checkKindHealth）。 */
  health: string[];
  scope: ChannelKindScope;
  channel: ChannelKindChannel;
  threadContext: ChannelKindThreadContext;
  policy: ChannelKindPolicy;
  environment: ChannelKindEnvironment;
}

const TELEGRAM_FIELDS: ChannelKindField[] = [
  { key: "TELEGRAM_BOT_TOKEN", label: "Bot token", type: "secret", required: true, secret: true, pattern: "^[0-9]+:[A-Za-z0-9_-]{20,}$", hint: "从 @BotFather 拿；也可放密码箱或环境变量" },
];

const DISCORD_FIELDS: ChannelKindField[] = [
  { key: "DISCORD_BOT_TOKEN", label: "Bot token", type: "secret", required: true, secret: true, hint: "Discord 开发者门户 → Bot → Token；收消息须开 Message Content Intent" },
];

const SLACK_FIELDS: ChannelKindField[] = [
  { key: "SLACK_APP_TOKEN", label: "App token（xapp- 开头）", type: "secret", required: true, secret: true, pattern: "^xapp-[A-Za-z0-9-]+$", hint: "Socket Mode 用；Basic Information → App-Level Tokens" },
  { key: "SLACK_BOT_TOKEN", label: "Bot token（xoxb- 开头）", type: "secret", required: true, secret: true, pattern: "^xoxb-[A-Za-z0-9-]+$", hint: "OAuth & Permissions → Bot User OAuth Token" },
];

const WHATSAPP_FIELDS: ChannelKindField[] = [
  { key: "WHATSAPP_ACCESS_TOKEN", label: "Access token", type: "secret", required: true, secret: true, hint: "Meta 开发者后台 → WhatsApp → API 设置；也可放密码箱或环境变量" },
  { key: "WHATSAPP_PHONE_NUMBER_ID", label: "号码 id", type: "text", required: true, pattern: "^[0-9]+$", hint: "Meta 开发者后台 → WhatsApp → API 设置里的 Phone number ID（纯数字）" },
  { key: "WHATSAPP_APP_SECRET", label: "App secret", type: "secret", required: false, secret: true, hint: "可选：配了才验 webhook 签名；不配则跳过验签（只适合测试）" },
];

export const CHANNEL_KINDS: Record<BotChannel, ChannelKind> = {
  telegram: {
    kind: "telegram",
    title: "Telegram",
    description: "Bot API 长轮询收消息，不需要公网入口，家里电脑上就能跑。",
    schema: TELEGRAM_FIELDS,
    fields: TELEGRAM_FIELDS,
    health: ["telegram:token", "telegram:adapter", "telegram:poll"],
    scope: { description: "私聊全收；群里默认只收 @ 的消息。", defaultListen: "mentions" },
    channel: { supportsPolling: true, supportsWebhook: false, supportsEdit: true, supportsButtons: false, supportsVoice: true },
    threadContext: { sessionKey: "telegram:<chat id>", description: "一个聊天一个会话；群里同一条线程的回复串在同一个会话里。" },
    policy: { mentionDefault: true, admission: "群聊默认只响应 @；要放开某群，在 bindings 里给那个群单独绑一条规则。" },
    environment: { needsPublicUrl: false, notes: "不需要公网入口；token 配好就能跑。" },
  },
  discord: {
    kind: "discord",
    title: "Discord",
    description: "Gateway WebSocket 收 MESSAGE_CREATE 事件，REST 发消息。",
    schema: DISCORD_FIELDS,
    fields: DISCORD_FIELDS,
    health: ["discord:token", "discord:adapter", "discord:poll"],
    scope: { description: "私聊全收；服务器频道默认只收 @ 的消息。", defaultListen: "mentions" },
    channel: { supportsPolling: true, supportsWebhook: false, supportsEdit: false, supportsButtons: false, supportsVoice: false },
    threadContext: { sessionKey: "discord:<channel id>", description: "一个频道一个会话。" },
    policy: { mentionDefault: true, admission: "服务器频道默认只响应 @；要放开某频道，在 bindings 里给那个频道单独绑一条规则。" },
    environment: { needsPublicUrl: false, notes: "收消息须在 Discord 开发者门户开 Message Content Intent，否则只能收到 @。" },
  },
  slack: {
    kind: "slack",
    title: "Slack",
    description: "Socket Mode 收 app_mention / message.im 事件，Web API 发消息，审批按钮闭环。",
    schema: SLACK_FIELDS,
    fields: SLACK_FIELDS,
    health: ["slack:token", "slack:adapter", "slack:poll"],
    scope: { description: "私聊（message.im）全收；频道默认只收 @ 的消息。", defaultListen: "mentions" },
    channel: { supportsPolling: true, supportsWebhook: false, supportsEdit: false, supportsButtons: true, supportsVoice: false },
    threadContext: { sessionKey: "slack:<channel id>", description: "一个频道一个会话；审批按钮的回调也落在同一个会话里。" },
    policy: { mentionDefault: true, admission: "频道默认只响应 @；要放开某频道，在 bindings 里给那个频道单独绑一条规则。" },
    environment: { needsPublicUrl: false, notes: "Socket Mode 不需要公网入口；两个 token 都要配齐。" },
  },
  whatsapp: {
    kind: "whatsapp",
    title: "WhatsApp",
    description: "Cloud API 发消息；收消息靠 Meta 的服务器往公网回调 URL 推 webhook。",
    schema: WHATSAPP_FIELDS,
    fields: WHATSAPP_FIELDS,
    health: ["whatsapp:token", "whatsapp:adapter", "whatsapp:poll"],
    scope: { description: "一对一对话全收；群组默认只收 @ 的消息。", defaultListen: "mentions" },
    channel: { supportsPolling: false, supportsWebhook: true, supportsEdit: false, supportsButtons: false, supportsVoice: false },
    threadContext: { sessionKey: "whatsapp:<chat id>", description: "一个对话一个会话。" },
    policy: { mentionDefault: true, admission: "默认不启用——WhatsApp 只做接入形态与风险说明，真接通须用户另行点头。" },
    environment: {
      needsPublicUrl: true,
      notes: "收消息必须有公网回调 URL，把 Meta 的 webhook POST 转发进适配器的 handleWebhook；没有公网入口就收不到消息。本渠道用的是 Meta 官方 Cloud API，不是 Baileys 之类的非官方客户端——Baileys 有封号风险，Nyra 不用它，也不要把两者的风险混为一谈。",
    },
  },
};

export function channelKindFor(channel: BotChannel): ChannelKind {
  return CHANNEL_KINDS[channel];
}

export function listChannelKinds(): ChannelKind[] {
  return (Object.keys(CHANNEL_KINDS) as BotChannel[]).map((k) => CHANNEL_KINDS[k]);
}

/** 校验一份 kind 配置：返回错误文案列表，空数组表示通过。秘密值只报“已配/未配”，不回显。 */
export function validateKindConfig(kind: ChannelKind, values: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const field of kind.schema) {
    const value = values[field.key];
    if (field.required && (value === undefined || value === null || (typeof value === "string" && value.trim() === ""))) {
      errors.push(`缺少必填配置：${field.label}（${field.key}）`);
      continue;
    }
    if (value === undefined || value === null || value === "") continue;
    if (field.type === "boolean" && typeof value !== "boolean") {
      errors.push(`配置 ${field.label}（${field.key}）须是 true / false`);
    }
    if (field.type === "number" && typeof value !== "number") {
      errors.push(`配置 ${field.label}（${field.key}）须是数字`);
    }
    if (typeof value === "string" && field.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(field.pattern);
      } catch {
        errors.push(`kind ${kind.kind} 的字段 ${field.key} 正则写坏了（内部错误）`);
        continue;
      }
      if (!re.test(value)) errors.push(`配置 ${field.label}（${field.key}）格式不对`);
    }
  }
  return errors;
}

export type ChannelHealthStatus = "ok" | "degraded" | "error";

export interface ChannelHealthEntry {
  name: string;
  status: ChannelHealthStatus;
  detail: string;
}

export interface ChannelHealth {
  kind: BotChannel;
  status: ChannelHealthStatus;
  /** 已启用的显式绑定数（不含隐式默认绑定）。 */
  bindings: number;
  entries: ChannelHealthEntry[];
}

export interface ChannelHealthProbe {
  /** token（或全部必填配置）是否配齐。 */
  tokenPresent: boolean;
  /** 适配器是否构造成功。 */
  adapterOk: boolean;
  /** 最近一次轮询是否成功：true 成功、false 失败、null 还没轮询过。 */
  lastPollOk: boolean | null;
  bindings: number;
}

/**
 * kind 健康检查（纯函数）：token 缺失与适配器构造失败是 error（须人处理）；
 * 最近一次轮询失败是 degraded（可能是网络抖动，会重试）；都没问题是 ok。
 * 健康条目名按 kind 加前缀，不会撞上 runtime / reply / worker 这类保留名。
 */
export function checkKindHealth(kind: ChannelKind, probe: ChannelHealthProbe): ChannelHealth {
  const entries: ChannelHealthEntry[] = [];
  entries.push({
    name: `${kind.kind}:token`,
    status: probe.tokenPresent ? "ok" : "error",
    detail: probe.tokenPresent ? "必填配置已配齐" : "必填配置未配齐（见 kind 的 schema）",
  });
  entries.push({
    name: `${kind.kind}:adapter`,
    status: probe.adapterOk ? "ok" : "error",
    detail: probe.adapterOk ? "适配器已构造" : "适配器构造失败",
  });
  entries.push({
    name: `${kind.kind}:poll`,
    status: probe.lastPollOk === false ? "degraded" : "ok",
    detail: probe.lastPollOk === null ? "还没轮询过" : probe.lastPollOk ? "最近一次轮询成功" : "最近一次轮询失败（会重试）",
  });
  const status: ChannelHealthStatus = entries.some((e) => e.status === "error")
    ? "error"
    : entries.some((e) => e.status === "degraded")
      ? "degraded"
      : "ok";
  return { kind: kind.kind, status, bindings: probe.bindings, entries };
}
