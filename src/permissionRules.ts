// src/permissionRules.ts — P0-5：权限规则语言（学 Claude Code 的 Tool(specifier)）。
//
// 目标：把"每次弹窗问人"升级成"可持久化、可审查、可提交到仓库的规则集"——这是把
// agent 放进团队工作流的前提。语法故意照抄 Claude Code，降低迁移成本：
//
//   Bash                     所有 shell 命令
//   Bash(npm run build)      精确命令
//   Bash(git *)              通配（* 匹配任意字符）
//   Edit(src/**)             gitignore 风格路径 glob（** 跨多层）
//   Read(./.env)             具体文件
//   WebFetch(domain:example.com)
//   mcp__<server>__<tool>    MCP 工具精确寻址
//   Write                    裸工具名 = 该工具全部操作
//
// 求值顺序：**deny > ask > allow**，第一条命中的规则生效；都不命中返回 null（走默认
// 审批流程）。这条次序是安全关键：任何与 deny 冲突的 allow 都不生效。
//
// 设计约束：
//   - 纯函数，不读文件、不 spawn、不抛异常（解析失败按"无效规则"丢弃并计入 warnings）
//   - 不改变 readonly 模式的硬约束（readonly 的拒绝发生在调用方，规则不能放开它）
//   - 规则集为空时行为与之前完全一致（零规则 = 零影响）
import { relative, resolve, sep } from "node:path";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  /** 原始文本，报错时原样回显。 */
  raw: string;
  /** 工具名（大小写敏感，与工具注册名一致）。 */
  tool: string;
  /** 括号里的 specifier；裸工具名为 null。 */
  specifier: string | null;
}

export interface RuleSet {
  allow: PermissionRule[];
  ask: PermissionRule[];
  deny: PermissionRule[];
  /** 解析失败的原始行，供 CLI/doctor 提示，不参与求值。 */
  warnings: string[];
}

export interface PermissionContext {
  /** 工具名，例如 Bash / Edit / mcp__memory__search。 */
  tool: string;
  /** 判定目标：shell 命令、文件绝对路径、URL、MCP 工具名等。 */
  target?: string;
  /** 工作目录，用于把绝对路径转成相对路径再匹配 glob。 */
  workdir?: string;
}

const RULE_RE = /^\s*([A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)*\*?)\s*(?:\((.*)\))?\s*$/;

/** 解析单条规则；格式不对返回 null。 */
export function parseRule(raw: string): PermissionRule | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.startsWith("#")) return null;
  const m = RULE_RE.exec(text);
  if (!m) return null;
  const tool = m[1];
  const inner = m[2];
  const specifier = inner === undefined ? null : inner.trim();
  return { raw: text, tool, specifier: specifier === "" ? null : specifier };
}

/** 解析一组规则文本（来自 config.json 的 permissions.allow/ask/deny）。 */
export function parseRules(input: { allow?: unknown; ask?: unknown; deny?: unknown } | null | undefined): RuleSet {
  const out: RuleSet = { allow: [], ask: [], deny: [], warnings: [] };
  if (!input || typeof input !== "object") return out;
  for (const key of ["allow", "ask", "deny"] as const) {
    const list = (input as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== "string") {
        out.warnings.push(`${key}: 非字符串项已忽略`);
        continue;
      }
      const rule = parseRule(raw);
      if (!rule) {
        out.warnings.push(`${key}: 无法解析 "${raw}"`);
        continue;
      }
      out[key].push(rule);
    }
  }
  return out;
}

