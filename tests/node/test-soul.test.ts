// tests/node/test-soul.test.ts — 缺口 28：Soul 身份层。
// 全部用临时 home，不连真实服务、不花真实 token、不碰真模型。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SOUL_AUDIT_FILE,
  addTenet,
  appendSoulAudit,
  buildSoulSection,
  compileSoulDenyRules,
  defaultSoul,
  handleSoul,
  listSoulAgents,
  loadSoul,
  parseSoulFile,
  rebuildSoulMemoryIndex,
  removeTenet,
  resolveSoulAgentId,
  reviewSoulInvariant,
  saveSoul,
  setTenetEnabled,
  soulExists,
  soulFilePath,
  soulInvariantBlock,
  updateSoulIdentity,
  updateTenet,
  validateSoulAgentId,
} from "../../src/soul.ts";
import { buildTenetIndex, findTenetById } from "../../src/memory.ts";
import { compileDenyRules } from "../../src/permissionRules.ts";
import { reviewToolCall } from "../../src/reviewer.ts";
import { checkApproval, newToolContext, resetPermissionRulesCache } from "../../src/tools.ts";
import { saveConfig } from "../../src/config.ts";
import { Agent } from "../../src/agent.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { expectPerms } from "./fsPerms.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readAudit(home: string): Record<string, unknown>[] {
  const p = join(home, SOUL_AUDIT_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

class FakeProvider {
  name = "fake"; model = "fake-1"; baseUrl = "https://fake.invalid";
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return ["fake-1"]; }
  async chat(_messages: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    return { choices: [{ message: { content: "ok", tool_calls: [] } }] };
  }
}

// ---- 解析与默认值 ----

test("SoulTest.test_resolve_agent_id", () => {
  expect(resolveSoulAgentId(null)).toBe("default");
  expect(resolveSoulAgentId({ soul: { agent: "helper" } })).toBe("helper");
  expect(resolveSoulAgentId({ soul: { agent: "Bad Name!" } })).toBe("default");
  expect(resolveSoulAgentId(null, { NYRA_SOUL_AGENT: "bot-a" })).toBe("bot-a");
  expect(resolveSoulAgentId(null, { NYRA_SOUL_AGENT: "BAD" })).toBe("default");
  expect(resolveSoulAgentId({ soul: { agent: "from-config" } }, { NYRA_SOUL_AGENT: "from-env" })).toBe("from-config");
});

test("SoulTest.test_validate_agent_id", () => {
  expect(() => validateSoulAgentId("default")).not.toThrow();
  expect(() => validateSoulAgentId("a")).not.toThrow();
  expect(() => validateSoulAgentId("bot-1_x")).not.toThrow();
  expect(() => validateSoulAgentId("Bad")).toThrow(/agent 名/);
  expect(() => validateSoulAgentId("")).toThrow(/agent 名/);
  expect(() => validateSoulAgentId("../x")).toThrow(/agent 名/);
  expect(() => validateSoulAgentId("a".repeat(33))).toThrow(/agent 名/);
});

test("SoulTest.test_default_soul", () => {
  const soul = defaultSoul("default");
  expect(soul.version).toBe(1);
  expect(soul.agent).toBe("default");
  expect(soul.identity.name).toBe("Nyra");
  expect(soul.tenets).toHaveLength(0);
  expect(soul.memory_index.files).toHaveLength(0);
});

test("SoulTest.test_load_missing_returns_default_without_writing", () => {
  const home = tmpHome("nyra-soul-missing-");
  expect(soulExists(home, "default")).toBe(false);
  const soul = loadSoul(home, "default");
  expect(soul.tenets).toHaveLength(0);
  expect(soulExists(home, "default")).toBe(false);
  expect(existsSync(join(home, "souls"))).toBe(false);
});

// ---- Tenet 增删改 ----

test("SoulTest.test_add_tenet_validation", () => {
  const home = tmpHome("nyra-soul-add-");
  // invariant 必须带 deny，prior 不能带 deny。
  expect(() => addTenet(home, "default", { kind: "invariant", text: "绝不删文件", deny: [] })).toThrow(/至少要有一条/);
  expect(() => addTenet(home, "default", { kind: "prior", text: "喜欢简洁", deny: ["shell(rm *)"] })).toThrow(/不能带 deny/);
  expect(() => addTenet(home, "default", { kind: "invariant", text: "绝不删文件", deny: ["不是规则((("] })).toThrow(/无法解析/);
  expect(() => addTenet(home, "default", { kind: "invariant", text: "   ", deny: ["shell(rm *)"] })).toThrow(/正文不能为空/);
  const tenet = addTenet(home, "default", { kind: "invariant", text: "绝不删文件", deny: ["shell(rm *)"], sourceSession: "sess-1" });
  expect(tenet.id).toMatch(/^ten_[0-9a-f]{12}$/);
  expect(tenet.enabled).toBe(true);
  expect(tenet.source_session).toBe("sess-1");
  expect(loadSoul(home, "default").tenets).toHaveLength(1);
  // 文件落盘 0600，目录 0700。
  expectPerms(soulFilePath(home, "default"), 0o600);
  expectPerms(join(home, "souls"), 0o700);
});

test("SoulTest.test_remove_update_toggle", () => {
  const home = tmpHome("nyra-soul-crud-");
  const inv = addTenet(home, "default", { kind: "invariant", text: "绝不删文件", deny: ["shell(rm *)"] });
  const prior = addTenet(home, "default", { kind: "prior", text: "回答要简短" });
  expect(loadSoul(home, "default").tenets).toHaveLength(2);
  const updated = updateTenet(home, "default", inv.id, { text: "绝不删任何文件" });
  expect(updated.text).toBe("绝不删任何文件");
  expect(() => updateTenet(home, "default", prior.id, { deny: ["shell(rm *)"] })).toThrow(/不能带 deny/);
  expect(() => updateTenet(home, "default", inv.id, { deny: [] })).toThrow(/至少要有一条/);
  const disabled = setTenetEnabled(home, "default", inv.id, false);
  expect(disabled.enabled).toBe(false);
  setTenetEnabled(home, "default", inv.id, true);
  const { removed, remaining } = removeTenet(home, "default", prior.id);
  expect(removed.id).toBe(prior.id);
  expect(remaining).toBe(1);
  expect(() => removeTenet(home, "default", "ten_000000000000")).toThrow(/找不到 Tenet/);
});

test("SoulTest.test_corrupt_soul_backed_up_and_throws", () => {
  const home = tmpHome("nyra-soul-corrupt-");
  addTenet(home, "default", { kind: "prior", text: "喜欢简洁" });
  writeFileSync(soulFilePath(home, "default"), "{ 不是 json", "utf-8");
  expect(() => loadSoul(home, "default")).toThrow(/损坏/);
  const backups = readdirSync(join(home, "souls")).filter((f) => f.includes(".corrupt-"));
  expect(backups).toHaveLength(1);
  // 结构不对（invariant 没 deny）同样备份再抛。
  writeFileSync(soulFilePath(home, "default"), JSON.stringify({
    version: 1, agent: "default",
    identity: { name: "Nyra", persona: "", goal: "" },
    tenets: [{ id: "ten_0123456789ab", kind: "invariant", text: "坏的", deny: [], source_session: null, created_at: "", enabled: true }],
    memory_index: { files: [] },
  }), "utf-8");
  expect(() => loadSoul(home, "default")).toThrow(/至少要有一条/);
});

test("SoulTest.test_parse_soul_file_rejects_bad_shapes", () => {
  const base = {
    version: 1, agent: "default",
    identity: { name: "Nyra", persona: "", goal: "" },
    tenets: [], memory_index: { files: [] },
  };
  expect(() => parseSoulFile({ ...base, version: 2 })).toThrow(/版本只认 1/);
  expect(() => parseSoulFile({ ...base, agent: "Bad" })).toThrow(/agent 名/);
  expect(() => parseSoulFile({ ...base, tenets: [{ id: "bad", kind: "prior", text: "x", deny: [], source_session: null, created_at: "", enabled: true }] })).toThrow(/id 格式/);
  expect(() => parseSoulFile({ ...base, tenets: [
    { id: "ten_0123456789ab", kind: "prior", text: "x", deny: [], source_session: null, created_at: "", enabled: true },
    { id: "ten_0123456789ab", kind: "prior", text: "y", deny: [], source_session: null, created_at: "", enabled: true },
  ] })).toThrow(/重复/);
  expect(parseSoulFile(base).agent).toBe("default");
});

// ---- 编译进规则层 ----

test("SoulTest.test_compile_deny_rules_pure", () => {
  const { rules, warnings } = compileDenyRules(["shell(rm *)", "不是规则(((", "write_file(**/.env)"]);
  expect(rules.deny).toHaveLength(2);
  expect(warnings).toHaveLength(1);
});

test("SoulTest.test_compile_soul_deny_rules_only_enabled_invariants", () => {
  const home = tmpHome("nyra-soul-compile-");
  const inv = addTenet(home, "default", { kind: "invariant", text: "绝不删文件", deny: ["shell(rm *)"] });
  addTenet(home, "default", { kind: "prior", text: "喜欢简洁" });
  setTenetEnabled(home, "default", inv.id, false);
  const soul = loadSoul(home, "default");
  // 关掉的不变量不编译。
  expect(compileSoulDenyRules(soul).rules.deny).toHaveLength(0);
  setTenetEnabled(home, "default", inv.id, true);
  const compiled = compileSoulDenyRules(loadSoul(home, "default"));
  expect(compiled.rules.deny).toHaveLength(1);
  expect(compiled.rules.deny[0].raw).toBe("shell(rm *)");
  expect(compiled.warnings).toHaveLength(0);
});

test("SoulTest.test_soul_invariant_block", () => {
  const home = tmpHome("nyra-soul-block-");
  addTenet(home, "default", { kind: "invariant", text: "绝不删文件", deny: ["shell(rm *)"] });
  addTenet(home, "default", { kind: "prior", text: "喜欢简洁" });
  const block = soulInvariantBlock(home, "default", "shell", "rm -rf /tmp/x");
  expect(block).not.toBeNull();
  expect(block!.rule).toBe("shell(rm *)");
  expect(block!.reason).toContain("绝不删文件");
  expect(soulInvariantBlock(home, "default", "shell", "git status")).toBeNull();
  expect(soulInvariantBlock(home, "default", "read_file", "/tmp/x")).toBeNull();
  expect(soulInvariantBlock(null, "default", "shell", "rm -rf /")).toBeNull();
  // 没有 Soul 文件 = 没有 invariant = 不拦。
  expect(soulInvariantBlock(tmpHome("nyra-soul-nofile-"), "default", "shell", "rm -rf /")).toBeNull();
});

test("SoulTest.test_soul_invariant_block_corrupt_fail_closed", () => {
  const home = tmpHome("nyra-soul-block-corrupt-");
  addTenet(home, "default", { kind: "prior", text: "喜欢简洁" });
  writeFileSync(soulFilePath(home, "default"), "{ 坏了", "utf-8");
  const block = soulInvariantBlock(home, "default", "shell", "git status");
  expect(block).not.toBeNull();
  expect(block!.reason).toContain("fail-closed");
});

test("SoulTest.test_review_soul_invariant", () => {
  const home = tmpHome("nyra-soul-review-");
  addTenet(home, "default", { kind: "invariant", text: "绝不删文件", deny: ["shell(rm *)"] });
  const blocked = reviewSoulInvariant({ home, agentId: "default", tool: "shell", target: "rm -rf /" });
  expect(blocked.decision).toBe("BLOCK");
  expect(blocked.rule).toBe("soul-invariant");
  expect(blocked.source).toBe("deterministic");
  const allowed = reviewSoulInvariant({ home, agentId: "default", tool: "shell", target: "git status" });
  expect(allowed.decision).toBe("ALLOW");
});

// ---- checkApproval 与 reviewer：Soul 在自定义规则之前、模型审查之前 ----

test("SoulTest.test_check_approval_soul_beats_allow_rule", async () => {
  const home = tmpHome("nyra-soul-approval-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-soul-work-"));
  addTenet(home, "default", { kind: "invariant", text: "绝不删文件", deny: ["shell(rm *)"] });
  // 用户自定义规则显式 allow 同一条命令——Soul 照样拦。
  saveConfig(home, { permissions: { allow: ["shell(rm *)"] } });
  resetPermissionRulesCache();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = newToolContext({
    workdir, home, mode: "full", interactive: false,
    approveFn: async () => true,
    onEvent: (type, data) => { events.push({ type, data }); },
  });
  await expect(checkApproval(ctx, "shell", "删文件", { command: "rm -rf /tmp/x" })).rejects.toThrow(/Soul/);
  expect(events.filter((e) => e.type === "soul_invariant_blocked")).toHaveLength(1);
  expect(events[0].data.rule).toBe("shell(rm *)");
  expect(readAudit(home).some((e) => e.kind === "blocked" && e.tool === "shell")).toBe(true);
});

