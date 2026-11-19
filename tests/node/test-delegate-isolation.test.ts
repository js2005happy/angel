// tests/node/test-delegate-isolation.test.ts — S4：子 Agent 的隔离 / 白名单 / 模型。
// 只测父级 agent 侧能确定性验证的部分：
//   1) worktree 隔离会在独立工作树里跑，主工作区文件不受影响，结果里给出工作树路径
//   2) 非 git 目录请求 worktree 时明确报错，不静默降级
//   3) 工具白名单里写了不存在的工具名时，结果里明确提示"忽略未知工具名"
// 不测真实模型调用——子 Agent 用的是假 provider。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Agent } from "../../src/agent.ts";
import { echoProvider } from "./fake-provider.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-home-"));
}

function newAgent(workdir: string): Agent {
  return new Agent(echoProvider("子任务完成。"), {
    workdir,
    mode: "auto",
    maxTurns: 2,
    interactive: false,
    home: makeHome(),
    sessionId: null,
    skillsDirs: [],
    checkpointStore: null,
  } as never);
}

test("worktree 隔离：子任务在独立工作树里跑，主工作区不受影响", async () => {
  const repo = mkdtempSync(join(tmpdir(), "nyra-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "主工作区内容\n", "utf-8");
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: repo });

  const agent = newAgent(repo);
  const out = await agent.delegate("读一下 a.txt", 1, { isolation: "worktree" });

  // 结果里应给出独立工作树路径（无改动时会清理并说明，两种都算通过）
  expect(out.includes("worktree") || out.includes("工作树")).toBe(true);
  // 主工作区文件必须没被动过
  expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("主工作区内容\n");
});

test("非 git 目录请求 worktree：明确报错，不静默降级", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-nogit-"));
  const agent = newAgent(dir);
  const out = await agent.delegate("随便做点事", 1, { isolation: "worktree" });
  expect(out).toContain("worktree 隔离要求工作目录是 git 仓库");
});

test("工具白名单里的未知工具名会被明确指出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-tools-"));
  const agent = newAgent(dir);
  const out = await agent.delegate("只读任务", 1, { tools: ["read_file", "不存在的工具"] });
  expect(out).toContain("忽略未知工具名");
  expect(out).toContain("不存在的工具");
});

test("未配置多模型时，请求的 model 不会静默假装生效", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nyra-model-"));
  const agent = newAgent(dir);
  const out = await agent.delegate("跑个便宜模型", 1, { model: "some-cheap-model" });
  expect(out).toContain("未配置多模型");
  expect(out).toContain("some-cheap-model");
});
