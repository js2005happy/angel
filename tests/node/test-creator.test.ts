// tests/node/test-creator.test.ts — 第 4 阶段创造模式（Creator Mode）。
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CREATOR_SKILL_TEXT, CREATOR_SKILL_NAME, CreatorError,
  matchBuiltinPattern, slugFor, buildSpec, renderSpec, writeCreatorSpec,
  buildBuiltinPlugin, verifyStagedPlugin, installStagedPlugin,
  describePlannedChanges, checkPanelSelfContained, runCreator,
  creatorDir, specPathFor, stagingDirFor,
} from "../../src/creator.ts";
import { listPlugins, uninstallPlugin, pluginsDir } from "../../src/plugins.ts";
import { parseSkillText } from "../../src/skills.ts";

function home(): string {
  const h = join(tmpdir(), `nyra-creator-home-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(h, { recursive: true });
  return h;
}

function workdir(): string {
  const w = join(tmpdir(), `nyra-creator-work-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(w, { recursive: true });
  return w;
}

test("CreatorTest.test_builtin_skill_matches_file", () => {
  const file = readFileSync(resolve(import.meta.dir, "../../skills/creator-mode.md"), "utf-8");
  expect(CREATOR_SKILL_TEXT).toBe(file);
  expect(CREATOR_SKILL_NAME).toBe("creator-mode");
  const parsed = parseSkillText(CREATOR_SKILL_TEXT, "builtin:creator-mode");
  expect(parsed.name).toBe("creator-mode");
  expect(parsed.keywords).toContain("番茄钟");
});

test("CreatorTest.test_match_builtin_pattern", () => {
  expect(matchBuiltinPattern("做个番茄钟")).toBe("pomodoro");
  expect(matchBuiltinPattern("帮我做一个倒计时")).toBe("pomodoro");
  expect(matchBuiltinPattern("pomodoro timer")).toBe("pomodoro");
  expect(matchBuiltinPattern("扫描 TODO")).toBe("todo-scan");
  expect(matchBuiltinPattern("帮我找找待办事项")).toBe("todo-scan");
  expect(matchBuiltinPattern("给我做个天气插件")).toBe(null);
  expect(matchBuiltinPattern("")).toBe(null);
});

test("CreatorTest.test_spec_written_and_rendered", () => {
  const w = workdir();
  const spec = buildSpec("做个番茄钟", "pomodoro");
  expect(spec.slug).toBe("pomodoro");
  expect(spec.tools).toContain("memory_append");
  expect(spec.permissions).toContain("network:none");
  const path = writeCreatorSpec(w, spec);
  expect(path).toBe(specPathFor(w, "pomodoro"));
  const text = readFileSync(path, "utf-8");
  expect(text).toBe(renderSpec(spec));
  expect(text).toContain("需求原文：做个番茄钟");
  expect(text).toContain("插件名：pomodoro");
  expect(existsSync(creatorDir(w, "pomodoro"))).toBe(true);
  expect(stagingDirFor(w, "pomodoro")).toContain("staging");
  expect(slugFor("给我做个天气插件", null)).toBe("给我做个天气插件");
});

test("CreatorTest.test_builtin_pomodoro_verifies", () => {
  const w = workdir();
  const staging = stagingDirFor(w, "pomodoro");
  buildBuiltinPlugin("pomodoro", staging);
  const report = verifyStagedPlugin(staging);
  expect(report.ok).toBe(true);
  expect(report.errors).toEqual([]);
  expect(report.manifest?.name).toBe("pomodoro");
  expect(report.tools).toEqual(["read_file", "write_file", "memory_append"]);
  expect(report.permissions).toEqual(["fs:write-workspace", "network:none"]);
  expect(report.files).toContain("plugin.json");
  expect(report.files).toContain("skills/pomodoro.md");
  expect(report.files).toContain("panel/pomodoro.html");
  expect(report.highPrivilegeTools).toEqual([]);
  const changes = describePlannedChanges(report);
  expect(changes).toContain("插件：pomodoro v0.1.0");
  expect(changes).toContain("panel/pomodoro.html");
  expect(changes).toContain("network:none");
});

test("CreatorTest.test_builtin_todo_scan_verifies", () => {
  const w = workdir();
  const staging = stagingDirFor(w, "todo-scan");
  buildBuiltinPlugin("todo-scan", staging);
  const report = verifyStagedPlugin(staging);
  expect(report.ok).toBe(true);
  expect(report.manifest?.name).toBe("todo-scan");
  expect(report.tools).toEqual(["grep_search", "list_dir", "read_file"]);
  expect(report.files).not.toContain("panel/pomodoro.html");
});

test("CreatorTest.test_verify_rejects_missing_skill_file", () => {
  const w = workdir();
  const staging = stagingDirFor(w, "broken");
  mkdirSync(join(staging, "skills"), { recursive: true });
  writeFileSync(join(staging, "plugin.json"), JSON.stringify({
    name: "broken", version: "0.1.0", skills: ["ghost"], tools: ["read_file"], permissions: ["fs:read-workspace"],
  }), "utf-8");
  const report = verifyStagedPlugin(staging);
  expect(report.ok).toBe(false);
  expect(report.errors.some((e) => e.includes("ghost"))).toBe(true);
});

test("CreatorTest.test_verify_rejects_unknown_tool", () => {
  const w = workdir();
  const staging = stagingDirFor(w, "todo-scan");
  buildBuiltinPlugin("todo-scan", staging);
  const manifestPath = join(staging, "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  manifest.tools = ["read_file", "magic_wand"];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  const report = verifyStagedPlugin(staging);
  expect(report.ok).toBe(false);
  expect(report.errors.some((e) => e.includes("magic_wand"))).toBe(true);
});

test("CreatorTest.test_verify_rejects_external_panel", () => {
  const w = workdir();
  const staging = stagingDirFor(w, "pomodoro");
  buildBuiltinPlugin("pomodoro", staging);
  writeFileSync(join(staging, "panel", "pomodoro.html"),
    "<html><head><script src=\"https://example.com/x.js\"></script></head><body>hi</body></html>", "utf-8");
  const report = verifyStagedPlugin(staging);
  expect(report.ok).toBe(false);
  expect(report.errors.some((e) => e.includes("外部"))).toBe(true);
  expect(checkPanelSelfContained("<img src=\"https://example.com/a.png\">").length).toBe(1);
  expect(checkPanelSelfContained("<html><body>纯静态</body></html>")).toEqual([]);
});

test("CreatorTest.test_install_roundtrip", () => {
  const h = home();
  const w = workdir();
  const staging = stagingDirFor(w, "pomodoro");
  buildBuiltinPlugin("pomodoro", staging);
  const { install, report } = installStagedPlugin(h, staging);
  expect(install.name).toBe("pomodoro");
  expect(report.ok).toBe(true);
  expect(existsSync(join(pluginsDir(h), "pomodoro", "panel", "pomodoro.html"))).toBe(true);
  expect(listPlugins(h).map((p) => p.name)).toEqual(["pomodoro"]);
  const removed = uninstallPlugin(h, "pomodoro");
  expect(removed.removed).toContain("panel/pomodoro.html");
  expect(listPlugins(h)).toEqual([]);
});

test("CreatorTest.test_run_creator_pomodoro_auto_approve", async () => {
  const h = home();
  const w = workdir();
  const result = await runCreator("做个番茄钟", { home: h, workdir: w, autoApprove: true });
  expect(result.status).toBe("installed");
  expect(result.install?.name).toBe("pomodoro");
  expect(existsSync(result.specPath)).toBe(true);
  expect(listPlugins(h).length).toBe(1);
});

test("CreatorTest.test_run_creator_awaiting_approval_installs_nothing", async () => {
  const h = home();
  const w = workdir();
  const result = await runCreator("扫描 TODO", { home: h, workdir: w });
  expect(result.status).toBe("awaiting-approval");
  expect(result.spec.slug).toBe("todo-scan");
  expect(existsSync(result.specPath)).toBe(true);
  expect(listPlugins(h)).toEqual([]);
});

test("CreatorTest.test_run_creator_unknown_request_readable_error", async () => {
  const h = home();
  const w = workdir();
  let caught: unknown = null;
  try {
    await runCreator("给我做个天气插件", { home: h, workdir: w });
  } catch (err: unknown) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(CreatorError);
  expect(String((caught as Error).message)).toContain("没有现成的模板");
  expect(listPlugins(h)).toEqual([]);
  await expect(runCreator("   ", { home: h, workdir: w })).rejects.toThrow("需求不能为空");
});

test("CreatorTest.test_pomodoro_panel_timer_logic", () => {
  const w = workdir();
  const staging = stagingDirFor(w, "pomodoro");
  buildBuiltinPlugin("pomodoro", staging);
  const html = readFileSync(join(staging, "panel", "pomodoro.html"), "utf-8");
  // 面板自包含：除 <script> 本身外不许出现任何 http(s) 链接。
  expect(html.replace(/<script>[\s\S]*?<\/script>/, "")).not.toMatch(/https?:\/\//);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeDefined();
  // 最小 DOM 桩 + 假时钟，跑满 25 分钟专注 + 5 分钟休息。
  const els: Record<string, { textContent: string; listeners: Record<string, () => void>; addEventListener: (ev: string, fn: () => void) => void }> = {};
  const el = (id: string) => {
    if (!els[id]) els[id] = { textContent: "", listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; } };
    return els[id];
  };
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document;
  const prevSet = g.setInterval;
  const prevClear = g.clearInterval;
  let timers: { id: number; fn: () => void }[] = [];
  g.document = { getElementById: el };
  g.setInterval = (fn: () => void) => { const id = timers.length + 1; timers.push({ id, fn }); return id; };
  g.clearInterval = (id: number) => { timers = timers.filter((t) => t.id !== id); };
  try {
    new Function(script as string)();
    expect(els.time.textContent).toBe("25:00");
    expect(els.mode.textContent).toBe("专注");
    els.start.listeners.click();
    for (let i = 0; i < 25 * 60; i++) timers.forEach((t) => t.fn());
    expect(els.mode.textContent).toBe("休息");
    expect(els.time.textContent).toBe("05:00");
    expect(els.rounds.textContent).toBe("已完成 1 轮");
    for (let i = 0; i < 5 * 60; i++) timers.forEach((t) => t.fn());
    expect(els.mode.textContent).toBe("专注");
    expect(els.time.textContent).toBe("25:00");
  } finally {
    g.document = prevDoc;
    g.setInterval = prevSet;
    g.clearInterval = prevClear;
  }
});

test("CreatorTest.test_run_creator_verify_failure_installs_nothing", async () => {
  const h = home();
  const w = workdir();
  await expect(runCreator("给我做个天气插件", {
    home: h, workdir: w,
    generate: (_spec, stagingDir) => {
      // 模拟模型生成了坏插件：清单声明的技能缺文件。
      mkdirSync(join(stagingDir, "skills"), { recursive: true });
      writeFileSync(join(stagingDir, "plugin.json"), JSON.stringify({
        name: "weather", version: "0.1.0", skills: ["ghost"], tools: ["read_file"], permissions: ["fs:read-workspace"],
      }), "utf-8");
    },
  })).rejects.toThrow("验证未通过");
  expect(listPlugins(h)).toEqual([]);
});
