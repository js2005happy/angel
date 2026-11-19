// tests/node/test-computer.test.ts — 对应 tests/test_computer.py 的 Node 移植。
// 全部 mock：假 runner / 假 which / 假 env，不调真实 xdotool、osascript、
// powershell，不联网。唯一例外：defaultCommandRunner 的真实 execFile
// 用本机 node 自身（process.execPath -e process.exit(3)）验证退出码
// 处理，不碰桌面工具、不联网。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComputerControl,
  ComputerError,
  checkPng,
  computerErrorMessage,
  defaultCommandRunner,
  defaultWhich,
  detectBackend,
  normalizeKey,
  validateButton,
  validateCoord,
  windowsVirtualKey,
  PNG_MAGIC,
  type CommandResult,
  type CommandRunner,
} from "../../src/computer.ts";

const PNG = Buffer.concat([PNG_MAGIC, Buffer.from("fake-png-body")]);
const DISPLAY_ENV = { DISPLAY: ":0", PATH: "/usr/bin:/bin" };

function ok(stdout: Buffer | string = "", stderr = ""): CommandResult {
  return {
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr,
    code: 0,
  };
}

function fail(code: number, stderr = ""): CommandResult {
  return { stdout: Buffer.from(""), stderr, code };
}

interface Fake {
  runner: CommandRunner;
  calls: string[][];
}

/** 假 runner：handler 按 argv 返回结果；默认成功空输出。 */
function fakeRunner(
  handler: (argv: string[]) => CommandResult = () => ok(),
): Fake {
  const calls: string[][] = [];
  const runner: CommandRunner = async (argv) => {
    calls.push(argv);
    return handler(argv);
  };
  return { runner, calls };
}

function x11Control(fake: Fake, extra: Record<string, unknown> = {}) {
  return new ComputerControl({
    backend: "x11",
    platform: "linux",
    env: { ...DISPLAY_ENV },
    runner: fake.runner,
    which: () => "/usr/bin/xdotool",
    commandTimeoutMs: 200,
    screenshotTimeoutMs: 200,
    ...extra,
  });
}

// ---- 按键归一化 / 校验（对应 Python TestNormalizeKey / TestValidate） ----

test("ComputerTest.test_normalize_key_simple_and_combo", () => {
  expect(normalizeKey("c")).toEqual({ mods: [], base: "c" });
  expect(normalizeKey("ctrl+c")).toEqual({ mods: ["ctrl"], base: "c" });
  expect(normalizeKey("Ctrl+Shift+Tab")).toEqual({
    mods: ["ctrl", "shift"],
    base: "tab",
  });
});

test("ComputerTest.test_normalize_key_aliases_and_case", () => {
  expect(normalizeKey("return")).toEqual({ mods: [], base: "enter" });
  expect(normalizeKey("ESCAPE")).toEqual({ mods: [], base: "esc" });
  expect(normalizeKey("control+option+del")).toEqual({
    mods: ["ctrl", "alt"],
    base: "delete",
  });
  expect(normalizeKey("cmd+a")).toEqual({ mods: ["win"], base: "a" });
  expect(normalizeKey("pgup")).toEqual({ mods: [], base: "page_up" });
  expect(normalizeKey("f12")).toEqual({ mods: [], base: "f12" });
});

test("ComputerTest.test_normalize_key_bad_keys", () => {
  expect(() => normalizeKey("")).toThrow("按键名不能为空");
  expect(() => normalizeKey("ctrl++c")).toThrow("按键名格式不对");
  expect(() => normalizeKey("ctrl+ctrl+c")).toThrow("重复的修饰键");
  expect(() => normalizeKey("a+b")).toThrow("一次只能按一个主键");
  expect(() => normalizeKey("ctrl")).toThrow("按键名里没有主键");
  expect(() => normalizeKey("hyper+x")).toThrow("不认识的按键");
});

test("ComputerTest.test_validate_coord", () => {
  expect(validateCoord(0, "x")).toBe(0);
  expect(validateCoord(100000, "x")).toBe(100000);
  expect(validateCoord(10.0, "x")).toBe(10);
  expect(() => validateCoord(true, "x")).toThrow("必须是整数");
  expect(() => validateCoord("10", "x")).toThrow("必须是整数，收到");
  expect(() => validateCoord(10.5, "x")).toThrow("必须是整数，收到");
  expect(() => validateCoord(-1, "x")).toThrow("超出合理范围");
  expect(() => validateCoord(100001, "x")).toThrow("超出合理范围");
  expect(() => validateButton("center")).toThrow(
    "鼠标键必须是 left/middle/right",
  );
});

