// tests/node/test-term-mark.test.ts — 欢迎屏上用半块字符拼的 Nyra 标志（src/termMark.ts）：
// 预计算的覆盖率常量与 brandMark 几何一致、两种画法的快照、圆盘是圆的、各回退路径。
import { test, expect } from "bun:test";
import { rasterizeMark, MARK_PAPER, MARK_STROKE } from "../../src/brandMark.ts";
import {
  renderTermMark, termMarkStyle, isLightTerminal, TERM_MARK_COVERAGE, TERM_MARK_PX, TERM_MARK_COLS, TERM_MARK_ROWS,
  TERM_MARK_PAPER,
} from "../../src/termMark.ts";
import { renderHeader, stripAnsi, MARK_MIN_COLS } from "../../src/banner.ts";
import { textWidth } from "../../src/consoleUi.ts";

const INFO = { version: "0.5.1", model: "deepseek / deepseek-flash", mode: "auto", cwd: "/home/sj/projects/nyra-cli", branch: "main" };

test("TermMark.test_coverage_constant_matches_brand_geometry", () => {
  // 改了 brandMark 的几何，这里会失败并打印新常量：把它贴回 src/termMark.ts。
  const a = rasterizeMark(TERM_MARK_PX, { disc: "#FFFFFF", bg: null, discFraction: 1, stroke: MARK_STROKE });
  const rows: string[] = [];
  for (let y = 0; y < TERM_MARK_PX; y++) {
    let s = "";
    for (let x = 0; x < TERM_MARK_PX; x++) s += Math.round((a[(y * TERM_MARK_PX + x) * 4 + 3] / 255) * 15).toString(16);
    rows.push(s);
  }
  expect([...TERM_MARK_COVERAGE]).toEqual(rows);
  expect(TERM_MARK_PAPER).toBe(MARK_PAPER);
  expect(TERM_MARK_COLS).toBeGreaterThanOrEqual(10);
  expect(TERM_MARK_COLS).toBeLessThanOrEqual(14);
  expect(TERM_MARK_ROWS).toBeGreaterThanOrEqual(5);
  expect(TERM_MARK_ROWS).toBeLessThanOrEqual(7);
});

test("TermMark.test_mono_snapshot", () => {
  const lines = renderTermMark({ level: 0 });
  expect(lines).toEqual([
    "   ▄██████▄   ",
    " ▄██████████▄ ",
    "█████  ▀██████",
    "█████    ▀████",
    "█████     ▄███",
    " ▀███  ▄  ▀█▀ ",
    "   ▀████▄▄▀   ",
  ]);
  for (const l of lines) expect(l).not.toContain("\x1b[");
});

test("TermMark.test_color_snapshot", () => {
  const lines = renderTermMark({ level: 3 });
  expect(lines.map(stripAnsi)).toEqual([
    "  ▄▄▀████▀▄▄  ",
    " ▀██▀▀██████▀ ",
    "▀████ ▀▀█████▀",
    "████▀    ▀▀███",
    "▀████     ▄▀█▀",
    " ▀███ ▄▄  ▀█▀ ",
    "  ▀▀▀███▀▀▀▀  ",
  ]);
  for (const l of lines) expect(textWidth(stripAnsi(l))).toBe(TERM_MARK_COLS);
  const all = lines.join("");
  // 满覆盖的像素就是浅色圆盘；不设任何"假想底色"大块：背景只用于上下两个像素都有颜色的格子。
  expect(all).toContain("38;2;245;245;247m█");
  expect(all).not.toContain("48;2;18;18;18");
  // 光标中心（第 4 行、第 6–8 列）露出终端底色：是不带转义的空格。
  expect(stripAnsi(lines[3]).slice(5, 9)).toBe("    ");
  // 256 色同样是抗锯齿画法（38;5 / 48;5），不出 truecolor 序列。
  const c256 = renderTermMark({ level: 2 }).join("");
  expect(c256).toContain("38;5;");
  expect(c256).not.toContain("38;2;");
});

