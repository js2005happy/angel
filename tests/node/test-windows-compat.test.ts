// tests/node/test-windows-compat.test.ts — 对应 tests/test_windows_compat.py。
// 跨平台守卫：MCP stdio 静默子进程超时清理、子进程立即退出上报、后端路径恒为 POSIX。
// 控制台编码：Node stdout 恒为 UTF-8 字节，不存在 Python configure_stream 那种
// 旧代码页重编码步骤；此处只锁定 UTF-8 往返不变量，不模拟 Windows 代码页。
import { test, expect } from "bun:test";
import { Writable } from "node:stream";
import { MCPClient, MCPServerConfig } from "../../src/mcp.ts";
import { resolveBackendPath, newToolContext } from "../../src/tools.ts";

test("ConsoleEncodingTest.test_chinese_output_is_utf8", () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, cb) { chunks.push(Buffer.from(chunk as Buffer)); cb(); },
  });
  stream.write("定时任务\n", "utf-8");
  stream.end();
  expect(Buffer.concat(chunks).toString("utf-8")).toBe("定时任务\n");
});

test("BackendPosixPathTest.test_sandbox_paths_are_posix", () => {
  const ctx = newToolContext({ workdir: "/home/user" });
  expect(resolveBackendPath(ctx, "child.txt")).toBe("/home/user/child.txt");
  expect(resolveBackendPath(ctx, "nested\\folder.txt")).toBe("/home/user/nested/folder.txt");
  expect(resolveBackendPath(ctx, "/tmp/../home/user")).toBe("/home/user");
});

test("MCPStdioCompatibilityTest.test_silent_child_times_out_and_is_cleaned_up", async () => {
  const client = new MCPClient(
    new MCPServerConfig("silent", "node", ["-e", "setTimeout(()=>{},10000)"]),
    0.2,
  );
  const started = Date.now();
  client.start();
  try {
    await expect(client.ensureNegotiated()).rejects.toThrow(/超时/);
  } finally {
    client.stop();
    await new Promise((r) => setTimeout(r, 300));
  }
  expect(Date.now() - started).toBeLessThan(5000);
  expect(client.process).toBeNull();
});

test("MCPStdioCompatibilityTest.test_immediate_child_exit_is_reported_and_cleaned_up", async () => {
  const client = new MCPClient(
    new MCPServerConfig("exit", "node", ["-e", "process.exit(3)"]),
    3,
  );
  client.start();
  try {
    await expect(client.ensureNegotiated()).rejects.toThrow(/已退出/);
  } finally {
    client.stop();
    await new Promise((r) => setTimeout(r, 300));
  }
  expect(client.process).toBeNull();
});
