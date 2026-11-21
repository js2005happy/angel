// tests/node/test-trust-ladder.test.ts — GROK-6：信任阶梯（缺口 43 治理深化）。
// 钉住的事：
//   - 信任账本往返（原子写 0600、损坏先备份再抛错、不静默重建）、登记校验
//     （默认只读起步、重复登记拒绝、id 非法拒绝）；
//   - 证据与升级：连续成功计数、一次违规清零、攒够 N 次才升一级、一次只升一级、
//     最高级升不上去；降级随时可做、只能往低降；
//   - 随机抽查：被抽中的成功先挂起不计数，复核通过才计入、驳回按违规算，
//     有待复核的抽查时不许升级；
//   - 门：只对已登记主体生效（未登记行为不变）、级别不够拦截、级别够放行；
//     checkApproval 接线（Soul invariant 之后、团队门之前），被拦记事件与审计，
//     拦截文案进幂等重试的“绝不重试”标记；
//   - 7 个新事件已注册进 EVENT_FIELDS（appendEvent 不抛错），时间线能渲染；
//   - 配置解析：默认值 5 次/10%，非法值回默认；config explain 有 trust_ladder 一项；
//   - CLI 端到端：register/list/show/evidence/promote/demote/review/check，
//     变异操作须 --yes；审计导出含 trust 来源。
// 全部用临时 home，不连真实服务、不花真实 token。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { saveConfig, loadConfig } from "../../src/config.ts";
import { explainOne } from "../../src/configExplain.ts";
import { checkApproval, newToolContext, resetPermissionRulesCache, isApprovalRefusalResult } from "../../src/tools.ts";
import { exportAudit, AUDIT_SOURCES } from "../../src/costCaps.ts";
import {
  registerSubject, getSubject, listSubjects, recordEvidence, reviewSpotCheck,
  checkPromotion, promoteSubject, demoteSubject, requiredLevelForTool,
  checkTrustGate, resolveTrustLadderSettings, trustLadderPath,
  TRUST_LADDER_AUDIT_FILE, TrustLadderError,
} from "../../src/trustLadder.ts";

