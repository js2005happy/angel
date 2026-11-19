// src/webuiMobile.ts — 手机 PWA（/m）：配对、会话列表、当前对话、Codex 式审批卡。
//
// 移植自 Python 版 nyra/webui_mobile.py（commit 134805e）与 nyra-approval 草稿的
// 审批卡设计，用 TS 重写，不粘 Python。样式与终端 v2 一致：深炭底、鼠尾草绿 → 雾蓝
// 渐变字标、彩色模式徽章（颜色取自 theme.ts 的 BRAND，即 DESIGN.md 品牌色的暗底提亮版）。
// 页面本身不含任何秘密：设备 token 只在 localStorage，每次 API 调用带 X-Nyra-Token 头。
// 图标从 docs/assets/nyra-mark.svg 的几何（圆 r46 + 旋转 -6° 的光标，描边 6 圆角）
// 在本机光栅化成 PNG：渐变圆盘 + 白色光标（暗底上光标填白，与 desktop/icon-src 的桌面图标一致）。
import { deflateSync } from "node:zlib";
import { BRAND } from "./theme.ts";

// ---------------------------------------------------------------- 颜色 ---
/** 品牌色：鼠尾草绿 → 雾蓝（终端 v2 同款提亮值），暗底 = DESIGN.md 暗色变体深炭底。 */
export const MOBILE_COLORS = {
  bg: "#171B18",
  surface: "#1F2420", // DESIGN.md 暗色变体深炭底
  panel: "#272E28",
  border: "#34403A",
  text: BRAND.text,
  muted: BRAND.muted,
  sage: BRAND.sage,
  mist: BRAND.mist,
  sageDeep: "#5F7D5C", // DESIGN.md 主色原值
  mistDeep: "#6B8CAE", // DESIGN.md 强调原值
  coral: BRAND.coral,
  success: BRAND.success,
  danger: BRAND.danger,
  badge: { readonly: BRAND.badgeReadonly, auto: BRAND.badgeAuto, full: BRAND.badgeFull, creator: BRAND.badgeCreator },
  badgeFg: BRAND.badgeFg,
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
 *   - any / favicon：透明底，渐变圆盘占满（视框原有 4% 留白）；
 *   - maskable：深炭底铺满，标志缩在 80% 安全区内（直径 72%）；
 *   - apple：深炭底（iOS 不支持透明），直径 78%。
 * 光标填白，光标外 3 单位（描边 6 的一半）留出底色缝，与桌面图标一致。
 */
export function renderMarkRgba(size: number, kind: IconKind): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const fraction = kind === "maskable" ? 0.72 : kind === "apple" ? 0.78 : 1;
  const opaqueBg = kind === "maskable" || kind === "apple";
  const bg = hexRgb(MOBILE_COLORS.surface);
  const c1 = hexRgb(MOBILE_COLORS.sage);
  const c2 = hexRgb(MOBILE_COLORS.mist);
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
          if (inDisc && inCursor) { cr = 255; cg = 255; cb = 255; ca = 1; }
          else if (inDisc && !inGap) {
            // 左上 → 右下的对角渐变
            const t = Math.max(0, Math.min(1, (x + y - 8) / 184));
            cr = c1[0] + (c2[0] - c1[0]) * t; cg = c1[1] + (c2[1] - c1[1]) * t; cb = c1[2] + (c2[2] - c1[2]) * t; ca = 1;
          } else if (opaqueBg) { [cr, cg, cb] = bg; ca = 1; }
          else if (inCursor) { cr = 255; cg = 255; cb = 255; ca = 1; } // 光标尖略出圆盘的部分
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

/** 矢量 favicon：同一几何，渐变圆盘 + 白色光标。 */
export function mobileFaviconSvg(): string {
  const pts = MARK_CURSOR.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(" L");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>` +
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${MOBILE_COLORS.sage}"/><stop offset="1" stop-color="${MOBILE_COLORS.mist}"/></linearGradient>` +
    `<mask id="m"><rect width="100" height="100" fill="#fff"/><path d="M${pts} Z" fill="#000" stroke="#000" stroke-width="${MARK_STROKE}" stroke-linejoin="round" transform="rotate(${MARK_ROTATE_DEG} 50 50)"/></mask></defs>` +
    `<circle cx="${MARK_CIRCLE.cx}" cy="${MARK_CIRCLE.cy}" r="${MARK_CIRCLE.r}" fill="url(#g)" mask="url(#m)"/>` +
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
  background_color: MOBILE_COLORS.bg,
  theme_color: MOBILE_COLORS.bg,
  icons: [
    { src: "/m/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/m/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/m/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: "/m/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

// ---------------------------------------------------------------- 页面 ---
const C = MOBILE_COLORS;
const CSS = `
:root{--bg:${C.bg};--surface:${C.surface};--panel:${C.panel};--border:${C.border};--text:${C.text};--muted:${C.muted};
--sage:${C.sage};--mist:${C.mist};--sage-d:${C.sageDeep};--mist-d:${C.mistDeep};--coral:${C.coral};--ok:${C.success};--danger:${C.danger};
--b-readonly:${C.badge.readonly};--b-auto:${C.badge.auto};--b-full:${C.badge.full};--b-creator:${C.badge.creator};--b-fg:${C.badgeFg}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
body{min-height:100vh;padding-bottom:env(safe-area-inset-bottom)}
button{font:inherit;color:inherit;border:0;border-radius:14px;cursor:pointer;min-height:48px;padding:12px 16px}
button:disabled{opacity:.45;cursor:default}
.btn-primary{background:linear-gradient(90deg,var(--sage-d),var(--mist-d));color:#fff;font-weight:700;font-size:18px;width:100%;min-height:56px}
.btn-secondary{background:var(--panel);border:1px solid var(--border);width:100%}
.btn-ghost{background:transparent;border:1px solid var(--border);width:100%}
.btn-danger{background:transparent;border:1px solid var(--danger);color:var(--danger);width:100%}
.btn-danger.solid{background:var(--danger);color:#fff;font-weight:700}
input,textarea{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px;width:100%}
input:focus,textarea:focus{outline:2px solid var(--mist);outline-offset:0}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 16px 10px;background:rgba(23,27,24,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
.wordmark{font-weight:800;font-size:24px;letter-spacing:.06em;background:linear-gradient(90deg,var(--sage),var(--mist));-webkit-background-clip:text;background-clip:text;color:transparent}
.sp{flex:1}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:700;color:var(--b-fg)}
.badge.readonly{background:var(--b-readonly)}.badge.auto{background:var(--b-auto)}.badge.full{background:var(--b-full)}.badge.creator{background:var(--b-creator)}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:700;background:var(--coral);color:var(--b-fg)}
.icon-btn{min-height:44px;min-width:44px;padding:8px 12px;background:var(--panel);border:1px solid var(--border)}
main{max-width:640px;margin:0 auto;padding:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:16px;margin:0 0 14px}
.muted{color:var(--muted);font-size:14px}.err{color:var(--danger);font-size:14px;min-height:1em}
h2{font-size:18px;margin:4px 0 12px}
.code-input{font-size:32px;letter-spacing:.4em;text-align:center;font-variant-numeric:tabular-nums;padding:14px}
.stack>*+*{margin-top:10px}
.session{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:14px 16px;margin:0 0 10px;min-height:60px}
.session .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feed{display:flex;flex-direction:column;gap:10px;padding-bottom:12px}
.msg{max-width:88%;padding:10px 14px;border-radius:16px;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:linear-gradient(90deg,var(--sage-d),var(--mist-d));color:#fff;border-bottom-right-radius:6px}
.msg.assistant{align-self:flex-start;background:var(--surface);border:1px solid var(--border);border-bottom-left-radius:6px}
.msg.tool{align-self:flex-start;background:transparent;border:1px dashed var(--border);color:var(--muted);font-size:13px;max-height:7.5em;overflow:hidden}
.approval{border:2px solid var(--coral);background:var(--surface);border-radius:18px;padding:16px;margin:0 0 14px}
.approval .head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.approval pre{background:#0F1210;color:#E9EBF0;border-radius:12px;padding:12px;margin:10px 0;white-space:pre-wrap;word-break:break-all;font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:40vh;overflow:auto}
.approval .rule{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:12px}
.approval .rule code{font:14px ui-monospace,Menlo,monospace;color:var(--sage)}
.seg{display:flex;gap:8px;margin:10px 0}.seg button{flex:1;background:var(--bg);border:1px solid var(--border)}
.seg button.on{border:2px solid var(--mist);background:var(--panel);font-weight:700}
.composer{position:sticky;bottom:0;background:var(--bg);padding:10px 0 calc(10px + env(safe-area-inset-bottom));display:flex;gap:8px;align-items:flex-end}
.composer textarea{flex:1;min-height:52px;max-height:30vh;resize:none}
.composer button{width:auto;min-width:76px}
.rewind-row{display:flex;gap:6px;align-self:stretch}.rewind-row button{min-height:44px;font-size:14px;padding:8px}
.status{font-size:13px;color:var(--muted);margin:0 0 8px}
.hidden{display:none!important}#fatal:empty{display:none}
.toast{position:fixed;left:50%;bottom:calc(150px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--panel);border:1px solid var(--border);padding:10px 16px;border-radius:12px;font-size:14px;z-index:20}
`;

const JS = `
'use strict';
const $ = (id) => document.getElementById(id);
const MODE_LABELS = { readonly: '只读', auto: '自动确认', full: '全权', creator: '创造模式' };
let pendingText = '', currentSession = null, poll = null, lastFeedKey = '', approvalKey = '', cardState = {};
function token(){
  const q = new URLSearchParams(location.search).get('token');
  if (q) { try { localStorage.setItem('nyra-token', q); } catch(e){} return q; }
  try { return localStorage.getItem('nyra-device-token') || localStorage.getItem('nyra-token') || ''; } catch(e){ return ''; }
}
async function api(path, opts){
  opts = opts || {};
  const res = await fetch(path, { ...opts, headers: { 'X-Nyra-Token': token(), 'Content-Type': 'application/json' } });
  let data = null; try { data = await res.json(); } catch(e){}
  if (res.status === 403) { lostDevice(); throw new Error((data && data.error) || '设备未授权'); }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}
function el(tag, cls, text){ const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function toast(text){ const t = el('div', 'toast', text); document.body.appendChild(t); setTimeout(() => t.remove(), 2200); }
function show(view){
  ['pair-view','home-view','chat-view'].forEach(v => $(v).classList.toggle('hidden', v !== view));
  $('back').classList.toggle('hidden', view !== 'chat-view');
}
function lostDevice(){
  try { localStorage.removeItem('nyra-device-token'); } catch(e){}
  clearInterval(poll); poll = null;
  $('pair-error').textContent = '这台手机的授权已失效（可能已在电脑上撤销），请重新配对。';
  show('pair-view');
}
function deviceName(){
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  const m = /Android[^;]*;\\s*([^;)]+?)(?:\\sBuild|\\))/.exec(ua);
  if (m) return m[1].trim().slice(0, 40);
  if (/Android/.test(ua)) return 'Android 手机';
  return '手机';
}
async function pair(){
  const code = $('pair-code').value.replace(/\\D/g, '');
  $('pair-error').textContent = '';
  if (code.length !== 6) { $('pair-error').textContent = '请输入 6 位配对码'; return; }
  $('pair-btn').disabled = true;
  try {
    const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: deviceName() }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) { $('pair-error').textContent = data.error || '配对失败'; return; }
    try { localStorage.setItem('nyra-device-token', data.token); } catch(e){}
    history.replaceState(null, '', '/m');
    $('pair-code').value = '';
    toast('已连接到电脑上的 Nyra');
    await boot();
  } catch (e) { $('pair-error').textContent = '连不上电脑：' + e.message; }
  finally { $('pair-btn').disabled = false; }
}
async function loadInfo(){
  const info = await api('/api/info');
  const b = $('mode-badge'); b.className = 'badge ' + (MODE_LABELS[info.mode] ? info.mode : 'auto');
  b.classList.remove('hidden');
  b.textContent = MODE_LABELS[info.mode] || info.mode;
}
async function loadSessions(){
  const data = await api('/api/sessions');
  const box = $('sessions'); box.innerHTML = '';
  const list = data.sessions || [];
  if (!list.length) box.appendChild(el('p', 'muted', '还没有会话。点上面的“＋ 新会话”开始。'));
  list.forEach(s => {
    const b = el('button', 'session');
    b.appendChild(el('span', 't', s.title || s.preview || s.id));
    b.appendChild(el('span', 'muted', String(s.count ?? '')));
    b.onclick = () => openSession(s.id);
    box.appendChild(b);
  });
}
async function newSession(){
  const data = await api('/api/sessions', { method: 'POST', body: '{}' });
  await openSession(data.id);
}
async function openSession(id){
  currentSession = id; lastFeedKey = ''; approvalKey = '';
  $('chat-title').textContent = id;
  $('feed').innerHTML = '';
  show('chat-view');
  await tick();
}
function goHome(){ currentSession = null; approvalKey = ''; show('home-view'); loadSessions().catch(()=>{}); tick(); }
function textOf(m){
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map(p => (p && p.text) || '').join('');
  return m.content == null ? '' : JSON.stringify(m.content);
}
function renderFeed(v){
  const all = v.messages || [];
  const msgs = all.filter(m => m.role !== 'system');
  const key = msgs.length + ':' + (msgs.length ? textOf(msgs[msgs.length - 1]).length : 0) + ':' + v.status;
  $('chat-status').textContent = v.status === 'running' ? 'Nyra 正在处理…' : (v.status === 'error' ? ('出错：' + (v.error || '')) : '');
  if (key === lastFeedKey) return;
  lastFeedKey = key;
  const feed = $('feed'); feed.innerHTML = '';
  msgs.forEach(m => {
    const t = textOf(m);
    if (m.role === 'tool') { feed.appendChild(el('div', 'msg tool', '工具结果：' + t.slice(0, 400))); return; }
    if (m.role === 'assistant' && !t && m.tool_calls) {
      m.tool_calls.forEach(c => {
        const name = (c.function && c.function.name) || '?';
        let args = {}; try { args = JSON.parse((c.function && c.function.arguments) || '{}'); } catch(e){}
        feed.appendChild(el('div', 'msg tool', name === 'shell' && args.command ? ('运行命令：' + args.command) : ('调用工具：' + name)));
      });
      return;
    }
    if (!t) return;
    const bubble = el('div', 'msg ' + (m.role === 'user' ? 'user' : 'assistant'), t);
    // 点一下消息展开回退操作（与桌面页一致：回退到此 / 编辑重发 / Fork 新会话）。
    const index = all.indexOf(m);
    bubble.onclick = () => toggleRewind(bubble, index, t);
    feed.appendChild(bubble);
  });
  // 运行中的这一轮还没写进会话：先把刚发出的消息显示出来。
  if (pendingText && v.status === 'running' && !msgs.some(m => m.role === 'user' && textOf(m) === pendingText)) {
    feed.appendChild(el('div', 'msg user', pendingText));
  }
  if (v.status !== 'running') pendingText = '';
  window.scrollTo(0, document.body.scrollHeight);
}
function toggleRewind(bubble, index, text){
  const next = bubble.nextSibling;
  if (next && next.classList && next.classList.contains('rewind-row')) { next.remove(); return; }
  const row = el('div', 'rewind-row');
  [['回退到此', 'truncate'], ['编辑重发', 'edit'], ['Fork 新会话', 'fork']].forEach(([label, action]) => {
    const b = el('button', 'btn-ghost', label); b.onclick = () => doRewind(index, action, text); row.appendChild(b);
  });
  bubble.after(row);
}
async function doRewind(index, action, text){
  if (!currentSession) return;
  const rows = await api('/api/sessions/' + encodeURIComponent(currentSession) + '/history').catch(() => null);
  const messageId = rows && rows.messages && rows.messages[index] ? rows.messages[index].id : null;
  if (messageId === null) { toast('这条消息还没记入对话存档，稍后再试'); return; }
  let edited = null;
  if (action === 'edit') { edited = prompt('编辑后重发：', text || ''); if (edited === null) return; }
  try {
    const res = await api('/api/sessions/' + encodeURIComponent(currentSession) + '/rewind', { method: 'POST', body: JSON.stringify({ message_id: messageId, action, text: edited }) });
    if (res && res.new_session_id) { await openSession(res.new_session_id); return; }
    lastFeedKey = ''; await tick();
  } catch (e) { toast('回退失败：' + e.message); }
}
async function decide(id, body){
  try {
    await api('/api/approvals/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify(body) });
    delete cardState[id]; approvalKey = '';
    toast(body.approve ? (body.scope ? '已允许，并记住了这条规则' : '已允许') : (body.feedback ? '已拒绝，反馈已发给 Nyra' : '已拒绝'));
    await tick();
  } catch (e) { toast('操作失败：' + e.message); }
}
function approvalCard(a){
  const st = cardState[a.id] || (cardState[a.id] = { open: null, scope: 'session', feedback: '' });
  const card = el('div', 'approval'); card.dataset.id = a.id;
  const head = el('div', 'head');
  head.appendChild(el('span', 'pill', '需要批准'));
  head.appendChild(el('b', '', a.tool === 'shell' ? '运行命令' : a.tool));
  if (!currentSession) head.appendChild(el('span', 'muted', '· ' + a.session));
  card.appendChild(head);
  if (a.command) card.appendChild(el('pre', 'cmd', a.command));
  else if (a.summary) card.appendChild(el('pre', 'cmd', a.summary));
  const actions = el('div', 'stack');
  const allow = el('button', 'btn-primary', '允许'); allow.dataset.act = 'allow';
  allow.onclick = () => decide(a.id, { approve: true });
  actions.appendChild(allow);
  const remember = el('button', 'btn-secondary', '允许并不再询问'); remember.dataset.act = 'remember';
  remember.onclick = () => { st.open = st.open === 'remember' ? null : 'remember'; approvalKey = ''; renderApprovals(lastApprovals); };
  actions.appendChild(remember);
  if (st.open === 'remember') {
    const box = el('div', 'rule');
    if (a.suggestion) {
      box.appendChild(el('div', 'muted', '以后自动允许：'));
      const label = el('div'); const code = el('code', '', a.suggestion.label); label.appendChild(code); box.appendChild(label);
      const seg = el('div', 'seg');
      [['session', '仅本会话'], ['project', '本项目']].forEach(([val, text]) => {
        const b = el('button', st.scope === val ? 'on' : '', text); b.dataset.scope = val;
        b.onclick = () => { st.scope = val; approvalKey = ''; renderApprovals(lastApprovals); };
        seg.appendChild(b);
      });
      box.appendChild(seg);
      box.appendChild(el('div', 'muted', st.scope === 'project' ? '记在这台电脑的 Nyra 设置里（不写进项目目录），可随时在设置里撤销。' : '只在这次会话里有效，会话结束自动失效。'));
      const ok = el('button', 'btn-primary', '确认：允许并记住'); ok.style.marginTop = '10px'; ok.dataset.act = 'remember-confirm';
      ok.onclick = () => decide(a.id, { approve: true, scope: st.scope });
      box.appendChild(ok);
    } else {
      box.appendChild(el('div', 'muted', '这条命令含复合语法（; && | $() 反引号 换行等）或属于危险操作，不能记成规则，只能单次允许。'));
    }
    actions.appendChild(box);
  }
  const reject = el('button', 'btn-danger', '拒绝…'); reject.dataset.act = 'reject';
  reject.onclick = () => { st.open = st.open === 'reject' ? null : 'reject'; approvalKey = ''; renderApprovals(lastApprovals); };
  actions.appendChild(reject);
  if (st.open === 'reject') {
    const box = el('div', 'stack');
    const ta = el('textarea'); ta.rows = 3; ta.placeholder = '告诉 Nyra 应该怎么做（可选），例如：先跑测试，别删文件'; ta.value = st.feedback; ta.id = 'reject-' + a.id;
    ta.oninput = () => { st.feedback = ta.value; };
    box.appendChild(ta);
    const send = el('button', 'btn-danger solid', '拒绝并发送反馈'); send.dataset.act = 'reject-confirm';
    send.onclick = () => decide(a.id, { approve: false, feedback: (st.feedback || '').trim() });
    box.appendChild(send);
    actions.appendChild(box);
  }
  card.appendChild(actions);
  return card;
}
let lastApprovals = [];
function renderApprovals(list){
  lastApprovals = list;
  const mine = currentSession ? list.filter(a => a.session === currentSession) : list;
  const key = JSON.stringify(mine.map(a => a.id));
  $('approval-count').textContent = list.length ? ('待批准 ' + list.length) : '';
  $('approval-count').classList.toggle('hidden', !list.length);
  document.title = list.length ? '(' + list.length + ') Nyra' : 'Nyra';
  if (key === approvalKey) return;
  approvalKey = key;
  const box = currentSession ? $('chat-approvals') : $('home-approvals');
  (currentSession ? $('home-approvals') : $('chat-approvals')).innerHTML = '';
  box.innerHTML = '';
  mine.forEach(a => box.appendChild(approvalCard(a)));
}
async function tick(){
  try {
    const data = await api('/api/approvals');
    renderApprovals(data.approvals || []);
    if (currentSession) renderFeed(await api('/api/sessions/' + encodeURIComponent(currentSession)));
  } catch (e) { /* 断网时下次再试 */ }
}
async function sendMsg(){
  const input = $('input'); const text = input.value.trim();
  if (!text || !currentSession) return;
  input.value = ''; pendingText = text; lastFeedKey = '';
  try { await api('/api/sessions/' + encodeURIComponent(currentSession) + '/messages', { method: 'POST', body: JSON.stringify({ text }) }); }
  catch (e) { toast(e.message); input.value = text; }
  await tick();
}
async function boot(){
  await loadInfo();
  show('home-view');
  await loadSessions();
  await tick();
  clearInterval(poll); poll = setInterval(tick, 1500);
}
window.addEventListener('load', async () => {
  const hash = location.hash || '';
  const m = /^#pair=(\\d{6})$/.exec(hash);
  if (m) {
    $('pair-code').value = m[1];
    show('pair-view');
    // 扫码打开：自动兑换一次；失败就留在配对页让用户手动输入。
    await pair();
    return;
  }
  if (!token()) { show('pair-view'); return; }
  try { await boot(); } catch (e) { if (!$('pair-view').classList.contains('hidden')) return; $('fatal').textContent = '加载失败：' + e.message; }
});
`;

export const MOBILE_V2_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${C.bg}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Nyra">
<title>Nyra</title>
<link rel="manifest" href="/m/manifest.json">
<link rel="icon" type="image/svg+xml" href="/m/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/m/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/m/apple-touch-icon.png">
<style>${CSS}</style></head><body>
<header>
<button id="back" class="icon-btn hidden" onclick="goHome()" aria-label="返回">‹</button>
<span class="wordmark">Nyra</span><span id="mode-badge" class="badge auto hidden"></span>
<span class="sp"></span><span id="approval-count" class="pill hidden"></span>
</header>
<main>
<p id="fatal" class="err"></p>
<section id="pair-view" class="hidden">
<div class="card stack">
<h2>连接电脑上的 Nyra</h2>
<p class="muted">在电脑终端运行 <b>nyra ui --pair</b>，用手机扫终端里的二维码；或者把终端显示的 6 位配对码填在这里。配对码 5 分钟内有效、只能用一次，输错 5 次作废。</p>
<input id="pair-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" aria-label="6 位配对码">
<button id="pair-btn" class="btn-primary" onclick="pair()">配对</button>
<p id="pair-error" class="err"></p>
<p class="muted">只在可信的局域网里配对。配对后这台手机拿到一个专属 token，电脑只存它的哈希，随时可以在电脑上撤销。</p>
</div>
</section>
<section id="home-view" class="hidden">
<div id="home-approvals"></div>
<div class="stack"><button class="btn-primary" onclick="newSession()">＋ 新会话</button></div>
<h2 style="margin-top:20px">会话</h2>
<div id="sessions"></div>
</section>
<section id="chat-view" class="hidden">
<p class="status"><span id="chat-title"></span> <span id="chat-status"></span></p>
<div id="feed" class="feed"></div>
<div id="chat-approvals"></div>
<div class="composer"><textarea id="input" rows="2" placeholder="给 Nyra 发消息…"></textarea><button class="btn-primary" onclick="sendMsg()">发送</button></div>
</section>
</main>
<script>${JS}</script>
</body></html>`;
