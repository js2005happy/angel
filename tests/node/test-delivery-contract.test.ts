// tests/node/test-delivery-contract.test.ts — 缺口 29：交付契约 + G-2 Golden 集。
//
// 覆盖：checker 注册表（内置六项 + 参数化四项 + 未知 id 拒绝）、轨迹评分
// （顺序匹配、漏工具、多余步骤不扣分）、结果评分、Golden 用例打分与跑分、
// 契约立/激活/挂运行/逐项打分（确定性/模型/人工三类 + flaky 复跑）、
// 验收 attempt 历史与一致性、每被接受任务成本、运行报告顶部的契约三数、
// 运行事件注册（contract_attached / contract_verified）、CLI（contract / golden）。
// 全部在临时 home 里跑，不调真模型（模型项用假 runner 或记 skipped）。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runChecker, isKnownChecker, listCheckers, CheckerError, type CheckerInput,
} from "../../src/checkers.ts";
import {
  createContract, getContract, activateContract, attachContractToRun, verifyContract,
  markContractItem, scoreContract, contractHash, contractConsistency, costPerAcceptedTask,
  contractHeaderForRun, formatContractReport, formatContractStats, handleContract,
  ContractError, type DeliveryContract, type ScoreInput,
} from "../../src/contract.ts";
import {
  scoreTrajectory, scoreResult, scoreGoldenCase, runGoldenCases, addGoldenCase,
  getGoldenCase, removeGoldenCase, trajectoryFromEvents, stripRunReport,
  formatGoldenRun, handleGolden, GoldenError,
} from "../../src/golden.ts";
import { RunStore, formatRunReport } from "../../src/runs.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-contract-test-"));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function baseInput(over: Partial<CheckerInput> = {}): CheckerInput {
  return {
    workdir: null, changedFiles: [], diffStat: null,
    title: "任务", summary: "摘要", outputText: "", trajectory: [], spentUsd: null, ...over,
  };
}

function scoreInput(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    workdir: null, changedFiles: [], diffStat: null, title: "任务",
    outputText: "", summary: "摘要", trajectory: [], spentUsd: null, ...over,
  };
}

function makeContract(home: string, checks: DeliveryContract["checks"]): DeliveryContract {
  return createContract(home, {
    task: "写一份说明并改代码",
    deliverables: [{ id: "doc", description: "说明文档", attributes: [{ name: "格式", value: "md" }] }],
    checks,
  });
}

function makeRun(home: string, workdir: string): string {
  const store = new RunStore(join(home, "runs"));
  return store.create("写一份说明并改代码", "sess-1", workdir, "normal", 10).run_id;
}

// ---- checker 注册表 ----

test("内置六项：有改动时 has-changes 与 files-exist 通过", () => {
  const workdir = mkdtempSync(join(tmpdir(), "nyra-checker-"));
  try {
    writeFileSync(join(workdir, "a.md"), "x");
    const input = baseInput({ workdir, changedFiles: ["a.md"], diffStat: "a.md | 1 +", summary: "改了 a.md" });
    expect(runChecker("has-changes", input).passed).toBe(true);
    expect(runChecker("files-exist", input).passed).toBe(true);
    expect(runChecker("diff-stat", input).passed).toBe(true);
    expect(runChecker("evidence-complete", input).passed).toBe(true);
  } finally {
    cleanup(workdir);
  }
});

test("内置六项：无改动时 has-changes 不过，缺文件时 files-exist 不过", () => {
  const input = baseInput({ changedFiles: [], diffStat: null, summary: "" });
  expect(runChecker("has-changes", input).passed).toBe(false);
  expect(runChecker("evidence-complete", input).passed).toBe(false);
  const missing = baseInput({ workdir: tmpdir(), changedFiles: ["no-such-file-xyz.md"], diffStat: "x" });
  expect(runChecker("files-exist", missing).passed).toBe(false);
});

test("内置六项：草稿声称已完成时 draft-labeled 不过", () => {
  const input = baseInput({ title: "草稿：说明", summary: "草稿，已完成", changedFiles: ["a.md"], diffStat: "x" });
  expect(runChecker("draft-labeled", input).passed).toBe(false);
  const ok = baseInput({ title: "草稿：说明", summary: "草稿，还没写完", changedFiles: ["a.md"], diffStat: "x" });
  expect(runChecker("draft-labeled", ok).passed).toBe(true);
});

