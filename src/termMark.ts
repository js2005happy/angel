// src/termMark.ts — 终端欢迎屏上的 Nyra 标志（圆盘 + 光标）。
//
// 能显示内联图片的终端（kitty 图形协议：kitty / Ghostty；iTerm2 内联图片：iTerm2 / WezTerm）直接画
// 标志图片本身（与 App 图标同一份 brandMark 几何，预先生成的 256px PNG，见 termMarkImage.ts），
// 占 18 列 × 9 行；其余终端用半块字符 ▀▄█ 拼。
//
// 半块字符画：几何来自 src/brandMark.ts（圆盘 r=40、光标绕圆心 -6°、光标四周 3 个单位的镂空），
// 光栅化成 18×18 的覆盖率网格（每格 0–f 共 16 级），一个字符格上下各放一个像素
// （终端字符格高 ≈ 宽 × 2，所以像素是方的、圆盘是圆的），画成 18 列 × 9 行。
// 网格与 PNG 都预先算好写成常量（启动时不光栅化、不加载 brandMark / zlib）；
// 改了几何跑 bun scripts/make-term-mark.ts，tests/node/test-term-mark.test.ts 会核对常量与 brandMark 一致。
//
// 字符画的三种画法：
// - color（深色终端、256 色或 truecolor）：每个像素按覆盖率在“假定深底”与浅色圆盘 #F5F5F7 之间
//   混色（先过一条对比度曲线），fg/bg 各管上下半格，边缘抗锯齿；覆盖率很低的像素不上色，露出终端自己的底色——
//   光标就是终端底色（= 入场动画终帧）。
// - mono（浅色终端、16 色、NO_COLOR）：覆盖率 ≥ 50% 的像素画实，不带任何颜色，用终端默认前景色。
//   浅色终端上自然是深色圆盘 + 浅色镂空光标（= 浅色版标志），NO_COLOR 的深色终端上是浅色圆盘。
// - 不能画块字符（老 conhost 等）或终端太窄：不调用这里，欢迎屏退回单行 "✻ Nyra"/"* Nyra"。
import { fgCode, bgCode, mix, type ColorLevel } from "./theme.ts";
import { TERM_MARK_PNG_DARK, TERM_MARK_PNG_LIGHT } from "./termMarkImage.ts";

type Env = Record<string, string | undefined>;

/** 覆盖率网格边长（像素）；字符画是 TERM_MARK_COLS 列 × TERM_MARK_ROWS 行。 */
export const TERM_MARK_PX = 18;
export const TERM_MARK_COLS = TERM_MARK_PX;
export const TERM_MARK_ROWS = TERM_MARK_PX / 2;

/**
 * 预先算好的覆盖率（每行 14 个十六进制数字，0 = 空、f = 全满）：
 * rasterizeMark(18, { disc, bg: null, discFraction: 1, stroke: MARK_STROKE })
 * 的 alpha，量化到 16 级。
 */
export const TERM_MARK_COVERAGE: readonly string[] = [
  "0000049dffd9400000",
  "0003bffffffffb3000",
  "003effffffffffe300",
  "03effffffffffffe30",
  "0bfffd6effffffffb0",
  "4ffffb02cffffffff4",
  "9ffffb0019fffffff9",
  "dffffe00007ffffffd",
  "ffffff000004efffff",
  "ffffff1000002cffff",
  "dfffff400000019ffd",
  "9fffff400000002ff9",
  "4fffff8000007ffff4",
  "0bffff8001001effb0",
  "03efff906d1007fe30",
  "003effd7ef8008e300",
  "0003bffffff8db3000",
  "0000049dffd9400000",
];

/** 深色终端上的圆盘色（= brandMark 的 MARK_PAPER，测试保证二者一致）。 */
export const TERM_MARK_PAPER = "#F5F5F7";
/** 抗锯齿混色时假定的终端底色（常见深色终端 #000–#1E1E1E 的中间值）。 */
export const TERM_MARK_ASSUMED_BG = "#121212";
/**
 * color 画法的对比度曲线：覆盖率 0.2→0.8 线性拉到 0→1（14 像素的小图，灰边太多会发虚），
 * 拉伸后低于 COLOR_FLOOR 的像素不上色（露出终端底色）。
 */
const RAMP_LO = 0.2;
const RAMP_HI = 0.8;
const COLOR_FLOOR = 0.15;

function colorAt(c: number): string | null {
  const v = Math.min(1, Math.max(0, (c - RAMP_LO) / (RAMP_HI - RAMP_LO)));
  return v < COLOR_FLOOR ? null : mix(TERM_MARK_ASSUMED_BG, TERM_MARK_PAPER, v);
}
/** mono 画法里像素画实的门槛。 */
const MONO_THRESHOLD = 8 / 15;

function coverage(x: number, y: number): number {
  return parseInt(TERM_MARK_COVERAGE[y][x], 16) / 15;
}

/**
 * 终端是否是浅色底。NYRA_THEME=light|dark 优先；否则看 COLORFGBG（xterm / rxvt / iTerm /
 * Konsole 等会设，形如 "0;15"，最后一段是底色：7 或 9–15 为浅色）。判断不了时按深色。
 */
export function isLightTerminal(env: Env = process.env): boolean {
  const forced = (env.NYRA_THEME ?? "").toLowerCase();
  if (forced === "light") return true;
  if (forced === "dark") return false;
  const parts = (env.COLORFGBG ?? "").split(";");
  const bg = Number.parseInt(parts[parts.length - 1] ?? "", 10);
  if (!Number.isFinite(bg)) return false;
  return bg === 7 || (bg >= 9 && bg <= 15);
}

export type TermMarkStyle = "color" | "mono";

