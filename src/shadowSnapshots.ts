// src/shadowSnapshots.ts — 缺口 9：影子快照 + 文件与会话联合回滚。
//
// 别家做法（只学能力，不抄实现）：Gemini CLI Checkpointing 在每次批准改文件
// 的工具调用前，先在影子 Git 仓里提交一次完整项目快照（不碰用户自己的 Git
// 历史），同时保存当时整段对话与该次工具调用，`/restore` 一键把文件与对话
// 一起恢复；Claude Code `/rewind` 与 Cline Checkpoints 支持只文件 / 只对话 /
// 两者一起三种恢复模式。
//
// Nyra 的做法（在现有 CheckpointStore 之上，默认开）：
// - 每次批准写操作后、执行前（tools.ts 的影子快照钩子）落一次快照：目标
//   文件的改前内容 + 当时整段 live 会话 + 该次工具调用的引用 + 已持久化
//   对话的水位（ConversationStore 的最后一条消息 id）。
// - 影子 Git 仓优先：`<home>/shadow/<workdir 指纹>/repo`，独立仓库，不碰
//   用户自己的 Git 历史；Git 不可用或写入失败时退回文件快照（同一目录下
//   的 `snapshots/<id>/`），并在快照记录里写明原因、经工具结果告诉用户，
//   绝不静默失败、绝不因快照失败拦住已批准的写操作。
// - 恢复三种模式（both / files / session），恢复前全量校验（快照内容
//   sha、目标在工作目录内、非符号链接），校验不过一律不改任何文件
//   （fail-closed）；恢复本身记进证据链（runs.ts 的 `restore` 事件）与
//   本目录的 `restores.jsonl`：回滚到哪个检查点、谁触发的、恢复了什么
//   文件与会话范围。
// - 索引是追加式 `index.jsonl`（损坏行跳过，与 runs.ts 的 events.jsonl
//   同口径），不是整文件重写，索引坏一行不丢其余快照。
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { join, resolve, relative, dirname, sep } from "node:path";
import { atomicWrite, MAX_FILE_BYTES } from "./checkpoints.ts";
import { scrubSecrets } from "./memoryExchange.ts";
import { rewindToSnapshot } from "./rewind.ts";
import type { ConversationStore } from "./conversations.ts";

export type RestoreMode = "both" | "files" | "session";
export const RESTORE_MODES: readonly RestoreMode[] = ["both", "files", "session"];

export class ShadowSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShadowSnapshotError";
  }
}

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => GitResult;

export interface ShadowSnapshotOptions {
  /** 测试注入：git 执行器；默认 spawnSync("git", ...)。 */
  gitRunner?: GitRunner | null;
  /** 测试注入：git 是否可用；默认跑 `git --version` 探测一次并缓存。 */
  gitAvailable?: (() => boolean) | null;
}

export interface SnapshotFileEntry {
  rel: string;
  /** 改前内容 sha256；文件不存在时为 null。 */
  before_sha: string | null;
  before_size: number | null;
  existed: boolean;
}

export interface SnapshotToolCall {
  tool: string;
  /** 目标相对路径；远端写 / 工作目录外写时为 null（只拍会话）。 */
  target: string | null;
  summary: string;
}

export interface SnapshotRecord {
  id: string;
  created_at: string;
  created_at_unix: number;
  session_id: string;
  workdir: string;
  tool_call: SnapshotToolCall;
  backend: "git" | "file";
  /** git 后端时的提交哈希；文件后端为 null。 */
  commit: string | null;
  files: SnapshotFileEntry[];
  files_skipped: { rel: string | null; reason: string }[];
  message_count: number;
  /** 已持久化对话的水位（最后一条消息 id）；快照时尚未持久化任何消息为 null。 */
  store_message_id: number | null;
  /** 文件后端的原因（Git 不可用 / Git 写入失败）；git 后端为 null。 */
  notice: string | null;
}

export interface ShadowSnapshotNotice {
  id: string;
  backend: "git" | "file";
  notice: string | null;
}

