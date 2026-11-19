// tests/node/test-evidence-audit.test.ts — P1-2：证据链自洽审计。
// 原则：审计只读落盘证据、不重跑命令；核心是抓"自相矛盾"。
import { test, expect } from "bun:test";
import { auditRunState, formatAudit } from "../../src/evidenceAudit.ts";

function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "20260101-000000-aaaa",
    status: "verified",
    task: "做点事",
    workdir: "/w",
    mode: "auto",
    turn: 3,
    max_turns: 20,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:05:00Z",
    changed_files: ["src/a.ts"],
    verify_cmd: "npm test",
    verify_result: { exit_code: 0, passed: true, output_tail: "ok", attempt: 1 },
    ...over,
  };
}

test("verified 且证据齐全：通过，无 fail", () => {
  const r = auditRunState(state());
  expect(r.ok).toBe(true);
  expect(r.findings.some((f) => f.level === "fail")).toBe(false);
  expect(r.verdict).toContain("通过");
});

test("自称 verified 但没有验证命令 → fail", () => {
  const r = auditRunState(state({ verify_cmd: null }));
  expect(r.ok).toBe(false);
  expect(r.findings.some((f) => f.code === "verified_without_cmd")).toBe(true);
});

test("自称 verified 但退出码非 0 → fail（两份证据矛盾）", () => {
  const r = auditRunState(state({ verify_result: { exit_code: 1, passed: true } }));
  expect(r.ok).toBe(false);
  expect(r.findings.some((f) => f.code === "verified_without_pass")).toBe(true);
});

test("自称 verified 但 passed 不是 true → fail", () => {
  const r = auditRunState(state({ verify_result: { exit_code: 0, passed: false } }));
  expect(r.ok).toBe(false);
  expect(r.findings.some((f) => f.code === "verified_without_flag")).toBe(true);
});

test("verify_failed 但退出码是 0 → fail", () => {
  const r = auditRunState(state({ status: "verify_failed", verify_result: { exit_code: 0, passed: false } }));
  expect(r.ok).toBe(false);
  expect(r.findings.some((f) => f.code === "failed_but_pass")).toBe(true);
});

test("verify_failed 且退出码非 0：自洽", () => {
  const r = auditRunState(state({ status: "verify_failed", verify_result: { exit_code: 2, passed: false } }));
  expect(r.ok).toBe(true);
});

test("未知状态 → fail", () => {
  const r = auditRunState(state({ status: "probably-fine" }));
  expect(r.ok).toBe(false);
  expect(r.findings.some((f) => f.code === "status_unknown")).toBe(true);
});

test("缺 status → fail", () => {
  const r = auditRunState(state({ status: undefined }));
  expect(r.ok).toBe(false);
  expect(r.findings.some((f) => f.code === "status_missing")).toBe(true);
});

test("测试文件被改 + 验证通过 → warn（不阻塞，但要人看）", () => {
  const r = auditRunState(state({ changed_files: ["src/a.ts", "tests/node/test-a.test.ts"] }));
  expect(r.ok).toBe(true);
  expect(r.findings.some((f) => f.code === "tests_modified")).toBe(true);
  expect(r.verdict).toContain("提醒");
});

test("未验证状态却带通过记录 → warn", () => {
  const r = auditRunState(state({ status: "completed_unverified" }));
  expect(r.findings.some((f) => f.code === "unverified_but_pass")).toBe(true);
});

test("时间戳倒挂 → warn", () => {
  const r = auditRunState(state({ created_at: "2026-01-01T10:00:00Z", updated_at: "2026-01-01T09:00:00Z" }));
  expect(r.findings.some((f) => f.code === "time_inverted")).toBe(true);
});

test("输入不是对象也不抛（记录损坏时要能给出结论）", () => {
  for (const bad of [null, undefined, "字符串", 42, []]) {
    const r = auditRunState(bad);
    expect(typeof r.verdict).toBe("string");
    expect(r.ok).toBe(false);
  }
});

test("formatAudit 带图标与结论", () => {
  const text = formatAudit(auditRunState(state()), "run-1");
  expect(text).toContain("run-1");
  expect(text).toContain("证据审计");
  expect(text).toContain("✅");
});
