// tests/node/test-regression-cases.test.ts — G-3 回归测例库（失败 → 回归测试集）。
// 钉住的事：
//   - precipitateFromTimeline：失败步骤各一例（五类映射），同标题去重，只取元数据；
//   - 账本往返（原子写 0600、损坏先备份再抛错、不静默重建）、去重、删、改状态；
//   - CLI 端到端：precipitate / list / status / remove（含 --yes 门）与退出码。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { RunStore } from "../../src/runs.ts";
import { precipitateFromTimeline, loadRegressionStore, addRegressionCases, removeRegressionCase, setRegressionCaseStatus, regressionStorePath, RegressionError } from "../../src/regression.ts";
import type { Timeline } from "../../src/timeline.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakeTimeline(steps: { kind: string; title: string; detail: string | null; ok: boolean | null }[]): Timeline {
  return {
    runId: "run-1",
    steps: steps.map((s, i) => ({ index: i + 1, at: "2026-11-21T00:00:00.000Z", offsetMs: i * 1000, turn: 1, kind: s.kind, title: s.title, detail: s.detail, ok: s.ok, durationMs: null })),
  } as unknown as Timeline;
}

function runCli(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

test("RegressionCasesTest.test_precipitate_maps_five_kinds_and_dedupes", () => {
  const tl = fakeTimeline([
    { kind: "tool", title: "工具 write_file（失败）", detail: "参数指纹 abc…", ok: false },
    { kind: "tool", title: "工具 write_file（失败）", detail: "参数指纹 abc…", ok: false },
    { kind: "delegate", title: "子任务 task-aaaa（失败）", detail: null, ok: false },
    { kind: "verdict", title: "验收 task-1：未通过", detail: null, ok: false },
    { kind: "llm", title: "模型调用失败", detail: null, ok: false },
    { kind: "event", title: "运行错误：Error", detail: null, ok: false },
    { kind: "tool", title: "工具 read_file", detail: null, ok: true },
    { kind: "tool", title: "工具 read_file（无结果）", detail: null, ok: null },
  ]);
  const cases = precipitateFromTimeline(tl);
  // 同标题的工具失败只留一例；ok 为 true/null 的步骤不沉淀。
  expect(cases).toHaveLength(5);
  expect(cases.map((c) => c.kind)).toEqual(["tool-failed", "delegate-failed", "verdict-failed", "llm-failed", "run-error"]);
  expect(cases[0].sourceRunId).toBe("run-1");
  expect(cases[0].status).toBe("open");
  expect(cases[0].id).toMatch(/^rg_[0-9a-f]{12}$/);
  expect(cases[0].detail).toBe("参数指纹 abc…");
});

test("RegressionCasesTest.test_store_roundtrip_perms_and_history", () => {
  const home = tmpHome("nyra-regression-");
  const cases = precipitateFromTimeline(fakeTimeline([
    { kind: "tool", title: "工具 write_file（失败）", detail: null, ok: false },
  ]));
  const res = addRegressionCases(home, cases);
  expect(res).toEqual({ added: 1, skipped: 0 });
  const store = loadRegressionStore(home);
  expect(store.version).toBe(1);
  expect(store.cases).toHaveLength(1);
  expect(store.cases[0].title).toBe("工具 write_file（失败）");
  expect(store.history).toHaveLength(1);
  expect(store.history[0].action).toBe("added");
  expectPerms(regressionStorePath(home), 0o600);
  // 重复沉淀同一批：新增 0，跳过 1。
  expect(addRegressionCases(home, cases)).toEqual({ added: 0, skipped: 1 });
  expect(loadRegressionStore(home).cases).toHaveLength(1);
});

test("RegressionCasesTest.test_corrupt_store_is_backed_up_not_silently_rebuilt", () => {
  const home = tmpHome("nyra-regression-corrupt-");
  writeFileSync(regressionStorePath(home), "{ 不是 json", "utf-8");
  expect(() => loadRegressionStore(home)).toThrow(RegressionError);
  const backups = readdirSync(home).filter((f) => f.startsWith("regression-cases.json.corrupt-"));
  expect(backups).toHaveLength(1);
  expect(existsSync(regressionStorePath(home))).toBe(false);
});

test("RegressionCasesTest.test_remove_and_status", () => {
  const home = tmpHome("nyra-regression-mutate-");
  const cases = precipitateFromTimeline(fakeTimeline([
    { kind: "tool", title: "工具 write_file（失败）", detail: null, ok: false },
    { kind: "llm", title: "模型调用失败", detail: null, ok: false },
  ]));
  addRegressionCases(home, cases);
  const [first, second] = loadRegressionStore(home).cases;
  expect(setRegressionCaseStatus(home, first.id, "verified")).toBe(true);
  expect(setRegressionCaseStatus(home, first.id, "verified")).toBe(true); // 同状态是 no-op
  expect(loadRegressionStore(home).cases[0].status).toBe("verified");
  expect(setRegressionCaseStatus(home, "rg_000000000000", "retired")).toBe(false);
  expect(removeRegressionCase(home, second.id)).toBe(true);
  expect(removeRegressionCase(home, second.id)).toBe(false);
  const store = loadRegressionStore(home);
  expect(store.cases).toHaveLength(1);
  expect(store.history.filter((h) => h.action === "status")).toHaveLength(1);
  expect(store.history.filter((h) => h.action === "removed")).toHaveLength(1);
});

test("RegressionCasesTest.test_cli_end_to_end", () => {
  const home = tmpHome("nyra-regression-cli-");
  // 种子运行：一次工具失败 + 一次成功调用。
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  const runId = state.run_id;
  store.appendEvent(runId, "tool_start", { id: "c1", name: "read_file", args_hash: "a" });
  store.appendEvent(runId, "tool_result", { id: "c1", name: "read_file", ok: false, args_hash: "a" });
  store.appendEvent(runId, "tool_start", { id: "c2", name: "write_file", args_hash: "b" });
  store.appendEvent(runId, "tool_result", { id: "c2", name: "write_file", ok: true, args_hash: "b" });
  store.setStatus(runId, "failed");

  const prec = runCli(home, ["regression", "precipitate", "--run", runId]);
  expect(prec.status).toBe(0);
  expect(prec.stdout).toContain("新增 1 条");
  const list = runCli(home, ["regression", "list"]);
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("tool-failed");
  expect(list.stdout).toContain("read_file");
  const json = runCli(home, ["regression", "list", "--json"]);
  expect(json.status).toBe(0);
  const parsed = JSON.parse(json.stdout);
  expect(parsed).toHaveLength(1);
  const caseId = parsed[0].id as string;

  // 再沉淀一次：新增 0（去重）。
  expect(runCli(home, ["regression", "precipitate", "--run", runId]).stdout).toContain("新增 0 条");

  const badStatus = runCli(home, ["regression", "status", caseId, "done"]);
  expect(badStatus.status).toBe(2);
  const okStatus = runCli(home, ["regression", "status", caseId, "verified"]);
  expect(okStatus.status).toBe(0);
  expect(okStatus.stdout).toContain("verified");

  // 删除须加 --yes。
  expect(runCli(home, ["regression", "remove", caseId]).status).toBe(2);
  const rm = runCli(home, ["regression", "remove", caseId, "--yes"]);
  expect(rm.status).toBe(0);
  expect(runCli(home, ["regression", "list"]).stdout).toContain("没有回归用例");

  // 找不到的运行 / 用例：退出码 2 / 1。
  expect(runCli(home, ["regression", "precipitate", "--run", "no-such-run"]).status).toBe(2);
  expect(runCli(home, ["regression", "remove", "rg_000000000000", "--yes"]).status).toBe(1);
  expect(runCli(home, ["regression", "bogus"]).status).toBe(2);
});

test("RegressionCasesTest.test_cli_precipitate_with_no_failures", () => {
  const home = tmpHome("nyra-regression-nofail-");
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  store.setStatus(state.run_id, "verified");
  const r = runCli(home, ["regression", "precipitate", "--run", state.run_id]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("没有失败步骤");
  expect(existsSync(regressionStorePath(home))).toBe(false);
});
