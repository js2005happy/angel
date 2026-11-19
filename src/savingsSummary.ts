// src/savingsSummary.ts — 把散落的省钱机制汇成一张单页摘要。
//
// 现状：工具裁剪、辅助模型、推理档位、延迟加载、跨会话回忆、成本硬顶这六件事各在各的
// 命令里（nyra tools / redlines / cost / recall），没人能一眼看到"整体到底省了多少"。
//
// 设计纪律：
//   - **只汇总已有数字，不新造估算**。每项的来源都写清楚，便于追查
//   - 算不出的项标 "unknown"，不填 0——0 会被读成"没省"
//   - 总量只加**可加**的项（token 类），把"比例类/布尔类"单列，不硬凑一个总数
import { measureToolBudget, filterSchemas, summarizeSavings as summarizeToolSavings, type ToolSchemaLike } from "./toolBudget.ts";
import { resolveAuxRouting } from "./modelRouting.ts";
import { resolveReasoningOptions } from "./reasoning.ts";

export interface SavingLine {
  /** 机制名（稳定，便于脚本判定）。 */
  mechanism: string;
  /** 是否已启用。 */
  enabled: boolean;
  /** 效果描述（人话，带数字）。 */
  effect: string;
  /** 可加的 token/轮 节省；算不出为 null。 */
  tokensPerTurnSaved: number | null;
  /** 能给总量加多少 token；null 表示不可加。 */
  additive: boolean;
  /** 数字来源（哪个命令/模块算的）。 */
  source: string;
}

export interface SavingsSummary {
  lines: SavingLine[];
  /** 可加项合计（token/轮）。 */
  tokensPerTurnTotal: number;
  /** 有多少项算不出数字。 */
  unknownCount: number;
  /** 一句话结论。 */
  verdict: string;
}

export interface SavingsInput {
  config: Record<string, unknown>;
  /** 全部可用工具 schema（含 MCP）。 */
  schemas?: readonly ToolSchemaLike[];
  /** 已禁用的工具名（--disable-tool / config.disabled_tools）。 */
  disabledTools?: readonly string[];
  /** 最近 30 天内可复用的历史条数（由调用方用 selectRecalledRuns 算好）。 */
  recallCount?: number | null;
  /** 延迟加载是否开启。 */
  toolSearchEnabled?: boolean;
  /** 本次运行的预计轮次（用于把 /轮 折算成总量）。 */
  turns?: number;
}

