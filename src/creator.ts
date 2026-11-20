// src/creator.ts — 创造模式（Creator Mode，第 4 阶段）。
// 一句话需求 → 对齐 spec（存档）→ 生成插件 → 验证 → 用户确认后安装。
// 与 DeepSeek Harness 的 Creator Mode 同构想、不同实现：Nyra 版插件是
// skill + manifest（不直接执行模型生成的代码），安装前必验证、必经用户
// 确认，插件默认最小权限；运行时调用仍走 smart approvals 与工具分档。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSkillFile, parseSkillText } from "./skills.ts";
import {
  installPlugin, readManifest, type PluginManifest, type InstallResult,
} from "./plugins.ts";
import { TOOL_SCHEMAS } from "./tools.ts";

export class CreatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreatorError";
  }
}

export const CREATOR_SKILL_NAME = "creator-mode";

/**
 * 创造模式技能（内嵌版；与 skills/creator-mode.md 同文，测试锁定一致，
 * 因为安装包不复制 skills/ 目录，技能必须随二进制走）。
 */
export const CREATOR_SKILL_TEXT = `---
name: creator-mode
description: 创造模式：一句话需求对齐 spec、生成插件、验证后经用户确认安装
when: 用户在创造模式下要做插件，或说“一句话做个XX插件”
keywords: 创造模式,插件,做个插件,一句话,番茄钟,TODO
---

# 创造模式

用户一句话描述想要的功能，你帮他搓出一个 Nyra 插件：先对齐 spec，再生成，最后验证通过、用户点头才安装。比 Harness 强的地方是安全：不经用户确认不装，插件默认最小权限，装之前把要改什么、要调什么都摆出来。

## 流程

1. **对齐 spec**：把一句话需求写成简短 spec，存到 \`.nyra/creator/<插件名>/spec.md\`，包括：需求原文、目标、包含什么、不包含什么、技能清单、声明的工具与权限、验证方法、假设。不清楚的关键点先问用户，最多问 2 个问题；问不出就按合理默认写进 spec 的“假设”里，不要反复追问。
2. **生成**：按 spec 把插件文件写到 \`.nyra/creator/<插件名>/staging/\`（plugin.json + skills/*.md，面板放 panel/*.html）。已知的两种模板直接用 CLI 生成，不要手写：
   - 番茄钟：\`nyra creator "做个番茄钟"\`
   - TODO 扫描：\`nyra creator "扫描 TODO"\`
   新需求自己写技能文件：技能就是 Markdown（frontmatter + 做法），只用 Nyra 已有的工具，不要凭空发明新工具。
3. **验证**：跑 \`nyra creator verify <staging>\`；验证不过就修，修不好就如实告诉用户、不要安装。绝不编造验证结果。
4. **确认**：把要装什么原样展示给用户：插件名、版本、新增文件、声明的工具与权限、高权限警告（如果有 shell、电脑操作、浏览器操作这类高权限工具，必须单独标出来说明风险）。明确问一句“确认安装吗”，用户没点头绝不装。
5. **安装**：用户确认后跑 \`nyra creator install <staging>\`；装完告诉用户插件已可用，以及怎么停用（\`nyra plugin disable <名>\`）和卸载（\`nyra plugin uninstall <名>\`）。

## 安全红线

- 绝不安装未经验证的插件；验证失败要给出可读的错误，不静默装坏东西。
- 插件默认最小权限，只声明它真正要用的工具；权限清单写进 plugin.json 的 tools 和 permissions。
- 绝不把 shell、电脑操作、浏览器操作写进插件，除非用户明确要求且已说明风险；这类工具进插件时必须在确认环节单独标出。
- 插件面板（panel/*.html）必须是自包含静态页面：不请求外部资源、不加载外部脚本。
- 生成失败、验证失败、用户拒绝，三个结果都要如实汇报，不绕过、不重试安装。
`;

export type BuiltinKind = "pomodoro" | "todo-scan";

