// tests/node/test-skill-sedimentation.test.ts — 技能自沉淀闭环（缺口 11）专项：
// 配置解析、起草资格与质量分、低质自动归档、批准/拒绝/归档、用量账本与 sweep、
// 自动起草钩子（RunRecorder 收尾）、CLI。全部 mock-only，不连真实服务、不调模型。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  skillSedimentationConfig, slugFromTask, uniqueDraftName, scoreDraft,
  draftSkillFromRun, maybeAutoDraft, approveDraft, rejectDraft, archiveDraft,
  listDrafts, findDraft, sweepStaleSkills, skillDraftsDir,
  DRAFT_QUALITY_ARCHIVE_BELOW,
} from "../../src/skillDrafts.ts";
import { recordSkillUse, loadSkillUsage } from "../../src/skillUsage.ts";
import { parseSkillText } from "../../src/skills.ts";
import { RunStore, RunRecorder } from "../../src/runs.ts";
import { Agent } from "../../src/agent.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 造一条运行记录：状态 + 若干工具调用事件 + 改动文件。 */
function makeRun(home: string, opts: {
    task: string; status: string;
    toolCalls: { name: string; ok: boolean }[];
    changedFiles?: string[]; verifyCmd?: string | null;
  }): { store: RunStore; runId: string } {
  const store = new RunStore(join(home, "runs"));
  const state = store.create(opts.task, "sess-test", home, "auto", 10, "running", opts.verifyCmd ?? null);
  opts.toolCalls.forEach((tc, i) => {
      store.appendEvent(state.run_id, "tool_start", { id: `c${i}`, name: tc.name, args_hash: `h${i}` });
      store.appendEvent(state.run_id, "tool_result", { id: `c${i}`, name: tc.name, ok: tc.ok, args_hash: `h${i}` });
    });
  if (opts.changedFiles?.length) store.update(state.run_id, { changed_files: opts.changedFiles });
  store.setStatus(state.run_id, opts.status);
  return { store, runId: state.run_id };
}

function okCalls(n: number, name = "write_file"): { name: string; ok: boolean }[] {
  return Array.from({ length: n }, () => ({ name, ok: true }));
}

test("SkillSedimentationTest.test_config_defaults_and_normalization", () => {
    const d = skillSedimentationConfig({});
    expect(d.enabled).toBe(false);
    expect(d.min_steps).toBe(3);
    expect(d.auto_archive_days).toBe(30);
    expect(d.require_verified).toBe(false);
    expect(DRAFT_QUALITY_ARCHIVE_BELOW).toBe(2);
    const custom = skillSedimentationConfig({
        skill_sedimentation: { enabled: true, min_steps: 5, auto_archive_days: 7, require_verified: true },
      });
    expect(custom.enabled).toBe(true);
    expect(custom.min_steps).toBe(5);
    expect(custom.auto_archive_days).toBe(7);
    expect(custom.require_verified).toBe(true);
    // 类型不对回落默认值，不抛错。
    const bad = skillSedimentationConfig({
        skill_sedimentation: { enabled: "yes", min_steps: 0, auto_archive_days: -1, require_verified: 1 },
      });
    expect(bad.enabled).toBe(false);
    expect(bad.min_steps).toBe(3);
    expect(bad.auto_archive_days).toBe(30);
    expect(bad.require_verified).toBe(false);
  });

test("SkillSedimentationTest.test_slug_from_task", () => {
    expect(slugFromTask("整理桌面文件", "20261120-120000-abcdef")).toBe("run-abcdef");
    expect(slugFromTask("Fix login bug and write tests", "20261120-120000-abcdef")).toBe("fix-login-bug-and-write");
    expect(slugFromTask("", "20261120-120000-abcdef")).toBe("run-abcdef");
  });

test("SkillSedimentationTest.test_score_draft", () => {
    const ext = { toolNames: ["write_file"], toolCalls: 5, toolFailures: 0, changedFiles: ["a.txt"], verifyPassed: true, verifyCommand: null };
    expect(scoreDraft("verified", ext).score).toBe(4);
    expect(scoreDraft("completed_unverified", { ...ext, toolCalls: 3, changedFiles: [] }).score).toBe(1);
    expect(scoreDraft("verified", { ...ext, toolCalls: 3, toolFailures: 3, changedFiles: [] }).score).toBe(0);
  });

