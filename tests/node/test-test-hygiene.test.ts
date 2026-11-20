// tests/node/test-test-hygiene.test.ts — 测试自身的静态卫生检查（防第三次踩同一个坑）。
//
// 来由：我三次在**中文测试名里用 ASCII 双引号**（如 `test("……做成"全都放行"）")`），
// bun 的解析器直接语法错误，三平台全红。前两次是手工修，第三次还是同样的错——
// 说明靠人记不住，得让机器查。
//
// 检查项：
//   H1 测试文件里没有「名字里再嵌 ASCII 双引号」的 test/it/describe 调用
//   H2 测试文件没有 BOM（Set-Content 写出 BOM 会让首行断言判错，也踩过）
//   H3 测试文件用 LF 换行（混入 CRLF 会让 diff 噪音变大，且部分断言按行比对）
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir);

function files(): string[] {
  return readdirSync(DIR).filter((f) => f.endsWith(".test.ts"));
}

/** 切出 `test(` 之后第一个字符串字面量，看它内部是否还有未转义的 ASCII 引号。 */
function quotedTitleHasInnerQuote(line: string): boolean {
  const m = /\b(?:test|it|describe)\(\s*"([\s\S]*)$/.exec(line);
  if (!m) return false;
  const rest = m[1];
  // 找到第一个「后面紧跟 , 或 )」的引号作为标题结束
  let titleEnd = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '"') continue;
    // 跳过转义
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && rest[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 1) continue;
    const after = rest.slice(i + 1).trimStart();
    if (after.startsWith(",") || after.startsWith(")")) { titleEnd = i; break; }
  }
  if (titleEnd < 0) return false;
  // 标题里若还有引号 → 说明原本想写引号却提前闭合了字符串
  return rest.slice(0, titleEnd).includes('"');
}

test("H1 测试名里不嵌 ASCII 双引号（bun 解析器会直接语法错）", () => {
  const offenders: string[] = [];
  for (const f of files()) {
    const lines = readFileSync(join(DIR, f), "utf-8").split("\n");
    lines.forEach((line, i) => {
      if (quotedTitleHasInnerQuote(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});

test("H2 测试文件不带 BOM", () => {
  const offenders: string[] = [];
  for (const f of files()) {
    const buf = readFileSync(join(DIR, f));
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) offenders.push(f);
  }
  expect(offenders).toEqual([]);
});

test("H3 测试文件使用 LF（不混 CRLF）", () => {
  const offenders: string[] = [];
  for (const f of files()) {
    if (readFileSync(join(DIR, f), "utf-8").includes("\r\n")) offenders.push(f);
  }
  expect(offenders).toEqual([]);
});
