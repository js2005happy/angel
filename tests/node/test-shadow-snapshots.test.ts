// tests/node/test-shadow-snapshots.test.ts — 缺口 9：影子快照 + 文件与会话联合回滚。
// 每次批准写操作前快照（影子 Git 仓优先，Git 不可用退回文件快照并明说）；
// 恢复三种模式（both / files / session）；回滚进证据链；快照失败不拦写操作。
import { test, expect } from "bun:test";
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync,
  symlinkSync, readlinkSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ShadowSnapshotStore, buildRestoreNote } from "../../src/shadowSnapshots.ts";
import { ConversationStore } from "../../src/conversations.ts";
import { rewindToSnapshot } from "../../src/rewind.ts";
import { RunStore, RunRecorder } from "../../src/runs.ts";
import { Agent } from "../../src/agent.ts";
import { newToolContext, executeTool, type ToolContext } from "../../src/tools.ts";

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  script: Record<string, unknown>[] = [];
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(): Promise<Record<string, unknown>> {
    return { choices: [{ message: { content: "ok", tool_calls: [] } }] };
  }
}

function setup(): { home: string; workdir: string; store: ShadowSnapshotStore; conv: ConversationStore } {
  const home = mkdtempSync(join(tmpdir(), "nyra-shadow-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-shadow-wd-"));
  const store = new ShadowSnapshotStore(home, workdir);
  const conv = new ConversationStore(home);
  return { home, workdir, store, conv };
}

function seedConversation(conv: ConversationStore, sessionId: string): number {
  conv.record(sessionId, "user", "把 a.txt 改成新版");
  const assistantId = conv.record(sessionId, "assistant", "好的，我来改 a.txt");
  return assistantId!;
}

