// src/parallelDelegate.ts — 缺口 3a：delegate 并行模式。
//
// 只做并行 delegate 本身：多个互不依赖的子任务同时跑、各自带超时硬约束、
// 失败的线程不拖垮主流程；review queue 与手机审批面是第二批（3b），本批不做，
// 但每线程的结果已经是结构化证据（改了什么、验证结论、成本），可直接被 3b 消费。
//
// 关于 toolPool：报告建议复用 src/toolPool.ts 的 worker 池，核查后未照搬——
// 该池是 node:worker_threads 的 CPU 池（BM25 打分 / JSON 解析 / spin），
// 子 agent 是带 provider、工具集、审批回调与 worktree 状态的主线程异步对象，
// 进 worker 线程要序列化全部上下文且 worktree/sandbox 状态无法共享。
// 本模块复用的是它的纪律而不是它的线程：有界槽位 + 排队 + 单任务超时硬约束，
// 语义与 ToolPool 对齐（超时即判失败、不静默等下去），实现在主线程用信号量做。
// 若以后真要把子 agent 放进 worker 线程，需先解决 provider 与审批状态的
// 序列化，那是另一批工作，不在本批假装已解决。

// 验收结论的状态与审阅队列共用同一套口径（type-only，编译期抹掉，无循环 import）。
import type { VerificationStatus } from "./reviewQueue.ts";
/** H-5：合并后的交付物（type-only；merge.ts 只 import 本文件的类型，无循环 import）。 */
import type { MergedDeliverable } from "./merge.ts";

/** 并行默认并发上限（学 Goose 的硬约束：默认 5，同时也是上限）。 */
export const DEFAULT_PARALLEL_MAX_CONCURRENCY = 5;
/** 并发上限硬顶：调用方给再大也只按 5 跑，并在结果里注明被夹住了。 */
export const MAX_PARALLEL_CONCURRENCY = 5;
/** 单任务默认超时：10 分钟。子任务是 LLM 多轮循环，30 秒（ToolPool 的默认值）不够用。 */
export const DEFAULT_PARALLEL_TASK_TIMEOUT_MS = 600_000;

export interface ParallelTaskSpec {
task: string;
maxTurns?: number;
isolation?: "none" | "worktree";
tools?: string[];
model?: string;
/** H-4：结构化输出契约（JSON Schema），与 delegate 的 output_schema 同义。 */
outputSchema?: Record<string, unknown>;
/** GROK-1：团队模式下这条线程分派给哪个成员（Soul agent 名）；只认团队成员。 */
agent?: string;
}

export type ParallelThreadStatus = "ok" | "failed" | "timeout" | "rejected";

/**
* 3b review queue 的消费接口：每线程的证据。
* verification 由缺口 13 的验收者填写：验收者开启时是真实验收结论
* （verified/failed，方法与时间见 method/at）；未开启时恒为
* "not-verified"（3a 不做自动验证、不替子任务编验证结论；子任务自述的
* 验证情况见 summary 原文，不要把它当成已验证的结论）。
*/
export interface ParallelThreadEvidence {
/** worktree 隔离下改动的文件（相对路径，取自 git status --porcelain）；非 worktree 为空。 */
changedFiles: string[];
/** worktree 隔离下的 `git diff --stat HEAD` 原文；无改动或非 worktree 为 null。 */
diffStat: string | null;
/** 改动留下的 worktree 路径；无改动、无隔离或已清理时为 null。 */
worktreePath: string | null;
/** 验收结论（缺口 13）：状态 + 原因 + 方法（verifier/verifier-deterministic）+ 时间；未验收时只有状态与原因。 */
verification: { status: VerificationStatus; note: string; method?: string | null; at?: string | null };
/** 该线程已花美元；未计价（无单价 / provider 未报用量）时为 null，不编数字。 */
spentUsd: number | null;
}

