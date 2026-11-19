// tests/node/test-skill-order.test.ts — 第十四批任务 4：
// --list-skills、网关状态 skills、agent 提示词技能索引三处顺序统一，
// 唯一来源是 src/skills.ts 的 canonicalSkillDirs / canonicalSkillOrder
//（分层加载顺序：项目 skills → 项目 .nyra/skills → 全局 skills → 插件 skills，
// 同目录内按文件名排序，同名先出现者胜；不按技能名排序）。
// 覆盖：三处技能名序列完全一致、改名/增删后仍一致、项目层覆盖全局层同名技能。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSkills, canonicalSkillDirs, canonicalSkillOrder, skillIndex,
} from "../../src/skills.ts";
import { pluginSkillDirs } from "../../src/plugins.ts";
import { Agent } from "../../src/agent.ts";
import { Gateway } from "../../src/gateway.ts";

const stubProvider = {
  async chat() { return { choices: [{ message: { content: "" } }] }; },
} as never;

function writeSkill(dir: string, file: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, file),
    `---\nname: ${name}\ndescription: ${description}\nwhen: 测试时\nkeywords: 测试\n---\n# ${name}\n\n内容。\n`,
    "utf-8",
  );
}

// 文件名顺序与技能名字母序故意错开：按文件名排是 zzz-last、aaa-first、mmm-mid，
// 按技能名排会是 aaa-first、mmm-mid、zzz-last——断言能区分两种顺序。
function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-skill-order-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-skill-order-wd-"));
  writeSkill(join(workdir, "skills"), "a-first.md", "zzz-last", "项目版 zzz");
  writeSkill(join(workdir, "skills"), "m-mid.md", "aaa-first", "aaa 技能");
  writeSkill(join(workdir, "skills"), "z-last.md", "mmm-mid", "mmm 技能");
  writeSkill(join(workdir, ".nyra", "skills"), "d-dot.md", "dotnyra-skill", "项目 .nyra 技能");
  writeSkill(join(home, "skills"), "h-home.md", "home-skill", "全局技能");
  // 同名技能：全局版应被项目版覆盖（先出现者胜，只留一条）。
  writeSkill(join(home, "skills"), "dup.md", "zzz-last", "全局版 zzz（应被覆盖）");
  return { home, workdir };
}

function agentNames(workdir: string, home: string): string[] {
  const agent = new Agent(stubProvider, { workdir, home, mode: "auto" });
  return agent.skillIndexText().split("\n").filter(Boolean).map((line) => line.split(" — ")[0]);
}

function cliNames(workdir: string, home: string): string[] {
  // 与 src/cli.ts --list-skills 完全相同的表达式（workdir 即进程工作目录）。
  return loadSkills(canonicalSkillDirs(workdir, home, pluginSkillDirs(home))).map((s) => s.name);
}

function gatewayNames(workdir: string, home: string): string[] {
  const gw = new Gateway({ home, workdir, config: { mcp_enabled: false, fallback_enabled: false } });
  const skills = (gw.info().skills as { name: string; description: string }[] | undefined) ?? [];
  return skills.map((s) => s.name);
}

test("SkillOrderTest.test_three_places_agree_on_canonical_order", () => {
  const { home, workdir } = setup();
  const expected = ["zzz-last", "aaa-first", "mmm-mid", "dotnyra-skill", "home-skill"];
  expect(agentNames(workdir, home)).toEqual(expected);
  expect(cliNames(workdir, home)).toEqual(expected);
  expect(gatewayNames(workdir, home)).toEqual(expected);
  // 项目层覆盖全局层：索引里 zzz-last 的描述是项目版，不是全局版。
  const agent = new Agent(stubProvider, { workdir, home, mode: "auto" });
  expect(agent.skillIndexText()).toContain("项目版 zzz");
  expect(agent.skillIndexText()).not.toContain("全局版 zzz");
});

test("SkillOrderTest.test_three_places_still_agree_after_rename_add_remove", () => {
  const { home, workdir } = setup();
  // 改名（m-mid.md → y-mid.md，文件名顺序变化）、新增、删除各一处。
  renameSync(join(workdir, "skills", "m-mid.md"), join(workdir, "skills", "y-mid.md"));
  writeSkill(join(workdir, "skills"), "b-new.md", "new-skill", "新增技能");
  unlinkSync(join(home, "skills", "h-home.md"));
  const expected = ["zzz-last", "new-skill", "aaa-first", "mmm-mid", "dotnyra-skill"];
  expect(agentNames(workdir, home)).toEqual(expected);
  expect(cliNames(workdir, home)).toEqual(expected);
  expect(gatewayNames(workdir, home)).toEqual(expected);
});

test("SkillOrderTest.test_skill_index_normalizes_to_canonical_order", () => {
  // skillIndex 本身也走规范顺序：同名去重（先出现者胜），其余保持输入顺序，不按名重排。
  const skills = [
    { name: "mmm-mid", description: "m", when: "", keywords: [], instructions: "x", path: "p1" },
    { name: "zzz-last", description: "z", when: "", keywords: [], instructions: "x", path: "p2" },
    { name: "mmm-mid", description: "重复", when: "", keywords: [], instructions: "x", path: "p3" },
  ];
  const lines = skillIndex(skills).split("\n");
  expect(lines).toEqual(["mmm-mid — m", "zzz-last — z"]);
  expect(canonicalSkillOrder(skills).map((s) => s.name)).toEqual(["mmm-mid", "zzz-last"]);
  expect(canonicalSkillDirs("/w", "/h", ["/p"])).toEqual(["/w/skills", "/w/.nyra/skills", "/h/skills", "/p"]);
});
