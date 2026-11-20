# callkit.py — 视频通话面板设计稿的公共样式、图标与组件。
# 令牌直接取自 kit.py 的 LIGHT / DARK（= src/assets/desktop-app.css.txt 的 :root），
# 液态玻璃在实现参数（--g-*）的基础上加强：更大模糊、更高饱和、更亮的镜面高光与折射边。
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', '..', 'source'))  # 仓库里 kit.py 在 docs/design/source/
from kit import LIGHT, DARK
import segno, io, re

# 实现里在玻璃上的次要文字令牌（desktop-app.css.txt 282-283 行），通话面板沿用并再加深一档。
GLASS_TEXT = {
    "light": dict(mu="#4E4E53", mu2="#5C5C61"),
    "dark": dict(mu="#C8C8CD", mu2="#B4B4B9"),
}

# ---- 加强版液态玻璃（通话专用浮层：控制条、顶栏、弹层、对话框、横幅） ----
GLASS = {
 "light": dict(
  fill="rgba(255,255,255,.50)", strong="rgba(255,255,255,.78)", media="rgba(250,250,252,.80)",
  blur="40px", sat="220%",
  border="rgba(0,0,0,.10)", hi="rgba(255,255,255,1)",
  inner="inset 0 1px 0 rgba(255,255,255,1),inset 0 0 0 1px rgba(255,255,255,.45),inset 0 -1px 0 rgba(255,255,255,.55),inset 0 -22px 40px rgba(255,255,255,.30),inset 0 14px 28px rgba(255,255,255,.22)",
  spec="linear-gradient(180deg,rgba(255,255,255,.80),rgba(255,255,255,0) 48%),linear-gradient(112deg,rgba(255,255,255,0) 34%,rgba(255,255,255,.42) 48%,rgba(255,255,255,0) 62%)",
  rim="linear-gradient(160deg,rgba(255,255,255,1),rgba(255,255,255,.15) 30%,rgba(255,255,255,.05) 60%,rgba(255,255,255,.85))",
  shadow="0 18px 50px rgba(0,0,0,.16),0 2px 6px rgba(0,0,0,.06)",
  scrim="rgba(242,242,244,.55)"),
 "dark": dict(
  fill="rgba(30,30,33,.50)", strong="rgba(24,24,27,.84)", media="rgba(20,20,22,.62)",
  blur="40px", sat="220%",
  border="rgba(255,255,255,.12)", hi="rgba(255,255,255,.30)",
  inner="inset 0 1px 0 rgba(255,255,255,.30),inset 0 0 0 1px rgba(255,255,255,.06),inset 0 -1px 0 rgba(255,255,255,.08),inset 0 -22px 40px rgba(255,255,255,.04),inset 0 14px 28px rgba(255,255,255,.035)",
  spec="linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,0) 48%),linear-gradient(112deg,rgba(255,255,255,0) 34%,rgba(255,255,255,.09) 48%,rgba(255,255,255,0) 62%)",
  rim="linear-gradient(160deg,rgba(255,255,255,.55),rgba(255,255,255,.06) 30%,rgba(255,255,255,0) 60%,rgba(255,255,255,.30))",
  shadow="0 22px 60px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.35)",
  scrim="rgba(0,0,0,.45)"),
}
# 媒体舞台上的玻璃（手机视频全屏：两种主题都在深色视频上）
MEDIA = dict(fill="rgba(22,22,24,.64)", strong="rgba(18,18,20,.76)", border="rgba(255,255,255,.14)",
  inner="inset 0 1px 0 rgba(255,255,255,.32),inset 0 0 0 1px rgba(255,255,255,.07),inset 0 -1px 0 rgba(255,255,255,.08),inset 0 -20px 36px rgba(255,255,255,.045)",
  spec="linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,0) 48%),linear-gradient(112deg,rgba(255,255,255,0) 34%,rgba(255,255,255,.10) 48%,rgba(255,255,255,0) 62%)",
  rim="linear-gradient(160deg,rgba(255,255,255,.60),rgba(255,255,255,.06) 30%,rgba(255,255,255,0) 60%,rgba(255,255,255,.32))")

