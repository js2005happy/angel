// tests/node/test-hooks.test.ts — Hooks 确定性钩子层（调研报告第 1 项，学 Claude Code）。
// 只用临时目录 + 自写小脚本作钩子，禁止依赖真实用户 home。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHooks, listHooks, type HookEvent } from "../../src/hooks.ts";
import { executeTool, newToolContext, type ToolContext } from "../../src/tools.ts";

let home: string;
let workdir: string;
const savedHooksEnv = process.env.NYRA_HOOKS;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nyra-hooks-home-"));
  workdir = mkdtempSync(join(tmpdir(), "nyra-hooks-work-"));
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

/** 在 <home>/hooks/<event>.d/ 下写一个可执行钩子脚本，返回其绝对路径。 */
function writeHook(event: HookEvent, name: string, body: string): string {
  const path = join(hookDir(event), name);
  writeFileSync(path, body, "utf-8");
  chmodSync(path, 0o755);
  return path;
}

function fullCtx(extra: Partial<ToolContext> = {}): ToolContext {
  return newToolContext({ workdir, mode: "full", interactive: false, home, ...extra });
}

test("HooksTest.test_no_hooks_passes_without_spawn", async () => {
  // 没有钩子文件时直接返回不通过，且不 spawn：放一个一旦被执行就会留下标记的脚本目录之外的证明——
  // 这里用“空 home + 一个本会被执行的哨兵”反证：home 里没有任何钩子，runHooks 必须立刻返回。
  const started = Date.now();
  const result = await runHooks("PreToolUse", { tool: "shell", args: { command: "echo hi" }, home, workdir });
  expect(result.blocked).toBe(false);
  expect(result.reason).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(2000);
  expect(listHooks(home)).toEqual([]);
});

test("HooksTest.test_exit_2_blocks_with_reason", async () => {
  writeHook("PreToolUse", "block.sh", "#!/bin/sh\necho '不许写这个文件'\nexit 2\n");
  const result = await runHooks("PreToolUse", { tool: "write_file", args: { path: "a.txt", content: "x" }, home, workdir });
  expect(result.blocked).toBe(true);
  expect(result.reason).toBe("不许写这个文件");
  expect(result.hook).toContain("block.sh");
});

test("HooksTest.test_exit_1_does_not_block", async () => {
  writeHook("PreToolUse", "broken.sh", "#!/bin/sh\necho '钩子自己挂了' >&2\nexit 1\n");
  const result = await runHooks("PreToolUse", { tool: "shell", args: { command: "echo hi" }, home, workdir });
  expect(result.blocked).toBe(false);
});

test("HooksTest.test_timeout_does_not_block", async () => {
  writeHook("PreToolUse", "slow.sh", "#!/bin/sh\nsleep 5\nexit 0\n");
  const started = Date.now();
  const result = await runHooks("PreToolUse", { tool: "shell", args: { command: "echo hi" }, home, workdir, timeoutMs: 1000 });
  expect(result.blocked).toBe(false);
  // 1 秒超时 + 最多 1 秒收尾宽限：远小于脚本的 5 秒。
  expect(Date.now() - started).toBeLessThan(4000);
});

test("HooksTest.test_post_tool_use_never_blocks", async () => {
  writeHook("PostToolUse", "nope.sh", "#!/bin/sh\necho '事后也不许'\nexit 2\n");
  const result = await runHooks("PostToolUse", { tool: "write_file", args: { path: "a.txt" }, home, workdir });
  expect(result.blocked).toBe(false);
});

test("HooksTest.test_list_hooks_from_directory", () => {
  writeHook("PreToolUse", "b-check.sh", "#!/bin/sh\nexit 0\n");
  writeHook("PreToolUse", "a-check.sh", "#!/bin/sh\nexit 0\n");
  writeHook("SessionStart", "hello.sh", "#!/bin/sh\nexit 0\n");
  const listed = listHooks(home);
  expect(listed.map((h) => `${h.event}:${h.path.split("/").pop()}`)).toEqual([
    "PreToolUse:a-check.sh",
    "PreToolUse:b-check.sh",
    "SessionStart:hello.sh",
  ]);
});

test("HooksTest.test_list_hooks_from_config", () => {
  const explicit = join(workdir, "explicit.sh");
  writeFileSync(explicit, "#!/bin/sh\nexit 0\n", "utf-8");
  chmodSync(explicit, 0o755);
  writeFileSync(join(home, "config.json"), JSON.stringify({ hooks: { PreToolUse: [explicit] } }), "utf-8");
  const listed = listHooks(home);
  expect(listed).toEqual([{ event: "PreToolUse", path: explicit }]);
});

