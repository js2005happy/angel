// src/memory.ts — 长期记忆与会话历史，与 Python 版 nyra/memory.py 同语义。
// 会话文件原子写（tmp + replace，0600）；spec 07 第 1 条原子迁移与第 7 条权限
// （~/.nyra 0700、会话/日志 0600）在此落地。
import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeSync, appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { pythonJsonDump } from "./pyjson.ts";

export function resolveNyraHome(homeOverride?: string): string {
  if (homeOverride) return homeOverride;
  return process.env.NYRA_HOME ?? process.env.ANGEL_HOME ?? join(process.env.HOME ?? "", ".nyra");
}

export function loadMemorySummary(maxLines = 40, path?: string, home?: string): string {
  const target = path ?? join(resolveNyraHome(home), "MEMORY.md");
  if (!existsSync(target) || maxLines <= 0) return "";
  const raw = readFileSync(target, "utf-8").split("\n");
  // 与 Python str.splitlines() 同语义：末尾换行不产生空行。
  if (raw.length && raw[raw.length - 1] === "") raw.pop();
  const lines = raw.slice(-maxLines);
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

export function appendMemory(text: string, path?: string, home?: string, now?: Date): void {
  const single = text.split("\n").join(" ").trim();
  if (!single) return;
  const target = path ?? join(resolveNyraHome(home), "MEMORY.md");
  mkdirSync(join(target, ".."), { recursive: true });
  const d = now ?? new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  appendFileSync(target, `- [${stamp}] ${single}\n`, "utf-8");
}

export function loadAgentsMd(workdir: string, home?: string): string {
  const globalPath = join(resolveNyraHome(home), "AGENTS.md");
  const sections: string[] = [];
  const sources: [string, string][] = [
    [join(workdir, "AGENTS.md"), "# 项目说明（AGENTS.md）\n"],
    [globalPath, "# 全局说明（~/.nyra/AGENTS.md）\n"],
  ];
  for (const [path, heading] of sources) {
    if (existsSync(path)) sections.push(heading + readFileSync(path, "utf-8"));
  }
  return sections.join("\n\n");
}

export function newSessionId(now?: Date): string {
  const d = now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${randomBytes(2).toString("hex")}`;
}

export function sessionPath(sessionId: string, home?: string): string {
  if (
    !sessionId || typeof sessionId !== "string" || sessionId.includes("..") ||
    [...sessionId].some((c) => "/\\:\x00".includes(c))
  ) {
    throw new Error("会话 ID 无效");
  }
  return join(resolveNyraHome(home), "sessions", `${sessionId}.jsonl`);
}

export function sessionsDir(home?: string): string {
  return join(resolveNyraHome(home), "sessions");
}

/** 原子写会话：同目录 tmp（0600）+ fsync + replace；失败不损坏旧会话。 */
export function saveSession(sessionId: string, messages: Record<string, unknown>[], home?: string): string {
  const path = sessionPath(sessionId, home);
  const dir = sessionsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
  }
  const tmp = join(dir, `.nyra-session-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      const data = messages.map((m) => pythonJsonDump(m)).join("\n") + (messages.length ? "\n" : "");
      writeSync(fd, data, null, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (process.platform !== "win32") {
      try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
    }
    renameSync(tmp, path);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  return path;
}

export function loadSession(sessionId: string, home?: string): Record<string, unknown>[] | null {
  let path: string;
  try {
    path = sessionPath(sessionId, home);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  const messages: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as unknown;
      if (msg && typeof msg === "object") messages.push(msg as Record<string, unknown>);
    } catch { /* 跳过损坏行 */ }
  }
  return messages;
}

export interface SessionMeta {
  id: string;
  preview: string;
  count: number;
  mtime: string;
}

export function listSessions(home?: string): SessionMeta[] {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return [];
  const out: { mtimeMs: number; meta: SessionMeta }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const path = join(dir, file);
    try {
      const mtimeMs = statSync(path).mtimeMs;
      const lines = readFileSync(path, "utf-8").split("\n");
      let count = 0;
      let preview = "";
      let foundUser = false;
      for (const line of lines) {
        if (!line.trim()) continue;
        count += 1;
        if (foundUser) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg && typeof msg === "object" && msg.role === "user") {
            preview = typeof msg.content === "string" ? msg.content.slice(0, 60) : "";
            foundUser = true;
          }
        } catch { /* ignore */ }
      }
      out.push({
        mtimeMs,
        meta: {
          id: file.replace(/\.jsonl$/, ""),
          preview,
          count,
          mtime: new Date(mtimeMs).toISOString().slice(0, 19),
        },
      });
    } catch { /* ignore */ }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.map((e) => e.meta);
}
