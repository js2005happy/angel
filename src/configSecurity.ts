// src/configSecurity.ts — 配置里的"密钥"与"危险键"清单（导出/导入共用的唯一来源）。
//
// 拆成独立文件是为了让 configTransfer 与将来的 doctor 检查共用同一份规则，
// 避免"导出时剔除了、导入时又写回去"这类两边不一致的坑。

/** 键名命中即视为密钥：导出时剔除，导入时忽略（绝不覆盖本机凭据）。 */
export const SECRET_KEY_RE = /(api[_-]?key|apikey|secret|token|password|passwd|credential|private[_-]?key|authorization)/i;

/**
 * 会削弱安全的配置键：导入时必须显式 `--allow-dangerous` 才接受。
 * 判断标准是"改它等于关掉某道防线"，而不是"它看起来危险"。
 */
export const DANGEROUS_KEYS: readonly string[] = [
  "sandbox",            // 改成 local = 退出 OS 沙箱
  "sandbox_mode",       // 改成 danger-full-access = 放弃隔离
  "sandbox_allow_net",  // 放开联网
  "permissions",        // 可能把 deny 清空、把 Bash 全量放行
  "deny_read_globs",    // 清空 = 敏感文件可读
  "hooks",              // 关掉钩子 = 少一层拦截与审计
  "max_cost_usd",       // 删掉 = 没有成本硬顶
];

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function isDangerousKey(key: string): boolean {
  return DANGEROUS_KEYS.includes(key);
}
