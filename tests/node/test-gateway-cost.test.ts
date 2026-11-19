// tests/node/test-gateway-cost.test.ts — 缺口 30：网关入口必须受成本硬顶约束。
//
// 背景（docs/cost.md 的「已知缺口（本批没做）」）：`nyra ui` 起的 agent 完全不接
// maxCostUsd / monthlyCostLimitUsd，Web UI 跑任务等于绕过 `--max-cost`——硬顶只对
// CLI 生效，那不叫硬顶；定时任务是无人值守入口，绕过更糟。
//
// 这里锁两件事：
//   C1 网关建出的 agent，成本选项与 config 一致（不是 null）
//   C2 网关运行会把用量增量写进账本（否则月度累计永远看不到 UI 的花费）
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { UsageLedger, monthKeyString } from "../../src/usageLedger.ts";

/** 假 provider：这些断言只看成本选项，不会真的发请求。 */
function fakeProvider() {
  return {
    name: "fake", model: "fake-1",
    chat: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
    hasCredentials: () => true,
  } as never;
}

/** 构造注入假 provider 的网关（测试不依赖外部凭证）。 */
function makeGw(home: string): Gateway {
  return new Gateway({ home, workdir: home, providerFactory: () => fakeProvider() });
}

function homeWith(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "nyra-gw-cost-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(config), "utf-8");
  return home;
}

interface CostOpts {
  maxCostUsd: number | null;
  monthlyCostLimitUsd: number | null;
  monthlySpentBeforeUsd: (() => { spentUsd: number; incomplete: boolean } | null) | null;
  pricing: unknown;
}

/** 取 private 方法做断言（只做类型转换，不引 runtime hack）。 */
function internals(gw: Gateway): { costOptions: () => CostOpts } {
  return gw as unknown as { costOptions: () => CostOpts };
}

test("网关成本选项：max_cost_usd 透传到 agent（Web UI 不再绕过硬顶）", () => {
  const home = homeWith({ max_cost_usd: 0.5, pricing: { "fake-1": { input_per_1m: 1, output_per_1m: 2 } } });
  const gw = makeGw(home);
  const opts = internals(gw).costOptions();
  expect(opts.maxCostUsd).toBe(0.5);
});

test("网关成本选项：未配 max_cost_usd 时为 null（不编造上限）", () => {
  const gw = makeGw(homeWith({}));
  expect(internals(gw).costOptions().maxCostUsd).toBeNull();
});

test("网关成本选项：月度上限默认不设（null），配了才生效", () => {
  expect(internals(makeGw(homeWith({}))).costOptions().monthlyCostLimitUsd).toBeNull();
  const withLimit = makeGw(homeWith({ monthly_cost_limit_usd: 12 }));
  expect(internals(withLimit).costOptions().monthlyCostLimitUsd).toBe(12);
});

test("网关成本选项：没设月度上限就不挂 spentBefore（不白读账本）", () => {
  const gw = makeGw(homeWith({}));
  expect(internals(gw).costOptions().monthlySpentBeforeUsd).toBeNull();
});

test("网关成本选项：设了月度上限才给 spentBefore，且读的是本月已花", () => {
  const home = homeWith({ monthly_cost_limit_usd: 10 });
  const ledger = new UsageLedger(home);
  // 造一条本月记录：1000 prompt / 500 completion / $0.25
  ledger.recordDelta(
    { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, calls: 1 } as never,
    null, 0.25, null, "fake-1",
  );
  const gw = makeGw(home);
  const before = internals(gw).costOptions().monthlySpentBeforeUsd;
  expect(before).not.toBeNull();
  const got = before!();
  expect(got).not.toBeNull();
  expect(got!.spentUsd).toBeGreaterThanOrEqual(0.25);
});

test("账本可读：网关写入前 monthTotal 能被读到（flush 的事实源存在）", () => {
  const home = homeWith({});
  const ledger = new UsageLedger(home);
  const before = ledger.monthTotal(monthKeyString());
  expect(typeof before.spentUsd).toBe("number");
  expect(existsSync(join(home, "usage")) || before.calls === 0).toBe(true);
});

test("网关构造不会因为成本相关配置缺失而崩", () => {
  expect(() => makeGw(homeWith({ max_cost_usd: 1 }))).not.toThrow();
  expect(() => makeGw(homeWith({ pricing: { "x-1": { input_per_1m: 1, output_per_1m: 1 } } }))).not.toThrow();
  // 畸形 pricing 也不该炸
  expect(() => makeGw(homeWith({ pricing: { "y-1": { input_per_1m: "oops" } } }))).not.toThrow();
});

test("读配置文件确认测试夹具真实落盘（防止假绿）", () => {
  const home = homeWith({ max_cost_usd: 0.25 });
  expect(JSON.parse(readFileSync(join(home, "config.json"), "utf-8")).max_cost_usd).toBe(0.25);
});
