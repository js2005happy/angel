// tests/node/test-model-routing.test.ts — 辅助任务走便宜模型（对齐 Alma 的 Tool Model）。
// 目标：压缩/子任务这类"低智力需求、高 token 消耗"的工作降水位，同时不假装优化。
import { test, expect } from "bun:test";
import {
  resolveAuxRouting, modelForTask, describeRouting, estimateCompactSaving,
} from "../../src/modelRouting.ts";

test("两个都配：各走各的", () => {
  const r = resolveAuxRouting({ compact_model: "cheap-a", delegate_model: "cheap-b" }, "main");
  expect(r.compact).toBe("cheap-a");
  expect(r.delegate).toBe("cheap-b");
  expect(r.ignored).toEqual([]);
});

test("与主模型相同 → 忽略并说明原因（不假装优化）", () => {
  const r = resolveAuxRouting({ compact_model: "main", delegate_model: "cheap-b" }, "main");
  expect(r.compact).toBeUndefined();
  expect(r.delegate).toBe("cheap-b");
  expect(r.ignored.length).toBe(1);
  expect(r.ignored[0].key).toBe("compact_model");
  expect(r.ignored[0].reason).toContain("等于没配");
});

test("未配置 → 全空（行为与改动前一致）", () => {
  const r = resolveAuxRouting({}, "main");
  expect(r.compact).toBeUndefined();
  expect(r.delegate).toBeUndefined();
  expect(modelForTask(r, "compact")).toBeNull();
  expect(modelForTask(r, "delegate")).toBeNull();
  expect(describeRouting(r)).toContain("未配置");
});

test("空白字符串、非字符串都被忽略", () => {
  const r = resolveAuxRouting({ compact_model: "   ", delegate_model: 123 }, "main");
  expect(r.compact).toBeUndefined();
  expect(r.delegate).toBeUndefined();
});

test("首尾空白会被 trim", () => {
  const r = resolveAuxRouting({ compact_model: "  cheap  " }, "main");
  expect(r.compact).toBe("cheap");
});

test("modelForTask 按任务取模型", () => {
  const r = resolveAuxRouting({ compact_model: "c", delegate_model: "d" }, "main");
  expect(modelForTask(r, "compact")).toBe("c");
  expect(modelForTask(r, "delegate")).toBe("d");
});

test("主模型未知（null）时不误判重复", () => {
  const r = resolveAuxRouting({ compact_model: "x" }, null);
  expect(r.compact).toBe("x");
  expect(r.ignored).toEqual([]);
});

test("describeRouting 说人话", () => {
  expect(describeRouting(resolveAuxRouting({ compact_model: "c", delegate_model: "d" }, "m")))
    .toContain("压缩 → c");
  const withIgnored = resolveAuxRouting({ compact_model: "m" }, "m");
  expect(describeRouting(withIgnored)).toContain("已忽略");
});

test("estimateCompactSaving：便宜模型应有正节省", () => {
  const r = estimateCompactSaving({
    promptTokens: 200_000, completionTokens: 5_000,
    main: { inputPer1M: 3, outputPer1M: 15 },
    aux: { inputPer1M: 0.28, outputPer1M: 0.42 },
  });
  expect(r.savingUsd).toBeGreaterThan(0);
  expect(r.savingRatio).toBeGreaterThan(0.8); // 压缩这类大输入场景，省下来的应该非常显著
});

test("estimateCompactSaving：同价位时节省为 0（不虚报）", () => {
  const p = { inputPer1M: 1, outputPer1M: 2 };
  const r = estimateCompactSaving({ promptTokens: 1000, completionTokens: 100, main: p, aux: p });
  expect(r.savingUsd).toBeCloseTo(0, 10);
  expect(r.savingRatio).toBe(0);
});
