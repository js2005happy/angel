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

// -- 0.4.1 审查 12 项：第 5 项（SSRF 只拦内网/保留地址段，公网放行） --
import { isPrivateOrReservedHost, isPrivateOrReservedIp, assertPublicUrl } from "../../src/net.ts";

test("Net041Test.test_private_or_reserved_ips", () => {
  for (const ip of [
    "127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255",
    "192.168.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0",
    "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd00::1", "ff02::1", "2001:db8::1",
    "::ffff:10.0.0.1", "::ffff:127.0.0.1",
  ]) {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2001:4860:4860::8888"]) {
    expect(isPrivateOrReservedIp(ip)).toBe(false);
  }
});

test("Net041Test.test_private_or_reserved_hosts", () => {
  expect(isPrivateOrReservedHost("localhost")).toBe(true);
  expect(isPrivateOrReservedHost("foo.localhost")).toBe(true);
  expect(isPrivateOrReservedHost("printer.local")).toBe(true);
  expect(isPrivateOrReservedHost("metadata.google.internal")).toBe(true);
  expect(isPrivateOrReservedHost("192.168.1.1")).toBe(true);
  expect(isPrivateOrReservedHost("::1")).toBe(true);
  expect(isPrivateOrReservedHost("example.com")).toBe(false);
  expect(isPrivateOrReservedHost("api.deepseek.com")).toBe(false);
});

test("Net041Test.test_assert_public_url_blocks_private", async () => {
  for (const url of [
    "http://127.0.0.1/admin",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:8080/",
    "http://[::1]/",
    "http://[::ffff:10.0.0.1]/",
    "https://metadata.google.internal/",
  ]) {
    await expect(assertPublicUrl(url)).rejects.toThrow(/已拦截内网/);
  }
  // 公网 IP 字面量放行（不依赖 DNS 解析）。
  await assertPublicUrl("http://8.8.8.8/");
  await assertPublicUrl("https://1.1.1.1/");
  // 非 http(s) 拒绝。
  await expect(assertPublicUrl("ftp://example.com/")).rejects.toThrow(/只支持 http/);
});

test("Net041Test.test_assert_public_url_env_bypass", async () => {
  const saved = process.env.NYRA_ALLOW_PRIVATE_URLS;
  process.env.NYRA_ALLOW_PRIVATE_URLS = "1";
  try {
    await assertPublicUrl("http://127.0.0.1/admin");
    await assertPublicUrl("http://169.254.169.254/latest/meta-data/");
  } finally {
    if (saved === undefined) delete process.env.NYRA_ALLOW_PRIVATE_URLS;
    else process.env.NYRA_ALLOW_PRIVATE_URLS = saved;
  }
});
