// src/runRecall.ts — 跨会话回忆：同一任务二次运行时，复用上次的结论而不是从零探索。
//
// 为什么省钱：一次跑完 20 轮的任务，第二轮重跑时前面十几轮都在重新"找文件、读代码、
// 试错"——这些结论上次已经得到过、也落在了 runs/ 里（改动文件、验证命令、验证结果）。
// 把它们压缩成几行注入上下文，就能省掉重复探索的 token。
//
// 纪律：
//   - **只回忆已验证或有明确结论的运行**：failed / incomplete 的运行不当作"上次结论"
//   - **必须同工作目录**：别的项目的历史没有参考价值
//   - **有界输出**：每条最多几行、总长有上限，不能把上下文又撑爆
//   - 明确标注"这是历史结论，不是当前事实"——历史可能已过期，模型必须自己复核
import type { RunState } from "./runs.ts";
import { tokenizeQuery } from "./toolSearch.ts";

export interface RecallOptions {
  /** 相似度阈值（0-1）。默认 0.3。 */
  threshold?: number;
  /** 最多回忆几条。默认 3。 */
  limit?: number;
  /** 总字数上限。默认 1200。 */
  maxChars?: number;
  /** 当前工作目录；只回忆同一目录的运行。 */
  workdir?: string;
  /** 要排除的运行 ID（通常是本次运行的 ID）。 */
  excludeRunId?: string;
}

export interface RecalledRun {
  run_id: string;
  task: string;
  status: string;
  score: number;
  changed_files: string[];
  verify_cmd: string | null;
  verify_exit: number | null;
  created_at: string;
}

/** 只回忆这些状态：有明确结论的运行。 */
const RECALLABLE = new Set(["verified", "verify_failed", "completed_unverified"]);

/** 任务文本相似度：词集合的 Jaccard，中文走 2-gram（与工具检索同一套分词）。 */
export function taskSimilarity(a: string, b: string): number {
  const ta = new Set(tokenizeQuery(a ?? ""));
  const tb = new Set(tokenizeQuery(b ?? ""));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 从运行历史里挑出与当前任务相似的几条。纯函数。 */
export function selectRecalledRuns(runs: readonly RunState[], task: string, opts: RecallOptions = {}): RecalledRun[] {
  const threshold = opts.threshold ?? 0.3;
  const limit = Math.max(1, Math.floor(opts.limit ?? 3));
  const workdir = opts.workdir;
  const out: RecalledRun[] = [];

  for (const r of runs) {
    const rec = r as unknown as Record<string, unknown>;
    const id = str(rec.run_id);
    if (!id || id === opts.excludeRunId) continue;
    const status = str(rec.status);
    if (!RECALLABLE.has(status)) continue;
    if (workdir && str(rec.workdir) && str(rec.workdir) !== workdir) continue;
    const pastTask = str(rec.task);
    const score = taskSimilarity(task, pastTask);
    if (score < threshold) continue;
    const vr = (rec.verify_result ?? {}) as Record<string, unknown>;
    out.push({
      run_id: id,
      task: pastTask,
      status,
      score,
      changed_files: Array.isArray(rec.changed_files) ? (rec.changed_files as string[]).slice(0, 8) : [],
      verify_cmd: typeof rec.verify_cmd === "string" ? rec.verify_cmd : null,
      verify_exit: typeof vr.exit_code === "number" ? (vr.exit_code as number) : null,
      created_at: str(rec.created_at),
    });
  }
  out.sort((a, b) => b.score - a.score || (a.created_at < b.created_at ? 1 : -1));
  return out.slice(0, limit);
}

/** 把回忆结果压成有界的注入文本；没有可回忆的返回 null（零影响）。 */
export function formatRecallNote(recalled: readonly RecalledRun[], maxChars = 1200): string | null {
  if (!recalled.length) return null;
  const lines: string[] = ["## 上次做过类似任务（历史结论，需自行复核是否仍然成立）"];
  for (const r of recalled) {
    const task = r.task.length > 60 ? r.task.slice(0, 60) + "…" : r.task;
    const statusText = r.status === "verified" ? "已验证" : r.status === "verify_failed" ? "验证未通过" : "未验证";
    const bits: string[] = [`- ${task}（${statusText}，相似度 ${(r.score * 100).toFixed(0)}%）`];
    if (r.changed_files.length) bits.push(`  改过：${r.changed_files.join("、")}`);
    if (r.verify_cmd) bits.push(`  验证：${r.verify_cmd}${r.verify_exit === null ? "" : `（退出码 ${r.verify_exit}）`}`);
    lines.push(bits.join("\n"));
  }
  lines.push("不要假设这些结论仍然成立：先看相关文件的当前内容，再决定要不要沿用。");
  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…（已截断）" : text;
}

/** 一步到位：从历史里挑 + 格式化。 */
export function buildRecallNote(runs: readonly RunState[], task: string, opts: RecallOptions = {}): string | null {
  return formatRecallNote(selectRecalledRuns(runs, task, opts), opts.maxChars ?? 1200);
}
