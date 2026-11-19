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
    } else if (kind === "assistant") {
      this.emit("assistant", { content: data.content ?? "" });
    } else if (kind === "max_turns") {
      this.incomplete = true;
      this.emit("turn_limit", { max_turns: data.max_turns });
    }
  }

  failed(code: string, message: string, exitCode: number): number {
    this.emit("run_failed", { error: { code, message }, exit_code: exitCode });
    return exitCode;
  }
}

export function invalidArguments(stream: NodeJS.WriteStream = process.stdout, message = "参数无效，请运行 --help 查看用法"): number {
  return new JsonLines(stream).failed("invalid_arguments", message, EXIT_ARGUMENT);
}
