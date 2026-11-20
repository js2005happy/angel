// src/jsonMode.ts — 版本化 JSON Lines 输出，与 Python 版 nyra/json_mode.py 同协议。
// stdout 只写机器可读行；退出码：0 完成 / 1 运行失败 / 2 参数无效 /
// 3 达最大轮数未完成 / 4 校验命令失败 / 130 用户中断。
export const SCHEMA_VERSION = 1;
export const EXIT_SUCCESS = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_ARGUMENT = 2;
export const EXIT_INCOMPLETE = 3;
export const EXIT_VERIFY = 4;
/** P2-2：成本上限被触发（运行已中止）。 */
export const EXIT_COST = 5;
export const EXIT_INTERRUPTED = 130;

export class JsonLines {
  seq = 0;
  incomplete = false;
  private stream: NodeJS.WriteStream;

  constructor(stream: NodeJS.WriteStream = process.stdout) {
    this.stream = stream;
  }

  emit(eventType: string, payload: Record<string, unknown> = {}): void {
    this.seq += 1;
    const event = { schema_version: SCHEMA_VERSION, seq: this.seq, type: eventType, ...payload };
    this.stream.write(JSON.stringify(event) + "\n");
  }

  agentEvent(kind: string, data: Record<string, unknown>): void {
    // 原始工具参数/结果绝不进 JSONL（可能含密钥、私人文件）。
    if (["usage", "auto_compact", "auto_compact_failed", "auto_compact_skipped"].includes(kind)) {
      this.emit(kind, data);
    } else if (kind === "cost_update") {
      // P2-3：每轮的看板快照（字段见 src/dashboard.ts 的 DashboardSnapshot）。
      // 与 "cost" 事件不同：cost 只在 priced 时发，cost_update 每轮都发，
      // 算不出金额时 status 为 unpriced/missing、金额字段为 null。
      this.emit("cost_update", data);
    } else if (kind === "model_switch") {
      // 缺口 5：换模型进 JSON 事件流（from/to 是 provider 名与模型名，
      // reason 是已脱敏的 provider 报错原文，截断后发出；手动切换时
      // reason 是固定文案、trigger 为 manual）。
      const reason = typeof data.reason === "string" ? data.reason : "";
      this.emit("model_switch", {
        from: data.from ?? "",
        to: data.to ?? "",
        reason: reason.length > 120 ? reason.slice(0, 117) + "…" : reason,
        trigger: data.trigger ?? "other",
        spent_usd: typeof data.spent_usd === "number" ? data.spent_usd : null,
      });
    } else if (kind === "parallel_delegate") {
      // 缺口 3a：并行委派汇总进 JSON 事件流（成功/失败数、已计价花费合计、并发上限）。
      this.emit("parallel_delegate", {
        succeeded: data.succeeded ?? 0,
        failed: data.failed ?? 0,
        total_spent_usd: typeof data.total_spent_usd === "number" ? data.total_spent_usd : null,
        max_concurrency: data.max_concurrency ?? 5,
      });
    } else if (kind === "verify_started") {
      this.emit("verify_started", { command: data.command ?? "" });
    } else if (kind === "verify_result") {
      this.emit("verify_result", {
        command: data.command ?? "",
        exit_code: data.exit_code,
        passed: Boolean(data.passed),
        attempt: data.attempt,
        tests_modified: Boolean(data.tests_modified),
      });
    } else if (kind === "tool_start") {
      this.emit("tool_start", { id: data.id ?? "", name: data.name ?? "" });
    } else if (kind === "tool_result") {
      const result = data.result;
      this.emit("tool_result", {
        id: data.id ?? "",
        name: data.name ?? "",
        ok: !(typeof result === "string" && result.startsWith("错误：")),
      });
    } else if (kind === "hook_blocked") {
      // 缺口 19：钩子拦截进 JSON 事件流（只记拦截本身，不含工具参数原文）。
      this.emit("hook_blocked", {
        event: data.event ?? "",
        tool: data.tool ?? "",
        hook: data.hook ?? "",
        reason: typeof data.reason === "string" && data.reason.length > 120 ? data.reason.slice(0, 117) + "…" : (data.reason ?? ""),
      });
    } else if (kind === "reviewer_verdict") {
      // 缺口 10：独立审查结论进 JSON 事件流（放行与拦截都记，不含工具参数原文）。
      this.emit("reviewer_verdict", {
        tool: data.tool ?? "",
        decision: data.decision ?? "",
        reason: typeof data.reason === "string" && data.reason.length > 120 ? data.reason.slice(0, 117) + "…" : (data.reason ?? ""),
        reviewer_model: data.reviewer_model ?? "",
      });
    } else if (kind === "assistant") {
      this.emit("assistant", { content: data.content ?? "" });
    } else if (kind === "max_turns") {
      this.incomplete = true;
      this.emit("turn_limit", { max_turns: data.max_turns });
    }
  }

  /**
   * P1-3：失败事件带分类，CI 不需要解析自然语言就能分辨"工具挂 / 模型限流 / 验证没过"。
   * 字段只增不改——`error.class` 与 `error.retryable` 是新增的，老消费者忽略即可。
   */
  failed(code: string, message: string, exitCode: number, extra?: { class?: string; retryable?: boolean; errorName?: string }): number {
    this.emit("run_failed", {
      error: {
        code,
        message,
        ...(extra?.class ? { class: extra.class } : {}),
        ...(typeof extra?.retryable === "boolean" ? { retryable: extra.retryable } : {}),
        ...(extra?.errorName ? { error_name: extra.errorName } : {}),
      },
      exit_code: exitCode,
    });
    return exitCode;
  }
}

export function invalidArguments(stream: NodeJS.WriteStream = process.stdout, message = "参数无效，请运行 --help 查看用法"): number {
  return new JsonLines(stream).failed("invalid_arguments", message, EXIT_ARGUMENT);
}
