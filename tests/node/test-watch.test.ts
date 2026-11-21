// tests/node/test-watch.test.ts — 缺口 32：变化监测例程 Watch / Watch-with-action。
// 钉住的事：
//   - 配置解析（默认 + 非法回默认）与 config explain 第 12 项；
//   - 立监测校验（id、label、目标、条件、动作、download 目的地）；
//   - 账本往返（原子写 0600、损坏先备份再抛错、旧行回填）；
//   - diff 摘要（新增/删除行数与摘录上限、非文本与超长只比哈希）；
//   - 汇报固定格式“变了什么 → 详情 → 来源”；
//   - 第一次检查只记基线、没变安静、变了汇报 + 审计；
//   - 目标取不到：第一次报一次、持续缺失不重复报、恢复后报变化；
//   - 条件 any / contains 命中与不命中；
//   - 动作：report 只汇报、enqueue-task 入队且事件镜像进任务运行、
//     download 只记待批准、不加 --yes 拒绝、加 --yes 才下载、目的地逃逸拒绝；
//   - runDueWatches：未启用跳过、未到间隔跳过、force 绕过；
//   - 五事件注册进 EVENT_FIELDS、时间线能渲染；CLI 全流程。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync, mkdirSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { explainOne } from "../../src/configExplain.ts";
import { saveConfig } from "../../src/config.ts";
import { loadInbox } from "../../src/tasks.ts";
import {
  resolveWatchSettings, loadWatchStore, saveWatchStore, watchesPath, watchAuditPath,
  addWatch, removeWatch, listWatches, getWatch, setWatchEnabled,
  parseCondition, parseAction, validateDownloadDest, resolveDownloadDest,
  summarizeDiff, formatWatchReport, shortHash,
  checkWatch, checkWatches, runDueWatches, runPendingAction,
  DEFAULT_WATCH_INTERVAL_SECONDS, WatchError,
  type Watch, type WatchContent,
} from "../../src/watch.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

function runCliEn(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "en" },
  });
}

function fakeFile(content: string): WatchContent {
  return { ok: true, text: content, hash: shortHash(content), missing: false, reason: null };
}

function fakeMissing(reason = "文件不存在"): WatchContent {
  return { ok: false, text: null, hash: "missing", missing: true, reason };
}

function baseWatch(overrides: Partial<Watch> = {}): Watch {
  return {
    id: "price-page", label: "报价页", kind: "url", target: "https://example.com/price",
    intervalSeconds: 3600, enabled: true,
    condition: { kind: "any", arg: "" }, action: { kind: "report", arg: "" },
    createdAt: new Date().toISOString(), lastCheckAt: null, lastHash: null, lastStatus: null,
    pendingAction: null, ...overrides,
  };
}

test("配置解析：默认关、默认间隔 3600，非法回默认", () => {
  expect(resolveWatchSettings({})).toEqual({ enabled: false, defaultIntervalSeconds: 3600 });
  expect(resolveWatchSettings({ watch: { enabled: true, default_interval_seconds: 120 } }))
    .toEqual({ enabled: true, defaultIntervalSeconds: 120 });
  expect(resolveWatchSettings({ watch: { enabled: "yes", default_interval_seconds: 30 } }))
    .toEqual({ enabled: false, defaultIntervalSeconds: 3600 });
  expect(resolveWatchSettings({ watch: { default_interval_seconds: 99999 } }).defaultIntervalSeconds)
    .toBe(3600);
});

test("config explain 第 12 项是 watch", () => {
  const item = explainOne({ config: {} }, "watch");
  expect(item).not.toBeNull();
  expect(item!.keys).toEqual(["watch.enabled", "watch.default_interval_seconds"]);
  expect(item!.effective).toContain("关");
  const on = explainOne({ config: { watch: { enabled: true, default_interval_seconds: 600 } } }, "watch");
  expect(on!.effective).toContain("开");
  expect(on!.source).toBe("config");
});

