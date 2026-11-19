// tests/node/test-tools.test.ts — 对应 tests/test_apply_patch.py（17 唯一）+
// test_shell_stream.py（3 唯一）+ tests/test_tools.py 行为 + 审批语义专项。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOOL_SCHEMAS, POPPY_TOOL_SCHEMA, POPPY_IDENTITY_SCHEMA, POPPY_PERMISSION_SCHEMA,
  MUTATING_TOOLS, SESSION_FILE_TOOLS, SESSION_GRANT_TOOLS,
  ToolError, ApprovalRequired, MAX_OUTPUT_CHARS, STREAM_LINES_MAX, truncate,
  newToolContext, checkApproval, checkShellDenied,
  applyUnifiedPatch, PatchError, unifiedPreview,
  executeTool, type ToolContext,
} from "../../src/tools.ts";

const TOOL_NAMES = ["read_file", "write_file", "edit_file", "apply_patch", "list_dir", "shell",
  "web_fetch", "web_search", "browser_navigate", "browser_click", "browser_screenshot",
  "computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_windows",
  "multi_model_research", "memory_append", "save_skill", "delegate", "plan",
  "grep_search", "git_status", "http_post"];

function fullCtx(workdir: string, extra: Partial<ToolContext> = {}): ToolContext {
  return newToolContext({ workdir, mode: "full", interactive: false, ...extra });
}

test("ToolsTest.test_schema_names_match_python_24", () => {
  const names = TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name as string);
  expect(names).toEqual(TOOL_NAMES);
  expect(TOOL_SCHEMAS.length).toBe(24);
  const poppy = [POPPY_TOOL_SCHEMA, POPPY_IDENTITY_SCHEMA, POPPY_PERMISSION_SCHEMA]
    .map((s) => (s.function as Record<string, unknown>).name as string);
  expect(poppy).toEqual(["poppy_discover", "poppy_identity_check", "poppy_permission_check"]);
});

test("ToolsTest.test_mutating_tools_set", () => {
  // delegate 不进 MUTATING_TOOLS（与 multi_model_research 同例：只花模型调用，
  // 不写文件不跑命令，Python 版 tools.py:1411 注释）。
  for (const name of ["write_file", "edit_file", "apply_patch", "shell", "memory_append", "save_skill", "plan", "mcp"]) {
    expect(MUTATING_TOOLS.has(name)).toBe(true);
  }
  for (const name of ["read_file", "list_dir", "grep_search", "git_status", "web_fetch", "web_search"]) {
    expect(MUTATING_TOOLS.has(name)).toBe(false);
  }
  expect(MUTATING_TOOLS.has("delegate")).toBe(false);
  expect(MUTATING_TOOLS.has("multi_model_research")).toBe(false);
  expect(SESSION_FILE_TOOLS.has("write_file")).toBe(true);
  expect(SESSION_GRANT_TOOLS.has("shell")).toBe(true);
});

test("ToolsTest.test_approval_required_shape", () => {
  const err = new ApprovalRequired("write_file", "写 a.txt");
  expect(err.tool).toBe("write_file");
  expect(err.summary).toBe("写 a.txt");
  expect(err.message).toBe("等待审批：write_file");
});

test("ToolsTest.test_readonly_rejects_mutating", async () => {
  const ctx = newToolContext({ workdir: tmpdir(), mode: "readonly", interactive: false });
  await expect(checkApproval(ctx, "write_file", "写文件")).rejects.toThrow(ToolError);
  await checkApproval(ctx, "read_file", "读文件");
});

test("ToolsTest.test_auto_noninteractive_rejects", async () => {
  const ctx = newToolContext({ workdir: tmpdir(), mode: "auto", interactive: false });
  await expect(checkApproval(ctx, "write_file", "写文件")).rejects.toThrow(ToolError);
});

test("ToolsTest.test_auto_approve_fn_yes_and_no", async () => {
  const yesCtx = newToolContext({ workdir: tmpdir(), mode: "auto", interactive: true, approveFn: async () => true });
  await checkApproval(yesCtx, "write_file", "写文件");
  const noCtx = newToolContext({ workdir: tmpdir(), mode: "auto", interactive: true, approveFn: async () => false });
  await expect(checkApproval(noCtx, "write_file", "写文件")).rejects.toThrow(ToolError);
});

