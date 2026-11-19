// tests/node/test-eigenflux-policy.test.ts — EigenFlux 网络策略账本原生 Node 移植。
// 对应 Python：tests/test_eigenflux_policy.py（NetworkPolicyTests，CLI 部分除外，
// cli.ts 接线由总协调做）。
// 全部用临时目录做账本：不碰真实 ~/.nyra、不调真实 eigenflux 二进制、不联网。
import { test, expect, afterEach } from "bun:test";
import { expectPerms } from "./fsPerms.ts";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquirePolicyLock, policyLockPath, releasePolicyLock,
} from "../../src/eigenflux.ts";
import {
  CAPABILITIES, MAX_AUDIT, MAX_BYTES, NetworkPolicy, NetworkPolicyConflict,
  NetworkPolicyError,
} from "../../src/eigenfluxPolicy.ts";

const INSTANCE_A = "0123456789abcdef0123456789abcdef";
const INSTANCE_B = "fedcba9876543210fedcba9876543210";
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nyra-policy-"));
  roots.push(root);
  return root;
}

function makeRoom(
  root: string,
  room: string,
  opts: { instanceId?: string | null; createdAt?: string; bots?: string[] } = {},
): void {
  const dir = join(root, "groups", room);
  mkdirSync(dir, { recursive: true });
  const data: Record<string, unknown> = {
    id: room, name: room,
    bots: (opts.bots ?? ["lead", "builder", "architect"]).map((id) => ({ id, mode: "readonly" })),
    messages: [], created_at: opts.createdAt ?? "2026-11-19T00:00:00+00:00",
  };
  if (opts.instanceId !== undefined && opts.instanceId !== null) data.instance_id = opts.instanceId;
  writeFileSync(join(dir, "room.json"), JSON.stringify(data), "utf-8");
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function deadPid(): Promise<number> {
  // Windows 没有 true 命令：用当前运行时自身（bun/node）跑 --version 立即退出取死 pid。
  const child = spawn(process.execPath, ["--version"]);
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return pid;
}

function allowedCaps(state: ReturnType<NetworkPolicy["show"]>): string[] {
  return (Object.keys(state.capabilities) as Array<keyof typeof state.capabilities>)
    .filter((cap) => state.capabilities[cap].local_intent === "allowed");
}

// --- show：初始状态与字段 ---

test("NetworkPolicyTest.test_new_policy_is_deny_by_default_and_has_no_side_effects", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: INSTANCE_A });
  const policy = new NetworkPolicy({ root });
  const state = policy.show();
  const alpha = policy.show({ room: "alpha", bot: "lead" });
  for (const item of [state, alpha]) {
    expect(item.network_actions_enabled).toBe(false);
    expect(item.official_onboarding_verified).toBe(false);
    expect(item.stale_identity_policy_ignored).toBe(false);
    expect(item.policy_version).toBe(1);
    expect(item.revision).toBe("missing");
    for (const cap of CAPABILITIES) {
      expect(item.capabilities[cap].local_intent).toBe("denied");
      expect(item.capabilities[cap].effective_network_permission).toBe(false);
    }
  }
  expect(new Set(Object.keys(state.capabilities))).toEqual(new Set(CAPABILITIES));
  expect(state.identity).toBe("main");
  expect(alpha.identity).toBe("room:alpha/bot:lead");
  expect(state.reason).toContain("本地许可");
  expect(policy.audit().events).toEqual([]);
  expect(existsSync(policy.path)).toBe(false);
});

test("NetworkPolicyTest.test_revision_is_sha256_of_ledger_bytes", () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  const result = policy.change("allow", "feed_read", { confirmed: true });
  expect(result.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(result.revision).toBe(sha256Hex(readFileSync(policy.path)));
  expect(policy.show().revision).toBe(result.revision);
});

test("NetworkPolicyTest.test_ledger_file_mode_and_no_temp_leftovers", () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  policy.change("allow", "feed_read", { confirmed: true });
  if (process.platform !== "win32") {
    expectPerms(policy.path, 0o600);
    expectPerms(join(root, "eigenflux"), 0o700);
  }
  const leftovers = readdirSync(join(root, "eigenflux")).filter((n) => n.startsWith(".network-policy-"));
  expect(leftovers).toEqual([]);
});

