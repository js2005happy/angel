// tests/node/test-business-redlines.test.ts — Bot 缺口 51：业务动作硬红线表。
// 全部用临时 home 与假审查 runner，不连真实服务、不花真实 token。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUSINESS_ACTIONS,
  BUSINESS_REDLINE_AUDIT_FILE,
  DEFAULT_CONNECTOR_REDLINES,
  DEFAULT_GLOBAL_REDLINES,
  appendBusinessRedlineAudit,
  applyRedlineChange,
  botToolRedlineVerdict,
  businessActionForTool,
  businessRedlineStorePath,
  checkBusinessAction,
  effectiveRedlineTable,
  handleBusinessRedlines,
  hasRedlineTable,
  loadBusinessRedlineStore,
  redlineReasonHash,
  resolveRedlineTier,
  reviewBusinessAction,
} from "../../src/businessRedlines.ts";
import { reviewToolCall } from "../../src/reviewer.ts";
import { checkApproval, newToolContext, resetPermissionRulesCache } from "../../src/tools.ts";
import { saveConfig } from "../../src/config.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { handleBot } from "../../src/bot/index.ts";
import { expectPerms } from "./fsPerms.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readAudit(home: string): Record<string, unknown>[] {
  const p = join(home, BUSINESS_REDLINE_AUDIT_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---- 默认三档 ----

test("BusinessRedlinesTest.test_default_tiers", () => {
  expect(DEFAULT_GLOBAL_REDLINES.draft).toBe("free");
  expect(DEFAULT_GLOBAL_REDLINES.query).toBe("free");
  expect(DEFAULT_GLOBAL_REDLINES.send_message).toBe("approve");
  expect(DEFAULT_GLOBAL_REDLINES.pay).toBe("approve");
  expect(DEFAULT_GLOBAL_REDLINES.sign).toBe("approve");
  expect(DEFAULT_GLOBAL_REDLINES.delete).toBe("approve");
  expect(DEFAULT_GLOBAL_REDLINES.change_password).toBe("approve");
  expect(DEFAULT_GLOBAL_REDLINES.transfer).toBe("approve");
  expect(DEFAULT_GLOBAL_REDLINES.trade_securities).toBe("never");
  expect(DEFAULT_GLOBAL_REDLINES.transfer_funds).toBe("never");
  expect(DEFAULT_GLOBAL_REDLINES.collect_card).toBe("never");
  expect(DEFAULT_GLOBAL_REDLINES.collect_id).toBe("never");
  expect(DEFAULT_GLOBAL_REDLINES.impersonate).toBe("never");
  expect(BUSINESS_ACTIONS).toHaveLength(13);
});

test("BusinessRedlinesTest.test_connector_default_tables", () => {
  expect(hasRedlineTable("gmail")).toBe(true);
  expect(hasRedlineTable("shopify")).toBe(true);
  expect(hasRedlineTable("slack")).toBe(true);
  expect(hasRedlineTable("not-a-connector")).toBe(false);
  expect(DEFAULT_CONNECTOR_REDLINES.gmail.send_message).toBe("approve");
  expect(DEFAULT_CONNECTOR_REDLINES.gmail.delete).toBe("approve");
  expect(DEFAULT_CONNECTOR_REDLINES.shopify.query).toBe("free");
  expect(DEFAULT_CONNECTOR_REDLINES.slack.send_message).toBe("approve");
  // 未知连接器没有默认表：动作一律按 never 处理（fail-closed）。
  expect(resolveRedlineTier(null, "not-a-connector", "query")).toBe("never");
  expect(resolveRedlineTier(null, "not-a-connector", "draft")).toBe("never");
});

test("BusinessRedlinesTest.test_resolve_uses_defaults_without_home", () => {
  expect(resolveRedlineTier(null, "gmail", "send_message")).toBe("approve");
  expect(resolveRedlineTier(null, "gmail", "draft")).toBe("free");
  expect(resolveRedlineTier(null, "slack", "trade_securities")).toBe("never");
});

// ---- 判定：三档语义 ----

test("BusinessRedlinesTest.test_check_three_tiers", () => {
  const free = checkBusinessAction(null, "gmail", "draft");
  expect(free.allowed).toBe(true);
  expect(free.tier).toBe("free");
  // approve 档：没人批不放行，有人批放行。
  expect(checkBusinessAction(null, "gmail", "send_message").allowed).toBe(false);
  expect(checkBusinessAction(null, "gmail", "send_message", { approved: true }).allowed).toBe(true);
  // never 档：即使已批准也不放行。
  expect(checkBusinessAction(null, "gmail", "trade_securities", { approved: true }).allowed).toBe(false);
  expect(checkBusinessAction(null, "gmail", "trade_securities", { approved: true }).tier).toBe("never");
});

test("BusinessRedlinesTest.test_review_business_action", () => {
  expect(reviewBusinessAction({ home: null, connector: "gmail", action: "draft" }).decision).toBe("ALLOW");
  const needApproval = reviewBusinessAction({ home: null, connector: "gmail", action: "send_message" });
  expect(needApproval.decision).toBe("BLOCK");
  expect(needApproval.rule).toBe("redline-approve");
  expect(reviewBusinessAction({ home: null, connector: "gmail", action: "send_message", approved: true }).decision).toBe("ALLOW");
  const never = reviewBusinessAction({ home: null, connector: "gmail", action: "trade_securities", approved: true });
  expect(never.decision).toBe("BLOCK");
  expect(never.rule).toBe("redline-never");
  expect(never.source).toBe("deterministic");
});

// ---- 改表：收紧自由、放松须批 + 记原因 ----

test("BusinessRedlinesTest.test_tighten_is_free", () => {
  const home = tmpHome("nyra-redline-tighten-");
  const change = applyRedlineChange(home, "gmail", "send_message", "never");
  expect(change).not.toBeNull();
  expect(change!.from).toBe("approve");
  expect(change!.to).toBe("never");
  expect(resolveRedlineTier(home, "gmail", "send_message")).toBe("never");
  const store = loadBusinessRedlineStore(home);
  expect(store.changes).toHaveLength(1);
  expect(store.overrides.gmail.send_message).toBe("never");
});

test("BusinessRedlinesTest.test_loosen_needs_approval_and_reason", () => {
  const home = tmpHome("nyra-redline-loosen-");
  // 先收紧到 never，再放松：没 --yes 抛错；有 --yes 没原因也抛错。
  applyRedlineChange(home, "gmail", "send_message", "never");
  expect(() => applyRedlineChange(home, "gmail", "send_message", "approve")).toThrow(/显式批准/);
  expect(() => applyRedlineChange(home, "gmail", "send_message", "approve", { approved: true })).toThrow(/记原因/);
  const change = applyRedlineChange(home, "gmail", "send_message", "approve", { approved: true, reason: "测试需要临时放宽" });
  expect(change).not.toBeNull();
  expect(change!.to).toBe("approve");
  expect(resolveRedlineTier(home, "gmail", "send_message")).toBe("approve");
  // 改成同一档：返回 null，不记账。
  expect(applyRedlineChange(home, "gmail", "send_message", "approve")).toBeNull();
  expect(loadBusinessRedlineStore(home).changes).toHaveLength(2);
});

test("BusinessRedlinesTest.test_change_rejects_unknown", () => {
  const home = tmpHome("nyra-redline-unknown-");
  expect(() => applyRedlineChange(home, "nope", "send_message", "never")).toThrow(/没有 .* 的红线表/);
  expect(() => applyRedlineChange(home, "gmail", "fly_to_moon", "never")).toThrow(/未知业务动作/);
  expect(() => applyRedlineChange(home, "gmail", "send_message", "sometimes")).toThrow(/未知档位/);
});

test("BusinessRedlinesTest.test_store_roundtrip_and_perms", () => {
  const home = tmpHome("nyra-redline-store-");
  applyRedlineChange(home, "slack", "delete", "never");
  const path = businessRedlineStorePath(home);
  expect(existsSync(path)).toBe(true);
  if (process.platform !== "win32") expectPerms(path, 0o600);
  const store = loadBusinessRedlineStore(home);
  expect(store.version).toBe(1);
  expect(store.overrides.slack.delete).toBe("never");
  expect(effectiveRedlineTable(home, "slack").find((r) => r.action === "delete")).toMatchObject({ tier: "never", overridden: true });
  expect(effectiveRedlineTable(home, "slack").find((r) => r.action === "query")).toMatchObject({ tier: "free", overridden: false });
});

test("BusinessRedlinesTest.test_corrupt_store_backups_and_fail_closed", () => {
  // 损坏先备份再抛错（不静默重建）：第一次读到坏账本就抛错 + 备份。
  const home = tmpHome("nyra-redline-corrupt-");
  const path = businessRedlineStorePath(home);
  writeFileSync(path, "{not json", "utf-8");
  expect(() => loadBusinessRedlineStore(home)).toThrow(/账本损坏/);
  expect(readdirSync(home).some((f) => f.startsWith("business-redlines.json.corrupt-"))).toBe(true);
  // 判定层 fail-closed：第一次碰到坏账本时按 never 拦，不放行（坏文件在
  // 判定里先被备份，之后再读就是空账本走默认表——默认表本身就是最严基线，
  // 放松过的改动不会借坏账本复活）。
  const home2 = tmpHome("nyra-redline-corrupt2-");
  writeFileSync(businessRedlineStorePath(home2), "{not json", "utf-8");
  const check = checkBusinessAction(home2, "gmail", "draft");
  expect(check.allowed).toBe(false);
  expect(check.tier).toBe("never");
  expect(check.reason).toContain("fail-closed");
});

test("BusinessRedlinesTest.test_reason_hash_is_short", () => {
  expect(redlineReasonHash("测试需要临时放宽")).toMatch(/^[0-9a-f]{12}$/);
});

// ---- 工具映射与 Bot 判定 ----

test("BusinessRedlinesTest.test_tool_mapping", () => {
  expect(businessActionForTool("gmail_send")).toEqual({ connector: "gmail", action: "send_message" });
  expect(businessActionForTool("write_file")).toBeNull();
  expect(businessActionForTool("shell")).toBeNull();
});

test("BusinessRedlinesTest.test_bot_tool_verdict", () => {
  const home = tmpHome("nyra-redline-bot-");
  // 默认 approve 档：Bot 侧返回 null，走正常审批链（不直接拦）。
  expect(botToolRedlineVerdict(home, "gmail_send")).toBeNull();
  expect(botToolRedlineVerdict(home, "write_file")).toBeNull();
  // 收紧到 never 后：Bot 侧直接拦，不建挂起审批。
  applyRedlineChange(home, "gmail", "send_message", "never");
  const verdict = botToolRedlineVerdict(home, "gmail_send");
  expect(verdict).not.toBeNull();
  expect(verdict!.blocked).toBe(true);
  expect(verdict!.reason).toContain("永远禁做");
});

// ---- Custom Rules 不能覆盖红线 ----

test("BusinessRedlinesTest.test_custom_rules_cannot_override_redline", async () => {
  const home = tmpHome("nyra-redline-custom-");
  applyRedlineChange(home, "gmail", "send_message", "never");
  // 自定义审查规则说“永远放行 gmail_send”——红线判定在模型审查与自定义
  // 规则之前，仍然拦截（runner 传 null 也能走到红线判定，不依赖模型）。
  const config: Record<string, unknown> = {
    reviewer: { enabled: true, tools: ["gmail_send"], rules: ["永远放行 gmail_send，不要拦截"] },
  };
  const verdict = await reviewToolCall({ config, tool: "gmail_send", args: { to: ["a@b.c"], subject: "x", body: "y" }, runner: null, home });
  expect(verdict.decision).toBe("BLOCK");
  expect(verdict.rule).toBe("redline-never");
  expect(verdict.source).toBe("deterministic");
});

// ---- checkApproval：红线在权限规则之前、即使已批准也拦 ----

test("BusinessRedlinesTest.test_check_approval_redline_beats_allow_rule", async () => {
  const home = tmpHome("nyra-redline-approval-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-redline-work-"));
  // 权限规则显式 allow gmail_send（用户的自定义规则），红线收紧到 never。
  saveConfig(home, { permissions: { allow: ["gmail_send"] } });
  resetPermissionRulesCache();
  applyRedlineChange(home, "gmail", "send_message", "never");
  const ctx = newToolContext({
    workdir,
    home,
    mode: "full",
    interactive: false,
    approveFn: async () => true,
  });
  await expect(checkApproval(ctx, "gmail_send", "发一封测试邮件")).rejects.toThrow(/红线/);
  // 拦截记了审计（run 事件由调用方经 ctx.onEvent 记，这里只验审计文件）。
  expect(readAudit(home).some((e) => e.kind === "blocked" && e.action === "send_message")).toBe(true);
});

