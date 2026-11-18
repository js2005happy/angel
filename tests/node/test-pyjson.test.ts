// tests/node/test-pyjson.test.ts — Python json.dumps 默认格式复刻（供 state.json / sessions.jsonl 与 Python 逐字节对比）。
import { test, expect } from "bun:test";
import { pythonJsonDump, pythonJsonDumpSorted } from "../../src/pyjson.ts";

test("PyjsonTest.test_separators_match_python", () => {
  expect(pythonJsonDump({ a: 1, b: "x" })).toBe('{"a": 1, "b": "x"}');
  expect(pythonJsonDump([1, 2, 3])).toBe('[1, 2, 3]');
  expect(pythonJsonDump({ a: null, b: true, c: false })).toBe('{"a": null, "b": true, "c": false}');
});

test("PyjsonTest.test_non_ascii_written_raw", () => {
  expect(pythonJsonDump({ text: "中文内容" })).toBe('{"text": "中文内容"}');
  expect(pythonJsonDump("你好")).toBe('"你好"');
});

test("PyjsonTest.test_indent_two_matches_python", () => {
  const out = pythonJsonDump({ a: 1, b: { c: 2 } }, 2);
  expect(out).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}');
});

test("PyjsonTest.test_sorted_keys", () => {
  expect(pythonJsonDumpSorted({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}');
  expect(pythonJsonDumpSorted({ z: { b: 1, a: 2 } })).toContain('"a": 2');
});

test("PyjsonTest.test_escapes_match_python", () => {
  expect(pythonJsonDump({ s: 'a"b\\c\nd' })).toBe('{"s": "a\\"b\\\\c\\nd"}');
  expect(pythonJsonDump({ s: "a/b" })).toBe('{"s": "a/b"}');
});

test("PyjsonTest.test_numbers", () => {
  expect(pythonJsonDump({ n: 1.5 })).toBe('{"n": 1.5}');
  expect(pythonJsonDump({ n: -0 })).toBe('{"n": 0}');
});
