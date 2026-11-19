// src/compact.ts — 会话压缩，与 Python 版 nyra/compact.py 同语义，
// 并按方案 2.6 第 7 条分层：网关阈值 85% / agent 阈值 50%（可按模型覆盖）；
// 压缩顺序：先剪旧工具结果（不调 LLM）→ 再选边界 → 最后辅助模型结构化摘要。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSession, saveSession } from "./memory.ts";

export const COMPACT_SYSTEM_INSTRUCTION =
  "你是会话压缩助手。把以下对话压缩成一份要点摘要（中文，不超过 800 字），" +
  "保留：关键事实、已做的决定、已完成的工作、待办事项、涉及的重要文件路径和命令及其结果。" +
  "不要编造对话中没有的内容，不要写客套话。" +
  "只输出摘要本身，不要加标题以外的多余格式。";

// 调研报告第 3 项：上下文补齐（学 Claude Code）——压缩后重读的备注标记，
// 与 compact focus 的上限、token 估算口径（4 字符 ≈ 1 token，仅估算用）。
export const RE_READ_MARKER = "[压缩后重读：记忆与规则]";
export const MAX_FOCUS_KEPT_MESSAGES = 10;
export const CHARS_PER_TOKEN_ESTIMATE = 4;

export const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.8;
/** 分层阈值：网关 85% / agent 50%（默认 agent 侧用 0.5，CLI 可按模型覆盖）。 */
export const GATEWAY_COMPACT_THRESHOLD = 0.85;
export const AGENT_COMPACT_THRESHOLD = 0.5;

export interface ChatMessageLike {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  [key: string]: unknown;
}

/** 先剪旧工具结果（不调 LLM）：只保留最近一轮的工具结果，旧的折叠成一行占位。 */
export function trimOldToolResults(messages: ChatMessageLike[]): ChatMessageLike[] {
  // 找到最后一轮 assistant tool_calls 的位置；之前的 tool 结果全部折叠。
  let lastAssistantWithCalls = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && Array.isArray(messages[i].tool_calls) && (messages[i].tool_calls as unknown[]).length) {
      lastAssistantWithCalls = i;
      break;
    }
  }
  if (lastAssistantWithCalls <= 0) return messages;
  const lastCallIds = new Set(
    ((messages[lastAssistantWithCalls].tool_calls as Record<string, unknown>[]) ?? []).map((c) => String(c.id ?? "")),
  );
  return messages.map((m, i) => {
    if (m.role === "tool" && i < lastAssistantWithCalls && !lastCallIds.has(String(m.tool_call_id ?? ""))) {
      return { ...m, content: "（已压缩：旧工具结果已折叠）" };
    }
    return m;
  });
}

/** 选边界：只压缩“已完成轮次”，绝不碰当前用户请求及其工具往返。 */
export function splitCompletedVsActive(messages: ChatMessageLike[]): { older: ChatMessageLike[]; active: ChatMessageLike[] } {
  const before = messages;
  let currentStart = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i].role === "user") { currentStart = i; break; }
  }
  return { older: before.slice(0, currentStart), active: before.slice(currentStart) };
}

export function buildCompactMessages(
  messages: ChatMessageLike[],
  summary: string,
  keepLast = 4,
  opts?: { focus?: string; reRead?: string | null },
): ChatMessageLike[] {
  const out: ChatMessageLike[] = [
    { role: "user", content: "[此前会话摘要]\n" + summary },
    { role: "assistant", content: "已压缩会话，继续。" },
  ];
  // 调研报告第 3 项：上下文补齐（学 Claude Code）——压缩后重读的记忆与规则
  // 放在摘要之后、保留消息之前；只在压缩成功时由 compactMessages 传入，
  // fallback 绝不追加（不在已损坏的会话上叠加内容）。
  if (opts?.reRead) out.push({ role: "user", content: opts.reRead });
  // 调研报告第 3 项：上下文补齐（学 Claude Code）——compact focus：除 keepLast
  // 尾部外，额外保留含 focus 关键词的历史消息（按原顺序、去重、上限 10 条）。
  const focus = (opts?.focus ?? "").trim();
  if (focus) {
    const keywords = focusKeywords(focus);
    const tailStart = keepLast > 0 ? Math.max(0, messages.length - keepLast) : messages.length;
    const extra: ChatMessageLike[] = [];
    for (let i = 0; i < tailStart && extra.length < MAX_FOCUS_KEPT_MESSAGES; i++) {
      if (messageMatchesFocus(messages[i], keywords)) extra.push(messages[i]);
    }
    out.push(...extra);
  }
  if (keepLast > 0) out.push(...messages.slice(-keepLast));
  return out;
}

// 调研报告第 3 项：上下文补齐（学 Claude Code）——focus 关键词切分：按空白与
// 常用分隔符切分；中文关键词本身就是一个词（子串匹配），英文按词匹配。
export function focusKeywords(focus: string): string[] {
  return focus.split(/[\s,，;；、|/]+/).map((k) => k.trim()).filter(Boolean);
}

export function messageMatchesFocus(message: ChatMessageLike, keywords: string[]): boolean {
  if (!keywords.length) return false;
  const text = typeof message.content === "string" ? message.content.toLowerCase() : "";
  if (!text) return false;
  return keywords.some((k) => text.includes(k.toLowerCase()));
}

