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

export function buildCompactMessages(messages: ChatMessageLike[], summary: string, keepLast = 4): ChatMessageLike[] {
  const out: ChatMessageLike[] = [
    { role: "user", content: "[此前会话摘要]\n" + summary },
    { role: "assistant", content: "已压缩会话，继续。" },
  ];
  if (keepLast > 0) out.push(...messages.slice(-keepLast));
  return out;
}

export async function summarizeWithProvider(
  provider: { chat(messages: unknown[], tools?: unknown, timeout?: number): Promise<Record<string, unknown>> },
  messages: ChatMessageLike[],
  onResponse?: (response: Record<string, unknown>) => void,
): Promise<string> {
  const requestMessages = [
    { role: "system", content: COMPACT_SYSTEM_INSTRUCTION },
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
  opts?: { strict?: boolean; onResponse?: (response: Record<string, unknown>) => void },
): Promise<[ChatMessageLike[], { method: string; summary_chars: number; before: number; after: number }]> {
  const before = messages.length;
  if (!messages.length) {
    return [[], { method: "none", summary_chars: 0, before: 0, after: 0 }];
  }
  try {
    const summary = await summarizeWithProvider(provider, messages, opts?.onResponse);
    const newMessages = buildCompactMessages(messages, summary, keepLast);
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