function tmpHome(prefix = "nyra-trust-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

/** 5 次成功（确定性不抽查）+ 升级，返回升到 send 级的主体。 */
function earnSendLevel(home: string, agent: string): void {
  for (let i = 0; i < 5; i++) {
    recordEvidence(home, "agent", agent, "success", { action: `draft-${i}`, random: () => 0.99 });
  }
  promoteSubject(home, "agent", agent, "test");
  for (let i = 0; i < 5; i++) {
    recordEvidence(home, "agent", agent, "success", { action: `send-${i}`, random: () => 0.99 });
  }
  promoteSubject(home, "agent", agent, "test");
}

test("TrustLadderTest.test_register_defaults_and_validation", () => {
  const home = tmpHome();
  const s = registerSubject(home, "agent", "bot-a");
  expect(s.level).toBe("readonly");
  expect(s.successes_at_level).toBe(0);
  expect(s.violations_total).toBe(0);
  expect(s.evidence).toHaveLength(0);
  expect(existsSync(trustLadderPath(home))).toBe(true);
  expectPerms(trustLadderPath(home), 0o600);
  expect(() => registerSubject(home, "agent", "bot-a")).toThrow(TrustLadderError);
  expect(() => registerSubject(home, "agent", "Bad Name!")).toThrow(TrustLadderError);
  expect(() => registerSubject(home, "agent", "1abc")).toThrow(TrustLadderError);
  expect(() => registerSubject(home, "skill", "My Skill")).toThrow(TrustLadderError);
  const skill = registerSubject(home, "skill", "duoasa-skill");
  expect(skill.kind).toBe("skill");
  expect(skill.level).toBe("readonly");
  expect(listSubjects(home)).toHaveLength(2);
  expect(listSubjects(home, { kind: "skill" })).toHaveLength(1);
  expect(getSubject(home, "agent", "nobody")).toBeNull();
});

test("TrustLadderTest.test_ledger_corrupt_backup_then_throw", () => {
  const home = tmpHome();
  registerSubject(home, "agent", "bot-a");
  writeFileSync(trustLadderPath(home), "{ not json");
  expect(() => getSubject(home, "agent", "bot-a")).toThrow(/损坏，已备份/);
});

test("TrustLadderTest.test_evidence_streak_and_violation_reset", () => {
  const home = tmpHome();
  registerSubject(home, "agent", "bot-a");
  const noSpot = () => 0.99;
  recordEvidence(home, "agent", "bot-a", "success", { action: "a", random: noSpot });
  recordEvidence(home, "agent", "bot-a", "success", { action: "b", random: noSpot });
  expect(getSubject(home, "agent", "bot-a")!.successes_at_level).toBe(2);
  recordEvidence(home, "agent", "bot-a", "violation", { action: "c" });
  const s = getSubject(home, "agent", "bot-a")!;
  expect(s.successes_at_level).toBe(0);
  expect(s.violations_total).toBe(1);
  expect(() => recordEvidence(home, "agent", "ghost", "success")).toThrow(TrustLadderError);
});

test("TrustLadderTest.test_promotion_needs_five_then_one_level", () => {
  const home = tmpHome();
  registerSubject(home, "agent", "bot-a");
  const noSpot = () => 0.99;
  for (let i = 0; i < 4; i++) recordEvidence(home, "agent", "bot-a", "success", { random: noSpot });
  const check = checkPromotion(home, "agent", "bot-a");
  expect(check.eligible).toBe(false);
  expect(check.needed).toBe(1);
  expect(check.reason).toContain("还差 1 次");
  expect(() => promoteSubject(home, "agent", "bot-a", "test")).toThrow(/不能升级/);
  recordEvidence(home, "agent", "bot-a", "success", { random: noSpot });
  expect(checkPromotion(home, "agent", "bot-a").eligible).toBe(true);
  const s = promoteSubject(home, "agent", "bot-a", "test");
  expect(s.level).toBe("draft");
  expect(s.successes_at_level).toBe(0);
  // 升到 draft 后本级计数清零，马上再升会被拒。
  expect(checkPromotion(home, "agent", "bot-a").eligible).toBe(false);
});

test("TrustLadderTest.test_promotion_at_top_refused", () => {
  const home = tmpHome();
  registerSubject(home, "agent", "bot-a");
  earnSendLevel(home, "bot-a");
  for (let i = 0; i < 5; i++) {
    recordEvidence(home, "agent", "bot-a", "success", { random: () => 0.99 });
  }
  promoteSubject(home, "agent", "bot-a", "test");
  expect(getSubject(home, "agent", "bot-a")!.level).toBe("purchase");
  expect(checkPromotion(home, "agent", "bot-a").eligible).toBe(false);
  expect(checkPromotion(home, "agent", "bot-a").reason).toContain("最高级");
});

test("TrustLadderTest.test_spot_check_hold_and_review", () => {
  const home = tmpHome();
  registerSubject(home, "agent", "bot-a");
  const alwaysSpot = () => 0.0;
  const r = recordEvidence(home, "agent", "bot-a", "success", { action: "x", random: alwaysSpot });
  expect(r.spotChecked).toBe(true);
  expect(r.evidence.spot_check).toBe(true);
  expect(r.evidence.spot_status).toBe("pending");
  expect(getSubject(home, "agent", "bot-a")!.successes_at_level).toBe(0);
  // 有待复核的抽查时不许升级（即使后面又攒了 5 次不抽查的成功）。
  const noSpot = () => 0.99;
  for (let i = 0; i < 5; i++) recordEvidence(home, "agent", "bot-a", "success", { random: noSpot });
  const check = checkPromotion(home, "agent", "bot-a");
  expect(check.eligible).toBe(false);
  expect(check.reason).toContain("待复核");
  expect(check.pendingSpotChecks).toBe(1);
  // 复核通过：计入升级。
  const reviewed = reviewSpotCheck(home, r.evidence.id, "approve", "human");
  expect(reviewed.evidence.spot_status).toBe("approved");
  expect(getSubject(home, "agent", "bot-a")!.successes_at_level).toBe(6);
  expect(checkPromotion(home, "agent", "bot-a").eligible).toBe(true);
  // 复核过的证据不能再复核；不存在的证据 id 报错。
  expect(() => reviewSpotCheck(home, r.evidence.id, "approve", "human")).toThrow(/不是待复核/);
  expect(() => reviewSpotCheck(home, "ev_000000000000", "approve", "human")).toThrow(/不存在/);
});

test("TrustLadderTest.test_spot_check_reject_counts_as_violation", () => {
  const home = tmpHome();
  registerSubject(home, "agent", "bot-a");
  const noSpot = () => 0.99;
  for (let i = 0; i < 3; i++) recordEvidence(home, "agent", "bot-a", "success", { random: noSpot });
  const r = recordEvidence(home, "agent", "bot-a", "success", { random: () => 0.0 });
  expect(r.spotChecked).toBe(true);
  reviewSpotCheck(home, r.evidence.id, "reject", "human");
  const s = getSubject(home, "agent", "bot-a")!;
  expect(s.successes_at_level).toBe(0);
  expect(s.violations_total).toBe(1);
});

test("TrustLadderTest.test_demote_anytime_only_down", () => {
  const home = tmpHome();
  registerSubject(home, "agent", "bot-a");
  earnSendLevel(home, "bot-a");
  expect(getSubject(home, "agent", "bot-a")!.level).toBe("send");
  const s = demoteSubject(home, "agent", "bot-a", "readonly", "human");
  expect(s.level).toBe("readonly");
  expect(s.successes_at_level).toBe(0);
  expect(() => demoteSubject(home, "agent", "bot-a", "readonly", "human")).toThrow(/只能降到比当前更低/);
  expect(() => demoteSubject(home, "agent", "bot-a", "draft", "human")).toThrow(/只能降到比当前更低/);
  expect(() => demoteSubject(home, "agent", "ghost", "readonly", "human")).toThrow(TrustLadderError);
});

test("TrustLadderTest.test_required_level_for_tool", () => {
  // 目前业务动作映射里只有 gmail_send 一只工具（缺口 51 的桥）；draft/purchase
  // 的分支是给以后映射到的工具预留的，门按同一张表走。
  expect(requiredLevelForTool("gmail_send")).toBe("send");
  expect(requiredLevelForTool("read_file")).toBeNull();
  expect(requiredLevelForTool("write_file")).toBeNull();
  expect(requiredLevelForTool("run_shell")).toBeNull();
  expect(requiredLevelForTool("no_such_tool")).toBeNull();
});

test("TrustLadderTest.test_gate_only_registered_subjects", () => {
  const home = tmpHome();
  // 未登记：不在阶梯里，门不拦（行为与以前一致）。
  expect(checkTrustGate(home, "ghost", "gmail_send")).toBeNull();
  registerSubject(home, "agent", "bot-a");
  const blocked = checkTrustGate(home, "bot-a", "gmail_send");
  expect(blocked).not.toBeNull();
  expect(blocked!.level).toBe("readonly");
  expect(blocked!.required).toBe("send");
  expect(blocked!.reason).toContain("只读");
  // 升到 send 级就放行；只读工具本来就不在门内。
  earnSendLevel(home, "bot-a");
  expect(checkTrustGate(home, "bot-a", "gmail_send")).toBeNull();
  expect(checkTrustGate(home, "bot-a", "read_file")).toBeNull();
});

test("TrustLadderTest.test_gate_reason_counts_pending_spot_checks", () => {
  const home = tmpHome();
  registerSubject(home, "agent", "bot-a");
  recordEvidence(home, "agent", "bot-a", "success", { random: () => 0.0 });
  const blocked = checkTrustGate(home, "bot-a", "gmail_send");
  expect(blocked!.reason).toContain("待复核");
});

test("TrustLadderTest.test_check_approval_trust_gate", async () => {
  const home = tmpHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-trust-wd-"));
  resetPermissionRulesCache();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = newToolContext({
    workdir, home, mode: "full", interactive: false,
    soulAgent: "bot-a", approveFn: async () => true,
    onEvent: (type, data) => { events.push({ type, data }); },
  });
  // 未登记：门不拦，审批链正常放行。
  await checkApproval(ctx, "gmail_send", "发一封测试邮件");
  expect(events.filter((e) => e.type === "trust_blocked")).toHaveLength(0);
  // 登记后只读：门拦住，记事件与审计；文案进“绝不重试”标记。
  registerSubject(home, "agent", "bot-a");
  await expect(checkApproval(ctx, "gmail_send", "发一封测试邮件")).rejects.toThrow(/信任阶梯拦截/);
  expect(events.filter((e) => e.type === "trust_blocked")).toHaveLength(1);
  const audit = readFileSync(join(home, TRUST_LADDER_AUDIT_FILE), "utf-8");
  expect(audit).toContain("trust_blocked");
  expect(isApprovalRefusalResult("信任阶梯拦截了 gmail_send：agent bot-a 当前为「只读」级")).toBe(true);
  // 升到 send 级：放行。
  earnSendLevel(home, "bot-a");
  await checkApproval(ctx, "gmail_send", "发一封测试邮件");
});

test("TrustLadderTest.test_events_registered_and_timeline_renders", () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  const types: [string, Record<string, unknown>][] = [
    ["trust_registered", { kind: "agent", subject_id: "bot-a", level: "readonly" }],
    ["trust_evidence_recorded", { kind: "agent", subject_id: "bot-a", evidence_id: "ev_0123456789ab", outcome: "success" }],
    ["trust_spot_check_flagged", { kind: "agent", subject_id: "bot-a", evidence_id: "ev_0123456789ab" }],
    ["trust_spot_check_reviewed", { evidence_id: "ev_0123456789ab", decision: "approve" }],
    ["trust_promoted", { kind: "agent", subject_id: "bot-a", level: "draft" }],
    ["trust_demoted", { kind: "agent", subject_id: "bot-a", level: "readonly" }],
    ["trust_blocked", { agent: "bot-a", tool: "gmail_send", level: "readonly", required_level: "send" }],
  ];
  for (const [type, fields] of types) {
    expect(() => store.appendEvent(state.run_id, type, fields)).not.toThrow();
  }
  const text = formatTimelineText(buildTimeline(store, state.run_id), { verbose: true });
  expect(text).toContain("信任阶梯");
  expect(text).toContain("已登记进信任阶梯");
  expect(text).toContain("已升级");
  expect(text).toContain("已降级");
  expect(text).toContain("信任阶梯拦截");
});

