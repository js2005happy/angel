// tests/node/test-compact-reread.test.ts — 第十四批任务 3：
// compactSessionFile 压缩后重读（与 REPL / Agent.compact() 一致）。
// 覆盖：压缩成功后追加重读标记与重读内容、压缩失败回退时不追加、
// 无记忆/规则文件时行为与原来一致、opts.reRead 显式覆盖/关闭。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactSessionFile, RE_READ_MARKER } from "../../src/compact.ts";
import { saveSession, loadSession } from "../../src/memory.ts";

function fakeProvider(summary: string | null) {
  return {
    calls: 0,
    async chat(_messages: unknown[], _tools?: unknown, _timeout?: number) {
      this.calls += 1;
      if (summary === null) throw new Error("模型挂了");
      return { choices: [{ message: { content: summary } }], usage: {} };
    },
  };
}

const MESSAGES = [
  { role: "user", content: "一" },
  { role: "assistant", content: "二" },
  { role: "user", content: "三" },
];

/** 造一个带长期记忆与项目规则的 home/workdir（与 Agent.postCompactReReadNote 同源）。 */
function setupWithMemoryAndRules() {
  const home = mkdtempSync(join(tmpdir(), "nyra-compact-reread-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-compact-reread-wd-"));
  writeFileSync(join(home, "MEMORY.md"), "- [2026-11-19] 用户是学生-锚点\n- 喜欢中文\n", "utf-8");
  writeFileSync(
    join(workdir, "AGENTS.md"),
    "第一段规则。\n\n第二段规则-锚点。\n\n第三段规则-锚点二。\n",
    "utf-8",
  );
  return { home, workdir };
}

test("CompactReReadTest.test_session_file_success_appends_re_read", async () => {
  const { home, workdir } = setupWithMemoryAndRules();
  saveSession("20261119-000000-rr1", MESSAGES, home);
  const info = await compactSessionFile("20261119-000000-rr1", fakeProvider("会话摘要"), 1, undefined, home, { workdir });
  expect(info.method).toBe("model");
  const loaded = loadSession("20261119-000000-rr1", home) ?? [];
  // 结构与 REPL 一致：摘要 → 已压缩 → 重读备注 → 保留的尾部消息。
  expect((loaded[0] as Record<string, unknown>).content).toContain("会话摘要");
  expect((loaded[1] as Record<string, unknown>).content).toBe("已压缩会话，继续。");
  const note = (loaded[2] as Record<string, unknown>).content as string;
  expect(note).toContain(RE_READ_MARKER);
  expect(note).toContain("用户是学生-锚点");
  // 规则只取 AGENTS.md 末尾段落：第一段不在，第二、三段在。
  expect(note).not.toContain("第一段规则");
  expect(note).toContain("第二段规则-锚点");
  expect(note).toContain("第三段规则-锚点二");
  expect((loaded[3] as Record<string, unknown>).content).toBe("三");
});

test("CompactReReadTest.test_session_file_fallback_never_appends_re_read", async () => {
  const { home, workdir } = setupWithMemoryAndRules();
  saveSession("20261119-000000-rr2", MESSAGES, home);
  const info = await compactSessionFile("20261119-000000-rr2", fakeProvider(null), 1, undefined, home, { workdir });
  expect(info.method).toBe("fallback");
  const loaded = loadSession("20261119-000000-rr2", home) ?? [];
  expect(JSON.stringify(loaded)).not.toContain(RE_READ_MARKER);
  expect(JSON.stringify(loaded)).not.toContain("用户是学生-锚点");
});

test("CompactReReadTest.test_session_file_without_memory_or_rules_unchanged", async () => {
  // home/workdir 里没有任何记忆与规则文件：不追加任何内容，原有行为不变。
  const home = mkdtempSync(join(tmpdir(), "nyra-compact-reread-empty-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-compact-reread-empty-wd-"));
  saveSession("20261119-000000-rr3", MESSAGES, home);
  const info = await compactSessionFile("20261119-000000-rr3", fakeProvider("会话摘要"), 1, undefined, home, { workdir });
  expect(info.method).toBe("model");
  const loaded = loadSession("20261119-000000-rr3", home) ?? [];
  expect((loaded[0] as Record<string, unknown>).content).toContain("会话摘要");
  expect(JSON.stringify(loaded)).not.toContain(RE_READ_MARKER);
  expect(loaded.length).toBe(3);
});

test("CompactReReadTest.test_session_file_explicit_re_read_overrides_auto", async () => {
  const { home, workdir } = setupWithMemoryAndRules();
  saveSession("20261119-000000-rr4", MESSAGES, home);
  const custom = `${RE_READ_MARKER}\n## 自定义重读\n- 自定义锚点`;
  const info = await compactSessionFile("20261119-000000-rr4", fakeProvider("会话摘要"), 1, undefined, home, {
    workdir,
    reRead: custom,
  });
  expect(info.method).toBe("model");
  const loaded = loadSession("20261119-000000-rr4", home) ?? [];
  expect((loaded[2] as Record<string, unknown>).content).toBe(custom);
  // 显式传入时不混入自动算出的记忆内容。
  expect(JSON.stringify(loaded)).not.toContain("用户是学生-锚点");
});

test("CompactReReadTest.test_session_file_explicit_null_disables_re_read", async () => {
  const { home, workdir } = setupWithMemoryAndRules();
  saveSession("20261119-000000-rr5", MESSAGES, home);
  const info = await compactSessionFile("20261119-000000-rr5", fakeProvider("会话摘要"), 1, undefined, home, {
    workdir,
    reRead: null,
  });
  expect(info.method).toBe("model");
  const loaded = loadSession("20261119-000000-rr5", home) ?? [];
  expect(JSON.stringify(loaded)).not.toContain(RE_READ_MARKER);
});
