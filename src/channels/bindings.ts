// src/channels/bindings.ts — 渠道绑定（bindings）与确定性路由。
//
// 一条入站消息（channel, chat, sender）先过 bindings 再决定交给哪个 agent：
// 声明式映射、可解释、可回放。路由是纯函数 routeInbound / explainRoute，
// 不读磁盘、不调模型——`nyra channels explain` 可以离线重放任意一条消息的
// 路由决定（命中哪条规则、为什么是它、没命中时 fallback 到谁）。
//
// 账本 `~/.nyra/channel-bindings.json`（原子写 0600；损坏先备份再抛错，
// 不静默重建——与团队账本 teams.json 同口径）。
//
// 准入（admission）是“接收范围 × 是否 @ × 是否在名单”三维：
//   - 绑定没命中 → 落到渠道默认绑定（fallback，agent 取 config bot.agent）。
//   - 绑定命中但准入失败（不在 allowlist / 群里没 @）→ 直接丢弃并记原因，
//     不再落到默认绑定（fail-closed：显式绑过的范围不许悄悄换 agent 接）。
//   - 对外发送永远走审批门（BotRunner 的 approvalBridge），路由只决定“谁接”，
//     不决定“能不能发”。
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolveNyraHome } from "../memory.ts";
import type { BotChannel } from "../bot/types.ts";
import { channelKindFor } from "./kind.ts";

export const CHANNEL_BINDINGS_FILE = "channel-bindings.json";

/** 绑定级沙箱档位（渠道会话默认进沙箱；档位只收紧，不放宽到宿主机直跑）。 */
export type BindingSandboxTier = "strict" | "standard" | "open";

export type BindingAdmission = "open" | "allowlist";

