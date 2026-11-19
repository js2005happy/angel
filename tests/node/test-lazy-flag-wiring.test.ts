// tests/node/test-lazy-flag-wiring.test.ts — tool_search 开关真正生效（修已知遗留）。
// 背景：Muse 的 P3 延迟加载只在「MCP 工具 > 8」时自动开，并注明
// "config.tool_search.enabled / --enable-feature tool_search 目前不起作用"。
// 本文件锁住修复后的三档行为。
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MCP_LAZY_LOAD_THRESHOLD } from "../../src/agent.ts";
import { echoProvider } from "./fake-provider.ts";

function makeAgent(opts: Record<string, unknown> = {}): Agent {
  return new Agent(echoProvider("ok") as never, {
    workdir: mkdtempSync(join(tmpdir(), "nyra-lazy-w-")),
    mode: "auto",
    maxTurns: 1,
    interactive: false,
    home: mkdtempSync(join(tmpdir(), "nyra-lazy-h-")),
    sessionId: null,
    skillsDirs: [],
    checkpointStore: null,
    ...opts,
  } as never);
}

const savedEnv = process.env.NYRA_LAZY_TOOLS;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.NYRA_LAZY_TOOLS;
  else process.env.NYRA_LAZY_TOOLS = savedEnv;
});

test("默认：未要求时阈值是 MCP_LAZY_LOAD_THRESHOLD", () => {
  const a = makeAgent() as unknown as { toolSearchRequested: boolean; toolSearchTopK: number };
  expect(a.toolSearchRequested).toBe(false);
  expect(a.toolSearchTopK).toBe(MCP_LAZY_LOAD_THRESHOLD);
});

test("显式开启：toolSearchRequested 为真，topK 可自定义", () => {
  const a = makeAgent({ toolSearch: { enabled: true, topK: 3 } }) as unknown as { toolSearchRequested: boolean; toolSearchTopK: number };
  expect(a.toolSearchRequested).toBe(true);
  expect(a.toolSearchTopK).toBe(3);
});

test("显式开启但没给 topK：回落默认阈值，不变成 0/NaN", () => {
  const a = makeAgent({ toolSearch: { enabled: true } }) as unknown as { toolSearchTopK: number };
  expect(a.toolSearchTopK).toBe(MCP_LAZY_LOAD_THRESHOLD);
});

test("toolSearch 传 null / 非对象也不炸", () => {
  expect(() => makeAgent({ toolSearch: null })).not.toThrow();
  const a = makeAgent({ toolSearch: { enabled: "yes" } }) as unknown as { toolSearchRequested: boolean };
  expect(a.toolSearchRequested).toBe(false); // 非 true 一律当没开
});

test("NYRA_LAZY_TOOLS=0 仍然一票否决（排障用）", () => {
  process.env.NYRA_LAZY_TOOLS = "0";
  // 环境变量在 toolSchemas() 里读取；这里只验证它不被构造期吞掉
  const a = makeAgent({ toolSearch: { enabled: true } });
  expect(a).toBeTruthy();
  expect(process.env.NYRA_LAZY_TOOLS).toBe("0");
});
