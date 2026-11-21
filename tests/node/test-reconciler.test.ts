// tests/node/test-reconciler.test.ts — Pi Bot 借鉴第 3 条：卡住步骤看门狗。
// 钉住的事：
//   - 配置解析（默认 + 非法回默认）与 config explain 第 11 项；
//   - 看门狗三字段（旧行回填、新行默认）与离开 working 清标记、reset 清重排计数；
//   - 阶梯：有进展不标 → 超阈值先标卡住 → 下次扫仍卡着自动重排 → 重排用完进 blocked；
//   - 重排走 fail 路径（attempts+1，满 maxAttempts 熔断进 blocked）；
//   - settled()：运行已失败走 fail 路径、运行已结束只提醒一次且不替人标完成、
//     仍在跑的走同一条卡住阶梯；
//   - 进展信号三处取最新（任务 updatedAt、运行 updated_at、子 agent 心跳）；
//   - runDueReconciliations：未启用跳过、未到扫描间隔跳过、--force 绕过间隔；
//   - 账本往返（原子写 0600、损坏先备份再抛错）、时间线渲染五事件、CLI 全流程。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { explainOne } from "../../src/configExplain.ts";
import { saveConfig } from "../../src/config.ts";
import {
  createKanbanTask, startKanbanTask, getKanbanTask, loadKanbanStore, saveKanbanStore,
  blockKanbanTask, resetKanbanTask, kanbanPath, KanbanError,
} from "../../src/kanban.ts";
import {
  resolveReconcilerSettings, loadReconcilerLedger, saveReconcilerLedger, reconcilerPath,
  scanReconciler, runDueReconciliations, settleReconcilerRun, lastProgressMs,
  DEFAULT_STUCK_AFTER_SECONDS, DEFAULT_MAX_RETRIES, DEFAULT_SCAN_INTERVAL_SECONDS,
  ReconcilerError, type ReconcilerSettings,
} from "../../src/reconciler.ts";

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

const SETTINGS: ReconcilerSettings = {
  enabled: true,
  stuckAfterSeconds: DEFAULT_STUCK_AFTER_SECONDS,
  maxRetries: DEFAULT_MAX_RETRIES,
  scanIntervalSeconds: DEFAULT_SCAN_INTERVAL_SECONDS,
};

/** fake 时钟：任务在 t0 建好，扫描时把 now 拨到 t0 + offset 秒。 */
function t0(): Date {
  return new Date();
}

function at(base: Date, seconds: number): Date {
  return new Date(base.getTime() + seconds * 1000);
}

/** 无运行绑定的 working 任务（进展信号只剩任务 updatedAt）。 */
function stuckTask(home: string, title = "卡住的活"): { id: string; created: Date } {
  const task = createKanbanTask(home, { title });
  startKanbanTask(home, task.id);
  return { id: task.id, created: new Date(getKanbanTask(home, task.id).updatedAt) };
}

/** 把任务的 updatedAt 拨回指定时间（模拟“一直没动静”）。 */
function setUpdatedAt(home: string, id: string, iso: string): void {
  const store = loadKanbanStore(home);
  const row = store.tasks.find((t) => t.id === id)!;
  row.updatedAt = iso;
  saveKanbanStore(home, store);
}

/** 把任务绑到一个运行上（模拟 tick 派发后挂上的运行；进展信号要问运行与
 * 心跳时，lastProgressMs 只在有 runId 时才问，所以这类测试先绑 runId）。 */
function bindRunId(home: string, id: string, runId: string): void {
  const store = loadKanbanStore(home);
  store.tasks.find((t) => t.id === id)!.runId = runId;
  saveKanbanStore(home, store);
}

const NO_RUN = {
  runStatus: () => null,
  runProgressAt: () => null,
  subagentHeartbeatAt: () => null,
};