// --- allow 需确认 / deny 不需确认 ---

test("NetworkPolicyTest.test_allow_requires_foreground_confirmation_and_does_not_execute", () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  expect(() => policy.change("allow", "feed_read")).toThrow(/--confirm/);
  expect(() => policy.change("allow", "feed_read", { confirmed: false })).toThrow(/--confirm/);
  expect(existsSync(policy.path)).toBe(false);
  const result = policy.change("allow", "feed_read", { confirmed: true });
  expect(result.changed).toBe(true);
  expect(result.network_actions_enabled).toBe(false);
  expect(result.local_intent).toBe("allowed");
  const state = policy.show();
  expect(state.capabilities.feed_read.local_intent).toBe("allowed");
  expect(state.capabilities.feed_read.effective_network_permission).toBe(false);
  expect(state.capabilities.public_broadcast.local_intent).toBe("denied");
});

test("NetworkPolicyTest.test_deny_needs_no_confirmation_and_repeat_allow_is_no_change", () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  const first = policy.change("allow", "direct_message", { confirmed: true });
  const again = policy.change("allow", "direct_message", { confirmed: true });
  expect(again.changed).toBe(false);
  expect(again.revision).toBe(first.revision);
  expect(again.local_intent).toBe("allowed");
  const revoked = policy.change("deny", "direct_message");
  expect(revoked.changed).toBe(true);
  expect(revoked.local_intent).toBe("denied");
  expect(policy.show().capabilities.direct_message.local_intent).toBe("denied");
  const events = policy.audit().events;
  expect(events.map((e) => e.operation)).toEqual(["deny", "allow"]);
  expect(events.every((e) => e.actor === "explicit_cli_user")).toBe(true);
  const reopened = new NetworkPolicy({ root });
  expect(reopened.show().capabilities.direct_message.local_intent).toBe("denied");
  expect(reopened.audit().events).toEqual(events);
});

test("NetworkPolicyTest.test_separate_room_bot_identities_are_isolated", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: INSTANCE_A });
  makeRoom(root, "beta", { instanceId: INSTANCE_B });
  const policy = new NetworkPolicy({ root });
  policy.change("allow", "public_broadcast", { room: "alpha", bot: "lead", confirmed: true });
  policy.change("allow", "feed_read", { room: "alpha", bot: "builder", confirmed: true });
  const cases: Array<[string, string, string[]]> = [
    ["alpha", "lead", ["public_broadcast"]],
    ["alpha", "builder", ["feed_read"]],
    ["alpha", "architect", []],
    ["beta", "lead", []],
  ];
  for (const [room, bot, expected] of cases) {
    expect(allowedCaps(policy.show({ room, bot }))).toEqual(expected);
    expect(policy.show({ room, bot }).network_actions_enabled).toBe(false);
  }
  expect(allowedCaps(policy.show())).toEqual([]);
});

test("NetworkPolicyTest.test_invalid_capabilities_identity_and_operation_fail", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: INSTANCE_A });
  const policy = new NetworkPolicy({ root });
  for (const cap of ["all", "*", "network_admin", "private_keys", "", null, undefined, 42]) {
    expect(() => policy.change("allow", cap as never, { confirmed: true })).toThrow(NetworkPolicyError);
  }
  for (const args of [
    { room: "alpha", bot: "outsider" },
    { room: "../alpha", bot: "lead" },
    { room: "beta", bot: null },
    { room: null, bot: "lead" },
    { room: "alpha", bot: null },
  ]) {
    expect(() => policy.show(args)).toThrow(NetworkPolicyError);
  }
  expect(() => policy.change("delete_all", "feed_read")).toThrow(/未知网络策略操作/);
});

// --- revision 乐观锁 ---