test("ComputerTest.test_check_png", () => {
  expect(checkPng(PNG, "x").equals(PNG)).toBe(true);
  expect(() => checkPng(Buffer.from("not a png"), "scrot")).toThrow(
    "scrot 没有返回有效的 PNG 数据",
  );
  expect(() => checkPng(Buffer.from(""), "x")).toThrow("没有返回有效的 PNG 数据");
});

test("ComputerTest.test_detect_backend_and_unknown", () => {
  expect(detectBackend("linux")).toBe("x11");
  expect(detectBackend("win32")).toBe("windows");
  expect(detectBackend("darwin")).toBe("macos");
  expect(() => detectBackend("freebsd")).toThrow("不支持的操作系统");
  expect(() => new ComputerControl({ backend: "wayland" as never })).toThrow(
    "不认识的后端",
  );
  expect(computerErrorMessage(new ComputerError("失败"))).toBe("失败");
  expect(computerErrorMessage(new Error("raw"))).toBe("raw");
});

// ---- Linux/X11 后端 ----

test("ComputerTest.test_x11_move_builds_argv", async () => {
  const fake = fakeRunner();
  const ctl = x11Control(fake);
  await ctl.move(10, 20);
  expect(fake.calls[0]).toEqual(["xdotool", "mousemove", "10", "20"]);
});

test("ComputerTest.test_x11_click_right_button", async () => {
  const fake = fakeRunner();
  const ctl = x11Control(fake);
  await ctl.click(1, 2, "right");
  expect(fake.calls[0]).toEqual([
    "xdotool", "mousemove", "1", "2", "click", "3",
  ]);
  await expect(ctl.click(1, 2, "center")).rejects.toThrow(
    "鼠标键必须是 left/middle/right",
  );
});

test("ComputerTest.test_x11_type_text_and_empty_noop", async () => {
  const fake = fakeRunner();
  const ctl = x11Control(fake);
  await ctl.typeText("hello");
  expect(fake.calls[0]).toEqual([
    "xdotool", "type", "--clearmodifiers", "--", "hello",
  ]);
  await ctl.typeText("");
  expect(fake.calls.length).toBe(1);
  await expect(ctl.typeText(42 as never)).rejects.toThrow(
    "要输入的文本必须是字符串",
  );
});

test("ComputerTest.test_x11_press_combo_and_names", async () => {
  const fake = fakeRunner();
  const ctl = x11Control(fake);
  await ctl.press("ctrl+c");
  await ctl.press("enter");
  expect(fake.calls[0]).toEqual(["xdotool", "key", "ctrl+c"]);
  expect(fake.calls[1]).toEqual(["xdotool", "key", "Return"]);
});

test("ComputerTest.test_x11_screen_size", async () => {
  const fake = fakeRunner(() => ok("1920 1080\n"));
  const ctl = x11Control(fake);
  expect(await ctl.screenSize()).toEqual({ width: 1920, height: 1080 });
});

test("ComputerTest.test_x11_screen_size_bad_output", async () => {
  const fake = fakeRunner(() => ok("garbage\n"));
  const ctl = x11Control(fake);
  await expect(ctl.screenSize()).rejects.toThrow(
    "读屏幕尺寸失败，xdotool 输出无法解析",
  );
});

test("ComputerTest.test_x11_windows_parsed_and_skips_dead", async () => {
  const fake = fakeRunner((argv) => {
    if (argv[1] === "search") return ok("111\n222\n");
    if (argv[1] === "getwindowname" && argv[2] === "111") return ok("Terminal\n");
    if (argv[1] === "getwindowname" && argv[2] === "222") return fail(1, "gone");
    if (argv[1] === "getwindowgeometry") {
      return ok("X=10\nY=20\nWIDTH=800\nHEIGHT=600\n");
    }
    return ok();
  });
  const ctl = x11Control(fake);
  expect(await ctl.windows()).toEqual([
    { id: "111", title: "Terminal", x: 10, y: 20, width: 800, height: 600 },
  ]);
});

test("ComputerTest.test_x11_screenshot_prefers_import", async () => {
  const fake = fakeRunner(() => ok(PNG));
  const ctl = x11Control(fake, {
    which: (tool: string) => (tool === "import" ? "/usr/bin/import" : null),
  });
  expect((await ctl.screenshot()).equals(PNG)).toBe(true);
  expect(fake.calls[0][0]).toBe("import");
  expect(fake.calls[0]).toEqual(["import", "-window", "root", "png:-"]);
});

