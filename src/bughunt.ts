// src/bughunt.ts — 授权漏洞挖掘技能包（候选提案 1，学 Claude-BugHunter 的
// 7-Question Gate + 范围卡 + 证据卫生，合 src-hunter 的证伪验证器思路）。
//
// 只做确定性校验（不调模型、不联网、不真的去测目标）：范围卡校验、证伪结论
// 判定、七问核对、证据卫生扫描、VRT 严重度映射，五道门合起来是一次“提交前
// 核对”。模型审查那一环走缺口 10 的 reviewToolCall（submit_bughunt_report
// 是虚拟敏感动作，见 DEFAULT_REVIEWED_TOOLS 的注释）。
//
// 红线写进校验层，缺一不可：只测授权目标；禁批量扫描、自动提交、凭据攻击、
// 社工钓鱼与针对真人的信息收集；提交前须人工验证、可复现 PoC；平台规则
// 高于技能包。审计日志只记范围卡名、目标主机名与结论，不记完整 URL 与
// 报告原文（URL 查询串里可能带 token）。
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync, writeSync, fsyncSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { parseSkillText } from "./skills.ts";
import {
  buildReviewerRunner, reviewToolCall,
  type ReviewVerdict, type ReviewerLike,
} from "./reviewer.ts";
import BUGHUNT_SKILL_TEXT_RAW from "./skills/authorized-bughunt.md" with { type: "text" };

export class BughuntError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BughuntError";
  }
}

/** 技能包在仓库里的正文（src/skills/authorized-bughunt.md，Bun 文本导入进包）。 */
export const BUGHUNT_SKILL_NAME = "authorized-bughunt";
export const BUGHUNT_SKILL_TEXT = BUGHUNT_SKILL_TEXT_RAW;

/** 五条红线手法：范围卡的 forbidden_techniques 必须一字不差全包含，少一条卡就无效。 */
export const REQUIRED_FORBIDDEN_TECHNIQUES: readonly string[] = [
  "批量扫描", "自动提交", "凭据攻击", "社工钓鱼", "针对真人的信息收集",
];

/** 范围卡：接任务先建卡，越界直接拒绝。 */
export interface ScopeCard {
  name: string;
  platform: string;
  targets: string[];
  forbidden: string[];
  allowed_techniques: string[];
  forbidden_techniques: string[];
  max_requests_per_second: number;
  account?: string;
  expires_at?: string;
  notes?: string;
}

export interface ScopeStore {
  version: 1;
  scopes: ScopeCard[];
}

export function scopeStorePath(home: string): string {
  return join(home, "bughunt-scopes.json");
}

