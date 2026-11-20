// tests/node/test-cli-fresh-home.test.ts — 全新机器（空 home）上的 CLI 冒烟。
//
// 缺口：我一直在加命令，但从没有测试问过「**全新安装、没有任何配置**时它们能不能活着跑完」。
// 典型表现：某个命令默认假设 `~/.nyra` 里已有文件 → 首次使用直接抛错。
//
// 关键决定：**用子进程跑真 CLI**（`bun src/cli.ts …`），不在本进程调 `main()`。
// 原因（踩过）：`main()` 会留下模块级状态（配置/开关/env），同进程跑测试时污染到
// 别的测试文件（表现为「工具 schema 数多了一个」「MCP ≤ 8 却走了延迟加载」这类
// 看似无关的失败）。子进程天然隔离，而且更接近用户真实用法。
//
// 刻意排除：会起服务或循环的（ui / gw / task worker / schedule daemon）、
// 需要网络的（doctor）、交互式的（setup）、可能需要口令的（vault）。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(argv: string[], home: string, workdir: string): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...argv, "--workdir", workdir],
    env: {
      ...process.env,
      NYRA_HOME: home,
      // 每个用例独立 home，别让真实配置漏进来
      NYRA_CONFIG: join(home, "config.json"),
      // 关掉延迟加载的自动开启，避免受机器上 MCP 配置影响
      NYRA_LAZY_TOOLS: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function fresh(): { home: string; workdir: string } {
  return {
    home: mkdtempSync(join(tmpdir(), "nyra-fresh-home-")),
    workdir: mkdtempSync(join(tmpdir(), "nyra-fresh-wd-")),
  };
}

/** 只读/纯计算的子命令：全新 home 上必须活着跑完。 */
const SAFE_COMMANDS: string[][] = [
  ["--help"],
  ["--version"],
  ["verdict"],
  ["verdict", "--json"],
  ["guard"],
  ["savings"],
  ["cost", "--show"],
  ["stats"],
  ["features"],
  ["tools"],
  ["redlines"],
  ["models", "list"],
  ["config", "explain"],
  ["config", "explain", "cost_cap"],
  ["recall", "重构 auth 模块"],
  ["hooks", "list"],
  ["status"],
];

for (const argv of SAFE_COMMANDS) {
  test(`全新 home 冒烟：nyra ${argv.join(" ")}`, async () => {
    const { home, workdir } = fresh();
    try {
      const r = await runCli(argv, home, workdir);
      // 1) 不崩：退出码在已知范围内（崩了通常是 1 + stderr 有 stack）
      expect([0, 1, 2, 3, 4, 5, 130]).toContain(r.code);
      // 2) 不吐未捕获异常（子进程崩溃的典型特征）
      expect(r.stderr).not.toContain("Uncaught");
      expect(r.stderr).not.toContain("TypeError:");
      // 3) 非纯用法错误时必须说了点什么
      if (r.code !== 2) expect(r.stdout.trim().length).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  }, 60000);
}

test("未知子命令：退出码非 0 且给出用法提示", async () => {
  const { home, workdir } = fresh();
  try {
    const r = await runCli(["definitely-not-a-command"], home, workdir);
    expect(r.code).not.toBe(0);
    expect((r.stdout + r.stderr).length).toBeGreaterThan(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
}, 60000);

test("空 home 下 --help 一定打印内容（首次安装不能一片空白）", async () => {
  const { home, workdir } = fresh();
  try {
    const r = await runCli(["--help"], home, workdir);
    expect(r.stdout.length).toBeGreaterThan(100);
    expect(r.stdout).toContain("nyra");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
}, 60000);

test("空 home 下 verdict --json 输出可解析", async () => {
  const { home, workdir } = fresh();
  try {
    const r = await runCli(["verdict", "--json"], home, workdir);
    const line = r.stdout.trim().split("\n").pop() as string;
    const parsed = JSON.parse(line);
    expect(parsed.schema_version).toBe(1);
    expect(["green", "yellow", "red"]).toContain(parsed.grade);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
}, 60000);
