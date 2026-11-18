// tests/node/test-multi-model.test.ts — 对应 tests/test_multi_model.py（20 个唯一测试）。
import { test, expect } from "bun:test";
import {
  MAX_MODELS, SYNTHESIS_INSTRUCTIONS, parseModelSpec, defaultProviderFactory,
  extractAnswer, buildSynthesisPrompt, research, formatText, listProviders,
} from "../../src/multiModel.ts";

function fakeFactory(answers: Record<string, string | Error>) {
  return (name: string, model: string | null) => {
    const key = model ? `${name}:${model}` : name;
    const value = answers[key] ?? answers[name];
    return {
      name, model: model ?? "default", baseUrl: "https://fake.invalid",
      hasCredentials: () => true,
      listModels: async () => [],
      redact: (t: string) => t,
      chat: async () => {
        if (value instanceof Error) throw value;
        return { choices: [{ message: { content: value ?? "默认回答", tool_calls: [] } }] };
      },
    };
  };
}

test("MultiModelTest.test_max_models", () => {
  expect(MAX_MODELS).toBe(5);
});

test("MultiModelTest.test_parse_model_spec", () => {
  expect(parseModelSpec("deepseek")).toEqual(["deepseek", null]);
  expect(parseModelSpec("deepseek:deepseek-flash")).toEqual(["deepseek", "deepseek-flash"]);
  // 只按第一个 : 切分，ollama 的 qwen2.5:7b 正确。
  expect(parseModelSpec("ollama:qwen2.5:7b")).toEqual(["ollama", "qwen2.5:7b"]);
  expect(parseModelSpec("xai:grok-4.3")).toEqual(["xai", "grok-4.3"]);
});

test("MultiModelTest.test_default_factory_throws", () => {
  expect(() => defaultProviderFactory("deepseek", null, "/tmp")).toThrow();
});

test("MultiModelTest.test_extract_answer", () => {
  const [text, usage] = extractAnswer({ choices: [{ message: { content: "你好", tool_calls: [] } }], usage: { total_tokens: 10 } });
  expect(text).toBe("你好");
  expect(usage).toEqual({ total_tokens: 10 });
  // 无 choices 时抛错（research 里由 callProvider 接住记为模型错误，不致命）。
  expect(() => extractAnswer({ choices: [] })).toThrow("无法解析");
});

test("MultiModelTest.test_synthesis_instructions_three_sections", () => {
  expect(SYNTHESIS_INSTRUCTIONS).toContain("共识");
  expect(SYNTHESIS_INSTRUCTIONS).toContain("分歧");
  expect(SYNTHESIS_INSTRUCTIONS).toContain("独特观点");
});

test("MultiModelTest.test_build_synthesis_prompt_names_failures", () => {
  const prompt = buildSynthesisPrompt("问题", [
    { model: "deepseek:flash", answer: "A", error: null, usage: null },
    { model: "xai:grok", answer: null, error: "超时", usage: null },
  ]);
  expect(prompt).toContain("deepseek:flash");
  expect(prompt).toContain("xai:grok");
  expect(prompt).toContain("超时");
  expect(prompt).not.toContain("替补");
});

test("MultiModelTest.test_research_parallel_success", async () => {
  const report = await research(["deepseek", "xai"], "什么是机器人？", {
    providerFactory: fakeFactory({ deepseek: "答案一", xai: "答案二" }) as never,
  });
  expect(report.results.length).toBe(2);
  expect(report.results[0].answer).toBe("答案一");
  expect(report.results[1].answer).toBe("答案二");
  expect(report.results.every((r) => r.error === null)).toBe(true);
  expect(report.synthesis).toBeNull();
});

test("MultiModelTest.test_research_failure_recorded_not_fatal", async () => {
  const report = await research(["deepseek", "xai"], "问题", {
    providerFactory: fakeFactory({ deepseek: new Error("挂了"), xai: "好的" }) as never,
  });
  expect(report.results[0].error).toContain("挂了");
  expect(report.results[0].answer).toBeNull();
  expect(report.results[1].answer).toBe("好的");
});

test("MultiModelTest.test_research_requires_factory", async () => {
  await expect(research(["deepseek"], "问题")).rejects.toThrow();
});

test("MultiModelTest.test_research_validates_models", async () => {
  await expect(research([], "问题", { providerFactory: fakeFactory({}) as never })).rejects.toThrow();
  await expect(research(["", "xai"], "问题", { providerFactory: fakeFactory({}) as never })).rejects.toThrow();
  await expect(research(["a", "b", "c", "d", "e", "f"], "问题", { providerFactory: fakeFactory({}) as never })).rejects.toThrow();
});

test("MultiModelTest.test_research_dedups_models", async () => {
  const report = await research(["deepseek", "deepseek"], "问题", {
    providerFactory: fakeFactory({ deepseek: "同" }) as never,
  });
  expect(report.results.length).toBe(1);
});

test("MultiModelTest.test_research_with_synthesizer", async () => {
  const report = await research(["deepseek", "xai"], "问题", {
    providerFactory: fakeFactory({ deepseek: "A", xai: "B", "deepseek:deepseek-flash": "综合：A 和 B 一致" }) as never,
    synthesizer: "deepseek:deepseek-flash",
  });
  expect(report.synthesis).toContain("综合");
  expect(report.synthesis_error).toBeNull();
});

test("MultiModelTest.test_format_text", () => {
  const text = formatText({
    results: [
      { model: "deepseek:flash", answer: "A", error: null, usage: null },
      { model: "xai:grok", answer: null, error: "超时", usage: null },
    ],
    synthesis: "综合：A",
    synthesis_error: null,
  });
  expect(text).toContain("deepseek:flash");
  expect(text).toContain("A");
  expect(text).toContain("超时");
  expect(text).toContain("综合：A");
});

test("MultiModelTest.test_list_providers", () => {
  const names = listProviders({ deepseek: { defaultModel: "deepseek-flash" }, xai: { defaultModel: "grok-4.3" } });
  expect(names).toContain("deepseek");
  expect(names).toContain("xai");
});
