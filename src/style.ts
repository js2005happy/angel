// src/style.ts — 分应用文风学习（缺口 4，2026-11-20）。
//
// 只学能力、不抄实现：接口语义学 Turnstone 的 “How you write”（每个渠道
// 各存一套用户文风画像，代笔时按画像写）与 ChatGPT Work（接 Gmail/Slack/
// Drive 学用户怎么写），实现是 Nyra 自己的确定性启发式提炼 + 本地 JSON 存
// 储，不抄别家的代码、界面文案与视觉，不调模型、不联网。
//
// 红线（比别家更严）：
// - 只学用户自己已发送的消息：样本由用户主动提供（文件或 stdin），
//   Nyra 不读他人发来的消息学文风，不碰 OAuth 拉取历史（那是缺口 6 的事）。
// - 显式 opt-in：`nyra style learn` 先展示提炼出的画像，用户确认后才保存
//   （--yes 跳过确认只用于脚本，仍是用户显式调用）。
// - 本地存储、可查看可删除：画像存在 `~/.nyra/styles/<渠道>.json`，
//   `nyra style show/delete` 查看/删除；样本原文绝不保存，只存提炼出的画像。
// - 画像只影响措辞风格，不影响事实与审批规则；保存与删除进证据链
//   （见 cli.ts 的 handleStyle，EvidenceStore `style_learn` / `style_delete`）。
// - 提炼是确定性启发式（问候/落款/语气/长度/标点/缩写），不是模型判断；
//   启发式会错，保存前用户看一眼、存后可直接改 JSON，这是设计不是缺陷。

import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { atomicTmpPath, resolveNyraHome } from "./memory.ts";

export class StyleError extends Error {
  constructor(message: string) { super(message); this.name = "StyleError"; }
}

/** 渠道名：小写字母开头，只含小写字母/数字/_/-，最长 32 字符（与群组名同形）。 */
export const CHANNEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 报告里点名的渠道；不在表里的渠道名只要合规也能用（以后加 Telegram 等不用改代码）。 */
export const KNOWN_CHANNELS = ["gmail", "outlook", "slack", "imessage", "whatsapp"] as const;

export function validateChannel(channel: string): string {
  const c = (channel ?? "").trim().toLowerCase();
  if (!CHANNEL_RE.test(c)) {
    throw new StyleError(
      `渠道名无效：${JSON.stringify(channel)}（须为小写字母开头、只含小写字母/数字/_/-、最长 32 字符，如 gmail、outlook、slack、imessage、whatsapp）`,
    );
  }
  return c;
}

export function stylesDir(home?: string): string {
  return join(resolveNyraHome(home), "styles");
}

export function stylePath(home: string | undefined, channel: string): string {
  return join(stylesDir(home), `${validateChannel(channel)}.json`);
}

export interface StyleProfile {
  version: 1;
  channel: string;
  /** 语气：正式 / 随意 / 中性（启发式判定，见 learnStyleProfile）。 */
  tone: "正式" | "随意" | "中性";
  /** 长度档：短（中位 < 40 字）/ 中（40–200 字）/ 长（> 200 字）。 */
  length: "短" | "中" | "长";
  /** 样本中位长度（字数，含标点）。 */
  typical_chars: number;
  /** 问候习惯，如“你好，”或“无固定问候，直接说事”。 */
  greeting: string;
  /** 落款习惯，如“谢谢”或“无固定落款”。 */
  signoff: string;
  /** 标点习惯摘要，如“感叹号多，很少用表情符号”。 */
  punctuation: string;
  /** 缩写习惯摘要，如“常用 pls、btw 等英文缩写”或“无明显缩写习惯”。 */
  abbreviations: string;
  /** 自由备注：提炼时为空，用户可直接改 JSON 补充。 */
  notes: string;
  /** 提炼用的样本条数（样本原文不保存）。 */
  sample_count: number;
  /** 提炼时间（ISO 8601）。 */
  learned_at: string;
  /** 来源说明：固定为用户提供的已发送消息样本，本地提炼、未上传。 */
  source: string;
}

export const STYLE_SOURCE = "用户提供的已发送消息样本（本地提炼，未上传）";

/** 解析样本文件：空行分隔多条消息；没有空行时每行一条。返回去空白后的样本（每条至多 2000 字）。 */
export function parseSamples(text: string): string[] {
  const blocks = text.split(/\r?\n\s*\r?\n/).map((b) => b.trim()).filter(Boolean);
  const raw = blocks.length > 1 ? blocks : text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return raw.map((s) => (s.length > 2000 ? s.slice(0, 2000) : s));
}

const GREETINGS = ["您好", "你好", "早上好", "下午好", "晚上好", "在吗", "哈喽", "嗨", "Hi", "Hello", "Hey"];
const SIGNOFFS = ["谢谢", "感谢", "多谢", "祝好", "此致", "敬礼", "顺祝商祺", "Best", "Thanks", "Thank you", "Regards", "Cheers"];
const FORMAL_MARKERS = ["您", "请", "感谢", "麻烦", "此致", "敬上", "顺祝", "您好"];
const CASUAL_MARKERS = ["哈哈", "嘿嘿", "嗯嗯", "哦", "啦", "～", "哈", "嘻嘻"];
const ABBREVIATIONS = ["pls", "plz", "thx", "btw", "asap", "fyi", "omg", "lol", "brb", "np", "tbd", "eta"];
const PARTICLES = ["嗯", "哦", "哈", "啦", "呢", "呀"];
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

