// tests/node/test-verifier.test.ts — 缺口 13：验收者（verifier）——并行产出合入前的验收门。
//
// 钉住的事：
//   - 确定性检查（改动存在、文件存在、diff 完整、证据齐全）纯函数可测；
//   - verifyOutput 的五条路：未开启（不调模型）、确定性失败（不调模型）、
//     无改动跳过、确定性通过（无模型时 verified-deterministic）、模型复核
//     （通过/打回/不可用时 fail-closed 回 not-verified）；
//   - 群聊默认机器人含验收者（只读）；
//   - delegate 验收门：结论进 DelegateResult.verification，未通过且开 rework
//     时打回重做 1 次，结论进证据链（verifier_verdict / verifier_rework）；
//   - review queue 的 verify：验收者开启时跑完整验收，否则沿用 files-exist；
//   - 新事件类型已在 src/runs.ts 的 EVENT_FIELDS 注册（事件写得进去，不静默丢失）。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  verifierConfig,
  resolveVerifierModel,
  runDeterministicChecks,
  verifyOutput,
  formatVerifierVerdict,
  handleVerifier,
  VERIFIER_CHECKLIST,
  type VerifierInput,
  type ReviewerLike,
} from "../../src/verifier.ts";
import { DEFAULT_BOTS } from "../../src/groups.ts";
import { Agent } from "../../src/agent.ts";
import { fakeProvider } from "./fake-provider.ts";
import { RunStore } from "../../src/runs.ts";
import {
  enqueueReviewItem,
  verifyReviewItem,
} from "../../src/reviewQueue.ts";
import {
  runParallelDelegate,
  formatParallelResults,
} from "../../src/parallelDelegate.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-verifier-"));
}

function makeWorkdir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nyra-vwt-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, "utf-8");
  return dir;
}

function baseInput(workdir: string, over: Partial<VerifierInput> = {}): VerifierInput {
  return {
    title: "修 a.txt 拼写",
    summary: "改了 a.txt，跑了 bun test，12 通过。",
    changedFiles: ["a.txt"],
    diffStat: " a.txt | 2 +-\n 1 file changed",
    worktreePath: workdir,
    workdir: null,
    spentUsd: 0.01,
    ...over,
  };
}

/** 数调用次数的假验收模型：按固定结论回 JSON。 */
function countingRunner(decision: "approve" | "deny", reason: string): ReviewerLike & { calls: number } {
  let calls = 0;
  return {
    calls: 0,
    async chat(): Promise<Record<string, unknown>> {
      calls += 1;
      (this as unknown as { calls: number }).calls = calls;
      return { choices: [{ message: { content: JSON.stringify({ decision, reason }) } }] };
    },
  } as unknown as ReviewerLike & { calls: number };
}

function throwingRunner(): ReviewerLike {
  return {
    async chat(): Promise<Record<string, unknown>> {
      throw new Error("模型挂了");
    },
  };
}

const ENABLED = { verifier: { enabled: true, provider: null, model: null, rework: false, rules: [] } };
const ENABLED_REWORK = { verifier: { enabled: true, provider: null, model: null, rework: true, rules: [] } };
const DISABLED = { verifier: { enabled: false, provider: null, model: null, rework: false, rules: [] } };

// ---- 配置解析 ----

test("配置：默认关闭、rework 默认关闭；模型走 reviewer 便宜链", () => {
  expect(verifierConfig({}).enabled).toBe(false);
  expect(verifierConfig({}).rework).toBe(false);
  expect(verifierConfig({}).rules).toEqual([]);
  expect(resolveVerifierModel({})).toEqual({ provider: "deepseek", model: "deepseek-flash" });
  expect(resolveVerifierModel({ verifier: { model: "my-model" } }).model).toBe("my-model");
  expect(resolveVerifierModel({ smart_approvals: { reviewer_model: "cheap-1" } }).model).toBe("cheap-1");
  expect(VERIFIER_CHECKLIST.map((c) => c.id)).toEqual(["has-changes", "files-exist", "diff-stat", "evidence-complete", "draft-labeled", "ui-before-shot"]);
});

// ---- 确定性检查 ----

test("确定性检查：全部通过", () => {
  const dir = makeWorkdir({ "a.txt": "x\n" });
  const checks = runDeterministicChecks(baseInput(dir));
  expect(checks.every((c) => c.passed)).toBe(true);
  expect(checks).toHaveLength(6);
});

test("确定性检查：无改动时只有 has-changes 失败", () => {
  const dir = makeWorkdir({});
  const checks = runDeterministicChecks(baseInput(dir, { changedFiles: [], diffStat: null, summary: "只调研，无改动。" }));
  expect(checks.find((c) => c.id === "has-changes")?.passed).toBe(false);
  expect(checks.filter((c) => !c.passed)).toHaveLength(1);
});