export interface ParallelThreadResult {
index: number;
task: string;
status: ParallelThreadStatus;
/** 成功时为子任务摘要原文；失败/超时/被拒时为 null。 */
summary: string | null;
/** 失败/超时/被拒的原因；成功时为 null。 */
error: string | null;
durationMs: number;
model: string | null;
evidence: ParallelThreadEvidence;
/** H-4：结构化输出契约的校验结论（没给契约时为 null；通过 true / 未通过 false）。 */
schemaValid: boolean | null;
}

export interface ParallelDelegateResult {
results: ParallelThreadResult[];
succeeded: number;
failed: number;
timedOut: number;
rejected: number;
/** 全部线程已花美元合计；任一线程未计价时仍为已计价部分之和，调用方不得当成全量。 */
totalSpentUsd: number | null;
  /**
   * 仍在后台跑的超时线程数。它们的最终花费事后会计入父级 delegateSpentUsd，
   * 但不进 totalSpentUsd——>0 时 totalSpentUsd 只是下限（汇总文本写 "≥"）。
   */
  pendingAfterTimeout: number;
totalDurationMs: number;
maxConcurrency: number;
timeoutMs: number;
/** 并发上限被硬顶夹住时为 true（调用方给了 >5）。 */
maxConcurrencyClamped: boolean;
/** 3b：已进审阅队列的项 id（只在调用方 opt-in 入队时有内容，否则为空）。 */
reviewEnqueued: string[];
/** 3b：opt-in 入队失败时的原因；未要求入队或入队成功时为 null。 */
reviewEnqueueError: string | null;
/** H-5：合并步的交付物；没开合并时为 null。 */
merged: MergedDeliverable | null;
}

export interface ParallelDelegateOptions {
maxConcurrency?: number;
timeoutMs?: number;
/** H-6：每线程结束时回调（per-group 回填用；回调里抛错不影响线程结果）。 */
onThreadDone?: (result: ParallelThreadResult) => void;
}

export interface ResolvedParallelOptions {
maxConcurrency: number;
timeoutMs: number;
maxConcurrencyClamped: boolean;
}

/** 并发与超时解析：并发夹在 [1, 5]，超时必须是正数否则回默认。 */
export function resolveParallelOptions(opts: ParallelDelegateOptions = {}): ResolvedParallelOptions {
let maxConcurrency = opts.maxConcurrency;
if (typeof maxConcurrency!== "number" ||!Number.isFinite(maxConcurrency)) {
maxConcurrency = DEFAULT_PARALLEL_MAX_CONCURRENCY;
}
maxConcurrency = Math.floor(maxConcurrency);
const clamped = maxConcurrency > MAX_PARALLEL_CONCURRENCY;
if (maxConcurrency < 1) maxConcurrency = 1;
if (clamped) maxConcurrency = MAX_PARALLEL_CONCURRENCY;
let timeoutMs = opts.timeoutMs;
if (typeof timeoutMs!== "number" ||!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
timeoutMs = DEFAULT_PARALLEL_TASK_TIMEOUT_MS;
}
return { maxConcurrency, timeoutMs: Math.floor(timeoutMs), maxConcurrencyClamped: clamped};
}

/** 单个线程的执行结果（由调用方把 delegate 的结构化结果适配进来）。 */
export interface ParallelThreadOutcome {
ok: boolean;
/** 成功时为子任务摘要；失败时可为空，错误见 error。 */
summary: string;
error?: string;
spentUsd: number | null;
model: string | null;
worktreePath: string | null;
changedFiles: string[];
diffStat: string | null;
/** 缺口 13：验收者的验收结论（未开启时不填，调用方按 not-verified 处理）。 */
verification?: ParallelThreadEvidence["verification"];
/** H-4：结构化输出契约的校验结论（没给契约时不填，调用方按 null 处理）。 */
schemaValid?: boolean | null;
}

export type ParallelRunner = (
spec: ParallelTaskSpec,
index: number,
) => Promise<ParallelThreadOutcome>;

