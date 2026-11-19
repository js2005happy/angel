// src/statsCli.ts — 缺口 20：`nyra stats` 子命令。
//
//   nyra stats                    本月累计 + 今日 + 最近 7 天（数字版）
//   nyra stats heatmap [--weeks N]  终端内每日用量热力图（默认 8 周）
//
// 数字只读用量账本（~/.nyra/usage_daily.jsonl）：热力图与月度硬顶同一份
// 事实源；账本从本批起才开始记，之前的运行没有留存用量，不补编历史。
// 未计价的部分（没配单价/没报 usage）只记 token、不记金额，花费显示“未知”。
import { loadConfig } from "./config.ts";
import { resolveMonthlyLimit } from "./cost.ts";
import { UsageLedger, formatHeatmap, localDateString, monthKeyString, nextMonthlyResetDate } from "./usageLedger.ts";
import { McpCostTracker } from "./mcpCost.ts";
import { t } from "./i18n.ts";

function money(v: number | null): string {
  return typeof v === "number" ? `$${v.toFixed(4)}` : t("stats.spentUnknown");
}

/** 本月一行（供 REPL /stats 与 cost --show 复用）：已花、MCP 占比、上限、重置日。 */
export function formatMonthLine(home: string, now = new Date()): string {
  const config = loadConfig(home);
  const month = monthKeyString(now);
  const ledger = new UsageLedger(home);
  const llm = ledger.monthTotal(month);
  const mcp = new McpCostTracker(home).monthTotalUsd(month);
  const spent = llm.spentUsd + mcp;
  const limit = resolveMonthlyLimit(config);
  const limitPart = limit === null
    ? t("stats.monthNoLimit")
    : t("stats.monthLimit", { limit: `$${limit.toFixed(2)}`, reset: nextMonthlyResetDate(now) });
  const incomplete = llm.incomplete ? " " + t("run.statsPartial") : "";
  return t("stats.monthLine", {
    month, tokens: llm.totalTokens.toLocaleString("en-US"),
    spent: money(spent) + incomplete, mcp: money(mcp), limitPart,
  });
}

function printMonthSummary(home: string, now = new Date()): void {
  const month = monthKeyString(now);
  const ledger = new UsageLedger(home);
  const llm = ledger.monthTotal(month);
  process.stdout.write(t("stats.monthTitle", { month }) + "\n");
  process.stdout.write(formatMonthLine(home, now) + "\n");
  const today = ledger.dailyTotals(1, now).get(localDateString(now));
  if (today) {
    process.stdout.write(t("stats.todayLine", {
      tokens: today.total.toLocaleString("en-US"), spent: money(today.spent),
    }) + "\n");
  }
  const week = ledger.dailyTotals(7, now);
  let any = false;
  for (const [date, day] of week) {
    if (day.total === 0 && day.calls === 0) continue;
    any = true;
    process.stdout.write(t("stats.weekLine", {
      date, tokens: day.total.toLocaleString("en-US"), spent: money(day.spent),
    }) + "\n");
  }
  if (!any && llm.totalTokens === 0) process.stdout.write(t("stats.empty") + "\n");
}

export function handleStats(argv: string[], home: string): number {
  const heatmap = argv.includes("heatmap") || argv.includes("--heatmap");
  if (!heatmap) {
    if (argv.length) {
      process.stderr.write("用法：nyra stats [--heatmap]；nyra stats heatmap [--weeks N]\n");
      return 2;
    }
    printMonthSummary(home);
    return 0;
  }
  const weeksIdx = argv.indexOf("--weeks");
  let weeks = 8;
  if (weeksIdx >= 0) {
    const raw = parseInt(argv[weeksIdx + 1] ?? "", 10);
    if (!Number.isFinite(raw) || raw < 1 || raw > 52) {
      process.stderr.write("用法：nyra stats heatmap [--weeks N]（N 为 1–52）\n");
      return 2;
    }
    weeks = raw;
  }
  const rest = argv.filter((a, i) => a !== "heatmap" && a !== "--heatmap" && i !== weeksIdx && i !== weeksIdx + 1);
  if (rest.length) {
    process.stderr.write("用法：nyra stats heatmap [--weeks N]\n");
    return 2;
  }
  const ledger = new UsageLedger(home);
  const daily = ledger.dailyTotals(weeks * 7);
  process.stdout.write(formatHeatmap(daily, { weeks }) + "\n");
  return 0;
}
