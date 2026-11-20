"""Read-only, dependency-free audit of Angel/Nyra runtime boundaries.

This tool inspects source text only; matching tokens do not prove a dynamic
call graph, lock coverage, or successful tool execution. No target code runs.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

MAX_SOURCE_BYTES = 2 * 1024 * 1024
PATHS = {
    "python_entry": "angel/__main__.py",
    "python_agent": "angel/agent.py",
    "python_journal": "angel/tool_journal.py",
    "node_manifest": "package.json",
    "node_cli": "src/cli.ts",
    "node_agent": "src/agent.ts",
    "node_tools": "src/tools.ts",
    "node_gateway": "src/gateway.ts",
    "node_memory": "src/memory.ts",
}
PROBES = {
    "python_journal_reference": ("angel/agent.py", "tool_journal"),
    "node_execute_tool_reference": ("src/agent.ts", "executeTool"),
    "node_idempotent_reference": ("src/agent.ts", "executeToolIdempotent"),
    "node_execute_tool_definition": ("src/tools.ts", "function executeTool"),
    "node_cli_agent_reference": ("src/cli.ts", "from \"./agent.ts\""),
    "node_tool_result_persistence": ("src/agent.ts", "saveSession(this.sessionId, messages.slice(1), this.home)"),
    "node_tool_result_append": ("src/agent.ts", "messages.push({ role: \"tool\""),
    "node_gateway_agent_run": ("src/gateway.ts", "run.agent!.run(text)"),
    "node_gateway_scheduler_run": ("src/gateway.ts", "agent.run(task.prompt)"),
    "node_memory_save_definition": ("src/memory.ts", "function saveSession"),
}


def _source(root: Path, relative: str) -> tuple[str | None, str]:
    """Read a bounded ordinary file, never following a symlink in its path."""
    path = root
    try:
        for part in Path(relative).parts:
            path = path / part
            if path.is_symlink():
                return None, "symlink"
        if not path.is_file():
            return None, "missing"
        if path.stat().st_size > MAX_SOURCE_BYTES:
            return None, "oversize"
        # Static audit only; avoid reading arbitrarily large or special files.
        with path.open("rb") as handle:
            raw = handle.read(MAX_SOURCE_BYTES + 1)
        if len(raw) > MAX_SOURCE_BYTES:
            return None, "oversize"
        return raw.decode("utf-8"), "ok"
    except (OSError, UnicodeError):
        return None, "unreadable"


def inspect_tree(root: Path) -> dict[str, object]:
    """Report file status and line-numbered textual references."""
    statuses = {key: _source(root, name)[1] for key, name in PATHS.items()}
    references = {}
    for key, (filename, token) in PROBES.items():
        source, status = _source(root, filename)
        references[key] = {
            "status": status,
            "lines": ([number for number, line in enumerate(source.splitlines(), 1)
                       if token in line][:30] if source is not None else []),
            "truncated": (sum(token in line for line in source.splitlines()) > 30
                          if source is not None else False),
        }
    return {
        "root": str(root),
        "present": {key: status == "ok" for key, status in statuses.items()},
        "file_status": statuses,
        "text_references": references,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("development_tree", type=Path)
    parser.add_argument("main_tree", type=Path)
    args = parser.parse_args()
    development = inspect_tree(args.development_tree)
    main = inspect_tree(args.main_tree)
    split = (development["file_status"]["python_agent"] == "ok"
             and development["file_status"]["node_agent"] == "missing"
             and main["file_status"]["node_agent"] == "ok")
    # Main runtime anchors are required: a missing textual match may mean the
    # upstream code moved. Do not silently report a complete dispatch audit.
    required_node_anchors = tuple(key for key in PROBES if key.startswith("node_"))
    missing_node_anchors = [key for key in required_node_anchors
                            if main["text_references"][key]["status"] != "ok"
                            or not main["text_references"][key]["lines"]]
    # Required entry files must exist even if textual probes elsewhere match.
    required_files = {
        "development": ("python_entry", "python_agent", "python_journal"),
        "main": ("node_manifest", "node_cli", "node_agent", "node_tools", "node_gateway", "node_memory"),
    }
    missing_required_files = {
        "development": [key for key in required_files["development"]
                        if development["file_status"][key] != "ok"],
        "main": [key for key in required_files["main"]
                 if main["file_status"][key] != "ok"],
    }
    # A failed inspection must not be mistaken for a missing runtime.
    errors = any(status not in ("ok", "missing")
                 for tree in (development, main)
                 for status in tree["file_status"].values())
    incomplete = (errors or not split or bool(missing_node_anchors)
                  or any(missing_required_files.values()))
    print(json.dumps({
        "schema_version": 5,
        "development": development,
        "main": main,
        "runtime_split_detected": split if not errors else None,
        "audit_incomplete": incomplete,
        "missing_required_files": missing_required_files,
        "missing_node_anchors": missing_node_anchors,
        "node_protected_by_python_journal": "not_established",
        "node_dispatch_and_persistence": "textual_anchors_only_not_complete_call_graph",
        "static_only": True,
    }, ensure_ascii=False, indent=2))
    return 2 if incomplete else 0


if __name__ == "__main__":
    raise SystemExit(main())
