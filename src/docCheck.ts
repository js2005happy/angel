// src/docCheck.ts — 文档与代码的一致性检查（机械可查，不靠人眼）。
//
// 起因：本会话里出现过两次文档漂移——竞品表把 5 项已完成的标成"待做"（差点重做一遍），
// CONFIG-MAP 手写追加了一节（生成器不知道）。两者都能用机械检查兜住。
//
// 检查范围（只查**能确定**的，不猜）：
//   1. 文档里出现的 `nyra <子命令>` 必须真的存在（否则是写完就忘了实现，或改过名）
//   2. 每个真实子命令至少在一处文档里出现过（否则用户不知道它存在）
//
// 不做的：配置键、参数、行为描述——那些有歧义，硬查会产出大量误报。
// 宁可少查，也不要一堆假警报把真问题埋掉。
import type { Verdict } from "./verdict.ts";

export interface DocFile {
  /** 展示名（通常是文件名）。 */
  name: string;
  text: string;
}

export interface DocFinding {
  code: "stale-command" | "undocumented-command";
  /** 命中的文档（undocumented 时为 "(none)"）。 */
  doc: string;
  /** 涉及的子命令。 */
  command: string;
  detail: string;
}

export interface DocCheckResult {
  findings: DocFinding[];
  /** 文档里出现过的子命令（去重）。 */
  mentioned: string[];
  ok: boolean;
}

/**
 * 从 Markdown 文本里抽出形如 `nyra <cmd>` / `$ nyra <cmd>` 的子命令。
 *
 * 只认 `nyra` 后面紧跟的第一个词，且该词必须是 `[a-z][a-z0-9-]*`：
 * 这样 `nyra --help`、`nyra` 裸用、`nyra <task>` 之类不会被当成子命令。
 */
export function extractNyaCommands(text: string): string[] {
  const out = new Set<string>();
  // 只认两种"真的在当命令写"的形式，避开正文里顺口提到的 `python3 -m nyra worker` 之类：
  //   1) 行首命令（允许前置 `$ ` 提示符）
  //   2) 反引号代码片段里的 `nyra x`
  const lineRe = /^[ \t]*(?:\$[ \t]+)?nyra[ \t]+([a-z][a-z0-9-]{0,30})\b/gm;
  const spanRe = /`nyra[ \t]+([a-z][a-z0-9-]{0,30})\b/g;
  for (const re of [lineRe, spanRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // `nyra --json` 这类已被正则排除（要求 a-z 开头）
      out.add(m[1]);
    }
  }
  return [...out];
}

/**
 * 对照检查。`subcommands` 是真实存在的子命令集合。
 *
 * 为了不误报，`ignore` 里可以放"文档里合法但不该存在"的词（例如 `nyra.exe` 之类的误抽结果）。
 */
export function checkDocs(
  docs: readonly DocFile[],
  subcommands: readonly string[],
  opts: { ignore?: readonly string[] } = {},
): DocCheckResult {
  const known = new Set(subcommands.map((s) => s.toLowerCase()));
  const ignore = new Set((opts.ignore ?? []).map((s) => s.toLowerCase()));
  const findings: DocFinding[] = [];
  const mentioned = new Set<string>();

  for (const doc of docs) {
    for (const cmd of extractNyaCommands(doc.text)) {
      if (ignore.has(cmd)) continue;
      mentioned.add(cmd);
      if (!known.has(cmd)) {
        findings.push({
          code: "stale-command",
          doc: doc.name,
          command: cmd,
          detail: `文档写了 \`nyra ${cmd}\`，但代码里没有这个子命令（改名了？还是只写没实现？）`,
        });
      }
    }
  }

  for (const cmd of known) {
    if (mentioned.has(cmd)) continue;
    findings.push({
      code: "undocumented-command",
      doc: "(none)",
      command: cmd,
      detail: `子命令 \`nyra ${cmd}\` 在任何文档里都没出现：用户不会知道它存在`,
    });
  }

  return { findings, mentioned: [...mentioned].sort(), ok: findings.length === 0 };
}

/** 人类可读。 */
export function formatDocCheck(result: DocCheckResult): string {
  if (result.ok) {
    return `文档一致性：通过（提到 ${result.mentioned.length} 个子命令，无过期引用、无未记录命令）`;
  }
  const lines = [`文档一致性：${result.findings.length} 处不一致`];
  for (const f of result.findings) {
    lines.push(`  ${f.code === "stale-command" ? "⚠️ " : "❓"} [${f.doc}] ${f.detail}`);
  }
  return lines.join("\n");
}

/** 把检查结果并进 verdict 的 reasons/blockers（便于 `nyra verdict` 一并显示）。 */
export function docCheckVerdict(result: DocCheckResult): Partial<Verdict> {
  if (result.ok) return { reasons: [`文档一致性：通过（${result.mentioned.length} 个子命令均有记录）`] };
  const stale = result.findings.filter((f) => f.code === "stale-command");
  return {
    reasons: [
      `文档一致性：${result.findings.length} 处不一致（过期引用 ${stale.length}、未记录 ${result.findings.length - stale.length}）`,
    ],
    nextSteps: stale.length
      ? [`先修过期引用：文档里的 \`nyra ${stale[0].command}\` 并不存在`]
      : [`补文档：\`nyra ${result.findings[0].command}\` 没有任何说明`],
  };
}