export interface CreatorSpec {
  request: string;
  slug: string;
  name: string;
  goal: string;
  includes: string[];
  excludes: string[];
  skills: string[];
  tools: string[];
  permissions: string[];
  verifyMethod: string;
  assumptions: string[];
  builtin: BuiltinKind | null;
}

export interface VerifyReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest: PluginManifest | null;
  files: string[];
  tools: string[];
  permissions: string[];
  highPrivilegeTools: string[];
}

export interface CreatorRunResult {
  status: "installed" | "awaiting-approval";
  spec: CreatorSpec;
  specPath: string;
  stagingDir: string;
  report: VerifyReport;
  changes: string;
  install?: InstallResult;
}

/** 高权限工具：进插件时必须在确认环节单独标出并说明风险。 */
export const HIGH_PRIVILEGE_TOOLS = new Set([
  "shell", "browser_navigate", "browser_click", "browser_screenshot",
  "computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_windows",
]);

export const KNOWN_TOOLS = new Set(
  TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name as string),
);

export function creatorDir(workdir: string, slug: string): string {
  return join(resolve(workdir), ".nyra", "creator", slug);
}

export function specPathFor(workdir: string, slug: string): string {
  return join(creatorDir(workdir, slug), "spec.md");
}

export function stagingDirFor(workdir: string, slug: string): string {
  return join(creatorDir(workdir, slug), "staging");
}

/**
 * 一句话需求匹配内置模板（番茄钟 / TODO 扫描）。匹配不上返回 null，
 * 由对话里的 agent 写插件；CLI 无模型时如实报错，不瞎编。
 */
export function matchBuiltinPattern(request: string): BuiltinKind | null {
  const text = request.toLowerCase();
  if (/番茄钟|番茄|倒计时|pomodoro/.test(text)) return "pomodoro";
  if (/todo|待办|待办事项|todo_scan|todo-scan|fixme/.test(text)) return "todo-scan";
  return null;
}

export function slugFor(request: string, kind: BuiltinKind | null): string {
  if (kind) return kind;
  const cleaned = request.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return cleaned || "custom-plugin";
}

export function buildSpec(request: string, kind: BuiltinKind | null): CreatorSpec {
  const slug = slugFor(request, kind);
  if (kind === "pomodoro") {
    return {
      request, slug, name: "pomodoro",
      goal: "番茄钟：25 分钟专注 + 5 分钟休息，带倒计时面板，循环记轮数。",
      includes: ["番茄钟技能（跑轮次、记轮数）", "倒计时面板 panel/pomodoro.html（纯静态，无网络请求）"],
      excludes: ["不跑命令", "不联网", "不替用户编造已完成的轮数"],
      skills: ["pomodoro"],
      tools: ["read_file", "write_file", "memory_append"],
      permissions: ["fs:write-workspace", "network:none"],
      verifyMethod: "nyra creator verify：清单校验 + 技能 frontmatter 解析 + 面板自包含检查",
      assumptions: ["一轮 25 分钟专注、5 分钟休息；每 4 轮建议长休息"],
      builtin: "pomodoro",
    };
  }
  if (kind === "todo-scan") {
    return {
      request, slug, name: "todo-scan",
      goal: "扫描工作区的 TODO、FIXME、XXX、HACK 标记，按文件汇总成清单。",
      includes: ["TODO 扫描技能（grep 找标记、按文件分组）"],
      excludes: ["只读不改", "不扫 node_modules、.git、dist"],
      skills: ["todo-scan"],
      tools: ["grep_search", "list_dir", "read_file"],
      permissions: ["fs:read-workspace", "network:none"],
      verifyMethod: "nyra creator verify：清单校验 + 技能 frontmatter 解析",
      assumptions: ["先搜 TODO，再按需搜 FIXME/XXX/HACK；超过 50 处先报前 20 处"],
      builtin: "todo-scan",
    };
  }
  return {
    request, slug, name: slug,
    goal: request,
    includes: ["待 agent 按 spec 生成技能"],
    excludes: ["不经验证不安装", "不经用户确认不安装"],
    skills: [],
    tools: [],
    permissions: ["network:none"],
    verifyMethod: "nyra creator verify：清单校验 + 技能 frontmatter 解析",
    assumptions: ["无现成模板，需 agent 在对话里写插件"],
    builtin: null,
  };
}

