// src/skillDrafts.ts — 技能自沉淀闭环（缺口 11，学 OpenClaw Skill Workshop /
// Hermes 自写技能 / MiniMax Skills 演化 / Grok Bot Teach by showing）。
//
// 做完一次成功任务 → 自动起草技能草稿（Markdown + frontmatter）→ 人工批准后
// 才安装（与创造模式“先验证、确认后安装”同规则）；低质技能自动归档，不污染
// 技能库。草稿附来源（哪次运行、哪几步、可复现性），与证据链同口径。
//
// 与别家不同的三点：
//   1. 起草是确定性的（只从运行记录提取，不调模型、不花 token、不联网），
//      草稿是骨架、不是成品——批准前人要通读一遍，改掉不对的地方。
//   2. 安装永远要人批准：自动起草 ≠ 自动安装；`enabled` 默认关闭（显式 opt-in），
//      队列与定时任务里同样只起草、不自动批准（RunRecorder 收尾钩子只调
//      maybeAutoDraft，批准只走 `nyra skills approve`）。
//   3. 低质自动归档有两条线：起草时质量分不够直接进 archived；已装技能超过
//      auto_archive_days 天没人用，`nyra skills sweep` 把它移出技能库、进归档。
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  readdirSync, statSync, appendFileSync,
  openSync, writeSync, fsyncSync, closeSync, rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { parseSkillText, saveSkillFile, loadSkills, canonicalSkillDirs } from "./skills.ts";
import { loadSkillUsage } from "./skillUsage.ts";
import { type RunStore } from "./runs.ts";

export class SkillDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillDraftError";
  }
}

/** 缺口 11 的配置（config.json 的 `skill_sedimentation` 一节）。 */
export interface SkillSedimentationConfig {
  /** 总开关：默认 false（显式 opt-in）；开后成功运行收尾时自动起草草稿。 */
  enabled: boolean;
  /** 起草门槛：一次运行至少要有这么多次工具调用才值得沉淀（默认 3）。 */
  min_steps: number;
  /** 已装技能多久没人用就归档（天，默认 30；`nyra skills sweep` 用）。 */
  auto_archive_days: number;
  /** 只让已验证（verified）的运行沉淀（默认 false：completed_unverified 也能沉淀，但质量分更低）。 */
  require_verified: boolean;
}

export const DEFAULT_SKILL_SEDIMENTATION: SkillSedimentationConfig = {
  enabled: false,
  min_steps: 3,
  auto_archive_days: 30,
  require_verified: false,
};

/** 质量分低于这个值时，草稿出生即归档（不进待批准，见 draftSkillFromRun）。 */
export const DRAFT_QUALITY_ARCHIVE_BELOW = 2;

/** 从 config.json 读沉淀配置：类型不对时回落默认值，不抛错。 */
export function skillSedimentationConfig(config: Record<string, unknown>): SkillSedimentationConfig {
  const raw = (config?.skill_sedimentation ?? {}) as Record<string, unknown>;
  const minSteps = raw.min_steps;
  const archiveDays = raw.auto_archive_days;
  return {
    enabled: raw.enabled === true,
    min_steps: typeof minSteps === "number" && Number.isInteger(minSteps) && minSteps >= 1 ? minSteps : 3,
    auto_archive_days: typeof archiveDays === "number" && Number.isInteger(archiveDays) && archiveDays >= 1 ? archiveDays : 30,
    require_verified: raw.require_verified === true,
  };
}

export type SkillDraftStatus = "pending" | "approved" | "rejected" | "archived" | "installed";

export interface SkillDraftQuality {
  score: number;
  reasons: string[];
}

export interface SkillDraft {
  name: string;
  status: SkillDraftStatus;
  source_run_id: string;
  source_task: string;
  tool_names: string[];
  tool_calls: number;
  tool_failures: number;
  changed_files: string[];
  quality: SkillDraftQuality;
  created_at: string;
  updated_at: string;
  archive_reason?: string;
  installed_path?: string;
}

interface DraftLedger {
  version: 1;
  drafts: SkillDraft[];
}

export function skillDraftsDir(home: string): string {
  return join(home, "skill-drafts");
}

export function skillDraftLedgerPath(home: string): string {
  return join(home, "skill-drafts.json");
}

export function skillArchiveDir(home: string): string {
  return join(home, "skills-archive");
}