test("ToolsTest.test_full_mode_passes_without_prompt", async () => {
  const ctx = newToolContext({ workdir: tmpdir(), mode: "full", interactive: false });
  await checkApproval(ctx, "write_file", "写文件");
  await checkApproval(ctx, "shell", "跑命令");
});

test("ToolsTest.test_shell_denylist", () => {
  expect(checkShellDenied("rm -rf /")).not.toBeNull();
  expect(checkShellDenied("rm -rf ~")).not.toBeNull();
  expect(checkShellDenied("rm -rf $HOME")).not.toBeNull();
  expect(checkShellDenied("rm -rf /*")).not.toBeNull();
  expect(checkShellDenied("sudo rm -rf /tmp/x")).not.toBeNull();
  expect(checkShellDenied("mkfs.ext4 /dev/sda1")).not.toBeNull();
  expect(checkShellDenied("dd if=/dev/zero of=/dev/sda")).not.toBeNull();
  expect(checkShellDenied("shutdown -h now")).not.toBeNull();
  expect(checkShellDenied("reboot")).not.toBeNull();
  expect(checkShellDenied(":(){ :|:& };:")).not.toBeNull();
  expect(checkShellDenied("echo hi > /dev/sda")).not.toBeNull();
  expect(checkShellDenied("chmod -R 777 /")).not.toBeNull();
  expect(checkShellDenied("chown -R root:root /")).not.toBeNull();
  expect(checkShellDenied("rm -rf /tmp/my-project")).toBeNull();
  expect(checkShellDenied("echo hello")).toBeNull();
  expect(checkShellDenied("ls -la")).toBeNull();
});

test("ToolsTest.test_read_write_edit_files", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd);
  expect(await executeTool("write_file", { path: "a.txt", content: "hello\n" }, ctx)).toContain("已写入");
  expect(await executeTool("read_file", { path: "a.txt" }, ctx)).toContain("hello");
  expect(await executeTool("edit_file", { path: "a.txt", old_text: "hello", new_text: "world" }, ctx)).toContain("已编辑 a.txt");
  expect(readFileSync(join(wd, "a.txt"), "utf-8")).toBe("world\n");
});

test("ToolsTest.test_read_missing_file_errors", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd);
  const out = await executeTool("read_file", { path: "nope.txt" }, ctx);
  expect(out.startsWith("错误：")).toBe(true);
});

test("ToolsTest.test_edit_requires_unique_old_text", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  writeFileSync(join(wd, "a.txt"), "dup\ndup\n");
  const ctx = fullCtx(wd);
  const out = await executeTool("edit_file", { path: "a.txt", old_text: "dup", new_text: "x" }, ctx);
  expect(out.startsWith("错误：")).toBe(true);
  const out2 = await executeTool("edit_file", { path: "a.txt", old_text: "absent", new_text: "x" }, ctx);
  expect(out2.startsWith("错误：")).toBe(true);
});

test("ToolsTest.test_write_outside_workdir_refused", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd);
  const out = await executeTool("write_file", { path: "../escape.txt", content: "x" }, ctx);
  expect(out.startsWith("错误：")).toBe(true);
});

test("ToolsTest.test_list_dir", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  writeFileSync(join(wd, "a.txt"), "x");
  mkdirSync(join(wd, "sub"));
  const ctx = fullCtx(wd);
  const out = await executeTool("list_dir", { path: "." }, ctx);
  expect(out).toContain("a.txt");
  expect(out).toContain("sub");
});

test("ToolsTest.test_apply_patch_valid", () => {
  const original = "line1\nline2\nline3\n";
  const patch = "--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2-new\n line3\n";
  expect(applyUnifiedPatch(original, patch, "f.txt")).toBe("line1\nline2-new\nline3\n");
});

test("ToolsTest.test_apply_patch_context_mismatch", () => {
  const original = "line1\nlineX\nline3\n";
  const patch = "--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2-new\n line3\n";
  expect(() => applyUnifiedPatch(original, patch, "f.txt")).toThrow(PatchError);
});

test("ToolsTest.test_apply_patch_rejects_multi_file", () => {
  const original = "a\n";
  const patch = "--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n--- a/g.txt\n+++ b/g.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n";
  expect(() => applyUnifiedPatch(original, patch, "f.txt")).toThrow(PatchError);
});

