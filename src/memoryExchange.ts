// src/memoryExchange.ts — Nyra 记忆模式，与 Python 版 nyra/memory_exchange.py 同语义。
// 快照导入/导出、聊天 .zip 导入、本地 Codex/Claude 记忆只读；
// 安全硬规则：导出与导入两端都要过 scrubSecrets，含凭据的行直接删掉并计数；
// 聊天 zip 的存档文件落盘前也要过同一套脱敏；导入只追加不覆盖；不做自动事实提炼。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { loadMemorySummary, appendMemory, resolveNyraHome } from "./memory.ts";
import {
  listStyleProfiles, loadStyleProfile, saveStyleProfile, validateChannel,
  type StyleProfile,
} from "./style.ts";

export const SNAPSHOT_SECTIONS = ["身份", "事实", "偏好", "目标与承诺", "关系"] as const;

const SECTION_ALIASES: Record<string, string[]> = {
  "身份": ["身份", "identity", "关于我", "who", "基本信息"],
  "事实": ["事实", "fact", "背景"],
  "偏好": ["偏好", "preference", "喜好", "习惯"],
  "目标与承诺": ["目标", "承诺", "commitment", "goal", "计划"],
  "关系": ["关系", "people", "relationship", "联系人", "家人", "朋友"],
};

const PLACEHOLDER_RES = [
  /^(暂无|无可靠信息|待补充|占位|不详|未知|n\/a|none|—|–|-)\s*[。；;,.]?$/i,
];

// 凭据行模式：只认“键 + 赋值号”或明确的 token 格式，prose 里提到 token 一词不会被误删。
const SECRET_RES = [
  /(api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret)\s*[:=：]/i,
  /(password|passwd|pwd)\s*[:=：]/i,
  /\bbearer\s+[A-Za-z0-9._\-]{8,}/i,
  /\btoken\s*[:=：]\s*\S/i,
  /(authorization|auth[_-]?token)\s*[:=：]/i,
  /(cookie|set-cookie)\s*[:=：]/i,
  /(credential|credentials)\s*[:=：]/i,
  /private[_-]?key\s*[:=：]/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
  /sk-[A-Za-z0-9_-]{8,}/,
  /\bgh[opsu]_[A-Za-z0-9]{10,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
];

export class SnapshotError extends Error {
  constructor(message: string) { super(message); this.name = "SnapshotError"; }
}
export class LocalMemoryNotFound extends Error {
  constructor(message: string) { super(message); this.name = "LocalMemoryNotFound"; }
}
export class ChatZipError extends Error {
  constructor(message: string) { super(message); this.name = "ChatZipError"; }
}

/** 删掉含凭据的行，返回（清理后的文本，删掉的行数）。
 * PEM 私钥块整块删：从 BEGIN 行删到 END 行（审查报告第 8 项；
 * 旧版只删 BEGIN 这一行，密钥体还留在存档里）。 */
export function scrubSecrets(text: string): [string, number] {
  const kept: string[] = [];
  let removed = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(line)) {
      removed += 1;
      while (i + 1 < lines.length) {
        i += 1;
        removed += 1;
        if (/-----END [A-Z ]*PRIVATE KEY-----/i.test(lines[i])) break;
      }
      continue;
    }
    if (SECRET_RES.some((p) => p.test(line))) { removed += 1; continue; }
    kept.push(line);
  }
  return [kept.join("\n").trim(), removed];
}

function isPlaceholder(bullet: string): boolean {
  const text = bullet.trim().replace(/[。；;,.\s]+$/g, "").trim();
  return !text || PLACEHOLDER_RES.some((p) => p.test(text));
}

function canonicalSection(heading: string): string | null {
  const text = heading.trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.some((a) => text.includes(a))) return canonical;
  }
  return null;
}

export function parseMarkdownSections(text: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let current = "事实";
  let inFence = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      current = canonicalSection(heading[1]) ?? "事实";
      continue;
    }
    const bullet = /^(?:[-*•]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    const content = bullet ? bullet[1].trim() : line;
    if (isPlaceholder(content)) continue;
    (sections[current] ??= []).push(content);
  }
  return sections;
}