export function skillArchiveLogPath(home: string): string {
  return join(home, "skills-archive.jsonl");
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err: unknown) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
* 读草稿账本；不存在返回空账本；损坏时先备份再抛错（fail-closed：
* 草稿状态丢了不能悄悄重建，否则已批准的草稿会被重复安装）。
*/
export function loadDraftLedger(home: string): DraftLedger {
  const path = skillDraftLedgerPath(home);
  if (!existsSync(path)) return { version: 1, drafts: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new SkillDraftError(`草稿账本损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as DraftLedger).drafts)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new SkillDraftError(`草稿账本格式无效，已备份到 ${backup}`);
  }
  return raw as DraftLedger;
}

export function saveDraftLedger(home: string, ledger: DraftLedger): void {
  atomicWriteJson(skillDraftLedgerPath(home), ledger);
}

export function listDrafts(home: string): SkillDraft[] {
  return loadDraftLedger(home).drafts;
}

export function findDraft(home: string, name: string): SkillDraft | null {
  return loadDraftLedger(home).drafts.find((d) => d.name === name) ?? null;
}

function updateDraft(home: string, name: string, patch: Partial<SkillDraft>): SkillDraft {
  const ledger = loadDraftLedger(home);
  const idx = ledger.drafts.findIndex((d) => d.name === name);
  if (idx === -1) throw new SkillDraftError(`没有名为 ${name} 的技能草稿（先 nyra skills drafts 看看）`);
  const next = { ...ledger.drafts[idx], ...patch, updated_at: new Date().toISOString() };
  ledger.drafts[idx] = next;
  saveDraftLedger(home, ledger);
  return next;
}

/** 草稿事件写进源运行的 events.jsonl（证据链审计副本）；运行目录没了也不破坏主流程。 */
function recordDraftEvent(store: RunStore, runId: string, type: string, fields: Record<string, unknown>): void {
  try {
    store.appendEvent(runId, type, fields);
  } catch { /* 源运行已删时只丢审计副本，不破坏起草/批准本身 */ }
}

/** 任务文本 → 技能名 slug：只取 ASCII 词（saveSkillFile 只允许字母数字 - _）；中文任务取不到词时用运行 id 后缀兜底。
 * 上限 24 字：事件字段过 appendEvent 的 redact（≥32 字的连续词串会被当成疑似密钥
 * 掩掉），24 字 + "-999" 后缀也才 28 字，草稿名在证据链里不会被掩掉。 */
export function slugFromTask(task: string, runId: string): string {
  const words = (task ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const base = words.join("-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  if (base) return base;
  return `run-${runId.replace(/[^a-z0-9]/gi, "").slice(-6) || "skill"}`;
}

/** 名字去重：与已装技能、已有草稿重名时加 -2、-3 后缀。 */
export function uniqueDraftName(home: string, workdir: string, base: string): string {
  const taken = new Set<string>();
  try {
    for (const s of loadSkills(canonicalSkillDirs(workdir, home))) taken.add(s.name);
  } catch { /* 技能目录读失败时只按草稿去重，不拦起草 */ }
  for (const d of listDrafts(home)) taken.add(d.name);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** frontmatter 字段清洗：去换行（防任务文本里的 `name:` 之类行注入 frontmatter）、截断。 */
function cleanField(text: string, maxChars: number): string {
  return (text ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export interface DraftExtraction {
  toolNames: string[];
  toolCalls: number;
  toolFailures: number;
  changedFiles: string[];
  verifyPassed: boolean | null;
  verifyCommand: string | null;
}

function extractFromRun(store: RunStore, runId: string): DraftExtraction {
  const state = store.load(runId);
  const toolNames: string[] = [];
  const seen = new Set<string>();
  let toolCalls = 0;
  let toolFailures = 0;
  for (const ev of store.readEvents(runId)) {
    if (ev.type !== "tool_result") continue;
    toolCalls++;
    if (ev.ok === false) toolFailures++;
    if (typeof ev.name === "string" && ev.name && !seen.has(ev.name)) {
      seen.add(ev.name);
      toolNames.push(ev.name);
    }
  }
  const verify = (state.verify_result ?? null) as Record<string, unknown> | null;
  return {
    toolNames,
    toolCalls,
    toolFailures,
    changedFiles: [...(state.changed_files ?? [])],
    verifyPassed: typeof verify?.passed === "boolean" ? (verify.passed as boolean) : null,
    verifyCommand: typeof state.verify_cmd === "string" ? state.verify_cmd : null,
  };
}

/**
* 质量分（确定性、可复现；规则写进文档）：
* verified +2 / completed_unverified +1；工具调用 ≥5 次 +1；改过文件 +1；
* 每次失败调用 -1（最多 -2）。低于 2 分的草稿出生即归档，不进待批准。
*/
export function scoreDraft(status: string, ext: DraftExtraction): SkillDraftQuality {
  const reasons: string[] = [];
  let score = 0;
  if (status === "verified") {
    score += 2;
    reasons.push("运行已验证（verified）+2");
  } else {
    score += 1;
    reasons.push("运行未验证（completed_unverified）+1");
  }
  if (ext.toolCalls >= 5) {
    score += 1;
    reasons.push(`工具调用 ${ext.toolCalls} 次（≥5）+1`);
  }
  if (ext.changedFiles.length > 0) {
    score += 1;
    reasons.push(`改动 ${ext.changedFiles.length} 个文件 +1`);
  }
  if (ext.toolFailures > 0) {
    const penalty = Math.min(2, ext.toolFailures);
    score -= penalty;
    reasons.push(`失败调用 ${ext.toolFailures} 次 -${penalty}`);
  }
  return { score, reasons };
}

/** 草稿 Markdown：frontmatter + 做法骨架。工具参数原文不在运行记录里（只存单向指纹），步骤只列工具顺序，具体参数须批准前补齐——正文里写明了这一点，不假装可复现。 */
export function renderDraftMarkdown(draft: SkillDraft, ext: DraftExtraction, verifyCommand: string | null): string {
  const task = cleanField(draft.source_task, 500);
  const keywords = draft.tool_names.slice(0, 8).join(", ");
  const steps = draft.tool_names.map((t, i) => `${i + 1}. 用 ${t} 做对应的那一步。`).join("\n");
  const files = draft.changed_files.length
  ? draft.changed_files.map((f) => `- ${f}`).join("\n")
  : "- （本次运行没有改动文件）";
  const lines = [
    "---",
    `name: ${draft.name}`,
    `description: ${cleanField(draft.source_task, 120)}`,
    `when: 用户要做与“${cleanField(draft.source_task, 60)}”类似的事`,
    `keywords: ${keywords}`,
    "---",
    "",
    `# ${draft.name}（草稿）`,
    "",
    "## 来源",
    "",
    `- 运行：${draft.source_run_id}（任务原文见下）`,
    `- 任务：${task}`,
    `- 工具调用：${draft.tool_calls} 次（成功 ${draft.tool_calls - draft.tool_failures} 次，失败 ${draft.tool_failures} 次）`,
    `- 验证：${ext.verifyPassed === null ? "未配置验证命令" : ext.verifyPassed ? "通过" : "未通过"}`,
    `- 质量分：${draft.quality.score}（${draft.quality.reasons.join("；")}）`,
    "",
    "## 做法",
    "",
    steps || "（本次运行没有工具调用记录）",
    "",
    "## 改动过的文件",
    "",
    files,
    "",
    "## 复现要点",
    "",
    verifyCommand ? `- 验证命令：\`${verifyCommand}\`` : "- 本次运行没有配置验证命令。",
    `- 源运行：\`nyra evidence verify ${draft.source_run_id}\` 可复核证据链。`,
    "",
    "## 注意（批准前必读）",
    "",
    "- 本草稿由 Nyra 自动起草，是骨架、不是成品：工具参数原文不在运行记录里（只存了单向指纹），步骤只列了工具顺序，具体参数、判断条件与例外情况请对照源运行与会话记录补齐，改掉不对的地方再批准。",
    "- 批准即安装到 `~/.nyra/skills/`，下次同类任务会自动匹配；不想要就拒绝或归档，不要留着占技能索引。",
    "",
  ];
  return lines.join("\n");
}

export interface DraftResult {
  draft: SkillDraft | null;
  /** 起草不成时的原因（人看的；自动钩子只跳过不报错）。 */
  reason: string;
}

/**
* 从一次已完成的运行起草技能草稿。
* 不合资格的运行返回 { draft: null, reason }（不抛错、不写盘）；
* 低质草稿会写盘，但状态直接是 archived（自动归档，不进待批准）。
*/
export function draftSkillFromRun(
  store: RunStore,
  runId: string,
  opts: { home: string; config?: Record<string, unknown> },
): DraftResult {
  const home = opts.home;
  const cfg = skillSedimentationConfig(opts.config ?? {});
  let state;
  try {
    state = store.load(runId);
  } catch (err: unknown) {
    return { draft: null, reason: `找不到运行 ${runId}：${err instanceof Error ? err.message : String(err)}` };
  }
  const eligible = cfg.require_verified ? state.status === "verified" : ["verified", "completed_unverified"].includes(state.status);
  if (!eligible) {
    return {
      draft: null,
      reason: cfg.require_verified
      ? `运行状态是 ${state.status}，require_verified 开启时只有 verified 的运行才能沉淀技能`
      : `运行状态是 ${state.status}，只有成功（verified / completed_unverified）的运行才能沉淀技能`,
    };
  }
  const ext = extractFromRun(store, runId);
  if (ext.toolCalls < cfg.min_steps) {
    return { draft: null, reason: `工具调用只有 ${ext.toolCalls} 次，少于最少 ${cfg.min_steps} 次，不值得沉淀为技能` };
  }
  const quality = scoreDraft(state.status, ext);
  const base = slugFromTask(state.task, runId);
  const name = uniqueDraftName(home, state.workdir, base);
  const archived = quality.score < DRAFT_QUALITY_ARCHIVE_BELOW;
  const now = new Date().toISOString();
  const draft: SkillDraft = {
    name,
    status: archived ? "archived" : "pending",
    source_run_id: runId,
    source_task: state.task,
    tool_names: ext.toolNames,
    tool_calls: ext.toolCalls,
    tool_failures: ext.toolFailures,
    changed_files: ext.changedFiles,
    quality,
    created_at: now,
    updated_at: now,
    ...(archived ? { archive_reason: `质量分 ${quality.score}（< ${DRAFT_QUALITY_ARCHIVE_BELOW}）：${quality.reasons.join("；")}` } : {}),
  };
  const dir = skillDraftsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${name}.md`), renderDraftMarkdown(draft, ext, ext.verifyCommand), "utf-8");
  const ledger = loadDraftLedger(home);
  ledger.drafts.push(draft);
  saveDraftLedger(home, ledger);
  recordDraftEvent(store, runId, "skill_draft_created", {
      draft_name: name,
      run_id: runId,
      quality: quality.score,
      status: draft.status,
    });
  return { draft, reason: archived ? `草稿已自动归档（${draft.archive_reason ?? ""}）` : "" };
}

/**
* 自动起草钩子（RunRecorder 收尾时调）：只起草、不批准；任何失败都吞掉、
* 永不破坏运行本身。沉淀未开启时直接返回 null（连运行记录都不读）。
*/
export function maybeAutoDraft(
  home: string,
  config: Record<string, unknown>,
  store: RunStore,
  runId: string,
): SkillDraft | null {
  try {
    if (!skillSedimentationConfig(config).enabled) return null;
    const { draft } = draftSkillFromRun(store, runId, { home, config });
    return draft;
  } catch {
    return null;
  }
}

/**
* 批准草稿 → 安装到 `~/.nyra/skills/`。
* 安装前用创造模式同款验证（frontmatter 解析 + 做法非空）；同名技能已存在时
* 拒绝安装（fail-closed，不覆盖别人的技能）。草稿文件里的 frontmatter 是准——
* 批准前人可以直接改草稿文件（包括改名），以文件内容为准。
*/
export function approveDraft(home: string, name: string, store: RunStore): { draft: SkillDraft; installedPath: string } {
  const ledger = loadDraftLedger(home);
  const found = ledger.drafts.find((d) => d.name === name);
  if (!found) throw new SkillDraftError(`没有名为 ${name} 的技能草稿（先 nyra skills drafts 看看）`);
  if (found.status !== "pending") {
    throw new SkillDraftError(`草稿 ${name} 当前状态是 ${found.status}，只有 pending 的草稿能批准`);
  }
  const draftPath = join(skillDraftsDir(home), `${name}.md`);
  if (!existsSync(draftPath)) throw new SkillDraftError(`草稿文件丢了：${draftPath}`);
  let parsed;
  try {
    parsed = parseSkillText(readFileSync(draftPath, "utf-8"), draftPath);
  } catch (err: unknown) {
    throw new SkillDraftError(`草稿 ${name} 解析失败，拒绝安装：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed.instructions.trim()) throw new SkillDraftError(`草稿 ${name} 没有写做法（instructions 为空），拒绝安装`);
  const skillsDir = join(home, "skills");
  if (existsSync(join(skillsDir, `${parsed.name}.md`))) {
    throw new SkillDraftError(`技能 ${parsed.name} 已安装在 ${skillsDir}，拒绝覆盖（先删掉旧技能，或改草稿里的 name 再批准）`);
  }
  const installedPath = saveSkillFile(skillsDir, parsed.name, parsed.description, parsed.when, parsed.keywords, parsed.instructions);
  const draft = updateDraft(home, name, { status: "installed", installed_path: installedPath });
  // 事件里只记名字与源运行，不记 installed_path：绝对路径过 appendEvent 的
  // redact 会被当成 ≥32 字词串掩掉（见测试），安装路径在账本里（installed_path 字段）。
  recordDraftEvent(store, found.source_run_id, "skill_draft_approved", {
      draft_name: name,
      run_id: found.source_run_id,
    });
  return { draft, installedPath };
}

