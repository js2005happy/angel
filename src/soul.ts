// src/soul.ts — 缺口 28：Soul 身份层（每 agent 独立的 Soul 文件）。
//
// Hello Minds 的 Soul 是 Identity/DNA + Memory + State + Wallet，Tenets
// 分 Invariants（不变量 Guardrail）与 Priors（柔性偏好），Brain（模型路由
// 层）可换而身份、记忆、Tenets、历史全部保留——“换脑不换魂”。Nyra 的落地：
//
//   ~/.nyra/souls/<agent>.json —— Identity（名字、人格、目标）+ Tenets
//   列表（每条带 id、类型 invariant/prior、来源会话、时间戳）+ 记忆索引。
//   与 config.ts 的 provider/model 配置彻底分文件：换模型只改配置，
//   不动 Soul。
//
// 比对方硬一档：Hello Minds 的 Invariant 靠模型“认知失调后不遵守”（提示
// 词层自律，软约束）；Nyra 把 invariant 编译进权限规则层（deny > ask >
// allow，见 permissionRules.ts），违反时在工具调用前由代码拦截（tools.ts
// 的 checkApproval 与 reviewer.ts 的 reviewToolCall，在用户自定义规则之
// 前），并把拦截记进证据链（soul_invariant_blocked 事件 + soul-audit.jsonl）。
//
// 不学对方的反面：Hello Minds 的记忆“cannot be switched off”、彻底删除
// “cannot be guaranteed”、数据默认可用于训练；Nyra 的 Tenets 必须可关
// （每条可 enable/disable）、可删（nyra soul remove）、可导出（nyra soul
// export），默认不上传——Soul 文件只在用户本机。
//
// 存储口径（与本仓其他账本一致）：Soul 文件原子写（同目录 tmp 0600 +
// fsync + rename）、souls 目录 0700；文件损坏先备份再抛错，不静默重建
// （损坏的 Soul 里可能藏着一条 deny 规则，静默重建等于悄悄放行）。
// 事件里只记元数据（agent、tenet id、工具、规则原文），不记绝对路径，
// 不记 Tenet 以外的正文（Tenet 文本本身就是用户写的规则，show 命令可查）。
import {
  appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync, fsyncSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { compileDenyRules, evaluate, parseRule, type RuleSet } from "./permissionRules.ts";
import { askApproval } from "./approvalUi.ts";
import { EvidenceStore } from "./evidence.ts";
import type { ReviewVerdict } from "./reviewer.ts";

export class SoulError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoulError";
  }
}

/** Tenet 两种类型：invariant（不变量，编译进规则层、代码强制执行）与 prior（柔性偏好，只进提示词）。 */
export type TenetKind = "invariant" | "prior";

export interface SoulIdentity {
  /** agent 的名字（默认 "Nyra"）。 */
  name: string;
  /** 人格：一两句话，如“说话直接、有事说事”。 */
  persona: string;
  /** 目标：一两句话，如“帮机主把重复工作自动化”。 */
  goal: string;
}

export interface SoulTenet {
  /** 稳定 id：`ten_` + 12 位十六进制。 */
  id: string;
  kind: TenetKind;
  /** 人类可读的规则正文。 */
  text: string;
  /** invariant 的 deny 规则（permissionRules 语法，如 "shell(rm *)"）；prior 一律空数组。 */
  deny: string[];
  /** 写下这条 Tenet 的来源会话；手工写 / 未知为 null。 */
  source_session: string | null;
  /** 创建时间（ISO）。 */
  created_at: string;
  /** 关闭的 Tenet 不参与编译与提示词注入，但保留在文件里（可关、可再开）。 */
  enabled: boolean;
}

/** Soul 文件里的记忆索引：只记“哪个记忆文件、有几条、上次同步时间”，不复制记忆正文。 */
export interface SoulMemoryFile {
  /** 相对 home 的路径（如 "MEMORY.md"），绝不记绝对路径。 */
  path: string;
  entries: number;
  updated_at: string;
}

/**
 * GROK-2：Charter 角色契约（六行合同，进 Soul，与 Tenet 并列）。
 * 正文五项——负责什么（own）、信息来源（sources）、输出格式（output）、
 * 审批门（approval）、停下条件（stop），连同角色名一行共六行。只借机制，
 * 不搬任何 Grok Bot 模板文案与 charter 原文：字段名与写法是 Nyra 自己的。
 * 契约是“可检查的合同”：建 agent 接单须有完整 charter（team.ts 的
 * requireCharter），交付时配 verifier 抽查（team.ts 的
 * verifyCharterCompliance）；合同写得再好模型也可能不遵守，抽查与审计
 * 是第二道防线，不是摆设。
 */
export interface SoulCharter {
  /** 负责什么：一两句话，如“只负责查数，不写稿、不对外发”。 */
  own: string;
  /** 信息来源：从哪拿数/拿材料，如 ["Shopify 订单 API（只读）", "任务板"]。 */
  sources: string[];
  /** 输出格式：交付物长什么样，如“以 `## 结论` 开头，附证据链接”。 */
  output: string;
  /** 审批门：什么事须先批，如“对外发消息与花钱先过参谋长/人批”。 */
  approval: string;
  /** 停下条件：什么时候停下问人，如“数据对不上、权限不够就停下，不猜”。 */
  stop: string;
}

export interface SoulFile {
  version: 1;
  agent: string;
  identity: SoulIdentity;
  tenets: SoulTenet[];
  /** 角色契约（GROK-2）：没有 = null；有就必须是五项齐全的有效契约。 */
  charter?: SoulCharter | null;
  memory_index: { files: SoulMemoryFile[] };
}

export const SOULS_DIRNAME = "souls";
export const SOUL_AUDIT_FILE = "soul-audit.jsonl";

/** agent 名只认小写字母开头、字母数字/下划线/连字符（与 peers / bot room 同款口径）。 */
export const SOUL_AGENT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const TENET_ID_RE = /^ten_[0-9a-f]{12}$/;

/**
 * 当前 agent 用哪个 Soul：显式参数 > config.json 的 soul.agent >
 * 环境变量 NYRA_SOUL_AGENT > "default"。这里只有“指到哪个 Soul 文件”
 * 的指针，身份本身永远在 Soul 文件里，不在 config 里。
 */
