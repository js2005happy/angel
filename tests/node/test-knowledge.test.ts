// tests/node/test-knowledge.test.ts — 对应 tests/test_knowledge.py（13 个唯一测试）。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_NOTE_CHARS, MIN_NOTE_CHARS, ASK_SYSTEM_PROMPT, KnowledgeError,
  tokenize, chunkText, extractPageText, KnowledgeBase,
} from "../../src/knowledge.ts";

function base(): string {
  return mkdtempSync(join(tmpdir(), "nyra-kb-"));
}

test("KnowledgeTest.test_tokenize_chinese_bigrams", () => {
  const tokens = tokenize("工业机器人技术");
  expect(tokens).toContain("工业");
  expect(tokens).toContain("机器");
  expect(tokens).toContain("工业机器人技术".slice(0, 2));
  const en = tokenize("Hello World hello");
  expect(en).toContain("hello");
  expect(en).toContain("world");
});

test("KnowledgeTest.test_chunk_text_splits_by_heading", () => {
  const text = "# 第一章\n" + "内容一。".repeat(50) + "\n\n# 第二章\n" + "内容二。".repeat(50);
  const chunks = chunkText(text, "fallback");
  expect(chunks.length).toBe(2);
  expect(chunks[0][0]).toContain("第一章");
  expect(chunks[1][0]).toContain("第二章");
  for (const [, body] of chunks) expect(body.length).toBeLessThanOrEqual(MAX_NOTE_CHARS + 500);
});

test("KnowledgeTest.test_chunk_text_fallback_title", () => {
  const chunks = chunkText("没有标题的长文本。".repeat(100), "我的笔记");
  expect(chunks.length).toBeGreaterThanOrEqual(1);
  expect(chunks[0][0]).toContain("我的笔记");
});

test("KnowledgeTest.test_extract_page_text", () => {
  const [title, body] = extractPageText("<html><head><title>测试页</title></head><body><script>var x=1;</script><p>正文内容</p></body></html>");
  expect(title).toBe("测试页");
  expect(body).toContain("正文内容");
  expect(body).not.toContain("var x=1");
});

test("KnowledgeTest.test_create_and_add_text", () => {
  const kb = new KnowledgeBase(base());
  kb.create("notes", "测试库");
  const notes = kb.addText("notes", "# 机器人\n工业机器人用于汽车制造。".repeat(5), "机器人", "manual");
  expect(notes.length).toBeGreaterThanOrEqual(1);
  expect(kb.listBases().map((b) => b.name)).toContain("notes");
});

test("KnowledgeTest.test_create_duplicate_rejected", () => {
  const kb = new KnowledgeBase(base());
  kb.create("notes");
  expect(() => kb.create("notes")).toThrow(KnowledgeError);
  expect(() => kb.create("bad name!")).toThrow(KnowledgeError);
});

test("KnowledgeTest.test_search_bm25_finds_relevant", () => {
  const kb = new KnowledgeBase(base());
  kb.create("notes");
  kb.addText("notes", "# 机器人\n工业机器人用于汽车制造焊接。".repeat(3), "机器人", "manual");
  kb.addText("notes", "# 烹饪\n番茄炒蛋需要先炒鸡蛋。".repeat(3), "烹饪", "manual");
  const results = kb.search("notes", "工业机器人汽车制造");
  expect(results.length).toBeGreaterThan(0);
  expect(results[0][0]).toBeGreaterThan(0);
  expect(results[0][1].title).toContain("机器人");
});

test("KnowledgeTest.test_search_unknown_base_rejected", () => {
  const kb = new KnowledgeBase(base());
  expect(() => kb.search("nope", "x")).toThrow(KnowledgeError);
});

test("KnowledgeTest.test_add_file_and_dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-kb-src-"));
  writeFileSync(join(dir, "a.md"), "# A\n内容 A。".repeat(10));
  writeFileSync(join(dir, "b.txt"), "内容 B。".repeat(10));
  const kb = new KnowledgeBase(base());
  kb.create("docs");
  const fromFile = kb.addFile("docs", join(dir, "a.md"));
  expect(fromFile.length).toBeGreaterThanOrEqual(1);
  const fromDir = kb.addDir("docs", dir);
  expect(fromDir.length).toBeGreaterThanOrEqual(1);
});