test("参数化 checker：file-exists / output-contains / trajectory-contains / no-tool", () => {
  const workdir = mkdtempSync(join(tmpdir(), "nyra-checker-"));
  try {
    mkdirSync(join(workdir, "docs"), { recursive: true });
    writeFileSync(join(workdir, "docs", "a.md"), "x");
    const input = baseInput({
      workdir, outputText: "完成：说明已写好", trajectory: ["read_file", "write_file", "shell"],
    });
    expect(runChecker("file-exists:docs/a.md", input).passed).toBe(true);
    expect(runChecker("file-exists:docs/nope.md", input).passed).toBe(false);
    expect(runChecker("output-contains:说明已写好", input).passed).toBe(true);
    expect(runChecker("output-contains:没出现过", input).passed).toBe(false);
    expect(runChecker("trajectory-contains:write_file", input).passed).toBe(true);
    expect(runChecker("trajectory-contains:shell", input).passed).toBe(true);
    expect(runChecker("no-tool:delete_file", input).passed).toBe(true);
    expect(runChecker("no-tool:shell", input).passed).toBe(false);
    const noWorkdir = baseInput({ workdir: null });
    expect(runChecker("file-exists:a.md", noWorkdir).passed).toBe(false);
  } finally {
    cleanup(workdir);
  }
});

test("未知 checker 在立契约前就拒绝，isKnownChecker 与 listCheckers 口径一致", () => {
  expect(isKnownChecker("has-changes")).toBe(true);
  expect(isKnownChecker("file-exists:docs/a.md")).toBe(true);
  expect(isKnownChecker("file-exists:")).toBe(false);
  expect(isKnownChecker("no-such-checker")).toBe(false);
  expect(isKnownChecker("")).toBe(false);
  expect(() => runChecker("no-such-checker", baseInput())).toThrow(CheckerError);
  expect(listCheckers().length).toBe(10);
});

// ---- 轨迹评分与结果评分 ----

test("轨迹分：按顺序出现算分，漏掉扣分，多余步骤不扣分", () => {
  const full = scoreTrajectory(["read_file", "write_file", "shell"], ["read_file", "search", "write_file", "shell"]);
  expect(full.score).toBe(1);
  expect(full.missing).toEqual([]);
  const partial = scoreTrajectory(["read_file", "write_file", "shell"], ["read_file", "shell"]);
  expect(partial.score).toBeCloseTo(2 / 3);
  expect(partial.missing).toEqual(["write_file"]);
  const outOfOrder = scoreTrajectory(["write_file", "read_file"], ["read_file", "write_file"]);
  expect(outOfOrder.score).toBeCloseTo(0.5);
  expect(outOfOrder.missing).toEqual(["read_file"]);
  const empty = scoreTrajectory([], ["shell"]);
  expect(empty.score).toBe(1);
});

test("结果分：期望子串出现几成，缺的列出来", () => {
  const r = scoreResult(["已完成", "测试通过", "文档"], "已完成：文档已写好");
  expect(r.score).toBeCloseTo(2 / 3);
  expect(r.missing).toEqual(["测试通过"]);
  expect(scoreResult([], "任何输出").score).toBe(1);
});

test("Golden 用例打分：合计分是结果分与轨迹分的均值，阈值定通过", () => {
  const c = {
    id: "gd_x", name: "写说明", input: "写说明", expectedOutputs: ["已完成", "文档"],
    expectedTrajectory: ["write_file"], threshold: 0.8, createdAt: "2026-11-21T00:00:00Z",
  };
  const good = scoreGoldenCase(c, "已完成：文档", ["write_file"], 0.01);
  expect(good.resultScore).toBe(1);
  expect(good.trajectoryScore).toBe(1);
  expect(good.combined).toBe(1);
  expect(good.passed).toBe(true);
  const bad = scoreGoldenCase(c, "写了一半", ["shell"], null);
  expect(bad.combined).toBe(0);
  expect(bad.passed).toBe(false);
  expect(bad.missingTools).toEqual(["write_file"]);
  const override = scoreGoldenCase(c, "已完成", ["write_file"], null, 0.4);
  expect(override.passed).toBe(true);
});

test("stripRunReport 剥掉运行报告，找不到标记时原样返回", () => {
  const raw = "最终输出：做完了\n----\n运行状态：verified（已验证）";
  expect(stripRunReport(raw)).toBe("最终输出：做完了");
  expect(stripRunReport("只有正文")).toBe("只有正文");
});