test("确定性检查：缺文件 / diff 为空 / 摘要为空各自失败", () => {
  const dir = makeWorkdir({ "a.txt": "x\n" });
  const missing = runDeterministicChecks(baseInput(dir, { changedFiles: ["missing.txt"] }));
  expect(missing.find((c) => c.id === "files-exist")?.passed).toBe(false);
  expect(missing.find((c) => c.id === "files-exist")?.detail).toContain("missing.txt");
  const noDiff = runDeterministicChecks(baseInput(dir, { diffStat: null }));
  expect(noDiff.find((c) => c.id === "diff-stat")?.passed).toBe(false);
  const noSummary = runDeterministicChecks(baseInput(dir, { summary: "   " }));
  expect(noSummary.find((c) => c.id === "evidence-complete")?.passed).toBe(false);
});

// ---- verifyOutput 五条路 ----

test("verifyOutput 未开启：不调模型、结论 not-verified", async () => {
  const dir = makeWorkdir({ "a.txt": "x\n" });
  const runner = countingRunner("approve", "好");
  const v = await verifyOutput({ config: DISABLED, input: baseInput(dir), runner });
  expect(v.status).toBe("not-verified");
  expect(v.source).toBe("skipped");
  expect(v.method).toBeNull();
  expect(runner.calls).toBe(0);
});

test("verifyOutput 确定性失败：不调模型、结论 failed", async () => {
  const dir = makeWorkdir({ "a.txt": "x\n" });
  const runner = countingRunner("approve", "好");
  const v = await verifyOutput({ config: ENABLED, input: baseInput(dir, { changedFiles: ["missing.txt"] }), runner });
  expect(v.status).toBe("failed");
  expect(v.source).toBe("deterministic");
  expect(v.reason).toContain("missing.txt");
  expect(runner.calls).toBe(0);
});

test("verifyOutput 无改动：跳过验收 not-verified（不打回重做）", async () => {
  const dir = makeWorkdir({});
  const v = await verifyOutput({
    config: ENABLED_REWORK,
    input: baseInput(dir, { changedFiles: [], diffStat: null, summary: "只调研，无改动。" }),
    runner: countingRunner("approve", "好"),
  });
  expect(v.status).toBe("not-verified");
  expect(v.reason).toContain("跳过验收");
});

test("verifyOutput 确定性通过、无模型：verified（verifier-deterministic），写清没验什么", async () => {
  const dir = makeWorkdir({ "a.txt": "x\n" });
  const v = await verifyOutput({ config: ENABLED, input: baseInput(dir), runner: null });
  expect(v.status).toBe("verified");
  expect(v.method).toBe("verifier-deterministic");
  expect(v.source).toBe("deterministic");
  expect(v.reason).toContain("未跑测试");
});

test("verifyOutput 模型复核：通过 / 打回", async () => {
  const dir = makeWorkdir({ "a.txt": "x\n" });
  const ok = await verifyOutput({ config: ENABLED, input: baseInput(dir), runner: countingRunner("approve", "复核通过：改动与任务相符") });
  expect(ok.status).toBe("verified");
  expect(ok.method).toBe("verifier");
  expect(ok.source).toBe("model");
  expect(ok.reason).toContain("复核通过");
  const no = await verifyOutput({ config: ENABLED, input: baseInput(dir), runner: countingRunner("deny", "测试结论无命令与结果佐证") });
  expect(no.status).toBe("failed");
  expect(no.source).toBe("model");
  expect(no.reason).toContain("无命令与结果佐证");
});

test("verifyOutput 模型不可用：fail-closed 回 not-verified，不得合并", async () => {
  const dir = makeWorkdir({ "a.txt": "x\n" });
  const v = await verifyOutput({ config: ENABLED, input: baseInput(dir), runner: throwingRunner() });
  expect(v.status).toBe("not-verified");
  expect(v.source).toBe("unavailable");
  expect(v.method).toBeNull();
});

test("formatVerifierVerdict：三种结论的文案", () => {
  const dir = makeWorkdir({ "a.txt": "x\n" });
  const checks = runDeterministicChecks(baseInput(dir));
  expect(formatVerifierVerdict({ status: "verified", method: "verifier", source: "model", reason: "好", verifierModel: "deepseek:deepseek-flash", checks, at: "2026-11-20T00:00:00Z" })).toContain("验收：通过");
  expect(formatVerifierVerdict({ status: "failed", method: "verifier", source: "deterministic", reason: "坏", verifierModel: null, checks, at: "2026-11-20T00:00:00Z" })).toContain("验收：未通过");
  expect(formatVerifierVerdict({ status: "not-verified", method: null, source: "skipped", reason: "没开", verifierModel: null, checks: [], at: "2026-11-20T00:00:00Z" })).toContain("验收：未验收");
});

