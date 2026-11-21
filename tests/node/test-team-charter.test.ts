// tests/node/test-team-charter.test.ts — GROK 批：Charter 角色契约 + 文件交接 +
// 常驻参谋长（新缺口 52）+ 团队审批门接线。全部用临时 home，不连真实服务、
// 不花真实 token、不碰真模型；多 agent 场景只用假 provider。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Agent } from "../../src/agent.ts";
import { echoProvider } from "./fake-provider.ts";
import {
  defaultSoul, saveSoul, setCharter, clearCharter, charterComplete, validateCharter,
  handleSoul, loadSoul, soulExists,
} from "../../src/soul.ts";
import {
  createTeam, listTeams, getTeam, addTeamMember, removeTeamMember, dissolveTeam,
  requireCharter, verifyCharterCompliance, formatCharterCheckLine,
  sendHandover, listHandovers, readHandover, ackHandover, resolveHandoverFile,
  teamApprovalRequired, teamApprovalSummary, planTeamDispatch, buildChiefTask,
  handleTeam, TEAM_AUDIT_FILE, type Team,
} from "../../src/team.ts";
import { resolveBotComputer } from "../../src/bot/binding.ts";
import { checkApproval, newToolContext, executeTool, resetPermissionRulesCache } from "../../src/tools.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { expectPerms } from "./fsPerms.ts";

function tmpHome(prefix = "nyra-team-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function charterInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    own: "负责写周报",
    sources: ["任务板", "上周周报"],
    output: "以 `## 结论` 开头，附三条要点",
    approval: "对外发送前须人批",
    stop: "缺关键数据时停下问人",
    ...overrides,
  };
}

/** 建一个带完整 Charter 的 Soul。 */
function makeSoul(home: string, agent: string, withCharter = true): void {
  saveSoul(home, defaultSoul(agent));
  if (withCharter) setCharter(home, agent, charterInput());
}

/** 建一支标准团队：参谋长 chief1 + 成员 member1、member2（都有完整 Charter）。 */
function makeTeam(home: string): Team {
  makeSoul(home, "chief1");
  makeSoul(home, "member1");
  makeSoul(home, "member2");
  return createTeam(home, { name: "alpha", chief: "chief1", members: ["member1", "member2"] });
}

