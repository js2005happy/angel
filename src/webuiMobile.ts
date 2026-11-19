// src/webuiMobile.ts — 手机 PWA（/m）：配对、对话列表、对话、Codex 式审批弹层、自动化、技能、设置。
//
// 视觉严格按设计稿 docs/assets/screenshots/android.png / ios.png（nyra-design v2：mobile.py + kit.py）：
// 浅色默认、黑白单色（白底、黑色主按钮、灰色次要文字、Inter / JetBrains Mono），
// prefers-color-scheme: dark 时用设计稿的 DARK 令牌。样式与前端脚本分别放在
// src/assets/mobile-app.css.txt / mobile-app.js.txt；入场动画移植自原 Nyra splash
// （src/assets/mobile-splash.js.txt）。界面文案在 src/i18n.ts 的 m.* 键（中英）。
// 页面本身不含任何秘密：设备 token 只在 localStorage，每次 API 调用带 X-Nyra-Token 头。
// 图标从 docs/assets/nyra-mark.svg 的几何（圆 r46 + 旋转 -6° 的光标，描边 6 圆角）在本机光栅化成 PNG。
import { deflateSync } from "node:zlib";
import { MESSAGES, type Lang } from "./i18n.ts";
import APP_CSS from "./assets/mobile-app.css.txt" with { type: "text" };
import APP_JS from "./assets/mobile-app.js.txt" with { type: "text" };
import SPLASH_JS from "./assets/mobile-splash.js.txt" with { type: "text" };
import INTER_400 from "./assets/mobile-fonts/inter-400.woff.b64.txt" with { type: "text" };
import INTER_600 from "./assets/mobile-fonts/inter-600.woff.b64.txt" with { type: "text" };
import JBM_400 from "./assets/mobile-fonts/jbm-400.woff.b64.txt" with { type: "text" };

// ---------------------------------------------------------------- 颜色 ---
/** 设计稿令牌（nyra-design v2 kit.py LIGHT / DARK）。图标与入场动画用原 splash 的黑底 / 浅色前景。 */
export const MOBILE_COLORS = {
  light: { bg: "#FFFFFF", fg: "#0D0D0D", muted: "#6E6E73", chip: "#F2F2F3", line: "#ECECEE" },
  dark: { bg: "#0B0B0C", fg: "#EDEDED", muted: "#8E8E93", chip: "#1C1C1E", line: "#232325" },
  splashBg: "#0B0B0C",
  splashFg: "#F5F5F7",
  mark: "#0B0B0C",
};

// ---------------------------------------------------------------- 图标 ---
// nyra-mark.svg 的几何（100×100 视框）。改 SVG 时同步改这里；测试会核对两边一致。
export const MARK_CIRCLE = { cx: 50, cy: 50, r: 46 };
export const MARK_CURSOR: [number, number][] = [
  [40.0, 31.0], [40.0, 75.72], [50.75, 65.83], [58.06, 81.74], [65.37, 78.47], [58.06, 62.65], [72.25, 62.65],
];
export const MARK_STROKE = 6;
export const MARK_ROTATE_DEG = -6;

type IconKind = "any" | "maskable" | "apple" | "favicon";

