// src/config.ts — 配置解析，与 Python 版 nyra/config.py 同格式、同语义。
// 第 2 阶段补全：第 1 阶段的骨架 + getProviderPresets 校验、resolveProfile、
// resolveSandbox、validateMode、兜底链完整语义（CLI 排除、未知跳过、空列表=无兜底）、
// 密码箱回退（vault.ts 解密，不再只判存在）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCredential } from "./vault.ts";
import { getFileKey } from "./keystore.ts";

import { effectiveValue } from "./enforcedConfig.ts";

export const VERSION = "0.5.3";

export interface ProviderPreset {
  baseUrl: string | null;
  defaultModel: string | null;
  envKey: string | null;
  connector: string | null;
  allowedHosts: string[];
  models: string[];
  auth?: "cli";
}

/** 14 个内置 provider，与 Python 版 nyra/config.py 的 PROVIDERS 一一对应。 */
export const PROVIDERS: Record<string, ProviderPreset> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-flash", envKey: "DEEPSEEK_API_KEY", connector: "custom.deepseek", allowedHosts: ["api.deepseek.com"], models: ["deepseek-flash", "deepseek-v4-pro"] },
  xai: { baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4.3", envKey: "XAI_API_KEY", connector: "custom.xai", allowedHosts: ["api.x.ai"], models: ["grok-4.3", "grok-4.5"] },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", defaultModel: "nousresearch/hermes-4-14b", envKey: "OPENROUTER_API_KEY", connector: null, allowedHosts: [], models: ["nousresearch/hermes-4-14b", "nousresearch/hermes-4-70b"] },
  ollama: { baseUrl: "http://localhost:11434/v1", defaultModel: "qwen2.5:7b", envKey: null, connector: null, allowedHosts: [], models: ["qwen2.5:7b"] },
  openai: { baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", envKey: "OPENAI_API_KEY", connector: null, allowedHosts: [], models: ["gpt-4o-mini"] },
  qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus", envKey: "DASHSCOPE_API_KEY", connector: null, allowedHosts: ["dashscope.aliyuncs.com"], models: ["qwen-plus", "qwen-turbo", "qwen3-max"] },
  kimi: { baseUrl: "https://api.moonshot.cn/v1", defaultModel: "kimi-k3", envKey: "MOONSHOT_API_KEY", connector: null, allowedHosts: ["api.moonshot.cn", "api.moonshot.ai"], models: ["kimi-k3", "kimi-k2.6", "kimi-k2.5"] },
  glm: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-5.3", envKey: "ZHIPU_API_KEY", connector: null, allowedHosts: ["open.bigmodel.cn", "api.z.ai"], models: ["glm-5.3", "glm-5.2", "glm-4.7-flash", "glm-4.5-flash"] },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.5-flash", envKey: "GEMINI_API_KEY", connector: null, allowedHosts: ["generativelanguage.googleapis.com"], models: ["gemini-2.5-flash", "gemini-2.5-pro"] },
  mistral: { baseUrl: "https://api.mistral.ai/v1", defaultModel: "mistral-small-latest", envKey: "MISTRAL_API_KEY", connector: null, allowedHosts: ["api.mistral.ai"], models: ["mistral-small-latest", "mistral-medium-latest", "mistral-large-latest", "codestral-latest"] },
  groq: { baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile", envKey: "GROQ_API_KEY", connector: null, allowedHosts: ["api.groq.com"], models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-120b"] },
  together: { baseUrl: "https://api.together.xyz/v1", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", envKey: "TOGETHER_API_KEY", connector: null, allowedHosts: ["api.together.xyz"], models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"] },
  codex: { baseUrl: "cli://codex", defaultModel: "codex-default", envKey: null, connector: null, allowedHosts: [], models: ["codex-default"], auth: "cli" },
  custom: { baseUrl: null, defaultModel: null, envKey: "NYRA_API_KEY", connector: null, allowedHosts: [], models: [] },
};