test("SkillSedimentationTest.test_draft_from_verified_run", () => {
    const home = tmpHome("nyra-sed-");
    const { store, runId } = makeRun(home, {
        task: "Fix login bug and write tests",
        status: "verified",
        toolCalls: [...okCalls(4), { name: "shell", ok: true }],
        changedFiles: ["src/login.ts"],
        verifyCmd: "bun test",
      });
    const { draft, reason } = draftSkillFromRun(store, runId, { home, config: {} });
    expect(reason).toBe("");
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe("pending");
    expect(draft!.quality.score).toBe(4);
    expect(draft!.tool_names).toEqual(["write_file", "shell"]);
    expect(draft!.changed_files).toEqual(["src/login.ts"]);
    const draftPath = join(skillDraftsDir(home), `${draft!.name}.md`);
    expect(existsSync(draftPath)).toBe(true);
    const text = readFileSync(draftPath, "utf-8");
    expect(text).toContain(`name: ${draft!.name}`);
    expect(text).toContain(runId);
    expect(text).toContain("bun test");
    // 账本与证据链事件。
    expect(listDrafts(home).map((d) => d.name)).toContain(draft!.name);
    const events = store.readEvents(runId);
    const created = events.find((e) => e.type === "skill_draft_created");
    expect(created).toBeTruthy();
    expect(created!.draft_name).toBe(draft!.name);
    expect(created!.quality).toBe(4);
    expect(created!.status).toBe("pending");
  });

test("SkillSedimentationTest.test_draft_from_unverified_run_lower_score", () => {
    const home = tmpHome("nyra-sed-");
    // 瘦的未验证运行（3 次调用、没改文件）：质量分 1（< 2），出生即归档。
    const thin = makeRun(home, {
        task: "整理桌面文件",
        status: "completed_unverified",
        toolCalls: okCalls(3),
      });
    const thinDraft = draftSkillFromRun(thin.store, thin.runId, { home, config: {} }).draft;
    expect(thinDraft).not.toBeNull();
    expect(thinDraft!.quality.score).toBe(1);
    expect(thinDraft!.status).toBe("archived");
    // 胖的未验证运行（5 次调用、改过文件）：质量分 3，进待批准。
    const rich = makeRun(home, {
        task: "整理桌面文件",
        status: "completed_unverified",
        toolCalls: okCalls(5),
        changedFiles: ["notes.md"],
      });
    const richDraft = draftSkillFromRun(rich.store, rich.runId, { home, config: {} }).draft;
    expect(richDraft).not.toBeNull();
    expect(richDraft!.quality.score).toBe(3);
    expect(richDraft!.status).toBe("pending");
  });

test("SkillSedimentationTest.test_draft_refused_for_failed_run", () => {
    const home = tmpHome("nyra-sed-");
    const { store, runId } = makeRun(home, {
        task: "Fix login bug",
        status: "failed",
        toolCalls: okCalls(5),
      });
    const { draft, reason } = draftSkillFromRun(store, runId, { home, config: {} });
    expect(draft).toBeNull();
    expect(reason).toContain("failed");
    expect(listDrafts(home)).toEqual([]);
  });

test("SkillSedimentationTest.test_draft_refused_for_too_few_tool_calls", () => {
    const home = tmpHome("nyra-sed-");
    const { store, runId } = makeRun(home, {
        task: "Fix login bug",
        status: "verified",
        toolCalls: okCalls(2),
      });
    const { draft, reason } = draftSkillFromRun(store, runId, { home, config: {} });
    expect(draft).toBeNull();
    expect(reason).toContain("2");
  });