/** 导出记忆快照。memoryPath 是记忆文件路径（与 Python 版 memory_path 同语义）；不传则用 ~/.nyra/MEMORY.md。 */
export function exportSnapshot(memoryPath?: string, home?: string): string {
  const target = memoryPath ?? join(resolveNyraHome(), "MEMORY.md");
  if (!existsSync(target)) {
    throw new SnapshotError(`记忆为空：${target} 不存在，先写几条记忆再导出`);
  }
  const summary = loadMemorySummary(undefined, target);
  const [cleaned, removed] = scrubSecrets(summary);
  const sections = parseMarkdownSections(cleaned);
  if (!Object.keys(sections).length) {
    throw new SnapshotError("记忆脱敏后没有剩余内容，无法导出快照");
  }
  const lines = ["# Nyra 记忆快照", ""];
  for (const section of SNAPSHOT_SECTIONS) {
    const items = sections[section] ?? [];
    if (!items.length) continue;
    lines.push(`## ${section}`);
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  }
  if (removed) lines.push(`<!-- 已删掉 ${removed} 行含凭据的内容 -->`);
  // 缺口 4：画像随记忆快照一起导出（没有画像时输出与以前完全一致）。
  const stylesText = exportStylesSnapshot(home ?? join(target, ".."));
  if (stylesText) lines.push(stylesText);
  return lines.join("\n");
}

// ---- 缺口 4：文风画像随记忆快照导入/导出 ----
//
// 画像是提炼出的习惯描述，不是样本原文；导出与导入两端仍过同一套
// scrubSecrets（备注是用户手写的自由文本，可能含凭据），含凭据的行
// 直接删掉并计数。导入只追加不覆盖：同渠道已有画像就跳过。

/** 把全部画像导成 Markdown（无画像返回 ""）。 */
export function exportStylesSnapshot(home: string): string {
  const channels = listStyleProfiles(home);
  if (!channels.length) return "";
  const chunks: string[] = [];
  let removedTotal = 0;
  for (const channel of channels) {
    let profile: StyleProfile | null = null;
    try { profile = loadStyleProfile(home, channel); } catch { continue; }
    if (!profile) continue;
    const body = [
      `## 文风画像（${profile.channel}）`,
      `- 语气：${profile.tone}`,
      `- 长度：${profile.length}（典型约 ${profile.typical_chars} 字）`,
      `- 问候：${profile.greeting}`,
      `- 落款：${profile.signoff}`,
      `- 标点：${profile.punctuation}`,
      `- 缩写：${profile.abbreviations}`,
      ...(profile.notes ? [`- 备注：${profile.notes}`] : []),
      `- 样本数：${profile.sample_count}`,
      ...(profile.learned_at ? [`- 更新时间：${profile.learned_at}`] : []),
      "",
    ].join("\n");
    const [cleaned, removed] = scrubSecrets(body);
    removedTotal += removed;
    chunks.push(cleaned);
  }
  if (!chunks.length) return "";
  const out = chunks.join("\n");
  return removedTotal ? out + `\n<!-- 文风画像已删掉 ${removedTotal} 行含凭据的内容 -->\n` : out;
}

const STYLE_SECTION_RE = /^文风画像（([a-z][a-z0-9_-]{0,31})）$/;
const STYLE_LENGTH_RE = /^(短|中|长)(?:（典型约 (\d+) 字）)?$/;

/** 按 `## ` 标题原样切分（不走记忆快照的分区归一化，那边会把标题丢掉）。 */
function parseRawSections(text: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  let inFence = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { current = heading[1].trim(); continue; }
    if (current === null) continue;
    const bullet = /^(?:[-*•]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    const content = bullet ? bullet[1].trim() : line;
    if (isPlaceholder(content)) continue;
    (sections[current] ??= []).push(content);
  }
  return sections;
}

/** 从 Markdown 文本里导入文风画像：只追加不覆盖，同渠道已有就跳过。 */
export function importStylesSnapshot(home: string, text: string): { added: number; skipped: number; removed: number } {
  const [cleaned, removed] = scrubSecrets(text);
  let added = 0;
  let skipped = 0;
  const sections = parseRawSections(cleaned);
  for (const [heading, items] of Object.entries(sections)) {
    const m = STYLE_SECTION_RE.exec(heading);
    if (!m) continue;
    let channel: string;
    try { channel = validateChannel(m[1]); } catch { skipped += 1; continue; }
    if (loadStyleProfile(home, channel)) { skipped += 1; continue; }
    const fields: Record<string, string> = {};
    for (const item of items) {
      const kv = /^([^：:]+)[：:]\s*(.*)$/.exec(item);
      if (kv) fields[kv[1].trim()] = kv[2].trim();
    }
    const lengthM = STYLE_LENGTH_RE.exec(fields["长度"] ?? "");
    if (!["正式", "随意", "中性"].includes(fields["语气"] ?? "") || !lengthM) { skipped += 1; continue; }
    if (["问候", "落款", "标点", "缩写"].some((k) => !fields[k])) { skipped += 1; continue; }
    const profile: StyleProfile = {
      version: 1,
      channel,
      tone: fields["语气"] as StyleProfile["tone"],
      length: lengthM[1] as StyleProfile["length"],
      typical_chars: lengthM[2] ? parseInt(lengthM[2], 10) : 0,
      greeting: fields["问候"],
      signoff: fields["落款"],
      punctuation: fields["标点"],
      abbreviations: fields["缩写"],
      notes: fields["备注"] ?? "",
      sample_count: fields["样本数"] ? parseInt(fields["样本数"], 10) || 0 : 0,
      learned_at: fields["更新时间"] ?? new Date().toISOString(),
      source: "从记忆快照导入（本地）",
    };
    try {
      saveStyleProfile(home, profile);
      added += 1;
    } catch { skipped += 1; }
  }
  return { added, skipped, removed };
}

