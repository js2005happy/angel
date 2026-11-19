// tests/node/test-style.test.ts — 缺口 4（分应用文风学习）。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  validateChannel, parseSamples, learnStyleProfile, saveStyleProfile, loadStyleProfile,
  listStyleProfiles, deleteStyleProfile, formatStyleProfile, buildStyleSection, StyleError,
  stylePath,
} from "../../src/style.ts";
import { appendMemory } from "../../src/memory.ts";
import {
  exportSnapshot, importSnapshot, exportStylesSnapshot, importStylesSnapshot,
} from "../../src/memoryExchange.ts";
import { Agent } from "../../src/agent.ts";
import { fakeProvider } from "./fake-provider.ts";

const FORMAL_SAMPLES = [
  "您好，附件是本周的进度报告，请查收。\n谢谢",
  "您好，会议改到周三下午三点，请确认。\n谢谢",
  "您好，报销单已提交，请审批。\n谢谢",
];

const CASUAL_SAMPLES = [
  "哈哈这个好笑，明天见啦～",
  "嗯嗯收到啦，明天聊😄",
  "在吗？帮我看下这个哈哈",
];

test("Style.test_validate_channel", () => {
  expect(validateChannel("gmail")).toBe("gmail");
  expect(validateChannel("WhatsApp")).toBe("whatsapp");
  expect(validateChannel("  slack ")).toBe("slack");
  expect(() => validateChannel("Gmail")).not.toThrow();
  expect(() => validateChannel("")).toThrow(StyleError);
  expect(() => validateChannel("a b")).toThrow(StyleError);
  expect(() => validateChannel("../etc")).toThrow(StyleError);
  expect(() => validateChannel("a".repeat(33))).toThrow(StyleError);
});

test("Style.test_parse_samples", () => {
  expect(parseSamples("第一条\n\n第二条\n\n第三条")).toEqual(["第一条", "第二条", "第三条"]);
  expect(parseSamples("第一条\n第二条\n第三条")).toEqual(["第一条", "第二条", "第三条"]);
  expect(parseSamples("\n\n  \n")).toEqual([]);
  expect(parseSamples("x".repeat(3000))).toEqual(["x".repeat(2000)]);
});

test("Style.test_learn_formal_greeting_signoff", () => {
  const p = learnStyleProfile("gmail", FORMAL_SAMPLES, new Date("2026-11-20T04:00:00Z"));
  expect(p.channel).toBe("gmail");
  expect(p.tone).toBe("正式");
  expect(p.greeting).toBe("您好，");
  expect(p.signoff).toBe("谢谢");
  expect(p.length).toBe("短");
  expect(p.sample_count).toBe(3);
  expect(p.learned_at).toBe("2026-11-20T04:00:00.000Z");
  expect(p.source).toContain("未上传");
  // 画像里不含任何样本原文。
  expect(JSON.stringify(p)).not.toContain("进度报告");
});

test("Style.test_learn_casual_emoji", () => {
  const p = learnStyleProfile("whatsapp", CASUAL_SAMPLES);
  expect(p.tone).toBe("随意");
  expect(p.greeting).toBe("无固定问候，直接说事");
  expect(p.signoff).toBe("无固定落款");
  expect(p.punctuation).toContain("常用表情符号");
});

test("Style.test_learn_length_buckets", () => {
  const medium = learnStyleProfile("slack", ["这是一条中等长度的消息，大约五十个字左右，用来测试长度分档是否正确，希望它落在中的一档里面。", "第二条中等长度的消息，也是五十个字左右，用来测试长度分档是否正确，希望它落在中的一档里面。", "第三条中等长度的消息，也是五十个字左右，用来测试长度分档是否正确，希望它落在中的一档里面。"]);
  expect(medium.length).toBe("中");
  expect(medium.typical_chars).toBeGreaterThanOrEqual(40);
  const longText = "这".repeat(220);
  const long = learnStyleProfile("slack", [longText, longText + "1", longText + "2"]);
  expect(long.length).toBe("长");
  expect(long.typical_chars).toBe(221);
});

test("Style.test_learn_abbreviations", () => {
  const p = learnStyleProfile("gmail", [
    "Hi, pls check the report btw the deadline is Friday. Thanks",
    "Hi, pls review this btw I need it today. Thanks",
    "Hi, pls send me the file btw. Thanks",
  ]);
  expect(p.greeting).toBe("Hi，");
  expect(p.tone).toBe("中性");
  expect(p.abbreviations).toContain("pls");
  expect(p.abbreviations).toContain("btw");
});

test("Style.test_learn_needs_three_samples_and_caps_at_fifty", () => {
  expect(() => learnStyleProfile("gmail", ["一条", "两条"])).toThrow(StyleError);
  expect(() => learnStyleProfile("gmail", [])).toThrow(StyleError);
  const many = Array.from({ length: 60 }, (_, i) => `第 ${i} 条样本消息，内容各不相同。`);
  const p = learnStyleProfile("gmail", many);
  expect(p.sample_count).toBe(50);
});

