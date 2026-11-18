"""Nyra 手机端网页（PWA）：`/m`。

电脑上的 `python3 -m nyra ui` 同时提供这个手机页面。它和桌面页面分开：
- 页面本身不含任何秘密，所以不要求 URL 里带 token；所有 API 仍要鉴权——
  手机用配对得到的设备 token（请求头 ``X-Nyra-Device``，存在手机
  localStorage 里），见 nyra/pairing.py 的 DeviceRegistry。
- 入场动画只在手机上、以安装后的独立窗口（display-mode: standalone，iOS
  为 navigator.standalone）启动时播放，每次冷启动一次，可点击跳过，
  prefers-reduced-motion 时只淡入标志。桌面浏览器、普通浏览器标签页和
  官网都不播。纯 CSS/JS 绘制（SVG），不含视频，零外部请求。
- 系统启动屏（iOS apple-touch-startup-image、安卓 manifest 的
  background_color）都是 #0B0B0C，与动画第一帧（纯 #0B0B0C）一致，
  避免闪白。

页面只引用同源资源；CSP 与桌面页面相同（见 webui.CSP），没有放宽。
"""

import struct
import zlib
from functools import lru_cache

SPLASH_BG = "#0B0B0C"

# iOS 启动图：(CSS 宽, CSS 高, 像素比)。竖屏；尺寸必须与设备完全一致
# iOS 才会使用。列表覆盖 iPhone SE（第 1 代）到 iPhone 16 Pro Max。
STARTUP_DEVICES = (
    (320, 568, 2),
    (375, 667, 2),
    (414, 736, 3),
    (375, 812, 3),
    (414, 896, 2),
    (414, 896, 3),
    (390, 844, 3),
    (428, 926, 3),
    (393, 852, 3),
    (430, 932, 3),
    (402, 874, 3),
    (440, 956, 3),
)
STARTUP_SIZES = frozenset((w * r, h * r) for w, h, r in STARTUP_DEVICES)


def _startup_links() -> str:
    lines = []
    for w, h, r in STARTUP_DEVICES:
        lines.append(
            f'<link rel="apple-touch-startup-image" href="/m/startup/{w * r}x{h * r}.png" '
            f'media="(device-width: {w}px) and (device-height: {h}px) and '
            f'(-webkit-device-pixel-ratio: {r}) and (orientation: portrait)">'
        )
    return "\n".join(lines)


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data)) + kind + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


@lru_cache(maxsize=4)
def solid_png(width: int, height: int, color: str = SPLASH_BG) -> bytes:
    """A solid-colour RGB PNG (startup screen = the animation's first frame)."""
    rgb = bytes.fromhex(color.lstrip("#"))
    row = b"\x00" + rgb * width
    raw = row * height
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(raw, 9))
        + _png_chunk(b"IEND", b"")
    )


