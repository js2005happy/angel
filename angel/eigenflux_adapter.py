"""EigenFlux bare-CLI readiness diagnostics, not installation or onboarding.

No broadcast, registration, account provisioning, heartbeat, scheduler, feed,
messages, or remote network actions are initiated by Angel. The default doctor
is a purely local plan. --check explicitly runs only the official CLI's
'version' and 'skills path --host terminal' diagnostic subcommands.

Each Angel runtime identity gets one stable, separate EigenFlux Home.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from .config import ANGEL_HOME
from .groups import GroupError, GroupStore

_ID = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_TIME_LIMIT = 8
_MAX_OUTPUT = 600


class EigenFluxAdapterError(ValueError):
    """Unsafe agent identity, home or diagnostics result."""


def home_for_agent(
    *, root: Path | None = None,
    room: str | None = None,
    bot: str | None = None,
) -> Path:
    """Resolve a stable EigenFlux Home without creating or writing files.

    IMPORTANT: EigenFlux appends '.eigenflux' when --homedir does not already
    end with that name, so return a path that includes that final component.
    """
    root = Path(root) if root is not None else ANGEL_HOME
    if (room is None) != (bot is None):
        raise EigenFluxAdapterError("--room 与 --bot 必须同时提供")
    if room is not None:
        if not _ID.fullmatch(room) or not _ID.fullmatch(bot):
            raise EigenFluxAdapterError("群与机器人 ID 格式无效")
        group_root = root / "groups"
        room_folder = group_root / room
        if group_root.is_symlink() or room_folder.is_symlink():
            raise EigenFluxAdapterError("群目录不能是符号链接")
        try:
            group = GroupStore(group_root).get(room)
        except GroupError as exc:
            raise EigenFluxAdapterError(str(exc)) from exc
        if not any(
            isinstance(item, dict) and item.get("id") == bot
            for item in group.get("bots", [])
        ):
            raise EigenFluxAdapterError("该群中没有指定机器人")
        target = root / "eigenflux" / "agents" / "rooms" / room / "bots" / bot / ".eigenflux"
    else:
        target = root / "eigenflux" / "agents" / "main" / ".eigenflux"

    # No symlink may route one identity into another's credential directory.
    # A symlink at root itself is a user-managed ~/.angel relocation and is
    # intentionally allowed; everything beneath it must be physical paths.
    current = target
    while current != root and current != current.parent:
        if current.is_symlink():
            raise EigenFluxAdapterError("EigenFlux Home 路径包含符号链接，拒绝共享身份")
        current = current.parent
    canonical_root = root.resolve()
    canonical_target = target.resolve()
    if not canonical_target.is_relative_to(canonical_root):
        raise EigenFluxAdapterError("EigenFlux Home 超出 Angel 数据目录")
    return canonical_target


def _minimal_environment(home: Path) -> dict[str, str]:
    """Do not inherit model keys, cloud tokens or other agent identities."""
    allow = (
        "PATH", "PATHEXT", "HOME", "USERPROFILE", "SystemRoot", "WINDIR",
        "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
    )
    env = {name: os.environ[name] for name in allow if name in os.environ}
    env["EIGENFLUX_HOME"] = str(home)
    return env


def _run_diagnostic(binary: str, home: Path, subcommand: list[str]) -> dict:
    command = [binary, "--homedir", str(home), *subcommand]
    try:
        result = subprocess.run(
            command, shell=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=_TIME_LIMIT,
            env=_minimal_environment(home),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {
            "status": "failed",
            "reason": type(exc).__name__,
            "exit_code": None,
        }
    # Most stderr / stdout may contain environment-specific details; retain
    # only a tiny bounded display when successfully executing a benign probe.
    description = (result.stdout or "").strip().splitlines()
    return {
        "status": "ok" if result.returncode == 0 else "failed",
        "exit_code": result.returncode,
        "output": description[0][:_MAX_OUTPUT] if result.returncode == 0 and description else "",
    }


def doctor(*, root: Path | None = None,
           room: str | None = None, bot: str | None = None,
           check: bool = False) -> dict:
    """Report integration readiness without granting any EigenFlux network actions."""
    home = home_for_agent(root=root, room=room, bot=bot)
    identity = "main" if room is None else f"room:{room}/bot:{bot}"
    result = {
        "adapter": "eigenflux-bare-cli",
        "identity": identity,
        "home": str(home),
        "home_exists": home.is_dir(),
        "skill_host": "terminal",
        "installer_mode": "skip-agent-setup",
        "network_actions_allowed": False,
        "broadcast_enabled": False,
        "onboarding_complete": False,
        "scheduled_checks_enabled": False,
        "requires_human_onboarding": True,
        "checked": False,
        "status": "not_checked",
    }
    if not check:
        result["next_step"] = "显式指定 --check 可运行本地 CLI version 与 skills path 诊断"
        return result
    binary = shutil.which("eigenflux")
    result["checked"] = True
    if not binary:
        result["status"] = "cli_not_installed"
        result["next_step"] = (
            "仅当用户明确要求安装时，按照官方 install.md 运行"
            " bare-CLI 安装器；不要改动其他 Agent 宿主"
        )
        return result
    probes = {
        "version": _run_diagnostic(binary, home, ["version"]),
        "skills": _run_diagnostic(binary, home, ["skills", "path", "--host", "terminal"]),
    }
    result["diagnostics"] = probes
    result["status"] = (
        "local_cli_verified" if all(x["status"] == "ok" for x in probes.values())
        else "incomplete"
    )
    result["next_step"] = (
        "核对身份是否已有认证；新账户须由用户前台同意 ef-onboarding 权限与资料"
        if result["status"] == "local_cli_verified" else
        "检查官方 CLI、已安装 ef-* Skills 和所选 Home；不得报连接成功"
    )
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="angel eigenflux",
        description="EigenFlux bare-CLI 本地适配准备：不会安装、注册、广播或开启定时任务",
    )
    parser.add_argument(
        "action", choices=("doctor",),
        help="输出当前 Agent 身份的独立 Home 和安装就绪检查结果",
    )
    parser.add_argument("--room", help="已经创建的 Angel 群聊 ID")
    parser.add_argument("--bot", help="该群里的机器人 ID")
    parser.add_argument(
        "--check", action="store_true",
        help="明确运行 eigenflux --homedir HOME version / skills path --host terminal",
    )
    args = parser.parse_args(argv)
    try:
        result = doctor(room=args.room, bot=args.bot, check=args.check)
    except (EigenFluxAdapterError, OSError) as exc:
        print("EigenFlux 适配检查失败：" + str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] in ("not_checked", "local_cli_verified") else 1