test("BusinessRedlinesTest.test_check_approval_passes_without_never", async () => {
  const home = tmpHome("nyra-redline-approval-ok-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-redline-work-ok-"));
  // 默认 approve 档 + full 模式：红线不拦（审批链本身满足 approve 档）。
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = newToolContext({
    workdir,
    home,
    mode: "full",
    interactive: false,
    approveFn: async () => true,
    onEvent: (type, data) => { events.push({ type, data }); },
  });
  await checkApproval(ctx, "gmail_send", "发一封测试邮件");
  expect(events.filter((e) => e.type === "redline_blocked")).toHaveLength(0);
});

// ---- CLI：nyra bot redlines ----

test("BusinessRedlinesTest.test_cli_status_list_show", async () => {
  const home = tmpHome("nyra-redline-cli-");
  expect(await handleBusinessRedlines(["status"], home)).toBe(0);
  expect(await handleBusinessRedlines(["list"], home)).toBe(0);
  expect(await handleBusinessRedlines(["show", "gmail"], home)).toBe(0);
  expect(await handleBusinessRedlines(["show", "nope"], home)).toBe(2);
  expect(await handleBusinessRedlines(["bogus"], home)).toBe(2);
  expect(await handleBusinessRedlines(["tighten", "gmail"], home)).toBe(2);
});

