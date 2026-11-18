// src/knowledge.ts — 本地 AI 知识库，与 Python 版 nyra/knowledge.py 同语义。
// kb.json + notes.jsonl；分块 ≤1500 字；BM25（英文词 + 中文单字与二元组）；
// ask 只按库内笔记回答，库内没有就直说不知道，不编造。
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync, fsyncSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomBytes } from "node:crypto";

export const MAX_NOTE_CHARS = 1500;
export const MIN_NOTE_CHARS = 200;
export const ASK_SYSTEM_PROMPT =
  "你是 Nyra 的知识库问答助手。只根据下面提供的库内笔记回答问题；" +
  "回答末尾注明依据了哪几条笔记（写笔记标题）；如果库内笔记没有" +
  "相关内容，就直说不知道，不要编造；不要使用笔记之外的知识。";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0 Safari/537.36";

export class KnowledgeError extends Error {
  constructor(message: string) { super(message); this.name = "KnowledgeError"; }
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Note {
  id: string; title: string; source: string; date: string; text: string; created_at: string;
}

function today(): string { return new Date().toISOString().slice(0, 10); }
function nowSeconds(): string {
  const d = new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, "");
}

function checkName(name: string): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new KnowledgeError("知识库名只允许字母、数字、下划线、点、横线");
  return name;
}

function checkDate(date: string | null | undefined): string {
  if (date === null || date === undefined) return today();
  if (typeof date !== "string" || !DATE_RE.test(date)) throw new KnowledgeError("日期须为 YYYY-MM-DD 格式");
  return date;
}

export function tokenize(text: string): string[] {
  const lower = (text || "").toLowerCase();
  const tokens: string[] = lower.match(/[a-z0-9]+/g) ?? [];
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (const ch of run) tokens.push(ch);
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

function splitLong(text: string, limit: number = MAX_NOTE_CHARS): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  const ends = ".。!！?？；;\n";
  while (rest.length > limit) {
    let cut = -1;
    for (const ch of ends) {
      const idx = rest.lastIndexOf(ch, limit - 1);
      if (idx > cut) cut = idx;
    }
    if (cut < limit / 2) cut = limit;
    else cut += 1;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

export function chunkText(text: string, fallbackTitle: string): [string, string][] {
  const sections: [string | null, string[]][] = [];
  let heading: string | null = null;
  let body: string[] = [];
  const flush = () => { sections.push([heading, body]); body = []; heading = null; };
  for (const line of text.split("\n")) {
    const m = /^(#{1,3})\s+(.*\S)\s*$/.exec(line);
    if (m) { flush(); heading = m[2].trim(); continue; }
    body.push(line);
  }
  flush();
  const chunks: [string, string][] = [];
  for (const [sectionTitle, lines] of sections) {
    const title = sectionTitle || fallbackTitle;
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const line of lines) {
      if (line.trim()) current.push(line.trim());
      else if (current.length) { paragraphs.push(current.join(" ")); current = []; }
    }
    if (current.length) paragraphs.push(current.join(" "));
    let buffer = "";
    for (const para of paragraphs) {
      for (const piece of splitLong(para)) {
        if (buffer && buffer.length + 1 + piece.length > MAX_NOTE_CHARS) {
          chunks.push([title, buffer]);
          buffer = piece;
        } else {
          buffer = buffer ? `${buffer} ${piece}` : piece;
        }
      }
    }
    if (buffer) chunks.push([title, buffer]);
    else if (!paragraphs.length && sectionTitle) chunks.push([title, title]);
  }
  const merged: [string, string][] = [];
  for (const [title, bodyText] of chunks) {
    if (merged.length && merged[merged.length - 1][0] === title &&
      bodyText.length < MIN_NOTE_CHARS &&
      merged[merged.length - 1][1].length + 1 + bodyText.length <= MAX_NOTE_CHARS) {
      merged[merged.length - 1] = [title, `${merged[merged.length - 1][1]} ${bodyText}`];
    } else merged.push([title, bodyText]);
  }
  const seen = new Map<string, number>();
  const numbered: [string, string][] = [];
  for (const [title, bodyText] of merged) {
    const n = (seen.get(title) ?? 0) + 1;
    seen.set(title, n);
    numbered.push([n > 1 ? `${title}（${n}）` : title, bodyText]);
  }
  return numbered;
}

export function extractPageText(rawHtml: string): [string, string] {
  const titleMatch = /<title[^>]*>(.*?)<\/title>/is.exec(rawHtml);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, " ").trim()) : "";
  const descMatch = /<meta[^>]+name=["']description["'][^>]+content=["'](.*?)["']/is.exec(rawHtml);
  const description = descMatch ? decodeEntities(descMatch[1].trim()) : "";
  let body = rawHtml.replace(/<(script|style)[^>]*>.*?<\/\1>/gis, " ");
  body = body.replace(/<[^>]+>/g, " ");
  body = decodeEntities(body);
  body = body.replace(/[ \t\r\f\v]+/g, " ");
  body = body.replace(/\n\s*\n+/g, "\n\n");
  let text = body.trim();
  if (description && !text.includes(description)) text = text ? `${description}\n\n${text}` : description;
  return [title, text];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}

function atomicWrite(path: string, data: string | Buffer): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = join(join(path, ".."), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    if (typeof data === "string") writeSync(fd, data, null, "utf-8");
    else writeSync(fd, data);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (err) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw err; }
}