export const DEFAULT_CONFIG: Record<string, unknown> = {
  provider: "deepseek",
  model: "deepseek-flash",
  mode: "auto",
  max_turns: 20,
  context_window_tokens: null,
  auto_compact_enabled: false,
  auto_compact_threshold: 0.8,
  profiles: {},
  mcp_servers: {},
  mcp_enabled: false,
  // 缺口 17：对外 MCP 服务（Nyra 当 MCP 服务器，供别的 agent 调记忆与任务）。
  // 默认关闭；allow_writes 默认 false = 只读（search_memory / query_evidence），
  // 写操作（add_memory / forget_session / dispatch_task）须显式开 allow_writes，
  // 且每次写操作都要过独立审查层（reviewer 未开启时写操作直接拒绝，fail-closed）。
  mcp_server: { enabled: false, allow_writes: false },
  // P0-5：权限规则语言（学 Claude Code 的 Tool(specifier)）。空 = 走默认交互式审批。
  // 例：deny: ["Bash(rm -rf *)"], allow: ["Bash(git *)", "Edit(src/**)"].
  permissions: { allow: [], ask: [], deny: [] },
  // P2-2：成本硬顶。max_cost_usd 为单次运行上限（美元），pricing 按模型配单价
  // （input_per_1m / output_per_1m）；未配单价时金额未知，不做超支判定。
  max_cost_usd: null,
  // 缺口 29：月度支出上限（美元）。默认 null = 不设上限（不挡老用户）；
  // 一旦配了就是硬停（与 --max-cost 同级，无豁免口子）；0 = 锁死一切计价花费。
  // 自然月累计 = 本月 LLM 花费（用量账本）+ 本月 MCP 花费；每月 1 日重置。
  monthly_cost_limit_usd: null,
  // 辅助任务走便宜模型（对齐 Alma 的 Tool Model）：压缩摘要与子 Agent 默认模型。
  // 与主模型相同时会被忽略（等于没配）。
  compact_model: null,
  delegate_model: null,
  // 推理档位与输出冗长度（对齐 Codex）：minimal/low/medium/high/xhigh；null = 用 provider 默认。
  reasoning_effort: null,
  verbosity: null,
  // 工具集裁剪：每轮少发 schema 就等于每轮省钱；支持前缀通配（如 "comp*"）。
  disabled_tools: [],
  // 工具检索（延迟加载）：默认关；开启后只发核心工具 + search_tools 命中的。
  tool_search: { enabled: false, top_k: 12 },
  // 功能开关（对齐 Codex [features]）：键名为开关名，值为布尔；未知键会告警。
  features: {},
  // 上线红线（docs/VISION-NEXT.md 第七节）的可调项：阈值按项目调、检查项可显式忽略。
  redlines: { thresholds: {}, ignore: [] },
  // 额外可写根（对齐 Codex --add-dir）：工作目录之外、显式允许写入的绝对路径。
  extra_writable_dirs: [],
  pricing: {},
  mcp_presets: ["memory", "sequential-thinking", "fetch", "time"],
  mcp_preset_args: {},
  fallback_enabled: false, // 默认关闭：模型自动兜底只由用户自己开启（用户定的安全事项）。
  fallback_providers: ["deepseek", "xai", "ollama"],
  custom_providers: {},
  sandbox: "auto",
  // 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——沙箱模式与默认网络。
  // sandbox_mode 默认 workspace-write；sandbox_allow_net 默认 false（断网）。
  sandbox_mode: "workspace-write",
  sandbox_allow_net: false,
  e2b_template: "base",
  e2b_timeout: 3600,
  e2b_sandbox_id: null,
  // 缺口 6：原生应用连接器。默认全部关闭（显式 opt-in）；这里只有开关，
  // 绝不放 client_id / client_secret / token——凭证只存密码箱（见 vault.ts）。
  // 目前只有 gmail：{ enabled: false }。
  connectors: { gmail: { enabled: false } },
  // 缺口 10：独立审查层（学 Dots Auto-review / Meta Muse Sentinel / Goose
  // Adversary Mode）。默认关闭（显式 opt-in）；开启后敏感工具调用先过独立
  // 审查 agent（独立上下文、只读原始任务与最近消息、便宜模型），结论进证据链；
  // 审查失败即拦截（fail-closed，不学 Goose 的 fail-open）。
  // provider/model 不填时沿用 smart_approvals.reviewer_*，再没有用 deepseek /
  // deepseek-flash；tools 不填时用默认被审集（write/edit/apply_patch/shell/
  // memory_forget/memory_delete/gmail_send/http_post/submit_bughunt_report/marketplace_install/marketplace_publish）；rules 是用户用自然语言
  // 写的额外审查规则（审查提示里原样交给审查模型）。
  reviewer: { enabled: false, provider: null, model: null, tools: null, rules: [] },
  // 缺口 13：验收者（学 MiniMax verifier / Devin 协调者 / Gas Town 合并队列）。
  // 默认关闭（显式 opt-in）；开启后并行子 agent 的产出合入前先过验收门
  // （确定性检查 + 便宜模型复核，结论进证据链）；rework 默认关闭，开了也
  // 最多重做 1 次（受委派预算与成本硬顶约束）。provider/model 不填时沿用
  // reviewer 的便宜模型链（smart_approvals.reviewer_*，再没有用 deepseek /
  // deepseek-flash）；rules 是用户用自然语言写的额外验收规则。
  verifier: { enabled: false, provider: null, model: null, rework: false, rules: [] },
  // 缺口 11：技能自沉淀闭环（学 OpenClaw Skill Workshop / Hermes 自写技能）。
  // 默认关闭（显式 opt-in）；开启后成功运行收尾时自动起草技能草稿（Markdown +
  // frontmatter，附来源运行与质量分），低质草稿出生即归档；安装永远要人批准
  // （`nyra skills approve`），自动起草 ≠ 自动安装。min_steps 是起草门槛
  // （一次运行至少这么多次工具调用）；auto_archive_days 是已装技能多久没人用
  // 就归档（`nyra skills sweep` 用）；require_verified 为 true 时只有 verified
  // 的运行才能沉淀。
  skill_sedimentation: { enabled: false, min_steps: 3, auto_archive_days: 30, require_verified: false },
};