export function resolveSoulAgentId(
  config?: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromConfig = (config as Record<string, unknown> | null)?.soul;
  if (fromConfig && typeof fromConfig === "object") {
    const agent = (fromConfig as Record<string, unknown>).agent;
    if (typeof agent === "string" && SOUL_AGENT_ID_RE.test(agent)) return agent;
  }
  const fromEnv = env.NYRA_SOUL_AGENT;
  if (typeof fromEnv === "string" && SOUL_AGENT_ID_RE.test(fromEnv)) return fromEnv;
  return "default";
}

export function validateSoulAgentId(agent: string): void {
  if (!SOUL_AGENT_ID_RE.test(agent)) {
    throw new SoulError(`Soul 的 agent 名只认小写字母开头、字母数字/下划线/连字符（最长 32 字），当前是 ${JSON.stringify(agent)}`);
  }
}

export function soulsDir(home: string): string {
  return join(home, SOULS_DIRNAME);
}

export function soulFilePath(home: string, agent: string): string {
  validateSoulAgentId(agent);
  return join(soulsDir(home), `${agent}.json`);
}

/** 空 Soul（文件不存在时返回这个，不落盘——没有 Soul 的用户零影响）。 */
export function defaultSoul(agent: string): SoulFile {
  return {
    version: 1,
    agent,
    identity: { name: agent === "default" ? "Nyra" : agent, persona: "", goal: "" },
    tenets: [],
    charter: null,
    memory_index: { files: [] },
  };
}

/** Charter 各字段上限：正文单项最长 1000 字，来源每条最长 200 字、最多 10 条。 */
export const CHARTER_FIELD_MAX = 1000;
export const CHARTER_SOURCES_MAX = 10;
export const CHARTER_SOURCE_MAX = 200;

/**
 * 校验一份 Charter：五项齐全、非空、在上限内才算有效；返回错误文案，
 * 有效返回 null。写坏了在 set 之前就拒绝，不落盘、不留半份契约。
 */
export function validateCharter(input: unknown): string | null {
  if (!isRecord(input)) return "Charter 不是一个对象（须有 own / sources / output / approval / stop 五项）";
  for (const field of ["own", "output", "approval", "stop"] as const) {
    const v = input[field];
    if (typeof v !== "string" || !v.trim()) return `Charter 的 ${field} 不能为空`;
    if (v.trim().length > CHARTER_FIELD_MAX) return `Charter 的 ${field} 超过 ${CHARTER_FIELD_MAX} 字`;
  }
  const sources = input.sources;
  if (!Array.isArray(sources) || sources.length === 0) return "Charter 的 sources 至少要有一条信息来源";
  if (sources.length > CHARTER_SOURCES_MAX) return `Charter 的 sources 最多 ${CHARTER_SOURCES_MAX} 条`;
  for (const s of sources) {
    if (typeof s !== "string" || !s.trim()) return "Charter 的 sources 里有空条目";
    if (s.trim().length > CHARTER_SOURCE_MAX) return `Charter 的 sources 单条超过 ${CHARTER_SOURCE_MAX} 字`;
  }
  return null;
}

/** 严格解析一份 Charter（parseSoulFile 用）：结构不对直接抛错。 */
export function parseCharter(raw: unknown): SoulCharter {
  const err = validateCharter(raw);
  if (err) throw new SoulError(`Charter 格式不对：${err}`);
  const rec = raw as Record<string, unknown>;
  return {
    own: (rec.own as string).trim(),
    sources: (rec.sources as string[]).map((s) => s.trim()),
    output: (rec.output as string).trim(),
    approval: (rec.approval as string).trim(),
    stop: (rec.stop as string).trim(),
  };
}

/** 一份 Soul 的 Charter 是否齐全有效（缺 = false；写坏了的 parse 时就抛了，到不了这里）。 */
export function charterComplete(soul: SoulFile): boolean {
  return soul.charter != null && validateCharter(soul.charter) === null;
}

/** 写一份 Charter（覆盖旧的；五项须齐全有效，写坏了拒绝落盘）。 */
export function setCharter(home: string, agent: string, input: unknown): SoulCharter {
  const charter = parseCharter(input);
  const soul = loadSoul(home, agent);
  soul.charter = charter;
  saveSoul(home, soul);
  return charter;
}

