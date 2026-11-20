// tests/node/test-bughunt.test.ts — 授权漏洞挖掘技能包（候选提案 1）专项：
// 范围卡校验与目标判定、证伪三态结论、七问核对、证据卫生、VRT 映射、
// 提交前核对五道门、独立审查接线、范围卡账本、技能包安装、模板、CLI。
// 全部 mock-only，不连真实服务、不调模型、不真的测任何目标。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BughuntError, BUGHUNT_SKILL_NAME, BUGHUNT_SKILL_TEXT,
  REQUIRED_FORBIDDEN_TECHNIQUES,
  validateScopeCard, parseScopeCard, checkTarget, hostMatches,
  addScope, removeScope, listScopes, findScope, loadScopeStore, scopeStorePath,
  FALSIFY_CHECKS, evaluateFalsification,
  SEVEN_QUESTIONS, evaluateSevenQuestions,
  checkEvidenceHygiene, REQUIRED_REPORT_SECTIONS,
  mapVrtSeverity, evaluateSubmitGate, reviewSubmitReport,
  appendBughuntAudit, bughuntAuditPath,
  bughuntSkillInstalled, installBughuntSkill,
  scopeCardTemplate, findingTemplate, reportTemplate, parseFinding,
  type ScopeCard, type FalsificationAttempt, type SevenAnswer,
} from "../../src/bughunt.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function validCard(): ScopeCard {
  return JSON.parse(scopeCardTemplate()) as ScopeCard;
}

function goodReport(): string {
  return [
    "# 订单价格篡改",
    "",
    "- 目标：https://ticket.example.com/order/123",
    "- 严重度：high",
    "- 证伪：confirmed",
    "",
    "## 复现步骤",
    "",
    "1. 用测试账号下单",
    "2. 改价重放",
    "3. 总价跟着变",
    "",
    "## 影响",
    "",
    "攻击者能以任意价格下单。",
    "",
    "## 证据",
    "",
    "脱敏后的请求与响应。",
    "",
    "## 脱敏记录",
    "",
    "已删测试账号邮箱。",
  ].join("\n");
}

function allYesSeven(): Record<string, SevenAnswer> {
  return { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "yes", q6: "yes", q7: "yes" };
}

function survivedAttempts(): FalsificationAttempt[] {
  return [
    { check: "independent-reproduction", outcome: "survived", detail: "换账号重走一遍，效果复现" },
    { check: "different-input", outcome: "survived", detail: "换一个篡改价 0，同样被接受" },
    { check: "negative-control", outcome: "survived", detail: "正常价 99 仍返回正常总价" },
  ];
}

function fakeReviewer(decision: string, reason = "测试结论") {
  return {
    async chat(_messages: unknown[]) {
      return { choices: [{ message: { content: JSON.stringify({ decision, reason }) } }] };
    },
  };
}

// ---- 范围卡校验 ----

test("范围卡：模板卡有效", () => {
    expect(validateScopeCard(validCard())).toEqual([]);
  });

test("范围卡：缺一条红线手法就无效", () => {
    const card = validCard();
    card.forbidden_techniques = REQUIRED_FORBIDDEN_TECHNIQUES.filter((t) => t !== "凭据攻击");
    const errors = validateScopeCard(card);
    expect(errors.some((e) => e.includes("凭据攻击"))).toBe(true);
  });

test("范围卡：目标为空、速率越界、同一手法既允许又禁止都无效", () => {
    const noTarget = validCard();
    noTarget.targets = [];
    expect(validateScopeCard(noTarget).some((e) => e.includes("targets"))).toBe(true);
    for (const rate of [0, -1, 11, Number.NaN]) {
      const card = validCard();
      card.max_requests_per_second = rate;
      expect(validateScopeCard(card).some((e) => e.includes("max_requests_per_second"))).toBe(true);
    }
    const clash = validCard();
    clash.allowed_techniques = ["批量扫描"];
    expect(validateScopeCard(clash).some((e) => e.includes("既允许又禁止"))).toBe(true);
  });

test("范围卡：坏目标、坏日期、坏名字都无效", () => {
    const badHost = validCard();
    badHost.targets = ["not a host!!"];
    expect(validateScopeCard(badHost).length).toBeGreaterThan(0);
    const badDate = validCard();
    badDate.expires_at = "不是日期";
    expect(validateScopeCard(badDate).some((e) => e.includes("expires_at"))).toBe(true);
    const badName = validCard();
    badName.name = "有 空格";
    expect(validateScopeCard(badName).some((e) => e.includes("name"))).toBe(true);
  });

