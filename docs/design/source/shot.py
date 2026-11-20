import sys, asyncio
from playwright.async_api import async_playwright
async def main(names):
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width":1600,"height":1000}, device_scale_factor=2)
        for n in names:
            await pg.goto(f"file:///workspace/nyra-design/v2/{n}.html")
            await pg.wait_for_timeout(400)
            await pg.screenshot(path=f"/workspace/nyra-design/v2/out/{n}.png")
        await b.close()
asyncio.run(main(sys.argv[1:]))