test("ShadowSnapshots.test_snapshot_captures_before_content_tool_call_and_session", () => {
  const { home, workdir, store, conv } = setup();
  writeFileSync(join(workdir, "a.txt"), "v0\n");
  const wm = seedConversation(conv, "sess-1");
  const live = [
    { role: "user", content: "把 a.txt 改成新版" },
    { role: "assistant", content: "好的，我来改 a.txt" },
  ];
  const notice = store.snapshot("write_file", join(workdir, "a.txt"), "写 a.txt", live, "sess-1", wm);
  expect(notice.backend).toBe("git");
  expect(notice.notice).toBeNull();
  const records = store.list();
  expect(records.length).toBe(1);
  const rec = records[0];
  expect(rec.tool_call.tool).toBe("write_file");
  expect(rec.tool_call.target).toBe("a.txt");
  expect(rec.files).toHaveLength(1);
  expect(rec.files[0].rel).toBe("a.txt");
  expect(rec.files[0].existed).toBe(true);
  expect(rec.store_message_id).toBe(wm);
  expect(rec.message_count).toBe(2);
  expect(rec.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(rec.session_id).toBe("sess-1");
  // 影子提交不碰用户自己的 Git 历史：工作目录里没有新建 .git。
  expect(existsSync(join(workdir, ".git"))).toBe(false);
  void home;
  conv.close();
});

test("ShadowSnapshots.test_snapshot_new_file_restore_deletes_it", () => {
  const { workdir, store, conv } = setup();
  store.snapshot("write_file", join(workdir, "new.txt"), "写 new.txt", [], "sess-1", null);
  writeFileSync(join(workdir, "new.txt"), "hello\n");
  const result = store.restore("1", "files", { triggeredBy: "test" });
  expect(existsSync(join(workdir, "new.txt"))).toBe(false);
  expect(result.files_deleted).toEqual(["new.txt"]);
  expect(result.messages_deleted).toBeNull(); // 只文件：会话未动
  expect(result.tool_call.tool).toBe("write_file");
  conv.close();
});

test("ShadowSnapshots.test_restore_both_rewinds_files_and_session", () => {
  const { workdir, store, conv } = setup();
  writeFileSync(join(workdir, "a.txt"), "v0\n");
  const wm = seedConversation(conv, "sess-1");
  const live = [{ role: "user", content: "把 a.txt 改成新版" }];
  store.snapshot("edit_file", join(workdir, "a.txt"), "改 a.txt", live, "sess-1", wm);
  writeFileSync(join(workdir, "a.txt"), "v1-bad\n");
  conv.record("sess-1", "assistant", "已改成 v1-bad");
  conv.record("sess-1", "tool", "edit_file ok");
  const evidence: Record<string, unknown>[] = [];
  const result = store.restore("1", "both", {
    conversationStore: conv, triggeredBy: "tester",
    recordEvidence: (f) => { evidence.push(f); },
  });
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("v0\n");
  expect(result.files_restored).toEqual(["a.txt"]);
  expect(result.messages_deleted).toBe(2);
  expect(result.messages_kept).toBe(2);
  expect(result.live_messages).toEqual(live);
  expect(result.tool_call).toEqual({ tool: "edit_file", target: "a.txt", summary: "改 a.txt" });
  expect(conv.history("sess-1", 100).length).toBe(2);
  // 证据链回调拿到回滚的全部要素：哪个检查点、谁触发、什么模式、恢复了什么。
  expect(evidence).toHaveLength(1);
  expect(evidence[0].snapshot_id).toBe(result.snapshot_id);
  expect(evidence[0].triggered_by).toBe("tester");
  expect(evidence[0].mode).toBe("both");
  expect(evidence[0].files).toBe("a.txt");
  expect(evidence[0].messages_deleted).toBe(2);
  expect(evidence[0].messages_kept).toBe(2);
  conv.close();
});

test("ShadowSnapshots.test_restore_files_only_leaves_session_alone", () => {
  const { workdir, store, conv } = setup();
  writeFileSync(join(workdir, "a.txt"), "v0\n");
  const wm = seedConversation(conv, "sess-1");
  store.snapshot("write_file", join(workdir, "a.txt"), "写 a.txt", [], "sess-1", wm);
  writeFileSync(join(workdir, "a.txt"), "v1-bad\n");
  conv.record("sess-1", "assistant", "已改坏");
  const result = store.restore("1", "files", { conversationStore: conv, triggeredBy: "test" });
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("v0\n");
  expect(result.live_messages).toBeNull();
  expect(result.messages_deleted).toBeNull();
  expect(conv.history("sess-1", 100).length).toBe(3);
  conv.close();
});

test("ShadowSnapshots.test_restore_session_only_leaves_files_alone", () => {
  const { workdir, store, conv } = setup();
  writeFileSync(join(workdir, "a.txt"), "v0\n");
  const wm = seedConversation(conv, "sess-1");
  store.snapshot("write_file", join(workdir, "a.txt"), "写 a.txt", [], "sess-1", wm);
  writeFileSync(join(workdir, "a.txt"), "v1-bad\n");
  conv.record("sess-1", "assistant", "已改坏");
  const result = store.restore("1", "session", { conversationStore: conv, triggeredBy: "test" });
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("v1-bad\n");
  expect(result.files_restored).toEqual([]);
  expect(result.messages_deleted).toBe(1);
  expect(result.messages_kept).toBe(2);
  conv.close();
});

test("ShadowSnapshots.test_git_unavailable_falls_back_to_file_snapshot_with_notice", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-shadow-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-shadow-wd-"));
  const store = new ShadowSnapshotStore(home, workdir, "", { gitAvailable: () => false });
  const conv = new ConversationStore(home);
  writeFileSync(join(workdir, "a.txt"), "v0\n");
  const notice = store.snapshot("write_file", join(workdir, "a.txt"), "写 a.txt", [], "sess-1", null);
  expect(notice.backend).toBe("file");
  expect(notice.notice).toContain("Git");
  const rec = store.list()[0];
  expect(rec.backend).toBe("file");
  expect(rec.commit).toBeNull();
  writeFileSync(join(workdir, "a.txt"), "v1-bad\n");
  const result = store.restore("1", "files", { triggeredBy: "test" });
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("v0\n");
  expect(result.backend).toBe("file");
  conv.close();
});

