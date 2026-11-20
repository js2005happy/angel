# call.py — Nyra 视频通话面板设计稿（桌面 1440×900 Mac 风格 + 手机 390×844 iOS/Android），浅色 / 深色。
# 生成 call-*.html；render_call.py 渲染 PNG。文案为中文一套（英文见 SPEC.md 文案表）。
# 所有数字（流量、token、时长、码）均为示意。
from callkit import *
import os, json
HERE = os.path.dirname(os.path.abspath(__file__))
A = "call-assets/"
PEOPLE = {
 "me":   dict(name="我", full="Sheng", img=A+"cam-me.jpg",   pos="51% 26%", agent="Nyra"),
 "lin":  dict(name="林舟", img=A+"cam-lin.jpg",  pos="56% 24%", agent="Kite"),
 "mark": dict(name="Mark Chen", img=A+"cam-mark.jpg", pos="57% 22%", agent="Pilot"),
}

def avatar(who, size=36, agent=True, status=None, ini=None):
    p = PEOPLE.get(who)
    style = f"width:{size}px;height:{size}px;font-size:{int(size*.4)}px;"
    inner = ""
    if p:
        style += f"background-image:url({p['img']});background-size:330% auto;background-position:{p['pos']};"
    else:
        inner = ini or "?"
    ag = ""
    if agent:
        s = max(14, int(size*.44))
        ag = f'<span class="ag" style="width:{s}px;height:{s}px">{mark(int(s*.78))}</span>'
    st = ""
    if status:
        st = f'<span class="st {status}-dot"></span>'
    return f'<span class="av" style="{style}">{inner}{ag}{st}</span>'

def orb(state, size=64):
    """agent 的“圆盘 + 光标”动画静帧。state: listen / think / edit / wait / muted / idle"""
    rings = ""
    if state == "listen":
        for i,(sc,op) in enumerate([(1.3,.30),(1.6,.15),(1.9,.07)]):
            d = size*sc
            rings += f'<span class="ring" style="width:{d}px;height:{d}px;opacity:{op}"></span>'
    elif state == "think":
        d = size*1.42
        rings = f'<svg style="position:absolute;width:{d}px;height:{d}px" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="none" stroke="currentColor" stroke-opacity=".14" stroke-width="2"/><circle cx="50" cy="50" r="48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="70 232" transform="rotate(-60 50 50)"/></svg>'
    elif state == "edit":
        d = size*1.42
        rings = f'<svg style="position:absolute;width:{d}px;height:{d}px" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="2" stroke-dasharray="2 6"/></svg>'
    elif state == "wait":
        d = size*1.42
        rings = f'<span class="ring" style="width:{d}px;height:{d}px;border-color:var(--warn);border-width:2px"></span>'
    op = ".42" if state == "muted" else "1"
    sl = ""
    if state == "muted":
        sl = f'<span style="position:absolute;right:-6px;bottom:-6px;width:{int(size*.42)}px;height:{int(size*.42)}px;border-radius:50%;background:var(--fg);color:var(--bg);display:flex;align-items:center;justify-content:center">{ic("micoff", int(size*.24))}</span>'
    return f'<span class="orb" style="width:{size}px;height:{size}px">{rings}<span style="opacity:{op};display:flex">{mark(size)}</span>{sl}</span>'

STATE = {
 "listen": ("在听", ""),
 "think": ("思考中", ""),
 "edit": ("正在编辑", "auth/client.py"),
 "wait": ("等你批准", "想修改 auth/client.py"),
 "muted": ("已静音", "不听也不说，后台任务照常"),
}

# ------------------------------------------------------------------ 桌面 ---
def side(active="friends", badge=True):
    items = [("edit","新对话","⌘N"),("search","搜索","⌘K"),("clock","自动化",""),("spark","技能",""),("plug","MCP 服务器","")]
    h = '<div class="side"><div class="lights"><i></i><i></i><i></i></div>'
    for icn,lab,k in items:
        h += f'<div class="si">{ic(icn,15)}{lab}<span class="k">{k}</span></div>'
    on = " on" if active=="friends" else ""
    b = '<span class="badge">1</span>' if badge else ""
    h += f'<div class="si{on}">{ic("users",15)}好友与通话{b}</div>'
    h += '<div class="sh">项目</div><div class="si" style="font-weight:500">'+ic("chevd",13)+'app</div>'
    h += '<div class="th" style="color:var(--fg)"><span class="dot" style="background:var(--warn)"></span>Fix login timeout<span class="t">刚刚</span></div>'
    h += '<div class="th">Flaky checkout test<span class="t">12 分钟</span></div><div class="th">Add dark mode tokens<span class="t">2 小时</span></div>'
    h += '<div style="flex:1"></div><div class="si">'+ic("gear",15)+'设置</div></div>'
    return h

def friend_row(who, name, agent, status, stxt, perm, sel=False, ini=None, busy=False):
    bg = "background:var(--hover);" if sel else ""
    call_dis = "opacity:.4;" if status=="off" else ""
    return f'''<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;{bg}">
 {avatar(who,40,True,None,ini)}
 <div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px"><b style="font-weight:600">{name}</b><span class="dot {status}-dot"></span><span class="muted small">{stxt}</span></div>
 <div class="muted small" style="margin-top:2px;display:flex;align-items:center;gap:6px">{mark(12)}<span style="color:var(--fg)">{agent}</span> · {name}{' 的' if name.isascii() else '的'} agent · {perm}</div></div>
 <span class="tbtn" style="{call_dis}">{ic("cam",14)}视频通话</span><span class="tbtn" style="{call_dis}">{ic("users",14)}邀请协作</span></div>'''