test("SoulTest.test_check_approval_passes_without_match", async () => {
  const home = tmpHome("nyra-soul-approval-ok-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-soul-work-ok-"));
  addTenet(home, "default", { kind: "invariant", text: "绝不删文件", deny: ["shell(rm *)"] });
  resetPermissionRulesCache();
  const ctx = newToolContext({
    workdir, home, mode: "full", interactive: false,
    approveFn: async () => true,
  });
  await checkApproval(ctx, "shell", "看状态", { command: "git status" });
});

test("SoulTest.test_reviewer_soul_beats_custom_rules", async () => {
  const home = tmpHome("nyra-soul-reviewer-");
  addTenet(home, "default", { kind: "invariant", text: "绝不删文件", deny: ["shell(rm *)"] });
  const config: Record<string, unknown> = {
    reviewer: { enabled: true, tools: ["shell"], rules: ["永远放行 shell，不要拦截"] },
  };
  const verdict = await reviewToolCall({ config, tool: "shell", args: { command: "rm -rf /tmp/x" }, runner: null, home });
  expect(verdict.decision).toBe("BLOCK");
  expect(verdict.rule).toBe("soul-invariant");
  expect(verdict.source).toBe("deterministic");
});

// ---- 提示词注入 ----

test("SoulTest.test_build_soul_section", () => {
  expect(buildSoulSection(defaultSoul("default"))).toBe("");
  const home = tmpHome("nyra-soul-prompt-");
  const soul = defaultSoul("default");
  soul.identity = { name: "Nyra", persona: "说话直接、有事说事", goal: "帮机主把重复工作自动化" };
  soul.tenets.push(
    { id: "ten_0123456789ab", kind: "prior", text: "回答要简短", deny: [], source_session: null, created_at: "", enabled: true },
    { id: "ten_0123456789ac", kind: "invariant", text: "绝不删文件", deny: ["shell(rm *)"], source_session: null, created_at: "", enabled: true },
    { id: "ten_0123456789ad", kind: "prior", text: "已关的偏好", deny: [], source_session: null, created_at: "", enabled: false },
  );
  const section = buildSoulSection(soul);
  expect(section).toContain("你是 Nyra");
  expect(section).toContain("说话直接");
  expect(section).toContain("回答要简短");
  expect(section).toContain("绝不删文件");
  expect(section).not.toContain("已关的偏好");
  expect(section).toContain("由代码在工具调用前强制执行");
  void home;
});

