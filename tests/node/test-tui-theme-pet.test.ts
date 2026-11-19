// tests/node/test-tui-theme-pet.test.ts — 色彩等级 / NO_COLOR / 渐变、spinner（非 TTY 不动）、终端小伙伴。
import { test, expect } from "bun:test";
import { detectColorLevel, fgCode, gradient, paint, rgbTo256, hexToRgb, BRAND, isCi } from "../../src/theme.ts";
import { Spinner, spinnerLine, SPINNER_FRAMES_UNICODE } from "../../src/spinner.ts";
import {
  petFrame, renderPet, petFace, petVisible, petEnabledFromConfig, parsePetCommand, PetController,
  PET_WIDTH, PET_HEIGHT, renderBubble, IDLE_QUIPS, HAPPY_QUIPS, WORRIED_QUIPS, APPROVAL_QUIP,
} from "../../src/pet.ts";
import { stripAnsi } from "../../src/banner.ts";
import { ToolPrinter, textWidth } from "../../src/consoleUi.ts";

// ---------- 色彩等级 ----------
test("Theme.test_color_level_detection", () => {
  expect(detectColorLevel({ COLORTERM: "truecolor", TERM: "xterm-256color" }, true, "linux")).toBe(3);
  expect(detectColorLevel({ WT_SESSION: "1" }, true, "win32")).toBe(3);
  expect(detectColorLevel({ TERM_PROGRAM: "iTerm.app" }, true, "darwin")).toBe(3);
  expect(detectColorLevel({ TERM: "xterm-256color" }, true, "linux")).toBe(2);
  expect(detectColorLevel({ TERM_PROGRAM: "Apple_Terminal" }, true, "darwin")).toBe(2);
  expect(detectColorLevel({ TERM: "xterm" }, true, "linux")).toBe(1);
  expect(detectColorLevel({}, true, "win32")).toBe(1);
});

test("Theme.test_no_color_and_non_tty", () => {
  expect(detectColorLevel({ NO_COLOR: "1", COLORTERM: "truecolor" }, true, "linux")).toBe(0);
  expect(detectColorLevel({ COLORTERM: "truecolor" }, false, "linux")).toBe(0);
  expect(detectColorLevel({ TERM: "dumb" }, true, "linux")).toBe(0);
  // 强制开关。
  expect(detectColorLevel({ NYRA_COLOR: "256", COLORTERM: "truecolor" }, true, "linux")).toBe(2);
  expect(detectColorLevel({ NYRA_COLOR: "none" }, true, "linux")).toBe(0);
  expect(detectColorLevel({ NYRA_COLOR: "16", NO_COLOR: "1" }, true, "linux")).toBe(0);
  expect(paint("x", 0, { fg: BRAND.sage, bold: true })).toBe("x");
  expect(gradient("NYRA", 0)).toBe("NYRA");
});

test("Theme.test_fg_codes_per_level", () => {
  expect(fgCode(BRAND.sage, 3)).toBe(`38;2;${hexToRgb(BRAND.sage).join(";")}`);
  expect(fgCode(BRAND.sage, 2)).toMatch(/^38;5;\d+$/);
  expect(fgCode(BRAND.sage, 1)).toBe("32");
  expect(fgCode(BRAND.danger, 1)).toBe("31");
  expect(fgCode(BRAND.sage, 0)).toBe("");
  expect(rgbTo256([0, 0, 0])).toBe(16);
  expect(rgbTo256([255, 255, 255])).toBe(231);
  expect(rgbTo256([128, 128, 128])).toBeGreaterThanOrEqual(232);
});