function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function rotatedCursor(): [number, number][] {
  const a = (MARK_ROTATE_DEG * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return MARK_CURSOR.map(([x, y]) => {
    const dx = x - 50;
    const dy = y - 50;
    return [50 + dx * c - dy * s, 50 + dx * s + dy * c];
  });
}

function insidePolygon(poly: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToPolygon(poly: [number, number][], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const vx = bx - ax;
    const vy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
    const d = Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
    if (d < best) best = d;
  }
  return best;
}

const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA 像素 → PNG（色彩类型 6）。 */
export function rgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 光栅化 Nyra 标志：
 *   - any / favicon：透明底，黑色圆盘占满（视框原有 4% 留白），光标填白；
 *   - maskable：黑底铺满，浅色圆盘缩在 80% 安全区内（直径 72%），光标黑色（= 入场动画终帧）；
 *   - apple：同 maskable（iOS 不支持透明），直径 78%。
 * 光标外 3 单位（描边 6 的一半）留出底色缝。
 */
export function renderMarkRgba(size: number, kind: IconKind): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const fraction = kind === "maskable" ? 0.72 : kind === "apple" ? 0.78 : 1;
  const opaqueBg = kind === "maskable" || kind === "apple";
  // any / favicon：黑色圆盘 + 白色光标（同 nyra-mark.svg）；maskable / apple：与入场动画终帧一致——
  // 黑底 + 浅色圆盘 + 黑色光标，从主屏幕图标到入场动画再到应用不跳色。
  const bg = hexRgb(MOBILE_COLORS.splashBg);
  const disc = hexRgb(opaqueBg ? MOBILE_COLORS.splashFg : MOBILE_COLORS.mark);
  const cursor: [number, number, number] = opaqueBg ? hexRgb(MOBILE_COLORS.splashBg) : [255, 255, 255];
  const poly = rotatedCursor();
  const half = MARK_STROKE / 2;
  const unit = (size * fraction) / 100; // 1 个视框单位 = 多少像素
  const offset = (size - size * fraction) / 2;
  const SS = 4; // 4×4 超采样抗锯齿
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      // 远离所有边缘的像素只采样一次（渐变在一个像素内几乎不变），边缘像素 4×4 超采样。
      const cx = (px + 0.5 - offset) / unit;
      const cy = (py + 0.5 - offset) / unit;
      const pxUnits = 1 / unit;
      const edge = Math.min(
        Math.abs(Math.hypot(cx - MARK_CIRCLE.cx, cy - MARK_CIRCLE.cy) - MARK_CIRCLE.r),
        Math.abs(distToPolygon(poly, cx, cy) - (insidePolygon(poly, cx, cy) ? 0 : half)),
        insidePolygon(poly, cx, cy) ? distToPolygon(poly, cx, cy) : Infinity,
      );
      const ss = edge > pxUnits * 1.5 ? 1 : SS;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss - offset) / unit;
          const y = (py + (sy + 0.5) / ss - offset) / unit;
          let cr: number, cg: number, cb: number, ca: number;
          const inDisc = Math.hypot(x - MARK_CIRCLE.cx, y - MARK_CIRCLE.cy) <= MARK_CIRCLE.r;
          const inCursor = insidePolygon(poly, x, y);
          const inGap = !inCursor && distToPolygon(poly, x, y) <= half;
          if (inDisc && inCursor) { [cr, cg, cb] = cursor; ca = 1; }
          else if (inDisc && !inGap) { [cr, cg, cb] = disc; ca = 1; }
          else if (opaqueBg) { [cr, cg, cb] = inCursor ? disc : bg; ca = 1; } // 光标尖略出圆盘：与原 splash 一样画成圆盘色
          else if (inCursor) { [cr, cg, cb] = [255, 255, 255]; ca = 1; } // 光标尖略出圆盘的部分
          else { cr = 0; cg = 0; cb = 0; ca = 0; }
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      if (a > 0) { out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a); }
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

const iconCache = new Map<string, Buffer>();
export function mobileIconPng(size: number, kind: IconKind): Buffer {
  const key = `${kind}:${size}`;
  let png = iconCache.get(key);
  if (!png) {
    png = rgbaPng(size, size, renderMarkRgba(size, kind));
    iconCache.set(key, png);
  }
  return png;
}

/** 路由 → 图标：manifest 的 any/maskable、apple-touch-icon 180、favicon。 */
export const MOBILE_ICON_ROUTES: Record<string, { size: number; kind: IconKind }> = {
  "/m/icon-192.png": { size: 192, kind: "any" },
  "/m/icon-512.png": { size: 512, kind: "any" },
  "/m/icon-maskable-192.png": { size: 192, kind: "maskable" },
  "/m/icon-maskable-512.png": { size: 512, kind: "maskable" },
  "/m/apple-touch-icon.png": { size: 180, kind: "apple" },
  "/m/icon-180.png": { size: 180, kind: "apple" },
  "/m/favicon-32.png": { size: 32, kind: "favicon" },
  "/favicon.ico": { size: 32, kind: "favicon" },
};