/** 该用哪种画法：深色终端且 ≥ 256 色才抗锯齿上色，其余（浅色 / 16 色 / 无色）都是 mono。 */
export function termMarkStyle(level: ColorLevel, light = false): TermMarkStyle {
  return level >= 2 && !light ? "color" : "mono";
}

function monoCell(top: number, bottom: number): string {
  const t = top >= MONO_THRESHOLD;
  const b = bottom >= MONO_THRESHOLD;
  return t && b ? "█" : t ? "▀" : b ? "▄" : " ";
}

/**
 * 标志的字符画：TERM_MARK_ROWS 行，每行显示宽度恰好 TERM_MARK_COLS 列（去掉 ANSI 后）。
 * mono 不带任何转义序列。
 */
export function renderTermMark(opts: { level: ColorLevel; light?: boolean }): string[] {
  const style = termMarkStyle(opts.level, opts.light);
  const lines: string[] = [];
  for (let row = 0; row < TERM_MARK_ROWS; row++) {
    let line = "";
    for (let x = 0; x < TERM_MARK_COLS; x++) {
      const top = coverage(x, row * 2);
      const bottom = coverage(x, row * 2 + 1);
      if (style === "mono") { line += monoCell(top, bottom); continue; }
      const tc = colorAt(top);
      const bc = colorAt(bottom);
      if (!tc && !bc) line += " ";
      else if (tc && bc && tc === bc) line += `\x1b[${fgCode(tc, opts.level)}m█\x1b[0m`;
      else if (tc && bc) line += `\x1b[${fgCode(tc, opts.level)};${bgCode(bc, opts.level)}m▀\x1b[0m`;
      else if (tc) line += `\x1b[${fgCode(tc, opts.level)}m▀\x1b[0m`;
      else line += `\x1b[${fgCode(bc!, opts.level)}m▄\x1b[0m`;
    }
    lines.push(line);
  }
  return lines;
}

// ------------------------------------------------------------ 内联图片 ---

export type TermImageProtocol = "kitty" | "iterm";

/**
 * 终端能不能（以及用哪种协议）显示内联图片。只看环境变量，不向终端发查询（不阻塞启动、不往输入里留回应）：
 * - NYRA_IMAGES=0/off/no/none 关掉；NYRA_IMAGES=kitty/iterm 强制某种协议（仍要求是 TTY、不在 tmux/screen 里）。
 * - 非 TTY、tmux / screen（它们不转发图片序列）、TERM=dumb：不画。
 * - kitty 图形协议：kitty（TERM=xterm-kitty / KITTY_WINDOW_ID）、Ghostty（TERM_PROGRAM=ghostty / TERM=xterm-ghostty）。
 * - iTerm2 内联图片：iTerm2（TERM_PROGRAM=iTerm.app，或 ssh 过去后的 LC_TERMINAL=iTerm2）、WezTerm（TERM_PROGRAM=WezTerm）。
 * - sixel 不画：没有可靠的环境变量能判断，探测要发 DA1 查询并等回应。
 */
export function termImageProtocol(env: Env = process.env, tty = true): TermImageProtocol | null {
  const force = (env.NYRA_IMAGES ?? "").trim().toLowerCase();
  if (["0", "off", "no", "none", "false"].includes(force)) return null;
  if (!tty) return null;
  const term = (env.TERM ?? "").toLowerCase();
  if (env.TMUX || env.STY || term.startsWith("screen") || term.startsWith("tmux") || term === "dumb") return null;
  if (force === "kitty" || force === "iterm") return force;
  const prog = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (term === "xterm-kitty" || env.KITTY_WINDOW_ID) return "kitty";
  if (prog === "ghostty" || term === "xterm-ghostty") return "kitty";
  if (prog === "iterm.app" || prog === "wezterm" || (env.LC_TERMINAL ?? "") === "iTerm2") return "iterm";
  return null;
}

/** 把标志图片画在光标处（图片宽 TERM_MARK_COLS 列，高按图片比例，约 TERM_MARK_ROWS 行）的转义序列。 */
export function termMarkImageSequence(protocol: TermImageProtocol, light = false): string {
  const b64 = light ? TERM_MARK_PNG_LIGHT : TERM_MARK_PNG_DARK;
  if (protocol === "iterm") {
    const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
    return `\x1b]1337;File=inline=1;size=${bytes};width=${TERM_MARK_COLS};height=auto;preserveAspectRatio=1:${b64}\x07`;
  }
  // kitty：f=100 PNG、a=T 传完即显示、c=列数（行数按比例）、C=1 不移动光标、q=2 不回任何应答（不往输入里留字）；
  // base64 按 4096 字节分块。
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += 4096) chunks.push(b64.slice(i, i + 4096));
  return chunks.map((c, i) => {
    const more = i < chunks.length - 1 ? 1 : 0;
    const keys = i === 0 ? `a=T,f=100,c=${TERM_MARK_COLS},C=1,q=2,m=${more}` : `m=${more}`;
    return `\x1b_G${keys};${c}\x1b\\`;
  }).join("");
}

/**
 * 欢迎屏已经整段输出（标志位置留空）之后，把图片画回标志的位置：保存光标 → 上移 linesUp 行、
 * 到第 col 列（从 0 起）→ 画图 → 恢复光标。图片只落在已经输出过的行里，不会让屏幕滚动。
 */
export function termMarkImageOverlay(protocol: TermImageProtocol, opts: { linesUp: number; col: number; light?: boolean }): string {
  const up = opts.linesUp > 0 ? `\x1b[${opts.linesUp}A` : "";
  const right = opts.col > 0 ? `\x1b[${opts.col}C` : "";
  return `\x1b7${up}\r${right}${termMarkImageSequence(protocol, opts.light)}\x1b8`;
}