export const VALID_MODES = ["readonly", "auto", "full", "creator"] as const;
export const VALID_SANDBOXES = ["auto", "local", "bwrap", "e2b"] as const;
// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——三档沙箱模式。
export const VALID_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export const PLAINTEXT_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** 自定义 provider 条目（config.json 里是 snake_case）转内置预置格式。 */
export function normalizeCustomPreset(raw: Record<string, unknown>): ProviderPreset {
  return {
    baseUrl: (raw.base_url as string | null) ?? null,
    defaultModel: (raw.default_model as string | null) ?? null,
    envKey: (raw.env_key as string | null) ?? "NYRA_API_KEY",
    connector: (raw.connector as string | null) ?? null,
    allowedHosts: Array.isArray(raw.allowed_hosts) ? (raw.allowed_hosts as string[]) : [],
    models: Array.isArray(raw.models) ? (raw.models as string[]) : [],
  };
}

/** 查预置：先看 config.custom_providers（snake_case 条目要归一化），再看内置 14 个。 */
export function lookupPreset(config: Record<string, unknown>, name: string): ProviderPreset | undefined {
  const custom = (config.custom_providers as Record<string, Record<string, unknown>> | undefined)?.[name];
  if (custom && typeof custom === "object") return normalizeCustomPreset(custom);
  return PROVIDERS[name];
}

/** 读 NYRA_<name>，旧 ANGEL_<name> 作回退（spec 07 第 3 条：回退无警告）。 */
export function envVar(name: string): string | undefined {
  return process.env["NYRA_" + name] || process.env["ANGEL_" + name] || undefined;
}

/**
 * Nyra 数据目录：NYRA_HOME（ANGEL_HOME 回退）> ~/.nyra；
 * 旧 ~/.angel 只有在 ~/.nyra 不存在时才复用（与 Python 版 _default_home 一致）。
 */
