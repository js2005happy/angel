// tests/node/test-banner.test.ts — 终端外观（框式头部 / 信任确认 / 输入区 / 状态栏）。
// 旧的 11 行 ### 字标已删除；这里用内联快照锁定新布局。
import { test, expect } from "bun:test";
import {
  renderHeader, renderTrustPrompt, renderStatusBar, renderInputFrame, renderRule,
  supportsBoxDrawing, shortenPath, truncateLeft, stripAnsi, inputRows,
} from "../../src/banner.ts";
import { textWidth } from "../../src/consoleUi.ts";

const INFO = { version: "0.5.1", model: "deepseek / deepseek-flash", mode: "auto", cwd: "/home/sj/projects/nyra-cli" };

test("BannerTest.test_header_snapshot_unicode", () => {
  const out = renderHeader(INFO, { width: 100, color: false, unicode: true, home: "/home/sj" }).join("\n");
  expect(out).toBe([
    "╭──────────────────────────────────────╮",
    "│ ✻ Nyra 0.5.1                         │",
    "│                                      │",
    "│   模型：deepseek / deepseek-flash    │",
    "│   模式：auto                         │",
    "│   目录：~/projects/nyra-cli          │",
    "╰──────────────────────────────────────╯",
  ].join("\n"));
});

test("BannerTest.test_header_snapshot_ascii", () => {
  const out = renderHeader(INFO, { width: 100, color: false, unicode: false, home: "/home/sj" }).join("\n");
  expect(out).toBe([
    "+--------------------------------------+",
    "| * Nyra 0.5.1                         |",
    "|                                      |",
    "|   模型：deepseek / deepseek-flash    |",
    "|   模式：auto                         |",
    "|   目录：~/projects/nyra-cli          |",
    "+--------------------------------------+",
  ].join("\n"));
  // ASCII 回退里不能有任何非 ASCII 的画框字符。
  expect(out).not.toMatch(/[\u2500-\u257f\u273b…]/);
});

test("BannerTest.test_no_big_wordmark_and_never_angel", () => {
  const out = renderHeader(INFO, { width: 80, unicode: true }).join("\n");
  expect(out).not.toContain("###");
  expect(out.split("\n").length).toBeLessThanOrEqual(8);
  const all = [
    out,
    renderTrustPrompt("/tmp/x", { width: 80 }).lines.join("\n"),
    renderTrustPrompt("/tmp/x", { width: 80 }).question,
    renderStatusBar({ model: "m", mode: "auto", contextUsage: null }, { width: 80 }),
  ].join("\n");
  expect(all.toLowerCase()).not.toContain("angel");
  expect(out).toContain("Nyra");
});

test("BannerTest.test_header_box_lines_have_equal_width", () => {
  for (const width of [100, 60, 40, 30]) {
    const lines = renderHeader({ ...INFO, cwd: "C:\\Users\\Administrator\\WorkBuddy\\2026-11-18-12-08-26\\nyra-cli" },
      { width, unicode: true, home: "C:\\Users\\Administrator" });
    const widths = lines.map((l) => textWidth(l));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeLessThanOrEqual(width);
  }
});

test("BannerTest.test_header_long_windows_path_shortened", () => {
  const lines = renderHeader({ ...INFO, cwd: "C:\\Users\\Administrator\\WorkBuddy\\2026-11-18-12-08-26\\nyra-cli" },
    { width: 44, unicode: true, home: "C:\\Users\\Administrator" });
  const dirLine = lines.find((l) => l.includes("目录"))!;
  expect(dirLine).toContain("…");
  expect(dirLine).toContain("nyra-cli");
  expect(dirLine).not.toContain("Administrator");
});

test("BannerTest.test_header_narrow_terminal_drops_box", () => {
  const lines = renderHeader(INFO, { width: 20, unicode: true, home: "/home/sj" });
  expect(lines.join("")).not.toContain("╭");
  for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(20);
});

test("BannerTest.test_color_and_no_color", () => {
  const plain = renderHeader(INFO, { width: 80, color: false, home: "/home/sj" });
  const colored = renderHeader(INFO, { width: 80, color: true, home: "/home/sj" });
  expect(plain.join("\n")).not.toContain("\x1b[");
  expect(colored.join("\n")).toContain("\x1b[");
  expect(colored.map(stripAnsi)).toEqual(plain);
  const bar = renderStatusBar({ model: "m", mode: "auto", contextUsage: 0.2 }, { width: 80, color: false });
  expect(bar).not.toContain("\x1b[");
});

