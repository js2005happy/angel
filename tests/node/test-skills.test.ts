// tests/node/test-skills.test.ts — 对应 tests/test_skill_deep_thinking.py（4 唯一）+ 技能加载/匹配行为。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillFile, loadSkills, matchSkills, renderSkill, saveSkillFile, parseSkillText, skillIndex, matchSkillsByPaths, readSkillBody, matchGlob, SKILL_INDEX_DESC_CHARS } from "../../src/skills.ts";
import { newToolContext, executeTool } from "../../src/tools.ts";
import { Agent, toTouchedPath } from "../../src/agent.ts";

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

// ---- 调研报告第 2 项：技能渐进披露 + 分层 / 路径触发加载 ----

function pathSkillDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nyra-skills-paths-"));
  writeFileSync(join(dir, "ts-review.md"), `---
name: ts-review
description: TypeScript 代码评审
when: 改 TypeScript 代码时
keywords: 评审, typescript
paths: src/**/*.ts
---
# TS 评审

先跑类型检查再评审。
`);
  writeFileSync(join(dir, "docs-guide.md"), `---
name: docs-guide
description: 文档写作指南
when: 写文档时
keywords: 文档
paths: docs/*.md
---
# 文档指南

文档要写中文。
`);
  writeFileSync(join(dir, "single.md"), `---
name: single-char
description: 单字符 glob 技能
when: 测试时
keywords: 单字符
paths: [src/?.ts, lib/*.js]
---
# 单字符

问号只匹配一个字符。
`);
  return dir;
}

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  calls: Record<string, unknown>[][] = [];
  script: Record<string, unknown>[];
  idx = 0;
  constructor(script: Record<string, unknown>[]) { this.script = script; }
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(messages: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    this.calls.push(messages);
    const next = this.script[Math.min(this.idx, this.script.length - 1)];
    this.idx += 1;
    return next;
  }
}

test("SkillsTest.test_parse_skill_paths", () => {
  const dir = pathSkillDir();
  const ts = parseSkillFile(join(dir, "ts-review.md"));
  expect(ts.paths).toEqual(["src/**/*.ts"]);
  // 括号写法同样解析。
  const single = parseSkillFile(join(dir, "single.md"));
  expect(single.paths).toEqual(["src/?.ts", "lib/*.js"]);
  // 没写 paths 的旧技能：paths 保持 undefined，行为与以前一致。
  const debug = parseSkillFile(join(skillDir(), "debug.md"));
  expect(debug.paths).toBeUndefined();
  // 文本解析同样支持 paths。
  const fromText = parseSkillText("---\nname: x\ndescription: d\npaths: a/*.md, b/**/*.ts\n---\n内容\n", "inline");
  expect(fromText.paths).toEqual(["a/*.md", "b/**/*.ts"]);
});

test("SkillsTest.test_match_glob", () => {
  // `**` 递归多层，也含 0 层。
  expect(matchGlob("src/**/*.ts", "src/deep/nested/file.ts")).toBe(true);
  expect(matchGlob("src/**/*.ts", "src/a.ts")).toBe(true);
  // `*.md` 只匹配单层。
  expect(matchGlob("docs/*.md", "docs/guide.md")).toBe(true);
  expect(matchGlob("docs/*.md", "docs/sub/guide.md")).toBe(false);
  // 不命中。
  expect(matchGlob("src/**/*.ts", "other/x.ts")).toBe(false);
  expect(matchGlob("src/**/*.ts", "src/a.js")).toBe(false);
  // `?` 只匹配单个字符。
  expect(matchGlob("src/?.ts", "src/a.ts")).toBe(true);
  expect(matchGlob("src/?.ts", "src/ab.ts")).toBe(false);
  // Windows 分隔符统一转 `/` 再匹配。
  expect(matchGlob("src/**/*.ts", "src\\deep\\file.ts")).toBe(true);
  expect(matchGlob("docs/*.md", "docs\\guide.md")).toBe(true);
});

test("SkillsTest.test_skill_index_truncates_about_100_chars", () => {
  expect(SKILL_INDEX_DESC_CHARS).toBe(100);
  const longDesc = "描".repeat(150);
  const index = skillIndex([{ name: "long", description: longDesc, when: "", keywords: [], instructions: "x", path: "p" }]);
  const line = index.split("\n")[0];
  expect(line.startsWith("long — ")).toBe(true);
  const shown = line.slice("long — ".length);
  expect(shown.endsWith("…")).toBe(true);
  expect([...shown].length).toBe(101); // 100 字描述 + `…`
  // 短描述不截断、不加 `…`；空描述只剩技能名。
  const short = skillIndex([
    { name: "a", description: "短描述", when: "", keywords: [], instructions: "x", path: "p" },
    { name: "b", description: "", when: "", keywords: [], instructions: "x", path: "p" },
  ]);
  expect(short).toBe("a — 短描述\nb");
});