FONTS = '''@font-face{font-family:Inter;src:url(Inter-Regular.ttf);font-weight:400}
@font-face{font-family:Inter;src:url(Inter-SemiBold.ttf);font-weight:500 600}
@font-face{font-family:Inter;src:url(Inter-Bold.ttf);font-weight:700}
@font-face{font-family:JBM;src:url(JBM-Regular.ttf);font-weight:400}
@font-face{font-family:JBM;src:url(JBM-Bold.ttf);font-weight:700}'''

# ---- 标志：圆盘 + 光标（docs/assets/nyra-mark.svg 同一条 evenodd 路径；圆盘 = currentColor，光标镂空） ----
MARK_D = "M10 50 A40 40 0 1 0 90 50 A40 40 0 1 0 10 50 Z M39.93 29.80 A3 3 0 0 0 35.09 32.46 L39.76 76.94 A3 3 0 0 0 44.99 78.61 L51.92 70.74 L58.75 82.25 A3 3 0 0 0 62.84 83.32 L69.77 79.30 A3 3 0 0 0 70.84 75.17 L64.32 64.23 L73.76 63.24 A3 3 0 0 0 75.32 57.91 Z"
def mark(size=16, cls="mark"):
    return f'<svg class="{cls}" width="{size}" height="{size}" viewBox="6 6 88 88" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="{MARK_D}"/></svg>'