test("TrustLadderTest.test_settings_resolution", () => {
  expect(resolveTrustLadderSettings({})).toEqual({ requiredSuccesses: 5, spotCheckRate: 0.1 });
  expect(resolveTrustLadderSettings({ trust_ladder: { required_successes: 3, spot_check_rate: 0.25 } }))
    .toEqual({ requiredSuccesses: 3, spotCheckRate: 0.25 });
  expect(resolveTrustLadderSettings({ trust_ladder: { required_successes: 0, spot_check_rate: 9 } }))
    .toEqual({ requiredSuccesses: 5, spotCheckRate: 0.1 });
  expect(resolveTrustLadderSettings({ trust_ladder: { required_successes: 21, spot_check_rate: -1 } }))
    .toEqual({ requiredSuccesses: 5, spotCheckRate: 0.1 });
  // config explain 有 trust_ladder 一项，非法值回默认。
  const c = explainOne({ config: {} }, "trust_ladder")!;
  expect(c.effective).toBe("5 次成功/级，抽查 10%");
  const c2 = explainOne({ config: { trust_ladder: { required_successes: 3, spot_check_rate: 0.5 } } }, "trust_ladder")!;
  expect(c2.effective).toBe("3 次成功/级，抽查 50%");
  expect(explainOne({ config: { trust_ladder: { required_successes: 99 } } }, "trust_ladder")!.effective)
    .toBe("5 次成功/级，抽查 10%");
});

