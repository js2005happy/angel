// tests/node/test-schedule-agent-computer.test.ts
//
// 缺口 42 第三批（定时任务落电脑）测试：
//   - ScheduleTask 加可选 agent（与 BotPolicy 的 agent 同口径，非法值在
//     添加时拒绝；旧任务文件没这个字段时为 null，行为不变）；
//   - resolveAgentWorkdir（src/bot/binding.ts）：没指定 agent 回退；有 Soul
//     有电脑用电脑 workspace；有 Soul 没电脑自动建一台；没 Soul 回退；
//     休眠的电脑先唤醒再跑。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScheduleError, validateTask, loadSchedule, saveSchedule, addScheduleTask,
} from "../../src/scheduler.ts";
import { resolveAgentWorkdir } from "../../src/bot/binding.ts";
import {
  createComputer, computerWorkspacePath, getComputer, listComputers,
  sleepComputer, type BotComputer,
} from "../../src/bot/computer.ts";
import { defaultSoul, saveSoul } from "../../src/soul.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-schedule-agent-computer-"));
}

function withSoulAndComputer(home: string, agent: string): BotComputer {
  saveSoul(home, defaultSoul(agent));
  return createComputer(home, { agent });
}

describe("定时任务 agent 字段（缺口 42 第三批）", () => {
  test("validateTask 接受合法 agent，字段保留", () => {
    const t = validateTask({ name: "a", prompt: "x", every_seconds: 60, agent: "nyra" });
    expect(t.agent).toBe("nyra");
  });

  test("validateTask 拒绝非法 agent", () => {
    for (const bad of ["Nyra", "a b", "a".repeat(33), 123, ""]) {
      expect(() => validateTask({ name: "a", prompt: "x", every_seconds: 60, agent: bad })).toThrow(ScheduleError);
    }
  });

  test("旧任务文件没 agent 字段：加载后为 null，行为不变", () => {
    const home = tmpHome();
    try {
      const path = join(home, "schedule.json");
      writeFileSync(path, JSON.stringify({ tasks: [{ name: "old", prompt: "x", every_seconds: 60 }] }), "utf-8");
      const loaded = loadSchedule(path);
      expect(loaded.tasks).toHaveLength(1);
      expect(loaded.tasks[0].agent).toBe(null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("addScheduleTask 保留 agent，save/load 往返不丢", () => {
    const home = tmpHome();
    try {
      const path = join(home, "schedule.json");
      const data = { tasks: [] as never[] };
      addScheduleTask(data as never, { name: "a", prompt: "x", every_seconds: 60, agent: "nyra" });
      saveSchedule(data as never, path);
      const loaded = loadSchedule(path);
      expect(loaded.tasks[0].agent).toBe("nyra");
      expect(JSON.parse(readFileSync(path, "utf-8")).tasks[0].agent).toBe("nyra");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveAgentWorkdir（缺口 42 第三批）", () => {
  test("没指定 agent：回退目录，computerId 为 null", () => {
    const home = tmpHome();
    try {
      const fallback = join(home, "launch-dir");
      const r = resolveAgentWorkdir(home, null, fallback);
      expect(r).toEqual({ workdir: fallback, computerId: null });
      expect(resolveAgentWorkdir(home, undefined, fallback)).toEqual({ workdir: fallback, computerId: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("有 Soul 有电脑：用电脑 workspace", () => {
    const home = tmpHome();
    try {
      const computer = withSoulAndComputer(home, "nyra");
      const r = resolveAgentWorkdir(home, "nyra", join(home, "launch-dir"));
      expect(r.workdir).toBe(computerWorkspacePath(home, computer));
      expect(r.computerId).toBe(computer.id);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("有 Soul 没电脑：自动建一台，跑在新电脑 workspace 里", () => {
    const home = tmpHome();
    try {
      saveSoul(home, defaultSoul("nyra"));
      expect(listComputers(home)).toHaveLength(0);
      const r = resolveAgentWorkdir(home, "nyra", join(home, "launch-dir"));
      expect(listComputers(home)).toHaveLength(1);
      const computer = listComputers(home)[0];
      expect(r.workdir).toBe(computerWorkspacePath(home, computer));
      expect(r.computerId).toBe(computer.id);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("没 Soul：回退目录，不建电脑", () => {
    const home = tmpHome();
    try {
      const fallback = join(home, "launch-dir");
      const r = resolveAgentWorkdir(home, "nyra", fallback);
      expect(r).toEqual({ workdir: fallback, computerId: null });
      expect(listComputers(home)).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("休眠的电脑：先唤醒再跑", () => {
    const home = tmpHome();
    try {
      const computer = withSoulAndComputer(home, "nyra");
      sleepComputer(home, computer.id);
      expect(getComputer(home, computer.id).state).toBe("sleeping");
      const r = resolveAgentWorkdir(home, "nyra", join(home, "launch-dir"));
      expect(getComputer(home, computer.id).state).toBe("active");
      expect(r.workdir).toBe(computerWorkspacePath(home, computer));
      expect(r.computerId).toBe(computer.id);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