def d_friends(mode):
    perm_row = lambda icn, t, s, okk: f'''<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)">{ic(icn,15)}<div style="flex:1"><div>{t}</div><div class="muted small">{s}</div></div>{'<span class="chip" style="color:var(--add)">'+ic("check",12)+'允许</span>' if okk=='y' else ('<span class="chip warn">'+ic("shield",12)+'需你批准</span>' if okk=='a' else '<span class="chip o muted">'+ic("x",12)+'不允许</span>')}</div>'''
    body = f'''<div class="win">{side()}
<div class="main"><div class="top"><b>好友与通话</b><span class="crumb">· 加的是“一个人 + 他的 agent”</span><span style="flex:1"></span><span class="tbtn">{ic("search",14)}搜索好友</span><span class="tbtn p">{ic("userplus",14)}添加好友</span></div>
<div style="flex:1;display:flex;gap:20px;padding:20px 22px;min-height:0">
 <div style="width:620px;display:flex;flex-direction:column;gap:16px">
  <div class="card" style="padding:16px;display:flex;gap:18px;align-items:center">
   <div style="width:112px;height:112px;padding:8px;border-radius:12px;background:#fff;color:#0B0B0C;box-shadow:inset 0 0 0 1px var(--line2);flex:none">{qr_svg()}</div>
   <div style="flex:1;min-width:0"><div class="muted small">我的 Nyra 好友码 · 对方扫码或输入即可加你</div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:6px"><span class="mono" style="font-size:24px;font-weight:700;letter-spacing:.04em">NYR-7K4Q-2M</span><span class="tbtn">{ic("copy",14)}复制</span><span class="tbtn">{ic("share",14)}分享</span></div>
    <div class="muted small" style="margin-top:8px;display:flex;align-items:center;gap:8px">{avatar("me",22,True)}Sheng · 我的 agent：<span style="color:var(--fg)">Nyra</span></div>
    <div class="muted small" style="margin-top:6px">好友码 24 小时后失效 · <u>重新生成</u> · 加好友后对方的 agent 默认只读</div></div>
  </div>
  <div class="card" style="padding:12px 14px">
   <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="font-weight:600">好友请求</b><span class="chip">1</span></div>
   <div style="display:flex;align-items:center;gap:12px">{avatar("mark",40,True)}
    <div style="flex:1;min-width:0"><div><b style="font-weight:600">Mark Chen</b> 想加你为好友</div><div class="muted small" style="margin-top:2px;display:flex;align-items:center;gap:5px">连同他的 agent {mark(12)}<span style="color:var(--fg)">Pilot</span> · 通过好友码 · 3 分钟前</div></div>
    <span class="tbtn lg">拒绝</span><span class="tbtn lg p">接受</span></div>
   <div class="muted small" style="margin-top:10px;padding:8px 10px;border-radius:8px;background:var(--chip)">接受后：Mark 可以给你打视频；Pilot 默认 <b style="color:var(--fg);font-weight:600">只读</b>，第一次协作前你会再确认它能做什么。</div>
  </div>
  <div style="display:flex;align-items:center;gap:8px;padding:2px 2px 0"><b style="font-weight:600">好友</b><span class="muted small">4 人 · 4 个 agent</span><span style="flex:1"></span><span class="muted small">按在线排序</span></div>
  <div style="display:flex;flex-direction:column;gap:2px;margin-top:-8px">
   {friend_row("lin","林舟","Kite","on","在线","可提议修改",sel=True)}
   {friend_row(None,"许安","Nyra","busy","忙碌 · 通话中","只读",ini="许")}
   {friend_row(None,"周屿","Atlas","off","离线 · 2 小时前","只读",ini="周")}
   {friend_row(None,"Ana Ruiz","Moss","off","离线 · 昨天","只读",ini="A")}
  </div>
 </div>
 <div class="card" style="flex:1;padding:18px;display:flex;flex-direction:column;min-width:0">
  <div style="display:flex;gap:12px">
   <div style="flex:1;border-radius:12px;background:var(--side);padding:14px;display:flex;gap:12px;align-items:center">{avatar("lin",52,False)}<div><div class="muted small">人</div><div style="font-size:16px;font-weight:600">林舟</div><div class="small" style="display:flex;align-items:center;gap:6px;margin-top:2px"><span class="dot on-dot"></span>在线</div></div></div>
   <div style="flex:1;border-radius:12px;background:var(--side);padding:14px;display:flex;gap:12px;align-items:center"><span class="agentbox" style="width:52px;height:52px;background:var(--bg)">{mark(34)}</span><div><div class="muted small">她的 agent</div><div style="font-size:16px;font-weight:600">Kite</div><div class="small muted" style="margin-top:2px">空闲 · 用林舟的 token</div></div></div>
  </div>
  <div style="display:flex;gap:8px;margin-top:14px"><span class="tbtn lg p">{ic("cam",15)}视频通话</span><span class="tbtn lg">{ic("phone",15)}语音</span><span class="tbtn lg">{ic("users",15)}邀请协作…</span><span style="flex:1"></span><span class="tbtn lg">{ic("more",15)}</span></div>
  <div style="margin-top:20px;display:flex;align-items:center"><b style="font-weight:600">Kite 在我这里的权限</b><span style="flex:1"></span><span class="tbtn">修改</span></div>
  <div class="muted small" style="margin:3px 0 6px">只管 agent；林舟本人能看到的，就是你在通话里共享给她的。</div>
  {perm_row("eye","看共享线程与计划","只限你拉进通话的线程","y")}
  {perm_row("doc","读取共享范围内的文件","app/ · 分支 fix/login-timeout","y")}
  {perm_row("pencil","提议修改你的文件","每一处修改都要你点“允许”","a")}
  {perm_row("term","在你的机器上运行命令","","n")}
  {perm_row("folder","访问共享范围外的项目与文件","","n")}
  <div style="margin-top:auto;padding-top:14px;border-top:1px solid var(--line)"><div class="muted small" style="margin-bottom:8px">最近一起做的</div>
   <div style="display:flex;align-items:center;gap:8px;padding:4px 0">{ic("cam",14)}<span>Fix login timeout</span><span class="muted small">· 32 分钟 · 2 处修改</span><span style="flex:1"></span><span class="muted small">昨天</span></div>
   <div style="display:flex;align-items:center;gap:8px;padding:4px 0">{ic("cam",14)}<span>Checkout 测试排查</span><span class="muted small">· 18 分钟 · 1 个待办</span><span style="flex:1"></span><span class="muted small">周一</span></div></div>
 </div>
</div>
<div class="status"><span>{ic("lock",12)}通话端到端加密</span><span>视频只走流量，不耗 token</span><span style="margin-left:auto"><span class="dot on-dot"></span>可接听</span></div>
</div></div>'''
    return body

def topbar_call(title="林舟", sub="app / Fix login timeout", t="12:48", rec=False, weak=False):
    recchip = (f'<span class="chip" style="background:rgba(217,45,32,.14);color:var(--rectx);font-weight:600">{ic("rec",12)}录制中 · 全员已同意</span>' if rec
               else f'<span class="chip o">{ic("rec",12)}<span style="color:var(--fg)">未录制</span></span>')
    sig = ic("signal1" if weak else "signal",14)
    sigtxt = "信号较弱" if weak else "信号良好"
    return f'''<div class="glass" style="position:absolute;left:12px;right:12px;top:10px;height:50px;border-radius:16px;display:flex;align-items:center;gap:10px;padding:0 10px 0 16px;z-index:5">
 <div class="lights"><i></i><i></i><i></i></div><span style="width:8px"></span>
 {avatar("lin",26,True)}<b style="font-weight:600">{title}</b><span class="muted">{sub}</span><span class="mono" style="font-size:12.5px;margin-left:4px">{t}</span>
 <span style="flex:1"></span>
 <span class="chip o">{ic("lock",12)}<span>端到端加密</span></span>{recchip}
 <span class="chip o" title="点进用量弹层看实时速率与已用流量">{sig}<span>{sigtxt}</span></span>
 <span class="chip" style="font-weight:500">视频走流量，不耗 token</span>
 <span class="tbtn" style="border-color:var(--g-border)">{ic("grid",14)}</span><span class="tbtn" style="border-color:var(--g-border)">{ic("panel",14)}</span></div>'''

def ctrlbar(mic=True, cam=True, agent_label="Nyra 在听", chat=2, x=None, voice_only=False):
    camb = f'<div class="cb {"on" if cam else "off"}">{ic("cam" if cam else "camoff")}摄像头</div>'
    return f'''<div class="cbar glass" style="position:absolute;bottom:22px;left:{x};transform:translateX(-50%);z-index:6">
 <div class="cb on">{ic("mic" if mic else "micoff")}静音</div>{camb}<div class="cb">{ic("screen")}共享屏幕</div>
 <div class="vsep"></div>
 <div class="cb wide">{mark(20)}<span style="text-align:left;line-height:1.2"><b style="font-weight:600;display:block">{agent_label}</b><span class="muted" style="font-size:11px">邀请 agent / 让它静音</span></span>{ic("chevd",14)}</div>
 <div class="vsep"></div>
 <div class="cb" style="position:relative">{ic("chat")}聊天<span class="bd">{chat}</span></div><div class="cb">{ic("more")}更多</div>
 <div class="cb hang">{ic("hang",22)}挂断</div></div>'''

def agent_tile(owner, name, state, w, h, log=None, orbsize=56):
    st, sub = STATE[state]
    stc = 'style="color:var(--warntx)"' if state=="wait" else ""
    sub_html = f'<div class="sub mono">{sub}</div>' if sub and state in ("edit","wait") else (f'<div class="sub">{sub}</div>' if sub else "")
    caret = '<span class="caret"></span>' if state=="edit" else ""
    lg = f'<div class="log">{log}</div>' if log else ""
    return f'''<div class="agt" style="width:{w}px;height:{h}px">
 <div class="who">{mark(14)}<span>{name}</span><span class="muted" style="font-weight:400">· {owner}的 agent</span></div>
 <div style="display:flex;align-items:center;gap:34px;margin-top:22px;width:100%;padding:0 48px">
 {orb(state, orbsize)}
 <div style="flex:1;min-width:0"><div class="st" {stc}>{st}{caret}</div>{sub_html}{lg}</div></div></div>'''

def person_tile(who, w, h, label, mic=True, speaking=False, cam=True):
    p = PEOPLE[who]
    if cam:
        bg = f"background-image:url({p['img']});"
        inner = ""
    else:
        bg = "background:var(--panel);box-shadow:inset 0 0 0 1px var(--line2);"
        inner = f'<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px">{avatar(who,88,False)}<div style="display:flex;align-items:center;gap:6px;color:var(--mu);font-size:12.5px">{ic("wave",16)}仅语音</div></div>'
    nm_cls = "gmedia s" if cam else "glass"
    return f'''<div class="tile{' speaking' if speaking else ''}" style="width:{w}px;height:{h}px;{bg}">{inner}
 <div class="nm {nm_cls}">{label}</div>
 <div class="mi {nm_cls}">{ic("mic" if mic else "micoff",15)}</div></div>'''