test("立监测校验：坏 id、坏 label、坏目标、坏条件、坏动作都拒绝", () => {
  const home = tmpHome("watch-validate-");
  const bad = (patch: Record<string, unknown>) => () => addWatch(home, {
    id: "ok-id", label: "报价页", kind: "url", target: "https://example.com",
    condition: { kind: "any", arg: "" }, action: { kind: "report", arg: "" }, ...patch,
  });
  expect(bad({ id: "Bad ID" })).toThrow(WatchError);
  expect(bad({ id: "a".repeat(33) })).toThrow(WatchError);
  expect(bad({ label: "" })).toThrow(WatchError);
  expect(bad({ label: "x".repeat(101) })).toThrow(WatchError);
  expect(bad({ target: "ftp://example.com/x" })).toThrow(WatchError);
  expect(bad({ target: "" })).toThrow(WatchError);
  expect(bad({ kind: "rss" })).toThrow(WatchError);
  expect(bad({ condition: { kind: "contains", arg: "" } })).toThrow(WatchError);
  expect(bad({ action: { kind: "enqueue-task", arg: "" } })).toThrow(WatchError);
  expect(bad({ action: { kind: "download", arg: "/tmp/abs.txt" } })).toThrow(WatchError);
  expect(bad({ action: { kind: "download", arg: "../escape.txt" } })).toThrow(WatchError);
  expect(() => addWatch(home, { id: "ok-id", label: "报价页", kind: "url", target: "https://example.com" })).not.toThrow();
  expect(() => addWatch(home, { id: "ok-id", label: "重复", kind: "url", target: "https://example.com" })).toThrow(WatchError);
});

test("parseCondition 与 parseAction 各情形", () => {
expect(parseCondition("")).toEqual({ kind: "any", arg: ""});
expect(parseCondition("any")).toEqual({ kind: "any", arg: ""});
expect(parseCondition("contains:9 月发票")).toEqual({ kind: "contains", arg: "9 月发票"});
expect(() => parseCondition("contains:")).toThrow(WatchError);
expect(() => parseCondition("regex:foo")).toThrow(WatchError);
expect(parseAction("")).toEqual({ kind: "report", arg: ""});
expect(parseAction("report")).toEqual({ kind: "report", arg: ""});
expect(parseAction("enqueue-task:去下载发票")).toEqual({ kind: "enqueue-task", arg: "去下载发票"});
expect(parseAction("download:invoices/sep.pdf")).toEqual({ kind: "download", arg: "invoices/sep.pdf"});
expect(() => parseAction("download:/abs/path")).toThrow(WatchError);
expect(() => parseAction("email:foo")).toThrow(WatchError);
});

test("账本往返：原子写 0600、损坏先备份再抛错、旧行回填", () => {
const home = tmpHome("watch-ledger-");
const w = addWatch(home, { id: "a", label: "甲", kind: "file", target: "/tmp/a.txt"});
expect(w.intervalSeconds).toBe(DEFAULT_WATCH_INTERVAL_SECONDS);
expectPerms(watchesPath(home), 0o600);
const loaded = loadWatchStore(home);
expect(loaded.watches.length).toBe(1);
expect(loaded.watches[0].id).toBe("a");
// 旧行：缺 condition / action / pendingAction 时读出来补默认值。
const raw = JSON.parse(readFileSync(watchesPath(home), "utf-8")) as { watches: Record<string, unknown>[]};
delete raw.watches[0].condition;
delete raw.watches[0].action;
delete raw.watches[0].pendingAction;
writeFileSync(watchesPath(home), JSON.stringify(raw));
const refilled = loadWatchStore(home).watches[0];
expect(refilled.condition).toEqual({ kind: "any", arg: ""});
expect(refilled.action).toEqual({ kind: "report", arg: ""});
expect(refilled.pendingAction).toBeNull();
// 损坏：先备份再抛错。
writeFileSync(watchesPath(home), "{ not json");
expect(() => loadWatchStore(home)).toThrow(WatchError);
const backups = readdirSync(home).filter((f) => f.startsWith("watches.json.corrupt-"));
expect(backups.length).toBe(1);
});

test("diff 摘要：新增/删除行数与摘录上限、非文本与超长只比哈希", () => {
const d = summarizeDiff("a\nb\nc\n", "a\nb2\nc\nd\n");
expect(d.added).toBe(2);
expect(d.removed).toBe(1);
expect(d.addedLines).toEqual(["b2", "d"]);
expect(d.removedLines).toEqual(["b"]);
expect(d.note).toBeNull();
const many = summarizeDiff("", Array.from({ length: 30}, (_, i) => `line${i}`).join("\n"));
expect(many.added).toBe(30);
expect(many.addedLines.length).toBe(8);
const binary = summarizeDiff(null, "x");
expect(binary.note).toContain("非文本");
const huge = summarizeDiff("x".repeat(70000), "y".repeat(70000));
expect(huge.note).toContain("超 64KB");
});

