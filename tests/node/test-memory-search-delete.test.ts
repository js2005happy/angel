// tests/node/test-memory-search-delete.test.ts — 缺口 1（记忆检索）+ 缺口 2（记忆删除与控制）。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendMemory, listMemoryEntries, searchMemoryEntries, formatMemorySearchResults,
  buildMemorySection, previewMemoryDelete, deleteMemoryEntries, MemoryDeleteError,
  memoryIndexPath, syncMemoryIndex,
} from "../../src/memory.ts";
import { Agent } from "../../src/agent.ts";
import { Gateway } from "../../src/gateway.ts";
import { GatewayClient } from "../../src/gatewayClient.ts";
import { fakeProvider } from "./fake-provider.ts";
import {
  newToolContext, executeTool, type ToolContext,
} from "../../src/tools.ts";
import { EvidenceStore } from "../../src/evidence.ts";

function setupMemory(): { home: string; memoryPath: string } {
  const home = mkdtempSync(join(tmpdir(), "nyra-memsd-"));
  const memoryPath = join(home, "MEMORY.md");
  appendMemory("用户偏好用 DeepSeek 跑测试", memoryPath, home, undefined, "20261120-000000-aaaa");
  appendMemory("项目决定用 Node 重写网关", memoryPath, home, undefined, "20261120-000000-aaaa");
  appendMemory("用户喜欢吃小龙虾", memoryPath, home, undefined, "20261120-000001-bbbb");
  return { home, memoryPath };
}