test("TrustLadderTest.test_audit_file_perms_and_export_source", () => {
  const home = tmpHome();
  registerSubject(home, "agent", "bot-a");
  const auditPath = join(home, TRUST_LADDER_AUDIT_FILE);
  expect(existsSync(auditPath)).toBe(true);
  expectPerms(auditPath, 0o600);
  expect(AUDIT_SOURCES.some((s) => s.label === "trust" && s.file === TRUST_LADDER_AUDIT_FILE)).toBe(true);
  const out = join(home, "audit-export.jsonl");
  const res = exportAudit(home, { out });
  expect(res.lines).toBeGreaterThan(0);
  const text = readFileSync(out, "utf-8");
  expect(text).toContain("trust_registered");
});

test("TrustLadderTest.test_evidence_cap_100", () => {
  const home = tmpHome();
  registerSubject(home, "agent", "bot-a");
  for (let i = 0; i < 105; i++) {
    recordEvidence(home, "agent", "bot-a", "success", { random: () => 0.99 });
  }
  const s = getSubject(home, "agent", "bot-a")!;
  expect(s.evidence).toHaveLength(100);
  expect(s.successes_at_level).toBe(105);
});

test("TrustLadderTest.test_cli_end_to_end", () => {
  const home = tmpHome();
  // 变异操作须 --yes。
  const noYes = runCli(home, ["trust", "register", "agent", "bot-a"]);
  expect(noYes.status).toBe(2);
  expect(noYes.stderr).toContain("--yes");
  const reg = runCli(home, ["trust", "register", "agent", "bot-a", "--yes"]);
  expect(reg.status).toBe(0);
  expect(reg.stdout).toContain("已登记");
  expect(reg.stdout).toContain("只读级");
  const dup = runCli(home, ["trust", "register", "agent", "bot-a", "--yes"]);
  expect(dup.status).toBe(2);
  const list = runCli(home, ["trust", "list"]);
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("bot-a");
  const show = runCli(home, ["trust", "show", "agent", "bot-a"]);
  expect(show.status).toBe(0);
  expect(show.stdout).toContain("只读级");
  // 门：只读级发邮件被拦（check 只判门，退出码 2）。
  const checkBlocked = runCli(home, ["trust", "check", "agent", "bot-a", "gmail_send"]);
  expect(checkBlocked.status).toBe(2);
  expect(checkBlocked.stdout).toContain("拦截");
  const checkOk = runCli(home, ["trust", "check", "agent", "bot-a", "read_file"]);
  expect(checkOk.status).toBe(0);
  expect(checkOk.stdout).toContain("放行");
  // 攒 5 次成功（CLI 记证据默认走真随机——可能被抽查；这里只断言能记，不依赖抽查与否）。
  // 为确定性，用函数级调用攒证据，CLI 只验升级路径。
  for (let i = 0; i < 5; i++) {
    recordEvidence(home, "agent", "bot-a", "success", { random: () => 0.99 });
  }
  const promote = runCli(home, ["trust", "promote", "agent", "bot-a", "--yes"]);
  expect(promote.status).toBe(0);
  expect(promote.stdout).toContain("已升级");
  expect(promote.stdout).toContain("起草级");
  const demote = runCli(home, ["trust", "demote", "agent", "bot-a", "--to", "readonly", "--yes"]);
  expect(demote.status).toBe(0);
  expect(demote.stdout).toContain("已降级");
  // review：不存在的证据 id 报错；skill 登记走同一套 CLI。
  const review = runCli(home, ["trust", "review", "ev_000000000000", "--approve", "--yes"]);
  expect(review.status).toBe(2);
  const regSkill = runCli(home, ["trust", "register", "skill", "duoasa-skill", "--yes"]);
  expect(regSkill.status).toBe(0);
  const badKind = runCli(home, ["trust", "show", "robot", "bot-a"]);
  expect(badKind.status).toBe(2);
  const usage = runCli(home, ["trust"]);
  expect(usage.status).toBe(2);
  expect(usage.stdout).toContain("nyra trust");
});

