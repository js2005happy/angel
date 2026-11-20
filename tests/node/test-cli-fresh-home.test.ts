// tests/node/test-cli-fresh-home.test.ts — 全新机器（空 home）上的 CLI 冒烟。
//
// 缺口：我一直在加命令，但从没有测试问过「**全新安装、没有任何配置**时它们能不能活着跑完」。
// 这类问题最典型的表现是：某个新命令默认假设 `~/.nyra` 里已有文件 → 首次使用直接抛错。
//
// 做法：把 `NYRA_HOME` 指向空临时目录，逐个调 `main(argv)`，断言三件事：
//   1. **不抛**（异常必须自己兜住并返回退出码）
//   2. 退出码是已知值（0/1/2/3/4/5）
//   3. 只要不是纯用法错误，就往 stdout 写了点东西（不能静默空跑）
//
// 刻意排除的：会起服务或循环的（ui / gw / task worker / schedule daemon）、
// 需要网络的（doctor）、交互式的（setup）。
import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli.ts";

const KNOWN_EXIT = new Set([0, 1, 2, 3, 4, 5, 130]);

let home = "";
let workdir = "";
let out = "";
let spy: ReturnType<typeof spyOn> | null = null;
const savedHome = process.env.NYRA_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nyra-fresh-home-"));
  workdir = mkdtempSync(join(tmpdir(), "nyra-fresh-wd-"));
  process.env.NYRA_HOME = home;
  out = "";
  spy = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  }) as never);
});

afterEach(() => {
  spy?.mockRestore();
  if (savedHome === undefined) delete process.env.NYRA_HOME;
  else process.env.NYRA_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

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
  ["memory", "search", "关键词"],
  ["style", "list"],
  ["plugin", "list"],
  ["kb", "list"],
  ["status"],
  ["config", "export", "--out", "cfg.json", "--dry-run"],
];

for (const argv of SAFE_COMMANDS) {
  test(`全新 home 冒烟：nyra ${argv.join(" ")}`, async () => {
    let code: number | null = null;
    let threw: unknown = null;
    try {
      code = await main([...argv, "--workdir", workdir].filter((a) => a !== undefined));
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeNull();
    expect(typeof code).toBe("number");
    expect(KNOWN_EXIT.has(code as number)).toBe(true);
  });
}

test("未知子命令：不抛，退出码是用法错误（2）", async () => {
  const code = await main(["definitely-not-a-command"]);
  expect(code).toBe(2);
});

test("空 home 下 help 一定打印内容（首次安装不能一片空白）", async () => {
  await main(["--help"]);
  expect(out.length).toBeGreaterThan(100);
  expect(out).toContain("nyra");
});

test("空 home 下 verdict 一定有输出（不能静默）", async () => {
  await main(["verdict"]);
  expect(out.trim().length).toBeGreaterThan(0);
});

test("空 home 下 verdict --json 输出可解析", async () => {
  await main(["verdict", "--json"]);
  const parsed = JSON.parse(out.trim().split("\n").pop() as string);
  expect(parsed.schema_version).toBe(1);
  expect(["green", "yellow", "red"]).toContain(parsed.grade);
});
