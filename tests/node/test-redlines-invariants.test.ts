// tests/node/test-redlines-invariants.test.ts — 红线自检的一致性不变式（防同类错误复发）。
//
// 来由：改可配置阈值那一轮，`kept` 过滤后统计仍基于未过滤的 `findings`，导致
// 「全忽略」时 verdict 还写着「4 条红线未设」。这类 bug 的共同特征是
// **同名概念的多个副本**（findings / kept / verdict 里的数字）。
//
// 这里用表驱动的输入组合，对返回结果做 5 条不变式检查：
//   I1. ok === 返回项里没有 fail
//   I2. verdict 里的 fail 数字 === 实际 fail 项数
//   I3. verdict 里的 warn 数字 === 实际 warn 项数
//   I4. 返回列表非空（永远给一句话，不给空列表）
//   I5. 每个 finding 都有 code/title/detail，且 code 唯一
import { test, expect } from "bun:test";
import { checkRedlines, type RedlineInput } from "../../src/redlines.ts";

const GOOD: RedlineInput = {
  config: { max_cost_usd: 5, pricing: { m: {} }, verify_command: "npm test" },
  sandbox: { level: "bwrap", backend: "bwrap" },
  permissions: {
    allow: [{ raw: "Bash(git *)", tool: "Bash", specifier: "git *" }],
    ask: [],
    deny: [{ raw: "Bash(rm *)", tool: "Bash", specifier: "rm *" }],
  },
  hasCostLimit: true,
};

/** 组合出一批差异很大的输入，覆盖 ok / warn / fail 各种组合。 */
const CASES: { name: string; input: RedlineInput }[] = [
  { name: "全绿", input: GOOD },
  { name: "空配置", input: { config: {} } },
  { name: "工具级沙箱", input: { ...GOOD, sandbox: { level: "tool-level", backend: "local" } } },
  { name: "沙箱未探测", input: { ...GOOD, sandbox: null } },
  { name: "danger 模式", input: { ...GOOD, config: { ...GOOD.config, sandbox_mode: "danger-full-access" } } },
  { name: "裸 Bash 放行", input: { ...GOOD, permissions: { allow: [{ raw: "Bash", tool: "Bash", specifier: null }], ask: [], deny: [] } } },
  { name: "无 deny 规则", input: { ...GOOD, permissions: { allow: [], ask: [], deny: [] } } },
  { name: "重工具集", input: { ...GOOD, toolBudget: { totalTools: 30, tokensPerTurn: 3000, contextRatio: 0.06 } } },
  { name: "重工具集+开延迟加载", input: { ...GOOD, toolBudget: { totalTools: 30, tokensPerTurn: 3000, contextRatio: 0.06 }, toolSearchEnabled: true } },
  { name: "回忆关闭", input: { ...GOOD, recall: { enabled: false, total: 3, fresh: 3 } } },
  { name: "回忆全过期", input: { ...GOOD, recall: { enabled: true, total: 5, fresh: 0 } } },
  { name: "回忆有新鲜", input: { ...GOOD, recall: { enabled: true, total: 5, fresh: 2 } } },
  { name: "钩子关闭", input: { ...GOOD, config: { ...GOOD.config, hooks: { enabled: false } } } },
  { name: "全忽略", input: { config: {}, permissions: null, ignore: [
    "cost-limit-missing", "pricing-missing", "sandbox-none", "sandbox-tool-level",
    "deny-rules-empty", "verify-missing", "hooks-disabled",
  ] } },
  { name: "部分忽略", input: { config: {}, permissions: null, ignore: ["cost-limit-missing", "pricing-missing"] } },
];

/** 从 verdict 里抠出 "N 条红线被踩" / "N 条红线未设" 的数字。 */
function numbersInVerdict(verdict: string): { fails: number | null; warns: number | null } {
  const failMatch = /(\d+)\s*条红线被踩/.exec(verdict);
  const warnMatch = /(\d+)\s*条红线未设/.exec(verdict);
  return {
    fails: failMatch ? Number(failMatch[1]) : null,
    warns: warnMatch ? Number(warnMatch[1]) : null,
  };
}

for (const { name, input } of CASES) {
  test(`不变式（${name}）：ok/verdict/列表三者一致`, () => {
    const r = checkRedlines(input);
    const fails = r.findings.filter((f) => f.level === "fail").length;
    const warns = r.findings.filter((f) => f.level === "warn").length;
    const parsed = numbersInVerdict(r.verdict);

    // I1：ok 只由「有没有 fail」决定
    expect(r.ok).toBe(fails === 0);

    // I2/I3：verdict 里的数字必须等于实际项数（没写数字时可以缺省）
    if (parsed.fails !== null) expect(parsed.fails).toBe(fails);
    if (parsed.warns !== null) expect(parsed.warns).toBe(warns);

    // I4：永远给一句话，不给空列表
    expect(r.findings.length).toBeGreaterThan(0);

    // I5：每项字段齐全，code 唯一
    for (const f of r.findings) {
      expect(typeof f.code).toBe("string");
      expect(f.code.length).toBeGreaterThan(0);
      expect(typeof f.title).toBe("string");
      expect(typeof f.detail).toBe("string");
    }
    const codes = r.findings.map((f) => f.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
}

test("不变式：fail 存在时 ok 必为 false，且 verdict 一定提到被踩", () => {
  const r = checkRedlines({ config: { sandbox_mode: "danger-full-access" }, permissions: null });
  expect(r.findings.some((f) => f.level === "fail")).toBe(true);
  expect(r.ok).toBe(false);
  expect(r.verdict).toContain("不宜上生产");
});

test("不变式：没有 fail 时 verdict 不说「不宜上生产」", () => {
  const r = checkRedlines(GOOD);
  expect(r.findings.some((f) => f.level === "fail")).toBe(false);
  expect(r.verdict).not.toContain("不宜上生产");
});