function mostCommon(counts: Map<string, number>, minShare: number, total: number): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [k, v] of counts) {
    if (v > bestCount) { best = k; bestCount = v; }
  }
  return best !== null && bestCount / total >= minShare ? best : null;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * 从用户已发送消息样本提炼文风画像（确定性启发式，不调模型）。
 * 至少 3 条样本才提炼（太少看不出习惯）；多于 50 条只用前 50 条。
 * 样本原文只用于本次提炼，调用方不得保存；返回的画像里不含任何样本原文。
 */
export function learnStyleProfile(channel: string, samples: readonly string[], now?: Date): StyleProfile {
  const c = validateChannel(channel);
  const usable = samples.map((s) => (s ?? "").trim()).filter(Boolean);
  if (usable.length < 3) {
    throw new StyleError(`样本太少：至少 3 条已发送消息才能提炼文风（给了 ${usable.length} 条）`);
  }
  const used = usable.slice(0, 50);
  const total = used.length;
  const lengths = used.map((s) => [...s].length);
  const typical = median(lengths);
  const length: StyleProfile["length"] = typical < 40 ? "短" : typical <= 200 ? "中" : "长";

  // 问候：样本开头（前 10 字）命中问候词的占比 ≥ 50% 才算习惯。
  const greetCounts = new Map<string, number>();
  for (const s of used) {
    const head = s.slice(0, 10);
    for (const g of GREETINGS) {
      if (head.startsWith(g)) { greetCounts.set(g, (greetCounts.get(g) ?? 0) + 1); break; }
    }
  }
  const greet = mostCommon(greetCounts, 0.5, total);
  const greeting = greet ? `${greet}，` : "无固定问候，直接说事";

  // 落款：样本末行命中落款词的占比 ≥ 30% 才算习惯。
  const signCounts = new Map<string, number>();
  for (const s of used) {
    const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const tail = lines.length ? lines[lines.length - 1] : "";
    for (const sign of SIGNOFFS) {
      if (tail.startsWith(sign)) { signCounts.set(sign, (signCounts.get(sign) ?? 0) + 1); break; }
    }
  }
  const sign = mostCommon(signCounts, 0.3, total);
  const signoff = sign ?? "无固定落款";

  // 语气：正式标记与随意标记的出现次数相减；表情符号多也算随意。
  let formal = 0;
  let casual = 0;
  let emojiSamples = 0;
  let exclaimSamples = 0;
  let ellipsisSamples = 0;
  for (const s of used) {
    for (const m of FORMAL_MARKERS) if (s.includes(m)) formal += 1;
    for (const m of CASUAL_MARKERS) if (s.includes(m)) casual += 1;
    if (EMOJI_RE.test(s)) { emojiSamples += 1; casual += 1; }
    if (s.includes("！")) exclaimSamples += 1;
    if (s.includes("…")) ellipsisSamples += 1;
  }
  const tone: StyleProfile["tone"] = formal > casual ? "正式" : casual > formal ? "随意" : "中性";
  const punctuationParts: string[] = [];
  punctuationParts.push(exclaimSamples / total >= 0.5 ? "感叹号多" : exclaimSamples > 0 ? "偶尔用感叹号" : "很少用感叹号");
  punctuationParts.push(
    emojiSamples / total >= 0.3 ? "常用表情符号" : emojiSamples > 0 ? "偶尔用表情符号" : "很少用表情符号",
  );
  if (ellipsisSamples > 0) punctuationParts.push("用省略号");
  const punctuation = punctuationParts.join("，");

  // 缩写：英文缩写命中 + 中文语气词高频，两边都没有就是无明显习惯。
  const foundAbbr: string[] = [];
  const joined = used.join("\n").toLowerCase();
  for (const abbr of ABBREVIATIONS) {
    if (new RegExp(`\\b${abbr}\\b`).test(joined)) foundAbbr.push(abbr);
  }
  let particleCount = 0;
  for (const s of used) for (const p of PARTICLES) if (s.includes(p)) particleCount += 1;
  const abbrParts: string[] = [];
  if (foundAbbr.length) abbrParts.push(`常用 ${foundAbbr.join("、")} 等英文缩写`);
  if (particleCount / total >= 0.5) abbrParts.push("常用语气词（嗯、哦、哈等）");
  const abbreviations = abbrParts.length ? abbrParts.join("；") : "无明显缩写习惯";

  return {
    version: 1,
    channel: c,
    tone,
    length,
    typical_chars: typical,
    greeting,
    signoff,
    punctuation,
    abbreviations,
    notes: "",
    sample_count: total,
    learned_at: (now ?? new Date()).toISOString(),
    source: STYLE_SOURCE,
  };
}