test("trajectoryFromEvents 只取 tool_start 的名字，按顺序", () => {
  const events = [
    { type: "turn", turn: 1 },
    { type: "tool_start", name: "read_file" },
    { type: "tool_result", name: "read_file", ok: true },
    { type: "tool_start", name: "shell" },
    { type: "final" },
  ];
  expect(trajectoryFromEvents(events)).toEqual(["read_file", "shell"]);
});

// ---- Golden 集跑分 ----

test("runGoldenCases 用注入的执行器跑分，不调真模型", async () => {
  const home = tempHome();
  try {
    const a = addGoldenCase(home, {
      name: "写说明", input: "写说明",
      expectedOutputs: ["已完成"], expectedTrajectory: ["write_file"],
    });
    const b = addGoldenCase(home, {
      name: "查文件", input: "查文件",
      expectedOutputs: ["找到"], expectedTrajectory: ["read_file", "shell"],
    });
    const run = await runGoldenCases([a, b], async (input) => {
      if (input === "写说明") return { output: "已完成", trajectory: ["write_file"], spentUsd: 0.01 };
      return { output: "什么都没查到", trajectory: ["read_file"], spentUsd: null };
    });
    expect(run.total).toBe(2);
    expect(run.passed).toBe(1);
    expect(run.meanScore).toBeCloseTo((1 + 0.25) / 2);
    expect(formatGoldenRun(run)).toContain("1/2 通过");
  } finally {
    cleanup(home);
  }
});

test("Golden 用例校验：没名字、没输入、既没期望输出又没期望轨迹、阈值越界都拒绝", () => {
  const home = tempHome();
  try {
    expect(() => addGoldenCase(home, { name: "", input: "x", expectedOutputs: ["y"], expectedTrajectory: [] })).toThrow(GoldenError);
    expect(() => addGoldenCase(home, { name: "n", input: "", expectedOutputs: ["y"], expectedTrajectory: [] })).toThrow(GoldenError);
    expect(() => addGoldenCase(home, { name: "n", input: "x", expectedOutputs: [], expectedTrajectory: [] })).toThrow(GoldenError);
    expect(() => addGoldenCase(home, { name: "n", input: "x", expectedOutputs: ["y"], expectedTrajectory: [], threshold: 1.5 })).toThrow(GoldenError);
    const c = addGoldenCase(home, { name: "n", input: "x", expectedOutputs: ["y"], expectedTrajectory: [] });
    expect(getGoldenCase(home, c.id)?.name).toBe("n");
    expect(removeGoldenCase(home, c.id)).toBe(true);
    expect(getGoldenCase(home, c.id)).toBeNull();
  } finally {
    cleanup(home);
  }
});

// ---- 契约：立、激活、挂运行 ----

test("立契约校验：没检查、未知 checker、检查 id 重复、没交付物都拒绝", () => {
  const home = tempHome();
  try {
    expect(() => createContract(home, { task: "t", deliverables: [{ id: "d", description: "x", attributes: [] }], checks: [] })).toThrow(ContractError);
    expect(() => makeContract(home, [{ id: "bad", label: "坏", kind: "deterministic", checker: "no-such" }])).toThrow(ContractError);
    expect(() => makeContract(home, [
      { id: "has-changes", label: "一", kind: "deterministic", checker: "has-changes" },
      { id: "has-changes", label: "二", kind: "deterministic", checker: "has-changes" },
    ])).toThrow(ContractError);
    expect(() => createContract(home, { task: "t", deliverables: [], checks: [{ id: "has-changes", label: "一", kind: "deterministic", checker: "has-changes" }] })).toThrow(ContractError);
  } finally {
    cleanup(home);
  }
});

test("契约哈希只跟正文走：同内容同哈希，改检查清单就变", () => {
  const home = tempHome();
  try {
    const a = makeContract(home, [{ id: "has-changes", label: "有改动", kind: "deterministic", checker: "has-changes" }]);
    const b = makeContract(home, [{ id: "has-changes", label: "有改动", kind: "deterministic", checker: "has-changes" }]);
    expect(a.contractHash).toBe(b.contractHash);
    expect(a.contractHash).toBe(contractHash(a));
    const c = makeContract(home, [{ id: "has-changes", label: "改了标签", kind: "deterministic", checker: "has-changes" }]);
    expect(c.contractHash).not.toBe(a.contractHash);
  } finally {
    cleanup(home);
  }
});

