// src/multiModel.ts — 多模型调研，与 Python 版 nyra/multi_model.py 同语义。
// 并行问多模型、综合共识/分歧/独特观点三节；失败的模型只记录、不兜底、不拖垮其他模型。
import { CliProvider, Provider, type ProviderLike } from "./providers.ts";

export const MAX_MODELS = 5;

export const SYNTHESIS_INSTRUCTIONS =
  "以下是多个模型对同一问题的独立回答，每份都已注明来源模型，" +
  "请综合成一份中文报告，只按以下三节写，不要编造没有出现的观点：\n" +
  "1. 共识：所有模型都同意的点；\n" +
  "2. 分歧：模型之间说得不一样的点，逐条注明是谁说的；\n" +
  "3. 独特观点：只有个别模型提到的点，注明是哪个模型提的。\n" +
  "如果某个模型的回答缺失（调用失败），不要替它补观点，只按已有的回答写。";

export function parseModelSpec(spec: string): [string, string | null] {
  const text = (spec || "").trim();
  if (!text) throw new Error("模型名不能为空");
  let name: string;
  let model: string | null;
  if (text.includes(":")) {
    const idx = text.indexOf(":");
    name = text.slice(0, idx).trim();
    model = text.slice(idx + 1).trim() || null;
  } else {
    name = text;
    model = null;
  }
  if (!name) throw new Error(`模型写法不对：${JSON.stringify(spec)}（应为 provider 或 provider:model）`);
  return [name, model];
}

export function defaultProviderFactory(_name: string, _model: string | null, _home: string): ProviderLike {
  // Node 版 research 要求调用方显式传 providerFactory（见 research）：
  // 默认工厂需要 home + 完整 config，不从全局隐式读取，避免在测试与
  // 队列里悄悄用上错误的配置。
  throw new Error("defaultProviderFactory 未接线：请给 research 传 providerFactory");
}

export interface ResearchResult {
  model: string;
  answer: string | null;
  error: string | null;
  usage: Record<string, unknown> | null;
}

export interface ResearchReport {
  results: ResearchResult[];
  synthesis: string | null;
  synthesis_error: string | null;
}

export function extractAnswer(resp: Record<string, unknown>): [string, Record<string, unknown> | null] {
  try {
    const choices = resp.choices as Record<string, unknown>[];
    const content = (choices[0].message as Record<string, unknown>).content as string;
    if (typeof content !== "string" && content !== null && content !== undefined) {
      throw new Error("bad content");
    }
    return [content || "", (resp.usage as Record<string, unknown>) ?? null];
  } catch {
    throw new Error("模型返回了无法解析的回答");
  }
}

async function callProvider(
  provider: ProviderLike,
  messages: Record<string, unknown>[],
  timeout: number,
): Promise<[string | null, Record<string, unknown> | null, string | null]> {
  try {
    const resp = await provider.chat(messages as never, null, timeout);
    const [answer, usage] = extractAnswer(resp);
    return [answer, usage, null];
  } catch (exc: unknown) {
    return [null, null, exc instanceof Error ? exc.message : String(exc)];
  }
}

export function buildSynthesisPrompt(prompt: string, results: ResearchResult[]): string {
  const parts = [SYNTHESIS_INSTRUCTIONS, `\n原问题：${prompt}\n`];
  const failed = results.filter((r) => r.error !== null);
  for (const r of results) {
    if (r.error !== null) continue;
    parts.push(`\n--- ${r.model} 的回答 ---\n${r.answer}\n`);
  }
  if (failed.length) {
    parts.push("\n以下模型调用失败，没有提供回答：\n");
    for (const r of failed) parts.push(`- ${r.model}：${r.error}\n`);
  }
  return parts.join("");
}

export async function research(
  models: string[],
  prompt: string,
  opts?: {
    system?: string | null;
    timeout?: number;
    synthesizer?: string | null;
    providerFactory?: (name: string, model: string | null) => ProviderLike;
  },
): Promise<ResearchReport> {
  if (!models || !models.length) throw new Error("至少要指定一个模型");
  const specs: string[] = [];
  for (const spec of models) {
    const text = (spec || "").trim();
    if (!text) throw new Error("模型名不能为空");
    if (!specs.includes(text)) specs.push(text);
  }
  if (specs.length > MAX_MODELS) throw new Error(`一次最多 ${MAX_MODELS} 个模型，给了 ${specs.length} 个`);
  const factory = opts?.providerFactory;
  if (!factory) throw new Error("research 需要 providerFactory（Node 版不从全局配置隐式构造 provider）");
  const timeout = opts?.timeout ?? 120;
  const messages: Record<string, unknown>[] = [];
  if (opts?.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  interface Slot extends ResearchResult { provider?: ProviderLike }
  const slots: Slot[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    try {
      const [name, model] = parseModelSpec(spec);
      const provider = factory(name, model);
      const key = `${provider.name}:${provider.model}`;
      const label = key;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push({ model: label, answer: null, error: null, usage: null, provider });
    } catch (exc: unknown) {
      slots.push({ model: spec, answer: null, error: exc instanceof Error ? exc.message : String(exc), usage: null });
    }
  }

  // 并行调用，共享一个截止时间：超时不拖垮整体（Promise.allSettled + 超时竞速）。
  const deadline = Date.now() + timeout * 1000;
  await Promise.all(slots.map(async (slot) => {
    if (!slot.provider) return;
    const remaining = Math.max(1, (deadline - Date.now()) / 1000);
    const [answer, usage, error] = await callProvider(slot.provider, messages, remaining);
    slot.answer = answer;
    slot.usage = usage;
    slot.error = error;
  }));

  const results: ResearchResult[] = slots.map(({ model, answer, error, usage }) => ({ model, answer, error, usage }));

  let synthesis: string | null = null;
  let synthesisError: string | null = null;
  if (opts?.synthesizer) {
    try {
      const [name, model] = parseModelSpec(opts.synthesizer);
      const provider = factory(name, model);
      const label = `${provider.name}:${provider.model}`;
      const synthPrompt = buildSynthesisPrompt(prompt, results);
      const [answer, , error] = await callProvider(provider, [{ role: "user", content: synthPrompt }], timeout);
      if (error !== null) synthesisError = `综合调用失败（${label}）：${error}`;
      else synthesis = answer;
    } catch (exc: unknown) {
      synthesisError = `综合模型 ${JSON.stringify(opts.synthesizer)} 无法使用：${exc instanceof Error ? exc.message : String(exc)}`;
    }
  }
  return { results, synthesis, synthesis_error: synthesisError };
}

export function formatText(report: ResearchReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    lines.push(`## ${r.model}`);
    lines.push(r.error !== null ? `调用失败：${r.error}` : (r.answer ?? ""));
    lines.push("");
  }
  if (report.synthesis) {
    lines.push("## 综合");
    lines.push(report.synthesis);
  } else if (report.synthesis_error) {
    lines.push(`综合失败：${report.synthesis_error}`);
  }
  return lines.join("\n");
}

export function listProviders(presets: Record<string, { defaultModel: string | null }>): string[] {
  return Object.keys(presets).sort();
}

export { CliProvider, Provider };
