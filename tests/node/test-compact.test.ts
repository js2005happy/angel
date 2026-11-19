// tests/node/test-compact.test.ts — 对应 tests/test_auto_compact.py（11 唯一）的核心项 +
// 方案 2.6 第 7 条压缩分层专项：网关 85% / agent 50%、先剪旧工具结果 → 选边界 → LLM 摘要。
import { test, expect } from "bun:test";
import {
  COMPACT_SYSTEM_INSTRUCTION, DEFAULT_AUTO_COMPACT_THRESHOLD,
  GATEWAY_COMPACT_THRESHOLD, AGENT_COMPACT_THRESHOLD,
  trimOldToolResults, splitCompletedVsActive, buildCompactMessages,
  summarizeWithProvider, compactMessages, compactSessionFile,
  validateAutoCompactThreshold, shouldAutoCompact,
  buildReReadNote, focusKeywords, messageMatchesFocus,
} from "../../src/compact.ts";
import { saveSession } from "../../src/memory.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeProvider(summary: string | null) {
  return {
    calls: 0,
    async chat(_messages: unknown[], _tools?: unknown, _timeout?: number) {
      this.calls += 1;
      if (summary === null) throw new Error("模型挂了");
      return { choices: [{ message: { content: summary } }], usage: {} };
    },
  };
}

test("AutoCompactTest.test_thresholds_layered", () => {
  expect(GATEWAY_COMPACT_THRESHOLD).toBe(0.85);
  expect(AGENT_COMPACT_THRESHOLD).toBe(0.5);
  expect(DEFAULT_AUTO_COMPACT_THRESHOLD).toBe(0.8);
  expect(GATEWAY_COMPACT_THRESHOLD).toBeGreaterThan(AGENT_COMPACT_THRESHOLD);
});

test("AutoCompactTest.test_threshold_from_reported_usage_only", () => {
  const snap = { last_prompt_tokens: 900, context_window_tokens: 1000 };
  expect(shouldAutoCompact(snap, 5, 0.8)).toBe(true);
  expect(shouldAutoCompact(snap, 5, 0.95)).toBe(false);
  // 未报告用量时不触发（不用 tokenizer 估算）。
  expect(shouldAutoCompact({ last_prompt_tokens: null, context_window_tokens: 1000 }, 5, 0.5)).toBe(false);
  expect(shouldAutoCompact({ last_prompt_tokens: 900, context_window_tokens: null }, 5, 0.5)).toBe(false);
  // 消息太少不触发。
  expect(shouldAutoCompact(snap, 2, 0.5)).toBe(false);
});

test("AutoCompactTest.test_threshold_validation_rejects_invalid_values", () => {
  expect(() => validateAutoCompactThreshold(0)).toThrow();
  expect(() => validateAutoCompactThreshold(1)).toThrow();
  expect(() => validateAutoCompactThreshold(-0.1)).toThrow();
  expect(() => validateAutoCompactThreshold(1.5)).toThrow();
  expect(() => validateAutoCompactThreshold("0.8")).toThrow();
  expect(() => validateAutoCompactThreshold(NaN)).toThrow();
  expect(validateAutoCompactThreshold(0.5)).toBe(0.5);
  expect(validateAutoCompactThreshold(0.85)).toBe(0.85);
});

test("AutoCompactTest.test_trim_old_tool_results_keeps_latest_round", () => {
  const messages = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
    { role: "tool", content: "旧结果很长很长", tool_call_id: "c1" },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "", tool_calls: [{ id: "c2" }] },
    { role: "tool", content: "最新结果", tool_call_id: "c2" },
  ];
  const trimmed = trimOldToolResults(messages);
  expect(trimmed[2].content).toContain("已压缩");
  expect(trimmed[5].content).toBe("最新结果");
});

test("AutoCompactTest.test_trim_without_tool_calls_is_identity", () => {
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好呀" },
  ];
  expect(trimOldToolResults(messages)).toEqual(messages);
});

test("AutoCompactTest.test_split_completed_vs_active_never_touches_current_request", () => {
  const messages = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "答一" },
    { role: "user", content: "当前问题" },
    { role: "assistant", content: "", tool_calls: [{ id: "c9" }] },
    { role: "tool", content: "结果", tool_call_id: "c9" },
  ];
  const { older, active } = splitCompletedVsActive(messages);
  expect(older).toEqual(messages.slice(0, 2));
  expect(active).toEqual(messages.slice(2));
  expect(active[0].content).toBe("当前问题");
});

test("AutoCompactTest.test_build_compact_messages_keeps_tail", () => {
  const messages = [
    { role: "user", content: "一" },
    { role: "assistant", content: "二" },
    { role: "user", content: "三" },
    { role: "assistant", content: "四" },
  ];
  const out = buildCompactMessages(messages, "摘要：做了很多事", 2);
  expect(out[0].content).toContain("[此前会话摘要]");
  expect(out[0].content).toContain("摘要：做了很多事");
  expect(out[1].content).toBe("已压缩会话，继续。");
  expect(out.slice(2)).toEqual(messages.slice(-2));
});

