// tests/node/test-doc-consistency.test.ts — 文档与代码的机械一致性（CI 兜住文档漂移）。
//
// 本会话里出现过两次真实漂移：
//   1. 竞品表把 5 项已完成的标成"待做"——差点重做已做过的工作
//   2. CONFIG-MAP 手写追加了一节，生成器不知道——同步测试当场抓住
//
// 这里把"命令索引必须完整且真实"变成会红的测试：
//   D1 文档里写的 `nyra <cmd>` 必须真的存在（写完忘了实现 / 改过名）
//   D2 每个真实子命令必须至少在一处文档出现（否则用户不知道它存在）
//
// 只查能确定的（命令名）。配置键、参数、行为描述有歧义，硬查会产出大量误报——
// 一堆假警报会把真问题埋掉。
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkDocs, extractNyaCommands, formatDocCheck } from "../../src/docCheck.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DOCS_DIR = join(ROOT, "docs");

/** 从 cli.ts 源码里抽出真实 subcommands 集合（单一事实源）。 */
function realSubcommands(): string[] {
  const src = readFileSync(join(ROOT, "src", "cli.ts"), "utf-8");
  const m = /const subcommands = new Set\(\[(.*?)\]\)/s.exec(src);
  if (!m) throw new Error("cli.ts 里找不到 subcommands 定义");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function allDocs(): { name: string; text: string }[] {
  return readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ name: f, text: readFileSync(join(DOCS_DIR, f), "utf-8") }));
}

test("真实子命令集合非空且包含新加的 verdict / guard", () => {
  const cmds = realSubcommands();
  expect(cmds.length).toBeGreaterThan(20);
  expect(cmds).toContain("verdict");
  expect(cmds).toContain("guard");
});

test("D1+D2 所有文档与代码完全一致（0 处不一致）", () => {
  const result = checkDocs(allDocs(), realSubcommands());
  // 失败时把可读报告塞进断言消息，CI 日志里能直接看到是哪一条
  expect(formatDocCheck(result)).toContain("通过");
  expect(result.findings).toEqual([]);
});

test("提取规则只认「当命令写」的形式，不吃正文顺口提到", () => {
  // 行首命令
  expect(extractNyaCommands("nyra verdict --json")).toContain("verdict");
  // 带提示符
  expect(extractNyaCommands("$ nyra guard --strict")).toContain("guard");
  // 反引号代码片段
  expect(extractNyaCommands("见 `nyra redlines` 一节")).toContain("redlines");
  // 正文里顺口提到的不算（曾把 python3 -m nyra worker 误判成子命令）
  expect(extractNyaCommands("入口为模块形式 python3 -m nyra worker")).not.toContain("worker");
  // 纯标志位不算
  expect(extractNyaCommands("nyra --json")).toEqual([]);
});

test("D1 会报出过期命令（写了但不存在）", () => {
  const r = checkDocs([{ name: "fake.md", text: "nyra doesnotexist --flag\n" }], ["verdict"], {});
  expect(r.findings.some((f) => f.code === "stale-command" && f.command === "doesnotexist")).toBe(true);
});

test("D2 会报出未记录命令（存在但没人写）", () => {
  const r = checkDocs([{ name: "fake.md", text: "无关内容\n" }], ["verdict", "guard"]);
  expect(r.findings.filter((f) => f.code === "undocumented-command").map((f) => f.command).sort()).toEqual(["guard", "verdict"]);
});

test("ignore 名单可排除合法但会被误抽的词", () => {
  const r = checkDocs([{ name: "fake.md", text: "nyra legacy-worker\n" }], ["verdict"], { ignore: ["legacy-worker"] });
  expect(r.findings.some((f) => f.code === "stale-command")).toBe(false);
});
