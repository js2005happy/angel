// src/checkers.ts — 缺口 29（交付契约）+ G-2：checker 即规则代码。
//
// 验收不要只写自然语言描述，要写成可跑的检查函数：每个检查项挂一个 checker id，
// 跑的时候按 id 调函数、逐项给出去/不过 + 证据出处（与证据链同口径：只记出处，
// 不记大段原文）。
//
// 两类 checker：
//   - 内置六项：复用缺口 13 验收者的 runDeterministicChecks（同一份语义，不另造
//     一套；改动存在、文件存在、diff 完整、证据齐全、草稿标未完成、UI 附 before）；
//   - 参数化四项：file-exists:<相对路径>、output-contains:<子串>、
//     trajectory-contains:<工具名>、no-tool:<工具名>（轨迹里不得出现该工具）。
// 全是确定性的：不调模型、零成本、可复跑（--repeat 测 flaky 就靠这个）。
// 模型复核不走这里（模型项在 contract.ts 里一次批量调模型，不是一项调一次）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runDeterministicChecks, type VerifierInput } from "./verifier.ts";

export class CheckerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckerError";
  }
}

/** 一次检查的输入：运行产物 + 输出文本 + 工具轨迹。 */
export interface CheckerInput {
  /** 工作目录（null = 无处核对文件，文件类检查直接不过）。 */
  workdir: string | null;
  worktreePath?: string | null;
  changedFiles: string[];
  diffStat: string | null;
  /** 任务标题与摘要（内置六项用；output-contains 不用这个，用 outputText）。 */
  title: string;
  summary: string;
  /** 任务最终输出文本（output-contains 的核对对象）。 */
  outputText: string;
  /** 工具轨迹：按执行顺序的工具名（trajectory-contains / no-tool 的核对对象）。 */
  trajectory: string[];
  spentUsd: number | null;
}

export interface CheckerResult {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  /** 证据出处：文件路径、命中的子串、工具在轨迹里的位置；无出处时为 null。 */
  evidence: string | null;
}

/** 内置六项（与 VERIFIER_CHECKLIST 同 id、同语义）。 */
export const BUILTIN_CHECKERS: { id: string; label: string; what: string }[] = [
  { id: "has-changes", label: "有可验收的改动", what: "改动文件非空，或 diff 摘要非空" },
  { id: "files-exist", label: "改动文件都存在", what: "每个改动文件在 worktree/工作目录里存在" },
  { id: "diff-stat", label: "diff 摘要完整", what: "有改动文件时 diff 摘要非空" },
  { id: "evidence-complete", label: "证据齐全", what: "摘要非空，且改动位置（worktree 或工作目录）有记录" },
  { id: "draft-labeled", label: "草稿标未完成", what: "标题/摘要含草稿标记时不得声称已完成" },
  { id: "ui-before-shot", label: "UI 改动附 before 证据", what: "改了界面文件时摘要须提 before/对比/截图" },
];

/** 参数化 checker 的前缀（冒号后面是参数，参数本身不许为空）。 */
export const PARAM_CHECKERS: { prefix: string; label: string; what: string }[] = [
  { prefix: "file-exists", label: "交付文件存在", what: "file-exists:<相对路径>：该文件在工作目录里存在" },
  { prefix: "output-contains", label: "输出含指定内容", what: "output-contains:<子串>：最终输出文本里出现该子串" },
  { prefix: "trajectory-contains", label: "轨迹含指定工具", what: "trajectory-contains:<工具名>：工具轨迹里出现过该工具" },
  { prefix: "no-tool", label: "轨迹禁指定工具", what: "no-tool:<工具名>：工具轨迹里不得出现该工具" },
];

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 拆 checker id：`file-exists:docs/a.md` → {kind: "file-exists", arg: "docs/a.md"}。 */
export function parseCheckerId(id: string): { kind: string; arg: string | null } {
  const i = id.indexOf(":");
  if (i < 0) return { kind: id, arg: null };
  return { kind: id.slice(0, i), arg: id.slice(i + 1) };
}