/** 拒绝草稿（文件保留备查，状态 rejected；不删文件，免得误删人的修改）。 */
export function rejectDraft(home: string, name: string, store: RunStore): SkillDraft {
  const found = findDraft(home, name);
  if (!found) throw new SkillDraftError(`没有名为 ${name} 的技能草稿（先 nyra skills drafts 看看）`);
  if (found.status !== "pending") {
    throw new SkillDraftError(`草稿 ${name} 当前状态是 ${found.status}，只有 pending 的草稿能拒绝`);
  }
  const draft = updateDraft(home, name, { status: "rejected" });
  recordDraftEvent(store, found.source_run_id, "skill_draft_rejected", {
      draft_name: name,
      run_id: found.source_run_id,
    });
  return draft;
}

/** 手动归档草稿（pending / rejected → archived；已安装的不走这里，走 sweep）。 */
export function archiveDraft(home: string, name: string, reason: string, store: RunStore): SkillDraft {
  const found = findDraft(home, name);
  if (!found) throw new SkillDraftError(`没有名为 ${name} 的技能草稿（先 nyra skills drafts 看看）`);
  if (found.status !== "pending" && found.status !== "rejected") {
    throw new SkillDraftError(`草稿 ${name} 当前状态是 ${found.status}，不能归档`);
  }
  const draft = updateDraft(home, name, { status: "archived", archive_reason: reason || "人工归档" });
  recordDraftEvent(store, found.source_run_id, "skill_archived", {
      draft_name: name,
      reason: draft.archive_reason ?? "",
      source: "manual",
    });
  return draft;
}