test("MemorySearchDelete.test_index_sync_keeps_stable_ids", () => {
  const { home, memoryPath } = setupMemory();
  const first = listMemoryEntries(memoryPath, home);
  expect(first.length).toBe(3);
  expect(existsSync(memoryIndexPath(memoryPath))).toBe(true);
  const idsFirst = first.map((e) => e.id);
  expect(new Set(idsFirst).size).toBe(3);
  // 再同步一次：内容没变，id 不变。
  const second = syncMemoryIndex(memoryPath, "global");
  expect(second.map((e) => e.id)).toEqual(idsFirst);
  // 新追加一行：旧 id 不变，新行得新 id。
  appendMemory("新决定用 Bun 跑测试", memoryPath, home, undefined, "20261120-000002-cccc");
  const third = listMemoryEntries(memoryPath, home);
  expect(third.length).toBe(4);
  expect(third.slice(0, 3).map((e) => e.id)).toEqual(idsFirst);
  expect(third[3].source_session).toBe("20261120-000002-cccc");
  expect(third[3].created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("MemorySearchDelete.test_append_records_source_session", () => {
  const { home, memoryPath } = setupMemory();
  const entries = listMemoryEntries(memoryPath, home);
  expect(entries[0].source_session).toBe("20261120-000000-aaaa");
  expect(entries[2].source_session).toBe("20261120-000001-bbbb");
  expect(entries[0].owner).toBe("global");
  expect(entries[0].source_file).toBe(memoryPath);
});

test("MemorySearchDelete.test_search_returns_hits_with_source", () => {
  const { home, memoryPath } = setupMemory();
  const hits = searchMemoryEntries(memoryPath, "用什么模型跑测试", { home });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].entry.text).toContain("DeepSeek");
  expect(hits[0].entry.id).toMatch(/^mem_[0-9a-f]{12}$/);
  expect(hits[0].entry.source_session).toBe("20261120-000000-aaaa");
  expect(hits[0].entry.line).toBe(1);
  const text = formatMemorySearchResults(hits);
  expect(text).toContain(hits[0].entry.id);
  expect(text).toContain("20261120-000000-aaaa");
  expect(text).toContain("第 1 行");
});

test("MemorySearchDelete.test_search_session_scope_filter", () => {
  const { home, memoryPath } = setupMemory();
  const hits = searchMemoryEntries(memoryPath, "用户", { session_id: "20261120-000001-bbbb", home });
  expect(hits.length).toBe(1);
  expect(hits[0].entry.text).toContain("小龙虾");
  expect(searchMemoryEntries(memoryPath, "用户", { session_id: "不存在的会话", home })).toEqual([]);
});

test("MemorySearchDelete.test_search_wrong_owner_refused", () => {
  const { home, memoryPath } = setupMemory();
  expect(() => searchMemoryEntries(memoryPath, "用户", { owner: "bot:room1/bot1", home })).toThrow("owner 不符");
});

test("MemorySearchDelete.test_search_no_match_returns_empty", () => {
  const { home, memoryPath } = setupMemory();
  expect(searchMemoryEntries(memoryPath, "月亮背面陨石坑 zzzqqq", { home })).toEqual([]);
});

test("MemorySearchDelete.test_delete_by_id_reports_counts", () => {
  const { home, memoryPath } = setupMemory();
  const entries = listMemoryEntries(memoryPath, home);
  const target = entries[2];
  const result = deleteMemoryEntries(memoryPath, { ids: [target.id], home });
  expect(result.deleted.length).toBe(1);
  expect(result.deleted[0].id).toBe(target.id);
  expect(result.remaining).toBe(2);
  expect(result.total).toBe(3);
  expect(readFileSync(memoryPath, "utf-8")).not.toContain("小龙虾");
  expect(listMemoryEntries(memoryPath, home).length).toBe(2);
  // 再删一次：已不在，报未找到，不报错。
  const again = deleteMemoryEntries(memoryPath, { ids: [target.id], home });
  expect(again.deleted.length).toBe(0);
  expect(again.notFound).toEqual([target.id]);
  expect(again.remaining).toBe(2);
});

test("MemorySearchDelete.test_delete_by_session_removes_only_that_session", () => {
  const { home, memoryPath } = setupMemory();
  const result = deleteMemoryEntries(memoryPath, { session_id: "20261120-000000-aaaa", home });
  expect(result.deleted.length).toBe(2);
  expect(result.remaining).toBe(1);
  expect(readFileSync(memoryPath, "utf-8")).toContain("小龙虾");
  expect(readFileSync(memoryPath, "utf-8")).not.toContain("DeepSeek");
});

test("MemorySearchDelete.test_delete_wrong_owner_skips_nothing_deleted", () => {
  const { home, memoryPath } = setupMemory();
  const entries = listMemoryEntries(memoryPath, home);
  const result = deleteMemoryEntries(memoryPath, { ids: [entries[0].id], owner: "bot:room1/bot1", home });
  expect(result.deleted.length).toBe(0);
  expect(result.skipped.length).toBe(1);
  expect(result.skipped[0].reason).toContain("owner 不符");
  expect(result.remaining).toBe(3);
  expect(readFileSync(memoryPath, "utf-8")).toContain("DeepSeek");
  // 预览同样只跳过不删。
  const preview = previewMemoryDelete(memoryPath, { ids: [entries[0].id], owner: "bot:room1/bot1", home });
  expect(preview.targets.length).toBe(0);
  expect(preview.skipped.length).toBe(1);
});

test("MemorySearchDelete.test_delete_running_session_refused_atomically", () => {
  const { home, memoryPath } = setupMemory();
  expect(() =>
    deleteMemoryEntries(memoryPath, {
      session_id: "20261120-000000-aaaa",
      activeSessionIds: ["20261120-000000-aaaa"],
      home,
    }),
  ).toThrow(MemoryDeleteError);
  try {
    deleteMemoryEntries(memoryPath, { session_id: "20261120-000000-aaaa", activeSessionIds: ["20261120-000000-aaaa"], home });
    expect.unreachable();
  } catch (err) {
    expect((err as MemoryDeleteError).reason).toBe("session_running");
    expect((err as MemoryDeleteError).blockedIds.length).toBe(2);
  }
  // 一条都没删。
  expect(listMemoryEntries(memoryPath, home).length).toBe(3);
  expect(readFileSync(memoryPath, "utf-8")).toContain("DeepSeek");
});

test("MemorySearchDelete.test_delete_revision_conflict_refused", () => {
  const { home, memoryPath } = setupMemory();
  const entries = listMemoryEntries(memoryPath, home);
  const goodRevision = createHash("sha256").update(readFileSync(memoryPath)).digest("hex");
  expect(() =>
    deleteMemoryEntries(memoryPath, { ids: [entries[0].id], expectedRevision: "0".repeat(64), home }),
  ).toThrow("已被其他进程修改");
  expect(listMemoryEntries(memoryPath, home).length).toBe(3);
  const ok = deleteMemoryEntries(memoryPath, { ids: [entries[0].id], expectedRevision: goodRevision, home });
  expect(ok.deleted.length).toBe(1);
  expect(ok.remaining).toBe(2);
});

test("MemorySearchDelete.test_build_memory_section_hit_vs_fallback", () => {
  const { home, memoryPath } = setupMemory();
  const hit = buildMemorySection(memoryPath, home, "用什么模型跑测试");
  expect(hit).toContain("按需检索");
  expect(hit).toContain("DeepSeek");
  expect(hit).toContain("来源：");
  // 无命中时回落到最后 40 行（仍有记忆内容，但不标按需检索）。
  const fallback = buildMemorySection(memoryPath, home, "月亮背面陨石坑 zzzqqq");
  expect(fallback).toContain("## 长期记忆");
  expect(fallback).not.toContain("按需检索");
  expect(fallback).toContain("DeepSeek");
  // 记忆为空时什么都不加。
  const emptyHome = mkdtempSync(join(tmpdir(), "nyra-memsd-empty-"));
  expect(buildMemorySection(join(emptyHome, "MEMORY.md"), emptyHome, "测试")).toBe("");
});

// ---- 工具层 ----

function toolCtx(workdir: string, home: string, extra: Partial<ToolContext> = {}): ToolContext {
  const ctx = newToolContext({ workdir, mode: "full", interactive: false, home, ...extra });
  ctx.memoryPath = join(home, "MEMORY.md");
  return ctx;
}

test("MemorySearchDelete.test_tool_memory_search_returns_source", async () => {
  const { home, memoryPath } = setupMemory();
  const wd = mkdtempSync(join(tmpdir(), "nyra-memsd-wd-"));
  const out = await executeTool("memory_search", { query: "用什么模型跑测试" }, toolCtx(wd, home));
  expect(out).toContain("DeepSeek");
  expect(out).toContain("20261120-000000-aaaa");
  expect(out).toContain("第 1 行");
  const none = await executeTool("memory_search", { query: "月亮背面陨石坑 zzzqqq" }, toolCtx(wd, home));
  expect(none).toContain("没有找到相关记忆");
  void memoryPath;
});

test("MemorySearchDelete.test_tool_memory_delete_full_mode_writes_evidence", async () => {
  const { home } = setupMemory();
  const wd = mkdtempSync(join(tmpdir(), "nyra-memsd-wd-"));
  const sessionId = "20261120-000000-evidence";
  const evidence = new EvidenceStore(join(home, "evidence"), sessionId);
  const ctx = toolCtx(wd, home, { sessionId });
  ctx.evidence = evidence;
  const entries = listMemoryEntries(join(home, "MEMORY.md"), home);
  const out = await executeTool("memory_delete", { ids: [entries[2].id], reason: "写错了" }, ctx);
  expect(out).toContain("已删除 1 条记忆，剩余 2 条");
  expect(readFileSync(join(home, "MEMORY.md"), "utf-8")).not.toContain("小龙虾");
  const files = evidence.list();
  expect(files.length).toBe(1);
  const body = readFileSync(files[0], "utf-8");
  expect(body).toContain("memory_delete");
  expect(body).toContain("小龙虾");
  expect(body).toContain("删后剩 2 条");
  expect(body).toContain("批准");
  // memory_forget 是同义词。
  const out2 = await executeTool("memory_forget", { ids: [listMemoryEntries(join(home, "MEMORY.md"), home)[0].id] }, ctx);
  expect(out2).toContain("已删除 1 条记忆，剩余 1 条");
});

test("MemorySearchDelete.test_tool_memory_delete_auto_noninteractive_refused", async () => {
  const { home } = setupMemory();
  const wd = mkdtempSync(join(tmpdir(), "nyra-memsd-wd-"));
  const ctx = newToolContext({ workdir: wd, mode: "auto", interactive: false, home });
  ctx.memoryPath = join(home, "MEMORY.md");
  const entries = listMemoryEntries(join(home, "MEMORY.md"), home);
  const out = await executeTool("memory_delete", { ids: [entries[0].id] }, ctx);
  expect(out).toContain("错误：");
  expect(readFileSync(join(home, "MEMORY.md"), "utf-8")).toContain("DeepSeek");
});

test("MemorySearchDelete.test_tool_memory_delete_wrong_owner_skips", async () => {
  const { home } = setupMemory();
  const wd = mkdtempSync(join(tmpdir(), "nyra-memsd-wd-"));
  const ctx = toolCtx(wd, home);
  const entries = listMemoryEntries(join(home, "MEMORY.md"), home);
  const out = await executeTool("memory_forget", { ids: [entries[0].id], owner: "bot:room1/bot1" }, ctx);
  expect(out).toContain("没有可删除的记忆");
  expect(out).toContain("owner 不符");
  expect(readFileSync(join(home, "MEMORY.md"), "utf-8")).toContain("DeepSeek");
});

test("MemorySearchDelete.test_tool_memory_delete_current_session_refused", async () => {
  const { home } = setupMemory();
  const wd = mkdtempSync(join(tmpdir(), "nyra-memsd-wd-"));
  // 当前会话正在跑：它自己写的记忆拒绝删除。
  const ctx = toolCtx(wd, home, { sessionId: "20261120-000000-aaaa" });
  const out = await executeTool("memory_delete", { session_id: "20261120-000000-aaaa" }, ctx);
  expect(out).toContain("错误：");
  expect(out).toContain("正在执行任务");
  expect(listMemoryEntries(join(home, "MEMORY.md"), home).length).toBe(3);
});

// ---- 主循环提示词 ----

test("MemorySearchDelete.test_agent_prompt_injects_search_hits_with_source", () => {
  const { home } = setupMemory();
  const wd = mkdtempSync(join(tmpdir(), "nyra-memsd-wd-"));
  const agent = new Agent(fakeProvider([{ content: "完成。" }]) as never, {
    workdir: wd, home, mode: "full", skillsDirs: [],
  });
  const prompt = agent.buildSystemPrompt("用什么模型跑测试");
  expect(prompt).toContain("按需检索");
  expect(prompt).toContain("DeepSeek");
  expect(prompt).toContain("来源：");
  const fallback = agent.buildSystemPrompt("月亮背面陨石坑 zzzqqq");
  expect(fallback).toContain("## 长期记忆");
  expect(fallback).not.toContain("按需检索");
});

// ---- 网关 DELETE /api/memory ----

async function startGateway(home: string, workdir: string, delayMs = 0) {
  const gw = new Gateway({
    home, workdir, host: "127.0.0.1", port: 0, mode: "full",
    providerFactory: () => fakeProvider([
      { content: "", toolCalls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) } }] },
      { content: "已读到文件。" },
    ], { delayMs }),
    config: { mcp_enabled: false, fallback_enabled: false },
  });
  const info = await gw.start();
  return { gw, info };
}

