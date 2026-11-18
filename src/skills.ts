// src/skills.ts — Markdown 技能加载/匹配/保存，与 Python 版 nyra/skills.py 同语义。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  when: string;
  keywords: string[];
  instructions: string;
  path: string;
}

export function parseSkillFile(path: string): Skill {
  const lines = readFileSync(path, "utf-8").split("\n");
  const formatError = `Skill 文件格式错误（缺少 frontmatter）: ${path}`;
  if (!lines.length || lines[0] !== "---") throw new Error(formatError);
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) throw new Error(formatError);
  const metadata: Record<string, string> = {};
  for (const line of lines.slice(1, closingIndex)) {
    const idx = line.indexOf(":");
    if (idx !== -1) {
      const key = line.slice(0, idx).trim();
      if (["name", "description", "when", "keywords"].includes(key)) {
        metadata[key] = line.slice(idx + 1).trim();
      }
    }
  }
  const name = metadata.name ?? "";
  if (!name) throw new Error(`Skill 缺少 name: ${path}`);
  const keywords = (metadata.keywords ?? "")
    .replace(/、/g, ",")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const bodyLines = lines.slice(closingIndex + 1);
  let start = 0;
  let end = bodyLines.length;
  while (start < end && !bodyLines[start].trim()) start++;
  while (end > start && !bodyLines[end - 1].trim()) end--;
  return {
    name,
    description: metadata.description ?? "",
    when: metadata.when ?? "",
    keywords,
    instructions: bodyLines.slice(start, end).join("\n"),
    path,
  };
}

export function loadSkills(dirs: string[]): Skill[] {
  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const directory of dirs) {
    if (!existsSync(directory)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(directory).filter((f) => f.endsWith(".md")).sort().map((f) => join(directory, f));
    } catch {
      continue;
    }
    for (const path of files) {
      let skill: Skill;
      try {
        skill = parseSkillFile(path);
      } catch (err: unknown) {
        console.error(`跳过无效 skill 文件 ${path}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        skills.push(skill);
      }
    }
  }
  return skills;
}

export function matchSkills(task: string, skills: Skill[], topN = 2): Skill[] {
  if (!task || !skills.length || topN <= 0) return [];
  const taskText = task.toLowerCase();
  const scored: [number, Skill][] = [];
  for (const skill of skills) {
    let score = 0;
    for (const keyword of skill.keywords) {
      if (keyword.toLowerCase() && taskText.includes(keyword.toLowerCase())) score += 1;
    }
    if (skill.name.toLowerCase() && taskText.includes(skill.name.toLowerCase())) score += 3;
    if (skill.description.split(/\s+/).some((w) => w.length > 1 && taskText.includes(w.toLowerCase()))) score += 1;
    if (score > 0) scored.push([score, skill]);
  }
  scored.sort((a, b) => (b[0] - a[0]) || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, topN).map(([, s]) => s);
}

export function renderSkill(skill: Skill): string {
  const lines = [`## Skill: ${skill.name}`];
  if (skill.description) lines.push(skill.description);
  if (skill.when) lines.push(`何时使用：${skill.when}`);
  lines.push(skill.instructions);
  return lines.join("\n");
}

export function saveSkillFile(
  skillsDir: string,
  name: string,
  description: string,
  when: string,
  keywords: string[],
  instructions: string,
): string {
  const alphanumeric = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const allowed = new Set((alphanumeric + "_-").split(""));
  if (!name || !alphanumeric.includes(name[0]) || [...name].some((c) => !allowed.has(c))) {
    throw new Error("Skill 名称只允许字母、数字、- 和 _");
  }
  mkdirSync(skillsDir, { recursive: true });
  const path = join(skillsDir, `${name}.md`);
  let content =
    "---\n" +
    `name: ${name}\n` +
    `description: ${description}\n` +
    `when: ${when}\n` +
    `keywords: ${keywords.join(", ")}\n` +
    "---\n" +
    instructions;
  if (!content.endsWith("\n")) content += "\n";
  writeFileSync(path, content, "utf-8");
  return path;
}