test("SkillSedimentationTest.test_draft_refused_when_require_verified", () => {
    const home = tmpHome("nyra-sed-");
    const { store, runId } = makeRun(home, {
        task: "Fix login bug",
        status: "completed_unverified",
        toolCalls: okCalls(5),
      });
    const { draft, reason } = draftSkillFromRun(store, runId, {
        home, config: { skill_sedimentation: { require_verified: true } },
      });
    expect(draft).toBeNull();
    expect(reason).toContain("require_verified");
  });

test("SkillSedimentationTest.test_low_quality_draft_auto_archived_at_birth", () => {
    const home = tmpHome("nyra-sed-");
    const { store, runId } = makeRun(home, {
        task: "Fix login bug",
        status: "verified",
        toolCalls: [
          { name: "shell", ok: false },
          { name: "shell", ok: false },
          { name: "shell", ok: false },
        ],
      });
    const { draft, reason } = draftSkillFromRun(store, runId, { home, config: {} });
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe("archived");
    expect(draft!.archive_reason).toContain("质量分 0");
    expect(reason).toContain("自动归档");
    expect(listDrafts(home)[0].status).toBe("archived");
    const created = store.readEvents(runId).find((e) => e.type === "skill_draft_created");
    expect(created!.status).toBe("archived");
  });

test("SkillSedimentationTest.test_duplicate_name_gets_suffix", () => {
    const home = tmpHome("nyra-sed-");
    const a = makeRun(home, { task: "Fix login bug", status: "verified", toolCalls: okCalls(3) });
    const b = makeRun(home, { task: "Fix login bug", status: "verified", toolCalls: okCalls(3) });
    const d1 = draftSkillFromRun(a.store, a.runId, { home, config: {} }).draft!;
    const d2 = draftSkillFromRun(b.store, b.runId, { home, config: {} }).draft!;
    expect(d1.name).toBe("fix-login-bug");
    expect(d2.name).toBe("fix-login-bug-2");
    expect(uniqueDraftName(home, home, "fix-login-bug")).toBe("fix-login-bug-3");
  });

test("SkillSedimentationTest.test_task_text_cannot_inject_frontmatter", () => {
    const home = tmpHome("nyra-sed-");
    const { store, runId } = makeRun(home, {
        task: "Fix login bug\nname: hacked\nkeywords: hacked",
        status: "verified",
        toolCalls: okCalls(3),
      });
    const { draft } = draftSkillFromRun(store, runId, { home, config: {} });
    expect(draft).not.toBeNull();
    const text = readFileSync(join(skillDraftsDir(home), `${draft!.name}.md`), "utf-8");
    // 任务文本里的换行已被清洗：正文引用任务原文时 "keywords: hacked" 会出现在
    // 行中（那是引用，不是 frontmatter），但绝不能出现在行首成为新的 frontmatter 键。
    expect(text).not.toContain("\nname: hacked");
    expect(text).not.toContain("\nkeywords: hacked");
    // 解析为准：frontmatter 的 name 是草稿名、keywords 里没有 hacked。
    const parsed = parseSkillText(text, "draft");
    expect(parsed.name).toBe(draft!.name);
    expect(parsed.keywords).not.toContain("hacked");
  });

test("SkillSedimentationTest.test_approve_installs_and_rejects_second_approve", () => {
    const home = tmpHome("nyra-sed-");
    const { store, runId } = makeRun(home, {
        task: "Fix login bug and write tests",
        status: "verified",
        toolCalls: okCalls(5),
        changedFiles: ["src/login.ts"],
      });
    const { draft } = draftSkillFromRun(store, runId, { home, config: {} });
    const { installedPath } = approveDraft(home, draft!.name, store);
    expect(existsSync(installedPath)).toBe(true);
    expect(installedPath).toBe(join(home, "skills", `${draft!.name}.md`));
    const installed = readFileSync(installedPath, "utf-8");
    expect(installed).toContain(`name: ${draft!.name}`);
    expect(findDraft(home, draft!.name)!.status).toBe("installed");
    const approved = store.readEvents(runId).find((e) => e.type === "skill_draft_approved");
    expect(approved).toBeTruthy();
    expect(approved!.draft_name).toBe(draft!.name);
    expect(approved!.run_id).toBe(runId);
    // 安装路径只在账本里，不进事件（绝对路径过 redact 会被掩掉）。
    expect("installed_path" in (approved as Record<string, unknown>)).toBe(false);
    expect(findDraft(home, draft!.name)!.installed_path).toBe(installedPath);
    expect(() => approveDraft(home, draft!.name, store)).toThrow("只有 pending 的草稿能批准");
  });