test("汇报固定格式：变了什么 → 详情 → 来源", () => {
const report = formatWatchReport(
baseWatch(), summarizeDiff("a\nb\n", "a\nb2\n"), "aaa111", "bbb222", "2026-11-22T00:00:00.000Z",
);
const lines = report.split("\n");
expect(lines[0]).toContain("报价页");
expect(lines[1]).toMatch(/^变了什么：新增 1 行、删除 1 行（aaa111 → bbb222）$/);
expect(lines[2]).toBe("详情：");
expect(report).toContain("+ b2");
expect(report).toContain("- b");
expect(report).toContain("来源：https://example.com/price，2026-11-22T00:00:00.000Z，内容哈希 bbb222");
});

test("第一次检查只记基线、不汇报；没变安静", async () => {
const home = tmpHome("watch-baseline-");
const file = join(home, "target.txt");
writeFileSync(file, "v1\n");
const store = loadWatchStore(home);
store.watches.push(baseWatch({ kind: "file", target: file}));
saveWatchStore(home, store);
const w = store.watches[0];
const first = await checkWatch(home, w, {});
expect(first.status).toBe("baseline");
expect(loadInbox(home, true).length).toBe(0);
saveWatchStore(home, store);
const second = await checkWatch(home, w, {});
expect(second.status).toBe("unchanged");
expect(loadInbox(home, true).length).toBe(0);
});

test("文件变了：diff 摘要 + 收件箱报告 + 审计 + 快照更新", async () => {
const home = tmpHome("watch-changed-");
const file = join(home, "target.txt");
writeFileSync(file, "alpha\nbeta\n");
const store = loadWatchStore(home);
store.watches.push(baseWatch({ kind: "file", target: file, id: "f1", label: "本地文件"}));
saveWatchStore(home, store);
const w = store.watches[0];
await checkWatch(home, w, {});
saveWatchStore(home, store);
writeFileSync(file, "alpha\nbeta2\ngamma\n");
const r = await checkWatch(home, w, {});
expect(r.status).toBe("changed");
expect(r.detail).toContain("新增 2 行、删除 1 行");
saveWatchStore(home, store);
const inbox = loadInbox(home, true);
expect(inbox.length).toBe(1);
expect(String(inbox[0].summary)).toContain("本地文件");
const audit = readFileSync(watchAuditPath(home), "utf-8");
expect(audit).toContain("watch_changed");
expect(audit).toContain("added_lines");
expect(loadWatchStore(home).watches[0].lastStatus).toBe("changed");
expectPerms(join(home, "watch-snapshots", "f1.txt"), 0o600);
});

test("URL 变了：contains 条件命中才触发动作，未命中只汇报", async () => {
  const home = tmpHome("watch-cond-");
  let current = "9 月账单：无";
  const fetchText = async (): Promise<WatchContent> => fakeFile(current);
  const store = loadWatchStore(home);
  store.watches.push(baseWatch({
    id: "inv", label: "承运商门户",
    condition: { kind: "contains", arg: "9 月发票" },
    action: { kind: "enqueue-task", arg: "去下载 9 月发票" },
  }));
  saveWatchStore(home, store);
  const w = store.watches[0];
  await checkWatch(home, w, { fetchText });
  saveWatchStore(home, store);
  // 内容没变 → unchanged。
  const r2 = await checkWatch(home, w, { fetchText });
  expect(r2.status).toBe("unchanged");
  // 内容变了但不含子串 → 只汇报，不入队。
  current = "9 月账单：有 10 月发票";
  const r3 = await checkWatch(home, w, { fetchText });
  expect(r3.status).toBe("changed");
  expect(r3.actionTaken).toBeNull();
  expect(r3.detail).toContain("条件未命中");
  // 内容变了且含子串 → 入队。
  current = "9 月账单：有 9 月发票，请下载";
  const r4 = await checkWatch(home, w, { fetchText });
  expect(r4.status).toBe("changed");
  expect(r4.runId).not.toBeNull();
  expect(r4.actionTaken).toContain("enqueue-task:");
  saveWatchStore(home, store);
  const audit = readFileSync(watchAuditPath(home), "utf-8");
  expect(audit).toContain("watch_action_triggered");
  expect(audit).toContain("watch_action_done");
  // 触发与完成镜像进了入队任务的运行事件。
  const events = readFileSync(join(home, "tasks", r4.runId!, "events.jsonl"), "utf-8");
  expect(events).toContain("watch_action_triggered");
  expect(events).toContain("watch_changed");
});

