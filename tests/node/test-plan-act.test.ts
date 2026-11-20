// tests/node/test-plan-act.test.ts — 缺口 24：Plan/Act 分模型 + 多模型工厂。
// 规划用强推理模型（只读）、执行换便宜模型；没配就沿用主模型，不假装切换。
import { test, expect } from "bun:test";
import { Agent } from "../../src/agent.ts";
import type { ProviderLike } from "../../src/providers.ts";
import { fakeProvider } from "./fake-provider.ts";

/** 一个记录被谁调用过的假 provider 工厂（按 model 名造）。 */
function factoryRecording(models: Record<string, ProviderLike & { calls: number }>) {
  return (name: string, model: string | null): ProviderLike => {
    const key = model ?? "main";
    const p = models[key];
    if (!p) throw new Error(`无此模型 ${key}`);
    return p;
  };
}

test("planProvider：配了 plan_model 且工厂可用 → 返回独立强模型", () => {
  const planModel = fakeProvider([{ content: "计划" }], { model: "deepseek-reasoner" });
  const main = fakeProvider([{ content: "ok" }], { model: "main" });
  const agent = new Agent(main, {
    planActModels: { plan: "deepseek-reasoner" },
    multiModelFactory: factoryRecording({ "deepseek-reasoner": planModel }),
  });
  const p = agent.planProvider();
  expect(p).not.toBeNull();
  expect(p!.model).toBe("deepseek-reasoner");
});

test("planProvider：未配 plan_model → 返回 null（沿用主模型）", () => {
  const main = fakeProvider([{ content: "ok" }]);
  const agent = new Agent(main, { multiModelFactory: factoryRecording({}) });
  expect(agent.planProvider()).toBeNull();
});

test("planProvider：配了但工厂抛错 → 返回 null（回退主模型，不假装切换）", () => {
  const main = fakeProvider([{ content: "ok" }]);
  const agent = new Agent(main, {
    planActModels: { plan: "ghost" },
    multiModelFactory: () => { throw new Error("无此模型"); },
  });
  expect(agent.planProvider()).toBeNull();
});

test("actProvider：配了 act_model → 执行走便宜模型", () => {
  const actModel = fakeProvider([{ content: "执行完成" }], { model: "deepseek-flash" });
  const main = fakeProvider([{ content: "ok" }], { model: "main" });
  const agent = new Agent(main, {
    planActModels: { act: "deepseek-flash" },
    multiModelFactory: factoryRecording({ "deepseek-flash": actModel }),
  });
  expect(agent.actProvider().model).toBe("deepseek-flash");
});

test("actProvider：未配 act_model → 沿用主 provider", () => {
  const main = fakeProvider([{ content: "ok" }], { model: "main" });
  const agent = new Agent(main, {});
  expect(agent.actProvider()).toBe(main);
});

test("actProvider：工厂抛错 → 回退主 provider（不因省钱写坏执行）", () => {
  const main = fakeProvider([{ content: "ok" }], { model: "main" });
  const agent = new Agent(main, {
    planActModels: { act: "ghost" },
    multiModelFactory: () => { throw new Error("无此模型"); },
  });
  expect(agent.actProvider()).toBe(main);
});

test("执行阶段真用便宜模型：run 循环里调 act 模型而非主模型", async () => {
  const actModel = fakeProvider([{ content: "用便宜模型执行完成" }], { model: "deepseek-flash" });
  const main = fakeProvider([{ content: "不该被调" }], { model: "main" });
  const agent = new Agent(main, {
    planActModels: { act: "deepseek-flash" },
    multiModelFactory: factoryRecording({ "deepseek-flash": actModel }),
    maxTurns: 1,
  });
  const out = await agent.run("写个函数");
  expect(out).toContain("便宜模型执行完成");
  expect(actModel.calls).toBe(1);
  expect(main.calls).toBe(0);
});

test("未配 act_model：run 循环用主模型", async () => {
  const main = fakeProvider([{ content: "主模型执行" }], { model: "main" });
  const agent = new Agent(main, { maxTurns: 1 });
  const out = await agent.run("写个函数");
  expect(out).toContain("主模型执行");
  expect(main.calls).toBe(1);
});