# ---- 图标（24 视框、1.7 描边、圆角，与实现里的 .ic svg 一致） ----
_I = {
 "mic": '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
 "micoff": '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16"/>',
 "cam": '<rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="M15.5 10.5 21 7.5v9l-5.5-3"/>',
 "camoff": '<rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="M15.5 10.5 21 7.5v9l-5.5-3M3.5 3.5l17 17"/>',
 "screen": '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4M9 10.5l3-3 3 3M12 7.5v5.5"/>',
 "chat": '<path d="M4.5 5h15a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H10l-4.5 3.5v-3.5h-1a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
 "more": '<circle cx="5.5" cy="12" r="1.3" class="f"/><circle cx="12" cy="12" r="1.3" class="f"/><circle cx="18.5" cy="12" r="1.3" class="f"/>',
 "hang": '<path class="f" d="M2.6 13.6c5.2-4.9 13.6-4.9 18.8 0 .5.5.5 1.3 0 1.8l-1.9 1.9c-.4.4-1.1.5-1.6.1l-2.4-1.8a1.2 1.2 0 0 1-.5-1v-2.1a12.6 12.6 0 0 0-6 0v2.1c0 .4-.2.8-.5 1l-2.4 1.8c-.5.4-1.2.3-1.6-.1l-1.9-1.9a1.3 1.3 0 0 1 0-1.8z"/>',
 "phone": '<path class="f" d="M6.6 3.6 9 3.2c.6-.1 1.1.2 1.3.7l1.2 3c.2.5 0 1.1-.4 1.4l-1.7 1.2a12 12 0 0 0 5.1 5.1l1.2-1.7c.3-.4.9-.6 1.4-.4l3 1.2c.5.2.8.8.7 1.3l-.4 2.4c-.1.7-.7 1.2-1.4 1.2C10.9 20.5 3.5 13.1 3.4 5c0-.7.5-1.3 1.2-1.4z"/>',
 "lock": '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
 "copy": '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V5.5a1.5 1.5 0 0 0-1.5-1.5H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5h3"/>',
 "userplus": '<circle cx="9.5" cy="8" r="3.8"/><path d="M2.8 20.5a6.8 6.8 0 0 1 13.4 0M19 8v6M16 11h6"/>',
 "users": '<circle cx="9" cy="8" r="3.6"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M15.5 4.6a3.6 3.6 0 0 1 0 6.8M17.5 14.2a6.5 6.5 0 0 1 4 5.8"/>',
 "check": '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
 "x": '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
 "shield": '<path d="M12 3.2 19.5 6v5.8c0 4.6-3.2 7.8-7.5 9-4.3-1.2-7.5-4.4-7.5-9V6z"/>',
 "eye": '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
 "pencil": '<path d="M4 20l1-4.2L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.2 19 4 20z"/>',
 "term": '<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>',
 "folder": '<path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
 "search": '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
 "edit": '<path d="M12 20h8"/><path d="M15.8 4.2a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>',
 "clock": '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
 "spark": '<path d="M12 3.5 13.6 9l5.4 1.5-5.4 1.6L12 17.5l-1.6-5.4L5 10.5 10.4 9z"/>',
 "plug": '<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0zM12 16.5v4"/>',
 "gear": '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
 "grid": '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.6"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.6"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.6"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.6"/>',
 "panel": '<rect x="3" y="4" width="18" height="16" rx="2.2"/><path d="M14.5 4v16"/>',
 "chev": '<path d="M9 6l6 6-6 6"/>',
 "chevd": '<path d="M6 9l6 6 6-6"/>',
 "back": '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
 "min": '<path d="M7 9.5 12 14.5l5-5"/>',
 "signal": '<path d="M5 18v-2M9.5 18v-5M14 18v-8M18.5 18V7"/>',
 "signal1": '<path d="M5 18v-2"/><path d="M9.5 18v-5M14 18v-8M18.5 18V7" opacity=".28"/>',
 "wave": '<path d="M4 12h1.5M8 8.5v7M11.5 5.5v13M15 9v6M18.5 11v2"/>',
 "rec": '<circle cx="12" cy="12" r="5" class="f"/>',
 "info": '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.2M12 7.8v.2"/>',
 "qr": '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2"/>',
 "share": '<path d="M12 15V4M8 7.5 12 3.5l4 4M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5"/>',
 "list": '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.5M4.5 12h.5M4.5 17.5h.5"/>',
 "flip": '<path d="M4 9a8 8 0 0 1 14.5-3M20 15a8 8 0 0 1-14.5 3M18.5 2.5V6H15M5.5 21.5V18H9"/>',
 "speaker": '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
 "doc": '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4M9 12.5h6M9 16h6"/>',
 "plus": '<path d="M12 5v14M5 12h14"/>',
 "refresh": '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4h-4"/>',
 "pause": '<path d="M9 6v12M15 6v12"/>',
 "slashmark": '<path d="M4 4l16 16"/>',
}
def ic(name, size=16, cls="ic"):
    return f'<svg class="{cls}" width="{size}" height="{size}" viewBox="0 0 24 24" aria-hidden="true">{_I[name]}</svg>'

def qr_svg(data="nyra://add/NYR-7K4Q-2M", color="currentColor"):
    q = segno.make(data, error="m", micro=False)
    m = q.matrix
    n = len(m); quiet = 0
    d = "".join(f"M{x} {y}h1v1h-1z" for y,row in enumerate(m) for x,v in enumerate(row) if v)
    return f'<svg viewBox="0 0 {n} {n}" shape-rendering="crispEdges" width="100%" height="100%"><path fill="{color}" d="{d}"/></svg>'

