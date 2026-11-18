"""Local encrypted vault tests (stdlib unittest only, no network, no keys).

Covers: add/get roundtrip, wrong-password unlock, tampered
ciphertext/MAC, 0600 file permissions, no secret leakage in list
output, change_password, lock, get_credential edge cases, the
resolve_provider vault fallback, and the `python3 -m nyra.vault`
CLI with patched getpass.
"""

import io
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nyra import config as config_module  # noqa: E402
from nyra.config import resolve_provider  # noqa: E402
from nyra.vault import Vault, VaultError, get_credential  # noqa: E402
from nyra.vault import main as vault_main  # noqa: E402

PASSWORD = "correct horse battery staple"
SECRET = "sk-test-0123456789abcdef"


class VaultTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name) / "home"
        self.home.mkdir()
        home_patcher = mock.patch.object(config_module, "NYRA_HOME", self.home)
        home_patcher.start()
        self.addCleanup(home_patcher.stop)
        # Start from a clean environment: strip any real API keys and
        # the vault password unless a test sets them explicitly.
        env_patcher = mock.patch.dict(os.environ, {}, clear=False)
        env_patcher.start()
        self.addCleanup(env_patcher.stop)
        for key in list(os.environ):
            if key.endswith("_API_KEY") or key in (
                "NYRA_VAULT_PASSWORD",
                "NYRA_API_KEY",
            ):
                del os.environ[key]
        self.vault = Vault()

    def _init_with_entry(self, name="DEEPSEEK_API_KEY", secret=SECRET):
        self.vault.init(PASSWORD)
        self.vault.add(name, secret)
        return self.vault


