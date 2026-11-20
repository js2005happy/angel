// tests/node/test-usage-coverage.test.ts — `nyra --help` 必须覆盖每个子命令。
//
// 起因（真实缺口）：`nyra redlines` 是一条**现存命令，但帮助里没有任何一行**（中英两个
// USAGE 都没有）。用户只能靠记忆或翻文档才知道它存在——等于命令"隐形"。
//
// 同类缺口本轮一次查出 9 个：verdict / guard / savings / config / features / tools /
// recall / gmail / vault。都是"代码有、帮助没有"。
//
// 与 docCheck 的分工：
//   · docCheck  —— docs/*.md 的命令索引（面向文档维护者）
//   · usageCheck —— `nyra --help` 的覆盖（面向用户；缺了等于命令隐形）
//
// 只查"有没有一行"，不查文案好坏——文案质量机器判不了，别硬判出误报。
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkUsageCoverage, formatUsageCheck, usageMentions, checkUsageTruth, formatUsageTruth, usageCommands } from "../../src/usageCheck.ts";
import { SUBCOMMANDS } from "../../src/subcommands.ts";

const ROOT = join(import.meta.dir, "..", "..");

/** 从 cli.ts 源码里抠出模板字符串形式的 USAGE 块。 */
function grab(name: string): string {
  const src = readFileSync(join(ROOT, "src", "cli.ts"), "utf-8");
  const marker = `export const ${name} = \``;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`cli.ts 里找不到 ${name}`);
  const from = start + marker.length;
  return src.slice(from, src.indexOf("`;", from));
}

test("U1 每个子命令在中英帮助里都有一行（0 处缺失）", () => {
  const result = checkUsageCoverage(
    [{ lang: "zh", text: grab("USAGE") }, { lang: "en", text: grab("USAGE_EN") }],
    [...SUBCOMMANDS],
  );
  // 失败时把可读报告带进断言消息，CI 日志能直接看到缺哪个
  expect(formatUsageCheck(result)).toContain("通过");
  expect(result.findings).toEqual([]);
});

test("U2 匹配规则：命令后必须是空白或行尾（不许前缀误命中）", () => {
  const text = "  nyra status\n  nyra statuss --x\n";
  expect(usageMentions(text, "status")).toBe(true);
  // `statuss` 不能被当成 `status` 的入口
  expect(usageMentions("  nyra statuss\n", "status")).toBe(false);
});

test("U3 允许带参数写法：`nyra cost --show [--json]`", () => {
  expect(usageMentions("  nyra cost --show [--json]\n", "cost")).toBe(true);
  expect(usageMentions("  nyra verdict [任务] [--json]\n", "verdict")).toBe(true);
});

test("U4 连字符子命令正常匹配（mail-inbox / responsibility）", () => {
  expect(usageMentions("  nyra mail-inbox <status|enable>\n", "mail-inbox")).toBe(true);
  expect(usageMentions("  nyra mail-inboxx\n", "mail-inbox")).toBe(false);
});

test("U5 缺某种语言时会指出是哪种", () => {
  const r = checkUsageCoverage(
    [{ lang: "zh", text: "  nyra verdict\n" }, { lang: "en", text: "  nothing here\n" }],
    ["verdict"],
  );
  expect(r.ok).toBe(false);
  expect(r.findings[0].langs).toEqual(["en"]);
  expect(formatUsageCheck(r)).toContain("nyra verdict");
});

// ---- 反向：帮助里写了但代码没有（"帮助骗人"）----
// 比"命令隐形"更伤：用户照着敲，得到"未知命令"，然后开始怀疑整个工具。
//
// `interactive` 是真实存在的误报来源：en 帮助里有 `nyra       interactive mode (REPL)`
// 这行正文，抽候选命令时会被当成一个叫 interactive 的子命令。这类**正文英文词**进白名单
// 比改正则可靠——正则会越改越窄，最终漏掉真命令。
const PROSE_WORDS = ["interactive"];

test("U6 帮助里没有不存在的子命令（0 处骗人）", () => {
  const result = checkUsageTruth(
    [{ lang: "zh", text: grab("USAGE") }, { lang: "en", text: grab("USAGE_EN") }],
    [...SUBCOMMANDS],
    { ignore: PROSE_WORDS },
  );
  expect(formatUsageTruth(result)).toContain("通过");
  expect(result.findings).toEqual([]);
});

test("U7 假命令会被抓出来（帮助有、代码没有）", () => {
  const r = checkUsageTruth([{ lang: "zh", text: "  nyra ghostcmd --x\n" }], ["verdict"]);
  expect(r.ok).toBe(false);
  expect(r.findings).toEqual([{ code: "unknown-in-usage", command: "ghostcmd", lang: "zh" }]);
  expect(formatUsageTruth(r)).toContain("ghostcmd");
});

test("U8 usageCommands 抽取候选：保序去重，不误抽正文", () => {
  expect(usageCommands("nyra verdict x\nnyra guard\nyra verdict y\n")).toEqual(["verdict", "guard"]);
  // 行中不出现 `nyra ` 前缀的英文词不会被抽
  expect(usageCommands("just some text with status inside")).toEqual([]);
});

test("U9 白名单只排除指定词（不会顺带放行别的假命令）", () => {
  const r = checkUsageTruth(
    [{ lang: "en", text: "  nyra interactive mode\n  nyra ghostcmd\n" }],
    [],
    { ignore: PROSE_WORDS },
  );
  expect(r.findings.map((f) => f.command)).toEqual(["ghostcmd"]);
});