test("ShadowSnapshots.test_git_commit_failure_falls_back_to_file_snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-shadow-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-shadow-wd-"));
  const failingRunner = (args: string[], cwd: string) => {
    if (args[0] === "commit") return { status: 1, stdout: "", stderr: "fatal: mock commit failure" };
    const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 30000 });
    return { status: r.status, stdout: typeof r.stdout === "string" ? r.stdout : "", stderr: typeof r.stderr === "string" ? r.stderr : "" };
  };
  const store = new ShadowSnapshotStore(home, workdir, "", { gitRunner: failingRunner });
  const conv = new ConversationStore(home);
  writeFileSync(join(workdir, "a.txt"), "v0\n");
  const notice = store.snapshot("write_file", join(workdir, "a.txt"), "写 a.txt", [], "sess-1", null);
  expect(notice.backend).toBe("file");
  expect(notice.notice).toContain("影子 Git 仓写入失败");
  writeFileSync(join(workdir, "a.txt"), "v1-bad\n");
  expect(store.restore("1", "files", { triggeredBy: "test" }).files_restored).toEqual(["a.txt"]);
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("v0\n");
  conv.close();
});

test("ShadowSnapshots.test_corrupt_snapshot_blocks_restore_without_touching_files", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-shadow-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-shadow-wd-"));
  const store = new ShadowSnapshotStore(home, workdir, "", { gitAvailable: () => false });
  const conv = new ConversationStore(home);
  writeFileSync(join(workdir, "a.txt"), "v0\n");
  store.snapshot("write_file", join(workdir, "a.txt"), "写 a.txt", [], "sess-1", null);
  const id = store.list()[0].id;
  writeFileSync(join(workdir, "a.txt"), "v1-bad\n");
  // 毁掉文件后端的那份快照副本。
  const copyPath = join(store.fileDir, id, "files", "a.txt");
  writeFileSync(copyPath, "tampered\n");
  expect(() => store.restore("1", "files", { triggeredBy: "test" })).toThrow(/校验失败/);
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("v1-bad\n");
  conv.close();
});

test("ShadowSnapshots.test_symlink_target_blocks_restore", () => {
  const { workdir, store, conv } = setup();
  writeFileSync(join(workdir, "a.txt"), "v0\n");
  writeFileSync(join(workdir, "real.txt"), "real\n");
  store.snapshot("write_file", join(workdir, "a.txt"), "写 a.txt", [], "sess-1", null);
  // 快照后目标被换成符号链接：恢复必须拒绝，不能顺着链接写到别处。
  rmSync(join(workdir, "a.txt"));
  symlinkSync(join(workdir, "real.txt"), join(workdir, "a.txt"));
  expect(() => store.restore("1", "files", { triggeredBy: "test" })).toThrow(/符号链接/);
  expect(readFileSync(join(workdir, "real.txt"), "utf-8")).toBe("real\n");
  expect(readlinkSync(join(workdir, "a.txt"))).toBe(join(workdir, "real.txt"));
  conv.close();
});

test("ShadowSnapshots.test_resolve_by_number_and_id_newest_first", () => {
  const { workdir, store, conv } = setup();
  writeFileSync(join(workdir, "a.txt"), "v0\n");
  store.snapshot("write_file", join(workdir, "a.txt"), "第一次", [], "sess-1", null);
  writeFileSync(join(workdir, "a.txt"), "v1\n");
  store.snapshot("edit_file", join(workdir, "a.txt"), "第二次", [], "sess-1", null);
  const list = store.list();
  expect(list).toHaveLength(2);
  expect(list[0].tool_call.summary).toBe("第二次");
  expect(list[1].tool_call.summary).toBe("第一次");
  expect(store.resolve("1").id).toBe(list[0].id);
  expect(store.resolve(list[1].id).tool_call.summary).toBe("第一次");
  expect(() => store.resolve("99")).toThrow(/没有这个检查点/);
  conv.close();
});

test("ShadowSnapshots.test_rewind_to_snapshot_without_watermark_uses_time", () => {
  const { conv } = setup();
  const before = conv.record("sess-1", "user", "快照前的问题", null, Date.now() / 1000 - 60);
  void before;
  const snapUnix = Date.now() / 1000;
  // 显式给“快照后”消息一个更晚的时间戳：同毫秒内 Date.now() 可能取到同一值。
  conv.record("sess-1", "assistant", "快照后的回答", null, snapUnix + 60);
  const out = rewindToSnapshot(conv, "sess-1", null, snapUnix);
  expect(out.deleted).toBe(1);
  expect(out.kept).toBe(1);
  conv.close();
});