export function summarizeSavings(input: SavingsInput): SavingsSummary {
  const cfg = input.config ?? {};
  const lines: SavingLine[] = [];

  // 1) 工具裁剪
  {
    const schemas = input.schemas ?? [];
    const disabled = input.disabledTools ?? [];
    if (schemas.length && disabled.length) {
      const { kept } = filterSchemas(schemas, disabled);
      const s = summarizeToolSavings(schemas, kept);
      lines.push({
        mechanism: "disable_tool",
        enabled: true,
        effect: `裁掉 ${s.dropped.length} 个工具，每轮省 ${s.tokensPerTurnSaved} token（${(s.ratio * 100).toFixed(1)}%）`,
        tokensPerTurnSaved: s.tokensPerTurnSaved,
        additive: true,
        source: "toolBudget.summarizeSavings",
      });
    } else {
      lines.push({
        mechanism: "disable_tool",
        enabled: false,
        effect: "未裁剪任何工具",
        tokensPerTurnSaved: 0,
        additive: true,
        source: "toolBudget.summarizeSavings",
      });
    }
  }

  // 2) 延迟加载（省的是"没发送的 schema"，与裁剪不重复计算：两者互斥时取实际发送量）
  {
    const schemas = input.schemas ?? [];
    const budget = measureToolBudget(schemas);
    if (input.toolSearchEnabled) {
      lines.push({
        mechanism: "tool_search",
        enabled: true,
        effect: `只发核心 + 命中工具（全集 ${budget.totalTools} 个、${budget.tokensPerTurn} token/轮 中的一部分）`,
        tokensPerTurnSaved: null, // 取决于命中的工具数，无法静态确定
        additive: false,
        source: "agent.toolSchemas（运行时决定）",
      });
    } else {
      lines.push({
        mechanism: "tool_search",
        enabled: false,
        effect: "未开启：每轮发送全部工具 schema",
        tokensPerTurnSaved: 0,
        additive: true,
        source: "features.tool_search",
      });
    }
  }

  // 3) 辅助模型
  {
    const routing = resolveAuxRouting(cfg, typeof cfg.model === "string" ? cfg.model : null);
    const parts = [routing.compact ? "压缩" : "", routing.delegate ? "子任务" : ""].filter(Boolean);
    lines.push({
      mechanism: "aux_model_routing",
      enabled: parts.length > 0,
      effect: parts.length ? `${parts.join("/")} 走便宜模型（单价差决定省多少，未配 pricing 时算不出）` : "未配置：压缩与子任务都用主模型",
      tokensPerTurnSaved: null,
      additive: false,
      source: "modelRouting.resolveAuxRouting",
    });
  }

  // 4) 推理档位
  {
    const r = resolveReasoningOptions(cfg);
    lines.push({
      mechanism: "reasoning_effort",
      enabled: Boolean(r.effort || r.verbosity),
      effect: r.effort || r.verbosity ? `已降到 ${[r.effort, r.verbosity].filter(Boolean).join("/")}（省的是 reasoning token，无法静态量化）` : "未配置：按 provider 默认档位",
      tokensPerTurnSaved: null,
      additive: false,
      source: "reasoning.resolveReasoningOptions",
    });
  }

  // 5) 跨会话回忆
  {
    const n = input.recallCount;
    if (n === null || n === undefined) {
      lines.push({
        mechanism: "run_recall",
        enabled: false,
        effect: "未统计（用 nyra recall 查看）",
        tokensPerTurnSaved: null,
        additive: false,
        source: "runRecall.selectRecalledRuns",
      });
    } else {
      lines.push({
        mechanism: "run_recall",
        enabled: n > 0,
        effect: n > 0 ? `${n} 条历史可复用（省的是探索轮次，折算见 cost --estimate）` : "没有可复用的历史",
        tokensPerTurnSaved: null,
        additive: false,
        source: "runRecall.selectRecalledRuns",
      });
    }
  }

  // 6) 成本硬顶（省钱机制里唯一"不省也要有"的一项）
  {
    const limit = typeof cfg.max_cost_usd === "number" ? cfg.max_cost_usd : null;
    lines.push({
      mechanism: "cost_cap",
      enabled: limit !== null,
      effect: limit !== null ? `上限 $${limit}（超了中止，不是警告）` : "未设上限：可能无限烧钱",
      tokensPerTurnSaved: null,
      additive: false,
      source: "config.max_cost_usd",
    });
  }

  const additiveLines = lines.filter((l) => l.additive);
  const tokensPerTurnTotal = additiveLines.reduce((sum, l) => sum + (l.tokensPerTurnSaved ?? 0), 0);
  const unknownCount = lines.filter((l) => l.tokensPerTurnSaved === null).length;
  const enabledCount = lines.filter((l) => l.enabled).length;

  const turns = typeof input.turns === "number" && input.turns > 0 ? Math.floor(input.turns) : null;
  const verdict = tokensPerTurnTotal > 0
    ? `每轮可确定省下 ${tokensPerTurnTotal} token${turns ? `，${turns} 轮共 ${tokensPerTurnTotal * turns}` : ""}；另有 ${unknownCount} 项无法静态量化`
    : enabledCount === 0
      ? "所有省钱机制都没开：按默认方式运行"
      : `已开 ${enabledCount} 项机制，但没有可静态相加的 token 数字（${unknownCount} 项需运行时才知道）`;

  return { lines, tokensPerTurnTotal, unknownCount, verdict };
}

/** 人类可读输出。 */
export function formatSavings(summary: SavingsSummary): string {
  const lines: string[] = ["省钱机制汇总："];
  for (const l of summary.lines) {
    lines.push(`  ${l.enabled ? "✅" : "⬜"} ${l.mechanism}：${l.effect}`);
  }
  lines.push("");
  lines.push(summary.verdict);
  lines.push("（数字来源见各机制模块；算不出的项不填 0，避免被读成「没省」）");
  return lines.join("\n");
}