export function renderSpec(spec: CreatorSpec): string {
  const lines = [
    `# 创造模式 spec：${spec.name}`,
    "",
    `- 需求原文：${spec.request}`,
    `- 插件名：${spec.slug}（版本 0.1.0）`,
    `- 目标：${spec.goal}`,
    `- 包含：${spec.includes.join("；")}`,
    `- 不包含：${spec.excludes.join("；")}`,
    `- 技能：${spec.skills.join("、") || "（待生成）"}`,
    `- 声明的工具：${spec.tools.join("、") || "（待生成）"}`,
    `- 声明的权限：${spec.permissions.join("、")}`,
    `- 验证方法：${spec.verifyMethod}`,
    `- 假设：${spec.assumptions.join("；")}`,
    "",
  ];
  return lines.join("\n");
}

export function writeCreatorSpec(workdir: string, spec: CreatorSpec): string {
  const dir = creatorDir(workdir, spec.slug);
  mkdirSync(dir, { recursive: true });
  const path = specPathFor(workdir, spec.slug);
  writeFileSync(path, renderSpec(spec), "utf-8");
  return path;
}

const TODO_SCAN_SKILL = `---
name: todo-scan
description: 扫描工作区的 TODO、FIXME、XXX、HACK 标记，按文件汇总成清单
when: 用户要找待办标记、扫描 TODO、清理遗留任务
keywords: TODO,待办,扫描,FIXME,XXX,HACK
---

# TODO 扫描

## 目标
扫描当前工作区的待办标记（TODO、FIXME、XXX、HACK），按文件汇总，告诉用户哪里还留着未做的事。

## 做法
1. 用 grep_search 在工作区里搜 TODO、FIXME、XXX、HACK（先搜 TODO，再按需搜其他三个）。
2. 只看源码与文档（.ts、.js、.py、.md 等）；跳过 node_modules、.git、dist、__pycache__。
3. 对每个命中点，用 read_file 看上下两行，确认是不是真正的待办（排除掉注释掉的示例、CHANGELOG 里的历史记录）。
4. 按文件分组输出：文件:行号 + 一行摘要；最后给总数，并按“影响功能的 FIXME/HACK”与“普通 TODO”分两组。

## 输出格式
- 先给总数，如“共 12 处待办标记，分布在 5 个文件”。
- 再按文件列出，每处一行：路径:行号 标记内容。
- 最后问用户一句：要不要我先修其中某一处。

## 红线
- 只读不改：这个插件不写文件、不跑命令，只用 grep_search、list_dir、read_file。
- 不要把 node_modules、.git、dist 里的命中算进来。
- 数量超过 50 处时，先报总数和前 20 处，问用户要不要看全部。
`;

const POMODORO_SKILL = `---
name: pomodoro
description: 番茄钟：25 分钟专注 + 5 分钟休息，带倒计时面板
when: 用户要番茄钟、专注计时、倒计时
keywords: 番茄钟,专注,计时,pomodoro,倒计时
---

# 番茄钟

## 目标
帮用户跑番茄钟：25 分钟专注、5 分钟休息，循环记轮数。计时由倒计时面板在浏览器里跑，不占 agent；agent 负责记轮数和提醒节奏。

## 做法
1. 第一次用时，把面板 panel/pomodoro.html 复制到工作区（write_file 到“工作区/pomodoro.html”），告诉用户在浏览器里打开它，点“开始专注”。
2. 问用户这轮的目标（一句话），用 memory_append 记下：番茄钟第 N 轮：目标（开始时间）。
3. 25 分钟后用户回来汇报时，记一轮完成，问要不要休息 5 分钟；休息结束再问要不要开下一轮。
4. 每完成 4 轮，建议长休息 15–30 分钟。
5. 用户随时说“停”就停，记下今天一共完成了几轮。

## 面板
- 面板是纯静态页面（无网络请求、无外部资源）：25:00 专注倒计时、5:00 休息倒计时、开始/暂停/重置、轮数计数。
- 面板只计时，不替用户记轮数；轮数以 agent 记录的为准。

## 红线
- 只用 read_file、write_file、memory_append；不跑命令、不联网。
- 不要替用户编造已完成的轮数；只记用户亲口确认的。
`;