test("范围卡：非法 JSON 与无效卡抛错", () => {
    expect(() => parseScopeCard("{不是 json")).toThrow(BughuntError);
    expect(() => parseScopeCard(JSON.stringify({ name: "x" }))).toThrow(BughuntError);
  });

// ---- 目标判定 ----

test("目标判定：裸主机名只匹配它自己，*. 匹配子域名", () => {
    expect(hostMatches("ticket.example.com", "ticket.example.com")).toBe(true);
    expect(hostMatches("sub.ticket.example.com", "ticket.example.com")).toBe(false);
    expect(hostMatches("sub.ticket.example.com", "*.ticket.example.com")).toBe(true);
    expect(hostMatches("ticket.example.com", "*.ticket.example.com")).toBe(false);
  });

test("目标判定：在范围内、禁区优先、过期即越界", () => {
    const card = validCard();
    expect(checkTarget(card, "https://ticket.example.com/order/123").inScope).toBe(true);
    expect(checkTarget(card, "https://other.example.com/").inScope).toBe(false);
    expect(checkTarget(card, "https://admin.example.com/").inScope).toBe(false);
    expect(checkTarget(card, "https://ticket.example.com/admin").inScope).toBe(false);
    expect(checkTarget(card, "https://ticket.example.com/admin/users").inScope).toBe(false);
    expect(checkTarget(card, "ftp://ticket.example.com/").inScope).toBe(false);
    expect(checkTarget(card, "不是 URL").inScope).toBe(false);
    const expired = validCard();
    expired.expires_at = "2020-01-01";
    expect(checkTarget(expired, "https://ticket.example.com/").inScope).toBe(false);
  });

test("目标判定：URL 目标按前缀匹配", () => {
    const card = validCard();
    card.targets = ["https://ticket.example.com/order"];
    expect(checkTarget(card, "https://ticket.example.com/order/123").inScope).toBe(true);
    expect(checkTarget(card, "https://ticket.example.com/profile").inScope).toBe(false);
  });

// ---- 证伪验证 ----

test("证伪：全 survived → confirmed；有 refuted → rejected；有 blocked → pending", () => {
    expect(evaluateFalsification({ attempts: survivedAttempts() }).verdict).toBe("confirmed");
    const refuted = evaluateFalsification({
        attempts: [
          { check: "independent-reproduction", outcome: "refuted", detail: "重走一遍，效果没了" },
        ],
      });
    expect(refuted.verdict).toBe("rejected");
    expect(refuted.refutation).toContain("效果没了");
    const blocked = evaluateFalsification({
        attempts: [
          { check: "independent-reproduction", outcome: "survived", detail: "回显了" },
          { check: "browser-execution", outcome: "blocked", detail: "没条件看浏览器执行" },
        ],
        vulnClass: "xss-reflected",
      });
    expect(blocked.verdict).toBe("pending");
    expect(blocked.validationPlan).toContain("浏览器");
  });

test("证伪：一次尝试都没做按 pending 算；未知检查名抛错", () => {
    const none = evaluateFalsification({ attempts: [] });
    expect(none.verdict).toBe("pending");
    expect(none.blocker).toContain("尚未做任何证伪尝试");
    expect(() => evaluateFalsification({
          attempts: [{ check: "瞎编的检查", outcome: "survived", detail: "x" }],
        })).toThrow(BughuntError);
    expect(() => evaluateFalsification({
          attempts: [{ check: "independent-reproduction", outcome: "survived", detail: "  " }],
        })).toThrow(BughuntError);
  });

// ---- 七问 ----

test("七问：全 yes 才过；no、unknown、没答都不过", () => {
    expect(evaluateSevenQuestions(allYesSeven()).passed).toBe(true);
    expect(SEVEN_QUESTIONS.length).toBe(7);
    const oneNo = allYesSeven();
    oneNo.q5 = "no";
    const r1 = evaluateSevenQuestions(oneNo);
    expect(r1.passed).toBe(false);
    expect(r1.failed).toContain("q5");
    const missing = allYesSeven();
    delete (missing as Record<string, SevenAnswer>).q7;
    const r2 = evaluateSevenQuestions(missing);
    expect(r2.passed).toBe(false);
    expect(r2.unanswered).toContain("q7");
  });