def collab_panel(approval=True, extra_top=""):
    who_row = lambda icon, name, what, st: f'<div style="display:flex;align-items:center;gap:9px;padding:7px 0">{icon}<div style="flex:1;min-width:0"><div><b style="font-weight:600">{name}</b> <span class="muted">{what}</span></div></div>{st}</div>'
    appr = f'''<div class="appr gstrong" style="margin-top:12px">
  <div class="fr">{ic("pencil",16)}<div class="ttl"><div class="a">Kite 想修改你的 <span class="mono" style="font-size:12.5px">auth/client.py</span> <span class="add">+6</span> <span class="del">−2</span></div>
   <div class="s">林舟的 agent · 改你的文件要你批准 · 用林舟的 token</div></div></div>
  <div class="code" style="margin:0 12px 10px;border-radius:8px;overflow:hidden;box-shadow:inset 0 0 0 1px var(--line2);background:var(--bg)">
   <div class="ln d"><span class="n">42</span>-   resp = http.post(url, data=payload)</div>
   <div class="ln a"><span class="n">42</span>+   for attempt in range(2):</div>
   <div class="ln a"><span class="n">43</span>+       resp = http.post(url, timeout=10)</div>
   <div class="ln a"><span class="n">44</span>+       if resp.ok: break</div></div>
  <div class="acts"><span class="muted small" style="margin-right:auto;align-self:center">查看完整 diff</span><span class="tbtn">拒绝</span><span class="tbtn">总是允许</span><span class="tbtn p">允许一次</span></div></div>''' if approval else ""
    return f'''<div class="glass" style="position:absolute;right:12px;top:70px;bottom:12px;width:432px;border-radius:16px;display:flex;flex-direction:column;overflow:hidden;z-index:4">
 <div style="padding:14px 16px 0"><div style="display:flex;align-items:center;gap:8px"><b style="font-weight:600;font-size:14.5px">共享协作</b><span class="muted small">app · fix/login-timeout</span><span style="flex:1"></span>{avatar("me",22,False)}{avatar("lin",22,False)}<span class="agentbox" style="width:22px;height:22px">{mark(14)}</span><span class="agentbox" style="width:22px;height:22px">{mark(14)}</span></div>
 <div style="display:flex;gap:4px;margin-top:10px;padding-bottom:10px;border-bottom:1px solid var(--g-border)"><span class="tbtn" style="background:var(--chip);border-color:transparent">线程</span><span class="tbtn" style="border-color:transparent">计划 3/5</span><span class="tbtn" style="border-color:transparent">Diff 2</span><span class="tbtn" style="border-color:transparent">成员 4</span></div></div>
 <div style="padding:12px 16px;flex:1;min-height:0;display:flex;flex-direction:column">
  {extra_top}
  <div class="muted small">谁在改什么</div>
  {who_row('<span class="agentbox" style="width:26px;height:26px">'+mark(16)+'</span>','Kite','编辑 <span class="mono" style="font-size:12px;color:var(--fg)">auth/client.py</span>','<span class="chip warn">等你批准</span>')}
  {who_row('<span class="agentbox" style="width:26px;height:26px">'+mark(16)+'</span>','Nyra','写好 <span class="mono" style="font-size:12px;color:var(--fg)">tests/test_auth.py</span> <span class="add">+24</span>','<span class="chip" style="color:var(--add)">'+ic("check",12)+'已完成</span>')}
  {who_row(avatar("lin",26,False),'林舟','在计划第 3 步留了评论','<span class="muted small">1 分钟前</span>')}
  {appr}
  <div style="margin-top:14px;display:flex;flex-direction:column;gap:10px">
   <div style="display:flex;gap:8px">{avatar("lin",22,False)}<div style="background:var(--chip);border-radius:12px;padding:7px 11px;max-width:330px">超时改成从设置里读？我那边的网更慢。</div></div>
   <div style="display:flex;gap:8px">{'<span class="agentbox" style="width:22px;height:22px">'+mark(14)+'</span>'}<div style="line-height:1.5"><b style="font-weight:600">Nyra</b> <span class="muted small">· 我的</span><div>好，我先补一条“套接字卡住”的回归测试，Kite 改实现。</div></div></div>
  </div>
  <div style="flex:1"></div>
  <div style="margin-top:10px;height:40px;border-radius:12px;box-shadow:inset 0 0 0 1px var(--g-border);display:flex;align-items:center;padding:0 6px 0 12px;color:var(--mu)">在共享线程里说点什么，@Kite @Nyra<span style="flex:1"></span><span style="width:28px;height:28px;border-radius:50%;background:var(--btn);color:var(--btnfg);display:flex;align-items:center;justify-content:center">↑</span></div>
 </div></div>'''

STAGE_W = 1440-432-24  # 984
def call_stage(people_cam=True, weak=False, agents=("listen","edit")):
    # 左侧舞台：按主人成对排列——左列 我 + Nyra，右列 林舟 + Kite
    gx = 16; gap = 12
    w = (STAGE_W - gx*2 - gap)//2  # 470
    ph = 560; ah = 208
    top = 72
    me_lab = f'{avatar("me",18,False)}我'
    lin_lab = f'{avatar("lin",18,False)}林舟'
    aN, aK = agents
    logN = "✓ tests/test_auth.py +24<br>· 等 Kite 的实现再跑一次" if aN=="listen" else None
    logK = "· 读取 auth/client.py<br>· 改 login()：超时 10 s + 重试 1 次" if aK in ("edit","wait") else None
    return f'''<div style="position:absolute;left:{gx}px;top:{top}px;display:grid;grid-template-columns:{w}px {w}px;gap:{gap}px">
 {agent_tile("我","Nyra",aN,w,ah,logN)}
 {agent_tile("林舟","Kite",aK,w,ah,logK)}
 {person_tile("me",w,ph,me_lab,True,False,people_cam)}
 {person_tile("lin",w,ph,lin_lab,True,True,people_cam)}
</div>'''

def d_incall(mode, approval=True):
    bg = "var(--side)"
    return f'''<div class="win" style="background:{bg}">
 {call_stage()}
 {topbar_call()}
 {collab_panel(approval)}
 {ctrlbar(x=f"{STAGE_W//2}px")}
</div>'''

def d_incoming(mode):
    # 主界面在后面（好友页），上面一层压暗 + 玻璃来电卡
    return f'''<div class="win">{side()}
<div class="main" style="filter:blur(2px)"><div class="top"><b>Fix login timeout</b><span class="crumb">app</span></div>
<div style="padding:30px 0;width:640px;margin:0 auto;display:flex;flex-direction:column;gap:16px;color:var(--fg)">
 <div style="align-self:flex-end;background:var(--chip);padding:10px 14px;border-radius:16px;max-width:480px">Login hangs for 30s on slow networks. Find the cause and fix it.</div>
 <div class="muted">▾ 已执行 48 秒 · 4 步</div><div style="line-height:1.65">The login call in auth/client.py had no timeout, so a stalled socket blocked the UI thread…</div></div></div>
<div class="dim"></div>
<div class="gstrong" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:520px;border-radius:24px;padding:28px 28px 24px;z-index:5">
 <div style="display:flex;align-items:center;gap:8px" class="muted small">{ic("lock",13)}端到端加密 · 视频走流量，不耗 token<span style="flex:1"></span><span class="mono">来电</span></div>
 <div style="display:flex;flex-direction:column;align-items:center;margin-top:44px">
  <div style="position:relative;display:flex;align-items:center;justify-content:center">
   <span style="position:absolute;width:132px;height:132px;border-radius:50%;box-shadow:0 0 0 1.5px var(--fg);opacity:.12"></span>
   <span style="position:absolute;width:160px;height:160px;border-radius:50%;box-shadow:0 0 0 1.5px var(--fg);opacity:.06"></span>
   {avatar("lin",104,False)}
   <span class="agentbox" style="position:absolute;right:-14px;bottom:-6px;width:44px;height:44px;background:var(--bg);box-shadow:0 0 0 3px var(--bg)">{mark(30)}</span></div>
  <div style="font-size:22px;font-weight:600;margin-top:26px">林舟 邀请你视频通话</div>
  <div class="muted" style="margin-top:6px;display:flex;align-items:center;gap:6px">她的 agent {mark(13)}<b style="color:var(--fg);font-weight:600">Kite</b> 也会加入 · 协作：app / Fix login timeout</div>
 </div>
 <div style="display:flex;gap:14px;margin-top:22px;align-items:stretch">
  <div class="tile" style="width:170px;height:112px;background-image:url({PEOPLE['me']['img']})"><div class="nm gmedia" style="height:24px;font-size:11.5px">我的预览</div></div>
  <div style="flex:1;display:flex;flex-direction:column;gap:8px">
   <div class="muted small">怎么加入</div>
   <div class="seg"><span class="on">{ic("cam",14)}带摄像头</span><span>{ic("mic",14)}仅语音</span></div>
   <div style="display:flex;align-items:center;gap:8px;font-size:12.5px"><span class="tg"></span>我的 Nyra 一起加入<span class="muted small">（可随时静音）</span></div></div></div>
 <div style="display:flex;gap:10px;margin-top:22px">
  <span class="tbtn lg" style="flex:1;justify-content:center;height:44px;border-radius:12px;background:var(--danger);border-color:var(--danger);color:#fff;font-weight:600">{ic("hang",18)}拒绝</span>
  <span class="tbtn lg" style="flex:1;justify-content:center;height:44px;border-radius:12px;font-weight:600">{ic("chat",16)}回条消息</span>
  <span class="tbtn lg p" style="flex:1.3;justify-content:center;height:44px;border-radius:12px;font-weight:600;background:#1F883D;border-color:#1F883D;color:#fff">{ic("cam",16)}接听</span></div>
 <div class="muted small" style="text-align:center;margin-top:12px"><span class="kbd">Enter</span> 接听 · <span class="kbd">Esc</span> 拒绝 · 30 秒无应答记为未接</div>
</div></div>'''