test("Style.test_save_load_roundtrip_and_perms", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-style-"));
  const profile = learnStyleProfile("gmail", FORMAL_SAMPLES);
  const path = saveStyleProfile(home, profile);
  expect(path).toBe(stylePath(home, "gmail"));
  expect(existsSync(path)).toBe(true);
    // POSIX 才保证 0600；Windows 上 chmod 只映射到只读位，mode 不等于 0o600。
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  const loaded = loadStyleProfile(home, "gmail");
  expect(loaded).toEqual(profile);
  expect(loadStyleProfile(home, "outlook")).toBeNull();
});

test("Style.test_load_corrupt_throws", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-style-"));
  mkdirSync(join(home, "styles"), { recursive: true });
  writeFileSync(stylePath(home, "gmail"), "{not json", "utf-8");
  expect(() => loadStyleProfile(home, "gmail")).toThrow(StyleError);
  writeFileSync(stylePath(home, "gmail"), JSON.stringify({ version: 1, channel: "slack" }), "utf-8");
  expect(() => loadStyleProfile(home, "gmail")).toThrow(StyleError);
});

test("Style.test_delete_and_list", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-style-"));
  saveStyleProfile(home, learnStyleProfile("slack", FORMAL_SAMPLES));
  saveStyleProfile(home, learnStyleProfile("gmail", FORMAL_SAMPLES));
  expect(listStyleProfiles(home)).toEqual(["gmail", "slack"]);
  expect(deleteStyleProfile(home, "gmail")).toBe(true);
  expect(deleteStyleProfile(home, "gmail")).toBe(false);
  expect(listStyleProfiles(home)).toEqual(["slack"]);
  expect(listStyleProfiles(mkdtempSync(join(tmpdir(), "nyra-style-empty-")))).toEqual([]);
});

test("Style.test_format_and_build_section", () => {
  const p = learnStyleProfile("gmail", FORMAL_SAMPLES);
  const text = formatStyleProfile(p);
  expect(text).toContain("渠道：gmail");
  expect(text).toContain("语气：正式");
  expect(text).toContain("原文未保存");
  const section = buildStyleSection(p);
  expect(section).toContain("## 你的文风（gmail）");
  expect(section).toContain("只影响措辞风格");
  expect(section).toContain("不改变事实内容，不改变审批规则");
  expect(section).not.toContain("进度报告");
});

test("Style.test_snapshot_roundtrip", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-style-"));
  const memoryPath = join(home, "MEMORY.md");
  appendMemory("[事实] 用户在铜陵上学", memoryPath, home);
  saveStyleProfile(home, learnStyleProfile("gmail", FORMAL_SAMPLES));
  const snapshot = exportSnapshot(memoryPath, home);
  expect(snapshot).toContain("## 文风画像（gmail）");
  expect(snapshot).toContain("语气：正式");
  // 导入到新家目录：记忆与画像都过去。
  const home2 = mkdtempSync(join(tmpdir(), "nyra-style-"));
  const result = importSnapshot(snapshot, join(home2, "MEMORY.md"), home2);
  expect(result.stylesAdded).toBe(1);
  const imported = loadStyleProfile(home2, "gmail");
  expect(imported?.tone).toBe("正式");
  expect(imported?.greeting).toBe("您好，");
  expect(imported?.source).toContain("记忆快照");
  expect(readFileSync(join(home2, "MEMORY.md"), "utf-8")).toContain("用户在铜陵上学");
  // 再导一次：同渠道已有就跳过，不覆盖。
  const again = importStylesSnapshot(home2, snapshot);
  expect(again.added).toBe(0);
  expect(again.skipped).toBe(1);
});

test("Style.test_snapshot_without_styles_unchanged", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-style-"));
  const memoryPath = join(home, "MEMORY.md");
  appendMemory("[事实] 用户在铜陵上学", memoryPath, home);
  const snapshot = exportSnapshot(memoryPath, home);
  expect(snapshot).not.toContain("文风画像");
  expect(exportStylesSnapshot(home)).toBe("");
});

test("Style.test_snapshot_scrubs_secrets_in_notes", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-style-"));
  const profile = learnStyleProfile("gmail", FORMAL_SAMPLES);
  profile.notes = "api_key: sk-live-1234567890abcdef";
  saveStyleProfile(home, profile);
  const text = exportStylesSnapshot(home);
  expect(text).not.toContain("sk-live-1234567890abcdef");
});

test("Style.test_agent_injects_profile_by_channel", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-style-"));
  saveStyleProfile(home, learnStyleProfile("gmail", FORMAL_SAMPLES));
  const withChannel = new Agent(fakeProvider([{ content: "完成。" }]) as never, { home, channel: "gmail" });
  const system = withChannel.buildSystemPrompt("帮我回这封邮件");
  expect(system).toContain("## 你的文风（gmail）");
  expect(system).toContain("语气正式");
  const noChannel = new Agent(fakeProvider([{ content: "完成。" }]) as never, { home });
  expect(noChannel.buildSystemPrompt("帮我回这封邮件")).not.toContain("你的文风");
  const noProfile = new Agent(fakeProvider([{ content: "完成。" }]) as never, { home, channel: "outlook" });
  expect(noProfile.buildSystemPrompt("帮我回这封邮件")).not.toContain("你的文风");
});

