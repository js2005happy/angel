// tests/node/test-skills-inline.test.ts — S3：技能 frontmatter 扩展 + `!`cmd`` 动态注入。
// 覆盖三件容易回归的事：
//   1) allowed-tools / model 能被解析出来（旧技能没写这两个字段时不受影响）
//   2) 默认不执行内联命令（contextUsage 也调 renderSkill，凭空执行会产生副作用）
//   3) 危险命令被拦截、失败命令降级为说明而不是抛错
import { test, expect } from "bun:test";
import { parseSkillText, renderSkill, expandInlineCommands } from "../../src/skills.ts";

const SAMPLE = `---
name: pr-summary
description: 汇总 PR 改动
when: 需要总结 PR 时
keywords: pr, summary
allowed-tools: Read, Grep, Bash(git *)
model: deepseek-v4-flash
paths: src/**/*.ts
---
## PR 上下文
- 分支: !\`echo feature-branch\`
请汇总。
`;

test("解析 allowed-tools / model / paths", () => {
  const skill = parseSkillText(SAMPLE, "/tmp/pr-summary.md");
  expect(skill.name).toBe("pr-summary");
  expect(skill.allowedTools).toEqual(["Read", "Grep", "Bash(git *)"]);
  expect(skill.model).toBe("deepseek-v4-flash");
  expect(skill.paths).toEqual(["src/**/*.ts"]);
});

test("旧技能没有新字段时仍是合法技能", () => {
  const legacy = `---\nname: plain\ndescription: 老技能\n---\n正文`;
  const skill = parseSkillText(legacy, "/tmp/plain.md");
  expect(skill.allowedTools).toBeUndefined();
  expect(skill.model).toBeUndefined();
  expect(skill.paths).toBeUndefined();
  expect(skill.instructions).toBe("正文");
});

test("默认不执行内联命令，保留占位", () => {
  const skill = parseSkillText(SAMPLE, "/tmp/pr-summary.md");
  const out = renderSkill(skill);
  expect(out).toContain("未执行");
  expect(out).not.toContain("feature-branch");
});

test("显式开启后注入真实命令输出", () => {
  const skill = parseSkillText(SAMPLE, "/tmp/pr-summary.md");
  const out = renderSkill(skill, { execute: true });
  expect(out).toContain("feature-branch");
  expect(out).not.toContain("未执行");
});

test("渲染头部带上声明的工具与建议模型", () => {
  const skill = parseSkillText(SAMPLE, "/tmp/pr-summary.md");
  const out = renderSkill(skill);
  expect(out).toContain("本技能声明的可用工具");
  expect(out).toContain("Bash(git *)");
  expect(out).toContain("建议模型：deepseek-v4-flash");
});

test("危险命令被拦截", () => {
  const out = expandInlineCommands("!\`sudo rm -rf /\`", "evil", { execute: true });
  expect(out).toContain("已拒绝执行");
});

test("命令失败降级为说明，不抛异常", () => {
  const out = expandInlineCommands("!\`command-that-does-not-exist-xyz\`", "x", { execute: true });
  expect(out).toContain("命令失败");
});

test("输出过长会截断", () => {
  const long = "a".repeat(6000);
  const out = expandInlineCommands("!\`echo " + long + "\`", "x", { execute: true, maxOutputChars: 100 });
  expect(out).toContain("输出已截断");
  expect(out.length).toBeLessThan(400);
});