test("KnowledgeTest.test_ask_only_answers_from_library", async () => {
  const kb = new KnowledgeBase(base());
  kb.create("notes");
  kb.addText("notes", "# 机器人\n工业机器人用于汽车制造。".repeat(3), "机器人", "manual");
  let asked: Record<string, unknown>[] = [];
  const chatFn = async (messages: Record<string, unknown>[]) => {
    asked = messages;
    return "根据库内笔记：工业机器人用于汽车制造。";
  };
  const [answer, used] = await kb.ask("notes", "工业机器人用在哪？", chatFn);
  expect(answer).toContain("汽车制造");
  expect(used.length).toBeGreaterThan(0);
  expect(JSON.stringify(asked)).toContain(ASK_SYSTEM_PROMPT.slice(0, 20));
});

test("KnowledgeTest.test_ask_empty_library_says_unknown", async () => {
  const kb = new KnowledgeBase(base());
  kb.create("notes");
  // 库内无相关笔记时仍调模型，但上下文写明“库内没有相关笔记”，模型按
  // ASK_SYSTEM_PROMPT 应直说不知道（与 Python 版同语义）。
  let asked: Record<string, unknown>[] = [];
  const chatFn = async (messages: Record<string, unknown>[]) => {
    asked = messages;
    return "不知道，库里没有相关内容。";
  };
  const [answer, used] = await kb.ask("notes", "随便问", chatFn);
  expect(answer).toContain("不知道");
  expect(used).toEqual([]);
  expect(JSON.stringify(asked)).toContain("库内没有与该问题相关的笔记");
});

test("KnowledgeTest.test_remove_base", () => {
  const kb = new KnowledgeBase(base());
  kb.create("notes");
  kb.remove("notes");
  expect(kb.listBases().map((b) => b.name)).not.toContain("notes");
  expect(() => kb.remove("notes")).toThrow(KnowledgeError);
});

test("KnowledgeTest.test_note_size_limits", () => {
  expect(MAX_NOTE_CHARS).toBe(1500);
  expect(MIN_NOTE_CHARS).toBe(200);
});

test("KnowledgeTest.test_search_async_matches_sync_on_large_library", async () => {
  const kb = new KnowledgeBase(base());
  try {
    kb.create("notes");
    for (let i = 0; i < 150; i++) {
      kb.addText("notes", `# 笔记 ${i}\n工业机器人调试内容 ${i} 汽车制造 运维。`, `笔记 ${i}`, "manual");
    }
    const sync = kb.search("notes", "工业机器人调试", 5);
    const asyncRes = await kb.searchAsync("notes", "工业机器人调试", 5);
    expect(asyncRes.map(([, n]) => n.title)).toEqual(sync.map(([, n]) => n.title));
    expect(asyncRes.map(([s]) => s)).toEqual(sync.map(([s]) => s));
  } finally {
    await kb.closePool();
  }
  // Node CI #73：Windows 运行器上该用例 9084ms 超时（Bun 默认 5 秒），
  // 大库建索引慢，非逻辑问题，单用例放宽到 15 秒。
}, 15000);

test("KnowledgeTest.test_search_async_small_library_uses_sync_path", async () => {
  const kb = new KnowledgeBase(base());
  try {
    kb.create("notes");
    kb.addText("notes", "# 机器人\n工业机器人用于汽车制造。", "机器人", "manual");
    const sync = kb.search("notes", "工业机器人", 5);
    const asyncRes = await kb.searchAsync("notes", "工业机器人", 5);
    expect(asyncRes).toEqual(sync);
  } finally {
    await kb.closePool();
  }
});

test("KnowledgeTest.test_ask_uses_pool_on_large_library", async () => {
  const kb = new KnowledgeBase(base());
  try {
    kb.create("notes");
    for (let i = 0; i < 120; i++) {
      kb.addText("notes", `# 笔记 ${i}\n工业机器人调试内容 ${i}。`, `笔记 ${i}`, "manual");
    }
    const [answer, used] = await kb.ask("notes", "工业机器人怎么调试", async () => "按手册调试。");
    expect(answer).toContain("按手册调试");
    expect(used.length).toBeGreaterThan(0);
  } finally {
    await kb.closePool();
  }
});