test("ReconcilerTest.test_settings_defaults_and_invalid_fallback", () => {
  const d = resolveReconcilerSettings({});
  expect(d).toEqual({ enabled: false, stuckAfterSeconds: 1800, maxRetries: 2, scanIntervalSeconds: 300 });
  const ok = resolveReconcilerSettings({ reconciler: { enabled: true, stuck_after_seconds: 60, max_retries: 0, scan_interval_seconds: 3600 } });
  expect(ok).toEqual({ enabled: true, stuckAfterSeconds: 60, maxRetries: 0, scanIntervalSeconds: 3600 });
  const bad = resolveReconcilerSettings({ reconciler: { enabled: "yes", stuck_after_seconds: 10, max_retries: 9, scan_interval_seconds: 5 } });
  expect(bad).toEqual({ enabled: false, stuckAfterSeconds: 1800, maxRetries: 2, scanIntervalSeconds: 300 });
  const partial = resolveReconcilerSettings({ reconciler: { max_retries: 5 } });
  expect(partial.stuckAfterSeconds).toBe(1800);
  expect(partial.maxRetries).toBe(5);
  expect(explainOne({ config: {} }, "reconciler")!.effective).toContain("关");
  expect(explainOne({ config: { reconciler: { enabled: true } } }, "reconciler")!.effective).toContain("开");
});

test("ReconcilerTest.test_kanban_watchdog_fields_backfill_and_defaults", () => {
  const home = tmpHome("nyra-reconciler-");
  const task = createKanbanTask(home, { title: "新任务" });
  expect(task.stuckAt).toBeNull();
  expect(task.stuckFlags).toBe(0);
  expect(task.watchdogRetries).toBe(0);
  // 旧行：手写一份没有三字段的账本，读出来补默认值。
  const store = JSON.parse(readFileSync(kanbanPath(home), "utf-8")) as Record<string, unknown>;
  const tasks = store.tasks as Record<string, unknown>[];
  delete tasks[0].stuckAt;
  delete tasks[0].stuckFlags;
  delete tasks[0].watchdogRetries;
  writeFileSync(kanbanPath(home), JSON.stringify(store));
  const loaded = loadKanbanStore(home).tasks[0];
  expect(loaded.stuckAt).toBeNull();
  expect(loaded.stuckFlags).toBe(0);
  expect(loaded.watchdogRetries).toBe(0);
});

test("ReconcilerTest.test_scan_empty_board", () => {
  const home = tmpHome("nyra-reconciler-");
  const report = scanReconciler(home, { settings: SETTINGS, providers: { now: t0(), ...NO_RUN } });
  expect(report.scanned).toBe(0);
  expect(report.skipped).toBeNull();
  expect(loadReconcilerLedger(home).lastScanAt).not.toBeNull();
});

test("ReconcilerTest.test_progress_within_threshold_not_flagged", () => {
  const home = tmpHome("nyra-reconciler-");
  const { id, created } = stuckTask(home);
  const report = scanReconciler(home, { settings: SETTINGS, providers: { now: at(created, 100), ...NO_RUN } });
  expect(report.flagged).toEqual([]);
  expect(getKanbanTask(home, id).stuckAt).toBeNull();
});

