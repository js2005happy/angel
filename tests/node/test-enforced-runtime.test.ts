// tests/node/test-enforced-runtime.test.ts — config.enforced 必须真的在运行时生效。
//
// 背景（我自己的漏洞）：#82 加的 `config.enforced` 只接进了 CLI 的命令行选项，
// 而运行时的几条读取路径**仍直接读 config.json 顶层**：
//   · `deny_read_globs`（tools.ts 的禁读清单缓存）
//   · `permissions`（tools.ts 的权限规则缓存）
//   · `sandbox` / `sandbox_mode`（config.ts 的 resolveSandbox）
// 于是「锁了」其实没锁——功能做成摆设。这比没有这个功能更糟：用户以为自己锁住了。
//
// 这组测试锁的是**优先级**：enforced 值压过配置文件值，环境变量仍最高（排障用）。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveValue, effectiveStringList } from "../../src/enforcedConfig.ts";
import { isDenyReadPath, resetDenyReadCache } from "../../src/tools.ts";
import { resolveSandbox } from "../../src/config.ts";

function homeWith(cfg: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "nyra-enf-rt-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg), "utf-8");
  resetDenyReadCache();
  return home;
}

test("effectiveValue：enforced 优先于顶层同名字段", () => {
  expect(effectiveValue({ sandbox: "local", enforced: { sandbox: "bwrap" } }, "sandbox")).toBe("bwrap");
  expect(effectiveValue({ sandbox: "local" }, "sandbox")).toBe("local");
  expect(effectiveValue({ enforced: { sandbox: "bwrap" } }, "sandbox")).toBe("bwrap");
});

test("effectiveValue：没锁且没配 → undefined（不编默认值）", () => {
  expect(effectiveValue({}, "sandbox")).toBeUndefined();
  expect(effectiveValue(null, "sandbox")).toBeUndefined();
});

test("effectiveStringList：非数组 / 含非字符串项都过滤掉", () => {
  expect(effectiveStringList({ denied: 1 }, "denied")).toEqual([]);
  expect(effectiveStringList({ denied: [".env", "", 3, " *.pem "] }, "denied")).toEqual([".env", " *.pem "]);
});

test("运行时关键：锁了 deny_read_globs，顶层清空也拦得住", () => {
  const home = homeWith({
    deny_read_globs: [],                       // 用户（或 agent）把顶层清单清空
    enforced: { deny_read_globs: [".env"] },    // 管理员锁住
  });
  const ctx = { home, workdir: home } as never;
  expect(isDenyReadPath(ctx, join(home, ".env"))).not.toBeNull();
});

test("运行时关键：没锁时按顶层来（锁不生效的地方不能被误伤）", () => {
  const home = homeWith({ deny_read_globs: [], enforced: {} });
  const ctx = { home, workdir: home } as never;
  expect(isDenyReadPath(ctx, join(home, ".env"))).toBeNull();
});

test("运行时关键：锁了 sandbox，顶层改成 local 也不生效", () => {
  const r = resolveSandbox({ sandbox: "local", enforced: { sandbox: "bwrap" } });
  expect(String(r.backend)).toContain("bwrap");
});

test("运行时关键：锁了 sandbox_mode，顶层写 danger-full-access 也不生效", () => {
  const r = resolveSandbox({ sandbox_mode: "danger-full-access", enforced: { sandbox_mode: "read-only" } });
  expect(String(r.mode)).toBe("read-only");
});

test("没锁时 sandbox 仍按顶层走（回归保护）", () => {
  const r = resolveSandbox({ sandbox: "local" });
  expect(String(r.backend)).not.toContain("bwrap");
});