export function bughuntAuditPath(home: string): string {
  return join(home, "bughunt-audit.jsonl");
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
export function loadScopeStore(home: string): ScopeStore {
  const path = scopeStorePath(home);
  if (!existsSync(path)) return { version: 1, scopes: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new BughuntError(`范围卡账本损坏，已备份到 ${backup}，请检查后再试：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as ScopeStore).scopes)) {
    const backup = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, backup); } catch { /* ignore */ }
    throw new BughuntError(`范围卡账本格式无效，已备份到 ${backup}`);
  }
  return raw as ScopeStore;
}

export function saveScopeStore(home: string, store: ScopeStore): void {
  atomicWriteJson(scopeStorePath(home), store);
}

export function listScopes(home: string): ScopeCard[] {
  return loadScopeStore(home).scopes;
}

export function findScope(home: string, name: string): ScopeCard | null {
  return listScopes(home).find((s) => s.name === name) ?? null;
}

// ---- 范围卡校验 ----

const HOST_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOST_RE = new RegExp(`^(\\*\\.)?(${HOST_LABEL}\\.)*${HOST_LABEL}$`);

function isValidHostname(value: string): boolean {
  return HOST_RE.test(value) && value.length <= 253;
}

/** 目标条目：URL（http/https）或主机名（可带 `*.` 前缀表子域名）。 */
export function parseTargetEntry(entry: string): { kind: "url" | "host"; value: string } | null {
  const v = entry.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (!isValidHostname(u.hostname)) return null;
      return { kind: "url", value: v.replace(/\/+$/, "") };
    } catch {
      return null;
    }
  }
  if (!isValidHostname(v)) return null;
  return { kind: "host", value: v.toLowerCase() };
}

/** 校验范围卡：返回错误清单（空 = 有效）。红线缺失、目标为空、速率越界都是否决项。 */
export function validateScopeCard(card: unknown): string[] {
  const errors: string[] = [];
  if (!card || typeof card !== "object" || Array.isArray(card)) return ["范围卡必须是 JSON 对象"];
  const c = card as Record<string, unknown>;
  if (typeof c.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(c.name)) {
    errors.push("name 缺失或格式不对（只允许字母、数字、- 和 _，字母或数字开头）");
  }
  if (typeof c.platform !== "string" || !c.platform.trim()) errors.push("platform 缺失");
  if (!Array.isArray(c.targets) || c.targets.length === 0) {
    errors.push("targets 为空（至少写一个允许测的目标）");
  } else {
    for (const t of c.targets) {
      if (typeof t !== "string" || !parseTargetEntry(t)) errors.push(`targets 里有无效条目：${String(t)}`);
    }
  }
  if (c.forbidden !== undefined) {
    if (!Array.isArray(c.forbidden)) {
      errors.push("forbidden 必须是数组");
    } else {
      for (const f of c.forbidden) {
        if (typeof f !== "string" || !f.trim()) { errors.push(`forbidden 里有无效条目：${String(f)}`); continue; }
        const v = f.trim();
        // 禁区条目：主机名、URL，或路径前缀（以 / 开头）。
        if (!v.startsWith("/") && !parseTargetEntry(v)) errors.push(`forbidden 里有无效条目：${v}`);
      }
    }
  }
  if (!Array.isArray(c.allowed_techniques)) {
    errors.push("allowed_techniques 必须是数组");
  } else if (c.allowed_techniques.some((t) => typeof t !== "string" || !t.trim())) {
    errors.push("allowed_techniques 里有空条目");
  }
  if (!Array.isArray(c.forbidden_techniques)) {
    errors.push("forbidden_techniques 必须是数组");
  } else {
    const missing = REQUIRED_FORBIDDEN_TECHNIQUES.filter(
      (r) => !(c.forbidden_techniques as unknown[]).includes(r),
    );
    if (missing.length) errors.push(`forbidden_techniques 缺少红线手法：${missing.join("、")}（少一条范围卡就无效）`);
    const allowed = new Set((c.allowed_techniques as unknown[] ?? []).filter((t) => typeof t === "string"));
    const clash = (c.forbidden_techniques as unknown[]).filter((t) => typeof t === "string" && allowed.has(t));
    if (clash.length) errors.push(`同一手法既允许又禁止：${clash.join("、")}`);
  }
  if (typeof c.max_requests_per_second !== "number" || !Number.isFinite(c.max_requests_per_second)
    || c.max_requests_per_second <= 0 || c.max_requests_per_second > 10) {
    errors.push("max_requests_per_second 必须是 0 到 10 之间的数字");
  }
  if (c.expires_at !== undefined && (typeof c.expires_at !== "string" || Number.isNaN(Date.parse(c.expires_at)))) {
    errors.push("expires_at 不是合法日期");
  }
  return errors;
}

export function parseScopeCard(text: string): ScopeCard {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: unknown) {
    throw new BughuntError(`范围卡不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const errors = validateScopeCard(raw);
  if (errors.length) throw new BughuntError(`范围卡无效：${errors.join("；")}`);
  return raw as ScopeCard;
}

/** 建范围卡：校验 + 名唯一（重名拒绝，先删旧卡或改名）。 */
export function addScope(home: string, card: ScopeCard): ScopeCard {
  const errors = validateScopeCard(card);
  if (errors.length) throw new BughuntError(`范围卡无效：${errors.join("；")}`);
  const store = loadScopeStore(home);
  if (store.scopes.some((s) => s.name === card.name)) {
    throw new BughuntError(`范围卡 ${card.name} 已存在（先删掉旧卡，或改名）`);
  }
  store.scopes.push(card);
  saveScopeStore(home, store);
  return card;
}

export function removeScope(home: string, name: string): boolean {
  const store = loadScopeStore(home);
  const next = store.scopes.filter((s) => s.name !== name);
  if (next.length === store.scopes.length) return false;
  saveScopeStore(home, { version: 1, scopes: next });
  return true;
}

// ---- 目标在不在范围内（禁区优先，过期即越界） ----

/** 主机名匹配：裸主机名只匹配它自己；`*.example.com` 匹配子域名（不含自身）。 */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) {
    const suffix = p.slice(1);
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

export interface TargetCheck {
  inScope: boolean;
  reason: string;
}

export function checkTarget(card: ScopeCard, url: string): TargetCheck {
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
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  // 禁区优先：主机名命中禁区，或路径命中禁区路径前缀。
  for (const f of card.forbidden ?? []) {
    const entry = f.trim();
    if (entry.startsWith("/")) {
      if (path === entry || path.startsWith(entry.endsWith("/") ? entry : `${entry}/`)) {
        return { inScope: false, reason: `命中禁区路径 ${entry}，越界` };
      }
      continue;
    }
    const parsed = parseTargetEntry(entry);
    if (!parsed) continue;
    if (parsed.kind === "host" && hostMatches(host, parsed.value)) {
      return { inScope: false, reason: `命中禁区主机 ${entry}，越界` };
    }
    if (parsed.kind === "url") {
      const want = parsed.value.replace(/^https?:\/\//i, "");
        const got = `${host}${u.pathname}`.replace(/\/+$/, "");
        if (got === want || got.startsWith(`${want}/`)) {
          return { inScope: false, reason: `命中禁区 ${entry}，越界` };
        }
      }
    }
    for (const t of card.targets) {
      const parsed = parseTargetEntry(t);
      if (!parsed) continue;
      if (parsed.kind === "host" && hostMatches(host, parsed.value)) {
        return { inScope: true, reason: `目标主机 ${host} 在范围卡 ${card.name} 内` };
      }
      if (parsed.kind === "url") {
        const want = parsed.value.replace(/^https?:\/\//i, "");
          const got = `${host}${u.pathname}`.replace(/\/+$/, "");
          if (got === want || got.startsWith(`${want}/`)) {
            return { inScope: true, reason: `目标 ${url} 在范围卡 ${card.name} 内` };
          }
        }
      }
      return { inScope: false, reason: `目标主机 ${host} 不在范围卡 ${card.name} 的目标清单里` };
    }

    // ---- 证伪验证（学 src-hunter falsify.py：三态结论） ----

    /** 证伪尝试的检查名：与技能正文里的六种尝试一一对应。 */
    export const FALSIFY_CHECKS: readonly string[] = [
      "independent-reproduction", "different-input", "cross-user",
      "negative-control", "header-check", "browser-execution",
    ];

    export type FalsifyOutcome = "survived" | "refuted" | "blocked";
    export type FalsifyVerdict = "confirmed" | "pending" | "rejected";

    export interface FalsificationAttempt {
      check: string;
      outcome: FalsifyOutcome;
      detail: string;
    }

    export interface FalsificationInput {
      attempts: FalsificationAttempt[];
      /** 决定性事实没解决时的确切描述（没给时取第一个 blocked 尝试的 detail）。 */
      blocker?: string;
      validationPlan?: string;
      vulnClass?: string;
    }

    export interface FalsificationResult {
      verdict: FalsifyVerdict;
      refutation?: string;
      blocker?: string;
      validationPlan?: string;
    }

    /**
    * 证伪结论判定（纯函数，不真的去测目标——探测由 agent/人按技能做，这里只算结论）：
    * 有 refuted → rejected；有 blocked → pending（附确切 blocker 与验证计划）；
    * 全 survived → confirmed；一次尝试都没做 → pending（尚未证伪，不许提交）。
    * 未知检查名直接抛错（不静默收进结论）。
    */
    export function evaluateFalsification(input: FalsificationInput): FalsificationResult {
      const attempts = input.attempts ?? [];
      for (const a of attempts) {
        if (!FALSIFY_CHECKS.includes(a.check)) {
          throw new BughuntError(`未知的证伪检查：${a.check}（只认 ${FALSIFY_CHECKS.join("、")}）`);
        }
        if (a.outcome !== "survived" && a.outcome !== "refuted" && a.outcome !== "blocked") {
          throw new BughuntError(`证伪尝试 outcome 非法：${String(a.outcome)}（只认 survived / refuted / blocked）`);
        }
        if (typeof a.detail !== "string" || !a.detail.trim()) {
          throw new BughuntError(`证伪尝试 ${a.check} 缺少 detail（每次尝试都要写清做了什么、看到什么）`);
        }
      }
      if (!attempts.length) {
        return {
          verdict: "pending",
          blocker: "尚未做任何证伪尝试",
          validationPlan: "按技能里的证伪清单至少做一次独立复现（independent-reproduction），再重新核对",
        };
      }
      const refuted = attempts.find((a) => a.outcome === "refuted");
      if (refuted) return { verdict: "rejected", refutation: refuted.detail };
      const blocked = attempts.find((a) => a.outcome === "blocked");
      if (blocked) {
        const blocker = input.blocker?.trim() || blocked.detail;
        let plan = input.validationPlan?.trim();
        if (!plan) {
          plan = input.vulnClass === "xss-reflected"
          ? "在浏览器里打开带 payload 的页面，观察脚本是否真的执行（如出现弹窗或 DOM 标记）；执行了升 confirmed，没执行标 rejected 并写清原因"
          : "补上被拦住的那项检查所需的能力或观察，再重新判定";
        }
        return { verdict: "pending", blocker, validationPlan: plan };
      }
      return { verdict: "confirmed" };
    }

    // ---- 提交前七问 ----

    export const SEVEN_QUESTIONS: readonly { id: string; text: string }[] = [
      { id: "q1", text: "目标在授权范围内吗（范围卡已建、目标在卡内、范围卡未过期）？" },
      { id: "q2", text: "在平台接受的影响清单上吗（影响真实、平台收这类报告）？" },
      { id: "q3", text: "已验证吗（可复现 PoC，别人按步骤能重现）？" },
      { id: "q4", text: "已过证伪吗（证伪结论是 confirmed，不是 pending/rejected）？" },
      { id: "q5", text: "已脱敏吗（报告里无真实 PII、凭证、token）？" },
      { id: "q6", text: "无越界行为吗（测试中没碰禁区、没超速率、没用禁用的手法）？" },
      { id: "q7", text: "人工复核过了吗（提交前真人看过报告全文）？" },
    ];

    export type SevenAnswer = "yes" | "no" | "unknown";

    export interface SevenResult {
      passed: boolean;
      failed: string[];
      unanswered: string[];
    }

    /** 七问核对：全是 yes 才过；no、unknown、没答一律不过（不知道 = 没过）。 */
    export function evaluateSevenQuestions(answers: Record<string, SevenAnswer> | null | undefined): SevenResult {
      const failed: string[] = [];
      const unanswered: string[] = [];
      for (const q of SEVEN_QUESTIONS) {
        const a = answers?.[q.id];
        if (a === undefined) unanswered.push(q.id);
        else if (a !== "yes") failed.push(q.id);
      }
      return { passed: failed.length === 0 && unanswered.length === 0, failed, unanswered };
    }

    // ---- 证据卫生 ----

    /** 卫生扫描只返回模式 id、中文名与行号，绝不返回匹配到的原文（输出本身不能泄露秘密）。 */
    export const HYGIENE_PATTERNS: readonly { id: string; label: string; regex: RegExp }[] = [
      { id: "email", label: "邮箱地址", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
      { id: "phone-cn", label: "手机号", regex: /1[3-9]\d{9}/ },
      { id: "id-card-cn", label: "身份证号", regex: /\d{17}[\dXx]/ },
      { id: "password-assign", label: "明文密码赋值", regex: /password\s*[:=]\s*\S+/i },
      { id: "api-key", label: "API 密钥字样", regex: /(api[_-]?key|apikey)\s*[:=]\s*['"]?[A-Za-z0-9_-]{8,}/i },
          { id: "bearer-token", label: "Bearer token", regex: /Bearer\s+[A-Za-z0-9_.-]{10,}/ },
          { id: "private-key", label: "私钥", regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
          { id: "aws-key", label: "AWS Access Key", regex: /AKIA[0-9A-Z]{16}/ },
          { id: "session-cookie", label: "会话 Cookie", regex: /(sessionid|session[_-]?id|PHPSESSID)\s*=\s*[A-Za-z0-9_-]{8,}/i },
        ];

        /** 报告必填段（缺一段就不完整）。 */
        export const REQUIRED_REPORT_SECTIONS: readonly string[] = [
          "目标", "复现步骤", "影响", "严重度", "证伪",
        ];

        export interface HygieneHit {
          pattern: string;
          label: string;
          lines: number[];
        }

        export interface HygieneResult {
          hits: HygieneHit[];
          missingSections: string[];
          clean: boolean;
        }

        export function checkEvidenceHygiene(report: string): HygieneResult {
          const lines = report.split("\n");
          const hits: HygieneHit[] = [];
          for (const p of HYGIENE_PATTERNS) {
            const found: number[] = [];
            lines.forEach((line, i) => {
                p.regex.lastIndex = 0;
                if (p.regex.test(line)) found.push(i + 1);
              });
            if (found.length) hits.push({ pattern: p.id, label: p.label, lines: found });
          }
          const missingSections = REQUIRED_REPORT_SECTIONS.filter((s) => !report.includes(s));
          return { hits, missingSections, clean: hits.length === 0 && missingSections.length === 0 };
        }

        // ---- VRT 严重度映射（Nyra 本地简化表，仅作初定，最终以平台的 VRT 为准） ----

        export type VrtSeverity = "critical" | "high" | "medium" | "low" | "info";

        export const VRT_SEVERITY: Record<string, VrtSeverity> = {
          "rce": "critical",
          "sqli": "critical",
          "auth-bypass": "critical",
          "idor": "high",
          "xss-stored": "high",
          "ssrf": "high",
          "price-tampering": "high",
          "business-logic": "high",
          "path-traversal": "high",
          "xss-reflected": "medium",
          "csrf": "medium",
          "info-disclosure": "medium",
          "session-fixation": "medium",
          "open-redirect": "low",
          "rate-limit-bypass": "low",
        };

        export function mapVrtSeverity(vulnClass: string): { severity: VrtSeverity } | { severity: null; unmapped: true } {
          const s = VRT_SEVERITY[vulnClass.trim().toLowerCase()];
          return s ? { severity: s } : { severity: null, unmapped: true };
        }

        // ---- 提交前核对（五道门） ----

        export interface SubmitGateInput {
          scope: ScopeCard;
          target: string;
          vulnClass: string;
          /** 报告里声明的严重度（null = 没声明）。 */
          severity: string | null;
          falsification: FalsificationInput;
          seven: Record<string, SevenAnswer> | null | undefined;
          /** 报告全文（null = 没提供，卫生检查直接不过——没报告可查就不能提交）。 */
          reportText: string | null;
        }

        export interface SubmitGateCheck {
          scope: TargetCheck;
          falsification: FalsificationResult;
          seven: SevenResult;
          hygiene: HygieneResult | null;
          severity: { ok: boolean; mapped: VrtSeverity | null; reason: string };
        }

        export interface SubmitGateResult {
          decision: "allow" | "block";
          reasons: string[];
          checks: SubmitGateCheck;
        }

        /**
        * 五道门按顺序过：范围 → 证伪 → 七问 → 证据卫生 → 严重度。
        * 有一道不过就 block，并写明哪道门、为什么（不只说“不行”）。
        */
        export function evaluateSubmitGate(input: SubmitGateInput): SubmitGateResult {
          const reasons: string[] = [];
          const scope = checkTarget(input.scope, input.target);
          if (!scope.inScope) reasons.push(`范围门：${scope.reason}`);
          let falsification: FalsificationResult;
          try {
            falsification = evaluateFalsification(input.falsification);
          } catch (err: unknown) {
            falsification = { verdict: "pending", blocker: err instanceof Error ? err.message : String(err) };
          }
          if (falsification.verdict === "rejected") {
            reasons.push(`证伪门：结论是 rejected（${falsification.refutation ?? "被推翻"}），发现不成立，不许提交`);
          } else if (falsification.verdict === "pending") {
            reasons.push(`证伪门：结论是 pending（${falsification.blocker ?? "有决定性事实未解决"}），先按验证计划补上再提交`);
          }
          const seven = evaluateSevenQuestions(input.seven);
          if (!seven.passed) {
            const bad = [...seven.failed, ...seven.unanswered];
            reasons.push(`七问门：${bad.join("、")} 没过（全是 yes 才能提交，不知道也算没过）`);
          }
          let hygiene: HygieneResult | null = null;
          if (input.reportText === null) {
            reasons.push("卫生门：未提供报告文本，无法做证据卫生检查（先写报告再核对）");
          } else {
            hygiene = checkEvidenceHygiene(input.reportText);
            if (hygiene.hits.length) {
              reasons.push(`卫生门：报告里检出未脱敏内容——${hygiene.hits.map((h) => `${h.label}（第 ${h.lines.join("、")} 行）`).join("；")}`);
            }
            if (hygiene.missingSections.length) {
              reasons.push(`卫生门：报告缺必填段——${hygiene.missingSections.join("、")}`);
            }
          }
          const mapped = mapVrtSeverity(input.vulnClass);
          const declared = (input.severity ?? "").trim().toLowerCase();
          let severity: SubmitGateCheck["severity"];
          if (mapped.severity === null) {
            severity = declared
            ? { ok: true, mapped: null, reason: `类别 ${input.vulnClass} 不在映射表里，声明严重度 ${declared} 由平台最终定` }
            : { ok: false, mapped: null, reason: `类别 ${input.vulnClass} 不在映射表里，且报告没声明严重度（不要自己编档位，写“未映射、由平台定”也算声明）` };
          } else if (!declared) {
            severity = { ok: false, mapped: mapped.severity, reason: `报告没声明严重度（VRT 映射是 ${mapped.severity}）` };
          } else if (declared !== mapped.severity) {
            severity = { ok: false, mapped: mapped.severity, reason: `声明严重度 ${declared} 与 VRT 映射 ${mapped.severity} 不一致（低报严重度不许提交）` };
          } else {
            severity = { ok: true, mapped: mapped.severity, reason: `声明严重度与 VRT 映射一致（${mapped.severity}）` };
          }
          if (!severity.ok) reasons.push(`严重度门：${severity.reason}`);
          return {
            decision: reasons.length === 0 ? "allow" : "block",
            reasons,
            checks: { scope, falsification, seven, hygiene, severity },
          };
        }

        // ---- 独立审查接线（缺口 10） ----

        /**
        * 把“提交漏洞报告”当敏感动作过独立审查层。
        * 审查层未开启 → 跳过（deterministic 五道门仍是主防线，调用方须写明跳过）；
        * 审查模型不可用 / 无有效结论 → BLOCK（fail-closed，reviewToolCall 的既有语义）。
        */
        export async function reviewSubmitReport(opts: {
            config: Record<string, unknown>;
            home?: string;
            summary: string;
            scope: string;
            targetHost: string;
            severity: string;
            runner?: ReviewerLike | null;
          }): Promise<ReviewVerdict> {
          const runner = opts.runner !== undefined ? opts.runner : buildReviewerRunner(opts.config, opts.home);
          return reviewToolCall({
              config: opts.config,
              tool: "submit_bughunt_report",
              args: { action: "submit_bughunt_report", scope: opts.scope, target_host: opts.targetHost, severity: opts.severity },
              task: opts.summary,
              recentMessages: [],
              runner,
            });
        }

        // ---- 审计日志（只记元数据，不记完整 URL 与报告原文） ----

        export interface BughuntAuditEntry {
          at: string;
          action: "submit_gate";
          scope: string;
          target_host: string;
          decision: "allow" | "block";
          failing: string[];
          severity: string | null;
          falsification_verdict: FalsifyVerdict;
          reviewer_source: string;
        }

        export function appendBughuntAudit(home: string, entry: BughuntAuditEntry): void {
          mkdirSync(dirname(bughuntAuditPath(home)), { recursive: true });
          const fd = openSync(bughuntAuditPath(home), "a", 0o600);
          try {
            writeSync(fd, JSON.stringify(entry) + "\n", null, "utf-8");
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }

        // ---- 技能包安装 ----

        /** 技能装在 ~/.nyra/skills/ 里吗。 */
        export function bughuntSkillInstalled(home: string): boolean {
          return existsSync(join(home, "skills", `${BUGHUNT_SKILL_NAME}.md`));
        }

        /**
        * 安装技能包：先过 parseSkillText（frontmatter 校验），再把仓库里的正文原样
        * 写进 ~/.nyra/skills/；已装且没给 --force 时拒绝覆盖（先删旧版或 --force）。
        */
        export function installBughuntSkill(home: string, opts?: { force?: boolean }): { path: string; overwritten: boolean } {
          const skill = parseSkillText(BUGHUNT_SKILL_TEXT, "builtin:authorized-bughunt");
          if (skill.name !== BUGHUNT_SKILL_NAME) {
            throw new BughuntError(`技能包名字对不上：正文里是 ${skill.name}，期望 ${BUGHUNT_SKILL_NAME}`);
          }
          const dir = join(home, "skills");
          const path = join(dir, `${BUGHUNT_SKILL_NAME}.md`);
          const existed = existsSync(path);
          if (existed && !opts?.force) {
            throw new BughuntError(`技能 ${BUGHUNT_SKILL_NAME} 已安装在 ${path}（改动会丢，先删掉旧版或加 --force 覆盖）`);
          }
          mkdirSync(dir, { recursive: true });
          writeFileSync(path, BUGHUNT_SKILL_TEXT, { encoding: "utf-8", mode: 0o600 });
          return { path, overwritten: existed };
        }

        // ---- 发现 JSON（nyra bughunt check 的输入） ----

        export interface BughuntFinding {
          scope: string;
          target: string;
          vuln_class: string;
          severity: string | null;
          falsification: FalsificationInput;
          seven: Record<string, SevenAnswer>;
          report_text: string | null;
        }

        /** 解析发现 JSON：字段类型不对直接抛错（不静默补默认值——提交前核对不能猜）。 */
        export function parseFinding(text: string): BughuntFinding {
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch (err: unknown) {
            throw new BughuntError(`发现文件不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
          }
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new BughuntError("发现文件必须是 JSON 对象");
          }
          const r = raw as Record<string, unknown>;
          for (const key of ["scope", "target", "vuln_class"]) {
            if (typeof r[key] !== "string" || !(r[key] as string).trim()) {
              throw new BughuntError(`发现文件缺字段 ${key}（须是非空字符串）`);
            }
          }
          if (r.severity !== undefined && r.severity !== null && typeof r.severity !== "string") {
            throw new BughuntError("severity 须是字符串或 null");
          }
          const f = r.falsification as Record<string, unknown> | undefined;
          if (!f || typeof f !== "object" || Array.isArray(f) || !Array.isArray(f.attempts)) {
            throw new BughuntError("falsification.attempts 缺失（须是数组，至少做一次证伪尝试）");
          }
          for (const a of f.attempts as unknown[]) {
            if (!a || typeof a !== "object" || Array.isArray(a)) throw new BughuntError("falsification.attempts 里有非法条目");
            const at = a as Record<string, unknown>;
            if (typeof at.check !== "string" || typeof at.outcome !== "string" || typeof at.detail !== "string") {
              throw new BughuntError("证伪尝试须含 check / outcome / detail 三个字符串字段");
            }
          }
          if (f.blocker !== undefined && typeof f.blocker !== "string") throw new BughuntError("falsification.blocker 须是字符串");
          if (f.validationPlan !== undefined && typeof f.validationPlan !== "string") throw new BughuntError("falsification.validationPlan 须是字符串");
          const sevenRaw = r.seven as Record<string, unknown> | undefined;
          if (!sevenRaw || typeof sevenRaw !== "object" || Array.isArray(sevenRaw)) {
            throw new BughuntError("seven 缺失（须是对象，键为 q1..q7，值为 yes / no / unknown）");
          }
          const seven: Record<string, SevenAnswer> = {};
          for (const [k, v] of Object.entries(sevenRaw)) {
            if (v !== "yes" && v !== "no" && v !== "unknown") {
              throw new BughuntError(`seven.${k} 的值非法：${String(v)}（只认 yes / no / unknown）`);
            }
            seven[k] = v;
          }
          return {
            scope: (r.scope as string).trim(),
            target: (r.target as string).trim(),
            vuln_class: (r.vuln_class as string).trim(),
            severity: typeof r.severity === "string" ? r.severity.trim() : null,
            falsification: {
              attempts: f.attempts as FalsificationAttempt[],
              blocker: typeof f.blocker === "string" ? f.blocker : undefined,
              validationPlan: typeof f.validationPlan === "string" ? f.validationPlan : undefined,
              vulnClass: (r.vuln_class as string).trim(),
            },
            seven,
            report_text: typeof r.report_text === "string" ? r.report_text : null,
          };
        }

        // ---- 模板（与技能正文里的模板同内容；改一处时两处一起改，测试钉住了关键字段） ----

        export function scopeCardTemplate(): string {
          return JSON.stringify({
              name: "cm-com",
              platform: "Intigriti",
              targets: ["ticket.example.com"],
              forbidden: ["admin.example.com", "/admin"],
              allowed_techniques: ["手动单点测试", "低速复现"],
              forbidden_techniques: [...REQUIRED_FORBIDDEN_TECHNIQUES],
              max_requests_per_second: 2,
              account: "tester@intigriti.me",
            }, null, 2) + "\n";
        }

        export function findingTemplate(): string {
          return JSON.stringify({
              scope: "cm-com",
              target: "https://ticket.example.com/order/123",
              vuln_class: "price-tampering",
              severity: "high",
              falsification: {
                attempts: [
                  { check: "independent-reproduction", outcome: "survived", detail: "换账号重走一遍，效果复现" },
                  { check: "different-input", outcome: "survived", detail: "换一个篡改价 0，同样被接受" },
                  { check: "negative-control", outcome: "survived", detail: "正常价 99 仍返回正常总价" },
                ],
              },
              seven: { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "yes", q6: "yes", q7: "yes" },
              report_text: "报告全文（或用 --report 传文件）",
            }, null, 2) + "\n";
        }

        export function reportTemplate(): string {
          return `# <漏洞标题>

- 目标：<URL>
          - 范围卡：<范围卡名>（平台：<平台>）
          - 漏洞类别：<类别>（VRT 映射严重度：<档位>）
          - 证伪结论：confirmed（尝试：<列出每种尝试与结果>）

          ## 复现步骤

          1. <用测试账号做的第一步>
          2. <第二步>
          3. <看到的效果>

          ## 影响

          <攻击者能干什么、影响谁、为什么平台会收>

          ## 证据

          <脱敏后的请求与响应、截图说明>

          ## 脱敏记录

          <脱了什么、用什么替换的>
          `;
}