/** 导入记忆快照：只追加不覆盖。memoryPath 是记忆文件路径（与 Python 版 memory_path 同语义）。 */
export function importSnapshot(text: string, memoryPath?: string, home?: string): { added: number; skipped: number; removed: number; stylesAdded: number; stylesSkipped: number } {
  const target = memoryPath ?? join(resolveNyraHome(), "MEMORY.md");
  const [cleaned, removed] = scrubSecrets(text);
  const sections = parseMarkdownSections(cleaned);
  const existing = loadMemorySummary(undefined, target);
  let added = 0; let skipped = 0;
  for (const section of SNAPSHOT_SECTIONS) {
    for (const item of sections[section] ?? []) {
      if (existing.toLowerCase().includes(item.toLowerCase())) { skipped += 1; continue; }
      appendMemory(`[${section}] ${item}`, target);
      added += 1;
    }
  }
  // 缺口 4：快照里带文风画像时一并导入（同渠道已有就跳过，不覆盖）。
  const styles = importStylesSnapshot(home ?? join(target, ".."), cleaned);
  return { added, skipped, removed, stylesAdded: styles.added, stylesSkipped: styles.skipped };
}

// -- 聊天 .zip 导入：最小 ZIP 读取器（stored + deflate），只取 conversations.json --
interface ZipEntry { name: string; method: number; data: Buffer; }

function readZipEntries(buf: Buffer): ZipEntry[] {
  // 从末尾找 End of Central Directory。
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ChatZipError("不是有效的 zip 文件");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ChatZipError("zip 中央目录已损坏");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf-8", p + 46, p + 46 + nameLen);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = inflateRawSync(comp);
    else throw new ChatZipError(`不支持的压缩方式：${method}`);
    entries.push({ name, method, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function importChatZip(zipPath: string, home?: string): { conversations: number; archived: string; removed: number } {
  if (!existsSync(zipPath)) throw new ChatZipError(`文件不存在：${zipPath}`);
  const buf = readFileSync(zipPath);
  let entries: ZipEntry[];
  try { entries = readZipEntries(buf); } catch (err: unknown) {
    throw new ChatZipError(err instanceof Error ? err.message : "zip 读取失败");
  }
  const conv = entries.find((e) => e.name === "conversations.json" || e.name.endsWith("/conversations.json"));
  if (!conv) throw new ChatZipError("zip 里没有 conversations.json");
  let list: unknown;
  try { list = JSON.parse(conv.data.toString("utf-8")); } catch { throw new ChatZipError("conversations.json 解析失败"); }
  if (!Array.isArray(list)) throw new ChatZipError("conversations.json 格式无效");
  const h = home ?? process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra");
  const archiveDir = join(h, "memory-imports");
  mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archivePath = join(archiveDir, `chat-${stamp}.json`);
  // 存档先脱敏再落盘（审查报告第 8 项）：聊天导出里常带 API Key、私钥，
  // 存档文件不能比记忆导出还松；与记忆导出同一套 scrubSecrets。
  // 按 JSON 结构逐值脱敏（不是按行扫整个文件）：PEM 块在 JSON 字符串里
  // 是转义的 \n，整行删会把后面的内容也吞掉；逐值脱敏则结构一定合法。
  let removed = 0;
  const scrubValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      const [cleaned, n] = scrubSecrets(value);
      removed += n;
      return cleaned;
    }
    if (Array.isArray(value)) return value.map(scrubValue);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubValue(v);
      return out;
    }
    return value;
  };
  const cleanedText = JSON.stringify(scrubValue(list), null, 2);
  writeFileSync(archivePath, cleanedText, "utf-8");
  // MEMORY.md 只记一行导入记录，不自动提炼事实。
  appendMemory(`从聊天导出导入 ${list.length} 条对话（原文存档：${archivePath}${removed ? `，已删掉 ${removed} 行含凭据的内容` : ""}）`, join(h, "MEMORY.md"));
  return { conversations: list.length, archived: archivePath, removed };
}

