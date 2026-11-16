"""Local Poppy permission INTENT ledger (not OAuth consent or access tokens).

An explicit user CLI command may record/revoke narrowly scoped preferences.
No site metadata, model tool, MCP response or discovery file can grant access.
An allow record is NOT evidence of a valid Poppy Session, sign-in, OAuth token,
or permission to execute a remote action. Future transports must independently
verify runtime authorization and enforce required human approval.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
from datetime import datetime, timezone
from urllib.parse import urlsplit

from .config import ANGEL_HOME
from .poppy import PoppyError, _site_url

DEFAULT_PATH = ANGEL_HOME / "poppy" / "permissions.json"
MAX_LEDGER_BYTES = 256 * 1024
MAX_SITES = 100
MAX_SCOPES_PER_IDENTITY = 100
MAX_AUDIT_EVENTS = 300
_SCOPE = re.compile(r'^[\x21\x23-\x5B\x5D-\x7E]{1,128}$')
_ACCOUNT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$")
_MUTEX = threading.RLock()


class PermissionError(ValueError):
    """Invalid identity/scope, unsafe file, full ledger or corrupted data."""


class PermissionConflict(PermissionError):
    """Another change invalidated a previously read ledger revision."""


def site_host(site: str) -> str:
    """Normalize an exact HTTPS DNS host; never resolve network here."""
    try:
        return urlsplit(_site_url(site)).hostname
    except PoppyError as exc:
        raise PermissionError(str(exc)) from exc


def scope_name(scope: str) -> str:
    """OAuth scope-token syntax, excluding wildcards and ambiguous names."""
    if not isinstance(scope, str) or not _SCOPE.fullmatch(scope) or "*" in scope:
        raise PermissionError("scope 必须是非空 OAuth scope-token，且不得包含通配符")
    return scope


def identity_key(account: str | None = None) -> str:
    """Visitor or a *local label* for one account; never a credential."""
    if account is None:
        return "visitor"
    if not isinstance(account, str) or not _ACCOUNT.fullmatch(account):
        raise PermissionError("账户别名只能包含字母、数字、-、_（最多 48 字符）")
    return "account:" + account


def classify_scope(hint: dict | None) -> dict:
    """Poppy 1.0 section 4.7: unknown change values are high-risk.

    Hints are untrusted *claims* of a company, not user approval. Missing
    personal_data is unknown, not the false Boolean.
    """
    hint = hint if isinstance(hint, dict) else {}
    change = hint.get("changes")
    if change not in ("none", "reversible", "irreversible"):
        change = "irreversible"
        uncertain = True
    else:
        uncertain = False
    personal = hint.get("personal_data")
    if not isinstance(personal, bool):
        personal = None
        uncertain = True
    return {
        "changes": change,
        "personal_data": personal,
        "unknown_hints": uncertain,
        "requires_human_approval": (change != "none" or personal is not False),
    }


def _new() -> dict:
    return {"version": 1, "sites": {}, "events": []}


def _revision(data: bytes | None) -> str:
    return hashlib.sha256(data).hexdigest() if data is not None else "missing"


def _ensure_safe(path: Path) -> None:
    """Reject symlinks at the ledger file and its immediate parent folders."""
    if path.is_symlink() or path.parent.is_symlink():
        raise PermissionError("权限账本路径不能是符号链接")
    if path.parent.parent.is_symlink():
        raise PermissionError("权限账本父目录不能是符号链接")
    if path.exists() and not path.is_file():
        raise PermissionError("权限账本必须是普通文件")


def _read(path: Path) -> tuple[dict, str]:
    _ensure_safe(path)
    if not path.exists():
        return _new(), "missing"
    if path.stat().st_size > MAX_LEDGER_BYTES:
        raise PermissionError("权限账本超过 256 KiB 限制")
    payload = path.read_bytes()
    if len(payload) > MAX_LEDGER_BYTES:
        raise PermissionError("权限账本超过 256 KiB 限制")
    try:
        record = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise PermissionError("权限账本已损坏，拒绝继续写入") from exc
    if (
        not isinstance(record, dict)
        or record.get("version") != 1
        or not isinstance(record.get("sites"), dict)
        or not isinstance(record.get("events"), list)
    ):
        raise PermissionError("权限账本格式无效或不受支持")
    # Treat stored content as untrusted, including edited JSON.
    if len(record["sites"]) > MAX_SITES or len(record["events"]) > MAX_AUDIT_EVENTS:
        raise PermissionError("权限账本条目超过限制")
    for host, identities in record["sites"].items():
        if site_host(host) != host or not isinstance(identities, dict):
            raise PermissionError("权限账本包含非法站点或身份")
        for identity, scopes in identities.items():
            if identity != "visitor" and not (
                identity.startswith("account:")
                and identity_key(identity[len("account:"):]) == identity
            ):
                raise PermissionError("权限账本包含非法身份")
            if not isinstance(scopes, dict) or len(scopes) > MAX_SCOPES_PER_IDENTITY:
                raise PermissionError("权限账本 scope 列表格式无效")
            for scope, entry in scopes.items():
                scope_name(scope)
                if not isinstance(entry, dict) or entry.get("kind") != "local_intent":
                    raise PermissionError("权限账本包含未知授权类型")
    return record, _revision(payload)


def _commit(path: Path, data: dict) -> str:
    payload = (json.dumps(
        data, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ) + "\n").encode("utf-8")
    if len(payload) > MAX_LEDGER_BYTES:
        raise PermissionError("权限账本超出 256 KiB，拒绝修改")
    _ensure_safe(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _ensure_safe(path)
    fd, tmp = tempfile.mkstemp(prefix=".angel-permissions-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as writer:
            writer.write(payload)
            writer.flush()
            os.fsync(writer.fileno())
        os.chmod(tmp, 0o600)
        _ensure_safe(path)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return _revision(payload)


class PermissionLedger:
    """Defaults to deny; only explicit user CLI calls can mutate intent."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path is not None else DEFAULT_PATH

    def list(self, site: str | None = None) -> dict:
        host = site_host(site) if site is not None else None
        with _MUTEX:
            data, rev = _read(self.path)
        records = []
        for domain, identities in sorted(data["sites"].items()):
            if host is not None and domain != host:
                continue
            for identity, scopes in sorted(identities.items()):
                for scope in sorted(scopes):
                    records.append({
                        "site": domain, "identity": identity,
                        "scope": scope, "kind": "local_intent",
                    })
        return {"revision": rev, "grants": records, "count": len(records)}

    def audit(self, site: str | None = None, limit: int = 30) -> list[dict]:
        host = site_host(site) if site is not None else None
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise PermissionError("审计显示条数必须在 1 到 100 之间")
        with _MUTEX:
            data, _ = _read(self.path)
        events = [e for e in data["events"] if host is None or e.get("site") == host]
        return list(reversed(events[-limit:]))

    def check(self, site: str, scope: str, account: str | None = None,
              *, hint: dict | None = None) -> dict:
        host = site_host(site)
        key = identity_key(account)
        scope = scope_name(scope)
        with _MUTEX:
            data, rev = _read(self.path)
        intent = scope in data["sites"].get(host, {}).get(key, {})
        classification = classify_scope(hint)
        return {
            "site": host, "identity": key, "scope": scope,
            "local_intent": "recorded" if intent else "denied",
            "oauth_grant_verified": False,
            "poppy_session_verified": False,
            "may_execute_remote_action": False,
            "risk": classification,
            "reason": (
                "本地仅记录用户授权意向；没有验证 OAuth token、"
                "Poppy Session、实际服务端 scopes 和必要的逐次人工审批。"
                if intent else "默认拒绝：该站点/身份/scope 没有本地授权意向。"
            ),
            "ledger_revision": rev,
        }

    def _change(
        self, operation: str, site: str, scope: str, account: str | None,
        expected_revision: str | None,
    ) -> dict:
        host = site_host(site)
        key = identity_key(account)
        scope = scope_name(scope)
        if expected_revision is not None and (
            not isinstance(expected_revision, str) or
            (expected_revision != "missing" and
             not re.fullmatch(r"[0-9a-f]{64}", expected_revision))
        ):
            raise PermissionError("expected_revision 格式无效")
        with _MUTEX:
            data, rev = _read(self.path)
            if expected_revision is not None and rev != expected_revision:
                raise PermissionConflict("账本版本已变化，请重新查询后操作")
            sites = data["sites"]
            identities = sites.get(host, {})
            scopes = identities.get(key, {})
            exists = scope in scopes
            if operation == "grant":
                if exists:
                    return {"changed": False, "revision": rev,
                            "site": host, "identity": key, "scope": scope}
                if host not in sites and len(sites) >= MAX_SITES:
                    raise PermissionError("最多支持 100 个不同站点")
                if len(scopes) >= MAX_SCOPES_PER_IDENTITY:
                    raise PermissionError("每个站点身份最多支持 100 个 scope")
                scopes[scope] = {"kind": "local_intent"}
                identities[key] = scopes
                sites[host] = identities
            elif operation == "revoke":
                if not exists:
                    return {"changed": False, "revision": rev,
                            "site": host, "identity": key, "scope": scope}
                del scopes[scope]
                if not scopes:
                    del identities[key]
                if not identities:
                    del sites[host]
            else:
                raise PermissionError("未知权限账本操作")
            data["events"].append({
                "at": datetime.now(timezone.utc).isoformat(),
                "actor": "explicit_cli_user",
                "operation": operation,
                "site": host, "identity": key, "scope": scope,
            })
            data["events"] = data["events"][-MAX_AUDIT_EVENTS:]
            new_rev = _commit(self.path, data)
            return {"changed": True, "revision": new_rev,
                    "site": host, "identity": key, "scope": scope}

    def grant(self, site: str, scope: str, account: str | None = None,
              *, confirmed: bool = False,
              expected_revision: str | None = None) -> dict:
        if confirmed is not True:
            raise PermissionError("创建本地授权意向需要用户显式 --confirm")
        return self._change("grant", site, scope, account, expected_revision)

    def revoke(self, site: str, scope: str, account: str | None = None,
               *, expected_revision: str | None = None) -> dict:
        return self._change("revoke", site, scope, account, expected_revision)
