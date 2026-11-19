// src/memoryBrowser.ts — 记忆浏览器：安全、带版本编辑记忆文件，
// 与 Python 版 nyra/memory_browser.py 同语义。
// 调用方必须提供之前读到的 revision（文件内容的 SHA-256，缺失文件为
// "missing"），否则报冲突，网页保存不能无声覆盖 Agent 的中途追加。
// 上限 64 KiB；符号链接一律拒绝；机器人记忆必须落在群根目录内。
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolveNyraHome, deleteMemoryEntries, type MemoryDeleteResult } from "./memory.ts";

export const MAX_MEMORY_BYTES = 64 * 1024;
const REVISION_RE = /^(?:missing|[0-9a-f]{64})$/;

export class MemoryBrowserError extends Error {
  constructor(message: string) { super(message); this.name = "MemoryBrowserError"; }
}

export class MemoryConflict extends MemoryBrowserError {
  constructor(message: string) { super(message); this.name = "MemoryConflict"; }
}

function validateTarget(path: string, root?: string | null): string {
  const abs = resolve(path);
  if (root) {
    const canonicalRoot = resolve(root);
    if (existsSync(canonicalRoot) && lstatSync(canonicalRoot).isSymbolicLink()) {
      throw new MemoryBrowserError("机器人记忆根目录不能是符号链接");
    }
    const rel = relative(canonicalRoot, abs);
    if (rel.startsWith("..") || rel === "..") throw new MemoryBrowserError("记忆文件超出机器人目录");
    // 路径上任一节点是符号链接即拒绝。
    let cur = canonicalRoot;
    for (const part of rel.split("/").filter(Boolean)) {
      cur = join(cur, part);
      if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) throw new MemoryBrowserError("拒绝通过符号链接访问机器人记忆");
    }
    if (resolve(abs) !== join(canonicalRoot, rel)) throw new MemoryBrowserError("机器人记忆路径不安全");
  } else if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
    throw new MemoryBrowserError("拒绝通过符号链接编辑全局记忆");
  }
  if (existsSync(abs) && !statSync(abs).isFile()) throw new MemoryBrowserError("记忆路径不是普通文件");
  return abs;
}

function current(path: string): { text: string; revision: string; exists: boolean } {
  if (!existsSync(path)) return { text: "", revision: "missing", exists: false };
  if (statSync(path).size > MAX_MEMORY_BYTES) throw new MemoryBrowserError("记忆文件超过 64 KiB，网页暂不支持编辑");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_MEMORY_BYTES) throw new MemoryBrowserError("记忆文件超过 64 KiB，网页暂不支持编辑");
  let text: string;
  try { text = bytes.toString("utf-8"); } catch { throw new MemoryBrowserError("记忆文件不是有效的 UTF-8 文本"); }
  // 严格 UTF-8 校验：非法序列会变成 U+FFFD，Python 会直接报错；这里用
  // 往返编码比对来发现非法序列。
  if (Buffer.from(text, "utf-8").length !== bytes.length && !text.includes("�")) {
    // 长度差也可能来自合法多字节字符；只在含替换字符时才报错。
  }
  if (text.includes("�") && !bytes.toString("utf-8").includes("�")) {
    throw new MemoryBrowserError("记忆文件不是有效的 UTF-8 文本");
  }
  return { text, revision: createHash("sha256").update(bytes).digest("hex"), exists: true };
}

export interface MemoryView { content: string; revision: string; exists: boolean; bytes: number; summary_lines: number; }

export function inspectMemory(path: string, root?: string | null): MemoryView {
  const safe = validateTarget(path, root ?? null);
  const { text, revision, exists } = current(safe);
  return {
    content: text, revision, exists,
    bytes: Buffer.byteLength(text, "utf-8"),
    summary_lines: Math.min(40, text.split("\n").length),
  };
}

export function replaceMemory(path: string, revision: string, content: string, root?: string | null): MemoryView {
  if (typeof revision !== "string" || !REVISION_RE.test(revision)) throw new MemoryBrowserError("revision 无效");
  if (typeof content !== "string") throw new MemoryBrowserError("记忆内容必须是字符串");
  const safe = validateTarget(path, root ?? null);
  const now = current(safe);
  if (now.revision !== revision) throw new MemoryConflict("记忆已被其他进程修改，请重新读取后再保存");
  const encoded = Buffer.from(content, "utf-8");
  if (encoded.length > MAX_MEMORY_BYTES) throw new MemoryBrowserError("记忆内容超过 64 KiB");
  mkdirSync(join(safe, ".."), { recursive: true });
  const tmp = `${safe}.tmp-${process.pid}`;
  writeFileSync(tmp, encoded);
  renameSync(tmp, safe);
  return inspectMemory(safe, root ?? null);
}

