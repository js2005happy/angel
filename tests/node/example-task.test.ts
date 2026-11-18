// tests/node/example-task.test.ts — 本地示例任务（不调模型）。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExampleTask } from "../../src/exampleTask.ts";

test("示例任务：读文件前 200 字 + SQLite 100 行，计数为 100", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-example-test-"));
  const file = join(home, "sample.txt");
  writeFileSync(file, "x".repeat(500), "utf-8");
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  try {
    const result = runExampleTask({ home, provider: "deepseek", model: "deepseek-flash", file });
    expect(result.rows).toBe(100);
    expect(result.preview).toBe("x".repeat(200));
    expect(result.file).toBe(file);
  } finally {
    console.log = origLog;
  }
  expect(logs.join("\n")).toMatch("sqlite rows=100");
});

test("示例任务：1MB 大文件也只取前 200 字，不整文件读进内存", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-example-big-test-"));
  const file = join(home, "big.txt");
  writeFileSync(file, "y".repeat(1024 * 1024), "utf-8");
  const origLog = console.log;
  console.log = () => {};
  try {
    const result = runExampleTask({ home, provider: "deepseek", model: "deepseek-flash", file });
    expect(result.rows).toBe(100);
    expect(result.preview).toBe("y".repeat(200));
  } finally {
    console.log = origLog;
  }
});
