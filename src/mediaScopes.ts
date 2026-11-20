// src/mediaScopes.ts — 候选提案 4：媒体抓取的范围卡账本（学 src/bughunt.ts 的做法）。
//
// 只做确定性校验（不调模型、不联网、不真的去下载）：范围卡校验、白名单 host
// 匹配、过期即越界。五条红线缺一不可——红线是写进校验层的，不只写在文档里。
//
// 与 bughunt 的区别：
//   - 这里不要求“先建卡才能用”：账本里没有 default 卡时，用内置默认卡
//     （YouTube/Bilibili/TikTok 三家 + 报告里的默认上限）；用户用
//     `nyra media scope add` 建一张同名 default 卡就能收紧它。
//   - cookies 一律禁用：allow_cookies 写 true 的卡直接判无效（父任务定死，
//     用户显式给也不接受）；工具层永远不传任何 cookies 参数。
//   - 链接里带账号信息（user:pass@host）直接拒绝——那是凭据，不是公开链接。
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync, writeSync, fsyncSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { hostMatches, parseTargetEntry } from "./bughunt.ts";

export class MediaScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaScopeError";
  }
}

/** 五条红线：范围卡的 forbidden 必须一字不差全包含，少一条卡就无效。 */
export const REQUIRED_FORBIDDEN_MEDIA: readonly string[] = [
  "DRM/付费墙后的内容（会员专享、付费课程、加密流）",
  "批量搬运 / 整频道镜像（无明确上限的列表下载）",
  "绕过地区限制（--geo-bypass 类手段）",
  "盗用他人 cookies / 账号（非本人登录态）",
  "再分发 / 商用他人版权内容（下载只为自己看/学习，不转售、不公开再发）",
];

/** 内置默认白名单（评估报告 §6.1 的举例 + www 变体；用户可建 default 卡收紧）。 */
export const DEFAULT_MEDIA_HOSTS: readonly string[] = [
  "youtube.com", "www.youtube.com", "youtu.be",
  "bilibili.com", "www.bilibili.com",
  "tiktok.com", "www.tiktok.com",
];

/** 媒体范围卡：一个名字 + 白名单 host + 四顶上限 + 五条红线。 */
export interface MediaScopeCard {
  name: string;
  allowed_hosts: string[];
  max_videos_per_run: number;
  max_duration_seconds: number;
  max_bytes: number;
  rate_limit: string;
  /** 必须 false：cookies 一律禁用，写 true 的卡直接判无效。 */
  allow_cookies: boolean;
  forbidden: string[];
  expires_at?: string;
  notes?: string;
}

export interface MediaScopeStore {
  version: 1;
  scopes: MediaScopeCard[];
}

export function mediaScopeStorePath(home: string): string {
  return join(home, "media-scopes.json");
}

