// src/skills.ts — Markdown 技能加载/匹配/保存，与 Python 版 nyra/skills.py 同语义。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  when: string;
  keywords: string[];
  // 调研报告第 2 项：技能渐进披露（学 Claude Code + OpenHands）——paths 触发。
  // 可选：逗号分隔的 glob（如 `src/**/*.ts, docs/*.md`，写在 frontmatter 的 paths: 行）。
  // agent 触碰到匹配的文件时，该技能全文才被确定性注入；平时只占索引里约 100 字。
  paths?: string[];
  instructions: string;
  path: string;
}

// 调研报告第 2 项：技能渐进披露（学 Claude Code + OpenHands）——30 行内的小 glob 匹配器，无新依赖。
// 支持 `**`（跨任意多层目录，含 0 层）、`*`（单层内任意字符）、`?`（单层内单个字符）。
// 路径分隔符统一转 `/` 再匹配，Windows 的 `\` 路径同样能命中。
export function matchGlob(pattern: string, filePath: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/");
  const pSegs = norm(pattern).split("/").filter((s) => s.length > 0);
  const fSegs = norm(filePath).split("/").filter((s) => s.length > 0);
  const segMatch = (pat: string, str: string): boolean => {
    let pi = 0, si = 0, star = -1, mark = 0;
    while (si < str.length) {
      if (pi < pat.length && (pat[pi] === "?" || pat[pi] === str[si])) { pi++; si++; }
      else if (pi < pat.length && pat[pi] === "*") { star = pi++; mark = si; }
      else if (star !== -1) { pi = star + 1; si = ++mark; }
      else return false;
    }
    while (pi < pat.length && pat[pi] === "*") pi++;
    return pi === pat.length;
  };
  const rec = (pi: number, si: number): boolean => {
    if (pi === pSegs.length) return si === fSegs.length;
    if (pSegs[pi] === "**") {
      for (let k = si; k <= fSegs.length; k++) if (rec(pi + 1, k)) return true;
      return false;
    }
    if (si >= fSegs.length) return false;
    return segMatch(pSegs[pi], fSegs[si]) && rec(pi + 1, si + 1);
  };
  return rec(0, 0);
}

export function parseSkillFile(path: string): Skill {
  return parseSkillText(readFileSync(path, "utf-8"), path);
}

/** 从文本解析技能（与 parseSkillFile 同格式；创造模式的内置技能由此加载）。 */
export function parseSkillText(text: string, path: string): Skill {
  // 先归一化换行：Windows 用户用记事本等工具写的技能文件常是 CRLF，
  // 不归一化时首行会变成 "---\r"，frontmatter 判定直接抛错。
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const formatError = `Skill 文件格式错误（缺少 frontmatter）: ${path}`;
  if (!lines.length || lines[0] !== "---") throw new Error(formatError);
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) throw new Error(formatError);
  const metadata: Record<string, string> = {};
  for (const line of lines.slice(1, closingIndex)) {
    const idx = line.indexOf(":");
    if (idx !== -1) {
      const key = line.slice(0, idx).trim();
      // 调研报告第 2 项：技能渐进披露——frontmatter 新增可选 paths 字段（逗号分隔的 glob）。
      if (["name", "description", "when", "keywords", "paths"].includes(key)) {
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
  // 调研报告第 2 项：技能渐进披露——paths 与 keywords 同样是逗号分隔；
  // 也接受 `[a, b]` 的括号写法与每项两侧的引号，写错格式只丢掉该项、不抛错。
  const paths = (metadata.paths ?? "")
    .split(",")
    .map((p) => p.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/^["']|["']$/g, "").trim())
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
    // 调研报告第 2 项：技能渐进披露——没写 paths 的旧技能保持 undefined，行为与以前一致。
    ...(paths.length ? { paths } : {}),
    instructions: bodyLines.slice(start, end).join("\n"),
    path,
  };
}

// 技能顺序的唯一规范来源：分层加载顺序即规范顺序，与 Agent 提示词一致。
// 目录优先级（先出现者胜，同名只保留第一次出现）：项目 skills → 项目
// .nyra/skills → 全局 skills → 插件 skills（调用方把 pluginSkillDirs(home)
// 传进 pluginDirs）；同目录内按文件名排序（loadSkills 的 readdir 排序）。
// 不按技能名排序：字母序会打乱项目层覆盖全局层的优先级表达，提示词索引、
// --list-skills 与网关状态三处都以这个顺序为准。
export function canonicalSkillDirs(workdir: string, home: string, pluginDirs: string[] = []): string[] {
  // 目录一律归一化为 POSIX 形式（`/`）：join() 在 Windows 上产出 `\`，而
  // 技能路径在提示词、--list-skills、网关状态与 matchSkillsByPaths 里都按
  // `/` 做字符串比较与展示——不归一化，Windows 上同一条目录在三处会写成
  // 两种样子（Node CI #49 的 test-skill-order 失败就是这么来的）。
  // fs 操作本身两种分隔符都能接受，所以归一化不影响加载。
  const toPosix = (p: string): string => p.replace(/\\/g, "/");
  return [toPosix(join(workdir, "skills")), toPosix(join(workdir, ".nyra", "skills")), toPosix(join(home, "skills")), ...pluginDirs.map(toPosix)];
}

/** 把任意技能列表规范化为规范顺序：同名去重（先出现者胜），其余保持原顺序。 */
export function canonicalSkillOrder(skills: Skill[]): Skill[] {
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const skill of skills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push(skill);
  }
  return out;
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

// 调研报告第 2 项：技能渐进披露（学 Claude Code + OpenHands）——常驻提示词用的技能索引。
// 每个技能只占一行 `name — description`，描述按字符截断到约 100 字（中文按字算，超了加 `…`）。
// 全文不进索引，需要时用 read_skill 按名按需读取。
export const SKILL_INDEX_DESC_CHARS = 100;

export function skillIndex(skills: Skill[]): string {
  // 提示词索引同样走规范顺序：先规范化再输出，三处（提示词索引、
  // --list-skills、网关状态）用同一来源。
  return canonicalSkillOrder(skills).map((skill) => {
    const chars = [...(skill.description ?? "")];
    const shown = chars.length > SKILL_INDEX_DESC_CHARS
      ? chars.slice(0, SKILL_INDEX_DESC_CHARS).join("") + "…"
      : chars.join("");
    return shown ? `${skill.name} — ${shown}` : skill.name;
  }).join("\n");
}

// 调研报告第 2 项：技能渐进披露（学 OpenHands）——路径触发：任一 touched 文件路径
// 命中某技能的 paths glob 即返回该技能；去重、按技能名排序。零基线成本：
// 没触碰匹配文件时一个字也不注入。
export function matchSkillsByPaths(filePaths: string[], skills: Skill[]): Skill[] {
  if (!filePaths.length || !skills.length) return [];
  const normalized = filePaths.map((p) => p.replace(/\\/g, "/"));
  return skills
    .filter((skill) => (skill.paths ?? []).some((glob) => normalized.some((p) => matchGlob(glob, p))))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// 调研报告第 2 项：技能渐进披露——按名取技能全文（renderSkill 格式），供 read_skill 按需读取；没有则返回 null。
export function readSkillBody(skills: Skill[], name: string): string | null {
  const skill = skills.find((s) => s.name === name);
  return skill ? renderSkill(skill) : null;
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
