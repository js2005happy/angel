// src/features.ts — 功能开关（对齐 Codex 的 [features] + --enable/--disable）。
//
// 为什么需要：Nyra 的新能力（工具延迟加载、自动上下文窗口、MCP 预设…）现在只有
// "配置项开着/关着"这一种粗粒度开关，没有统一的地方能回答"这个能力到底启用没有"，
// 也没法在出问题时一键关掉做灰度回退。
//
// 设计要点：
//   - **未知开关名不静默忽略**：拼错的开关会进入 warnings，否则用户以为关掉了其实没关
//   - **CLI 覆盖配置**：--enable-feature / --disable-feature 优先于 config.features
//   - 每个开关都有默认值与一句话说明，`nyra features` 能直接列出
//   - 纯函数，便于单测；不读文件、不 spawn

import { t } from "./i18n.ts";
export interface FeatureSpec {
  name: string;
  /** 默认值。默认关的开关意味着"实验性/可能省 token 但改变行为"。 */
  defaultEnabled: boolean;
  description: string;
}

/**
 * 已知开关清单。加新能力时在这里登记一行——**这是唯一的登记处**。
 * 默认关的应该是"改变模型行为或输出"的能力；纯优化、无行为变化的默认开。
 */
export const FEATURES: readonly FeatureSpec[] = [
  { name: "tool_search", defaultEnabled: false, description: "工具延迟加载：只发核心工具 + search_tools 命中的（省 token，改变发给模型的工具集）" },
  { name: "auto_context_window", defaultEnabled: true, description: "自动探测模型上下文窗口（省去手工配 context_window）" },
  { name: "aux_model_routing", defaultEnabled: true, description: "压缩/子任务走便宜模型（compact_model / delegate_model）" },
  { name: "deny_read_globs", defaultEnabled: true, description: "读侧禁读清单（.env / secrets 等敏感文件拒绝读取）" },
  { name: "cost_hard_cap", defaultEnabled: true, description: "成本硬顶：超过 max_cost_usd 立即中止而不是只警告" },
  { name: "resume_idempotent", defaultEnabled: true, description: "续跑幂等：已成功的写操作不重复执行" },
];

export type FeatureState = "on" | "off" | "default";

export interface ResolvedFeature extends FeatureSpec {
  enabled: boolean;
  /** 值从哪来：CLI 覆盖 / 配置文件 / 默认值。 */
  source: "cli" | "config" | "default";
}

export interface FeatureResolution {
  features: ResolvedFeature[];
  /** 无法识别的开关名（配置或 CLI 里写错）。不静默忽略。 */
  warnings: string[];
}

function norm(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase();
  return t.length ? t : undefined;
}

/**
 * 解析生效状态。
 *
 * 优先级：CLI（--enable-feature / --disable-feature）> config.features > 默认值。
 * CLI 里同时 enable 与 disable 同名开关时，**disable 优先**（关掉比打开更安全）。
 */
export function resolveFeatures(
  config: Record<string, unknown> | null | undefined,
  cli?: { enable?: readonly string[]; disable?: readonly string[] } | null,
): FeatureResolution {
  const cfg = config ?? {};
  const raw = cfg.features;
  const cfgMap = new Map<string, boolean>();
  const warnings: string[] = [];

  if (raw !== undefined) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const key = norm(k);
        if (!key) continue;
        if (typeof v !== "boolean") {
          warnings.push(`features.${k} 不是布尔值，已忽略`);
          continue;
        }
        cfgMap.set(key, v);
      }
    } else {
      warnings.push("config.features 不是对象，已忽略");
    }
  }

  const known = new Set(FEATURES.map((f) => f.name));
  for (const k of cfgMap.keys()) {
    if (!known.has(k)) warnings.push(`未知开关 features.${k}（拼写错误？见 nyra features）`);
  }

  const enableSet = new Set((cli?.enable ?? []).map((s) => norm(s)).filter((s): s is string => Boolean(s)));
  const disableSet = new Set((cli?.disable ?? []).map((s) => norm(s)).filter((s): s is string => Boolean(s)));
  for (const k of [...enableSet, ...disableSet]) {
    if (!known.has(k)) warnings.push(`未知开关 ${k}（CLI 覆盖已忽略）`);
  }

  const features: ResolvedFeature[] = FEATURES.map((f) => {
    if (disableSet.has(f.name)) return { ...f, enabled: false, source: "cli" };
    if (enableSet.has(f.name)) return { ...f, enabled: true, source: "cli" };
    if (cfgMap.has(f.name)) return { ...f, enabled: cfgMap.get(f.name) === true, source: "config" };
    return { ...f, enabled: f.defaultEnabled, source: "default" };
  });

  return { features, warnings };
}

/** 单个开关是否启用（未登记的开关一律 false，不猜测）。 */
export function featureOn(resolution: FeatureResolution, name: string): boolean {
  return resolution.features.find((f) => f.name === name)?.enabled === true;
}

/** 人类可读列表（`nyra features` 用）。 */
export function formatFeatures(resolution: FeatureResolution): string {
  const lines = [t("features.title"), ""];
  for (const f of resolution.features) {
    const mark = f.enabled ? "✅" : "⬜";
    const src = f.source === "cli" ? t("features.srcCli") : f.source === "config" ? t("features.srcConfig") : t("features.srcDefault");
    lines.push(`${mark} ${f.name}${src}`);
    lines.push(`     ${f.description}`);
  }
  if (resolution.warnings.length) {
    lines.push("", t("features.warnHead"));
    for (const w of resolution.warnings) lines.push(`  ⚠️  ${w}`);
  }
  return lines.join("\n");
}
