// src/reasoning.ts — 推理档位与输出冗长度（对齐 Codex 的 model_reasoning_effort / verbosity）。
//
// 为什么省钱：简单任务（改个错别字、看个文件）用 xhigh 推理，付的是最贵的一档 token；
// 复杂任务用 minimal，结果会反复返工——两头都亏。把档位显式化，让"这次该用多少脑子"
// 变成一个可配置、可解释的决定，而不是每次都由默认值决定。
//
// 纪律：
//   - 只认 provider 真认识的键；不认识的档位直接丢弃并说明，不发出去让 API 报错
//   - 未配置就**什么都不发**（payload 与改动前逐字节一致），零配置零影响
//   - 纯函数，便于单测
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type Verbosity = "low" | "medium" | "high";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
export const VERBOSITIES: readonly Verbosity[] = ["low", "medium", "high"];

export interface ReasoningOptions {
  effort?: ReasoningEffort;
  verbosity?: Verbosity;
  /** 被丢弃的配置（值非法/不认识），展示给用户，不静默吞掉。 */
  ignored: { key: string; value: unknown; reason: string }[];
}

function norm(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase();
  return t.length ? t : undefined;
}

/** 从 config 解析推理档位；非法值丢弃并记原因。 */
export function resolveReasoningOptions(config: Record<string, unknown> | null | undefined): ReasoningOptions {
  const cfg = config ?? {};
  const out: ReasoningOptions = { ignored: [] };

  const effortRaw = cfg.reasoning_effort;
  if (effortRaw !== undefined) {
    const e = norm(effortRaw);
    if (e && (REASONING_EFFORTS as readonly string[]).includes(e)) out.effort = e as ReasoningEffort;
    else out.ignored.push({ key: "reasoning_effort", value: effortRaw, reason: `只接受 ${REASONING_EFFORTS.join(" / ")}` });
  }

  const verbosityRaw = cfg.verbosity;
  if (verbosityRaw !== undefined) {
    const v = norm(verbosityRaw);
    if (v && (VERBOSITIES as readonly string[]).includes(v)) out.verbosity = v as Verbosity;
    else out.ignored.push({ key: "verbosity", value: verbosityRaw, reason: `只接受 ${VERBOSITIES.join(" / ")}` });
  }

  return out;
}

/**
 * 变成请求体字段。未配置返回空对象——调用方据此决定"什么都不加"，
 * 保证零配置时 payload 与改动前完全一致。
 */
export function toRequestBody(opts: ReasoningOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.effort) body.reasoning_effort = opts.effort;
  if (opts.verbosity) body.verbosity = opts.verbosity;
  return body;
}

/** 一行摘要（doctor / redlines 用）。 */
export function describeReasoning(opts: ReasoningOptions): string {
  const parts: string[] = [];
  if (opts.effort) parts.push(`推理档位 ${opts.effort}`);
  if (opts.verbosity) parts.push(`输出冗长 ${opts.verbosity}`);
  const head = parts.length ? parts.join("，") : "未配置：按 provider 默认档位（复杂任务建议 high / xhigh）";
  const ignored = opts.ignored.length ? `；已忽略：${opts.ignored.map((i) => `${i.key}=${String(i.value)}`).join("、")}` : "";
  return head + ignored;
}

/**
 * 给一次运行推荐档位：按任务长度与是否含验证命令给个保守建议。
 * 只用于提示，不改运行行为——自动降档会悄悄降低质量，比多花钱更糟。
 */
export function suggestEffort(taskText: string): { effort: ReasoningEffort; reason: string } {
  const len = [...(taskText ?? "")].length;
  const heavy = /(重构|重写|refactor|migrate|迁移|架构|design|设计|安全审计|漏|debug|排查|为什么)/i.test(taskText ?? "");
  if (heavy || len > 400) return { effort: "high", reason: "任务含重构/排查类关键词或描述很长，建议 high" };
  if (len < 80) return { effort: "low", reason: "任务很短且无复杂关键词，建议 low" };
  return { effort: "medium", reason: "普通任务，建议 medium" };
}