test("ComputerTest.test_x11_screenshot_falls_back_to_scrot", async () => {
  const seen: string[] = [];
  const fake = fakeRunner((argv) => {
    seen.push(argv[0]);
    if (argv[0] === "import") return ok("not png");
    return ok(PNG);
  });
  const ctl = x11Control(fake, {
    which: (tool: string) => `/usr/bin/${tool}`,
  });
  expect((await ctl.screenshot()).equals(PNG)).toBe(true);
  expect(seen).toEqual(["import", "scrot"]);
});

test("ComputerTest.test_x11_screenshot_no_tool", async () => {
  const fake = fakeRunner();
  const ctl = x11Control(fake, { which: () => null });
  await expect(ctl.screenshot()).rejects.toThrow(
    "截屏需要 ImageMagick（import）、scrot 或 gnome-screenshot",
  );
  await expect(ctl.screenshot()).rejects.toThrow("import（未安装）");
});

test("ComputerTest.test_x11_no_display_raises", async () => {
  const fake = fakeRunner();
  const ctl = new ComputerControl({
    backend: "x11",
    platform: "linux",
    env: { PATH: "/usr/bin" },
    runner: fake.runner,
    which: () => "/usr/bin/xdotool",
  });
  await expect(ctl.move(1, 2)).rejects.toThrow("没有桌面会话（DISPLAY 未设置）");
  expect(fake.calls.length).toBe(0);
});

test("ComputerTest.test_x11_xdotool_missing_raises", async () => {
  const fake = fakeRunner();
  const ctl = x11Control(fake, { which: () => null });
  await expect(ctl.move(1, 2)).rejects.toThrow("找不到 xdotool");
});

test("ComputerTest.test_x11_nonzero_exit_raises", async () => {
  const fake = fakeRunner(() => fail(1, "no display"));
  const ctl = x11Control(fake);
  await expect(ctl.move(1, 2)).rejects.toThrow(
    "桌面命令失败（退出码 1）：xdotool mousemove 1 2：no display",
  );
});

test("ComputerTest.test_x11_timeout_raises", async () => {
  const hanging: CommandRunner = async () => new Promise(() => {});
  const ctl = x11Control(fakeRunner(), {
    runner: hanging,
    commandTimeoutMs: 50,
  });
  await expect(ctl.move(1, 2)).rejects.toThrow("桌面命令超时：xdotool mousemove 1 2");
});

test("ComputerTest.test_runner_spawn_failure_wrapped", async () => {
  const broken: CommandRunner = async () => {
    throw new Error("spawn xdotool ENOENT");
  };
  const ctl = x11Control(fakeRunner(), { runner: broken });
  await expect(ctl.move(1, 2)).rejects.toThrow(
    "运行桌面命令失败：spawn xdotool ENOENT",
  );
});

// ---- macOS 后端 ----

function macosControl(fake: Fake, extra: Record<string, unknown> = {}) {
  return new ComputerControl({
    backend: "macos",
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin" },
    runner: fake.runner,
    commandTimeoutMs: 200,
    screenshotTimeoutMs: 200,
    ...extra,
  });
}

test("ComputerTest.test_macos_move_argv", async () => {
  const fake = fakeRunner();
  const ctl = macosControl(fake);
  await ctl.move(10, 20);
  expect(fake.calls[0][0]).toBe("osascript");
  const joined = fake.calls[0].join("\n");
  expect(joined).toContain(
    "CGEventCreateMouseEvent(missing value, 1, {10, 20}, 0)",
  );
  expect(joined).toContain("CGEventPost(0, mouseEvent)");
});

test("ComputerTest.test_macos_click_right", async () => {
  const fake = fakeRunner();
  const ctl = macosControl(fake);
  await ctl.click(1, 2, "right");
  const joined = fake.calls[0].join("\n");
  expect(joined).toContain(
    "CGEventCreateMouseEvent(missing value, 4, {1, 2}, 1)",
  );
  expect(joined).toContain(
    "CGEventCreateMouseEvent(missing value, 5, {1, 2}, 1)",
  );
});

test("ComputerTest.test_macos_type_text_escapes_quotes", async () => {
  const fake = fakeRunner();
  const ctl = macosControl(fake);
  await ctl.typeText('a"b');
  expect(fake.calls[0][fake.calls[0].length - 1]).toBe(
    'tell application "System Events" to keystroke "a\\"b"',
  );
});