# start_url / scope 是 /m：手机装的是手机页面，不带 token（页面里没有秘密，
# 鉴权靠设备 token）。背景色 = 动画首帧颜色，安卓系统启动屏不闪白。
MOBILE_MANIFEST = {
    "name": "Nyra",
    "short_name": "Nyra",
    "description": "Nyra — 电脑上的 AI 助手，手机遥控",
    "id": "/m",
    "start_url": "/m",
    "scope": "/m",
    "display": "standalone",
    "orientation": "portrait",
    "background_color": SPLASH_BG,
    "theme_color": SPLASH_BG,
    "icons": [
        {"src": "/m/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
        {"src": "/m/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
        {"src": "/m/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
}

MOBILE_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Nyra</title>
<link rel="manifest" href="/m/manifest.json">
<link rel="apple-touch-icon" href="/m/icon-180.png">
<meta name="theme-color" content="#0B0B0C">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Nyra">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="format-detection" content="telephone=no">
__STARTUP_LINKS__
<style>
:root{--bg:#FFFFFF;--line:#ECECEE;--line2:#E2E2E5;--fg:#0D0D0D;--mu:#6E6E73;--mu2:#A1A1A6;--chip:#F2F2F3;--add:#1A7F37;--addbg:#E9F6EC;--rm:#CF222E;--rmbg:#FCEBEC;--btn:#0D0D0D;--btnfg:#FFFFFF;--warn:#B7791F;
--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text",Roboto,"Segoe UI","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,"Roboto Mono",Consolas,monospace;
--st:env(safe-area-inset-top,0px);--sbm:env(safe-area-inset-bottom,0px)}
@media (prefers-color-scheme:dark){:root{--bg:#0B0B0C;--line:#232325;--line2:#2C2C2F;--fg:#EDEDED;--mu:#8E8E93;--mu2:#5E5E63;--chip:#1C1C1E;--add:#3FB950;--addbg:rgba(63,185,80,.12);--rm:#F85149;--rmbg:rgba(248,81,73,.12);--btn:#EDEDED;--btnfg:#0B0B0C;--warn:#E3B341}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:16px/1.45 var(--sans);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
html[data-splash=play],html[data-splash=static]{background:#0B0B0C}
button,input,textarea{font:inherit;color:inherit}
button{cursor:pointer}
[hidden]{display:none!important}
#nyra-splash{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:#0B0B0C;transition:opacity .35s ease;touch-action:manipulation}
#nyra-splash svg{display:block;width:100%;height:100%}
.view{position:fixed;inset:0;display:flex;flex-direction:column;padding-top:var(--st);background:var(--bg)}
.hd{display:flex;align-items:center;gap:12px;padding:8px 14px 8px;min-height:56px;flex:none}
.ib{width:40px;height:40px;border-radius:50%;background:var(--chip);border:0;display:flex;align-items:center;justify-content:center;font-size:18px;flex:none;padding:0}
.ib.ghost{visibility:hidden}
.ttl{flex:1;min-width:0}
.ttl b{display:block;font-weight:600;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ttl.big b{font-size:24px;letter-spacing:-.01em}
.ttl small{display:block;color:var(--mu);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ttl.c{text-align:center}
.mark{width:28px;height:28px;color:var(--fg);flex:none}
.badge{min-width:20px;height:20px;border-radius:10px;background:var(--fg);color:var(--bg);font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;padding:0 6px}
.banner{margin:2px 14px 8px;border:1px solid var(--line2);border-radius:16px;padding:12px 14px;display:flex;align-items:center;gap:10px;background:var(--chip);border-color:var(--warn);text-align:left;width:calc(100% - 28px)}
.banner b{font-weight:600}
.lst{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:calc(96px + var(--sbm))}
.lh{color:var(--mu);font-size:12.5px;padding:14px 20px 4px}
.it{display:flex;align-items:center;gap:12px;padding:12px 20px;width:100%;border:0;background:none;text-align:left;min-height:60px}
.it:active{background:var(--chip)}
.it .tx{flex:1;min-width:0}
.it b{display:block;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.it small{display:block;color:var(--mu);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.it .t{color:var(--mu2);font-size:12px;flex:none}
.dot{width:8px;height:8px;border-radius:50%;background:var(--line2);flex:none}
.dot.run{background:var(--fg);animation:pulse 1.2s ease-in-out infinite}
.dot.wait{background:var(--warn)}
@keyframes pulse{50%{opacity:.35}}
.empty{color:var(--mu);text-align:center;padding:60px 28px}
.fab{position:fixed;right:16px;bottom:calc(20px + var(--sbm));height:56px;border-radius:18px;background:var(--btn);color:var(--btnfg);border:0;display:flex;align-items:center;gap:8px;padding:0 20px;font-weight:600;box-shadow:0 6px 16px rgba(0,0,0,.2)}
.feed{flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;padding:6px 16px 16px}
#log{display:flex;flex-direction:column;gap:14px}
.u{align-self:flex-end;background:var(--chip);padding:10px 14px;border-radius:20px;max-width:86%;white-space:pre-wrap;overflow-wrap:anywhere}
.a{line-height:1.55;overflow-wrap:anywhere}
.a p{margin:0 0 8px}.a p:last-child{margin:0}
.a code{font-family:var(--mono);font-size:13px;background:var(--chip);padding:1px 5px;border-radius:5px}
.a pre,.diff{font-family:var(--mono);font-size:12.5px;line-height:19px;background:var(--chip);border-radius:12px;padding:8px 0;margin:6px 0;overflow-x:auto;-webkit-overflow-scrolling:touch;white-space:pre}
.a pre{padding:8px 12px}
.lg{color:var(--mu);font-size:13.5px;display:flex;flex-direction:column;gap:6px}
.lg .c{font-family:var(--mono);font-size:12.5px;color:var(--fg)}
.note{color:var(--mu);font-size:13px;text-align:center}
.note.bad{color:var(--rm)}
.box{border:1px solid var(--line2);border-radius:18px;padding:14px}
.appr .h{font-weight:600;font-size:16px}
.appr .sub{color:var(--mu);font-size:13px;margin-top:2px}
.appr .cmd{font-family:var(--mono);font-size:13px;margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere}
.diff{background:none;border:1px solid var(--line2);margin-top:10px;max-height:46vh;overflow:auto}
.dl{display:block;padding:0 12px;min-width:max-content}
.dl.dl-a{background:var(--addbg)}.dl.dl-d{background:var(--rmbg)}.dl.dl-h{color:var(--mu)}
.acts{display:flex;flex-direction:column;gap:8px;margin-top:14px}
.acts .row{display:flex;gap:8px}
.bt{min-height:50px;border-radius:25px;border:0;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:16px;flex:1;padding:0 14px}
.bt.p{background:var(--btn);color:var(--btnfg)}.bt.s{background:var(--chip)}
.bt:disabled{opacity:.5}
.res{margin-top:10px;font-size:14px;font-weight:600}
.res.ok{color:var(--add)}.res.bad{color:var(--rm)}
.appr.done .acts{display:none}
.pill{margin:6px 12px calc(10px + var(--sbm));border-radius:28px;background:var(--chip);border:1px solid var(--line2);padding:6px 6px 6px 16px;display:flex;align-items:flex-end;gap:8px;flex:none}
.pill textarea{flex:1;border:0;background:none;resize:none;outline:none;padding:9px 0;max-height:140px;min-height:24px;font-size:16px;line-height:1.4}
.go{width:40px;height:40px;border-radius:50%;background:var(--btn);color:var(--btnfg);border:0;display:flex;align-items:center;justify-content:center;font-size:18px;flex:none}
.go:disabled{opacity:.4}
.pair{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 26px calc(24px + var(--sbm));text-align:center;gap:14px;overflow-y:auto}
.pair .mark{width:56px;height:56px}
.pair h1{font-size:24px;font-weight:600;margin:6px 0 0;letter-spacing:-.01em}
.pair p{color:var(--mu);margin:0;font-size:14.5px;max-width:340px}
.pair code{font-family:var(--mono);font-size:13px;background:var(--chip);padding:1px 6px;border-radius:5px;color:var(--fg)}
.field{width:100%;max-width:340px;height:54px;border-radius:16px;border:1px solid var(--line2);background:var(--chip);padding:0 16px;font-size:18px;outline:none}
.field.code{font-family:var(--mono);font-size:24px;letter-spacing:.3em;text-align:center}
.pair .bt{width:100%;max-width:340px;flex:none}
.msg{min-height:20px;font-size:14px}
.msg.bad{color:var(--rm)}
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(90px + var(--sbm));background:var(--btn);color:var(--btnfg);padding:10px 16px;border-radius:14px;font-size:14px;max-width:88vw;z-index:50}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div id="nyra-splash" hidden aria-hidden="true"></div>
<script>
/* Nyra opening animation (phones only): plays once per cold start of the
   installed app (standalone window), ~3.4 s, tap to skip, honours reduced
   motion. Never in a normal browser tab, never on desktop. Pure CSS/JS,
   no media files, no network requests. */
/*nyra-splash-decide:start*/
function nyraSplashMode(env){
  if(!env||env.seen)return "none";
  var standalone=!!env.standalone||env.iosStandalone===true;
  if(!standalone)return "none";
  var mobile=!!env.coarse&&env.shortSide>0&&env.shortSide<=1024;
  if(!mobile)return "none";
  return env.reducedMotion?"static":"play";
}
/*nyra-splash-decide:end*/
// Nyra splash timeline: one pure function -> SVG string. Used by splash.html and render.js.
(function(root){
const W=1280,H=800,BG="#0B0B0C",FG="#F5F5F7",GRAY="#8E8E93";
const AR=[[0,0],[0,52],[12.5,40.5],[21,59],[29.5,55.2],[21,36.8],[37.5,36.8]];
const arrowD=(x,y,s)=>"M"+AR.map(([a,b])=>`${(x+a*s).toFixed(2)} ${(y+b*s).toFixed(2)}`).join(" L")+" Z";
const ARROW=arrowD(40,31,0.86);
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const P=(t,a,b)=>clamp((t-a)/(b-a));
const eOut=p=>1-Math.pow(1-p,3), eInOut=p=>p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;
const eBack=p=>{const c=1.6;return 1+(c+1)*Math.pow(p-1,3)+c*Math.pow(p-1,2)};
const lerp=(a,b,p)=>a+(b-a)*p;
const WM={"glyphs": [{"d": "M72.2940340909091 -78.54545454545455H58.14204545454545V-25.00568181818182H57.45170454545455L20.480113636363637 -78.54545454545455H7.747159090909091V0.0H21.975852272727273V-53.50142045454545H22.62784090909091L59.63778409090909 0.0H72.2940340909091Z", "x": 0}, {"d": "M15.762784090909092 22.09090909090909C26.578125 22.09090909090909 32.82954545454545 16.529829545454547 36.16619318181818 7.1335227272727275L59.752840909090914 -58.90909090909091H44.98721590909091L31.37215909090909 -14.420454545454545H30.758522727272727L17.181818181818183 -58.90909090909091H2.4545454545454546L23.816761363636363 1.2272727272727273L22.62784090909091 4.410511363636363C20.058238636363637 11.122159090909092 15.992897727272728 11.582386363636363 9.933238636363637 9.818181818181818L6.7116477272727275 20.633522727272727C8.590909090909092 21.400568181818183 11.965909090909092 22.09090909090909 15.762784090909092 22.09090909090909Z", "x": 77.5}, {"d": "M7.1335227272727275 0.0H21.017045454545453V-34.63210227272727C21.017045454545453 -42.11079545454545 26.654829545454547 -47.40340909090909 34.28693181818182 -47.40340909090909C36.62642045454545 -47.40340909090909 39.54119318181818 -46.98153409090909 40.73011363636364 -46.59801136363637V-59.36931818181818C39.46448863636364 -59.59943181818182 37.27840909090909 -59.752840909090914 35.74431818181818 -59.752840909090914C28.994318181818183 -59.752840909090914 23.35653409090909 -55.91761363636364 21.20880681818182 -49.09090909090909H20.595170454545453V-58.90909090909091H7.1335227272727275Z", "x": 137.21}, {"d": "M24.085227272727273 1.1889204545454546C33.328125 1.1889204545454546 38.85085227272727 -3.1448863636363638 41.38210227272727 -8.092329545454545H41.84232954545455V0.0H55.18892045454545V-39.42613636363637C55.18892045454545 -54.99715909090909 42.49431818181818 -59.67613636363637 31.257102272727273 -59.67613636363637C18.869318181818183 -59.67613636363637 9.357954545454545 -54.15340909090909 6.2897727272727275 -43.41477272727273L19.25284090909091 -41.57386363636364C20.633522727272727 -45.60085227272727 24.545454545454547 -49.05255681818182 31.33380681818182 -49.05255681818182C37.77698863636364 -49.05255681818182 41.30539772727273 -45.75426136363637 41.30539772727273 -39.96306818181818V-39.73295454545455C41.30539772727273 -35.74431818181818 37.125 -35.55255681818182 26.73153409090909 -34.44034090909091C15.302556818181818 -33.21306818181818 4.372159090909091 -29.79971590909091 4.372159090909091 -16.529829545454547C4.372159090909091 -4.947443181818182 12.848011363636363 1.1889204545454546 24.085227272727273 1.1889204545454546ZM27.69034090909091 -9.012784090909092C21.899147727272727 -9.012784090909092 17.757102272727273 -11.65909090909091 17.757102272727273 -16.759943181818183C17.757102272727273 -22.09090909090909 22.397727272727273 -24.31534090909091 28.610795454545453 -25.197443181818183C32.25426136363637 -25.696022727272727 39.54119318181818 -26.616477272727273 41.34375 -28.073863636363637V-21.132102272727273C41.34375 -14.573863636363637 36.05113636363637 -9.012784090909092 27.69034090909091 -9.012784090909092Z", "x": 177.55}], "w": 239.6, "cap": 78.55}; // "Nyra" in Inter SemiBold (OFL), outlined
const DUR=3.4;
function frame(t,lang){
  const R=60,cy=H/2, GAP=34, TOTAL=2*R+GAP+WM.w;
  const cx=lerp(W/2,W/2-TOTAL/2+R,eInOut(P(t,1.35,1.95)));
  const k=R/40, ox=cx-50*k, oy=cy-50*k;
  // disc grows from a point, small press at the click
  let s=eBack(P(t,0.12,0.62));
  const pr=P(t,1.12,1.42); s*=1-0.045*Math.sin(Math.PI*pr);
  // cursor flies in from bottom-right, settles
  const fp=eOut(P(t,0.5,1.15));
  const dx=lerp(118,0,fp), dy=lerp(92,0,fp), rot=lerp(-24,-6,fp), vis=t>0.5?1:0;
  const cur=`translate(${dx} ${dy}) rotate(${rot} 50 50)`;
  const curPath=`<path d="${ARROW}" stroke-width="6" stroke-linejoin="round" transform="${cur}"`;
  // trail dots (only while moving)
  let trail="";
  if(t>0.5&&t<1.5){[[0.10,5],[0.20,3.4]].forEach(([lag,r],i)=>{
    const q=eOut(P(t-lag,0.5,1.15)); const tx=lerp(118,0,q)+40+21*0.86+6, ty=lerp(92,0,q)+31+59*0.86+6;
    const a=(1-P(t,1.0,1.4))*(i?0.35:0.6)*(q>0?1:0);
    trail+=`<circle cx="${tx}" cy="${ty}" r="${r}" fill="${FG}" opacity="${a.toFixed(3)}"/>`;});}
  // ripple from cursor tip at the click
  const rp=P(t,1.2,1.9), tip=[40-50,31-50], c6=Math.cos(-6*Math.PI/180), s6=Math.sin(-6*Math.PI/180);
  const tx=50+tip[0]*c6-tip[1]*s6, ty=50+tip[0]*s6+tip[1]*c6;
  const ripple=rp>0&&rp<1?`<circle cx="${tx}" cy="${ty}" r="${lerp(2,58,eOut(rp))}" fill="none" stroke="${GRAY}" stroke-width="${lerp(2.2,0.4,rp)}" opacity="${(1-rp)*0.7}"/>`:"";
  const sc=`translate(${50} ${50}) scale(${s}) translate(-50 -50)`;
  const mark=`<g transform="translate(${ox} ${oy}) scale(${k})">
    <defs><clipPath id="d"><circle cx="50" cy="50" r="${40*s}"/></clipPath></defs>
    ${vis?curPath+` fill="${FG}" stroke="${FG}"/>`:""}
    <g transform="${sc}"><circle cx="50" cy="50" r="40" fill="${FG}"/></g>
    ${vis?`<g clip-path="url(#d)">${curPath} fill="${BG}" stroke="${BG}"/></g>`:""}
    ${trail}${ripple}</g>`;
  // wordmark letters
  let word="";const bx=cx+R+GAP, by=cy+WM.cap/2;
  WM.glyphs.forEach((g,i)=>{const p=eOut(P(t,1.55+0.08*i,2.15+0.08*i));
    word+=`<path transform="translate(${(bx+g.x+lerp(-10,0,p)).toFixed(2)} ${(by+lerp(22,0,p)).toFixed(2)})" d="${g.d}" fill="${FG}" opacity="${p.toFixed(3)}"/>`;});
  const out=1-P(t,3.0,3.4);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${BG}"/><g opacity="${out}">${mark}${word}</g></svg>`;
}
const api={frame,DUR,W,H};
if(typeof module!=="undefined")module.exports=api; else root.NyraSplash=api;
})(this);
(function(){
  var el=document.getElementById("nyra-splash"),root=document.documentElement;
  function mq(q){try{return !!(window.matchMedia&&window.matchMedia(q).matches)}catch(e){return false}}
  var seen=false;try{seen=!!sessionStorage.getItem("nyra-splash-seen")}catch(e){}
  var env={seen:seen,standalone:mq("(display-mode: standalone)")||mq("(display-mode: fullscreen)"),
    iosStandalone:window.navigator.standalone===true,coarse:mq("(pointer: coarse)"),
    shortSide:Math.min(screen.width||0,screen.height||0),reducedMotion:mq("(prefers-reduced-motion: reduce)")};
  var mode=nyraSplashMode(env);
  window.__nyraSplash={mode:mode,done:mode==="none"};
  root.setAttribute("data-splash",mode);
  if(mode==="none"){el.parentNode.removeChild(el);return}
  try{sessionStorage.setItem("nyra-splash-seen","1")}catch(e){}
  el.hidden=false;
  var S=window.NyraSplash,stopped=false,start=null;
  function vb(){var w=window.innerWidth||390,h=window.innerHeight||844,W=560,H=W*h/w;if(H<360){H=360;W=H*w/h}
    return (640-W/2).toFixed(1)+" "+(400-H/2).toFixed(1)+" "+W.toFixed(1)+" "+H.toFixed(1)}
  function draw(t){el.innerHTML=S.frame(t).replace(/viewBox="0 0 1280 800" width="1280" height="800"/,'viewBox="'+vb()+'" preserveAspectRatio="xMidYMid meet" width="100%" height="100%"')}
  function finish(){if(stopped)return;stopped=true;el.style.opacity="0";el.style.pointerEvents="none";
    setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el);root.setAttribute("data-splash","done");window.__nyraSplash.done=true},380)}
  window.__nyraSplash.skip=finish;
  ["pointerdown","touchstart","click","keydown"].forEach(function(n){(n==="keydown"?window:el).addEventListener(n,finish,{once:true,passive:true})});
  if(mode==="static"){draw(2.9);el.style.opacity="0";requestAnimationFrame(function(){el.style.transition="opacity .3s ease";el.style.opacity="1"});setTimeout(finish,900);return}
  draw(0);
  function tick(ts){if(stopped)return;if(start===null)start=ts;var t=(ts-start)/1000;draw(Math.min(t,S.DUR));if(t>=S.DUR)finish();else requestAnimationFrame(tick)}
  requestAnimationFrame(tick);
  setTimeout(finish,(S.DUR+1.2)*1000); // safety net if rAF is throttled
})();
</script>
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
<symbol id="nyra-mark" viewBox="0 0 100 100"><mask id="nyra-mark-cut"><rect width="100" height="100" fill="#fff"/><path d="M40.00 31.00 L40.00 75.72 L50.75 65.83 L58.06 81.74 L65.37 78.47 L58.06 62.65 L72.25 62.65 Z" fill="#000" stroke="#000" stroke-width="6" stroke-linejoin="round" transform="rotate(-6 50 50)"/></mask><circle cx="50" cy="50" r="46" fill="currentColor" mask="url(#nyra-mark-cut)"/></symbol>
</svg>

<section class="view" id="v-pair" hidden aria-label="配对">
  <div class="pair">
    <svg class="mark" aria-hidden="true"><use href="#nyra-mark"/></svg>
    <h1>连接电脑上的 Nyra</h1>
    <p>在电脑上运行 <code>python3 -m nyra ui --pair</code>，或在网页界面的“设置 → 手机”里点“连接手机”，再用手机相机扫码。也可以在下面输入电脑上显示的 6 位配对码。</p>
    <input class="field code" id="pair-code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-label="6 位配对码">
    <input class="field" id="pair-name" maxlength="40" placeholder="设备名称（可选）" aria-label="设备名称">
    <button class="bt p" id="pair-go" type="button">配对</button>
    <div class="msg" id="pair-msg" role="status" aria-live="polite"></div>
  </div>
</section>

<section class="view" id="v-home" hidden aria-label="会话">
  <header class="hd">
    <svg class="mark" aria-hidden="true"><use href="#nyra-mark"/></svg>
    <div class="ttl big"><b>会话</b><small id="home-sub">正在连接电脑…</small></div>
    <button class="ib" id="refresh" type="button" aria-label="刷新">↻</button>
  </header>
  <button class="banner" id="pending-banner" type="button" hidden><span class="badge" id="pending-count">1</span><span><b>有操作等待你批准</b><br><small id="pending-what"></small></span></button>
  <div class="lst" id="list" role="list"></div>
  <button class="fab" id="new" type="button">✎ 新会话</button>
</section>

<section class="view" id="v-chat" hidden aria-label="对话">
  <header class="hd">
    <button class="ib" id="back" type="button" aria-label="返回会话列表">‹</button>
    <div class="ttl c"><b id="chat-title">新会话</b><small id="chat-sub">在你的电脑上运行</small></div>
    <span class="ib ghost" aria-hidden="true"></span>
  </header>
  <div class="feed" id="feed"><div id="log" aria-live="polite"></div></div>
  <form class="pill" id="comp"><textarea id="input" rows="1" placeholder="让 Nyra 做点什么" aria-label="消息"></textarea><button class="go" id="send" type="submit" aria-label="发送">↑</button></form>
</section>
<div class="toast" id="toast" role="status" hidden></div>

<script>
(function(){
"use strict";
var DKEY="nyra-device";
function $(id){return document.getElementById(id)}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function short(s,n){s=String(s==null?"":s).replace(/\s+/g," ").trim();return s.length>n?s.slice(0,n-1)+"…":s}
function toast(m){var t=$("toast");t.textContent=m;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(function(){t.hidden=true},3200)}
function loadDev(){try{var d=JSON.parse(localStorage.getItem(DKEY)||"null");return d&&d.token?d:null}catch(e){return null}}
var DEV=loadDev();
var S={view:null,sid:null,next:0,status:"idle",timer:null,cards:{},pend:[],project:"",sessions:[]};

function api(path,opts){opts=opts||{};var h={"Content-Type":"application/json"};if(DEV)h["X-Nyra-Device"]=DEV.token;opts.headers=h;opts.cache="no-store";
  return fetch(path,opts).then(function(r){return r.json().catch(function(){return {}}).then(function(j){
    if(r.status===401&&DEV){unpair("这台手机的配对已失效（可能已在电脑上撤销），请重新配对。");throw new Error("未配对")}
    if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j})})}

/* ---------- pairing ---------- */
function deviceName(){var ua=navigator.userAgent||"";if(/iPhone/.test(ua))return "iPhone";if(/iPad/.test(ua))return "iPad";if(/Android/.test(ua))return "Android 手机";return "手机"}
function unpair(msg){try{localStorage.removeItem(DKEY)}catch(e){}DEV=null;clearTimeout(S.timer);clearInterval(S.pendTimer);show("pair");if(msg)pairMsg(msg,true)}
function pairMsg(m,bad){var p=$("pair-msg");p.textContent=m||"";p.className="msg"+(bad?" bad":"")}
function pair(code){code=String(code||"").replace(/\D/g,"");if(code.length!==6){pairMsg("请输入 6 位数字配对码",true);return Promise.resolve(false)}
  $("pair-go").disabled=true;pairMsg("正在配对…");
  return fetch("/api/pair",{method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store",body:JSON.stringify({code:code,name:($("pair-name").value||"").trim()||deviceName()})})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(j){if(!r.ok||!j.token)throw new Error(j.error||("HTTP "+r.status));return j})})
    .then(function(j){DEV={id:j.id,name:j.name,token:j.token};try{localStorage.setItem(DKEY,JSON.stringify(DEV))}catch(e){}
      pairMsg("");toast("已配对："+j.name);start();return true})
    .catch(function(e){pairMsg("配对失败："+e.message,true);return false})
    .then(function(ok){$("pair-go").disabled=false;return ok})}
$("pair-go").onclick=function(){pair($("pair-code").value)};
$("pair-code").addEventListener("input",function(){var v=this.value.replace(/\D/g,"").slice(0,6);if(v!==this.value)this.value=v;if(v.length===6)pair(v)});

/* ---------- views ---------- */
function show(name){S.view=name;["pair","home","chat"].forEach(function(v){$("v-"+v).hidden=v!==name})}
function relTime(iso){var d=new Date(iso);if(isNaN(d.getTime()))return "";var s=(Date.now()-d.getTime())/1000;if(s<60)return "刚刚";if(s<3600)return Math.floor(s/60)+" 分钟";if(s<86400)return Math.floor(s/3600)+" 小时";return Math.floor(s/86400)+" 天"}
function pendingFor(sid){return S.pend.filter(function(p){return p.session===sid})}
function renderList(){var box=$("list");box.textContent="";
  if(!S.sessions.length){box.appendChild(el("div","empty","还没有会话。点右下角“新会话”，让电脑上的 Nyra 开始工作。"));return}
  var groups={},order=[];S.sessions.forEach(function(s){var k=s.project||"其他";if(!groups[k]){groups[k]=[];order.push(k)}groups[k].push(s)});
  order.forEach(function(k){box.appendChild(el("div","lh",k));groups[k].forEach(function(s){
    var b=el("button","it");b.type="button";b.setAttribute("role","listitem");var waiting=pendingFor(s.id).length;
    b.appendChild(el("span","dot"+(waiting?" wait":(s.running?" run":""))));
    var tx=el("span","tx");tx.appendChild(el("b",null,short(s.preview||"（空会话）",60)));tx.appendChild(el("small",null,waiting?"等待你批准":(s.running?"正在运行":(s.count+" 条消息"))));b.appendChild(tx);
    b.appendChild(el("span","t",relTime(s.mtime)));b.onclick=function(){openChat(s.id,s.preview)};box.appendChild(b)})})}
function loadSessions(){return api("/api/sessions").then(function(r){S.sessions=r.sessions||[];S.project=(r.project&&r.project.name)||"";
  $("home-sub").textContent="已连接电脑"+(S.project?" · "+S.project:"");renderList()}).catch(function(e){$("home-sub").textContent="连接失败："+e.message})}

/* ---------- pending approvals: title + app badge (local only, no push) ---------- */
function setBadge(n){document.title=(n?"("+n+") ":"")+"Nyra";
  try{if(n&&navigator.setAppBadge)navigator.setAppBadge(n).catch(function(){});else if(!n&&navigator.clearAppBadge)navigator.clearAppBadge().catch(function(){})}catch(e){}
  var bn=$("pending-banner");bn.hidden=!n;if(n){$("pending-count").textContent=String(n);$("pending-what").textContent=short(S.pend[0].summary.split("\n")[0],60)}}
function loadPending(){if(!DEV)return Promise.resolve();return api("/api/approvals").then(function(r){S.pend=r.approvals||[];setBadge(S.pend.length);if(S.view==="home")renderList()}).catch(function(){})}
$("pending-banner").onclick=function(){var p=S.pend[0];if(p)openChat(p.session,"")};

/* ---------- chat ---------- */
function md(text){var frag=document.createDocumentFragment();var parts=String(text||"").split(/```[^\n]*\n?/);
  parts.forEach(function(part,i){if(!part)return;if(i%2===1){frag.appendChild(el("pre",null,part.replace(/\n$/,"")));return}
    part.split(/\n{2,}/).forEach(function(par){if(!par.trim())return;var p=el("p");var re=/`([^`\n]+)`/g,last=0,m;
      while((m=re.exec(par))){if(m.index>last)p.appendChild(document.createTextNode(par.slice(last,m.index)));p.appendChild(el("code",null,m[1]));last=re.lastIndex}
      if(last<par.length)p.appendChild(document.createTextNode(par.slice(last)));p.style.whiteSpace="pre-wrap";frag.appendChild(p)})});return frag}
function log(){return $("log")}
function addUser(t){log().appendChild(el("div","u",t))}
function addAssistant(t){if(!t)return;var d=el("div","a");d.appendChild(md(t));log().appendChild(d)}
function addNote(t,bad){log().appendChild(el("div","note"+(bad?" bad":""),t))}
function toolLine(name,args){var a=args;if(typeof a==="string"){try{a=JSON.parse(a)}catch(e){}}var s="";
  if(a&&typeof a==="object")s=a.path||a.command||a.url||a.query||a.pattern||"";var last=log().lastElementChild;var g=last&&last.classList.contains("lg")?last:null;
  if(!g){g=el("div","lg");log().appendChild(g)}var r=el("span",null,"◇ "+name+" ");if(s)r.appendChild(el("span","c",short(s,48)));g.appendChild(r)}
var TITLES={shell:"运行命令？",write_file:"写入文件？",edit_file:"编辑文件？",apply_patch:"应用补丁？",plan:"写入计划文件？",http_post:"发送网络请求？",memory_append:"写入记忆？",save_skill:"保存技能？"};
function diffBox(body){var pre=el("div","diff");pre.setAttribute("aria-label","改动预览");
  String(body).split("\n").forEach(function(l){if(l==="")return;var k=/^(\+\+\+|---)/.test(l)?"dl-h":l.charAt(0)==="+"?"dl-a":l.charAt(0)==="-"?"dl-d":l.indexOf("@@")===0?"dl-h":"";pre.appendChild(el("span","dl"+(k?" "+k:""),l))});return pre}
function addApproval(d){if(S.cards[d.id])return;var sum=String(d.summary||""),nl=sum.indexOf("\n"),head=nl<0?sum:sum.slice(0,nl),body=nl<0?"":sum.slice(nl+1);
  var c=el("div","box appr");c.dataset.aid=d.id;c.setAttribute("role","group");c.setAttribute("aria-label","需要批准："+d.tool);
  c.appendChild(el("div","h",TITLES[d.tool]||(d.tool+" 需要批准")));c.appendChild(el("div","cmd",head));c.appendChild(el("div","sub",d.tool+" · 在你的电脑上执行"));
  if(body.trim())c.appendChild(diffBox(body));
  var acts=el("div","acts"),row=el("div","row");
  var no=el("button","bt s","拒绝");no.type="button";no.onclick=function(){decide(d.id,false,false,c)};
  var ok=el("button","bt p","允许一次");ok.type="button";ok.onclick=function(){decide(d.id,true,false,c)};
  row.appendChild(no);row.appendChild(ok);acts.appendChild(row);
  if(d.always){var al=el("button","bt s","本会话始终允许");al.type="button";al.onclick=function(){decide(d.id,true,true,c)};acts.appendChild(al)}
  c.appendChild(acts);c.appendChild(el("div","res"));c.lastChild.hidden=true;log().appendChild(c);S.cards[d.id]=c}
function approvalDone(d){var c=S.cards[d.id];if(!c)return;c.classList.add("done");var r=c.querySelector(".res");r.hidden=false;r.className="res "+(d.approved?"ok":"bad");
  r.textContent=d.approved?(d.always?"已允许（本会话始终允许）":"已允许一次"):(d.timeout?"审批超时，已拒绝":"已拒绝")}
function decide(id,ok,always,c){c.querySelectorAll(".acts button").forEach(function(b){b.disabled=true});
  api("/api/approvals/"+id,{method:"POST",body:JSON.stringify({approve:ok,always:!!always})}).then(function(){loadPending();poll(150)})
   .catch(function(e){c.querySelectorAll(".acts button").forEach(function(b){b.disabled=false});toast("审批失败："+e.message)})}
function renderTranscript(msgs){log().textContent="";S.cards={};
  (msgs||[]).forEach(function(m){if(m.role==="user")addUser(m.content||"");else if(m.role==="assistant"){if(m.content)addAssistant(m.content);(m.tool_calls||[]).forEach(function(tc){var f=tc.function||{};toolLine(f.name,f.arguments)})}})}
function applyEvent(ev){var d=ev.data||{};
  if(ev.type==="user")addUser(d.content||"");
  else if(ev.type==="assistant"||ev.type==="final")addAssistant(d.content);
  else if(ev.type==="tool_start")toolLine(d.name,d.arguments);
  else if(ev.type==="approval")addApproval(d);
  else if(ev.type==="approval_result")approvalDone(d);
  else if(ev.type==="max_turns")addNote("已达到最大轮数（"+d.max_turns+"），任务未完成。",true);
  else if(ev.type==="model_switch")addNote("模型已切换："+d.from+" → "+d.to);
  else if(ev.type==="plan_ready")addNote("计划已写入 "+(d.path||"plan.md")+"，请在电脑上查看并执行。")}
function nearEnd(){var f=$("feed");return f.scrollHeight-f.scrollTop-f.clientHeight<140}
function scrollEnd(){var f=$("feed");f.scrollTop=f.scrollHeight}
function setStatus(st){S.status=st;$("send").disabled=st==="running";$("chat-sub").textContent=st==="running"?"正在运行 · 在你的电脑上":(S.project?S.project+" · 在你的电脑上":"在你的电脑上运行")}
function openChat(sid,preview,push){clearTimeout(S.timer);S.sid=sid;S.next=0;S.cards={};log().textContent="";$("chat-title").textContent=short(preview||"会话",40);show("chat");
  if(push!==false)history.pushState({chat:sid},"","#s="+encodeURIComponent(sid));
  return api("/api/sessions/"+encodeURIComponent(sid)).then(function(v){if(sid!==S.sid)return;var running=v.status==="running";
    renderTranscript(v.messages);if(running)v.events.forEach(applyEvent);
    if(v.pending)addApproval(v.pending);
    if(!preview){var first=(v.messages||[]).filter(function(m){return m.role==="user"})[0]||(v.events||[]).filter(function(e){return e.type==="user"})[0];if(first)$("chat-title").textContent=short(first.content||(first.data&&first.data.content)||"会话",40)}
    if(!log().childNodes.length)log().appendChild(el("div","empty","给电脑上的 Nyra 一个任务。写文件、跑命令前，会在这里请你批准。"));
    S.next=v.next;setStatus(v.status);if(v.status==="error"&&v.error)addNote("错误："+v.error,true);if(running)poll();scrollEnd()}).catch(function(e){toast("读取会话失败："+e.message)})}
function poll(delay){clearTimeout(S.timer);S.timer=setTimeout(function(){if(!S.sid||S.view!=="chat")return;var sid=S.sid;
  api("/api/sessions/"+encodeURIComponent(sid)+"?since="+S.next).then(function(v){if(sid!==S.sid)return;var stick=nearEnd();
    v.events.forEach(applyEvent);S.next=v.next;if(v.pending)addApproval(v.pending);if(v.events.length&&stick)scrollEnd();
    if(v.status==="running"){setStatus("running");poll()}else{setStatus(v.status);if(v.status==="error"&&v.error)addNote("错误："+v.error,true);if(stick)scrollEnd();loadPending()}})
   .catch(function(){poll(2000)})},delay==null?700:delay)}
function newChat(){return api("/api/sessions",{method:"POST",body:"{}"}).then(function(r){openChat(r.id,"新会话");setTimeout(function(){$("input").focus()},50)}).catch(function(e){toast("新建失败："+e.message)})}
function send(){var t=$("input").value.trim();if(!t||S.status==="running"||!S.sid)return;var sid=S.sid;$("input").value="";autosize();
  var e=log().querySelector(".empty");if(e)e.remove();
  api("/api/sessions/"+encodeURIComponent(sid)+"/messages",{method:"POST",body:JSON.stringify({text:t})}).then(function(r){if(r.status==="error"){addNote("错误："+r.error,true);return}
    if($("chat-title").textContent==="新会话")$("chat-title").textContent=short(t,40);S.next=0;setStatus("running");poll(200)}).catch(function(err){addNote("发送失败："+err.message,true);$("input").value=t})}
function autosize(){var i=$("input");i.style.height="auto";i.style.height=Math.min(i.scrollHeight,140)+"px"}
$("comp").addEventListener("submit",function(e){e.preventDefault();send()});
$("input").addEventListener("input",autosize);
$("back").onclick=function(){if(history.state&&history.state.chat)history.back();else goHome()};
function goHome(){clearTimeout(S.timer);S.sid=null;show("home");loadSessions();loadPending()}
window.addEventListener("popstate",function(e){if(!DEV)return;if(e.state&&e.state.chat)openChat(e.state.chat,"",false);else goHome()});
$("new").onclick=newChat;
$("refresh").onclick=function(){loadSessions();loadPending()};
document.addEventListener("visibilitychange",function(){if(!document.hidden&&DEV){loadPending();if(S.view==="home")loadSessions();else if(S.view==="chat")poll(0)}});

/* ---------- start ---------- */
function start(){history.replaceState(null,"",location.pathname);show("home");loadSessions();loadPending();clearInterval(S.pendTimer);S.pendTimer=setInterval(loadPending,4000)}
var m=/(?:^|[#&])pair=(\d{6})/.exec(location.hash||"");
if(m){history.replaceState(null,"",location.pathname);show("pair");$("pair-code").value=m[1];pair(m[1])}
else if(DEV)start();
else show("pair");
})();
</script>
</body>
</html>
"""

MOBILE_HTML = MOBILE_HTML.replace("__STARTUP_LINKS__", _startup_links())
