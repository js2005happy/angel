// src/usage.ts — Token 用量统计，与 Python 版 nyra/usage.py 同语义。
// 只统计 provider 实际报告的数字；上下文窗口只用用户配置的数字，绝不按模型名猜。
export function contextLimit(value: unknown): number | null {
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function count(value: unknown): number | null {
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

export interface UsageSnapshot {
  calls: number;
  reported_calls: number;
  missing_calls: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  prompt_samples: number;
  completion_samples: number;
  total_samples: number;
  last_prompt_tokens: number | null;
  context_window_tokens: number | null;
  context_remaining_tokens: number | null;
}

export class UsageTracker {
  configuredWindow: number | null;
  calls = 0;
  reported_calls = 0;
  prompt_tokens = 0;
  completion_tokens = 0;
  total_tokens = 0;
  prompt_samples = 0;
  completion_samples = 0;
  total_samples = 0;
  last_prompt_tokens: number | null = null;

  constructor(configuredWindow?: number | null) {
    this.configuredWindow = configuredWindow ?? null;
  }

  record(response: unknown): void {
    this.calls += 1;
    const usage = (response as Record<string, unknown>)?.usage;
    if (!usage || typeof usage !== "object") return;
    const u = usage as Record<string, unknown>;
    let prompt = count(u.prompt_tokens);
    if (prompt === null) prompt = count(u.input_tokens);
    let completion = count(u.completion_tokens);
    if (completion === null) completion = count(u.output_tokens);
    const total = count(u.total_tokens);
    if (prompt === null && completion === null && total === null) return;
    this.reported_calls += 1;
    if (prompt !== null) {
      this.prompt_tokens += prompt;
      this.prompt_samples += 1;
      this.last_prompt_tokens = prompt;
    }
    if (completion !== null) {
      this.completion_tokens += completion;
      this.completion_samples += 1;
    }
    if (total !== null) {
      this.total_tokens += total;
      this.total_samples += 1;
    } else if (prompt !== null && completion !== null) {
      this.total_tokens += prompt + completion;
      this.total_samples += 1;
    }
  }

  snapshot(): UsageSnapshot {
    const window = contextLimit(this.configuredWindow);
    const last = this.last_prompt_tokens;
    const remaining = window !== null && last !== null ? Math.max(0, window - last) : null;
    return {
      calls: this.calls,
      reported_calls: this.reported_calls,
      missing_calls: this.calls - this.reported_calls,
      prompt_tokens: this.prompt_samples ? this.prompt_tokens : null,
      completion_tokens: this.completion_samples ? this.completion_tokens : null,
      total_tokens: this.total_samples ? this.total_tokens : null,
      prompt_samples: this.prompt_samples,
      completion_samples: this.completion_samples,
      total_samples: this.total_samples,
      last_prompt_tokens: last,
      context_window_tokens: window,
      context_remaining_tokens: remaining,
    };
  }
}

export function formatUsage(snapshot: UsageSnapshot): string {
  const shown = (v: number | null) => (typeof v === "number" ? v.toLocaleString("en-US") : "未报告");
  const lines = [
    `模型调用：${snapshot.calls} 次；返回用量：${snapshot.reported_calls} 次`,
    `Token（已报告）：输入 ${shown(snapshot.prompt_tokens)} / 输出 ${shown(snapshot.completion_tokens)} / 合计 ${shown(snapshot.total_tokens)}`,
  ];
  if (snapshot.missing_calls) {
    lines.push(`注：${snapshot.missing_calls} 次响应未返回 token 用量，累计值不完整。`);
  }
  const window = snapshot.context_window_tokens;
  const recent = snapshot.last_prompt_tokens;
  const remaining = snapshot.context_remaining_tokens;
  if (window === null) {
    lines.push("上下文剩余：未知（未配置该模型的 context_window_tokens）。");
  } else if (recent === null) {
    lines.push(`上下文剩余：未知（配置上限 ${window.toLocaleString("en-US")}，尚无可用输入 token 数据）。`);
  } else {
    lines.push(
      `最近请求输入：${recent.toLocaleString("en-US")} / 配置窗口：${window.toLocaleString("en-US")} tokens；` +
      `参考余量约 ${remaining!.toLocaleString("en-US")}（不含本轮生成和下一次输入）。`,
    );
  }
  return lines.join("\n");
}