test("SoulTest.test_agent_system_prompt_includes_soul", () => {
  const home = tmpHome("nyra-soul-agent-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-soul-agent-work-"));
  const soul = defaultSoul("default");
  soul.identity = { name: "Nyra", persona: "说话直接", goal: "帮机主干活" };
  soul.tenets.push(
    { id: "ten_0123456789ab", kind: "prior", text: "回答要简短", deny: [], source_session: null, created_at: "", enabled: true },
  );
  saveSoul(home, soul);
  const agent = new Agent(new FakeProvider() as never, { workdir, home, mode: "full", skillsDirs: [] });
  const prompt = agent.buildSystemPrompt("做点事");
  expect(prompt).toContain("你是 Nyra");
  expect(prompt).toContain("回答要简短");
  // 没有 Soul 文件的 agent：提示词里没有 Soul 段。
  const home2 = tmpHome("nyra-soul-agent2-");
  const agent2 = new Agent(new FakeProvider() as never, { workdir, home: home2, mode: "full", skillsDirs: [] });
  expect(agent2.buildSystemPrompt("做点事")).not.toContain("## Soul");
});

// ---- 记忆索引与 Tenet 索引 ----

test("SoulTest.test_rebuild_memory_index", () => {
  const home = tmpHome("nyra-soul-memidx-");
  writeFileSync(join(home, "MEMORY.md"), "- [2026-11-21 04:00] 喜欢简洁\n- [2026-11-21 04:01] 绝不删文件\n\n", "utf-8");
  const soul = rebuildSoulMemoryIndex(home, "default");
  expect(soul.memory_index.files).toHaveLength(1);
  expect(soul.memory_index.files[0].path).toBe("MEMORY.md");
  expect(soul.memory_index.files[0].entries).toBe(2);
  expect(soul.memory_index.files[0].path).not.toContain(home);
  // 第二次重建内容不变时不重写文件（updated_at 不动）。
  const before = readFileSync(soulFilePath(home, "default"), "utf-8");
  rebuildSoulMemoryIndex(home, "default");
  expect(readFileSync(soulFilePath(home, "default"), "utf-8")).toBe(before);
});

