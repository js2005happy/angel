// tests/node/test-nested-delegate.test.ts — H-7：嵌套编排 opt-in（缺口 13 深化）。
// 默认 flat（子 agent 不能再委派）+ orchestrator 角色显式开启 + 深度上限
// 默认 2（可配 1–5）+ 每层预算独立记账 + 防循环委派。全部用临时 home 与
// 假 provider，不连真实服务、不花真实 token；多 agent 场景只用假 provider。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent, DelegationBudget, resolveMaxDelegateDepth,
  MAX_DELEGATE_DEPTH, MAX_DELEGATE_CALLS,
} from "../../src/agent.ts";
import { fakeProvider } from "./fake-provider.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { registerSubagentRun } from "../../src/resume.ts";
import { buildRoster, getRosterDetail } from "../../src/roster.ts";
import { defaultSoul, saveSoul, setCharter } from "../../src/soul.ts";
import { createTeam, type Team } from "../../src/team.ts";
import { newToolContext, executeTool } from "../../src/tools.ts";

function tmpHome(prefix = "nyra-nested-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
function tmpWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "nyra-nested-wd-"));
}

function delegateCall(id: string, args: Record<string, unknown>): { id: string; type: string; function: { name: string; arguments: string } } {
  return { id, type: "function", function: { name: "delegate", arguments: JSON.stringify(args) } };
}

// ---- 常量与配置解析 ----

test("H-7：深度上限默认 2，可配 1–5，非法回 2", () => {
  expect(MAX_DELEGATE_DEPTH).toBe(2);
  expect(resolveMaxDelegateDepth(2)).toBe(2);
  expect(resolveMaxDelegateDepth(5)).toBe(5);
  expect(resolveMaxDelegateDepth(1)).toBe(1);
  expect(resolveMaxDelegateDepth(undefined)).toBe(2);
  expect(resolveMaxDelegateDepth(null)).toBe(2);
  expect(resolveMaxDelegateDepth("3")).toBe(2);
  expect(resolveMaxDelegateDepth(2.5)).toBe(2);
  expect(resolveMaxDelegateDepth(0)).toBe(1);
  expect(resolveMaxDelegateDepth(99)).toBe(5);
});

// ---- 每层独立记账的预算 ----

test("H-7：每层预算独立记账——第 0 层用完不影响第 1 层", () => {
  const budget = new DelegationBudget();
  expect(budget.remaining(0)).toBe(8);
  expect(budget.remaining(1)).toBe(8);
  expect(budget.remaining()).toBe(8);
  for (let i = 0; i < 8; i++) expect(budget.consume(0)).toBe(true);
  expect(budget.consume(0)).toBe(false);
  expect(budget.remaining(0)).toBe(0);
  expect(budget.remaining(1)).toBe(8);
  expect(budget.consume(1)).toBe(true);
  expect(budget.remaining(1)).toBe(7);
  expect(budget.layerUsage()).toEqual([
    { depth: 0, used: 8, remaining: 0 },
    { depth: 1, used: 1, remaining: 7 },
  ]);
  budget.reset();
  expect(budget.remaining(0)).toBe(8);
  expect(budget.remaining(1)).toBe(8);
  expect(budget.layerUsage()).toEqual([]);
});

// ---- flat 门与 orchestrator 门（直接调 delegateDetailed） ----

function flatChild(home: string, workdir: string, budget: DelegationBudget): Agent {
  return new Agent(fakeProvider([{ content: "子级完成。" }]) as never, {
    workdir, home, mode: "full", maxTurns: 3, interactive: false,
    sessionId: null, skillsDirs: [], checkpointStore: null,
    delegateDepth: 1, delegateBudget: budget,
  });
}

test("H-7：默认 flat——第 1 层没 orchestrator 角色就不能再委派", async () => {
  const home = tmpHome();
  const workdir = tmpWorkdir();
  const budget = new DelegationBudget();
  const child = flatChild(home, workdir, budget);
  const d = await child.delegateDetailed("再派给别人", 1, {});
  expect(d.ok).toBe(false);
  expect(d.text).toContain("flat");
  expect(d.text).toContain("orchestrator");
  // 被门拒绝不占预算。
  expect(budget.remaining(1)).toBe(8);
});

