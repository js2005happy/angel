// src/config.ts — 配置解析，与 Python 版 nyra/config.py 同格式、同语义。
// 第 2 阶段补全：第 1 阶段的骨架 + getProviderPresets 校验、resolveProfile、
// resolveSandbox、validateMode、兜底链完整语义（CLI 排除、未知跳过、空列表=无兜底）、
// 密码箱回退（vault.ts 解密，不再只判存在）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCredential } from "./vault.ts";

export const VERSION = "0.5.0";

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

export type KeySource = "env" | "vault" | "connector" | "none" | "local";

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
 * 链顺序：NYRA_FALLBACK_PROVIDERS 环境变量 > config fallback_providers > 默认 [deepseek, xai, ollama]。
 * 允许列表就是 fallback_providers：只切列表里的；显式空列表 = 无兜底。
 * CLI provider 绝不参与兜底（既不当目标、也不从它身上切）；未知名字跳过并报 stderr。
 */
export function resolveFallbackChain(
  config: Record<string, unknown>,
  primary: string,
  enabled?: boolean,
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
  if (config.fallback_providers === undefined || config.fallback_providers === null) {
    chainNames = ["deepseek", "xai", "ollama"];
  } else {
    chainNames = [...(config.fallback_providers as string[])];
  }
  const envChain = envVar("FALLBACK_PROVIDERS");
  if (envChain !== undefined) {
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
  const chosen = backend || envVar("SANDBOX") || (cfg.sandbox as string) || "auto";
  if (!(VALID_SANDBOXES as readonly string[]).includes(chosen)) {
    throw new Error(`Invalid sandbox backend: ${chosen}. Valid backends: ${VALID_SANDBOXES.join(", ")}`);
  }
  const modeRaw = envVar("SANDBOX_MODE") || (cfg.sandbox_mode as string) || "workspace-write";
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