test("SoulTest.test_tenet_index_across_souls", () => {
  const home = tmpHome("nyra-soul-idx-");
  const a = addTenet(home, "default", { kind: "invariant", text: "绝不删文件", deny: ["shell(rm *)"] });
  const b = addTenet(home, "helper", { kind: "prior", text: "回答简短" });
  expect(listSoulAgents(home)).toEqual(["default", "helper"]);
  const index = buildTenetIndex(home);
  expect(index).toHaveLength(2);
  expect(findTenetById(home, a.id)).toEqual({ agent: "default", tenet: expect.objectContaining({ id: a.id }) });
  expect(findTenetById(home, b.id)?.agent).toBe("helper");
  expect(findTenetById(home, "ten_000000000000")).toBeNull();
  // 损坏的 Soul 跳过，不拦整张索引。
  writeFileSync(soulFilePath(home, "helper"), "{ 坏了", "utf-8");
  expect(buildTenetIndex(home)).toHaveLength(1);
});

test("SoulTest.test_update_identity", () => {
  const home = tmpHome("nyra-soul-ident-");
  const soul = updateSoulIdentity(home, "default", { name: "阿尼", persona: "温和" });
  expect(soul.identity.name).toBe("阿尼");
  expect(soul.identity.persona).toBe("温和");
  expect(soul.identity.goal).toBe("");
  expect(loadSoul(home, "default").identity.name).toBe("阿尼");
});

