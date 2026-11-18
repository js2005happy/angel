// tests/node/test-skills.test.ts — 对应 tests/test_skill_deep_thinking.py（4 唯一）+ 技能加载/匹配行为。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillFile, loadSkills, matchSkills, renderSkill, saveSkillFile } from "../../src/skills.ts";

function skillDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nyra-skills-"));
  writeFileSync(join(dir, "debug.md"), `---
name: debugging
description: 调试技能
when: 修 bug 时
keywords: 调试, 复现, bug
---
# 调试

没有可变红的复现命令不许动手改。
`);
  writeFileSync(join(dir, "robot.md"), `---
name: robot-ops
description: 工业机器人操作
when: 操作机器人时
keywords: 机器人, 示教, 工业
---
# 机器人操作

先读手册再动手。
`);
  return dir;
}

test("SkillsTest.test_parse_skill_file", () => {
  const dir = skillDir();
  const skill = parseSkillFile(join(dir, "debug.md"));
  expect(skill.name).toBe("debugging");
  expect(skill.description).toBe("调试技能");
  expect(skill.when).toBe("修 bug 时");
  expect(skill.keywords).toContain("调试");
  expect(skill.keywords).toContain("复现");
  expect(skill.instructions).toContain("没有可变红的复现命令不许动手改");
  expect(skill.instructions).not.toContain("---");
});

test("SkillsTest.test_parse_requires_frontmatter", () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-skills-"));
  writeFileSync(join(dir, "bad.md"), "没有 frontmatter\n");
  expect(() => parseSkillFile(join(dir, "bad.md"))).toThrow();
  writeFileSync(join(dir, "noname.md"), "---\ndescription: x\n---\n内容\n");
  expect(() => parseSkillFile(join(dir, "noname.md"))).toThrow();
});

test("SkillsTest.test_load_skills_sorted_and_dedup", () => {
  const dir = skillDir();
  const skills = loadSkills([dir]);
  expect(skills.map((s) => s.name)).toEqual(["debugging", "robot-ops"]);
  const twice = loadSkills([dir, dir]);
  expect(twice.length).toBe(2);
});

test("SkillsTest.test_load_skills_skips_invalid_files", () => {
  const dir = skillDir();
  writeFileSync(join(dir, "broken.md"), "坏文件\n");
  const skills = loadSkills([dir]);
  expect(skills.length).toBe(2);
  expect(loadSkills(["/tmp/no-such-dir-xyz"])).toEqual([]);
});

test("SkillsTest.test_match_skills_keyword_and_name", () => {
  const dir = skillDir();
  const skills = loadSkills([dir]);
  const matched = matchSkills("机器人示教怎么操作", skills, 2);
  expect(matched.length).toBeGreaterThanOrEqual(1);
  expect(matched[0].name).toBe("robot-ops");
  const debugged = matchSkills("这个 bug 怎么复现和调试", skills, 2);
  expect(debugged[0].name).toBe("debugging");
});

test("SkillsTest.test_match_skills_top_n", () => {
  const dir = skillDir();
  const skills = loadSkills([dir]);
  expect(matchSkills("机器人", skills, 1).length).toBe(1);
  expect(matchSkills("完全不相关的话题天气", skills, 2).length).toBe(0);
});

test("SkillsTest.test_render_skill", () => {
  const dir = skillDir();
  const skill = parseSkillFile(join(dir, "debug.md"));
  const rendered = renderSkill(skill);
  expect(rendered).toContain("debugging");
  expect(rendered).toContain("调试技能");
  expect(rendered).toContain("没有可变红的复现命令");
});

test("SkillsTest.test_save_skill_file_validates_name", () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-skills-"));
  expect(() => saveSkillFile(dir, "bad name!", "d", "w", [], "x")).toThrow();
  expect(() => saveSkillFile(dir, "good-name_1", "d", "w", ["a"], "内容")).not.toThrow();
  expect(existsSync(join(dir, "good-name_1.md"))).toBe(true);
});

test("SkillsTest.test_debugging_skill_content", () => {
  const skill = parseSkillFile("skills/debugging.md");
  expect(skill.name).toBe("debugging");
  expect(skill.instructions).toContain("复现");
});