test("激活：草稿才能激活，激活两次报错；草稿不能挂运行", async () => {
  const home = tempHome();
  try {
    const workdir = mkdtempSync(join(tmpdir(), "nyra-wd-"));
    const runId = makeRun(home, workdir);
    const c = makeContract(home, [{ id: "has-changes", label: "有改动", kind: "deterministic", checker: "has-changes" }]);
    expect(c.status).toBe("draft");
    expect(() => attachContractToRun(home, runId, c.id)).toThrow(ContractError);
    const active = activateContract(home, c.id);
    expect(active.status).toBe("active");
    expect(() => activateContract(home, c.id)).toThrow(ContractError);
    cleanup(workdir);
  } finally {
    cleanup(home);
  }
});

test("挂运行：run 记录写 contract_id 与哈希，事件 contract_attached 可追加", () => {
  const home = tempHome();
  try {
    const workdir = mkdtempSync(join(tmpdir(), "nyra-wd-"));
    const runId = makeRun(home, workdir);
    const c = makeContract(home, [{ id: "has-changes", label: "有改动", kind: "deterministic", checker: "has-changes" }]);
    activateContract(home, c.id);
    attachContractToRun(home, runId, c.id);
    const store = new RunStore(join(home, "runs"));
    const state = store.load(runId);
    expect(state.contract_id).toBe(c.id);
    expect(state.contract_hash).toBe(c.contractHash);
    expect(state.contract_verdict).toBeNull();
    const events = store.readEvents(runId);
    expect(events.some((e) => e.type === "contract_attached")).toBe(true);
    expect(() => store.appendEvent(runId, "contract_verified", { contract_id: c.id, verdict: "accepted", passed: 1, total: 1 })).not.toThrow();
    cleanup(workdir);
  } finally {
    cleanup(home);
  }
});

// ---- 契约：逐项打分 ----

test("verify：确定性项全过就是已接受，状态与 attempt 都落账", async () => {
  const home = tempHome();
  try {
    const workdir = mkdtempSync(join(tmpdir(), "nyra-wd-"));
    writeFileSync(join(workdir, "a.md"), "x");
    const runId = makeRun(home, workdir);
    const c = makeContract(home, [
      { id: "has-changes", label: "有改动", kind: "deterministic", checker: "has-changes" },
      { id: "file-exists:a.md", label: "文件在", kind: "deterministic", checker: "file-exists:a.md" },
    ]);
    activateContract(home, c.id);
    attachContractToRun(home, runId, c.id);
    const { contract, attempt } = await verifyContract(home, c.id, scoreInput({
      workdir, changedFiles: ["a.md"], diffStat: "a.md | 1 +", summary: "改了 a.md", outputText: "改了 a.md",
    }), { runId });
    expect(attempt.verdict).toBe("accepted");
    expect(attempt.passed).toBe(2);
    expect(contract.status).toBe("accepted");
    expect(contract.attempts.length).toBe(1);
    const state = new RunStore(join(home, "runs")).load(runId);
    expect(state.contract_verdict).toBe("accepted");
    expect(state.contract_passed).toBe(2);
    expect(state.contract_total).toBe(2);
    const report = formatContractReport(contract, attempt);
    expect(report).toContain("2/2 通过");
    expect(report).toContain("已接受");
    cleanup(workdir);
  } finally {
    cleanup(home);
  }
});

test("verify：有一项不过就是未接受；人工项没标记时结论待定", async () => {
  const home = tempHome();
  try {
    const workdir = mkdtempSync(join(tmpdir(), "nyra-wd-"));
    const c = makeContract(home, [
      { id: "has-changes", label: "有改动", kind: "deterministic", checker: "has-changes" },
      { id: "human-check", label: "人工看一眼", kind: "manual", checker: null },
    ]);
    activateContract(home, c.id);
    const first = await verifyContract(home, c.id, scoreInput({ changedFiles: ["a.md"], diffStat: "x" }), {});
    expect(first.attempt.verdict).toBe("pending");
    expect(first.attempt.pending).toBe(1);
    expect(first.contract.status).toBe("active");
    markContractItem(home, c.id, "human-check", true, "看过了，没问题");
    const second = await verifyContract(home, c.id, scoreInput({ changedFiles: ["a.md"], diffStat: "x" }), {});
    expect(second.attempt.verdict).toBe("accepted");
    const failCase = makeContract(home, [
      { id: "file-exists:nope.md", label: "文件在", kind: "deterministic", checker: "file-exists:nope.md" },
    ]);
    activateContract(home, failCase.id);
    const failed = await verifyContract(home, failCase.id, scoreInput({ workdir }), {});
    expect(failed.attempt.verdict).toBe("rejected");
    expect(failed.contract.status).toBe("rejected");
    cleanup(workdir);
  } finally {
    cleanup(home);
  }
});