export function resolveHome(homeOverride?: string): string {
  const fromEnv = homeOverride || envVar("HOME");
  if (fromEnv) return fromEnv;
  const home = homedir();
  const fresh = join(home, ".nyra");
  const legacy = join(home, ".angel");
  if (!existsSync(fresh) && existsSync(legacy)) return legacy;
  return fresh;
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

/** 读 config.json（不存在则按 Python 版行为建默认文件）；损坏时返回默认值，不抛错。 */
export function loadConfig(home?: string): Record<string, unknown> {
  const h = home ?? resolveHome();
  const cfg: Record<string, unknown> = { ...DEFAULT_CONFIG };
  const path = configPath(h);
  if (!existsSync(path)) {
    try {
      mkdirSync(h, { recursive: true, mode: 0o700 });
    } catch { /* 已存在时不改权限，与 Python 版一致 */ }
    if (process.platform !== "win32") {
      try { chmodSync(h, 0o700); } catch { /* Windows 没有 POSIX 权限位 */ }
    }
    try {
      writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    } catch { /* 只读目录时返回默认配置即可 */ }
    return cfg;
  }
  try {
    const saved = JSON.parse(readFileSync(path, "utf-8"));
    if (saved && typeof saved === "object") Object.assign(cfg, saved);
  } catch { /* 损坏的 config.json 按默认值处理 */ }
  return cfg;
}

/** 写回 config.json（只写 provider/model 等设置，绝不写 Key——与 Python 版一致）。 */
export function saveConfig(home: string, patch: Record<string, unknown>): void {
  const cfg = loadConfig(home);
  Object.assign(cfg, patch);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(configPath(home), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

/** 明文 http:// 只允许本机地址（与 Python 版 plaintext_http_error 一致）。 */
export function plaintextHttpError(name: string, baseUrl: string): string | null {
  const url = (baseUrl || "").trim();
  if (url.toLowerCase().split("://", 1)[0] !== "http") return null;
  let host = "";
  try { host = (new URL(url).hostname || "").replace(/\.$/, "").toLowerCase(); } catch { host = ""; }
  if (PLAINTEXT_HTTP_HOSTS.has(host)) return null;
  return `provider ${name} 的 base_url 使用了明文 http:// 且不是本机地址（${url}），API Key 会随请求明文传输；请改用 https://，http:// 只允许本机地址（localhost、127.0.0.1、::1）。`;
}

/** 内置预置 + config["custom_providers"] 合并；非法自定义条目抛 ValueError 式错误。 */
export function getProviderPresets(config?: Record<string, unknown> | null): Record<string, ProviderPreset> {
  const presets: Record<string, ProviderPreset> = {};
  for (const [name, preset] of Object.entries(PROVIDERS)) presets[name] = { ...preset };
  const cfg = config ?? {};
  const custom = (cfg.custom_providers as Record<string, unknown>) ?? {};
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) {
    throw new Error("custom_providers must be an object");
  }
  for (const [name, entry] of Object.entries(custom)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Custom provider ${name} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const baseUrl = e.base_url;
    const defaultModel = e.default_model;
    if (!baseUrl || typeof baseUrl !== "string") throw new Error(`自定义 provider ${name} 的配置里缺少 base_url`);
    if (!defaultModel || typeof defaultModel !== "string") throw new Error(`Custom provider ${name} needs default_model`);
    const scheme = baseUrl.trim().toLowerCase().split("://", 1)[0];
    if (!baseUrl.includes("://") || (scheme !== "http" && scheme !== "https")) {
      throw new Error(`Custom provider ${name} base_url must start with http:// or https://`);
    }
    const err = plaintextHttpError(name, baseUrl);
    if (err !== null) throw new Error(err);
    presets[name] = {
      baseUrl,
      defaultModel,
      envKey: (e.env_key as string | null) ?? null,
      connector: (e.connector as string | null) ?? null,
      allowedHosts: [...((e.allowed_hosts as string[]) ?? [])],
      models: [...((e.models as string[]) ?? [])],
    };
  }
  return presets;
}

export function knownProviderNames(config?: Record<string, unknown> | null): Set<string> {
  return new Set(Object.keys(getProviderPresets(config)));
}

export type KeySource = "env" | "vault" | "file" | "connector" | "none" | "local";

export interface ResolvedProvider {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  auth: "cli" | "env" | "connector" | "none";
  connectorName: string | null;
  allowedHosts: string[];
  keySource: KeySource;
  /** Key 是否已就绪（env/vault 里有，或本地 provider 不需要 Key，或连接器可用）。 */
  hasKey: boolean;
  envKey: string | null;
  preset: ProviderPreset;
}

export function resolveProvider(opts: {
  home: string;
  config: Record<string, unknown>;
  providerName?: string;
  model?: string;
}): ResolvedProvider {
  const cfg = opts.config;
  const name = opts.providerName || envVar("PROVIDER") || (cfg.provider as string) || "deepseek";
  const presets = getProviderPresets(cfg);
  if (!(name in presets)) {
    throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(presets).sort().join(", ")}`);
  }
  const preset = presets[name];

  // 模型解析：显式 > NYRA_MODEL > 配置（同 provider 时）> 预置默认。
  // 配置里的模型若与当前 provider 不符且不在当前 provider 已知模型里，丢掉它。
  let resolvedModel: string | undefined = opts.model;
  if (resolvedModel !== undefined) {
    const presetModels = preset.models ?? [];
    if (
      cfg.provider !== name &&
      resolvedModel === cfg.model &&
      presetModels.length > 0 &&
      !presetModels.includes(resolvedModel)
    ) {
      resolvedModel = undefined;
    }
  }
  if (resolvedModel === undefined) resolvedModel = envVar("MODEL");
  if (resolvedModel === undefined) {
    resolvedModel = cfg.provider === name && cfg.model ? (cfg.model as string) : preset.defaultModel ?? undefined;
  }

  if (preset.auth === "cli") {
    if (!resolvedModel) throw new Error(`Provider ${name} needs a model`);
    return {
      name, baseUrl: preset.baseUrl || `cli://${name}`, model: resolvedModel,
      apiKey: null, auth: "cli", connectorName: null,
      allowedHosts: [...(preset.allowedHosts ?? [])],
      keySource: "local", hasKey: true, envKey: null, preset,
    };
  }

  let baseUrl: string;
  if (name === "custom") {
    baseUrl = envVar("BASE_URL") ?? "";
    if (!baseUrl) throw new Error(name === "custom" ? "Custom provider 需要 NYRA_BASE_URL" : `自定义 provider ${name} 的配置里缺少 base_url`);
  } else {
    baseUrl = preset.baseUrl ?? "";
  }
  const scheme = (baseUrl || "").trim().toLowerCase().split("://", 1)[0];
  if (!baseUrl.includes("://") || (scheme !== "http" && scheme !== "https")) {
    throw new Error(`Provider ${name} base_url must start with http:// or https://`);
  }
  const httpErr = plaintextHttpError(name, baseUrl);
  if (httpErr) throw new Error(httpErr);
  if (!resolvedModel) throw new Error("Custom provider needs NYRA_MODEL");

  const envKey = preset.envKey;
  let apiKey: string | null = envKey ? (process.env[envKey] ?? null) : null;
  apiKey = apiKey || envVar("API_KEY") || null;
  const connectorName = preset.connector ?? null;
  let keySource: KeySource = "none";
  if (apiKey !== null) {
    keySource = "env";
  } else if (envKey !== null && connectorName === null) {
    // 本地加密密码箱回退（无连接器时才读箱；绝不弹密码提示）。
    const fromVault = getCredential(envKey, opts.home);
    if (fromVault) {
      apiKey = fromVault;
      keySource = "vault";
    }
  }
  // 界面（首次引导 / 设置 → 模型）保存的 Key：密码箱已解锁时在密码箱里，否则在 keys.json（0600）。
  // 连接器 provider 在 Node 侧没有凭证注入，所以用户在界面里填了 Key 也照样用上。
  if (apiKey === null && envKey !== null) {
    const fromVault = connectorName !== null ? getCredential(envKey, opts.home) : null;
    if (fromVault) {
      apiKey = fromVault;
      keySource = "vault";
    } else {
      const fromFile = getFileKey(envKey, opts.home);
      if (fromFile) {
        apiKey = fromFile;
        keySource = "file";
      }
    }
  }
  let auth: ResolvedProvider["auth"];
  if (apiKey !== null) auth = "env";
  else if (connectorName !== null) auth = "connector";
  else if (envKey !== null) auth = "env";
  else auth = "none";
  if (connectorName !== null && apiKey === null) keySource = "none";
  if (name === "ollama") { keySource = "local"; auth = "none"; }

  return {
    name, baseUrl, model: resolvedModel, apiKey, auth, connectorName,
    allowedHosts: [...(preset.allowedHosts ?? [])],
    keySource, hasKey: apiKey !== null || auth === "none" || name === "ollama",
    envKey, preset,
  };
}

