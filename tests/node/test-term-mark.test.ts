// tests/node/test-term-mark.test.ts — 欢迎屏上的 Nyra 标志（src/termMark.ts）：
// 预计算的覆盖率常量 / 内联图片 PNG 与 brandMark 几何一致、字符画两种画法的快照、圆盘是圆的、
// 内联图片的协议探测与转义序列、各回退路径。
import { test, expect } from "bun:test";
import { MARK_PAPER } from "../../src/brandMark.ts";
import {
  renderTermMark, termMarkStyle, isLightTerminal, TERM_MARK_COVERAGE, TERM_MARK_PX, TERM_MARK_COLS, TERM_MARK_ROWS,
  TERM_MARK_PAPER, termImageProtocol, termMarkImageSequence, termMarkImageOverlay,
} from "../../src/termMark.ts";
import { TERM_MARK_PNG_DARK, TERM_MARK_PNG_LIGHT } from "../../src/termMarkImage.ts";
import { termMarkCoverageRows, termMarkPng, TERM_MARK_PNG_PX } from "../../src/termMarkSource.ts";
import { renderHeader, stripAnsi, MARK_MIN_COLS, headerShowsMark, MARK_TOP_LINE, MARK_LEFT_COL } from "../../src/banner.ts";
import { textWidth } from "../../src/consoleUi.ts";

const INFO = { version: "0.5.1", model: "deepseek / deepseek-flash", mode: "auto", cwd: "/home/sj/projects/nyra-cli", branch: "main" };

test("TermMark.test_coverage_constant_matches_brand_geometry", () => {
  // 改了 brandMark 的几何，这里会失败：跑 bun scripts/make-term-mark.ts，把打印的新常量贴回 src/termMark.ts。
  expect([...TERM_MARK_COVERAGE]).toEqual(termMarkCoverageRows(TERM_MARK_PX));
  expect(TERM_MARK_PAPER).toBe(MARK_PAPER);
  // 比 dcf8870 的 14 列 × 7 行最多多 2 行。
  expect(TERM_MARK_COLS).toBe(18);
  expect(TERM_MARK_ROWS).toBe(9);
});

