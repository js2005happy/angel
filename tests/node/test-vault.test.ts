// tests/node/test-vault.test.ts — 对应 tests/test_vault.py（35 个唯一测试）。
// 密码箱字节级兼容已在验收里双向验证（见 docs/node-migration-phase2.md）。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Vault,
  VaultError,
  deriveKeys,
  encryptEntry,
  getCredential,
  verifier,
  PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS_LEGACY,
  MIN_MASTER_PASSWORD_LENGTH,
  MAX_UNLOCK_ATTEMPTS,
  VAULT_VERSION,
} from "../../src/vault.ts";
import { handleVault } from "../../src/cli.ts";
import { expectPerms } from "./fsPerms.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-vault-test-"));
}

function makeVault(home = tmpHome()): { vault: Vault; home: string } {
  const vault = new Vault(join(home, "vault.json"));
  vault.init("master-pass");
  return { vault, home };
}

test("VaultCoreTest.test_add_get_roundtrip_and_persistence", () => {
  const { vault, home } = makeVault();
  vault.add("DEEPSEEK_API_KEY", "sk-abc123");
  expect(vault.get("DEEPSEEK_API_KEY")).toBe("sk-abc123");
  const reopened = new Vault(join(home, "vault.json"));
  expect(reopened.unlock("master-pass")).toBe(true);
  expect(reopened.get("DEEPSEEK_API_KEY")).toBe("sk-abc123");
});

test("VaultCoreTest.test_wrong_password_unlock_fails", () => {
  const { vault } = makeVault();
  vault.lock();
  expect(vault.unlock("wrong")).toBe(false);
  expect(() => vault.get("x")).toThrow();
});

test("VaultCoreTest.test_tampered_ciphertext_fails", () => {
  const { vault, home } = makeVault();
  vault.add("K", "secret-value");
  const path = join(home, "vault.json");
  const doc = JSON.parse(readFileSync(path, "utf-8")) as { entries: Record<string, { data: string }> };
  const entry = doc.entries.K;
  entry.data = (entry.data[0] === "a" ? "b" : "a") + entry.data.slice(1);
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
  const reopened = new Vault(path);
  expect(reopened.unlock("master-pass")).toBe(true);
  expect(() => reopened.get("K")).toThrow();
});

test("VaultCoreTest.test_tampered_mac_fails", () => {
  const { vault, home } = makeVault();
  vault.add("K", "secret-value");
  const path = join(home, "vault.json");
  const doc = JSON.parse(readFileSync(path, "utf-8")) as { entries: Record<string, { mac: string }> };
  const entry = doc.entries.K;
  entry.mac = (entry.mac[0] === "a" ? "b" : "a") + entry.mac.slice(1);
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
  const reopened = new Vault(path);
  expect(reopened.unlock("master-pass")).toBe(true);
  expect(() => reopened.get("K")).toThrow();
});

test("VaultCoreTest.test_tampered_verifier_unlock_fails", () => {
  const { vault, home } = makeVault();
  const path = join(home, "vault.json");
  const doc = JSON.parse(readFileSync(path, "utf-8")) as { verifier: string };
  doc.verifier = (doc.verifier[0] === "a" ? "b" : "a") + doc.verifier.slice(1);
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
  const reopened = new Vault(path);
  expect(reopened.unlock("master-pass")).toBe(false);
});

test("VaultCoreTest.test_new_file_permissions_0600", () => {
  const { home } = makeVault();
  if (process.platform === "win32") return;
  expectPerms(join(home, "vault.json"), 0o600);
});

test("VaultCoreTest.test_list_does_not_leak_secret", () => {
  const { vault } = makeVault();
  vault.add("K", "super-secret-value");
  const names = vault.listNames();
  expect(names).toEqual(["K"]);
  expect(JSON.stringify(names)).not.toContain("super-secret-value");
});

test("VaultCoreTest.test_list_names_sorted", () => {
  const { vault } = makeVault();
  vault.add("ZEBRA", "1");
  vault.add("APPLE", "2");
  vault.add("MANGO", "3");
  expect(vault.listNames()).toEqual(["APPLE", "MANGO", "ZEBRA"]);
});

test("VaultCoreTest.test_get_missing_name_returns_none", () => {
  const { vault } = makeVault();
  expect(vault.get("NOPE")).toBeNull();
});

test("VaultCoreTest.test_change_password", () => {
  const { vault, home } = makeVault();
  vault.add("K", "v");
  vault.changePassword("master-pass", "new-pass");
  const reopened = new Vault(join(home, "vault.json"));
  expect(reopened.unlock("master-pass")).toBe(false);
  expect(reopened.unlock("new-pass")).toBe(true);
  expect(reopened.get("K")).toBe("v");
});

