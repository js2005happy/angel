// tests/node/test-repo-map.test.ts — 轻量 Repo Map（缺口 24）。
// 目标：不引 tree-sitter，用正则启发式抽函数/类签名；预算内省 token；
// 拿不准的签名宁可漏不可错。
import { test, expect } from "bun:test";
import {
  extractSignatures, isRepoMapCandidate, buildRepoMap, estimateTokens,
  listRepoMapFiles, REPO_MAP_SKIP_DIRS, isCodeRelatedTask, computeFingerprint,
} from "../../src/repoMap.ts";

test("TS：抽 function / class / interface / arrow / 方法", () => {
  const src = `
export function foo(a: number, b: string): number { return 0; }
export class Bar { }
interface Baz { x: number }
const qux = (a: number) => a + 1;
async function quux<T>(x: T): Promise<T> { return x; }
`;
  const sigs = extractSignatures(src, ".ts");
  expect(sigs).toContain("export foo(a: number, b: string)");
  expect(sigs).toContain("export class Bar");
  expect(sigs).toContain("interface Baz");
  expect(sigs).toContain("qux(a: number)");
  expect(sigs).toContain("async quux(x: T)");
});

test("TS：控制流关键字不误判为函数", () => {
  const src = "if (a) { } while (b) { } for (let i=0;i<3;i++) { } switch(x) { }";
  const sigs = extractSignatures(src, ".ts");
  expect(sigs).toEqual([]);
});

test("Python：def / async def / class", () => {
  const src = "def foo(a, b):\n    pass\nasync def bar(x):\n    pass\nclass Baz:\n    pass";
  const sigs = extractSignatures(src, ".py");
  expect(sigs).toContain("def foo(a, b)");
  expect(sigs).toContain("async def bar(x)");
  expect(sigs).toContain("class Baz");
});

test("Go：func / 方法接收者 / struct", () => {
  const src = "func Foo(a int) int { return a }\nfunc (s *S) Bar(x string) {}\ntype Baz struct{}";
  const sigs = extractSignatures(src, ".go");
  expect(sigs).toContain("func Foo(a int)");
  expect(sigs).toContain("func Bar(x string)");
  expect(sigs).toContain("type Baz");
});

test("Rust：pub fn / fn / trait", () => {
  const src = "pub fn foo(a: i32) -> i32 { a }\nasync fn bar() {}\ntrait Baz {}";
  const sigs = extractSignatures(src, ".rs");
  expect(sigs).toContain("pub fn foo(a: i32)");
  expect(sigs).toContain("async fn bar()");
  expect(sigs).toContain("trait Baz");
});

test("isRepoMapCandidate：跳过 node_modules / 隐藏目录 / 非代码扩展名", () => {
  expect(isRepoMapCandidate("src/foo.ts")).toBe(true);
  expect(isRepoMapCandidate("src/foo.py")).toBe(true);
  expect(isRepoMapCandidate("node_modules/x/index.js")).toBe(false);
  expect(isRepoMapCandidate(".git/config")).toBe(false);
  expect(isRepoMapCandidate("README.md")).toBe(false);
  expect(isRepoMapCandidate("dist/bundle.js")).toBe(false);
  expect(REPO_MAP_SKIP_DIRS.has("node_modules")).toBe(true);
  expect(REPO_MAP_SKIP_DIRS.has("dist")).toBe(true);
});

test("buildRepoMap：注入只读文件，产出 Markdown 签名清单", () => {
  const files = {
    "src/a.ts": "export function one(x: number) { return x; }\nexport class A {}\n",
    "src/b.py": "def two(a, b):\n    pass\n",
  };
  const r = buildRepoMap({
    workdir: "/repo",
    files: ["src/a.ts", "src/b.py"],
    readFile: (rel) => files[rel] ?? null,
    tokenBudget: 1000,
  });
  expect(r.text).toContain("### src/a.ts");
  expect(r.text).toContain("export one(x: number)");
  expect(r.text).toContain("### src/b.py");
  expect(r.text).toContain("def two(a, b)");
  expect(r.fileCount).toBe(2);
  expect(r.sigCount).toBe(3);
  expect(r.truncated).toBe(false);
});

test("buildRepoMap：预算极小会截断并标记 truncated", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 50; i++) {
    files[`src/f${i}.ts`] = `export function fn${i}(a: number, b: number, c: number) { return a; }\n`;
  }
  const r = buildRepoMap({
    workdir: "/repo",
    files: Object.keys(files),
    readFile: (rel) => files[rel] ?? null,
    tokenBudget: 20,
  });
  expect(r.truncated).toBe(true);
  expect(r.fileCount).toBeLessThan(50);
});

test("estimateTokens：4 字符 ≈ 1 token", () => {
  expect(estimateTokens("abcd")).toBe(1);
  expect(estimateTokens("abcdefgh")).toBe(2);
  expect(estimateTokens("")).toBe(0);
});

test("listRepoMapFiles：不递归 node_modules / .git / dist", () => {
  // 用临时目录实测（有真实文件系统）。
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyra-repomap-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export function a() {}\n");
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "b.js"), "x");
    fs.writeFileSync(path.join(root, "dist", "c.js"), "x");
    fs.writeFileSync(path.join(root, "README.md"), "x");
    const files = listRepoMapFiles(root);
    expect(files).toContain("src/a.ts");
    expect(files).not.toContain("node_modules/pkg/b.js");
    expect(files).not.toContain("dist/c.js");
    expect(files).not.toContain("README.md");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 缺口 24 第二批：智能注入 + 缓存 ----

test("isCodeRelatedTask：代码任务命中关键词 / 扩展名 / 路径，闲聊不命中", () => {
  // 关键词命中
  expect(isCodeRelatedTask("修复 src/a.ts 里的 bug")).toBe(true);
  expect(isCodeRelatedTask("实现一个函数")).toBe(true);
  expect(isCodeRelatedTask("refactor the module")).toBe(true);
  expect(isCodeRelatedTask("加一个类")).toBe(true);
  // 扩展名命中
  expect(isCodeRelatedTask("看看 a.py 里的逻辑")).toBe(true);
  expect(isCodeRelatedTask("编译 .go 文件")).toBe(true);
  // 路径命中
  expect(isCodeRelatedTask("检查 src/ 下的导入")).toBe(true);
  // 闲聊 / 纯问答不命中
  expect(isCodeRelatedTask("给我写一首诗")).toBe(false);
  expect(isCodeRelatedTask("今天天气怎么样")).toBe(false);
  expect(isCodeRelatedTask("翻译这段英文")).toBe(false);
  expect(isCodeRelatedTask("")).toBe(false);
  expect(isCodeRelatedTask("   ")).toBe(false);
});

test("computeFingerprint：文件内容 / mtime 变化会导致指纹变化", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyra-fp-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export function a() {}\n");
    const f1 = computeFingerprint(root, ["src/a.ts"]);
    expect(f1).toContain("src/a.ts:");
    // 内容不变 → 指纹相同
    expect(computeFingerprint(root, ["src/a.ts"])).toBe(f1);
    // 内容变化 → 指纹不同
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export function a() { return 1; }\n");
    const f2 = computeFingerprint(root, ["src/a.ts"]);
    expect(f2).not.toBe(f1);
    // 文件缺失 → 标记 missing，不抛异常
    expect(computeFingerprint(root, ["src/ghost.ts"])).toContain("src/ghost.ts:missing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