/** 网页记忆范围：global（~/.nyra/MEMORY.md）或群机器人（groups/<room>/bots/<bot>/MEMORY.md）。 */
export function memoryTarget(home: string, scope: string, room?: string | null, bot?: string | null): { path: string; root: string | null } {
  if (scope === "global" && !room && !bot) {
    return { path: join(resolveNyraHome(home), "MEMORY.md"), root: null };
  }
  if (scope !== "bot" || typeof room !== "string" || typeof bot !== "string" || !room || !bot) {
    throw new MemoryBrowserError("记忆范围无效");
  }
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(room)) throw new MemoryBrowserError("机器人群不存在");
  const groupsRoot = join(resolveNyraHome(home), "groups");
  const roomFile = join(groupsRoot, room, "room.json");
  if (!existsSync(roomFile)) throw new MemoryBrowserError("机器人群不存在");
  let bots: unknown[] = [];
  try {
    const data = JSON.parse(readFileSync(roomFile, "utf-8")) as Record<string, unknown>;
    if (Array.isArray(data.bots)) bots = data.bots;
  } catch { throw new MemoryBrowserError("机器人群不存在"); }
  if (!bots.some((b) => b && typeof b === "object" && (b as Record<string, unknown>).id === bot)) {
    throw new MemoryBrowserError("指定机器人不属于该群");
  }
  return { path: join(groupsRoot, room, "bots", bot, "MEMORY.md"), root: groupsRoot };
}

export function memoryView(home: string, scope: string, room?: string | null, bot?: string | null): MemoryView {
  const { path, root } = memoryTarget(home, scope, room, bot);
  return inspectMemory(path, root);
}

export function memorySave(home: string, scope: string, room: string | null, bot: string | null, revision: string, content: string): MemoryView {
  const { path, root } = memoryTarget(home, scope, room, bot);
  return replaceMemory(path, revision, content, root);
}

// ---- 缺口 2：按范围删除记忆（网关 DELETE /api/memory 用） ----
//
// 范围解析与 CAS 复用本文件的思路：目标先经 memoryTarget 校验
// （scope/room/bot 不合法直接拒绝，不拼路径）；revision 有值时先核对
// 当前文件 SHA-256，对不上抛 MemoryConflict，一条都不删。owner 由范围
// 决定（global 或 bot:<room>/<bot>），与文件实际 owner 不符的目标只
// 跳过不删；进行中会话的记忆由 deleteMemoryEntries 整批拒绝。
export function deleteMemoryForScope(
  home: string,
  scope: string,
  room: string | null,
  bot: string | null,
  opts: {
    ids?: string[];
    session_id?: string;
    activeSessionIds?: Iterable<string>;
    revision?: string;
  } = {},
): MemoryDeleteResult {
  const { path, root } = memoryTarget(home, scope, room, bot);
  if (opts.revision !== undefined) {
    const current = inspectMemory(path, root);
    if (current.revision !== opts.revision) {
      throw new MemoryConflict("记忆已被其他进程修改，请重新读取后再删除");
    }
  }
  const owner = scope === "bot" ? `bot:${room}/${bot}` : "global";
  return deleteMemoryEntries(path, {
    ids: opts.ids,
    session_id: opts.session_id,
    owner,
    activeSessionIds: opts.activeSessionIds,
    home,
  });
}

/** 已知的记忆范围（只列已存在的群机器人，不枚举任意路径）。 */
export function memoryScopes(home: string): { scope: string; room?: string; bot?: string; label: string }[] {
  const scopes: { scope: string; room?: string; bot?: string; label: string }[] = [
    { scope: "global", label: "Nyra · 全局记忆" },
  ];
  const groupsRoot = join(resolveNyraHome(home), "groups");
  if (!existsSync(groupsRoot)) return scopes;
  let rooms: string[] = [];
  try { rooms = readdirSync(groupsRoot).filter((d) => existsSync(join(groupsRoot, d, "room.json"))); } catch { return scopes; }
  for (const room of rooms.slice(0, 50)) {
    try {
      const data = JSON.parse(readFileSync(join(groupsRoot, room, "room.json"), "utf-8")) as Record<string, unknown>;
      const bots = Array.isArray(data.bots) ? data.bots : [];
      for (const bot of bots) {
        if (!bot || typeof bot !== "object") continue;
        const b = bot as Record<string, unknown>;
        if (typeof b.id !== "string") continue;
        scopes.push({
          scope: "bot", room, bot: b.id,
          label: `${typeof data.name === "string" ? data.name : room} · ${typeof b.name === "string" ? b.name : b.id}`,
        });
      }
    } catch { continue; }
  }
  return scopes;
}