def d_permissions(mode):
    opt = lambda on, t, s, rec="": f'''<div style="display:flex;gap:12px;padding:12px;border-radius:12px;{'box-shadow:inset 0 0 0 1.5px var(--fg);background:var(--chip)' if on else 'box-shadow:inset 0 0 0 1px var(--line2)'}"><span class="rd{' on' if on else ''}"></span><div style="flex:1"><div style="font-weight:600">{t}{rec}</div><div class="muted small" style="margin-top:2px">{s}</div></div></div>'''
    tgr = lambda t, s, on, lock=False: f'<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)"><div style="flex:1"><div>{t}</div><div class="muted small">{s}</div></div><span class="tg{"" if on else " off"}{" lock" if lock else ""}"></span></div>'
    return f'''<div class="win" style="background:var(--side)">
 <div style="filter:blur(3px)">{call_stage()}{collab_panel(False)}{ctrlbar(x=f"{STAGE_W//2}px")}</div>
 {topbar_call()}
 <div class="dim" style="top:70px;z-index:6"></div>
 <div class="gstrong" style="position:absolute;left:50%;top:92px;transform:translateX(-50%);width:600px;border-radius:22px;padding:24px;z-index:7">
  <div style="display:flex;align-items:center;gap:12px"><span class="agentbox" style="width:44px;height:44px">{mark(28)}</span><div><div style="font-size:18px;font-weight:600">第一次和 Kite 协作</div><div class="muted small" style="margin-top:2px">林舟的 agent 在这次协作里能看到、能做什么？只问这一次，之后可在好友页改。</div></div></div>
  <div style="margin-top:16px;display:flex;align-items:center;gap:8px;font-size:12.5px"><span class="muted">共享范围</span><span class="chip">{ic("folder",12)}app/</span><span class="chip">分支 fix/login-timeout</span><span class="chip">线程 Fix login timeout</span><span class="muted" style="margin-left:auto"><u>改范围</u></span></div>
  <div style="display:flex;flex-direction:column;gap:8px;margin-top:14px">
   {opt(False,"只读","看共享线程、计划和共享范围内的文件，不能提修改")}
   {opt(True,"可提议修改，每次要我批准","Kite 的每处改动都会弹出审批卡：拒绝 / 总是允许 / 允许一次"," <span class='chip o' style='margin-left:6px;height:20px;font-size:11px;font-weight:500'>推荐</span>")}
   {opt(False,"可直接改共享分支","只在 fix/login-timeout 上，不经审批；可随时 /undo 回到检查点")}</div>
  <div style="margin-top:12px">
   {tgr("在我的机器上运行命令","测试、构建、脚本——默认不允许；开启后每条命令也要你批准",False)}
   {tgr("读取共享范围外的文件与项目","始终不允许",False,True)}
   {tgr("看到我的屏幕共享","只在你主动共享屏幕时",True)}</div>
  <div class="muted small" style="margin-top:12px;padding:9px 11px;border-radius:10px;background:var(--chip)">{ic("info",12)} 你的 Nyra 在林舟那边能做什么，由林舟决定。Kite 的工作用林舟自己的 token，不花你的。</div>
  <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end"><span class="tbtn lg">先不协作，只通话</span><span class="tbtn lg p">开始协作</span></div>
 </div>
</div>'''

def d_recording(mode):
    return f'''<div class="win" style="background:var(--side)">
 {call_stage()}
 {topbar_call()}
 {collab_panel(False)}
 {ctrlbar(x=f"{STAGE_W//2}px")}
 <div class="dim" style="top:70px;z-index:6"></div>
 <div class="gstrong" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:500px;border-radius:22px;padding:24px;z-index:7">
  <div style="display:flex;align-items:center;gap:12px"><span style="width:44px;height:44px;border-radius:50%;background:rgba(217,45,32,.12);color:var(--danger);display:flex;align-items:center;justify-content:center">{ic("rec",22)}</span>
   <div><div style="font-size:18px;font-weight:600">林舟想录制这次通话</div><div class="muted small" style="margin-top:2px">要每个人都同意才会开始录。你不同意，就不会录。</div></div></div>
  <div style="margin-top:16px;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line2);padding:4px 14px">
   <div style="display:flex;gap:10px;padding:10px 0">{ic("cam",15)}<div style="flex:1">会录：所有人的画面与声音、屏幕共享</div></div>
   <div style="display:flex;gap:10px;padding:10px 0;border-top:1px solid var(--line)">{ic("doc",15)}<div style="flex:1">会录：共享线程里的消息和改动记录</div></div>
   <div style="display:flex;gap:10px;padding:10px 0;border-top:1px solid var(--line)">{ic("folder",15)}<div style="flex:1">录像保存在发起录制的一方（林舟）<div class="muted small">存储方式由实现决定，这里只写给谁</div></div></div></div>
  <div class="muted small" style="margin-top:12px">录制开始后，顶栏会一直显示红色“录制中”；任何人都可以随时停止自己的那一路。</div>
  <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end"><span class="tbtn lg">不同意</span><span class="tbtn lg p">同意录制</span></div>
 </div>
</div>'''

def d_weak(mode):
    return f'''<div class="win" style="background:var(--side)">
 {call_stage(people_cam=False, agents=("listen","think"))}
 {topbar_call(weak=True, rec=True)}
 {collab_panel(False)}
 <div class="gstrong" style="position:absolute;left:{STAGE_W//2}px;transform:translateX(-50%);top:340px;width:620px;border-radius:14px;padding:10px 10px 10px 14px;display:flex;align-items:center;gap:10px;z-index:6">
  <span style="color:var(--warn);display:flex">{ic("signal1",18)}</span><div style="flex:1"><div style="font-weight:600">网络较弱，已自动切到仅语音</div><div class="muted small">网好了视频会自己回来 · 协作和 agent 不受影响</div></div><span class="tbtn">仍要开视频</span><span class="tbtn" style="border-color:transparent">{ic("x",14)}</span></div>
 {ctrlbar(cam=False, x=f"{STAGE_W//2}px")}
</div>'''

def d_summary(mode):
    row = lambda icn, t, s, r="": f'<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)">{icn}<div style="flex:1;min-width:0"><div>{t}</div><div class="muted small">{s}</div></div>{r}</div>'
    stat = lambda k, v, s="": f'<div style="flex:1;padding:12px 14px;border-radius:12px;background:var(--chip)"><div class="muted small">{k}</div><div style="font-size:20px;font-weight:600;margin-top:2px" class="mono">{v}</div><div class="muted" style="font-size:11.5px;margin-top:2px">{s}</div></div>'
    return f'''<div class="win" style="background:var(--side)">
 <div style="filter:blur(6px);opacity:.75">{call_stage(agents=("listen","listen"))}</div>
 <div class="glass" style="position:absolute;left:12px;right:12px;top:10px;height:50px;border-radius:16px;display:flex;align-items:center;gap:10px;padding:0 16px;z-index:5"><div class="lights"><i></i><i></i><i></i></div><span style="width:8px"></span><b style="font-weight:600">通话已结束</b><span class="muted">林舟 · app / Fix login timeout</span></div>
 <div class="gstrong" style="position:absolute;left:50%;top:84px;transform:translateX(-50%);width:640px;border-radius:22px;padding:24px;z-index:6">
  <div style="display:flex;align-items:center;gap:12px">{avatar("me",36,True)}{avatar("lin",36,True)}<div style="margin-left:6px"><div style="font-size:18px;font-weight:600">和林舟的通话已结束</div><div class="muted small">今天 14:02 – 14:34 · 未录制 · 端到端加密</div></div></div>
  <div style="display:flex;gap:10px;margin-top:16px">
   {stat("时长","32:14")}{stat("流量","412 MB","↑138 · ↓274 MB · 不耗 token")}{stat("Agent token","11.7k","我的 4.1k · 林舟的 7.6k")}</div>
  <div style="margin-top:18px;font-weight:600">一起完成的</div>
  {row('<span class="agentbox" style="width:26px;height:26px">'+mark(16)+'</span>','Kite 修改了 <span class="mono" style="font-size:12.5px">auth/client.py</span> <span class="add">+6</span> <span class="del">−2</span>','你在 14:21 允许一次 · 检查点 4','<span class="tbtn">查看 diff</span>')}
  {row('<span class="agentbox" style="width:26px;height:26px">'+mark(16)+'</span>','Nyra 新增 <span class="mono" style="font-size:12.5px">tests/test_auth.py</span> <span class="add">+24</span>','测试 3/3 通过','<span class="tbtn">查看 diff</span>')}
  {row(ic("x",16),'Kite 想运行 <span class="mono" style="font-size:12.5px">pip install httpx</span>','你拒绝了 · 附言“先别加依赖”','')}
  <div style="margin-top:14px;font-weight:600">待办</div>
  {row('<span class="rd"></span>','让超时可在设置里配置','林舟 · 来自共享线程','<span class="chip o">林舟</span>')}
  {row('<span class="rd"></span>','周五前合并 fix/login-timeout','我 · 来自计划第 5 步','<span class="chip o">我</span>')}
  <div style="display:flex;gap:8px;margin-top:18px"><span class="tbtn lg">关闭</span><span style="flex:1"></span><span class="tbtn lg">{ic("cam",15)}再打一次</span><span class="tbtn lg p">存为线程并加入待办</span></div>
 </div>
</div>'''