const POMODORO_PANEL = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>番茄钟</title>
<style>
body { font-family: system-ui, sans-serif; background: #F3F5F4; color: #2A2D34; text-align: center; padding: 48px 16px; }
#time { font-size: 96px; font-variant-numeric: tabular-nums; margin: 16px 0; }
#mode { font-size: 20px; color: #5F7D5C; }
button { font-size: 18px; margin: 6px; padding: 10px 22px; border: 1px solid #5F7D5C; background: #fff; color: #2A2D34; border-radius: 8px; cursor: pointer; }
button.primary { background: #5F7D5C; color: #fff; }
#rounds { margin-top: 24px; color: #666; }
</style>
</head>
<body>
<h1>番茄钟</h1>
<div id="mode">专注</div>
<div id="time">25:00</div>
<div>
<button class="primary" id="start">开始专注</button>
<button id="pause">暂停</button>
<button id="reset">重置</button>
</div>
<div id="rounds">已完成 0 轮</div>
<script>
var FOCUS = 25 * 60, BREAK = 5 * 60;
var remaining = FOCUS, mode = "focus", timer = null, rounds = 0;
var timeEl = document.getElementById("time");
var modeEl = document.getElementById("mode");
var roundsEl = document.getElementById("rounds");
var startEl = document.getElementById("start");
function render() {
  var m = Math.floor(remaining / 60), s = remaining % 60;
  timeEl.textContent = (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
  modeEl.textContent = mode === "focus" ? "专注" : "休息";
  startEl.textContent = mode === "focus" ? "开始专注" : "开始休息";
  roundsEl.textContent = "已完成 " + rounds + " 轮";
}
function tick() {
  remaining--;
  if (remaining <= 0) {
    if (mode === "focus") { rounds++; mode = "break"; remaining = BREAK; }
    else { mode = "focus"; remaining = FOCUS; }
  }
  render();
}
document.getElementById("start").addEventListener("click", function () {
  if (timer) return;
  timer = setInterval(tick, 1000);
});
document.getElementById("pause").addEventListener("click", function () {
  if (timer) { clearInterval(timer); timer = null; }
});
document.getElementById("reset").addEventListener("click", function () {
  if (timer) { clearInterval(timer); timer = null; }
  mode = "focus"; remaining = FOCUS; render();
});
render();
</script>
</body>
</html>
`;

function writePluginFiles(stagingDir: string, manifest: PluginManifest, skills: Record<string, string>, panel: Record<string, string>): void {
  mkdirSync(join(stagingDir, "skills"), { recursive: true });
  writeFileSync(join(stagingDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  for (const [name, content] of Object.entries(skills)) {
    writeFileSync(join(stagingDir, "skills", `${name}.md`), content, "utf-8");
  }
  if (Object.keys(panel).length) {
    mkdirSync(join(stagingDir, "panel"), { recursive: true });
    for (const [name, content] of Object.entries(panel)) {
      writeFileSync(join(stagingDir, "panel", name), content, "utf-8");
    }
  }
}

/** 内置模板生成：把一句话需求变成插件 staging 目录（plugin.json + skills + panel）。 */
export function buildBuiltinPlugin(kind: BuiltinKind, stagingDir: string): void {
  if (kind === "todo-scan") {
    writePluginFiles(stagingDir, {
      name: "todo-scan",
      version: "0.1.0",
      description: "扫描工作区的 TODO、FIXME、XXX、HACK 标记，按文件汇总",
      author: "Nyra 创造模式",
      license: "MIT",
      skills: ["todo-scan"],
      tools: ["grep_search", "list_dir", "read_file"],
      permissions: ["fs:read-workspace", "network:none"],
    }, { "todo-scan": TODO_SCAN_SKILL }, {});
    return;
  }
  writePluginFiles(stagingDir, {
    name: "pomodoro",
    version: "0.1.0",
    description: "番茄钟：25 分钟专注 + 5 分钟休息，带倒计时面板",
    author: "Nyra 创造模式",
    license: "MIT",
    skills: ["pomodoro"],
    tools: ["read_file", "write_file", "memory_append"],
    permissions: ["fs:write-workspace", "network:none"],
  }, { pomodoro: POMODORO_SKILL }, { "pomodoro.html": POMODORO_PANEL });
}

/** 面板自包含检查：不许外部资源、不许外部脚本（纯静态页面）。 */
export function checkPanelSelfContained(html: string): string[] {
  const problems: string[] = [];
  const external = /(?:src|href)\s*=\s*["']https?:\/\//i;
  if (external.test(html)) problems.push("面板引用了外部资源（http/https 链接），必须是自包含静态页面");
  if (/<script[^>]+src=/i.test(html)) problems.push("面板加载了外部脚本，必须是自包含静态页面");
  if (/<\s*iframe/i.test(html)) problems.push("面板含 iframe，不允许");
  return problems;
}

function listStagedFiles(stagingDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
      const full = join(dir, f);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${f}/`);
      else out.push(`${prefix}${f}`);
    }
  };
  walk(stagingDir, "");
  return out;
}