// 与 skills.ts 的 matchGlob 同款语义（该模块已导出，这里直接复用会形成循环依赖风险，
// 故在 permissionRules 内保留一份等价的轻量实现；两处语义由各自测试锁定）。
function segmentMatch(pat: string, str: string): boolean {
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < str.length) {
    if (pi < pat.length && (pat[pi] === "?" || pat[pi] === str[si])) {
      pi++;
      si++;
    } else if (pi < pat.length && pat[pi] === "*") {
      star = pi++;
      mark = si;
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (pi < pat.length && pat[pi] === "*") pi++;
  return pi === pat.length;
}

export function matchPathGlob(pattern: string, filePath: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/");
  const pSegs = norm(pattern).replace(/^\.\//, "").split("/").filter((s) => s.length > 0);
  const fSegs = norm(filePath).split("/").filter((s) => s.length > 0);
  const rec = (pi: number, si: number): boolean => {
    if (pi === pSegs.length) return si === fSegs.length;
    if (pSegs[pi] === "**") {
      for (let k = si; k <= fSegs.length; k++) if (rec(pi + 1, k)) return true;
      return false;
    }
    if (si >= fSegs.length) return false;
    return segmentMatch(pSegs[pi], fSegs[si]) && rec(pi + 1, si + 1);
  };
  return rec(0, 0);
}

/** 命令通配：只有 * 与 ?，`git *` 匹配 `git status`，不匹配 `gitk`。 */
function matchCommandGlob(pattern: string, command: string): boolean {
  return segmentMatch(pattern, command);
}

function normalizeTarget(ctx: PermissionContext): string {
  const target = ctx.target ?? "";
  if (!target) return target;
  if (!ctx.workdir) return target.replace(/\\/g, "/");
  const abs = resolve(target);
  const root = resolve(ctx.workdir);
  if (abs === root || abs.startsWith(root + sep)) {
    return relative(root, abs).replace(/\\/g, "/");
  }
  return abs.replace(/\\/g, "/");
}

/** 单条规则是否命中。 */
export function ruleMatches(rule: PermissionRule, ctx: PermissionContext): boolean {
  // 裸工具名（无 specifier）命中该工具的全部调用。
  if (rule.tool !== ctx.tool) {
    // MCP 通配：mcp__server__* 命中该 server 的所有工具。
    if (!rule.tool.endsWith("__*")) return false;
    const prefix = rule.tool.slice(0, -1); // "mcp__server__"
    if (!ctx.tool.startsWith(prefix)) return false;
  }
  if (rule.specifier === null) return true;

  const target = normalizeTarget(ctx);
  if (!target) return false;

  // WebFetch(domain:example.com)：域名后缀匹配。
  if (rule.specifier.startsWith("domain:")) {
    const want = rule.specifier.slice("domain:".length).trim().toLowerCase();
    let host = target.toLowerCase();
    try {
      host = new URL(target).hostname.toLowerCase();
    } catch {
      // 不是 URL 就按原字符串比
    }
    return host === want || host.endsWith("." + want);
  }

  // 路径类工具用 glob；其余（Bash 命令、MCP 工具名、URL）用普通通配。
  if (rule.specifier.includes("/") || rule.specifier.startsWith("**")) {
    return matchPathGlob(rule.specifier, target) || matchCommandGlob(rule.specifier, target);
  }
  return matchCommandGlob(rule.specifier, target) || target === rule.specifier;
}

/** 把工具名归到"命令类"——只有命令类需要做复合命令拆分。 */
const SHELL_TOOLS = new Set(["Bash", "shell", "sh", "zsh", "powershell"]);

/**
 * 拆分复合命令：`a && b`、`a || b`、`a ; b`、`a | b`、换行。
 *
 * **已知边界**：不做引号解析。`echo "a && b"` 会被误拆——这会**偏严**（把不该拦的
 * 拦下来），不会偏松。规则引擎宁可多问一次，也不能把 `git status && rm -rf /`
 * 当成一条 `git *` 放过。
 */
export function splitCompound(command: string): string[] {
  return command
    .split(/\r?\n|&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function evaluateSingle(rules: RuleSet, ctx: PermissionContext): { action: PermissionAction; rule: PermissionRule } | null {
  for (const action of ["deny", "ask", "allow"] as const) {
    for (const rule of rules[action]) {
      if (ruleMatches(rule, ctx)) return { action, rule };
    }
  }
  return null;
}

/**
 * 求值：deny > ask > allow。返回 null 表示"没规则命中，走默认审批"。
 * 这是本模块唯一的安全关键入口，改动前先看测试。
 *
 * 命令类工具的 target 会先按 `&& || ; |` 拆成多段，**逐段判定后取最严结论**：
 *   - 任一段 deny → deny
 *   - 任一段 ask  → ask
 *   - **全部段都 allow 才允许**；只要有一段没有规则命中 → null（走默认审批）
 *
 * 最后这条是防绕过的关键：`Bash(git *)` 命中 `git status`，但同一串里的
 * `rm -rf /` 不会被任何规则命中，于是整串不放行——修复"用白名单规则夹带私货"。
 */
export function evaluate(rules: RuleSet, ctx: PermissionContext): { action: PermissionAction; rule: PermissionRule } | null {
  const isShell = SHELL_TOOLS.has(ctx.tool);
  const target = ctx.target ?? "";
  if (!isShell || !target) return evaluateSingle(rules, ctx);

  const segments = splitCompound(target);
  if (segments.length <= 1) return evaluateSingle(rules, ctx);

  let sawAllow: { action: PermissionAction; rule: PermissionRule } | null = null;
  for (const segment of segments) {
    const decision = evaluateSingle(rules, { ...ctx, target: segment });
    if (!decision) {
      // 有一段没规则覆盖 → 整串不享受 allow，交回默认审批
      return null;
    }
    if (decision.action === "deny") return decision;
    if (decision.action === "ask") return decision;
    sawAllow = decision;
  }
  return sawAllow;
}

/** 规则集是否为空（用于"零规则 = 零影响"的快速路径与提示）。 */
export function isEmpty(rules: RuleSet): boolean {
  return rules.allow.length === 0 && rules.ask.length === 0 && rules.deny.length === 0;
}

/** 人类可读的规则摘要，供 doctor / CLI 展示。 */
export function describeRules(rules: RuleSet): string {
  const lines: string[] = [];
  for (const action of ["deny", "ask", "allow"] as const) {
    for (const r of rules[action]) lines.push(`${action}: ${r.raw}`);
  }
  for (const w of rules.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}
