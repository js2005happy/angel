// src/toolBudget.ts — 工具集的常驻 token 成本（对齐 Codex 的 tool_search 思路，先量化再裁剪）。
//
// 事实：工具 schema 每一轮请求都要重发一次。30 个工具的 schema 通常是几千 token，
// 一个 20 轮的运行就是几万 token 的纯开销——而其中绝大多数工具这一轮根本用不到。
//
// 这一步先做"量化 + 可裁剪"：
//   1. 算出当前工具集每轮占多少 token、占上下文的比例
//   2. 支持按名字裁剪（config.disabled_tools / --disable-tool），并显示省了多少
// 下一步才是延迟加载（工具检索），那一步的前提也是先把账算清楚。
import type { ChatMessage } from "./providers.ts";
import { t } from "./i18n.ts";

/** 字符 → token 的粗算口径，与 cost.ts 保持一致（中英混排取 2.5）。 */
export const CHARS_PER_TOKEN = 2.5;

export interface ToolSchemaLike {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

export interface ToolBudget {
  totalTools: number;
  /** 每轮随请求发送的 schema 估算 token。 */
  tokensPerTurn: number;
  /** 各工具各占多少（降序），用于判断"谁最贵"。 */
  byTool: { name: string; tokens: number }[];
  /** 占上下文窗口的比例（未给窗口时为 null）。 */
  contextRatio: number | null;
}

function schemaJson(schema: ToolSchemaLike): string {
  try {
    return JSON.stringify(schema);
  } catch {
    return "";
  }
}

/** 单个工具的 schema 估算 token。 */
export function schemaTokens(schema: ToolSchemaLike): number {
  return Math.ceil([...schemaJson(schema)].length / CHARS_PER_TOKEN);
}

/** 整个工具集的每轮成本。 */
export function measureToolBudget(schemas: readonly ToolSchemaLike[], contextWindow?: number | null): ToolBudget {
  const byTool = schemas
    .map((s) => ({ name: s?.function?.name ?? "(未命名)", tokens: schemaTokens(s) }))
    .sort((a, b) => b.tokens - a.tokens);
  const tokensPerTurn = byTool.reduce((sum, t) => sum + t.tokens, 0);
  const win = typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : null;
  return {
    totalTools: schemas.length,
    tokensPerTurn,
    byTool,
    contextRatio: win === null ? null : tokensPerTurn / win,
  };
}

/** 按名字（或 "*" 前缀通配）过滤工具集；返回过滤结果与被移除的名字。 */
export function filterSchemas<T extends ToolSchemaLike>(
  schemas: readonly T[],
  disabled: readonly string[],
): { kept: T[]; dropped: string[] } {
  const set = new Set(disabled.map((d) => d.trim()).filter(Boolean));
  if (!set.size) return { kept: [...schemas], dropped: [] };
  const match = (name: string) => set.has(name) || [...set].some((d) => d.endsWith("*") && name.startsWith(d.slice(0, -1)));
  const kept: T[] = [];
  const dropped: string[] = [];
  for (const s of schemas) {
    const name = s?.function?.name ?? "";
    if (match(name)) dropped.push(name);
    else kept.push(s);
  }
  return { kept, dropped };
}

export interface ToolSavings {
  dropped: string[];
  tokensPerTurnSaved: number;
  /** 相对原工具集省下的百分比（0-1）。 */
  ratio: number;
}

/** 裁剪前后对比。 */
export function summarizeSavings(
  before: readonly ToolSchemaLike[],
  after: readonly ToolSchemaLike[],
): ToolSavings {
  const beforeTokens = measureToolBudget(before).tokensPerTurn;
  const afterTokens = measureToolBudget(after).tokensPerTurn;
  const beforeNames = new Set(before.map((s) => s?.function?.name ?? ""));
  const afterNames = new Set(after.map((s) => s?.function?.name ?? ""));
  const dropped = [...beforeNames].filter((n) => !afterNames.has(n));
  return {
    dropped,
    tokensPerTurnSaved: Math.max(0, beforeTokens - afterTokens),
    ratio: beforeTokens > 0 ? Math.max(0, (beforeTokens - afterTokens) / beforeTokens) : 0,
  };
}

/**
 * 估算一次运行的工具集总开销（轮次 × 每轮）。
 * 保守假设：工具 schema 每轮都完整发送（当前实现确实如此）。
 */
export function estimateRunToolOverhead(
  schemas: readonly ToolSchemaLike[],
  turns: number,
): { tokensPerTurn: number; totalTokens: number } {
  const perTurn = measureToolBudget(schemas).tokensPerTurn;
  const n = Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 1;
  return { tokensPerTurn: perTurn, totalTokens: perTurn * n };
}

/** 人类可读摘要（doctor / redlines / tools 子命令用）。 */
export function formatToolBudget(budget: ToolBudget): string {
  const lines = [t("tools.head", { count: budget.totalTools, tokens: budget.tokensPerTurn.toLocaleString() })];
  if (budget.contextRatio !== null) {
    lines.push(t("tools.ratio", { pct: (budget.contextRatio * 100).toFixed(1) }));
  }
  const top = budget.byTool.slice(0, 5);
  if (top.length) {
    lines.push(t("tools.top", { list: top.map((x) => `${x.name}(${x.tokens})`).join("、") }));
  }
  return lines.join("；");
}

/** 供测试/诊断：把消息里的工具相关 token 也纳入视野（当前只统计 schema，不含工具结果）。 */
export function messagesChars(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    const c = (m as { content?: unknown }).content;
    if (typeof c === "string") n += [...c].length;
    else if (c) n += [...schemaJson(c as ToolSchemaLike)].length;
  }
  return n;
}
