// tests/node/test-memory-atomic-tmp.test.ts — 记忆原子写 tmp 路径的 Windows 回归。
// 根因：`src/memory.ts` 两处原子写用 `path.split("/").pop()` 取文件名，Windows
// 路径用反斜杠、切不开，于是 tmp 文件名里嵌进整串绝对路径（组件带冒号），
// `openSync` 报 ENOENT——Node CI #156（6de24e7）只有 Windows 任务失败，
// 10 条 failure annotation 全来自 test-memory-search-delete.test.ts。
// 修复：`atomicTmpPath` 用 `basename` 取文件名。测试在 Linux 上跑，
// 通过注入 `node:path/win32` 断言 Windows 语义；旧写法在同语义下必失败。
import { test, expect } from "bun:test";
import * as path from "node:path";
import { atomicTmpPath } from "../../src/memory.ts";

const WIN_INDEX = "C:\\Users\\x\\Temp\\d\\MEMORY.md.index.json";
const WIN_MEMORY = "C:\\Users\\x\\Temp\\d\\MEMORY.md";

test("MemoryAtomicTmp.test_win32_tmp_stays_in_same_dir_with_clean_name", () => {
  const tmp = atomicTmpPath(WIN_INDEX, path.win32);
  expect(path.win32.dirname(tmp)).toBe("C:\\Users\\x\\Temp\\d");
  const name = path.win32.basename(tmp);
  expect(name).toMatch(/^\.MEMORY\.md\.index\.json\.\d+\.[0-9a-f]{8}\.tmp$/);
  expect(name).not.toContain("/");
  expect(name).not.toContain("\\");
  expect(name).not.toContain(":");
});

test("MemoryAtomicTmp.test_win32_memory_file_tmp", () => {
  const tmp = atomicTmpPath(WIN_MEMORY, path.win32);
  expect(path.win32.dirname(tmp)).toBe("C:\\Users\\x\\Temp\\d");
  const name = path.win32.basename(tmp);
  expect(name).toMatch(/^\.MEMORY\.md\.\d+\.[0-9a-f]{8}\.tmp$/);
  expect(name).not.toContain(":");
});

test("MemoryAtomicTmp.test_posix_tmp_unchanged", () => {
  const tmp = atomicTmpPath("/tmp/d/MEMORY.md.index.json", path.posix);
  expect(path.posix.dirname(tmp)).toBe("/tmp/d");
  const name = path.posix.basename(tmp);
  expect(name).toMatch(/^\.MEMORY\.md\.index\.json\.\d+\.[0-9a-f]{8}\.tmp$/);
  expect(name).not.toContain("/");
});

test("MemoryAtomicTmp.test_old_split_slash_construction_embeds_full_path_under_win32", () => {
  // 旧写法复现：同样的输入在 win32 语义下造出的 tmp 路径里混进完整绝对路径。
  // 若生产代码走回 split("/")，上面三项断言（同目录、文件名无冒号/分隔符）
  // 会直接失败；本项把“旧写法确实会炸”本身钉死，防止有人以为它只是风格问题。
  const w = path.win32;
  const oldTmp = w.join(
    w.join(WIN_INDEX, ".."),
    `.${WIN_INDEX.split("/").pop()}.${process.pid}.abcd1234.tmp`,
  );
  expect(oldTmp).toContain(".C:");
  expect(oldTmp.split("\\").some((seg) => seg.includes(":"))).toBe(true);
  // 旧写法在 POSIX 上恰好能工作——这正是它只在 Windows CI 上红的原因。
  const posixOld = path.posix.join(
    path.posix.join("/tmp/d/MEMORY.md.index.json", ".."),
    `.${"/tmp/d/MEMORY.md.index.json".split("/").pop()}.${process.pid}.abcd1234.tmp`,
  );
  expect(path.posix.basename(posixOld)).toMatch(/^\.MEMORY\.md\.index\.json\.\d+\.abcd1234\.tmp$/);
});
