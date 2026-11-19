// tests/node/test-redlines.test.ts — 上线红线自检（docs/VISION-NEXT.md 第七节的可执行化）。
// 三层判定：ok（已设好）/ warn（缺省可接受但长任务前该补）/ fail（明确危险）。
import { test, expect } from "bun:test";
import { checkRedlines, formatRedlines } from "../../src/redlines.ts";
import { parseRules } from "../../src/permissionRules.ts";

function rules(allow: string[] = [], deny: string[] = [], ask: string[] = []) {
  const r = parseRules({ allow, ask, deny });
  return { allow: r.allow, ask: r.ask, deny: r.deny };
}

function good() {
  return {
    config: { max_cost_usd: 5, pricing: { m: { input_per_1m: 1, output_per_1m: 2 } }, verify_command: "npm test" },
    sandbox: { level: "bwrap", backend: "bwrap" },
    permissions: rules(["Bash(git *)"], ["Bash(rm -rf *)"]),
    hasCostLimit: true,
  };
}

test("全绿：无 fail、无 warn", () => {
  const r = checkRedlines(good());
  expect(r.ok).toBe(true);
  expect(r.findings.some((f) => f.level !== "ok")).toBe(false);
  expect(r.verdict).toContain("全绿");
});

test("缺成本上限 → warn（长任务会烧钱）", () => {
  const r = checkRedlines({ ...good(), hasCostLimit: false, config: { ...good().config, max_cost_usd: undefined } });
  expect(r.ok).toBe(true);
  expect(r.findings.some((f) => f.code === "cost-limit-missing")).toBe(true);
  expect(r.verdict).toContain("红线未设");
});

test("缺定价 → warn（金额未知，硬顶失效）", () => {
  const r = checkRedlines({ ...good(), config: { ...good().config, pricing: {} } });
  expect(r.findings.some((f) => f.code === "pricing-missing")).toBe(true);
});

test("工具级沙箱 → warn，并给出平台修复建议", () => {
  const r = checkRedlines({ ...good(), sandbox: { level: "tool-level", backend: "local" } });
  const f = r.findings.find((x) => x.code === "sandbox-tool-level");
  expect(f).toBeTruthy();
  expect(f!.fix).toContain("bwrap");
});

test("danger-full-access → fail（明确放弃隔离）", () => {
  const r = checkRedlines({ ...good(), config: { ...good().config, sandbox_mode: "danger-full-access" } });
  expect(r.ok).toBe(false);
  expect(r.findings.some((f) => f.code === "sandbox-danger-mode" && f.level === "fail")).toBe(true);
});

test("没有 deny 规则 → warn", () => {
  const r = checkRedlines({ ...good(), permissions: rules(["Bash(git *)"]) });
  expect(r.findings.some((f) => f.code === "deny-rules-empty")).toBe(true);
});

test("allow 里裸 Bash → fail（等于关掉审批）", () => {
  const r = checkRedlines({ ...good(), permissions: rules(["Bash"], ["Bash(rm -rf *)"]) });
  expect(r.ok).toBe(false);
  expect(r.findings.some((f) => f.code === "allow-all-shell" && f.level === "fail")).toBe(true);
});

test("Bash(git *) 不算裸 Bash（不能误判）", () => {
  const r = checkRedlines({ ...good(), permissions: rules(["Bash(git *)"], ["Bash(rm -rf *)"]) });
  expect(r.findings.some((f) => f.code === "allow-all-shell")).toBe(false);
});

test("缺验证命令 → warn（完成无法自证）", () => {
  const r = checkRedlines({ ...good(), config: { ...good().config, verify_command: "" } });
  expect(r.findings.some((f) => f.code === "verify-missing")).toBe(true);
});

test("钩子被关 → warn", () => {
  const r = checkRedlines({ ...good(), config: { ...good().config, hooks: { enabled: false } } });
  expect(r.findings.some((f) => f.code === "hooks-disabled")).toBe(true);
});

test("空配置：不抛，给出多条 warn 但无 fail（本地开发也能跑）", () => {
  const r = checkRedlines({ config: {}, sandbox: null, permissions: null, hasCostLimit: false });
  expect(r.ok).toBe(true);
  expect(r.findings.filter((f) => f.level === "warn").length).toBeGreaterThan(3);
  expect(typeof r.verdict).toBe("string");
});

test("多条 fail 时结论给出数量", () => {
  const r = checkRedlines({
    ...good(),
    config: { ...good().config, sandbox_mode: "danger-full-access" },
    permissions: rules(["Bash"], []),
  });
  expect(r.ok).toBe(false);
  expect(r.verdict).toMatch(/2 条红线/);
});

test("formatRedlines 带图标与修复建议", () => {
  const r = checkRedlines({ config: {}, sandbox: { level: "tool-level", backend: "local" }, permissions: null, hasCostLimit: false });
  const text = formatRedlines(r);
  expect(text).toContain("上线红线自检");
  expect(text).toContain("⚠️");
  expect(text).toContain("修复：");
});

