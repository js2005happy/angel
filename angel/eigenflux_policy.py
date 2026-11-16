"""Local EigenFlux action ceilings: explicit, per-Agent, deny by default.

This policy is an additional Angel-owned restriction, NOT EigenFlux consent.
No network calls, credentials, model tools, host rules or recurring triggers
are created here. Any future runtime MUST also validate official onboarding,
current credentials, per-action user approval and the installed ef-* Skills.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading

from .config import ANGEL_HOME
from .eigenflux_adapter import home_for_agent
from .groups import GroupStore

CAPABILITIES = (
    "feed_read",
    "public_broadcast",
    "direct_message",
    "relationship_request",
    "recurring_check",
    "profile_prefill",
)
DEFAULT_POLICY_PATH = ANGEL_HOME / "eigenflux" / "network-policy.json"
MAX_BYTES = 128 * 1024
MAX_AGENTS = 100
MAX_AUDIT = 250
_LOCK = threading.RLock()
_REVISION = re.compile(r"^(?:missing|[0-9a-f]{64})$")
_IDENTITY = re.compile(r"^(?:main|room:[a-z][a-z0-9_-]{0,31}/bot:[a-z][a-z0-9_-]{0,31})$")


class NetworkPolicyError(ValueError):
    """The policy is corrupt, invalid, or unsafe to access."""


class NetworkPolicyConflict(NetworkPolicyError):
    """File was changed since the caller read its revision."""


def _capability(value: str) -> str:
    if value not in CAPABILITIES:
        raise NetworkPolicyError("未知 EigenFlux 网络行为，只允许固定能力清单")
    return value


def _resolve_identity(root: Path, room: str | None, bot: str | None):
    # The adapter already rejects missing bots and symlinked identity paths.
    home_for_agent(root=root, room=room, bot=bot)
    if room is None:
        return "main", "main-v1"
    group = GroupStore(root / "groups").get(room)
    stamp = group.get("instance_id", group.get("created_at"))
    if not isinstance(stamp, str) or not stamp or len(stamp) > 100:
        raise NetworkPolicyError("群聊缺少稳定的创建标记，不能继承旧权限")
    return f"room:{room}/bot:{bot}", stamp


def _safe_file(path: Path, root: Path):
    """Reject symlink aliasing below Angel root, including policy file."""
    path = Path(path)
    root = Path(root)
    if not path.is_absolute():
        raise NetworkPolicyError("策略路径必须是绝对路径")
    if not path.resolve().is_relative_to(root.resolve()):
        raise NetworkPolicyError("策略文件必须位于 Angel 数据目录内")
    current = path
    while current != root and current != current.parent:
        if current.is_symlink():
            raise NetworkPolicyError("网络策略不能通过符号链接读写")
        current = current.parent
    if path.exists() and not path.is_file():
        raise NetworkPolicyError("网络策略不是普通文件")


def _new():
    return {"version": 1, "agents": {}, "events": []}


def _read(path: Path, root: Path):
    _safe_file(path, root)
    if not path.exists():
        return _new(), "missing"
    if path.stat().st_size > MAX_BYTES:
        raise NetworkPolicyError("网络权限账本超过 128 KiB")
    raw = path.read_bytes()
    if len(raw) > MAX_BYTES:
        raise NetworkPolicyError("网络权限账本超过 128 KiB")
    try:
        record = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise NetworkPolicyError("网络权限账本损坏，拒绝读取和变更") from exc
    if not isinstance(record, dict) or set(record) != {"version", "agents", "events"}:
        raise NetworkPolicyError("网络策略格式错误")
    if record["version"] != 1 or not isinstance(record["agents"], dict):
        raise NetworkPolicyError("网络策略版本或 Agent 列表无效")
    if not isinstance(record["events"], list) or len(record["events"]) > MAX_AUDIT:
        raise NetworkPolicyError("网络策略审计历史无效")
    if len(record["agents"]) > MAX_AGENTS:
        raise NetworkPolicyError("网络策略 Agent 数量超限")
    for identity, entry in record["agents"].items():
        if not isinstance(identity, str) or not _IDENTITY.fullmatch(identity):
            raise NetworkPolicyError("策略中包含非法机器人标识")
        if not isinstance(entry, dict) or set(entry) != {"instance", "allowed"}:
            raise NetworkPolicyError("策略中的授权结构无效")
        if not isinstance(entry["instance"], str) or not (1 <= len(entry["instance"]) <= 100):
            raise NetworkPolicyError("机器人实例标记无效")
        allowed = entry["allowed"]
        if not isinstance(allowed, list) or len(allowed) != len(set(
            str(v) for v in allowed
        )):
            raise NetworkPolicyError("策略中包含重复网络行为")
        for cap in allowed:
            _capability(cap)
    for item in record["events"]:
        if (
            not isinstance(item, dict) or
            set(item) != {"at", "actor", "operation", "identity", "capability"} or
            not isinstance(item["at"], str) or len(item["at"]) > 50 or
            item["actor"] != "explicit_cli_user" or
            item["operation"] not in ("allow", "deny") or
            not isinstance(item["identity"], str) or
            not _IDENTITY.fullmatch(item["identity"])
        ):
            raise NetworkPolicyError("审计记录格式无效")
        _capability(item["capability"])
    return record, hashlib.sha256(raw).hexdigest()


def _persist(path: Path, root: Path, record: dict) -> str:
    payload = (json.dumps(
        record, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ) + "\n").encode("utf-8")
    if len(payload) > MAX_BYTES:
        raise NetworkPolicyError("网络策略写入超出 128 KiB")
    _safe_file(path, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    _safe_file(path, root)
    fd, temporary = tempfile.mkstemp(prefix=".network-policy-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        _safe_file(path, root)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return hashlib.sha256(payload).hexdigest()


class NetworkPolicy:
    """Owner-controlled local ceilings that cannot activate the EigenFlux CLI."""

    def __init__(self, *, root: Path | None = None, path: Path | None = None):
        self.root = Path(root).resolve() if root is not None else ANGEL_HOME.resolve()
        self.path = Path(path) if path is not None else self.root / "eigenflux" / "network-policy.json"

    def show(self, *, room: str | None = None, bot: str | None = None) -> dict:
        identity, instance = _resolve_identity(self.root, room, bot)
        with _LOCK:
            data, revision = _read(self.path, self.root)
        entry = data["agents"].get(identity)
        stale = entry is not None and entry["instance"] != instance
        local = set(entry["allowed"]) if entry and not stale else set()
        return {
            "identity": identity,
            "revision": revision,
            "policy_version": 1,
            "stale_identity_policy_ignored": stale,
            "capabilities": {
                cap: {
                    "local_intent": "allowed" if cap in local else "denied",
                    "effective_network_permission": False,
                }
                for cap in CAPABILITIES
            },
            "official_onboarding_verified": False,
            "network_actions_enabled": False,
            "reason": (
                "本地许可仅定义 Angel 的额外上限；仍需 EigenFlux 官方"
                "onboarding、实际身份凭据与行为逐项授权，当前未执行联网操作。"
            ),
        }

    def audit(self, *, room: str | None = None, bot: str | None = None,
              limit: int = 30) -> dict:
        identity, _ = _resolve_identity(self.root, room, bot)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise NetworkPolicyError("审计查询数量必须是 1–100")
        with _LOCK:
            data, revision = _read(self.path, self.root)
        events = [e for e in data["events"] if e["identity"] == identity]
        return {"identity": identity, "revision": revision,
                "events": list(reversed(events[-limit:]))}

    def change(self, operation: str, capability: str, *,
               room: str | None = None, bot: str | None = None,
               confirmed: bool = False, expected_revision: str | None = None) -> dict:
        cap = _capability(capability)
        identity, instance = _resolve_identity(self.root, room, bot)
        if operation not in ("allow", "deny"):
            raise NetworkPolicyError("未知网络策略操作")
        if operation == "allow" and confirmed is not True:
            raise NetworkPolicyError("设为允许必须由用户显式提供 --confirm")
        if expected_revision is not None and (
            not isinstance(expected_revision, str) or
            not _REVISION.fullmatch(expected_revision)
        ):
            raise NetworkPolicyError("策略版本格式无效")
        with _LOCK:
            data, revision = _read(self.path, self.root)
            if expected_revision is not None and expected_revision != revision:
                raise NetworkPolicyConflict("策略已被其他任务修改，请重新查看后操作")
            stored_entry = data["agents"].get(identity)
            # A recreated room MUST NOT inherit an old group's permissions.
            stale = stored_entry is not None and stored_entry["instance"] != instance
            entry = (
                stored_entry if stored_entry is not None and not stale
                else {"instance": instance, "allowed": []}
            )
            allowed = set(entry["allowed"])
            was_allowed = cap in allowed
            if operation == "allow":
                allowed.add(cap)
            else:
                allowed.discard(cap)
            changed = (cap in allowed) != was_allowed or (
                stale and operation == "deny"
            )
            if not changed:
                return {"identity": identity, "capability": cap, "changed": False,
                        "revision": revision, "local_intent": (
                            "allowed" if was_allowed else "denied"
                        ), "network_actions_enabled": False}
            if identity not in data["agents"] and len(data["agents"]) >= MAX_AGENTS:
                raise NetworkPolicyError("最多允许 100 个机器人策略记录")
            if allowed:
                data["agents"][identity] = {
                    "instance": instance, "allowed": sorted(allowed),
                }
            else:
                data["agents"].pop(identity, None)
            data["events"].append({
                "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "actor": "explicit_cli_user",
                "operation": operation,
                "identity": identity,
                "capability": cap,
            })
            data["events"] = data["events"][-MAX_AUDIT:]
            newer = _persist(self.path, self.root, data)
        return {"identity": identity, "capability": cap, "changed": True,
                "revision": newer,
                "local_intent": "allowed" if operation == "allow" else "denied",
                "network_actions_enabled": False}