test("TermMark.test_disc_is_round", () => {
  // 每格上下两个像素、终端字符格高 ≈ 宽 × 2 → 像素是方的。圆盘的像素外接框必须是正方形，
  // 且上下 / 左右各一半的面积接近（光标在里面挖掉的部分不算）。
  const px: [number, number][] = [];
  for (let y = 0; y < TERM_MARK_PX; y++) for (let x = 0; x < TERM_MARK_PX; x++) {
    if (parseInt(TERM_MARK_COVERAGE[y][x], 16) >= 8) px.push([x, y]);
  }
  const xs = px.map((p) => p[0]); const ys = px.map((p) => p[1]);
  expect(Math.max(...xs) - Math.min(...xs)).toBe(Math.max(...ys) - Math.min(...ys));
  // 外圈（第一行 / 最后一行 / 第一列 / 最后一列）的亮像素数一致：四边对称。
  const edge = (f: (p: [number, number]) => boolean) => px.filter(f).length;
  const top = edge((p) => p[1] === 0); const bottom = edge((p) => p[1] === TERM_MARK_PX - 1);
  const left = edge((p) => p[0] === 0); const right = edge((p) => p[0] === TERM_MARK_PX - 1);
  expect(new Set([top, bottom, left, right]).size).toBe(1);
});

test("TermMark.test_style_and_light_detection", () => {
  expect(termMarkStyle(3)).toBe("color");
  expect(termMarkStyle(2)).toBe("color");
  expect(termMarkStyle(1)).toBe("mono");
  expect(termMarkStyle(0)).toBe("mono");
  expect(termMarkStyle(3, true)).toBe("mono");
  expect(isLightTerminal({})).toBe(false);
  expect(isLightTerminal({ COLORFGBG: "0;15" })).toBe(true);
  expect(isLightTerminal({ COLORFGBG: "0;7" })).toBe(true);
  expect(isLightTerminal({ COLORFGBG: "15;0" })).toBe(false);
  expect(isLightTerminal({ COLORFGBG: "15;default;0" })).toBe(false);
  expect(isLightTerminal({ COLORFGBG: "garbage" })).toBe(false);
  expect(isLightTerminal({ COLORFGBG: "15;0", NYRA_THEME: "light" })).toBe(true);
  expect(isLightTerminal({ COLORFGBG: "0;15", NYRA_THEME: "dark" })).toBe(false);
  // 浅色终端 / 16 色：mono，不带颜色，用终端默认前景色。
  expect(renderTermMark({ level: 3, light: true })).toEqual(renderTermMark({ level: 0 }));
  expect(renderTermMark({ level: 1 })).toEqual(renderTermMark({ level: 0 }));
});

test("TermMark.test_header_fallbacks", () => {
  const block = /[▀▄█]/;
  // 宽屏 + 能画块字符：标志在左。
  const wide = renderHeader(INFO, { width: 100, color: true, level: 3, unicode: true, home: "/home/sj" });
  expect(wide.slice(1, 1 + TERM_MARK_ROWS).join("")).toMatch(block);
  // NO_COLOR：同样的布局，mono 标志，没有任何转义。
  const nc = renderHeader(INFO, { width: 100, color: true, level: 0, unicode: true, home: "/home/sj" });
  expect(nc.join("")).not.toContain("\x1b[");
  expect(nc.slice(1, 1 + TERM_MARK_ROWS).map((l) => l.slice(1, 1 + TERM_MARK_COLS).trimEnd()))
    .toEqual(renderTermMark({ level: 0 }).map((l) => l.trimEnd()));
  // 浅色终端：mono 标志；标题不用近白色，用终端默认前景色加粗。
  const light = renderHeader(INFO, { width: 100, color: true, level: 3, unicode: true, light: true, home: "/home/sj" });
  expect(light.slice(1, 1 + TERM_MARK_ROWS).map((l) => stripAnsi(l))).toEqual(nc.slice(1, 1 + TERM_MARK_ROWS));
  expect(light[3]).toContain("\x1b[1mNyra\x1b[0m");
  // 不能画块字符（老 conhost / NYRA_ASCII）、太窄、非 TTY：单行，没有块字符。
  for (const o of [{ unicode: false, width: 100 }, { unicode: true, width: MARK_MIN_COLS - 1 }, { unicode: true, width: 120, compact: true }]) {
    const lines = renderHeader(INFO, { ...o, color: false, home: "/home/sj" });
    expect(lines[1]).toMatch(/^[✻*] Nyra 0\.5\.1$/);
    expect(lines.join("\n")).not.toMatch(block);
  }
  // 任何宽度都不超出终端。
  for (const width of [MARK_MIN_COLS, 46, 60, 80, 100]) {
    for (const l of renderHeader(INFO, { width, color: true, level: 3, unicode: true, home: "/home/sj" })) {
      expect(textWidth(stripAnsi(l))).toBeLessThanOrEqual(width);
    }
  }
});
