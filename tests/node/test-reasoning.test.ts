// tests/node/test-reasoning.test.ts — 推理档位与冗长度（对齐 Codex model_reasoning_effort / verbosity）。
// 核心纪律：未配置就什么都不发（payload 逐字节不变）；非法值丢弃并说明，不发出去让 API 报错。
import { test, expect } from "bun:test";
import {
  resolveReasoningOptions, toRequestBody, describeReasoning, suggestEffort,
  REASONING_EFFORTS, VERBOSITIES,
} from "../../src/reasoning.ts";

test("合法档位被接受", () => {
  const r = resolveReasoningOptions({ reasoning_effort: "high", verbosity: "low" });
  expect(r.effort).toBe("high");
  expect(r.verbosity).toBe("low");
  expect(r.ignored).toEqual([]);
});

test("大小写与空白不敏感", () => {
  const r = resolveReasoningOptions({ reasoning_effort: "  XHIGH ", verbosity: "MEDIUM" });
  expect(r.effort).toBe("xhigh");
  expect(r.verbosity).toBe("medium");
});

test("未配置 → 空对象（payload 不变，零配置零影响）", () => {
  const r = resolveReasoningOptions({});
  expect(toRequestBody(r)).toEqual({});
  expect(describeReasoning(r)).toContain("未配置");
});

test("非法值被丢弃并说明原因，不发出去", () => {
  const r = resolveReasoningOptions({ reasoning_effort: "turbo", verbosity: 3 });
  expect(r.effort).toBeUndefined();
  expect(r.verbosity).toBeUndefined();
  expect(r.ignored.length).toBe(2);
  expect(r.ignored[0].reason).toContain("minimal");
  expect(toRequestBody(r)).toEqual({});
});

test("toRequestBody：只带有配置的键", () => {
  expect(toRequestBody(resolveReasoningOptions({ reasoning_effort: "low" }))).toEqual({ reasoning_effort: "low" });
  expect(toRequestBody(resolveReasoningOptions({ verbosity: "high" }))).toEqual({ verbosity: "high" });
});

test("全部合法档位都能往返", () => {
  for (const e of REASONING_EFFORTS) {
    expect(toRequestBody(resolveReasoningOptions({ reasoning_effort: e })).reasoning_effort).toBe(e);
  }
  for (const v of VERBOSITIES) {
    expect(toRequestBody(resolveReasoningOptions({ verbosity: v })).verbosity).toBe(v);
  }
});

test("describeReasoning：说人话并提示忽略项", () => {
  expect(describeReasoning(resolveReasoningOptions({ reasoning_effort: "high" }))).toContain("推理档位 high");
  expect(describeReasoning(resolveReasoningOptions({ reasoning_effort: "nope" }))).toContain("已忽略");
});

test("suggestEffort：短任务 low，长任务/复杂关键词 high，普通 medium", () => {
  expect(suggestEffort("改个错别字").effort).toBe("low");
  expect(suggestEffort("请帮我重构整个 auth 模块并迁移到 middleware").effort).toBe("high");
  expect(suggestEffort("a".repeat(500)).effort).toBe("high");
  // 中等长度、无复杂关键词 → medium（超过 low 的 80 字符阈值）\n  const mediumTask = "请把 src/utils/format.ts 里的三个工具函数补上注释，并确认现有测试仍然通过，最后把改动整理成一份简短的说明放到 docs 目录下，方便同事review";\n  expect(suggestEffort(mediumTask).effort).toBe("medium");
});

test("suggestEffort 只给建议，不改变运行行为（纯函数无副作用）", () => {
  const a = suggestEffort("重构");
  const b = suggestEffort("重构");
  expect(a).toEqual(b);
});