/**
 * 验证 staging 插件（安装前必跑）：清单校验、技能 frontmatter 解析与加载、
 * 声明的工具必须都是已知的 Nyra 工具、高权限工具标出、面板自包含。
 * 验证不过返回 ok=false 与可读错误，绝不安装。
 */
export function verifyStagedPlugin(stagingDir: string): VerifyReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  let manifest: PluginManifest | null = null;
  let files: string[] = [];
  try {
    files = listStagedFiles(stagingDir);
  } catch (err: unknown) {
    errors.push(`无法读取 staging 目录：${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    manifest = readManifest(stagingDir);
  } catch (err: unknown) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  if (manifest) {
    for (const skill of manifest.skills) {
      const path = join(stagingDir, "skills", `${skill}.md`);
      if (!existsSync(path)) {
        errors.push(`清单声明的技能缺文件：skills/${skill}.md`);
        continue;
      }
      try {
        const parsed = parseSkillFile(path);
        if (parsed.name !== skill) errors.push(`技能文件 ${skill}.md 的 name 是 ${parsed.name}，与清单不一致`);
        if (!parsed.instructions.trim()) errors.push(`技能 ${skill} 没有写做法（instructions 为空）`);
      } catch (err: unknown) {
        errors.push(`技能 ${skill} 解析失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const declared = manifest.tools ?? [];
    for (const tool of declared) {
      if (!KNOWN_TOOLS.has(tool)) errors.push(`声明的工具 ${tool} 不是 Nyra 已知的工具`);
    }
    if (!declared.length) warnings.push("未声明 tools 白名单：默认最小权限，建议写明它要用的工具");
    if (!(manifest.permissions ?? []).length) warnings.push("未声明 permissions 清单");
    if (!files.includes("plugin.json")) errors.push("缺少 plugin.json");
    const panelDir = join(stagingDir, "panel");
    if (existsSync(panelDir)) {
      for (const f of readdirSync(panelDir).sort()) {
        if (!f.endsWith(".html")) {
          errors.push(`panel 只允许 .html 文件：${f}`);
          continue;
        }
        const html = readFileSync(join(panelDir, f), "utf-8");
        for (const p of checkPanelSelfContained(html)) errors.push(`面板 ${f}：${p}`);
      }
    }
  }
  const tools = manifest?.tools ?? [];
  const permissions = manifest?.permissions ?? [];
  const highPrivilegeTools = tools.filter((t) => HIGH_PRIVILEGE_TOOLS.has(t));
  if (highPrivilegeTools.length) {
    warnings.push(`高权限工具：${highPrivilegeTools.join("、")}（安装确认时须单独说明风险）`);
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    manifest,
    files,
    tools,
    permissions,
    highPrivilegeTools,
  };
}

