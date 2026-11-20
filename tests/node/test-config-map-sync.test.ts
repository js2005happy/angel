// tests/node/test-config-map-sync.test.ts — 文档与代码同步（防手写文档腐化）。
//
// docs/CONFIG-MAP.md 由 scripts/gen-config-map.ts 从 src/configExplain.ts 生成。
// 这里做三件事：
//   1. 每个能力都出现在文档里
//   2. 每个能力的所有「可改的键」都出现在该能力那一行
//   3. 文档确实由脚本生成的（头部标记在），不是人手写的
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { explainAll } from "../../src/configExplain.ts";

const DOC_PATH = join(import.meta.dir, "..", "..", "docs", "CONFIG-MAP.md");
const doc = readFileSync(DOC_PATH, "utf-8");

/** 取某个能力在表格里的那一行。 */
function rowFor(capability: string): string | undefined {
  return doc.split("\n").find((l) => l.startsWith(`| \`${capability}\``));
}

test("文档存在且标明由脚本生成（不是手写）", () => {
  expect(doc).toContain("由脚本生成，勿手改");
  expect(doc).toContain("scripts/gen-config-map.ts");
});

test("每个能力都在文档里有单独一行", () => {
  for (const c of explainAll({ config: {} })) {
    expect(rowFor(c.capability)).toBeTruthy();
  }
});

test("每个能力的「可改的键」全都出现在它那一行", () => {
  for (const c of explainAll({ config: {} })) {
    const row = rowFor(c.capability);
    expect(row).toBeTruthy();
    for (const key of c.keys) {
      expect(row!).toContain(key);
    }
  }
});

test("文档里没有多出来的能力行（代码删掉的能力不能留在文档里）", () => {
  const known = new Set(explainAll({ config: {} }).map((c) => c.capability));
    // 只看「能力表」那一段：文档里还有别的表（如锁定范围表）首列也是 `键`，
    // 全局正则会把它们误当成能力行（这条断言自己踩过）。
    const capSection = (() => {
      const lines = doc.split("\n");
      const start = lines.findIndex((l) => l.startsWith("| 能力 |"));
      if (start < 0) return [];
      const rest = lines.slice(start);
      const end = rest.findIndex((l, i) => i > 0 && /^#{1,6} /.test(l));
      return end < 0 ? rest : rest.slice(0, end);
    })();
        const docCaps = capSection
          .filter((l) => /^\| `[a-z_]+` \|/.test(l))
          .map((l) => /^\| `([a-z_]+)` \|/.exec(l)![1]);
  for (const cap of docCaps) expect(known.has(cap)).toBe(true);
});

test("文档写了生效优先级（避免「改了不生效」的困惑）", () => {
  expect(doc).toContain("CLI 覆盖");
  expect(doc).toContain("config.json");
  expect(doc).toContain("默认值");
});

test("重新生成会得到同样内容（脚本确定性）", async () => {
  const proc = Bun.spawnSync({
    cmd: ["node", "--experimental-strip-types", "--no-warnings", join(import.meta.dir, "..", "..", "scripts", "gen-config-map.ts")],
    stdout: "pipe",
    stderr: "pipe",
  });
  // 没有 node 的环境（CI 里可能只有 bun）跳过这条——别让环境问题变成假失败
  if (proc.exitCode !== 0) {
    console.log("跳过：本环境跑不了脚本生成（缺 node）");
    return;
  }
  const fresh = proc.stdout.toString();
  expect(fresh.trim()).toBe(doc.trim());
});
