"""Local encrypted credential vault for Nyra.

Usage: ``python3 -m nyra.vault init`` creates ``NYRA_HOME/vault.json``
and stores provider API keys / account passwords encrypted on this
machine, so the agent can read them without the plaintext ever
appearing in chat logs or shell history. Entry names are typically
the environment variable name, e.g. ``DEEPSEEK_API_KEY``; see
``get_credential`` and the ``resolve_provider`` fallback in
``nyra/config.py``.

Encryption (stdlib only):
- PBKDF2-HMAC-SHA256, 200_000 iterations, 32-byte random salt, 64-byte
  derived key: first 32 bytes encrypt, last 32 bytes authenticate.
- Encryption is a counter mode built from HMAC-SHA256(enc_key,
  nonce || counter_be32), XORed with the plaintext; nonce is 16
  random bytes per entry.
- Authentication is HMAC-SHA256(mac_key, nonce || ciphertext),
  verified with ``hmac.compare_digest`` before any decryption; a
  failure raises ``VaultError`` without saying whether the password
  was wrong or the file was tampered with.
- The password itself is checked with a verifier:
  HMAC-SHA256(mac_key, b"nyra-vault-verifier-v1").

Threat model (read this before trusting the vault):
- Protects against: someone else reading the vault file (0600 file
  permissions, 0700 parent directory, plus encryption), e.g. another
  user on the same machine or a leaked file copy.
- Does NOT protect against: a compromised machine (root / malware
  can read memory while the vault is unlocked), a weak master
  password (brute-forceable), or memory forensics. This code has not
  been security-audited. High-value secrets belong in a professional
  password manager, not here.
- Entry *names* are stored in cleartext by design (only values are
  encrypted); ``list_names`` therefore works without unlocking.
- Secrets are never printed or logged, except for the explicit
  ``vault get`` command, which prints the value on the user's own
  terminal at their own request.
"""

from __future__ import annotations

import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
from pathlib import Path

VAULT_VERSION = 1
PBKDF2_ITERATIONS = 200_000
SALT_LEN = 32
NONCE_LEN = 16
DERIVED_KEY_LEN = 64
ENC_KEY_LEN = 32
VERIFIER_MESSAGE = b"nyra-vault-verifier-v1"
NAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")


class VaultError(Exception):
    """Raised for vault errors; never includes a secret value."""


def _default_path() -> Path:
    """Default vault file: NYRA_HOME/vault.json.

    Resolved lazily (function-level import) so tests can patch
    ``nyra.config.NYRA_HOME`` and so ``nyra.config`` can import this
    module without a circular import.
    """
    from nyra.config import NYRA_HOME

    return NYRA_HOME / "vault.json"


def _derive_keys(password: str, salt: bytes) -> tuple[bytes, bytes]:
    """Derive (enc_key, mac_key) from a password and salt."""
    key = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
        dklen=DERIVED_KEY_LEN,
    )
    return key[:ENC_KEY_LEN], key[ENC_KEY_LEN:]


def _keystream(enc_key: bytes, nonce: bytes, length: int) -> bytes:
    """Counter-mode keystream: HMAC blocks over nonce || counter_be32."""
    out = bytearray()
    counter = 0
    while len(out) < length:
        block = hmac.new(
            enc_key, nonce + counter.to_bytes(4, "big"), hashlib.sha256
        ).digest()
        out.extend(block)
        counter += 1
    return bytes(out[:length])


def _xor(left: bytes, right: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(left, right))


def _encrypt(enc_key: bytes, mac_key: bytes, plaintext: bytes) -> dict:
    nonce = secrets.token_bytes(NONCE_LEN)
    ciphertext = _xor(plaintext, _keystream(enc_key, nonce, len(plaintext)))
    mac = hmac.new(mac_key, nonce + ciphertext, hashlib.sha256).digest()
    return {"nonce": nonce.hex(), "data": ciphertext.hex(), "mac": mac.hex()}