test("H-7：flat 门也拦 delegateParallel——一个线程都不启动", async () => {
  const home = tmpHome();
  const workdir = tmpWorkdir();
  const budget = new DelegationBudget();
  const child = flatChild(home, workdir, budget);
  const r = await child.delegateParallel([{ task: "甲" }, { task: "乙" }]);
  expect(r.rejected).toBe(2);
  expect(r.succeeded).toBe(0);
  expect(r.results.every((t) => (t.error ?? "").includes("flat"))).toBe(true);
  expect(budget.remaining(1)).toBe(8);
});

test("H-7：深度上限——第 2 层再委派直接被拒（orchestrator 也救不了）", async () => {
  const home = tmpHome();
  const workdir = tmpWorkdir();
  const budget = new DelegationBudget();
  const grandchild = new Agent(fakeProvider([{ content: "孙级完成。" }]) as never, {
    workdir, home, mode: "full", maxTurns: 3, interactive: false,
    sessionId: null, skillsDirs: [], checkpointStore: null,
    delegateDepth: 2, delegateBudget: budget, orchestrator: true,
  });
  const d = await grandchild.delegateDetailed("再派给别人", 1, {});
  expect(d.ok).toBe(false);
  expect(d.text).toContain("最大委派深度");
  expect(d.text).toContain("2");
  expect(budget.remaining(2)).toBe(8);
});

// ---- 拒绝进证据链（有监听器时） ----

test("H-7：flat 拒绝进证据链（delegate_rejected 事件）", async () => {
  const home = tmpHome();
  const workdir = tmpWorkdir();
  const seen: { kind: string; data: Record<string, unknown> }[] = [];
  const child = new Agent(fakeProvider([{ content: "子级完成。" }]) as never, {
    workdir, home, mode: "full", maxTurns: 3, interactive: false,
    sessionId: null, skillsDirs: [], checkpointStore: null,
    delegateDepth: 1, delegateBudget: new DelegationBudget(),
    onEvent: (kind, data) => { seen.push({ kind, data }); },
  });
  await child.delegateDetailed("再派给别人", 1, {});
  const rejected = seen.find((e) => e.kind === "delegate_rejected");
  expect(rejected).toBeDefined();
  expect(rejected?.data.depth).toBe(1);
  expect(String(rejected?.data.reason ?? "")).toContain("flat");
});

// ---- orchestrator 嵌套 + 每层预算独立（直接调 delegate） ----

test("H-7：orchestrator 孩子能再委派，且第 0/1 层预算互不挤占", async () => {
  const home = tmpHome();
  const workdir = tmpWorkdir();
  const budget = new DelegationBudget();
  const root = new Agent(fakeProvider([{ content: "收到，已完成。" }]) as never, {
    workdir, home, mode: "full", maxTurns: 3, interactive: false,
    sessionId: null, skillsDirs: [], checkpointStore: null,
    delegateBudget: budget,
  });
  // 根派一个 orchestrator 孩子（占第 0 层 1 个名额）。
  const c1 = await root.delegateDetailed("拆给子级", 1, { orchestrator: true });
  expect(c1.ok).toBe(true);
  expect(budget.remaining(0)).toBe(7);
  expect(budget.remaining(1)).toBe(8);
  // 孩子自己再派两个孙级（占第 1 层 2 个名额，第 0 层不动）。
  const child1 = new Agent(fakeProvider([{ content: "收到，已完成。" }]) as never, {
    workdir, home, mode: "full", maxTurns: 3, interactive: false,
    sessionId: null, skillsDirs: [], checkpointStore: null,
    delegateDepth: 1, delegateBudget: budget, orchestrator: true,
  });
  const g1 = await child1.delegateDetailed("孙任务一", 1, {});
  const g2 = await child1.delegateDetailed("孙任务二", 1, {});
  expect(g1.ok).toBe(true);
  expect(g2.ok).toBe(true);
  expect(budget.remaining(0)).toBe(7);
  expect(budget.remaining(1)).toBe(6);
  expect(budget.layerUsage()).toEqual([
    { depth: 0, used: 1, remaining: 7 },
    { depth: 1, used: 2, remaining: 6 },
  ]);
});

