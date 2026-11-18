// src/checkpoints.ts — 本地文件检查点（改前存档、/undo、/rewind），
// 与 Python 版 nyra/checkpoints.py 同语义：同任务只存首次原内容、
// 外部改动即中止、元数据篡改即拒绝、2 MiB 上限、每任务最多 20 个文件。
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { join, resolve, relative, dirname, sep } from "node:path";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TURN_FILES = 20;
export const MAX_REWIND = 10;
export const MAX_CHECKPOINTS = 20;

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

function digest(data: Buffer | null): string | null {
  return data === null ? null : createHash("sha256").update(data).digest("hex");
}

export function atomicWrite(path: string, payload: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.nyra-write-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, payload);
    if (existsSync(path)) {
      try { chmodSync(tmp, statSync(path).mode & 0o777); } catch { /* ignore */ }
    }
    renameSync(tmp, path);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

interface FileEntry {
  before: string | null;
  before_sha: string | null;
  after_sha?: string | null;
}

interface CheckpointRecord {
  version: number;
  workdir: string;
  undone: boolean;
  files: Record<string, FileEntry>;
}

export class CheckpointStore {
  readonly workdir: string;
  readonly directory: string;
  private active: CheckpointRecord | null = null;
  private activePath: string | null = null;

  constructor(baseDir: string, sessionId: string, workdir: string) {
    const resolved = resolve(workdir);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new CheckpointError("工作目录不存在");
    }
    this.workdir = resolved;
    const fingerprint = createHash("sha256").update(`${sessionId}\0${resolved}`, "utf-8").digest("hex").slice(0, 32);
    this.directory = join(baseDir, fingerprint);
  }

  beginTurn(): void {
    this.active = null;
    this.activePath = null;
  }

  private newRecord(): [string, CheckpointRecord] {
    mkdirSync(this.directory, { recursive: true });
    const name = `${String(process.hrtime.bigint()).padStart(20, "0")}-${randomBytes(6).toString("hex")}.json`;
    return [join(this.directory, name), { version: 1, workdir: this.workdir, undone: false, files: {} }];
  }

  private safePath(rel: string): string {
    if (typeof rel !== "string") throw new CheckpointError("检查点文件路径无效");
    const parts = rel.split("/").filter((p) => p !== "");
    if (!parts.length || parts.some((p) => p === "." || p === "..")) {
      throw new CheckpointError("检查点文件路径超出工作目录");
    }
    if (rel.startsWith("/") || rel.includes("\\")) throw new CheckpointError("检查点文件路径超出工作目录");
    const raw = join(this.workdir, ...parts);
    if (existsSync(raw) && lstatSync(raw).isSymbolicLink()) {
      throw new CheckpointError("文件已被替换为符号链接，不执行撤销");
    }
    const resolved = resolve(raw);
    if (resolved === this.workdir || !resolved.startsWith(this.workdir + sep)) {
      throw new CheckpointError("目标路径不在工作目录内");
    }
    return raw;
  }

  private relativePath(path: string): string {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new CheckpointError("拒绝对符号链接执行检查点写入");
    }
    const resolved = resolve(path);
    if (resolved === this.workdir || !resolved.startsWith(this.workdir + sep)) {
      throw new CheckpointError("目标路径不在工作目录内");
    }
    return relative(this.workdir, resolved).split(sep).join("/");
  }

  private content(path: string): Buffer | null {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new CheckpointError("文件已变成符号链接");
    if (!existsSync(path)) return null;
    if (!statSync(path).isFile()) throw new CheckpointError("检查点只能处理普通文件");
    if (statSync(path).size > MAX_FILE_BYTES) throw new CheckpointError("文件超过 2 MiB 检查点限制");
    const data = readFileSync(path);
    if (data.length > MAX_FILE_BYTES) throw new CheckpointError("文件超过 2 MiB 检查点限制");
    return data;
  }

  private save(path: string, record: CheckpointRecord): void {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new CheckpointError("检查点元数据路径不安全");
    atomicWrite(path, Buffer.from(JSON.stringify(record, null, 0), "utf-8"));
  }

  private records(): [string, CheckpointRecord][] {
    if (!existsSync(this.directory)) return [];
    const found: [string, CheckpointRecord][] = [];
    for (const file of readdirSync(this.directory).filter((f) => f.endsWith(".json")).sort()) {
      const path = join(this.directory, file);
      if (lstatSync(path).isSymbolicLink()) throw new CheckpointError("检查点元数据不能是符号链接");
      let record: CheckpointRecord;
      try {
        record = JSON.parse(readFileSync(path, "utf-8")) as CheckpointRecord;
      } catch {
        throw new CheckpointError("检查点元数据损坏");
      }
      if (!record || typeof record !== "object" || record.version !== 1 ||
        record.workdir !== this.workdir || !record.files || typeof record.files !== "object") {
        throw new CheckpointError("检查点元数据与当前工作目录不一致");
      }
      found.push([path, record]);
    }
    return found;
  }

  writeText(path: string, content: string): void {
    const payload = Buffer.from(content, "utf-8");
    if (payload.length > MAX_FILE_BYTES) throw new CheckpointError("写入超过 2 MiB 检查点限制");
    const rel = this.relativePath(path);
    const safePath = this.safePath(rel);
    const before = this.content(safePath);
    if (this.active === null) {
      const records = this.records();
      if (records.filter(([, r]) => !r.undone).length >= MAX_CHECKPOINTS) {
        throw new CheckpointError("未撤销的检查点已达 20 个，请先备份或整理");
      }
      const [p, rec] = this.newRecord();
      this.activePath = p;
      this.active = rec;
    }
    const items = this.active.files;
    if (!(rel in items) && Object.keys(items).length >= MAX_TURN_FILES) {
      throw new CheckpointError("单次任务最多修改 20 个有检查点的文件");
    }
    const previous: CheckpointRecord = { ...this.active, files: { ...items } };
    const entry: FileEntry = { ...(items[rel] ?? {}) } as FileEntry;
    if (!items[rel]) {
      entry.before = before === null ? null : before.toString("base64");
      entry.before_sha = digest(before);
    } else if (digest(before) !== entry.after_sha) {
      throw new CheckpointError("文件已被其他操作修改，拒绝继续覆盖");
    }
    entry.after_sha = digest(payload);
    this.active.files[rel] = entry;
    this.save(this.activePath!, this.active);
    try {
      mkdirSync(dirname(safePath), { recursive: true });
      const safeAgain = this.safePath(rel);
      atomicWrite(safeAgain, payload);
    } catch (err: unknown) {
      if (digest(this.content(safePath)) === digest(before)) {
        this.active = previous;
        if (Object.keys(previous.files).length) {
          this.save(this.activePath!, previous);
        } else {
          rmSync(this.activePath!, { force: true });
          this.active = null;
          this.activePath = null;
        }
      }
      throw err;
    }
  }

  recordPosition(): number {
    return this.records().length;
  }

  history(): { index: number; files: string[]; undone: boolean }[] {
    return this.records().map(([_, rec], i) => ({
      index: i + 1,
      files: Object.keys(rec.files),
      undone: rec.undone,
    }));
  }

  latestDiff(): string {
    const records = this.records().filter(([, r]) => !r.undone);
    if (!records.length) return "（暂无检查点）";
    const [, rec] = records[records.length - 1];
    return Object.keys(rec.files).map((f) => `  ${f}`).join("\n");
  }

  filesChangedSince(position: number): string[] {
    const records = this.records();
    const out = new Set<string>();
    for (let i = position; i < records.length; i++) {
      for (const f of Object.keys(records[i][1].files)) out.add(f);
    }
    return [...out];
  }

  undo(count = 1): { turns: number; files: number } {
    if (!Number.isInteger(count) || count < 1 || count > MAX_REWIND) {
      throw new CheckpointError(`撤销次数必须在 1 到 ${MAX_REWIND} 之间`);
    }
    const records = this.records().filter(([, r]) => !r.undone);
    if (count > records.length) {
      throw new CheckpointError(`只有 ${records.length} 个可撤销的检查点，无法撤销 ${count} 个`);
    }
    const toUndo = records.slice(-count);
    // 先全部校验（all-or-nothing），再统一恢复。校验按从新到旧模拟：
    // 同一文件被多轮改过时，旧轮次的“当前状态”是新轮次回退后的状态，
    // 用 simulated 字典模拟，不与磁盘现状直接比对（与 Python 版同语义）。
    const toUndoReversed = [...toUndo].reverse();
    const simulated = new Map<string, string | null>();
    const restore: { target: string; original: Buffer | null }[] = [];
    for (const [recordPath, record] of toUndoReversed) {
      void recordPath;
      for (const [rel, entry] of Object.entries(record.files)) {
        const safePath = this.safePath(rel);
        const current = simulated.has(rel) ? simulated.get(rel)! : digest(this.content(safePath));
        if (current !== entry.after_sha) {
          throw new CheckpointError(`文件 ${rel} 已被外部修改，撤销中止，未改动任何文件`);
        }
        let original: Buffer | null = null;
        if (entry.before !== null) {
          if (typeof entry.before !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.before) || entry.before.length % 4 !== 0) {
            throw new CheckpointError("检查点备份数据损坏");
          }
          original = Buffer.from(entry.before, "base64");
          if (digest(original) !== entry.before_sha) {
            throw new CheckpointError("检查点备份数据校验失败");
          }
        } else if (entry.before_sha !== null) {
          throw new CheckpointError("检查点备份数据校验失败");
        }
        simulated.set(rel, digest(original));
        restore.push({ target: safePath, original });
      }
    }
    // 全部校验通过后再实际写回；每次写回前再查一次符号链接。
    for (const item of restore) {
      const rel = relative(this.workdir, resolve(item.target)).split(sep).join("/");
      const target = this.safePath(rel);
      if (item.original === null) {
        rmSync(target, { force: true });
      } else {
        atomicWrite(target, item.original);
      }
    }
    for (const [recordPath, record] of toUndo) {
      record.undone = true;
      this.save(recordPath, record);
    }
    this.active = null;
    this.activePath = null;
    return { turns: toUndo.length, files: new Set(restore.map((r) => r.target)).size };
  }
}