test("VaultCoreTest.test_change_password_wrong_old_raises", () => {
  const { vault } = makeVault();
  expect(() => vault.changePassword("wrong-old-pass", "new-pass")).toThrow();
});

test("VaultCoreTest.test_lock_then_get_raises", () => {
  const { vault } = makeVault();
  vault.add("K", "v");
  vault.lock();
  expect(() => vault.get("K")).toThrow();
});

test("VaultCoreTest.test_init_twice_raises", () => {
  const home = tmpHome();
  const v = new Vault(join(home, "vault.json"));
  v.init("password1");
  expect(() => v.init("password2")).toThrow();
});

test("VaultCoreTest.test_add_duplicate_without_overwrite_raises", () => {
  const { vault } = makeVault();
  vault.add("K", "v1");
  expect(() => vault.add("K", "v2")).toThrow();
  vault.add("K", "v2", true);
  expect(vault.get("K")).toBe("v2");
});

test("VaultCoreTest.test_invalid_name_raises", () => {
  const { vault } = makeVault();
  expect(() => vault.add("bad name!", "v")).toThrow();
  expect(() => vault.add("", "v")).toThrow();
});

test("VaultCoreTest.test_empty_master_password_rejected", () => {
  const home = tmpHome();
  const v = new Vault(join(home, "vault.json"));
  expect(() => v.init("")).toThrow();
});

test("VaultCoreTest.test_unlock_missing_file_returns_false", () => {
  const v = new Vault(join(tmpHome(), "vault.json"));
  expect(v.unlock("anything")).toBe(false);
});

test("VaultCoreTest.test_remove", () => {
  const { vault } = makeVault();
  vault.add("K", "v");
  vault.remove("K");
  expect(vault.get("K")).toBeNull();
  expect(vault.listNames()).toEqual([]);
  expect(() => vault.remove("K")).toThrow();
});

test("GetCredentialTest.test_no_password_env_returns_none", () => {
  const { home } = makeVault();
  const saved = process.env.NYRA_VAULT_PASSWORD;
  delete process.env.NYRA_VAULT_PASSWORD;
  try {
    expect(getCredential("DEEPSEEK_API_KEY", home)).toBeNull();
  } finally {
    if (saved !== undefined) process.env.NYRA_VAULT_PASSWORD = saved;
  }
});

test("GetCredentialTest.test_no_vault_file_returns_none", () => {
  const saved = process.env.NYRA_VAULT_PASSWORD;
  process.env.NYRA_VAULT_PASSWORD = "pw";
  try {
    expect(getCredential("K", tmpHome())).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = saved;
  }
});

test("GetCredentialTest.test_wrong_password_returns_none", () => {
  const { home } = makeVault();
  const saved = process.env.NYRA_VAULT_PASSWORD;
  process.env.NYRA_VAULT_PASSWORD = "wrong";
  try {
    expect(getCredential("K", home)).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = saved;
  }
});