def theme_css(mode):
    t = LIGHT if mode == "light" else DARK
    g = GLASS[mode]; gt = GLASS_TEXT[mode]
    warn = "#B7791F" if mode == "light" else "#E3B341"
    v = ";".join(f"--{k}:{x}" for k, x in t.items())
    extra = (f";--warn:{warn};--warntx:{'#8A5A00' if mode=='light' else '#E3B341'};--warnbg:{'#FBF3E4' if mode=='light' else 'rgba(227,179,65,.12)'}"
             f";--g-fill:{g['fill']};--g-strong:{g['strong']};--g-media:{g['media']};--g-blur:{g['blur']};--g-sat:{g['sat']}"
             f";--g-border:{g['border']};--g-inner:{g['inner']};--g-spec:{g['spec']};--g-rim:{g['rim']};--g-shadow:{g['shadow']};--g-scrim:{g['scrim']}"
             f";--mu:{'#5C5C61' if mode=='light' else '#A6A6AB'};--mu2:{'#67676C' if mode=='light' else '#8E8E93'};--capmu:{'#4E4E53' if mode=='light' else '#A6A6AB'};--gmu:{gt['mu']};--gmu2:{gt['mu2']}"
             f";--m-fill:{MEDIA['fill']};--m-strong:{MEDIA['strong']};--m-border:{MEDIA['border']};--m-inner:{MEDIA['inner']};--m-spec:{MEDIA['spec']};--m-rim:{MEDIA['rim']}"
             f";--rectx:{'#A40E26' if mode=='light' else '#FF9A92'};--danger:#D92D20;--gadd:{t['add'] if mode=='light' else '#5BD46A'};--grm:{t['rm'] if mode=='light' else '#FF9A92'};--ok:{t['add']}")
    return ":root{" + v + extra + "}"