test("ComputerTest.test_macos_press_combo", async () => {
  const fake = fakeRunner();
  const ctl = macosControl(fake);
  await ctl.press("ctrl+c");
  await ctl.press("enter");
  expect(fake.calls[0]).toContain(
    'tell application "System Events" to key code 8 using {control down}',
  );
  expect(fake.calls[1]).toContain(
    'tell application "System Events" to key code 36',
  );
});

test("ComputerTest.test_macos_press_unsupported_key", async () => {
  const fake = fakeRunner();
  const ctl = macosControl(fake);
  await expect(ctl.press("print_screen")).rejects.toThrow(
    "macOS 不支持这个按键",
  );
});

test("ComputerTest.test_macos_screen_size", async () => {
  const fake = fakeRunner(() => ok("{0, 0, 1920, 1080}\n"));
  const ctl = macosControl(fake);
  expect(await ctl.screenSize()).toEqual({ width: 1920, height: 1080 });
});

test("ComputerTest.test_macos_windows_parsed", async () => {
  const fake = fakeRunner(() =>
    ok("Terminal|{10, 20}|{800, 600}|42\nMail|{0, 0}|{400, 300}|43\n"),
  );
  const ctl = macosControl(fake);
  expect(await ctl.windows()).toEqual([
    { id: "42", title: "Terminal", x: 10, y: 20, width: 800, height: 600 },
    { id: "43", title: "Mail", x: 0, y: 0, width: 400, height: 300 },
  ]);
});

test("ComputerTest.test_macos_screenshot_success_and_argv", async () => {
  const fake = fakeRunner(() => ok());
  let readPath = "";
  const ctl = macosControl(fake, {
    readFile: (p: string) => {
      readPath = p;
      return PNG;
    },
  });
  expect((await ctl.screenshot()).equals(PNG)).toBe(true);
  expect(fake.calls[0].slice(0, 4)).toEqual([
    "screencapture", "-x", "-t", "png",
  ]);
  expect(readPath.endsWith(".png")).toBe(true);
});

test("ComputerTest.test_macos_screenshot_failure", async () => {
  const fake = fakeRunner(() => fail(1, "no display"));
  const ctl = macosControl(fake);
  await expect(ctl.screenshot()).rejects.toThrow(
    "screencapture 失败（退出码 1）",
  );
});

test("ComputerTest.test_macos_screenshot_missing_file", async () => {
  const fake = fakeRunner(() => ok());
  const ctl = macosControl(fake, {
    readFile: () => {
      throw new Error("ENOENT");
    },
  });
  await expect(ctl.screenshot()).rejects.toThrow("screencapture 没写出截图文件");
});

test("ComputerTest.test_macos_screenshot_non_png", async () => {
  const fake = fakeRunner(() => ok());
  const ctl = macosControl(fake, {
    readFile: () => Buffer.from("not a png"),
  });
  await expect(ctl.screenshot()).rejects.toThrow(
    "screencapture 没有返回有效的 PNG 数据",
  );
});

// ---- Windows 后端（PowerShell 脚本形态；未在真机验证，见汇报） ----

function windowsControl(fake: Fake, extra: Record<string, unknown> = {}) {
  return new ComputerControl({
    backend: "windows",
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32" },
    runner: fake.runner,
    commandTimeoutMs: 200,
    screenshotTimeoutMs: 200,
    ...extra,
  });
}

function psScript(fake: Fake, index = 0): string {
  expect(fake.calls[index][0]).toBe("powershell");
  expect(fake.calls[index].slice(1, 4)).toEqual([
    "-NoProfile", "-NonInteractive", "-Command",
  ]);
  return fake.calls[index][4];
}

test("ComputerTest.test_windows_move_script", async () => {
  const fake = fakeRunner(() => ok());
  const ctl = windowsControl(fake);
  await ctl.move(10, 20);
  const script = psScript(fake);
  expect(script).toContain("Add-Type -TypeDefinition $code");
  expect(script).toContain("[NyraWin32]::SetCursorPos(10, 20)");
  expect(script).toContain("SendInput");
});

test("ComputerTest.test_windows_click_right_script", async () => {
  const fake = fakeRunner(() => ok());
  const ctl = windowsControl(fake);
  await ctl.click(1, 2, "right");
  const script = psScript(fake);
  expect(script).toContain("[NyraWin32]::SetCursorPos(1, 2)");
  expect(script).toContain("[NyraWin32]::mouse_event(8, 0, 0, 0, [UIntPtr]::Zero)");
  expect(script).toContain("[NyraWin32]::mouse_event(16, 0, 0, 0, [UIntPtr]::Zero)");
  expect(script).toContain("Start-Sleep -Milliseconds 50");
});