class VaultCoreTest(VaultTestBase):
    def test_add_get_roundtrip_and_persistence(self):
        self._init_with_entry()
        self.assertEqual(self.vault.get("DEEPSEEK_API_KEY"), SECRET)
        # A fresh instance on the same file, unlocked again, reads it.
        reopened = Vault()
        self.assertTrue(reopened.unlock(PASSWORD))
        self.assertEqual(reopened.get("DEEPSEEK_API_KEY"), SECRET)

    def test_wrong_password_unlock_fails(self):
        self.vault.init(PASSWORD)
        other = Vault()
        self.assertFalse(other.unlock("wrong password"))
        self.assertTrue(other.is_locked)
        with self.assertRaises(VaultError):
            other.get("DEEPSEEK_API_KEY")

    def test_tampered_ciphertext_fails(self):
        self._init_with_entry()
        doc = json.loads(self.vault.path.read_text(encoding="utf-8"))
        entry = doc["entries"]["DEEPSEEK_API_KEY"]
        data = entry["data"]
        entry["data"] = ("0" if data[0] != "0" else "1") + data[1:]
        self.vault.path.write_text(json.dumps(doc), encoding="utf-8")
        reopened = Vault()
        self.assertTrue(reopened.unlock(PASSWORD))
        with self.assertRaises(VaultError):
            reopened.get("DEEPSEEK_API_KEY")

    def test_tampered_mac_fails(self):
        self._init_with_entry()
        doc = json.loads(self.vault.path.read_text(encoding="utf-8"))
        entry = doc["entries"]["DEEPSEEK_API_KEY"]
        mac = entry["mac"]
        entry["mac"] = ("0" if mac[0] != "0" else "1") + mac[1:]
        self.vault.path.write_text(json.dumps(doc), encoding="utf-8")
        reopened = Vault()
        self.assertTrue(reopened.unlock(PASSWORD))
        with self.assertRaises(VaultError):
            reopened.get("DEEPSEEK_API_KEY")

    def test_tampered_verifier_unlock_fails(self):
        self.vault.init(PASSWORD)
        doc = json.loads(self.vault.path.read_text(encoding="utf-8"))
        verifier = doc["verifier"]
        doc["verifier"] = ("0" if verifier[0] != "0" else "1") + verifier[1:]
        self.vault.path.write_text(json.dumps(doc), encoding="utf-8")
        self.assertFalse(Vault().unlock(PASSWORD))

    # Windows 文件系统没有 POSIX 权限位：os.chmod(0o600) 在 NTFS 上只影响
    # 只读标志，stat 看到的 mode 仍是 0o666，0600/0700 断言在 Windows 上
    # 本就不适用；密码箱的加密本身不受影响。
    @unittest.skipIf(sys.platform == "win32", "POSIX permission bits do not exist on Windows")
    def test_new_file_permissions_0600(self):
        self.vault.init(PASSWORD)
        mode = stat.S_IMODE(self.vault.path.stat().st_mode)
        self.assertEqual(mode, 0o600)
        parent_mode = stat.S_IMODE(self.home.stat().st_mode)
        self.assertEqual(parent_mode, 0o700)

    def test_list_does_not_leak_secret(self):
        self._init_with_entry()
        names = self.vault.list_names()
        self.assertEqual(names, ["DEEPSEEK_API_KEY"])
        self.assertNotIn(SECRET, " ".join(names))
        # The raw file must not contain the plaintext either.
        self.assertNotIn(
            SECRET, self.vault.path.read_text(encoding="utf-8")
        )

    def test_list_names_sorted(self):
        self.vault.init(PASSWORD)
        self.vault.add("z-key", "1")
        self.vault.add("a-key", "2")
        self.assertEqual(self.vault.list_names(), ["a-key", "z-key"])

    def test_get_missing_name_returns_none(self):
        self.vault.init(PASSWORD)
        self.assertIsNone(self.vault.get("NOPE"))

    def test_change_password(self):
        self._init_with_entry()
        self.vault.add("OTHER_KEY", "other-secret")
        self.vault.change_password(PASSWORD, "new password here")
        self.assertFalse(Vault().unlock(PASSWORD))
        reopened = Vault()
        self.assertTrue(reopened.unlock("new password here"))
        self.assertEqual(reopened.get("DEEPSEEK_API_KEY"), SECRET)
        self.assertEqual(reopened.get("OTHER_KEY"), "other-secret")

    def test_change_password_wrong_old_raises(self):
        self._init_with_entry()
        with self.assertRaises(VaultError):
            self.vault.change_password("wrong", "new password here")
        # Entries are still readable with the old password.
        reopened = Vault()
        self.assertTrue(reopened.unlock(PASSWORD))
        self.assertEqual(reopened.get("DEEPSEEK_API_KEY"), SECRET)

    def test_lock_then_get_raises(self):
        self._init_with_entry()
        self.assertFalse(self.vault.is_locked)
        self.vault.lock()
        self.assertTrue(self.vault.is_locked)
        with self.assertRaises(VaultError):
            self.vault.get("DEEPSEEK_API_KEY")
        with self.assertRaises(VaultError):
            self.vault.add("X", "y")

    def test_init_twice_raises(self):
        self.vault.init(PASSWORD)
        with self.assertRaises(VaultError):
            self.vault.init(PASSWORD)

    def test_add_duplicate_without_overwrite_raises(self):
        self._init_with_entry()
        with self.assertRaises(VaultError):
            self.vault.add("DEEPSEEK_API_KEY", "another")
        self.vault.add("DEEPSEEK_API_KEY", "replaced", overwrite=True)
        self.assertEqual(self.vault.get("DEEPSEEK_API_KEY"), "replaced")

    def test_invalid_name_raises(self):
        self.vault.init(PASSWORD)
        for bad in ("bad name!", "", "a/b", "a b"):
            with self.assertRaises(VaultError, msg=bad):
                self.vault.add(bad, "x")

    def test_empty_master_password_rejected(self):
        with self.assertRaises(VaultError):
            self.vault.init("")

    def test_unlock_missing_file_returns_false(self):
        self.assertFalse(Vault().unlock(PASSWORD))

    def test_remove(self):
        self._init_with_entry()
        self.vault.remove("DEEPSEEK_API_KEY")
        self.assertIsNone(self.vault.get("DEEPSEEK_API_KEY"))
        self.assertEqual(self.vault.list_names(), [])
        with self.assertRaises(VaultError):
            self.vault.remove("DEEPSEEK_API_KEY")


class GetCredentialTest(VaultTestBase):
    def test_no_password_env_returns_none(self):
        self._init_with_entry()
        self.assertIsNone(get_credential("DEEPSEEK_API_KEY"))

    def test_no_vault_file_returns_none(self):
        os.environ["NYRA_VAULT_PASSWORD"] = PASSWORD
        self.assertIsNone(get_credential("DEEPSEEK_API_KEY"))

    def test_wrong_password_returns_none(self):
        self._init_with_entry()
        os.environ["NYRA_VAULT_PASSWORD"] = "wrong"
        self.assertIsNone(get_credential("DEEPSEEK_API_KEY"))

    def test_roundtrip(self):
        self._init_with_entry()
        os.environ["NYRA_VAULT_PASSWORD"] = PASSWORD
        self.assertEqual(get_credential("DEEPSEEK_API_KEY"), SECRET)
        self.assertIsNone(get_credential("MISSING_KEY"))

    def test_corrupt_file_returns_none(self):
        self._init_with_entry()
        os.environ["NYRA_VAULT_PASSWORD"] = PASSWORD
        self.vault.path.write_text("{not json", encoding="utf-8")
        self.assertIsNone(get_credential("DEEPSEEK_API_KEY"))


