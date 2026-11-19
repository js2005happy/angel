// src/toolSearch.ts — 工具检索（延迟加载的选择器部分，对齐 Codex 的 tool_search）。
//
// 现状：所有工具 schema 每轮全量发送。MCP 接进来以后工具数会到几十个，光 schema 就
// 吃掉可观上下文，而且模型在这一轮里根本用不到其中绝大多数。
//
// 做法（分两步，本文件只做第一步）：
//   1. **选择器**：给定当前任务文本，挑出最相关的 K 个工具 + 常驻核心工具（本文件）
//   2. **检索工具**：暴露一个 `search_tools` 元工具，模型能按需把没发的工具拉回来
//
// 本文件是纯函数：不读文件、不 spawn、不改状态。排序必须可解释——每个入选/落选都要
// 说得出理由，否则出问题时没法排查"为什么这个工具没发给模型"。
import type { ToolSchemaLike } from "./toolBudget.ts";

export interface ToolSearchOptions {
  /** 最多保留多少个（不含 always 列表）。默认 12。 */
  topK?: number;
  /** 永远保留的工具名（核心工具：读文件、shell、搜索等）。 */
  always?: readonly string[];
  /** 低于该分数直接丢弃（0 = 只要命中一点就留）。默认 1。 */
  minScore?: number;
}

export interface ToolScore {
  name: string;
  score: number;
  /** 命中的关键词，便于解释为什么选它。 */
  matched: string[];
}

export interface ToolSelection {
  kept: string[];
  dropped: string[];
  scores: ToolScore[];
  /** 落选但接近阈值的工具（提示模型可以用 search_tools 拉回来）。 */
  suggestions: string[];
}

/** 把名字切成可比较的词：snake_case / kebab-case / camelCase 都拆开，并保留原串。 */
export function tokenizeName(name: string): string[] {
  const raw = name ?? "";
  const parts = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  const whole = raw.toLowerCase();
  return [...new Set([whole, ...parts])];
}

/** 任务文本的小写词集合（含中文按 2-gram 处理，避免整句不匹配）。 */
export function tokenizeQuery(query: string): string[] {
  const q = (query ?? "").toLowerCase();
  const latin = q.split(/[^a-z0-9_]+/).filter((s) => s.length >= 2);
  const cjk = [...q].filter((c) => /[\u4e00-\u9fff]/.test(c));
  const grams: string[] = [];
  for (let i = 0; i + 1 < cjk.length; i++) grams.push(cjk[i] + cjk[i + 1]);
  return [...new Set([...latin, ...grams])];
}

function scoreOne(schema: ToolSchemaLike, queryTokens: string[], queryLower: string): ToolScore {
  const name = schema?.function?.name ?? "";
  const desc = schema?.function?.description ?? "";
  const nameTokens = tokenizeName(name);
  const descLower = desc.toLowerCase();
  const matched: string[] = [];
  let score = 0;

  for (const t of nameTokens) {
    if (t.length >= 2 && queryTokens.includes(t)) {
      score += 5; // 名字命中权重最高：说明任务就是在说这个工具
      matched.push(`name:${t}`);
    }
  }
  for (const t of queryTokens) {
    // 中文按 2-gram 切，长度天然是 2——门槛按字符类型区分，否则中文查询永远命不中描述。
    const minLen = /[\u4e00-\u9fff]/.test(t) ? 2 : 3;
    if (t.length >= minLen && descLower.includes(t)) {
      score += 1;
      matched.push(`desc:${t}`);
    }
  }
  // 名字整体出现在任务文本里（如 "用 read_file 看"）给一次性加分
  if (name && queryLower.includes(name.toLowerCase())) {
    score += 8;
    matched.push(`literal:${name}`);
  }
  return { name, score, matched };
}

/**
 * 选出本轮要发送的工具。
 *
 * 规则：
 *   - always 列表无条件保留（核心工具，缺了会直接卡死流程）
 *   - 其余按分数排序取前 K；分数 < minScore 的丢弃
 *   - 一个都没命中时（例如刚开会话、任务还没描述清楚）**回退为全量发送**——
 *     宁可多花 token，也不能让模型手里没有工具
 */
export function selectTools(
  schemas: readonly ToolSchemaLike[],
  query: string,
  opts: ToolSearchOptions = {},
): ToolSelection {
  const topK = Math.max(1, Math.floor(opts.topK ?? 12));
  const always = new Set(opts.always ?? []);
  const minScore = opts.minScore ?? 1;
  const queryTokens = tokenizeQuery(query);
  const queryLower = (query ?? "").toLowerCase();

  const scored = schemas.map((s) => scoreOne(s, queryTokens, queryLower));
  const byName = new Map<string, ToolScore>();
  for (const s of scored) byName.set(s.name, s);

  const alwaysNames = schemas.map((s) => s?.function?.name ?? "").filter((n) => always.has(n));
  const candidates = scored
    .filter((s) => !always.has(s.name))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const picked = candidates.slice(0, Math.max(0, topK - alwaysNames.length));
  const kept = [...alwaysNames, ...picked.map((s) => s.name)];

  if (kept.length === 0) {
    // 无命中：全量回退，绝不让模型手里没有工具
    const all = schemas.map((s) => s?.function?.name ?? "").filter(Boolean);
    return { kept: all, dropped: [], scores: scored, suggestions: [] };
  }

  const keptSet = new Set(kept);
  const dropped = schemas.map((s) => s?.function?.name ?? "").filter((n) => n && !keptSet.has(n));
  const suggestions = candidates.slice(picked.length, picked.length + 5).map((s) => s.name);

  return { kept, dropped, scores: scored.sort((a, b) => b.score - a.score), suggestions };
}

/** 给 `search_tools` 元工具用的一句话说明（告诉模型有哪些工具没发出去、怎么拿回来）。 */
export function describeDeferred(selection: ToolSelection, total: number): string {
  if (!selection.dropped.length) return "";
  const sample = selection.dropped.slice(0, 10).join("、");
  return `本轮未发送 ${selection.dropped.length}/${total} 个工具（${sample}${selection.dropped.length > 10 ? "…" : ""}）。需要时调用 search_tools 检索后使用。`;
}

/** 人类可读的排序解释（doctor / 排障用）。 */
export function explainSelection(selection: ToolSelection): string {
  const top = selection.scores.filter((s) => s.score > 0).slice(0, 8);
  if (!top.length) return "本轮无关键词命中，已全量发送（避免模型手里没有工具）";
  return top.map((s) => `${s.name}(${s.score}${s.matched.length ? `: ${s.matched.join(",")}` : ""})`).join("；");
}
