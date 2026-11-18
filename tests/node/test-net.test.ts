// tests/node/test-net.test.ts — 对应 tests/test_net_scheme.py（1 唯一）+
// test_net_proxy.py（6 唯一）+ test_plaintext_http.py（14 唯一）的核心项。
import { test, expect } from "bun:test";
import { isLoopbackHost, isLoopbackUrl, assertSafeUrl } from "../../src/net.ts";
import { plaintextHttpError } from "../../src/config.ts";

test("NetTest.test_loopback_hosts", () => {
  expect(isLoopbackHost("localhost")).toBe(true);
  expect(isLoopbackHost("127.0.0.1")).toBe(true);
  expect(isLoopbackHost("::1")).toBe(true);
  expect(isLoopbackHost("127.0.0.2")).toBe(true);
  expect(isLoopbackHost("127.1.2.3")).toBe(true);
  expect(isLoopbackHost("foo.localhost")).toBe(true);
  expect(isLoopbackHost("example.com")).toBe(false);
  expect(isLoopbackHost("192.168.1.1")).toBe(false);
  expect(isLoopbackHost("10.0.0.1")).toBe(false);
});

test("NetTest.test_loopback_urls", () => {
  expect(isLoopbackUrl("http://localhost:11434/v1")).toBe(true);
  expect(isLoopbackUrl("http://127.0.0.1:8080/")).toBe(true);
  expect(isLoopbackUrl("https://example.com/")).toBe(false);
  expect(isLoopbackUrl("http://192.168.1.1/")).toBe(false);
  expect(isLoopbackUrl("not-a-url")).toBe(false);
});

test("NetTest.test_plaintext_http_only_loopback", () => {
  assertSafeUrl("https://api.deepseek.com/v1");
  assertSafeUrl("http://localhost:11434/v1");
  assertSafeUrl("http://127.0.0.1:8080/x");
  expect(() => assertSafeUrl("http://api.deepseek.com/v1")).toThrow();
  expect(() => assertSafeUrl("http://192.168.1.1/v1")).toThrow();
  expect(() => assertSafeUrl("ftp://example.com/")).toThrow();
});

test("NetTest.test_plaintext_http_error_message", () => {
  const err = plaintextHttpError("deepseek", "http://api.deepseek.com/v1");
  expect(err).not.toBeNull();
  expect(err!).toContain("http");
  expect(plaintextHttpError("ollama", "http://127.0.0.1:11434/v1")).toBeNull();
  expect(plaintextHttpError("deepseek", "https://api.deepseek.com/v1")).toBeNull();
});
