// src/mcpCost.ts — 付费 MCP 工具的成本显示与上限（第 3 阶段，方案 2.3）。
// 规则：调用前先显示预估成本；上限由用户在 config.json 里设
// `mcp_cost_limit_usd`（数字，未设 = 不设上限）；预估价来自
// `mcp_tool_costs`（{"服务器.工具": 美元}）或服务器级 `cost_per_call_usd`，
// 未标价的工具预估为 0 并在显示里写明“未标价”。超上限时停手并报信，
// 绝不先调用再算账。花费记到 NYRA_HOME/mcp_spend.jsonl（只追加，不改写）。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNyraHome } from "./memory.ts";

export interface McpSpendRecord {
  ts: string;
  server: string;
  tool: string;
  estimate_usd: number;
  status: "called" | "blocked_over_limit" | "failed";
  total_usd_after: number;
}

export function estimateToolCost(
  config: Record<string, unknown>,
  server: string,
  tool: string,
): { estimate_usd: number; priced: boolean; source: string } {
  const perTool = config.mcp_tool_costs as Record<string, unknown> | undefined;
  const key = `${server}.${tool}`;
  if (perTool && typeof perTool[key] === "number" && (perTool[key] as number) >= 0) {
    return { estimate_usd: perTool[key] as number, priced: true, source: `mcp_tool_costs["${key}"]` };
  }
  const servers = config.mcp_servers as Record<string, Record<string, unknown>> | undefined;
  const raw = servers?.[server];
  if (raw && typeof raw.cost_per_call_usd === "number" && (raw.cost_per_call_usd as number) >= 0) {
    return { estimate_usd: raw.cost_per_call_usd as number, priced: true, source: `mcp_servers["${server}"].cost_per_call_usd` };
  }
  return { estimate_usd: 0, priced: false, source: "未标价" };
}

export function costLimitUsd(config: Record<string, unknown>): number | null {
  const v = config.mcp_cost_limit_usd;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return null;
}

export class McpCostTracker {
  home: string;
  file: string;
  constructor(home?: string) {
    this.home = resolveNyraHome(home);
    this.file = join(this.home, "mcp_spend.jsonl");
  }

  totalUsd(): number {
    if (!existsSync(this.file)) return 0;
    let total = 0;
    for (const line of readFileSync(this.file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as McpSpendRecord;
        if (rec.status === "called") total += Number(rec.estimate_usd) || 0;
      } catch { /* 坏行跳过，不让记账拖垮调用 */ }
    }
    return total;
  }

  /** 调用前检查：返回 null 表示可调用；返回字符串表示停手原因。 */
  checkBeforeCall(config: Record<string, unknown>, server: string, tool: string): { estimate_usd: number; priced: boolean; source: string; blocked: string | null } {
    const est = estimateToolCost(config, server, tool);
    const limit = costLimitUsd(config);
    if (limit !== null && this.totalUsd() + est.estimate_usd > limit) {
      return {
        ...est,
        blocked: `MCP 成本上限已到：本次预估 $${est.estimate_usd.toFixed(4)}，累计 $${this.totalUsd().toFixed(4)}，上限 $${limit.toFixed(4)}；已停手，未调用 ${server}.${tool}。请在设置里调高 mcp_cost_limit_usd 后再试。`,
      };
    }
    return { ...est, blocked: null };
  }

  /** 调用前显示给用户的一行预估（调用前出现，见 gateway / api/mcp/call）。 */
  estimateLine(config: Record<string, unknown>, server: string, tool: string): string {
    const est = estimateToolCost(config, server, tool);
    const limit = costLimitUsd(config);
    const priced = est.priced ? `预估 $${est.estimate_usd.toFixed(4)}` : "未标价（预估 $0.0000）";
    const limitText = limit === null ? "未设上限" : `上限 $${limit.toFixed(4)}，已用 $${this.totalUsd().toFixed(4)}`;
    return `MCP 调用 ${server}.${tool}：${priced}（${est.source}）；${limitText}。`;
  }

  record(server: string, tool: string, estimateUsd: number, status: McpSpendRecord["status"]): McpSpendRecord {
    const total = this.totalUsd() + (status === "called" ? estimateUsd : 0);
    const rec: McpSpendRecord = {
      ts: new Date().toISOString(), server, tool, estimate_usd: estimateUsd, status, total_usd_after: total,
    };
    try {
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      appendFileSync(this.file, JSON.stringify(rec) + "\n", "utf-8");
    } catch { /* 记账失败不阻塞调用本身 */ }
    return rec;
  }
}
