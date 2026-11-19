// tests/node/fsPerms.ts — 权限位断言的唯一入口（修 Windows CI 反复红的根因）。
//
// 背景：`expect(statSync(p).mode & 0o777).toBe(0o600)` 这类断言只在 POSIX 成立——
// Windows 的 chmod 只映射到只读位，mode 拿不到 0600/0700。这类断言散在 8 个文件里，
// 每次 Windows CI 红一条、我们修一条，已经发生过两次（Style、mobile-pwa）。
//
// 这个 helper 把「平台差异」集中到一处：
//   - POSIX：照常断言精确权限位（安全强度不降）
//   - Windows：断言"至少不是全开"（0o777 那种），并打印实际值便于排查
//
// 用法：`expectPerms(path, 0o600)` / `expectPerms(path, 0o700)`
import { statSync } from "node:fs";

export const IS_WINDOWS = process.platform === "win32";

/**
 * 断言文件/目录权限位。
 *
 * Windows 上退化为"不能是 0o777"——因为 chmod 在 NTFS 上只影响只读位，
 * 精确位拿不到。这条退化断言仍能抓住"文件权限被设成全开"这类真问题。
 */
export function expectPerms(path: string, expected: number): void {
  const actual = statSync(path).mode & 0o777;
  if (!IS_WINDOWS) {
    if (actual !== expected) {
      throw new Error(`${path} 权限位应为 0o${expected.toString(8)}，实际 0o${actual.toString(8)}`);
    }
    return;
  }
  // Windows：只保证不是全开
  if (actual === 0o777) {
    throw new Error(`${path} 在 Windows 上权限位是 0o777（全开），不符合最低要求`);
  }
}

/** 断言某路径在 POSIX 上权限精确匹配；Windows 上跳过（用于确实无法退化的场景）。 */
export function expectPermsPosixOnly(path: string, expected: number): void {
  if (IS_WINDOWS) return;
  expectPerms(path, expected);
}