test("Theme.test_gradient_varies_and_strips_clean", () => {
  const g = gradient("██████████", 3);
  expect(stripAnsi(g)).toBe("██████████");
  const codes = new Set([...g.matchAll(/38;2;[0-9;]+/g)].map((m) => m[0]));
  expect(codes.size).toBeGreaterThan(3);
  // 16 色不做色块跳变：只有一种颜色。
  const g16 = gradient("██████████", 1);
  expect(new Set([...g16.matchAll(/\x1b\[[0-9;]+m/g)].map((m) => m[0])).size).toBeLessThanOrEqual(2);
});

test("Theme.test_is_ci", () => {
  expect(isCi({ CI: "true" })).toBe(true);
  expect(isCi({ GITHUB_ACTIONS: "true" })).toBe(true);
  expect(isCi({})).toBe(false);
  expect(isCi({ CI: "0" })).toBe(false);
});

// ---------- spinner ----------
test("Spinner.test_does_not_animate_outside_tty", async () => {
  const out: string[] = [];
  const s = new Spinner({ write: (t) => out.push(t), tty: false, intervalMs: 5 });
  s.start();
  await new Promise((r) => setTimeout(r, 40));
  s.setLabel("运行 shell…");
  s.pause();
  s.resume();
  s.stop();
  expect(out).toEqual([]);
  expect(s.running).toBe(false);
});

test("Spinner.test_animates_on_tty_and_clears", async () => {
  const out: string[] = [];
  const s = new Spinner({ write: (t) => out.push(t), tty: true, intervalMs: 5, width: () => 80 });
  s.start();
  await new Promise((r) => setTimeout(r, 60));
  expect(s.running).toBe(true);
  expect(out.length).toBeGreaterThan(2);
  expect(out.every((t) => t.startsWith("\r\x1b[2K"))).toBe(true);
  expect(out.join("")).toContain("思考中…");
  expect(out.join("")).not.toContain("\n");
  s.stop();
  expect(out[out.length - 1]).toBe("\r\x1b[2K");
  const n = out.length;
  await new Promise((r) => setTimeout(r, 30));
  expect(out.length).toBe(n);
});

test("Spinner.test_line_format", () => {
  const line = spinnerLine({ tick: 2, elapsedMs: 3400, label: "思考中…", level: 0, unicode: true, width: 80 });
  expect(line).toBe(`${SPINNER_FRAMES_UNICODE[2]} 思考中… 3s`);
  const ascii = spinnerLine({ tick: 1, elapsedMs: 0, label: "思考中…", level: 0, unicode: false, width: 80 });
  expect(ascii).toBe("/ 思考中… 0s");
  const colored = spinnerLine({ tick: 0, elapsedMs: 1000, label: "思考中…", level: 3, unicode: true, width: 80 });
  expect(colored).toContain("38;2;");
  expect(stripAnsi(colored)).toBe(`${SPINNER_FRAMES_UNICODE[0]} 思考中… 1s`);
  // 带小伙伴小脸：放在指定列，眼珠随 tick 转。
  const withFace = spinnerLine({ tick: 0, elapsedMs: 0, label: "思考中…", level: 0, unicode: true, width: 100, face: petFace("thinking", 0), faceCol: 90 });
  expect(withFace.indexOf("(")).toBe(withFace.length - 5);
  expect(textWidth(withFace)).toBe(95);
  expect(petFace("thinking", 0)).not.toBe(petFace("thinking", 1));
  // 太窄时截断，不超宽。
  expect(textWidth(spinnerLine({ tick: 0, elapsedMs: 0, label: "运行 a_very_long_tool_name…", level: 0, unicode: true, width: 12 }))).toBeLessThanOrEqual(11);
});

// ---------- 小伙伴 ----------
const STATES = ["idle", "blink", "thinking", "happy", "worried", "approval"] as const;

test("Pet.test_frames_have_fixed_size", () => {
  for (const s of STATES) for (const tick of [0, 1, 2, 3]) {
    const f = petFrame(s, tick);
    expect(f.length).toBe(PET_HEIGHT);
    expect(PET_HEIGHT).toBeGreaterThanOrEqual(3);
    expect(PET_HEIGHT).toBeLessThanOrEqual(5);
    for (const row of f) expect(textWidth(row)).toBe(PET_WIDTH);
    const colored = renderPet(s, { level: 3, tick });
    expect(colored.map(stripAnsi)).toEqual(f);
    expect(colored.map((r) => textWidth(stripAnsi(r)))).toEqual(f.map(() => PET_WIDTH));
  }
});

test("Pet.test_expressions_differ_by_state", () => {
  const frames = STATES.map((s) => petFrame(s, 0).join("\n"));
  expect(new Set(frames).size).toBe(STATES.length);
  expect(petFrame("approval").join("")).toContain("o");
  expect(petFrame("approval")[1]).toContain("├─╯");
  expect(petFrame("happy")[1]).toContain("^ ^");
  // 思考时眼珠随 tick 转圈。
  expect(petFrame("thinking", 0)).not.toEqual(petFrame("thinking", 1));
  expect(petFrame("thinking", 0)).toEqual(petFrame("thinking", 4));
  // 品牌色：主色描边（truecolor 下出现鼠尾草绿）。
  expect(renderPet("idle", { level: 3 }).join("")).toContain(`38;2;${hexToRgb(BRAND.sage).join(";")}`);
  expect(renderPet("idle", { level: 0 })).toEqual(petFrame("idle"));
});

test("Pet.test_visibility_rules", () => {
  const base = { enabled: true, tty: true, cols: 100, unicode: true, env: {} };
  expect(petVisible(base)).toBe(true);
  expect(petVisible({ ...base, enabled: false })).toBe(false);
  expect(petVisible({ ...base, tty: false })).toBe(false);
  expect(petVisible({ ...base, cols: 79 })).toBe(false);
  expect(petVisible({ ...base, cols: 80 })).toBe(true);
  expect(petVisible({ ...base, unicode: false })).toBe(false);
  expect(petVisible({ ...base, env: { NYRA_ASCII: "1" } })).toBe(false);
  expect(petVisible({ ...base, env: { CI: "true" } })).toBe(false);
  expect(petVisible({ ...base, env: { GITHUB_ACTIONS: "true" } })).toBe(false);
});

test("Pet.test_config_default_on_and_command", () => {
  expect(petEnabledFromConfig({})).toBe(true);
  expect(petEnabledFromConfig({ pet: false })).toBe(false);
  expect(petEnabledFromConfig({ pet: true })).toBe(true);
  expect(parsePetCommand("/pet", true)).toBe(false);
  expect(parsePetCommand("/pet", false)).toBe(true);
  expect(parsePetCommand("/pet on", false)).toBe(true);
  expect(parsePetCommand("/pet off", true)).toBe(false);
  expect(parsePetCommand("/pet maybe", true)).toBeNull();
});

test("Pet.test_quips_and_bubble_are_short_and_nyra", () => {
  for (const q of [...IDLE_QUIPS, ...HAPPY_QUIPS, ...WORRIED_QUIPS, APPROVAL_QUIP]) {
    expect(textWidth(q)).toBeLessThanOrEqual(24);
    expect(q.toLowerCase()).not.toContain("angel");
  }
  expect(renderBubble("你好", 0)).toBe("( 你好 )");
  expect(stripAnsi(renderBubble("你好", 3))).toBe("( 你好 )");
});

function fakeClock(start = 1_000_000) {
  let now = start;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  let rand = 0.0;
  return {
    clock: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
      clearTimeout: (h: unknown) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
      random: () => rand,
    },
    setRandom: (r: number) => { rand = r; },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
      }
      now = end;
    },
    pending: () => timers.length,
  };
}