test("ReconcilerTest.test_flag_then_retry_then_block_ladder", () => {
  const home = tmpHome("nyra-reconciler-");
  const { id, created } = stuckTask(home);
  const base = created;
  // 第 1 次扫：超阈值，先标卡住（任务仍在 working，收件箱留一条提醒）。
  let report = scanReconciler(home, { settings: SETTINGS, providers: { now: at(base, 2000), ...NO_RUN } });
  expect(report.flagged).toEqual([id]);
  let task = getKanbanTask(home, id);
  expect(task.status).toBe("working");
  expect(task.stuckAt).not.toBeNull();
  expect(task.stuckFlags).toBe(1);
  const inbox = readFileSync(join(home, "inbox.jsonl"), "utf-8");
  expect(inbox).toContain("reconciler_stuck");
  // 第 2 次扫（仍卡着）：自动重排回队列，attempts+1、重排计数 1。
  report = scanReconciler(home, { settings: SETTINGS, providers: { now: at(base, 2000), ...NO_RUN } });
  expect(report.retried).toEqual([id]);
  task = getKanbanTask(home, id);
  expect(task.status).toBe("queued");
  expect(task.attempts).toBe(1);
  expect(task.watchdogRetries).toBe(1);
  expect(task.stuckAt).toBeNull();
  // 再派发、再卡住：标卡住（第 2 次）→ 再重排（第 2 次）。
  startKanbanTask(home, id);
  setUpdatedAt(home, id, base.toISOString());
  report = scanReconciler(home, { settings: SETTINGS, providers: { now: at(base, 2000), ...NO_RUN } });
  expect(report.flagged).toEqual([id]);
  expect(getKanbanTask(home, id).stuckFlags).toBe(2);
  report = scanReconciler(home, { settings: SETTINGS, providers: { now: at(base, 2000), ...NO_RUN } });
  expect(report.retried).toEqual([id]);
  task = getKanbanTask(home, id);
  expect(task.watchdogRetries).toBe(2);
  expect(task.attempts).toBe(2);
  // 再派发、再卡住：标卡住（第 3 次）→ 重排已用完，进 blocked 只等人。
  startKanbanTask(home, id);
  setUpdatedAt(home, id, base.toISOString());
  report = scanReconciler(home, { settings: SETTINGS, providers: { now: at(base, 2000), ...NO_RUN } });
  expect(report.flagged).toEqual([id]);
  report = scanReconciler(home, { settings: SETTINGS, providers: { now: at(base, 2000), ...NO_RUN } });
  expect(report.blocked).toEqual([id]);
  task = getKanbanTask(home, id);
  expect(task.status).toBe("blocked");
  expect(task.watchdogRetries).toBe(2);
  // blocked 只能人 reset；reset 清重排预算、不清累计标卡住次数。
  const reset = resetKanbanTask(home, id);
  expect(reset.status).toBe("queued");
  expect(reset.watchdogRetries).toBe(0);
  expect(reset.stuckFlags).toBe(3);
});

test("ReconcilerTest.test_retry_fuses_to_blocked_on_kanban_max_attempts", () => {
  const home = tmpHome("nyra-reconciler-");
  const task = createKanbanTask(home, { title: "只许失败一次", maxAttempts: 1 });
  startKanbanTask(home, task.id);
  const created = new Date(getKanbanTask(home, task.id).updatedAt);
  let report = scanReconciler(home, { settings: SETTINGS, providers: { now: at(created, 2000), ...NO_RUN } });
  expect(report.flagged).toEqual([task.id]);
  // 重排走 fail 路径：attempts 1/1 已满，直接熔断进 blocked（不是 queued）。
  report = scanReconciler(home, { settings: SETTINGS, providers: { now: at(created, 2000), ...NO_RUN } });
  expect(report.blocked).toEqual([task.id]);
  expect(report.retried).toEqual([]);
  expect(getKanbanTask(home, task.id).status).toBe("blocked");
});

test("ReconcilerTest.test_max_retries_zero_blocks_after_flag", () => {
  const home = tmpHome("nyra-reconciler-");
  const { id, created } = stuckTask(home);
  const zero: ReconcilerSettings = { ...SETTINGS, maxRetries: 0 };
  let report = scanReconciler(home, { settings: zero, providers: { now: at(created, 2000), ...NO_RUN } });
  expect(report.flagged).toEqual([id]);
  report = scanReconciler(home, { settings: zero, providers: { now: at(created, 2000), ...NO_RUN } });
  expect(report.blocked).toEqual([id]);
  expect(getKanbanTask(home, id).status).toBe("blocked");
});

test("ReconcilerTest.test_progress_recovered_clears_flag", () => {
  const home = tmpHome("nyra-reconciler-");
  const { id, created } = stuckTask(home);
  // 先标卡住，再让运行有进展（runProgressAt 比阈值新）→ 清标记。
  let report = scanReconciler(home, { settings: SETTINGS, providers: { now: at(created, 2000), ...NO_RUN } });
  expect(report.flagged).toEqual([id]);
  bindRunId(home, id, "run-rec-1");
  report = scanReconciler(home, {
    settings: SETTINGS,
    providers: {
      now: at(created, 2100),
      runStatus: () => "running",
      runProgressAt: () => at(created, 2050).toISOString(),
      subagentHeartbeatAt: () => null,
    },
  });
  expect(report.recovered).toEqual([id]);
  const task = getKanbanTask(home, id);
  expect(task.stuckAt).toBeNull();
  expect(task.stuckFlags).toBe(1);
});