test("MemorySearchDelete.test_gateway_delete_memory_by_ids_and_revision", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-memsd-gw-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-memsd-gw-wd-"));
  writeFileSync(join(workdir, "hello.txt"), "你好，世界\n", "utf-8");
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const headers = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    appendMemory("网关测试记忆甲", join(home, "MEMORY.md"), home);
    appendMemory("网关测试记忆乙", join(home, "MEMORY.md"), home);
    const entries = listMemoryEntries(join(home, "MEMORY.md"), home);
    expect(entries.length).toBe(2);
    // revision 错：409，一条都不删。
    const badRev = await fetch(`${base}/api/memory`, {
      method: "DELETE", headers,
      body: JSON.stringify({ scope: "global", ids: [entries[0].id], revision: "0".repeat(64) }),
    });
    expect(badRev.status).toBe(409);
    expect(listMemoryEntries(join(home, "MEMORY.md"), home).length).toBe(2);
    // 读当前 revision 再删：200，汇报删后数量。
    const view = await fetch(`${base}/api/memory?scope=global`, { headers: { "X-Nyra-Token": gw.token } });
    const { revision } = await view.json() as { revision: string };
    const ok = await fetch(`${base}/api/memory`, {
      method: "DELETE", headers,
      body: JSON.stringify({ scope: "global", ids: [entries[0].id], revision }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { deleted: number; remaining: number; deleted_ids: string[] };
    expect(body.deleted).toBe(1);
    expect(body.remaining).toBe(1);
    expect(body.deleted_ids).toEqual([entries[0].id]);
    expect(readFileSync(join(home, "MEMORY.md"), "utf-8")).not.toContain("记忆甲");
    // 删除进了证据链。
    const evidenceDir = join(home, "evidence", "memory");
    expect(existsSync(evidenceDir)).toBe(true);
    expect(readdirSync(evidenceDir).some((f) => f.includes("memory_delete"))).toBe(true);
    // 无 token：403。
    const noToken = await fetch(`${base}/api/memory`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", ids: [entries[1].id] }),
    });
    expect(noToken.status).toBe(403);
  } finally {
    await gw.stop();
  }
});

