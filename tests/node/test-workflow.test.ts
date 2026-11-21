// tests/node/test-workflow.test.ts — 缺口 25 第一批：声明式工作流 DSL + 固定图执行。
//
// 覆盖：YAML 子集解析、DSL 校验、条件求值、模板渲染、dry-run 计划与哈希验证、
// 固定图执行（tool / llm / for_each / parallel / if 跳过）、审批挂起与续跑、
// 成本硬顶、试跑→激活两道门、注册表/运行账本（损坏备份、上限 200）、
// 运行事件注册（EVENT_FIELDS）与时间线渲染。全部在临时 home 里跑，不碰真模型
// （llm / delegate 节点用假 provider），不碰真文件系统外的东西。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkflowText,
  parseWorkflowDefinition,
  validateWorkflowDefinition,
  evalCondition,
  renderTemplate,
  dryRunPlan,
  verifyDryRunPlan,
  importWorkflow,
  runWorkflowByName,
  dryRunWorkflowByName,
  trialWorkflow,
  activateWorkflow,
  removeWorkflow,
  resumeWorkflow,
  getWorkflowRun,
  loadWorkflowRegistry,
  loadWorkflowRuns,
  saveWorkflowRun,
  handleWorkflow,
  WorkflowError,
} from "../../src/workflow.ts";
import type { WorkflowDefinition, WorkflowRun, WorkflowRunRequest } from "../../src/workflow.ts";
import { decideReviewItem, getReviewItem } from "../../src/reviewQueue.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { UsageLedger, monthKeyString } from "../../src/usageLedger.ts";
import type { ProviderLike } from "../../src/providers.ts";

