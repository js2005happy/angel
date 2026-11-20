"""Read-only, dependency-free audit of Angel/Nyra runtime boundaries.

This tool inspects source text only. It never executes the target project and
cannot prove that all runtime dispatch paths are covered.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def inspect_tree(root: Path) -> dict[str, object]:
    """Report entrypoints and static dispatch references without importing code."""
    paths = {
        "python_entry": "angel/__main__.py",
        "python_agent": "angel/agent.py",
        "python_journal": "angel/tool_journal.py",
        "node_manifest": "package.json",
        "node_cli": "src/cli.ts",
        "node_agent": "src/agent.ts",
        "node_tools": "src/tools.ts",
    }
    present = {key: (root / name).is_file() for key, name in paths.items()}
    evidence: dict[str, bool] = {}
    for key, filename, token in (
        ("python_journal_reference", "angel/agent.py", "tool_journal"),
        ("node_execute_tool_reference", "src/agent.ts", "executeTool"),
        ("node_idempotent_reference", "src/agent.ts", "executeToolIdempotent"),
        ("node_execute_tool_definition", "src/tools.ts", "function executeTool"),
    ):
        path = root / filename
        if not path.is_file() or path.is_symlink():
            evidence[key] = False
            continue
        try:
            evidence[key] = token in path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            evidence[key] = False
    return {"root": str(root), "present": present, "text_references": evidence}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("development_tree", type=Path)
    parser.add_argument("main_tree", type=Path)
    args = parser.parse_args()
    development = inspect_tree(args.development_tree)
    main = inspect_tree(args.main_tree)
    dev_python = bool(development["present"]["python_agent"])
    main_node = bool(main["present"]["node_agent"])
    split = dev_python and main_node and not bool(development["present"]["node_agent"])
    print(json.dumps({
        "schema_version": 1,
        "development": development,
        "main": main,
        "runtime_split_detected": split,
        "node_protected_by_python_journal": "not_established",
        "static_only": True,
    }, ensure_ascii=False, indent=2))
    return 0 if split else 2


if __name__ == "__main__":
    raise SystemExit(main())