// -- 本地读记忆（只读） --
/** 只读读本地 Codex 记忆。home 是用户家目录（与 Python 版 read_local_agent_memory 的 home 同语义）。 */
export function readLocalCodex(home?: string): string {
  const base = home ?? process.env.HOME ?? "";
  const dbPath = join(base, ".codex", "memories_1.sqlite");
  if (!existsSync(dbPath)) throw new LocalMemoryNotFound(`本机没有 Codex 记忆库（${dbPath} 不存在）`);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err: unknown) {
    throw new LocalMemoryNotFound(`打不开 Codex 记忆库：${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // 本机 Codex 版本没有 memories 表，记忆在 stage1_outputs.raw_memory 里；
    // 两种表结构都支持，哪种有内容读哪种（与 Python 版 _read_codex_sqlite 同语义）。
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    const texts: string[] = [];
    if (tables.has("memories")) {
      const cols = (db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map((r) => r.name);
      const preferred = ["content", "memory", "text", "raw_memory", "summary", "note"];
      let textCol = cols.find((c) => preferred.includes(c.toLowerCase())) ?? null;
      if (textCol === null) {
        textCol = cols.find((c) => !["id", "created_at", "updated_at", "thread_id"].includes(c.toLowerCase())) ?? null;
      }
      if (textCol !== null) {
        const rows = db.prepare(`SELECT "${textCol.replace(/"/g, '""')}" AS v FROM memories`).all() as { v: unknown }[];
        for (const row of rows) if (row.v && String(row.v).trim()) texts.push(String(row.v).trim());
      }
    }
    if (!texts.length && tables.has("stage1_outputs")) {
      const cols = (db.prepare("PRAGMA table_info(stage1_outputs)").all() as { name: string }[]).map((r) => r.name);
      for (const col of ["raw_memory", "rollout_summary"]) {
        if (!cols.includes(col)) continue;
        const rows = db.prepare(`SELECT "${col}" AS v FROM stage1_outputs WHERE "${col}" IS NOT NULL AND "${col}" != ''`).all() as { v: unknown }[];
        for (const row of rows) if (row.v && String(row.v).trim()) texts.push(String(row.v).trim());
        if (texts.length) break;
      }
    }
    if (!texts.length) throw new LocalMemoryNotFound(`Codex 记忆库里没有内容：${dbPath}`);
    const [cleaned] = scrubSecrets(texts.join("\n"));
    return cleaned;
  } catch (err: unknown) {
    if (err instanceof LocalMemoryNotFound) throw err;
    throw new LocalMemoryNotFound(`读 Codex 记忆库失败：${err instanceof Error ? err.message : String(err)}`);
  } finally { db.close(); }
}

export function readLocalClaude(home?: string): string {
  const base = home ?? process.env.HOME ?? "";
  const candidates = [
    join(base, ".claude", "CLAUDE.md"),
    join(base, ".claude", "MEMORY.md"),
  ];
  const parts: string[] = [];
  for (const p of candidates) {
    if (existsSync(p)) parts.push(readFileSync(p, "utf-8"));
  }
  if (!parts.length) throw new LocalMemoryNotFound("本机没有 Claude 记忆文件（~/.claude/CLAUDE.md 不存在）");
  const [cleaned] = scrubSecrets(parts.join("\n\n"));
  return cleaned;
}

export function readLocalDir(dir: string): string {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new LocalMemoryNotFound(`目录不存在：${dir}`);
  const parts: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isFile() && /\.(md|txt)$/i.test(entry)) parts.push(readFileSync(p, "utf-8"));
  }
  if (!parts.length) throw new LocalMemoryNotFound(`目录里没有记忆文件：${dir}`);
  const [cleaned] = scrubSecrets(parts.join("\n\n"));
  return cleaned;
}

export const EXPORT_PROMPT =
  "请按以下格式输出一份关于用户的便携式记忆快照（Markdown），只写你确实知道的内容，不知道的写“暂无”，不要编造，不要包含任何密码、密钥或 token：\n\n" +
  "## 身份\n- ……\n\n## 事实\n- ……\n\n## 偏好\n- ……\n\n## 目标与承诺\n- ……\n\n## 关系\n- ……\n";