const NOT_VERIFIED_NOTE =
"3a 不做自动验证：本线程未经过独立验证，验证结论待 3b 的 review queue / verifier 填写；" +
"子任务自述的验证情况见摘要原文，不要把它当成已验证的结论。";

function emptyEvidence(): ParallelThreadEvidence {
return {
changedFiles: [],
diffStat: null,
worktreePath: null,
verification: { status: "not-verified", note: NOT_VERIFIED_NOTE},
spentUsd: null,
};
}

/**
* 并行跑一批子任务。
*
* 并发语义：最多 maxConcurrency 个同时在跑，其余排队；每个线程单独计时，
* 超过 timeoutMs 即判 timeout，不等它跑完。超时不取消底层的子任务——
* Agent.run 目前没有 AbortSignal，超时的线程仍在后台跑完，它的 worktree
* 清理与花费记账（delegate 的 recordChildUsage）照常走，只是结果不再等它；
* 事后多花的钱仍会计入父级的 delegateSpentUsd，但不进本批返回的 totalSpentUsd，
* 这一点在文档里写明了，不要把 totalSpentUsd 当成最终账单。
*
* 失败隔离：任一线程抛错/超时只记自己那一项，其余线程照常跑完；主流程
* 汇总成功者，失败原因与已花成本逐项注明。
*/
export async function runParallelDelegate(
runOne: ParallelRunner,
tasks: ParallelTaskSpec[],
opts: ParallelDelegateOptions = {},
): Promise<ParallelDelegateResult> {
if (!Array.isArray(tasks) || tasks.length === 0) {
throw new Error("并行委派至少需要一个子任务");
}
const { maxConcurrency, timeoutMs, maxConcurrencyClamped} = resolveParallelOptions(opts);
const startedAt = Date.now();
const results: ParallelThreadResult[] = new Array(tasks.length);
let next = 0;

async function runThread(index: number): Promise<void> {
const spec = tasks[index];
const threadStartedAt = Date.now();
const base: Omit<ParallelThreadResult, "status" | "summary" | "error"> = {
index,
task: spec.task,
durationMs: 0,
model: null,
evidence: emptyEvidence(),
schemaValid: null,
};
const finish = (
status: ParallelThreadStatus,
summary: string | null,
error: string | null,
outcome?: ParallelThreadOutcome,
): void => {
const evidence = emptyEvidence();
if (outcome) {
evidence.changedFiles = outcome.changedFiles?? [];
evidence.diffStat = outcome.diffStat?? null;
evidence.worktreePath = outcome.worktreePath?? null;
evidence.spentUsd = outcome.spentUsd?? null;
if (outcome.verification) evidence.verification = outcome.verification;
}
results[index] = {
...base,
status,
summary,
error,
durationMs: Date.now() - threadStartedAt,
model: outcome?.model?? null,
evidence,
schemaValid: outcome?.schemaValid?? null,
};
// H-6：per-group 回填钩子——回调里抛错不影响线程结果。
if (opts.onThreadDone) {
try { opts.onThreadDone(results[index]); } catch { /* ignore */ }
}
};
try {
const outcome = await runWithTimeout(runOne(spec, index), timeoutMs, index);
if (outcome.ok) finish("ok", outcome.summary, null, outcome);
else finish("failed", null, outcome.error || "子任务失败（未给原因）", outcome);
} catch (err: unknown) {
if (err instanceof ParallelTimeoutError) {
finish("timeout", null, `子任务超时：${timeoutMs}ms 内未返回（底层任务仍在后台跑完，花费仍计入父级累计，但不进本批返回的合计）`);
} else {
finish("failed", null, err instanceof Error? err.message: String(err));
}
}
}

async function worker(): Promise<void> {
while (next < tasks.length) {
const index = next;
next += 1;
await runThread(index);
}
}

const workers = Array.from(
{ length: Math.min(maxConcurrency, tasks.length)},
() => worker(),
);
await Promise.all(workers);

let succeeded = 0;
let failed = 0;
let timedOut = 0;
let rejected = 0;
let totalSpent: number | null = null;
for (const r of results) {
if (r.status === "ok") succeeded += 1;
else if (r.status === "failed") failed += 1;
else if (r.status === "timeout") timedOut += 1;
else rejected += 1;
if (typeof r.evidence.spentUsd === "number") {
totalSpent = (totalSpent?? 0) + r.evidence.spentUsd;
}
}
return {
results,
succeeded,
failed,
timedOut,
rejected,
totalSpentUsd: totalSpent,
  // 超时线程没有 AbortSignal，底层仍在跑：花费此刻未知，且不进 totalSpent。
  pendingAfterTimeout: timedOut,
totalDurationMs: Date.now() - startedAt,
maxConcurrency,
timeoutMs,
maxConcurrencyClamped,
reviewEnqueued: [],
reviewEnqueueError: null,
// H-5：本层不做合并（合并在 agent.ts 的 delegateParallel 里，跑完才有结果可合）。
merged: null,
};
}