/**
 * 兜底链（用户定的安全红线：默认关闭）。
 * 开关优先级：显式 enabled 参数 > NYRA_FALLBACK 环境变量 > config fallback_enabled > 默认 false。
 * 链顺序：显式 chainOverride 参数 > NYRA_FALLBACK_PROVIDERS 环境变量 > config fallback_providers > 默认 [deepseek, xai, ollama]。
 * 允许列表就是 fallback_providers：只切列表里的；显式空列表 = 无兜底。
 * CLI provider 绝不参与兜底（既不当目标、也不从它身上切）；未知名字跳过并报 stderr。
 *
 * 缺口 5：chainOverride 是该 agent 自己的备用链（群聊机器人的
 * fallback_providers）；每 agent 的显式 opt-in 就落在这里——机器人
 * 传自己的 enabled/chainOverride，null = 沿用全局配置（老行为不变）。
 */
export function resolveFallbackChain(
  config: Record<string, unknown>,
  primary: string,
  enabled?: boolean,
  chainOverride?: string[] | null,
): string[] {
  let on: boolean;
  if (enabled !== undefined) {
    on = enabled;
  } else {
    const envFlag = envVar("FALLBACK");
    if (envFlag !== undefined) {
      on = !["0", "false", "no", "off"].includes(envFlag.trim().toLowerCase());
    } else {
      const raw = config.fallback_enabled;
      on = typeof raw === "string"
        ? !["0", "false", "no", "off"].includes(raw.trim().toLowerCase())
        : raw === true;
    }
  }
  if (!on) return [primary];

  const presets = getProviderPresets(config);
  if (presets[primary]?.auth === "cli") return [primary];

  let chainNames: string[];
  if (chainOverride !== undefined && chainOverride !== null) {
    chainNames = [...chainOverride];
  } else if (config.fallback_providers === undefined || config.fallback_providers === null) {
    chainNames = ["deepseek", "xai", "ollama"];
  } else {
    chainNames = [...(config.fallback_providers as string[])];
  }
  const envChain = envVar("FALLBACK_PROVIDERS");
  if (envChain !== undefined && (chainOverride === undefined || chainOverride === null)) {
    chainNames = envChain.split(",").map((p) => p.trim()).filter(Boolean);
  }

  const known = knownProviderNames(config);
  const names = [primary];
  const skipped: string[] = [];
  const skippedCli: string[] = [];
  for (const n of chainNames) {
    if (known.has(n) && !names.includes(n)) {
      if (presets[n]?.auth === "cli") { skippedCli.push(n); continue; }
      names.push(n);
    } else if (!known.has(n)) {
      skipped.push(n);
    }
  }
  if (skipped.length) console.error(`兜底允许列表里跳过了未知 provider：${skipped.join(", ")}`);
  if (skippedCli.length) console.error(`兜底允许列表里跳过了 CLI provider（不进兜底链）：${skippedCli.join(", ")}`);
  return names;
}