// ---- 证据卫生 ----

test("证据卫生：干净报告通过；检出项只报模式与行号、不报原文", () => {
    expect(checkEvidenceHygiene(goodReport()).clean).toBe(true);
    const secret = "sk-test-9f27SECRETVALUE";
    const dirty = goodReport() + `\napi_key = "${secret}"\nAuthorization: Bearer abcdefghij1234567890\n`;
    const result = checkEvidenceHygiene(dirty);
    expect(result.clean).toBe(false);
    expect(result.hits.map((h) => h.pattern)).toContain("api-key");
    expect(result.hits.map((h) => h.pattern)).toContain("bearer-token");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("abcdefghij1234567890");
  });

test("证据卫生：缺必填段列出来", () => {
    const result = checkEvidenceHygiene("# 标题\n\n只有一句话。\n");
    for (const s of REQUIRED_REPORT_SECTIONS) {
      expect(result.missingSections).toContain(s);
    }
  });

// ---- VRT 映射 ----

test("VRT 映射：已知类别有档位，未知类别不编档位", () => {
    expect(mapVrtSeverity("idor")).toEqual({ severity: "high" });
    expect(mapVrtSeverity("rce")).toEqual({ severity: "critical" });
    expect(mapVrtSeverity("xss-reflected")).toEqual({ severity: "medium" });
    const unknown = mapVrtSeverity("某种新类别");
    expect(unknown.severity).toBeNull();
  });

// ---- 提交前核对五道门 ----

function greenGateInput() {
  return {
    scope: validCard(),
    target: "https://ticket.example.com/order/123",
    vulnClass: "price-tampering",
    severity: "high" as string | null,
    falsification: { attempts: survivedAttempts() },
    seven: allYesSeven(),
    reportText: goodReport(),
  };
}

test("提交核对：五道全过才放行", () => {
    const result = evaluateSubmitGate(greenGateInput());
    expect(result.decision).toBe("allow");
    expect(result.reasons).toEqual([]);
  });

test("提交核对：每一道门不过都拦截并写明原因", () => {
    const outOfScope = evaluateSubmitGate({ ...greenGateInput(), target: "https://other.example.com/" });
    expect(outOfScope.decision).toBe("block");
    expect(outOfScope.reasons.some((r) => r.includes("范围门"))).toBe(true);

    const pending = evaluateSubmitGate({
        ...greenGateInput(),
        falsification: { attempts: [{ check: "browser-execution", outcome: "blocked", detail: "没条件看" }] },
        vulnClass: "xss-reflected",
        severity: "medium",
      });
    expect(pending.decision).toBe("block");
    expect(pending.reasons.some((r) => r.includes("证伪门"))).toBe(true);

    const sevenFail = evaluateSubmitGate({
        ...greenGateInput(),
        seven: { ...allYesSeven(), q7: "no" },
      });
    expect(sevenFail.decision).toBe("block");
    expect(sevenFail.reasons.some((r) => r.includes("七问门") && r.includes("q7"))).toBe(true);

    const dirty = evaluateSubmitGate({
        ...greenGateInput(),
        reportText: goodReport() + "\npassword: hunter-secret-9f27\n",
      });
    expect(dirty.decision).toBe("block");
    expect(dirty.reasons.some((r) => r.includes("卫生门"))).toBe(true);

    const noReport = evaluateSubmitGate({ ...greenGateInput(), reportText: null });
    expect(noReport.decision).toBe("block");
    expect(noReport.reasons.some((r) => r.includes("未提供报告文本"))).toBe(true);

    const mismatch = evaluateSubmitGate({ ...greenGateInput(), severity: "low" });
    expect(mismatch.decision).toBe("block");
    expect(mismatch.reasons.some((r) => r.includes("严重度门"))).toBe(true);

    const unmappedNoSeverity = evaluateSubmitGate({
        ...greenGateInput(), vulnClass: "某种新类别", severity: null,
      });
    expect(unmappedNoSeverity.decision).toBe("block");
    const unmappedDeclared = evaluateSubmitGate({
        ...greenGateInput(), vulnClass: "某种新类别", severity: "medium",
      });
    expect(unmappedDeclared.decision).toBe("allow");
  });

// ---- 独立审查接线 ----

