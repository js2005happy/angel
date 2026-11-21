// src/golden.ts — 缺口 29（交付契约）+ G-2：Golden 测试集 + 轨迹评分 + checkers。
//
// 契约管“这次任务的验收标准是什么”；Golden 集管“Nyra 自己跑任务的能力有没有
// 退步”——一小批固定输入，每个配期望输出（须出现的子串）与期望的工具轨迹
// （按顺序该调哪些工具）：不只看最后答得对不对，还看它走了哪几步。
//   - 轨迹分：期望工具按顺序在真实轨迹里出现几成（多余的步骤不扣分，漏掉的扣分）；
//   - 结果分：期望子串在最终输出里出现几成；
//   - 合计分 = 两项均值；合计分 ≥ 阈值（默认 0.8，单用例可改）才算通过；
//   - 分数只作内部回归基线，不对外宣传（避开“先宣传后交付”红线）。
//
// checkers 的写法在 checkers.ts：Golden 的结果分就是 output-contains 的批量版，
// 轨迹分就是 trajectory-contains 的顺序版——同一套“检查即代码”的口径。
// 生产对话重打分：`golden rescore --run <运行 ID> --case <用例>` 从运行记录的
// tool_start 事件里取真实轨迹（不重新执行、不花 token），结果分须另给
// --output-file（运行记录里不存最终输出文本）。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveHome } from "./config.ts";
import { RunStore } from "./runs.ts";

export class GoldenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenError";
  }
}

export interface GoldenCase {
  id: string;
  name: string;
  /** 固定输入：交给 agent 的任务文本。 */
  input: string;
  /** 期望输出：最终输出里须出现的子串（区分大小写，全出现才满分）。 */
  expectedOutputs: string[];
  /** 期望工具轨迹：按顺序该调的工具名（多余步骤不扣分，漏掉扣分）。 */
  expectedTrajectory: string[];
  /** 通过阈值（0–1，默认 0.8）。 */
  threshold: number;
  createdAt: string;
}

export interface GoldenResult {
  caseId: string;
  name: string;
  resultScore: number;
  trajectoryScore: number;
  combined: number;
  passed: boolean;
  actualTrajectory: string[];
  missingTools: string[];
  missingOutputs: string[];
  spentUsd: number | null;
}

export interface GoldenRun {
  id: string;
  at: string;
  threshold: number | null;
  results: GoldenResult[];
  /** 全部用例合计分的均值（没用例时为 null）。 */
  meanScore: number | null;
  passed: number;
  total: number;
}

export interface GoldenStore {
  version: 1;
  cases: GoldenCase[];
  runs: GoldenRun[];
}