test("ReconcilerTest.test_awaiting_approval_is_not_stuck", () => {
  const home = tmpHome("nyra-reconciler-");
  const { id, created } = stuckTask(home);
  bindRunId(home, id, "run-wait-1");
  const { found, result } = settleReconcilerRun(home, "run-wait-1", {
    settings: SETTINGS,
    providers: { now: at(created, 2000), runStatus: () => "awaiting_approval", runProgressAt: () => null, subagentHeartbeatAt: () => null },
  });
  expect(found).toBe(true);
  expect(result!.action).toBe("ok");
  expect(getKanbanTask(home, id).stuckAt).toBeNull();
  expect(getKanbanTask(home, id).status).toBe("working");
});

test("ReconcilerTest.test_last_progress_takes_newest_of_three_signals", () => {
  const home = tmpHome("nyra-reconciler-");
  const { id, created } = stuckTask(home);
  bindRunId(home, id, "run-prog-1");
  const task = getKanbanTask(home, id);
  // 任务 updatedAt 是 t0；运行 updated_at 是 t0+1900（比阈值新）→ 不算卡住。
  const ms = lastProgressMs(task, {
    runProgressAt: () => at(created, 1900).toISOString(),
    subagentHeartbeatAt: () => null,
  });
  expect(ms).toBe(Date.parse(at(created, 1900).toISOString()));
  const report = scanReconciler(home, {
    settings: SETTINGS,
    providers: {
      now: at(created, 2000),
      runStatus: () => "running",
      runProgressAt: () => at(created, 1900).toISOString(),
      subagentHeartbeatAt: () => null,
    },
  });
  expect(report.flagged).toEqual([]);
  // 子 agent 心跳是 t0+100（比任务 updatedAt 新）→ 取心跳时间；但离阈值还远。
  const ms2 = lastProgressMs(task, {
    runProgressAt: () => null,
    subagentHeartbeatAt: () => at(created, 100).toISOString(),
  });
  expect(ms2).toBe(Date.parse(at(created, 100).toISOString()));
});

test("ReconcilerTest.test_settle_failed_run_takes_fail_path", () => {
  const home = tmpHome("nyra-reconciler-");
  const task = createKanbanTask(home, { title: "绑了失败运行" });
  startKanbanTask(home, task.id, "run-failed-1");
  const { found, result } = settleReconcilerRun(home, "run-failed-1", {
    settings: SETTINGS,
    providers: { now: t0(), runStatus: () => "failed", runProgressAt: () => null, subagentHeartbeatAt: () => null },
  });
  expect(found).toBe(true);
  expect(result!.action).toBe("failed");
  const after = getKanbanTask(home, task.id);
  expect(after.status).toBe("queued");
  expect(after.attempts).toBe(1);
  expect(settleReconcilerRun(home, "run-nobody", { settings: SETTINGS }).found).toBe(false);
});

test("ReconcilerTest.test_settle_done_run_notes_once_and_does_not_complete", () => {
  const home = tmpHome("nyra-reconciler-");
  const store = new RunStore(join(home, "tasks"));
  // 注意：RUN_STATUSES 里没有 "completed"，完成是 verified / completed_unverified。
  const state = store.create("做完了的活", "sess-1", home, "auto", 20, "verified");
  const task = createKanbanTask(home, { title: "运行完了、任务还在跑" });
  startKanbanTask(home, task.id, state.run_id);
  const providers = { now: t0(), runStatus: () => "verified", runProgressAt: () => null, subagentHeartbeatAt: () => null };
  const first = settleReconcilerRun(home, state.run_id, { settings: SETTINGS, providers });
  expect(first.found).toBe(true);
  expect(first.result!.action).toBe("run_done");
  // 任务仍在 working：看门狗不替人标完成（完成须附验证证据）。
  expect(getKanbanTask(home, task.id).status).toBe("working");
  // 第二次 settle：已提醒过，不重复刷事件。
  const second = settleReconcilerRun(home, state.run_id, { settings: SETTINGS, providers });
  expect(second.result!.action).toBe("ok");
  const events = store.readEvents(state.run_id);
  expect(events.filter((e) => e.type === "reconciler_run_done")).toHaveLength(1);
});