/** 一条绑定：把（渠道，聊天，发送者）映射到一个 agent。 */
export interface ChannelBinding {
  id: string;
  channel: BotChannel;
  /** 聊天 id（字符串，如 Telegram 的 -100123456789）；"*" 表示任意聊天。 */
  chat: string;
  /** 发送者 id（字符串）；"*" 表示任意发送者。 */
  sender: string;
  /** 接这条消息的 agent（Soul 名，如 nyra）。 */
  agent: string;
  /** 绑定级沙箱档位：strict 只读断网、standard 工作目录可写断网、open 工作目录可写放网。 */
  sandbox: BindingSandboxTier;
  /** 准入：open 全接、allowlist 只接名单里的人。 */
  admission: BindingAdmission;
  /** allowlist 时的发送者 id 清单（字符串）。 */
  allowlist: string[];
  /** 群里是否只响应 @：null 表示用 kind 的默认口径（mentionDefault）。 */
  mentionOnly: boolean | null;
  /** 语音消息是否允许走云端转写（默认只走本地 whisper.cpp；云端须显式开）。 */
  voiceCloud: boolean;
  enabled: boolean;
  /** 同具体程度时，priority 大的先赢。 */
  priority: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelBindingStore {
  version: 1;
  bindings: ChannelBinding[];
}

export class BindingError extends Error {}

const AGENT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const BINDING_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bindingsPath(home: string): string {
  return join(resolveNyraHome(home), CHANNEL_BINDINGS_FILE);
}

function parseBinding(raw: unknown): ChannelBinding {
  if (!isRecord(raw)) throw new BindingError("绑定不是对象");
  const channel = raw.channel;
  if (channel !== "telegram" && channel !== "discord" && channel !== "slack" && channel !== "whatsapp") {
    throw new BindingError(`绑定渠道不对：${String(channel)}`);
  }
  const sandbox = raw.sandbox;
  if (sandbox !== "strict" && sandbox !== "standard" && sandbox !== "open") {
    throw new BindingError(`绑定沙箱档位不对：${String(sandbox)}`);
  }
  const admission = raw.admission;
  if (admission !== "open" && admission !== "allowlist") {
    throw new BindingError(`绑定准入不对：${String(admission)}`);
  }
  if (typeof raw.id !== "string" || !BINDING_ID_RE.test(raw.id)) throw new BindingError("绑定 id 不对");
  if (typeof raw.chat !== "string" || raw.chat === "") throw new BindingError("绑定 chat 不对");
  if (typeof raw.sender !== "string" || raw.sender === "") throw new BindingError("绑定 sender 不对");
  if (typeof raw.agent !== "string" || !AGENT_ID_RE.test(raw.agent)) throw new BindingError(`绑定 agent 不对：${String(raw.agent)}`);
  if (!Array.isArray(raw.allowlist) || raw.allowlist.some((x) => typeof x !== "string" || x === "")) {
    throw new BindingError("绑定 allowlist 不对");
  }
  if (raw.mentionOnly !== null && typeof raw.mentionOnly !== "boolean") throw new BindingError("绑定 mentionOnly 不对");
  if (typeof raw.voiceCloud !== "boolean") throw new BindingError("绑定 voiceCloud 不对");
  if (typeof raw.enabled !== "boolean") throw new BindingError("绑定 enabled 不对");
  if (typeof raw.priority !== "number" || !Number.isInteger(raw.priority) || raw.priority < 0 || raw.priority > 100) {
    throw new BindingError("绑定 priority 不对（须是 0–100 的整数）");
  }
  return {
    id: raw.id,
    channel,
    chat: raw.chat,
    sender: raw.sender,
    agent: raw.agent,
    sandbox,
    admission,
    allowlist: [...(raw.allowlist as string[])],
    mentionOnly: raw.mentionOnly as boolean | null,
    voiceCloud: raw.voiceCloud,
    enabled: raw.enabled,
    priority: raw.priority,
    note: typeof raw.note === "string" ? raw.note : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

/** 读绑定账本；不存在返回空账本；损坏先备份再抛错（不静默重建）。 */
export function loadBindingStore(home: string): ChannelBindingStore {
  const path = bindingsPath(home);
  if (!existsSync(path)) return { version: 1, bindings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new BindingError(`绑定账本损坏，已备份到 ${basename(backup)}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bindings)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new BindingError(`绑定账本结构不对，已备份到 ${basename(backup)}`);
  }
  return { version: 1, bindings: (parsed.bindings as unknown[]).map(parseBinding) };
}

/** 原子写绑定账本（同目录 tmp 0600 + rename）。 */
export function saveBindingStore(home: string, store: ChannelBindingStore): void {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = bindingsPath(home);
  const data = JSON.stringify(store, null, 2) + "\n";
  const tmp = join(dir, `.bindings.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

/** 校验一条新建/修改的绑定输入：返回错误文案列表，空数组表示通过。 */
export function validateBindingInput(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (typeof input.id !== "string" || !BINDING_ID_RE.test(input.id)) {
    errors.push("绑定 id 不对：须是小写字母开头、只含小写字母/数字/_/-，最长 32 字");
  }
  const channel = input.channel;
  if (channel !== "telegram" && channel !== "discord" && channel !== "slack" && channel !== "whatsapp") {
    errors.push(`渠道不对：${String(channel)}（只支持 telegram / discord / slack / whatsapp）`);
  }
  if (typeof input.chat !== "string" || input.chat === "") errors.push("chat 不对：须是聊天 id 或 *");
  if (typeof input.sender !== "string" || input.sender === "") errors.push("sender 不对：须是发送者 id 或 *");
  if (typeof input.agent !== "string" || !AGENT_ID_RE.test(input.agent)) {
    errors.push(`agent 不对：${String(input.agent)}（须是小写字母开头、只含小写字母/数字/_/-，最长 32 字）`);
  }
  const sandbox = input.sandbox;
  if (sandbox !== "strict" && sandbox !== "standard" && sandbox !== "open") {
    errors.push(`沙箱档位不对：${String(sandbox)}（只支持 strict / standard / open）`);
  }
  const admission = input.admission;
  if (admission !== "open" && admission !== "allowlist") {
    errors.push(`准入不对：${String(admission)}（只支持 open / allowlist）`);
  }
  if (admission === "allowlist" && (!Array.isArray(input.allowlist) || input.allowlist.length === 0)) {
    errors.push("准入是 allowlist 时，allowlist 不能为空");
  }
  if (Array.isArray(input.allowlist) && input.allowlist.some((x) => typeof x !== "string" || x === "")) {
    errors.push("allowlist 里有空的发送者 id");
  }
  if (input.mentionOnly !== null && input.mentionOnly !== undefined && typeof input.mentionOnly !== "boolean") {
    errors.push("mentionOnly 不对：须是 true / false，或不填（用 kind 默认口径）");
  }
  if (typeof input.priority !== "number" || !Number.isInteger(input.priority) || input.priority < 0 || input.priority > 100) {
    errors.push("priority 不对：须是 0–100 的整数");
  }
  return errors;
}

/** 隐式默认绑定的 id：渠道没命中任何显式绑定时落到它。 */
export function defaultBindingId(channel: BotChannel): string {
  return `default:${channel}`;
}

/** 生成一条隐式默认绑定（不进账本）：agent 取 config bot.agent，沙箱 standard，准入 open。 */
export function defaultBinding(channel: BotChannel, agent: string): ChannelBinding {
  const now = new Date().toISOString();
  return {
    id: defaultBindingId(channel),
    channel,
    chat: "*",
    sender: "*",
    agent,
    sandbox: "standard",
    admission: "open",
    allowlist: [],
    mentionOnly: null,
    voiceCloud: false,
    enabled: true,
    priority: 0,
    note: "隐式默认绑定：没有显式绑定命中时落到这里",
    createdAt: now,
    updatedAt: now,
  };
}

/** 入站消息的路由输入（只含路由要用的字段，不含正文）。 */
export interface RouteInput {
  channel: BotChannel;
  chat: string;
  sender: string;
  /** 是否 @ 了机器人。 */
  mentioned: boolean;
  /** 是否群聊（群里才适用 mentionOnly）。 */
  isGroup: boolean;
}

export type RouteOutcome = "routed" | "dropped" | "fallback";

export interface RouteDecision {
  outcome: RouteOutcome;
  /** 命中的绑定 id；dropped 时是命中但准入失败的那条绑定；fallback 时是 default:<渠道>。 */
  bindingId: string;
  /** 命中哪条规则：specificity:<分> / fallback:default / drop:<原因>。 */
  rule: string;
  /** 给人看的原因。 */
  reason: string;
  /** 命中绑定的具体程度分（fallback 为 0）。 */
  specificity: number;
}

export interface RouteCandidate {
  bindingId: string;
  specificity: number;
  priority: number;
  matched: boolean;
  /** 准入检查的结果（没命中时为空串）。 */
  admission: string;
}

export interface RouteExplanation extends RouteDecision {
  candidates: RouteCandidate[];
}

/** 具体程度分：chat 精确 4 分、sender 精确 2 分、allowlist 非空 1 分。 */
export function bindingSpecificity(binding: ChannelBinding): number {
  let score = 0;
  if (binding.chat !== "*") score += 4;
  if (binding.sender !== "*") score += 2;
  if (binding.allowlist.length > 0) score += 1;
  return score;
}

function matches(binding: ChannelBinding, msg: RouteInput): boolean {
  if (binding.channel !== msg.channel) return false;
  if (binding.chat !== "*" && binding.chat !== msg.chat) return false;
  if (binding.sender !== "*" && binding.sender !== msg.sender) return false;
  return true;
}

/** 准入检查：返回 null 表示通过，否则返回丢弃原因。 */
function admissionFailure(binding: ChannelBinding, msg: RouteInput): string | null {
  if (binding.admission === "allowlist" && !binding.allowlist.includes(msg.sender)) {
    return "not_in_allowlist";
  }
  const kind = channelKindFor(binding.channel);
  const mentionOnly = binding.mentionOnly ?? kind.policy.mentionDefault;
  if (mentionOnly && msg.isGroup && !msg.mentioned) {
    return "mention_only";
  }
  return null;
}

function sortCandidates(a: ChannelBinding, b: ChannelBinding): number {
  const specDiff = bindingSpecificity(b) - bindingSpecificity(a);
  if (specDiff !== 0) return specDiff;
  const prioDiff = b.priority - a.priority;
  if (prioDiff !== 0) return prioDiff;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/**
 * 确定性路由（纯函数）：显式绑定按“具体程度 → priority → 创建时间”排序，
 * 第一名命中即接；命中但准入失败直接丢弃（不落到默认绑定）；都没命中落到默认绑定。
 */
export function routeInbound(msg: RouteInput, bindings: ChannelBinding[]): RouteDecision {
  const enabled = bindings.filter((b) => b.enabled);
  const matched = enabled.filter((b) => matches(b, msg)).sort(sortCandidates);
  if (matched.length === 0) {
    return {
      outcome: "fallback",
      bindingId: defaultBindingId(msg.channel),
      rule: "fallback:default",
      reason: "没有显式绑定命中，落到渠道默认绑定",
      specificity: 0,
    };
  }
  const winner = matched[0];
  const failure = admissionFailure(winner, msg);
  if (failure) {
    const reason = failure === "not_in_allowlist"
      ? `发送者 ${msg.sender} 不在绑定 ${winner.id} 的 allowlist 里`
      : `绑定 ${winner.id} 只响应 @，这条群消息没 @ 机器人`;
    return { outcome: "dropped", bindingId: winner.id, rule: `drop:${failure}`, reason, specificity: bindingSpecificity(winner) };
  }
  return {
    outcome: "routed",
    bindingId: winner.id,
    rule: `specificity:${bindingSpecificity(winner)}`,
    reason: `命中绑定 ${winner.id}（具体程度 ${bindingSpecificity(winner)} 分）`,
    specificity: bindingSpecificity(winner),
  };
}

/** 路由解释（纯函数）：decision + 全部候选的排序与准入结果，供 explain 离线回放。 */
export function explainRoute(msg: RouteInput, bindings: ChannelBinding[]): RouteExplanation {
  const decision = routeInbound(msg, bindings);
  const enabled = bindings.filter((b) => b.enabled);
  const candidates: RouteCandidate[] = enabled
    .map((b) => {
      const matched = matches(b, msg);
      const failure = matched ? admissionFailure(b, msg) : null;
      return {
        bindingId: b.id,
        specificity: bindingSpecificity(b),
        priority: b.priority,
        matched,
        admission: !matched ? "" : failure ? `drop:${failure}` : "pass",
      };
    })
    .sort((a, b) => {
      if (a.matched !== b.matched) return a.matched ? -1 : 1;
      if (a.specificity !== b.specificity) return b.specificity - a.specificity;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return 0;
    });
  return { ...decision, candidates };
}

/** 沙箱档位 → resolveSandbox 要的 config 覆盖（只收紧，不放宽到宿主机直跑）。 */
export function sandboxOverrideFor(tier: BindingSandboxTier): { backend: string; mode: string; allowNet: boolean } {
  if (tier === "strict") return { backend: "auto", mode: "read-only", allowNet: false };
  if (tier === "open") return { backend: "auto", mode: "workspace-write", allowNet: true };
  return { backend: "auto", mode: "workspace-write", allowNet: false };
}

/** 把绑定档位合并进 config：绑定档位优先，但 NYRA_SANDBOX* 环境变量仍最高（resolveSandbox 的既有口径）。 */
export function configWithSandboxTier(config: Record<string, unknown>, tier: BindingSandboxTier): Record<string, unknown> {
  const override = sandboxOverrideFor(tier);
  return { ...config, sandbox: override.backend, sandbox_mode: override.mode, sandbox_allow_net: override.allowNet };
}