export class KnowledgeBase {
  base: string;

  constructor(base?: string | null) {
    this.base = base ?? join(process.env.NYRA_HOME ?? join(process.env.HOME ?? "", ".nyra"), "knowledge");
  }

  private kbDir(name: string): string { return join(this.base, checkName(name)); }
  private metaPath(name: string): string { return join(this.kbDir(name), "kb.json"); }
  private notesPath(name: string): string { return join(this.kbDir(name), "notes.jsonl"); }

  exists(name: string): boolean { return existsSync(this.metaPath(name)); }

  private require(name: string): string {
    const dir = this.kbDir(name);
    if (!existsSync(this.metaPath(name))) throw new KnowledgeError(`知识库不存在：${name}`);
    return dir;
  }

  private loadNotes(name: string): Note[] {
    this.require(name);
    const path = this.notesPath(name);
    if (!existsSync(path)) return [];
    const notes: Note[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { notes.push(JSON.parse(line) as Note); } catch {
        throw new KnowledgeError(`知识库笔记已损坏：${name}`);
      }
    }
    return notes;
  }

  private saveNotes(name: string, notes: Note[]): void {
    const data = notes.map((n) => JSON.stringify(n, null, 0) + "\n").join("");
    atomicWrite(this.notesPath(name), data);
  }

  create(name: string, description = ""): Record<string, unknown> {
    checkName(name);
    if (this.exists(name)) throw new KnowledgeError(`知识库已存在：${name}`);
    const meta = { name, description, created_at: nowSeconds() };
    atomicWrite(this.metaPath(name), JSON.stringify(meta, null, 2) + "\n");
    atomicWrite(this.notesPath(name), "");
    return meta;
  }

  listBases(): (Record<string, unknown> & { notes: number })[] {
    const out: (Record<string, unknown> & { notes: number })[] = [];
    if (!existsSync(this.base)) return out;
    for (const entry of readdirSync(this.base).sort()) {
      const metaPath = join(this.base, entry, "kb.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
        const name = (meta.name as string) || entry;
        let count = 0;
        try { count = this.loadNotes(name).length; } catch { count = 0; }
        out.push({ ...meta, notes: count });
      } catch { continue; }
    }
    return out;
  }

  remove(name: string): void {
    const dir = this.require(name);
    for (const p of [this.notesPath(name), this.metaPath(name)]) {
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
    }
    try { rmSync(dir, { recursive: false }); } catch { /* ignore */ }
  }

  addText(name: string, text: string, title: string, source: string, date?: string | null): Note[] {
    this.require(name);
    if (typeof text !== "string" || !text.trim()) throw new KnowledgeError("内容为空，没有可收录的笔记");
    const noteDate = checkDate(date);
    const created = nowSeconds();
    const notes = this.loadNotes(name);
    const added: Note[] = [];
    for (const [chunkTitle, chunkBody] of chunkText(text, title)) {
      added.push({
        id: randomBytes(6).toString("hex"), title: chunkTitle, source,
        date: noteDate, text: chunkBody, created_at: created,
      });
    }
    notes.push(...added);
    this.saveNotes(name, notes);
    return added;
  }