# ------------------------------------------------------------------ 手机 ---
def sb(light_text=False, android=False):
    col = "color:#F5F5F7;" if light_text else ""
    if android:
        return f'<div class="pcam"></div><div class="sb" style="{col}"><span>9:41</span><span style="display:flex;gap:6px;align-items:center">{ic("signal",14)} ▮</span></div>'
    return f'<div class="isl"></div><div class="sb" style="{col}"><span>9:41</span><span style="display:flex;gap:6px;align-items:center">{ic("signal",15)} ▭</span></div>'

def phone(inner, android=False, light_text=False, hb=True):
    cls = "ph and" if android else "ph"
    h = '<div class="hb" style="background:#F5F5F7"></div>' if (hb and light_text) else ('<div class="hb"></div>' if hb else "")
    top = '<div style="position:absolute;left:0;right:0;top:0;height:96px;background:linear-gradient(180deg,rgba(0,0,0,.5),rgba(0,0,0,0));z-index:8;pointer-events:none"></div>' if light_text else ""
    return f'<div class="{cls}"><div class="sc">{top}{sb(light_text, android)}{inner}{h}</div></div>'

def m_tabbar(active="好友"):
    tabs = [("list","线程"),("users","好友"),("clock","自动化"),("gear","设置")]
    h = '<div class="glass nav" style="position:absolute;left:0;right:0;bottom:0;z-index:8">'
    for icn,l in tabs:
        h += f'<div class="{"on" if l==active else ""}">{ic(icn,22)}{l}</div>'
    return h + "</div>"

def m_friend(who, name, agent, status, stxt, ini=None):
    off = status == "off"
    return f'''<div class="it">{avatar(who,46,True,None,ini)}<div style="flex:1;min-width:0"><b>{name} <span class="dot {status}-dot" style="margin-left:4px;vertical-align:2px"></span></b><small style="display:flex;align-items:center;gap:5px">{mark(12)}<span style="color:var(--fg)">{agent}</span> · {stxt}</small></div>
 <span class="ib" style="{'opacity:.4' if off else ''}">{ic("cam",17)}</span><span class="ib" style="{'opacity:.4' if off else ''}">{ic("users",17)}</span></div>'''

def m_friends(mode):
    return f'''<div class="hd"><span style="flex:1"></span><span class="ib">{ic("qr",17)}</span><span class="ib" style="background:var(--btn);color:var(--btnfg)">{ic("userplus",17)}</span></div>
 <div class="lt">好友</div>
 <div style="margin:0 16px;padding:12px;border-radius:16px;background:var(--chip);display:flex;gap:12px;align-items:center">
  <div style="width:66px;height:66px;padding:5px;border-radius:10px;background:#fff;color:#0B0B0C;flex:none">{qr_svg()}</div>
  <div style="flex:1;min-width:0"><div class="muted" style="font-size:12.5px">我的好友码</div><div class="mono" style="font-size:19px;font-weight:700;letter-spacing:.03em">NYR-7K4Q-2M</div><div class="muted" style="font-size:12px">24 小时后失效</div></div>
  <span class="ib" style="background:var(--bg)">{ic("copy",17)}</span></div>
 <div class="lh">好友请求</div>
 <div style="margin:0 16px;padding:12px;border-radius:16px;box-shadow:inset 0 0 0 1px var(--line2)">
  <div style="display:flex;gap:12px;align-items:center">{avatar("mark",42,True)}<div style="flex:1;min-width:0"><b style="font-weight:600">Mark Chen</b><div class="muted" style="font-size:12.5px;display:flex;align-items:center;gap:4px">连同 agent {mark(11)}<span style="color:var(--fg)">Pilot</span> 想加你</div></div></div>
  <div style="display:flex;gap:8px;margin-top:10px"><span class="bt sm" style="flex:1">拒绝</span><span class="bt sm p" style="flex:1">接受</span></div>
  <div class="muted" style="font-size:12px;margin-top:8px">接受后 Pilot 默认只读，第一次协作前再确认。</div></div>
 <div class="lh">好友 · 人 + 他的 agent</div>
 {m_friend("lin","林舟","Kite","on","在线 · 可提议修改")}
 {m_friend(None,"许安","Nyra","busy","忙碌 · 通话中",ini="许")}
 {m_friend(None,"周屿","Atlas","off","离线 · 2 小时前",ini="周")}
 {m_tabbar()}'''

def m_friend_detail(mode):
    pr = lambda t, ok: f'<div style="display:flex;align-items:center;gap:10px;padding:11px 0;border-top:1px solid var(--line)"><span style="flex:1">{t}</span>{ok}</div>'
    Y = '<span class="chip" style="color:var(--add)">'+ic("check",12)+'允许</span>'
    W = '<span class="chip warn">'+ic("shield",12)+'需批准</span>'
    N = '<span class="chip o muted">'+ic("x",12)+'不允许</span>'
    return f'''<div class="hd"><span class="ib">{ic("back",17)}</span><span style="flex:1"></span><span class="ib">{ic("more",17)}</span></div>
 <div style="display:flex;flex-direction:column;align-items:center;padding:6px 0 0">{avatar("lin",84,False)}<div style="font-size:22px;font-weight:700;margin-top:10px">林舟</div><div class="muted" style="font-size:13px;display:flex;align-items:center;gap:6px"><span class="dot on-dot"></span>在线</div></div>
 <div style="display:flex;gap:8px;padding:14px 16px 0"><span class="bt p">{ic("cam",17)}视频</span><span class="bt">{ic("phone",17)}语音</span><span class="bt">{ic("users",17)}协作</span></div>
 <div style="margin:16px 16px 0;padding:12px 14px;border-radius:16px;background:var(--chip);display:flex;align-items:center;gap:12px"><span class="agentbox" style="width:42px;height:42px;background:var(--bg)">{mark(28)}</span><div style="flex:1"><div class="muted" style="font-size:12px">她的 agent</div><b style="font-weight:600">Kite</b><div class="muted" style="font-size:12px">空闲 · 用林舟自己的 token</div></div></div>
 <div style="padding:14px 20px 0"><div style="display:flex;align-items:center"><b style="font-weight:600">Kite 在我这里的权限</b><span style="flex:1"></span><span class="muted" style="font-size:13px">修改</span></div>
  <div style="margin-top:8px">{pr("看共享线程与计划",Y)}{pr("读共享范围内的文件",Y)}{pr("提议修改我的文件",W)}{pr("在我的手机/电脑上运行命令",N)}{pr("访问共享范围外的内容",N)}</div></div>'''

def m_qr(mode):
    return f'''<div class="hd"><span style="flex:1"></span></div><div class="lt">好友</div>
 <div style="padding:0 20px;opacity:.5">{m_friend("lin","林舟","Kite","on","在线")}</div>
 <div class="dim"></div>
 <div class="sheet gstrong" style="z-index:9">
  <div class="grab"></div>
  <div style="font-size:20px;font-weight:700">加好友</div><div class="muted" style="font-size:13.5px;margin-top:2px">加的是“一个人 + 他的 agent”。对方扫码或输入好友码。</div>
  <div class="seg" style="margin-top:14px"><span class="on">我的码</span><span>扫一扫</span><span>输入码</span></div>
  <div style="display:flex;justify-content:center;margin-top:18px"><div style="width:200px;height:200px;padding:12px;border-radius:18px;background:#fff;color:#0B0B0C;box-shadow:0 0 0 1px rgba(0,0,0,.06)">{qr_svg()}</div></div>
  <div style="text-align:center;margin-top:14px"><div class="mono" style="font-size:24px;font-weight:700;letter-spacing:.04em">NYR-7K4Q-2M</div><div class="muted" style="font-size:13px;margin-top:2px;display:flex;justify-content:center;align-items:center;gap:6px">Sheng · agent {mark(12)}<span style="color:var(--fg)">Nyra</span> · 24 小时后失效</div></div>
  <div style="display:flex;gap:8px;margin-top:16px"><span class="bt">{ic("copy",17)}复制</span><span class="bt">{ic("share",17)}分享</span><span class="bt">{ic("refresh",17)}换一个</span></div>
 </div>'''