def _decrypt(enc_key: bytes, mac_key: bytes, entry: dict) -> bytes:
    try:
        nonce = bytes.fromhex(entry["nonce"])
        ciphertext = bytes.fromhex(entry["data"])
        mac = bytes.fromhex(entry["mac"])
    except (KeyError, TypeError, ValueError):
        raise VaultError("密码箱条目已损坏") from None
    expected = hmac.new(mac_key, nonce + ciphertext, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, mac):
        # 不区分密码错误与内容被改：两种情况只报同一个错。
        raise VaultError("密码箱校验失败：主密码错误或内容已被修改")
    return _xor(ciphertext, _keystream(enc_key, nonce, len(ciphertext)))


def _verifier(mac_key: bytes) -> str:
    return hmac.new(mac_key, VERIFIER_MESSAGE, hashlib.sha256).hexdigest()


class Vault:
    """One encrypted vault file. Keys live in memory only while unlocked."""

    def __init__(self, path: str | Path | None = None):
        self.path = Path(path) if path is not None else _default_path()
        self._enc_key: bytes | None = None
        self._mac_key: bytes | None = None
        self._salt: bytes | None = None

    def exists(self) -> bool:
        return self.path.exists()

    @property
    def is_locked(self) -> bool:
        return self._enc_key is None

    def _require_unlocked(self) -> None:
        if self.is_locked:
            raise VaultError("密码箱未解锁，请先解锁")

    def _load(self) -> dict:
        try:
            with self.path.open("r", encoding="utf-8") as file:
                doc = json.load(file)
        except FileNotFoundError:
            raise VaultError(
                "密码箱不存在，请先运行 `python3 -m nyra.vault init`"
            ) from None
        except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
            raise VaultError("密码箱文件已损坏，无法读取") from exc
        if not isinstance(doc, dict) or doc.get("version") != VAULT_VERSION:
            raise VaultError("密码箱版本不受支持或文件已损坏")
        for field in ("salt", "verifier", "entries"):
            if field not in doc:
                raise VaultError("密码箱文件已损坏：缺少字段")
        if not isinstance(doc["entries"], dict):
            raise VaultError("密码箱文件已损坏：entries 不是对象")
        return doc

    def _save(self, doc: dict) -> None:
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(parent, 0o700)
        except OSError:
            pass
        tmp = parent / f".{self.path.name}.tmp-{os.getpid()}"
        try:
            with tmp.open("w", encoding="utf-8") as file:
                json.dump(doc, file, indent=2, sort_keys=True)
                file.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def init(self, password: str) -> None:
        """Create a new vault. Raises VaultError if it already exists."""
        if not password:
            raise VaultError("主密码不能为空")
        if self.path.exists():
            raise VaultError(f"密码箱已存在：{self.path}")
        salt = secrets.token_bytes(SALT_LEN)
        enc_key, mac_key = _derive_keys(password, salt)
        doc = {
            "version": VAULT_VERSION,
            "salt": salt.hex(),
            "verifier": _verifier(mac_key),
            "entries": {},
        }
        self._save(doc)
        self._enc_key, self._mac_key, self._salt = enc_key, mac_key, salt

    def unlock(self, password: str) -> bool:
        """Check the password; on success keep the keys in memory.

        Returns False for a missing file or a wrong password (and
        keeps no key in memory). Raises VaultError only for a
        structurally damaged file.
        """
        if not password or not self.path.exists():
            return False
        doc = self._load()
        try:
            salt = bytes.fromhex(doc["salt"])
        except (TypeError, ValueError):
            raise VaultError("密码箱文件已损坏：salt 无效") from None
        enc_key, mac_key = _derive_keys(password, salt)
        if not hmac.compare_digest(_verifier(mac_key), doc["verifier"]):
            self._enc_key = self._mac_key = self._salt = None
            return False
        self._enc_key, self._mac_key, self._salt = enc_key, mac_key, salt
        return True

    def lock(self) -> None:
        """Drop the in-memory keys."""
        self._enc_key = self._mac_key = self._salt = None

    def add(self, name: str, secret: str, overwrite: bool = False) -> None:
        """Store a secret. Requires unlock; refuses to overwrite
        unless overwrite=True."""
        self._require_unlocked()
        if not NAME_PATTERN.fullmatch(name):
            raise VaultError(
                f"名字不合法：{name}（只允许字母、数字、_ . -）"
            )
        doc = self._load()
        if name in doc["entries"] and not overwrite:
            raise VaultError(f"已存在：{name}（覆盖请用 overwrite=True）")
        assert self._enc_key is not None and self._mac_key is not None
        doc["entries"][name] = _encrypt(
            self._enc_key, self._mac_key, secret.encode("utf-8")
        )
        self._save(doc)

    def get(self, name: str) -> str | None:
        """Return the secret, or None when the name is not stored.
        Requires unlock. Raises VaultError on MAC failure."""
        self._require_unlocked()
        doc = self._load()
        entry = doc["entries"].get(name)
        if entry is None:
            return None
        assert self._enc_key is not None and self._mac_key is not None
        return _decrypt(self._enc_key, self._mac_key, entry).decode("utf-8")

    def remove(self, name: str) -> None:
        """Delete an entry. Requires unlock."""
        self._require_unlocked()
        doc = self._load()
        if name not in doc["entries"]:
            raise VaultError(f"没有这条：{name}")
        del doc["entries"][name]
        self._save(doc)

    def list_names(self) -> list[str]:
        """Return sorted entry names. Names are stored in cleartext
        by design, so listing does not need the vault unlocked and
        never exposes a secret value."""
        if not self.path.exists():
            raise VaultError(
                "密码箱不存在，请先运行 `python3 -m nyra.vault init`"
            )
        doc = self._load()
        return sorted(doc["entries"])

    def change_password(self, old_password: str, new_password: str) -> None:
        """Re-encrypt every entry under a new password (and new salt)."""
        if not new_password:
            raise VaultError("新主密码不能为空")
        doc = self._load()
        try:
            old_salt = bytes.fromhex(doc["salt"])
        except (TypeError, ValueError):
            raise VaultError("密码箱文件已损坏：salt 无效") from None
        old_enc, old_mac = _derive_keys(old_password, old_salt)
        if not hmac.compare_digest(_verifier(old_mac), doc["verifier"]):
            raise VaultError("旧主密码错误")
        plaintexts = {
            name: _decrypt(old_enc, old_mac, entry)
            for name, entry in doc["entries"].items()
        }
        new_salt = secrets.token_bytes(SALT_LEN)
        new_enc, new_mac = _derive_keys(new_password, new_salt)
        doc["salt"] = new_salt.hex()
        doc["verifier"] = _verifier(new_mac)
        doc["entries"] = {
            name: _encrypt(new_enc, new_mac, plaintext)
            for name, plaintext in plaintexts.items()
        }
        self._save(doc)
        self._enc_key, self._mac_key, self._salt = new_enc, new_mac, new_salt


