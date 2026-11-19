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
  /** 文档一致性检查结果（不传 = 没查，按未知处理）。 */
  docs?: { ok: boolean; findings: readonly { code: string; command: string; doc: string }[]; mentioned: readonly string[] } | null;
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

  // ---- 文档侧（一致性）----
  if (!input.docs) {
    unknowns.push("文档一致性没查（无法判断命令索引是否过期）");
  } else if (input.docs.ok) {
    reasons.push(`文档一致性：通过（${input.docs.mentioned.length} 个子命令均有记录）`);
  } else {
    const stale = input.docs.findings.filter((f) => f.code === "stale-command");
    reasons.push(`文档一致性：${input.docs.findings.length} 处不一致（过期引用 ${stale.length}）`);
    nextSteps.push(stale.length
      ? `先修过期引用：文档里写了 nyra ${stale[0].command}，但代码里没有`
      : `补文档：nyra ${input.docs.findings[0].command} 没有任何说明`);
  }

  // ---- 汇总 ----
  let grade: VerdictGrade;
  if (evidenceOk === false) grade = "red";
  else if (evidenceOk === null) grade = "yellow";
  else if (costOk === null) grade = "yellow";
  // 红线未设（warn）也是"能跑但不齐"：不能算 green。
  else if (warnCount > 0) grade = "yellow";
  else if (!costOk) grade = "yellow";
  // 文档不一致算质量问题，降到 yellow：它不像红线 fail 那样直接推翻证据。
  else if (input.docs && !input.docs.ok) grade = "yellow";
  else if (blockers.length) grade = "yellow";
  else grade = "green";

  const docDrift = Boolean(input.docs && !input.docs.ok);
  const headline = grade === "red"
    ? "不值：证据不过关，先修红线"
    : grade === "yellow"
      ? `勉强：能跑，但${blockers.length ? `有 ${blockers.length} 个阻断项` : docDrift ? "文档与代码不一致" : "两侧数据不全"}`
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

// ---- 单次运行的结论（nyra verdict --run <id>）----
// 与配置级 verdict 的区别：配置级问"这套设置值不值"，运行级问"这一次跑成了没有、代价多大"。
// 判定只认三样东西：**验证结果**（有没有证据）、**运行状态**（跑完没跑完）、**花费**（代价多大）。
// 状态字符串的语义在 runs.ts 里定义：verified / verify_failed / completed_unverified / failed / running …

export interface RunVerdictInput {
  run_id: string;
  task?: string | null;
  status: string;
  verify_result?: Record<string, unknown> | null;
  verify_cmd?: string | null;
  changed_files?: readonly string[] | null;
  /** 本次运行（主 agent）已花费；未计价为 null。 */
  spent_usd?: number | null;
  /** 子任务花费合计。 */
  delegate_spent_usd?: number | null;
  error?: string | null;
}

/** 本次运行的总花费：主 + 子；两处都未知时为 null。 */
function runTotal(input: RunVerdictInput): number | null {
  const main = typeof input.spent_usd === "number" && Number.isFinite(input.spent_usd) ? input.spent_usd : null;
  const del = typeof input.delegate_spent_usd === "number" && Number.isFinite(input.delegate_spent_usd) ? input.delegate_spent_usd : null;
  if (main === null && del === null) return null;
  return (main ?? 0) + (del ?? 0);
}

/**
 * 单次运行打分。规则（顺序即优先级）：
 *
 * | 条件 | 等级 | 依据 |
 * |---|---|---|
 * | verify_failed | red | 有证据表明改坏了 |
 * | failed | red | 没跑完，谈不上值 |
 * | verified（exit 0 / passed） | green | 有验证证据 |
 * | completed_unverified | yellow | 跑完了但没有证据 |
 * | 其它状态 | yellow | 状态不明（running 等），不当通过 |
 */
