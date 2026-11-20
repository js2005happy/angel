// src/usageCheck.ts — 帮助文本覆盖率检查（`nyra --help` 是用户的第一个接触面）。
//
// 起因：`nyra redlines` 是一条**现存命令，但帮助里没有任何一行**（中英两个 USAGE 都没有）。
// 用户只能靠记忆或翻文档才能知道它存在。这类缺口机器能查，就不该靠人发现。
//
// 与 docCheck 的分工：
//   · docCheck  —— docs/*.md 的命令索引（面向文档维护者）
//   · usageCheck —— `nyra --help` 的覆盖（面向用户；缺了等于命令"隐形"）
//
// 只查"有没有一行"，不查文案好坏——文案质量机器判不了，别硬判。

export interface UsageBlock {
  /** "zh" / "en"，报错时指明缺哪种语言。 */
  lang: string;
  text: string;
}

export interface UsageFinding {
  code: "missing-in-usage";
  command: string;
  /** 缺在哪些语言里。 */
  langs: string[];
}

export interface UsageCheckResult {
  findings: UsageFinding[];
  ok: boolean;
}

/**
 * 该语言的帮助文本里是否有 `nyra <cmd>` 这样一行。
 *
 * 允许三种写法（都是真实存在过的形式）：
 *   `nyra status`
 *   `nyra verdict [task]`
 *   `nyra cost --show [--json]`
 * 只要求命令行以该子命令**紧跟一个空白或行尾**出现，避免 `nyra statuss` 误判命中 `status`。
 */
export function usageMentions(text: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^[ \\t]*nyra[ \\t]+${escaped}(?:[ \\t]|$)`, "m").test(text);
}

/** 每个子命令必须**在每种语言的帮助里**都有一行。 */
export function checkUsageCoverage(blocks: readonly UsageBlock[], subcommands: readonly string[]): UsageCheckResult {
  const findings: UsageFinding[] = [];
  for (const cmd of subcommands) {
    const missingIn = blocks.filter((b) => !usageMentions(b.text, cmd)).map((b) => b.lang);
    if (missingIn.length) {
      findings.push({ code: "missing-in-usage", command: cmd, langs: missingIn });
    }
  }
  return { findings, ok: findings.length === 0 };
}

/** 人类可读（doctor / 测试失败信息用）。 */
export function formatUsageCheck(result: UsageCheckResult): string {
  if (result.ok) return "帮助覆盖：通过（每个子命令在中英帮助里都有一行）";
  const lines = [`帮助覆盖：${result.findings.length} 个子命令在 --help 里没有入口`];
  for (const f of result.findings) {
    lines.push(`  ❓ nyra ${f.command} —— 缺 ${f.langs.join("/")} 帮助行（用户只能靠记忆）`);
  }
  return lines.join("\n");
}

// ---- 反向检查：帮助里写了但代码里没有 ----
// usageCheck 防"命令隐形"（代码有、帮助没有）；这里防"帮助骗人"（帮助有、代码没有）。
// 后者更伤：用户照着敲，得到"未知命令"，然后开始怀疑整个工具。

/** 抽出帮助文本里所有形如 `nyra <word>` 的候选命令名（去重，按出现顺序）。 */
export function usageCommands(text: string): string[] {
  const seen: string[] = [];
  const re = /^[ \t]*nyra[ \t]+([a-z][a-z0-9-]*)(?:[ \t]|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

export interface UsageTruthFinding {
  code: "unknown-in-usage";
  command: string;
  lang: string;
}

/**
 * 帮助里提到、代码里却没有的子命令。
 *
 * `ignore` 用来排除**正文里顺口出现的英文词**（例如 `nyra       interactive mode (REPL)`
 * 会让 `interactive` 被当命令抽出来）。这类词不是命令，进白名单比改正则可靠。
 */
export function checkUsageTruth(
  blocks: readonly UsageBlock[],
  subcommands: readonly string[],
  opts: { ignore?: readonly string[] } = {},
): { findings: UsageTruthFinding[]; ok: boolean } {
  const known = new Set(subcommands);
  const ignore = new Set(opts.ignore ?? []);
  const findings: UsageTruthFinding[] = [];
  for (const block of blocks) {
    for (const cmd of usageCommands(block.text)) {
      if (known.has(cmd) || ignore.has(cmd)) continue;
      findings.push({ code: "unknown-in-usage", command: cmd, lang: block.lang });
    }
  }
  return { findings, ok: findings.length === 0 };
}

export function formatUsageTruth(result: { findings: UsageTruthFinding[]; ok: boolean }): string {
  if (result.ok) return "帮助真实性：通过（帮助里没有不存在的子命令）";
  const lines = [`帮助真实性：${result.findings.length} 处帮助写了但代码没有`];
  for (const f of result.findings) lines.push(`  ⚠️  [${f.lang}] nyra ${f.command} —— 照着敲会得到"未知命令"`);
  return lines.join("\n");
}