test("目标取不到：第一次报一次、持续缺失不重复报、恢复后报变化", async () => {
  const home = tmpHome("watch-missing-");
  const store = loadWatchStore(home);
  store.watches.push(baseWatch({ id: "m1", label: "总缺席", kind: "file", target: join(home, "nope.txt") }));
  saveWatchStore(home, store);
  const w = store.watches[0];
  const r1 = await checkWatch(home, w, { readFile: () => fakeMissing() });
  expect(r1.status).toBe("missing");
  expect(loadInbox(home, true).length).toBe(1);
  expect(String(loadInbox(home, true)[0].summary)).toContain("取不到了");
  saveWatchStore(home, store);
  const r2 = await checkWatch(home, w, { readFile: () => fakeMissing() });
  expect(r2.status).toBe("missing");
  expect(r2.detail).toContain("不重复报");
  expect(loadInbox(home, true).length).toBe(1);
  // 目标恢复了：报变化。
  const r3 = await checkWatch(home, w, { readFile: () => fakeFile("回来了\n") });
  expect(r3.status).toBe("changed");
  expect(r3.detail).toContain("目标恢复了");
  expect(loadInbox(home, true).length).toBe(2);
});

test("download 动作：触发只记待批准，不加 --yes 拒绝，加 --yes 才下载", async () => {
  const home = tmpHome("watch-download-");
  const workdir = join(home, "work");
  mkdirSync(workdir, { recursive: true });
  let content = "发票列表：无";
  const fetchText = async (): Promise<WatchContent> => fakeFile(content);
  const store = loadWatchStore(home);
  store.watches.push(baseWatch({
    id: "dl", label: "发票门户",
    condition: { kind: "contains", arg: "9 月发票" },
    action: { kind: "download", arg: "invoices/sep.pdf.txt" },
  }));
  saveWatchStore(home, store);
  const w = store.watches[0];
  await checkWatch(home, w, { fetchText });
  saveWatchStore(home, store);
  content = "发票列表：有 9 月发票";
  const r = await checkWatch(home, w, { fetchText });
  expect(r.status).toBe("changed");
  expect(r.actionTaken).toBe("download:pending");
  expect(existsSync(join(workdir, "invoices", "sep.pdf.txt"))).toBe(false);
  saveWatchStore(home, store);
  expect(loadWatchStore(home).watches[0].pendingAction).not.toBeNull();
  // 不加 --yes 拒绝执行。
  await expect(runPendingAction(home, "dl", { providers: { fetchText }, cwd: workdir })).rejects.toThrow("加 --yes");
  expect(existsSync(join(workdir, "invoices", "sep.pdf.txt"))).toBe(false);
  // 加 --yes 执行：重新抓当前内容下载。
  const done = await runPendingAction(home, "dl", { yes: true, providers: { fetchText }, cwd: workdir });
  expect(done.dest).toBe(join(workdir, "invoices", "sep.pdf.txt"));
  expect(readFileSync(done.dest, "utf-8")).toBe("发票列表：有 9 月发票");
  expect(loadWatchStore(home).watches[0].pendingAction).toBeNull();
  const audit = readFileSync(watchAuditPath(home), "utf-8");
  expect(audit).toContain("watch_action_pending");
  expect(audit).toContain("watch_action_done");
  // 没待批准动作时再跑报错。
  await expect(runPendingAction(home, "dl", { yes: true, providers: { fetchText }, cwd: workdir })).rejects.toThrow("没有待批准");
});

test("download 目的地：绝对路径与 .. 逃逸拒绝，软链逃逸拒绝", () => {
  expect(() => validateDownloadDest("/tmp/x.txt")).toThrow(WatchError);
  expect(() => validateDownloadDest("../x.txt")).toThrow(WatchError);
  expect(() => validateDownloadDest("a//b.txt")).toThrow(WatchError);
  expect(() => validateDownloadDest("C:\\x.txt")).toThrow(WatchError);
  expect(() => validateDownloadDest("")).toThrow(WatchError);
  expect(() => resolveDownloadDest("/tmp/base", "sub/f.txt")).not.toThrow();
  const home = tmpHome("watch-dest-");
  const outside = tmpHome("watch-dest-outside-");
  mkdirSync(join(home, "linkdir"), { recursive: true });
  symlinkSync(outside, join(home, "linkdir", "escape"));
  expect(() => resolveDownloadDest(home, "linkdir/escape/f.txt")).toThrow(WatchError);
  expect(resolveDownloadDest(home, "ok/f.txt")).toBe(join(home, "ok", "f.txt"));
});

