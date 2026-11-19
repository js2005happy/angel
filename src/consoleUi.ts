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

// ---- CJK 宽度助手（与 Python nyra/tui.py 的 char_width/text_width/truncate/wrap 同语义） ----
// CJK 与全角字符占 2 列、结合符占 0 列、其余 1 列；unicodedata.east_asian_width
// 的 W/F 档用标准宽字符区段近似（与 wcwidth 一致）。

const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe1f], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];
const COMBINING_RANGES: [number, number][] = [
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x20d0, 0x20ff], [0xfe20, 0xfe2f],
];

function inRanges(code: number, ranges: [number, number][]): boolean {
  for (const [lo, hi] of ranges) if (code >= lo && code <= hi) return true;
  return false;
}

/** 单个字符的终端列宽：结合符 0、宽字符 2、其余 1。 */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (inRanges(code, COMBINING_RANGES)) return 0;
  return inRanges(code, WIDE_RANGES) ? 2 : 1;
}

/** 整段文本的终端列宽（按码点求和，代理对只算一次）。 */
export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

/** 按列宽截断，超限补省略号（与 Python tui.truncate 同语义）。 */
export function truncateWidth(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  const out: string[] = [];
  let used = 0;
  const limit = width - textWidth(ellipsis);
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > limit) break;
    out.push(ch);
    used += w;
  }
  return out.join("") + ellipsis;
}

/** 按列宽换行：能断空格就断空格，否则在 CJK 内任意断开（与 Python tui.wrap 同语义）。 */
export function wrapText(text: string, width: number): string[] {
  width = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > width) {
      const cut = line.lastIndexOf(" ");
      if (cut > 0 && ch !== " " && ![...line.slice(cut)].some((c) => charWidth(c) === 2)) {
        lines.push(line.slice(0, cut));
        line = line.slice(cut + 1);
        used = textWidth(line);
      } else {
        lines.push(line.trimEnd());
        line = "";
        used = 0;
      }
      if (ch === " " && !line) continue;
    }
    line += ch;
    used += w;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
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
