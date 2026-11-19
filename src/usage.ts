// src/usage.ts — Token 用量统计，与 Python 版 nyra/usage.py 同语义。
// 只统计 provider 实际报告的数字；上下文窗口只用用户配置的数字，绝不按模型名猜。
import { t } from "./i18n.ts";
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
  const shown = (v: number | null) => (typeof v === "number" ? v.toLocaleString("en-US") : t("usage.notReported"));
  const lines = [
    t("usage.calls", { calls: snapshot.calls, reported: snapshot.reported_calls }),
    t("usage.tokens", { p: shown(snapshot.prompt_tokens), c: shown(snapshot.completion_tokens), t: shown(snapshot.total_tokens) }),
  ];
  if (snapshot.missing_calls) {
    lines.push(t("usage.missing", { n: snapshot.missing_calls }));
  }
  const window = snapshot.context_window_tokens;
  const recent = snapshot.last_prompt_tokens;
  const remaining = snapshot.context_remaining_tokens;
  if (window === null) {
    lines.push(t("usage.windowUnset"));
  } else if (recent === null) {
    lines.push(t("usage.noRecent", { window: window.toLocaleString("en-US") }));
  } else {
    lines.push(
      t("usage.recent", { recent: recent.toLocaleString("en-US"), window: window.toLocaleString("en-US"), remaining: remaining!.toLocaleString("en-US") }),
    );
  }
  return lines.join("\n");
}
