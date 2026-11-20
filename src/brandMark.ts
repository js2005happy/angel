// src/brandMark.ts — Nyra 正式标志（圆盘 + 光标）的唯一几何来源与全部导出格式。
//
// 标志 = 入场动画终帧里的那枚圆标（docs/design/splash/splash.js 的 frame(3.0)）：
//   圆盘 r=40（中心 50,50）；光标 = splash 的 arrowD(40,31,0.86)，绕圆心旋转 -6°，
//   描边 6、圆角接头；光标整体落在圆盘内，画成“底色”——浅底上是深色圆盘 + 镂空光标，
//   深底上是浅色圆盘（#F5F5F7）+ 底色光标，与终帧完全一致。不带 “Nyra” 字标。
// 视框 6 6 88 88：圆盘直径占 91%，四周 4 个单位留白（抗锯齿不被裁）。
//
// 本文件零依赖：SVG 字符串、RGBA 光栅化（超采样抗锯齿）、PNG / ICO / ICNS 编码。
// 手机 PWA 图标（src/webuiMobile.ts）在运行时用它；scripts/make-icons.ts 用它生成
// docs/assets/ 与 desktop/ 下所有提交进仓库的图标文件。改几何只改这里，再跑一次脚本。
import { deflateSync } from "node:zlib";

export const MARK_INK = "#0B0B0C"; // 深色：浅底上的圆盘；深底 / 图块的底色
export const MARK_PAPER = "#F5F5F7"; // 浅色：深底上的圆盘（= 入场动画终帧）
export const MARK_VIEWBOX: [number, number, number, number] = [6, 6, 88, 88];
export const MARK_CIRCLE = { cx: 50, cy: 50, r: 40 };
export const MARK_CURSOR: [number, number][] = [
  [40.0, 31.0], [40.0, 75.72], [50.75, 65.83], [58.06, 81.74], [65.37, 78.47], [58.06, 62.65], [72.25, 62.65],
];
export const MARK_STROKE = 6;
export const MARK_ROTATE_DEG = -6;
/** 16–32 px 用的加粗版：光标镂空加粗（描边 10），线条在小尺寸下不糊成一团。 */
export const MARK_STROKE_SMALL = 10;
export const SMALL_MAX_PX = 32;

export const CURSOR_D = "M" + MARK_CURSOR.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(" L") + " Z";

// ---------------------------------------------------------------- SVG ---
export interface MarkSvgOpts {
  /** 圆盘颜色；默认深色。 */
  disc?: string;
  /** 光标外扩的描边宽度（镂空比光标本身每边宽 stroke/2）。 */
  stroke?: number;
  /** 视框外再包一层底色图块（App 图标）：底色、圆角比例（相对边长）、圆盘占图块的比例。 */
  tile?: { fill: string; radius: number; disc: number };
  /** favicon：跟随系统深浅色（深色时圆盘换浅色）。 */
  adaptive?: boolean;
}

/**
 * 光标外扩 stroke/2（圆角）的轮廓：凸角画圆弧、凹角取两条外扩边的交点，已绕圆心旋转 -6°。
 * 这正是 splash 里 “填充 + 描边 6、圆角接头” 的光标外形，写成一条路径，不用 mask，
 * GitHub README、老浏览器、各种 SVG 光栅器都按同一个形状画。
 */
export function cursorOutlineD(stroke = MARK_STROKE): string {
  const h = stroke / 2;
  const P = rotatedCursor();
  const n = P.length;
  // 多边形方向（屏幕坐标、y 向下）：面积 > 0 为顺时针。
  let area = 0;
  for (let i = 0; i < n; i++) { const [x1, y1] = P[i]; const [x2, y2] = P[(i + 1) % n]; area += x1 * y2 - x2 * y1; }
  const cw = area > 0;
  const normal = (a: [number, number], b: [number, number]): [number, number] => {
    const dx = b[0] - a[0]; const dy = b[1] - a[1]; const L = Math.hypot(dx, dy);
    // 外法线（y 向下的屏幕坐标）：顺时针多边形是 (dy, -dx)，逆时针反过来。
    return cw ? [dy / L, -dx / L] : [-dy / L, dx / L];
  };
  const f = (v: number) => v.toFixed(2);
  let d = "";
  for (let i = 0; i < n; i++) {
    const prev = P[(i - 1 + n) % n]; const cur = P[i]; const next = P[(i + 1) % n];
    const n1 = normal(prev, cur); const n2 = normal(cur, next);
    const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    const convex = cw ? cross > 0 : cross < 0;
    const a: [number, number] = [cur[0] + n1[0] * h, cur[1] + n1[1] * h];
    const b: [number, number] = [cur[0] + n2[0] * h, cur[1] + n2[1] * h];
    if (convex) {
      d += (d ? " L" : "M") + `${f(a[0])} ${f(a[1])} A${h} ${h} 0 0 ${cw ? 1 : 0} ${f(b[0])} ${f(b[1])}`;
    } else {
      // 两条外扩边（过 a 方向 cur-prev，过 b 方向 next-cur）的交点。
      const d1 = [cur[0] - prev[0], cur[1] - prev[1]]; const d2 = [next[0] - cur[0], next[1] - cur[1]];
      const den = d1[0] * d2[1] - d1[1] * d2[0];
      const t = ((b[0] - a[0]) * d2[1] - (b[1] - a[1]) * d2[0]) / den;
      d += (d ? " L" : "M") + `${f(a[0] + d1[0] * t)} ${f(a[1] + d1[1] * t)}`;
    }
  }
  return d + " Z";
}