def get_credential(name: str) -> str | None:
    """Read one credential from the vault without ever raising.

    Returns None when there is no vault file, NYRA_VAULT_PASSWORD is
    not set, the password is wrong, the entry is missing, or the file
    is damaged. Used as a silent fallback in ``resolve_provider``.
    """
    password = os.environ.get("NYRA_VAULT_PASSWORD")
    if not password:
        return None
    path = _default_path()
    if not path.exists():
        return None
    try:
        vault = Vault(path)
        if not vault.unlock(password):
            return None
        return vault.get(name)
    except Exception:
        return None


def _usage() -> str:
    return (
        "用法：python3 -m nyra.vault <命令> [参数]\n"
        "\n"
        "命令：\n"
        "  init             创建密码箱（主密码用 getpass 输入两次，不回显）\n"
        "  add NAME         存一条密钥（密钥用 getpass 输入，不回显；绝不要写在命令行里）\n"
        "  get NAME         显示一条密钥（只在你自己的机器上用，输出含明文）\n"
        "  list             只列出名字，不显示密钥\n"
        "  remove NAME      删除一条\n"
        "  change-password  改主密码（旧密码 + 新密码两次，均不回显）\n"
    )


def _read_password(prompt: str) -> str:
    return getpass.getpass(prompt)