test("SkillsTest.test_match_skills_ignores_paths_old_behavior", () => {
  const dir = pathSkillDir();
  const skills = loadSkills([dir]);
  // 只提文件路径、不提关键词时，关键词匹配不受 paths 影响：旧行为不变。
  expect(matchSkills("src/deep/file.ts 改一下", skills, 2)).toEqual([]);
  // 关键词行为本身不变。
  expect(matchSkills("这段 typescript 代码请评审", skills, 2)[0].name).toBe("ts-review");
  expect(matchSkills("文档怎么写", skills, 1).length).toBe(1);
});

test("SkillsTest.test_match_skills_by_paths_dedup_and_sort", () => {
  const dir = pathSkillDir();
  const skills = loadSkills([dir]);
  // `**` 递归命中 + `*.md` 单层命中。
  expect(matchSkillsByPaths(["src/deep/file.ts"], skills).map((s) => s.name)).toEqual(["ts-review"]);
  expect(matchSkillsByPaths(["docs/guide.md"], skills).map((s) => s.name)).toEqual(["docs-guide"]);
  expect(matchSkillsByPaths(["docs/sub/guide.md"], skills)).toEqual([]);
  // 同一技能命中两个文件只返回一次；多个技能按名排序。
  const hit = matchSkillsByPaths(["src/a.ts", "src/b.ts", "docs/x.md", "lib/y.js"], skills);
  expect(hit.map((s) => s.name)).toEqual(["docs-guide", "single-char", "ts-review"]);
  expect(matchSkillsByPaths([], skills)).toEqual([]);
  expect(matchSkillsByPaths(["src/a.ts"], [])).toEqual([]);
});

test("SkillsTest.test_read_skill_body", () => {
  const dir = pathSkillDir();
  const skills = loadSkills([dir]);
  const body = readSkillBody(skills, "ts-review");
  expect(body).toContain("## Skill: ts-review");
  expect(body).toContain("先跑类型检查再评审");
  expect(readSkillBody(skills, "不存在的技能")).toBeNull();
});

test("SkillsTest.test_read_skill_tool", async () => {
  const dir = pathSkillDir();
  // 没传 getSkills 时回退到从 skillsDir 现场加载。
  const ctx = newToolContext({ workdir: tmpdir(), mode: "full", interactive: false, skillsDir: dir });
  const out = await executeTool("read_skill", { name: "docs-guide" }, ctx);
  expect(out).toContain("## Skill: docs-guide");
  expect(out).toContain("文档要写中文");
  // 不存在的技能名：清楚的错误 + 可用技能列表，不抛异常。
  const missing = await executeTool("read_skill", { name: "no-such-skill" }, ctx);
  expect(missing).toContain("错误：没有名为 no-such-skill 的技能");
  expect(missing).toContain("docs-guide");
  expect(missing).toContain("ts-review");
  // 空名同样是清楚的错误。
  expect(await executeTool("read_skill", { name: "  " }, ctx)).toContain("错误：read_skill 需要技能名");
  // getSkills 闭包（Agent 接线）优先于 skillsDir。
  const skills = loadSkills([dir]);
  const ctx2 = newToolContext({
    workdir: tmpdir(), mode: "full", interactive: false,
    skillsDir: "/tmp/no-such-dir-xyz", getSkills: () => skills,
  });
  expect(await executeTool("read_skill", { name: "ts-review" }, ctx2)).toContain("先跑类型检查再评审");
});

test("SkillsTest.test_layered_loading_project_overrides_global", () => {
  const globalDir = mkdtempSync(join(tmpdir(), "nyra-skills-global-"));
  const projectDir = mkdtempSync(join(tmpdir(), "nyra-skills-project-"));
  const write = (d: string, desc: string) => writeFileSync(join(d, "shared.md"), `---\nname: shared\ndescription: ${desc}\nwhen: 测试\nkeywords: 共享\n---\n${desc}\n`);
  write(globalDir, "全局版");
  write(projectDir, "项目版");
  // loadSkills 是“先加载的赢”（seen 去重）：项目目录在前，同名技能项目层覆盖全局层。
  expect(loadSkills([projectDir, globalDir])[0].description).toBe("项目版");
  // 顺序反过来则全局版赢——顺序即优先级，写清楚、不改去重语义。
  expect(loadSkills([globalDir, projectDir])[0].description).toBe("全局版");
});