test("审查接线：未开启时跳过；开启后无 runner 拦截（fail-closed）", async () => {
    const skipped = await reviewSubmitReport({
        config: { reviewer: { enabled: false } },
        summary: "提交测试",
        scope: "cm-com",
        targetHost: "ticket.example.com",
        severity: "high",
      });
    expect(skipped.decision).toBe("ALLOW");
    expect(skipped.source).toBe("skipped");

    const noRunner = await reviewSubmitReport({
        config: { reviewer: { enabled: true } },
        summary: "提交测试",
        scope: "cm-com",
        targetHost: "ticket.example.com",
        severity: "high",
        runner: null,
      });
    expect(noRunner.decision).toBe("BLOCK");
    expect(noRunner.source).toBe("unavailable");
  });

test("审查接线：开启后模型 ALLOW 放行、BLOCK 拦截、抛错拦截", async () => {
    const base = {
      config: { reviewer: { enabled: true } },
      summary: "提交测试",
      scope: "cm-com",
      targetHost: "ticket.example.com",
      severity: "high",
    };
    const allow = await reviewSubmitReport({ ...base, runner: fakeReviewer("allow") as never });
    expect(allow.decision).toBe("ALLOW");
    expect(allow.source).toBe("model");
    const block = await reviewSubmitReport({ ...base, runner: fakeReviewer("block", "报告里还有未脱敏邮箱") as never });
    expect(block.decision).toBe("BLOCK");
    expect(block.reason).toContain("未脱敏邮箱");
    const throwing = {
      async chat(_messages: unknown[]) { throw new Error("model-down-probe-9f27"); },
    };
    const failed = await reviewSubmitReport({ ...base, runner: throwing as never });
    expect(failed.decision).toBe("BLOCK");
  });

// ---- 范围卡账本 ----

test("范围卡账本：增删查往返；重名拒绝", () => {
    const home = tmpHome("nyra-bughunt-store-");
    expect(listScopes(home)).toEqual([]);
    addScope(home, validCard());
    expect(listScopes(home).map((s) => s.name)).toEqual(["cm-com"]);
    expect(findScope(home, "cm-com")?.platform).toBe("Intigriti");
    expect(() => addScope(home, validCard())).toThrow(BughuntError);
    expect(removeScope(home, "不存在")).toBe(false);
    expect(removeScope(home, "cm-com")).toBe(true);
    expect(listScopes(home)).toEqual([]);
  });

test("范围卡账本：损坏先备份再抛错", () => {
    const home = tmpHome("nyra-bughunt-corrupt-");
    mkdirSync(home, { recursive: true });
    writeFileSync(scopeStorePath(home), "{坏掉的 json", "utf-8");
    expect(() => loadScopeStore(home)).toThrow(BughuntError);
    expect(existsSync(scopeStorePath(home))).toBe(false);
  });

// ---- 技能包安装 ----

test("技能包安装：正文可解析、装进 skills、重装拒绝、--force 覆盖", () => {
    const home = tmpHome("nyra-bughunt-install-");
    expect(bughuntSkillInstalled(home)).toBe(false);
    const first = installBughuntSkill(home);
    expect(first.overwritten).toBe(false);
    expect(bughuntSkillInstalled(home)).toBe(true);
    expect(readFileSync(first.path, "utf-8")).toBe(BUGHUNT_SKILL_TEXT);
    expect(() => installBughuntSkill(home)).toThrow(BughuntError);
    const second = installBughuntSkill(home, { force: true });
    expect(second.overwritten).toBe(true);
    expect(readFileSync(second.path, "utf-8")).toBe(BUGHUNT_SKILL_TEXT);
  });

// ---- 模板与技能正文一致 ----

test("模板：范围卡模板能解析且有效；发现模板能解析；报告模板含必填段", () => {
    expect(validateScopeCard(JSON.parse(scopeCardTemplate()))).toEqual([]);
    const finding = parseFinding(findingTemplate());
    expect(finding.scope).toBe("cm-com");
    expect(finding.seven.q1).toBe("yes");
    expect(finding.falsification.attempts.length).toBe(3);
    for (const s of REQUIRED_REPORT_SECTIONS) {
      expect(reportTemplate()).toContain(s);
    }
  });

