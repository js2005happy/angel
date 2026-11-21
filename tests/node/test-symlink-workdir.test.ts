// tests/node/test-symlink-workdir.test.ts — 软链工作目录回归（CI #494）。
//
// 第一轮修补（CI #491）把 workspaceReadPath/workspaceWritePath/workspaceShellCwd
// 的返回值改成了 realpath 规范化后的真实路径，修好了 macOS :614，却让下游按
// 字符串比较路径的部件认不出同一文件：CheckpointStore.relativePath 拿真实路径
// 去比词法 workdir，抛“目标路径不在工作目录内”，检查点写入失败，文件根本没
// 写出来——macOS 上 12 项回归（test-runs、test-resume-idempotent、
// test-user-path-e2e、test-agent、test-bot-approval、test-gateway-desktop、
// test-usage-heatmap-monthly、test-skill-sedimentation）。
//
// 正确契约：越界比较时两边都过 realpath，但返回给调用方的必须是调用方拼写的
// 原始路径。本文件在 Linux 上用软链复现 macOS 的 /var → /private/var 形状，
// 覆盖写文件落盘、changed_files、拼写不变、检查点直通四类回归点。
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import { CheckpointStore } from "../../src/checkpoints.ts";
import { RunStore, RunRecorder } from "../../src/runs.ts";
import { workspaceReadPath, workspaceWritePath, newToolContext, type ToolContext } from "../../src/tools.ts";

class FakeWriteProvider {
  name = "fake"; model = "fake-1"; calls = 0;
  hasCredentials() { return true; }
  async chat(): Promise<Record<string, unknown>> {
    this.calls += 1;
    if (this.calls === 1) {
      return { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "new\n" }) } }] } }] };
    }
    return { choices: [{ message: { content: "done", tool_calls: [] } }] };
  }
}

/** 建一对“真实目录 + 指向它的软链”，返回 { real, link }，用完由调用方清理。 */
function symlinkPair(tag: string): { real: string; link: string } {
  const real = mkdtempSync(join(tmpdir(), `nyra-sym-real-${tag}-`));
  const link = join(tmpdir(), `nyra-sym-link-${tag}-${Date.now()}-${process.pid}`);
  symlinkSync(real, link);
  return { real, link };
}

function cleanupPair(p: { real: string; link: string }): void {
  rmSync(p.link, { force: true });
  rmSync(p.real, { recursive: true, force: true });
}

test("Agent 写文件：软链工作目录下文件真的落盘且 changed_files 一致（CI #494）", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-sym-home-"));
  const pair = symlinkPair("wd");
  const workdir = pair.link;
  try {
    writeFileSync(join(workdir, "a.txt"), "original\n");
    const agent = new Agent(new FakeWriteProvider() as never, {
      workdir, mode: "full", maxTurns: 5, sessionId: "20261121-000000-sym1",
      skillsDirs: [], home,
    });
    const store = new RunStore(join(home, "runs"));
    const rec = new RunRecorder(store, agent, "写 a.txt", { verifyCmd: null });
    const out = await rec.run("写 a.txt");
    expect(out).toContain("done");
    // 文件真的被新内容覆盖（不是“模型说它写了”），词法路径与真实路径读到同一份。
    expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("new\n");
    expect(readFileSync(join(pair.real, "a.txt"), "utf-8")).toBe("new\n");
    const final = store.load(rec.runId);
    expect(final.changed_files).toContain("a.txt");
    expect(existsSync(join(workdir, "a.txt"))).toBe(true);
  } finally {
    cleanupPair(pair);
    rmSync(home, { recursive: true, force: true });
  }
});

test("workspaceWritePath/workspaceReadPath：返回调用方拼写，不改写成真实路径（CI #494）", () => {
  const pair = symlinkPair("spelling");
  const home = mkdtempSync(join(tmpdir(), "nyra-sym-home-"));
  try {
    writeFileSync(join(pair.real, "t.txt"), "hello");
    const ctxLink = { workdir: pair.link, home, mode: "auto", interactive: false } as unknown as ToolContext;
    const ctxReal = { workdir: pair.real, home, mode: "auto", interactive: false } as unknown as ToolContext;
    // 写路径：按调用方给的拼写原样返回，不改成真实路径。
    expect(workspaceWritePath(ctxLink, "a.txt")).toBe(join(pair.link, "a.txt"));
    expect(workspaceWritePath(ctxReal, "a.txt")).toBe(join(pair.real, "a.txt"));
    // 读路径：输入什么拼写就返回什么拼写，只做越界判断。
    expect(workspaceReadPath(ctxLink, join(pair.link, "t.txt"))).toBe(join(pair.link, "t.txt"));
    expect(workspaceReadPath(ctxLink, join(pair.real, "t.txt"))).toBe(join(pair.real, "t.txt"));
    expect(workspaceReadPath(ctxReal, join(pair.link, "t.txt"))).toBe(join(pair.link, "t.txt"));
    // 越界比较仍用真实路径：软链两侧的同一目录可读，目录外仍拒绝。
    expect(() => workspaceReadPath(ctxLink, join(pair.real, "t.txt"))).not.toThrow();
    const outside = mkdtempSync(join(tmpdir(), "nyra-sym-outside-"));
    try {
      expect(() => workspaceReadPath(ctxLink, join(outside, "secret.txt"))).toThrow(/只能访问工作目录内/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    cleanupPair(pair);
    rmSync(home, { recursive: true, force: true });
  }
});

test("CheckpointStore.writeText：接 workspaceWritePath 的返回值不抛错（CI #494）", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-sym-home-"));
  const pair = symlinkPair("ckpt");
  try {
    const ctx = newToolContext({ workdir: pair.link, home, mode: "auto", interactive: false });
    const target = workspaceWritePath(ctx, "a.txt");
    const store = new CheckpointStore(join(home, "checkpoints"), "sess-1", pair.link);
    expect(() => store.writeText(target, "new\n")).not.toThrow();
    expect(store.filesChangedSince(0)).toContain("a.txt");
    expect(readFileSync(join(pair.link, "a.txt"), "utf-8")).toBe("new\n");
  } finally {
    cleanupPair(pair);
    rmSync(home, { recursive: true, force: true });
  }
});

test("workspaceShellCwd：软链工作目录下返回原始拼写且可执行（CI #494）", async () => {
  const { workspaceShellCwd } = await import("../../src/tools.ts");
  const pair = symlinkPair("shell");
  const home = mkdtempSync(join(tmpdir(), "nyra-sym-home-"));
  try {
    mkdirSync(join(pair.real, "sub"), { recursive: true });
    const ctx = { workdir: pair.link, home, mode: "auto", interactive: false } as unknown as ToolContext;
    expect(workspaceShellCwd(ctx, null)).toBe(pair.link);
    expect(workspaceShellCwd(ctx, "sub")).toBe(join(pair.link, "sub"));
  } finally {
    cleanupPair(pair);
    rmSync(home, { recursive: true, force: true });
  }
});
