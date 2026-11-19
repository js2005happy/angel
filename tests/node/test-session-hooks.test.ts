// tests/node/test-session-hooks.test.ts — SessionStart/SessionEnd 会话钩子接线（调研报告第 1 项）。
// CLI REPL 与网关会话生命周期触发点；用临时 home + 假 .sh 钩子脚本记录调用，
// 禁止依赖真实用户 home。超时约定与 runHooks 一致：config.json hooks.timeout_ms
//（默认 10 秒，夹到 1–120 秒），fail-open，退出码 2 在这两个事件上只通知不拦截。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Gateway } from "../../src/gateway.ts";
import { echoProvider } from "./fake-provider.ts";

const savedHooksEnv = process.env.NYRA_HOOKS;

beforeEach(() => {
  delete process.env.NYRA_HOOKS;
});

afterEach(() => {
  if (savedHooksEnv === undefined) delete process.env.NYRA_HOOKS;
  else process.env.NYRA_HOOKS = savedHooksEnv;
});

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function waitFor(fn: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitRunDone(run: { status: string }, timeoutMs = 10000): Promise<void> {
  await waitFor(() => run.status === "done" || run.status === "error", timeoutMs);
}

/** 在 <home>/hooks/<event>.d/ 下写一个可执行钩子脚本（路径可写死在脚本里）。 */
function writeHook(home: string, event: "SessionStart" | "SessionEnd", name: string, body: string): string {
  const dir = join(home, "hooks", `${event}.d`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body, "utf-8");
  chmodSync(path, 0o755);
  return path;
}

function markerLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim() !== "");
}

function makeGateway(home: string, workdir: string) {
  return new Gateway({
    home, workdir, mode: "full",
    providerFactory: () => echoProvider(),
    config: { mcp_enabled: false, fallback_enabled: false },
  });
}

test("网关会话钩子：新建会话触发 SessionStart，关停触发 SessionEnd", async () => {
  const home = tmpDir("nyra-gw-hooks-home-");
  const workdir = tmpDir("nyra-gw-hooks-wd-");
  const marker = join(workdir, "hooks.log");
  writeHook(home, "SessionStart", "log.sh", `#!/bin/sh\necho start >> "${marker}"\nexit 0\n`);
  writeHook(home, "SessionEnd", "log.sh", `#!/bin/sh\necho end >> "${marker}"\nexit 0\n`);
  const gw = makeGateway(home, workdir);
  gw.newSession();
  await waitFor(() => markerLines(marker).includes("start"));
  expect(markerLines(marker)).toEqual(["start"]);
  await gw.stop();
  expect(markerLines(marker)).toEqual(["start", "end"]);
});

test("网关会话钩子：同一会话多次 send 只触发一次 SessionStart", async () => {
  const home = tmpDir("nyra-gw-hooks-home-");
  const workdir = tmpDir("nyra-gw-hooks-wd-");
  const marker = join(workdir, "hooks.log");
  writeHook(home, "SessionStart", "log.sh", `#!/bin/sh\necho start >> "${marker}"\nexit 0\n`);
  const gw = makeGateway(home, workdir);
  const id = gw.newSession();
  const run1 = gw.send(id, "你好");
  await waitRunDone(run1);
  expect(run1.status).toBe("done");
  const run2 = gw.send(id, "再说一遍");
  await waitRunDone(run2);
  expect(run2.status).toBe("done");
  await waitFor(() => markerLines(marker).length >= 1);
  // 给 fire-and-forget 的钩子留半秒，确认没有第二遍。
  await new Promise((r) => setTimeout(r, 500));
  expect(markerLines(marker)).toEqual(["start"]);
  await gw.stop();
});

test("网关会话钩子：无钩子时新建、发送、关停都不阻塞", async () => {
  const home = tmpDir("nyra-gw-hooks-home-");
  const workdir = tmpDir("nyra-gw-hooks-wd-");
  const started = Date.now();
  const gw = makeGateway(home, workdir);
  const id = gw.newSession();
  const run = gw.send(id, "你好");
  await waitRunDone(run);
  expect(run.status).toBe("done");
  await gw.stop();
  expect(Date.now() - started).toBeLessThan(10000);
});

test("网关会话钩子：SessionStart 钩子超时不阻塞 send", async () => {
  const home = tmpDir("nyra-gw-hooks-home-");
  const workdir = tmpDir("nyra-gw-hooks-wd-");
  const marker = join(workdir, "hooks.log");
  // 先记一笔再睡 30 秒：主流程不等它睡完（timeout_ms=1000 时杀掉）。
  writeHook(home, "SessionStart", "slow.sh", `#!/bin/sh\necho start >> "${marker}"\nsleep 30\nexit 0\n`);
  writeFileSync(join(home, "config.json"), JSON.stringify({ hooks: { timeout_ms: 1000 } }), "utf-8");
  const gw = makeGateway(home, workdir);
  const started = Date.now();
  const id = gw.newSession();
  const run = gw.send(id, "你好");
  await waitRunDone(run);
  expect(run.status).toBe("done");
  await waitFor(() => markerLines(marker).includes("start"));
  expect(Date.now() - started).toBeLessThan(15000);
  await gw.stop();
});

