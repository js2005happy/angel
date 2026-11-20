// src/theme.ts — Nyra 终端配色：品牌色、色彩等级探测、渐变。零依赖、纯环境变量判断，
// 不 spawn 子进程，不影响启动速度。
//
// 品牌色取自 DESIGN.md「品牌色（UI v2）」：主色鼠尾草绿 #5F7D5C、强调雾蓝 #6B8CAE、
// 点缀蜜桃珊瑚 #E07856、成功 #4C9A6C、危险 #C24B42。终端多是深色底，原色太暗，
// 这里用同色相提亮的版本（浅色底上也够对比）。
//
// 色彩等级：truecolor（COLORTERM=truecolor/24bit、Windows Terminal、iTerm、WezTerm、
// VS Code 等）→ 256 色（TERM 含 256color）→ 16 色；NO_COLOR / 非 TTY / TERM=dumb → 无色。
// NYRA_COLOR=truecolor|256|16|none 可强制。

import { release as osRelease } from "node:os";

export type ColorLevel = 0 | 1 | 2 | 3; // 0 无色 · 1 16 色 · 2 256 色 · 3 truecolor
type Env = Record<string, string | undefined>;

export type Rgb = [number, number, number];

/** 品牌色（为深色终端提亮过的同色相版本）。 */
export const BRAND = {
  sage: "#8DB58A",       // 主色（鼠尾草绿 #5F7D5C 提亮）
  mist: "#86A9D4",       // 渐变第二色（雾蓝 #6B8CAE 提亮）
  coral: "#E8875F",      // 点缀（蜜桃珊瑚 #E07856）
  rule: "#4A5E49",       // 输入区横线：暗一档的主色
  border: "#5F7D5C",     // 信息卡边框：品牌原色鼠尾草绿
  muted: "#8C948B",      // 次要文字
  text: "#E6EAE5",       // 强调正文
  success: "#5DBB82",
  danger: "#E0675C",
  badgeReadonly: "#4C9A6C",
  badgeAuto: "#7C7FD6",  // 蓝紫
  badgeFull: "#C9493F",
  badgeCreator: "#E07856",
  badgeFg: "#101311",
} as const;

// 16 色回退：每个品牌色对应的基本 SGR 前景码。
const BASIC_FG: Record<string, number> = {
  [BRAND.sage]: 32, [BRAND.mist]: 34, [BRAND.coral]: 33, [BRAND.rule]: 90, [BRAND.border]: 32, [BRAND.muted]: 90,
  [BRAND.text]: 97, [BRAND.success]: 32, [BRAND.danger]: 31,
  [BRAND.badgeReadonly]: 32, [BRAND.badgeAuto]: 35, [BRAND.badgeFull]: 31, [BRAND.badgeCreator]: 33,
  [BRAND.badgeFg]: 30,
};