export interface RestoreResult {
  snapshot_id: string;
  session_id: string;
  mode: RestoreMode;
  backend: "git" | "file";
  files_restored: string[];
  files_deleted: string[];
  /** 仅会话 / 两者一起时为数字；只文件时为 null（未动会话）。 */
  messages_kept: number | null;
  messages_deleted: number | null;
  /** 仅会话 / 两者一起时为快照时刻的 live 会话（调用方据此重建内存会话）；只文件时为 null。 */
  live_messages: Record<string, unknown>[] | null;
  tool_call: SnapshotToolCall;
  notice: string | null;
}

export interface RestoreOptions {
  conversationStore?: ConversationStore | null;
  triggeredBy: string;
  /** 证据链回调（runs.ts 的 `restore` 事件口径）；写失败不影响恢复本身。 */
  recordEvidence?: ((fields: Record<string, unknown>) => void) | null;
}

export interface SnapshotOptions {
  /** 证据链回调（runs.ts 的 `snapshot` 事件口径）；写失败不影响快照本身。 */
  recordEvidence?: ((fields: Record<string, unknown>) => void) | null;
}

interface SessionPayload {
  version: number;
  snapshot_id: string;
  live_messages: Record<string, unknown>[];
  tool_call: SnapshotToolCall;
  store_message_id: number | null;
  message_count: number;
}

const META_DIR = ".nyra-shadow-meta";
const MAX_GIT_OUTPUT = 2000;

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function newSnapshotId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${randomBytes(3).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

/** 递归过 scrubSecrets：快照里的 live 会话不存明文凭据（与 conversations.record 同口径）。 */
function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrubSecrets(value)[0];
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubValue(v);
    return out;
  }
  return value;
}