test("AutoCompactTest.test_summarize_with_provider_uses_system_instruction", async () => {
  let seen: unknown[] = [];
  const provider = {
    async chat(messages: unknown[]) {
      seen = messages as unknown[];
      return { choices: [{ message: { content: "要点摘要" } }] };
    },
  };
  const summary = await summarizeWithProvider(provider, [{ role: "user", content: "你好" }]);
  expect(summary).toBe("要点摘要");
  expect((seen[0] as Record<string, unknown>).content).toBe(COMPACT_SYSTEM_INSTRUCTION);
  expect((seen[seen.length - 1] as Record<string, unknown>).content).toContain("压缩这段对话");
});

test("AutoCompactTest.test_summarize_empty_throws", async () => {
  const provider = { async chat() { return { choices: [{ message: { content: "   " } }] }; } };
  await expect(summarizeWithProvider(provider, [])).rejects.toThrow("空摘要");
});

test("AutoCompactTest.test_success_compacts_and_preserves_session", async () => {
  const messages = [
    { role: "user", content: "一" },
    { role: "assistant", content: "二" },
    { role: "user", content: "三" },
    { role: "assistant", content: "四" },
    { role: "user", content: "五" },
  ];
  const provider = fakeProvider("摘要内容");
  const [out, info] = await compactMessages(provider, messages, 2);
  expect(info.method).toBe("model");
  expect(info.before).toBe(5);
  expect(info.after).toBe(4);
  expect(out[0].content).toContain("摘要内容");
});

test("AutoCompactTest.test_summary_failure_preserves_transcript_and_continues", async () => {
  const messages = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "答一" },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "答二" },
  ];
  const provider = fakeProvider(null);
  const [out, info] = await compactMessages(provider, messages, 2);
  expect(info.method).toBe("fallback");
  expect(out[0].content).toContain("[压缩失败");
  // 回退保留首条 user 消息 + 尾部，不编造内容。
  expect(out.some((m) => m.content === "第一问")).toBe(true);
  expect(out.some((m) => m.content === "答二")).toBe(true);
});

test("AutoCompactTest.test_strict_failure_keeps_original", async () => {
  const messages = [{ role: "user", content: "你好" }];
  const provider = fakeProvider(null);
  await expect(compactMessages(provider, messages, 2, { strict: true })).rejects.toThrow("模型挂了");
});

test("AutoCompactTest.test_compact_empty_is_noop", async () => {
  const provider = fakeProvider("摘要");
  const [out, info] = await compactMessages(provider, [], 2);
  expect(out).toEqual([]);
  expect(info.method).toBe("none");
  expect(provider.calls).toBe(0);
});

test("AutoCompactTest.test_compact_session_file_roundtrip", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-compact-"));
  const messages = [
    { role: "user", content: "一" },
    { role: "assistant", content: "二" },
    { role: "user", content: "三" },
  ];
  saveSession("20261118-000000-cmp1", messages, home);
  const provider = fakeProvider("会话摘要");
  const info = await compactSessionFile("20261118-000000-cmp1", provider, 1, undefined, home);
  expect(info.method).toBe("model");
  const { loadSession } = await import("../../src/memory.ts");
  const loaded = loadSession("20261118-000000-cmp1", home) ?? [];
  expect((loaded[0] as Record<string, unknown>).content).toContain("会话摘要");
  await expect(compactSessionFile("20261118-000000-nope", provider, 1, undefined, home)).rejects.toThrow("会话不存在");
});

// ---- 调研报告第 3 项：上下文补齐（学 Claude Code）----

test("ContextTest.test_focus_keywords_split_and_case_insensitive_match", () => {
  expect(focusKeywords("部署 回滚")).toEqual(["部署", "回滚"]);
  expect(focusKeywords("deploy, rollback")).toEqual(["deploy", "rollback"]);
  expect(focusKeywords("  ")).toEqual([]);
  expect(messageMatchesFocus({ role: "user", content: "Deploy the app" }, ["deploy"])).toBe(true);
  expect(messageMatchesFocus({ role: "user", content: "聊天气" }, ["部署"])).toBe(false);
  expect(messageMatchesFocus({ role: "user", content: "部署" }, [])).toBe(false);
});

test("ContextTest.test_build_compact_messages_focus_keeps_keyword_only", () => {
  const messages = [
    { role: "user", content: "聊聊部署流程" },
    { role: "assistant", content: "部署分三步" },
    { role: "user", content: "今天天气不错" },
    { role: "assistant", content: "是啊很晴朗" },
    { role: "user", content: "部署回滚怎么做" },
    { role: "assistant", content: "回滚按清单来" },
  ];
  const out = buildCompactMessages(messages, "摘要", 2, { focus: "部署" });
  const text = JSON.stringify(out);
  // 含关键词的旧消息被额外保留，不含的不保留；尾部 2 条照常保留。
  expect(text).toContain("聊聊部署流程");
  expect(text).toContain("部署分三步");
  expect(text).not.toContain("今天天气不错");
  expect(text).not.toContain("是啊很晴朗");
  expect(out.slice(-2)).toEqual(messages.slice(-2));
});