/** 这个 checker id 能不能跑（未知 id 在立契约时就拒绝，不等到验收才报错）。 */
export function isKnownChecker(id: string): boolean {
  if (typeof id !== "string" || !id.trim()) return false;
  const { kind, arg } = parseCheckerId(id.trim());
  if (BUILTIN_CHECKERS.some((c) => c.id === kind) && arg === null) return true;
  const param = PARAM_CHECKERS.find((c) => c.prefix === kind);
  return param !== undefined && arg !== null && arg.length > 0;
}

export function listCheckers(): { id: string; label: string; what: string }[] {
  return [
    ...BUILTIN_CHECKERS.map((c) => ({ id: c.id, label: c.label, what: c.what })),
    ...PARAM_CHECKERS.map((c) => ({ id: `${c.prefix}:<参数>`, label: c.label, what: c.what })),
  ];
}

function builtinInput(input: CheckerInput): VerifierInput {
  return {
    title: input.title,
    summary: input.summary,
    changedFiles: input.changedFiles,
    diffStat: input.diffStat,
    worktreePath: input.worktreePath ?? null,
    workdir: input.workdir,
    spentUsd: input.spentUsd,
  };
}

/** 跑一个 checker（确定性，不调模型）。未知 id 抛 CheckerError。 */
export function runChecker(id: string, input: CheckerInput): CheckerResult {
  const clean = typeof id === "string" ? id.trim() : "";
  if (!isKnownChecker(clean)) throw new CheckerError(`未知 checker：${id}`);
  const { kind, arg } = parseCheckerId(clean);
  const builtin = BUILTIN_CHECKERS.find((c) => c.id === kind);
  if (builtin && arg === null) {
    const found = runDeterministicChecks(builtinInput(input)).find((c) => c.id === kind);
    if (!found) throw new CheckerError(`内置检查 ${kind} 未返回结果`);
    return { id: clean, label: found.label, passed: found.passed, detail: found.detail, evidence: null };
  }
  if (kind === "file-exists" && arg !== null) {
    if (!input.workdir) {
      return { id: clean, label: "交付文件存在", passed: false, detail: "无工作目录，文件无处核对", evidence: null };
    }
    const ok = existsSync(join(input.workdir, arg));
    return {
      id: clean, label: "交付文件存在", passed: ok,
      detail: ok ? `文件在工作目录里：${arg}` : `文件不在工作目录里：${arg}`,
      evidence: ok ? arg : null,
    };
  }
  if (kind === "output-contains" && arg !== null) {
    const ok = input.outputText.includes(arg);
    return {
      id: clean, label: "输出含指定内容", passed: ok,
      detail: ok ? `输出里出现了：${trunc(arg, 80)}` : `输出里没出现：${trunc(arg, 80)}`,
      evidence: ok ? trunc(arg, 80) : null,
    };
  }
  if (kind === "trajectory-contains" && arg !== null) {
    const at = input.trajectory.indexOf(arg);
    return {
      id: clean, label: "轨迹含指定工具", passed: at >= 0,
      detail: at >= 0 ? `轨迹第 ${at + 1} 步调了 ${arg}` : `轨迹里没调过 ${arg}`,
      evidence: at >= 0 ? `${arg}（轨迹第 ${at + 1} 步）` : null,
    };
  }
  if (kind === "no-tool" && arg !== null) {
    const at = input.trajectory.indexOf(arg);
    return {
      id: clean, label: "轨迹禁指定工具", passed: at < 0,
      detail: at < 0 ? `轨迹里没调 ${arg}` : `轨迹第 ${at + 1} 步调了禁用的 ${arg}`,
      evidence: at < 0 ? null : `${arg}（轨迹第 ${at + 1} 步）`,
    };
  }
  throw new CheckerError(`未知 checker：${id}`);
}