function defaultGitRunner(args: string[], cwd: string): GitResult {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 30000 });
    return {
      status: r.status,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
    };
  } catch (err: unknown) {
    return { status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** 恢复后追加给模型的记录（Agent 与 CLI 共用同一份文案）：模型不要假设此前改动仍存在。 */
export function buildRestoreNote(result: RestoreResult): string {
  const modeText = result.mode === "both" ? "文件+会话" : result.mode === "files" ? "仅文件" : "仅会话";
  const fileText = result.files_restored.length || result.files_deleted.length
    ? `${result.files_restored.length + result.files_deleted.length} 个文件`
    : "无文件";
  return `[Nyra 恢复记录] 已从影子快照 ${result.snapshot_id} 恢复（${modeText}）：${fileText}；` +
    (result.messages_deleted !== null ? `对话删 ${result.messages_deleted} 条、留 ${result.messages_kept} 条。` : "对话未动。") +
    `原工具调用 ${result.tool_call.tool} ${result.tool_call.target ?? ""} 可重跑、修改后重跑，或忽略。` +
    "后续操作请重新读取文件，不要假设此前改动仍存在。";
}

export class ShadowSnapshotStore {
  readonly workdir: string;
  readonly directory: string;
  readonly repoDir: string;
  readonly fileDir: string;
  readonly sessionId: string;
  private gitRunner: GitRunner;
  private gitAvailableFn: (() => boolean) | null;
  private gitAvailableCache: boolean | null = null;

  constructor(home: string, workdir: string, sessionId = "", opts?: ShadowSnapshotOptions) {
    const resolved = resolve(workdir);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new ShadowSnapshotError("工作目录不存在");
    }
    this.workdir = resolved;
    this.sessionId = sessionId;
    const fingerprint = createHash("sha256").update(resolved, "utf-8").digest("hex").slice(0, 16);
    this.directory = join(home, "shadow", fingerprint);
    this.repoDir = join(this.directory, "repo");
    this.fileDir = join(this.directory, "snapshots");
    this.gitRunner = opts?.gitRunner ?? defaultGitRunner;
    this.gitAvailableFn = opts?.gitAvailable ?? null;
  }

  gitAvailable(): boolean {
    if (this.gitAvailableCache !== null) return this.gitAvailableCache;
    if (this.gitAvailableFn) {
      this.gitAvailableCache = this.gitAvailableFn();
      return this.gitAvailableCache;
    }
    this.gitAvailableCache = this.gitRunner(["--version"], this.workdir).status === 0;
    return this.gitAvailableCache;
  }

  private indexPath(): string {
    return join(this.directory, "index.jsonl");
  }

  private restoresPath(): string {
    return join(this.directory, "restores.jsonl");
  }

  private relativePath(path: string): string | null {
    const resolved = resolve(path);
    if (resolved === this.workdir || !resolved.startsWith(this.workdir + sep)) return null;
    return relative(this.workdir, resolved).split(sep).join("/");
  }

  /** 恢复时的目标校验（与 CheckpointStore 同口径）：工作目录内、非符号链接。 */
  private safePath(rel: string): string {
    const parts = rel.split("/").filter((p) => p !== "");
    if (!parts.length || parts.some((p) => p === "." || p === "..")) {
      throw new ShadowSnapshotError("快照文件路径超出工作目录");
    }
    if (rel.startsWith("/") || rel.includes("\\")) {
      throw new ShadowSnapshotError("快照文件路径超出工作目录");
    }
    const raw = join(this.workdir, ...parts);
    if (existsSync(raw) && lstatSync(raw).isSymbolicLink()) {
      throw new ShadowSnapshotError("文件已被替换为符号链接，不执行恢复");
    }
    const resolved = resolve(raw);
    if (resolved === this.workdir || !resolved.startsWith(this.workdir + sep)) {
      throw new ShadowSnapshotError("目标路径不在工作目录内");
    }
    return raw;
  }

  list(): SnapshotRecord[] {
    const path = this.indexPath();
    if (!existsSync(path)) return [];
    const out: SnapshotRecord[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as SnapshotRecord;
        if (rec && typeof rec === "object" && typeof rec.id === "string" && rec.workdir === this.workdir) {
          out.push(rec);
        }
      } catch { /* 损坏行跳过，不丢其余快照 */ }
    }
    // 新est在前：恢复时序号 1 即最新快照。
    return out.reverse();
  }

  resolve(ref: string): SnapshotRecord {
    const records = this.list();
    const byId = records.find((r) => r.id === ref);
    if (byId) return byId;
    if (/^\d+$/.test(ref)) {
      const idx = parseInt(ref, 10);
      if (idx >= 1 && idx <= records.length) return records[idx - 1];
    }
    throw new ShadowSnapshotError(
      records.length ? `没有这个检查点：${ref}（共 ${records.length} 个，用 nyra restore 列出）` : "暂无影子快照",
    );
  }

  private appendIndex(record: SnapshotRecord): void {
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(this.indexPath(), JSON.stringify(record) + "\n", "utf-8");
  }

  private readBefore(target: string): { data: Buffer | null; skipped: string | null } {
    if (!existsSync(target)) return { data: null, skipped: null };
    if (lstatSync(target).isSymbolicLink()) throw new ShadowSnapshotError("文件是符号链接，不拍快照");
    if (!statSync(target).isFile()) return { data: null, skipped: "不是普通文件" };
    if (statSync(target).size > MAX_FILE_BYTES) return { data: null, skipped: `文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MiB 快照限制` };
    const data = readFileSync(target);
    if (data.length > MAX_FILE_BYTES) return { data: null, skipped: `文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MiB 快照限制` };
    return { data, skipped: null };
  }

  private ensureRepo(): void {
    mkdirSync(this.repoDir, { recursive: true });
    if (!existsSync(join(this.repoDir, ".git"))) {
      const init = this.gitRunner(["-c", "init.defaultBranch=main", "init", "-q"], this.repoDir);
      if (init.status !== 0) throw new ShadowSnapshotError(`影子 Git 仓初始化失败：${(init.stderr || "git init 失败").slice(0, 200)}`);
      this.gitRunner(["config", "user.name", "nyra-shadow"], this.repoDir);
      this.gitRunner(["config", "user.email", "nyra-shadow@localhost"], this.repoDir);
    }
  }

  private gitCommitSnapshot(record: SnapshotRecord, files: { rel: string; data: Buffer | null }[], payload: SessionPayload): string {
    this.ensureRepo();
    for (const f of files) {
      const dest = join(this.repoDir, ...f.rel.split("/"));
      if (f.data === null) {
        rmSync(dest, { force: true });
      } else {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, f.data);
      }
    }
    const metaDir = join(this.repoDir, META_DIR, record.id);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "session.json"), JSON.stringify(payload, null, 0), "utf-8");
    writeFileSync(join(metaDir, "record.json"), JSON.stringify(record, null, 0), "utf-8");
    const add = this.gitRunner(["add", "-A"], this.repoDir);
    if (add.status !== 0) throw new ShadowSnapshotError(`影子 Git 仓暂存失败：${(add.stderr || "git add 失败").slice(0, 200)}`);
    const commit = this.gitRunner(["commit", "-q", "-m", `shadow snapshot ${record.id} ${record.tool_call.tool} ${record.tool_call.target ?? "-"}`], this.repoDir);
    if (commit.status !== 0) throw new ShadowSnapshotError(`影子 Git 仓提交失败：${(commit.stderr || "git commit 失败").slice(0, 200)}`);
    const head = this.gitRunner(["rev-parse", "HEAD"], this.repoDir);
    if (head.status !== 0 || !head.stdout.trim()) throw new ShadowSnapshotError("影子 Git 仓提交后读不到 HEAD");
    return head.stdout.trim();
  }

  private fileFallbackSnapshot(record: SnapshotRecord, files: { rel: string; data: Buffer | null }[], payload: SessionPayload): void {
    const dir = join(this.fileDir, record.id);
    mkdirSync(join(dir, "files"), { recursive: true });
    for (const f of files) {
      if (f.data === null) continue;
      const dest = join(dir, "files", ...f.rel.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.data);
    }
    writeFileSync(join(dir, "session.json"), JSON.stringify(payload, null, 0), "utf-8");
    writeFileSync(join(dir, "record.json"), JSON.stringify(record, null, 0), "utf-8");
  }

  /**
   * 批准写操作前落快照（钩子在“批准后、执行前”调用；targetAbs 为 null 时
   * 只拍会话，如远端写）。快照本身失败时抛错，由调用方决定（tools.ts 的
   * 钩子会吞掉并只发事件，绝不拦住已批准的写操作）。
   */
  snapshot(
    tool: string,
    targetAbs: string | null,
    summary: string,
    liveMessages: Record<string, unknown>[],
    sessionId: string,
    storeMessageId: number | null,
    opts?: SnapshotOptions,
  ): ShadowSnapshotNotice {
    if (typeof tool !== "string" || !tool.trim()) throw new ShadowSnapshotError("快照需要工具名");
    const id = newSnapshotId();
    const createdAt = nowIso();
    const rel = targetAbs === null ? null : this.relativePath(targetAbs);
    const files: SnapshotFileEntry[] = [];
    const filesSkipped: { rel: string | null; reason: string }[] = [];
    const filePayloads: { rel: string; data: Buffer | null }[] = [];
    if (targetAbs === null) {
      filesSkipped.push({ rel: null, reason: "远端写操作，只拍会话" });
    } else if (rel === null) {
      filesSkipped.push({ rel: null, reason: "目标不在工作目录内，只拍会话" });
    } else {
      const target = resolve(this.workdir, ...rel.split("/"));
      const { data, skipped } = this.readBefore(target);
      if (skipped) {
        filesSkipped.push({ rel, reason: skipped });
      } else {
        files.push({ rel, before_sha: data === null ? null : digest(data), before_size: data === null ? null : data.length, existed: data !== null });
        filePayloads.push({ rel, data });
      }
    }
    const toolCall: SnapshotToolCall = { tool, target: rel, summary: typeof summary === "string" ? summary.slice(0, 500) : "" };
    const payload: SessionPayload = {
      version: 1,
      snapshot_id: id,
      live_messages: (Array.isArray(liveMessages) ? liveMessages : []).map((m) => scrubValue(m) as Record<string, unknown>),
      tool_call: toolCall,
      store_message_id: storeMessageId,
      message_count: Array.isArray(liveMessages) ? liveMessages.length : 0,
    };
    const record: SnapshotRecord = {
      id, created_at: createdAt, created_at_unix: Date.now() / 1000,
      session_id: sessionId, workdir: this.workdir, tool_call: toolCall,
      backend: "git", commit: null, files, files_skipped: filesSkipped,
      message_count: payload.message_count, store_message_id: storeMessageId, notice: null,
    };
    if (this.gitAvailable()) {
      try {
        record.commit = this.gitCommitSnapshot(record, filePayloads, payload);
      } catch (err: unknown) {
        // Git 写入失败不静默、不拦写操作：退回文件快照并写明原因。
        record.backend = "file";
        record.commit = null;
        record.notice = `影子 Git 仓写入失败（${err instanceof Error ? err.message : String(err)}），已退回文件快照`;
        this.fileFallbackSnapshot(record, filePayloads, payload);
      }
    } else {
      record.backend = "file";
      record.notice = "本机未安装 Git，已退回文件快照（恢复能力相同，只是不走 Git 提交）";
      this.fileFallbackSnapshot(record, filePayloads, payload);
    }
    this.appendIndex(record);
    try {
      opts?.recordEvidence?.({
        snapshot_id: record.id, tool, backend: record.backend,
        files: files.map((f) => f.rel).join(","),
      });
    } catch { /* 证据链写失败不影响快照本身 */ }
    return { id: record.id, backend: record.backend, notice: record.notice };
  }

  private readSessionPayload(record: SnapshotRecord): SessionPayload {
    let raw: string;
    if (record.backend === "git") {
      if (!record.commit) throw new ShadowSnapshotError(`检查点 ${record.id} 缺少提交记录，无法恢复`);
      const out = this.gitRunner(["show", `${record.commit}:${META_DIR}/${record.id}/session.json`], this.repoDir);
      if (out.status !== 0) throw new ShadowSnapshotError(`检查点 ${record.id} 的会话快照读不出来，恢复中止`);
      raw = out.stdout;
    } else {
      const path = join(this.fileDir, record.id, "session.json");
      if (!existsSync(path)) throw new ShadowSnapshotError(`检查点 ${record.id} 的会话快照不存在，恢复中止`);
      raw = readFileSync(path, "utf-8");
    }
    let payload: SessionPayload;
    try {
      payload = JSON.parse(raw) as SessionPayload;
    } catch {
      throw new ShadowSnapshotError(`检查点 ${record.id} 的会话快照已损坏，恢复中止`);
    }
    if (!payload || payload.version !== 1 || !Array.isArray(payload.live_messages)) {
      throw new ShadowSnapshotError(`检查点 ${record.id} 的会话快照格式不对，恢复中止`);
    }
    return payload;
  }

  private readFileBefore(record: SnapshotRecord, entry: SnapshotFileEntry): Buffer | null {
    let data: Buffer | null;
    if (record.backend === "git") {
      if (!record.commit) throw new ShadowSnapshotError(`检查点 ${record.id} 缺少提交记录，无法恢复`);
      if (!entry.existed) {
        const probe = this.gitRunner(["cat-file", "-e", `${record.commit}:${entry.rel}`], this.repoDir);
        if (probe.status === 0) throw new ShadowSnapshotError(`检查点 ${record.id} 的快照内容与记录不符（${entry.rel} 本不应存在），恢复中止`);
        return null;
      }
      const out = this.gitRunner(["show", `${record.commit}:${entry.rel}`], this.repoDir);
      if (out.status !== 0) throw new ShadowSnapshotError(`检查点 ${record.id} 的文件快照读不出来（${entry.rel}），恢复中止`);
      // git show 输出按字节处理：runner 用 utf-8 解码会损坏二进制；本批快照只覆盖
      // 文本写操作（write_file/edit_file/apply_patch/plan 均为 UTF-8 文本），此处
      // 按 UTF-8 还原并校验 sha，不符即中止。
      data = Buffer.from(out.stdout, "utf-8");
    } else {
      const path = join(this.fileDir, record.id, "files", ...entry.rel.split("/"));
      if (!entry.existed) {
        if (existsSync(path)) throw new ShadowSnapshotError(`检查点 ${record.id} 的快照内容与记录不符（${entry.rel} 本不应存在），恢复中止`);
        return null;
      }
      if (!existsSync(path)) throw new ShadowSnapshotError(`检查点 ${record.id} 的文件快照不存在（${entry.rel}），恢复中止`);
      data = readFileSync(path);
    }
    if (entry.before_sha === null) {
      if (data !== null) throw new ShadowSnapshotError(`检查点 ${record.id} 的快照内容与记录不符（${entry.rel}），恢复中止`);
      return null;
    }
    if (data === null || digest(data) !== entry.before_sha) {
      throw new ShadowSnapshotError(`检查点 ${record.id} 的快照内容校验失败（${entry.rel}），恢复中止`);
    }
    return data;
  }

  /**
   * 联合回滚：先全量校验（快照完整性、目标路径、会话水位），再统一应用；
   * 任一步失败都不改任何文件与会话。恢复后返回原工具调用，供重跑 / 修改 / 忽略。
   */
  restore(ref: string, mode: RestoreMode, opts: RestoreOptions): RestoreResult {
    if (!RESTORE_MODES.includes(mode)) throw new ShadowSnapshotError(`恢复模式无效：${mode}（应为 both / files / session）`);
    const record = this.resolve(ref);
    const wantFiles = mode === "both" || mode === "files";
    const wantSession = mode === "both" || mode === "session";
    // ---- 校验阶段（全有或全无，什么都不改） ----
    if (record.backend === "git") {
      if (!record.commit) throw new ShadowSnapshotError(`检查点 ${record.id} 缺少提交记录，无法恢复`);
      const probe = this.gitRunner(["cat-file", "-e", `${record.commit}^{commit}`], this.repoDir);
      if (probe.status !== 0) throw new ShadowSnapshotError(`检查点 ${record.id} 的影子提交不存在，恢复中止`);
    }
    let payload: SessionPayload | null = null;
    if (wantSession) payload = this.readSessionPayload(record);
    const restored: { target: string; rel: string; data: Buffer | null }[] = [];
    if (wantFiles) {
      for (const entry of record.files) {
        const target = this.safePath(entry.rel);
        const data = this.readFileBefore(record, entry);
        restored.push({ target, rel: entry.rel, data });
      }
    }
    let sessionResult: { kept: number; deleted: number } | null = null;
    if (wantSession && opts.conversationStore) {
      // 先校验水位消息属于本会话（rewindToSnapshot 内会再校验）；这里只确认
      // store 能打开，会话截断本身在应用阶段执行。
      void opts.conversationStore;
    }
    // ---- 应用阶段 ----
    const filesRestored: string[] = [];
    const filesDeleted: string[] = [];
    for (const item of restored) {
      if (item.data === null) {
        rmSync(item.target, { force: true });
        filesDeleted.push(item.rel);
      } else {
        atomicWrite(item.target, item.data);
        filesRestored.push(item.rel);
      }
    }
    if (wantSession && opts.conversationStore) {
      sessionResult = rewindToSnapshot(
        opts.conversationStore, record.session_id,
        record.store_message_id, record.created_at_unix,
      );
    }
    const filesJoined = [...filesRestored, ...filesDeleted].join(",");
    const result: RestoreResult = {
      snapshot_id: record.id, session_id: record.session_id, mode, backend: record.backend,
      files_restored: filesRestored, files_deleted: filesDeleted,
      messages_kept: sessionResult ? sessionResult.kept : null,
      messages_deleted: sessionResult ? sessionResult.deleted : null,
      live_messages: payload ? payload.live_messages : null,
      tool_call: record.tool_call,
      notice: record.notice,
    };
    // ---- 审计：回滚本身记进证据链 + 本地审计日志 ----
    mkdirSync(this.directory, { recursive: true });
    try {
      appendFileSync(this.restoresPath(), JSON.stringify({
        at: nowIso(), snapshot_id: record.id, triggered_by: opts.triggeredBy, mode,
        backend: record.backend, files_restored: filesRestored, files_deleted: filesDeleted,
        messages_kept: result.messages_kept, messages_deleted: result.messages_deleted,
      }) + "\n", "utf-8");
    } catch { /* 审计日志写失败不影响已完成的恢复 */ }
    try {
      const fields: Record<string, unknown> = {
        snapshot_id: record.id, triggered_by: opts.triggeredBy, mode, files: filesJoined,
      };
      if (sessionResult) {
        fields.messages_deleted = sessionResult.deleted;
        fields.messages_kept = sessionResult.kept;
      }
      opts.recordEvidence?.(fields);
    } catch { /* 证据链写失败不影响已完成的恢复 */ }
    return result;
  }
}