test("NetworkPolicyTest.test_optimistic_revision_blocks_stale_concurrent_updates", () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  const version = policy.show().revision;
  expect(version).toBe("missing");
  const first = policy.change("allow", "feed_read", { expectedRevision: version, confirmed: true });
  expect(first.revision).not.toBe(version);
  expect(() => policy.change("allow", "public_broadcast", { expectedRevision: version, confirmed: true }))
    .toThrow(NetworkPolicyConflict);
  expect(policy.show().capabilities.public_broadcast.local_intent).toBe("denied");
  expect(() => policy.change("deny", "feed_read", { expectedRevision: version }))
    .toThrow(NetworkPolicyConflict);
  expect(policy.show().capabilities.feed_read.local_intent).toBe("allowed");
  // 用当前 revision 可以继续写；格式非法的 revision 在读账本前就拒绝。
  const current = policy.show().revision;
  expect(policy.change("deny", "feed_read", { expectedRevision: current }).changed).toBe(true);
  expect(() => policy.change("allow", "feed_read", { confirmed: true, expectedRevision: "wrong" }))
    .toThrow(/策略版本格式无效/);
  expect(() => policy.change("allow", "feed_read", { confirmed: true, expectedRevision: "MISSING" }))
    .toThrow(/策略版本格式无效/);
});

// --- 群重建后旧权限作废 ---

test("NetworkPolicyTest.test_recreate_group_does_not_inherit_old_permissions", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: INSTANCE_A });
  const policy = new NetworkPolicy({ root });
  policy.change("allow", "public_broadcast", { room: "alpha", bot: "lead", confirmed: true });
  expect(policy.show({ room: "alpha", bot: "lead" }).capabilities.public_broadcast.local_intent).toBe("allowed");
  // 模拟管理员删旧群、同 id 重建：instance_id 变化。
  rmSync(join(root, "groups", "alpha"), { recursive: true, force: true });
  makeRoom(root, "alpha", { instanceId: INSTANCE_B });
  const state = policy.show({ room: "alpha", bot: "lead" });
  expect(state.stale_identity_policy_ignored).toBe(true);
  expect(state.capabilities.public_broadcast.local_intent).toBe("denied");
  // 对 stale 身份 deny 仍算一次变更（清掉旧条目并记审计），之后不再 stale。
  const denied = policy.change("deny", "public_broadcast", { room: "alpha", bot: "lead" });
  expect(denied.changed).toBe(true);
  expect(policy.show({ room: "alpha", bot: "lead" }).stale_identity_policy_ignored).toBe(false);
  // 新 instance 下重新 allow 生效。
  policy.change("allow", "public_broadcast", { room: "alpha", bot: "lead", confirmed: true });
  expect(policy.show({ room: "alpha", bot: "lead" }).capabilities.public_broadcast.local_intent).toBe("allowed");
});

test("NetworkPolicyTest.test_legacy_room_without_instance_uses_created_at_stamp", () => {
  const root = makeRoot();
  makeRoom(root, "alpha", { instanceId: null, createdAt: "2026-11-19T00:00:00+00:00" });
  const policy = new NetworkPolicy({ root });
  policy.change("allow", "feed_read", { room: "alpha", bot: "lead", confirmed: true });
  expect(policy.show({ room: "alpha", bot: "lead" }).capabilities.feed_read.local_intent).toBe("allowed");
  // created_at 变化即视为重建：旧权限作废。
  makeRoom(root, "alpha", { instanceId: null, createdAt: "2026-11-20T00:00:00+00:00" });
  const state = policy.show({ room: "alpha", bot: "lead" });
  expect(state.stale_identity_policy_ignored).toBe(true);
  expect(state.capabilities.feed_read.local_intent).toBe("denied");
});

// --- 审计：上限 250 条、排序、limit 边界 ---