test("ReconcilerTest.test_settle_running_stuck_task_flags_it", () => {
  const home = tmpHome("nyra-reconciler-");
  const { id, created } = stuckTask(home);
  // 先把任务绑到一个运行上（直接改账本的 runId，模拟 tick 派发后挂上的运行）。
  bindRunId(home, id, "run-stuck-1");
  const { found, result } = settleReconcilerRun(home, "run-stuck-1", {
    settings: SETTINGS,
    providers: { now: at(created, 2000), runStatus: () => "running", runProgressAt: () => null, subagentHeartbeatAt: () => null },
  });
  expect(found).toBe(true);
  expect(result!.action).toBe("flagged");
  expect(getKanbanTask(home, id).stuckAt).not.toBeNull();
});

test("ReconcilerTest.test_default_providers_read_real_run_store", () => {
  const home = tmpHome("nyra-reconciler-");
  const store = new RunStore(join(home, "tasks"));
  const state = store.create("真运行", "sess-2", home, "auto", 20, "running");
  const task = createKanbanTask(home, { title: "绑了真运行" });
  startKanbanTask(home, task.id, state.run_id);
  const created = new Date(state.created_at);
  // 运行刚建好（updated_at 是创建时间），100 秒后扫：不算卡住。
  let report = scanReconciler(home, { settings: SETTINGS, providers: { now: at(created, 100) } });
  expect(report.flagged).toEqual([]);
  // 2000 秒后扫：运行也没动静，标卡住（默认 provider 读到运行的 updated_at）。
  report = scanReconciler(home, { settings: SETTINGS, providers: { now: at(created, 2000) } });
  expect(report.flagged).toEqual([task.id]);
});

test("ReconcilerTest.test_run_due_skips_when_disabled_or_within_interval", () => {
  const home = tmpHome("nyra-reconciler-");
  const { id, created } = stuckTask(home);
  // 未启用：跳过（即使任务已卡住也不动）。
  let report = runDueReconciliations(home, { providers: { now: at(created, 2000), ...NO_RUN } });
  expect(report.skipped).toContain("未启用");
  expect(getKanbanTask(home, id).stuckAt).toBeNull();
  // 写配置开自动巡查：第一次扫（标卡住），紧接着第二次扫（未到间隔，跳过）。
  saveConfig(home, { reconciler: { enabled: true, stuck_after_seconds: 1800, max_retries: 2, scan_interval_seconds: 300 } });
  report = runDueReconciliations(home, { providers: { now: at(created, 2000), ...NO_RUN } });
  expect(report.flagged).toEqual([id]);
  report = runDueReconciliations(home, { providers: { now: at(created, 2100), ...NO_RUN } });
  expect(report.skipped).toBe("未到扫描间隔");
  // --force 绕过间隔：再扫一次，仍卡着就重排。
  report = runDueReconciliations(home, { force: true, providers: { now: at(created, 2100), ...NO_RUN } });
  expect(report.retried).toEqual([id]);
});

test("ReconcilerTest.test_ledger_roundtrip_perms_and_corrupt_backup", () => {
  const home = tmpHome("nyra-reconciler-");
  saveReconcilerLedger(home, { version: 1, lastScanAt: "2026-11-22T00:00:00.000Z", notedRunDone: ["run-1"] });
  const loaded = loadReconcilerLedger(home);
  expect(loaded.lastScanAt).toBe("2026-11-22T00:00:00.000Z");
  expect(loaded.notedRunDone).toEqual(["run-1"]);
  expectPerms(reconcilerPath(home), 0o600);
  writeFileSync(reconcilerPath(home), "{ 不是 json");
  expect(() => loadReconcilerLedger(home)).toThrow(ReconcilerError);
  const backups = readdirSync(home).filter((f) => f.startsWith("reconciler.json.corrupt-"));
  expect(backups).toHaveLength(1);
  expect(existsSync(join(home, backups[0]))).toBe(true);
});