export function goldenStorePath(home: string): string {
  return join(home, "golden.json");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function newCaseId(): string {
  return `gd_${randomBytes(6).toString("hex")}`;
}

function newRunId(): string {
  return `gr_${randomBytes(6).toString("hex")}`;
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err: unknown) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/** 读 Golden 账本；不存在返回空库；损坏先备份再抛错（不静默重建）。 */
export function loadGoldenStore(home: string): GoldenStore {
  const path = goldenStorePath(home);
  if (!existsSync(path)) return { version: 1, cases: [], runs: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new GoldenError(`Golden 账本损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || !Array.isArray((raw as GoldenStore).cases) || !Array.isArray((raw as GoldenStore).runs)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new GoldenError(`Golden 账本格式无效，已备份到 ${backup}`);
  }
  return raw as GoldenStore;
}

export function saveGoldenStore(home: string, store: GoldenStore): void {
  atomicWriteJson(goldenStorePath(home), store);
}

export function addGoldenCase(
  home: string,
  input: { name: string; input: string; expectedOutputs: string[]; expectedTrajectory: string[]; threshold?: number },
): GoldenCase {
  if (!input.name.trim()) throw new GoldenError("用例要有名字（--name）");
  if (!input.input.trim()) throw new GoldenError("用例要有固定输入（--input）");
  if (!input.expectedOutputs.length && !input.expectedTrajectory.length) {
    throw new GoldenError("用例至少要配期望输出（--expect-output）或期望轨迹（--expect-tool）中的一种");
  }
  const threshold = input.threshold ?? 0.8;
  if (!(threshold > 0 && threshold <= 1)) throw new GoldenError("阈值须在 0–1 之间");
  const c: GoldenCase = {
    id: newCaseId(),
    name: input.name,
    input: input.input,
    expectedOutputs: input.expectedOutputs,
    expectedTrajectory: input.expectedTrajectory,
    threshold,
    createdAt: nowIso(),
  };
  const store = loadGoldenStore(home);
  store.cases.push(c);
  saveGoldenStore(home, store);
  return c;
}

export function getGoldenCase(home: string, id: string): GoldenCase | null {
  return loadGoldenStore(home).cases.find((c) => c.id === id) ?? null;
}

export function removeGoldenCase(home: string, id: string): boolean {
  const store = loadGoldenStore(home);
  const idx = store.cases.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  store.cases.splice(idx, 1);
  saveGoldenStore(home, store);
  return true;
}

/**
 * 轨迹分：期望工具按顺序在真实轨迹里出现几成（贪心顺序匹配）。
 * 期望为空时记 1（这项没要求）；多余的工具调用不扣分。
 */
export function scoreTrajectory(expected: string[], actual: string[]): { score: number; matched: number; missing: string[] } {
  if (!expected.length) return { score: 1, matched: 0, missing: [] };
  let pos = 0;
  let matched = 0;
  const missing: string[] = [];
  for (const tool of expected) {
    const at = actual.indexOf(tool, pos);
    if (at < 0) {
      missing.push(tool);
      continue;
    }
    matched += 1;
    pos = at + 1;
  }
  return { score: matched / expected.length, matched, missing };
}

/** 结果分：期望子串在最终输出里出现几成。期望为空时记 1。 */
export function scoreResult(expectedOutputs: string[], outputText: string): { score: number; missing: string[] } {
  if (!expectedOutputs.length) return { score: 1, missing: [] };
  const missing = expectedOutputs.filter((s) => !outputText.includes(s));
  return { score: (expectedOutputs.length - missing.length) / expectedOutputs.length, missing };
}

/** 一个用例的打分：轨迹分 + 结果分，合计分是两项均值。 */
export function scoreGoldenCase(
  c: GoldenCase,
  output: string,
  trajectory: string[],
  spentUsd: number | null,
  thresholdOverride?: number | null,
): GoldenResult {
  const result = scoreResult(c.expectedOutputs, output);
  const traj = scoreTrajectory(c.expectedTrajectory, trajectory);
  const combined = (result.score + traj.score) / 2;
  const threshold = thresholdOverride ?? c.threshold;
  return {
    caseId: c.id,
    name: c.name,
    resultScore: result.score,
    trajectoryScore: traj.score,
    combined,
    passed: combined >= threshold,
    actualTrajectory: trajectory,
    missingTools: traj.missing,
    missingOutputs: result.missing,
    spentUsd,
  };
}

/** 跑一次 Golden 集的执行器：接固定输入，返回最终输出 + 工具轨迹 + 花费。 */
export type GoldenRunner = (input: string) => Promise<{ output: string; trajectory: string[]; spentUsd: number | null }>;

/** 跑一批用例（纯执行 + 打分；写账本由调用方决定）。 */
export async function runGoldenCases(
  cases: GoldenCase[],
  runner: GoldenRunner,
  thresholdOverride?: number | null,
): Promise<GoldenRun> {
  const results: GoldenResult[] = [];
  for (const c of cases) {
    const { output, trajectory, spentUsd } = await runner(c.input);
    results.push(scoreGoldenCase(c, output, trajectory, spentUsd, thresholdOverride));
  }
  const meanScore = results.length ? results.reduce((a, r) => a + r.combined, 0) / results.length : null;
  return {
    id: newRunId(),
    at: nowIso(),
    threshold: thresholdOverride ?? null,
    results,
    meanScore,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
  };
}

export function saveGoldenRun(home: string, run: GoldenRun): void {
  const store = loadGoldenStore(home);
  store.runs.push(run);
  if (store.runs.length > 20) store.runs = store.runs.slice(-20);
  saveGoldenStore(home, store);
}

/** 从运行事件里取工具轨迹（tool_start 的 name，按顺序；只读，不重新执行）。 */
export function trajectoryFromEvents(events: { type: string; name?: unknown }[]): string[] {
  return events
    .filter((e) => e.type === "tool_start" && typeof e.name === "string")
    .map((e) => e.name as string);
}

/**
 * 剥掉 RunRecorder.run  append 的运行报告：报告固定以 "\n----\n" 开头
 *（formatRunReport 首行是空行 + "----"），从最后一处切开即为 agent 原文。
 * 找不到报告标记时原样返回。
 */
export function stripRunReport(text: string): string {
  const marker = "\n----\n";
  const at = text.lastIndexOf(marker);
  if (at < 0) return text;
  return text.slice(0, at);
}

export function formatGoldenRun(run: GoldenRun): string {
  const lines = [
    `Golden 集跑分：${run.passed}/${run.total} 通过，均分 ${run.meanScore === null ? "—" : run.meanScore.toFixed(3)}`,
    ...run.results.map((r) =>
      `  ${r.passed ? "✓" : "✗"} ${r.name}：合计 ${r.combined.toFixed(3)}（结果 ${r.resultScore.toFixed(2)}、轨迹 ${r.trajectoryScore.toFixed(2)}）`
      + `${r.missingTools.length ? ` 缺工具：${r.missingTools.join("、")}` : ""}`
      + `${r.missingOutputs.length ? ` 缺输出：${r.missingOutputs.map((s) => s.slice(0, 40)).join("、")}` : ""}`
      + `${r.spentUsd === null ? "" : ` 花费 $${r.spentUsd.toFixed(4)}`}`,
    ),
  ];
  return lines.join("\n");
}

// ---- 子命令：golden（G-2：Golden 测试集 + 轨迹评分） ----

const USAGE = "用法：nyra golden <add|list|show|remove|run|rescore> [选项]\n"
  + "  add --name \"<名字>\" --input \"<固定输入>\" [--expect-output \"<子串>\" ...] [--expect-tool \"<工具名>\" ...] [--threshold 0.8]  加用例\n"
  + "  list [--json]  列出用例\n"
  + "  show <用例 id>  看用例与最近跑分\n"
  + "  remove <用例 id> --yes  删除用例\n"
  + "  run [--case <用例 id>] [--threshold <0-1>] --yes  真跑 Golden 集（调模型花真钱，须 --yes）\n"
  + "  rescore --run <运行 ID> --case <用例 id> [--output-file <路径>]  给一次已跑完的生产运行重打分（不重新执行、不花 token）\n";

function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`${flag}=`)) out.push(argv[i].slice(flag.length + 1));
  }
  return out;
}

function flagValue(argv: string[], flag: string): string | null {
  const values = flagValues(argv, flag);
  return values.length ? values[values.length - 1] : null;
}

export async function handleGolden(argv: string[], home: string, runner?: GoldenRunner): Promise<number> {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action) {
    process.stdout.write(USAGE);
    return 2;
  }
  try {
    if (action === "list") {
      const store = loadGoldenStore(resolvedHome);
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(store.cases, null, 2) + "\n");
        return 0;
      }
      if (!store.cases.length) {
        process.stdout.write("没有 Golden 用例（先 nyra golden add 加一个）。\n");
        return 0;
      }
      for (const c of store.cases) {
        process.stdout.write(`${c.id} ${c.name}（期望输出 ${c.expectedOutputs.length} 条、期望轨迹 ${c.expectedTrajectory.length} 步、阈值 ${c.threshold}）\n`);
      }
      return 0;
    }
    if (action === "add") {
      const name = flagValue(argv, "--name") ?? "";
      const input = flagValue(argv, "--input") ?? "";
      const thresholdRaw = flagValue(argv, "--threshold");
      const threshold = thresholdRaw ? parseFloat(thresholdRaw) : undefined;
      if (thresholdRaw && (!(threshold! > 0) || !(threshold! <= 1))) {
        process.stderr.write("错误：--threshold 是 0–1 之间的数\n");
        return 2;
      }
      const c = addGoldenCase(resolvedHome, {
        name,
        input,
        expectedOutputs: flagValues(argv, "--expect-output"),
        expectedTrajectory: flagValues(argv, "--expect-tool"),
        threshold,
      });
      process.stdout.write(`Golden 用例已加：${c.id}（${c.name}）。\n`);
      return 0;
    }
    if (action === "show") {
      const id = argv[1] ?? "";
      const c = id ? getGoldenCase(resolvedHome, id) : null;
      if (!c) {
        process.stderr.write("错误：用法：nyra golden show <用例 id>\n");
        return 2;
      }
      const store = loadGoldenStore(resolvedHome);
      const lastRun = [...store.runs].reverse().find((r) => r.results.some((x) => x.caseId === id));
      const lastResult = lastRun?.results.find((x) => x.caseId === id);
      const lines = [
        `Golden 用例 ${c.id}：${c.name}（阈值 ${c.threshold}）`,
        `固定输入：${c.input}`,
        `期望输出：${c.expectedOutputs.length ? c.expectedOutputs.join("；") : "（无）"}`,
        `期望轨迹：${c.expectedTrajectory.length ? c.expectedTrajectory.join(" → ") : "（无）"}`,
        lastResult
          ? `最近跑分（${lastRun!.at}）：合计 ${lastResult.combined.toFixed(3)}（结果 ${lastResult.resultScore.toFixed(2)}、轨迹 ${lastResult.trajectoryScore.toFixed(2)}）${lastResult.passed ? "通过" : "未通过"}`
          : "还没跑过分。",
      ];
      process.stdout.write(lines.join("\n") + "\n");
      return 0;
    }
    if (action === "remove") {
      const id = argv[1] ?? "";
      if (!id || !argv.includes("--yes")) {
        process.stderr.write("错误：用法：nyra golden remove <用例 id> --yes\n");
        return 2;
      }
      if (!removeGoldenCase(resolvedHome, id)) {
        process.stderr.write(`找不到用例 ${id}\n`);
        return 1;
      }
      process.stdout.write(`已删除用例 ${id}。\n`);
      return 0;
    }
    if (action === "run") {
      if (!argv.includes("--yes")) {
        process.stderr.write("错误：golden run 会真调模型花真钱，须加 --yes 确认：nyra golden run --yes\n");
        return 2;
      }
      if (!runner) {
        process.stderr.write("错误：golden run 须从 CLI 跑（要起真实 agent）\n");
        return 2;
      }
      const store = loadGoldenStore(resolvedHome);
      const caseId = flagValue(argv, "--case");
      const thresholdRaw = flagValue(argv, "--threshold");
      const threshold = thresholdRaw ? parseFloat(thresholdRaw) : null;
      if (thresholdRaw && (!(threshold! > 0) || !(threshold! <= 1))) {
        process.stderr.write("错误：--threshold 是 0–1 之间的数\n");
        return 2;
      }
      let cases = store.cases;
      if (caseId) {
        const one = store.cases.find((c) => c.id === caseId);
        if (!one) {
          process.stderr.write(`找不到用例 ${caseId}\n`);
          return 1;
        }
        cases = [one];
      }
      if (!cases.length) {
        process.stdout.write("没有 Golden 用例可跑（先 nyra golden add 加一个）。\n");
        return 0;
      }
      const run = await runGoldenCases(cases, runner, threshold);
      saveGoldenRun(resolvedHome, run);
      process.stdout.write(formatGoldenRun(run) + "\n");
      return run.passed === run.total ? 0 : 1;
    }
    if (action === "rescore") {
      const runId = flagValue(argv, "--run") ?? "";
      const caseId = flagValue(argv, "--case") ?? "";
      if (!runId || !caseId) {
        process.stderr.write("错误：用法：nyra golden rescore --run <运行 ID> --case <用例 id> [--output-file <路径>]\n");
        return 2;
      }
      const c = getGoldenCase(resolvedHome, caseId);
      if (!c) {
        process.stderr.write(`找不到用例 ${caseId}\n`);
        return 1;
      }
      let events: { type: string; name?: unknown }[];
      try {
        const store = new RunStore(join(resolvedHome, "runs"));
        events = store.readEvents(runId) as { type: string; name?: unknown }[];
      } catch {
        process.stderr.write(`找不到运行 ${runId}\n`);
        return 1;
      }
      const trajectory = trajectoryFromEvents(events);
      const outputFile = flagValue(argv, "--output-file");
      let output = "";
      if (outputFile) {
        try {
          output = readFileSync(outputFile, "utf-8");
        } catch {
          process.stderr.write(`读不到输出文件：${outputFile}\n`);
          return 1;
        }
      }
      const result = scoreGoldenCase(c, output, trajectory, null);
      const lines = [
        `重打分：运行 ${runId} 按用例 ${c.name} 打`,
        `轨迹（${trajectory.length} 步）：${trajectory.join(" → ") || "（无工具调用）"}`,
        `结果分 ${result.resultScore.toFixed(2)}（期望输出 ${c.expectedOutputs.length} 条，缺 ${result.missingOutputs.length} 条）`,
        `轨迹分 ${result.trajectoryScore.toFixed(2)}（期望工具 ${c.expectedTrajectory.length} 个，缺：${result.missingTools.join("、") || "无"}）`,
        `合计 ${result.combined.toFixed(3)}（阈值 ${c.threshold}）：${result.passed ? "通过" : "未通过"}`,
      ];
      if (!outputFile && c.expectedOutputs.length) lines.push("没给 --output-file，结果分按空输出算：要打结果分请把运行的最终输出存文件再重打。");
      process.stdout.write(lines.join("\n") + "\n");
      return result.passed ? 0 : 1;
    }
    process.stderr.write(`错误：未知子命令 golden ${action}\n${USAGE}`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