test("SkillSedimentationTest.test_approve_refuses_name_collision", () => {
    const home = tmpHome("nyra-sed-");
    const { store, runId } = makeRun(home, {
        task: "Fix login bug",
        status: "verified",
        toolCalls: okCalls(3),
      });
    const { draft } = draftSkillFromRun(store, runId, { home, config: {} });
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(join(home, "skills", `${draft!.name}.md`), "---\nname: fix-login-bug\ndescription: 旧技能\nwhen: 以前\nkeywords: x\n---\n旧做法。\n", "utf-8");
    expect(() => approveDraft(home, draft!.name, store)).toThrow("拒绝覆盖");
    expect(findDraft(home, draft!.name)!.status).toBe("pending");
  });

test("SkillSedimentationTest.test_reject_and_archive_draft", () => {
    const home = tmpHome("nyra-sed-");
    const r1 = makeRun(home, { task: "Fix login bug", status: "verified", toolCalls: okCalls(3) });
    const r2 = makeRun(home, { task: "Clean temp files", status: "verified", toolCalls: okCalls(3) });
    const d1 = draftSkillFromRun(r1.store, r1.runId, { home, config: {} }).draft!;
    const d2 = draftSkillFromRun(r2.store, r2.runId, { home, config: {} }).draft!;
    const rejected = rejectDraft(home, d1.name, r1.store);
    expect(rejected.status).toBe("rejected");
    expect(r1.store.readEvents(r1.runId).some((e) => e.type === "skill_draft_rejected")).toBe(true);
    expect(() => rejectDraft(home, d1.name, r1.store)).toThrow("只有 pending 的草稿能拒绝");
    const archived = archiveDraft(home, d2.name, "没价值", r2.store);
    expect(archived.status).toBe("archived");
    expect(archived.archive_reason).toBe("没价值");
    expect(r2.store.readEvents(r2.runId).some((e) => e.type === "skill_archived")).toBe(true);
    expect(() => archiveDraft(home, d2.name, "再归档", r2.store)).toThrow("不能归档");
    expect(() => approveDraft(home, "no-such-draft", r1.store)).toThrow("没有名为");
  });

test("SkillSedimentationTest.test_skill_usage_ledger", () => {
    const home = tmpHome("nyra-sed-");
    expect(loadSkillUsage(home)).toEqual({});
    const e1 = recordSkillUse(home, "todo-scan");
    expect(e1.uses).toBe(1);
    expect(typeof e1.last_used_at).toBe("string");
    const e2 = recordSkillUse(home, "todo-scan");
    expect(e2.uses).toBe(2);
    expect(loadSkillUsage(home)["todo-scan"].uses).toBe(2);
    // 损坏的账本读作空，不抛错。
    writeFileSync(join(home, "skill-usage.json"), "{bad json", "utf-8");
    expect(loadSkillUsage(home)).toEqual({});
    expect(() => recordSkillUse(home, "")).toThrow("技能名不能为空");
  });