function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "nyra-wf-test-"));
  mkdirSync(join(h, "workflows"), { recursive: true });
  return h;
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function fakeProvider(): ProviderLike {
  return {
    name: "fake",
    model: "fake-model",
    baseUrl: "",
    hasCredentials: () => true,
    chat: async () => ({
      choices: [{ message: { content: "FAKE-REPLY" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    listModels: async () => ["fake-model"],
    redact: (t: string) => t,
  };
}

function reqFor(home: string, maxCostUsd?: number): WorkflowRunRequest {
  return {
    workdir: home,
    mode: "normal",
    interactive: false,
    providerFactory: async () => fakeProvider(),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
  };
}

function writePricing(home: string): void {
  writeFileSync(join(home, "config.json"), JSON.stringify({
    pricing: { "fake-model": { input_per_1m: 100, output_per_1m: 200 } },
  }));
}

const TOOL_DEF: WorkflowDefinition = {
  name: "读文件",
  version: 1,
  mode: "fixed",
  steps: [{ id: "read", type: "tool", tool: "read_file", args: { path: "{{inputs.file}}" } }],
};

function toolDefYaml(fileVar = "{{inputs.file}}"): string {
  return [
    "name: 读文件",
    "version: 1",
    "mode: fixed",
    "inputs:",
    "  file: /tmp/x.txt",
    "steps:",
    "  - id: read",
    "    type: tool",
    "    tool: read_file",
    "    args:",
    `      path: ${fileVar}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// YAML 子集解析
// ---------------------------------------------------------------------------

test("YAML：嵌套映射/列表/块标量/引号/注释/数字布尔都能解析", () => {
  const text = [
    "# 注释行",
    "name: 读文件  # 行尾注释",
    "version: 1",
    "enabled: true",
    "ratio: 1.5",
    "description: |",
    "  第一行",
    "  第二行",
    "steps:",
    "  - id: a",
    "    type: tool",
    "    tool: read_file",
    "    args:",
    "      path: '/tmp/a.txt'",
    "  - id: b",
    "    type: llm",
    '    prompt: "say \\"hi\\""',
    "",
  ].join("\n");
  const v = parseWorkflowText(text, "w.yaml") as Record<string, unknown>;
  expect(v.name).toBe("读文件");
  expect(v.enabled).toBe(true);
  expect(v.ratio).toBe(1.5);
  expect(v.description).toBe("第一行\n第二行\n");
  const steps = v.steps as Array<Record<string, unknown>>;
  expect(steps).toHaveLength(2);
  expect((steps[0].args as Record<string, unknown>).path).toBe("/tmp/a.txt");
  expect(steps[1].prompt).toBe('say "hi"');
});

test("YAML：Tab 缩进、flow 风格、锚点、重复键、缩进不一致都拒绝", () => {
  expect(() => parseWorkflowText("name: x\n\tversion: 1\n", "w.yaml")).toThrow(WorkflowError);
  expect(() => parseWorkflowText("steps: [{id: a}]\n", "w.yaml")).toThrow(WorkflowError);
  expect(() => parseWorkflowText("name: &a x\nversion: *a\n", "w.yaml")).toThrow(WorkflowError);
  expect(() => parseWorkflowText("name: a\nname: b\n", "w.yaml")).toThrow(WorkflowError);
  expect(() => parseWorkflowText("steps:\n  - id: a\n   type: tool\n", "w.yaml")).toThrow(WorkflowError);
  expect(() => parseWorkflowText("", "w.yaml")).toThrow(WorkflowError);
});

test("YAML：.json 走 JSON.parse", () => {
  const v = parseWorkflowText('{"name": "读文件", "version": 1}', "w.json") as Record<string, unknown>;
  expect(v.name).toBe("读文件");
  expect(() => parseWorkflowText("{bad json", "w.json")).toThrow(WorkflowError);
});

test("YAML：双引号里的 Windows 路径反转义不丢反斜杠（CI #491）", () => {
  // defToYaml 用 JSON.stringify 给字符串加双引号：Windows 路径里的 \\n / \\t
  // 是“转义反斜杠 + 字母”，绝不能先当成换行/制表符读掉。旧实现是顺序 replace
  // 链（先 \\n/\\t、最后才折叠 \\\\），"\\nyra-wf-test-..." 里的第二个反斜杠
  // 会跟 n 拼成换行，路径被改写，Windows 上整轮 run 失败。
  const winPaths = [
    "C:\\Users\\runner\\AppData\\Local\\Temp\\nyra-wf-test-abc\\a.txt",
    "C:\\test\\tmp\\new.txt",
    "D:\\work\\notes\\todo.txt",
  ];
  const text = [
    "name: win",
    "version: 1",
    "mode: fixed",
    "inputs:",
    ...winPaths.map((p, i) => `  p${i}: ${JSON.stringify(p)}`),
    "steps:",
    "  - id: r",
    "    type: tool",
    "    tool: read_file",
    "    args:",
    `      path: ${JSON.stringify(winPaths[0])}`,
    "",
  ].join("\n");
  const def = parseWorkflowDefinition(text, "w.yaml", new Set(["read_file"]));
  const inputs = def.inputs as Record<string, unknown>;
  winPaths.forEach((p, i) => expect(inputs[`p${i}`]).toBe(p));
  expect((def.steps[0].args as Record<string, unknown>).path).toBe(winPaths[0]);
});

test("YAML：双引号转义单遍处理（回车、引号、unicode、反斜杠）", () => {
  const line = '    prompt: "a\\rb\\"c\\u0041\\\\d"';
  const text = ["name: esc", "version: 1", "mode: fixed", "steps:", "  - id: a", "    type: llm", line, ""].join("\n");
  const def = parseWorkflowDefinition(text, "w.yaml");
  expect(def.steps[0].prompt).toBe("a\rb\"cA\\d");
});

test("YAML：导入后重读定义，Windows 路径原样保存（CI #491）", async () => {
  const home = tempHome();
  try {
    const winPath = "C:\\Users\\runner\\AppData\\Local\\Temp\\nyra-wf-test-abc\\a.txt";
    const def: WorkflowDefinition = {
      name: "读文件", version: 1, mode: "fixed",
      inputs: { file: winPath },
      steps: [{ id: "read", type: "tool", tool: "read_file", args: { path: "{{inputs.file}}" } }],
    };
    const ret = await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    const stored = parseWorkflowDefinition(readFileSync(join(home, "workflows", ret.file), "utf-8"), ret.file, new Set(["read_file"]));
    expect((stored.inputs as Record<string, unknown>).file).toBe(winPath);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// DSL 校验
// ---------------------------------------------------------------------------

test("校验：最小合法定义通过；mode coordinator/dynamic 明确提示后续批次", () => {
  expect(validateWorkflowDefinition({ ...TOOL_DEF }).name).toBe("读文件");
  expect(() => validateWorkflowDefinition({ ...TOOL_DEF, mode: "coordinator" })).toThrow(/后续批次/);
  expect(() => validateWorkflowDefinition({ ...TOOL_DEF, mode: "dynamic" })).toThrow(/后续批次/);
  expect(() => validateWorkflowDefinition({ ...TOOL_DEF, mode: "other" })).toThrow(WorkflowError);
});

test("校验：重复步骤 id、未知工具、坏 cron、超限都拒绝", () => {
  const dup: WorkflowDefinition = { ...TOOL_DEF, steps: [TOOL_DEF.steps[0], TOOL_DEF.steps[0]] };
  expect(() => validateWorkflowDefinition(dup)).toThrow(/重复/);
  expect(() => validateWorkflowDefinition(TOOL_DEF, new Set(["other_tool"]))).toThrow(/未知工具/);
  expect(() => validateWorkflowDefinition({ ...TOOL_DEF, triggers: [{ type: "schedule", cron: "not a cron" }] })).toThrow(/cron/);
  expect(() => validateWorkflowDefinition({ ...TOOL_DEF, triggers: [{ type: "schedule", cron: "0 9 * * *" }] })).not.toThrow();
  const many = { ...TOOL_DEF, steps: Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, type: "tool" as const, tool: "read_file", args: { path: "/tmp/x" } })) };
  expect(() => validateWorkflowDefinition(many)).toThrow(/超过 50/);
});

test("校验：审批节点不许放并行分支与循环里；parallel 分支数 2–8", () => {
  const inParallel: WorkflowDefinition = {
    name: "审批放错地方", version: 1, mode: "fixed",
    steps: [{ id: "p", type: "parallel", branches: [[{ id: "a", type: "approve", title: "批一下" }], [{ id: "b", type: "tool", tool: "read_file", args: { path: "/tmp/x" } }]] }],
  };
  expect(() => validateWorkflowDefinition(inParallel)).toThrow(/只认顶层步骤/);
  const inLoop: WorkflowDefinition = {
    name: "审批放循环", version: 1, mode: "fixed",
    steps: [{ id: "a", type: "approve", title: "批一下", for_each: { items: "{{inputs.x}}", as: "item" } }],
  };
  expect(() => validateWorkflowDefinition(inLoop)).toThrow(/不支持放在循环/);
  const oneBranch: WorkflowDefinition = {
    name: "一个分支", version: 1, mode: "fixed",
    steps: [{ id: "p", type: "parallel", branches: [[{ id: "b", type: "tool", tool: "read_file", args: { path: "/tmp/x" } }]] }],
  };
  expect(() => validateWorkflowDefinition(oneBranch)).toThrow(/2–8/);
});

// ---------------------------------------------------------------------------
// 条件与模板
// ---------------------------------------------------------------------------

test("条件：==/!=/比较/contains/and/or/not/括号都按预期求值", () => {
  const scope = { inputs: { n: 3, s: "hello world", flag: true }, steps: { a: { output: "done", ok: true, approved: null, spent_usd: null } }, loop: {} };
  expect(evalCondition("inputs.n > 2 and inputs.flag", scope)).toBe(true);
  expect(evalCondition("inputs.s contains 'world'", scope)).toBe(true);
  expect(evalCondition("steps.a.output == 'done'", scope)).toBe(true);
  expect(evalCondition("not inputs.flag or inputs.n == 3", scope)).toBe(true);
  expect(evalCondition("(inputs.n < 2 or inputs.n > 5) and inputs.flag", scope)).toBe(false);
  expect(evalCondition("inputs.n != 4", scope)).toBe(true);
});

test("条件：未知变量、类型不匹配、非布尔结果都抛错（不静默当 false）", () => {
  const scope = { inputs: { s: "abc" }, steps: {}, loop: {} };
  expect(() => evalCondition("inputs.missing == 1", scope)).toThrow(/不存在/);
  expect(() => evalCondition("inputs.s > 2", scope)).toThrow(/须是数字/);
  expect(() => evalCondition("inputs.s", scope)).toThrow(/须是布尔值/);
});

test("模板：整串占位符返回原始值（数组不被串化），嵌入式串化，未知变量抛错", () => {
  const scope = { inputs: { list: [1, 2] as unknown, name: "nyra" }, steps: { a: { output: "out", ok: true, approved: null, spent_usd: null } }, loop: { item: "x", index: 0 } };
  expect(renderTemplate("{{inputs.list}}", scope)).toEqual([1, 2]);
  expect(renderTemplate("hi {{inputs.name}} {{loop.index}}", scope)).toBe("hi nyra 0");
  expect(renderTemplate("{{steps.a.output}}-done", scope)).toBe("out-done");
  expect(() => renderTemplate("{{inputs.nope}}", scope)).toThrow(/不存在/);
});

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

test("dry-run：工具节点按读写分类，模型节点标无法枚举，哈希稳定且可验证", async () => {
  const home = tempHome();
  try {
    const def: WorkflowDefinition = {
      name: "计划", version: 1, mode: "fixed",
      steps: [
        { id: "r", type: "tool", tool: "read_file", args: { path: "/tmp/x" } },
        { id: "w", type: "tool", tool: "write_file", args: { path: "/tmp/y", content: "hi" } },
        { id: "m", type: "llm", prompt: "总结一下" },
        { id: "k", type: "knowledge", base: "kb", query: "nyra" },
      ],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    const { plan } = dryRunWorkflowByName(home, "计划", {});
    expect(plan.actions.map((a) => a.kind)).toEqual(["read", "write", "unknown-model-action", "read"]);
    expect(plan.actions[2].detail).toContain("无法枚举");
    expect(dryRunPlan(def, {}).hash).toBe(plan.hash);
  } finally {
    cleanup(home);
  }
});

test("dry-run：verify 用定义快照重算哈希，改过定义就失败", () => {
  const home = tempHome();
  try {
    const def: WorkflowDefinition = {
      name: "计划", version: 1, mode: "fixed",
      steps: [{ id: "r", type: "tool", tool: "read_file", args: { path: "/tmp/x" } }],
    };
    const plan = dryRunPlan(def, {});
    const run: WorkflowRun = {
      id: "20261121-120000-abcdef", workflow: "计划", status: "completed", inputs: {},
      definition: def, nodes: [], spentUsd: 0, startedAt: "2026-11-21T12:00:00Z", endedAt: "2026-11-21T12:00:01Z",
      dryRun: true, trial: false, error: null, pendingNodeId: null, pendingNodeIndex: null,
      reviewItemId: null, dryRunPlanHash: plan.hash,
    };
    saveWorkflowRun(home, run);
    expect(verifyDryRunPlan(run).ok).toBe(true);
    const tampered: WorkflowRun = { ...run, definition: { ...def, steps: [{ id: "r", type: "tool", tool: "list_dir", args: { path: "/tmp" } }] } };
    expect(verifyDryRunPlan(tampered).ok).toBe(false);
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 执行：tool / llm / if / for_each / parallel
// ---------------------------------------------------------------------------

test("执行：tool 节点读真文件，输出与耗时进账本", async () => {
  const home = tempHome();
  try {
    const file = join(home, "hello.txt");
    writeFileSync(file, "hello workflow");
    await importWorkflow(home, writeDefFile(home, toolDefYaml()));
    const run = await runWorkflowByName(home, "读文件", { file }, reqFor(home));
    expect(run.status).toBe("completed");
    expect(run.nodes).toHaveLength(1);
    expect(run.nodes[0].output).toContain("hello workflow");
    expect(run.nodes[0].ms).toBeGreaterThanOrEqual(0);
    expect(getWorkflowRun(home, run.id)?.status).toBe("completed");
  } finally {
    cleanup(home);
  }
});

test("执行：llm 节点用假 provider，成本按单价表算并进月度账本", async () => {
  const home = tempHome();
  try {
    writePricing(home);
    const def: WorkflowDefinition = {
      name: "问一句", version: 1, mode: "fixed",
      steps: [{ id: "ask", type: "llm", prompt: "你好" }],
    };
    const file = writeDefFile(home, defToYaml(def));
    await importWorkflow(home, file);
    const run = await runWorkflowByName(home, "问一句", {}, reqFor(home));
    expect(run.status).toBe("completed");
    expect(run.nodes[0].output).toBe("FAKE-REPLY");
    // 10 输入 token × $100/百万 + 5 输出 token × $200/百万 = $0.002
    expect(run.nodes[0].spentUsd).toBeCloseTo(0.002, 6);
    expect(new UsageLedger(home).monthTotal(monthKeyString(new Date())).spentUsd).toBeCloseTo(0.002, 6);
  } finally {
    cleanup(home);
  }
});

test("执行：if 为假跳过节点；for_each 循环读 JSON 数组里的每个文件", async () => {
  const home = tempHome();
  try {
    const f1 = join(home, "a.txt");
    const f2 = join(home, "b.txt");
    writeFileSync(f1, "AAA");
    writeFileSync(f2, "BBB");
    const listFile = join(home, "list.json");
    writeFileSync(listFile, JSON.stringify([f1, f2]));
    const def: WorkflowDefinition = {
      name: "循环读", version: 1, mode: "fixed",
      inputs: { list_file: listFile },
      steps: [
        { id: "skipme", type: "tool", tool: "read_file", args: { path: f1 }, if: "inputs.list_file == 'nope'" },
        { id: "fetch", type: "tool", tool: "read_file", args: { path: "{{inputs.list_file}}" } },
        { id: "each", type: "tool", tool: "read_file", args: { path: "{{loop.item}}" }, for_each: { items: "{{steps.fetch.output}}", as: "item" } },
      ],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    const run = await runWorkflowByName(home, "循环读", {}, reqFor(home));
    expect(run.status).toBe("completed");
    expect(run.nodes.find((n) => n.id === "skipme")?.status).toBe("skipped");
    expect(run.nodes.filter((n) => n.id.startsWith("each["))).toHaveLength(2);
    expect(run.nodes.find((n) => n.id === "each[0]")?.output).toContain("AAA");
    expect(run.nodes.find((n) => n.id === "each[1]")?.output).toContain("BBB");
  } finally {
    cleanup(home);
  }
});

test("执行：parallel 两分支都跑，任一分支失败则整个节点失败", async () => {
  const home = tempHome();
  try {
    const f1 = join(home, "a.txt");
    writeFileSync(f1, "AAA");
    const okDef: WorkflowDefinition = {
      name: "并行", version: 1, mode: "fixed",
      steps: [{
        id: "p", type: "parallel",
        branches: [
          [{ id: "b1", type: "tool", tool: "read_file", args: { path: f1 } }],
          [{ id: "b2", type: "tool", tool: "read_file", args: { path: f1 } }],
        ],
      }],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(okDef)));
    const okRun = await runWorkflowByName(home, "并行", {}, reqFor(home));
    expect(okRun.status).toBe("completed");
    expect(okRun.nodes.find((n) => n.id === "b1")?.output).toContain("AAA");
    expect(okRun.nodes.find((n) => n.id === "b2")?.output).toContain("AAA");
    expect(okRun.nodes.find((n) => n.id === "p")?.status).toBe("ok");

    const failDef: WorkflowDefinition = {
      name: "并行失败", version: 1, mode: "fixed",
      steps: [{
        id: "p", type: "parallel",
        branches: [
          [{ id: "b1", type: "tool", tool: "read_file", args: { path: f1 } }],
          [{ id: "b2", type: "tool", tool: "read_file", args: { path: "/tmp/does-not-exist-nyra-wf.txt" } }],
        ],
      }],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(failDef)));
    const failRun = await runWorkflowByName(home, "并行失败", {}, reqFor(home));
    expect(failRun.status).toBe("failed");
  } finally {
    cleanup(home);
  }
});

test("执行：超 --max-cost 即停，运行标失败", async () => {
  const home = tempHome();
  try {
    writePricing(home);
    const def: WorkflowDefinition = {
      name: "贵问题", version: 1, mode: "fixed",
      steps: [{ id: "ask", type: "llm", prompt: "你好" }],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    const run = await runWorkflowByName(home, "贵问题", {}, reqFor(home, 0.001));
    expect(run.status).toBe("failed");
    expect(run.error).toContain("成本上限已超");
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// 审批挂起与续跑
// ---------------------------------------------------------------------------

test("审批：跑到 approve 节点挂起，批复后 resume 续跑；拒绝+skip 跳过继续", async () => {
  const home = tempHome();
  try {
    const f1 = join(home, "a.txt");
    writeFileSync(f1, "AAA");
    const def: WorkflowDefinition = {
      name: "要批的", version: 1, mode: "fixed",
      steps: [
        { id: "a", type: "approve", title: "看一眼再继续", on_reject: "skip" },
        { id: "r", type: "tool", tool: "read_file", args: { path: f1 } },
      ],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(def)));
    const run = await runWorkflowByName(home, "要批的", {}, reqFor(home));
    expect(run.status).toBe("awaiting_approval");
    expect(run.pendingNodeId).toBe("a");
    expect(run.reviewItemId).toBeTruthy();
    expect(getReviewItem(home, run.reviewItemId!).status).toBe("pending");

    // 还没批复就 resume：拒绝续跑
    await expect(resumeWorkflow(home, run.id, reqFor(home))).rejects.toThrow(/还没批复/);

    decideReviewItem(home, run.reviewItemId!, "approved", { by: "test" });
    const resumed = await resumeWorkflow(home, run.id, reqFor(home));
    expect(resumed.status).toBe("completed");
    expect(resumed.nodes.find((n) => n.id === "a")?.approved).toBe(true);
    expect(resumed.nodes.find((n) => n.id === "r")?.output).toContain("AAA");
  } finally {
    cleanup(home);
  }
});

test("审批：拒绝+skip 跳过审批节点继续跑；拒绝+fail 整轮失败", async () => {
  const home = tempHome();
  try {
    const f1 = join(home, "a.txt");
    writeFileSync(f1, "AAA");
    const skipDef: WorkflowDefinition = {
      name: "拒了跳过", version: 1, mode: "fixed",
      steps: [
        { id: "a", type: "approve", title: "看一眼", on_reject: "skip" },
        { id: "r", type: "tool", tool: "read_file", args: { path: f1 } },
      ],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(skipDef)));
    const run1 = await runWorkflowByName(home, "拒了跳过", {}, reqFor(home));
    decideReviewItem(home, run1.reviewItemId!, "rejected", { by: "test" });
    const resumed1 = await resumeWorkflow(home, run1.id, reqFor(home));
    expect(resumed1.status).toBe("completed");
    expect(resumed1.nodes.find((n) => n.id === "a")?.status).toBe("skipped");

    const failDef: WorkflowDefinition = {
      name: "拒了就停", version: 1, mode: "fixed",
      steps: [
        { id: "a", type: "approve", title: "看一眼" },
        { id: "r", type: "tool", tool: "read_file", args: { path: f1 } },
      ],
    };
    await importWorkflow(home, writeDefFile(home, defToYaml(failDef)));
    const run2 = await runWorkflowByName(home, "拒了就停", {}, reqFor(home));
    decideReviewItem(home, run2.reviewItemId!, "rejected", { by: "test" });
    const resumed2 = await resumeWorkflow(home, run2.id, reqFor(home));
    expect(resumed2.status).toBe("failed");
    expect(resumed2.error).toContain("被拒绝");
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// import / trial / activate / remove 两道门
// ---------------------------------------------------------------------------

test("两道门：import 校验工具名；trial 须 --yes；激活前须试跑通过", async () => {
  const home = tempHome();
  try {
    const badYaml = [
      "name: 坏工具",
      "version: 1",
      "mode: fixed",
      "steps:",
      "  - id: x",
      "    type: tool",
      "    tool: no_such_tool_xyz",
      "",
    ].join("\n");
    await expect(importWorkflow(home, writeDefFile(home, badYaml, "bad.yaml"))).rejects.toThrow(/未知工具/);

    await importWorkflow(home, writeDefFile(home, toolDefYaml()));
    await expect(trialWorkflow(home, "读文件", {}, reqFor(home), false)).rejects.toThrow(/--yes/);
    expect(() => activateWorkflow(home, "读文件", true)).toThrow(/还没试跑通过/);
    expect(() => activateWorkflow(home, "读文件", false)).toThrow(/--yes/);

    const file = join(home, "t.txt");
    writeFileSync(file, "trial-ok");
    const trialRun = await trialWorkflow(home, "读文件", { file }, reqFor(home), true);
    expect(trialRun.status).toBe("completed");
    expect(trialRun.trial).toBe(true);
    expect(loadWorkflowRegistry(home).workflows.find((w) => w.name === "读文件")?.status).toBe("trial_passed");
    const entry = activateWorkflow(home, "读文件", true);
    expect(entry.status).toBe("active");

    await expect(importWorkflow(home, writeDefFile(home, toolDefYaml()))).rejects.toThrow(/已存在/);
    removeWorkflow(home, "读文件", true);
    expect(loadWorkflowRegistry(home).workflows).toHaveLength(0);
    expect(() => removeWorkflow(home, "读文件", true)).toThrow(/没有这个工作流/);
  } finally {
    cleanup(home);
  }
});

test("账本：注册表损坏先备份再抛错；运行账本上限 200 条", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, "workflows.json"), "this is not json{");
    expect(() => loadWorkflowRegistry(home)).toThrow(/账本损坏/);
    const files = readdirSync(home);
    expect(files.some((f) => f.startsWith("workflows.json.corrupt-"))).toBe(true);
    const backup = files.find((f) => f.startsWith("workflows.json.corrupt-"))!;
    expect(readFileSync(join(home, backup), "utf-8")).toContain("this is not json");
  } finally {
    cleanup(home);
  }
  const home2 = tempHome();
  try {
    for (let i = 0; i < 205; i++) {
      saveWorkflowRun(home2, {
        id: `20261121-120000-${String(i).padStart(6, "0")}`, workflow: "x", status: "completed", inputs: {},
        definition: TOOL_DEF, nodes: [], spentUsd: 0, startedAt: "2026-11-21T12:00:00Z", endedAt: "2026-11-21T12:00:01Z",
        dryRun: false, trial: false, error: null, pendingNodeId: null, pendingNodeIndex: null,
        reviewItemId: null, dryRunPlanHash: null,
      });
    }
    expect(loadWorkflowRuns(home2).runs).toHaveLength(200);
  } finally {
    cleanup(home2);
  }
});

// ---------------------------------------------------------------------------
// 运行事件注册与时间线渲染
// ---------------------------------------------------------------------------

test("事件：五个工作流事件类型已注册（appendEvent 不抛错），未知类型抛错", () => {
  const home = tempHome();
  try {
    const store = new RunStore(join(home, "runs"));
    const st = store.create("测试", "test-session", home, "normal", 1);
    expect(() => store.appendEvent(st.run_id, "workflow_node", { node_id: "a", node_type: "tool", status: "ok", ms: 3, spent_usd: null })).not.toThrow();
    expect(() => store.appendEvent(st.run_id, "workflow_started", { workflow: "读文件", dry_run: false, trial: false })).not.toThrow();
    expect(() => store.appendEvent(st.run_id, "workflow_awaiting_approval", { node_id: "a", review_item_id: "rv-1" })).not.toThrow();
    expect(() => store.appendEvent(st.run_id, "workflow_completed", { spent_usd: 0, nodes: 1 })).not.toThrow();
    expect(() => store.appendEvent(st.run_id, "workflow_failed", { error: "boom" })).not.toThrow();
    expect(() => store.appendEvent(st.run_id, "workflow_nope", {})).toThrow();
  } finally {
    cleanup(home);
  }
});

test("时间线：真实工作流运行的事件能在时间线里看到", async () => {
  const home = tempHome();
  try {
    const file = join(home, "hello.txt");
    writeFileSync(file, "hello timeline");
    await importWorkflow(home, writeDefFile(home, toolDefYaml()));
    const run = await runWorkflowByName(home, "读文件", { file }, reqFor(home));
    expect(run.status).toBe("completed");
    const store = new RunStore(join(home, "runs"));
    const storeRun = store.list().find((s) => s.session_id === `workflow-${run.id}`);
    expect(storeRun).toBeTruthy();
    const tl = buildTimeline(store, storeRun!.run_id);
    const text = formatTimelineText(tl);
    expect(text).toContain("工作流");
    expect(text).toContain("read");
  } finally {
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// CLI 处理器（不经过浏览器，只测动作分发与退出码）
// ---------------------------------------------------------------------------

test("CLI：list/show/import/run 分发与退出码", async () => {
  const home = tempHome();
  try {
    const origWrite = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    let out = "";
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
    try {
      expect(await handleWorkflow([], home)).toBe(2);
      expect(await handleWorkflow(["bogus"], home)).toBe(2);
      expect(await handleWorkflow(["list"], home)).toBe(0);
      expect(out).toContain("还没有工作流");
      const defPath = writeDefFile(home, toolDefYaml());
      expect(await handleWorkflow(["import", defPath], home)).toBe(0);
      expect(await handleWorkflow(["list"], home)).toBe(0);
      expect(out).toContain("读文件");
      expect(await handleWorkflow(["show", "读文件"], home)).toBe(0);
      expect(await handleWorkflow(["show", "不存在"], home)).toBe(1);
      const file = join(home, "t.txt");
      writeFileSync(file, "cli-ok");
      // run 的 workdir 是进程 cwd，工具路径按工作区 containment 解析：chdir 进临时 home 再跑。
      const savedCwd = process.cwd();
      process.chdir(home);
      try {
        expect(await handleWorkflow(["run", "读文件", "--input", `file=${file}`], home)).toBe(0);
        expect(await handleWorkflow(["dry-run", "读文件", "--input", `file=${file}`], home)).toBe(0);
      } finally {
        process.chdir(savedCwd);
      }
      expect(out).toContain("dry-run");
      expect(await handleWorkflow(["verify", "no-such-run"], home)).toBe(1);
    } finally {
      (process.stdout as unknown as { write: unknown }).write = origWrite;
      (process.stderr as unknown as { write: unknown }).write = origErr;
    }
  } finally {
    cleanup(home);
  }
});

test("CLI：软链临时目录下 run 仍能读文件（macOS /var 软链回归，CI #491）", async () => {
  // macOS 的 tmpdir 是 /var/folders/...（软链到 /private/var/folders/...）：
  // process.chdir(软链路径) 后 process.cwd() 返回解析后的真实路径，而 --input
  // 传的是软链路径拼的文件。旧的 workspaceReadPath 只做字符串前缀比较，
  // 文件看起来在工作目录外，run 失败、退出码 1。Linux 上用软链复现同一形状。
  const real = mkdtempSync(join(tmpdir(), "nyra-wf-real-"));
  const link = join(tmpdir(), `nyra-wf-link-${Date.now()}`);
  symlinkSync(real, link);
  const home = link;
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  const savedCwd = process.cwd();
  try {
    const defPath = writeDefFile(home, toolDefYaml());
    expect(await handleWorkflow(["import", defPath], home)).toBe(0);
    const file = join(home, "t.txt");
    writeFileSync(file, "cli-ok");
    process.chdir(home);
    expect(await handleWorkflow(["run", "读文件", "--input", `file=${file}`], home)).toBe(0);
    expect(out).toContain("completed");
  } finally {
    process.chdir(savedCwd);
    (process.stdout as unknown as { write: unknown }).write = origWrite;
    (process.stderr as unknown as { write: unknown }).write = origErr;
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 小工具：把定义写成 YAML 文本文件（测试用，不依赖 workflow.ts 的 YAML 生成器）
// ---------------------------------------------------------------------------

function writeDefFile(home: string, text: string, name = "wf.yaml"): string {
  const p = join(home, name);
  writeFileSync(p, text);
  return p;
}

function defToYaml(def: WorkflowDefinition): string {
  const lines: string[] = [
    `name: ${def.name}`,
    "version: 1",
    "mode: fixed",
  ];
  if (def.inputs) {
    lines.push("inputs:");
    for (const [k, v] of Object.entries(def.inputs)) {
      lines.push(`  ${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
    }
  }
  if (def.max_cost_usd !== undefined) lines.push(`max_cost_usd: ${def.max_cost_usd}`);
  lines.push("steps:");
  const dumpStep = (s: WorkflowDefinition["steps"][number], indent: string): void => {
    lines.push(`${indent}- id: ${s.id}`);
    lines.push(`${indent}  type: ${s.type}`);
    if (s.if) lines.push(`${indent}  if: ${JSON.stringify(s.if)}`);
    if (s.for_each) {
      lines.push(`${indent}  for_each:`);
      lines.push(`${indent}    items: ${JSON.stringify(s.for_each.items)}`);
      lines.push(`${indent}    as: ${s.for_each.as}`);
      if (s.for_each.max !== undefined) lines.push(`${indent}    max: ${s.for_each.max}`);
    }
    if (s.tool) lines.push(`${indent}  tool: ${s.tool}`);
    if (s.args) {
      lines.push(`${indent}  args:`);
      for (const [k, v] of Object.entries(s.args)) {
        lines.push(`${indent}    ${k}: ${JSON.stringify(v)}`);
      }
    }
    if (s.prompt) lines.push(`${indent}  prompt: ${JSON.stringify(s.prompt)}`);
    if (s.system) lines.push(`${indent}  system: ${JSON.stringify(s.system)}`);
    if (s.task) lines.push(`${indent}  task: ${JSON.stringify(s.task)}`);
    if (s.max_turns !== undefined) lines.push(`${indent}  max_turns: ${s.max_turns}`);
    if (s.base) lines.push(`${indent}  base: ${JSON.stringify(s.base)}`);
    if (s.query) lines.push(`${indent}  query: ${JSON.stringify(s.query)}`);
    if (s.top_k !== undefined) lines.push(`${indent}  top_k: ${s.top_k}`);
    if (s.skill) lines.push(`${indent}  skill: ${JSON.stringify(s.skill)}`);
    if (s.summary) lines.push(`${indent}  summary: ${JSON.stringify(s.summary)}`);
    if (s.title) lines.push(`${indent}  title: ${JSON.stringify(s.title)}`);
    if (s.on_reject) lines.push(`${indent}  on_reject: ${s.on_reject}`);
    if (s.branches) {
      lines.push(`${indent}  branches:`);
      for (const branch of s.branches) {
        lines.push(`${indent}    -`);
        for (const sub of branch) dumpStep(sub, `${indent}      `);
      }
    }
  };
  for (const s of def.steps) dumpStep(s, "  ");
  lines.push("");
  return lines.join("\n");
}