test("TermMark.test_inline_png_matches_brand_geometry", () => {
  // 内联图片就是 brandMark 光栅化的标志（同一份几何、同一个光栅器），跑 bun scripts/make-term-mark.ts 重新生成。
  expect(Buffer.from(TERM_MARK_PNG_DARK, "base64").equals(termMarkPng(false))).toBe(true);
  expect(Buffer.from(TERM_MARK_PNG_LIGHT, "base64").equals(termMarkPng(true))).toBe(true);
  for (const b64 of [TERM_MARK_PNG_DARK, TERM_MARK_PNG_LIGHT]) {
    const png = Buffer.from(b64, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(TERM_MARK_PNG_PX);
    expect(png.readUInt32BE(20)).toBe(TERM_MARK_PNG_PX);
    expect(png.length).toBeLessThan(4096); // 启动时写一次，体积可以忽略
  }
});

test("TermMark.test_mono_snapshot", () => {
  const lines = renderTermMark({ level: 0 });
  expect(lines).toEqual([
    "    ▄▄██████▄▄    ",
    "  ▄████████████▄  ",
    " █████ ▀█████████ ",
    "██████   ▀▀███████",
    "██████      ▀█████",
    "██████        ▀███",
    " ██████      ████ ",
    "  ▀████ ▄█▄  ▄█▀  ",
    "    ▀▀██████▀▀    ",
  ]);
  for (const l of lines) expect(l).not.toContain("\x1b[");
});

test("TermMark.test_color_snapshot", () => {
  const lines = renderTermMark({ level: 3 });
  expect(lines.map(stripAnsi)).toEqual([
    "    ▄▄▀████▀▄▄    ",
    "  ▄████████████▄  ",
    " ▀███▀▀▀████████▀ ",
    "▀████▀   ▀▀██████▀",
    "██████      ▀█████",
    "▀█████        ▀██▀",
    " ▀█████     ▀███▀ ",
    "  ▀███▀▄▀█▄  ▀█▀  ",
    "    ▀▀▀████▀▀▀    ",
  ]);
  for (const l of lines) expect(textWidth(stripAnsi(l))).toBe(TERM_MARK_COLS);
  const all = lines.join("");
  // 满覆盖的像素就是浅色圆盘；不设任何"假想底色"大块：背景只用于上下两个像素都有颜色的格子。
  expect(all).toContain("38;2;245;245;247m█");
  expect(all).not.toContain("48;2;18;18;18");
  // 光标中心（第 5 行、第 7–11 列）露出终端底色：是不带转义的空格。
  expect(stripAnsi(lines[4]).slice(6, 12)).toBe("      ");
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
  expect(light[4]).toContain("\x1b[1mNyra\x1b[0m");
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

test("TermMark.test_image_protocol_detection", () => {
  const p = termImageProtocol;
  expect(p({})).toBe(null);
  expect(p({ TERM: "xterm-256color", COLORTERM: "truecolor" })).toBe(null);
  expect(p({ TERM: "xterm-kitty" })).toBe("kitty");
  expect(p({ TERM: "xterm-256color", KITTY_WINDOW_ID: "1" })).toBe("kitty");
  expect(p({ TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" })).toBe("kitty");
  expect(p({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm");
  expect(p({ TERM_PROGRAM: "WezTerm" })).toBe("iterm");
  expect(p({ LC_TERMINAL: "iTerm2", TERM: "xterm-256color" })).toBe("iterm"); // ssh 过去
  // 不转发图片的复用器、非 TTY、dumb、显式关掉：都不画。
  expect(p({ TERM: "xterm-kitty", TMUX: "/tmp/tmux-1/default,1,0" })).toBe(null);
  expect(p({ TERM: "screen-256color", TERM_PROGRAM: "iTerm.app" })).toBe(null);
  expect(p({ TERM: "tmux-256color", KITTY_WINDOW_ID: "1" })).toBe(null);
  expect(p({ STY: "123.pts-0", TERM_PROGRAM: "WezTerm" })).toBe(null);
  expect(p({ TERM: "xterm-kitty" }, false)).toBe(null);
  expect(p({ TERM: "dumb", KITTY_WINDOW_ID: "1" })).toBe(null);
  expect(p({ TERM: "xterm-kitty", NYRA_IMAGES: "0" })).toBe(null);
  expect(p({ TERM_PROGRAM: "iTerm.app", NYRA_IMAGES: "off" })).toBe(null);
  // 强制。
  expect(p({ TERM: "xterm-256color", NYRA_IMAGES: "kitty" })).toBe("kitty");
  expect(p({ TERM: "xterm-256color", NYRA_IMAGES: "iterm" })).toBe("iterm");
  expect(p({ TERM: "xterm-256color", NYRA_IMAGES: "kitty", TMUX: "x" })).toBe(null);
  // VS Code / Windows Terminal / Apple Terminal：不画（用字符画）。
  expect(p({ TERM_PROGRAM: "vscode" })).toBe(null);
  expect(p({ WT_SESSION: "x" })).toBe(null);
  expect(p({ TERM_PROGRAM: "Apple_Terminal" })).toBe(null);
});

test("TermMark.test_image_sequences", () => {
  // kitty：PNG、传完即显示、宽 18 列（高按比例）、不移动光标、不回应答；分块，每块 ≤ 4096。
  const k = termMarkImageSequence("kitty");
  const chunks = [...k.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
  expect(chunks.map((c) => c[0]).join("")).toBe(k);
  expect(chunks[0][1]).toBe(`a=T,f=100,c=${TERM_MARK_COLS},C=1,q=2,m=${chunks.length > 1 ? 1 : 0}`);
  expect(chunks[chunks.length - 1][1]).toEndWith("m=0");
  for (const c of chunks) expect(c[2].length).toBeLessThanOrEqual(4096);
  expect(chunks.map((c) => c[2]).join("")).toBe(TERM_MARK_PNG_DARK);
  expect(termMarkImageSequence("kitty", true)).toContain(TERM_MARK_PNG_LIGHT.slice(0, 100));
  // iTerm2：OSC 1337 File=，宽 18 格，高按比例，size 是解码后的字节数。
  const i = termMarkImageSequence("iterm");
  const m = /^\x1b\]1337;File=inline=1;size=(\d+);width=(\d+);height=auto;preserveAspectRatio=1:([A-Za-z0-9+/=]+)\x07$/.exec(i);
  expect(m).not.toBe(null);
  expect(Number(m![1])).toBe(Buffer.from(TERM_MARK_PNG_DARK, "base64").length);
  expect(Number(m![2])).toBe(TERM_MARK_COLS);
  expect(m![3]).toBe(TERM_MARK_PNG_DARK);
  // 叠加：保存光标 → 上移 → 回到第 col 列 → 画图 → 恢复光标。
  const o = termMarkImageOverlay("kitty", { linesUp: 15, col: 1 });
  expect(o.startsWith("\x1b7\x1b[15A\r\x1b[1C\x1b_G")).toBe(true);
  expect(o.endsWith("\x1b\\\x1b8")).toBe(true);
});

test("TermMark.test_header_leaves_room_for_image", () => {
  const opts = { width: 100, color: true, level: 3 as const, unicode: true, home: "/home/sj" };
  expect(headerShowsMark(opts)).toBe(true);
  expect(headerShowsMark({ ...opts, width: MARK_MIN_COLS - 1 })).toBe(false);
  expect(headerShowsMark({ ...opts, unicode: false })).toBe(false);
  expect(headerShowsMark({ ...opts, compact: true })).toBe(false);
  const withImg = renderHeader(INFO, { ...opts, markImage: true });
  const withMark = renderHeader(INFO, opts);
  // 同样的行数、标题与介绍在同一处；标志位置是空白（图片随后画在 MARK_TOP_LINE 行、MARK_LEFT_COL 列）。
  expect(withImg.length).toBe(withMark.length);
  expect(MARK_TOP_LINE).toBe(1);
  expect(MARK_LEFT_COL).toBe(1);
  for (let i = 0; i < withImg.length; i++) {
    if (i >= MARK_TOP_LINE && i < MARK_TOP_LINE + TERM_MARK_ROWS) {
      expect(stripAnsi(withImg[i]).slice(0, MARK_LEFT_COL + TERM_MARK_COLS).trim()).toBe("");
      expect(stripAnsi(withImg[i]).slice(MARK_LEFT_COL + TERM_MARK_COLS)).toBe(stripAnsi(withMark[i]).slice(MARK_LEFT_COL + TERM_MARK_COLS));
    } else expect(withImg[i]).toBe(withMark[i]);
  }
  expect(withImg.join("")).not.toMatch(/[▀▄█]/);
});