/**
 * 缺口 5：对话中途手动换模型的允许列表——主 agent 换模型只能切到这些
 * 服务商。口径与兜底链的“允许列表”是同一份（primary + fallback_providers，
 * 未知名字与 CLI provider 照样跳过），但不受 fallback_enabled 开关影响：
 * 手动换是用户当场点的显式动作，不是静默自动切换；开关只管“触顶时
 * 自动换不换”。显式空 fallback_providers 时列表只剩 primary。
 */
export function resolveSwitchAllowlist(
  config: Record<string, unknown>,
  primary: string,
): string[] {
  return resolveFallbackChain(config, primary, true);
}

export function listProfiles(config?: Record<string, unknown> | null): string[] {
  const cfg = config ?? {};
  const profiles = cfg.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return [];
  return Object.keys(profiles).sort();
}

export function resolveProfile(
  profileName?: string | null,
  config?: Record<string, unknown> | null,
): { provider: string; model: string | null; mode: string } {
  const cfg = config ?? {};
  const base = {
    provider: (cfg.provider as string) || "deepseek",
    model: (cfg.model as string | null) ?? null,
    mode: (cfg.mode as string) || "auto",
  };
  const name = profileName || envVar("PROFILE") || (cfg.profile as string | undefined);
  if (!name) return base;
  const profiles = (cfg.profiles as Record<string, unknown>) ?? {};
  if (!profiles || typeof profiles !== "object" || !(name in profiles)) {
    const available = profiles && typeof profiles === "object" ? Object.keys(profiles).sort().join(", ") : "";
    const hint = available ? ` Available: ${available}` : "";
    throw new Error(`Unknown profile: ${name}.${hint}`);
  }
  const prof = profiles[name] as Record<string, unknown>;
  if (!prof || typeof prof !== "object") throw new Error(`Profile ${name} must be an object`);
  const merged = { ...base };
  for (const key of ["provider", "model", "mode"] as const) {
    if (prof[key]) merged[key] = prof[key] as never;
  }
  return merged;
}