test("BannerTest.test_shorten_path", () => {
  expect(shortenPath("/home/sj", 40, "/home/sj")).toBe("~");
  expect(shortenPath("/home/sj/a/b", 40, "/home/sj")).toBe("~/a/b");
  expect(shortenPath("/home/sjx/a", 40, "/home/sj")).toBe("/home/sjx/a");
  expect(shortenPath("C:\\Users\\Admin\\proj", 40, "C:\\Users\\Admin")).toBe("~\\proj");
  expect(truncateLeft("abcdefghij", 5)).toBe("…ghij");
  expect(textWidth(truncateLeft("工作目录很长很长", 7))).toBeLessThanOrEqual(7);
});

test("BannerTest.test_trust_prompt_snapshot", () => {
  const t = renderTrustPrompt("/home/sj/projects/nyra-cli", { width: 100, unicode: true });
  expect(t.lines.join("\n")).toBe([
    "╭───────────────────────────────────────╮",
    "│ 信任这个工作目录吗？                  │",
    "│ /home/sj/projects/nyra-cli            │",
    "│ Nyra 可以在这里读取、修改和执行文件。 │",
    "╰───────────────────────────────────────╯",
  ].join("\n"));
  expect(t.question).toContain("(y/N)");
});

test("BannerTest.test_status_bar_snapshot", () => {
  expect(renderStatusBar({ model: "deepseek / deepseek-flash", mode: "auto", contextUsage: null }, { width: 80 }))
    .toBe("  deepseek / deepseek-flash · auto · 上下文 --");
  expect(renderStatusBar({ model: "deepseek", mode: "full", contextUsage: 0.254 }, { width: 80, unicode: false }))
    .toBe("  deepseek - full - 上下文 25%");
});

test("BannerTest.test_status_bar_mode_hint_only_when_supported", () => {
  const without = renderStatusBar({ model: "m", mode: "auto", contextUsage: null }, { width: 100 });
  expect(without).not.toContain("shift+tab");
  const withKey = renderStatusBar({ model: "m", mode: "auto", contextUsage: null, modeSwitchKey: true }, { width: 100 });
  expect(withKey).toContain("shift+tab to switch modes");
});

test("BannerTest.test_status_bar_fits_narrow_terminal", () => {
  const bar = renderStatusBar({ model: "a-very-long-provider / a-very-long-model-name", mode: "auto", contextUsage: 0.5 }, { width: 30 });
  expect(textWidth(bar)).toBeLessThanOrEqual(30);
});

test("BannerTest.test_input_frame", () => {
  const f = renderInputFrame({ model: "m", mode: "auto", contextUsage: null }, { width: 40, unicode: true });
  expect(f.prompt).toBe("> ");
  expect(f.above).toEqual(["─".repeat(40)]);
  expect(f.below[0]).toBe("─".repeat(40));
  expect(f.below[1]).toContain("auto");
  expect(renderRule(4, { unicode: false })).toBe("----");
  expect(inputRows("", 80)).toBe(1);
  expect(inputRows("x".repeat(100), 80)).toBe(2);
});

test("BannerTest.test_supports_box_drawing_detection", () => {
  // Windows：Windows Terminal / VS Code / ConEmu 才用框线；裸 conhost 退回 ASCII。
  expect(supportsBoxDrawing({ WT_SESSION: "abc" }, "win32")).toBe(true);
  expect(supportsBoxDrawing({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true);
  expect(supportsBoxDrawing({ ConEmuANSI: "ON" }, "win32")).toBe(true);
  expect(supportsBoxDrawing({}, "win32")).toBe(false);
  // 强制开关。
  expect(supportsBoxDrawing({ NYRA_ASCII: "1", WT_SESSION: "abc" }, "win32")).toBe(false);
  expect(supportsBoxDrawing({ NYRA_UNICODE: "1" }, "win32")).toBe(true);
  // 其他平台：默认支持；dumb 或明确非 UTF-8 的 locale 不支持。
  expect(supportsBoxDrawing({}, "linux")).toBe(true);
  expect(supportsBoxDrawing({ LANG: "en_US.UTF-8" }, "darwin")).toBe(true);
  expect(supportsBoxDrawing({ TERM: "dumb" }, "linux")).toBe(false);
  expect(supportsBoxDrawing({ LANG: "zh_CN.GBK" }, "linux")).toBe(false);
});