// ---- 端到端：模型循环里 orchestrator 嵌套跑通，深度上限处停下 ----

test("H-7：端到端——根→orchestrator 子级→孙级跑通，孙级再派被深度上限拦住且不烧模型调用", async () => {
  const home = tmpHome();
  const workdir = tmpWorkdir();
  const provider = fakeProvider([
    { toolCalls: [delegateCall("c1", { task: "拆给子级", orchestrator: true })] },
    { toolCalls: [delegateCall("c2", { task: "再拆给孙级", orchestrator: true })] },
    { toolCalls: [delegateCall("c3", { task: "再拆一层" })] },
    { content: "孙级完成。" },
    { content: "子级完成。" },
    { content: "根完成。" },
  ]);
  const root = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 6, interactive: false,
    sessionId: null, skillsDirs: [], checkpointStore: null,
  });
  const out = await root.run("把任务拆下去做");
  expect(out).toBe("根完成。");
  // 6 次模型调用：根、子级、孙级各两次（工具调用 + 收尾）；被深度上限拦住
  // 的那次委派没到模型（delegateDetailed 里直接拒绝，不调 chat）。
  expect(provider.calls).toBe(6);
});

// ---- 团队模式：orchestrator 成员能再分派，循环委派被拒 ----

function charterInput(): Record<string, unknown> {
  return {
    own: "负责写周报",
    sources: ["任务板", "上周周报"],
    output: "以 `## 结论` 开头，附三条要点",
    approval: "对外发送前须人批",
    stop: "缺关键数据时停下问人",
  };
}

function makeSoul(home: string, agent: string): void {
  saveSoul(home, defaultSoul(agent));
  setCharter(home, agent, charterInput());
}

function makeTeam(home: string): Team {
  makeSoul(home, "chief1");
  makeSoul(home, "member1");
  makeSoul(home, "member2");
  return createTeam(home, { name: "alpha", chief: "chief1", members: ["member1", "member2"] });
}

test("H-7：团队模式——没 orchestrator 的成员仍不能分派；有 orchestrator 的成员能再分派", async () => {
  const home = tmpHome();
  const team = makeTeam(home);
  const workdir = tmpWorkdir();
  const member = new Agent(fakeProvider([{ content: "## 结论\n成员完成。" }]) as never, {
    workdir, home, mode: "full", maxTurns: 3, interactive: false,
    sessionId: null, skillsDirs: [], checkpointStore: null,
    soulAgent: "member1", teamId: team.id, teamRole: "member",
    delegateDepth: 1, delegateBudget: new DelegationBudget(),
  });
  const flat = await member.delegateDetailed("再派给别人", 1, { agent: "member2" });
  expect(flat.ok).toBe(false);
  expect(flat.text).toContain("只有参谋长能分派");
  // 同一个成员拿到 orchestrator 角色就能再往下分派（仍须指定 agent、仍须 Charter）。
  const orch = new Agent(fakeProvider([{ content: "## 结论\n成员完成。" }]) as never, {
    workdir, home, mode: "full", maxTurns: 3, interactive: false,
    sessionId: null, skillsDirs: [], checkpointStore: null,
    soulAgent: "member1", teamId: team.id, teamRole: "member",
    delegateDepth: 1, delegateBudget: new DelegationBudget(), orchestrator: true,
  });
  const ok = await orch.delegateDetailed("派给 member2", 1, { agent: "member2" });
  expect(ok.ok).toBe(true);
  expect(ok.text).toContain("charter_valid: true");
});