def _unlock(vault: Vault) -> bool:
    """Prompt for the master password and unlock; False on any failure."""
    if not vault.exists():
        print("密码箱不存在，先运行：python3 -m nyra.vault init", file=sys.stderr)
        return False
    if not vault.unlock(_read_password("主密码：")):
        print("主密码错误或密码箱已损坏", file=sys.stderr)
        return False
    return True


def _cmd_init() -> int:
    vault = Vault()
    if vault.exists():
        print(f"密码箱已存在：{vault.path}", file=sys.stderr)
        return 1
    first = _read_password("主密码：")
    second = _read_password("再输一次主密码：")
    if first != second:
        print("两次输入的主密码不一致", file=sys.stderr)
        return 1
    vault.init(first)
    print(f"密码箱已创建：{vault.path}")
    return 0


def _cmd_add(name: str) -> int:
    if not NAME_PATTERN.fullmatch(name):
        print(f"名字不合法：{name}（只允许字母、数字、_ . -）", file=sys.stderr)
        return 1
    vault = Vault()
    if not _unlock(vault):
        return 1
    secret = _read_password("密钥（不回显）：")
    if not secret:
        print("密钥不能为空", file=sys.stderr)
        return 1
    vault.add(name, secret)
    print(f"已保存：{name}")
    return 0


def _cmd_get(name: str) -> int:
    vault = Vault()
    if not _unlock(vault):
        return 1
    value = vault.get(name)
    if value is None:
        print(f"没有这条：{name}", file=sys.stderr)
        return 1
    print(value)
    return 0


def _cmd_list() -> int:
    vault = Vault()
    if not vault.exists():
        print("密码箱不存在，先运行：python3 -m nyra.vault init", file=sys.stderr)
        return 1
    names = vault.list_names()
    if not names:
        print("（密码箱为空）")
    else:
        for name in names:
            print(name)
    return 0


def _cmd_remove(name: str) -> int:
    vault = Vault()
    if not _unlock(vault):
        return 1
    vault.remove(name)
    print(f"已删除：{name}")
    return 0


def _cmd_change_password() -> int:
    vault = Vault()
    if not vault.exists():
        print("密码箱不存在，先运行：python3 -m nyra.vault init", file=sys.stderr)
        return 1
    old = _read_password("旧主密码：")
    if not vault.unlock(old):
        print("旧主密码错误或密码箱已损坏", file=sys.stderr)
        return 1
    new = _read_password("新主密码：")
    again = _read_password("再输一次新主密码：")
    if new != again:
        print("两次输入的新主密码不一致", file=sys.stderr)
        return 1
    vault.change_password(old, new)
    print("主密码已更换")
    return 0


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Returns a process exit code.

    Secrets are only ever read with getpass, never from argv: argv
    shows up in the process table and shell history.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help", "help"):
        print(_usage())
        return 0
    cmd, rest = args[0], args[1:]
    try:
        if cmd == "init":
            if rest:
                print("init 不接受额外参数", file=sys.stderr)
                return 2
            return _cmd_init()
        if cmd == "add":
            if len(rest) != 1:
                print(
                    "用法：python3 -m nyra.vault add NAME\n"
                    "密钥用 getpass 输入，绝不要写在命令行里（会进进程表和 shell 历史）。",
                    file=sys.stderr,
                )
                return 2
            return _cmd_add(rest[0])
        if cmd == "get":
            if len(rest) != 1:
                print("用法：python3 -m nyra.vault get NAME", file=sys.stderr)
                return 2
            return _cmd_get(rest[0])
        if cmd == "list":
            if rest:
                print("用法：python3 -m nyra.vault list", file=sys.stderr)
                return 2
            return _cmd_list()
        if cmd == "remove":
            if len(rest) != 1:
                print("用法：python3 -m nyra.vault remove NAME", file=sys.stderr)
                return 2
            return _cmd_remove(rest[0])
        if cmd == "change-password":
            if rest:
                print(
                    "用法：python3 -m nyra.vault change-password",
                    file=sys.stderr,
                )
                return 2
            return _cmd_change_password()
        print(f"未知命令：{cmd}\n{_usage()}", file=sys.stderr)
        return 2
    except VaultError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
