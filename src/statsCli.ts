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
  // --json：成本侧第四个机读出口（与 savings / cost / verdict 同一套契约）。
  if (argv.includes("--json")) {
    const now = new Date();
    const config = loadConfig(home);
    const month = monthKeyString(now);
    const ledger = new UsageLedger(home);
    const llm = ledger.monthTotal(month);
    const mcp = new McpCostTracker(home).monthTotalUsd(month);
    const daily = ledger.dailyTotals(7, now);
    const todayKey = localDateString(now);
    const t0 = daily.get(todayKey);
    const days = [...daily.entries()]
      .filter(([, d2]) => d2.total > 0 || d2.calls > 0)
      .sort((a, b2) => a[0].localeCompare(b2[0]))
      .map(([date, d2]) => ({ date, tokens: d2.total, spent: d2.spent, calls: d2.calls }));
    // 有调用没配单价时 spent 不完整：给 null 而不是 0（0 会被读成"这个月免费"）。
    const spent = llm.incomplete ? null : llm.spentUsd + mcp;
    process.stdout.write(JSON.stringify(buildStatsJson({
      month,
      monthTokens: llm.totalTokens,
      monthSpentUsd: spent,
      incomplete: llm.incomplete,
      mcpSpentUsd: mcp,
      monthlyLimitUsd: resolveMonthlyLimit(config),
      resetAt: nextMonthlyResetDate(now),
      today: t0 ? { date: todayKey, tokens: t0.total, spent: t0.spent, calls: t0.calls } : null,
      days,
    })) + "\n");
    return 0;
  }
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

// ---- 机器可读（nyra stats --json）----
// 成本侧第四个 JSON 出口，契约同 savings/cost/verdict：只加字段、不改名、不删字段。
//
// 两个刻意的取舍：
//   · `spent_usd` 用 null 表示"本月有调用但没配单价"——不是 0。账本里这类调用只记 token
//     不记金额，写成 0 会让看板以为"这个月免费"。
//   · `incomplete: true` 单独给一个布尔——"有调用未计价"与"真没花钱"是两件事，
//     消费方需要能一眼区分，而不是从 null 里猜。

export const STATS_JSON_SCHEMA = 1;

export interface StatsJson {
  schema_version: number;
  month: string;
  month_tokens: number;
  month_spent_usd: number | null;
  /** 本月是否有调用没配单价（有 → spent 不完整）。 */
  incomplete: boolean;
  mcp_spent_usd: number | null;
  monthly_limit_usd: number | null;
  reset_at: string;
  /** 今日（本地日期）。 */
  today: { date: string; tokens: number; spent_usd: number | null; calls: number } | null;
  /** 最近 N 天，按日期升序；只含真的有调用或 token 的天。 */
  days: { date: string; tokens: number; spent_usd: number | null; calls: number }[];
}

/** 把 stats 要显示的东西整理成结构。账本读取与计价由调用方完成，这里只做整形。 */
export function buildStatsJson(input: {
  month: string;
  monthTokens: number;
  monthSpentUsd: number | null;
  incomplete: boolean;
  mcpSpentUsd: number | null;
  monthlyLimitUsd: number | null;
  resetAt: string;
  today: { date: string; tokens: number; spent: number | null; calls: number } | null;
  days: { date: string; tokens: number; spent: number | null; calls: number }[];
}): StatsJson {
  const day = (d: { date: string; tokens: number; spent: number | null; calls: number }) => ({
    date: d.date,
    tokens: d.tokens,
    spent_usd: d.spent,
    calls: d.calls,
  });
  return {
    schema_version: STATS_JSON_SCHEMA,
    month: input.month,
    month_tokens: input.monthTokens,
    month_spent_usd: input.monthSpentUsd,
    incomplete: input.incomplete,
    mcp_spent_usd: input.mcpSpentUsd,
    monthly_limit_usd: input.monthlyLimitUsd,
    reset_at: input.resetAt,
    today: input.today ? day(input.today) : null,
    days: input.days.map(day),
  };
}