// ---- CLI ----

test("SoulTest.test_cli_init_show_status_list", async () => {
  const home = tmpHome("nyra-soul-cli-");
  expect(await handleSoul(["status"], home)).toBe(0);
  expect(await handleSoul(["list"], home)).toBe(0);
  expect(await handleSoul(["show"], home)).toBe(0);
  expect(await handleSoul(["init", "default", "--name", "Nyra", "--persona", "直接"], home)).toBe(0);
  expect(soulExists(home, "default")).toBe(true);
  expect(await handleSoul(["init", "default"], home)).toBe(0);
  expect(await handleSoul(["status"], home)).toBe(0);
  expect(await handleSoul(["bogus"], home)).toBe(2);
  expect(await handleSoul(["show", "Bad Name"], home)).toBe(1);
});

test("SoulTest.test_cli_add_remove_enable_disable_edit", async () => {
  const home = tmpHome("nyra-soul-cli2-");
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const input = { onEvent: (type: string, data: Record<string, unknown>) => { events.push({ type, data }); } };
  expect(await handleSoul(["add", "--kind", "invariant", "--text", "绝不删文件", "--deny", "shell(rm *)", "--yes"], home, input)).toBe(0);
  expect(await handleSoul(["add", "--kind", "prior", "--text", "回答简短", "--yes"], home, input)).toBe(0);
  // 用法错误：invariant 没 deny、prior 带 deny、缺 text。
  expect(await handleSoul(["add", "--kind", "invariant", "--text", "x", "--yes"], home, input)).toBe(2);
  expect(await handleSoul(["add", "--kind", "prior", "--text", "x", "--deny", "shell(rm *)", "--yes"], home, input)).toBe(2);
  expect(await handleSoul(["add", "--kind", "prior", "--yes"], home, input)).toBe(2);
  const soul = loadSoul(home, "default");
  expect(soul.tenets).toHaveLength(2);
  const invId = soul.tenets[0].id;
  const priorId = soul.tenets[1].id;
  expect(events.filter((e) => e.type === "soul_tenet_added")).toHaveLength(2);
  expect(await handleSoul(["disable", invId], home, input)).toBe(0);
  expect(loadSoul(home, "default").tenets[0].enabled).toBe(false);
  expect(await handleSoul(["enable", invId], home, input)).toBe(0);
  expect(await handleSoul(["edit", invId, "--text", "绝不删任何文件", "--yes"], home, input)).toBe(0);
  expect(loadSoul(home, "default").tenets[0].text).toBe("绝不删任何文件");
  expect(await handleSoul(["remove", priorId, "--yes"], home, input)).toBe(0);
  expect(loadSoul(home, "default").tenets).toHaveLength(1);
  const removedEvents = events.filter((e) => e.type === "soul_tenet_removed");
  expect(removedEvents).toHaveLength(1);
  expect(removedEvents[0].data.remaining).toBe(1);
  // 审计记了增删改（谁批准的、动了哪条、动完剩几条），证据也落盘了。
  const audit = readAudit(home);
  expect(audit.filter((e) => e.kind === "added")).toHaveLength(2);
  expect(audit.filter((e) => e.kind === "removed")).toHaveLength(1);
  expect(audit.every((e) => e.agent === "default")).toBe(true);
  expect(existsSync(join(home, "evidence", "soul"))).toBe(true);
  // 找不到的 id 报错不崩。
  expect(await handleSoul(["remove", "ten_000000000000", "--yes"], home, input)).toBe(1);
  expect(await handleSoul(["enable", "ten_000000000000"], home, input)).toBe(1);
});