test("verify：模型项无验收模型记 skipped，不算接受；假 runner 批量判分", async () => {
  const home = tempHome();
  try {
    const c = makeContract(home, [
      { id: "semantic-fit", label: "语义相符", kind: "model", checker: null },
    ]);
    activateContract(home, c.id);
    const skipped = await verifyContract(home, c.id, scoreInput({ summary: "摘要" }), {});
    expect(skipped.attempt.items[0].status).toBe("skipped");
    expect(skipped.attempt.verdict).toBe("pending");
    const fakeRunner = {
      chat: async () => ({
        choices: [{ message: { content: JSON.stringify({ results: [{ id: "semantic-fit", passed: true, reason: "相符" }] }) } }],
      }),
    };
    const scored = await verifyContract(home, c.id, scoreInput({ summary: "摘要" }), { runner: fakeRunner as never });
    expect(scored.attempt.items[0].status).toBe("pass");
    expect(scored.attempt.verdict).toBe("accepted");
    const badJson = { chat: async () => ({ choices: [{ message: { content: "不是 JSON" } }] }) };
    const c2 = makeContract(home, [{ id: "m2", label: "模型项", kind: "model", checker: null }]);
    activateContract(home, c2.id);
    const unparsed = await verifyContract(home, c2.id, scoreInput({}), { runner: badJson as never });
    expect(unparsed.attempt.items[0].status).toBe("skipped");
  } finally {
    cleanup(home);
  }
});

test("verify：--repeat 测 flaky，忽过忽不过不算通过、结论待定", async () => {
  const home = tempHome();
  try {
    const c = makeContract(home, [
      { id: "has-changes", label: "有改动", kind: "deterministic", checker: "has-changes" },
    ]);
    activateContract(home, c.id);
    let n = 0;
    const flakyRunner = () => {
      n += 1;
      const passed = n % 2 === 1;
      return { id: "has-changes", label: "有改动", passed, detail: passed ? "过" : "不过", evidence: null };
    };
    const attempt = await scoreContract(c, scoreInput({ changedFiles: ["a.md"], diffStat: "x" }), { repeat: 3, checkerRunner: flakyRunner });
    expect(attempt.items[0].status).toBe("flaky");
    expect(attempt.flaky).toBe(1);
    expect(attempt.verdict).toBe("pending");
  } finally {
    cleanup(home);
  }
});

test("一致性与每被接受任务成本：三次复核 2/3 一致，没计价返回 null", async () => {
  const home = tempHome();
  try {
    const c = makeContract(home, [{ id: "has-changes", label: "有改动", kind: "deterministic", checker: "has-changes" }]);
    activateContract(home, c.id);
    expect(contractConsistency(c).label).toBe("未验收过");
    expect(costPerAcceptedTask(home)).toBeNull();
    await verifyContract(home, c.id, scoreInput({ changedFiles: ["a.md"], diffStat: "x" }), { spentUsd: 0.02 });
    await verifyContract(home, c.id, scoreInput({ changedFiles: ["a.md"], diffStat: "x" }), { spentUsd: 0.04 });
    const after = getContract(home, c.id)!;
    expect(contractConsistency(after).label).toContain("2/2 一致");
    expect(costPerAcceptedTask(home)).toBeCloseTo(0.04);
    const stats = formatContractStats(home);
    expect(stats).toContain("已接受 1");
    expect(stats).toContain("$0.0400");
  } finally {
    cleanup(home);
  }
});

// ---- 运行报告顶部的契约三数 ----