CSS = r'''
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,"Noto Sans CJK SC","PingFang SC",sans-serif;-webkit-font-smoothing:antialiased;color:var(--fg)}
.mono,code{font-family:JBM,"Noto Sans Mono CJK SC",monospace}
.glass,.gstrong{--add:var(--gadd);--rm:var(--grm)}
.ic{stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.ic .f{fill:currentColor;stroke:none}
.mark{flex:none;display:block}
/* ---------- 画板 ---------- */
.stage{width:1600px;height:1000px;background:var(--stage);position:relative;overflow:hidden;display:flex;justify-content:center;align-items:flex-start}
.stage:before{content:"";position:absolute;inset:0;background:radial-gradient(900px 500px at 50% 0%,var(--glow),transparent 70%)}
.cap{position:absolute;left:48px;top:24px;display:flex;align-items:center;gap:12px;color:var(--fg);font-size:18px;font-weight:600;z-index:2}
.cap small{color:var(--capmu);font-weight:400;font-size:14px}
.cap .mark{width:24px;height:24px;color:var(--fg)}
.cap .tag{font-size:12px;font-weight:500;color:var(--capmu);border:1px solid var(--line2);border-radius:999px;padding:2px 9px}
/* ---------- 桌面窗口 1440×900 ---------- */
.win{width:1440px;height:900px;margin-top:76px;border-radius:12px;overflow:hidden;background:var(--bg);color:var(--fg);position:relative;z-index:1;box-shadow:0 40px 120px rgba(0,0,0,.30),0 0 0 1px var(--line2);font-size:13.5px;line-height:1.4;display:flex}
.lights{display:flex;gap:8px}.lights i{width:12px;height:12px;border-radius:50%;display:block}
.lights i:nth-child(1){background:#FF5F57}.lights i:nth-child(2){background:#FEBC2E}.lights i:nth-child(3){background:#28C840}
/* 侧栏（与实现一致） */
.side{width:248px;flex:none;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:44px 8px 10px;gap:1px;position:relative}
.side .lights{position:absolute;left:16px;top:16px}
.si{height:30px;display:flex;align-items:center;gap:10px;padding:0 10px;border-radius:7px;color:var(--fg)}
.si.on{background:var(--hover);font-weight:500}
.si .ic{color:var(--mu)}.si.on .ic{color:var(--fg)}
.si .k{margin-left:auto;color:var(--mu2);font-size:11.5px}
.si .badge{margin-left:auto;min-width:18px;height:18px;border-radius:9px;background:var(--btn);color:var(--btnfg);font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;padding:0 5px}
.sh{font-size:11.5px;color:var(--mu);margin:16px 10px 4px}
.th{height:28px;display:flex;align-items:center;gap:8px;padding:0 10px 0 28px;border-radius:7px;color:var(--mu);white-space:nowrap;overflow:hidden}
.th .t{margin-left:auto;font-size:11.5px;color:var(--mu2)}
.main{flex:1;display:flex;flex-direction:column;min-width:0;position:relative}
.top{height:46px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;padding:0 18px;flex:none}
.top b{font-weight:600}.crumb{color:var(--mu)}
.tbtn{height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--line2);display:inline-flex;align-items:center;gap:6px;color:var(--fg);font-size:12.5px;white-space:nowrap;background:transparent}
.tbtn.p{background:var(--btn);color:var(--btnfg);border-color:var(--btn);font-weight:500}
.tbtn.danger{color:var(--rm)}
.tbtn.lg{height:34px;padding:0 14px;border-radius:9px;font-size:13.5px}
.status{height:28px;border-top:1px solid var(--line);display:flex;align-items:center;gap:18px;padding:0 14px;color:var(--mu);font-size:11.5px;flex:none;background:var(--side)}
.status span{display:flex;align-items:center;gap:6px}
.dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block}
.on-dot{background:var(--add)}.busy-dot{background:var(--warn)}.off-dot{background:transparent;box-shadow:inset 0 0 0 1.5px var(--mu2)}
.card{border:1px solid var(--line2);border-radius:12px;background:var(--bg)}
.muted{color:var(--mu)}.small{font-size:12px}
.add{color:var(--add)}.del{color:var(--rm)}
.chip{height:24px;padding:0 9px;border-radius:999px;background:var(--chip);display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--fg);white-space:nowrap}
.chip.o{background:transparent;box-shadow:inset 0 0 0 1px var(--line2)}
.chip.warn{background:var(--warnbg);color:var(--warntx)}
.kbd{font-family:JBM;font-size:11px;color:var(--mu)}
/* ---------- 头像 + agent 徽章：“一个人 + 他的 agent” ---------- */
.av{position:relative;flex:none;border-radius:50%;background:var(--chip) center/cover no-repeat;display:flex;align-items:center;justify-content:center;font-weight:600;color:var(--fg)}
.av .ag{position:absolute;right:-3px;bottom:-3px;border-radius:50%;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--fg);box-shadow:0 0 0 1.5px var(--bg)}
.av .st{position:absolute;right:-1px;top:-1px;width:11px;height:11px;border-radius:50%;box-shadow:0 0 0 2px var(--bg)}
.agentbox{flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--chip);color:var(--fg)}
/* ---------- 加强版液态玻璃 ---------- */
.glass,.gstrong,.gmedia{position:relative;-webkit-backdrop-filter:blur(var(--g-blur)) saturate(var(--g-sat));backdrop-filter:blur(var(--g-blur)) saturate(var(--g-sat));border:1px solid var(--g-border);box-shadow:var(--g-inner),var(--g-shadow);--mu:var(--gmu);--mu2:var(--gmu2)}
.glass{background:var(--g-spec),var(--g-fill)}
.gstrong{background:var(--g-spec),var(--g-strong)}
.gmedia{background:var(--m-spec),var(--m-fill);border-color:var(--m-border);box-shadow:var(--m-inner),0 18px 50px rgba(0,0,0,.45);color:#F5F5F7;--fg:#F5F5F7;--mu:#D6D6DA;--mu2:#C4C4C9;--chip:rgba(255,255,255,.14);--line2:rgba(255,255,255,.18);--line:rgba(255,255,255,.12)}
.gmedia.s{background:var(--m-spec),var(--m-strong)}
/* 折射边（lensing rim）：渐变描边，用 mask 只露出 1px 边 */
.glass:after,.gstrong:after,.gmedia:after{content:"";position:absolute;inset:-1px;border-radius:inherit;padding:1px;background:var(--g-rim);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
.gmedia:after{background:var(--m-rim)}
/* ---------- 通话：视频块与 agent 块 ---------- */
.tile{position:relative;border-radius:16px;overflow:hidden;background:#111 center/cover no-repeat}
.tile .nm{position:absolute;left:10px;top:10px;height:28px;padding:0 10px 0 8px;border-radius:9px;display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500}
.tile .mi{position:absolute;right:10px;top:10px;width:28px;height:28px;border-radius:9px;display:flex;align-items:center;justify-content:center}
.tile.speaking{outline:2px solid var(--fg);outline-offset:2px}
.agt{--mu:var(--gmu);position:relative;border-radius:16px;overflow:hidden;background:var(--side);border:1px solid var(--line);display:flex;flex-direction:column;align-items:center;justify-content:center}
.agt .orb{position:relative;display:flex;align-items:center;justify-content:center;color:var(--fg)}
.agt .ring{position:absolute;border-radius:50%;border:1.5px solid var(--fg)}
.agt .st{display:flex;align-items:center;gap:7px;font-size:15px;font-weight:600}
.agt .sub{margin-top:5px;color:var(--mu);font-size:12px}
.agt .who{position:absolute;left:12px;top:12px;display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500}
.agt .tok{position:absolute;right:12px;top:12px;font-size:11.5px;color:var(--mu)}
.agt .log{margin-top:10px;font-family:JBM,"Noto Sans Mono CJK SC",monospace;font-size:11.5px;color:var(--mu);line-height:18px}
.caret{display:inline-block;width:7px;height:14px;background:var(--fg);vertical-align:-2px;margin-left:2px}
/* 状态动画（设计稿静帧；实现时按 SPEC 的关键帧） */
@keyframes listen{0%{transform:scale(1);opacity:.5}100%{transform:scale(1.8);opacity:0}}
@keyframes think{to{transform:rotate(360deg)}}
@keyframes blink{50%{opacity:0}}
/* 控制条 */
.cbar{display:flex;align-items:center;gap:6px;padding:8px;border-radius:22px}
.cb{width:52px;height:52px;border-radius:16px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;color:var(--fg);font-size:10.5px;font-weight:500}
.cb .ic{width:20px;height:20px}
.cb.on{background:var(--chip)}
.cb.off{background:var(--fg);color:var(--bg)}
.cb.wide{width:auto;padding:0 12px;flex-direction:row;gap:8px;font-size:12.5px}
.cb.hang{background:var(--danger);color:#fff;width:64px}
.cb .bd{position:absolute;margin:-26px 0 0 26px;min-width:16px;height:16px;border-radius:8px;background:var(--fg);color:var(--bg);font-size:10px;display:flex;align-items:center;justify-content:center;padding:0 4px}
.vsep{width:1px;height:30px;background:var(--line2);margin:0 4px}
/* 审批卡（与实现 .appr 一致：拒绝 / 总是允许 / 允许一次） */
.appr{border-radius:12px;overflow:hidden}
.appr .fr{display:flex;align-items:flex-start;gap:10px;padding:11px 12px}
.appr .ttl{flex:1;min-width:0}
.appr .ttl .a{font-weight:500}
.appr .ttl .s{color:var(--mu);font-size:12px;margin-top:2px}
.appr .acts{display:flex;gap:6px;padding:0 12px 12px;justify-content:flex-end}
.code{font-family:JBM;font-size:11.5px;line-height:19px}
.ln{display:flex;white-space:pre;padding-right:8px}.ln .n{width:34px;text-align:right;padding-right:10px;color:var(--mu2);flex:none}
.ln.a{background:var(--addbg)}.ln.a .n{color:var(--add)}.ln.d{background:var(--rmbg)}.ln.d .n{color:var(--rm)}
/* 开关与单选 */
.tg{width:36px;height:22px;border-radius:11px;background:var(--btn);position:relative;flex:none}.tg:after{content:"";position:absolute;right:2px;top:2px;width:18px;height:18px;border-radius:50%;background:var(--btnfg)}
.tg.off{background:transparent;box-shadow:inset 0 0 0 1.5px var(--mu2)}.tg.off:after{right:auto;left:3px;top:3px;width:16px;height:16px;background:var(--mu2)}
.tg.lock{opacity:.55}
.rd{width:18px;height:18px;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--mu2);flex:none;margin-top:1px}
.rd.on{box-shadow:inset 0 0 0 5.5px var(--fg)}
.seg{display:flex;gap:3px;background:var(--chip);border-radius:10px;padding:3px}
.seg span{flex:1;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;color:var(--mu)}
.seg span.on{background:var(--bg);color:var(--fg);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.dim{position:absolute;inset:0;background:var(--g-scrim)}
.hr{height:1px;background:var(--line)}
/* ---------- 手机 390×844 ---------- */
.phones{display:flex;gap:56px;margin-top:84px;position:relative;z-index:1}
.ph{width:412px;height:866px;border-radius:60px;background:#0A0A0A;padding:11px;box-shadow:0 30px 90px rgba(0,0,0,.40),0 0 0 1px var(--line2);flex:none}
.ph.and{border-radius:44px;background:#1A1A1A}
.sc{width:390px;height:844px;border-radius:50px;overflow:hidden;background:var(--bg);color:var(--fg);position:relative;display:flex;flex-direction:column;font-size:15px;line-height:1.4}
.and .sc{border-radius:34px}
.sb{height:50px;display:flex;align-items:center;justify-content:space-between;padding:0 32px 0 38px;font-weight:600;font-size:15px;flex:none;position:relative;z-index:9}
.isl{position:absolute;top:12px;left:50%;margin-left:-62px;width:124px;height:36px;border-radius:20px;background:#000;z-index:10}
.and .sb{height:38px;font-size:13px;padding:0 24px}
.pcam{position:absolute;left:50%;top:12px;width:13px;height:13px;border-radius:50%;background:#000;margin-left:-6px;z-index:10}
.hb{position:absolute;bottom:8px;left:50%;width:134px;height:5px;border-radius:3px;margin-left:-67px;background:var(--fg);opacity:.85;z-index:12}
.hd{display:flex;align-items:center;padding:6px 16px 8px;gap:12px}
.ib{width:36px;height:36px;border-radius:50%;background:var(--chip);display:flex;align-items:center;justify-content:center;color:var(--fg);flex:none}
.lt{font-size:30px;font-weight:700;letter-spacing:-.02em;padding:4px 20px 10px}
.lh{color:var(--mu);font-size:13px;padding:14px 20px 6px}
.it{display:flex;align-items:center;gap:12px;padding:10px 20px}
.it b{font-weight:600;display:block}.it small{color:var(--mu);font-size:13px;display:block}
.bt{height:44px;border-radius:22px;display:flex;align-items:center;justify-content:center;gap:6px;font-weight:600;font-size:15px;flex:1;background:var(--chip);color:var(--fg);white-space:nowrap;padding:0 10px}
.bt.p{background:var(--btn);color:var(--btnfg)}
.bt.danger{background:var(--danger);color:#fff}
.bt.sm{height:34px;font-size:13.5px;border-radius:17px;flex:none;padding:0 14px}
.sheet{position:absolute;left:0;right:0;bottom:0;border-radius:30px 30px 0 0;padding:10px 18px 30px;border-bottom:0}
.grab{width:36px;height:5px;border-radius:3px;background:var(--mu2);opacity:.6;margin:0 auto 14px}
.nav{height:82px;display:flex;justify-content:space-around;align-items:flex-start;padding-top:8px;font-size:11px;color:var(--mu);border-radius:0;border-left:0;border-right:0;border-bottom:0}
.nav div{display:flex;flex-direction:column;align-items:center;gap:3px}
.nav .on{color:var(--fg);font-weight:600}
.vid{position:absolute;inset:0;background:#111 center/cover no-repeat}
.vscrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.72),rgba(0,0,0,.25) 18%,rgba(0,0,0,0) 32%,rgba(0,0,0,0) 62%,rgba(0,0,0,.55))}
.pip{position:absolute;border-radius:16px;background:#111 center/cover no-repeat;box-shadow:0 8px 24px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.18)}
'''

def page(mode, body, extra=""):
    return f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>{FONTS}{theme_css(mode)}{CSS}{extra}</style></head><body>{body}</body></html>'