test("runDueWatches：全局未开跳过、未到间隔跳过、force 绕过", async () => {
  const home = tmpHome("watch-due-");
  saveConfig(home, { watch: { enabled: false, default_interval_seconds: 3600 } });
  const file = join(home, "t.txt");
  writeFileSync(file, "v1\n");
  addWatch(home, { id: "d1", label: "甲", kind: "file", target: file });
  const skipped = await runDueWatches(home, {});
  expect(skipped.skipped).toContain("未启用");
  expect(skipped.checked).toBe(0);
  const forced = await runDueWatches(home, { force: true });
  expect(forced.checked).toBe(1);
  expect(forced.baselined).toEqual(["d1"]);
  // 刚检查过，未到间隔 → 不扫。
  const again = await runDueWatches(home, { force: true });
  expect(again.checked).toBe(0);
});

test("checkWatches 只扫到期的监测", async () => {
  const home = tmpHome("watch-due2-");
  const file = join(home, "t.txt");
  writeFileSync(file, "v1\n");
  addWatch(home, { id: "soon", label: "快", kind: "file", target: file, intervalSeconds: 60 });
  addWatch(home, { id: "late", label: "慢", kind: "file", target: file, intervalSeconds: 86400 });
  const first = await checkWatches(home, {});
  expect(first.checked).toBe(2);
  const second = await checkWatches(home, {});
  expect(second.checked).toBe(0);
  // 把 soon 的上次检查拨回 61 秒前 → 只扫 soon。
  const store = loadWatchStore(home);
  const soon = store.watches.find((w) => w.id === "soon")!;
  soon.lastCheckAt = new Date(Date.now() - 61 * 1000).toISOString();
  saveWatchStore(home, store);
  const third = await checkWatches(home, {});
  expect(third.checked).toBe(1);
});

test("五事件已注册进 EVENT_FIELDS，时间线能渲染", () => {
  const home = tmpHome("watch-events-");
  const store = new RunStore(join(home, "tasks"));
  const state = store.create("事件注册探针", "watch-test-run", home, "readonly", 1);
  for (const type of ["watch_changed", "watch_missing", "watch_action_triggered", "watch_action_pending", "watch_action_done"]) {
    expect(() => store.appendEvent(state.run_id, type, {
      watch_id: "w1", label: "报价页", kind: "url", from_hash: "aaa111", to_hash: "bbb222",
      added_lines: 2, removed_lines: 1, reason: "文件不存在", action: "download",
      condition: "any", run_id: state.run_id, ok: true, detail: "已下载",
    })).not.toThrow();
  }
  const timeline = buildTimeline(store, state.run_id);
  const text = formatTimelineText(timeline);
  expect(text).toContain("监测「报价页」变了");
  expect(text).toContain("目标取不到了");
  expect(text).toContain("触发了动作");
  expect(text).toContain("等批准");
  expect(text).toContain("完成了");
});

test("CLI 全流程：add / list / show / check / enable / disable / config / remove", () => {
  const home = tmpHome("watch-cli-");
  const file = join(home, "t.txt");
  writeFileSync(file, "hello\n");
  let r = runCli(home, ["watch", "add", "--id", "cli1", "--label", "命令行测", "--file", file, "--every-seconds", "120"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("监测已加：cli1");
  r = runCli(home, ["watch", "list"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("cli1");
  r = runCli(home, ["watch", "show", "cli1"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("命令行测");
  r = runCli(home, ["watch", "check", "cli1"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("只记基线");
  appendFileSync(file, "world\n");
  // 手动 check <id> 不受间隔限制（显式点的动作）。
  r = runCli(home, ["watch", "check", "cli1"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("变了");
  r = runCli(home, ["watch", "disable", "cli1"]);
  expect(r.status).toBe(0);
  expect(getWatch(home, "cli1")!.enabled).toBe(false);
  r = runCli(home, ["watch", "enable", "cli1"]);
  expect(r.status).toBe(0);
  expect(getWatch(home, "cli1")!.enabled).toBe(true);
  r = runCli(home, ["watch", "config"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("未开启");
  r = runCli(home, ["watch", "config", "--auto", "on"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("已开启");
  r = runCli(home, ["watch", "remove", "cli1"]);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("--yes");
  r = runCli(home, ["watch", "remove", "cli1", "--yes"]);
  expect(r.status).toBe(0);
  expect(listWatches(home).length).toBe(0);
});

test("CLI：help 行中英文都有 watch，子命令已登记", () => {
  const home = tmpHome("watch-help-");
  const zh = runCli(home, ["--help"]);
  expect(zh.stdout).toContain("nyra watch <add|list|show|remove|check|enable|disable|config|run-action>");
  const en = runCliEn(home, ["--help"]);
  expect(en.stdout).toContain("nyra watch <add|list|show|remove|check|enable|disable|config|run-action>");
  expect(en.stdout).toContain("change-watch routine");
});