export function buildRunVerdict(input: RunVerdictInput): Verdict {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const nextSteps: string[] = [];
  const unknowns: string[] = [];

  const status = String(input.status ?? "");
  const vr = input.verify_result ?? {};
  const exitCode = typeof vr.exit_code === "number" ? (vr.exit_code as number) : null;
  const passed = typeof vr.passed === "boolean" ? (vr.passed as boolean) : null;
  const files = Array.isArray(input.changed_files) ? input.changed_files : [];
  const cost = runTotal(input);
  const del = typeof input.delegate_spent_usd === "number" && input.delegate_spent_usd > 0 ? input.delegate_spent_usd : null;

  // ---- 状态与证据 ----
  let grade: VerdictGrade;
  if (status === "verify_failed") {
    grade = "red";
    blockers.push(`验证未通过${exitCode !== null ? `（退出码 ${exitCode}）` : ""}：改动没被证明是对的`);
    nextSteps.push(input.verify_cmd ? `先手工跑一次 \`${input.verify_cmd}\` 看真实报错` : "补一条 verify_command，否则下次还是没有证据");
  } else if (status === "failed") {
    grade = "red";
    blockers.push(`运行失败${input.error ? `：${input.error}` : ""}`);
    nextSteps.push("看 `nyra runs` 的失败分类，别在黑盒里重跑");
  } else if (status === "verified" && exitCode === 0) {
    grade = "green";
    reasons.push(`已验证：${input.verify_cmd ?? "验证命令"} 退出码 0`);
  } else if (status === "verified" && exitCode === null) {
    // 状态说 verified 但没退出码：只信状态，标注证据不全
    grade = "yellow";
    reasons.push("状态记为 verified，但没有退出码：证据链不完整");
    unknowns.push("验证退出码缺失（旧运行可能没记）");
  } else if (status === "completed_unverified") {
    grade = "yellow";
    reasons.push("跑完了但没有验证证据：不知道改对没改对");
    nextSteps.push("补 `--verify <cmd>` 重跑一次，或手工验证后在报告里写清结论");
  } else {
    grade = "yellow";
    reasons.push(`状态 ${status || "未知"}：既不算通过也不算失败`);
    unknowns.push(`状态 ${status || "空"} 的语义未覆盖`);
  }

  if (passed === false && grade !== "red") {
    grade = "red";
    blockers.push("验证结果 passed=false");
  }

  // ---- 产物 ----
  if (files.length) {
    reasons.push(`改动 ${files.length} 个文件${files.length <= 3 ? `：${files.join("、")}` : ""}`);
  } else if (status === "verified") {
    reasons.push("没有文件改动（可能是纯查询/分析型任务）");
  }

  // ---- 代价 ----
  if (cost === null) {
    unknowns.push("花费未知（未配单价或 provider 没报 usage）");
  } else {
    reasons.push(`花费 $${cost.toFixed(4)}${del ? `（含子任务 $${del.toFixed(4)}）` : ""}`);
    if (grade === "red" && cost > 0.01) {
      nextSteps.push(`这次失败花了 $${cost.toFixed(4)}：先修根因再重跑，别用重跑碰运气`);
    }
  }

  const headline = grade === "green"
    ? `值：${input.task ? `「${input.task.slice(0, 30)}」` : "本次运行"}有验证证据`
    : grade === "red"
      ? "不值：本次运行没有拿到可用结果"
      : "待定：跑完了，但证据不足以下结论";

  return { grade, headline, reasons, blockers, nextSteps: nextSteps.slice(0, 3), unknowns };
}

// ---- 批量趋势（nyra verdict --recent N）----
// 单次结论回答"这一次"，趋势回答"该修什么"。规则：
//   - 通过率 ≥ 70% → green；>0 但 <70% → yellow；一次都没通过 → red
//   - 失败集中度：某一类**严格过半**才点名（50/50 平分时点名是误导）
//   - 单位成本：每个通过运行平均花多少（衡量"值不值"最直白的数）

export interface TrendVerdictInput {
  runs: readonly RunVerdictInput[];
  /** 失败分类计数（CLI 侧用 classifyFailure 算好后传入）。 */
  failureCounts?: Record<string, number> | null;
}

export interface TrendSummary {
  total: number;
  verified: number;
  verifiedRate: number;
  failed: number;
  unverified: number;
  other: number;
  /** 平均每个**通过**运行的花费；没有通过运行或花费全未知时为 null。 */
  costPerVerifiedUsd: number | null;
  /** 失败最多的类（**严格过半**才给出；两类各占一半时不给，避免误导）。 */
  dominantFailure: { cls: string; count: number; share: number } | null;
}

/** 只做统计，不给结论（便于单测与复用）。 */
export function summarizeTrend(input: TrendVerdictInput): TrendSummary {
  const runs = input.runs ?? [];
  let verified = 0, failed = 0, unverified = 0, other = 0;
  let spendAll = 0;
  let spendKnown = false;
  for (const r of runs) {
    const st = String(r.status ?? "");
    if (st === "verified") verified += 1;
    else if (st === "failed" || st === "verify_failed") failed += 1;
    else if (st === "completed_unverified") unverified += 1;
    else other += 1;
    const total = runTotal(r);
    if (total !== null) { spendAll += total; spendKnown = true; }
  }
  const total = runs.length;
  const counts = input.failureCounts ?? {};
  let dominant: TrendSummary["dominantFailure"] = null;
  const failedCount = Object.values(counts).reduce((a, b) => a + b, 0);
  if (failedCount > 0) {
    for (const [cls, n] of Object.entries(counts)) {
      const share = n / failedCount;
      // 严格过半才点名：两类各占一半时说"集中在某一类"是误导。
      if (share > 0.5 && (!dominant || n > dominant.count)) dominant = { cls, count: n, share };
    }
  }
  return {
    total,
    verified,
    verifiedRate: total ? verified / total : 0,
    failed,
    unverified,
    other,
    costPerVerifiedUsd: spendKnown && verified > 0 ? spendAll / verified : null,
    dominantFailure: dominant,
  };
}