function readAudit(home: string): Record<string, unknown>[] {
  const p = join(home, TEAM_AUDIT_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function chiefAgent(home: string, team: Team, workdir: string): Agent {
  // 假 provider 回的摘要里带 Charter 声明的 `## 结论` 标记——交付抽查的
  // output_marker 项才能过（假摘要不含标记时抽查会如实判未通过，见抽查单测）。
  return new Agent(echoProvider("## 结论\n子任务完成。"), {
    workdir,
    mode: "auto",
    maxTurns: 2,
    interactive: false,
    home,
    sessionId: null,
    skillsDirs: [],
    checkpointStore: null,
    soulAgent: "chief1",
    teamId: team.id,
    teamRole: "chief",
  } as never);
}

function memberAgent(home: string, team: Team, workdir: string): Agent {
  return new Agent(echoProvider("成员完成。"), {
    workdir,
    mode: "auto",
    maxTurns: 2,
    interactive: false,
    home,
    sessionId: null,
    skillsDirs: [],
    checkpointStore: null,
    soulAgent: "member1",
    teamId: team.id,
    teamRole: "member",
  } as never);
}

// ---- GROK-2：Charter 校验与存取 ----

test("Charter：五项齐全有效才算过；缺项/空项/超长/来源超条都拒绝", () => {
  expect(validateCharter(charterInput())).toBeNull();
  expect(validateCharter({ ...charterInput(), stop: undefined })).not.toBeNull();
  expect(validateCharter(charterInput({ own: "  " }))).toContain("不能为空");
  expect(validateCharter(charterInput({ own: "x".repeat(1001) }))).toContain("超过 1000 字");
  expect(validateCharter(charterInput({ sources: [] }))).toContain("至少要有一条");
  expect(validateCharter(charterInput({ sources: Array.from({ length: 11 }, (_, i) => `来源${i}`) }))).toContain("最多 10 条");
  expect(validateCharter(charterInput({ sources: ["x".repeat(201)] }))).toContain("超过 200 字");
  expect(validateCharter("不是对象")).not.toBeNull();
});

test("Charter：set/clear 落盘与完整性判定；写坏了拒绝落盘、旧契约不动", () => {
  const home = tmpHome();
  makeSoul(home, "a1", false);
  expect(charterComplete(loadSoul(home, "a1"))).toBe(false);
  const c = setCharter(home, "a1", charterInput());
  expect(c.own).toBe("负责写周报");
  expect(charterComplete(loadSoul(home, "a1"))).toBe(true);
  expect(() => setCharter(home, "a1", charterInput({ own: "" }))).toThrow();
  expect(charterComplete(loadSoul(home, "a1"))).toBe(true);
  expect(clearCharter(home, "a1")).toBe(true);
  expect(charterComplete(loadSoul(home, "a1"))).toBe(false);
  expect(clearCharter(home, "a1")).toBe(false);
  expect(soulExists(home, "a1")).toBe(true);
});

test("Charter：CLI set/show/clear（--yes 时不问人；缺项返回 2）", async () => {
  const home = tmpHome();
  makeSoul(home, "a2", false);
  expect(await handleSoul(["charter", "set", "a2", "--own", "写周报", "--sources", "任务板", "--output", "Markdown", "--approval", "对外须人批", "--stop", "缺数据停下", "--yes"], home)).toBe(0);
  expect(charterComplete(loadSoul(home, "a2"))).toBe(true);
  expect(await handleSoul(["charter", "show", "a2"], home)).toBe(0);
  expect(await handleSoul(["charter", "set", "a2", "--own", "写周报", "--yes"], home)).toBe(2);
  expect(await handleSoul(["charter", "clear", "a2", "--yes"], home)).toBe(0);
  expect(charterComplete(loadSoul(home, "a2"))).toBe(false);
  expect(await handleSoul(["charter", "show", "a2"], home)).toBe(0);
});

// ---- 团队 CRUD 与接单门 ----

test("团队：参谋长没 Soul、成员没 Charter 都建不起来", () => {
  const home = tmpHome();
  expect(() => createTeam(home, { name: "t", chief: "ghost", members: ["m1"] })).toThrow("没有 Soul");
  makeSoul(home, "chief1");
  expect(() => createTeam(home, { name: "t", chief: "chief1", members: ["ghost"] })).toThrow("没有 Soul");
  makeSoul(home, "m1", false);
  expect(() => createTeam(home, { name: "t", chief: "chief1", members: ["m1"] })).toThrow("角色契约（Charter）不完整");
});

test("团队：建队成功字段齐全；同名 active 不重复；参谋长不能同时是成员；最多 8 个成员", () => {
  const home = tmpHome();
  const team = makeTeam(home);
  expect(team.id).toMatch(/^team_[0-9a-f]{12}$/);
  expect(team.status).toBe("active");
  expect(team.chief).toBe("chief1");
  expect(team.members).toEqual(["member1", "member2"]);
  expect(getTeam(home, team.id)?.name).toBe("alpha");
  expect(getTeam(home, "alpha")?.id).toBe(team.id);
  expect(getTeam(home, "nope")).toBeNull();
  expect(() => createTeam(home, { name: "alpha", chief: "chief1", members: ["member1"] })).toThrow("已有同名 active 团队");
  expect(() => createTeam(home, { name: "b", chief: "chief1", members: ["chief1"] })).toThrow("不能同时是自己的下游成员");
  const many = Array.from({ length: 9 }, (_, i) => `mx${i}`);
  for (const m of many) makeSoul(home, m);
  expect(() => createTeam(home, { name: "big", chief: "chief1", members: many })).toThrow("最多 8 个");
});

test("团队：加人/移人；最后一个成员移不掉；解散是终态、list 默认藏起来", () => {
  const home = tmpHome();
  const team = makeTeam(home);
  makeSoul(home, "member3");
  const added = addTeamMember(home, "alpha", "member3");
  expect(added.members).toContain("member3");
  expect(() => addTeamMember(home, "alpha", "member3")).toThrow("已经是团队 alpha 的成员");
  const removed = removeTeamMember(home, "alpha", "member3");
  expect(removed.members).not.toContain("member3");
  removeTeamMember(home, "alpha", "member2");
  expect(() => removeTeamMember(home, "alpha", "member1")).toThrow("团队至少要留一个成员");
  const dissolved = dissolveTeam(home, "alpha");
  expect(dissolved.status).toBe("dissolved");
  expect(listTeams(home)).toHaveLength(0);
  expect(listTeams(home, true)).toHaveLength(1);
  expect(() => addTeamMember(home, "alpha", "member2")).toThrow("已解散");
  // 重复解散幂等：不抛错，直接返回已解散的团队。
  expect(dissolveTeam(home, "alpha").status).toBe("dissolved");
});

test("团队：requireCharter 接单门——没 Soul / 没 Charter / Charter 不全都拒绝", () => {
  const home = tmpHome();
  expect(() => requireCharter(home, "ghost", "接单")).toThrow("没有 Soul");
  makeSoul(home, "m1", false);
  expect(() => requireCharter(home, "m1", "接单")).toThrow("角色契约（Charter）不完整");
  makeSoul(home, "m2");
  expect(requireCharter(home, "m2", "接单").own).toBe("负责写周报");
});

// ---- GROK-2：Charter 交付抽查 ----

test("Charter 抽查：齐全 + 交付物非空 + 标记齐全才通过；缺标记、空交付物都不过", () => {
  const home = tmpHome();
  makeTeam(home);
  const ok = verifyCharterCompliance(home, "member1", "## 结论\n都做完了。");
  expect(ok.passed).toBe(true);
  expect(formatCharterCheckLine(ok)).toContain("charter_valid: true");
  const noMarker = verifyCharterCompliance(home, "member1", "做完了，没按格式写。");
  expect(noMarker.passed).toBe(false);
  expect(formatCharterCheckLine(noMarker)).toContain("charter_valid: false");
  expect(formatCharterCheckLine(noMarker)).toContain("output_marker");
  const empty = verifyCharterCompliance(home, "member1", "   ");
  expect(empty.passed).toBe(false);
  expect(formatCharterCheckLine(empty)).toContain("deliverable_nonempty");
  const ghost = verifyCharterCompliance(home, "ghost", "## 结论\n做完了。");
  expect(ghost.passed).toBe(false);
  expect(formatCharterCheckLine(ghost)).toContain("charter_present");
});

test("Charter 抽查：Charter 没声明反引号标记时该项跳过（不算通过也不算失败）", () => {
  const home = tmpHome();
  makeSoul(home, "chief1");
  makeSoul(home, "plain");
  setCharter(home, "plain", charterInput({ output: "写一段 Markdown 报告" }));
  const r = verifyCharterCompliance(home, "plain", "随便写点什么。");
  expect(r.passed).toBe(true);
  expect(r.checks.find((c) => c.id === "output_marker")?.skipped).toBe(true);
  expect(formatCharterCheckLine(r)).toContain("跳过：output_marker");
});

// ---- GROK-4：文件交接 ----

function setupHandover(home: string): { fromWd: string; toWd: string } {
  makeSoul(home, "from1");
  makeSoul(home, "to1");
  const fromWd = resolveBotComputer(home, "from1").workdir;
  const toWd = resolveBotComputer(home, "to1").workdir;
  return { fromWd, toWd };
}

test("交接：小文本文件内联原文；inbox/outbox 各落一份；双方 changelog 都记一行", () => {
  const home = tmpHome();
  const { fromWd, toWd } = setupHandover(home);
  mkdirSync(join(fromWd, "reports"), { recursive: true });
  writeFileSync(join(fromWd, "reports", "weekly.md"), "# 周报\n都做完了。\n", "utf-8");
  const pkg = sendHandover(home, { from: "from1", to: "to1", task: "本周周报", files: ["reports/weekly.md"] });
  expect(pkg.id).toMatch(/^ho_[0-9a-f]{12}$/);
  expect(pkg.files).toHaveLength(1);
  expect(pkg.files[0].content).toContain("# 周报");
  expect(pkg.files[0].sha256).toBe(createHash("sha256").update("# 周报\n都做完了。\n").digest("hex"));
  expect(existsSync(join(toWd, "handover", "inbox", `${pkg.id}.json`))).toBe(true);
  expect(existsSync(join(fromWd, "handover", "outbox", `${pkg.id}.json`))).toBe(true);
  expect(readFileSync(join(toWd, "handover", "changelog.md"), "utf-8")).toContain("本周周报");
  expect(readFileSync(join(fromWd, "handover", "changelog.md"), "utf-8")).toContain("本周周报");
  expectPerms(join(toWd, "handover", "inbox", `${pkg.id}.json`), 0o600);
});

test("交接：大文件与二进制只记指纹、不内联原文", () => {
  const home = tmpHome();
  const { fromWd } = setupHandover(home);
  writeFileSync(join(fromWd, "big.txt"), "x".repeat(9 * 1024), "utf-8");
  writeFileSync(join(fromWd, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
  const pkg = sendHandover(home, { from: "from1", to: "to1", task: "大文件与二进制", files: ["big.txt", "bin.dat"] });
  expect(pkg.files.find((f) => f.path === "big.txt")?.content).toBeNull();
  expect(pkg.files.find((f) => f.path === "bin.dat")?.content).toBeNull();
  expect(pkg.files.every((f) => f.sha256.length === 64)).toBe(true);
});

test("交接：列出/查看/确认；确认只能由接收方做；重复确认幂等", () => {
  const home = tmpHome();
  setupHandover(home);
  const pkg = sendHandover(home, { from: "from1", to: "to1", task: "请看一下" });
  expect(listHandovers(home, "to1", "inbox")).toHaveLength(1);
  expect(listHandovers(home, "from1", "outbox")).toHaveLength(1);
  expect(readHandover(home, "to1", pkg.id).box).toBe("inbox");
  expect(() => ackHandover(home, "from1", pkg.id)).toThrow("不是发给");
  const acked = ackHandover(home, "to1", pkg.id);
  expect(acked.status).toBe("accepted");
  expect(ackHandover(home, "to1", pkg.id).status).toBe("accepted");
  expect(() => readHandover(home, "to1", "ho_000000000000")).toThrow("找不到交接包");
});

test("交接：路径 containment——绝对路径、.. 逃逸、不存在的文件都拒绝", () => {
  const home = tmpHome();
  const { fromWd } = setupHandover(home);
  writeFileSync(join(fromWd, "ok.txt"), "ok", "utf-8");
  expect(() => sendHandover(home, { from: "from1", to: "to1", task: "逃逸", files: ["../evil.txt"] })).toThrow("越界");
  expect(() => sendHandover(home, { from: "from1", to: "to1", task: "绝对", files: ["/etc/passwd"] })).toThrow("相对路径");
  expect(() => sendHandover(home, { from: "from1", to: "to1", task: "不存在", files: ["nope.txt"] })).toThrow("不存在");
  expect(() => resolveHandoverFile(fromWd, "ok.txt")).not.toThrow();
});

test("交接：符号链接不跟（防 workspace 外偷渡）", () => {
  if (process.platform === "win32") return;
  const home = tmpHome();
  const { fromWd } = setupHandover(home);
  writeFileSync(join(tmpdir(), "nyra-team-outside.txt"), "outside", "utf-8");
  symlinkSync(join(tmpdir(), "nyra-team-outside.txt"), join(fromWd, "link.txt"));
  expect(() => sendHandover(home, { from: "from1", to: "to1", task: "链接", files: ["link.txt"] })).toThrow("符号链接");
});

test("交接：没 Soul 的 agent 收不到也发不出；不能给自己交接", () => {
  const home = tmpHome();
  makeSoul(home, "from1");
  expect(() => sendHandover(home, { from: "from1", to: "ghost", task: "x" })).toThrow("还没有 Soul");
  expect(() => sendHandover(home, { from: "ghost", to: "from1", task: "x" })).toThrow("还没有 Soul");
  expect(() => sendHandover(home, { from: "from1", to: "from1", task: "x" })).toThrow("不能给自己交接");
  expect(() => sendHandover(home, { from: "from1", to: "to1", task: "  " })).toThrow("一句话任务");
});

// ---- GROK-3：团队审批门 ----

test("团队审批门判定：只有团队里成员的对外动作才拦；参谋长、本地活、没进团队都不拦", () => {
  const home = tmpHome();
  const team = makeTeam(home);
  expect(teamApprovalRequired(home, null, "member1", "gmail_send")).toBeNull();
  expect(teamApprovalRequired(home, "nope-team", "member1", "gmail_send")).toBeNull();
  expect(teamApprovalRequired(home, team.id, "chief1", "gmail_send")).toBeNull();
  expect(teamApprovalRequired(home, team.id, "outsider", "gmail_send")).toBeNull();
  expect(teamApprovalRequired(home, team.id, "member1", "write_file")).toBeNull();
  expect(teamApprovalRequired(home, team.id, "member1", "shell")).toBeNull();
  const gate = teamApprovalRequired(home, team.id, "member1", "gmail_send");
  expect(gate).not.toBeNull();
  expect(gate!.agent).toBe("member1");
  expect(gate!.chief).toBe("chief1");
  expect(gate!.actionLabel).toBe("发消息");
  const httpGate = teamApprovalRequired(home, team.id, "member1", "http_post");
  expect(httpGate).not.toBeNull();
  expect(httpGate!.actionLabel).toBeNull();
  const summary = teamApprovalSummary(gate!, "发一封周报邮件");
  expect(summary).toContain("member1 替团队 alpha 申请 gmail_send");
  expect(summary).toContain("发消息");
  expect(summary).toContain("参谋长 chief1");
});

test("团队审批门 checkApproval：批了放行、拒了抛错；没审批桥又非交互直接拒绝", async () => {
  const home = tmpHome();
  const team = makeTeam(home);
  resetPermissionRulesCache();
  const base = { workdir: tmpHome(), mode: "auto", home, soulAgent: "member1", teamId: team.id };
  const approved: string[] = [];
  const ctxOk = newToolContext({ ...base, interactive: false, approveFn: async (tool, summary) => { approved.push(`${tool}:${summary}`); return true; } });
  await checkApproval(ctxOk, "gmail_send", "发一封邮件");
  expect(approved).toHaveLength(1);
  expect(approved[0]).toContain("member1 替团队 alpha 申请 gmail_send");
  const ctxNo = newToolContext({ ...base, interactive: false, approveFn: async () => false });
  await expect(checkApproval(ctxNo, "gmail_send", "发一封邮件")).rejects.toThrow("用户拒绝执行");
  const ctxNone = newToolContext({ ...base, interactive: false, approveFn: null });
  await expect(checkApproval(ctxNone, "gmail_send", "发一封邮件")).rejects.toThrow("没有审批人");
});

test("团队审批门 checkApproval：参谋长自己的对外动作不走门；成员的本地写操作不走门", async () => {
  const home = tmpHome();
  const team = makeTeam(home);
  resetPermissionRulesCache();
  let calls = 0;
  const ctxChief = newToolContext({
    workdir: tmpHome(), mode: "full", home, soulAgent: "chief1", teamId: team.id,
    interactive: false, approveFn: async () => { calls++; return true; },
  });
  await checkApproval(ctxChief, "gmail_send", "参谋长自己发");
  expect(calls).toBe(0);
  const ctxLocal = newToolContext({
    workdir: tmpHome(), mode: "full", home, soulAgent: "member1", teamId: team.id,
    interactive: false, approveFn: async () => { calls++; return true; },
  });
  await checkApproval(ctxLocal, "write_file", "成员本地写文件");
  expect(calls).toBe(0);
});

// ---- GROK-1：参谋长分派 ----

test("分派计划：团队 active + Charter 齐全 + 硬顶没触顶才放行；解散/缺 Charter 都拒绝", () => {
  const home = tmpHome();
  const team = makeTeam(home);
  const plan = planTeamDispatch(home, "alpha", "把周报写了");
  expect(plan.chief).toBe("chief1");
  expect(plan.members).toEqual(["member1", "member2"]);
  expect(plan.cap.allowed).toBe(true);
  clearCharter(home, "member2");
  expect(() => planTeamDispatch(home, "alpha", "把周报写了")).toThrow("角色契约（Charter）不完整");
  dissolveTeam(home, team.id);
  expect(() => planTeamDispatch(home, "alpha", "把周报写了")).toThrow("已解散");
  expect(() => planTeamDispatch(home, "alpha", "  ")).toThrow("一句话任务");
});

test("参谋长任务文本：只拆解分派汇总、不写业务代码、只收简报、成员名单齐全", () => {
  const home = tmpHome();
  makeTeam(home);
  const plan = planTeamDispatch(home, "alpha", "把周报写了");
  const text = buildChiefTask(plan);
  expect(text).toContain("member1");
  expect(text).toContain("member2");
  expect(text).toContain("不写业务代码");
  expect(text).toContain("只收各成员的简报");
  expect(text).toContain("把周报写了");
  expect(text).toContain("不要硬拆");
});

// ---- delegateDetailed 团队分派门 + Charter 抽查 + delegateFn 透传 ----

test("分派门：参谋长派给成员成功、交回文本带 charter_valid 行；不指定 agent、派给非成员都拒绝", async () => {
  const home = tmpHome();
  const team = makeTeam(home);
  const workdir = mkdtempSync(join(tmpdir(), "nyra-team-wd-"));
  const chief = chiefAgent(home, team, workdir);
  const ok = await chief.delegateDetailed("写一段摘要", 1, { agent: "member1" });
  expect(ok.ok).toBe(true);
  expect(ok.text).toContain("charter_valid: true");
  const noAgent = await chief.delegateDetailed("写一段摘要", 1, {});
  expect(noAgent.ok).toBe(false);
  expect(noAgent.text).toContain("须指定 agent");
  const outsider = await chief.delegateDetailed("写一段摘要", 1, { agent: "ghost" });
  expect(outsider.ok).toBe(false);
  expect(outsider.text).toContain("只认团队 alpha 的成员");
});

test("分派门：成员自己不能再分派（下游之间不直接互发指令）", async () => {
  const home = tmpHome();
  const team = makeTeam(home);
  const workdir = mkdtempSync(join(tmpdir(), "nyra-team-wd-"));
  const member = memberAgent(home, team, workdir);
  const d = await member.delegateDetailed("再派给别人", 1, { agent: "member2" });
  expect(d.ok).toBe(false);
  expect(d.text).toContain("只有参谋长能分派");
});

test("delegateFn 不再丢 opts：工具层 delegate 带 agent 参数能分派到成员", async () => {
  const home = tmpHome();
  const team = makeTeam(home);
  const workdir = mkdtempSync(join(tmpdir(), "nyra-team-wd-"));
  const chief = chiefAgent(home, team, workdir);
  // 工具层入口（Agent.ctx.delegateFn）——旧代码丢 opts，agent 参数到不了 delegateDetailed。
  const out = await chief.ctx.delegateFn!("写一段摘要", 1, { agent: "member1" });
  expect(out).toContain("charter_valid: true");
  const refused = await chief.ctx.delegateFn!("写一段摘要", 1, {});
  expect(refused).toContain("须指定 agent");
});

test("工具层 delegate：args.agent 透传到 delegateDetailed（经 executeTool）", async () => {
  const home = tmpHome();
  const team = makeTeam(home);
  const workdir = mkdtempSync(join(tmpdir(), "nyra-team-wd-"));
  const chief = chiefAgent(home, team, workdir);
  const ctx = newToolContext({
    workdir, mode: "auto", home, interactive: false,
    delegateFn: (task, maxTurns, opts) => chief.delegate(task, maxTurns, opts ?? {}),
  });
  const out = await executeTool("delegate", { task: "写一段摘要", max_turns: 1, agent: "member1" }, ctx);
  expect(out).toContain("charter_valid: true");
});

// ---- CLI：nyra team ----

test("CLI team：create/list/show/add/remove/dissolve 走通；dispatch --dry-run 只出计划不跑模型", async () => {
  const home = tmpHome();
  makeSoul(home, "chief1");
  makeSoul(home, "member1");
  expect(await handleTeam(["create", "beta", "--chief", "chief1", "--members", "member1"], home)).toBe(0);
  expect(await handleTeam(["list"], home)).toBe(0);
  expect(await handleTeam(["show", "beta"], home)).toBe(0);
  expect(await handleTeam(["show", "nope"], home)).toBe(1);
  makeSoul(home, "member2");
  expect(await handleTeam(["add", "beta", "member2"], home)).toBe(0);
  expect(await handleTeam(["remove", "beta", "member2"], home)).toBe(0);
  expect(await handleTeam(["dispatch", "beta", "把周报写了", "--dry-run"], home)).toBe(0);
  expect(await handleTeam(["dissolve", "beta", "--yes"], home)).toBe(0);
  expect(getTeam(home, "beta")?.status).toBe("dissolved");
  expect(await handleTeam(["create"], home)).toBe(2);
  expect(await handleTeam(["bogus"], home)).toBe(2);
});

test("CLI team dispatch：runChief 被调到、汇总输出返回、审计记 dispatched", async () => {
  const home = tmpHome();
  makeTeam(home);
  let ran: { plan: unknown; task: string } | null = null;
  const code = await handleTeam(["dispatch", "alpha", "把周报写了"], home, {
    runChief: async (plan, task) => { ran = { plan, task }; return "汇总：都做完了。"; },
  });
  expect(code).toBe(0);
  expect(ran).not.toBeNull();
  expect(ran!.task).toContain("不写业务代码");
  expect(readAudit(home).some((e) => e.kind === "dispatched")).toBe(true);
});

test("CLI team handover：send/list/show/ack 走通", async () => {
  const home = tmpHome();
  const { fromWd } = setupHandover(home);
  writeFileSync(join(fromWd, "note.txt"), "hi", "utf-8");
  expect(await handleTeam(["handover", "send", "--from", "from1", "--to", "to1", "--task", "看一下", "--file", "note.txt"], home)).toBe(0);
  expect(await handleTeam(["handover", "list", "to1"], home)).toBe(0);
  const pkgs = listHandovers(home, "to1", "inbox");
  expect(pkgs).toHaveLength(1);
  expect(await handleTeam(["handover", "show", "to1", pkgs[0].id], home)).toBe(0);
  expect(await handleTeam(["handover", "ack", "to1", pkgs[0].id], home)).toBe(0);
  expect(await handleTeam(["handover", "send", "--from", "from1", "--to", "to1"], home)).toBe(2);
});

// ---- 事件注册与时间线 ----

test("事件：13 个新事件类型都能进证据链；时间线渲染写清团队动作", () => {
  const home = tmpHome();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("团队任务", "sess-1", home, "auto", 10);
  const runId = state.run_id;
  const cases: Array<[string, Record<string, unknown>]> = [
    ["soul_charter_set", { agent: "member1" }],
    ["soul_charter_cleared", { agent: "member1" }],
    ["team_created", { team_id: "team_abc123456789", chief: "chief1", members: 2 }],
    ["team_member_added", { team_id: "team_abc123456789", agent: "member2" }],
    ["team_member_removed", { team_id: "team_abc123456789", agent: "member2" }],
    ["team_dissolved", { team_id: "team_abc123456789" }],
    ["team_dispatched", { team_id: "team_abc123456789", chief: "chief1", members: 2 }],
    ["team_handover_sent", { handover_id: "ho_abc123456789", from: "a", to: "b" }],
    ["team_handover_received", { handover_id: "ho_abc123456789", from: "a", to: "b" }],
    ["team_handover_accepted", { handover_id: "ho_abc123456789", from: "a", to: "b" }],
    ["team_approval_requested", { team_id: "team_abc123456789", agent: "member1", chief: "chief1", tool: "gmail_send" }],
    ["team_approval_decided", { team_id: "team_abc123456789", agent: "member1", tool: "gmail_send", approved: true }],
    ["team_charter_verified", { team_id: "team_abc123456789", agent: "member1", run_id: "task-1", passed: true }],
  ];
  for (const [type, fields] of cases) store.appendEvent(runId, type, fields);
  const tl = buildTimeline(store, runId);
  const text = formatTimelineText(tl);
  expect(text).toContain("团队已建");
  expect(text).toContain("团队审批");
  expect(text).toContain("Charter 抽查通过");
  expect(text).toContain("交接已发出");
  expect(text).toContain("角色契约");
});