test("NetworkPolicyTest.test_audit_trail_is_capped_at_250_events", () => {
  // 260 次 change() 每次都是持锁 + fsync + 原子重命名 的耐久写；Windows
  // CI 上实测 6.4 秒，超过 bun 默认 5 秒测试超时，故放宽到 15 秒。
  // 这不是放宽等待：上限断言本身不变，慢的是 Windows 文件 IO。
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  for (let i = 0; i < 260; i++) {
    policy.change(i % 2 === 0 ? "allow" : "deny", "feed_read",
      i % 2 === 0 ? { confirmed: true } : {});
  }
  const stored = JSON.parse(readFileSync(policy.path, "utf-8")) as { events: Array<Record<string, unknown>> };
  expect(stored.events.length).toBe(MAX_AUDIT);
  // 最新 250 条：第 11 次变更（下标 10，allow）起。
  expect(stored.events[0]).toMatchObject({ operation: "allow", capability: "feed_read" });
  expect(stored.events[stored.events.length - 1]).toMatchObject({ operation: "deny", capability: "feed_read" });
  const page = policy.audit({ limit: 100 });
  expect(page.events.length).toBe(100);
  expect(page.events[0]).toMatchObject({ operation: "deny", capability: "feed_read" });
  expect(page.events[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  expect(policy.audit({ limit: 1 }).events.length).toBe(1);
  expect(policy.audit().events.length).toBe(30);
}, 15000);

test("NetworkPolicyTest.test_audit_query_bounds", () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  for (const limit of [0, -1, 101, 1.5, "10", true, null]) {
    expect(() => policy.audit({ limit: limit as never })).toThrow(/审计查询数量必须是 1–100/);
  }
});

// --- 账本超限拒绝 ---

test("NetworkPolicyTest.test_oversized_ledger_is_refused", () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  mkdirSync(join(root, "eigenflux"), { recursive: true });
  writeFileSync(policy.path, "x".repeat(MAX_BYTES + 1), "utf-8");
  expect(() => policy.show()).toThrow(/网络权限账本超过 128 KiB/);
  expect(() => policy.change("allow", "feed_read", { confirmed: true })).toThrow(/网络权限账本超过 128 KiB/);
  // 超限的有效 JSON 也一样：大小检查在解析之前。
  const valid = JSON.stringify({ version: 1, agents: {}, events: [] });
  const padded = valid + " ".repeat(MAX_BYTES + 1 - valid.length);
  writeFileSync(policy.path, padded, "utf-8");
  expect(() => policy.show()).toThrow(/网络权限账本超过 128 KiB/);
  // 恰好 128 KiB 的有效 JSON（补空白）可以通过大小检查并正常解析。
  const exact = valid + " ".repeat(MAX_BYTES - valid.length);
  expect(exact.length).toBe(MAX_BYTES);
  writeFileSync(policy.path, exact, "utf-8");
  expect(policy.show().revision).toBe(sha256Hex(exact));
});

// --- 损坏账本的处理 ---

test("NetworkPolicyTest.test_file_corruption_fails_closed", () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  mkdirSync(join(root, "eigenflux"), { recursive: true });
  writeFileSync(policy.path, "not-json", "utf-8");
  expect(() => policy.show()).toThrow(/网络权限账本损坏/);
  expect(() => policy.change("allow", "feed_read", { confirmed: true })).toThrow(/网络权限账本损坏/);
  // 非法 UTF-8 字节同样视为损坏。
  writeFileSync(policy.path, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
  expect(() => policy.show()).toThrow(/网络权限账本损坏/);
  // 顶层键不对、版本号不对、审计记录非法，各有对应报错。
  writeFileSync(policy.path, JSON.stringify({ version: 1, agents: {} }), "utf-8");
  expect(() => policy.show()).toThrow(/网络策略格式错误/);
  writeFileSync(policy.path, JSON.stringify({ version: 2, agents: {}, events: [] }), "utf-8");
  expect(() => policy.show()).toThrow(/网络策略版本或 Agent 列表无效/);
  const badEvent = { version: 1, agents: {}, events: [{ at: "2026-11-19T00:00:00+00:00", actor: "someone", operation: "allow", identity: "main", capability: "feed_read" }] };
  writeFileSync(policy.path, JSON.stringify(badEvent), "utf-8");
  expect(() => policy.show()).toThrow(/审计记录格式无效/);
});