def m_incoming(mode, outgoing=False, offline=False):
    p = PEOPLE["lin"]
    if offline:
        title = "林舟现在不在线"; sub = "上次在线 2 小时前 · Kite 也不在线"
    elif outgoing:
        title = "正在呼叫 林舟…"; sub = "Kite 也会收到邀请 · 响铃 12 秒"
    else:
        title = "林舟"; sub = "邀请你视频通话"
    vid = f'<div class="vid" style="background-image:url({PEOPLE["me"]["img"] if outgoing or offline else p["img"]});filter:blur({18 if not outgoing else 0}px) brightness(.8);transform:scale(1.15)"></div>' if not offline else '<div class="vid" style="background:#0E0E10"></div>'
    if outgoing:
        vid = f'<div class="vid" style="background-image:url({PEOPLE["me"]["img"]});background-position:52% 50%"></div>'
    top = f'''<div style="position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;margin-top:{40 if not outgoing else 30}px;color:#F5F5F7">
 <div style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:#EDEDF0">{ic("lock",13)}端到端加密 · 视频走流量，不耗 token</div>
 <div style="position:relative;margin-top:30px">{avatar("lin",96,False)}<span class="agentbox" style="position:absolute;right:-10px;bottom:-4px;width:40px;height:40px;background:#F5F5F7;color:#0B0B0C;box-shadow:0 0 0 3px rgba(0,0,0,.4)">{mark(27)}</span></div>
 <div style="font-size:28px;font-weight:700;margin-top:18px">{title}</div><div style="font-size:15px;color:#D0D0D5;margin-top:4px">{sub}</div>
 {'' if (outgoing or offline) else '<div style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:13.5px;color:#D0D0D5">她的 agent '+mark(13)+'<b style="color:#F5F5F7;font-weight:600">Kite</b> 也会加入</div><div style="margin-top:8px;font-size:13px;color:#D0D0D5">协作：app / Fix login timeout</div>'}
</div>'''
    if offline:
        bottom = f'''<div class="gmedia s" style="position:absolute;left:12px;right:12px;bottom:28px;border-radius:28px;padding:16px;z-index:3">
 <div style="font-weight:600">留个话，她上线时会收到</div>
 <div style="margin-top:10px;height:44px;border-radius:22px;background:rgba(255,255,255,.12);display:flex;align-items:center;padding:0 6px 0 16px;color:#C9C9CE">想和你一起看下登录超时…<span style="flex:1"></span><span style="width:32px;height:32px;border-radius:50%;background:#F5F5F7;color:#0B0B0C;display:flex;align-items:center;justify-content:center">↑</span></div>
 <div style="display:flex;gap:8px;margin-top:10px"><span class="bt" style="background:rgba(255,255,255,.14);color:#F5F5F7">{ic("clock",16)}她上线时提醒我</span><span class="bt" style="background:rgba(255,255,255,.14);color:#F5F5F7">关闭</span></div>
 <div style="font-size:12px;color:#C9C9CE;margin-top:10px;text-align:center">Kite 离线时也不能代她接听或协作</div></div>'''
    elif outgoing:
        bottom = f'''<div class="gmedia" style="position:absolute;left:12px;right:12px;bottom:28px;border-radius:30px;padding:12px;z-index:3;display:flex;justify-content:space-around">
 <div class="cb on" style="width:60px;height:60px;border-radius:30px;background:rgba(255,255,255,.14)">{ic("mic",22)}</div>
 <div class="cb on" style="width:60px;height:60px;border-radius:30px;background:rgba(255,255,255,.14)">{ic("cam",22)}</div>
 <div class="cb on" style="width:60px;height:60px;border-radius:30px;background:rgba(255,255,255,.14)">{ic("flip",22)}</div>
 <div class="cb hang" style="width:60px;height:60px;border-radius:30px">{ic("hang",26)}</div></div>'''
    else:
        bottom = f'''<div class="gmedia s" style="position:absolute;left:12px;right:12px;bottom:28px;border-radius:30px;padding:16px;z-index:3">
 <div style="display:flex;gap:4px;padding:3px;border-radius:12px;background:rgba(255,255,255,.10)"><span style="flex:1;height:34px;border-radius:9px;background:rgba(255,255,255,.92);color:#0B0B0C;display:flex;align-items:center;justify-content:center;gap:6px;font-weight:600;font-size:14px">{ic("cam",15)}带摄像头</span><span style="flex:1;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;gap:6px;font-size:14px;color:#E5E5EA">{ic("mic",15)}仅语音</span></div>
 <div style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13.5px"><span class="tg" style="background:#F5F5F7;--btnfg:#0B0B0C"></span>我的 Nyra 一起加入</div>
 <div style="display:flex;justify-content:space-between;margin-top:18px;padding:0 18px">
  <div style="display:flex;flex-direction:column;align-items:center;gap:6px;font-size:13px"><span style="width:68px;height:68px;border-radius:34px;background:var(--danger);display:flex;align-items:center;justify-content:center;color:#fff">{ic("hang",30)}</span>拒绝</div>
  <div style="display:flex;flex-direction:column;align-items:center;gap:6px;font-size:13px"><span style="width:68px;height:68px;border-radius:34px;background:rgba(255,255,255,.16);display:flex;align-items:center;justify-content:center">{ic("chat",26)}</span>回消息</div>
  <div style="display:flex;flex-direction:column;align-items:center;gap:6px;font-size:13px"><span style="width:68px;height:68px;border-radius:34px;background:#1F883D;display:flex;align-items:center;justify-content:center;color:#fff">{ic("cam",28)}</span>接听</div></div></div>'''
    scrim = '<div class="vscrim" style="background:rgba(0,0,0,.5)"></div>' if not offline else ""
    pipself = ""
    if outgoing:
        scrim = '<div class="vscrim" style="background:linear-gradient(180deg,rgba(0,0,0,.72),rgba(0,0,0,.55) 45%,rgba(0,0,0,.1) 70%,rgba(0,0,0,.5))"></div>'
    return f'{vid}{scrim}{top}{bottom}'

def m_ctrl(cam=True, bottom=28):
    btn = lambda icn, on=True, extra="": f'<span style="width:50px;height:50px;border-radius:25px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.14);{extra}">{icn}</span>'
    return f'''<div class="gmedia" style="position:absolute;left:12px;right:12px;bottom:{bottom}px;border-radius:32px;padding:9px;display:flex;justify-content:space-between;z-index:5">
 {btn(ic("mic",21))}{btn(ic("cam" if cam else "camoff",21), extra="" if cam else "background:#F5F5F7;color:#0B0B0C;")}{btn(ic("screen",21))}{btn(mark(22))}{btn(ic("chat",21))}<span style="width:62px;height:50px;border-radius:25px;display:flex;align-items:center;justify-content:center;background:var(--danger);color:#fff">{ic("hang",24)}</span></div>'''

def m_topbar(weak=False, rec=False):
    rect = '<span style="color:#FF9A92;font-weight:600">● 录制中</span>' if rec else '未录制'
    sigtxt = "信号较弱" if weak else "信号良好"
    return f'''<div class="gmedia" style="position:absolute;left:12px;right:12px;top:54px;height:54px;border-radius:20px;display:flex;align-items:center;gap:8px;padding:0 8px 0 6px;z-index:5">
 <span style="width:38px;height:38px;display:flex;align-items:center;justify-content:center">{ic("min",20)}</span>
 <div style="flex:1;min-width:0;line-height:1.25"><b style="font-weight:600;font-size:15px">林舟 <span class="mono" style="font-weight:400;font-size:13px;color:#E5E5EA">12:48</span></b><div style="font-size:11.5px;color:#E0E0E4;display:flex;align-items:center;gap:4px">{ic("lock",11)}端到端加密 · {rect}</div></div>
 <span title="点进用量弹层看实时速率与已用流量" style="height:30px;padding:0 10px;border-radius:15px;background:rgba(255,255,255,.12);display:flex;align-items:center;gap:5px;font-size:11.5px">{ic("signal1" if weak else "signal",13)}<span>{sigtxt}</span></span></div>'''

def m_agentchip(name, owner, state, txt, mono=False):
    o = orb(state, 22)
    t = f'<span class="mono" style="font-size:11.5px">{txt}</span>' if mono else txt
    wc = "color:#F2C46B" if state=="wait" else ""
    return f'<div class="gmedia s" style="border-radius:16px;padding:8px 12px 8px 10px;display:flex;align-items:center;gap:10px;flex:1;min-width:0"><span style="width:32px;height:32px;flex:none;display:flex;align-items:center;justify-content:center;--fg:#F5F5F7;color:#F5F5F7">{o}</span><div style="min-width:0;line-height:1.3"><div style="font-size:13px;font-weight:600">{name} <span style="font-weight:400;color:#E0E0E4;font-size:11.5px">· {owner}</span></div><div style="font-size:12px;{wc};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{t}</div></div></div>'

