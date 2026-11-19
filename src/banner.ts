// src/banner.ts — 交互终端外观（Claude Code 风格）：
//   1. 头部：圆角小框，✻ Nyra <版本>，下面是模型 / 模式 / 工作目录；
//   2. 工作区信任：简短的框式确认；
//   3. 输入区：上下两条横线夹一行 "> "，下面一行暗色状态栏。
// 全部是纯函数（文本进、行出），便于快照测试；只做零依赖的环境探测，
// 不 spawn 子进程，不拖慢启动。
//
// 字形：能画框线的终端用 ╭─╮│╰╯ 与 ✻；Windows 上只有确认能渲染的终端
// （Windows Terminal / VS Code / ConEmu / mintty 等）才用，否则（老 conhost
// 点阵字体、未知宿主）退回纯 ASCII，保证不出乱码。NYRA_ASCII=1 强制 ASCII，
// NYRA_UNICODE=1 强制框线。NO_COLOR 只去掉颜色，布局不变。
import { homedir } from "node:os";
import { charWidth, textWidth, truncateWidth } from "./consoleUi.ts";

export interface Glyphs {
  tl: string; tr: string; bl: string; br: string; h: string; v: string;
  mark: string; dot: string; ellipsis: string;
}

export const UNICODE_GLYPHS: Glyphs = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", mark: "✻", dot: "·", ellipsis: "…",
};
export const ASCII_GLYPHS: Glyphs = {
  tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", mark: "*", dot: "-", ellipsis: "...",
};

type Env = Record<string, string | undefined>;

/**
 * 终端能否正确显示框线字符。纯环境变量判断（不跑 chcp 之类的子进程）：
 * - NYRA_ASCII=1 → 否；NYRA_UNICODE=1 → 是；TERM=dumb → 否。
 * - Windows：Windows Terminal（WT_SESSION）、VS Code / 其他声明了
 *   TERM_PROGRAM 的宿主、ConEmu/Cmder（ConEmuANSI=ON）、mintty/MSYS
 *   （TERM=xterm*）才算能；裸 conhost 无法确认字体，按否处理。
 * - 其他平台：locale 明确是非 UTF-8 的编码（如 zh_CN.GBK）时否，其余是。
 */
export function supportsBoxDrawing(env: Env = process.env, platform: string = process.platform): boolean {
  const flag = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  if (flag(env.NYRA_ASCII)) return false;
  if (flag(env.NYRA_UNICODE)) return true;
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return false;
  if (platform === "win32") {
    if (env.WT_SESSION) return true;
    if (env.TERM_PROGRAM) return true;
    if ((env.ConEmuANSI ?? "").toUpperCase() === "ON") return true;
    if (term.startsWith("xterm") || term.includes("256color")) return true;
    return false;
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (locale && locale.includes(".") && !/utf-?8/i.test(locale)) return false;
  return true;
}

export function glyphsFor(unicode: boolean): Glyphs {
  return unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

// ---- 样式（NO_COLOR 由调用方算好 color 传进来） ----
const CODES: Record<string, string> = { bold: "1", dim: "2", gold: "33", cyan: "36", red: "31" };
function paint(text: string, color: boolean, ...names: string[]): string {
  if (!color || !text) return text;
  const codes = names.map((n) => CODES[n]).filter(Boolean);
  return codes.length ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text;
}

/** 去掉 ANSI 颜色序列（测试与宽度计算用）。 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 从左侧截断（保留尾部），超宽时以省略号开头：适合路径。 */
export function truncateLeft(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  const limit = width - textWidth(ellipsis);
  if (limit <= 0) return ellipsis.slice(0, width);
  const chars = [...text];
  const out: string[] = [];
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = charWidth(chars[i]);
    if (used + w > limit) break;
    out.unshift(chars[i]);
    used += w;
  }
  return ellipsis + out.join("");
}

/** 家目录换成 ~，再按列宽从左截断。 */
export function shortenPath(path: string, width: number, home: string = homedir(), ellipsis = "…"): string {
  let p = path;
  if (home) {
    const sep = p.includes("\\") && !p.includes("/") ? "\\" : "/";
    const norm = (s: string) => (sep === "\\" ? s.toLowerCase() : s);
    if (norm(p) === norm(home)) p = "~";
    else if (norm(p).startsWith(norm(home.endsWith(sep) ? home : home + sep))) {
      p = "~" + sep + p.slice(home.length).replace(/^[\\/]+/, "");
    }
  }
  return truncateLeft(p, width, ellipsis);
}

function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - textWidth(text)));
}

/**
 * 把若干行（纯文本 + 各自的样式）画进圆角框。框宽 = 内容宽 + 4，
 * 不超过终端宽度；内容超宽时截断。终端太窄（< 24 列）就不画框，只出文本。
 */