test("ShadowSnapshots.test_restore_audit_log_written", () => {
  const { workdir, store, conv } = setup();
  writeFileSync(join(workdir, "a.txt"), "v0\n");
  store.snapshot("write_file", join(workdir, "a.txt"), "写 a.txt", [], "sess-1", null);
  writeFileSync(join(workdir, "a.txt"), "v1\n");
  store.restore("1", "files", { triggeredBy: "cli" });
  const log = readFileSync(join(store.directory, "restores.jsonl"), "utf-8");
  const entry = JSON.parse(log.trim().split("\n").pop()!) as Record<string, unknown>;
  expect(entry.triggered_by).toBe("cli");
  expect(entry.mode).toBe("files");
  expect(entry.files_restored).toEqual(["a.txt"]);
  conv.close();
});

test("ShadowSnapshots.test_build_restore_note_mentions_reproposal", () => {
  const note = buildRestoreNote({
    snapshot_id: "20261120-000000-abcdef", session_id: "s", mode: "both", backend: "git",
    files_restored: ["a.txt"], files_deleted: [], messages_kept: 2, messages_deleted: 1,
    live_messages: [], tool_call: { tool: "write_file", target: "a.txt", summary: "写 a.txt" }, notice: null,
  });
  expect(note).toContain("20261120-000000-abcdef");
  expect(note).toContain("write_file a.txt");
  expect(note).toContain("重跑");
});

test("ShadowSnapshots.test_hook_runs_after_approval_before_write", async () => {
  const { home, workdir, store } = setup();
  writeFileSync(join(workdir, "a.txt"), "old\n");
  const order: string[] = [];
  const seenAtHook: string[] = [];
  const ctx = newToolContext({
    workdir, mode: "auto", interactive: true, home,
    approveFn: async () => { order.push("approve"); return { approved: true }; },
    shadowSnapshotHook: (tool, target) => {
      order.push("snapshot");
      seenAtHook.push(readFileSync(target, "utf-8"));
      return store.snapshot(tool, target, "写 a.txt", [], "sess-1", null);
    },
  });
  const out = await executeTool("write_file", { path: "a.txt", content: "new\n" }, ctx);
  expect(out).toContain("已写入 a.txt");
  expect(order).toEqual(["approve", "snapshot"]);
  expect(seenAtHook).toEqual(["old\n"]); // 钩子看到的仍是改前内容
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("new\n");
  expect(store.list()).toHaveLength(1);
  expect(store.list()[0].backend).toBe("git");
});

test("ShadowSnapshots.test_hook_skipped_when_approval_denied", async () => {
  const { home, workdir } = setup();
  writeFileSync(join(workdir, "a.txt"), "old\n");
  let hooked = 0;
  const ctx = newToolContext({
    workdir, mode: "auto", interactive: true, home,
    approveFn: async () => ({ approved: false, feedback: "不批" }),
    shadowSnapshotHook: () => { hooked += 1; return null; },
  });
  const out = await executeTool("write_file", { path: "a.txt", content: "new\n" }, ctx);
  expect(out.startsWith("错误：")).toBe(true);
  expect(hooked).toBe(0);
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("old\n");
});

test("ShadowSnapshots.test_hook_skipped_on_idempotent_retry", async () => {
  const { home, workdir } = setup();
  writeFileSync(join(workdir, "a.txt"), "old\n");
  let hooked = 0;
  const ctx = newToolContext({
    workdir, mode: "full", interactive: false, home, idempotentRetry: true,
    shadowSnapshotHook: () => { hooked += 1; return null; },
  });
  await executeTool("write_file", { path: "a.txt", content: "new\n" }, ctx);
  expect(hooked).toBe(0);
});

