#!/usr/bin/env bun
// mobile/scripts/make-assets.ts — 由正式标志（src/brandMark.ts：圆盘 + 光标）
// 生成手机端 Capacitor 要用的图标与启动图。
// 零依赖（复用 brandMark 自带的光栅化与 PNG 编码），任何平台
// `bun mobile/scripts/make-assets.ts` 即可重新生成。
// 产物提交进仓库（mobile/assets/），CI 不重新生成，只用它们跑
// `npx @capacitor/assets generate --android`。
//
// 产物：
//   assets/icon.png             1024：黑色圆角图块 + 浅色圆盘（启动图标）
//   assets/icon-foreground.png  1024：透明底 + 浅色圆盘（自适应图标前景，66% 安全区）
//   assets/icon-background.png  1024：纯色 #0B0B0C（自适应图标背景）
//   assets/splash.png           2732：深色启动图，浅色圆盘居中
//   assets/splash-dark.png      2732：与 splash.png 相同（本身就是深色）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARK_INK, MARK_PAPER, MARK_PRESETS, markPng, rgbaPng } from "../../src/brandMark.ts";

const ASSETS = join(import.meta.dir, "..", "assets");

function solidPng(size: number, hex: string): Buffer {
  const [r, g, b] = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgbaPng(size, size, rgba);
}

const outputs: Record<string, Buffer> = {
  "icon.png": markPng(1024, MARK_PRESETS.app(1024)),
  "icon-foreground.png": markPng(1024, { disc: MARK_PAPER, bg: null, discFraction: 0.66 }),
  "icon-background.png": solidPng(1024, MARK_INK),
  "splash.png": markPng(2732, { disc: MARK_PAPER, bg: MARK_INK, discFraction: 0.25 }),
  "splash-dark.png": markPng(2732, { disc: MARK_PAPER, bg: MARK_INK, discFraction: 0.25 }),
};

if (import.meta.main) {
  mkdirSync(ASSETS, { recursive: true });
  for (const [name, buf] of Object.entries(outputs)) {
    writeFileSync(join(ASSETS, name), buf);
    console.log(`wrote mobile/assets/${name} (${buf.length} bytes)`);
  }
}
