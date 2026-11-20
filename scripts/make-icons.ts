#!/usr/bin/env bun
// scripts/make-icons.ts — 由正式标志（src/brandMark.ts：圆盘 + 光标，= 入场动画终帧）生成仓库里的全部图标文件。
// 零依赖（自带光栅化与 PNG / ICO / ICNS 编码），任何平台 `bun scripts/make-icons.ts` 即可重新生成。
//   --check  只核对 SVG 是否与几何一致（不写文件，不一致时退出码 1）。
//
// 产物：
//   docs/assets/nyra-mark.svg        主文件：深色圆盘 + 镂空光标（浅色背景用；README、官网、网页 /nyra-mark.svg）
//   docs/assets/nyra-mark-dark.svg   浅色圆盘 + 镂空光标（深色背景用）
//   docs/assets/nyra-app-icon.svg    App 图标：黑色圆角图块 + 浅色圆盘 + 黑色光标
//   docs/assets/favicon.svg          跟随系统深浅色的矢量 favicon
//   docs/assets/favicon.ico          16 / 32 / 48
//   docs/assets/apple-touch-icon.png 180（不透明黑底）
//   desktop/icon-src/*.svg           桌面图标的矢量源（正常版、16–32 px 加粗版）
//   desktop/src-tauri/icons/*        Tauri：icon.png(512) / 32x32 / 128x128 / 128x128@2x / icon.ico / icon.icns
//   desktop/ui/mark.svg、mark-dark.svg  桌面外壳启动页的标志（浅 / 深）
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ICNS_TYPES, MARK_INK, MARK_PAPER, MARK_PRESETS, MARK_STROKE_SMALL,
  icnsFromPngs, icoFromPngs, markPng, markSvg,
} from "../src/brandMark.ts";

const ROOT = join(import.meta.dir, "..");

export const SVG_OUTPUTS: Record<string, string> = {
  "docs/assets/nyra-mark.svg": markSvg({ disc: MARK_INK }) + "\n",
  "docs/assets/nyra-mark-dark.svg": markSvg({ disc: MARK_PAPER }) + "\n",
  "docs/assets/nyra-app-icon.svg": markSvg({ disc: MARK_PAPER, tile: { fill: MARK_INK, radius: 0.225, disc: 0.7 } }) + "\n",
  "docs/assets/favicon.svg": markSvg({ disc: MARK_INK, adaptive: true }) + "\n",
  "desktop/icon-src/nyra-mark-small.svg": markSvg({ disc: MARK_PAPER, stroke: MARK_STROKE_SMALL, tile: { fill: MARK_INK, radius: 0.225, disc: 0.82 } }) + "\n",
  "desktop/icon-src/nyra-app-icon.svg": markSvg({ disc: MARK_PAPER, tile: { fill: MARK_INK, radius: 0.225, disc: 0.7 } }) + "\n",
  "desktop/ui/mark.svg": markSvg({ disc: MARK_INK }) + "\n",
  "desktop/ui/mark-dark.svg": markSvg({ disc: MARK_PAPER }) + "\n",
};

function binaryOutputs(): Record<string, Buffer> {
  const app = (s: number) => markPng(s, MARK_PRESETS.app(s));
  const mac = (s: number) => markPng(s, MARK_PRESETS.appMac(s));
  const light = (s: number) => markPng(s, MARK_PRESETS.light());
  return {
    "docs/assets/favicon.ico": icoFromPngs([16, 32, 48].map((size) => ({ size, png: light(size) }))),
    "docs/assets/apple-touch-icon.png": markPng(180, MARK_PRESETS.apple()),
    "desktop/src-tauri/icons/icon.png": app(512),
    "desktop/src-tauri/icons/32x32.png": app(32),
    "desktop/src-tauri/icons/128x128.png": app(128),
    "desktop/src-tauri/icons/128x128@2x.png": app(256),
    "desktop/src-tauri/icons/icon.ico": icoFromPngs([16, 24, 32, 48, 64, 256].map((size) => ({ size, png: app(size) }))),
    "desktop/src-tauri/icons/icon.icns": icnsFromPngs(ICNS_TYPES.map(([type, size]) => ({ type, png: mac(size) }))),
  };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  let bad = 0;
  for (const [rel, svg] of Object.entries(SVG_OUTPUTS)) {
    const path = join(ROOT, rel);
    if (check) {
      let cur = "";
      try { cur = readFileSync(path, "utf-8"); } catch {}
      if (cur !== svg) { console.error(`过期：${rel}`); bad++; }
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, svg);
    console.log(`写入 ${rel}`);
  }
  if (!check) {
    for (const [rel, buf] of Object.entries(binaryOutputs())) {
      const path = join(ROOT, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, buf);
      console.log(`写入 ${rel}（${buf.length} 字节）`);
    }
  }
  if (bad) { console.error("图标 SVG 与 src/brandMark.ts 不一致：运行 bun scripts/make-icons.ts 重新生成。"); process.exit(1); }
}
