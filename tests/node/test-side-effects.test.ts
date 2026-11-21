// tests/node/test-side-effects.test.ts — DSH-4 先存后做 + 重启恢复。
// 钉住的事：
//   - 先存后做：record → pending，mark 改状态、非 pending 不可再标；
//   - 恢复按年龄从老到新：已做过的不重复执行、没做过的重做、重做失败标 failed、
//     没执行器只写 recovery note、不擅自标 done；
//   - recovery note 含目录与 git 只读信息；
//   - 已读/未读跨重启保留：恢复绝不碰收件箱；
//   - 账本往返（原子写 0600、损坏先备份再抛错）；CLI 端到端。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { appendInbox, loadInbox, markInboxRead } from "../../src/tasks.ts";
import {
  recordSideEffect, getSideEffect, listSideEffects, markSideEffect,
  recoverSideEffects, buildRecoveryNote, sideEffectsPath, SideEffectError,
} from "../../src/sideEffects.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(home: string, args: string[]) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh" },
  });
}

test("SideEffectsTest.test_record_list_mark_validation", () => {
  const home = tmpHome("nyra-sidefx-");
  const effect = recordSideEffect(home, { description: "把报告发到群里", kind: "external_send", target: "telegram:100" });
  expect(effect.id).toMatch(/^se_[0-9a-f]{12}$/);
  expect(effect.status).toBe("pending");
  expect(listSideEffects(home)).toHaveLength(1);
  expect(getSideEffect(home, effect.id).description).toBe("把报告发到群里");
  expectPerms(sideEffectsPath(home), 0o600);
  expect(() => recordSideEffect(home, { description: "" })).toThrow(SideEffectError);
  expect(() => recordSideEffect(home, { description: "x", kind: "nope" as never })).toThrow(SideEffectError);
  const done = markSideEffect(home, effect.id, "done", "已发");
  expect(done.status).toBe("done");
  expect(done.recoveryNote).toBe("已发");
  expect(() => markSideEffect(home, effect.id, "done")).toThrow(SideEffectError);
  expect(() => getSideEffect(home, "se_missing")).toThrow(SideEffectError);
});

test("SideEffectsTest.test_store_corrupt_backup", () => {
  const home = tmpHome("nyra-sidefx-");
  recordSideEffect(home, { description: "写文件" });
  writeFileSync(sideEffectsPath(home), "not json{");
  expect(() => listSideEffects(home)).toThrow(SideEffectError);
  expect(readdirSync(home).filter((f) => f.startsWith("side-effects.json.corrupt-"))).toHaveLength(1);
});

test("SideEffectsTest.test_build_recovery_note_readonly_checks", () => {
  const home = tmpHome("nyra-sidefx-");
  const note = buildRecoveryNote(home);
  expect(note).toContain("工作目录存在");
  expect(note).toContain("不是 git 仓库");
  const gone = buildRecoveryNote(join(home, "no-such-dir"));
  expect(gone).toContain("工作目录已不存在");
  // git 仓库：最近提交与干净工作区都读得到（只读，不改东西）。
  const repo = tmpHome("nyra-sidefx-repo-");
  spawnSync("git", ["init", "-q", repo], { encoding: "utf-8" });
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t.t"], { encoding: "utf-8" });
  spawnSync("git", ["-C", repo, "config", "user.name", "t"], { encoding: "utf-8" });
  writeFileSync(join(repo, "a.txt"), "hi\n");
  spawnSync("git", ["-C", repo, "add", "."], { encoding: "utf-8" });
  spawnSync("git", ["-C", repo, "commit", "-qm", "first"], { encoding: "utf-8" });
  const repoNote = buildRecoveryNote(repo);
  expect(repoNote).toContain("最近提交：");
  expect(repoNote).toContain("first");
  expect(repoNote).toContain("工作区干净");
});

test("SideEffectsTest.test_recover_oldest_first_no_double_execution", async () => {
  const home = tmpHome("nyra-sidefx-");
  const first = recordSideEffect(home, { description: "第一件：发消息" });
  const second = recordSideEffect(home, { description: "第二件：写文件" });
  const third = recordSideEffect(home, { description: "第三件：调接口" });
  const order: string[] = [];
  const executed: string[] = [];
  const report = await recoverSideEffects(home, {
    workdir: home,
    executor: {
      check: (e) => (e.id === first.id ? "already-done" : "not-done"),
      execute: async (e) => {
        order.push(e.id);
        if (e.id === third.id) throw new Error("接口挂了");
        executed.push(e.id);
      },
    },
  });
  expect(report.total).toBe(3);
  expect(report.alreadyDone).toEqual([first.id]);
  expect(report.executed).toEqual([second.id]);
  expect(report.failed).toEqual([third.id]);
  // 按年龄从老到新：执行顺序是 second → third（first 已做过，跳过）。
  expect(order).toEqual([second.id, third.id]);
  expect(getSideEffect(home, first.id).status).toBe("done");
  expect(getSideEffect(home, first.id).recoveryNote).toContain("已做过，不重复执行");
  expect(getSideEffect(home, second.id).status).toBe("done");
  expect(getSideEffect(home, third.id).status).toBe("failed");
  expect(getSideEffect(home, third.id).recoveryNote).toContain("接口挂了");
});

test("SideEffectsTest.test_recover_without_executor_leaves_pending", async () => {
  const home = tmpHome("nyra-sidefx-");
  const effect = recordSideEffect(home, { description: "没人能执行的副作用" });
  const report = await recoverSideEffects(home, { workdir: home });
  expect(report).toEqual({ total: 1, alreadyDone: [], executed: [], failed: [], leftPending: [effect.id] });
  const row = getSideEffect(home, effect.id);
  expect(row.status).toBe("pending");
  expect(row.recoveryNote).toContain("没有执行器，留待人工处理");
});

test("SideEffectsTest.test_recover_never_touches_inbox_read_flags", async () => {
  const home = tmpHome("nyra-sidefx-");
  recordSideEffect(home, { description: "一件副作用" });
  appendInbox("run-1", "failed", "任务失败了", home);
  appendInbox("run-2", "ok", "任务好了", home);
  expect(markInboxRead(home)).toBe(2);
  await recoverSideEffects(home, { workdir: home });
  const items = loadInbox(home);
  expect(items).toHaveLength(2);
  expect(items.every((i) => i.read === true)).toBe(true);
  expect(loadInbox(home, true)).toHaveLength(0);
});

test("SideEffectsTest.test_cli_end_to_end", () => {
  const home = tmpHome("nyra-sidefx-");
  const created = runCli(home, ["side-effects", "record", "CLI 副作用", "--kind", "shell", "--target", "ls"]);
  expect(created.status).toBe(0);
  const id = created.stdout.trim();
  expect(id).toMatch(/^se_[0-9a-f]{12}$/);
  expect(runCli(home, ["side-effects", "list"]).stdout).toContain(id);
  expect(runCli(home, ["side-effects", "mark", id, "done"]).status).toBe(0);
  const recovered = runCli(home, ["side-effects", "recover"]);
  expect(recovered.status).toBe(0);
  expect(recovered.stdout).toContain("pending 0 项");
  expect(runCli(home, ["side-effects", "nope"]).status).toBe(2);
});