test("H-7：团队模式——循环委派被拒（A 派 B、B 派 A），且不占预算", async () => {
  const home = tmpHome();
  const team = makeTeam(home);
  const workdir = tmpWorkdir();
  const provider = fakeProvider([
    { toolCalls: [delegateCall("c1", { task: "给 member1", agent: "member1", orchestrator: true })] },
    { toolCalls: [delegateCall("c2", { task: "给 member2", agent: "member2", orchestrator: true })] },
    { toolCalls: [delegateCall("c3", { task: "回给 member1", agent: "member1" })] },
    { content: "## 结论\nmember2 完成。" },
    { content: "## 结论\nmember1 完成。" },
    { content: "参谋长完成。" },
  ]);
  const chief = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 6, interactive: false,
    sessionId: null, skillsDirs: [], checkpointStore: null,
    soulAgent: "chief1", teamId: team.id, teamRole: "chief",
  });
  const out = await chief.run("把任务分下去做");
  expect(out).toBe("参谋长完成。");
  // 被循环门拦住的那次委派没到模型。
  expect(provider.calls).toBe(6);
});

// ---- 工具层透传 ----

test("H-7：工具层 delegate 的 orchestrator 参数透传到 delegateDetailed", async () => {
  const seen: Record<string, unknown>[] = [];
  const ctx = newToolContext({
    workdir: tmpWorkdir(), mode: "full", home: tmpHome(), interactive: false,
    delegateFn: async (_task, _maxTurns, opts) => {
      seen.push({ ...(opts ?? {}) });
      return "收到。";
    },
  });
  const out = await executeTool("delegate", { task: "拆下去", orchestrator: true }, ctx);
  expect(out).toBe("收到。");
  expect(seen[0]?.orchestrator).toBe(true);
  const out2 = await executeTool("delegate", { task: "拆下去" }, ctx);
  expect(out2).toBe("收到。");
  expect(seen[1]?.orchestrator).toBeUndefined();
});

test("H-7：工具层 delegate_parallel 每条线程的 orchestrator 透传", async () => {
  const captured: { task: string; orchestrator?: boolean }[] = [];
  const ctx = newToolContext({
    workdir: tmpWorkdir(), mode: "full", home: tmpHome(), interactive: false,
    delegateParallelFn: async (tasks) => {
      for (const t of tasks) captured.push({ task: t.task, orchestrator: t.orchestrator });
      return "并行完成。";
    },
  });
  const out = await executeTool(
    "delegate_parallel",
    { tasks: [{ task: "甲", orchestrator: true }, { task: "乙" }], background: false },
    ctx,
  );
  expect(out).toBe("并行完成。");
  expect(captured).toEqual([
    { task: "甲", orchestrator: true },
    { task: "乙", orchestrator: undefined },
  ]);
});

// ---- 注册表层级与花名册 ----

test("H-7：注册表记委派层级，花名册详情里看得到", () => {
  const home = tmpHome();
  registerSubagentRun(home, { runId: "task-root", agent: "nyra", delegateDepth: 1 });
  registerSubagentRun(home, { runId: "task-child", agent: "nyra", parentRunId: "task-root", delegateDepth: 2 });
  const rows = buildRoster(home);
  expect(rows.length).toBe(2);
  const child = rows.find((r) => r.id === "task-child");
  expect(child?.depth).toBe(1);
  expect(child?.delegateDepth).toBe(2);
  const detail = getRosterDetail(home, "task-child");
  expect(detail.row.delegateDepth).toBe(2);
});

// ---- 事件注册与时间线渲染 ----

test("H-7：delegate_rejected 已注册（appendEvent 不抛错），delegate_start 新字段时间线能渲染", () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  // 没注册进 EVENT_FIELDS 会抛错（见 appendEvent 的守卫）。
  expect(() => store.appendEvent(state.run_id, "delegate_rejected", { task_id: "task-bbbb", reason: "循环委派被拒绝", depth: 1 })).not.toThrow();
  store.appendEvent(state.run_id, "delegate_start", { task_id: "task-aaaa", model: "fake-1", max_turns: 3, depth: 2, layer_remaining: 6 });
  const text = formatTimelineText(buildTimeline(store, state.run_id), { verbose: true });
  expect(text).toContain("第 2 层");
  expect(text).toContain("本层预算剩 6");
  expect(text).toContain("委派被拒");
  expect(text).toContain("循环委派被拒绝");
});