/** 原子写画像：同目录 tmp（0600）+ fsync + rename；失败不损坏旧画像。 */
export function saveStyleProfile(home: string | undefined, profile: StyleProfile): string {
  const channel = validateChannel(profile.channel);
  if (profile.version !== 1) throw new StyleError("文风画像 version 须为 1");
  for (const field of ["tone", "length", "greeting", "signoff", "punctuation", "abbreviations"] as const) {
    if (typeof profile[field] !== "string" || !profile[field]) {
      throw new StyleError(`文风画像缺字段：${field}`);
    }
  }
  const dir = stylesDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
  }
  const target = stylePath(home, channel);
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const data = JSON.stringify(profile, null, 2) + "\n";
  const tmp = atomicTmpPath(target);
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  return target;
}

/** 读画像：不存在返回 null；文件损坏或字段不全抛 StyleError（不静默吞掉）。 */
export function loadStyleProfile(home: string | undefined, channel: string): StyleProfile | null {
  const target = stylePath(home, validateChannel(channel));
  if (!existsSync(target)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(target, "utf-8"));
  } catch {
    throw new StyleError(`文风画像损坏：${target} 不是有效 JSON，请删掉重学（nyra style delete ${channel}）`);
  }
  if (!data || typeof data !== "object") throw new StyleError(`文风画像损坏：${target} 内容不是对象`);
  const p = data as Record<string, unknown>;
  if (p.version !== 1 || p.channel !== validateChannel(channel)) {
    throw new StyleError(`文风画像损坏：${target} 的 version/channel 与文件名不符`);
  }
  for (const field of ["tone", "length", "greeting", "signoff", "punctuation", "abbreviations", "source"] as const) {
    if (typeof p[field] !== "string" || !(p[field] as string)) {
      throw new StyleError(`文风画像损坏：${target} 缺字段 ${field}`);
    }
  }
  if (!["正式", "随意", "中性"].includes(p.tone as string) || !["短", "中", "长"].includes(p.length as string)) {
    throw new StyleError(`文风画像损坏：${target} 的 tone/length 取值不在允许范围`);
  }
  return {
    version: 1,
    channel: p.channel as string,
    tone: p.tone as StyleProfile["tone"],
    length: p.length as StyleProfile["length"],
    typical_chars: typeof p.typical_chars === "number" ? p.typical_chars : 0,
    greeting: p.greeting as string,
    signoff: p.signoff as string,
    punctuation: p.punctuation as string,
    abbreviations: p.abbreviations as string,
    notes: typeof p.notes === "string" ? p.notes : "",
    sample_count: typeof p.sample_count === "number" ? p.sample_count : 0,
    learned_at: typeof p.learned_at === "string" ? p.learned_at : "",
    source: p.source as string,
  };
}

/** 列出已存画像的渠道（按渠道名字母序）。 */
export function listStyleProfiles(home?: string): string[] {
  const dir = stylesDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((c) => CHANNEL_RE.test(c))
    .sort();
}

/** 删除画像：存在返回 true，不存在返回 false。 */
export function deleteStyleProfile(home: string | undefined, channel: string): boolean {
  const target = stylePath(home, validateChannel(channel));
  if (!existsSync(target)) return false;
  rmSync(target, { force: true });
  return true;
}

/** 人看的画像文本（`nyra style show` 用）。 */
export function formatStyleProfile(p: StyleProfile): string {
  return [
    `渠道：${p.channel}`,
    `语气：${p.tone}`,
    `长度：${p.length}（典型约 ${p.typical_chars} 字）`,
    `问候：${p.greeting}`,
    `落款：${p.signoff}`,
    `标点：${p.punctuation}`,
    `缩写：${p.abbreviations}`,
    ...(p.notes ? [`备注：${p.notes}`] : []),
    `样本：${p.sample_count} 条（原文未保存）`,
    ...(p.learned_at ? [`更新：${p.learned_at.slice(0, 19).replace("T", " ")}`] : []),
    `来源：${p.source}`,
  ].join("\n");
}

/**
 * 缺口 4：主循环提示词里的文风段——按当前渠道注入画像。
 * 段首注明来源渠道；段尾写清边界：只影响措辞风格，不影响事实与审批规则。
 */
export function buildStyleSection(profile: StyleProfile): string {
  const lines = [
    `## 你的文风（${profile.channel}）`,
    `以下文风画像来自用户本人在 ${profile.channel} 上已发送的消息样本（经用户确认后本地保存，未上传；样本原文没有保存，只存了提炼出的习惯）。`,
    `按这套文风代笔：语气${profile.tone}；长度${profile.length}（典型约 ${profile.typical_chars} 字）；问候习惯：${profile.greeting}；落款习惯：${profile.signoff}；标点习惯：${profile.punctuation}；缩写习惯：${profile.abbreviations}。`,
  ];
  if (profile.notes) lines.push(`补充说明：${profile.notes}`);
  lines.push("只影响措辞风格：不改变事实内容，不改变审批规则，不模仿样本里的具体措辞与个人信息。");
  return lines.join("\n");
}