test("SkillsTest.test_agent_default_skills_dirs_project_first", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-agent-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-agent-wd-"));
  mkdirSync(join(workdir, "skills"), { recursive: true });
  mkdirSync(join(workdir, ".nyra", "skills"), { recursive: true });
  mkdirSync(join(home, "skills"), { recursive: true });
  const write = (d: string, desc: string) => writeFileSync(join(d, "shared.md"), `---\nname: shared\ndescription: ${desc}\nwhen: 测试\nkeywords: 共享\n---\n${desc}\n`);
  write(join(home, "skills"), "全局版");
  write(join(workdir, "skills"), "项目版");
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "auto" });
  // 默认顺序：项目层在前、全局层居中、插件层最后；同名技能项目层优先。
  // canonicalSkillDirs 返回 POSIX 形式（Windows 上也是 /，见技能目录归一化修复），
  // 所以期望值同样归一化；Linux/macOS 上 replace 是空操作。
  const posix = (p: string): string => p.replace(/\\/g, "/");
  expect(agent.skillsDirs[0]).toBe(posix(join(workdir, "skills")));
  expect(agent.skillsDirs[1]).toBe(posix(join(workdir, ".nyra", "skills")));
  expect(agent.skillsDirs[2]).toBe(posix(join(home, "skills")));
  expect(agent.skills.find((s) => s.name === "shared")?.description).toBe("项目版");
});

test("SkillsTest.test_agent_build_system_prompt_progressive_disclosure", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-agent-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-agent-wd-"));
  const agent = new Agent(new FakeProvider([]) as never, { workdir, home, mode: "auto", skillsDirs: [pathSkillDir()] });
  const prompt = agent.buildSystemPrompt("这段 typescript 代码请评审");
  // 常驻段：技能索引里三个技能都在，只有约 100 字描述。
  expect(prompt).toContain("## 技能索引");
  expect(prompt).toContain("ts-review — TypeScript 代码评审");
  expect(prompt).toContain("docs-guide — 文档写作指南");
  // 全文段：只有关键词命中的 ts-review 全文；未命中的 docs-guide 全文不在提示词里。
  expect(prompt).toContain("先跑类型检查再评审");
  expect(prompt).not.toContain("文档要写中文");
  // 路径触发：调用方传入本轮触碰路径，docs-guide 全文随之进入全文段。
  const withPath = agent.buildSystemPrompt("随便做点事", ["docs/guide.md"]);
  expect(withPath).toContain("文档要写中文");
  // 索引有缓存：技能集合不变时两次结果一致（且不依赖重复拼字符串）。
  expect(agent.skillIndexText()).toBe(agent.skillIndexText());
  expect(agent.buildSystemPrompt("这段 typescript 代码请评审")).toBe(prompt);
});

test("SkillsTest.test_agent_run_path_trigger_injects_into_tool_result", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-agent-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-agent-wd-"));
  mkdirSync(join(workdir, "docs"), { recursive: true });
  writeFileSync(join(workdir, "docs", "guide.md"), "# 指南\n内容\n");
  const provider = new FakeProvider([
    { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "docs/guide.md" }) } }] } }] },
    { choices: [{ message: { content: "读完了", tool_calls: [] } }] },
  ]);
  const agent = new Agent(provider as never, { workdir, home, mode: "full", skillsDirs: [pathSkillDir()] });
  const final = await agent.run("读一下指南文件");
  expect(final).toBe("读完了");
  // 第二轮模型收到的 tool 消息里，路径触发的技能全文已追加在工具结果后。
  const secondCall = provider.calls[1] as Record<string, unknown>[];
  const toolMsg = secondCall.find((m) => m.role === "tool") as Record<string, unknown>;
  expect(String(toolMsg.content)).toContain("## 路径触发的技能");
  expect(String(toolMsg.content)).toContain("文档要写中文");
  // 同一技能一轮里只注入一次：工具结果里只出现一次技能标题。
  expect(String(toolMsg.content).split("## Skill: docs-guide").length - 1).toBe(1);
});

test("SkillsTest.test_to_touched_path", () => {
  expect(toTouchedPath("/tmp/wd", "/tmp/wd/src/a.ts")).toBe("src/a.ts");
  expect(toTouchedPath("/tmp/wd", "src/a.ts")).toBe("src/a.ts");
  expect(toTouchedPath(".", "./src/a.ts")).toBe("src/a.ts");
  expect(toTouchedPath(".", "src/a.ts")).toBe("src/a.ts");
  expect(toTouchedPath("/tmp/wd", "src\\a.ts")).toBe("src/a.ts");
});