test("Style.test_agent_tolerates_corrupt_profile", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-style-"));
  mkdirSync(join(home, "styles"), { recursive: true });
  writeFileSync(stylePath(home, "gmail"), "{broken", "utf-8");
  const agent = new Agent(fakeProvider([{ content: "完成。" }]) as never, { home, channel: "gmail" });
  expect(() => agent.buildSystemPrompt("帮我回邮件")).not.toThrow();
  expect(agent.buildSystemPrompt("帮我回邮件")).not.toContain("你的文风");
});

// ---- CLI 真测 ----

function runCli(args: string[], home: string): { code: number; out: string } {
  const r = spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra") },
    encoding: "utf-8", timeout: 60000,
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("Style.test_cli_learn_show_list_delete", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-style-cli-"));
  const samplesFile = join(home, "sent.txt");
  writeFileSync(samplesFile, FORMAL_SAMPLES.join("\n\n"), "utf-8");
  const learn = runCli(["style", "learn", "gmail", samplesFile, "--yes"], home);
  expect(learn.code).toBe(0);
  expect(learn.out).toContain("已保存 gmail 的文风画像");
  expect(learn.out).toContain("--channel gmail");
  expect(existsSync(join(home, ".nyra", "styles", "gmail.json"))).toBe(true);
  // 证据链：保存记了学到什么、谁确认的。
  const evidenceDir = join(home, ".nyra", "evidence", "style");
  const evidenceFiles = existsSync(evidenceDir)
    ? readdirSync(evidenceDir).filter((f: string) => f.includes("style_learn"))
    : [];
  expect(evidenceFiles.length).toBe(1);
  const show = runCli(["style", "show", "gmail"], home);
  expect(show.code).toBe(0);
  expect(show.out).toContain("语气：正式");
  expect(show.out).toContain("问候：您好，");
  const list = runCli(["style", "list"], home);
  expect(list.out).toContain("gmail");
  const del = runCli(["style", "delete", "gmail", "--yes"], home);
  expect(del.code).toBe(0);
  expect(del.out).toContain("已删除 gmail 的文风画像");
  expect(existsSync(join(home, ".nyra", "styles", "gmail.json"))).toBe(false);
  const showAfter = runCli(["style", "show", "gmail"], home);
  expect(showAfter.out).toContain("没有 gmail 的文风画像");
});

test("Style.test_cli_learn_rejects_too_few_samples", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-style-cli-"));
  const samplesFile = join(home, "sent.txt");
  writeFileSync(samplesFile, "只有一条", "utf-8");
  const r = runCli(["style", "learn", "gmail", samplesFile, "--yes"], home);
  expect(r.code).toBe(1);
  expect(r.out).toContain("至少 3 条");
  expect(existsSync(join(home, ".nyra", "styles", "gmail.json"))).toBe(false);
});

test("Style.test_cli_export_import_roundtrip", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-style-cli-"));
  const samplesFile = join(home, "sent.txt");
  writeFileSync(samplesFile, FORMAL_SAMPLES.join("\n\n"), "utf-8");
  expect(runCli(["style", "learn", "gmail", samplesFile, "--yes"], home).code).toBe(0);
  const exported = runCli(["style", "export"], home);
  expect(exported.code).toBe(0);
  expect(exported.out).toContain("## 文风画像（gmail）");
  const home2 = mkdtempSync(join(tmpdir(), "nyra-style-cli-"));
  const importFile = join(home2, "styles.md");
  writeFileSync(importFile, exported.out, "utf-8");
  const imported = runCli(["style", "import", importFile], home2);
  expect(imported.code).toBe(0);
  expect(imported.out).toContain("已导入 1 套文风画像");
  expect(runCli(["style", "show", "gmail"], home2).out).toContain("语气：正式");
});

test("Style.test_cli_memory_export_carries_styles", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-style-cli-"));
  const nyraHome = join(home, ".nyra");
  appendMemory("[事实] 用户在铜陵上学", join(nyraHome, "MEMORY.md"), nyraHome);
  const samplesFile = join(home, "sent.txt");
  writeFileSync(samplesFile, FORMAL_SAMPLES.join("\n\n"), "utf-8");
  expect(runCli(["style", "learn", "gmail", samplesFile, "--yes"], home).code).toBe(0);
  const exported = runCli(["memory", "export"], home);
  expect(exported.code).toBe(0);
  expect(exported.out).toContain("## 文风画像（gmail）");
  const home2 = mkdtempSync(join(tmpdir(), "nyra-style-cli-"));
  const snapshotFile = join(home2, "snapshot.md");
  writeFileSync(snapshotFile, exported.out, "utf-8");
  const imported = runCli(["memory", "import", snapshotFile], home2);
  expect(imported.code).toBe(0);
  expect(runCli(["style", "show", "gmail"], home2).out).toContain("语气：正式");
});
