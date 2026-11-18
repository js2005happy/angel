"""Workspace trust: remember which folders the user said Nyra may work in.

The first interactive run in a folder asks once whether the user trusts it.
A "yes" is stored here, one entry per absolute path, and the question is
not asked again for that path. Trust is exact-path: trusting a folder does
not trust its parent or its subfolders.

Trust only decides whether Nyra starts at all. It never widens the approval
mode: after a folder is trusted, readonly / auto / full apply exactly as
before.

Storage: ``<NYRA_HOME>/trusted_workspaces.json`` (0600 file in a 0700
directory), written atomically. A corrupt or unreadable file counts as
"nothing trusted" so the user is asked again rather than silently allowed.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

TRUST_FILENAME = "trusted_workspaces.json"


def _home(home: Path | None) -> Path:
    if home is not None:
        return Path(home)
    from .config import NYRA_HOME

    return NYRA_HOME


def trust_file(home: Path | None = None) -> Path:
    return _home(home) / TRUST_FILENAME


def normalize(path) -> str:
    """Canonical key for a folder: absolute, symlinks resolved, case folded
    on case-insensitive platforms (Windows)."""
    resolved = Path(path).expanduser().resolve()
    return os.path.normcase(str(resolved))


def load_trusted(home: Path | None = None) -> dict:
    path = trust_file(home)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    folders = data.get("folders") if isinstance(data, dict) else None
    if not isinstance(folders, dict):
        return {}
    return {str(k): v for k, v in folders.items() if isinstance(v, dict)}


def is_trusted(path, home: Path | None = None) -> bool:
    return normalize(path) in load_trusted(home)


def add_trusted(path, home: Path | None = None) -> str:
    """Record ``path`` as trusted and return its canonical key."""
    key = normalize(path)
    folders = load_trusted(home)
    if key in folders:
        return key
    folders[key] = {"trusted_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    target = trust_file(home)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(target.parent, 0o700)
    except OSError:
        pass
    payload = json.dumps({"version": 1, "folders": folders}, ensure_ascii=False, indent=2)
    fd, tmp = tempfile.mkstemp(prefix=".trust-", dir=str(target.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return key


def remove_trusted(path, home: Path | None = None) -> bool:
    key = normalize(path)
    folders = load_trusted(home)
    if key not in folders:
        return False
    del folders[key]
    target = trust_file(home)
    target.write_text(
        json.dumps({"version": 1, "folders": folders}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return True