test("SkillSedimentationTest.test_sweep_archives_stale_and_keeps_fresh", () => {
    const home = tmpHome("nyra-sed-");
    const skillsDir = join(home, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const oldSkill = "---\nname: old-skill\ndescription: 老技能\nwhen: 以前\nkeywords: old\n---\n老做法。\n";
    const freshSkill = "---\nname: fresh-skill\ndescription: 新技能\nwhen: 现在\nkeywords: fresh\n---\n新做法。\n";
    writeFileSync(join(skillsDir, "old-skill.md"), oldSkill, "utf-8");
    writeFileSync(join(skillsDir, "fresh-skill.md"), freshSkill, "utf-8");
    // 老技能：40 天没动过；新技能：刚装。
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(join(skillsDir, "old-skill.md"), fortyDaysAgo, fortyDaysAgo);
    // 演练不动文件。
    const dry = sweepStaleSkills(home, { dryRun: true });
    expect(dry.archived.map((a) => a.name)).toEqual(["old-skill"]);
    expect(dry.kept).toBe(1);
    expect(existsSync(join(skillsDir, "old-skill.md"))).toBe(true);
    // 真扫：老技能移进归档，审计行留痕。
    const real = sweepStaleSkills(home, {});
    expect(real.archived.map((a) => a.name)).toEqual(["old-skill"]);
    expect(existsSync(join(skillsDir, "old-skill.md"))).toBe(false);
    expect(existsSync(join(home, "skills-archive", "old-skill.md"))).toBe(true);
    const log = readFileSync(join(home, "skills-archive.jsonl"), "utf-8");
    expect(log).toContain("old-skill");
    expect(log).toContain("30 天");
    expect(existsSync(join(skillsDir, "fresh-skill.md"))).toBe(true);
    // 再扫一次：无事可做。
    const again = sweepStaleSkills(home, {});
    expect(again.archived).toEqual([]);
    expect(again.kept).toBe(1);
  });

test("SkillSedimentationTest.test_sweep_uses_usage_ledger_over_mtime", () => {
    const home = tmpHome("nyra-sed-");
    const skillsDir = join(home, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "used-skill.md"), "---\nname: used-skill\ndescription: 在用\nwhen: 现在\nkeywords: used\n---\n做法。\n", "utf-8");
    // 文件本身 40 天没动，但用量账本说昨天刚用过 → 不归档。
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(join(skillsDir, "used-skill.md"), fortyDaysAgo, fortyDaysAgo);
    recordSkillUse(home, "used-skill", new Date(Date.now() - 24 * 60 * 60 * 1000));
    const result = sweepStaleSkills(home, {});
    expect(result.archived).toEqual([]);
    expect(result.kept).toBe(1);
    // 账本说 40 天前用过 → 归档。
    const usage = loadSkillUsage(home);
    usage["used-skill"] = { uses: 5, last_used_at: fortyDaysAgo.toISOString() };
    writeFileSync(join(home, "skill-usage.json"), JSON.stringify(usage), "utf-8");
    const result2 = sweepStaleSkills(home, {});
    expect(result2.archived.map((a) => a.name)).toEqual(["used-skill"]);
  });

test("SkillSedimentationTest.test_maybe_auto_draft_respects_enabled_flag", () => {
    const home = tmpHome("nyra-sed-");
    const { store, runId } = makeRun(home, {
        task: "Fix login bug",
        status: "verified",
        toolCalls: okCalls(4),
      });
    expect(maybeAutoDraft(home, {}, store, runId)).toBeNull();
    expect(listDrafts(home)).toEqual([]);
    const draft = maybeAutoDraft(home, { skill_sedimentation: { enabled: true } }, store, runId);
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe("pending");
    // 不存在的运行也不抛错，只返回 null。
    expect(maybeAutoDraft(home, { skill_sedimentation: { enabled: true } }, store, "20990101-000000-abcdef")).toBeNull();
  });

test("SkillSedimentationTest.test_auto_draft_hook_in_run_recorder", async () => {
    const home = tmpHome("nyra-sed-hook-");
    const workdir = join(home, "work");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ skill_sedimentation: { enabled: true } }), "utf-8");
    class FakeProvider {
      name = "fake"; model = "fake-1"; calls = 0;
      hasCredentials() { return true; }
      async chat(): Promise<Record<string, unknown>> {
        this.calls += 1;
        if (this.calls <= 3) {
          const id = `c${this.calls}`;
          return { choices: [{ message: { content: "", tool_calls: [{ id, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `f${this.calls}.txt`, content: "hi\n" }) } }] } }] };
        }
        return { choices: [{ message: { content: "done", tool_calls: [] } }] };
      }
    }
    const agent = new Agent(new FakeProvider() as never, {
        workdir, mode: "full", maxTurns: 10, sessionId: "20261120-000000-hook1",
        skillsDirs: [], home,
      });
    const store = new RunStore(join(home, "runs"));
    const rec = new RunRecorder(store, agent, "Write three files then finish", { verifyCmd: null });
    await rec.run("Write three files then finish");
    const final = store.load(rec.runId);
    expect(final.status).toBe("completed_unverified");
    const drafts = listDrafts(home);
    expect(drafts.length).toBe(1);
    expect(drafts[0].status).toBe("pending");
    expect(drafts[0].source_run_id).toBe(rec.runId);
    expect(drafts[0].tool_calls).toBe(3);
  });

