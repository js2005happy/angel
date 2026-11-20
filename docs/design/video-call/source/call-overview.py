# 总览图：最重要的 10 屏并排（桌面 4 + 手机 6）
from callkit import *
S="/workspace/nyra-design/out/call/single/"
D=[("call-d3-incall-light","通话中 · 浅色"),("call-d3-incall-dark","通话中 · 深色"),("call-d1-friends-light","好友：人 + 他的 agent"),("call-d4-permissions-dark","首次协作权限")]
M=[("call-m2-calling-dark-1","来电"),("call-m3-incall-light-1","通话中"),("call-m3-incall-light-2","协作抽屉 + 审批"),("call-m4-privacy-dark-2","录制同意"),("call-m5-edge-dark-1","弱网 · 仅语音"),("call-m5-edge-light-3","结束总结")]
cell=lambda f,l,w,h,r: f'<figure><img src="file://{S}{f}.png" style="width:{w}px;height:{h}px;border-radius:{r}px"><figcaption>{l}</figcaption></figure>'
body=f'''<div style="width:2000px;padding:36px 40px 40px;background:#E9E9EC">
<div class="cap" style="position:static;margin-bottom:24px">{mark(26)}Nyra 视频通话 · 设计总览 <small>桌面 1440×900 · 手机 390×844 · 浅色 / 深色 · 数字为示意</small></div>
<div style="display:grid;grid-template-columns:950px 950px;gap:22px 20px">{''.join(cell(f,l,950,594,10) for f,l in D)}</div>
<div style="display:flex;justify-content:space-between;margin-top:26px">{''.join(cell(f,l,300,649,34) for f,l in M)}</div></div>'''
extra="figure{margin:0}figure img{display:block;box-shadow:0 14px 40px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.06)}figcaption{font-size:15px;font-weight:600;color:#0D0D0D;margin-top:10px}"
open("call-overview.html","w").write(page("light",body,extra))

import asyncio
from playwright.async_api import async_playwright
async def shot():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={"width":2000,"height":1000},device_scale_factor=1.6)
        await pg.goto("file:///workspace/nyra-design/v2/call-overview.html"); await pg.wait_for_timeout(800)
        await pg.locator("body>div").screenshot(path="/workspace/nyra-design/out/call/call-overview.png"); await b.close()
asyncio.run(shot())
