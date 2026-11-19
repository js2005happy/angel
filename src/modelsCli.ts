// src/modelsCli.ts — `nyra models` 子命令：查模型窗口、刷新模型数据。
//
//   nyra models [list] [--provider 名字]   列出内置表 + 刷新缓存里的模型窗口
//   nyra models show <模型名>             看一个模型的窗口、输出上限、计价与来源
//   nyra models refresh                  从 OpenRouter 公开列表拉取最新数据进缓存
//
// 日常运行不联网；只有 refresh 会发一次公网请求（15 秒超时），失败时旧缓存原样保留。
import { listCatalog, loadModelCache, lookupBuiltin, lookupCache, refreshModelCache, MODEL_CATALOG_UPDATED, OPENROUTER_MODELS_URL } from "./modelCatalog.ts";
import { getProviderPresets } from "./config.ts";

function fmtMoney(v: number | null | undefined): string {
  if (typeof v !== "number") return "—";
  return `$${v.toFixed(2)}`;
}

function fmtNum(v: number | null | undefined): string {
  return typeof v === "number" ? v.toLocaleString("en-US") : "—";
}

export async function handleModels(argv: string[], home: string): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : "list";
  const rest = sub === "list" ? argv : argv.slice(1);
  if (sub === "refresh") {
    try {
      const r = await refreshModelCache({ home });
      process.stdout.write(`模型数据已刷新：本次拉取 ${r.fetched} 个模型，缓存共 ${r.kept} 个（${r.path}，${r.fetchedAt.slice(0, 10)}）。\n`);
      process.stdout.write("说明：缓存只补内置表没有的模型，内置表的人工核实值不会被覆盖。\n");
      return 0;
    } catch (err) {
      process.stderr.write(`模型数据刷新失败：${err instanceof Error ? err.message : String(err)}\n`);
      process.stderr.write("已保留旧缓存（或无缓存）；日常运行继续用内置模型表，不受影响。\n");
      return 1;
    }
  }
  if (sub === "show") {
    const model = rest[0];
    if (!model) {
      process.stderr.write("用法：nyra models show <模型名>\n");
      return 2;
    }
    const cache = loadModelCache(home);
    const builtin = lookupBuiltin(model);
    const cached = builtin ? null : lookupCache(cache, model);
    if (!builtin && !cached) {
      process.stdout.write(`模型 ${model} 未收录。\n`);
      process.stdout.write("可运行 nyra models refresh 从 OpenRouter 拉取最新数据，或用 --context-window / context_window_tokens 手动指定窗口。\n");
      return 0;
    }
    if (builtin) {
      const e = builtin.entry;
      process.stdout.write(`模型：${e.model}（${e.provider}，来源：${builtin.match === "exact" ? "内置模型表" : `内置模型表，同系列 ${e.model} 推断`}）\n`);
      process.stdout.write(`上下文窗口：${fmtNum(e.contextWindow)} tokens\n`);
      process.stdout.write(`最大输出：${fmtNum(e.maxOutputTokens)} tokens\n`);
      process.stdout.write(`计价（美元 / 百万 token）：输入 ${fmtMoney(e.inputPricePer1M)} / 输出 ${fmtMoney(e.outputPricePer1M)}\n`);
      process.stdout.write(`数据来源：${e.source}（${e.updated} 核实）\n`);
      if (e.note) process.stdout.write(`注意：${e.note}\n`);
      return 0;
    }
    process.stdout.write(`模型：${model}（来源：刷新缓存，${cache!.fetchedAt.slice(0, 10)} 从 ${OPENROUTER_MODELS_URL} 拉取）\n`);
    process.stdout.write(`上下文窗口：${fmtNum(cached!.contextWindow)} tokens\n`);
    process.stdout.write(`最大输出：${fmtNum(cached!.maxOutputTokens)} tokens\n`);
    process.stdout.write(`计价（美元 / 百万 token）：输入 ${fmtMoney(cached!.inputPricePer1M)} / 输出 ${fmtMoney(cached!.outputPricePer1M)}\n`);
    return 0;
  }
  if (sub !== "list") {
    process.stderr.write("用法：nyra models [list] [--provider 名字]；nyra models show <模型名>；nyra models refresh\n");
    return 2;
  }
  const providerFlag = rest.indexOf("--provider");
  const providerFilter = providerFlag >= 0 ? rest[providerFlag + 1] : undefined;
  if (providerFlag >= 0 && !providerFilter) {
    process.stderr.write("用法：nyra models list --provider <名字>\n");
    return 2;
  }
  const cache = loadModelCache(home);
  let rows = listCatalog(cache);
  if (providerFilter) {
    let allowed: Set<string> | null = null;
    try {
      const presets = getProviderPresets({});
      const preset = presets[providerFilter];
      allowed = preset ? new Set([...preset.models, providerFilter]) : new Set([providerFilter]);
    } catch {
      allowed = new Set([providerFilter]);
    }
    rows = rows.filter((r) => allowed!.has(r.entry.model) || allowed!.has(r.entry.provider));
  }
  process.stdout.write(`模型上下文窗口（内置表 ${MODEL_CATALOG_UPDATED} 整理；缓存：${cache ? `${cache.fetchedAt.slice(0, 10)} 拉取，共 ${Object.keys(cache.models).length} 个` : "未刷新过"}）：\n`);
  process.stdout.write("模型 | 窗口 | 最大输出 | 输入$/1M | 输出$/1M | 来源\n");
  for (const { entry, from } of rows) {
    const src = from === "cache" ? "缓存" : entry.source.replace(/^https?:\/\//, "").split("/")[0];
    process.stdout.write(`${entry.model} | ${fmtNum(entry.contextWindow)} | ${fmtNum(entry.maxOutputTokens)} | ${fmtMoney(entry.inputPricePer1M)} | ${fmtMoney(entry.outputPricePer1M)} | ${src}${entry.note ? `（${entry.note}）` : ""}\n`);
  }
  process.stdout.write("计价为官方定价页的缓存未命中价，仅作参考；实际计费以 config.pricing 为准。窗口数变了就运行 nyra models refresh 更新。\n");
  return 0;
}
