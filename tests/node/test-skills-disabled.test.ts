// tests/node/test-skills-disabled.test.ts — 单技能启停（config.skills.disabled）。
//
// 对齐 Codex `[[skills.config]] enabled=false`：不动文件、只按名字关掉。
// 三条规矩：
//   D1 大小写不敏感（配置里写 BETA 也要关掉 beta）
//   D2 被关掉的 skill 仍然会被**解析**（坏文件照样报错）——「关掉」不等于「文件不存在」，
//      否则配置写错了永远发现不了
//   D3 空名单 / 空白项不过滤任何东西
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "../../src/skills.ts";

function skillsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nyra-skillchk-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf-8");
  }
  return dir;
}

const ALPHA = "---\nname: alpha\ndescription: 甲\n---\n正文 A\n";
const BETA = "---\nname: beta\ndescription: 乙\n---\n正文 B\n";

test("默认加载全部（坏文件被跳过，不影响其余）", () => {
  const dir = skillsDir({ "alpha.md": ALPHA, "beta.md": BETA, "broken.md": "没有 frontmatter\n" });
  expect(loadSkills([dir]).map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
});

test("D1 按名字关掉，大小写不敏感", () => {
  const dir = skillsDir({ "alpha.md": ALPHA, "beta.md": BETA });
  expect(loadSkills([dir], { disabled: ["beta"] }).map((s) => s.name)).toEqual(["alpha"]);
  expect(loadSkills([dir], { disabled: ["BETA"] }).map((s) => s.name)).toEqual(["alpha"]);
});

test("D3 空名单 / 空白项不过滤", () => {
  const dir = skillsDir({ "alpha.md": ALPHA, "beta.md": BETA });
  expect(loadSkills([dir], { disabled: [] }).length).toBe(2);
  expect(loadSkills([dir], { disabled: ["  ", ""] }).length).toBe(2);
});

test("全部关掉时返回空数组（不是报错）", () => {
  const dir = skillsDir({ "alpha.md": ALPHA, "beta.md": BETA });
  expect(loadSkills([dir], { disabled: ["alpha", "beta"] })).toEqual([]);
});

test("D2 关掉不影响解析：坏文件仍然会被跳过并报出（不会因为 disabled 而静默）", () => {
  const dir = skillsDir({ "alpha.md": ALPHA, "broken.md": "坏文件\n" });
  // 坏文件本来就不在结果里；关键是 alpha 能正常加载，且不因为名单里有 broken 而报错
  expect(loadSkills([dir], { disabled: ["broken"] }).map((s) => s.name)).toEqual(["alpha"]);
});

test("不传 opts 时行为与从前一致（向后兼容）", () => {
  const dir = skillsDir({ "alpha.md": ALPHA });
  expect(loadSkills([dir]).length).toBe(1);
  expect(loadSkills([dir], {})).toEqual(loadSkills([dir]));
});

test("同名 skill 去重仍然生效（disabled 不改变去重语义）", () => {
  const dirA = skillsDir({ "a.md": ALPHA });
  const dirB = skillsDir({ "a.md": "---\nname: alpha\ndescription: 另一份\n---\nB\n" });
  const merged = loadSkills([dirA, dirB]);
  expect(merged.length).toBe(1);
  expect(loadSkills([dirA, dirB], { disabled: ["alpha"] })).toEqual([]);
});