test("网关会话钩子：SessionEnd 钩子退出码 2 也不拦截关停", async () => {
  const home = tmpDir("nyra-gw-hooks-home-");
  const workdir = tmpDir("nyra-gw-hooks-wd-");
  const marker = join(workdir, "hooks.log");
  writeHook(home, "SessionStart", "log.sh", `#!/bin/sh\necho start >> "${marker}"\nexit 0\n`);
  writeHook(home, "SessionEnd", "nope.sh", `#!/bin/sh\necho end >> "${marker}"\nexit 2\n`);
  const gw = makeGateway(home, workdir);
  gw.newSession();
  await waitFor(() => markerLines(marker).includes("start"));
  const started = Date.now();
  await gw.stop();
  expect(markerLines(marker)).toEqual(["start", "end"]);
  expect(Date.now() - started).toBeLessThan(10000);
});

/** 以子进程跑一次 CLI REPL：管道喂 /exit，ollama provider 不需要真实凭证、不联网。 */
function runReplCli(home: string, workdir: string, input: string, timeoutMs = 60000) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, NYRA_HOME: join(home, ".nyra") };
  delete env.NYRA_HOOKS;
  // 沙箱环境变量可能被外层带进来：REPL 钩子测试不关心沙箱，清掉避免 fail-closed 干扰。
  for (const k of ["NYRA_SANDBOX", "ANGEL_SANDBOX", "NYRA_SANDBOX_MODE", "ANGEL_SANDBOX_MODE"]) delete env[k];
  return spawnSync("bun", ["run", join(process.cwd(), "src/cli.ts"), "--provider", "ollama", "--workdir", workdir], {
    cwd: process.cwd(),
    env: env as Record<string, string>,
    input,
    encoding: "utf-8",
    timeout: timeoutMs,
  });
}

test("CLI REPL 会话钩子：启动触发 SessionStart，/exit 触发 SessionEnd", () => {
  const home = tmpDir("nyra-repl-hooks-home-");
  const nyraHome = join(home, ".nyra");
  const workdir = tmpDir("nyra-repl-hooks-wd-");
  const marker = join(workdir, "hooks.log");
  writeHook(nyraHome, "SessionStart", "log.sh", `#!/bin/sh\necho start >> "${marker}"\nexit 0\n`);
  writeHook(nyraHome, "SessionEnd", "log.sh", `#!/bin/sh\necho end >> "${marker}"\nexit 0\n`);
  const r = runReplCli(home, workdir, "/exit\n");
  expect(r.status).toBe(0);
  expect(markerLines(marker)).toEqual(["start", "end"]);
}, 30000);

test("CLI REPL 会话钩子：无钩子时 /exit 快速退出", () => {
  const home = tmpDir("nyra-repl-hooks-home-");
  const workdir = tmpDir("nyra-repl-hooks-wd-");
  const started = Date.now();
  const r = runReplCli(home, workdir, "/exit\n");
  expect(r.status).toBe(0);
  expect(Date.now() - started).toBeLessThan(30000);
}, 30000);

test("CLI REPL 会话钩子：会话钩子超时不阻塞启动与退出", () => {
  const home = tmpDir("nyra-repl-hooks-home-");
  const nyraHome = join(home, ".nyra");
  const workdir = tmpDir("nyra-repl-hooks-wd-");
  const marker = join(workdir, "hooks.log");
  writeHook(nyraHome, "SessionStart", "slow.sh", `#!/bin/sh\necho start >> "${marker}"\nsleep 30\nexit 0\n`);
  writeHook(nyraHome, "SessionEnd", "slow.sh", `#!/bin/sh\necho end >> "${marker}"\nsleep 30\nexit 0\n`);
  writeFileSync(join(nyraHome, "config.json"), JSON.stringify({ hooks: { timeout_ms: 1000 } }), "utf-8");
  const started = Date.now();
  const r = runReplCli(home, workdir, "/exit\n");
  expect(r.status).toBe(0);
  expect(markerLines(marker)).toEqual(["start", "end"]);
  // 两个钩子各睡 30 秒：若阻塞，主流程至少 60 秒；超时杀掉后只需约 4 秒。
  expect(Date.now() - started).toBeLessThan(20000);
}, 30000);