/** 圆盘去掉光标的单条路径（evenodd）：圆 + 光标外扩轮廓。 */
export function markPathD(stroke = MARK_STROKE): string {
  const { cx, cy, r } = MARK_CIRCLE;
  const circle = `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
  return `${circle} ${cursorOutlineD(stroke)}`;
}

/**
 * 标志 SVG：一条 evenodd 路径，光标是镂空的——放在任何底色上，光标处露出的都是底色
 * （= 终帧里光标是底色）。tile 模式下外面包一块实心圆角图块（App 图标）。
 */
export function markSvg(o: MarkSvgOpts = {}): string {
  const disc = o.disc ?? MARK_INK;
  const d = markPathD(o.stroke ?? MARK_STROKE);
  const style = o.adaptive
    ? `<style>path{fill:${disc}}@media (prefers-color-scheme:dark){path{fill:${MARK_PAPER}}}</style>`
    : "";
  const path = `<path fill="${disc}" fill-rule="evenodd" d="${d}"/>`;
  if (o.tile) {
    const S = 80 / o.tile.disc;
    const x0 = (50 - S / 2).toFixed(2);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${x0} ${S.toFixed(2)} ${S.toFixed(2)}">` +
      `<rect x="${x0}" y="${x0}" width="${S.toFixed(2)}" height="${S.toFixed(2)}" rx="${(S * o.tile.radius).toFixed(2)}" fill="${o.tile.fill}"/>${path}</svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX.join(" ")}">${style}${path}</svg>`;
}

/** 内联进页面的标志：圆盘 = currentColor，光标镂空露出页面底色；aria-hidden。 */
export function inlineMarkSvg(cls = ""): string {
  return markSvg({ disc: "currentColor" }).replace("<svg ", `<svg${cls ? ` class="${cls}"` : ""} aria-hidden="true" focusable="false" `);
}

// ---------------------------------------------------------- 光栅化 ---
export interface RasterOpts {
  /** 圆盘颜色。 */
  disc: string;
  /** 不透明底色（null = 透明底，光标镂空为透明）。 */
  bg: string | null;
  /** 底色的形状：full = 铺满正方形；圆角比例（相对边长）。 */
  bgRadius?: number;
  /** 底色图块四周的透明边距（相对边长，macOS 图标网格用）。 */
  bgMargin?: number;
  /** 圆盘直径占整幅的比例。 */
  discFraction: number;
  /** 光标镂空描边；不给时按尺寸取正常 / 加粗。 */
  stroke?: number;
}

function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