test("ToolsTest.test_apply_patch_rejects_new_file_and_delete", () => {
  expect(() => applyUnifiedPatch("", "--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+x\n", "f.txt")).toThrow(PatchError);
  expect(() => applyUnifiedPatch("x\n", "--- a/f.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n", "f.txt")).toThrow(PatchError);
});

test("ToolsTest.test_apply_patch_rejects_crlf", () => {
  const original = "a\r\nb\r\n";
  const patch = "--- a/f.txt\r\n+++ b/f.txt\r\n@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n";
  expect(() => applyUnifiedPatch(original, patch, "f.txt")).toThrow(PatchError);
});

test("ToolsTest.test_unified_preview", () => {
  const preview = unifiedPreview("f.txt", Buffer.from("old\n"), Buffer.from("new\n"));
  expect(preview).toContain("f.txt");
  expect(preview).toContain("-old");
  expect(preview).toContain("+new");
});

test("ToolsTest.test_shell_echo", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd);
  const out = await executeTool("shell", { command: "echo hello-shell", timeout: 10 }, ctx);
  expect(out).toContain("hello-shell");
});

test("ToolsTest.test_shell_denied_command_not_run", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd);
  const out = await executeTool("shell", { command: "rm -rf /", timeout: 10 }, ctx);
  expect(out.startsWith("错误：")).toBe(true);
  expect(out).toContain("禁止");
});

test("ToolsTest.test_shell_timeout_returns_error_text", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd);
  const out = await executeTool("shell", { command: "sleep 5", timeout: 1 }, ctx);
  expect(out).toContain("超时");
});

test("ToolsTest.test_shell_streaming_lines_capped", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const events: string[] = [];
  const ctx = fullCtx(wd, {
    streamToolOutput: true,
    onEvent: (kind) => { events.push(kind); },
  });
  const out = await executeTool("shell", { command: "seq 1 250", timeout: 10 }, ctx);
  expect(out).toContain("250");
  expect(events).toContain("tool_stream");
});

test("ToolsTest.test_grep_search", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  writeFileSync(join(wd, "a.txt"), "hello world\nsecond line\n");
  writeFileSync(join(wd, "b.txt"), "nothing here\n");
  const ctx = fullCtx(wd);
  const out = await executeTool("grep_search", { pattern: "hello", path: "." }, ctx);
  expect(out).toContain("a.txt");
  expect(out).not.toContain("b.txt");
});

test("ToolsTest.test_git_status_outside_repo", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd);
  const out = await executeTool("git_status", { path: "." }, ctx);
  expect(typeof out).toBe("string");
  expect(out.length).toBeGreaterThan(0);
});

test("ToolsTest.test_unknown_tool_returns_error_string", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd);
  expect(await executeTool("no_such_tool", {}, ctx)).toBe("错误：未知工具 no_such_tool");
});

test("ToolsTest.test_bridge_tool_without_bridge_errors", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd);
  const out = await executeTool("browser_navigate", { url: "https://example.com" }, ctx);
  expect(out.startsWith("错误：")).toBe(true);
});

test("ToolsTest.test_truncate_caps_output", () => {
  expect(truncate("x".repeat(MAX_OUTPUT_CHARS + 100)).length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 100);
  expect(truncate("short")).toBe("short");
  expect(STREAM_LINES_MAX).toBe(200);
});

test("ToolsTest.test_memory_append_and_save_skill", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const home = mkdtempSync(join(tmpdir(), "nyra-tools-home-"));
  const ctx = fullCtx(wd);
  ctx.memoryPath = join(home, "MEMORY.md");
  const out = await executeTool("memory_append", { text: "测试记忆行" }, ctx);
  expect(out).not.toContain("错误：");
  expect(existsSync(join(home, "MEMORY.md"))).toBe(true);
  expect(readFileSync(join(home, "MEMORY.md"), "utf-8")).toContain("测试记忆行");
});

test("ToolsTest.test_http_post_to_closed_port_errors", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd);
  const out = await executeTool("http_post", { url: "http://127.0.0.1:1/hook", body: "{}" }, ctx);
  expect(out.startsWith("错误：")).toBe(true);
});

// ---- 第 4 阶段：浏览器 / 电脑 / Poppy 原生接线（注入假后端，不启动真实 Chrome/桌面/网络） ----

