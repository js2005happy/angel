// src/beads.ts — 缺口 12：Beads 式可寻址工作账本（最小落地）。
//
// 报告里要的 Beads 是“任务、决策、依赖、进度以 git backed 的原子单元记下来，
// agent 崩了也能原地续上”。本批只落地其中与跨实例交接直接相关的一小块：
// 每次互问 / 交接在账本里留一条可寻址记录（谁交的、交了什么、对方接没接），
// 与证据链（runs/ 的 peer_asked / peer_handoff 事件）互相印证。
// 完整的 Beads（任务拆解、依赖图、git backed 同步）是后续批次的事，见
// docs/peer.md 的“已知局限”。
//
// 账本是追加写 JSONL：~/.nyra/peer-handoffs.jsonl（0600，原子追加 + fsync，
// 与 runs.ts 的 appendEvent 同款写法）。只记元数据：对端名、运行 id、问题
// 指纹、结论；绝不记问题原文、答复原文、令牌与绝对路径。
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { resolveNyraHome } from "./memory.ts";

export const PEER_HANDOFFS_FILE = "peer-handoffs.jsonl";

/** 账本条目状态：sent = 已发给对端（等对方处理）；accepted = 对端接了
* （dispatch_task 回了 run_id）；rejected = 对端明确拒了（审查拦截或
* 入队失败）；failed = 没发出去（网络/协议失败）；answered = 互问拿到答复。 */
export type BeadStatus = "sent" | "accepted" | "rejected" | "failed" | "answered";

export interface BeadEntry {
  id: string;
  at: string;
  kind: "ask" | "handoff";
  /** 交出方：本机固定记 "local"，不记主机名与用户名。 */
  from: string;
  /** 对端名（config peers.list 里的名字），不是地址。 */
  to: string;
  /** 交接的源运行 id（互问没有源运行，记 null）。 */
  run_id: string | null;
  /** 对端接下后回的运行 id（没接上记 null）。 */
  peer_run_id: string | null;
  /** 问题摘要的 SHA-256 前 12 位（互问才有；交接记交接包的指纹）。 */
  content_hash: string;
  status: BeadStatus;
  /** 失败/拒绝的原因（一句话，不含对方原文）。 */
  error?: string;
}

/** 内容指纹：SHA-256 前 12 位（与 connector 的 token 指纹同款截断，
* 免得被 appendEvent 的 redact 当长词串掩掉）。 */
export function beadHash(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
}

export function newBeadId(): string {
  return `bead-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function beadsPath(home: string): string {
  const dir = resolveNyraHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, PEER_HANDOFFS_FILE);
}

/** 追加一条账本记录（0600 追加写 + fsync；写失败直接抛，不静默丢审计）。 */
export function appendBead(home: string, entry: Omit<BeadEntry, "id" | "at" | "from"> & { id?: string; at?: string }): BeadEntry {
  const full: BeadEntry = {
    id: entry.id ?? newBeadId(),
    at: entry.at ?? new Date().toISOString(),
    from: "local",
    ...entry,
  };
  const path = beadsPath(home);
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, JSON.stringify(full) + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return full;
}

/** 按 id 查一条（找不到返回 null；损坏行跳过，不破坏整本账）。 */
export function getBead(home: string, id: string): BeadEntry | null {
  for (const e of listBeads(home)) {
    if (e.id === id) return e;
  }
  return null;
}

/** 读整本账（损坏行跳过；文件不存在返回空列表）。 */
export function listBeads(home: string): BeadEntry[] {
  const path = beadsPath(home);
  if (!existsSync(path)) return [];
  const out: BeadEntry[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as BeadEntry;
      if (e && typeof e === "object" && typeof e.id === "string" && typeof e.to === "string") out.push(e);
    } catch { /* 损坏行跳过 */ }
  }
  return out;
}