export class ParallelTimeoutError extends Error {
constructor(public readonly threadIndex: number) {
super(`并行子任务 ${threadIndex} 超时`);
this.name = "ParallelTimeoutError";
}
}

/** 单线程超时：到点即判失败，不等底层 promise；底层继续跑，挂个 catch 防止未处理 rejection。 */
function runWithTimeout(
promise: Promise<ParallelThreadOutcome>,
timeoutMs: number,
threadIndex: number,
): Promise<ParallelThreadOutcome> {
let timer: ReturnType<typeof setTimeout> | null = null;
const timeout = new Promise<never>((_resolve, reject) => {
timer = setTimeout(() => reject(new ParallelTimeoutError(threadIndex)), timeoutMs);
});
// 超时后底层仍在跑：结果不要了，但 rejection 不能没人接。
void promise.catch(() => undefined);
return Promise.race([promise, timeout]).finally(() => {
if (timer) clearTimeout(timer);
});
}

/**
* 收敛规则（写进并行子任务的系统提示，见 agent.ts 的 delegate）：
* 各线程只做自己那件任务、不碰别线程的文件、不等别的线程；
* 结束时在摘要末尾另起一段写收敛小结（改了哪些文件、验证结论、未验证就写未验证），
* 供 3b 的 review queue 直接消费；审批规则与父级相同，不自动放行。
*/
export function parallelConvergenceNote(index: number, total: number): string {
return (
`你是 ${total} 个并行子任务中的第 ${index + 1} 个，只做自己这件任务：` +
`不要修改、不要读取其他线程负责的文件；不要等待其他线程，也不要跨线程协调；` +
`结束时在摘要末尾另起一段写收敛小结：改了哪些文件（相对路径）、验证结论（跑了什么验证命令、结果如何；没验证就写“未验证”）。` +
`审批规则与父级相同：写文件、执行命令仍按父级审批规则来，不要自动放行；不要编造花费数字。`
);
}

