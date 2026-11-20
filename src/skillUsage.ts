// src/skillUsage.ts — 技能使用账本（缺口 11：技能自沉淀闭环）。
//
// 只记“哪个技能最近一次被注入提示词、累计几次”，供 `nyra skills sweep`
// 判断“多久没人用”。文件 `~/.nyra/skill-usage.json`（原子写 0600）。
// 损坏时丢弃重建——这只是用量统计，丢了不影响运行、不影响技能本身。
// 本模块只依赖 node，不 import 任何 src 模块，避免 agent.ts / runs.ts 的循环引用。
import { existsSync, mkdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface SkillUsageEntry {
  uses: number;
  last_used_at: string;
}

export type SkillUsage = Record<string, SkillUsageEntry>;

export function skillUsagePath(home: string): string {
  return join(home, "skill-usage.json");
}

/** 读用量账本；文件不存在返回空；损坏返回空（用量统计不值得 fail-closed）。 */
export function loadSkillUsage(home: string): SkillUsage {
  const path = skillUsagePath(home);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: SkillUsage = {};
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const uses = (entry as Record<string, unknown>).uses;
      const last = (entry as Record<string, unknown>).last_used_at;
      if (typeof uses !== "number" || typeof last !== "string") continue;
      out[name] = { uses, last_used_at: last };
    }
    return out;
  } catch {
    return {};
  }
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
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
* 记一次技能使用：累计次数 +1、最近使用时间刷新到现在。
* 账本写失败时抛错——调用方（agent.ts）负责吞掉，绝不因用量统计破坏运行。
*/
export function recordSkillUse(home: string, name: string, now = new Date()): SkillUsageEntry {
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("技能名不能为空");
  const usage = loadSkillUsage(home);
  const prev = usage[clean];
  const entry: SkillUsageEntry = {
    uses: (prev?.uses ?? 0) + 1,
    last_used_at: now.toISOString(),
  };
  usage[clean] = entry;
  atomicWriteJson(skillUsagePath(home), usage);
  return entry;
}