// ---- 群聊验收者角色 ----

test("群聊默认机器人含验收者（只读、按清单验收、打回重做）", () => {
  expect(DEFAULT_BOTS.map((b) => b.id)).toContain("verifier");
  const v = DEFAULT_BOTS.find((b) => b.id === "verifier");
  expect(v?.name).toBe("验收者");
  expect(v?.mode).toBe("readonly");
  expect(v?.instructions).toContain("打回");
  expect(v?.role).toContain("验收");
});

// ---- 新事件类型已注册 ----

test("新事件类型 verifier_verdict / verifier_rework 能写进 events.jsonl", () => {
  const home = makeHome();
  const store = new RunStore(join(home, "runs"));
  const run = store.create("任务", "20260101-000000-abcdef", process.cwd(), "auto", 5, "running");
  for (const [type, fields] of [
    ["verifier_verdict", { target: "0123456789abcdef", verdict: "verified", reason: "好", verifier_model: "deepseek:deepseek-flash", source: "model", checks_passed: 4, checks_failed: 0 }],
    ["verifier_rework", { target: "task-01234567", attempt: 2, reason: "缺文件" }],
  ] as [string, Record<string, unknown>][]) {
    expect(() => store.appendEvent(run.run_id, type, fields)).not.toThrow();
  }
  const lines = readFileSync(join(home, "runs", run.run_id, "events.jsonl"), "utf-8").split("\n").filter(Boolean);
  expect(lines).toHaveLength(3);
  const types = lines.map((l) => JSON.parse(l).type);
  expect(types).toContain("verifier_verdict");
  expect(types).toContain("verifier_rework");
});

// ---- delegate 验收门 ----

function newAgent(workdir: string, provider: ReturnType<typeof fakeProvider>, opts: Record<string, unknown> = {}): Agent {
  return new Agent(provider, {
    workdir,
    mode: "full",
    maxTurns: 6,
    interactive: false,
    home: makeHome(),
    sessionId: null,
    skillsDirs: [],
    checkpointStore: null,
    ...opts,
  } as never);
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "nyra-vrepo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "原内容\n", "utf-8");
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repo });
  return repo;
}

test("delegate 门：未开启时结论 not-verified，不调验收模型", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-vd-"));
  const runner = countingRunner("approve", "好");
  const agent = newAgent(dir, fakeProvider([{ content: "调研完成，无改动。" }]), {
    verifier: { enabled: false, provider: null, model: null, rework: false, rules: [] },
    verifierRunner: runner,
  });
  const d = await agent.delegateDetailed("调研一下", 2);
  expect(d.ok).toBe(true);
  expect(d.verification.status).toBe("not-verified");
  expect(d.text).toContain("验收：未验收");
  expect(runner.calls).toBe(0);
});

test("delegate 门：开启 + 验收通过 → verified，结论进结果文本", async () => {
  const repo = initRepo();
  const provider = fakeProvider([
    { toolCalls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "新内容\n" }) } }] },
    { content: "改了 a.txt，跑了 git diff 核对。" },
  ]);
  // 注意：Agent 的 verifierRunner 有 fallback 链（注入 > 多模型 > 便宜模型 >
  // 主模型，与 reviewer 同款），传 null 是“不注入、走 fallback”不是“不要模型
  // 腿”；确定性-only 的路径在 verifyOutput 层已测，这里显式传 approve 的 runner。
  const runner = countingRunner("approve", "复核通过：改动与任务相符");
  const agent = newAgent(repo, provider, {
    verifier: { enabled: true, provider: null, model: null, rework: false, rules: [] },
    verifierRunner: runner,
  });
  const d = await agent.delegateDetailed("把 a.txt 改成新内容", 4, { isolation: "worktree" });
  expect(d.ok).toBe(true);
  expect(d.changedFiles).toContain("a.txt");
  expect(d.verification.status).toBe("verified");
  expect(d.verification.method).toBe("verifier");
  expect(d.text).toContain("验收：通过");
  expect(runner.calls).toBe(1);
});