function boxed(
  rows: { text: string; styles?: string[]; path?: boolean }[],
  width: number,
  color: boolean,
  g: Glyphs,
  minInner = 0,
): string[] {
  const cols = Math.max(1, width);
  if (cols < 24) {
    return rows.map((r) => {
      const t = r.path ? truncateLeft(r.text, cols, g.ellipsis) : truncateWidth(r.text, cols, g.ellipsis);
      return paint(t, color, ...(r.styles ?? []));
    });
  }
  const maxInner = cols - 4;
  const inner = Math.min(maxInner, Math.max(minInner, ...rows.map((r) => textWidth(r.text))));
  const border = (s: string) => paint(s, color, "dim");
  const out = [border(g.tl + g.h.repeat(inner + 2) + g.tr)];
  for (const r of rows) {
    const t = r.path ? truncateLeft(r.text, inner, g.ellipsis) : truncateWidth(r.text, inner, g.ellipsis);
    out.push(`${border(g.v)} ${paint(padTo(t, inner), color, ...(r.styles ?? []))} ${border(g.v)}`);
  }
  out.push(border(g.bl + g.h.repeat(inner + 2) + g.br));
  return out;
}

export interface HeaderInfo {
  version: string;
  model: string;
  mode: string;
  cwd: string;
}

/** 头部小框：✻ Nyra <版本>，空一行，模型 / 模式 / 目录（长路径 ~ 与省略号缩短）。 */
export function renderHeader(
  info: HeaderInfo,
  opts: { width: number; color?: boolean; unicode?: boolean; home?: string },
): string[] {
  const color = opts.color ?? false;
  const g = glyphsFor(opts.unicode ?? true);
  const cols = Math.max(1, opts.width);
  const inner = Math.max(1, Math.min(cols, 64) - 4);
  const dirLabel = "目录：";
  const dir = shortenPath(info.cwd, Math.max(8, inner - textWidth(dirLabel) - 2), opts.home ?? homedir(), g.ellipsis);
  const lines = boxed(
    [
      { text: `${g.mark} Nyra ${info.version}`, styles: ["bold"] },
      { text: "" },
      { text: `  模型：${info.model}`, styles: ["dim"] },
      { text: `  模式：${info.mode}`, styles: ["dim"] },
      { text: `  ${dirLabel}${dir}`, styles: ["dim"], path: true },
    ],
    Math.min(cols, 64),
    color,
    g,
    36,
  );
  // 标记单独上金色（框内第二行开头）。
  if (color && lines.length > 1) lines[1] = lines[1].replace(`\x1b[1m${g.mark} `, `\x1b[33;1m${g.mark}\x1b[0m\x1b[1m `);
  return lines;
}

/** 工作区信任：简短框式确认；最后一行是提问（调用方在其后读 y/N）。 */
export function renderTrustPrompt(
  path: string,
  opts: { width: number; color?: boolean; unicode?: boolean; home?: string },
): { lines: string[]; question: string } {
  const color = opts.color ?? false;
  const g = glyphsFor(opts.unicode ?? true);
  const cols = Math.max(1, Math.min(opts.width, 72));
  const inner = Math.max(1, cols - 4);
  const lines = boxed(
    [
      { text: "信任这个工作目录吗？", styles: ["gold", "bold"] },
      { text: path, styles: ["bold"], path: true },
      { text: "Nyra 可以在这里读取、修改和执行文件。", styles: ["dim"] },
    ],
    cols,
    color,
    g,
    Math.min(inner, 36),
  );
  return { lines, question: ` 信任并继续？(y/N) ` };
}

/** 输入区的横线（整行宽，暗色）。 */
export function renderRule(width: number, opts: { color?: boolean; unicode?: boolean } = {}): string {
  const g = glyphsFor(opts.unicode ?? true);
  return paint(g.h.repeat(Math.max(1, width)), opts.color ?? false, "dim");
}

export interface StatusInfo {
  model: string;
  mode: string;
  /** 0..1；null = 模型没有报告，显示 --（不估算）。 */
  contextUsage: number | null;
  /** 只有当前运行时真的支持 shift+tab 切换模式时才传 true。 */
  modeSwitchKey?: boolean;
}

/** 输入区下方的暗色状态栏：模型 · 模式 · 上下文 n%（+ 可选的 shift+tab 提示）。 */
export function renderStatusBar(
  info: StatusInfo,
  opts: { width: number; color?: boolean; unicode?: boolean },
): string {
  const g = glyphsFor(opts.unicode ?? true);
  const pct = info.contextUsage === null || info.contextUsage === undefined || !Number.isFinite(info.contextUsage)
    ? "--"
    : `${Math.round(info.contextUsage * 100)}%`;
  const sep = ` ${g.dot} `;
  let text = [info.model, info.mode, `上下文 ${pct}`].join(sep);
  if (info.modeSwitchKey) text += `${sep}shift+tab to switch modes`;
  const room = Math.max(1, opts.width - 3);
  return paint("  " + truncateWidth(text, room, g.ellipsis), opts.color ?? false, "dim");
}

/** 输入框：上横线 + "> " 行（留空给 readline）+ 下横线 + 状态栏。 */
export function renderInputFrame(
  status: StatusInfo,
  opts: { width: number; color?: boolean; unicode?: boolean },
): { above: string[]; prompt: string; below: string[] } {
  const rule = renderRule(opts.width, opts);
  return {
    above: [rule],
    prompt: paint(">", opts.color ?? false, "bold") + " ",
    below: [rule, renderStatusBar(status, opts)],
  };
}

/** 提交后输入占了几行（"> " + 文本，按终端宽度折行）。 */
export function inputRows(answer: string, width: number): number {
  const cols = Math.max(1, width);
  return Math.max(1, Math.ceil((2 + textWidth(answer)) / cols) || 1);
}
