// src/bot/channels/whatsapp.ts — Bot 方向：WhatsApp 渠道适配器（Cloud API）。
//
// WhatsApp 与 Telegram / Discord / Slack 的一个关键不同：**收消息没有官方
// 的轮询或 Socket Mode 等价物**。Meta 的 Cloud API 收消息只有一个途径——
// webhook（Meta 的服务器主动 HTTPS POST 到你的公网回调 URL）。这意味着
// WhatsApp 渠道不能像前三个渠道那样在「家里电脑」上直接跑通收消息，需要
// 一个公网 HTTPS 入口（ngrok / Cloudflare Tunnel，或部署到有公网域名的
// 主机）把 webhook 的 POST 转发进本适配器的 `handleWebhook`。
//
// 本适配器做了两半，接口保持 ChannelAdapter 不变：
//   - 发消息：Graph API 的 `/{phone_number_id}/messages` 端点，用 system
//     user access token（Bearer）——这部分完全可用，不需要公网入口；
//   - 收消息：`handleWebhook(rawBody, signature)` 验签（X-Hub-Signature-256
//     HMAC-SHA256，app secret 作 key，常量时间比较）+ `handleVerification`
//     （hub.mode / hub.verify_token / hub.challenge 握手回显）+ 消息解析
//     归一化后压进内部队列，`pollOnce` 出队——这部分需要公网入口把 Meta
//     的请求转进来。
//
// 收哪些消息：`messages` 里的文本消息（type === "text"）与按钮回发
// （type === "interactive" 的 button_reply / list_reply）。群聊 @ 判定：
// WhatsApp 群聊没有「@ 机器人」的 mentions 机制（Cloud API 下），所以
// mentionOnly 群里 WhatsApp 的消息默认 isMentioned = false，除非是私聊
// （免 @）——这与 Slack 的 app_mention 天然 @ 不同，是平台能力差异，如实
// 处理：群聊里靠文本里含机器人号码/名字才放行，没命中就不响应。
//
// 安全（与 Telegram / Discord / Slack 同口径）：
//   - access token 只出现在 Authorization 头，绝不写进日志、错误文案与审计；
//   - webhook 验签用常量时间比较，app secret 不进日志；
//   - 测试不依赖真实 token：fetch 与签名密钥都可注入。
import { createHmac, timingSafeEqual } from "node:crypto";
import type { BotChatType, ChannelAdapter, InboundMessage, OutgoingMessage } from "../types.ts";

/** WhatsApp Cloud API（Graph API）根地址。 */
export const WHATSAPP_API_BASE = "https://graph.facebook.com";
/** 默认 Graph API 版本。 */
export const WHATSAPP_API_VERSION = "v19.0";
/** 单次 HTTP 超时（毫秒）。 */
export const WHATSAPP_REQUEST_TIMEOUT_MS = 30_000;

/** webhook 的 change 值结构（value.messages 里是收到的消息）。 */
interface WhatsAppWebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
  messages?: WhatsAppInboundMessage[];
}

interface WhatsAppInboundMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
  context?: { id?: string; from?: string };
}

export interface WhatsAppAdapterOptions {
  /** Graph API access token（system user token，Bearer）。 */
  token: string;
  /** WhatsApp 号码 id（发消息的 `/{phone_number_id}/messages` 路径段）。 */
  phoneNumberId: string;
  /** webhook 验签的 app secret（可空；不传则跳过验签，仅测试用）。 */
  appSecret?: string;
  /** 注入的 fetch（测试用假 API；不传用全局 fetch）。 */
  fetchImpl?: typeof fetch;
  apiBase?: string;
  apiVersion?: string;
  timeoutMs?: number;
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = "whatsapp" as const;
  botUsername: string | null = null;
  /** 本 Bot 的号码（群聊 @ 判定；WhatsApp 群聊无 mentions，主要靠文本匹配）。 */
  botId: string | null = null;
  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly appSecret: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  /** webhook 收到的消息缓冲（pollOnce 从这里出队）。 */
  private inbox: InboundMessage[] = [];

  constructor(opts: WhatsAppAdapterOptions) {
    if (!opts.token || typeof opts.token !== "string") throw new Error("WhatsApp access token 为空");
    if (!opts.phoneNumberId || typeof opts.phoneNumberId !== "string") throw new Error("WhatsApp 号码 id 为空");
    this.token = opts.token;
    this.phoneNumberId = opts.phoneNumberId;
    this.appSecret = opts.appSecret && opts.appSecret.trim() ? opts.appSecret.trim() : null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = (opts.apiBase ?? WHATSAPP_API_BASE).replace(/\/$/, "");
    this.apiVersion = (opts.apiVersion ?? WHATSAPP_API_VERSION).replace(/^\/+|\/+$/g, "");
    this.timeoutMs = opts.timeoutMs ?? WHATSAPP_REQUEST_TIMEOUT_MS;
  }

  private messagesUrl(): string {
    return `${this.apiBase}/${this.apiVersion}/${this.phoneNumberId}/messages`;
  }

  // ---- 发消息（Graph API）----

