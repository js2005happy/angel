// tests/node/test-vault.test.ts — 对应 tests/test_vault.py（35 个唯一测试）。
// 密码箱字节级兼容已在验收里双向验证（见 docs/node-migration-phase2.md）。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, VaultError, getCredential } from "../../src/vault.ts";
import { handleVault } from "../../src/cli.ts";

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
  expect(statSync(join(home, "vault.json")).mode & 0o777).toBe(0o600);
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
  expect(() => vault.changePassword("wrong", "new")).toThrow();
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
  v.init("pw");
  expect(() => v.init("pw2")).toThrow();
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
  expect(await handleVault(["init"], home, { passwords: ["pw1", "pw1"] })).toBe(0);
  expect(await handleVault(["add", "K1"], home, { passwords: ["pw1"], secrets: ["secret1"] })).toBe(0);
  expect(await handleVault(["list"], home)).toBe(0);
  const v = new Vault(join(home, "vault.json"));
  expect(v.unlock("pw1")).toBe(true);
  expect(v.get("K1")).toBe("secret1");
  expect(await handleVault(["remove", "K1"], home, { passwords: ["pw1"] })).toBe(0);
  expect(v.get("K1")).toBeNull();
});

test("VaultCliTest.test_init_password_mismatch", async () => {
  const home = tmpHome();
  expect(await handleVault(["init"], home, { passwords: ["a", "b"] })).toBe(1);
  expect(new Vault(join(home, "vault.json")).exists()).toBe(false);
});

test("VaultCliTest.test_add_refuses_argv_secret", async () => {
  const home = tmpHome();
  await handleVault(["init"], home, { passwords: ["pw1", "pw1"] });
  // 密钥绝不能出现在 argv 里：多一个参数即拒绝。
  expect(await handleVault(["add", "K1", "secret-in-argv"], home, { passwords: ["pw1"] })).toBe(2);
});

test("VaultCliTest.test_change_password", async () => {
  const home = tmpHome();
  await handleVault(["init"], home, { passwords: ["old", "old"] });
  await handleVault(["add", "K"], home, { passwords: ["old"], secrets: ["v"] });
  expect(await handleVault(["change-password"], home, { passwords: ["old", "new", "new"] })).toBe(0);
  const v = new Vault(join(home, "vault.json"));
  expect(v.unlock("new")).toBe(true);
  expect(v.get("K")).toBe("v");
});

test("VaultCliTest.test_change_password_mismatch", async () => {
  const home = tmpHome();
  await handleVault(["init"], home, { passwords: ["old", "old"] });
  expect(await handleVault(["change-password"], home, { passwords: ["old", "n1", "n2"] })).toBe(1);
});

test("VaultCliTest.test_get_missing_vault", async () => {
  expect(await handleVault(["get", "K"], tmpHome(), { passwords: ["pw"] })).toBe(1);
});

test("VaultCliTest.test_get_missing_entry", async () => {
  const home = tmpHome();
  await handleVault(["init"], home, { passwords: ["pw", "pw"] });
  expect(await handleVault(["get", "NOPE"], home, { passwords: ["pw"] })).toBe(1);
});

test("VaultCliTest.test_unknown_command", async () => {
  expect(await handleVault(["explode"], tmpHome())).toBe(2);
});
