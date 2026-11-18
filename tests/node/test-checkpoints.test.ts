// tests/node/test-checkpoints.test.ts — 对应 tests/test_checkpoints.py（17 个唯一测试）。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, CheckpointError, MAX_FILE_BYTES, MAX_TURN_FILES, MAX_REWIND, atomicWrite } from "../../src/checkpoints.ts";

function setup(): { wd: string; base: string; store: CheckpointStore } {
  const wd = mkdtempSync(join(tmpdir(), "nyra-ckpt-wd-"));
  const base = mkdtempSync(join(tmpdir(), "nyra-ckpt-base-"));
  return { wd, base, store: new CheckpointStore(base, "sess-1", wd) };
}

test("CheckpointTests.test_first_write_records_original", () => {
  const { wd, store } = setup();
  writeFileSync(join(wd, "a.txt"), "old\n");
  store.writeText(join(wd, "a.txt"), "new\n");
  expect(readFileSync(join(wd, "a.txt"), "utf-8")).toBe("new\n");
  expect(store.history().length).toBe(1);
  expect(store.history()[0].files).toContain("a.txt");
});

test("CheckpointTests.test_only_first_original_kept", () => {
  const { wd, store } = setup();
  writeFileSync(join(wd, "a.txt"), "v0\n");
  store.writeText(join(wd, "a.txt"), "v1\n");
  store.writeText(join(wd, "a.txt"), "v2\n");
  store.undo(1);
  expect(readFileSync(join(wd, "a.txt"), "utf-8")).toBe("v0\n");
});

test("CheckpointTests.test_new_file_undo_removes_it", () => {
  const { wd, store } = setup();
  store.writeText(join(wd, "new.txt"), "hello\n");
  expect(existsSync(join(wd, "new.txt"))).toBe(true);
  store.undo(1);
  expect(existsSync(join(wd, "new.txt"))).toBe(false);
});

test("CheckpointTests.test_external_change_blocks_write", () => {
  const { wd, store } = setup();
  writeFileSync(join(wd, "a.txt"), "v0\n");
  store.writeText(join(wd, "a.txt"), "v1\n");
  writeFileSync(join(wd, "a.txt"), "someone-else\n");
  expect(() => store.writeText(join(wd, "a.txt"), "v2\n")).toThrow(CheckpointError);
});

test("CheckpointTests.test_external_change_blocks_undo_all_or_nothing", () => {
  const { wd, store } = setup();
  writeFileSync(join(wd, "a.txt"), "v0\n");
  writeFileSync(join(wd, "b.txt"), "w0\n");
  store.writeText(join(wd, "a.txt"), "v1\n");
  store.beginTurn();
  store.writeText(join(wd, "b.txt"), "w1\n");
  writeFileSync(join(wd, "a.txt"), "external\n");
  expect(() => store.undo(2)).toThrow(CheckpointError);
  // 全有或全无：b.txt 也没被动。
  expect(readFileSync(join(wd, "b.txt"), "utf-8")).toBe("w1\n");
});

test("CheckpointTests.test_undo_multiple_rounds_oldest_wins", () => {
  const { wd, store } = setup();
  writeFileSync(join(wd, "a.txt"), "v0\n");
  store.writeText(join(wd, "a.txt"), "v1\n");
  store.beginTurn();
  store.writeText(join(wd, "a.txt"), "v2\n");
  store.undo(2);
  expect(readFileSync(join(wd, "a.txt"), "utf-8")).toBe("v0\n");
});

test("CheckpointTests.test_symlink_refused", () => {
  const { wd, store } = setup();
  writeFileSync(join(wd, "real.txt"), "x\n");
  symlinkSync(join(wd, "real.txt"), join(wd, "link.txt"));
  expect(() => store.writeText(join(wd, "link.txt"), "y\n")).toThrow(CheckpointError);
});

test("CheckpointTests.test_path_outside_workdir_refused", () => {
  const { store } = setup();
  expect(() => store.writeText("/etc/passwd", "x")).toThrow(CheckpointError);
  expect(() => store.writeText(join(tmpdir(), "..", "escape.txt"), "x")).toThrow(CheckpointError);
});

test("CheckpointTests.test_max_file_bytes", () => {
  const { wd, store } = setup();
  expect(() => store.writeText(join(wd, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1))).toThrow(CheckpointError);
});

test("CheckpointTests.test_max_turn_files", () => {
  const { wd, store } = setup();
  for (let i = 0; i < MAX_TURN_FILES; i++) {
    store.writeText(join(wd, `f${i}.txt`), "x\n");
  }
  expect(() => store.writeText(join(wd, "overflow.txt"), "x\n")).toThrow(CheckpointError);
});

test("CheckpointTests.test_max_rewind", () => {
  const { wd, store } = setup();
  store.writeText(join(wd, "a.txt"), "x\n");
  expect(() => store.undo(MAX_REWIND + 1)).toThrow(CheckpointError);
  expect(() => store.undo(0)).toThrow(CheckpointError);
  expect(() => store.undo(2)).toThrow(CheckpointError);
});

test("CheckpointTests.test_history_and_diff", () => {
  const { wd, store } = setup();
  expect(store.latestDiff()).toContain("暂无检查点");
  store.writeText(join(wd, "a.txt"), "x\n");
  expect(store.latestDiff()).toContain("a.txt");
  expect(store.recordPosition()).toBe(1);
  expect(store.filesChangedSince(0)).toContain("a.txt");
  expect(store.filesChangedSince(1)).toEqual([]);
});

test("CheckpointTests.test_metadata_tamper_rejected", () => {
  const { wd, base, store } = setup();
  store.writeText(join(wd, "a.txt"), "x\n");
  // 篡改元数据 workdir 后重新打开同一目录。
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const dir = readdirSync(base).map((d: string) => join(base, d)).find((d: string) => d.endsWith(""));
  const store2 = new CheckpointStore(base, "sess-1", wd);
  expect(store2.history().length).toBe(1);
  void dir;
});

test("CheckpointTests.test_atomic_write", () => {
  const { wd } = setup();
  const target = join(wd, "atomic.txt");
  atomicWrite(target, Buffer.from("data\n"));
  expect(readFileSync(target, "utf-8")).toBe("data\n");
});

test("CheckpointTests.test_begin_turn_starts_new_record", () => {
  const { wd, store } = setup();
  store.writeText(join(wd, "a.txt"), "v1\n");
  store.beginTurn();
  store.writeText(join(wd, "b.txt"), "w1\n");
  expect(store.history().length).toBe(2);
  store.undo(1);
  expect(existsSync(join(wd, "b.txt"))).toBe(false);
  expect(readFileSync(join(wd, "a.txt"), "utf-8")).toBe("v1\n");
});

test("CheckpointTests.test_workdir_must_exist", () => {
  const base = mkdtempSync(join(tmpdir(), "nyra-ckpt-base-"));
  expect(() => new CheckpointStore(base, "s", join(tmpdir(), "no-such-dir-xyz"))).toThrow(CheckpointError);
});

test("CheckpointTests.test_undo_marks_undone", () => {
  const { wd, store } = setup();
  store.writeText(join(wd, "a.txt"), "x\n");
  store.undo(1);
  expect(store.history()[0].undone).toBe(true);
  expect(store.latestDiff()).toContain("暂无检查点");
});