test("ContextTest.test_build_compact_messages_focus_cap_10_and_dedup", () => {
  const messages: ChatMessageLike[] = [];
  for (let i = 0; i < 15; i++) messages.push({ role: "user", content: `部署事项 ${i}` });
  messages.push({ role: "user", content: "最新问题" });
  messages.push({ role: "assistant", content: "最新回答" });
  const out = buildCompactMessages(messages, "摘要", 2, { focus: "部署" });
  // 15 条含关键词的旧消息只留前 10 条（上限），尾部 2 条不重复计入。
  const kept = out.filter((m) => typeof m.content === "string" && (m.content as string).startsWith("部署事项"));
  expect(kept.length).toBe(10);
  expect(kept[0].content).toBe("部署事项 0");
  expect(out.slice(-2)).toEqual(messages.slice(-2));
});

test("ContextTest.test_build_compact_messages_empty_focus_unchanged", () => {
  const messages = [
    { role: "user", content: "一" },
    { role: "assistant", content: "二" },
    { role: "user", content: "三" },
    { role: "assistant", content: "四" },
  ];
  expect(buildCompactMessages(messages, "摘要", 2, { focus: "" })).toEqual(buildCompactMessages(messages, "摘要", 2));
  expect(buildCompactMessages(messages, "摘要", 2, { focus: "   " })).toEqual(buildCompactMessages(messages, "摘要", 2));
});

test("ContextTest.test_summarize_focus_appends_instruction", async () => {
  let seen: unknown[] = [];
  const provider = {
    async chat(messages: unknown[]) {
      seen = messages as unknown[];
      return { choices: [{ message: { content: "要点摘要" } }] };
    },
  };
  const summary = await summarizeWithProvider(provider, [{ role: "user", content: "你好" }], undefined, "部署");
  expect(summary).toBe("要点摘要");
  expect((seen[0] as Record<string, unknown>).content).toContain("重点保留与「部署」相关的内容");
  // 无 focus 时指令与原来完全一致。
  seen = [];
  await summarizeWithProvider(provider, [{ role: "user", content: "你好" }]);
  expect((seen[0] as Record<string, unknown>).content).toBe(COMPACT_SYSTEM_INSTRUCTION);
});

test("ContextTest.test_build_re_read_note_from_real_text", () => {
  const note = buildReReadNote(
    "- [2026-11-19] 用户是学生\n- 喜欢中文",
    "# 项目说明\n\n第一段规则。\n\n第二段规则-锚点。\n\n第三段规则-锚点二。",
  );
  expect(note).toContain("[压缩后重读：记忆与规则]");
  expect(note).toContain("用户是学生");
  // 规则只取末尾段落：第一段不在备注里，第二、三段在。
  expect(note).not.toContain("第一段规则");
  expect(note).toContain("第二段规则-锚点");
  expect(note).toContain("第三段规则-锚点二");
  expect(buildReReadNote("", "")).toBeNull();
  expect(buildReReadNote("   ", "")).toBeNull();
});

test("ContextTest.test_compact_success_appends_re_read_and_focus", async () => {
  const messages = [
    { role: "user", content: "聊聊部署流程" },
    { role: "assistant", content: "部署分三步" },
    { role: "user", content: "今天天气不错" },
    { role: "assistant", content: "是啊很晴朗" },
    { role: "user", content: "最新问题" },
    { role: "assistant", content: "最新回答" },
  ];
  const provider = fakeProvider("摘要内容");
  const [out, info] = await compactMessages(provider, messages, 2, {
    focus: "部署",
    reRead: "[压缩后重读：记忆与规则]\n## 长期记忆（压缩后重读）\n- 用户是学生",
  });
  expect(info.method).toBe("model");
  // 重读备注在摘要之后、保留消息之前（第 3 条）。
  expect(out[0].content).toContain("摘要内容");
  expect(out[2].content).toContain("[压缩后重读：记忆与规则]");
  expect(out[2].content).toContain("用户是学生");
  expect(JSON.stringify(out)).toContain("聊聊部署流程");
  expect(JSON.stringify(out)).not.toContain("今天天气不错");
});

test("ContextTest.test_compact_fallback_never_appends_re_read", async () => {
  const messages = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "答一" },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "答二" },
  ];
  const provider = fakeProvider(null);
  const [out, info] = await compactMessages(provider, messages, 2, {
    reRead: "[压缩后重读：记忆与规则]\n- 用户是学生",
  });
  expect(info.method).toBe("fallback");
  expect(JSON.stringify(out)).not.toContain("[压缩后重读");
});