test("TrustLadderTest.test_cli_spot_check_review_flow", () => {
  const home = tmpHome();
  runCli(home, ["trust", "register", "agent", "bot-a", "--yes"]);
  // 强制抽查一条（函数级记证据，random 0.0 必抽中），再走 CLI 复核。
  const r = recordEvidence(home, "agent", "bot-a", "success", { random: () => 0.0 });
  expect(r.spotChecked).toBe(true);
  const pending = runCli(home, ["trust", "promote", "agent", "bot-a", "--yes"]);
  expect(pending.status).toBe(2);
  expect(pending.stderr).toContain("待复核");
  const review = runCli(home, ["trust", "review", r.evidence.id, "--approve", "--yes"]);
  expect(review.status).toBe(0);
  expect(review.stdout).toContain("通过");
  expect(getSubject(home, "agent", "bot-a")!.successes_at_level).toBe(1);
});

test("TrustLadderTest.test_config_keys_present_in_defaults", () => {
  const home = tmpHome();
  // loadConfig 会在临时 home 建默认 config.json；信任阶梯两键须在默认值里。
  const cfg = loadConfig(home);
  expect(cfg.trust_ladder).toEqual({ required_successes: 5, spot_check_rate: 0.1 });
  // saveConfig 改值后解析生效。
  saveConfig(home, { trust_ladder: { required_successes: 2, spot_check_rate: 0 } });
  expect(resolveTrustLadderSettings(loadConfig(home))).toEqual({ requiredSuccesses: 2, spotCheckRate: 0 });
});
