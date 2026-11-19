// src/repeatGuard.ts — 循环检测守卫（OpenMausBot B 项：chat-repeat-guard
// 的思路，用 TypeScript 重写，未复制对方代码）。
//
// 做法：工具调用按“工具名 + 规范化参数（key 排序后 JSON）”做 key、结果文本
// 做 SHA-256 摘要，逐调用计数（不要求连续，两个卡住的调用交替出现也算）。
// 截图类结果不计入（图变了、文字没变，摘要没有意义）；长文本摘要前先截断。
//
// 阈值（默认开启，可由调用方关掉）：
//   同一失败调用 3 次后拒绝执行，并给模型写纸条“换输入、换方法、或说出卡点”；
//   同一成功调用返回同一答案 3 次后提醒、10 次后直接停掉本轮。
// 停轮 / 最大轮数耗尽时的返回文案一律用诚实失败表述（见 honestFailureText），
// 列出失败 / 被拒的调用名，不让模型用漂亮话盖过去。
import { createHash } from "node:crypto";

/** 同一失败调用达到这么多次后，拒绝再执行。 */
export const REPEAT_FAIL_REFUSE_AFTER = 3;
/** 同一成功调用返回同一答案达到这么多次后，提醒模型可能在原地打转。 */
export const REPEAT_SUCCESS_WARN_AFTER = 3;
/** 同一成功调用返回同一答案达到这么多次后，直接停掉本轮。 */
export const REPEAT_SUCCESS_STOP_AFTER = 10;
/** 摘要前先截断到这么多字符：工具结果常含长文本，截断后摘要才稳定。 */
export const REPEAT_DIGEST_TRUNCATE_CHARS = 4000;

/** 不计入循环统计的工具：截图结果是图片，返回文本（路径 + 大小）不能代表答案。 */
export const REPEAT_GUARD_SKIPPED_TOOLS = new Set([
  "browser_screenshot",
  "computer_screenshot",
]);

/** 工具失败结果的前缀（与 tools.ts 里 executeTool 的错误返回一致）。 */
export function isToolErrorResult(result: string): boolean {
  return result.startsWith("错误：") || result.startsWith("执行失败：");
}

/** 递归 key 排序后 JSON：参数顺序不同、内容相同算同一次调用。 */
export function normalizeToolArgs(args: unknown): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sorted((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  try {
    return JSON.stringify(sorted(args)) ?? "null";
  } catch {
    return String(args);
  }
}

/** 循环统计的 key：工具名 + 规范化参数。 */
export function repeatCallKey(name: string, args: unknown): string {
  return `${name}(${normalizeToolArgs(args)})`;
}

/** 结果摘要：先截断长文本再 SHA-256；只比较摘要，不存全文。 */
export function digestResult(result: string): string {
  const truncated = result.slice(0, REPEAT_DIGEST_TRUNCATE_CHARS);
  return createHash("sha256").update(truncated, "utf-8").digest("hex");
}

/**
 * 该次调用结果是否不计入统计：截图类工具的结果不是答案；内嵌的
 * base64 图片数据（data:image/...）同样跳过，只认文本结果。
 */
export function isSkippedRepeatResult(name: string, result: string): boolean {
  if (REPEAT_GUARD_SKIPPED_TOOLS.has(name)) return true;
  if (result.includes("data:image/") && result.includes(";base64,")) return true;
  const trimmed = result.trim();
  if (trimmed.length >= 2000 && /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed)) return true;
  return false;
}

export interface RepeatGuardRecord {
  name: string;
  key: string;
  failures: number;
  /** 同一成功答案的摘要 → 出现次数。 */
  successes: Map<string, number>;
}

export interface RepeatGuardNote {
  /** 追加给模型看的提醒纸条（接到工具结果后附加）。 */
  warn?: string;
  /** 本轮是否应立即停掉（成功同答案达到上限）。 */
  stop: boolean;
}