/** 安装前展示给用户看的变更说明：装什么、改什么、调什么。 */
export function describePlannedChanges(report: VerifyReport): string {
  const m = report.manifest;
  const lines: string[] = [];
  if (m) {
    lines.push(`插件：${m.name} v${m.version}`);
    if (m.description) lines.push(`说明：${m.description}`);
  }
  lines.push(`新增文件（${report.files.length} 个）：${report.files.join("、") || "无"}`);
  lines.push(`声明的工具：${report.tools.join("、") || "未声明"}`);
  lines.push(`声明的权限：${report.permissions.join("、") || "未声明"}`);
  if (report.highPrivilegeTools.length) {
    lines.push(`⚠ 高权限工具：${report.highPrivilegeTools.join("、")}——装完后每次调用仍需审批，请确认你真的需要它。`);
  }
  for (const w of report.warnings) lines.push(`提醒：${w}`);
  return lines.join("\n");
}

/** 验证通过后安装（走插件市场的哈希锁定安装路径）。验证不过直接抛错、不装。 */
export function installStagedPlugin(home: string, stagingDir: string): { install: InstallResult; report: VerifyReport } {
  const report = verifyStagedPlugin(stagingDir);
  if (!report.ok) {
    throw new CreatorError(`插件验证未通过，拒绝安装：\n${report.errors.map((e) => `- ${e}`).join("\n")}`);
  }
  const install = installPlugin(home, stagingDir);
  return { install, report };
}

export interface CreatorRunOptions {
  home: string;
  workdir: string;
  autoApprove?: boolean;
  /** 模型生成函数（对话里的 agent 提供；CLI 无模型时不传）。 */
  generate?: (spec: CreatorSpec, stagingDir: string) => void | Promise<void>;
}

/**
 * 一句话创造全流程：对齐 spec → 生成 → 验证 →（未确认时返回待确认，不安装）。
 * autoApprove 时直接安装；否则返回 awaiting-approval，由调用方展示变更并确认。
 */
export async function runCreator(request: string, opts: CreatorRunOptions): Promise<CreatorRunResult> {
  const trimmed = request.trim();
  if (!trimmed) throw new CreatorError("需求不能为空：请用一句话描述想要的功能，例如“做个番茄钟”。");
  const kind = matchBuiltinPattern(trimmed);
  if (!kind && !opts.generate) {
    throw new CreatorError(
      "这个需求没有现成的模板，需要模型来写插件内容。\n"
      + "请在对话里用创造模式让 agent 写（nyra --mode creator），或先试两个现成的例子：\n"
      + "  nyra creator \"做个番茄钟\"\n"
      + "  nyra creator \"扫描 TODO\"",
    );
  }
  const spec = buildSpec(trimmed, kind);
  const specPath = writeCreatorSpec(opts.workdir, spec);
  const stagingDir = stagingDirFor(opts.workdir, spec.slug);
  mkdirSync(stagingDir, { recursive: true });
  if (kind) {
    buildBuiltinPlugin(kind, stagingDir);
  } else if (opts.generate) {
    await opts.generate(spec, stagingDir);
  }
  const report = verifyStagedPlugin(stagingDir);
  if (!report.ok) {
    throw new CreatorError(
      `插件生成完了，但验证未通过，没有安装：\n${report.errors.map((e) => `- ${e}`).join("\n")}`,
    );
  }
  const changes = describePlannedChanges(report);
  if (!opts.autoApprove) {
    return { status: "awaiting-approval", spec, specPath, stagingDir, report, changes };
  }
  const { install } = installStagedPlugin(opts.home, stagingDir);
  return { status: "installed", spec, specPath, stagingDir, report, changes, install };
}
