// tests/node/test-tool-pool.test.ts — 第 4 阶段 worker threads 工具并行池。
import { test, expect } from "bun:test";
import { ToolPool, defaultPoolSize } from "../../src/toolPool.ts";
import { scoreBm25, tokenize } from "../../src/knowledge.ts";

test("ToolPoolTest.test_default_size_is_capped_at_four", () => {
  const n = defaultPoolSize();
  expect(n).toBeGreaterThanOrEqual(1);
  expect(n).toBeLessThanOrEqual(4);
  const pool = new ToolPool();
  expect(pool.size).toBe(n);
  // 懒启动：构造时不建 worker。
  expect(pool.running).toBe(0);
  expect(pool.pending).toBe(0);
});

test("ToolPoolTest.test_ping_roundtrip", async () => {
  const pool = new ToolPool(2);
  try {
    const out = await pool.run("ping", { hello: "world" });
    expect(out).toEqual({ hello: "world" });
    expect(pool.running).toBeGreaterThanOrEqual(1);
  } finally {
    await pool.close();
  }
});

test("ToolPoolTest.test_two_jobs_run_on_two_workers", async () => {
  const pool = new ToolPool(2);
  try {
    // 两个大 BM25 任务同时提交，应分到两个 worker 上并行跑。
    const docs = Array.from({ length: 3000 }, (_, i) => `文档 ${i} 工业机器人 汽车制造 调试 运维 ${"填充词 ".repeat(20)}`);
    const docTokens = docs.map((d) => tokenize(d));
    const p1 = pool.run("bm25", { queryTokens: tokenize("工业机器人"), docTokens, topK: 5 });
    const p2 = pool.run("bm25", { queryTokens: tokenize("汽车制造"), docTokens, topK: 5 });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(Array.isArray(r1)).toBe(true);
    expect(Array.isArray(r2)).toBe(true);
    expect((r1 as [number, number][]).length).toBeGreaterThan(0);
    expect((r2 as [number, number][]).length).toBeGreaterThan(0);
    expect(pool.running).toBe(2);
  } finally {
    await pool.close();
  }
});

test("ToolPoolTest.test_bm25_matches_sync_scoring", async () => {
  const pool = new ToolPool(1);
  try {
    const docs = [
      "工业机器人用于汽车制造",
      "猫咪养护指南：猫粮与饮水",
      "工业机器人调试与 3C 电子运维",
      "观赏鱼水质管理",
    ];
    const docTokens = docs.map((d) => tokenize(d));
    const queryTokens = tokenize("工业机器人调试");
    const expected = scoreBm25(queryTokens, docTokens, 5);
    const got = (await pool.run("bm25", { queryTokens, docTokens, topK: 5 })) as [number, number][];
    expect(got).toEqual(expected);
  } finally {
    await pool.close();
  }
});

test("ToolPoolTest.test_timeout_kills_stuck_worker_and_pool_recovers", async () => {
  const pool = new ToolPool(1);
  try {
    // spin 任务在 worker 内确定性阻塞 5000ms，100ms 超时必然触发；
    // 随后 ping 应恢复可用。旧版用 10 万文档 BM25 赌计算量，在快机器上
    // 仅约 13ms，超时从不触发（36f08e6 的 Node binaries #28 真失败）。
    let err: unknown = null;
    try {
      await pool.run("spin", { ms: 5000 }, 100);
    } catch (e: unknown) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain("超时");
    const out = await pool.run("ping", { ok: true });
    expect(out).toEqual({ ok: true });
  } finally {
    await pool.close();
  }
});

test("ToolPoolTest.test_unknown_kind_rejects", async () => {
  const pool = new ToolPool(1);
  try {
    let err: unknown = null;
    try {
      await pool.run("nope" as never, {});
    } catch (e: unknown) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain("未知任务类型");
  } finally {
    await pool.close();
  }
});

test("ToolPoolTest.test_run_after_close_rejects", async () => {
  const pool = new ToolPool(1);
  await pool.close();
  let err: unknown = null;
  try {
    await pool.run("ping", {});
  } catch (e: unknown) { err = e; }
  expect(err).toBeInstanceOf(Error);
  expect(String((err as Error).message)).toContain("已关闭");
});