/** 矢量 favicon：同一几何，黑色圆盘 + 白色光标（与 nyra-mark.svg 一致）。 */
export function mobileFaviconSvg(): string {
  const pts = MARK_CURSOR.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(" L");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>` +
    `<mask id="m"><rect width="100" height="100" fill="#fff"/><path d="M${pts} Z" fill="#000" stroke="#000" stroke-width="${MARK_STROKE}" stroke-linejoin="round" transform="rotate(${MARK_ROTATE_DEG} 50 50)"/></mask></defs>` +
    `<circle cx="${MARK_CIRCLE.cx}" cy="${MARK_CIRCLE.cy}" r="${MARK_CIRCLE.r}" fill="${MOBILE_COLORS.mark}" mask="url(#m)"/>` +
    `<path d="M${pts} Z" fill="#fff" transform="rotate(${MARK_ROTATE_DEG} 50 50)"/></svg>`;
}

export const MOBILE_V2_MANIFEST = {
  name: "Nyra",
  short_name: "Nyra",
  description: "Nyra — 跑在你电脑上的 AI Agent（手机端）",
  start_url: "/m",
  scope: "/m",
  display: "standalone",
  orientation: "portrait",
  // 系统启动屏与入场动画同为黑底，之后淡入浅色应用。
  background_color: MOBILE_COLORS.splashBg,
  theme_color: MOBILE_COLORS.light.bg,
  icons: [
    { src: "/m/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/m/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/m/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: "/m/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

// ---------------------------------------------------------------- 字体 ---
// Inter 400/600 与 JetBrains Mono 400 的 WOFF（docs/assets/fonts，SIL OFL 1.1），以 base64 文本随包。
// 页面用同源 fetch + FontFace(ArrayBuffer) 加载，CSP 不加 font-src；字体文件不含秘密，无需 token。
const FONT_SOURCES: Record<string, string> = { "inter-400": INTER_400, "inter-600": INTER_600, "jbm-400": JBM_400 };
const fontCache = new Map<string, Buffer>();
export const MOBILE_FONT_ROUTE = /^\/m\/fonts\/(inter-400|inter-600|jbm-400)\.woff$/;
export function mobileFont(name: string): Buffer | null {
  const src = FONT_SOURCES[name];
  if (!src) return null;
  let buf = fontCache.get(name);
  if (!buf) { buf = Buffer.from(src.trim(), "base64"); fontCache.set(name, buf); }
  return buf;
}

// ---------------------------------------------------------------- 文案 ---
/** 只把手机用的 m.* 文案（中英）嵌进页面；语言在手机上按 navigator.language 选，认不出回落 en。 */
export function mobileMessages(): Record<Lang, Record<string, string>> {
  const pick = (lang: Lang): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(MESSAGES[lang])) if (k.startsWith("m.")) out[k] = v;
    return out;
  };
  return { zh: pick("zh"), en: pick("en") };
}
const I18N_JSON = JSON.stringify(mobileMessages()).replace(/</g, "\\u003c");

// ---------------------------------------------------------------- 图标 ---
// 设计稿的单色线性图标（✦ 对话、◷ 自动化、❖ 技能、⚙ 设置、⌕、✎、←、⋮、＋），内联 SVG，不依赖手机字体。
const SVG = (body: string, cls = "i", vb = "0 0 24 24") => `<svg class="${cls}" viewBox="${vb}" aria-hidden="true">${body}</svg>`;
const IC = {
  threads: SVG('<path d="M8 0C9 5 11 7 16 8C11 9 9 11 8 16C7 11 5 9 0 8C5 7 7 5 8 0Z"/>', "i f", "-1 -1 18 18"),
  review: SVG('<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>'),
  automations: SVG('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  skills: SVG('<path d="M8 .6l2.7 2.7L8 6 5.3 3.3z M3.3 5.3 6 8 3.3 10.7.6 8z M12.7 5.3 15.4 8l-2.7 2.7L10 8z M8 10l2.7 2.7L8 15.4l-2.7-2.7z"/>', "i f", "-1 -1 18 18"),
  settings: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  search: SVG('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20"/>'),
  pencil: SVG('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>'),
  back: SVG('<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>', "i and-only") + SVG('<path d="M15 5l-7 7 7 7"/>', "i ios-only"),
  more: SVG('<circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/>', "i f"),
  plus: SVG('<path d="M12 5v14M5 12h14"/>'),
  up: SVG('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>'),
  mark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C9 5 11 7 16 8C11 9 9 11 8 16C7 11 5 9 0 8C5 7 7 5 8 0Z"/></svg>',
};
const NAV = (["threads", "review", "automations", "skills", "settings"] as const)
  .map((k) => `<button data-tab="${k}"><i>${IC[k]}</i><span data-i="m.tab.${k}"></span></button>`).join("");

export const MOBILE_V2_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="${MOBILE_COLORS.light.bg}">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${MOBILE_COLORS.dark.bg}">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Nyra">
<title>Nyra</title>
<link rel="manifest" href="/m/manifest.json">
<link rel="icon" type="image/svg+xml" href="/m/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/m/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/m/apple-touch-icon.png">
<style>${APP_CSS}
.ios .and-only,.android .ios-only{display:none}</style></head><body>
<div id="splash" class="hidden" aria-hidden="true"></div>
<p id="fatal" class="err"></p>
<section id="pair-view" class="view hidden"><div class="pair">
<div class="mk">${IC.mark}</div>
<h1 data-i="m.pair.title"></h1>
<p data-i="m.pair.body"></p>
<input id="pair-code" class="codein" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" data-ia="m.pair.code">
<button id="pair-btn" class="bt p full" data-i="m.pair.btn"></button>
<p id="pair-error" class="err"></p>
<p data-i="m.pair.foot"></p>
</div></section>
<section id="threads-view" class="view tabview hidden">
<div class="lt"><h1 data-i="m.tab.threads"></h1><button id="search-btn" class="ib" data-ia="m.search">${IC.search}</button></div>
<div id="search-row" class="search hidden"><input id="search" type="search" data-ip="m.searchPlaceholder"></div>
<div id="threads"></div>
</section>
<button id="fab" class="fab hidden">${IC.pencil}<span data-i="m.newThread"></span></button>
<section id="chat-view" class="view hidden">
<div class="hd"><button id="back" class="ib" data-ia="m.back">${IC.back}</button><div class="tt"><b id="chat-title"></b><small id="chat-sub"></small></div><button id="kebab" class="ib" data-ia="m.more">${IC.more}</button></div>
<div id="menu" class="menu hidden"><button id="menu-new">${IC.pencil}<span data-i="m.newThread"></span></button><button id="menu-settings">${IC.settings}<span data-i="m.tab.settings"></span></button></div>
<div id="feed" class="feed"></div>
<div class="composer"><p id="chat-status" class="cstatus"></p><div class="pill"><textarea id="input" rows="1" data-ip="m.followUp"></textarea><button id="send-btn" class="go" data-ia="m.send">${IC.up}</button></div></div>
<div id="dim" class="dim hidden"></div>
<div id="sheet" class="sheet hidden" role="dialog" aria-modal="true"></div>
</section>
<section id="review-view" class="view tabview hidden">
<div class="lt"><h1 data-i="m.tab.review"></h1></div>
<div id="reviews"></div>
</section>
<section id="automations-view" class="view tabview hidden">
<div class="lt"><h1 data-i="m.tab.automations"></h1><button id="auto-add" class="ib" data-ia="m.auto.addHint">${IC.plus}</button></div>
<div id="autos"></div>
</section>
<section id="skills-view" class="view tabview hidden">
<div class="lt"><h1 data-i="m.tab.skills"></h1></div>
<div id="skill-list"></div>
</section>
<section id="settings-view" class="view tabview hidden">
<div class="lt"><h1 data-i="m.tab.settings"></h1></div>
<div class="lh" data-i="m.set.mode"></div>
<div class="seg modes" id="modes" style="margin:4px 16px 0"></div><div id="mode-confirm"></div>
<p class="help" id="mode-help" data-i="m.set.modeHelp"></p>
<div class="lh" data-i="m.set.rules"></div>
<div class="grp" id="rules"></div>
<p class="help" data-i="m.set.rulesHelp"></p>
<div class="lh" data-i="m.set.model"></div>
<div class="grp"><div class="row"><span class="tx" id="provider-line"></span></div><div class="row"><div class="tx"><span data-i="m.set.key"></span><small data-i="m.set.keyBody"></small></div></div></div>
<div class="lh" data-i="m.set.device"></div>
<div class="grp"><button id="disconnect" class="textbtn" data-i="m.set.disconnect"></button></div>
<p class="help" data-i="m.set.deviceHelp"></p>
<p class="help" id="version-line" style="padding-bottom:16px"></p>
</section>
<nav id="nav" class="nav hidden">${NAV}</nav>
${Object.entries(IC).map(([k, v]) => `<template id="ic-${k}">${v}</template>`).join("")}
<script>window.NYRA_I18N=${I18N_JSON};</script>
<script>${SPLASH_JS}</script>
<script>${APP_JS}</script>
</body></html>`;
