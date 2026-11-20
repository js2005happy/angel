# 渲染 call-*.html：画板 1600×1000 @2x → out/call/<name>.png；单屏（桌面 .win 1440×900、手机 .sc 390×844）@2x → out/call/single/
import json, sys, asyncio, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get("CALL_OUT", "/workspace/nyra-design/out/call")
async def main(only=None):
    man = json.load(open(os.path.join(HERE, "call-manifest.json")))
    os.makedirs(OUT + "/single", exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=2)
        for fn in man["desk"]:
            if only and only not in fn: continue
            await pg.goto(f"file://{HERE}/{fn}"); await pg.wait_for_timeout(350)
            name = fn[:-5]
            await pg.screenshot(path=f"{OUT}/{name}.png")
            await pg.locator(".win").screenshot(path=f"{OUT}/single/{name}.png")
        for fn, labels in man["mob"]:
            if only and only not in fn: continue
            await pg.goto(f"file://{HERE}/{fn}"); await pg.wait_for_timeout(350)
            name = fn[:-5]
            await pg.screenshot(path=f"{OUT}/{name}.png")
            scs = pg.locator(".sc")
            for i in range(await scs.count()):
                await scs.nth(i).screenshot(path=f"{OUT}/single/{name}-{i+1}.png")
        await b.close()
asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))