test("Pet.test_controller_blinks_and_stops", () => {
  const fc = fakeClock();
  const seen: string[] = [];
  const pet = new PetController(() => seen.push(pet.state), fc.clock);
  pet.start();
  fc.advance(3_000); // random()=0 → 第一次眨眼在 3s
  expect(seen).toContain("blink");
  fc.advance(200);
  expect(pet.state).toBe("idle");
  pet.stop();
  expect(fc.pending()).toBe(0);
  const n = seen.length;
  fc.advance(60_000);
  expect(seen.length).toBe(n);
});

test("Pet.test_controller_moods_and_quip_rate_limit", () => {
  const fc = fakeClock();
  const pet = new PetController(() => {}, fc.clock);
  pet.start();
  // 启动后 60 秒内不闲聊。
  fc.advance(45_000);
  expect(pet.bubble).toBeNull();
  fc.advance(45_000); // 90s：允许，random()=0 < 0.5 → 冒泡
  expect(pet.bubble).not.toBeNull();
  fc.advance(5_100);
  expect(pet.bubble).toBeNull(); // 几秒后消失
  // 冷却期内不再冒泡。
  expect(pet.say("hi")).toBe(false);
  // 审批强制提示并举手。
  pet.setMood("approval");
  expect(pet.state).toBe("approval");
  expect(pet.bubble).toBe(APPROVAL_QUIP);
  // happy 几秒后回到 idle。
  pet.setMood("happy");
  expect(pet.state).toBe("happy");
  fc.advance(4_100);
  expect(pet.state).toBe("idle");
  pet.setMood("worried");
  expect(pet.state).toBe("worried");
  fc.advance(6_100);
  expect(pet.state).toBe("idle");
  pet.setMood("thinking");
  fc.advance(30_000);
  expect(pet.state).toBe("thinking"); // 思考中不眨眼、不回落
  pet.stop();
});

// ---------- 工具调用树 ----------
test("ToolPrinter.test_tree_and_markers", () => {
  const lines: string[] = [];
  const stream = { write: (s: string) => { lines.push(s); return true; } } as unknown as NodeJS.WriteStream;
  const p = new ToolPrinter(stream, false, { unicode: true });
  p.call("assistant", { content: "先看一下" });
  p.call("tool_start", { name: "list_dir", arguments: { path: "." } });
  p.call("tool_result", { result: "src/ package.json" });
  p.call("tool_result", { result: "错误：没有这个文件" });
  expect(lines.join("")).toBe("● 先看一下\n  ⎿ list_dir path=.\n    ✓ src/ package.json\n    ✗ 错误：没有这个文件\n");
  const ascii: string[] = [];
  const pa = new ToolPrinter({ write: (s: string) => { ascii.push(s); return true; } } as unknown as NodeJS.WriteStream, false, { unicode: false });
  pa.call("tool_start", { name: "shell", arguments: {} });
  pa.call("tool_result", { result: "ok" });
  expect(ascii.join("")).toBe("  `- shell\n    + ok\n");
  // 打印前后的钩子（REPL 用来收起 / 恢复 spinner）。
  const order: string[] = [];
  const ph = new ToolPrinter({ write: () => { order.push("write"); return true; } } as unknown as NodeJS.WriteStream, false);
  ph.onBeforeWrite = () => order.push("before");
  ph.onAfterWrite = () => order.push("after");
  ph.call("tool_start", { name: "x" });
  expect(order).toEqual(["before", "write", "after"]);
});
