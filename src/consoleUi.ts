// src/consoleUi.ts — 终端输出样式与工具打印，与 Python 版 nyra/console.py 同语义。
// 颜色只在 TTY 且 NO_COLOR 未设且 TERM 不是 dumb 时启用；其余情况纯文本。
const STYLES: Record<string, string> = {
  bold: "1", dim: "2", gold: "33", blue: "34", cyan: "36", green: "32", red: "31",
};

export function useColor(stream?: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  const s = stream ?? process.stdout;
  try {
    return Boolean(typeof (s as unknown as { isTTY?: unknown }).isTTY === "boolean" && (s as unknown as { isTTY: boolean }).isTTY);
  } catch {
    return false;
  }
}

export function style(text: string, ...names: string[]): string {
  return styleEnabled(text, names, undefined);
}

export function styleEnabled(text: string, names: string[], enabled?: boolean): string {
  const on = enabled ?? useColor();
  const codes = names.filter((n) => n in STYLES).map((n) => STYLES[n]);
  if (!on || !codes.length) return text;
  return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
}

export function oneLine(value: unknown, limit = 80): string {
  let text: string;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const parts: string[] = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      parts.push(`${key}=${item && typeof item === "object" ? "…" : String(item)}`);
    }
    text = parts.join(" ");
  } else {
    text = String(value ?? "");
  }
  text = text.split(/\s+/).join(" ");
  if (text.length > limit) text = text.slice(0, Math.max(0, limit - 1)) + "…";
  return text;
}

export class ToolPrinter {
  stream: NodeJS.WriteStream;
  color: boolean;

  constructor(stream?: NodeJS.WriteStream, color?: boolean) {
    this.stream = stream ?? process.stdout;
    this.color = color ?? useColor(this.stream);
  }

  private s(text: string, ...names: string[]): string {
    return styleEnabled(text, names, this.color);
  }

  call(kind: string, data: Record<string, unknown>): void {
    let line: string | null = null;
    if (kind === "tool_start") {
      const name = String(data.name ?? "");
      const args = oneLine(data.arguments ?? "", 70);
      line = `${this.s("┌", "dim")} ${this.s(name, "cyan", "bold")} ${this.s(args, "dim")}`;
    } else if (kind === "tool_result") {
      const result = String(data.result ?? "");
      const failed = result.startsWith("错误：") || result.startsWith("执行失败：");
      const mark = failed ? this.s("✗", "red") : this.s("✓", "green");
      line = `${this.s("└", "dim")} ${mark} ${this.s(oneLine(result, 90), "dim")}`;
    } else if (kind === "tool_stream") {
      let text = String(data.text ?? "").replace(/\n$/, "");
      if (text.length > 200) text = text.slice(0, 199) + "…";
      line = data.stream === "stderr"
        ? `${this.s("│", "dim")} ${this.s(text, "red")}`
        : `${this.s("│", "dim")} ${this.s(text, "dim")}`;
    } else if (kind === "assistant") {
      line = this.s("· " + oneLine(data.content ?? "", 100), "dim");
    } else {
      return;
    }
    this.stream.write(line + "\n");
  }
}

/** REPL 状态行：[模型] | 目录 · 上下文 n% · 模式；上下文只用模型实际报告的数字，未报告显示 --。 */
export function formatReplStatus(model: string, cwd: string, contextUsage: number | null, mode: string): string {
  const pct = contextUsage === null || contextUsage === undefined ? "--" : `${Math.round(contextUsage * 100)}%`;
  return `[${model}] | ${cwd} · 上下文 ${pct} · ${mode}`;
}