  addFile(name: string, path: string): Note[] {
    this.require(name);
    if (!existsSync(path) || !statSync(path).isFile()) throw new KnowledgeError(`文件不存在：${path}`);
    if (![".txt", ".md"].includes(extname(path).toLowerCase())) throw new KnowledgeError("只收录 .txt / .md 文件");
    let text: string;
    try { text = readFileSync(path, "utf-8"); } catch { throw new KnowledgeError(`读文件失败：${path}`); }
    const date = new Date(statSync(path).mtimeMs).toISOString().slice(0, 10);
    return this.addText(name, text, basename(path), path, date);
  }

  addDir(name: string, path: string): Note[] {
    this.require(name);
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new KnowledgeError(`目录不存在：${path}`);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && [".txt", ".md"].includes(extname(e.name).toLowerCase())) files.push(p);
      }
    };
    walk(path);
    const added: Note[] = [];
    for (const f of files) {
      try { added.push(...this.addFile(name, f)); } catch { continue; }
    }
    return added;
  }

  async addUrl(name: string, url: string): Promise<Note[]> {
    this.require(name);
    let response: Response;
    try {
      response = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(20000) });
    } catch { throw new KnowledgeError(`抓取失败：${url}`); }
    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType && !contentType.toLowerCase().includes("text/html")) throw new KnowledgeError(`不是网页，无法收录：${url}`);
    const buf = Buffer.from(await response.arrayBuffer());
    let charset = "utf-8";
    const m = /charset=([A-Za-z0-9_-]+)/i.exec(contentType);
    if (m) charset = m[1];
    let rawHtml: string;
    try { rawHtml = new TextDecoder(charset).decode(buf); } catch { rawHtml = buf.toString("utf-8"); }
    const [title, text] = extractPageText(rawHtml);
    if (!text.trim()) throw new KnowledgeError(`页面没有可收录的正文：${url}`);
    return this.addText(name, text, title || url, url);
  }

  search(name: string, query: string, topK = 5): [number, Note][] {
    const notes = this.loadNotes(name);
    const queryTokens = tokenize(query || "");
    if (!notes.length || !queryTokens.length) return [];
    const docTokens = notes.map((n) => tokenize(n.text ?? ""));
    const docLen = docTokens.map((t) => t.length);
    const avgLen = docLen.reduce((a, b) => a + b, 0) / docLen.length || 1.0;
    const docCount = notes.length;
    const docFreq = new Map<string, number>();
    for (const tokens of docTokens) {
      for (const t of new Set(tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
    const k1 = 1.5; const b = 0.75;
    const scored: [number, Note][] = [];
    for (let i = 0; i < notes.length; i++) {
      const tokens = docTokens[i];
      const counts = new Map<string, number>();
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      let score = 0;
      for (const token of new Set(queryTokens)) {
        const df = docFreq.get(token) ?? 0;
        if (!df) continue;
        const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
        const tf = counts.get(token) ?? 0;
        score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * docLen[i] / avgLen));
      }
      if (score > 0) scored.push([score, notes[i]]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, Math.max(topK, 0));
  }

  async ask(
    name: string,
    question: string,
    chatFn?: (messages: Record<string, unknown>[]) => Promise<string> | string,
  ): Promise<[string, Note[]]> {
    const results = this.search(name, question, 5);
    const used = results.map(([, n]) => n);
    let userContent: string;
    if (used.length) {
      const context = used.map((n) => `【${n.title ?? ""}】（来源：${n.source ?? ""}，日期：${n.date ?? ""}）\n${n.text ?? ""}`).join("\n\n");
      userContent = `问题：${question}\n\n库内相关笔记：\n${context}`;
    } else {
      userContent = `问题：${question}\n\n库内没有与该问题相关的笔记。`;
    }
    const messages = [
      { role: "system", content: ASK_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];
    const fn = chatFn ?? defaultChatFn;
    let answer = await fn(messages);
    if (typeof answer !== "string") answer = String(answer);
    return [answer, used];
  }
}

async function defaultChatFn(messages: Record<string, unknown>[]): Promise<string> {
  const { loadConfig, resolveProvider, resolveHome } = await import("./config.ts");
  const { Provider } = await import("./providers.ts");
  const config = loadConfig();
  const provider = new Provider(resolveProvider({ home: resolveHome(), config, providerName: config.provider as string, model: config.model as string }));
  const resp = await provider.chat(messages as never);
  const content = (resp as Record<string, unknown>).choices;
  if (!Array.isArray(content) || !content[0]) throw new KnowledgeError("模型返回了无法解析的回答");
  return ((content[0] as Record<string, unknown>).message as Record<string, unknown>)?.content as string ?? "";
}

export async function knowledgeMain(argv: string[], base?: string | null, chatFn?: (m: Record<string, unknown>[]) => Promise<string> | string): Promise<number> {
  const store = new KnowledgeBase(base ?? undefined);
  const cmd = argv[0];
  try {
    if (cmd === "create") {
      const descIdx = argv.indexOf("--description");
      const meta = store.create(argv[1], descIdx >= 0 ? argv[descIdx + 1] : "");
      process.stdout.write(`已创建知识库：${meta.name}\n`);
    } else if (cmd === "list") {
      const bases = store.listBases();
      if (!bases.length) process.stdout.write("还没有知识库，用 `create <名>` 新建一个。\n");
      for (const item of bases) {
        process.stdout.write(`${item.name}\t${item.notes} 条笔记` + (item.description ? `\t${item.description}` : "") + "\n");
      }
    } else if (cmd === "add") {
      const name = argv[1];
      if (!store.exists(name)) throw new KnowledgeError(`知识库不存在：${name}`);
      let added: Note[] = [];
      const fileIdx = argv.indexOf("--file");
      const dirIdx = argv.indexOf("--dir");
      const textIdx = argv.indexOf("--text");
      const urlIdx = argv.indexOf("--url");
      const titleIdx = argv.indexOf("--title");
      if (fileIdx >= 0) added = store.addFile(name, argv[fileIdx + 1]);
      else if (dirIdx >= 0) added = store.addDir(name, argv[dirIdx + 1]);
      else if (textIdx >= 0) added = store.addText(name, argv[textIdx + 1], titleIdx >= 0 ? argv[titleIdx + 1] : "手动输入", "手动输入");
      else if (urlIdx >= 0) added = await store.addUrl(name, argv[urlIdx + 1]);
      else throw new KnowledgeError("add 须指定 --file / --dir / --text / --url 之一");
      process.stdout.write(`已收录 ${added.length} 条笔记进 ${name}\n`);
    } else if (cmd === "search") {
      const name = argv[1];
      if (!store.exists(name)) throw new KnowledgeError(`知识库不存在：${name}`);
      const topIdx = argv.indexOf("--top-k");
      const results = store.search(name, argv[2], topIdx >= 0 ? parseInt(argv[topIdx + 1], 10) : 5);
      if (!results.length) process.stdout.write("没有找到相关笔记。\n");
      for (const [score, note] of results) {
        process.stdout.write(`${score.toFixed(2)}\t${note.title ?? ""}\t来源：${note.source ?? ""}\t日期：${note.date ?? ""}\n`);
      }
    } else if (cmd === "ask") {
      const name = argv[1];
      if (!store.exists(name)) throw new KnowledgeError(`知识库不存在：${name}`);
      const [answer, used] = await store.ask(name, argv[2], chatFn);
      process.stdout.write(answer + "\n");
      if (used.length) {
        process.stdout.write("\n依据笔记：\n");
        for (const n of used) process.stdout.write(`- ${n.title ?? ""}\n`);
      } else process.stdout.write("\n（库内没有相关笔记）\n");
    } else if (cmd === "remove") {
      const name = argv[1];
      if (!store.exists(name)) throw new KnowledgeError(`知识库不存在：${name}`);
      if (!argv.includes("--yes")) {
        process.stderr.write("删除须加 --yes 确认。\n");
        return 1;
      }
      store.remove(name);
      process.stdout.write(`已删除知识库：${name}\n`);
    } else {
      process.stderr.write("用法：nyra kb <create|list|add|search|ask|remove> …\n");
      return 2;
    }
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  return 0;
}
