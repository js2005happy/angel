// src/verdict.ts — 一条结论：这次跑得值不值。
//
// 现状：`redlines`（该不该上生产）、`savings`（能省多少）、`recall`（有没有历史可复用）、
// 运行历史（失败分类）是四张分散的表。工具多了以后没人愿意拼，于是「值不值」这个判断
// 被省略——而它恰恰是唯一该看的结论。
//
// 设计纪律：
//   - **结论必须可解释**：每个等级都给出具体依据（哪条红线、哪个机制没开），不输出"感觉"
//   - **证据优先于乐观**：红线有 fail 就是 red，不管省了多少钱
//   - **缺数据不下结论**：某块没传就写"未知"，不当作"通过"
//   - 纯函数、零运行时依赖，便于本地自证与单测
import type { RedlineResult } from "./redlines.ts";
import type { SavingsSummary } from "./savingsSummary.ts";
import type { ModelSavingsReport } from "./modelSavings.ts";

export type VerdictGrade = "green" | "yellow" | "red";

export interface VerdictInput {
  /** 红线自检结果（不传 = 没检查，按未知处理）。 */
  redlines?: RedlineResult | null;
  /** 省钱汇总（不传 = 没算，按未知处理）。 */
  savings?: SavingsSummary | null;
  /** 账本实测的辅助模型节省。 */
  modelSavings?: ModelSavingsReport | null;
  /** 可复用的历史运行条数（null/undefined = 没查）。 */
  recallAvailable?: number | null;
  /** 最近运行的状态分布（如 { verified: 3, verify_failed: 1, failed: 2 }）。 */
  runStatusCounts?: Record<string, number> | null;
  /** 本次运行的预计轮次（用于把"每轮省"折算成"整轮省"）。 */
  turns?: number | null;
}

export interface Verdict {
  grade: VerdictGrade;
  /** 一句话结论。 */
  headline: string;
  /** 支撑结论的事实（每条都带数字/原因）。 */
  reasons: string[];
  /** 阻断项：有它就不能算"值"。 */
  blockers: string[];
  /** 建议的下一步（最多 3 条，按影响排序）。 */
  nextSteps: string[];
  /** 缺哪些输入（不把"未知"当"通过"）。 */
  unknowns: string[];
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

/**
 * 规则（表驱动，顺序即优先级）：
 *
 * | 条件 | 等级 | 依据 |
 * |---|---|---|
 * | 红线有 fail | red | 证据不过关，省再多也不值 |
 * | 无红线数据 | yellow | 未知不当作通过 |
 * | 红线有 warn | yellow | 能跑，但红线未设 |
 * | 有首选的省钱机制没开 | yellow | 能跑，但在烧钱 |
 * | 全都齐 | green | 证据 + 成本两侧都成立 |
 */
export function buildVerdict(input: VerdictInput): Verdict {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const nextSteps: string[] = [];
  const unknowns: string[] = [];

  const rl = input.redlines ?? null;
  const sv = input.savings ?? null;
  const ms = input.modelSavings ?? null;

  // ---- 证据侧（红线）----
  let evidenceOk: boolean | null = null;
  let warnCount = 0;
  if (!rl) {
    unknowns.push("红线自检没跑（无法判断该不该上生产）");
  } else {
    const fails = rl.findings.filter((f) => f.level === "fail");
    const warns = rl.findings.filter((f) => f.level === "warn");
    evidenceOk = fails.length === 0;
    warnCount = warns.length;
    if (fails.length) {
      blockers.push(`${fails.length} 条红线被踩：${fails.map((f) => f.code).join("、")}`);
      nextSteps.push("先修红线（`nyra redlines` 看每条的具体修法）");
    } else {
      reasons.push(`红线全绿（${rl.findings.length} 项检查通过）`);
    }
    if (warns.length) {
      reasons.push(`${warns.length} 条红线未设：${warns.map((f) => f.code).join("、")}`);
      nextSteps.push("补齐未设的红线（成本上限/禁读清单/管理员锁定）");
    }
  }

  // ---- 成本侧（省钱）----
  let costOk: boolean | null = null;
  if (!sv) {
    unknowns.push("省钱汇总没算（无法判断每轮开销）");
  } else {
    const enabled = sv.lines.filter((l) => l.enabled);
    const cap = sv.lines.find((l) => l.mechanism === "cost_cap");
    const capOn = cap?.enabled === true;
    costOk = enabled.length > 0 && capOn;
    if (sv.tokensPerTurnTotal > 0) {
      const turns = typeof input.turns === "number" && input.turns > 0 ? Math.floor(input.turns) : null;
      reasons.push(`每轮可确定省 ${sv.tokensPerTurnTotal} token${turns ? `（${turns} 轮共 ${sv.tokensPerTurnTotal * turns}）` : ""}`);
    }
    if (!capOn) {
      blockers.push("没有成本上限：长任务可能无限烧钱");
      nextSteps.push("设 max_cost_usd（或写进 config.enforced 锁死）");
    }
    if (!enabled.length) {
      reasons.push("所有省钱机制都没开：按默认方式运行（能跑，但每轮都在多花钱）");
      nextSteps.push("至少开一项：`--disable-tool` 裁工具 或 `compact_model` 走便宜压缩");
    }
    if (ms && ms.totalSavedUsd !== 0) {
      reasons.push(ms.totalSavedUsd > 0
        ? `辅助模型实测省 ${fmtUsd(ms.totalSavedUsd)}`
        : `辅助模型实测多花 ${fmtUsd(Math.abs(ms.totalSavedUsd))}（配的模型比主模型贵）`);
    }
  }

  // ---- 复用侧（回忆）----
  const recall = input.recallAvailable;
  if (recall === null || recall === undefined) {
    unknowns.push("没查可复用历史（`nyra recall <任务>` 可查）");
  } else if (recall > 0) {
    reasons.push(`${recall} 条历史可复用：同类任务不必从零探索`);
  } else {
    reasons.push("没有可复用的历史：这次会从零探索（第一次跑正常）");
  }

  // ---- 历史表现侧（运行状态）----
  const counts = input.runStatusCounts ?? null;
  if (counts) {
    const verified = counts.verified ?? 0;
    const failed = (counts.failed ?? 0) + (counts.verify_failed ?? 0);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) {
      reasons.push(`历史 ${total} 次运行：已验证 ${verified}、失败 ${failed}`);
      if (total >= 3 && verified === 0) {
        reasons.push("历史里没有一次通过验证：先解决失败原因，别急着上生产");
        nextSteps.push("看 `nyra runs` 的失败分类，优先修重复出现的那一类");
      }
    }
  }