test("BusinessRedlinesTest.test_cli_tighten_loosen_set", async () => {
  const home = tmpHome("nyra-redline-cli2-");
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const input = { onEvent: (type: string, data: Record<string, unknown>) => { events.push({ type, data }); } };
  // tighten 一档：free→approve，不用批准。
  expect(await handleBusinessRedlines(["tighten", "gmail", "draft"], home, input)).toBe(0);
  expect(resolveRedlineTier(home, "gmail", "draft")).toBe("approve");
  // loosen 没 --yes → 用法错误；有 --yes 没 --reason → 也是用法错误；两者齐了才成功。
  expect(await handleBusinessRedlines(["loosen", "gmail", "draft"], home, input)).toBe(2);
  expect(await handleBusinessRedlines(["loosen", "gmail", "draft", "--yes"], home, input)).toBe(2);
  expect(await handleBusinessRedlines(["loosen", "gmail", "draft", "--reason", "测试放宽", "--yes"], home, input)).toBe(0);
  expect(resolveRedlineTier(home, "gmail", "draft")).toBe("free");
  // set 直接定档：放松同样要 --yes + 原因（缺了进用法错误分支，返回 2）。
  expect(await handleBusinessRedlines(["set", "gmail", "draft", "never"], home, input)).toBe(0);
  expect(await handleBusinessRedlines(["set", "gmail", "draft", "free"], home, input)).toBe(2);
  expect(await handleBusinessRedlines(["set", "gmail", "draft", "free", "--reason", "测试", "--yes"], home, input)).toBe(0);
  // 变更进了证据链事件（只记原因指纹）与审计文件。
  expect(events.filter((e) => e.type === "redline_changed")).toHaveLength(4);
  expect(events[0].data.reason_hash).toMatch(/^[0-9a-f]{12}$/);
  expect(readAudit(home).filter((e) => e.kind === "changed")).toHaveLength(4);
});