// 调研报告第 3 项：上下文补齐（学 Claude Code）——压缩后重读的备注正文：
// 记忆取 loadMemorySummary 的末 40 行（调用方传入），规则取 AGENTS.md 末尾段落
// （最后 2 个段落）；两边都空时返回 null，调用方不追加任何内容。
export function buildReReadNote(memoryText: string, agentsText: string): string | null {
  const memory = (memoryText ?? "").trim();
  const agents = (agentsText ?? "").trim();
  if (!memory && !agents) return null;
  const parts = [RE_READ_MARKER];
  if (memory) parts.push("## 长期记忆（压缩后重读）\n" + memory);
  if (agents) {
    const paragraphs = agents.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const tail = paragraphs.slice(-2).join("\n\n");
    parts.push("## 规则（压缩后重读，取 AGENTS.md 末尾段落）\n" + tail);
  }
  return parts.join("\n\n");
}

export async function summarizeWithProvider(
  provider: { chat(messages: unknown[], tools?: unknown, timeout?: number): Promise<Record<string, unknown>> },
  messages: ChatMessageLike[],
  onResponse?: (response: Record<string, unknown>) => void,
  // 调研报告第 3 项：上下文补齐（学 Claude Code）——compact focus：非空时摘要
  // 指令追加重点保留与 focus 相关的内容。
  focus?: string,
): Promise<string> {
  const instruction = (focus ?? "").trim()
    ? COMPACT_SYSTEM_INSTRUCTION + `\n重点保留与「${(focus as string).trim()}」相关的内容：相关事实、决定与待办不要丢。`
    : COMPACT_SYSTEM_INSTRUCTION;
  const requestMessages = [
    { role: "system", content: instruction },
    ...messages,
    { role: "user", content: "请按以上要求压缩这段对话。" },
  ];
  const response = await provider.chat(requestMessages, null, 120);
  onResponse?.(response);
  const content = ((response.choices as Record<string, unknown>[])?.[0]?.message as Record<string, unknown>)?.content as string;
  const summary = (content || "").trim();
  if (!summary) throw new Error("模型返回了空摘要");
  return summary;
}

export async function compactMessages(
  provider: { chat(messages: unknown[], tools?: unknown, timeout?: number): Promise<Record<string, unknown>> },
  messages: ChatMessageLike[],
  keepLast = 4,
  opts?: {
    strict?: boolean;
    onResponse?: (response: Record<string, unknown>) => void;
    // 调研报告第 3 项：上下文补齐（学 Claude Code）——focus 只影响摘要指令与
    // 额外保留；reRead 只在压缩成功时追加，失败回退时不追加。
    focus?: string;
    reRead?: string | null;
  },
): Promise<[ChatMessageLike[], { method: string; summary_chars: number; before: number; after: number }]> {
  const before = messages.length;
  if (!messages.length) {
    return [[], { method: "none", summary_chars: 0, before: 0, after: 0 }];
  }
  try {
    const summary = await summarizeWithProvider(provider, messages, opts?.onResponse, opts?.focus);
    const newMessages = buildCompactMessages(messages, summary, keepLast, { focus: opts?.focus, reRead: opts?.reRead ?? null });
    return [newMessages, { method: "model", summary_chars: summary.length, before, after: newMessages.length }];
  } catch (err: unknown) {
    if (opts?.strict) throw err;
    // 本地回退：保留首尾消息，绝不编造内容。
    const fallback: ChatMessageLike[] = [{ role: "user", content: "[压缩失败：模型摘要不可用，仅保留首尾消息]" }];
    const tailStart = keepLast > 0 ? Math.max(0, before - keepLast) : before;
    for (let index = 0; index < messages.length; index++) {
      if (messages[index].role === "user") {
        if (index < tailStart) fallback.push(messages[index]);
        break;
      }
    }
    if (keepLast > 0) fallback.push(...messages.slice(tailStart));
    return [fallback, { method: "fallback", summary_chars: 0, before, after: fallback.length }];
  }
}

export async function compactSessionFile(
  sessionId: string,
  provider: { chat(messages: unknown[], tools?: unknown, timeout?: number): Promise<Record<string, unknown>> },
  keepLast = 4,
  sessionsDir?: string,
  home?: string,
): Promise<Record<string, unknown>> {
  const dir = sessionsDir ?? join(home ?? process.env.NYRA_HOME ?? "", "sessions");
  const path = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(path)) throw new Error(`会话不存在：${sessionId}`);
  const messages = (loadSession(sessionId, home) ?? []) as ChatMessageLike[];
  const [newMessages, info] = await compactMessages(provider, messages, keepLast);
  saveSession(sessionId, newMessages as Record<string, unknown>[], home);
  return info;
}

export function validateAutoCompactThreshold(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0 || value >= 1) {
    throw new Error("auto_compact_threshold 必须在 0 到 1 之间（不含端点）");
  }
  return value;
}

/**
 * 是否触发自动压缩：只用模型实际报告的用量（snapshot），不用 tokenizer 估算。
 * snapshot 形状与 usage.UsageTracker.snapshot() 一致。
 */
export function shouldAutoCompact(
  snapshot: { last_prompt_tokens: number | null; context_window_tokens: number | null },
  messageCount: number,
  threshold: number,
): boolean {
  const window = snapshot.context_window_tokens;
  const last = snapshot.last_prompt_tokens;
  if (window === null || window === undefined || last === null || last === undefined) return false;
  if (messageCount < 3) return false;
  return last / window >= threshold;
}