test("ReconcilerTest.test_block_kanban_task_only_working_and_only_human_resets", () => {
  const home = tmpHome("nyra-reconciler-");
  const task = createKanbanTask(home, { title: "直接停下" });
  expect(() => blockKanbanTask(home, task.id, "还没开始")).toThrow(KanbanError);
  startKanbanTask(home, task.id);
  const blocked = blockKanbanTask(home, task.id, "看门狗停下");
  expect(blocked.status).toBe("blocked");
  expect(blocked.lastError).toContain("看门狗停下");
  expect(() => startKanbanTask(home, task.id)).toThrow(KanbanError);
});

test("ReconcilerTest.test_timeline_renders_five_events", () => {
  const home = tmpHome("nyra-reconciler-");
  const store = new RunStore(join(home, "tasks"));
  const state = store.create("时间线", "sess-3", home, "auto", 20, "running");
  const runId = state.run_id;
  store.appendEvent(runId, "reconciler_stuck", { task_id: "kb_a", idle_seconds: 2000, retries: 0 });
  store.appendEvent(runId, "reconciler_retried", { task_id: "kb_a", idle_seconds: 2000, retries: 1, attempts: 1 });
  store.appendEvent(runId, "reconciler_blocked", { task_id: "kb_a", idle_seconds: 2000, retries: 2 });
  store.appendEvent(runId, "reconciler_recovered", { task_id: "kb_b", idle_seconds: 100 });
  store.appendEvent(runId, "reconciler_run_done", { task_id: "kb_c", run_id: "run-x", status: "completed" });
  const text = formatTimelineText(buildTimeline(store, runId));
  expect(text).toContain("看门狗：任务 kb_a 卡住了");
  expect(text).toContain("看门狗：任务 kb_a 自动重排");
  expect(text).toContain("看门狗：任务 kb_a 已停下等人");
  expect(text).toContain("看门狗：任务 kb_b 恢复进展");
  expect(text).toContain("看门狗：任务 kb_c 的运行已结束");
});

test("ReconcilerTest.test_cli_status_enable_config_scan_settle", () => {
  const home = tmpHome("nyra-reconciler-");
  let r = runCli(home, ["reconciler", "status"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("自动巡查未开启");
  r = runCli(home, ["reconciler", "enable"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("自动巡查已开启");
  r = runCli(home, ["reconciler", "config", "--stuck-after-seconds", "60", "--max-retries", "1"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("60 秒无进展算卡住");
  r = runCli(home, ["reconciler", "config", "--max-retries", "9"]);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("0 到 5");
  r = runCli(home, ["reconciler", "config"]);
  expect(r.status).toBe(2);
  r = runCli(home, ["reconciler", "scan"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("扫完 0 个在跑任务");
  r = runCli(home, ["reconciler", "settle", "run-nobody"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("没绑在跑的任务板任务");
  r = runCli(home, ["reconciler", "settle"]);
  expect(r.status).toBe(2);
  r = runCli(home, ["reconciler", "bogus"]);
  expect(r.status).toBe(2);
  r = runCli(home, ["reconciler"]);
  expect(r.status).toBe(2);
  r = runCli(home, ["reconciler", "disable"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("自动巡查已关闭");
  const help = runCli(home, ["--help"]);
  expect(help.stdout).toContain("nyra reconciler <scan|status|enable|disable|config|settle>");
});

test("ReconcilerTest.test_cli_scan_flags_stuck_task_end_to_end", () => {
  const home = tmpHome("nyra-reconciler-");
  let r = runCli(home, ["kanban", "create", "端到端卡住的活"]);
  expect(r.status).toBe(0);
  const id = r.stdout.trim();
  r = runCli(home, ["kanban", "start", id]);
  expect(r.status).toBe(0);
  // 把 updatedAt 拨到 1 小时前（直接改账本，模拟一直没动静）。
  const store = loadKanbanStore(home);
  const row = store.tasks.find((t) => t.id === id)!;
  row.updatedAt = new Date(Date.now() - 3600 * 1000).toISOString();
  saveKanbanStore(home, store);
  r = runCli(home, ["reconciler", "scan"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("标卡住 1 个");
  expect(getKanbanTask(home, id).stuckAt).not.toBeNull();
});
