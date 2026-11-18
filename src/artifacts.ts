// src/artifacts.ts — 产物（Artifacts）存储/检测/Markdown 渲染，
// 与 Python 版 nyra/artifacts.py 同语义。
// 产物存为 NYRA_HOME/artifacts/<session_id>/<12位hex>.json；内容超 1MB 截断；
// 每会话最多 50 个，超了删最旧的。内容永不执行；markdown_to_html 先转义
// 再做 Markdown 变换，源码里的 HTML 永远成不了标记。
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNyraHome } from "./memory.ts";

export const MAX_CONTENT_BYTES = 1_048_576;
export const MAX_PER_SESSION = 50;
export const KINDS = ["markdown", "html", "code"] as const;
export type ArtifactKind = (typeof KINDS)[number];

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const ARTIFACT_ID_RE = /^[0-9a-f]{12}$/;
const FENCE_GLOBAL_RE = /^[ \t]{0,3}```([^\s`]*)[ \t]*\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$/gm;
const HTML_START_RE = /^\s*<(?:!DOCTYPE\s+html|html|body|div|section|article|main|table|ul|ol|form|svg|details|blockquote|pre|h[1-6]|p)\b/i;
const HTML_CLOSE_RE = /<\/[A-Za-z][A-Za-z0-9]*\s*>/;

export interface ArtifactRecord {
  id: string;
  session_id: string;
  title: string;
  kind: ArtifactKind;
  lang: string;
  content: string;
  created_at: string;
  truncated: boolean;
}

export type ArtifactMeta = Omit<ArtifactRecord, "content">;

function homeDir(home?: string): string { return resolveNyraHome(home); }

function ensureDir(path: string): void {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true });
  if (!existed) { try { chmodSync(path, 0o700); } catch { /* ignore */ } }
}

function checkSessionId(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`会话 ID 无效：${sessionId}`);
  return sessionId;
}

function sessionDir(sessionId: string, home?: string): string {
  return join(homeDir(home), "artifacts", checkSessionId(sessionId));
}

function readRecord(path: string): ArtifactRecord | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as ArtifactRecord;
    if (!data || typeof data !== "object" || typeof data.id !== "string") return null;
    return data;
  } catch { return null; }
}

function meta(record: ArtifactRecord): ArtifactMeta {
  const { content: _omit, ...rest } = record;
  void _omit;
  return rest;
}

export function createArtifact(
  sessionId: string, title: string, kind: string, content: string, lang?: string | null, home?: string,
): ArtifactRecord {
  if (!KINDS.includes(kind as ArtifactKind)) throw new Error(`未知的产物类型：${kind}，可用：${KINDS.join("、")}`);
  if (typeof content !== "string") throw new Error("产物内容必须是字符串");
  checkSessionId(sessionId);
  const cleanTitle = ((title || "").trim() || "未命名产物").slice(0, 200);
  let encoded = Buffer.from(content, "utf-8");
  let truncated = encoded.length > MAX_CONTENT_BYTES;
  if (truncated) content = encoded.subarray(0, MAX_CONTENT_BYTES).toString("utf-8");
  const record: ArtifactRecord = {
    id: randomBytes(6).toString("hex"),
    session_id: sessionId,
    title: cleanTitle,
    kind: kind as ArtifactKind,
    lang: (lang || "").trim().slice(0, 40),
    content,
    created_at: new Date().toISOString(),
    truncated,
  };
  const directory = sessionDir(sessionId, home);
  ensureDir(directory);
  const path = join(directory, `${record.id}.json`);
  const tmp = join(directory, `.${record.id}.tmp`);
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
  renameSync(tmp, path);
  enforceSessionCap(directory);
  return record;
}

function enforceSessionCap(directory: string): void {
  let paths: string[] = [];
  try { paths = readdirSync(directory).filter((f) => f.endsWith(".json")).map((f) => join(directory, f)); } catch { return; }
  if (paths.length <= MAX_PER_SESSION) return;
  const stamped = paths.map((p) => {
    const r = readRecord(p);
    return { created: r?.created_at ?? "", path: p, name: p.split("/").pop() ?? "" };
  });
  stamped.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.name < b.name ? -1 : 1));
  for (const item of stamped.slice(0, paths.length - MAX_PER_SESSION)) {
    try { rmSync(item.path); } catch { /* ignore */ }
  }
}

