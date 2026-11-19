// tests/node/test-hooks-gap19.test.ts — 缺口 19：Hooks 事件广度 + prompt/agent
// handler + fail-closed + 拦截进证据链。只用临时目录 + 自写小脚本作钩子，
// 禁止依赖真实用户 home；prompt/agent handler 用注入的假回调，不调真实模型。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runHooks, listHookEntries, listUnknownHookEvents, HOOK_EVENTS, BLOCKING_HOOK_EVENTS,
  isBlockingHookEvent, parseHookEntry, parseHookDecisionLoose, type HookEvent,
} from "../../src/hooks.ts";
import { Agent } from "../../src/agent.ts";
import { RunStore, RunRecorder } from "../../src/runs.ts";
import { newToolContext, executeTool, checkApproval, type ToolContext } from "../../src/tools.ts";
import { fakeProvider } from "./fake-provider.ts";

let home: string;
let workdir: string;
const savedHooksEnv = process.env.NYRA_HOOKS;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nyra-g19-home-"));
  workdir = mkdtempSync(join(tmpdir(), "nyra-g19-work-"));
  delete process.env.NYRA_HOOKS;
});

afterEach(() => {
  if (savedHooksEnv === undefined) delete process.env.NYRA_HOOKS;
  else process.env.NYRA_HOOKS = savedHooksEnv;
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

function hookDir(event: HookEvent): string {
  const dir = join(home, "hooks", `${event}.d`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeHook(event: HookEvent, name: string, body: string): string {
  const path = join(hookDir(event), name);
  writeFileSync(path, body, "utf-8");
  chmodSync(path, 0o755);
  return path;
}

function writeConfig(obj: Record<string, unknown>): void {
  writeFileSync(join(home, "config.json"), JSON.stringify(obj), "utf-8");
}

test("Gap19.test_ten_events_five_blocking", () => {
  expect(HOOK_EVENTS).toEqual([
    "PreToolUse", "PostToolUse", "SessionStart", "SessionEnd",
    "PermissionRequest", "SubagentStart", "SubagentStop", "Stop", "PreCompact", "PostCompact",
  ]);
  expect([...BLOCKING_HOOK_EVENTS].sort()).toEqual(
    ["PreCompact", "PermissionRequest", "PreToolUse", "Stop", "SubagentStart"].sort(),
  );
  expect(isBlockingHookEvent("PostToolUse")).toBe(false);
  expect(isBlockingHookEvent("SessionStart")).toBe(false);
  expect(isBlockingHookEvent("SubagentStop")).toBe(false);
  expect(isBlockingHookEvent("PostCompact")).toBe(false);
  expect(isBlockingHookEvent("Stop")).toBe(true);
});

test("Gap19.test_permission_request_exit_2_blocks", async () => {
  writeHook("PermissionRequest", "deny.sh", "#!/bin/sh\necho '这条命令不许问'\nexit 2\n");
  const result = await runHooks("PermissionRequest", { tool: "shell", args: { command: "rm -rf /" }, home, workdir });
  expect(result.blocked).toBe(true);
  expect(result.reason).toBe("这条命令不许问");
});

test("Gap19.test_permission_request_failure_blocks_fail_closed", async () => {
  writeHook("PermissionRequest", "broken.sh", "#!/bin/sh\nexit 1\n");
  const result = await runHooks("PermissionRequest", { tool: "shell", args: {}, home, workdir });
  expect(result.blocked).toBe(true);
  expect(result.reason).toContain("退出码 1");
});

test("Gap19.test_permission_request_allow_decision_passes", async () => {
  writeHook("PermissionRequest", "allow.sh", "#!/bin/sh\nprintf '{\"permissionDecision\":\"allow\",\"permissionDecisionReason\":\"只读命令\"}'\nexit 0\n");
  const result = await runHooks("PermissionRequest", { tool: "shell", args: { command: "git status" }, home, workdir });
  expect(result.blocked).toBe(false);
  expect(result.decision?.decision).toBe("allow");
});

test("Gap19.test_notification_events_never_block", async () => {
  writeHook("PostCompact", "nope.sh", "#!/bin/sh\nexit 2\n");
  writeHook("SubagentStop", "nope.sh", "#!/bin/sh\nexit 1\n");
  expect((await runHooks("PostCompact", { home, workdir })).blocked).toBe(false);
  expect((await runHooks("SubagentStop", { home, workdir })).blocked).toBe(false);
});

test("Gap19.test_spawn_failure_blocks_fail_closed", async () => {
  // config 指向不存在的脚本：PreToolUse 上拦截，不静默放行。
  writeConfig({ hooks: { PreToolUse: [join(workdir, "missing.sh")] } });
  const result = await runHooks("PreToolUse", { tool: "shell", args: { command: "echo hi" }, home, workdir });
  expect(result.blocked).toBe(true);
    // 失败路径有两条，取决于平台与 shell：
    //   spawn 直接失败 → 「无法启动」；能起 shell 但脚本不存在 → 退出码 127 →「钩子自身出错」
    // 断言真正的不变量（blocked），再接受这两条已知文案之一，而不是锁死某一种。
    expect(String(result.reason)).toMatch(/无法启动|钩子自身出错/);
});

test("Gap19.test_prompt_handler_deny_blocks", async () => {
  writeConfig({ hooks: { PreToolUse: [{ type: "prompt", prompt: "检查调用是否合规", tools: ["shell"] }] } });
  const result = await runHooks("PreToolUse", {
    tool: "shell", args: { command: "rm -rf /" }, home, workdir,
    hookRunners: { prompt: async () => '{"permissionDecision":"deny","permissionDecisionReason":"小模型说不行"}' },
  });
  expect(result.blocked).toBe(true);
  expect(result.reason).toBe("小模型说不行");
});

test("Gap19.test_prompt_handler_throw_blocks_fail_closed", async () => {
  writeConfig({ hooks: { PreToolUse: [{ type: "prompt", prompt: "检查调用" }] } });
  const result = await runHooks("PreToolUse", {
    tool: "shell", args: {}, home, workdir,
    hookRunners: { prompt: async () => { throw new Error("模型挂了"); } },
  });
  expect(result.blocked).toBe(true);
  expect(result.reason).toContain("模型挂了");
});

test("Gap19.test_prompt_handler_garbage_output_blocks_fail_closed", async () => {
  writeConfig({ hooks: { PreToolUse: [{ type: "prompt", prompt: "检查调用" }] } });
  const result = await runHooks("PreToolUse", {
    tool: "shell", args: {}, home, workdir,
    hookRunners: { prompt: async () => "嗯，看起来没问题" },
  });
  expect(result.blocked).toBe(true);
  expect(result.reason).toContain("解析不出决策");
});

test("Gap19.test_prompt_handler_unwired_blocks_on_blocking_event_only", async () => {
  writeConfig({ hooks: { PreToolUse: [{ type: "prompt", prompt: "检查调用" }], PostToolUse: [{ type: "prompt", prompt: "记一笔" }] } });
  // 阻塞型事件：未接线 = 拦截；只通知事件：未接线 = 警告后继续。
  expect((await runHooks("PreToolUse", { tool: "shell", args: {}, home, workdir })).blocked).toBe(true);
  expect((await runHooks("PostToolUse", { tool: "shell", args: {}, home, workdir })).blocked).toBe(false);
});

test("Gap19.test_agent_handler_deny_blocks", async () => {
  writeConfig({ hooks: { PreToolUse: [{ type: "agent", prompt: "核查这次调用", max_turns: 2 }] } });
  const seen: { prompt: string; maxTurns?: number }[] = [];
  const result = await runHooks("PreToolUse", {
    tool: "write_file", args: { path: "a.txt" }, home, workdir,
    hookRunners: {
      agent: async (input) => {
        seen.push({ prompt: input.prompt, maxTurns: input.maxTurns });
        return "核查完毕。\n{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"越权写入\"}";
      },
    },
  });
  expect(result.blocked).toBe(true);
  expect(result.reason).toBe("越权写入");
  expect(seen).toHaveLength(1);
  expect(seen[0].maxTurns).toBe(2);
  expect(seen[0].prompt).toBe("核查这次调用");
});

test("Gap19.test_matcher_limits_hook_to_listed_tools", async () => {
  writeConfig({ hooks: { PreToolUse: [{ type: "command", command: join(workdir, "block.sh"), tools: ["write_file"] }] } });
  writeFileSync(join(workdir, "block.sh"), "#!/bin/sh\necho '写文件不许'\nexit 2\n", "utf-8");
  chmodSync(join(workdir, "block.sh"), 0o755);
  const blocked = await runHooks("PreToolUse", { tool: "write_file", args: { path: "a.txt" }, home, workdir });
  expect(blocked.blocked).toBe(true);
  const skipped = await runHooks("PreToolUse", { tool: "shell", args: { command: "echo hi" }, home, workdir });
  expect(skipped.blocked).toBe(false);
});

test("Gap19.test_matcher_glob_and_never_matching", async () => {
  writeConfig({ hooks: { PreToolUse: [{ type: "command", command: join(workdir, "block.sh"), tools: ["write_*"] }] } });
  writeFileSync(join(workdir, "block.sh"), "#!/bin/sh\nexit 2\n", "utf-8");
  chmodSync(join(workdir, "block.sh"), 0o755);
  expect((await runHooks("PreToolUse", { tool: "write_file", args: {}, home, workdir })).blocked).toBe(true);
  expect((await runHooks("PreToolUse", { tool: "shell", args: {}, home, workdir })).blocked).toBe(false);
  // 永不匹配的 matcher：运行时直接跳过（不拦截），由 /status 报出来。
  writeConfig({ hooks: { PreToolUse: [{ type: "command", command: join(workdir, "block.sh"), tools: ["no_such_tool"] }] } });
  expect((await runHooks("PreToolUse", { tool: "shell", args: {}, home, workdir })).blocked).toBe(false);
});

test("Gap19.test_parse_hook_entry_forms", () => {
  expect(parseHookEntry("PreToolUse", "/a/b.sh", "x")).toEqual(
    expect.objectContaining({ kind: "command", path: "/a/b.sh" }),
  );
  expect(parseHookEntry("PreToolUse", { type: "prompt", prompt: "查", model: "m1" }, "x")).toEqual(
    expect.objectContaining({ kind: "prompt", prompt: "查", model: "m1" }),
  );
  const agent = parseHookEntry("Stop", { type: "agent", prompt: "核查" }, "x");
  expect(agent.kind).toBe("agent");
  expect(agent.maxTurns).toBe(3);
  expect(parseHookEntry("Stop", { type: "agent" }, "x").kind).toBe("invalid");
  expect(parseHookEntry("Stop", { type: "http", prompt: "x" }, "x").kind).toBe("invalid");
  expect(parseHookEntry("Stop", { type: "prompt" }, "x").kind).toBe("invalid");
});

test("Gap19.test_unknown_hook_event_listed", () => {
  writeConfig({ hooks: { PreTool: ["x.sh"], PreToolUse: [] } });
  expect(listUnknownHookEvents(home)).toEqual(["PreTool"]);
});

test("Gap19.test_execute_tool_blocked_by_failing_hook", async () => {
  writeHook("PreToolUse", "broken.sh", "#!/bin/sh\nexit 1\n");
  const ctx: ToolContext = newToolContext({ workdir, mode: "full", interactive: false, home });
  const out = await executeTool("write_file", { path: "a.txt", content: "hello\n" }, ctx);
  expect(out).toContain("钩子拦截了 write_file");
  expect(existsSync(join(workdir, "a.txt"))).toBe(false);
});

test("Gap19.test_permission_request_hook_in_check_approval", async () => {
  writeHook("PermissionRequest", "deny.sh", "#!/bin/sh\necho '这条不许'\nexit 2\n");
  let approvals = 0;
  const ctx: ToolContext = newToolContext({
    workdir, mode: "auto", interactive: true, home,
    approveFn: async () => { approvals += 1; return true; },
  });
  await expect(checkApproval(ctx, "shell", "跑命令", { command: "echo hi" })).rejects.toThrow("已被权限钩子拒绝");
  expect(approvals).toBe(0);
});

test("Gap19.test_permission_request_hook_failure_blocks_approval", async () => {
  writeHook("PermissionRequest", "broken.sh", "#!/bin/sh\nexit 1\n");
  let approvals = 0;
  const ctx: ToolContext = newToolContext({
    workdir, mode: "auto", interactive: true, home,
    approveFn: async () => { approvals += 1; return true; },
  });
  await expect(checkApproval(ctx, "shell", "跑命令", { command: "echo hi" })).rejects.toThrow("权限钩子");
  expect(approvals).toBe(0);
});

test("Gap19.test_permission_request_hook_allow_skips_prompt", async () => {
  writeHook("PermissionRequest", "allow.sh", "#!/bin/sh\nprintf '{\"permissionDecision\":\"allow\"}'\nexit 0\n");
  let approvals = 0;
  const ctx: ToolContext = newToolContext({
    workdir, mode: "auto", interactive: true, home,
    approveFn: async () => { approvals += 1; return true; },
  });
  await checkApproval(ctx, "shell", "跑命令", { command: "echo hi" });
  expect(approvals).toBe(0);
});

test("Gap19.test_stop_hook_blocks_agent_stop_once", async () => {
  const marker = join(workdir, "stopped-once");
  writeHook("Stop", "once.sh", `#!/bin/sh\nif [ -f "${marker}" ]; then exit 0; fi\ntouch "${marker}"\necho '还没完'\nexit 2\n`);
  const provider = fakeProvider([{ content: "第一稿。" }, { content: "改完了。" }]);
  const agent = new Agent(provider as never, { home, workdir, sessionId: "sess-stop", maxTurns: 3 });
  const events: string[] = [];
  agent.onEvent = (kind) => { events.push(kind); };
  const out = await agent.run("做完这件事");
  expect(out).toBe("改完了。");
  expect(provider.calls).toBe(2);
  expect(events).toContain("hook_blocked");
});

test("Gap19.test_subagent_start_blocked_by_hook", async () => {
  writeHook("SubagentStart", "nope.sh", "#!/bin/sh\necho '今天不许派活'\nexit 2\n");
  const provider = fakeProvider([{ content: "子任务结果。" }]);
  const agent = new Agent(provider as never, { home, workdir, sessionId: "sess-sub", maxTurns: 3 });
  const detail = await agent.delegateDetailed("做个子任务", 2);
  expect(detail.ok).toBe(false);
  expect(detail.text).toContain("钩子阻止");
  expect(provider.calls).toBe(0);
});

test("Gap19.test_subagent_stop_fires_on_success", async () => {
  const marker = join(workdir, "subagent-stopped");
  writeHook("SubagentStop", "mark.sh", `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
  const provider = fakeProvider([{ content: "子任务结果。" }]);
  const agent = new Agent(provider as never, { home, workdir, sessionId: "sess-sub2", maxTurns: 3 });
  const detail = await agent.delegateDetailed("做个子任务", 2);
  expect(detail.ok).toBe(true);
  expect(existsSync(marker)).toBe(true);
});

test("Gap19.test_precompact_blocked_by_hook", async () => {
  writeHook("PreCompact", "nope.sh", "#!/bin/sh\necho '现在不许压缩'\nexit 2\n");
  const provider = fakeProvider([{ content: "摘要。" }]);
  const agent = new Agent(provider as never, { home, workdir, sessionId: "sess-compact", maxTurns: 3 });
  await expect(agent.compact()).rejects.toThrow("压缩被钩子阻止");
});

test("Gap19.test_hook_blocked_lands_in_events_jsonl", async () => {
  const agent = new Agent(fakeProvider([{ content: "ok" }]) as never, { home, workdir, sessionId: "sess-ev" });
  const store = new RunStore(join(home, "runs"));
  const recorder = new RunRecorder(store, agent, "任务", {});
  recorder.call("hook_blocked", { event: "PreToolUse", tool: "shell", hook: "/x/block.sh", reason: "钩子退出码 1" });
  const events = store.readEvents(recorder.runId);
  const found = events.find((e) => e.type === "hook_blocked");
  expect(found).toBeDefined();
  expect(found?.event).toBe("PreToolUse");
  expect(found?.tool).toBe("shell");
  expect(found?.hook).toBe("/x/block.sh");
});

test("Gap19.test_parse_hook_decision_loose", () => {
  expect(parseHookDecisionLoose('{"permissionDecision":"allow"}')?.decision).toBe("allow");
  expect(parseHookDecisionLoose('核查完毕。\n{"permissionDecision":"deny","permissionDecisionReason":"越权"}')?.decision).toBe("deny");
  expect(parseHookDecisionLoose('{"permissionDecision":"allow","updatedInput":{"path":"a.txt"}}')?.updatedInput).toEqual({ path: "a.txt" });
  expect(parseHookDecisionLoose("嗯，看起来没问题")).toBeNull();
  expect(parseHookDecisionLoose("")).toBeNull();
});

test("Gap19.test_list_hook_entries_includes_prompt_and_invalid", () => {
  writeConfig({
    hooks: {
      PreToolUse: [
        { type: "prompt", prompt: "查", tools: ["shell"] },
        { type: "agent" },
      ],
    },
  });
  const entries = listHookEntries(home);
  const prompt = entries.find((e) => e.event === "PreToolUse" && e.kind === "prompt");
  expect(prompt?.tools).toEqual(["shell"]);
  const invalid = entries.find((e) => e.event === "PreToolUse" && e.kind === "invalid");
  expect(invalid?.invalidReason).toContain("prompt");
});