test("delegate 门：未通过 + 开 rework → 打回重做 1 次，事件顺序为 verdict→rework→verdict", async () => {
  const repo = initRepo();
  // 第 1 次：新建 b.txt（untracked，git diff --stat HEAD 为空 → diff-stat 失败）；
  // 第 2 次（重做）：改已入库的 a.txt，diff 恢复正常 → 通过。
  const provider = fakeProvider([
    { toolCalls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "b.txt", content: "新建\n" }) } }] },
    { content: "新建了 b.txt。" },
    { toolCalls: [{ id: "c2", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "重做后的内容\n" }) } }] },
    { content: "按验收意见改了 a.txt，b.txt 也留着。" },
  ]);
  const seen: string[] = [];
  const runner = countingRunner("approve", "复核通过：改动与任务相符");
  const agent = newAgent(repo, provider, {
    verifier: { enabled: true, provider: null, model: null, rework: true, rules: [] },
    verifierRunner: runner,
    onEvent: (kind: string) => { seen.push(kind); },
  });
  const d = await agent.delegateDetailed("改 a.txt", 6, { isolation: "worktree" });
  expect(d.ok).toBe(true);
  expect(d.verification.status).toBe("verified");
  expect(d.text).toContain("已打回重做 1 次后通过");
  // 第 1 次确定性失败没调模型（模型只在第 2 次确定性通过后跑了 1 次）。
  expect(runner.calls).toBe(1);
  expect(seen.filter((k) => k === "verifier_verdict")).toHaveLength(2);
  expect(seen.filter((k) => k === "verifier_rework")).toHaveLength(1);
  expect(seen.indexOf("verifier_rework")).toBeGreaterThan(seen.indexOf("verifier_verdict"));
});

// ---- review queue 的 verify（验收者开启时跑完整验收） ----

test("review queue verify：验收者开启时方法为 verifier，模型打回则 failed", async () => {
  const home = makeHome();
  const wt = makeWorkdir({ "a.txt": "x\n" });
  const item = enqueueReviewItem(home, {
    source: "parallel", title: "有文件", summary: "改了 a.txt，跑了验证。", worktreePath: wt,
    changedFiles: ["a.txt"], diffStat: " a.txt | 1 +",
  }).item;
  const verified = await verifyReviewItem(home, item.id, { config: ENABLED, runner: null });
  expect(verified.item.verification.status).toBe("verified");
  expect(verified.item.verification.method).toBe("verifier-deterministic");
  const denied = await verifyReviewItem(home, item.id, {
    config: ENABLED,
    runner: countingRunner("deny", "改动与任务不符"),
  });
  expect(denied.item.verification.status).toBe("failed");
  expect(denied.item.verification.method).toBe("verifier");
  expect(denied.item.verification.note).toContain("改动与任务不符");
});

// ---- 并行：verification 透传与格式化 ----

test("并行：outcome 的 verification 透传到 evidence，格式化文本带验收", async () => {
  const r = await runParallelDelegate(async (spec) => ({
    ok: true,
    summary: `做了：${spec.task}`,
    spentUsd: null,
    model: "fake-1",
    worktreePath: null,
    changedFiles: ["a.txt"],
    diffStat: " a.txt | 1 +",
    verification: { status: "verified", note: "确定性检查全部通过", method: "verifier-deterministic", at: null },
  }), [{ task: "甲" }]);
  expect(r.results[0].evidence.verification.status).toBe("verified");
  expect(r.results[0].evidence.verification.method).toBe("verifier-deterministic");
  const text = formatParallelResults(r);
  expect(text).toContain("验收：通过");
  expect(text).toContain("验收者已验收 1 个线程");
});

// ---- CLI：nyra verifier ----

test("CLI：verifier status/enable/disable/set-model/rework/check", async () => {
  const home = makeHome();
  const capture = async (argv: string[]): Promise<{ out: string; code: number }> => {
    let out = "";
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
    try {
      const code = await handleVerifier(argv, home);
      return { out, code };
    } finally {
      (process.stdout as unknown as { write: unknown }).write = origOut;
      (process.stderr as unknown as { write: unknown }).write = origErr;
    }
  };
  let r = await capture(["status"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("禁用");
  r = await capture(["enable"]);
  expect(r.code).toBe(0);
  r = await capture(["status"]);
  expect(r.out).toContain("启用");
  expect(r.out).toContain("打回重做：关闭");
  r = await capture(["rework-on"]);
  expect(r.code).toBe(0);
  r = await capture(["status"]);
  expect(r.out).toContain("打回重做：开启");
  r = await capture(["set-model", "deepseek:deepseek-flash"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("deepseek:deepseek-flash");
  // check 试运行：真实目录 + 真实文件 → 确定性通过（无凭证，不调模型）。
  const dir = makeWorkdir({ "a.txt": "x\n" });
  r = await capture(["check", "--title", "修 a.txt", "--summary", "改了 a.txt。", "--workdir", dir, "--files", "a.txt", "--diff-stat", " a.txt | 1 +"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("验收：通过");
  // check 缺文件 → 退出 3。
  r = await capture(["check", "--title", "修缺失", "--summary", "改了 missing.txt。", "--workdir", dir, "--files", "missing.txt", "--diff-stat", " missing.txt | 1 +"]);
  expect(r.code).toBe(3);
  expect(r.out).toContain("验收：未通过");
});
