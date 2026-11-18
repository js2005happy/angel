// src/vault/index.ts — 密码箱入口：重导出 src/vault.ts（第 2 阶段已实现，
// PBKDF2-HMAC-SHA256 200k 次 + HMAC-CTR，vault.json 字节级兼容 Python 版）。
export * from "../vault.ts";
import { statSync } from "node:fs";
import { vaultPath } from "../vault.ts";

/** vault.json 的权限位（Windows 返回 null：没有 POSIX 权限位）。 */
export function vaultMode(home: string): number | null {
  try {
    if (process.platform === "win32") return null;
    return statSync(vaultPath(home)).mode & 0o777;
  } catch {
    return null;
  }
}