function fakeBrowser(overrides: Record<string, unknown> = {}) {
  return {
    navigate: async (_url: string) => "ok",
    click: async (_selector: string) => "ok",
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    title: async () => "测试页",
    currentUrl: async () => "https://example.com/",
    visibleText: async (_limit?: number) => "可见文本内容",
    close: () => {},
    ...overrides,
  } as unknown as ToolContext["browser"];
}

function fakeComputer(overrides: Record<string, unknown> = {}) {
  return {
    backend: "x11",
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    click: async (_x: number, _y: number, _button?: string) => {},
    typeText: async (_text: string) => {},
    press: async (_key: string) => {},
    windows: async () => [
      { id: "1", title: "编辑器", x: 0, y: 0, width: 800, height: 600 },
      { id: "2", title: "终端" },
    ],
    ...overrides,
  } as unknown as ToolContext["computer"];
}

test("ToolsTest.test_browser_navigate_native_fake", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd, { browser: fakeBrowser() });
  const out = await executeTool("browser_navigate", { url: "https://example.com/" }, ctx);
  expect(out).toContain("页面：https://example.com/");
  expect(out).toContain("标题：测试页");
  expect(out).toContain("可见文本内容");
});

test("ToolsTest.test_browser_click_and_screenshot_native_fake", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd, { browser: fakeBrowser() });
  const clicked = await executeTool("browser_click", { selector: "#btn" }, ctx);
  expect(clicked.startsWith("已点击：#btn")).toBe(true);
  const shot = await executeTool("browser_screenshot", {}, ctx);
  expect(shot).toContain("已截图并保存：");
  const match = /已截图并保存：(.+?)（PNG，/.exec(shot);
  expect(match).not.toBeNull();
  expect(existsSync(match![1])).toBe(true);
});

test("ToolsTest.test_computer_tools_native_fake", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const ctx = fullCtx(wd, { computer: fakeComputer() });
  expect(await executeTool("computer_click", { x: 10, y: 20 }, ctx)).toBe("已点击（10, 20，left键）");
  expect(await executeTool("computer_type", { text: "abc" }, ctx)).toBe("已输入 3 个字符");
  expect(await executeTool("computer_key", { key: "Enter" }, ctx)).toBe("已按键：Enter");
  const wins = await executeTool("computer_windows", {}, ctx);
  expect(wins).toContain("可见窗口（共 2 个）");
  expect(wins).toContain("[1] 编辑器");
  expect(wins).toContain("位置 (0, 0)，大小 800x600");
  expect(wins).toContain("[2] 终端");
  const shot = await executeTool("computer_screenshot", {}, ctx);
  expect(shot).toContain("已截屏并保存：");
  expect(shot).toContain("模型暂不能直接看图");
  const match = /已截屏并保存：(.+?)（PNG，/.exec(shot);
  expect(match).not.toBeNull();
  expect(existsSync(match![1])).toBe(true);
});

test("ToolsTest.test_poppy_disabled_and_bad_site_errors", async () => {
  const wd = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const off = fullCtx(wd, { poppyEnabled: false });
  expect(await executeTool("poppy_discover", { site: "https://example.com" }, off))
    .toBe("错误：Poppy 发现未启用，需要显式设置 --poppy");
  const on = fullCtx(wd, { poppyEnabled: true });
  const bad = await executeTool("poppy_discover", { site: "https://invalid.invalid" }, on);
  expect(bad.startsWith("错误：")).toBe(true);
});

test("ToolsTest.test_creator_mode_asks_like_auto", async () => {
  const ctx = newToolContext({ workdir: tmpdir(), mode: "creator", interactive: false });
  await expect(checkApproval(ctx, "write_file", "写文件")).rejects.toThrow(ToolError);
  await checkApproval(ctx, "read_file", "读文件");
  const yesCtx = newToolContext({ workdir: tmpdir(), mode: "creator", interactive: true, approveFn: async () => true });
  await checkApproval(yesCtx, "write_file", "写文件");
  const noCtx = newToolContext({ workdir: tmpdir(), mode: "creator", interactive: true, approveFn: async () => false });
  await expect(checkApproval(noCtx, "write_file", "写文件")).rejects.toThrow(ToolError);
});
