// src/timeline.ts — 缺口 21：多 agent 执行时间线 + 会话回放（只读）。
// 时间线从已有证据拼出来，不另起一套日志：state.json（任务/状态/用量摘要）
// + events.jsonl（turn/工具/委派/验收/审批/模型切换……）。回放与导出都是
// 纯函数：只读事件，不重新执行任何工具调用、不花 token、不改文件。
// 事件里只记元数据（不记 prompt 全文、不记令牌、不记绝对路径）；渲染时
// 自由文本再过一次 redact，防旧事件里漏网的敏感串。
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RunStore, computeRunStats, redact } from "./runs.ts";

export type TimelineStepKind =
  | "run" | "turn" | "llm" | "tool" | "delegate" | "verdict" | "approval" | "model" | "verify" | "event";

export interface TimelineStep {
  index: number;
  at: string;
  offsetMs: number | null;
  turn: number;
  kind: TimelineStepKind;
  title: string;
  detail: string | null;
  ok: boolean | null;
  durationMs: number | null;
}

export interface Timeline {
  runId: string;
  task: string;
  status: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  turns: number;
  llmCalls: number | null;
  toolCalls: number;
  toolErrors: number;
  runErrors: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  spentUsd: number | null;
  delegateSpentUsd: number | null;
  steps: TimelineStep[];
  eventsTotal: number;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null) return "未知";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatClock(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "??:??:??";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatOffset(ms: number | null): string {
  if (ms === null) return "";
  return ` +${formatDurationMs(ms)}`;
}

function formatUsd(v: number | null): string {
  return v === null ? "未知" : `$${v.toFixed(4)}`;
}

function formatTokens(v: number | null): string {
  return v === null ? "未知" : String(v);
}

function safeText(v: unknown): string {
  return redact(v) ?? "";
}

/** 事件里挑几个关键字段拼成一行（跳过 args_hash：指纹不进正文）。 */
function kvLine(ev: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ev)) {
    if (k === "at" || k === "type" || k === "args_hash") continue;
    if (typeof v === "string") parts.push(`${k}=${safeText(v)}`);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`);
  }
  return parts.length ? parts.join("、") : null;
}

export function buildTimeline(store: RunStore, runId: string): Timeline {
  const state = store.load(runId);
  const stats = computeRunStats(store, runId, state);
  const rawEvents = store.readEvents(runId);
  // 按时间稳定排序（同时间戳保文件顺序）；缺 at 的事件按创建时间算。
  const indexed = rawEvents.map((ev, i) => ({ ev, i }));
  indexed.sort((a, b) => {
    const ta = str(a.ev.at) ?? state.created_at;
    const tb = str(b.ev.at) ?? state.created_at;
    return ta < tb ? -1 : ta > tb ? 1 : a.i - b.i;
  });
  const createdMs = Date.parse(state.created_at);
  const offsetOf = (at: string): number | null => {
    const t = Date.parse(at);
    return Number.isFinite(t) && Number.isFinite(createdMs) ? Math.max(0, t - createdMs) : null;
  };

  const steps: TimelineStep[] = [];
  const pendingTools = new Map<string, TimelineStep>();
  const pendingDelegates = new Map<string, TimelineStep>();
  let turn = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let runErrors = 0;

  const push = (at: string, kind: TimelineStepKind, title: string, detail: string | null, ok: boolean | null, durationMs: number | null): TimelineStep => {
    const step: TimelineStep = { index: 0, at, offsetMs: offsetOf(at), turn, kind, title, detail, ok, durationMs };
    steps.push(step);
    return step;
  };

  for (const { ev } of indexed) {
    const at = str(ev.at) ?? state.created_at;
    const type = str(ev.type) ?? "event";
    switch (type) {
      case "run_started":
        push(at, "run", "运行开始", null, null, null);
        break;
      case "resumed":
        push(at, "run", `续跑（第 ${num(ev.turn) ?? "?"} 轮，中断前 ${num(ev.interrupted_tool_calls) ?? 0} 次工具调用未完成）`, null, null, null);
        break;
      case "turn": {
        const n = num(ev.turn) ?? turn + 1;
        turn = n;
        push(at, "turn", `第 ${n} 轮开始`, null, null, null);
        break;
      }
      case "llm_span": {
        const model = str(ev.model) ?? "未知模型";
        const ok = bool(ev.ok);
        const pt = num(ev.prompt_tokens);
        const ct = num(ev.completion_tokens);
        const tt = num(ev.total_tokens);
        const detail = `耗时 ${formatDurationMs(num(ev.duration_ms))} · prompt ${formatTokens(pt)} / completion ${formatTokens(ct)} / 合计 ${formatTokens(tt)}`;
        push(at, "llm", `模型调用 ${model}${ok === false ? "（失败）" : ""}`, detail, ok, num(ev.duration_ms));
        break;
      }
      case "vision_input": {
        const count = num(ev.count) ?? 0;
        const kinds = str(ev.kinds) ?? "";
        const model = str(ev.model) ?? "未知模型";
        push(at, "event", `看了 ${count} 张图（${model}）`, kinds ? `来源：${kinds}` : null, null, null);
        break;
      }
      case "voice_input": {
        const seconds = num(ev.seconds);
        const chars = num(ev.chars) ?? 0;
        const engine = str(ev.engine) ?? "未知引擎";
        const cost = num(ev.cost_usd);
        push(at, "event", `语音转写（${engine}）`, `${seconds !== null ? `${seconds} 秒 · ` : ""}${chars} 字${cost !== null ? ` · $${cost.toFixed(4)}` : " · 未计价"}`, null, null);
        break;
      }
      case "voice_speak": {
        const chars = num(ev.chars) ?? 0;
        const engine = str(ev.engine) ?? "未知引擎";
        const cost = num(ev.cost_usd);
        push(at, "event", `语音回读（${engine}）`, `${chars} 字${cost !== null ? ` · $${cost.toFixed(4)}` : " · 未计价"}`, null, null);
        break;
      }
      case "office_exported": {
        const format = str(ev.format) ?? "未知格式";
        const bytes = num(ev.bytes) ?? 0;
        const verified = num(ev.verified) ?? 0;
        const unverified = num(ev.unverified) ?? 0;
        push(at, "event", `导出办公成品（${format}）`, `${bytes} 字节 · 事实核查：${verified} 项已核实，${unverified} 项未核实`, null, null);
        break;
      }
      case "media_ingested": {
        const host = str(ev.host) ?? "未知来源";
        const source = str(ev.source) ?? "未知来源";
        const seconds = num(ev.duration_seconds);
        const bytes = num(ev.bytes) ?? 0;
        const cost = num(ev.cost_usd);
        push(at, "event", `抓取媒体转写（${host} · ${source}）`, `${seconds !== null ? `${seconds} 秒 · ` : ""}${bytes} 字节 · 转写来源：${source}${cost !== null ? ` · $${cost.toFixed(4)}` : " · 未计价"}`, null, null);
        break;
      }
      case "peer_asked": {
        const peer = str(ev.peer) ?? "未知对端";
        const ok = bool(ev.ok);
        const hash = str(ev.question_hash);
        push(at, "event", `问对端 ${peer}${ok === false ? "（失败）" : "（已答复）"}`, hash ? `问题指纹 ${hash.slice(0, 12)}…` : null, ok, null);
        break;
      }
      case "peer_handoff": {
        const peer = str(ev.peer) ?? "未知对端";
        const status = str(ev.status) ?? "?";
        const peerRun = str(ev.peer_run_id) ?? "";
        push(at, "event", `交接给对端 ${peer}（${status}）`, peerRun ? `对端运行 ${peerRun}` : null, status === "accepted", null);
        break;
      }
      case "redline_changed": {
        const connector = str(ev.connector) ?? "未知连接器";
        const action = str(ev.action) ?? "未知动作";
        const from = str(ev.from) ?? "?";
        const to = str(ev.to) ?? "?";
        push(at, "event", `红线表改动：${connector} 的 ${action}（${from} → ${to}）`, null, null, null);
        break;
      }
      case "redline_blocked": {
        const connector = str(ev.connector) ?? "未知连接器";
        const action = str(ev.action) ?? "未知动作";
        const tier = str(ev.tier) ?? "?";
        const tool = str(ev.tool);
        push(at, "event", `红线拦截：${connector} 的 ${action}（${tier}）`, tool ? `工具 ${tool}` : null, false, null);
        break;
      }
      case "tool_start": {
        const id = str(ev.id) ?? "";
        const name = str(ev.name) ?? "未知工具";
        toolCalls += 1;
        const step = push(at, "tool", `工具 ${name}`, null, null, null);
        if (id) pendingTools.set(id, step);
        break;
      }
      case "tool_result": {
        const id = str(ev.id) ?? "";
        const name = str(ev.name) ?? "未知工具";
        const ok = bool(ev.ok);
        if (ok === false) toolErrors += 1;
        const hash = str(ev.args_hash);
        const detail = hash ? `参数指纹 ${hash.slice(0, 12)}…` : null;
        const pending = id ? pendingTools.get(id) : undefined;
        if (pending) {
          pendingTools.delete(id);
          pending.ok = ok;
          pending.durationMs = offsetOf(at) !== null && pending.offsetMs !== null ? (offsetOf(at) as number) - (pending.offsetMs as number) : null;
          pending.title = `工具 ${name}${ok === false ? "（失败）" : ""}`;
          pending.detail = detail;
        } else {
          push(at, "tool", `工具 ${name}（结果，无开始记录）${ok === false ? "（失败）" : ""}`, detail, ok, null);
        }
        break;
      }
      case "delegate_start": {
        const taskId = str(ev.task_id) ?? "?";
        const step = push(at, "delegate", `子任务 ${taskId} 启动（模型 ${str(ev.model) ?? "未知"}，最多 ${num(ev.max_turns) ?? "?"} 轮）`, null, null, null);
        pendingDelegates.set(taskId, step);
        break;
      }
      case "delegate_end": {
        const taskId = str(ev.task_id) ?? "?";
        const ok = bool(ev.ok);
        const spent = num(ev.spent_usd);
        const detail = `轮数 ${num(ev.turns) ?? "未知"} · 花费 ${formatUsd(spent)} · 验收：${str(ev.verification) ?? "未验收"}`;
        const pending = pendingDelegates.get(taskId);
        if (pending) {
          pendingDelegates.delete(taskId);
          pending.ok = ok;
          pending.durationMs = offsetOf(at) !== null && pending.offsetMs !== null ? (offsetOf(at) as number) - (pending.offsetMs as number) : null;
          pending.title = `子任务 ${taskId}${ok === false ? "（失败）" : "（完成）"}`;
          pending.detail = detail;
        } else {
          push(at, "delegate", `子任务 ${taskId}${ok === false ? "（失败）" : "（完成）"}`, detail, ok, null);
        }
        break;
      }
      case "parallel_delegate":
        push(at, "delegate", `并行委派：成功 ${num(ev.succeeded) ?? "?"} / 失败 ${num(ev.failed) ?? "?"}（花费 ${formatUsd(num(ev.total_spent_usd))}）`, null, null, null);
        break;
      case "verifier_verdict": {
        const verdict = str(ev.verdict) ?? "not-verified";
        const label = verdict === "verified" ? "通过" : verdict === "failed" ? "未通过" : "未验证";
        const checks = `检查 ${num(ev.checks_passed) ?? "?"} 通过 / ${num(ev.checks_failed) ?? "?"} 未通过`;
        const reason = safeText(ev.reason);
        push(at, "verdict", `验收 ${str(ev.target) ?? "?"}：${label}（${str(ev.source) ?? "?"}）`, `${checks}${reason ? ` · ${reason}` : ""}`, verdict === "verified" ? true : verdict === "failed" ? false : null, null);
        break;
      }
      case "verifier_rework":
        push(at, "verdict", `验收打回重做（第 ${num(ev.attempt) ?? "?"} 次）：${str(ev.target) ?? "?"}`, safeText(ev.reason) || null, false, null);
        break;
      case "reviewer_verdict":
        push(at, "verdict", `审查 ${str(ev.tool) ?? "?"}：${str(ev.decision) ?? "?"}`, safeText(ev.reason) || null, str(ev.decision) === "allow" ? true : str(ev.decision) === "deny" ? false : null, null);
        break;
      case "review_decision":
        push(at, "verdict", `审阅批复 ${str(ev.item_id) ?? "?"}：${str(ev.decision) ?? "?"}`, null, str(ev.decision) === "approve" ? true : str(ev.decision) === "reject" ? false : null, null);
        break;
      case "approval_wait":
        push(at, "approval", `等待审批：${str(ev.tool) ?? "?"}`, null, null, null);
        break;
      case "approval_done":
        push(at, "approval", `审批 ${str(ev.tool) ?? "?"}：${bool(ev.approved) === true ? "批准" : bool(ev.approved) === false ? "拒绝" : "未知"}`, null, bool(ev.approved), null);
        break;
      case "model_switch":
        push(at, "model", `换模型 ${str(ev.from) ?? "?"} → ${str(ev.to) ?? "?"}` + (str(ev.reason) ? `（${safeText(ev.reason)}）` : ""), null, null, null);
        break;
      case "verify_started":
        push(at, "verify", `开始验证：${safeText(ev.command)}`, null, null, null);
        break;
      case "verify_result":
        push(at, "verify", `验证结果：${bool(ev.passed) === true ? "通过" : bool(ev.passed) === false ? "未通过" : "未知"}（退出码 ${num(ev.exit_code) ?? "未知"}，第 ${num(ev.attempt) ?? "?"} 次）`, null, bool(ev.passed), null);
        break;
      case "error":
        runErrors += 1;
        push(at, "event", `运行错误：${str(ev.error_type) ?? "Error"}`, null, false, null);
        break;
      case "max_turns":
        push(at, "event", "达到最大轮数（未完成）", null, false, null);
        break;
      case "interrupted":
        push(at, "event", "运行中断", null, false, null);
        break;
      case "final":
        push(at, "run", "运行结束（模型给出最终回答）", null, null, null);
        break;
      case "status":
        push(at, "event", `状态：${str(ev.from) ?? "?"} → ${str(ev.to) ?? "?"}`, null, null, null);
        break;
      default:
        push(at, "event", type, kvLine(ev), null, null);
        break;
    }
  }
  // 无结果的调用：中断截断的尾巴，标出来而不是假装完成了。
  for (const step of pendingTools.values()) {
    step.title += "（无结果，可能中断）";
    step.ok = null;
  }
  for (const step of pendingDelegates.values()) {
    step.title += "（未结束）";
    step.ok = null;
  }
  steps.forEach((s, i) => { s.index = i + 1; });

  const summary = (state.usage_summary ?? {}) as Record<string, unknown>;
  return {
    runId: state.run_id,
    task: state.task,
    status: state.status,
    mode: state.mode,
    createdAt: state.created_at,
    updatedAt: state.updated_at,
    durationMs: stats.durationMs,
    turns: stats.turns,
    llmCalls: stats.llmCalls,
    toolCalls,
    toolErrors,
    runErrors,
    promptTokens: num(summary.prompt_tokens),
    completionTokens: num(summary.completion_tokens),
    totalTokens: num(summary.total_tokens),
    spentUsd: num(summary.spent_usd) !== null || num(summary.delegate_spent_usd) !== null || num(summary.voice_spent_usd) !== null
      ? (num(summary.spent_usd) ?? 0) + (num(summary.delegate_spent_usd) ?? 0) + (num(summary.voice_spent_usd) ?? 0)
      : null,
    delegateSpentUsd: num(summary.delegate_spent_usd),
    steps,
    eventsTotal: rawEvents.length,
  };
}

function headlineLines(tl: Timeline): string[] {
  return [
    `运行 ${tl.runId}（${tl.status}）`,
    `任务：${safeText(tl.task)}`,
    `总耗时：${formatDurationMs(tl.durationMs)} · 轮次：${tl.turns} · 模型调用：${tl.llmCalls === null ? "未知" : tl.llmCalls} · 工具调用：${tl.toolCalls} · 错误：${tl.toolErrors + tl.runErrors}（工具 ${tl.toolErrors} / 运行 ${tl.runErrors}）`,
    `Token：prompt ${formatTokens(tl.promptTokens)} / completion ${formatTokens(tl.completionTokens)} / 合计 ${formatTokens(tl.totalTokens)} · 花费：${formatUsd(tl.spentUsd)}${tl.delegateSpentUsd !== null ? `（其中子任务 ${formatUsd(tl.delegateSpentUsd)}）` : ""}`,
  ];
}

function stepLine(s: TimelineStep, verbose: boolean): string {
  const mark = s.ok === true ? "✓" : s.ok === false ? "✗" : "·";
  const head = `${s.index}. [${formatClock(s.at)}${formatOffset(s.offsetMs)}] [第 ${s.turn} 轮] ${mark} ${s.title}`;
  if (!verbose) return head;
  const parts: string[] = [head];
  if (s.detail) parts.push(`   ${s.detail}`);
  if (s.durationMs !== null && s.kind !== "llm") parts.push(`   耗时 ${formatDurationMs(s.durationMs)}`);
  return parts.join("\n");
}

/** 文本时间线：统计头 + 按时间编号的步骤（默认摘要，--verbose 展开细节）。 */
export function formatTimelineText(tl: Timeline, opts?: { verbose?: boolean }): string {
  const verbose = opts?.verbose ?? false;
  const lines = [...headlineLines(tl), ""];
  if (!tl.steps.length) lines.push("（本次运行没有事件记录）");
  for (const s of tl.steps) lines.push(stepLine(s, verbose));
  return lines.join("\n");
}

/** 会话回放：按轮次分组的逐步 walkthrough。只读展示，不重新执行任何调用。 */
export function formatReplayText(tl: Timeline, opts?: { verbose?: boolean }): string {
  const verbose = opts?.verbose ?? false;
  const lines = [
    `回放 ${tl.runId}（只读：按原始时序重现，未重新执行任何工具调用、不花 token）`,
    ...headlineLines(tl).slice(1),
    "",
  ];
  if (!tl.steps.length) {
    lines.push("（本次运行没有事件记录，无可回放的步骤）");
    return lines.join("\n");
  }
  let currentTurn = -1;
  for (const s of tl.steps) {
    if (s.turn !== currentTurn) {
      currentTurn = s.turn;
      lines.push(`== 第 ${currentTurn} 轮 ==`);
    }
    lines.push(stepLine(s, verbose));
  }
  lines.push("");
  lines.push(`回放结束：运行状态 ${tl.status}`);
  return lines.join("\n");
}

/** 导出用 Markdown：统计头表格 + 步骤表（与 nyra evidence verify 同口径、可审计）。 */
export function formatTimelineMarkdown(tl: Timeline): string {
  const lines = [
    `# 运行时间线 ${tl.runId}`,
    "",
    `任务：${safeText(tl.task)}`,
    "",
    "| 项目 | 数值 |",
    "| --- | --- |",
    `| 状态 | ${tl.status} |`,
    `| 模式 | ${tl.mode} |`,
    `| 开始 | ${tl.createdAt} |`,
    `| 结束 | ${tl.updatedAt} |`,
    `| 总耗时 | ${formatDurationMs(tl.durationMs)} |`,
    `| 轮次 | ${tl.turns} |`,
    `| 模型调用 | ${tl.llmCalls === null ? "未知" : tl.llmCalls} |`,
    `| 工具调用 | ${tl.toolCalls} |`,
    `| 错误（工具/运行） | ${tl.toolErrors} / ${tl.runErrors} |`,
    `| Token（prompt/completion/合计） | ${formatTokens(tl.promptTokens)} / ${formatTokens(tl.completionTokens)} / ${formatTokens(tl.totalTokens)} |`,
    `| 花费 | ${formatUsd(tl.spentUsd)} |`,
    "",
    "## 步骤",
    "",
    "| # | 时间 | 轮次 | 步骤 | 结论 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const s of tl.steps) {
    const verdict = s.ok === true ? "通过" : s.ok === false ? "失败" : "—";
    const title = s.title.replace(/\|/g, "\\|");
    const detail = s.detail ? `（${s.detail.replace(/\|/g, "\\|")}）` : "";
    lines.push(`| ${s.index} | ${formatClock(s.at)}${formatOffset(s.offsetMs)} | ${s.turn} | ${title}${detail} | ${verdict} |`);
  }
  lines.push("");
  lines.push("注：本报告由运行事件重建，只读回放，未重新执行任何工具调用。");
  return lines.join("\n");
}

/** 导出时间线 Markdown（落盘 0600；父目录不存在时创建 0700）。 */
export function exportTimelineMarkdown(store: RunStore, runId: string, outPath: string): string {
  const tl = buildTimeline(store, runId);
  const md = formatTimelineMarkdown(tl);
  const dir = dirname(outPath);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(outPath, md, { mode: 0o600 });
  try { chmodSync(outPath, 0o600); } catch { /* Windows 不认 POSIX mode，忽略 */ }
  return outPath;
}
