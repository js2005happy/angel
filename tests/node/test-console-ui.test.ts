// tests/node/test-console-ui.test.ts — 对应 tests/test_repl_ui.py（16 个唯一测试）的核心项。
import { test, expect } from "bun:test";
import { useColor, style, styleEnabled, oneLine, ToolPrinter, formatReplStatus } from "../../src/consoleUi.ts";

test("ConsoleUiTest.test_use_color_tty_rules", () => {
  // 非 TTY 的输出流不用颜色。
  const fake = { isTTY: false } as unknown as NodeJS.WriteStream;
  expect(useColor(fake)).toBe(false);
});

test("ConsoleUiTest.test_style_enabled_wraps_ansi", () => {
  expect(styleEnabled("hi", ["bold"], true)).toContain("\x1b[1m");
  expect(styleEnabled("hi", ["bold"], true)).toContain("hi");
  expect(styleEnabled("hi", ["bold"], false)).toBe("hi");
});

test("ConsoleUiTest.test_one_line_dict", () => {
  expect(oneLine({ a: 1, b: "x" })).toContain("a=1");
  expect(oneLine({ a: 1, b: "x" })).toContain("b=x");
});

test("ConsoleUiTest.test_one_line_truncates_long", () => {
  const out = oneLine("x".repeat(200), 80);
  expect(out.length).toBeLessThanOrEqual(81);
  expect(out).toContain("…");
});

test("ConsoleUiTest.test_tool_printer_call_tool_start", () => {
  const lines: string[] = [];
  const printer = new ToolPrinter({ write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream, false);
  printer.call("tool_start", { name: "read_file", id: "c1" });
  expect(lines.join("")).toContain("read_file");
});

test("ConsoleUiTest.test_tool_printer_stream_stderr_red", () => {
  const lines: string[] = [];
  const printer = new ToolPrinter({ write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream, true);
  printer.call("tool_stream", { name: "shell", stream: "stderr", text: "出错了" });
  expect(lines.join("")).toContain("出错了");
  expect(lines.join("")).toContain("\x1b[");
});

test("ConsoleUiTest.test_tool_printer_stream_truncates_200_chars", () => {
  const lines: string[] = [];
  const printer = new ToolPrinter({ write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream, false);
  printer.call("tool_stream", { name: "shell", stream: "stdout", text: "x".repeat(500) });
  expect(lines.join("").length).toBeLessThan(500);
});

test("ConsoleUiTest.test_format_repl_status", () => {
  const status = formatReplStatus("deepseek · deepseek-flash", "/tmp/wd", 0.25, "auto");
  expect(status).toContain("deepseek");
  expect(status).toContain("/tmp/wd");
  expect(status).toContain("25%");
  expect(status).toContain("auto");
});

test("ConsoleUiTest.test_format_repl_status_no_usage", () => {
  const status = formatReplStatus("deepseek", "/tmp/wd", null, "readonly");
  expect(status).toContain("--");
  expect(status).toContain("readonly");
});