export class RepeatGuard {
  enabled: boolean;
  stopped = false;
  private counts = new Map<string, RepeatGuardRecord>();
  private refusedKeys = new Map<string, { name: string; count: number }>();

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  private recordFor(name: string, args: unknown): RepeatGuardRecord {
    const key = repeatCallKey(name, args);
    let rec = this.counts.get(key);
    if (!rec) {
      rec = { name, key, failures: 0, successes: new Map() };
      this.counts.set(key, rec);
    }
    return rec;
  }

  /**
   * 调用前问：该调用是否已被拒绝执行。返回纸条（非 null 即拒绝）；
   * 拒绝本身记一笔，供诚实失败汇报列出。
   */
  refuseCall(name: string, args: unknown): string | null {
    if (!this.enabled) return null;
    const rec = this.counts.get(repeatCallKey(name, args));
    if (!rec || rec.failures < REPEAT_FAIL_REFUSE_AFTER) return null;
    const prev = this.refusedKeys.get(rec.key);
    this.refusedKeys.set(rec.key, { name, count: (prev?.count ?? 0) + 1 });
    return (
      `（系统提示：工具 ${name} 用相同参数已连续失败 ${rec.failures} 次，本次拒绝执行。` +
      `请换一个输入、换一种方法，或直接说出卡点，不要重复同一调用。）`
    );
  }

  /**
   * 调用后记一笔。失败记失败数；成功按答案摘要计数，3 次提醒、10 次停轮。
   * 截图 / 二进制结果不计入。
   */
  noteAfter(name: string, args: unknown, result: string): RepeatGuardNote {
    if (!this.enabled) return { stop: false };
    if (isSkippedRepeatResult(name, result)) return { stop: false };
    const rec = this.recordFor(name, args);
    if (isToolErrorResult(result)) {
      rec.failures += 1;
      return { stop: false };
    }
    const digest = digestResult(result);
    const count = (rec.successes.get(digest) ?? 0) + 1;
    rec.successes.set(digest, count);
    if (count >= REPEAT_SUCCESS_STOP_AFTER) {
      this.stopped = true;
      return {
        stop: true,
        warn:
          `（系统提示：工具 ${name} 用相同参数已连续 ${count} 次返回相同结果，本轮已停掉。` +
          `请直接汇报目前已确认的进展与卡点，不要再重复调用。）`,
      };
    }
    if (count === REPEAT_SUCCESS_WARN_AFTER) {
      return {
        stop: false,
        warn:
          `（系统提示：工具 ${name} 用相同参数已连续 ${count} 次返回相同结果，` +
          `请确认这就是你要的答案；如果只是在原地打转，请换方法或直接汇报进展。）`,
      };
    }
    return { stop: false };
  }

  /** 失败过的调用（名 → 失败次数），供诚实失败汇报。 */
  failedCalls(): { name: string; count: number }[] {
    const out: { name: string; count: number }[] = [];
    for (const rec of this.counts.values()) {
      if (rec.failures > 0) out.push({ name: rec.name, count: rec.failures });
    }
    return out;
  }

  /** 被拒绝过的调用（名 → 被拒次数）。 */
  refusedCalls(): { name: string; count: number }[] {
    return [...this.refusedKeys.values()];
  }

  /** 诚实失败表述：分清“失败的调用”和“被拒绝的调用”，附报错原文所在的步骤。 */
  failureSummary(): string {
    const parts: string[] = [];
    const failed = this.failedCalls();
    if (failed.length) {
      parts.push(`失败的调用：${failed.map((f) => `${f.name}（${f.count} 次）`).join("、")}`);
    }
    const refused = this.refusedCalls();
    if (refused.length) {
      parts.push(`被守卫拒绝的调用：${refused.map((f) => `${f.name}（${f.count} 次）`).join("、")}`);
    }
    if (!parts.length) return "";
    return parts.join("；") + "。失败步骤里有报错原文，请按原文核对，不要只凭一句完成来汇报。";
  }

  /** 停轮 / 耗尽时的完整返回文案。 */
  honestFailureText(reason: string): string {
    const summary = this.failureSummary();
    return `（${reason}，任务未完成。${summary ? summary : "本轮没有记录到失败或被拒的工具调用。"}请拆分任务或换方法后重试。）`;
  }

  reset(): void {
    this.counts.clear();
    this.refusedKeys.clear();
    this.stopped = false;
  }
}
