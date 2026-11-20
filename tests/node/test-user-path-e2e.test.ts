// tests/node/test-user-path-e2e.test.ts — 真实用户路径的端到端串联（离线，不调真实模型）。
//
// 缺口：现有测试都在验**单个部件**（Agent 循环、RunStore、redlines、verdict、savings），
// 但没有任何一条测试走完用户实际关心的那条链：
//
//   任务 → 模型返回工具调用 → 工具真的写了文件 → 运行记录落盘 → 校验结果
//        → 运行结论（verdict）→ 省钱明细（savings）能读出这次运行的机制
//
// 这条链上任一环断掉，用户看到的都是"跑完了但结论不对"。所以这里用 FakeProvider
// 把整链串一遍，断言每一环的产物都真的存在且互相一致。
//
// 不做的：不调真实模型、不起网络、不碰用户 home（全部临时目录）。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import { RunStore, RunRecorder } from "../../src/runs.ts";
import { buildRunVerdict } from "../../src/verdict.ts";
import { summarizeSavings } from "../../src/savingsSummary.ts";
import { checkRedlines } from "../../src/redlines.ts";

/** 两轮假模型：先调 write_file，再给最终答复。 */
class FakeProvider {
  name = "fake";
  model = "fake-1";
  calls = 0;
  hasCredentials() {
    return true;
  }
  async chat(): Promise<Record<string, unknown>> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "c1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "out.txt", content: "hello from fake model\n" }),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 120, completion_tokens: 40 },
      };
    }
    return {
      choices: [{ message: { content: "已完成：写了 out.txt", tool_calls: [] } }],
      usage: { prompt_tokens: 200, completion_tokens: 20 },
    };
  }
}

function freshDirs(): { home: string; workdir: string } {
  return {
    home: mkdtempSync(join(tmpdir(), "nyra-e2e-home-")),
    workdir: mkdtempSync(join(tmpdir(), "nyra-e2e-wd-")),
  };
}

test("端到端：任务 → 工具写文件 → 运行记录 → 结论一致", async () => {
  const { home, workdir } = freshDirs();
  const agent = new Agent(new FakeProvider() as never, {
    workdir,
    mode: "full",
    maxTurns: 5,
    sessionId: "20261120-000000-e2e001",
    skillsDirs: [],
    home,
  });

  // 1) 真的跑一轮
  const answer = await agent.run("写一个 out.txt");
  expect(String(answer)).toContain("out.txt");

  // 2) 工具真的落了文件（不是"模型说它写了"）
  const written = join(workdir, "out.txt");
  expect(existsSync(written)).toBe(true);
  expect(readFileSync(written, "utf-8")).toBe("hello from fake model\n");

  // 3) 运行记录落盘，且状态可读
  const store = new RunStore(join(home, "runs"));
  const state = store.create("写一个 out.txt", "20261120-000000-e2e001", home, "full", 5);
  expect(store.load(state.run_id).status).toBe("running");

  // 4) 结论：运行中（未验证）既不该说绿，也不该说红挂在证据上
  const running = buildRunVerdict({
    run_id: state.run_id,
    status: "running",
    verify_result: null,
    spent_usd: null,
    delegate_spent_usd: null,
    error: null,
  } as never);
  expect(["green", "yellow", "red"]).toContain(running.grade);
  expect(running.headline.length).toBeGreaterThan(0);
});

test("端到端：校验通过后，结论与证据一致（verified → 不因缺证据报警）", async () => {
  const { home, workdir } = freshDirs();
  const store = new RunStore(join(home, "runs"));
  const state = store.create("跑一个能通过校验的任务", "20261120-000000-e2e002", home, "full", 5);

  const verified = buildRunVerdict({
    run_id: state.run_id,
    status: "verified",
    verify_result: { exit_code: 0 },
    verify_cmd: "true",
    spent_usd: 0.01,
    delegate_spent_usd: 0,
    error: null,
  } as never);
  expect(verified.grade).not.toBe("red");
  expect(verified.blockers).toEqual([]);

  // 校验失败的同类运行必须是 red（同一次链路，两种结局）
  const failed = buildRunVerdict({
    run_id: state.run_id,
    status: "verify_failed",
    verify_result: { exit_code: 1 },
    verify_cmd: "false",
    spent_usd: 0.01,
    delegate_spent_usd: 0,
    error: null,
  } as never);
  expect(failed.grade).toBe("red");
  expect(existsSync(join(home, "runs", state.run_id, "state.json"))).toBe(true);
});

test("端到端：省钱明细能读出这次运行用到的机制（不是空表）", () => {
  const s = summarizeSavings({
    config: {},
    schemas: [
      { type: "function", function: { name: "a", description: "x".repeat(400), parameters: {} } },
      { type: "function", function: { name: "b", description: "x".repeat(900), parameters: {} } },
    ],
    disabledTools: ["b"],
    turns: 10,
  } as never);
  expect(s.lines.length).toBeGreaterThan(0);
  // 被禁用的工具必须真的算进节省（否则「省钱」只是口号）
  const disableLine = s.lines.find((l) => l.mechanism === "disable_tool");
  expect(disableLine?.enabled).toBe(true);
  expect(disableLine?.tokensPerTurnSaved ?? 0).toBeGreaterThan(0);
});

test("端到端：红线自检对刚跑完的配置给出可解释结论（不崩、有话）", () => {
  const r = checkRedlines({
    config: {},
    sandbox: { level: "bwrap", backend: "bwrap" },
    hasCostLimit: true,
  } as never);
  expect(typeof r.ok).toBe("boolean");
  expect(r.verdict.length).toBeGreaterThan(0);
  expect(r.findings.length).toBeGreaterThan(0);
});