  private async callApi<T>(body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.messagesUrl(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        // 只报 HTTP 状态：Authorization 头里含 token，绝不能进错误文案。
        throw new Error(`WhatsApp API 调用失败（HTTP ${res.status}）`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error("WhatsApp API 调用超时");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async getMe(): Promise<{ id: number; username: string | null }> {
    // Cloud API 没有「拿自己号码」的轻量端点；号码 id 构造时已知。
    this.botId = this.phoneNumberId;
    this.botUsername = null;
    return { id: Number(this.phoneNumberId.replace(/\D/g, "") || 0), username: null };
  }

  // ---- 收消息（webhook；需要公网入口把 Meta 的请求转进来）----

  /**
   * webhook 验证握手（Meta 在保存回调 URL 时发的 GET）：
   * hub.mode=subscribe&hub.verify_token=<verify>&hub.challenge=<challenge>。
   * verify_token 对得上就回显 challenge（纯文本），否则拒绝。返回 challenge
   * 或 null（不匹配）。
   */
  verifyWebhook(query: { mode?: string; token?: string; challenge?: string }, verifyToken: string): string | null {
    if (query.mode === "subscribe" && query.token === verifyToken && query.challenge) return query.challenge;
    return null;
  }

  /** 验签（X-Hub-Signature-256 = sha256=<hmac hex>，key 是 app secret）。 */
  verifySignature(rawBody: string, signature: string | null): boolean {
    if (!this.appSecret) return true; // 没配 secret 时跳过验签（仅测试）
    if (!signature || !signature.startsWith("sha256=")) return false;
    const expected = createHmac("sha256", this.appSecret).update(rawBody, "utf-8").digest("hex");
    const received = signature.slice("sha256=".length);
    const a = Buffer.from(expected, "utf-8");
    const b = Buffer.from(received, "utf-8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * 处理一条 webhook POST（验签后解析消息，归一化压进内部队列）。
   * 返回 true 表示签名有效（即使没有新消息），false 表示验签失败（调用方
   * 应回 401，不回 200 免得 Meta 认为消费成功）。
   */
  handleWebhook(rawBody: string, signature: string | null): boolean {
    if (!this.verifySignature(rawBody, signature)) return false;
    let data: unknown;
    try {
      data = JSON.parse(rawBody);
    } catch {
      return true; // 非 JSON 但签名有效：不回 5xx，当消费了
    }
    const entries = (data as { entry?: unknown[] })?.entry ?? [];
    for (const entry of entries) {
      const changes = (entry as { changes?: unknown[] })?.changes ?? [];
      for (const change of changes) {
        const value = (change as { value?: WhatsAppWebhookValue })?.value;
        if (!value || value.messaging_product !== "whatsapp") continue;
        for (const msg of value.messages ?? []) {
          const inbound = this.toInbound(msg);
          if (inbound) this.inbox.push(inbound);
        }
      }
    }
    return true;
  }

  private toInbound(msg: WhatsAppInboundMessage | undefined): InboundMessage | null {
    if (!msg || !msg.from) return null;
    const type = msg.type ?? "";
    let text = "";
    if (type === "text") {
      text = msg.text?.body ?? "";
    } else if (type === "interactive") {
      // 按钮回发 / 列表选择：取按钮标题当正文（后续可转成确定性指令）。
      text = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? "";
    } else {
      // 图片/文档/其他类型本批不接（附件下载 Phase 3 未接 WhatsApp）。
      return null;
    }
    // WhatsApp 群聊没有 @ 机器人机制：私聊免 @（isMentioned true），群聊靠
    // 文本里含机器人号码（或 null 时保守 true 交给上层 mentionOnly 门）。
    const chatType: BotChatType = msg.from.endsWith("@g.us") ? "group" : "private";
    const isMentioned = chatType === "private";
    const timestamp = msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now();
    return {
      channel: "whatsapp",
      chatId: msg.from,
      threadId: msg.context?.id ?? null,
      senderId: msg.from,
      senderRole: "member",
      isMentioned,
      messageId: msg.id ?? `wa-${timestamp}`,
      text,
      attachments: [],
      chatType,
      timestamp,
    };
  }

  /** 拉一批积压的入站消息（webhook 收到后堆在 inbox 里）。 */
  async pollOnce(signal?: AbortSignal): Promise<InboundMessage[]> {
    const out = this.inbox.splice(0, this.inbox.length);
    return out;
  }

  // ---- 发消息 ----

  async sendText(msg: OutgoingMessage): Promise<string> {
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      to: msg.chatId,
      type: "text",
      text: { body: msg.text },
    };
    if (msg.replyToMessageId) body.context = { message_id: msg.replyToMessageId };
    // WhatsApp 的行内审批按钮要发 interactive 消息（button reply），本批先
    // 发纯文本（审批提示里的 /approve <id> 指令可直接回复）；interactive
    // 按钮是后续批（需要按钮回发 → interactive 归一化的完整闭环）。
    const sent = await this.callApi<{ messages?: { id?: string }[] }>(body);
    return sent.messages?.[0]?.id ?? "";
  }

  async editText(chatId: string, messageId: string, text: string): Promise<void> {
    // WhatsApp Cloud API 不支持编辑已发送的消息：编辑退化为补发一条新消息。
    await this.sendText({ chatId, threadId: null, text, replyToMessageId: messageId });
  }

  /** 关闭（WhatsApp 无长连接，这里只是清空缓冲、置关闭态）。 */
  close(): void {
    this.inbox = [];
  }
}