test("SkillSedimentationTest.test_agent_records_skill_use_on_injection", async () => {
    const home = tmpHome("nyra-sed-use-");
    const workdir = join(home, "work");
    const skillsDir = join(home, "skills");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "test-skill.md"),
      "---\nname: test-skill\ndescription: 测试技能\nwhen: 用户说 testme\nkeywords: testme\n---\n按测试技能做事。\n", "utf-8");
    class EchoProvider {
      name = "fake"; model = "fake-1";
      hasCredentials() { return true; }
      async chat(): Promise<Record<string, unknown>> {
        return { choices: [{ message: { content: "完成。", tool_calls: [] } }] };
      }
    }
    const agent = new Agent(new EchoProvider() as never, {
        workdir, mode: "full", maxTurns: 5, sessionId: "20261120-000000-use1",
        skillsDirs: [skillsDir], home,
      });
    await agent.run("请用 testme 做点事");
    const usage = loadSkillUsage(home);
    expect(usage["test-skill"]).toBeTruthy();
    expect(usage["test-skill"].uses).toBeGreaterThanOrEqual(1);
  });

test("SkillSedimentationTest.test_cli_skills_status_enable_draft_approve", () => {
    const home = tmpHome("nyra-sed-cli-");
    const nyraHome = join(home, ".nyra");
    const run = (args: string[]) => spawnSync("bun", ["run", "src/cli.ts", ...args], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, NYRA_HOME: nyraHome, NYRA_LANG: "zh" },
        encoding: "utf-8", timeout: 60000,
      });
    const status0 = run(["skills", "status"]);
    expect(status0.status).toBe(0);
    expect((status0.stdout ?? "")).toContain("禁用");
    const enable = run(["skills", "enable"]);
    expect(enable.status).toBe(0);
    expect((enable.stdout ?? "")).toContain("已启用技能自沉淀");
    // 造一条成功运行，再走 CLI 起草 + 批准。
    const store = new RunStore(join(nyraHome, "runs"));
    const state = store.create("Fix login bug and write tests", "sess-cli", home, "auto", 10, "running", null);
    for (let i = 0; i < 4; i++) {
      store.appendEvent(state.run_id, "tool_result", { id: `c${i}`, name: "write_file", ok: true, args_hash: `h${i}` });
    }
    store.setStatus(state.run_id, "verified");
    const draft = run(["skills", "draft", state.run_id]);
    expect(draft.status).toBe(0);
    expect((draft.stdout ?? "")).toContain("已起草技能草稿");
    const drafts = listDrafts(nyraHome);
    expect(drafts.length).toBe(1);
    const name = drafts[0].name;
    const show = run(["skills", "show", name]);
    expect(show.status).toBe(0);
    expect((show.stdout ?? "")).toContain(`name: ${name}`);
    const approve = run(["skills", "approve", name]);
    expect(approve.status).toBe(0);
    expect((approve.stdout ?? "")).toContain("已批准并安装技能");
    expect(existsSync(join(nyraHome, "skills", `${name}.md`))).toBe(true);
    // 用法错误与未知子命令。
    expect(run(["skills"]).status).toBe(2);
    expect(run(["skills", "bogus-cmd"]).status).toBe(2);
    expect(run(["skills", "draft", "20990101-000000-abcdef"]).status).toBe(1);
    // 配置落盘。
    const saved = JSON.parse(readFileSync(join(nyraHome, "config.json"), "utf-8")) as Record<string, unknown>;
    expect((saved.skill_sedimentation as Record<string, unknown>).enabled).toBe(true);
  });