test("HooksTest.test_hooks_disabled_by_config", async () => {
  writeHook("PreToolUse", "block.sh", "#!/bin/sh\nexit 2\n");
  writeFileSync(join(home, "config.json"), JSON.stringify({ hooks: { enabled: false } }), "utf-8");
  const result = await runHooks("PreToolUse", { tool: "shell", args: {}, home, workdir });
  expect(result.blocked).toBe(false);
});

test("HooksTest.test_hooks_disabled_by_env", async () => {
  writeHook("PreToolUse", "block.sh", "#!/bin/sh\nexit 2\n");
  process.env.NYRA_HOOKS = "0";
  const result = await runHooks("PreToolUse", { tool: "shell", args: {}, home, workdir });
  expect(result.blocked).toBe(false);
});

test("HooksTest.test_hook_receives_json_stdin_and_no_secrets", async () => {
  const payloadPath = join(workdir, "payload.json");
  const envPath = join(workdir, "env.txt");
  process.env.MY_HOOK_SECRET_TEST = "do-not-leak-secret";
  try {
    writeHook(
      "PreToolUse",
      "inspect.sh",
      `#!/bin/sh\ncat > "${payloadPath}"\nenv > "${envPath}"\nexit 0\n`,
    );
    await runHooks("PreToolUse", { tool: "shell", args: { command: "echo hi" }, home, workdir });
    const payload = JSON.parse(readFileSync(payloadPath, "utf-8")) as Record<string, unknown>;
    expect(payload.event).toBe("PreToolUse");
    expect(payload.tool).toBe("shell");
    expect(payload.workdir).toBe(workdir);
    expect(payload.args).toEqual({ command: "echo hi" });
    const envText = readFileSync(envPath, "utf-8");
    expect(envText).toContain("NYRA_HOOK_EVENT=PreToolUse");
    expect(envText).toContain("NYRA_HOOK_TOOL=shell");
    expect(envText).not.toContain("MY_HOOK_SECRET_TEST");
    expect(envText).not.toContain("do-not-leak-secret");
  } finally {
    delete process.env.MY_HOOK_SECRET_TEST;
  }
});

test("HooksTest.test_execute_tool_blocked_by_pre_hook", async () => {
  writeHook("PreToolUse", "no-todo.sh", "#!/bin/sh\necho '内容含 TODO，先处理完再写文件'\nexit 2\n");
  const ctx = fullCtx();
  const out = await executeTool("write_file", { path: "a.txt", content: "hello\n" }, ctx);
  expect(out).toContain("钩子拦截了 write_file");
  expect(out).toContain("no-todo.sh");
  expect(out).toContain("内容含 TODO，先处理完再写文件");
  expect(existsSync(join(workdir, "a.txt"))).toBe(false);
});

test("HooksTest.test_execute_tool_passes_when_hook_allows", async () => {
  writeHook("PreToolUse", "ok.sh", "#!/bin/sh\nexit 0\n");
  const ctx = fullCtx();
  const out = await executeTool("write_file", { path: "a.txt", content: "hello\n" }, ctx);
  expect(out).toContain("已写入");
  expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("hello\n");
});

test("HooksTest.test_execute_tool_post_hook_does_not_block_result", async () => {
  writeHook("PostToolUse", "nope.sh", "#!/bin/sh\nexit 2\n");
  const ctx = fullCtx();
  const out = await executeTool("shell", { command: "echo hi" }, ctx);
  expect(out).toContain("hi");
});

test("HooksTest.test_execute_tool_shell_blocked_by_pre_hook", async () => {
  writeHook(
    "PreToolUse",
    "block-danger.sh",
    "#!/bin/sh\ninput=$(cat)\ncase \"$input\" in *\"rm -rf /\"*) echo '危险命令已被钩子拦截'; exit 2;; esac\nexit 0\n",
  );
  const ctx = fullCtx();
  const allowed = await executeTool("shell", { command: "echo hello" }, ctx);
  // 不含危险关键词，钩子放行，正常执行。
  expect(allowed).toContain("hello");
  expect(allowed).not.toContain("钩子拦截");
  const blocked = await executeTool("shell", { command: "rm -rf /" }, ctx);
  expect(blocked).toContain("钩子拦截了 shell");
  expect(blocked).toContain("危险命令已被钩子拦截");
});