test("NetworkPolicyTest.test_tampering_cannot_inject_unrecognized_actions", () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  policy.change("allow", "feed_read", { confirmed: true });
  const data = JSON.parse(readFileSync(policy.path, "utf-8")) as {
    agents: { main: { allowed: string[] } };
  };
  data.agents.main.allowed.push("leak_everything");
  writeFileSync(policy.path, JSON.stringify(data), "utf-8");
  expect(() => policy.show()).toThrow(/未知 EigenFlux 网络行为/);
  expect(() => policy.change("deny", "feed_read")).toThrow(/未知 EigenFlux 网络行为/);
  // allowed 里出现重复项也拒绝。
  data.agents.main.allowed = ["feed_read", "feed_read"];
  writeFileSync(policy.path, JSON.stringify(data), "utf-8");
  expect(() => policy.show()).toThrow(/重复网络行为/);
});

test("NetworkPolicyTest.test_policy_symlink_and_outside_root_fail_closed", () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  mkdirSync(join(root, "eigenflux"), { recursive: true });
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "outside file", "utf-8");
  symlinkSync(outside, policy.path);
  expect(() => policy.show()).toThrow(/符号链接/);
  expect(() => policy.change("allow", "feed_read", { confirmed: true })).toThrow(/符号链接/);
  expect(readFileSync(outside, "utf-8")).toBe("outside file");
  // 账本路径在 Nyra 数据目录之外：读写都拒绝，且不创建文件。
  const external = join(root, "..", "external-policy.json");
  const other = new NetworkPolicy({ root, path: external });
  expect(() => other.show()).toThrow(/必须位于 Nyra 数据目录内/);
  expect(() => other.change("allow", "feed_read", { confirmed: true })).toThrow(/必须位于 Nyra 数据目录内/);
  expect(existsSync(external)).toBe(false);
  // 相对路径拒绝。
  const relative = new NetworkPolicy({ root, path: "eigenflux/network-policy.json" });
  expect(() => relative.show()).toThrow(/必须是绝对路径/);
});

// --- 跨进程策略锁 ---

test("NetworkPolicyTest.test_write_fails_when_policy_lock_is_held", () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  const held = acquirePolicyLock(root);
  expect(held.acquired).toBe(true);
  try {
    expect(() => policy.change("allow", "feed_read", { confirmed: true }))
      .toThrow(/正被其他任务修改/);
    expect(existsSync(policy.path)).toBe(false);
    // 读操作不需要锁：锁争用时 show / audit 仍可读。
    expect(policy.show().revision).toBe("missing");
    expect(policy.audit().events).toEqual([]);
  } finally {
    expect(releasePolicyLock(held.lockPath)).toBe(true);
  }
  expect(policy.change("allow", "feed_read", { confirmed: true }).changed).toBe(true);
  expect(lstatSync(policy.path).isSymbolicLink()).toBe(false);
});

test("NetworkPolicyTest.test_corrupt_lock_file_fails_closed_on_write", () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  mkdirSync(join(root, "eigenflux"), { recursive: true });
  writeFileSync(policyLockPath(root), "not-json", "utf-8");
  expect(() => policy.change("allow", "feed_read", { confirmed: true }))
    .toThrow(/策略锁文件损坏/);
  expect(existsSync(policy.path)).toBe(false);
  // 读操作不受损坏的锁文件影响。
  expect(policy.show().revision).toBe("missing");
});

test("NetworkPolicyTest.test_lock_held_by_dead_process_is_recycled", async () => {
  const root = makeRoot();
  const policy = new NetworkPolicy({ root });
  const pid = await deadPid();
  mkdirSync(join(root, "eigenflux"), { recursive: true });
  writeFileSync(policyLockPath(root), JSON.stringify({
    pid, owner: "nyra:dead", acquiredAt: new Date().toISOString(),
    acquiredAtMs: Date.now(), ttlMs: 60_000,
  }), "utf-8");
  expect(policy.change("allow", "feed_read", { confirmed: true }).changed).toBe(true);
  expect(existsSync(policyLockPath(root))).toBe(false);
});