test("SoulTest.test_cli_export_import", async () => {
  const home = tmpHome("nyra-soul-cli3-");
  const out = join(home, "exported.json");
  addTenet(home, "default", { kind: "invariant", text: "绝不删文件", deny: ["shell(rm *)"] });
  expect(await handleSoul(["export", "default", "--out", out], home)).toBe(0);
  expectPerms(out, 0o600);
  const home2 = tmpHome("nyra-soul-cli4-");
  expect(await handleSoul(["import", out, "--yes"], home2)).toBe(0);
  const imported = loadSoul(home2, "default");
  expect(imported.tenets).toHaveLength(1);
  expect(imported.tenets[0].text).toBe("绝不删文件");
  // 坏文件导入失败不崩。
  const bad = join(home, "bad.json");
  writeFileSync(bad, "{ 坏了", "utf-8");
  expect(await handleSoul(["import", bad, "--yes"], home2)).toBe(1);
  expect(await handleSoul(["import"], home2)).toBe(2);
});

// ---- 事件与时间线 ----

test("SoulTest.test_events_and_timeline", () => {
  const home = tmpHome("nyra-soul-tl-");
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  const runId = state.run_id;
  store.appendEvent(runId, "soul_tenet_added", { agent: "default", tenet_id: "ten_0123456789ab", kind: "invariant" });
  store.appendEvent(runId, "soul_tenet_removed", { agent: "default", tenet_id: "ten_0123456789ab", remaining: 1 });
  store.appendEvent(runId, "soul_tenet_changed", { agent: "default", tenet_id: "ten_0123456789ab", change: "disabled" });
  store.appendEvent(runId, "soul_invariant_blocked", { agent: "default", tenet_id: "ten_0123456789ab", tool: "shell", rule: "shell(rm *)" });
  const tl = buildTimeline(store, runId);
  const text = formatTimelineText(tl);
  expect(text).toContain("Soul default 加了一条不变量");
  expect(text).toContain("Soul default 删了一条 Tenet");
  expect(text).toContain("Soul default 的 Tenet 关闭");
  expect(text).toContain("Soul invariant 拦截");
  expect(text).toContain("shell(rm *)");
  // 事件里没有绝对路径。
  const raw = readFileSync(join(home, "runs", runId, "events.jsonl"), "utf-8");
  expect(raw).not.toContain(home);
});

test("SoulTest.test_append_audit", () => {
  const home = tmpHome("nyra-soul-audit-");
  appendSoulAudit(home, { kind: "added", agent: "default", tenet_id: "ten_0123456789ab" });
  const audit = readAudit(home);
  expect(audit).toHaveLength(1);
  expect(audit[0].tenet_id).toBe("ten_0123456789ab");
});