export function getArtifact(artifactId: string, home?: string): ArtifactRecord | null {
  if (typeof artifactId !== "string" || !ARTIFACT_ID_RE.test(artifactId)) return null;
  const base = join(homeDir(home), "artifacts");
  if (!existsSync(base)) return null;
  for (const dir of readdirSync(base)) {
    const p = join(base, dir, `${artifactId}.json`);
    if (!existsSync(p)) continue;
    const record = readRecord(p);
    if (record && record.id === artifactId) return record;
  }
  return null;
}

export function listArtifacts(sessionId: string, home?: string): ArtifactMeta[] {
  const directory = sessionDir(sessionId, home);
  if (!existsSync(directory)) return [];
  const records: ArtifactRecord[] = [];
  for (const f of readdirSync(directory).filter((x) => x.endsWith(".json")).sort()) {
    const r = readRecord(join(directory, f));
    if (r) records.push(r);
  }
  records.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
  return records.map(meta);
}

function scanHtmlBlocks(lines: string[]): [number, number][] {
  const blocks: [number, number][] = [];
  let i = 0;
  while (i < lines.length) {
    if (!HTML_START_RE.test(lines[i])) { i += 1; continue; }
    let j = i;
    let seenClose = false;
    while (j < lines.length) {
      if (HTML_CLOSE_RE.test(lines[j])) seenClose = true;
      if (seenClose) {
        const nxt = j + 1 < lines.length ? lines[j + 1] : "";
        if (nxt.trim() === "" || nxt.trimStart().startsWith("<")) { j += 1; continue; }
        break;
      }
      j += 1;
    }
    if (seenClose) { blocks.push([i, Math.min(j + 1, lines.length)]); i = j + 1; }
    else i += 1;
  }
  return blocks;
}

export interface DetectedArtifact { title: string; kind: ArtifactKind; lang: string; content: string; }

export function detectArtifacts(text: string): [string, DetectedArtifact[]] {
  if (!text) return ["", []];
  const artifacts: DetectedArtifact[] = [];
  const remaining = text.replace(FENCE_GLOBAL_RE, (_m, lang: string, body: string) => {
    const l = (lang || "").trim();
    if (l.toLowerCase() === "html") artifacts.push({ title: "HTML 页面", kind: "html", lang: l, content: body });
    else artifacts.push({ title: l ? `${l} 代码` : "代码片段", kind: "code", lang: l, content: body });
    return `[产物：${artifacts[artifacts.length - 1].title}]\n`;
  });
  const lines = remaining.split("\n");
  const blocks = scanHtmlBlocks(lines);
  if (blocks.length) {
    const rebuilt: string[] = [];
    let last = 0;
    for (const [start, end] of blocks) {
      rebuilt.push(...lines.slice(last, start));
      const content = lines.slice(start, end).join("\n").replace(/^\n+|\n+$/g, "");
      artifacts.push({ title: "HTML 页面", kind: "html", lang: "html", content });
      rebuilt.push("[产物：HTML 页面]");
      last = end;
    }
    rebuilt.push(...lines.slice(last));
    return [rebuilt.join("\n"), artifacts];
  }
  return [remaining, artifacts];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function markdownToHtml(text: string): string {
  const blocks: string[] = [];
  let s = (text || "").replace(FENCE_GLOBAL_RE, (_m, _lang: string, body: string) => {
    blocks.push(body);
    return `\x00${blocks.length - 1}\x00`;
  });
  s = escapeHtml(s);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^\*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^\*\n]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/(^|[\s(（：:，,])(https?:\/\/[^\s<)），。]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  const out: string[] = [];
  let lst: string | null = null;
  for (const line of s.split("\n")) {
    let m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m) {
      if (lst !== "ul") { if (lst) out.push(`</${lst}>`); out.push("<ul>"); lst = "ul"; }
      out.push(`<li>${m[1]}</li>`);
      continue;
    }
    m = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (m) {
      if (lst !== "ol") { if (lst) out.push(`</${lst}>`); out.push("<ol>"); lst = "ol"; }
      out.push(`<li>${m[1]}</li>`);
      continue;
    }
    if (lst) { out.push(`</${lst}>`); lst = null; }
    m = line.match(/^#{1,3}\s+(.*)$/);
    if (m) { out.push(`<h3>${m[1]}</h3>`); continue; }
    m = line.match(/^#{4,6}\s+(.*)$/);
    if (m) { out.push(`<h4>${m[1]}</h4>`); continue; }
    if (line.trim() === "") continue;
    out.push(`<p>${line}</p>`);
  }
  if (lst) out.push(`</${lst}>`);
  const joined = out.join("\n");
  return joined.replace(/\x00(\d+)\x00/g, (_m, n: string) => "<pre><code>" + escapeHtml(blocks[Number(n)] ?? "") + "</code></pre>");
}
