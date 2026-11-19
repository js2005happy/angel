// tests/node/test-extra-dirs.test.ts — 额外可写根 `--add-dir`（对齐 Codex）。
// 关键契约：拒绝根目录与工作目录祖先；只放行显式列出的目录；其余仍按工作目录外拒绝。
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { resolveExtraDirs, isUnderExtraDir, describeExtraDirs } from "../../src/extraDirs.ts";
import { workspaceWritePath } from "../../src/tools.ts";
import type { ToolContext } from "../../src/tools.ts";

test("合法绝对目录被接受并去重排序", () => {
  const base = mkdtempSync(join(tmpdir(), "nyra-ed-"));
  const a = mkdirSync(join(base, "a")) ?? join(base, "a");
  const b = mkdirSync(join(base, "b")) ?? join(base, "b");
  const r = resolveExtraDirs([b, a, a], { workdir: join(base, "work"), checkExists: true });
  expect(r.ok.length).toBe(2);
  expect(r.ok[0] < r.ok[1]).toBe(true); // 已排序
  rmSync(base, { recursive: true, force: true });
});

test("相对路径、空串、不存在、非目录都被拒绝且说明原因", () => {
  const base = mkdtempSync(join(tmpdir(), "nyra-ed2-"));
  const file = join(base, "f.txt");
  writeFileSync(file, "x");
  const r = resolveExtraDirs(["relative/path", "  ", join(base, "nope"), file], { checkExists: true });
  expect(r.ok.length).toBe(0);
  expect(r.rejected.length).toBe(4);
  expect(r.rejected.some((x) => x.reason.includes("绝对路径"))).toBe(true);
  expect(r.rejected.some((x) => x.reason.includes("不存在"))).toBe(true);
  expect(r.rejected.some((x) => x.reason.includes("不是目录"))).toBe(true);
  rmSync(base, { recursive: true, force: true });
});

test("拒绝根目录（加进来等于关掉 containment）", () => {
  const r = resolveExtraDirs(["/"], { checkExists: false });
  expect(r.ok.length).toBe(0);
  expect(r.rejected[0].reason).toContain("根目录");
});

test("拒绝工作目录本身与其祖先", () => {
  const work = resolve("/tmp/proj/sub");
  const r = resolveExtraDirs([work, "/tmp/proj"], { workdir: work, checkExists: false });
  expect(r.ok.length).toBe(0);
  expect(r.rejected.every((x) => x.reason.includes("工作目录"))).toBe(true);
});

test("isUnderExtraDir：根本身与子路径命中，兄弟目录不命中", () => {
  const extra = [resolve("/data/build")];
  expect(isUnderExtraDir("/data/build/x/y.txt", extra)).toBe(resolve("/data/build"));
  expect(isUnderExtraDir("/data/build", extra)).toBe(resolve("/data/build"));
  expect(isUnderExtraDir("/data/build-other/x", extra)).toBeNull();
});

test("describeExtraDirs 两种状态都有话说", () => {
  expect(describeExtraDirs([])).toContain("（无）");
  expect(describeExtraDirs(["/a"]).includes("/a") || describeExtraDirs(["C:\\a"]).includes("a")).toBe(true);
});

test("workspaceWritePath：额外根下的写入被放行，其他外部路径仍拒绝", () => {
  const work = mkdtempSync(join(tmpdir(), "nyra-w-"));
  const extra = mkdtempSync(join(tmpdir(), "nyra-x-"));
  const ctx = { workdir: work, mode: "auto", interactive: false, extraWriteDirs: [extra] } as unknown as ToolContext;

  // 注意：workspaceWritePath 用 join(root, path) 解析，绝对路径会被当成工作目录下的片段，
  // 所以这里必须用"相对工作目录、跳出工作目录"的形式（这也是逃逸尝试的真实形态）。
  const relExtra = relative(work, join(extra, "out.txt"));
  const relOutside = relative(work, join(tmpdir(), "nyra-elsewhere-" + Date.now() + ".txt"));

  expect(() => workspaceWritePath(ctx, relExtra)).not.toThrow();
  expect(() => workspaceWritePath(ctx, relOutside)).toThrow(/--add-dir/);

  rmSync(work, { recursive: true, force: true });
  rmSync(extra, { recursive: true, force: true });
});

test("没有额外根时行为与改动前一致", () => {
  const work = mkdtempSync(join(tmpdir(), "nyra-w2-"));
  const ctx = { workdir: work, mode: "auto", interactive: false } as unknown as ToolContext;
  const relOutside = relative(work, join(tmpdir(), "nyra-out-" + Date.now() + ".txt"));
  expect(() => workspaceWritePath(ctx, relOutside)).toThrow(/禁止写入工作目录之外的路径/);
  rmSync(work, { recursive: true, force: true });
});
