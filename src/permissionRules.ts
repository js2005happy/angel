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

/**
 * 缺口 19：工具名归一化——规则按 Claude Code 的写法（`Bash` / `Edit` /
 * `Write` / `Read`），但 checkApproval 传进来的是 Nyra 自己的工具名
 * （`shell` / `edit_file` / `write_file` / `read_file`）。不归一化，
 * 按文档写的规则永远匹配不上、静默失效——这就是 /status 要报的"被忽略
 * 的权限设置"头号来源。归一化是双向的：规则侧与调用侧都归一，旧测试
 * （ctx.tool 直接写 "Bash"）的行为不变。
 */
export function normalizeToolName(name: string): string {
  switch (name) {
  case "Bash":
  case "sh":
  case "zsh":
  case "powershell":
    return "shell";
  case "Edit":
    return "edit_file";
  case "Write":
    return "write_file";
  case "Read":
    return "read_file";
  default:
    return name;
  }
}

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

// ---- 缺口 28：Soul invariant 编译进规则层 ----
//
// Soul 的 invariant 是“编译进来的 deny 规则”：调用方（soul.ts）把
// Tenet 的 deny 文本交给这里，拿回一个只有 deny 的 RuleSet，再用
// evaluate() 求值。纯函数、不读文件——规则文本在写入 Soul 时已校验过，
// 这里再遇到无法解析的（手改文件改坏了）就跳过并记 warning，调用方负责
// 把 warning 亮出来（soul show / soul status），不让人“写了规则以为挡
// 住了、实际没生效”。
/** 把若干条 deny 规则文本编译成只有 deny 的规则集；解析失败的进 warnings。 */
export function compileDenyRules(texts: readonly string[]): { rules: RuleSet; warnings: string[] } {
  const deny: PermissionRule[] = [];
  const warnings: string[] = [];
  for (const raw of texts) {
    const rule = parseRule(raw);
    if (rule) deny.push(rule);
    else warnings.push(`无法解析 "${raw}"`);
  }
  return { rules: { allow: [], ask: [], deny, warnings }, warnings };
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

/** 只有这些工具的目标是文件系统路径，其余（shell 命令 / URL / MCP 名）不能按路径处理。 */
const PATH_TARGET_TOOLS = new Set(["read_file", "write_file", "edit_file", "apply_patch", "list_dir", "grep_search"]);

function normalizeTarget(ctx: PermissionContext): string {
  const target = ctx.target ?? "";
  if (!target) return target;
  // **只对路径类工具做文件系统归一化**：shell 命令、URL、MCP 工具名不是路径，
  // 一旦走 resolve() 就会被当相对路径拼上 process.cwd()，于是 `Bash(rm *)` 这类
  // 规则在带 workdir 时永不命中（deny 规则静默失效——这是真实缺陷，不是配置问题）。
  if (!PATH_TARGET_TOOLS.has(normalizeToolName(ctx.tool))) return target.replace(/\\/g, "/");
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
  // 缺口 19：双向归一化（见 normalizeToolName），否则 Bash/Edit 规则永不命中。
  const ruleTool = normalizeToolName(rule.tool);
  const ctxTool = normalizeToolName(ctx.tool);
  // 裸工具名（无 specifier）命中该工具的全部调用。
  if (ruleTool !== ctxTool) {
    // MCP 通配：mcp__server__* 命中该 server 的所有工具。
    if (!rule.tool.endsWith("__*")) return false;
    const prefix = rule.tool.slice(0, -1); // "mcp__server__"
    if (!ctx.tool.startsWith(prefix)) return false;
  }
  if (rule.specifier === null) return true;

  const target = normalizeTarget(ctx);
  if (!target) return false;

  // URL 类工具：裸主机名（web_fetch(example.com)）也当域名规则处理。
  // 以前这种写法**静默不命中**——与 shell 规则那次同一个病：写了规则以为挡住了。
  if (URL_TOOLS.has(normalizeToolName(ctx.tool)) && !/[/*?]/.test(rule.specifier)) {
    const want = rule.specifier.trim().toLowerCase();
    let host = target.toLowerCase();
    try {
      host = new URL(target).hostname.toLowerCase();
    } catch { /* 不是 URL 就按原字符串比 */ }
    if (host === want || host.endsWith("." + want)) return true;
  }

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

/** 目标是一个 URL 的工具：裸主机名按域名规则匹配。 */
const URL_TOOLS = new Set(["web_fetch", "http_post", "browser_navigate"]);

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

// ---- 规则体检（lint）：找出「写了但永远不会命中」的规则 ----
// 来由：这个仓库连续踩了两次同类问题——shell 命令规则带 workdir 永不命中、
// 裸主机名规则永不命中。两次的共同点都是 **规则写了、人以为挡住了、实际不生效**。
// 既然能机械判定，就让工具去说，而不是等下一次事故。

export type RuleLintCode = "unknown-tool" | "domain-on-non-url-tool" | "empty-specifier" | "bare-host-on-path-tool";

export interface RuleLintFinding {
  code: RuleLintCode;
  /** 处在哪一组：allow / ask / deny。 */
  action: PermissionAction;
  /** 原始规则文本，便于人去改。 */
  raw: string;
  detail: string;
}

export interface RuleLintOptions {
  /** 已知工具名（含别名，如 Bash/Edit/Write/Read）；不传则跳过 unknown-tool 检查。 */
  knownTools?: readonly string[] | null;
}

/**
 * 体检一组权限规则。纯函数，只做**确定能判**的检查：
 *   - unknown-tool：工具名不在已知集合里（拼错了 → 这条规则永远不命中）
 *   - domain-on-non-url-tool：`read_file(domain:x)` 这种把域名语法用在路径工具上
 *   - bare-host-on-path-tool：`read_file(example.com)` 看起来是想写域名，但路径工具按 glob 处理
 *   - empty-specifier：`Bash()` —— 与裸工具名等价，容易被误读成"什么都不匹配"
 */
export function lintRules(rules: RuleSet, opts: RuleLintOptions = {}): RuleLintFinding[] {
  const findings: RuleLintFinding[] = [];
  const known = opts.knownTools ? new Set(opts.knownTools.map((t) => normalizeToolName(t))) : null;
  const out: { action: PermissionAction; rule: PermissionRule }[] = [
    ...rules.allow.map((rule) => ({ action: "allow" as const, rule })),
    ...rules.ask.map((rule) => ({ action: "ask" as const, rule })),
    ...rules.deny.map((rule) => ({ action: "deny" as const, rule })),
  ];
  for (const { action, rule } of out) {
    const tool = normalizeToolName(rule.tool);
    const isUrlTool = URL_TOOLS.has(tool);
    const isPathTool = PATH_TARGET_TOOLS.has(tool);

    // MCP 通配与精确名：只要带 mcp__ 前缀就当作已知（server 名无法静态校验）
    if (known && !known.has(tool) && !rule.tool.startsWith("mcp__")) {
      findings.push({
        code: "unknown-tool",
        action, raw: rule.raw,
        detail: `工具名 ${rule.tool} 不在已知工具里（拼错了？这条规则永远不会命中）`,
      });
    }
    const spec = rule.specifier;
    if (spec === null) {
      // `Bash()` 解析后 specifier 也是 null（与裸工具名等价），但写法容易被误读成"什么都不匹配"。
      if (/\(\s*\)\s*$/.test(rule.raw)) {
        findings.push({
          code: "empty-specifier",
          action, raw: rule.raw,
          detail: "括号里是空的：与裸工具名等价（命中该工具全部调用），确认这是你的意思",
        });
      }
      continue;
    }
    if (spec.trim() === "") {
      findings.push({
        code: "empty-specifier",
        action, raw: rule.raw,
        detail: "specifier 为空：与裸工具名等价（命中该工具全部调用），确认这是你的意思",
      });
      continue;
    }
    if (spec.startsWith("domain:") && !isUrlTool) {
      findings.push({
        code: "domain-on-non-url-tool",
        action, raw: rule.raw,
        detail: `domain: 语法只对 URL 类工具生效（${[...URL_TOOLS].join("/")}），这条不会命中`,
      });
      continue;
    }
    // 看起来像裸域名（含点、不含通配与斜杠），却用在路径工具上
    if (isPathTool && !/[*?/]/.test(spec) && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(spec)) {
      findings.push({
        code: "bare-host-on-path-tool",
        action, raw: rule.raw,
        detail: `${tool} 的目标是文件路径，按 glob 处理；${spec} 会被当成相对路径文件名而不是域名`,
      });
    }
  }
  return findings;
}

/** 人类可读（doctor / status 用）。 */
export function formatRuleLint(findings: readonly RuleLintFinding[]): string {
  if (!findings.length) return "权限规则体检：没有发现永不命中的规则";
  const lines = [`权限规则体检：${findings.length} 处可疑`];
  for (const f of findings) lines.push(`  ⚠️  [${f.action}] ${f.raw} —— ${f.detail}`);
  return lines.join("\n");
}