test("ComputerTest.test_windows_press_combo_script", async () => {
  const fake = fakeRunner(() => ok());
  const ctl = windowsControl(fake);
  await ctl.press("ctrl+c");
  const script = psScript(fake);
  // ctrl=0x11=17，c=0x43=67；keybd_event 的第三个参数 2 表示 keyup。
  expect(script).toContain("[NyraWin32]::keybd_event(17, 0, 0, [UIntPtr]::Zero)");
  expect(script).toContain("[NyraWin32]::keybd_event(67, 0, 0, [UIntPtr]::Zero)");
  expect(script).toContain("[NyraWin32]::keybd_event(67, 0, 2, [UIntPtr]::Zero)");
  expect(script).toContain("[NyraWin32]::keybd_event(17, 0, 2, [UIntPtr]::Zero)");
  expect(windowsVirtualKey("f1")).toBe(0x70);
  expect(windowsVirtualKey("a")).toBe(0x41);
  expect(windowsVirtualKey("5")).toBe(0x35);
  expect(windowsVirtualKey("print_screen")).toBe(0x2c);
});

test("ComputerTest.test_windows_type_text_base64_arg", async () => {
  const fake = fakeRunner(() => ok());
  const ctl = windowsControl(fake);
  await ctl.typeText("hi你");
  const script = psScript(fake);
  expect(script).toContain("[NyraWin32]::TypeText($text)");
  expect(script).toContain("FromBase64String($args[0])");
  expect(fake.calls[0][5]).toBe(
    Buffer.from("hi你", "utf-16le").toString("base64"),
  );
});

test("ComputerTest.test_windows_screen_size", async () => {
  const fake = fakeRunner(() => ok("800 600\n"));
  const ctl = windowsControl(fake);
  expect(await ctl.screenSize()).toEqual({ width: 800, height: 600 });
});

test("ComputerTest.test_windows_windows_parsed", async () => {
  const titleB64 = Buffer.from("记事本", "utf-8").toString("base64");
  const fake = fakeRunner(() => ok(`1234|${titleB64}|10|20|800|600\n`));
  const ctl = windowsControl(fake);
  expect(await ctl.windows()).toEqual([
    { id: "1234", title: "记事本", x: 10, y: 20, width: 800, height: 600 },
  ]);
});

test("ComputerTest.test_windows_screenshot_png_and_non_png", async () => {
  const pngB64 = PNG.toString("base64");
  const fake = fakeRunner(() => ok(pngB64 + "\n"));
  const ctl = windowsControl(fake);
  expect((await ctl.screenshot()).equals(PNG)).toBe(true);
  expect(psScript(fake)).toContain("CopyFromScreen");
  expect(psScript(fake)).toContain("ImageFormat]::Png");

  const bad = fakeRunner(() => ok(Buffer.from("not png").toString("base64") + "\n"));
  const ctl2 = windowsControl(bad);
  await expect(ctl2.screenshot()).rejects.toThrow(
    "Windows 截屏 没有返回有效的 PNG 数据",
  );
});

test("ComputerTest.test_windows_nonzero_exit", async () => {
  const fake = fakeRunner(() => fail(1, "Windows 移动鼠标失败"));
  const ctl = windowsControl(fake);
  await expect(ctl.move(1, 2)).rejects.toThrow(
    "Windows 命令失败（退出码 1）：powershell：Windows 移动鼠标失败",
  );
});

// ---- 默认 runner / which（本机 node 自身，不碰桌面工具） ----

test("ComputerTest.test_default_runner_nonzero_exit", async () => {
  const result = await defaultCommandRunner(
    [process.execPath, "-e", "process.exit(3)"],
    { timeoutMs: 5000 },
  );
  expect(result.code).toBe(3);
});

test("ComputerTest.test_default_runner_timeout", async () => {
  await expect(
    defaultCommandRunner(
      [process.execPath, "-e", "setTimeout(()=>{}, 10000)"],
      { timeoutMs: 100 },
    ),
  ).rejects.toThrow("桌面命令超时");
});

test("ComputerTest.test_default_which_finds_executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-which-"));
  const file = join(dir, "xdotool");
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
  expect(defaultWhich("xdotool", "linux", { PATH: dir })).toBe(file);
  expect(defaultWhich("nope", "linux", { PATH: dir })).toBeNull();
});