test("工具集体积：重工具集 → warn（不阻塞），修法是裁工具而不是开开关", () => {
  const r = checkRedlines({
    ...good(),
    toolBudget: { totalTools: 30, tokensPerTurn: 3000, contextRatio: 0.06 },
  });
  const f = r.findings.find((x) => x.code === "tools-bloat");
  expect(f?.level).toBe("warn");
  expect(f?.fix).toContain("disable-tool");
  expect(f?.fix).not.toContain("tool_search");
  expect(r.ok).toBe(true); // 只是提醒
});

test("工具集体积：轻工具集不打扰", () => {
  const r = checkRedlines({
    ...good(),
    toolBudget: { totalTools: 8, tokensPerTurn: 700, contextRatio: 0.004 },
  });
  expect(r.findings.some((x) => x.code === "tools-lean")).toBe(true);
  expect(r.findings.some((x) => x.code === "tools-bloat")).toBe(false);
});

test("没传工具体积时不产生该检查（零影响）", () => {
  const r = checkRedlines(good());
  expect(r.findings.some((x) => x.code.startsWith("tools-"))).toBe(false);
});

test("跨会话回忆：关闭时告警（同类任务会从零重跑）", () => {
  const r = checkRedlines({ ...good(), recall: { enabled: false, total: 5, fresh: 5 } });
  expect(r.findings.some((x) => x.code === "recall-off" && x.level === "warn")).toBe(true);
});

test("跨会话回忆：没有历史不算问题（第一次跑自然不省）", () => {
  const r = checkRedlines({ ...good(), recall: { enabled: true, total: 0, fresh: 0 } });
  expect(r.findings.some((x) => x.code === "recall-empty" && x.level === "ok")).toBe(true);
});

test("跨会话回忆：历史全过期 → warn（开着等于没开）", () => {
  const r = checkRedlines({ ...good(), recall: { enabled: true, total: 5, fresh: 0 } });
  const f = r.findings.find((x) => x.code === "recall-stale");
  expect(f?.level).toBe("warn");
  expect(f?.detail).toContain("等价于关闭");
  expect(r.ok).toBe(true); // 只是提醒
});

test("跨会话回忆：有新鲜历史 → ok 并报出比例", () => {
  const r = checkRedlines({ ...good(), recall: { enabled: true, total: 5, fresh: 2 } });
  const f = r.findings.find((x) => x.code === "recall-ready");
  expect(f?.detail).toContain("2/5");
});

test("跨会话回忆：不传时零影响", () => {
  const r = checkRedlines(good());
  expect(r.findings.some((x) => x.code.startsWith("recall-"))).toBe(false);
});

test("阈值可调：放宽后重工具集不再报警", () => {
  const r = checkRedlines({
    ...good(),
    toolBudget: { totalTools: 30, tokensPerTurn: 3000, contextRatio: 0.06 },
    thresholds: { maxTools: 50, maxTokensPerTurn: 8000, maxContextRatio: 0.2 },
  });
  expect(r.findings.some((x) => x.code === "tools-bloat")).toBe(false);
});

test("阈值可调：收紧后小工具集也报警", () => {
  const r = checkRedlines({
    ...good(),
    toolBudget: { totalTools: 10, tokensPerTurn: 900, contextRatio: 0.01 },
    thresholds: { maxTools: 8 },
  });
  expect(r.findings.some((x) => x.code === "tools-bloat")).toBe(true);
});

test("忽略项生效：被忽略的检查不出现，也不阻塞", () => {
  const r = checkRedlines({
    ...good(),
    toolBudget: { totalTools: 30, tokensPerTurn: 3000, contextRatio: 0.06 },
    ignore: ["tools-bloat"],
  });
  expect(r.findings.some((x) => x.code === "tools-bloat")).toBe(false);
  expect(r.ok).toBe(true);
});

test("全部忽略时给一条说明，而不是空列表", () => {
  const r = checkRedlines({
    config: {},
    sandbox: { level: "tool-level", backend: "local" },
    permissions: null,
    hasCostLimit: false,
    ignore: ["cost-limit-missing", "pricing-missing", "sandbox-tool-level", "deny-rules-empty", "verify-missing", "hooks-disabled"],
  });
  expect(r.findings.length).toBe(1);
  expect(r.findings[0].code).toBe("consistent");
  expect(r.ok).toBe(true);
});

test("回忆过期阈值可配：默认 30 天", () => {
  const r = checkRedlines({ ...good(), recall: { enabled: true, total: 5, fresh: 0 } });
  const f = r.findings.find((x) => x.code === "recall-stale");
  expect(f?.detail).toContain("30 天");
});

test("回忆过期阈值可配：改成 7 天后文案与修复建议都跟着变", () => {
  const r = checkRedlines({
    ...good(),
    recall: { enabled: true, total: 5, fresh: 0 },
    thresholds: { recallMaxAgeDays: 7 },
  });
  const f = r.findings.find((x) => x.code === "recall-stale");
  expect(f?.detail).toContain("7 天");
  expect(f?.detail).not.toContain("30 天");
  expect(f?.fix).toContain("7 天");
});

test("回忆过期阈值可配：ready 状态文案同步", () => {
  const r = checkRedlines({
    ...good(),
    recall: { enabled: true, total: 5, fresh: 2 },
    thresholds: { recallMaxAgeDays: 7 },
  });
  expect(r.findings.find((x) => x.code === "recall-ready")?.detail).toContain("7 天内");
});