  // ---- 汇总 ----
  let grade: VerdictGrade;
  if (evidenceOk === false) grade = "red";
  else if (evidenceOk === null) grade = "yellow";
  else if (costOk === null) grade = "yellow";
  // 红线未设（warn）也是"能跑但不齐"：不能算 green。
  else if (warnCount > 0) grade = "yellow";
  else if (!costOk) grade = "yellow";
  else if (blockers.length) grade = "yellow";
  else grade = "green";

  const headline = grade === "red"
    ? "不值：证据不过关，先修红线"
    : grade === "yellow"
      ? `勉强：能跑，但${blockers.length ? `有 ${blockers.length} 个阻断项` : "两侧数据不全"}`
      : "值：证据与成本两侧都成立";

  return {
    grade,
    headline,
    reasons,
    blockers,
    nextSteps: nextSteps.slice(0, 3),
    unknowns,
  };
}

/** 人类可读输出。 */
export function formatVerdict(v: Verdict): string {
  const mark = v.grade === "green" ? "✅" : v.grade === "yellow" ? "⚠️ " : "❌";
  const lines: string[] = [`${mark} ${v.headline}`];
  if (v.reasons.length) {
    lines.push("", "依据：");
    for (const r of v.reasons) lines.push(`  · ${r}`);
  }
  if (v.blockers.length) {
    lines.push("", "阻断项：");
    for (const b of v.blockers) lines.push(`  ✗ ${b}`);
  }
  if (v.unknowns.length) {
    lines.push("", "未知（不当作通过）：");
    for (const u of v.unknowns) lines.push(`  ? ${u}`);
  }
  if (v.nextSteps.length) {
    lines.push("", "下一步：");
    for (let i = 0; i < v.nextSteps.length; i++) lines.push(`  ${i + 1}. ${v.nextSteps[i]}`);
  }
  return lines.join("\n");
}
