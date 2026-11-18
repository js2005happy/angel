// tests/node/fake-provider.ts — 测试用假 provider（不发真实模型请求）。
// 按调用次数返回脚本化响应；每次响应都带 usage，方便用量/压缩测试。
import type { ProviderLike } from "../../src/providers.ts";

export interface FakeScriptStep {
  content?: string;
  toolCalls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  promptTokens?: number;
}

export function fakeProvider(steps: FakeScriptStep[], opts?: { name?: string; model?: string; delayMs?: number }): ProviderLike & { calls: number } {
  let calls = 0;
  const provider = {
    name: opts?.name ?? "fake",
    model: opts?.model ?? "fake-1",
    baseUrl: "http://127.0.0.1:9",
    calls: 0,
    hasCredentials: () => true,
    async chat(_messages: unknown[], _tools?: unknown, _timeout?: number): Promise<Record<string, unknown>> {
      if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      calls += 1;
      provider.calls = calls;
      const step = steps[Math.min(calls - 1, steps.length - 1)] ?? { content: "完成。" };
      const message: Record<string, unknown> = { role: "assistant", content: step.content ?? "" };
      if (step.toolCalls) message.tool_calls = step.toolCalls;
      return {
        choices: [{ message }],
        usage: { prompt_tokens: step.promptTokens ?? 100, completion_tokens: 10, total_tokens: (step.promptTokens ?? 100) + 10 },
      };
    },
    async listModels(): Promise<string[]> { return ["fake-1"]; },
    redact: (text: string) => text,
  };
  return provider;
}

/** 只回一句话的假 provider。 */
export function echoProvider(text = "收到，已完成。", promptTokens = 100): ProviderLike & { calls: number } {
  return fakeProvider([{ content: text, promptTokens }]);
}