/** 批量趋势结论。 */
export function buildTrendVerdict(input: TrendVerdictInput): Verdict {
  const s = summarizeTrend(input);
  const reasons: string[] = [];
  const blockers: string[] = [];
  const nextSteps: string[] = [];

  if (!s.total) {
    return {
      grade: "yellow",
      headline: "没有运行记录：无从判断趋势",
      reasons: [],
      blockers: [],
      nextSteps: ["先跑一次任务，积累记录后 `nyra verdict --recent 10` 才有意义"],
      unknowns: ["没有任何运行记录"],
    };
  }

  reasons.push(`最近 ${s.total} 次：验证通过 ${s.verified}、失败 ${s.failed}、未验证 ${s.unverified}${s.other ? `、其它 ${s.other}` : ""}`);
  reasons.push(`通过率 ${(s.verifiedRate * 100).toFixed(0)}%`);

  if (s.costPerVerifiedUsd !== null) {
    reasons.push(`每个通过运行平均花 $${s.costPerVerifiedUsd.toFixed(4)}`);
  } else if (s.verified === 0) {
    // 没有通过运行时不谈单位成本——分母是 0，谈它没意义
  } else {
    reasons.push("单位成本未知（花费记录不全）");
  }

  if (s.dominantFailure) {
    const pct = (s.dominantFailure.share * 100).toFixed(0);
    reasons.push(`失败集中在 ${s.dominantFailure.cls}（${s.dominantFailure.count} 次，占 ${pct}%）`);
    nextSteps.push(`先修 ${s.dominantFailure.cls}：它占失败的 ${pct}%，修掉这一类收益最大`);
  }

  let grade: VerdictGrade;
  if (s.verified === 0) {
    grade = "red";
    blockers.push(`${s.total} 次运行没有一次通过验证：当前做法拿不到可用结果`);
    nextSteps.push("看失败分类后改策略，别继续用同一种方式重跑");
  } else if (s.verifiedRate >= 0.7) {
    grade = "green";
  } else {
    grade = "yellow";
    nextSteps.push("通过率不到 70%：优先处理失败那几次的共性原因");
  }

  const headline = grade === "green"
    ? `值：最近 ${s.total} 次里 ${s.verified} 次通过（${(s.verifiedRate * 100).toFixed(0)}%）`
    : grade === "red"
      ? `不值：最近 ${s.total} 次全都失败`
      : `勉强：最近 ${s.total} 次里只通过 ${s.verified} 次`;

  return { grade, headline, reasons, blockers, nextSteps: nextSteps.slice(0, 3), unknowns: [] };
}

// ---- 机器可读输出（nyra verdict --json）----
// 人工看 formatVerdict，机器看这里。CI 门禁只看 grade，看板画趋势线看 reasons 里的数字。
// 字段一旦发布就当契约：不改名、不删字段，只加。

export const VERDICT_JSON_SCHEMA = 1;

export type VerdictKind = "config" | "run" | "trend";

export interface VerdictJson {
  schema_version: number;
  kind: VerdictKind;
  grade: VerdictGrade;
  headline: string;
  reasons: string[];
  blockers: string[];
  next_steps: string[];
  unknowns: string[];
}

/** 转成机器可读结构。纯函数、字段顺序稳定（便于 diff 与快照测试）。 */
export function toVerdictJson(v: Verdict, kind: VerdictKind): VerdictJson {
  return {
    schema_version: VERDICT_JSON_SCHEMA,
    kind,
    grade: v.grade,
    headline: v.headline,
    reasons: [...v.reasons],
    blockers: [...v.blockers],
    next_steps: [...v.nextSteps],
    unknowns: [...v.unknowns],
  };
}

// ---- 守门（nyra guard / pre-push 钩子）----
// verdict 回答"值不值"，guard 回答"**能不能过**"——把判断变成退出码，交给钩子与 CI。
//
// 纪律：guard 只做一件事（把 grade 映射成退出码），不重新判断。这样"人看的报告"与
// "机器看的门禁"永远同源，不会出现"报告说红、门禁放行"这种鬼故事。

/** 等级 → 退出码。`strict` 下 yellow 也不放行（默认只拦 red）。 */
export function guardExitCode(grade: VerdictGrade, opts: { strict?: boolean } = {}): number {
  if (grade === "red") return 2;
  if (grade === "yellow" && opts.strict) return 2;
  return 0;
}

/** 一行输出（钩子里不该刷屏）。 */
export function formatGuardLine(v: Verdict, opts: { strict?: boolean } = {}): string {
  const code = guardExitCode(v.grade, opts);
  const mark = code === 0 ? "✅" : "⛔";
  const why = v.blockers.length ? v.blockers[0] : v.grade === "yellow" ? "有未设项（strict 下不放行）" : "";
  return `${mark} guard ${code === 0 ? "放行" : "拦截"}：${v.grade}${why ? ` —— ${why}` : ""}`;
}