let ROT_CACHE: [number, number][] | null = null;
function rotatedCursor(): [number, number][] {
  if (ROT_CACHE) return ROT_CACHE;
  const a = (MARK_ROTATE_DEG * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  ROT_CACHE = MARK_CURSOR.map(([x, y]) => {
    const dx = x - 50;
    const dy = y - 50;
    return [50 + dx * c - dy * s, 50 + dx * s + dy * c];
  });
  return ROT_CACHE;
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

/** 点到圆角矩形（中心 c、半边长 h、圆角 r）的有符号距离，单位与输入相同。 */
function roundRectSd(x: number, y: number, c: number, h: number, r: number): number {
  const qx = Math.abs(x - c) - (h - r);
  const qy = Math.abs(y - c) - (h - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 光栅化标志为 RGBA。坐标：像素 → 视框单位，圆盘直径 = size * discFraction。 */
export function rasterizeMark(size: number, o: RasterOpts): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const stroke = o.stroke ?? (size <= SMALL_MAX_PX ? MARK_STROKE_SMALL : MARK_STROKE);
  const half = stroke / 2;
  const unit = (size * o.discFraction) / (2 * MARK_CIRCLE.r); // 1 视框单位 = 多少像素
  const toU = (p: number) => 50 + (p - size / 2) / unit;
  const disc = hexRgb(o.disc);
  const bg = o.bg ? hexRgb(o.bg) : null;
  const margin = (o.bgMargin ?? 0) * size;
  const bgHalf = size / 2 - margin;
  const bgR = (o.bgRadius ?? 0) * (size - 2 * margin);
  const poly = rotatedCursor();
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const cx = toU(px + 0.5);
      const cy = toU(py + 0.5);
      const pxU = 1 / unit;
      const dPoly = distToPolygon(poly, cx, cy);
      const inP = insidePolygon(poly, cx, cy);
      const edge = Math.min(
        Math.abs(Math.hypot(cx - MARK_CIRCLE.cx, cy - MARK_CIRCLE.cy) - MARK_CIRCLE.r),
        inP ? Infinity : Math.abs(dPoly - half),
        bg ? Math.abs(roundRectSd(px + 0.5, py + 0.5, size / 2, bgHalf, bgR)) / unit : Infinity,
      );
      const ss = edge > pxU * 1.5 ? 1 : SS;
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = px + (sx + 0.5) / ss;
          const fy = py + (sy + 0.5) / ss;
          const x = toU(fx);
          const y = toU(fy);
          const inDisc = Math.hypot(x - MARK_CIRCLE.cx, y - MARK_CIRCLE.cy) <= MARK_CIRCLE.r;
          const inCut = insidePolygon(poly, x, y) || distToPolygon(poly, x, y) <= half;
          let col: [number, number, number] | null = null;
          if (inDisc && !inCut) col = disc;
          else if (bg && roundRectSd(fx, fy, size / 2, bgHalf, bgR) <= 0) col = bg;
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) { out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a); }
      out[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return out;
}

/** 预设：各用途的标志光栅参数。 */
export const MARK_PRESETS = {
  /** 透明底、深色圆盘、光标镂空（浅色界面 / favicon / PWA any）。 */
  light: (): RasterOpts => ({ disc: MARK_INK, bg: null, discFraction: 0.92 }),
  /** 透明底、浅色圆盘（深色界面）。 */
  dark: (): RasterOpts => ({ disc: MARK_PAPER, bg: null, discFraction: 0.92 }),
  /** 手机主屏幕 maskable：黑底铺满，浅色圆盘在 80% 安全区内。 */
  maskable: (): RasterOpts => ({ disc: MARK_PAPER, bg: MARK_INK, discFraction: 0.66 }),
  /** apple-touch-icon：黑底铺满（iOS 自己切圆角），浅色圆盘。 */
  apple: (): RasterOpts => ({ disc: MARK_PAPER, bg: MARK_INK, discFraction: 0.72 }),
  /** 桌面 App 图标（Windows / Linux）：黑色圆角图块铺满，浅色圆盘；小尺寸圆盘更满。 */
  app: (size: number): RasterOpts => ({ disc: MARK_PAPER, bg: MARK_INK, bgRadius: 0.225, discFraction: size <= SMALL_MAX_PX ? 0.82 : 0.7 }),
  /** macOS 图标网格：1024 画布里 824 的圆角图块（四周约 10% 透明边距）。 */
  appMac: (size: number): RasterOpts => ({ disc: MARK_PAPER, bg: MARK_INK, bgRadius: 0.225, bgMargin: size <= SMALL_MAX_PX ? 0 : 0.0977, discFraction: size <= SMALL_MAX_PX ? 0.82 : 0.56 }),
};

// ------------------------------------------------------------ 编码 ---
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

export function markPng(size: number, o: RasterOpts): Buffer {
  return rgbaPng(size, size, rasterizeMark(size, o));
}

/** 多尺寸 ICO（每帧内嵌 PNG，Vista 起都支持）。 */
export function icoFromPngs(frames: { size: number; png: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach((f, i) => {
    const e = 6 + 16 * i;
    head[e] = f.size >= 256 ? 0 : f.size;
    head[e + 1] = f.size >= 256 ? 0 : f.size;
    head[e + 2] = 0; head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(f.png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += f.png.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.png)]);
}

/** ICNS：每项是 PNG 数据（macOS 10.7+）。type 如 icp4 / ic07 / ic14。 */
export function icnsFromPngs(entries: { type: string; png: Buffer }[]): Buffer {
  const parts = entries.map((e) => {
    const h = Buffer.alloc(8);
    h.write(e.type, 0, 4, "ascii");
    h.writeUInt32BE(e.png.length + 8, 4);
    return Buffer.concat([h, e.png]);
  });
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.write("icns", 0, 4, "ascii");
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

/** ICNS 各项的像素尺寸（PNG 项）。 */
export const ICNS_TYPES: [string, number][] = [
  ["icp4", 16], ["icp5", 32], ["ic11", 32], ["ic12", 64],
  ["ic07", 128], ["ic08", 256], ["ic13", 256], ["ic09", 512], ["ic14", 512], ["ic10", 1024],
];