test("技能正文：与模板同内容的关键字段都在", () => {
    expect(BUGHUNT_SKILL_TEXT).toContain("name: authorized-bughunt");
    expect(BUGHUNT_SKILL_TEXT).toContain('"max_requests_per_second"');
    expect(BUGHUNT_SKILL_TEXT).toContain('"seven"');
    expect(BUGHUNT_SKILL_TEXT).toContain('"attempts"');
    expect(BUGHUNT_SKILL_TEXT).toContain("批量扫描");
    expect(BUGHUNT_SKILL_TEXT).toContain("证伪");
    expect(FALSIFY_CHECKS.length).toBe(6);
  });

test("发现解析：坏 JSON、缺字段、七问非法值都抛错", () => {
    expect(() => parseFinding("{坏")).toThrow(BughuntError);
    expect(() => parseFinding(JSON.stringify({ scope: "cm-com" }))).toThrow(BughuntError);
    const badSeven = JSON.parse(findingTemplate()) as Record<string, unknown>;
    (badSeven.seven as Record<string, string>).q1 = "maybe";
    expect(() => parseFinding(JSON.stringify(badSeven))).toThrow(BughuntError);
  });

// ---- 审计日志 ----

test("审计日志：只记元数据", () => {
    const home = tmpHome("nyra-bughunt-audit-");
    mkdirSync(home, { recursive: true });
    appendBughuntAudit(home, {
        at: "2026-11-20T00:00:00.000Z",
        action: "submit_gate",
        scope: "cm-com",
        target_host: "ticket.example.com",
        decision: "allow",
        failing: [],
        severity: "high",
        falsification_verdict: "confirmed",
        reviewer_source: "skipped",
      });
    const lines = readFileSync(bughuntAuditPath(home), "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.target_host).toBe("ticket.example.com");
    expect(entry.decision).toBe("allow");
  });

// ---- CLI 真测 ----

function runCli(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
      cwd: join(process.cwd()),
      encoding: "utf-8",
      env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
    });
}

test("CLI：status / template / scope add+check / check 全流程", () => {
    const home = tmpHome("nyra-bughunt-cli-");
    mkdirSync(home, { recursive: true });
    const status = runCli(home, ["bughunt", "status"]);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("未安装");

    const install = runCli(home, ["bughunt", "install"]);
    expect(install.status).toBe(0);
    expect(install.stdout).toContain("已安装");
    expect(existsSync(join(home, "skills", `${BUGHUNT_SKILL_NAME}.md`))).toBe(true);

    const template = runCli(home, ["bughunt", "template", "scope"]);
    expect(template.status).toBe(0);
    expect(validateScopeCard(JSON.parse(template.stdout))).toEqual([]);

    const scopeFile = join(home, "scope.json");
    writeFileSync(scopeFile, scopeCardTemplate(), "utf-8");
    const add = runCli(home, ["bughunt", "scope", "add", scopeFile]);
    expect(add.status).toBe(0);
    expect(add.stdout).toContain("已建范围卡 cm-com");

    const inScope = runCli(home, ["bughunt", "scope", "check", "https://ticket.example.com/order/1"]);
    expect(inScope.status).toBe(0);
    expect(inScope.stdout).toContain("在范围内");
    const outScope = runCli(home, ["bughunt", "scope", "check", "https://other.example.com/"]);
    expect(outScope.status).toBe(3);
    expect(outScope.stdout).toContain("不在范围内");

    const findingFile = join(home, "finding.json");
    const finding = JSON.parse(findingTemplate()) as Record<string, unknown>;
    finding.report_text = goodReport();
    writeFileSync(findingFile, JSON.stringify(finding), "utf-8");
    const check = runCli(home, ["bughunt", "check", "--finding", findingFile]);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("可提交");
    expect(check.stdout).toContain("审查层：已跳过");
    expect(existsSync(bughuntAuditPath(home))).toBe(true);

    const badFinding = JSON.parse(findingTemplate()) as Record<string, unknown>;
    (badFinding.seven as Record<string, string>).q7 = "no";
    badFinding.report_text = goodReport();
    const badFile = join(home, "finding-bad.json");
    writeFileSync(badFile, JSON.stringify(badFinding), "utf-8");
    const blocked = runCli(home, ["bughunt", "check", "--finding", badFile]);
    expect(blocked.status).toBe(3);
    expect(blocked.stdout).toContain("拦截");
    expect(blocked.stdout).toContain("q7");
  });

test("CLI：bughunt 进 --help 与子命令表", () => {
    const home = tmpHome("nyra-bughunt-help-");
    const help = runCli(home, ["--help"]);
    expect(help.stdout).toContain("nyra bughunt");
  });