test("MemorySearchDelete.test_gateway_delete_running_session_memory_refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-memsd-gw2-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-memsd-gw2-wd-"));
  writeFileSync(join(workdir, "hello.txt"), "你好，世界\n", "utf-8");
  const { gw, info } = await startGateway(home, workdir, 1000);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const headers = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    const client = new GatewayClient({ url: base, token: gw.token });
    const { id } = await client.createSession();
    appendMemory("进行中会话写的记忆", join(home, "MEMORY.md"), home, undefined, id);
    const sent = await client.send(id, "读一下 hello.txt") as { status: string };
    expect(sent.status).toBe("running");
    // 会话正在跑：删其记忆得 409。
    const refused = await fetch(`${base}/api/memory`, {
      method: "DELETE", headers,
      body: JSON.stringify({ scope: "global", session_id: id }),
    });
    expect(refused.status).toBe(409);
    expect(readFileSync(join(home, "MEMORY.md"), "utf-8")).toContain("进行中会话写的记忆");
    // 等跑完再删：200。
    for (let i = 0; i < 50; i++) {
      const view = await fetch(`${base}/api/sessions/${id}`, { headers: { "X-Nyra-Token": gw.token } });
      const viewBody = await view.json() as { status: string };
      if (viewBody.status !== "running") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const ok = await fetch(`${base}/api/memory`, {
      method: "DELETE", headers,
      body: JSON.stringify({ scope: "global", session_id: id }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { deleted: number; remaining: number };
    expect(body.deleted).toBe(1);
    expect(body.remaining).toBe(0);
  } finally {
    await gw.stop();
  }
});

// ---- CLI 真测 ----

function runCli(args: string[], home: string): { code: number; out: string } {
  const r = spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra") },
    encoding: "utf-8", timeout: 60000,
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("MemorySearchDelete.test_cli_search_and_forget", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-memsd-cli-"));
  const nyraHome = join(home, ".nyra");
  appendMemory("用户偏好用 DeepSeek 跑测试", join(nyraHome, "MEMORY.md"), nyraHome);
  appendMemory("用户喜欢吃小龙虾", join(nyraHome, "MEMORY.md"), nyraHome);
  const search = runCli(["memory", "search", "用什么模型跑测试"], home);
  expect(search.code).toBe(0);
  expect(search.out).toContain("DeepSeek");
  expect(search.out).toContain("来源：");
  const idMatch = /\[mem_[0-9a-f]{12}\]/.exec(search.out);
  expect(idMatch).not.toBeNull();
  const forget = runCli(["memory", "forget", idMatch![0].slice(1, -1), "--yes"], home);
  expect(forget.code).toBe(0);
  expect(forget.out).toContain("已删除 1 条记忆，剩余 1 条");
  expect(readFileSync(join(nyraHome, "MEMORY.md"), "utf-8")).not.toContain("DeepSeek");
  expect(readFileSync(join(nyraHome, "MEMORY.md"), "utf-8")).toContain("小龙虾");
  const noQuery = runCli(["memory", "search"], home);
  expect(noQuery.code).toBe(2);
});
