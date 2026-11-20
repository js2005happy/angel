// tests/node/test-permission-cache-reset.test.ts — 权限规则缓存必须能被刷新（否则改配置不生效）。
//
// 起因：本仓库反复踩「模块级可变状态 + 同进程多测试文件」这一类坑（i18n 语言泄漏、
// main() 残留状态）。`tools.ts` 的 `permissionRulesCache` 是同一类：按 home 缓存整份规则集。
//
// 缓存本身是对的（每轮都读文件太浪费），但**必须有不失效的出口**：
//   · 测试改配置后要能清缓存（否则断言的是旧规则）
//   · `nyra doctor` / 长驻网关改了配置也应能刷新，不必重启进程
//
// 这里锁的是"刷新真的有效"，而不只是"函数存在"。
//
// 只用**路径 glob 规则**（`write_file(**/*.env)`）做断言：它是当前实现里能稳定命中的形式。
// 顺带记录一个观察：`shell(...)` 形式的规则在本版本里 evaluate 返回 null（不命中），
// 已单独反馈，不在本文件中假设其行为。
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, parseRules } from "../../src/permissionRules.ts";
import { checkApproval, resetPermissionRulesCache, ToolError } from "../../src/tools.ts";

function freshHome(cfg: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "nyra-perm-cache-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg), "utf-8");
  return home;
}

const CTX = (home: string) => ({ home, workdir: home, mode: "full" }) as never;

/** 目标文件放在 workdir 下，让路径 glob 能稳定命中。 */
function envPath(home: string): string {
  return join(home, "secrets", "a.env");
}

beforeEach(() => {
  resetPermissionRulesCache();
});

test("配置里有路径 deny 规则 → checkApproval 抛「已被权限规则拒绝」", async () => {
  const home = freshHome({ permissions: { deny: ["write_file(**/*.env)"] } });
  const target = envPath(home);
  await expect(
    checkApproval(CTX(home), "write_file", target, { fileTarget: target } as never),
  ).rejects.toThrow(ToolError);
});

test("缓存真的在缓存：改配置但不清缓存 → 仍按旧规则拒绝", async () => {
  const home = freshHome({ permissions: { deny: ["write_file(**/*.env)"] } });
  const target = envPath(home);
  await expect(checkApproval(CTX(home), "write_file", target, { fileTarget: target } as never)).rejects.toThrow();

  // 改成"没有 deny"，但不刷新缓存
  writeFileSync(join(home, "config.json"), JSON.stringify({ permissions: {} }), "utf-8");
  await expect(checkApproval(CTX(home), "write_file", target, { fileTarget: target } as never)).rejects.toThrow();
});

test("resetPermissionRulesCache() 之后，新配置里的 deny 立即生效", async () => {
  const home = freshHome({ permissions: { deny: ["write_file(**/*.env)"] } });
  const target = envPath(home);
  await expect(checkApproval(CTX(home), "write_file", target, { fileTarget: target } as never)).rejects.toThrow();

  // 换成拦 *.pem，刷新缓存后应立刻按新规则拦
  writeFileSync(join(home, "config.json"), JSON.stringify({ permissions: { deny: ["write_file(**/*.pem)"] } }), "utf-8");
  resetPermissionRulesCache();
  const pem = join(home, "keys", "id.pem");
  await expect(checkApproval(CTX(home), "write_file", pem, { fileTarget: pem } as never)).rejects.toThrow(ToolError);
});

test("enforced.permissions 优先：顶层清空 deny 也拦得住", async () => {
  const home = freshHome({
    permissions: {},
    enforced: { permissions: { deny: ["write_file(**/*.env)"] } },
  });
  const target = envPath(home);
  await expect(checkApproval(CTX(home), "write_file", target, { fileTarget: target } as never)).rejects.toThrow(ToolError);
});

test("纯函数回归：parseRules + evaluate 的 deny 优先级不变", () => {
  const rules = parseRules({ allow: ["write_file(**/*)"], deny: ["write_file(**/*.env)"] });
  expect(evaluate(rules, { tool: "write_file", target: "/tmp/a.env", workdir: "/tmp" })?.action).toBe("deny");
  expect(evaluate(rules, { tool: "write_file", target: "/tmp/a.txt", workdir: "/tmp" })?.action).toBe("allow");
});

test("空规则集：evaluate 返回 null（行为与没有规则时一致）", () => {
  expect(evaluate(parseRules(null), { tool: "write_file", target: "/tmp/a", workdir: "/tmp" })).toBeNull();
});