function flag(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * 终端支持的色彩等级。`tty` 为 false、NO_COLOR、TERM=dumb → 0。
 * 只看环境变量（与 chalk/supports-color 的常见规则一致的子集）。
 */
export function detectColorLevel(env: Env = process.env, tty = true, platform: string = process.platform): ColorLevel {
  const forced = (env.NYRA_COLOR ?? "").toLowerCase();
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  if (forced === "none" || forced === "0") return 0;
  if (forced === "truecolor" || forced === "24bit" || forced === "3") return 3;
  if (forced === "256" || forced === "2") return 2;
  if (forced === "16" || forced === "1") return 1;
  if (!tty) return 0;
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return 0;
  const ct = (env.COLORTERM ?? "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return 3;
  if (env.WT_SESSION) return 3;
  const prog = env.TERM_PROGRAM ?? "";
  if (prog === "iTerm.app" || prog === "WezTerm" || prog === "vscode" || prog === "ghostty" || prog === "Hyper") return 3;
  if (term.includes("truecolor") || term.includes("direct") || term === "xterm-kitty" || term === "xterm-ghostty") return 3;
  if (term.includes("256") || prog === "Apple_Terminal") return 2;
  if (platform === "win32" && (env.ConEmuANSI ?? "").toUpperCase() === "ON") return 2;
  return 1;
}

/**
 * 终端能否正确显示框线 / 块字符。纯环境变量判断（不跑 chcp 之类的子进程）：
 * - NYRA_ASCII=1 → 否；NYRA_UNICODE=1 → 是；TERM=dumb → 否。
 * - Windows：Windows Terminal（WT_SESSION）、VS Code / 其他声明了
 *   TERM_PROGRAM 的宿主、ConEmu/Cmder（ConEmuANSI=ON）、mintty/MSYS
 *   （TERM=xterm*）才算能；裸 conhost 无法确认字体，按否处理。
 * - 其他平台：locale 明确是非 UTF-8 的编码（如 zh_CN.GBK）时否，其余是。
 */
/** Windows 10 1903（build 18362）起，经典控制台 conhost 也能正确显示框线与半块字符。 */
export function modernWindowsConsole(release: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(release);
  if (!m) return false;
  const major = Number(m[1]), build = Number(m[3]);
  return major > 10 || (major === 10 && build >= 18362);
}

export function supportsBoxDrawing(env: Env = process.env, platform: string = process.platform, release: string = osRelease()): boolean {
  if (flag(env.NYRA_ASCII)) return false;
  if (flag(env.NYRA_UNICODE)) return true;
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return false;
  if (platform === "win32") {
    if (env.WT_SESSION) return true;
    if (env.TERM_PROGRAM) return true;
    if ((env.ConEmuANSI ?? "").toUpperCase() === "ON") return true;
    if (term.startsWith("xterm") || term.includes("256color")) return true;
    // 从快捷方式 / 资源管理器启动时，即使由 Windows Terminal 接管窗口也拿不到 WT_SESSION；
    // 现代 Windows 一律按支持处理，老系统才退回 ASCII（NYRA_ASCII=1 可强制关掉）。
    return modernWindowsConsole(release);
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (locale && locale.includes(".") && !/utf-?8/i.test(locale)) return false;
  return true;
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** RGB → xterm 256 色索引（6×6×6 色块与灰阶中取更近的一个）。 */
export function rgbTo256([r, g, b]: Rgb): number {
  const steps = [0, 95, 135, 175, 215, 255];
  const idx = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const ri = idx(r), gi = idx(g), bi = idx(b);
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cr = steps[ri], cg = steps[gi], cb = steps[bi];
  const avg = Math.round((r + g + b) / 3);
  const grayIdx = avg > 238 ? 23 : Math.max(0, Math.round((avg - 8) / 10));
  const gv = 8 + 10 * grayIdx;
  const dist = (a: Rgb, c: Rgb) => (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 + (a[2] - c[2]) ** 2;
  return dist([r, g, b], [gv, gv, gv]) < dist([r, g, b], [cr, cg, cb]) ? 232 + grayIdx : cube;
}

function nearestBasic(hex: string): number {
  if (hex in BASIC_FG) return BASIC_FG[hex];
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  if (max < 60) return 30;
  const bit = (v: number) => (v > max * 0.6 ? 1 : 0);
  return 30 + bit(r) + 2 * bit(g) + 4 * bit(b);
}

/** 前景色 SGR 参数（不含 ESC[ 与 m）；level 0 返回空串。 */
export function fgCode(hex: string, level: ColorLevel): string {
  if (level === 0) return "";
  if (level === 3) { const [r, g, b] = hexToRgb(hex); return `38;2;${r};${g};${b}`; }
  if (level === 2) return `38;5;${rgbTo256(hexToRgb(hex))}`;
  return String(nearestBasic(hex));
}

/** 背景色 SGR 参数。 */
export function bgCode(hex: string, level: ColorLevel): string {
  if (level === 0) return "";
  if (level === 3) { const [r, g, b] = hexToRgb(hex); return `48;2;${r};${g};${b}`; }
  if (level === 2) return `48;5;${rgbTo256(hexToRgb(hex))}`;
  return String(nearestBasic(hex) + 10);
}

export interface PaintOpts { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean }

/** 按色彩等级上色；level 0 原样返回（NO_COLOR 只去颜色，不改布局）。 */
export function paint(text: string, level: ColorLevel, o: PaintOpts): string {
  if (!level || !text) return text;
  const codes: string[] = [];
  if (o.bold) codes.push("1");
  if (o.dim) codes.push("2");
  if (o.italic) codes.push("3");
  if (o.fg) codes.push(fgCode(o.fg, level));
  if (o.bg) codes.push(bgCode(o.bg, level));
  return codes.length ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text;
}

export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * 横向渐变：按列在 from→to 之间插值，每列一个颜色；空格不上色。
 * 16 色时整段用 from 的基本色（避免花哨的色块跳变）。
 */
export function gradient(text: string, level: ColorLevel, from: string = BRAND.sage, to: string = BRAND.mist, bold = false): string {
  if (!level || !text) return text;
  const chars = [...text];
  if (level === 1) return paint(text, level, { fg: from, bold });
  const n = Math.max(1, chars.length - 1);
  let out = "";
  let last = "";
  chars.forEach((ch, i) => {
    if (ch === " ") { if (last) { out += "\x1b[0m"; last = ""; } out += ch; return; }
    const code = (bold ? "1;" : "") + fgCode(mix(from, to, i / n), level);
    if (code !== last) { out += `\x1b[${code}m`; last = code; }
    out += ch;
  });
  if (last) out += "\x1b[0m";
  return out;
}

/** CI 环境（自动隐藏小伙伴等纯装饰元素）。 */
export function isCi(env: Env = process.env): boolean {
  return flag(env.CI) || Boolean(env.GITHUB_ACTIONS || env.BUILDKITE || env.GITLAB_CI || env.JENKINS_URL || env.TF_BUILD);
}
