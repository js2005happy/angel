// tests/node/test-plugins.test.ts — 第 4 阶段最小插件市场。
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PluginError, installPlugin, uninstallPlugin, listPlugins, verifyPlugin,
  setPluginStatus, setPluginPinned, pluginSkillDirs, recordUse,
  refreshLifecycle, auditPlugins, searchRegistry, loadLock, saveLock,
  pluginsDir,
} from "../../src/plugins.ts";

function home(): string {
  const h = join(tmpdir(), `nyra-plugins-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(h, { recursive: true });
  return h;
}

function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: 测试技能 ${name}\nwhen: 测试时\nkeywords: 测试\n---\n指令：${name}。\n`;
}

function makePluginDir(skills: string[], opts: { name?: string; version?: string; manifestSkills?: string[] } = {}): string {
  const dir = join(tmpdir(), `nyra-plugin-src-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "skills"), { recursive: true });
  for (const s of skills) writeFileSync(join(dir, "skills", `${s}.md`), skillFile(s), "utf-8");
  const manifest = {
    name: opts.name ?? "demo-plugin",
    version: opts.version ?? "1.0.0",
    description: "演示插件",
    author: "test",
    license: "MIT",
    skills: opts.manifestSkills ?? skills,
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return dir;
}

test("PluginsTest.test_install_from_local_dir_and_verify", () => {
  const h = home();
  const src = makePluginDir(["alpha-skill"]);
  const res = installPlugin(h, src);
  expect(res.name).toBe("demo-plugin");
  expect(res.upgraded).toBe(false);
  expect(res.keptModified).toEqual([]);
  expect(existsSync(join(pluginsDir(h), "demo-plugin", "skills", "alpha-skill.md"))).toBe(true);
  const list = listPlugins(h);
  expect(list.length).toBe(1);
  expect(list[0].status).toBe("active");
  expect(list[0].files["skills/alpha-skill.md"]).toBeDefined();
  expect(verifyPlugin(h, "demo-plugin").ok).toBe(true);
  expect(pluginSkillDirs(h)).toEqual([join(pluginsDir(h), "demo-plugin", "skills")]);
});

test("PluginsTest.test_install_rejects_builtin_skill_name", () => {
  const h = home();
  const src = makePluginDir(["deep-thinking"]);
  expect(() => installPlugin(h, src)).toThrow(PluginError);
  expect(listPlugins(h)).toEqual([]);
});

test("PluginsTest.test_install_rejects_manifest_file_mismatch", () => {
  const h = home();
  const src = makePluginDir(["alpha-skill"], { manifestSkills: ["alpha-skill", "missing-skill"] });
  expect(() => installPlugin(h, src)).toThrow(PluginError);
  const src2 = makePluginDir(["alpha-skill", "extra-skill"], { manifestSkills: ["alpha-skill"] });
  expect(() => installPlugin(h, src2)).toThrow(PluginError);
});

test("PluginsTest.test_install_rejects_skill_name_collision_across_plugins", () => {
  const h = home();
  installPlugin(h, makePluginDir(["shared-skill"], { name: "first-plugin" }));
  expect(() => installPlugin(h, makePluginDir(["shared-skill"], { name: "second-plugin" }))).toThrow(PluginError);
});

test("PluginsTest.test_upgrade_keeps_user_modified_skill", () => {
  const h = home();
  const v1 = makePluginDir(["alpha-skill"], { version: "1.0.0" });
  installPlugin(h, v1);
  const installed = join(pluginsDir(h), "demo-plugin", "skills", "alpha-skill.md");
  writeFileSync(installed, skillFile("alpha-skill") + "用户手改的补充。\n", "utf-8");
  const v2 = makePluginDir(["alpha-skill", "beta-skill"], { version: "1.1.0" });
  const res = installPlugin(h, v2);
  expect(res.upgraded).toBe(true);
  expect(res.keptModified).toContain("skills/alpha-skill.md");
  expect(readFileSync(installed, "utf-8")).toContain("用户手改的补充");
  expect(existsSync(join(pluginsDir(h), "demo-plugin", "skills", "beta-skill.md"))).toBe(true);
  const rec = listPlugins(h)[0];
  expect(rec.version).toBe("1.1.0");
  const v = verifyPlugin(h, "demo-plugin");
  expect(v.ok).toBe(true);
  expect(v.files.find((f) => f.rel === "skills/alpha-skill.md")?.state).toBe("held");
});

test("PluginsTest.test_verify_detects_tampering", () => {
  const h = home();
  installPlugin(h, makePluginDir(["alpha-skill"]));
  const installed = join(pluginsDir(h), "demo-plugin", "skills", "alpha-skill.md");
  writeFileSync(installed, skillFile("alpha-skill") + "篡改。\n", "utf-8");
  const v = verifyPlugin(h, "demo-plugin");
  expect(v.ok).toBe(false);
  expect(v.files.find((f) => f.rel === "skills/alpha-skill.md")?.state).toBe("modified");
});

test("PluginsTest.test_uninstall_removes_only_unmodified_files", () => {
  const h = home();
  installPlugin(h, makePluginDir(["alpha-skill", "beta-skill"]));
  const modified = join(pluginsDir(h), "demo-plugin", "skills", "alpha-skill.md");
  writeFileSync(modified, skillFile("alpha-skill") + "用户改过。\n", "utf-8");
  const res = uninstallPlugin(h, "demo-plugin");
  expect(res.removed).toContain("skills/beta-skill.md");
  expect(res.keptModified).toContain("skills/alpha-skill.md");
  expect(existsSync(modified)).toBe(true);
  expect(existsSync(join(pluginsDir(h), "demo-plugin", "skills", "beta-skill.md"))).toBe(false);
  expect(listPlugins(h)).toEqual([]);
  expect(() => uninstallPlugin(h, "demo-plugin")).toThrow(PluginError);
});

test("PluginsTest.test_disable_excludes_skill_dirs", () => {
  const h = home();
  installPlugin(h, makePluginDir(["alpha-skill"]));
  setPluginStatus(h, "demo-plugin", "disabled");
  expect(pluginSkillDirs(h)).toEqual([]);
  setPluginStatus(h, "demo-plugin", "active");
  expect(pluginSkillDirs(h).length).toBe(1);
});

test("PluginsTest.test_lifecycle_stale_after_90_days_without_use", () => {
  const h = home();
  installPlugin(h, makePluginDir(["alpha-skill"]));
  const lock = loadLock(h);
  lock.plugins["demo-plugin"].installed_at = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
  saveLock(h, lock);
  const changed = refreshLifecycle(h);
  expect(changed).toEqual(["demo-plugin"]);
  expect(listPlugins(h)[0].status).toBe("stale");
  expect(pluginSkillDirs(h)).toEqual([]);
});

test("PluginsTest.test_recent_use_prevents_stale", () => {
  const h = home();
  installPlugin(h, makePluginDir(["alpha-skill"]));
  const lock = loadLock(h);
  lock.plugins["demo-plugin"].installed_at = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
  saveLock(h, lock);
  recordUse(h, "demo-plugin", "alpha-skill");
  expect(refreshLifecycle(h)).toEqual([]);
  expect(listPlugins(h)[0].status).toBe("active");
});

test("PluginsTest.test_pinned_does_not_exempt_stale", () => {
  const h = home();
  installPlugin(h, makePluginDir(["alpha-skill"]));
  setPluginPinned(h, "demo-plugin", true);
  const lock = loadLock(h);
  lock.plugins["demo-plugin"].installed_at = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
  saveLock(h, lock);
  expect(refreshLifecycle(h)).toEqual(["demo-plugin"]);
  expect(listPlugins(h)[0].pinned).toBe(true);
});

test("PluginsTest.test_audit_reports_stale_and_verification", () => {
  const h = home();
  installPlugin(h, makePluginDir(["alpha-skill"]));
  const audit = auditPlugins(h);
  expect(audit.staleNow).toEqual([]);
  expect(audit.verified.length).toBe(1);
  expect(audit.verified[0].ok).toBe(true);
});

test("PluginsTest.test_install_rejects_bad_source", () => {
  const h = home();
  expect(() => installPlugin(h, "/不存在的目录")).toThrow(PluginError);
  expect(() => installPlugin(h, "http://example.com/plugin.git")).toThrow(PluginError);
  expect(() => installPlugin(h, "")).toThrow(PluginError);
});

test("PluginsTest.test_search_registry_reads_user_registry", () => {
  const h = home();
  mkdirSync(pluginsDir(h), { recursive: true });
  writeFileSync(
    join(pluginsDir(h), "registry.json"),
    JSON.stringify({ plugins: [
      { name: "cat-guide", version: "0.1.0", description: "猫咪养护技能包", source: "https://example.invalid/cat-guide.git" },
      { name: "dog-guide", version: "0.1.0", description: "犬类技能包", source: "https://example.invalid/dog-guide.git" },
    ] }, null, 2),
    "utf-8",
  );
  expect(searchRegistry(h).map((e) => e.name)).toEqual(["cat-guide", "dog-guide"]);
  expect(searchRegistry(h, "猫咪").map((e) => e.name)).toEqual(["cat-guide"]);
});
