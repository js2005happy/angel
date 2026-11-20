// tests/node/test-bot-computer.test.ts — 缺口 42 第一批：每 Bot 一台持久电脑。
// 钉住的事：
//   - 创建须已有 Soul、每 agent 一台、共享须记下谁接受；
//   - 账本往返（原子写 0600、损坏先备份再抛错）、隔离判定三档（allow/ask/deny）；
//   - 内存上限拒绝（注入小内存才可确定性测）、休眠/唤醒与 sleep-due；
//   - 凭证 Vault 存列删（列表只给掩码、明文只进应用层代填）、删电脑清凭证与目录；
//   - 浏览器访问只记 host、shell 经假 bwrap（不依赖真实 bwrap）；
//   - 活动账本 + 运行事件镜像（EVENT_FIELDS 已注册）与时间线渲染；
//   - CLI 端到端（含 --yes 门与注入的 secret/confirm）。
import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline } from "../../src/timeline.ts";
import { defaultSoul, saveSoul } from "../../src/soul.ts";
import {
  ComputerError,
  checkComputerAccess,
  computerCredentialEntry,
  computerResourceSummary,
  computersDueForSleep,
  createComputer,
  getComputer,
  getComputerCredential,
  handleComputer,
  listComputerCredentials,
  listComputers,
  loadComputerProfile,
  loadComputerStore,
  computerStorePath,
  computerWorkspacePath,
  computerProfilePath,
  readComputerActivity,
  recordBrowserVisit,
  recordComputerActivity,
  removeComputer,
  runComputerShell,
  saveComputerProfile,
  saveComputerStore,
  sleepComputer,
  sleepDueComputers,
  storeComputerCredential,
  wakeComputer,
} from "../../src/bot/computer.ts";
import { handleBot } from "../../src/bot/index.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withSoul(home: string, agent: string): void {
  saveSoul(home, defaultSoul(agent));
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const origWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
    out += String(chunk);
    return true;
  };
  try {
    const code = await fn();
    return { code, out };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = origWrite;
  }
}