class ResolveProviderVaultTest(VaultTestBase):
    def test_vault_fallback(self):
        # openai has no connector, so auth would be "env": the vault
        # is consulted when the env var is empty.
        vault = Vault()
        vault.init(PASSWORD)
        vault.add("OPENAI_API_KEY", "sk-vault-1")
        os.environ["NYRA_VAULT_PASSWORD"] = PASSWORD
        provider = resolve_provider("openai")
        self.assertEqual(provider.api_key, "sk-vault-1")
        self.assertEqual(provider.auth, "env")

    def test_env_key_wins_over_vault(self):
        vault = Vault()
        vault.init(PASSWORD)
        vault.add("OPENAI_API_KEY", "sk-vault-1")
        os.environ["NYRA_VAULT_PASSWORD"] = PASSWORD
        os.environ["OPENAI_API_KEY"] = "sk-env-1"
        provider = resolve_provider("openai")
        self.assertEqual(provider.api_key, "sk-env-1")

    def test_no_vault_keeps_original_behavior(self):
        provider = resolve_provider("openai")
        self.assertIsNone(provider.api_key)
        self.assertEqual(provider.auth, "env")

    def test_vault_missing_entry_keeps_original_behavior(self):
        vault = Vault()
        vault.init(PASSWORD)
        vault.add("SOME_OTHER_KEY", "x")
        os.environ["NYRA_VAULT_PASSWORD"] = PASSWORD
        provider = resolve_provider("openai")
        self.assertIsNone(provider.api_key)
        self.assertEqual(provider.auth, "env")


class VaultCliTest(VaultTestBase):
    def _run(self, argv, passwords):
        with mock.patch(
            "nyra.vault.getpass.getpass", side_effect=list(passwords)
        ):
            out = io.StringIO()
            with redirect_stdout(out):
                code = vault_main(argv)
        return code, out.getvalue()

    def test_init_add_get_list_remove(self):
        code, _ = self._run(["init"], [PASSWORD, PASSWORD])
        self.assertEqual(code, 0)
        self.assertTrue(self.vault.path.exists())
        code, _ = self._run(["add", "DEEPSEEK_API_KEY"], [PASSWORD, SECRET])
        self.assertEqual(code, 0)
        code, out = self._run(["get", "DEEPSEEK_API_KEY"], [PASSWORD])
        self.assertEqual(code, 0)
        self.assertIn(SECRET, out)
        code, out = self._run(["list"], [])
        self.assertEqual(code, 0)
        self.assertIn("DEEPSEEK_API_KEY", out)
        self.assertNotIn(SECRET, out)
        code, _ = self._run(["remove", "DEEPSEEK_API_KEY"], [PASSWORD])
        self.assertEqual(code, 0)
        self.assertEqual(Vault().list_names(), [])

    def test_init_password_mismatch(self):
        code, _ = self._run(["init"], [PASSWORD, "different"])
        self.assertEqual(code, 1)
        self.assertFalse(self.vault.path.exists())

    def test_add_refuses_argv_secret(self):
        self._run(["init"], [PASSWORD, PASSWORD])
        code, _ = self._run(
            ["add", "DEEPSEEK_API_KEY", SECRET], [PASSWORD, SECRET]
        )
        self.assertEqual(code, 2)
        self.assertEqual(Vault().list_names(), [])

    def test_change_password(self):
        self._run(["init"], [PASSWORD, PASSWORD])
        self._run(["add", "DEEPSEEK_API_KEY"], [PASSWORD, SECRET])
        code, _ = self._run(
            ["change-password"], [PASSWORD, "brand new", "brand new"]
        )
        self.assertEqual(code, 0)
        self.assertFalse(Vault().unlock(PASSWORD))
        reopened = Vault()
        self.assertTrue(reopened.unlock("brand new"))
        self.assertEqual(reopened.get("DEEPSEEK_API_KEY"), SECRET)

    def test_change_password_mismatch(self):
        self._run(["init"], [PASSWORD, PASSWORD])
        code, _ = self._run(
            ["change-password"], [PASSWORD, "one", "two"]
        )
        self.assertEqual(code, 1)
        self.assertTrue(Vault().unlock(PASSWORD))

    def test_get_missing_vault(self):
        code, _ = self._run(["get", "DEEPSEEK_API_KEY"], [PASSWORD])
        self.assertEqual(code, 1)

    def test_get_missing_entry(self):
        self._run(["init"], [PASSWORD, PASSWORD])
        code, _ = self._run(["get", "NOPE"], [PASSWORD])
        self.assertEqual(code, 1)

    def test_unknown_command(self):
        code, _ = self._run(["frobnicate"], [])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