def m_incall(mode, android=False):
    return f'''<div class="vid" style="background-image:url({PEOPLE['lin']['img']});background-position:58% 50%"></div><div class="vscrim"></div>
 {m_topbar()}
 <div class="pip" style="right:16px;top:120px;width:104px;height:140px;background-image:url({PEOPLE['me']['img']});background-position:50% 40%;background-size:auto 100%"></div>
 <div style="position:absolute;left:12px;right:12px;bottom:{184 if not android else 170}px;display:flex;gap:8px;z-index:4">
  {m_agentchip("Kite","林舟的","edit","正在编辑 client.py")}{m_agentchip("Nyra","我的","listen","在听")}</div>
 <div class="gmedia" style="position:absolute;left:12px;right:12px;bottom:{110 if not android else 96}px;height:62px;border-radius:20px;display:flex;align-items:center;gap:10px;padding:0 14px;z-index:4">
  <span style="width:4px;height:30px;border-radius:2px;background:#F2C46B"></span><div style="flex:1;line-height:1.3"><div style="font-weight:600;font-size:14px">协作 · 1 个待你批准</div><div style="font-size:12px;color:#C9C9CE">上滑打开 · Kite 想改 auth/client.py</div></div>{ic("chevd",18)}</div>
 {m_ctrl(bottom=28 if not android else 20)}'''

def m_drawer(mode):
    return f'''<div class="vid" style="background-image:url({PEOPLE['lin']['img']});background-position:58% 50%;height:300px;bottom:auto"></div><div class="vscrim" style="height:300px;bottom:auto"></div>
 {m_topbar()}
 <div class="pip" style="right:16px;top:120px;width:72px;height:96px;background-image:url({PEOPLE['me']['img']});background-position:50% 40%;background-size:auto 100%"></div>
 <div class="sheet gstrong" style="height:610px;z-index:6;padding-bottom:20px">
  <div class="grab"></div>
  <div class="seg"><span>{ic("cam",14)}视频</span><span class="on">{ic("users",14)}协作 · 1</span></div>
  <div style="display:flex;align-items:center;gap:6px;margin-top:12px;font-size:13px" class="muted">app · fix/login-timeout<span style="flex:1"></span>线程 · 计划 · Diff</div>
  <div style="margin-top:6px">
   <div style="display:flex;align-items:center;gap:10px;padding:8px 0"><span class="agentbox" style="width:30px;height:30px">{mark(18)}</span><div style="flex:1;font-size:14px"><b style="font-weight:600">Kite</b> <span class="muted">编辑</span> <span class="mono" style="font-size:12.5px">auth/client.py</span></div><span class="chip warn">等你批准</span></div>
   <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line)"><span class="agentbox" style="width:30px;height:30px">{mark(18)}</span><div style="flex:1;font-size:14px"><b style="font-weight:600">Nyra</b> <span class="muted">写好</span> <span class="mono" style="font-size:12.5px">test_auth.py</span> <span class="add">+24</span></div><span class="chip" style="color:var(--add)">{ic("check",12)}完成</span></div></div>
  <div style="margin-top:8px;border-radius:18px;padding:14px;box-shadow:inset 0 0 0 1px var(--line2);background:var(--bg)">
   <div style="font-size:17px;font-weight:700">允许 Kite 改这个文件？</div>
   <div class="muted" style="font-size:13px;margin-top:2px">林舟的 agent · <span class="mono" style="font-size:12px">auth/client.py</span> <span class="add">+6</span> <span class="del">−2</span></div>
   <div class="code" style="margin-top:10px;border-radius:10px;overflow:hidden;box-shadow:inset 0 0 0 1px var(--line2)">
    <div class="ln d"><span class="n">42</span>- resp = http.post(url, data=p)</div>
    <div class="ln a"><span class="n">42</span>+ for attempt in range(2):</div>
    <div class="ln a"><span class="n">43</span>+     resp = http.post(url,</div>
    <div class="ln a"><span class="n">44</span>+         timeout=10)</div></div>
   <div style="display:flex;gap:8px;margin-top:12px"><span class="bt">拒绝</span><span class="bt">总是允许</span><span class="bt p">允许一次</span></div>
   <div class="muted" style="font-size:12px;text-align:center;margin-top:8px">先存检查点 · 可在电脑上 /undo</div></div>
  <div style="margin-top:10px;height:44px;border-radius:22px;box-shadow:inset 0 0 0 1px var(--line2);display:flex;align-items:center;padding:0 6px 0 16px;color:var(--mu);font-size:14px">在共享线程里说… @Kite @Nyra<span style="flex:1"></span><span style="width:32px;height:32px;border-radius:50%;background:var(--btn);color:var(--btnfg);display:flex;align-items:center;justify-content:center">↑</span></div>
 </div>'''

def m_permsheet(mode):
    opt = lambda on, t, s: f'<div style="display:flex;gap:12px;padding:12px;border-radius:14px;{"box-shadow:inset 0 0 0 1.5px var(--fg);background:var(--chip)" if on else "box-shadow:inset 0 0 0 1px var(--line2)"}"><span class="rd{" on" if on else ""}"></span><div style="flex:1"><div style="font-weight:600;font-size:14.5px">{t}</div><div class="muted" style="font-size:12.5px;margin-top:2px">{s}</div></div></div>'
    return f'''<div class="vid" style="background-image:url({PEOPLE['lin']['img']});background-position:58% 50%;filter:blur(2px)"></div><div class="vscrim"></div>
 {m_topbar()}
 <div class="sheet gstrong" style="z-index:6">
  <div class="grab"></div>
  <div style="display:flex;align-items:center;gap:10px"><span class="agentbox" style="width:40px;height:40px">{mark(26)}</span><div><div style="font-size:19px;font-weight:700">第一次和 Kite 协作</div><div class="muted" style="font-size:13px">林舟的 agent 能看到、能做什么？</div></div></div>
  <div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap"><span class="chip">{ic("folder",12)}app/</span><span class="chip">fix/login-timeout</span><span class="chip">本线程</span></div>
  <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
   {opt(False,"只读","看线程、计划和共享文件")}
   {opt(True,"可提议修改，每次要我批准","每处改动都会弹审批卡")}
   {opt(False,"可直接改共享分支","只在 fix/login-timeout，可 /undo")}</div>
  <div style="display:flex;align-items:center;gap:12px;padding:12px 2px 0"><div style="flex:1"><div style="font-size:14.5px">运行命令</div><div class="muted" style="font-size:12.5px">默认不允许</div></div><span class="tg off"></span></div>
  <div style="display:flex;align-items:center;gap:12px;padding:10px 2px 0"><div style="flex:1"><div style="font-size:14.5px">共享范围外的内容</div><div class="muted" style="font-size:12.5px">始终不允许</div></div><span class="tg off lock"></span></div>
  <div class="muted" style="font-size:12.5px;margin-top:12px">Kite 用林舟的 token，不花你的。</div>
  <div style="display:flex;gap:8px;margin-top:12px"><span class="bt">只通话</span><span class="bt p">开始协作</span></div>
 </div>'''

def m_recconsent(mode):
    return f'''<div class="vid" style="background-image:url({PEOPLE['lin']['img']});background-position:58% 50%"></div><div class="vscrim"></div>
 {m_topbar()}
 <div style="position:absolute;inset:0;background:rgba(0,0,0,.35);z-index:5"></div>
 <div class="sheet gstrong" style="z-index:6">
  <div class="grab"></div>
  <div style="display:flex;align-items:center;gap:12px"><span style="width:42px;height:42px;border-radius:50%;background:rgba(217,45,32,.12);color:var(--danger);display:flex;align-items:center;justify-content:center">{ic("rec",22)}</span><div><div style="font-size:19px;font-weight:700">林舟想录制这次通话</div><div class="muted" style="font-size:13px">每个人都同意才会开始</div></div></div>
  <div style="margin-top:14px;font-size:14px;display:flex;flex-direction:column;gap:9px">
   <div style="display:flex;gap:10px">{ic("cam",16)}<span>画面、声音、屏幕共享</span></div>
   <div style="display:flex;gap:10px">{ic("doc",16)}<span>共享线程的消息与改动记录</span></div>
   <div style="display:flex;gap:10px">{ic("folder",16)}<span>录像保存在林舟（发起方）那边</span></div></div>
  <div class="muted" style="font-size:12.5px;margin-top:12px">开始后顶栏一直显示红色“录制中”，任何人都能随时停止。</div>
  <div style="display:flex;gap:8px;margin-top:16px"><span class="bt">不同意</span><span class="bt p">同意录制</span></div>
 </div>'''

