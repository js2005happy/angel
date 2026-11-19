// src/configTransfer.ts — 配置导出 / 导入（对齐 Alma 的 Settings Export/Import）。
//
// 为什么要它：Nyra 的红线（permissions / deny_read_globs / max_cost_usd / pricing /
// 验证命令 / 沙箱模式）是"团队共识"，不是"个人偏好"。现在只能靠人肉抄 config.json，
// 抄漏一条就少一道防线。导出/导入让一套红线可以像代码一样被 review、被版本化。
//
// 两条安全纪律：
//   1. **默认剔除密钥**：api_key / token / secret / password 一律不导出，
//      custom_providers 里的 env_key 名字保留（那是变量名，不是密钥本身）
//   2. **导入不静默覆盖**：逐键报告"将覆盖 / 新增 / 忽略"，支持 --dry-run 先看后写
import { DANGEROUS_KEYS, SECRET_KEY_RE } from "./configSecurity.ts";

export interface ExportResult {
  payload: { format: string; version: number; exported_at: string; config: Record<string, unknown> };
  /** 被剔除的字段路径（让用户知道导出的不是完整配置）。 */
  redacted: string[];
}

export const CONFIG_FORMAT = "nyra-config";
export const CONFIG_FORMAT_VERSION = 1;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** 递归剔除密钥字段；返回新对象，不改原对象。 */
export function redactSecrets(config: Record<string, unknown>, includeSecrets = false): { config: Record<string, unknown>; redacted: string[] } {
  const redacted: string[] = [];
  if (includeSecrets) return { config: structuredCloneSafe(config), redacted };
  const walk = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (!isPlainObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const keyPath = path ? `${path}.${k}` : k;
      if (SECRET_KEY_RE.test(k)) {
        redacted.push(keyPath);
        continue;
      }
      out[k] = walk(v, keyPath);
    }
    return out;
  };
  return { config: walk(config, "") as Record<string, unknown>, redacted };
}

function structuredCloneSafe(v: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
  } catch {
    return { ...v };
  }
}

/** 组装导出内容。 */
export function exportConfig(config: Record<string, unknown>, opts: { includeSecrets?: boolean; now?: string } = {}): ExportResult {
  const { config: clean, redacted } = redactSecrets(config, opts.includeSecrets ?? false);
  return {
    payload: {
      format: CONFIG_FORMAT,
      version: CONFIG_FORMAT_VERSION,
      exported_at: opts.now ?? new Date().toISOString(),
      config: clean,
    },
    redacted,
  };
}

export interface ImportPreview {
  ok: boolean;
  /** 致命错误（格式不对，不能导入）。 */
  errors: string[];
  /** 非致命提示（忽略的键、可疑键）。 */
  warnings: string[];
  willOverwrite: string[];
  willAdd: string[];
  /** 计算出的合并结果（ok 时才有意义）。 */
  merged: Record<string, unknown>;
}

/**
 * 校验并预览导入。默认**只合并白名单之外也允许**，但危险键（会削弱安全）必须显式确认。
 * 不读文件、不写文件——纯函数，便于单测与 --dry-run。
 */
export function previewImport(raw: unknown, current: Record<string, unknown>, opts: { allowDangerous?: boolean } = {}): ImportPreview {
  const errors: string[] = [];
  const warnings: string[] = [];
  const willOverwrite: string[] = [];
  const willAdd: string[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["文件内容不是 JSON 对象"], warnings, willOverwrite, willAdd, merged: {} };
  }
  const wrapper = raw as Record<string, unknown>;
  if (wrapper.format !== CONFIG_FORMAT) {
    return {
      ok: false,
      errors: [`不是 Nyra 配置导出文件（缺少 "format": "${CONFIG_FORMAT}"）`],
      warnings, willOverwrite, willAdd, merged: {},
    };
  }
  const version = wrapper.version;
  if (typeof version !== "number" || version > CONFIG_FORMAT_VERSION) {
    return {
      ok: false,
      errors: [`导出文件版本 ${String(version)} 高于本程序支持的 ${CONFIG_FORMAT_VERSION}，请升级 Nyra`],
      warnings, willOverwrite, willAdd, merged: {},
    };
  }
  const incoming = wrapper.config;
  if (!isPlainObject(incoming)) {
    return { ok: false, errors: ["config 字段缺失或不是对象"], warnings, willOverwrite, willAdd, merged: {} };
  }

  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(incoming)) {
    if (SECRET_KEY_RE.test(k)) {
      warnings.push(`忽略密钥字段 ${k}（导入不覆盖本机凭据）`);
      continue;
    }
    if (DANGEROUS_KEYS.includes(k) && !opts.allowDangerous) {
      warnings.push(`忽略会削弱安全的字段 ${k}（确需导入请加 --allow-dangerous）`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(current, k)) willOverwrite.push(k);
    else willAdd.push(k);
    merged[k] = v;
  }
  return { ok: true, errors, warnings, willOverwrite, willAdd, merged };
}

/** 人类可读的导入预览。 */
export function formatImportPreview(p: ImportPreview, file: string): string {
  const lines: string[] = [];
  lines.push(p.ok ? `导入预览（${file}）：可以导入` : `导入预览（${file}）：不可导入`);
  if (p.errors.length) {
    for (const e of p.errors) lines.push(`  ❌ ${e}`);
    return lines.join("\n");
  }
  lines.push(`  将覆盖：${p.willOverwrite.length ? p.willOverwrite.join("、") : "（无）"}`);
  lines.push(`  将新增：${p.willAdd.length ? p.willAdd.join("、") : "（无）"}`);
  for (const w of p.warnings) lines.push(`  ⚠️  ${w}`);
  if (!p.willOverwrite.length && !p.willAdd.length) lines.push("  没有任何字段会变化。");
  return lines.join("\n");
}
