# 截图实测文字对比度：先记下每个文字元素的位置与颜色，再把文字隐藏重截一张取背景像素，
# 按背景第 10 百分位（最不利的那块）算 WCAG 对比度。跳过：被模糊的背景层、禁用态（祖先 opacity<1）。
import json, sys, asyncio, os, io
from playwright.async_api import async_playwright
from PIL import Image
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
JS = r'''() => {
 const out=[];
 const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 const seen=new Set();
 while(walk.nextNode()){const n=walk.currentNode; if(!n.textContent.trim()) continue; const el=n.parentElement; if(seen.has(el)) continue; seen.add(el);
  let skip=false,a=el; while(a){const cs=getComputedStyle(a); if(cs.filter&&cs.filter!=='none') skip='blur'; if(parseFloat(cs.opacity)<1) skip='disabled'; a=a.parentElement;}
  const r=document.createRange(); r.selectNodeContents(n); const b=r.getBoundingClientRect(); if(b.width<2||b.height<2) continue;
  const cs=getComputedStyle(el);
  if(!skip){const h=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2); if(h&&!(el.contains(h)||h.contains(el))) skip='covered';}
  out.push({t:n.textContent.trim().slice(0,30),x:b.x,y:b.y,w:b.width,h:b.height,c:cs.color,fs:parseFloat(cs.fontSize),fw:parseInt(cs.fontWeight),skip});}
 return out;}'''
def lum(rgb):
    c = np.asarray(rgb, dtype=float)/255.0
    c = np.where(c <= 0.03928, c/12.92, ((c+0.055)/1.055)**2.4)
    return 0.2126*c[...,0]+0.7152*c[...,1]+0.0722*c[...,2]
def parse(c):
    v=c[c.index('(')+1:-1].split(','); r,g,b=[float(x) for x in v[:3]]; a=float(v[3]) if len(v)>3 else 1.0; return np.array([r,g,b]),a
async def main():
    man = json.load(open(os.path.join(HERE, "call-manifest.json")))
    files = man["desk"] + [m[0] for m in man["mob"]]
    worst=[]; total=0; fails=[]
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={"width":1600,"height":1000})
        for fn in files:
            await pg.goto(f"file://{HERE}/{fn}"); await pg.wait_for_timeout(300)
            items = await pg.evaluate(JS)
            await pg.add_style_tag(content="*{color:transparent!important;-webkit-text-fill-color:transparent!important;caret-color:transparent!important}")
            await pg.wait_for_timeout(100)
            img = np.asarray(Image.open(io.BytesIO(await pg.screenshot())).convert("RGB")).astype(float)
            for it in items:
                if it["skip"]: continue
                x0,y0=int(max(0,it["x"])),int(max(0,it["y"])); x1,y1=int(min(1600,it["x"]+it["w"])),int(min(1000,it["y"]+it["h"]))
                if x1<=x0 or y1<=y0: continue
                bg = img[y0:y1,x0:x1].reshape(-1,3)
                col,a = parse(it["c"])
                L_bg = lum(bg)
                # 文字颜色按 alpha 叠在每个背景像素上
                fg = col*a + bg*(1-a)
                L_fg = lum(fg)
                cr = (np.maximum(L_bg,L_fg)+0.05)/(np.minimum(L_bg,L_fg)+0.05)
                c10 = float(np.percentile(cr,10)); total+=1
                large = it["fs"]>=24 or (it["fs"]>=18.66 and it["fw"]>=600)
                need = 3.0 if large else 4.5
                if c10 < need: fails.append((fn,it["t"],round(c10,2),need,it["fs"]))
        await b.close()
    print("text elements checked:", total, "fails:", len(fails))
    for f in fails: print(f)
asyncio.run(main())