test("GetCredentialTest.test_roundtrip", () => {
  const { vault, home } = makeVault();
  vault.add("OPENAI_API_KEY", "sk-roundtrip");
  const saved = process.env.NYRA_VAULT_PASSWORD;
  process.env.NYRA_VAULT_PASSWORD = "master-pass";
  try {
    expect(getCredential("OPENAI_API_KEY", home)).toBe("sk-roundtrip");
  } finally {
    if (saved === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = saved;
  }
});

test("GetCredentialTest.test_corrupt_file_returns_none", () => {
  const home = tmpHome();
  writeFileSync(join(home, "vault.json"), "{not json");
  const saved = process.env.NYRA_VAULT_PASSWORD;
  process.env.NYRA_VAULT_PASSWORD = "pw";
  try {
    expect(getCredential("K", home)).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = saved;
  }
});

test("ResolveProviderVaultTest.test_vault_fallback", async () => {
  const { home } = makeVault();
  const { vault } = { vault: new Vault(join(home, "vault.json")) };
  vault.unlock("master-pass");
  vault.add("OPENAI_API_KEY", "sk-from-vault");
  const savedPw = process.env.NYRA_VAULT_PASSWORD;
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.NYRA_VAULT_PASSWORD = "master-pass";
  delete process.env.OPENAI_API_KEY;
  try {
    const { resolveProvider } = await import("../../src/config.ts");
    // openai 无连接器，env 为空时才查密码箱（与 Python 版 test_vault_fallback 一致）。
    const resolved = resolveProvider({ home, config: { provider: "openai" }, providerName: "openai" });
    expect(resolved.apiKey).toBe("sk-from-vault");
    expect(resolved.auth).toBe("env");
  } finally {
    if (savedPw === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = savedPw;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  }
});

test("ResolveProviderVaultTest.test_env_key_wins_over_vault", async () => {
  const { home } = makeVault();
  const v = new Vault(join(home, "vault.json"));
  v.unlock("master-pass");
  v.add("OPENAI_API_KEY", "sk-from-vault");
  const savedPw = process.env.NYRA_VAULT_PASSWORD;
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.NYRA_VAULT_PASSWORD = "master-pass";
  process.env.OPENAI_API_KEY = "sk-from-env";
  try {
    const { resolveProvider } = await import("../../src/config.ts");
    const resolved = resolveProvider({ home, config: { provider: "openai" }, providerName: "openai" });
    expect(resolved.apiKey).toBe("sk-from-env");
  } finally {
    if (savedPw === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = savedPw;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  }
});

test("ResolveProviderVaultTest.test_no_vault_keeps_original_behavior", async () => {
  const savedKey = process.env.OPENAI_API_KEY;
  const savedPw = process.env.NYRA_VAULT_PASSWORD;
  delete process.env.OPENAI_API_KEY;
  delete process.env.NYRA_VAULT_PASSWORD;
  try {
    const { resolveProvider } = await import("../../src/config.ts");
    const resolved = resolveProvider({ home: tmpHome(), config: {}, providerName: "openai" });
    expect(resolved.hasKey).toBe(false);
    expect(resolved.apiKey).toBeNull();
  } finally {
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    if (savedPw !== undefined) process.env.NYRA_VAULT_PASSWORD = savedPw;
  }
});

test("ResolveProviderVaultTest.test_vault_missing_entry_keeps_original_behavior", async () => {
  const { home } = makeVault();
  const savedPw = process.env.NYRA_VAULT_PASSWORD;
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.NYRA_VAULT_PASSWORD = "master-pass";
  delete process.env.OPENAI_API_KEY;
  try {
    const { resolveProvider } = await import("../../src/config.ts");
    const resolved = resolveProvider({ home, config: {}, providerName: "openai" });
    expect(resolved.hasKey).toBe(false);
    expect(resolved.apiKey).toBeNull();
  } finally {
    if (savedPw === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = savedPw;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  }
});

test("VaultCliTest.test_init_add_get_list_remove", async () => {
  const home = tmpHome();
  expect(await handleVault(["init"], home, { passwords: ["password1", "password1"] })).toBe(0);
  expect(await handleVault(["add", "K1"], home, { passwords: ["password1"], secrets: ["secret1"] })).toBe(0);
  expect(await handleVault(["list"], home)).toBe(0);
  const v = new Vault(join(home, "vault.json"));
  expect(v.unlock("password1")).toBe(true);
  expect(v.get("K1")).toBe("secret1");
  expect(await handleVault(["remove", "K1"], home, { passwords: ["password1"] })).toBe(0);
  expect(v.get("K1")).toBeNull();
});

test("VaultCliTest.test_init_password_mismatch", async () => {
  const home = tmpHome();
  expect(await handleVault(["init"], home, { passwords: ["password1", "password2"] })).toBe(1);
  expect(new Vault(join(home, "vault.json")).exists()).toBe(false);
});

test("VaultCliTest.test_add_refuses_argv_secret", async () => {
  const home = tmpHome();
  await handleVault(["init"], home, { passwords: ["password1", "password1"] });
  // 密钥绝不能出现在 argv 里：多一个参数即拒绝。
  expect(await handleVault(["add", "K1", "secret-in-argv"], home, { passwords: ["password1"] })).toBe(2);
});

test("VaultCliTest.test_change_password", async () => {
  const home = tmpHome();
  await handleVault(["init"], home, { passwords: ["old-pass", "old-pass"] });
  await handleVault(["add", "K"], home, { passwords: ["old-pass"], secrets: ["v"] });
  expect(await handleVault(["change-password"], home, { passwords: ["old-pass", "new-pass", "new-pass"] })).toBe(0);
  const v = new Vault(join(home, "vault.json"));
  expect(v.unlock("new-pass")).toBe(true);
  expect(v.get("K")).toBe("v");
});

test("VaultCliTest.test_change_password_mismatch", async () => {
  const home = tmpHome();
  await handleVault(["init"], home, { passwords: ["old-pass", "old-pass"] });
  expect(await handleVault(["change-password"], home, { passwords: ["old-pass", "new-pass-1", "new-pass-2"] })).toBe(1);
});

test("VaultCliTest.test_get_missing_vault", async () => {
  expect(await handleVault(["get", "K"], tmpHome(), { passwords: ["pw"] })).toBe(1);
});

test("VaultCliTest.test_get_missing_entry", async () => {
  const home = tmpHome();
  await handleVault(["init"], home, { passwords: ["password1", "password1"] });
  expect(await handleVault(["get", "NOPE"], home, { passwords: ["password1"] })).toBe(1);
});

test("VaultCliTest.test_unknown_command", async () => {
  expect(await handleVault(["explode"], tmpHome())).toBe(2);
});

// -- 0.4.1 审查 12 项：第 1 项（PBKDF2 600k + 旧箱自动升级）、第 2 项（最小长度与限流） --
test("Vault041Test.test_short_master_password_rejected", () => {
  const v = new Vault(join(tmpHome(), "vault.json"));
  expect(() => v.init("1234567")).toThrow(`主密码至少 ${MIN_MASTER_PASSWORD_LENGTH} 位`);
  expect(() => v.changePassword("whatever-long", "short")).toThrow(`新主密码至少 ${MIN_MASTER_PASSWORD_LENGTH} 位`);
  // 正好 8 位可以通过。
  v.init("12345678");
  expect(v.unlock("12345678")).toBe(true);
});

test("Vault041Test.test_new_vault_uses_600k_iterations", () => {
  const { home } = makeVault();
  const doc = JSON.parse(readFileSync(join(home, "vault.json"), "utf-8")) as { iterations?: number };
  expect(doc.iterations).toBe(PBKDF2_ITERATIONS);
  expect(PBKDF2_ITERATIONS).toBe(600_000);
});

test("Vault041Test.test_legacy_200k_vault_unlocks_and_upgrades", () => {
  const home = tmpHome();
  const path = join(home, "vault.json");
  // 手写一个 0.4.0 式旧密码箱：200k 次、无 iterations 字段。
  const salt = randomBytes(32);
  const keys = deriveKeys("master-pass", salt, PBKDF2_ITERATIONS_LEGACY);
  const doc = {
    version: VAULT_VERSION,
    salt: salt.toString("hex"),
    verifier: verifier(keys.macKey),
    entries: { K: encryptEntry(keys.encKey, keys.macKey, Buffer.from("v", "utf-8")) },
  };
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  const v = new Vault(path);
  expect(v.unlock("master-pass")).toBe(true);
  expect(v.get("K")).toBe("v");
  // 解锁后已自动升级到 600k：文件里有了 iterations，旧口令照常用。
  const upgraded = JSON.parse(readFileSync(path, "utf-8")) as { iterations?: number };
  expect(upgraded.iterations).toBe(PBKDF2_ITERATIONS);
  const reopened = new Vault(path);
  expect(reopened.unlock("master-pass")).toBe(true);
  expect(reopened.get("K")).toBe("v");
});

test("Vault041Test.test_unlock_rate_limit_and_backoff", () => {
  const home = tmpHome();
  const path = join(home, "vault.json");
  let now = Date.now();
  const clock = () => now;
  const v = new Vault(path, { clock, lockoutBaseMs: 1000 });
  v.init("master-pass");
  expect(v.lockoutRemainingMs()).toBe(0);
  for (let i = 0; i < MAX_UNLOCK_ATTEMPTS; i++) {
    expect(v.unlock("wrong-pass")).toBe(false);
  }
  // 5 次输错后锁死：正确口令也进不去，限流状态落盘、换实例也认。
  expect(v.lockoutRemainingMs()).toBeGreaterThan(0);
  expect(v.unlock("master-pass")).toBe(false);
  const other = new Vault(path, { clock, lockoutBaseMs: 1000 });
  expect(other.lockoutRemainingMs()).toBeGreaterThan(0);
  expect(other.unlock("master-pass")).toBe(false);
  // 锁死期过后正确口令能进；再输错一次，锁死翻倍（第 6 次错 = 2 倍基础时长）。
  now += 1000;
  expect(v.unlock("wrong-pass")).toBe(false);
  expect(v.lockoutRemainingMs()).toBeGreaterThan(1000);
  expect(v.lockoutRemainingMs()).toBeLessThanOrEqual(2000);
  now += 2000;
  expect(v.unlock("master-pass")).toBe(true);
  expect(v.lockoutRemainingMs()).toBe(0);
});