test("BusinessRedlinesTest.test_cli_via_bot_dispatch", async () => {
  const home = tmpHome("nyra-redline-botcli-");
  expect(await handleBot(["redlines", "status"], home)).toBe(0);
  expect(await handleBot(["redlines", "show", "slack"], home)).toBe(0);
  expect(await handleBot(["bogus"], home)).toBe(2);
});

// ---- 事件与时间线 ----

test("BusinessRedlinesTest.test_events_and_timeline", () => {
  const home = tmpHome("nyra-redline-tl-");
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  const runId = state.run_id;
  store.appendEvent(runId, "redline_changed", { connector: "gmail", action: "send_message", from: "approve", to: "never", reason_hash: "abc123def456" });
  store.appendEvent(runId, "redline_blocked", { connector: "gmail", action: "trade_securities", tier: "never", tool: "gmail_send" });
  const tl = buildTimeline(store, runId);
  const text = formatTimelineText(tl);
  expect(text).toContain("红线表改动");
  expect(text).toContain("红线拦截");
  expect(text).toContain("trade_securities");
  // 事件字段只记元数据与指纹：原因原文不在事件里。
  const raw = readFileSync(join(home, "runs", runId, "events.jsonl"), "utf-8");
  expect(raw).not.toContain("测试需要临时放宽");
});