/** PATH 里放一个假 bwrap：把最后一个参数当 shell 命令跑（与 test-sandbox.test.ts 同款）。 */
function makeBwrapShim(): { dir: string } {
  const dir = tmpHome("nyra-bwrap-shim-");
  writeFileSync(join(dir, "bwrap"), "#!/bin/sh\nfor last; do :; done\nsh -c \"$last\"\n", "utf-8");
  chmodSync(join(dir, "bwrap"), 0o755);
  return { dir };
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("BotComputerTest.test_create_requires_existing_soul", () => {
  const home = tmpHome("nyra-computer-");
  expect(() => createComputer(home, { agent: "ghost" })).toThrow("nyra soul init ghost");
  expect(() => createComputer(home, { agent: "Bad Name" })).toThrow();
  withSoul(home, "nyra");
  const c = createComputer(home, { agent: "nyra" });
  expect(c.id).toMatch(/^cmp_[0-9a-f]{12}$/);
  expect(c.agent).toBe("nyra");
  expect(c.state).toBe("active");
  expect(c.isolation).toBe("dedicated");
  expect(c.workspace).toBe(`computers/${c.id}/workspace`);
  expect(c.profile).toBe(`computers/${c.id}/profile`);
  expect(existsSync(computerWorkspacePath(home, c))).toBe(true);
  expect(existsSync(computerProfilePath(home, c))).toBe(true);
});

test("BotComputerTest.test_one_computer_per_agent", () => {
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  withSoul(home, "helper");
  createComputer(home, { agent: "nyra" });
  expect(() => createComputer(home, { agent: "nyra" })).toThrow("已经有一台电脑");
  // 别的 agent 不受影响。
  const other = createComputer(home, { agent: "helper" });
  expect(listComputers(home)).toHaveLength(2);
  expect(getComputer(home, other.id).agent).toBe("helper");
});

test("BotComputerTest.test_shared_requires_accepted_by", () => {
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  expect(() => createComputer(home, { agent: "nyra", isolation: "shared" })).toThrow("显式接受");
  const c = createComputer(home, { agent: "nyra", isolation: "shared", sharedAcceptedBy: "机主" });
  expect(c.isolation).toBe("shared");
  expect(c.sharedAcceptedBy).toBe("机主");
});

test("BotComputerTest.test_store_roundtrip_perms_and_corrupt_backup", () => {
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  const c = createComputer(home, { agent: "nyra" });
  expectPerms(computerStorePath(home), 0o600);
  expectPerms(join(home, "computers"), 0o700);
  const store = loadComputerStore(home);
  expect(store.computers).toHaveLength(1);
  expect(store.computers[0].id).toBe(c.id);
  writeFileSync(computerStorePath(home), "{ 不是 json", "utf-8");
  expect(() => loadComputerStore(home)).toThrow("电脑账本损坏");
  expect(existsSync(computerStorePath(home))).toBe(false);
});

test("BotComputerTest.test_access_three_decisions", () => {
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  withSoul(home, "helper");
  const dedicated = createComputer(home, { agent: "nyra" });
  expect(checkComputerAccess(home, dedicated.id, "nyra", "write").decision).toBe("allow");
  expect(checkComputerAccess(home, dedicated.id, "helper", "read").decision).toBe("deny");
  expect(checkComputerAccess(home, dedicated.id, "helper", "write").decision).toBe("deny");
  const shared = createComputer(home, { agent: "helper", isolation: "shared", sharedAcceptedBy: "机主" });
  expect(checkComputerAccess(home, shared.id, "nyra", "read").decision).toBe("allow");
  const ask = checkComputerAccess(home, shared.id, "nyra", "write");
  expect(ask.decision).toBe("ask");
  expect(ask.reason).toContain("须经审批");
  // 休眠：读可以，写拒绝。
  sleepComputer(home, shared.id);
  expect(checkComputerAccess(home, shared.id, "helper", "read").decision).toBe("allow");
  expect(checkComputerAccess(home, shared.id, "helper", "write").decision).toBe("deny");
  expect(checkComputerAccess(home, shared.id, "nyra", "write").decision).toBe("deny");
});

test("BotComputerTest.test_memory_cap_refuses", () => {
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  withSoul(home, "helper");
  // 注入 1024 MB 总内存：上限 819 MB，默认 1024 MB 建不出来。
  expect(() => createComputer(home, { agent: "nyra" }, { systemMemoryMb: 1024 })).toThrow("内存声明超限");
  const small = createComputer(home, { agent: "nyra", memoryMb: 256 }, { systemMemoryMb: 1024 });
  expect(small.memoryMb).toBe(256);
  // 再建一台 1024 MB 的：已声明 256 + 1024 > 819，同样拒绝。
  expect(() => createComputer(home, { agent: "helper", memoryMb: 1024 }, { systemMemoryMb: 1024 })).toThrow("内存声明超限");
  const summary = computerResourceSummary(home, 1024);
  expect(summary.declaredMemoryMb).toBe(256);
  expect(summary.memoryCapMb).toBe(819);
  expect(summary.systemMemoryMb).toBe(1024);
  expect(summary.cpuOverSubscribed).toBe(false);
});

test("BotComputerTest.test_vault_store_list_remove_masked", async () => {
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  const c = createComputer(home, { agent: "nyra" });
  const stored = storeComputerCredential(home, c.id, "github", "ghp_secretvalue1234");
  expect(stored.stored).toBe("file");
  expect(stored.masked).not.toContain("ghp_secretvalue1234");
  expect(stored.masked).toContain("1234");
  // 明文只进应用层代填，不进列表与活动账本。
  expect(getComputerCredential(home, c.id, "github")).toBe("ghp_secretvalue1234");
  const listed = listComputerCredentials(home, c.id);
  expect(listed).toHaveLength(1);
  expect(listed[0].account).toBe("github");
  expect(listed[0].masked).not.toContain("ghp_secretvalue1234");
  const activity = readComputerActivity(home, c.id, 10);
  expect(JSON.stringify(activity)).not.toContain("ghp_secretvalue1234");
  expect(activity.some((a) => a.action === "credential.stored" && a.target === "github")).toBe(true);
  // 条目名口径：BOTCMP_<id 大写>_<账号大写>。
  expect(computerCredentialEntry(c.id, "github")).toBe(`BOTCMP_${c.id.slice(4).toUpperCase()}_GITHUB`);
  // 删掉后取不到，清单空了。
  const { code } = await captureStdout(() => handleComputer(["credential", c.id, "remove", "--account", "github", "--yes"], home));
  expect(code).toBe(0);
  expect(getComputerCredential(home, c.id, "github")).toBeNull();
  expect(listComputerCredentials(home, c.id)).toHaveLength(0);
});

test("BotComputerTest.test_sleep_wake_and_sleep_due", () => {
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  withSoul(home, "helper");
  const c = createComputer(home, { agent: "nyra", idleSleepMinutes: 1 });
  expect(() => wakeComputer(home, c.id)).toThrow("已经醒着");
  const slept = sleepComputer(home, c.id, "手动休眠");
  expect(slept.state).toBe("sleeping");
  expect(() => sleepComputer(home, c.id)).toThrow("已经在休眠");
  const woken = wakeComputer(home, c.id);
  expect(woken.state).toBe("active");
  // 闲置到点：把 lastActiveAt 拨回 2 分钟前（阈值 1 分钟），sleep-due 应休眠它。
  const store = loadComputerStore(home);
  const found = store.computers.find((x) => x.id === c.id)!;
  found.lastActiveAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  saveComputerStore(home, store);
  expect(computersDueForSleep(home)).toHaveLength(1);
  const sleptDue = sleepDueComputers(home);
  expect(sleptDue).toHaveLength(1);
  expect(sleptDue[0].id).toBe(c.id);
  // 闲置 0 = 永不自动休眠。
  const never = createComputer(home, { agent: "helper", idleSleepMinutes: 0 });
  const store2 = loadComputerStore(home);
  store2.computers.find((x) => x.id === never.id)!.lastActiveAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  saveComputerStore(home, store2);
  expect(computersDueForSleep(home)).toHaveLength(0);
});

test("BotComputerTest.test_browser_visit_records_host_only", () => {
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  const c = createComputer(home, { agent: "nyra" });
  const { host } = recordBrowserVisit(home, c.id, "https://github.com/js2005happy/nyra?tab=repositories#readme");
  expect(host).toBe("github.com");
  const activity = readComputerActivity(home, c.id, 10);
  const visit = activity.find((a) => a.action === "browser.open");
  expect(visit).toBeDefined();
  expect(visit!.target).toBe("github.com");
  expect(JSON.stringify(activity)).not.toContain("tab=repositories");
  expect(() => recordBrowserVisit(home, c.id, "https://user:pass@example.com/")).toThrow("不能带用户名密码");
  expect(() => recordBrowserVisit(home, c.id, "ftp://example.com/x")).toThrow("只认 http/https");
  expect(() => recordBrowserVisit(home, c.id, "not a url")).toThrow("URL 格式不对");
});

test("BotComputerTest.test_shell_via_fake_bwrap", async () => {
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  const c = createComputer(home, { agent: "nyra" });
  const shim = makeBwrapShim();
  await withEnv({ PATH: `${shim.dir}:${process.env.PATH ?? ""}` }, async () => {
    const result = await runComputerShell(home, c.id, "echo hi > hello.txt && echo done", { agent: "nyra" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("done");
    expect(existsSync(join(computerWorkspacePath(home, c), "hello.txt"))).toBe(true);
    const activity = readComputerActivity(home, c.id, 10);
    const shell = activity.find((a) => a.action === "shell.run");
    expect(shell).toBeDefined();
    expect(shell!.ok).toBe(true);
    // 失败的命令也记一条 ok=false 的活动（进回归沉淀口径）。
    const failed = await runComputerShell(home, c.id, "exit 3", { agent: "nyra" });
    expect(failed.code).toBe(3);
    const activity2 = readComputerActivity(home, c.id, 10);
    expect(activity2.some((a) => a.action === "shell.run" && a.ok === false)).toBe(true);
  });
  // 没 bwrap 时 fail-closed，不裸奔。
  await withEnv({ PATH: tmpHome("nyra-empty-path-") }, async () => {
    await expect(runComputerShell(home, c.id, "echo hi", { agent: "nyra" })).rejects.toThrow("bwrap");
  });
  // 休眠的电脑跑 shell 直接拒绝。
  sleepComputer(home, c.id);
  const shim2 = makeBwrapShim();
  await withEnv({ PATH: `${shim2.dir}:${process.env.PATH ?? ""}` }, async () => {
    await expect(runComputerShell(home, c.id, "echo hi", { agent: "nyra" })).rejects.toThrow("休眠");
  });
});

test("BotComputerTest.test_activity_and_run_event_mirror", () => {
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  const c = createComputer(home, { agent: "nyra" });
  const store = new RunStore(join(home, "runs"));
  const run = store.create("做点事", "sess-1", home, "auto", 10);
  recordComputerActivity(home, {
    computerId: c.id,
    kind: "shell",
    action: "shell.run",
    target: "echo hi",
    runId: run.run_id,
    ok: true,
  });
  recordComputerActivity(home, {
    computerId: c.id,
    kind: "shell",
    action: "shell.run",
    target: "exit 3",
    runId: run.run_id,
    ok: false,
  });
  // 新事件类型已注册进 EVENT_FIELDS：appendEvent 不抛错；时间线里看得到这两步。
  const tl = buildTimeline(store, run.run_id);
  const steps = tl.steps.filter((s) => s.title.includes("shell.run"));
  expect(steps).toHaveLength(2);
  expect(steps[0].ok).toBe(true);
  expect(steps[1].ok).toBe(false);
  // 没有运行上下文时只记账本，不抛错。
  const solo = recordComputerActivity(home, { computerId: c.id, kind: "file", action: "file.write", target: "notes.md", ok: true });
  expect(solo.runId).toBeNull();
});

test("BotComputerTest.test_cli_end_to_end", async () => {
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  const { code: codeCreate, out: outCreate } = await captureStdout(() =>
    handleComputer(["create", "--agent", "nyra", "--name", "主力"], home),
  );
  expect(codeCreate).toBe(0);
  expect(outCreate).toContain("电脑已创建");
  const id = listComputers(home)[0].id;
  const { code: codeList, out: outList } = await captureStdout(() => handleComputer(["list"], home));
  expect(codeList).toBe(0);
  expect(outList).toContain(id);
  expect(outList).toContain("主力");
  const { code: codeStatus, out: outStatus } = await captureStdout(() => handleComputer(["status", id], home));
  expect(codeStatus).toBe(0);
  expect(outStatus).toContain("工作目录");
  expect(outStatus).toContain("浏览器配置");
  // 凭证存取走注入的 secret，不用 TTY。
  const { code: codeStore } = await captureStdout(() =>
    handleComputer(["credential", id, "store", "--account", "github"], home, { secret: async () => "ghp_test1234" }),
  );
  expect(codeStore).toBe(0);
  expect(getComputerCredential(home, id, "github")).toBe("ghp_test1234");
  // remove 没 --yes 且拒绝确认时取消，不删。
  const { code: codeRemoveNo } = await captureStdout(() =>
    handleComputer(["remove", id], home, { confirm: async () => false }),
  );
  expect(codeRemoveNo).toBe(0);
  expect(listComputers(home)).toHaveLength(1);
  // --yes 删掉。
  const { code: codeRemoveYes, out: outRemove } = await captureStdout(() =>
    handleComputer(["remove", id, "--yes"], home),
  );
  expect(codeRemoveYes).toBe(0);
  expect(outRemove).toContain("已删除");
  expect(listComputers(home)).toHaveLength(0);
  expect(existsSync(join(home, "computers", id))).toBe(false);
  // 凭证也清了：keys.json 里没这条（唯一一条凭证，文件直接删掉）。
  expect(existsSync(join(home, "keys.json"))).toBe(false);
});

test("BotComputerTest.test_bot_status_lists_computers", async () => {
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  createComputer(home, { agent: "nyra" });
  const { code, out } = await captureStdout(() => handleBot(["status"], home));
  expect(code).toBe(0);
  expect(out).toContain("Telegram Bot");
  expect(out).toContain("Discord Bot");
  expect(out).toContain("电脑：1 台");
  expect(out).toContain("agent nyra");
});

test("BotComputerTest.test_remove_refuses_when_vault_locked_with_vault_credential", async () => {
  // 凭证存在密码箱里但密码箱未解锁时，删电脑须先拒绝（免得留凭证孤儿）。
  // 本测试用 keys.json 模拟“file”去处（能删）与“vault”去处（须解锁）：
  // 直接改 profile 清单，把一条 file 凭证标成 vault，再删——应拒绝。
  const home = tmpHome("nyra-computer-");
  withSoul(home, "nyra");
  const c = createComputer(home, { agent: "nyra" });
  storeComputerCredential(home, c.id, "github", "ghp_test1234");
  const profile = loadComputerProfile(home, c);
  profile.accounts[0].stored = "vault";
  saveComputerProfile(home, c, profile);
  // 没设 NYRA_VAULT_PASSWORD：密码箱打不开，应拒绝。
  expect(() => removeComputer(home, c.id)).toThrow("密码箱未解锁");
  expect(listComputers(home)).toHaveLength(1);
});