def m_weak(mode):
    return f'''<div class="vid" style="background:#121214"></div>
 {m_topbar(weak=True, rec=True)}
 <div class="gmedia s" style="position:absolute;left:12px;right:12px;top:118px;border-radius:18px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start;z-index:5">
  <span style="color:#F2C46B;display:flex;margin-top:1px">{ic("signal1",18)}</span><div style="flex:1;line-height:1.35"><div style="font-weight:600;font-size:14.5px">网络较弱，已切到仅语音</div><div style="font-size:12.5px;color:#C9C9CE">网好了视频会自己回来，协作不受影响</div></div><span style="font-size:13px;font-weight:600;margin-top:1px">开视频</span></div>
 <div style="position:absolute;left:0;right:0;top:250px;display:flex;flex-direction:column;align-items:center;color:#F5F5F7">
  <div style="position:relative">{avatar("lin",120,False)}<span style="position:absolute;inset:-14px;border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,.35)"></span></div>
  <div style="font-size:22px;font-weight:700;margin-top:24px">林舟</div><div style="display:flex;align-items:center;gap:6px;color:#C9C9CE;font-size:13.5px;margin-top:4px">{ic("wave",16)}正在说话 · 仅语音</div></div>
 <div style="position:absolute;left:12px;right:12px;bottom:110px;display:flex;gap:8px;z-index:4">
  {m_agentchip("Kite","林舟的","think","思考中")}{m_agentchip("Nyra","我的","listen","在听")}</div>
 {m_ctrl(cam=False)}'''

def m_data(mode):
    row = lambda k, v: f'<div style="display:flex;align-items:center;padding:10px 0;border-top:1px solid var(--line)"><span class="muted">{k}</span><span style="flex:1"></span><span class="mono" style="font-size:14px">{v}</span></div>'
    return f'''<div class="vid" style="background-image:url({PEOPLE['lin']['img']});background-position:58% 50%"></div><div class="vscrim"></div>
 {m_topbar()}
 <div class="sheet gstrong" style="z-index:6">
  <div class="grab"></div>
  <div style="font-size:19px;font-weight:700">这次通话的用量</div>
  <div class="muted" style="font-size:13px;margin-top:2px">视频走流量，不耗 token · agent 的工作各用各主人的 token</div>
  <div style="display:flex;gap:8px;margin-top:14px"><div style="flex:1;padding:12px;border-radius:14px;background:var(--chip)"><div class="muted" style="font-size:12px">实时</div><div class="mono" style="font-size:15px;font-weight:700;margin-top:2px">↑1.2 ↓2.4</div><div class="muted" style="font-size:12px">MB/s</div></div><div style="flex:1;padding:12px;border-radius:14px;background:var(--chip)"><div class="muted" style="font-size:12px">已用流量</div><div class="mono" style="font-size:15px;font-weight:700;margin-top:2px">85 MB</div><div class="muted" style="font-size:12px">12:48</div></div></div>
  <div style="margin-top:12px">{row("网络","Wi-Fi")}{row("视频清晰度","720p · 自动")}{row("Nyra · 我的 token","3.2k")}{row("Kite · 林舟的 token","5.8k")}</div>
  <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)"><div style="flex:1"><div>蜂窝网络下省流量</div><div class="muted" style="font-size:12.5px">最高 360p，弱网时先关视频</div></div><span class="tg"></span></div>
  <div class="muted" style="font-size:11.5px;margin-top:6px">数字为示意</div>
 </div>'''

def m_summary(mode):
    item = lambda icn, t, s: f'<div style="display:flex;gap:10px;align-items:center;padding:10px 0;border-top:1px solid var(--line)">{icn}<div style="flex:1;min-width:0;line-height:1.35"><div style="font-size:14px">{t}</div><div class="muted" style="font-size:12.5px">{s}</div></div></div>'
    st = lambda k, v, s: f'<div style="flex:1;padding:10px 12px;border-radius:14px;background:var(--chip)"><div class="muted" style="font-size:12px">{k}</div><div class="mono" style="font-size:16px;font-weight:700">{v}</div><div class="muted" style="font-size:11px">{s}</div></div>'
    return f'''<div class="hd"><span class="ib">{ic("x",17)}</span><span style="flex:1"></span><span class="ib">{ic("share",17)}</span></div>
 <div style="padding:2px 20px 0"><div style="display:flex;gap:6px">{avatar("me",36,True)}{avatar("lin",36,True)}</div>
  <div style="font-size:24px;font-weight:700;margin-top:10px">通话已结束</div><div class="muted" style="font-size:13px">和林舟 · 14:02–14:34 · 未录制</div></div>
 <div style="display:flex;gap:8px;padding:14px 16px 0">{st("时长","32:14","")}{st("流量","412 MB","不耗 token")}{st("token","11.7k","各付各的")}</div>
 <div style="padding:14px 20px 0"><b style="font-weight:600">一起完成的</b>
  {item('<span class="agentbox" style="width:28px;height:28px">'+mark(17)+'</span>','Kite 改了 <span class="mono" style="font-size:12.5px">auth/client.py</span> <span class="add">+6</span> <span class="del">−2</span>','你允许了一次')}
  {item('<span class="agentbox" style="width:28px;height:28px">'+mark(17)+'</span>','Nyra 加了 <span class="mono" style="font-size:12.5px">test_auth.py</span> <span class="add">+24</span>','测试 3/3 通过')}
  {item('<span style="width:28px;display:flex;justify-content:center">'+ic("x",16)+'</span>','Kite 想运行 <span class="mono" style="font-size:12.5px">pip install</span>','你拒绝了')}
  <div style="margin-top:12px"><b style="font-weight:600">待办</b></div>
  {item('<span class="rd"></span>','超时可在设置里配置','林舟')}
  {item('<span class="rd"></span>','周五前合并分支','我')}</div>
 <div style="position:absolute;left:16px;right:16px;bottom:34px;display:flex;gap:8px"><span class="bt">{ic("cam",17)}再打</span><span class="bt p" style="flex:2">存为线程 + 待办</span></div>'''

# ------------------------------------------------------------------ 输出 ---
DESK = [
 ("d1-friends", "好友与通话", "我的好友码 · 好友请求 · 人 + agent · agent 权限单列", d_friends),
 ("d2-incoming", "来电", "玻璃来电卡 · 对方 + 她的 agent · 带摄像头 / 仅语音", d_incoming),
 ("d3-incall", "通话中（核心）", "人与 agent 按主人成对 · 玻璃控制条 · 右侧共享协作 + 审批卡 · 流量 vs token", d_incall),
 ("d4-permissions", "首次协作权限", "对方 agent 能看 / 能做什么", d_permissions),
 ("d5-recording", "录制同意", "全员同意才开始 · 常驻加密 / 录制状态", d_recording),
 ("d6-weak", "弱网", "自动降为仅语音 + 横幅 · 顶栏常驻“录制中”", d_weak),
 ("d7-summary", "通话结束总结", "时长 · 流量 · 一起完成的改动与待办", d_summary),
]
MOB = [
 ("m1-friends", "好友 · 手机", [("好友列表", m_friends, False, False), ("好友详情 · agent 权限", m_friend_detail, False, False), ("加好友 · 我的码", m_qr, False, False)]),
 ("m2-calling", "来电 / 去电 / 对方离线 · 手机", [("来电", lambda m: m_incoming(m), False, True), ("呼叫中", lambda m: m_incoming(m, outgoing=True), False, True), ("对方离线", lambda m: m_incoming(m, offline=True), False, True)]),
 ("m3-incall", "通话中 · 手机", [("视频（iOS）", m_incall, False, True), ("协作抽屉 + 审批", m_drawer, False, True), ("视频（Android）", lambda m: m_incall(m, True), True, True)]),
 ("m4-privacy", "权限与录制 · 手机", [("首次协作权限", m_permsheet, False, True), ("录制同意", m_recconsent, False, True), ("流量与 token", m_data, False, True)]),
 ("m5-edge", "边缘状态 · 手机", [("弱网 · 仅语音", m_weak, False, True), ("对方离线", lambda m: m_incoming(m, offline=True), True, True), ("通话结束总结", m_summary, False, False)]),
]

def capline(title, sub, mode):
    return f'<div class="cap">{mark(24)}{title} <small>{sub}</small><span class="tag">{"浅色" if mode=="light" else "深色"}</span><span class="tag">数字为示意</span></div>'

def build():
    manifest = {"desk": [], "mob": []}
    for key, title, sub, fn in DESK:
        for mode in ("light", "dark"):
            body = f'<div class="stage">{capline(title, sub, mode)}{fn(mode)}</div>'
            fn_ = f"call-{key}-{mode}.html"
            open(os.path.join(HERE, fn_), "w").write(page(mode, body))
            manifest["desk"].append(fn_)
    for key, title, screens in MOB:
        for mode in ("light", "dark"):
            ph = "".join(phone(f(mode), android=a, light_text=lt) for (_, f, a, lt) in screens)
            labels = " · ".join(s[0] for s in screens)
            body = f'<div class="stage">{capline(title, labels, mode)}<div class="phones">{ph}</div></div>'
            fn_ = f"call-{key}-{mode}.html"
            open(os.path.join(HERE, fn_), "w").write(page(mode, body))
            manifest["mob"].append([fn_, [s[0] for s in screens]])
    json.dump(manifest, open(os.path.join(HERE, "call-manifest.json"), "w"), ensure_ascii=False, indent=1)
    print(len(manifest["desk"]), len(manifest["mob"]))

if __name__ == "__main__":
    build()