test("ShadowSnapshots.test_hook_failure_does_not_block_write", async () => {
  const { home, workdir } = setup();
  writeFileSync(join(workdir, "a.txt"), "old\n");
  const events: string[] = [];
  const ctx: ToolContext = newToolContext({
    workdir, mode: "full", interactive: false, home,
    shadowSnapshotHook: () => { throw new Error("快照炸了"); },
    onEvent: (kind) => { events.push(kind); },
  });
  const out = await executeTool("write_file", { path: "a.txt", content: "new\n" }, ctx);
  expect(out).toContain("已写入 a.txt");
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("new\n");
  expect(events).toContain("shadow_snapshot_failed");
});

test("ShadowSnapshots.test_snapshot_and_restore_events_land_in_run_evidence", () => {
  const { home, workdir } = setup();
  const runStore = new RunStore(join(home, "runs"));
  const state = runStore.create("任务", "sess-1", workdir, "auto", 5);
  runStore.appendEvent(state.run_id, "snapshot", { snapshot_id: "s1", tool: "write_file", backend: "git", files: "a.txt" });
  runStore.appendEvent(state.run_id, "restore", { snapshot_id: "s1", triggered_by: "tester", mode: "both", files: "a.txt", messages_deleted: 1, messages_kept: 2 });
  const events = runStore.readEvents(state.run_id);
  expect(events.map((e) => e.type)).toContain("snapshot");
  expect(events.map((e) => e.type)).toContain("restore");
  const restoreEv = events.find((e) => e.type === "restore")!;
  expect(restoreEv.triggered_by).toBe("tester");
  expect(restoreEv.files).toBe("a.txt");
  expect(restoreEv.messages_deleted).toBe(1);
});

test("ShadowSnapshots.test_recorder_records_snapshot_and_restore_kinds", () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider() as never, { home, workdir, sessionId: "sess-1" });
  const runStore = new RunStore(join(home, "runs"));
  const recorder = new RunRecorder(runStore, agent, "任务", {});
  recorder.call("snapshot", { snapshot_id: "s1", tool: "write_file", backend: "file", files: "a.txt" });
  recorder.call("restore", { snapshot_id: "s1", triggered_by: "tester", mode: "files", files: "a.txt" });
  const events = runStore.readEvents(recorder.runId);
  expect(events.map((e) => e.type)).toContain("snapshot");
  expect(events.map((e) => e.type)).toContain("restore");
});

test("ShadowSnapshots.test_agent_snapshot_and_restore_roundtrip", () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider() as never, { home, workdir, sessionId: "sess-1" });
  writeFileSync(join(workdir, "a.txt"), "v0\n");
  agent.messages = [
    { role: "user", content: "把 a.txt 改成新版" },
    { role: "assistant", content: "好的" },
  ];
  const notice = agent.takeShadowSnapshot("write_file", join(workdir, "a.txt"), "写 a.txt");
  expect(notice).not.toBeNull();
  expect(notice!.backend).toBe("git");
  // 改坏 + 追加对话，再联合回滚。
  writeFileSync(join(workdir, "a.txt"), "v1-bad\n");
  agent.messages.push({ role: "assistant", content: "已改成 v1-bad" });
  const result = agent.restoreShadowSnapshot("1", "both", "test");
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("v0\n");
  expect(agent.messages.length).toBe(3); // 快照时 2 条 + 1 条恢复记录
  expect(String((agent.messages[2] as Record<string, unknown>).content)).toContain("恢复记录");
  expect(result.tool_call.tool).toBe("write_file");
});

test("ShadowSnapshots.test_cli_restore_lists_empty_and_rejects_bad_id", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-shadow-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-shadow-wd-"));
  const env = { ...process.env, NYRA_HOME: home, NYRA_LANG: "zh" };
  const cliPath = join(import.meta.dir, "../../src/cli.ts");
  const list = spawnSync("bun", ["run", cliPath, "restore"], { cwd: join(import.meta.dir, "../.."), env, encoding: "utf-8", timeout: 60000 });
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("暂无影子快照");
  const bad = spawnSync("bun", ["run", cliPath, "restore", "99"], { cwd: workdir, env, encoding: "utf-8", timeout: 60000 });
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain("恢复失败");
});
