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
}

export type ParallelThreadStatus = "ok" | "failed" | "timeout" | "rejected";

/**
* 3b review queue 的消费接口：每线程的证据。
* verification 现在只有 "not-verified"：3a 不做自动验证、不替子任务编验证结论；
* 子任务自述的验证情况见 summary 原文，真正的验收结论由 3b 的 verifier 填写。
*/
export interface ParallelThreadEvidence {
/** worktree 隔离下改动的文件（相对路径，取自 git status --porcelain）；非 worktree 为空。 */
changedFiles: string[];
/** worktree 隔离下的 `git diff --stat HEAD` 原文；无改动或非 worktree 为 null。 */
diffStat: string | null;
/** 改动留下的 worktree 路径；无改动、无隔离或已清理时为 null。 */
worktreePath: string | null;
verification: { status: "not-verified"; note: string};
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
}

export interface ParallelDelegateResult {
results: ParallelThreadResult[];
succeeded: number;
failed: number;
timedOut: number;
rejected: number;
/** 全部线程已花美元合计；任一线程未计价时仍为已计价部分之和，调用方不得当成全量。 */
totalSpentUsd: number | null;
totalDurationMs: number;
maxConcurrency: number;
timeoutMs: number;
/** 并发上限被硬顶夹住时为 true（调用方给了 >5）。 */
maxConcurrencyClamped: boolean;
}

export interface ParallelDelegateOptions {
maxConcurrency?: number;
timeoutMs?: number;
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
}
results[index] = {
...base,
status,
summary,
error,
durationMs: Date.now() - threadStartedAt,
model: outcome?.model?? null,
evidence,
};
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
totalDurationMs: Date.now() - startedAt,
maxConcurrency,
timeoutMs,
maxConcurrencyClamped,
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
`；已计价花费合计 ${result.totalSpentUsd === null? "未知（未计价）": "$" + result.totalSpentUsd.toFixed(4)}` +
`（超时线程事后花的钱不进此合计，仍计入父级累计）` +
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
lines.push("验证结论：本批不做自动验证（见各线程证据的 verification 字段），需 3b 的 review queue 验收后再合并。");
return lines.join("\n\n");
}
