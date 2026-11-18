// src/memoryExchange.ts — Nyra 记忆模式，与 Python 版 nyra/memory_exchange.py 同语义。
// 快照导入/导出、聊天 .zip 导入、本地 Codex/Claude 记忆只读；
// 安全硬规则：导出与导入两端都要过 scrubSecrets，含凭据的行直接删掉并计数；
// 导入只追加不覆盖；不做自动事实提炼。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { loadMemorySummary, appendMemory, resolveNyraHome } from "./memory.ts";

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

/** 删掉含凭据的行，返回（清理后的文本，删掉的行数）。 */
export function scrubSecrets(text: string): [string, number] {
  const kept: string[] = [];
  let removed = 0;
  for (const line of text.split("\n")) {
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
export function exportSnapshot(memoryPath?: string): string {
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
  return lines.join("\n");
}

/** 导入记忆快照：只追加不覆盖。memoryPath 是记忆文件路径（与 Python 版 memory_path 同语义）。 */
export function importSnapshot(text: string, memoryPath?: string): { added: number; skipped: number; removed: number } {
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
  return { added, skipped, removed };
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

export function importChatZip(zipPath: string, home?: string): { conversations: number; archived: string } {
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
  writeFileSync(archivePath, JSON.stringify(list, null, 2), "utf-8");
  // MEMORY.md 只记一行导入记录，不自动提炼事实。
  appendMemory(`从聊天导出导入 ${list.length} 条对话（原文存档：${archivePath}）`, join(h, "MEMORY.md"));
  return { conversations: list.length, archived: archivePath };
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