/** 清掉一份 Charter（删了就没契约：该 agent 不能再接团队单，直到重写一份）。 */
export function clearCharter(home: string, agent: string): boolean {
  const soul = loadSoul(home, agent);
  if (soul.charter == null) return false;
  soul.charter = null;
  saveSoul(home, soul);
  return true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseTenet(raw: unknown): SoulTenet {
  if (!isRecord(raw)) throw new SoulError("Tenet 不是对象");
  if (typeof raw.id !== "string" || !TENET_ID_RE.test(raw.id)) throw new SoulError("Tenet 的 id 格式不对（应为 ten_ + 12 位十六进制）");
  if (raw.kind !== "invariant" && raw.kind !== "prior") throw new SoulError(`Tenet ${raw.id} 的类型只认 invariant / prior，当前是 ${JSON.stringify(raw.kind)}`);
  if (typeof raw.text !== "string" || !raw.text.trim()) throw new SoulError(`Tenet ${raw.id} 的正文为空`);
  if (!Array.isArray(raw.deny) || raw.deny.some((d) => typeof d !== "string")) throw new SoulError(`Tenet ${raw.id} 的 deny 不是字符串数组`);
  if (raw.kind === "prior" && raw.deny.length > 0) throw new SoulError(`Tenet ${raw.id} 是 prior，不能带 deny 规则（prior 只进提示词，不进规则层）`);
  if (raw.kind === "invariant" && raw.deny.length === 0) throw new SoulError(`Tenet ${raw.id} 是 invariant，至少要有一条 deny 规则（没有规则就编译不出东西，改成 prior 或补规则）`);
  for (const rule of raw.deny) {
    if (!parseRule(rule)) throw new SoulError(`Tenet ${raw.id} 的 deny 规则无法解析：${JSON.stringify(rule)}`);
  }
  return {
    id: raw.id,
    kind: raw.kind,
    text: raw.text.trim(),
    deny: [...raw.deny],
    source_session: typeof raw.source_session === "string" ? raw.source_session : null,
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    enabled: raw.enabled !== false,
  };
}

/** 严格解析 Soul 文件内容：结构不对直接抛错（调用方先备份再抛，不静默重建）。 */
export function parseSoulFile(raw: unknown): SoulFile {
  if (!isRecord(raw)) throw new SoulError("Soul 文件不是一个 JSON 对象");
  if (raw.version !== 1) throw new SoulError(`Soul 文件版本只认 1，当前是 ${JSON.stringify(raw.version)}`);
  if (typeof raw.agent !== "string" || !SOUL_AGENT_ID_RE.test(raw.agent)) throw new SoulError("Soul 文件的 agent 名格式不对");
  if (!isRecord(raw.identity)) throw new SoulError("Soul 文件缺 identity");
  const name = raw.identity.name;
  const persona = raw.identity.persona;
  const goal = raw.identity.goal;
  if (typeof name !== "string" || typeof persona !== "string" || typeof goal !== "string") {
    throw new SoulError("Soul 文件的 identity.name / persona / goal 须为字符串");
  }
  if (!Array.isArray(raw.tenets)) throw new SoulError("Soul 文件的 tenets 不是数组");
  const tenets = raw.tenets.map(parseTenet);
  const ids = new Set<string>();
  for (const t of tenets) {
    if (ids.has(t.id)) throw new SoulError(`Soul 文件里 Tenet id 重复：${t.id}`);
    ids.add(t.id);
  }
  let memoryFiles: SoulMemoryFile[] = [];
  if (isRecord(raw.memory_index) && Array.isArray(raw.memory_index.files)) {
    memoryFiles = (raw.memory_index.files as unknown[]).filter(isRecord).map((f) => ({
      path: typeof f.path === "string" ? f.path : "",
      entries: typeof f.entries === "number" ? f.entries : 0,
      updated_at: typeof f.updated_at === "string" ? f.updated_at : "",
    })).filter((f) => f.path !== "");
  }
  // GROK-2：Charter 没有 = null（老文件没这字段照常读）；写了就必须五项齐全有效。
  const charter = raw.charter === undefined || raw.charter === null ? null : parseCharter(raw.charter);
  return {
    version: 1,
    agent: raw.agent,
    identity: { name, persona, goal },
    tenets,
    charter,
    memory_index: { files: memoryFiles },
  };
}

/**
 * 读 Soul 文件；不存在返回默认 Soul（不落盘）；损坏（JSON 解析失败或结构
 * 不对）先备份再抛错——损坏的 Soul 里可能藏着一条 deny 规则，静默重建
 * 等于悄悄放行，绝不能这么干。
 */
export function loadSoul(home: string, agent: string): SoulFile {
  const path = soulFilePath(home, agent);
  if (!existsSync(path)) return defaultSoul(agent);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new SoulError(`Soul 文件损坏，已备份到 ${basename(backup)}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const soul = parseSoulFile(parsed);
    if (soul.agent !== agent) throw new SoulError(`Soul 文件里的 agent（${soul.agent}）与文件名（${agent}）对不上`);
    return soul;
  } catch (err: unknown) {
    if (err instanceof SoulError) {
      const backup = `${path}.corrupt-${Date.now()}`;
      try { renameSync(path, backup); } catch { /* ignore */ }
    }
    throw err;
  }
}

/** 原子写 Soul 文件（同目录 tmp 0600 + fsync + rename；souls 目录 0700）。 */
export function saveSoul(home: string, soul: SoulFile): void {
  validateSoulAgentId(soul.agent);
  const dir = soulsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
  }
  const path = soulFilePath(home, soul.agent);
  const data = JSON.stringify(soul, null, 2) + "\n";
  const tmp = join(dir, `.${soul.agent}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data, null, "utf-8");
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

/** Soul 文件是否存在（与 loadSoul 的“不存在返回默认”区分：init 与 status 用）。 */
export function soulExists(home: string, agent: string): boolean {
  return existsSync(soulFilePath(home, agent));
}

/** 列出已有 Soul 的 agent 名（只认合法文件名，别的杂文件不算）。 */
export function listSoulAgents(home: string): string[] {
  const dir = soulsDir(home);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^([a-z][a-z0-9_-]{0,31})\.json$/.exec(f);
    if (m) out.push(m[1]);
  }
  return out.sort();
}

export function newTenetId(): string {
  return `ten_${randomBytes(6).toString("hex")}`;
}

export interface AddTenetInput {
  kind: TenetKind;
  text: string;
  deny?: string[];
  sourceSession?: string | null;
}

/** 新增一条 Tenet：invariant 必须带至少一条能解析的 deny 规则，prior 不能带 deny。 */
export function addTenet(home: string, agent: string, input: AddTenetInput): SoulTenet {
  if (input.kind !== "invariant" && input.kind !== "prior") {
    throw new SoulError(`Tenet 类型只认 invariant / prior，当前是 ${JSON.stringify(input.kind)}`);
  }
  const text = input.text.trim();
  if (!text) throw new SoulError("Tenet 正文不能为空");
  const deny = [...(input.deny ?? [])];
  if (input.kind === "invariant") {
    if (!deny.length) throw new SoulError("invariant 至少要有一条 deny 规则（没有规则就编译不出东西，改成 prior 或补规则）");
    for (const rule of deny) {
      if (!parseRule(rule)) throw new SoulError(`deny 规则无法解析：${JSON.stringify(rule)}（语法见 permissionRules.ts，如 "shell(rm *)"）`);
    }
  } else if (deny.length) {
    throw new SoulError("prior 不能带 deny 规则（prior 只进提示词，不进规则层）");
  }
  const soul = loadSoul(home, agent);
  const tenet: SoulTenet = {
    id: newTenetId(),
    kind: input.kind,
    text,
    deny,
    source_session: input.sourceSession ?? null,
    created_at: new Date().toISOString(),
    enabled: true,
  };
  soul.tenets.push(tenet);
  saveSoul(home, soul);
  return tenet;
}

/** 删除一条 Tenet：返回删掉的 Tenet 与删后剩余条数（审计要记“删了哪条、删后剩几条”）。 */
export function removeTenet(home: string, agent: string, id: string): { removed: SoulTenet; remaining: number } {
  const soul = loadSoul(home, agent);
  const idx = soul.tenets.findIndex((t) => t.id === id);
  if (idx < 0) throw new SoulError(`找不到 Tenet ${id}（先用 nyra soul show 看 id）`);
  const [removed] = soul.tenets.splice(idx, 1);
  saveSoul(home, soul);
  return { removed, remaining: soul.tenets.length };
}

/** 改一条 Tenet 的正文与 deny 规则（deny 只对 invariant 有效，改 prior 的 deny 直接拒绝）。 */
export function updateTenet(
  home: string,
  agent: string,
  id: string,
  patch: { text?: string; deny?: string[] },
): SoulTenet {
  const soul = loadSoul(home, agent);
  const tenet = soul.tenets.find((t) => t.id === id);
  if (!tenet) throw new SoulError(`找不到 Tenet ${id}（先用 nyra soul show 看 id）`);
  if (patch.text !== undefined) {
    const text = patch.text.trim();
    if (!text) throw new SoulError("Tenet 正文不能为空");
    tenet.text = text;
  }
  if (patch.deny !== undefined) {
    if (tenet.kind !== "invariant") throw new SoulError("prior 不能带 deny 规则（prior 只进提示词，不进规则层）");
    if (!patch.deny.length) throw new SoulError("invariant 至少要有一条 deny 规则（想去掉规则先改成 prior，或直接删掉这条）");
    for (const rule of patch.deny) {
      if (!parseRule(rule)) throw new SoulError(`deny 规则无法解析：${JSON.stringify(rule)}`);
    }
    tenet.deny = [...patch.deny];
  }
  saveSoul(home, soul);
  return tenet;
}

/** 开关一条 Tenet（关掉的不参与编译与提示词注入，文件里留着，可再开）。 */
export function setTenetEnabled(home: string, agent: string, id: string, enabled: boolean): SoulTenet {
  const soul = loadSoul(home, agent);
  const tenet = soul.tenets.find((t) => t.id === id);
  if (!tenet) throw new SoulError(`找不到 Tenet ${id}（先用 nyra soul show 看 id）`);
  tenet.enabled = enabled;
  saveSoul(home, soul);
  return tenet;
}

/** 改 Identity（名字/人格/目标，缺省的字段不动）。 */
export function updateSoulIdentity(home: string, agent: string, patch: Partial<SoulIdentity>): SoulFile {
  const soul = loadSoul(home, agent);
  soul.identity = { ...soul.identity, ...patch };
  saveSoul(home, soul);
  return soul;
}

// ---- invariant 编译进规则层 ----

/**
 * 把一个 Soul 里所有**启用中**的 invariant 的 deny 规则编译成规则集。
 * 规则文本在写入时已校验过，这里再遇到无法解析的（手改文件改坏了）就
 * 跳过并记一条 warning——调用方（soul show / soul status）会把 warning
 * 亮出来，不让人“写了规则以为挡住了、实际没生效”（本仓已踩过两次同类问题）。
 */
export function compileSoulDenyRules(soul: SoulFile): { rules: RuleSet; warnings: string[] } {
  const texts: string[] = [];
  const warnings: string[] = [];
  for (const tenet of soul.tenets) {
    if (!tenet.enabled || tenet.kind !== "invariant") continue;
    for (const rule of tenet.deny) {
      if (parseRule(rule)) texts.push(rule);
      else warnings.push(`Tenet ${tenet.id} 的 deny 规则无法解析，已跳过：${rule}`);
    }
  }
  const { rules } = compileDenyRules(texts);
  return { rules, warnings };
}

/**
 * Soul 层面的拦截判定（checkApproval 与 reviewToolCall 共用）：
 * 启用中的 invariant 的 deny 规则命中 → 返回命中的 Tenet 与规则；
 * 没命中、没有 Soul 文件、home 为 null → null（放行，零影响）。
 * Soul 文件损坏时 fail-closed：写操作全部拦截（损坏的 Soul 里可能藏着
 * 一条 deny 规则，读不到就当它还在），并把损坏原因写进 reason。
 */
export function soulInvariantBlock(
  home: string | null,
  agentId: string,
  tool: string,
  target?: string,
  workdir?: string,
): { tenetId: string; rule: string; reason: string } | null {
  if (home === null) return null;
  let soul: SoulFile;
  try {
    soul = loadSoul(home, agentId);
  } catch (err: unknown) {
    return {
      tenetId: "",
      rule: "",
      reason: `Soul 文件读失败，写操作全部拦截（fail-closed），先修好 Soul 再试：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  for (const tenet of soul.tenets) {
    if (!tenet.enabled || tenet.kind !== "invariant" || !tenet.deny.length) continue;
    const { rules } = compileSoulDenyRules({ ...soul, tenets: [tenet] });
    const decision = evaluate(rules, { tool, target, workdir });
    if (decision?.action === "deny") {
      return {
        tenetId: tenet.id,
        rule: decision.rule.raw,
        reason: `Soul 的 invariant 拦截了 ${tool}：Tenet ${tenet.id}「${tenet.text}」（规则 ${decision.rule.raw}）`,
      };
    }
  }
  return null;
}

/** 独立审查层用的 Soul 判定（reviewer.ts）：命中返回 BLOCK，rule 一律 soul-invariant。 */
export function reviewSoulInvariant(opts: {
  home: string | null;
  agentId: string;
  tool: string;
  target?: string;
  workdir?: string;
}): ReviewVerdict {
  const block = soulInvariantBlock(opts.home, opts.agentId, opts.tool, opts.target, opts.workdir);
  if (!block) {
    return { decision: "ALLOW", reason: "没有 Soul invariant 命中", reviewerModel: null, source: "deterministic" };
  }
  return {
    decision: "BLOCK",
    reason: block.reason,
    reviewerModel: null,
    source: "deterministic",
    rule: "soul-invariant",
  };
}

// ---- 提示词注入：Identity + Priors 进系统提示词，Invariant 只列“硬约束”（执行靠代码） ----

/** Soul 在主循环提示词里的一段：没有身份内容、没有启用中的 Tenet 时返回 ""（零影响）。 */
export function buildSoulSection(soul: SoulFile): string {
  const lines: string[] = [];
  const { name, persona, goal } = soul.identity;
  // 默认占位名字（default → "Nyra"）本身不算身份内容：只有人格/目标、
  // 或一个真正起过的名字才值得进提示词；否则空 Soul 会白白多一段。
  const defaultName = soul.agent === "default" ? "Nyra" : soul.agent;
  const hasIdentity = persona.trim() !== "" || goal.trim() !== "" || (name.trim() !== "" && name !== defaultName);
  if (hasIdentity) {
    lines.push(`你是 ${name || soul.agent}。${persona ? `人格：${persona}。` : ""}${goal ? `目标：${goal}。` : ""}`);
  }
  const priors = soul.tenets.filter((t) => t.enabled && t.kind === "prior");
  if (priors.length) {
    lines.push("偏好（柔性，可商量）：");
    for (const t of priors) lines.push(`- ${t.text}`);
  }
  const invariants = soul.tenets.filter((t) => t.enabled && t.kind === "invariant");
  if (invariants.length) {
    lines.push("硬约束（由代码在工具调用前强制执行，违反时工具调用会被拦截——不是靠自觉）：");
    for (const t of invariants) lines.push(`- ${t.text}`);
  }
  // GROK-2：Charter 进提示词——角色边界从“提示词里的一句话”变成“可检查的
  // 合同”。合同本身不强制执行（模型也可能不遵守），执行靠 invariant、
  // 团队审批门与交付时的 verifier 抽查；这里只让模型看得见自己的合同。
  if (soul.charter) {
    const c = soul.charter;
    lines.push("角色契约（Charter：可检查的合同，出问题先查合同——只做合同里的事，合同外的事停下问人）：");
    lines.push(`- 负责：${c.own}`);
    lines.push(`- 信息来源：${c.sources.join("、")}`);
    lines.push(`- 输出格式：${c.output}`);
    lines.push(`- 审批门：${c.approval}`);
    lines.push(`- 停下条件：${c.stop}`);
  }
  if (!lines.length) return "";
  return `## Soul（身份层：换模型不换魂，身份与规则存在 ~/.nyra/souls/${soul.agent}.json，与模型配置分文件）\n${lines.join("\n")}`;
}

// ---- 记忆索引：Soul 文件里记“哪个记忆文件、有几条、上次同步时间” ----

/**
 * 重建 Soul 的记忆索引：目前只索引全局 MEMORY.md（非空行数）。不经过
 * memory.ts——Soul 层不依赖记忆检索层，索引丢了随时重建，不丢记忆正文。
 * 路径只记相对 home 的相对路径，绝不记绝对路径。
 */
export function rebuildSoulMemoryIndex(home: string, agent: string): SoulFile {
  const soul = loadSoul(home, agent);
  const memoryPath = join(home, "MEMORY.md");
  let entries = 0;
  try {
    const raw = readFileSync(memoryPath, "utf-8").split("\n");
    if (raw.length && raw[raw.length - 1] === "") raw.pop();
    entries = raw.filter((line) => line.trim() !== "").length;
  } catch {
    entries = 0;
  }
  const current = soul.memory_index.files;
  if (current.length === 1 && current[0].path === "MEMORY.md" && current[0].entries === entries) return soul;
  soul.memory_index = {
    files: [{ path: "MEMORY.md", entries, updated_at: new Date().toISOString() }],
  };
  saveSoul(home, soul);
  return soul;
}

// ---- 审计 ----

/** Soul 审计行：增删改与拦截各写一行（只记元数据与 Tenet id，不记正文以外的敏感内容）。 */
export function appendSoulAudit(home: string, entry: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  appendFileSync(join(home, SOUL_AUDIT_FILE), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf-8");
}

/** Tenet 文本指纹（事件里不用正文时用；show 命令直接看正文）。 */
export function soulTenetHash(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
}

// ---- CLI：`nyra soul <init|show|status|list|add|remove|enable|disable|edit|export|import>` ----

export interface SoulCliInput {
  onEvent?: (type: string, data: Record<string, unknown>) => void;
}

const SOUL_USAGE = "用法：\n"
  + "  nyra soul show [agent]                                  看某个 agent 的 Soul（名字、人格、目标 + 全部 Tenets，默认 default）\n"
  + "  nyra soul status                                        列出已有的 Soul（各有几条 Tenet、开着几条）\n"
  + "  nyra soul list                                          只列 agent 名\n"
  + "  nyra soul init [agent] [--name 名字] [--persona 人格] [--goal 目标]   建一个 Soul 文件（已存在不覆盖）\n"
  + "  nyra soul add --kind invariant|prior --text \"正文\" [--deny \"规则\" ...] [--session 会话 id] [--yes]   加一条 Tenet\n"
  + "  nyra soul remove <tenet id> [--yes]                     删一条 Tenet（先列出来确认，--yes 跳过确认）\n"
  + "  nyra soul enable <tenet id> / disable <tenet id>        开关一条 Tenet（关掉的不参与编译与提示词）\n"
  + "  nyra soul edit <tenet id> [--text \"新正文\"] [--deny \"规则\" ...]   改一条 Tenet（deny 只对 invariant 有效）\n"
  + "  nyra soul export [agent] [--out <路径>]                 导出 Soul 文件（JSON，默认打印到终端；不上传）\n"
  + "  nyra soul import <路径> [--agent <名字>] [--yes]         导入 Soul 文件（替换同名文件，须确认）\n"
  + "  nyra soul charter set <agent> --own \"负责什么\" --sources \"来源1、来源2\" --output \"输出格式\" --approval \"审批门\" --stop \"停下条件\" [--yes]   写一份角色契约（五项齐全才落盘）\n"
  + "  nyra soul charter show [agent]                          看某个 agent 的角色契约\n"
  + "  nyra soul charter clear <agent> [--yes]                 清掉角色契约（清掉后该 agent 不能再接团队单，直到重写一份）\n"
  + "invariant 的 deny 规则用权限规则语法，如 \"shell(rm *)\"、\"write_file(**/.env)\"；prior 不带 deny，只进提示词。\n"
  + "Tenet 的增删改都要你确认（交互问一次，或 --yes），改动记进 soul-audit.jsonl 与证据链。\n"
  + "详见 docs/soul.md";

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
}

function flagValues(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  }
  return out;
}

/** Tenet 增删改的证据记录（与缺口 2 的 memory_forget 同一套：谁批准的、动了哪条、动完剩几条）。 */
function saveSoulEvidence(home: string, action: string, agent: string, tenet: SoulTenet, remaining: number): void {
  try {
    new EvidenceStore(join(home, "evidence"), "soul").save(
      "soul_tenet",
      `soul://${agent}`,
      [
        `nyra soul ${action}（终端）`,
        `Soul 文件：souls/${agent}.json`,
        "批准：用户（终端确认）",
        `${action}了 Tenet [${tenet.id}]（${tenet.kind}）：${tenet.text}`,
        `改完剩 ${remaining} 条 Tenet。`,
      ].join("\n"),
    );
  } catch { /* 证据落盘失败不破坏 Tenet 改动本身 */ }
}

function emitSoulEvent(input: SoulCliInput | undefined, type: string, data: Record<string, unknown>): void {
  try {
    input?.onEvent?.(type, data);
  } catch { /* 观察器故障不破坏 Tenet 改动本身 */ }
}

function formatSoul(soul: SoulFile, exists: boolean, warnings: string[]): string {
  const lines: string[] = [];
  lines.push(`Soul：${soul.agent}${exists ? "" : "（还没有落盘的文件，下面是默认内容，用 nyra soul init 建一个）"}`);
  lines.push(`  名字：${soul.identity.name || "（未填）"}`);
  lines.push(`  人格：${soul.identity.persona || "（未填）"}`);
  lines.push(`  目标：${soul.identity.goal || "（未填）"}`);
  if (!soul.tenets.length) {
    lines.push("  Tenets：没有（nyra soul add 加一条）");
  } else {
    lines.push(`  Tenets（${soul.tenets.length} 条）：`);
    for (const t of soul.tenets) {
      lines.push(`  - [${t.id}] ${t.kind === "invariant" ? "不变量" : "偏好"}${t.enabled ? "" : "（已关）"}：${t.text}`);
      if (t.kind === "invariant") lines.push(`      deny：${t.deny.join("、")}`);
      lines.push(`      来源会话：${t.source_session ?? "未记录"}；创建：${t.created_at || "未记录"}`);
    }
  }
  if (soul.memory_index.files.length) {
    lines.push("  记忆索引：");
    for (const f of soul.memory_index.files) {
      lines.push(`    ${f.path}：${f.entries} 条（同步于 ${f.updated_at || "未记录"}）`);
    }
  } else {
    lines.push("  记忆索引：未同步（nyra soul show 时自动同步，或等下次改动）");
  }
  // GROK-2：show 时把 Charter 也亮出来（没有就写没有，别让人以为有合同）。
  if (soul.charter) {
    const c = soul.charter;
    lines.push("  角色契约（Charter）：");
    lines.push(`    负责：${c.own}`);
    lines.push(`    信息来源：${c.sources.join("、")}`);
    lines.push(`    输出格式：${c.output}`);
    lines.push(`    审批门：${c.approval}`);
    lines.push(`    停下条件：${c.stop}`);
  } else {
    lines.push("  角色契约：没有（团队接单须有完整 Charter，nyra soul charter set 写一份）");
  }
  for (const w of warnings) lines.push(`  ⚠️  ${w}`);
  return lines.join("\n");
}

export async function handleSoul(argv: string[], home: string, input?: SoulCliInput): Promise<number> {
  const cmd = argv[0];
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(SOUL_USAGE + "\n");
      return 0;
    }
    if (cmd === "status") {
      const agents = listSoulAgents(home);
      if (!agents.length) {
        process.stdout.write("还没有 Soul 文件（nyra soul init 建一个，默认 agent 是 default）。\n");
        return 0;
      }
      for (const agent of agents) {
        let soul: SoulFile;
        try {
          soul = loadSoul(home, agent);
        } catch (err: unknown) {
          process.stdout.write(`${agent}：Soul 文件损坏（${err instanceof Error ? err.message : String(err)}）\n`);
          continue;
        }
        const enabled = soul.tenets.filter((t) => t.enabled).length;
        const invariants = soul.tenets.filter((t) => t.kind === "invariant").length;
        const warnings = compileSoulDenyRules(soul).warnings;
        process.stdout.write(`${agent}：${soul.tenets.length} 条 Tenet（不变量 ${invariants} 条，偏好 ${soul.tenets.length - invariants} 条），开着 ${enabled} 条${warnings.length ? `，⚠️ ${warnings.length} 条规则警告` : ""}\n`);
      }
      return 0;
    }
    if (cmd === "list") {
      for (const agent of listSoulAgents(home)) process.stdout.write(`${agent}\n`);
      return 0;
    }
    if (cmd === "show") {
      const agent = argv[1] ?? "default";
      validateSoulAgentId(agent);
      const exists = soulExists(home, agent);
      let soul = loadSoul(home, agent);
      const warnings = compileSoulDenyRules(soul).warnings;
      if (exists) {
        // 看的时候顺手把记忆索引同步一下（读操作，不改 Tenet、不改身份）。
        try { soul = rebuildSoulMemoryIndex(home, agent); } catch { /* 索引同步失败不破坏查看 */ }
      }
      process.stdout.write(formatSoul(soul, exists, warnings) + "\n");
      return 0;
    }
    if (cmd === "init") {
      const agent = argv[1] ?? "default";
      validateSoulAgentId(agent);
      if (soulExists(home, agent)) {
        process.stdout.write(`Soul ${agent} 已存在（souls/${agent}.json），不覆盖；改身份用 nyra soul edit 改 Tenet，加 Tenet 用 nyra soul add。\n`);
        return 0;
      }
      const identity: SoulIdentity = {
        name: flagValue(argv, "--name") ?? (agent === "default" ? "Nyra" : agent),
        persona: flagValue(argv, "--persona") ?? "",
        goal: flagValue(argv, "--goal") ?? "",
      };
      const soul = defaultSoul(agent);
      soul.identity = identity;
      saveSoul(home, soul);
      process.stdout.write(`已建 Soul ${agent}（souls/${agent}.json）：名字 ${identity.name}。\n`);
      return 0;
    }
    if (cmd === "add") {
      const kind = flagValue(argv, "--kind");
      const text = flagValue(argv, "--text");
      const deny = flagValues(argv, "--deny");
      const session = flagValue(argv, "--session");
      const yes = argv.includes("--yes");
      if (kind !== "invariant" && kind !== "prior") {
        process.stderr.write("加 Tenet 须指定 --kind invariant（不变量，进规则层）或 --kind prior（偏好，只进提示词）。\n");
        return 2;
      }
      if (!text || !text.trim()) {
        process.stderr.write("加 Tenet 须给 --text \"正文\"。\n");
        return 2;
      }
      if (kind === "invariant" && !deny.length) {
        process.stderr.write("invariant 至少要有一条 --deny \"规则\"（没有规则就编译不出东西，改成 --kind prior 或补规则）。\n");
        return 2;
      }
      if (kind === "prior" && deny.length) {
        process.stderr.write("prior 不能带 --deny（prior 只进提示词，不进规则层）。\n");
        return 2;
      }
      const agent = flagValue(argv, "--agent") ?? resolveSoulAgentId(null);
      validateSoulAgentId(agent);
      if (!yes) {
        process.stdout.write(`将给 Soul ${agent} 加一条 ${kind === "invariant" ? "不变量" : "偏好"}：${text.trim()}\n`);
        if (deny.length) process.stdout.write(`  deny：${deny.join("、")}\n`);
        const choice = await askApproval("确认加这条 Tenet 吗？");
        if (choice !== "yes") { process.stdout.write("已取消，未加任何东西。\n"); return 0; }
      }
      const tenet = addTenet(home, agent, { kind, text, deny, sourceSession: session ?? null });
      const remaining = loadSoul(home, agent).tenets.length;
      appendSoulAudit(home, { kind: "added", agent, tenet_id: tenet.id, tenet_kind: kind, remaining });
      saveSoulEvidence(home, "add", agent, tenet, remaining);
      emitSoulEvent(input, "soul_tenet_added", { agent, tenet_id: tenet.id, kind });
      process.stdout.write(`已加 Tenet [${tenet.id}]（${kind === "invariant" ? "不变量" : "偏好"}），Soul ${agent} 现在共 ${remaining} 条。\n`);
      return 0;
    }
    if (cmd === "remove") {
      const id = argv[1];
      const yes = argv.includes("--yes");
      const agent = flagValue(argv, "--agent") ?? resolveSoulAgentId(null);
      if (!id) { process.stderr.write("用法：nyra soul remove <tenet id> [--yes]\n"); return 2; }
      validateSoulAgentId(agent);
      const soul = loadSoul(home, agent);
      const tenet = soul.tenets.find((t) => t.id === id);
      if (!tenet) { process.stderr.write(`找不到 Tenet ${id}（先用 nyra soul show 看 id）。\n`); return 1; }
      if (!yes) {
        process.stdout.write(`将从 Soul ${agent} 删掉 Tenet [${tenet.id}]（${tenet.kind}）：${tenet.text}（删后剩 ${soul.tenets.length - 1} 条）\n`);
        const choice = await askApproval("确认删除这条 Tenet 吗？");
        if (choice !== "yes") { process.stdout.write("已取消，未删除任何东西。\n"); return 0; }
      }
      const { remaining } = removeTenet(home, agent, id);
      appendSoulAudit(home, { kind: "removed", agent, tenet_id: id, tenet_kind: tenet.kind, remaining });
      saveSoulEvidence(home, "remove", agent, tenet, remaining);
      emitSoulEvent(input, "soul_tenet_removed", { agent, tenet_id: id, remaining });
      process.stdout.write(`已删除 Tenet [${id}]，Soul ${agent} 现在剩 ${remaining} 条。\n`);
      return 0;
    }
    if (cmd === "enable" || cmd === "disable") {
      const id = argv[1];
      const agent = flagValue(argv, "--agent") ?? resolveSoulAgentId(null);
      if (!id) { process.stderr.write(`用法：nyra soul ${cmd} <tenet id>\n`); return 2; }
      validateSoulAgentId(agent);
      const tenet = setTenetEnabled(home, agent, id, cmd === "enable");
      const remaining = loadSoul(home, agent).tenets.length;
      appendSoulAudit(home, { kind: cmd === "enable" ? "enabled" : "disabled", agent, tenet_id: id, tenet_kind: tenet.kind, remaining });
      saveSoulEvidence(home, cmd, agent, tenet, remaining);
      emitSoulEvent(input, "soul_tenet_changed", { agent, tenet_id: id, change: cmd === "enable" ? "enabled" : "disabled" });
      process.stdout.write(`Tenet [${id}] 已${cmd === "enable" ? "开启" : "关闭"}。\n`);
      return 0;
    }
    if (cmd === "edit") {
      const id = argv[1];
      const text = flagValue(argv, "--text");
      const deny = flagValues(argv, "--deny");
      const yes = argv.includes("--yes");
      const agent = flagValue(argv, "--agent") ?? resolveSoulAgentId(null);
      if (!id) { process.stderr.write("用法：nyra soul edit <tenet id> [--text \"新正文\"] [--deny \"规则\" ...]\n"); return 2; }
      if (text === undefined && !deny.length) { process.stderr.write("edit 须至少给 --text 或 --deny 之一。\n"); return 2; }
      validateSoulAgentId(agent);
      const soul = loadSoul(home, agent);
      const tenet = soul.tenets.find((t) => t.id === id);
      if (!tenet) { process.stderr.write(`找不到 Tenet ${id}（先用 nyra soul show 看 id）。\n`); return 1; }
      if (tenet.kind === "prior" && deny.length) { process.stderr.write("prior 不能带 --deny（prior 只进提示词，不进规则层）。\n"); return 2; }
      if (!yes) {
        process.stdout.write(`将改 Tenet [${tenet.id}]（${tenet.kind}）：${tenet.text}\n`);
        if (text !== undefined) process.stdout.write(`  新正文：${text}\n`);
        if (deny.length) process.stdout.write(`  新 deny：${deny.join("、")}\n`);
        const choice = await askApproval("确认改这条 Tenet 吗？");
        if (choice !== "yes") { process.stdout.write("已取消，未改任何东西。\n"); return 0; }
      }
      const updated = updateTenet(home, agent, id, { text, deny: deny.length ? deny : undefined });
      const remaining = loadSoul(home, agent).tenets.length;
      appendSoulAudit(home, { kind: "edited", agent, tenet_id: id, tenet_kind: updated.kind, remaining });
      saveSoulEvidence(home, "edit", agent, updated, remaining);
      emitSoulEvent(input, "soul_tenet_changed", { agent, tenet_id: id, change: "edited" });
      process.stdout.write(`Tenet [${id}] 已改。\n`);
      return 0;
    }
    if (cmd === "export") {
      const agent = argv[1] ?? "default";
      validateSoulAgentId(agent);
      const out = flagValue(argv, "--out");
      const soul = loadSoul(home, agent);
      const text = JSON.stringify(soul, null, 2) + "\n";
      if (out) {
        writeFileSync(out, text, { mode: 0o600 });
        process.stdout.write(`Soul ${agent} 已导出到 ${out}（默认不上传，文件只在你本机）。\n`);
        return 0;
      }
      process.stdout.write(text);
      return 0;
    }
    // GROK-2：Charter 子命令——set 写一份（五项齐全才落盘）、show 看、clear 清掉。
    if (cmd === "charter") {
      const sub = argv[1];
      if (sub === "show") {
        const agent = argv[2] ?? "default";
        validateSoulAgentId(agent);
        const soul = loadSoul(home, agent);
        if (!soul.charter) {
          process.stdout.write(`Soul ${agent} 还没有角色契约（团队接单须有完整 Charter，nyra soul charter set 写一份）。\n`);
          return 0;
        }
        const c = soul.charter;
        process.stdout.write(
          `角色契约（${agent}）：\n  负责：${c.own}\n  信息来源：${c.sources.join("、")}\n  输出格式：${c.output}\n  审批门：${c.approval}\n  停下条件：${c.stop}\n`,
        );
        return 0;
      }
      if (sub === "set") {
        const agent = argv[2];
        const yes = argv.includes("--yes");
        if (!agent) { process.stderr.write("用法：nyra soul charter set <agent> --own \"负责什么\" --sources \"来源1、来源2\" --output \"输出格式\" --approval \"审批门\" --stop \"停下条件\" [--yes]\n"); return 2; }
        validateSoulAgentId(agent);
        const sourcesRaw = flagValue(argv, "--sources") ?? "";
        const charterInput = {
          own: flagValue(argv, "--own") ?? "",
          sources: sourcesRaw.split(/[,、]/).map((s) => s.trim()).filter(Boolean),
          output: flagValue(argv, "--output") ?? "",
          approval: flagValue(argv, "--approval") ?? "",
          stop: flagValue(argv, "--stop") ?? "",
        };
        const err = validateCharter(charterInput);
        if (err) { process.stderr.write(`Charter 写坏了，没落盘：${err}\n`); return 2; }
        if (!yes) {
          process.stdout.write(`将给 Soul ${agent} 写一份角色契约：\n  负责：${charterInput.own}\n  信息来源：${charterInput.sources.join("、")}\n  输出格式：${charterInput.output}\n  审批门：${charterInput.approval}\n  停下条件：${charterInput.stop}\n`);
          const choice = await askApproval("确认写这份 Charter 吗？");
          if (choice !== "yes") { process.stdout.write("已取消，未写任何东西。\n"); return 0; }
        }
        setCharter(home, agent, charterInput);
        appendSoulAudit(home, { kind: "charter_set", agent });
        emitSoulEvent(input, "soul_charter_set", { agent });
        process.stdout.write(`已给 Soul ${agent} 写好角色契约（五项齐全）。\n`);
        return 0;
      }
      if (sub === "clear") {
        const agent = argv[2];
        const yes = argv.includes("--yes");
        if (!agent) { process.stderr.write("用法：nyra soul charter clear <agent> [--yes]\n"); return 2; }
        validateSoulAgentId(agent);
        const soul = loadSoul(home, agent);
        if (!soul.charter) {
          process.stdout.write(`Soul ${agent} 本来就没有角色契约，不用清。\n`);
          return 0;
        }
        if (!yes) {
          process.stdout.write(`将清掉 Soul ${agent} 的角色契约（清掉后该 agent 不能再接团队单，直到重写一份）。\n`);
          const choice = await askApproval("确认清掉这份 Charter 吗？");
          if (choice !== "yes") { process.stdout.write("已取消，未清任何东西。\n"); return 0; }
        }
        clearCharter(home, agent);
        appendSoulAudit(home, { kind: "charter_cleared", agent });
        emitSoulEvent(input, "soul_charter_cleared", { agent });
        process.stdout.write(`已清掉 Soul ${agent} 的角色契约。\n`);
        return 0;
      }
      process.stderr.write("用法：nyra soul charter <set|show|clear> [agent]\n");
      return 2;
    }
    if (cmd === "import") {
      const file = argv[1];
      const agent = flagValue(argv, "--agent");
      const yes = argv.includes("--yes");
      if (!file) { process.stderr.write("用法：nyra soul import <路径> [--agent <名字>] [--yes]\n"); return 2; }
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf-8"));
      } catch (err: unknown) {
        process.stderr.write(`导入文件读失败：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      let soul: SoulFile;
      try {
        soul = parseSoulFile(raw);
      } catch (err: unknown) {
        process.stderr.write(`导入文件格式不对：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      const target = agent ?? soul.agent;
      validateSoulAgentId(target);
      soul.agent = target;
      if (!yes) {
        const exists = soulExists(home, target);
        process.stdout.write(`将${exists ? "替换" : "新建"} Soul ${target}（${soul.tenets.length} 条 Tenet，身份：${soul.identity.name}）\n`);
        const choice = await askApproval("确认导入吗？");
        if (choice !== "yes") { process.stdout.write("已取消，未导入任何东西。\n"); return 0; }
      }
      saveSoul(home, soul);
      appendSoulAudit(home, { kind: "imported", agent: target, tenet_count: soul.tenets.length, remaining: soul.tenets.length });
      process.stdout.write(`已导入 Soul ${target}（${soul.tenets.length} 条 Tenet）。\n`);
      return 0;
    }
    process.stderr.write(SOUL_USAGE + "\n");
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