export interface SandboxSettings {
  backend: string;
  sandboxId: string | null;
  template: string;
  timeout: number;
  // 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——模式与网络开关。
  // mode：config.sandbox_mode / NYRA_SANDBOX_MODE，默认 workspace-write；
  // allowNet：config.sandbox_allow_net / NYRA_SANDBOX_ALLOW_NET=1，默认 false（断网）。
  mode: string;
  allowNet: boolean;
}

export function resolveSandbox(
  config?: Record<string, unknown> | null,
  backend?: string | null,
  sandboxId?: string | null,
  template?: string | null,
  timeout?: number | null,
): SandboxSettings {
  const cfg = config ?? {};
  // config.enforced 优先（锁了沙箱就不能被 config 改成 local）；环境变量仍最高，供排障。
  const chosen = backend || envVar("SANDBOX") || ((effectiveValue(cfg, "sandbox") as string | undefined)) || "auto";
  if (!(VALID_SANDBOXES as readonly string[]).includes(chosen)) {
    throw new Error(`Invalid sandbox backend: ${chosen}. Valid backends: ${VALID_SANDBOXES.join(", ")}`);
  }
  const modeRaw = envVar("SANDBOX_MODE") || ((effectiveValue(cfg, "sandbox_mode") as string | undefined)) || "workspace-write";
  if (!(VALID_SANDBOX_MODES as readonly string[]).includes(modeRaw)) {
    throw new Error(`Invalid sandbox_mode: ${modeRaw}. Valid modes: ${VALID_SANDBOX_MODES.join(", ")}`);
  }
  const allowNetEnv = envVar("SANDBOX_ALLOW_NET");
  const allowNet = allowNetEnv !== undefined
    ? ["1", "true", "yes", "on"].includes(allowNetEnv.trim().toLowerCase())
    : (cfg.sandbox_allow_net as boolean | undefined) === true;
  let resolvedTimeout = timeout ?? null;
  if (resolvedTimeout === null) {
    const envTimeout = envVar("E2B_TIMEOUT");
    if (envTimeout !== undefined) {
      const parsed = parseInt(envTimeout, 10);
      resolvedTimeout = Number.isNaN(parsed) ? null : parsed;
    }
  }
  if (resolvedTimeout === null) {
    resolvedTimeout = (cfg.e2b_timeout as number) || 3600;
  }
  return {
    backend: chosen,
    sandboxId: sandboxId || envVar("E2B_SANDBOX_ID") || (cfg.e2b_sandbox_id as string) || null,
    template: template || envVar("E2B_TEMPLATE") || (cfg.e2b_template as string) || "base",
    timeout: resolvedTimeout,
    mode: modeRaw,
    allowNet,
  };
}

export function validateMode(mode: string): string {
  if (!(VALID_MODES as readonly string[]).includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Valid modes: ${VALID_MODES.join(", ")}`);
  }
  return mode;
}