/** 内置默认卡：账本里没有 default 卡时用它（上限与评估报告 §6.1 一致）。 */
export function defaultMediaScope(): MediaScopeCard {
  return {
    name: "default",
    allowed_hosts: [...DEFAULT_MEDIA_HOSTS],
    max_videos_per_run: 1,
    max_duration_seconds: 3600,
    max_bytes: 2 * 1024 * 1024 * 1024,
    rate_limit: "1M",
    allow_cookies: false,
    forbidden: [...REQUIRED_FORBIDDEN_MEDIA],
  };
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
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

/** 读范围卡账本；不存在返回空账本；损坏先备份再抛错（不静默重建）。 */
export function loadMediaScopeStore(home: string): MediaScopeStore {
  const path = mediaScopeStorePath(home);
  if (!existsSync(path)) return { version: 1, scopes: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new MediaScopeError(`媒体范围卡账本损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as MediaScopeStore).scopes)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new MediaScopeError(`媒体范围卡账本格式无效，已备份到 ${backup}`);
  }
  return raw as MediaScopeStore;
}

export function saveMediaScopeStore(home: string, store: MediaScopeStore): void {
  atomicWriteJson(mediaScopeStorePath(home), store);
}

export function listMediaScopes(home: string): MediaScopeCard[] {
  return loadMediaScopeStore(home).scopes;
}

export function findMediaScope(home: string, name: string): MediaScopeCard | null {
  return listMediaScopes(home).find((s) => s.name === name) ?? null;
}

/**
 * 解析本次用的范围卡：指名就用指名的（没有直接抛错，不静默回退）；
 * 不指名时账本里的 default 卡优先，没有 default 卡用内置默认卡。
 */
export function resolveMediaScope(home: string, name?: string): MediaScopeCard {
  if (name) {
    const card = findMediaScope(home, name);
    if (!card) throw new MediaScopeError(`没有叫 ${name} 的媒体范围卡（nyra media scope list 查看）`);
    return card;
  }
  return findMediaScope(home, "default") ?? defaultMediaScope();
}

// ---- 范围卡校验 ----

function isValidRateLimit(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const m = /^(\d+(?:\.\d+)?)([KM]?)$/.exec(value.trim());
  if (!m) return false;
  return Number(m[1]) > 0;
}

/** 校验范围卡：返回错误清单（空 = 有效）。红线缺失、cookies 开、白名单为空都是否决项。 */
export function validateMediaScopeCard(card: unknown): string[] {
  const errors: string[] = [];
  if (!card || typeof card !== "object" || Array.isArray(card)) return ["范围卡必须是 JSON 对象"];
  const c = card as Record<string, unknown>;
  if (typeof c.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(c.name)) {
    errors.push("name 缺失或格式不对（只允许字母、数字、- 和 _，字母或数字开头）");
  }
  if (!Array.isArray(c.allowed_hosts) || c.allowed_hosts.length === 0) {
    errors.push("allowed_hosts 为空（至少写一个允许抓的 host，如 youtube.com）");
  } else {
    for (const h of c.allowed_hosts) {
      if (typeof h !== "string" || !h.trim()) { errors.push(`allowed_hosts 里有空条目`); continue; }
      const parsed = parseTargetEntry(h.trim());
      if (!parsed || parsed.kind !== "host") errors.push(`allowed_hosts 里有无效条目：${h}（只接受主机名，可带 *. 前缀）`);
    }
  }
  const intIn = (key: string, min: number, max: number): void => {
    const v = c[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      errors.push(`${key} 必须是 ${min} 到 ${max} 之间的整数`);
    }
  };
  intIn("max_videos_per_run", 1, 10);
  intIn("max_duration_seconds", 1, 86400);
  intIn("max_bytes", 1024 * 1024, 10 * 1024 * 1024 * 1024);
  if (!isValidRateLimit(c.rate_limit)) {
    errors.push("rate_limit 格式不对（如 1M、500K，不带单位就是字节/秒）");
  }
  if (c.allow_cookies !== false) {
    errors.push("allow_cookies 必须是 false（cookies 一律禁用，用户显式给也不接受）");
  }
  if (!Array.isArray(c.forbidden)) {
    errors.push("forbidden 必须是数组");
  } else {
    const missing = REQUIRED_FORBIDDEN_MEDIA.filter(
      (r) => !(c.forbidden as unknown[]).includes(r),
    );
    if (missing.length) errors.push(`forbidden 缺少红线：${missing.join("、")}（少一条范围卡就无效）`);
  }
  if (c.expires_at !== undefined && (typeof c.expires_at !== "string" || Number.isNaN(Date.parse(c.expires_at)))) {
    errors.push("expires_at 不是合法日期");
  }
  return errors;
}

export function parseMediaScopeCard(text: string): MediaScopeCard {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: unknown) {
    throw new MediaScopeError(`范围卡不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const errors = validateMediaScopeCard(raw);
  if (errors.length) throw new MediaScopeError(`范围卡无效：${errors.join("；")}`);
  return raw as MediaScopeCard;
}

/** 建范围卡：校验 + 名唯一（重名拒绝，先删旧卡或改名）。 */
export function addMediaScope(home: string, card: MediaScopeCard): MediaScopeCard {
  const errors = validateMediaScopeCard(card);
  if (errors.length) throw new MediaScopeError(`范围卡无效：${errors.join("；")}`);
  const store = loadMediaScopeStore(home);
  if (store.scopes.some((s) => s.name === card.name)) {
    throw new MediaScopeError(`范围卡 ${card.name} 已存在（先删掉旧卡，或改名）`);
  }
  store.scopes.push(card);
  saveMediaScopeStore(home, store);
  return card;
}

export function removeMediaScope(home: string, name: string): boolean {
  const store = loadMediaScopeStore(home);
  const next = store.scopes.filter((s) => s.name !== name);
  if (next.length === store.scopes.length) return false;
  saveMediaScopeStore(home, { version: 1, scopes: next });
  return true;
}

// ---- 链接在不在范围内（禁区优先，过期即越界）----

export interface MediaUrlCheck {
  inScope: boolean;
  reason: string;
}

export function checkMediaUrl(card: MediaScopeCard, url: string): MediaUrlCheck {
  if (card.expires_at && Date.parse(card.expires_at) < Date.now()) {
    return { inScope: false, reason: `范围卡 ${card.name} 已过期（expires_at ${card.expires_at}），停手` };
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { inScope: false, reason: "目标不是合法 URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { inScope: false, reason: "目标不是 http(s) URL，不在范围内" };
  }
  if (u.username || u.password) {
    return { inScope: false, reason: "链接里带账号信息（user:pass@host），不处理带凭据的链接" };
  }
  const host = u.hostname.toLowerCase();
  if (!card.allowed_hosts.some((p) => hostMatches(host, p))) {
    return { inScope: false, reason: `host ${host} 不在范围卡 ${card.name} 的白名单里（允许：${card.allowed_hosts.join("、")}）` };
  }
  return { inScope: true, reason: `host ${host} 在范围卡 ${card.name} 的白名单里` };
}

/** `nyra media scope template` 打印的模板卡（照着改：五条红线一个字都不能少）。 */
export function mediaScopeCardTemplate(): string {
  return JSON.stringify(defaultMediaScope(), null, 2) + "\n";
}

/** 审计只记范围卡名与 host，不记完整 URL（查询串里可能带 token）。 */
export function appendMediaScopeAudit(home: string, line: string): void {
  try {
    appendFileSync(join(home, "media-audit.jsonl"), line + "\n", { mode: 0o600 });
  } catch { /* 审计落盘失败不破坏抓取结果 */ }
}