export interface SweepResult {
  archived: { name: string; from: string; to: string; reason: string }[];
  kept: number;
  dryRun: boolean;
}

/**
* 归档长期没人用的已装技能（只动用户自己的 `~/.nyra/skills/`，项目技能与
* 插件技能不动——那些是协作资产，不是个人沉淀）。
* 判定：用量账本有 last_used_at 就用它；没记录的技能用文件 mtime 兜底
* （用量统计从本批才开始，老技能没有使用记录，直接按 mtime 算会误删“一直
* 在用但没记上”的技能吗——不会：没记录 + 文件又老，说明它在统计开始前就
* 已经长期没动过；刚装的技能 mtime 是新的，不会被扫走）。
* 归档 = 文件移进 `~/.nyra/skills-archive/` + 审计行写进 `skills-archive.jsonl`
* （没有运行上下文可写事件，jsonl 就是审计账本）。
*/
export function sweepStaleSkills(
  home: string,
  opts: { config?: Record<string, unknown>; dryRun?: boolean; now?: Date } = {},
): SweepResult {
  const cfg = skillSedimentationConfig(opts.config ?? {});
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const thresholdMs = cfg.auto_archive_days * 24 * 60 * 60 * 1000;
  const usage = loadSkillUsage(home);
  const skillsDir = join(home, "skills");
  const archived: SweepResult["archived"] = [];
  let kept = 0;
  if (!existsSync(skillsDir)) return { archived, kept, dryRun };
  const archiveDir = skillArchiveDir(home);
  for (const file of readdirSync(skillsDir).filter((f) => f.endsWith(".md")).sort()) {
    const from = join(skillsDir, file);
    let skillName: string;
    try {
      skillName = parseSkillText(readFileSync(from, "utf-8"), from).name;
    } catch {
      kept++;
      continue;
    }
    const lastUsed = usage[skillName]?.last_used_at;
    const refMs = lastUsed ? Date.parse(lastUsed) : statSync(from).mtimeMs;
    if (Number.isNaN(refMs) || now.getTime() - refMs < thresholdMs) {
      kept++;
      continue;
    }
    const reason = lastUsed
    ? `超过 ${cfg.auto_archive_days} 天没人用（最后使用 ${lastUsed.slice(0, 10)}）`
    : `无使用记录，且文件超过 ${cfg.auto_archive_days} 天没动过（最后修改 ${new Date(refMs).toISOString().slice(0, 10)}）`;
    let to = join(archiveDir, `${skillName}.md`);
    if (existsSync(to)) to = join(archiveDir, `${skillName}-${now.toISOString().replace(/[:.]/g, "-")}.md`);
    if (!dryRun) {
      mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
      renameSync(from, to);
      appendFileSync(
        skillArchiveLogPath(home),
        JSON.stringify({ at: now.toISOString(), name: skillName, reason, from, to }) + "\n",
        "utf-8",
      );
    }
    archived.push({ name: skillName, from, to, reason });
  }
  return { archived, kept, dryRun };
}