/** 格式化成给模型/用户看的文本：只汇总成功者，失败逐项注明原因与已花成本。 */
export function formatParallelResults(result: ParallelDelegateResult): string {
const lines: string[] = [];
lines.push(
`并行委派完成：共 ${result.results.length} 个线程，成功 ${result.succeeded} 个` +
(result.failed? `，失败 ${result.failed} 个`: "") +
(result.timedOut? `，超时 ${result.timedOut} 个`: "") +
(result.rejected? `，被拒 ${result.rejected} 个`: "") +
`；总耗时 ${(result.totalDurationMs / 1000).toFixed(1)} 秒` +
    `；已计价花费合计 ${result.totalSpentUsd === null ? "未知（未计价）" : (result.pendingAfterTimeout > 0 ? "≥" : "") + "$" + result.totalSpentUsd.toFixed(4)}` +
    `（${result.pendingAfterTimeout > 0 ? `${result.pendingAfterTimeout} 个超时线程仍在后台跑，其花费未结算——上值只是下限` : "无超时线程，上值为全部"}）` +
`；并发上限 ${result.maxConcurrency}（${result.maxConcurrencyClamped? "调用方要求更高，已按硬顶 5 夹住": "默认"}）` +
`，单任务超时 ${Math.round(result.timeoutMs / 1000)} 秒。`,
);
for (const r of result.results) {
const head = ``;
if (r.status === "ok") {
lines.push(
`${head}成功；耗时 ${(r.durationMs / 1000).toFixed(1)} 秒` +
`；花费 ${r.evidence.spentUsd === null? "未知（未计价）": "$" + r.evidence.spentUsd.toFixed(4)}` +
(r.model? `；模型 ${r.model}`: "") +
(r.evidence.worktreePath
? `；worktree：${r.evidence.worktreePath}` +
(r.evidence.changedFiles.length
? `，改动文件：${r.evidence.changedFiles.join("、")}`
: "，无文件改动")
: "") +
`；验收：${r.evidence.verification.status === "verified" ? "通过" : r.evidence.verification.status === "failed" ? "未通过" : "未验收"}${r.evidence.verification.method ? `（${r.evidence.verification.method}）` : ""}` +
`\n${r.summary?? ""}`,
);
} else if (r.status === "timeout") {
lines.push(
`${head}超时；耗时 ${(r.durationMs / 1000).toFixed(1)} 秒` +
`；花费未知（超时前未结算）；原因：${r.error?? ""}`,
);
} else if (r.status === "rejected") {
lines.push(`${head}被拒；原因：${r.error?? ""}`);
} else {
lines.push(
`${head}失败；耗时 ${(r.durationMs / 1000).toFixed(1)} 秒` +
`；花费 ${r.evidence.spentUsd === null? "未知（未计价）": "$" + r.evidence.spentUsd.toFixed(4)}` +
`；原因：${r.error?? ""}`,
);
}
}
const verifiedCount = result.results.filter((r) => r.evidence.verification.status === "verified").length;
const failedCount = result.results.filter((r) => r.evidence.verification.status === "failed").length;
lines.push(
verifiedCount + failedCount > 0
? `验证结论：验收者已验收 ${verifiedCount + failedCount} 个线程（通过 ${verifiedCount} 个，未通过 ${failedCount} 个），未通过的已打回（见各线程证据的 verification 字段），合入前仍需 3b 的 review queue 逐项批。`
: "验证结论：本批未验收（验收者未开启，见各线程证据的 verification 字段），需 3b 的 review queue 验收后再合并。",
);
if (result.reviewEnqueued?.length) {
lines.push(`已进审阅队列 ${result.reviewEnqueued.length} 项（nyra review list 查看）：${result.reviewEnqueued.join("、")}`);
}
if (result.reviewEnqueueError) {
lines.push(`入队失败（结果本身不受影响）：${result.reviewEnqueueError}`);
}
// H-5：开了合并时附合并交付物（#79 同款容忍：手写结果可能没有 merged 字段）。
if (result.merged) {
const m = result.merged;
lines.push(
m.ok
? `合并交付物：${m.title}\n${m.text}\n\n合并核验：确定性检查 ${m.checks.filter((c) => c.passed).length} 通过 / ${m.checks.filter((c) => !c.passed).length} 未通过（merge-deterministic）${m.verified ? "；可进审阅。" : "；未通过，须人批复后再用，不要把合并结果当已验证。"}` +
(m.file ? `\n完整版文件：${m.file}（~/.nyra 下）。` : "") +
(m.reviewItemId ? `\n审阅队列：${m.reviewItemId}（nyra review show ${m.reviewItemId} 查看并批复）。` : `\n审阅队列：未入队${m.reviewEnqueueError ? `（${m.reviewEnqueueError}）` : ""}。`)
: `合并步失败：${m.error ?? "未知原因"}（各线程原文汇总见上，合并交付物未生成）。`,
);
}
return lines.join("\n\n");
}