test("formatRunReport：挂了契约写三数行，没挂不写", () => {
  const home = tempHome();
  try {
    const workdir = mkdtempSync(join(tmpdir(), "nyra-wd-"));
    const runId = makeRun(home, workdir);
    const store = new RunStore(join(home, "runs"));
    const plain = store.load(runId);
    expect(formatRunReport(plain as unknown as Record<string, unknown>)).not.toContain("交付契约");
    store.update(runId, {
      contract_id: "ct_abc", contract_hash: "h", contract_verdict: "accepted",
      contract_passed: 7, contract_total: 9,
    });
    const withContract = store.load(runId);
    const report = formatRunReport(
      withContract as unknown as Record<string, unknown>,
      undefined,
      { costPerAccepted: "$0.0400", consistency: "3/3 一致（最新结论：accepted）" },
    );
    expect(report).toContain("交付契约：ct_abc 检查通过 7/9，结论：已接受");
    expect(report).toContain("每被接受任务成本 $0.0400");
    expect(report).toContain("三次复核一致性 3/3 一致");
    const header = contractHeaderForRun(home, withContract as unknown as Record<string, unknown>);
    expect(header.passRate).toBe("7/9");
    expect(contractHeaderForRun(home, plain as unknown as Record<string, unknown>).passRate).toBeNull();
    cleanup(workdir);
  } finally {
    cleanup(home);
  }
});

// ---- CLI ----

test("CLI contract：create/list/show/activate/verify/mark-item/stats 全流程", async () => {
  const home = tempHome();
  try {
    const workdir = mkdtempSync(join(tmpdir(), "nyra-wd-"));
    writeFileSync(join(workdir, "a.md"), "x");
    const runId = makeRun(home, workdir);
    new RunStore(join(home, "runs")).update(runId, { changed_files: ["a.md"], file_hashes: { "a.md": "0123456789abcdef" } });
    expect(await handleContract(["create", "--task", "写说明", "--deliverable", "doc:说明文档", "--check", "deterministic:has-changes:有改动", "--check", "manual:human-check:人工看一眼"], home)).toBe(0);
    const created = (await import("../../src/contract.ts")).listContracts(home);
    expect(created.length).toBe(1);
    const id = created[0].id;
    expect(await handleContract(["list"], home)).toBe(0);
    expect(await handleContract(["show", id], home)).toBe(0);
    expect(await handleContract(["verify", id, "--run", runId], home)).toBe(1);
    expect(await handleContract(["mark-item", id, "human-check", "--pass", "--evidence", "看过了"], home)).toBe(0);
    expect(await handleContract(["activate", id, "--yes"], home)).toBe(0);
    expect(await handleContract(["attach", id, "--run", runId], home)).toBe(0);
    expect(await handleContract(["verify", id, "--run", runId], home)).toBe(0);
    expect(await handleContract(["stats"], home)).toBe(0);
    expect(await handleContract(["remove", id], home)).toBe(2);
    expect(await handleContract(["remove", id, "--yes"], home)).toBe(0);
    cleanup(workdir);
  } finally {
    cleanup(home);
  }
});

test("CLI contract：create 参数不对时报错返回 2", async () => {
  const home = tempHome();
  try {
    expect(await handleContract(["create", "--task", "t"], home)).toBe(1);
    expect(await handleContract(["bogus"], home)).toBe(2);
    expect(await handleContract([], home)).toBe(2);
  } finally {
    cleanup(home);
  }
});

test("CLI golden：add/list/run/rescore 全流程（假执行器，不调真模型）", async () => {
  const home = tempHome();
  try {
    const workdir = mkdtempSync(join(tmpdir(), "nyra-wd-"));
    const runId = makeRun(home, workdir);
    const store = new RunStore(join(home, "runs"));
    store.appendEvent(runId, "tool_start", { id: "t1", name: "write_file", args_hash: "a" });
    store.appendEvent(runId, "tool_start", { id: "t2", name: "shell", args_hash: "b" });
    expect(await handleGolden(["add", "--name", "写说明", "--input", "写说明", "--expect-output", "已完成", "--expect-tool", "write_file"], home)).toBe(0);
    const cases = (await import("../../src/golden.ts")).loadGoldenStore(home).cases;
    expect(cases.length).toBe(1);
    const caseId = cases[0].id;
    expect(await handleGolden(["list"], home)).toBe(0);
    expect(await handleGolden(["show", caseId], home)).toBe(0);
    expect(await handleGolden(["run"], home, async () => ({ output: "已完成", trajectory: ["write_file"], spentUsd: null }))).toBe(2);
    const fake = async () => ({ output: "已完成", trajectory: ["write_file"], spentUsd: 0.01 });
    expect(await handleGolden(["run", "--yes"], home, fake)).toBe(0);
    expect(await handleGolden(["rescore", "--run", runId, "--case", caseId], home)).toBe(1);
    expect(await handleGolden(["remove", caseId, "--yes"], home)).toBe(0);
    cleanup(workdir);
  } finally {
    cleanup(home);
  }
});
