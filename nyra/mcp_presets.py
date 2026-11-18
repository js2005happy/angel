"""Built-in MCP server presets: pre-configured servers users can enable by name.

A preset is only a configuration recipe, not a running server. Nothing
here starts automatically: MCP stays off until the user enables it
(`mcp_enabled: true`), and in auto mode every server still asks for
approval before it starts (see agent.build_mcp_manager).

Tiers:
- "ready": works out of the box, no key and no path needed. These are
  enabled by default (DEFAULT_MCP_PRESETS).
- "needs-key": needs an API key in the environment. Enabled by name in
  `mcp_presets`; the server only starts when the key is present, and
  the key is forwarded to that server only (via inherit_env).
- "needs-path": needs a path (directory / repo / database file) from
  `mcp_preset_args`. Enabled by name in `mcp_presets` plus the path.

The catalog only lists servers whose package was confirmed to exist
(npm / PyPI) in November 2026. Active reference servers come from the
MCP project itself; archived ones are marked as such and are never in
the default set. Servers that need a browser download (puppeteer) or
a key the user does not have are opt-in only.
"""

import os
from pathlib import Path

# command/args are the fixed prefix; path presets append the user's
# mcp_preset_args entry to args. requires_env names are checked in
# os.environ; a missing key means the preset is skipped, never started
# with a fake value.
MCP_PRESETS = {
    "memory": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-memory"],
        "env": {},
        "requires_env": [],
        "requires_args": False,
        "description": "知识图谱记忆：长期记住对话里的事实、偏好和关系。",
        "note": "需要本机装好 Node.js（提供 npx 命令）。",
    },
    "sequential-thinking": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        "env": {},
        "requires_env": [],
        "requires_args": False,
        "description": "结构化思考：把复杂问题拆成步骤逐步推导。",
        "note": "需要本机装好 Node.js（提供 npx 命令）。",
    },
    "fetch": {
        "command": "uvx",
        "args": ["mcp-server-fetch"],
        "env": {},
        "requires_env": [],
        "requires_args": False,
        "description": "抓网页内容：把网页取回并转成干净的 Markdown。",
        "note": "需要本机装好 uv（提供 uvx 命令）。",
    },
    "time": {
        "command": "uvx",
        "args": ["mcp-server-time"],
        "env": {},
        "requires_env": [],
        "requires_args": False,
        "description": "时间与时区：当前时间、时区换算。",
        "note": "需要本机装好 uv（提供 uvx 命令）。",
    },
    "github": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": {},
        "requires_env": ["GITHUB_PERSONAL_ACCESS_TOKEN"],
        "requires_args": False,
        "description": "GitHub：读仓库、issue、PR、提交记录。",
        "note": "需要 GITHUB_PERSONAL_ACCESS_TOKEN。官方已归档，不再维护。",
    },
    "brave-search": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-brave-search"],
        "env": {},
        "requires_env": ["BRAVE_API_KEY"],
        "requires_args": False,
        "description": "Brave 搜索：网页搜索与本地搜索。",
        "note": "需要 BRAVE_API_KEY。官方已归档，不再维护。",
    },
    "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem"],
        "env": {},
        "requires_env": [],
        "requires_args": True,
        "description": "文件系统：只在用户允许的目录里读写、移动、搜索文件。",
        "note": "需要在 mcp_preset_args 里写要开放的目录，如 {\"filesystem\": [\"D:/docs\"]}。",
    },
    "git": {
        "command": "uvx",
        "args": ["mcp-server-git", "--repository"],
        "env": {},
        "requires_env": [],
        "requires_args": True,
        "description": "Git：读本地仓库的状态、历史、分支与 diff。",
        "note": "需要在 mcp_preset_args 里写仓库目录，如 {\"git\": [\"D:/repo\"]}。",
    },
    "sqlite": {
        "command": "uvx",
        "args": ["--with", "mcp==1.30.0", "mcp-server-sqlite", "--db-path"],
        "env": {},
        "requires_env": [],
        "requires_args": True,
        "description": "SQLite：查询本地 SQLite 数据库。",
        "note": "需要在 mcp_preset_args 里写数据库文件路径。官方已归档，不再维护；用 mcp 1.30.0 才能跑（新版 SDK 删了 resources 接口）。",
    },
    "puppeteer": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-puppeteer"],
        "env": {},
        "requires_env": [],
        "requires_args": False,
        "description": "浏览器自动化：用无头浏览器打开网页、截图、点页面元素。",
        "note": "首次使用会下载 Chromium（约 100MB 以上），比较慢。官方已归档，不再维护。",
    },
}

# Presets enabled by default (ready tier only: no key, no path).
DEFAULT_MCP_PRESETS = ("memory", "sequential-thinking", "fetch", "time")


def get_preset(name: str) -> dict | None:
    """Return a copy of one preset, or None for an unknown name."""
    preset = MCP_PRESETS.get(name)
    return dict(preset) if preset is not None else None


def list_presets() -> list[dict]:
    """Return every preset with its name included, sorted by name."""
    return [
        {"name": name, **preset}
        for name, preset in sorted(MCP_PRESETS.items())
    ]


def resolve_preset(name, preset_args=None, environ=None):
    """Resolve one preset name to a raw server config dict.

    Returns (raw_config, skip_reason): raw_config is a dict suitable
    for MCPServerConfig.from_dict, or None when the preset cannot be
    used; skip_reason names the missing key/path in that case, else
    None. User-supplied preset_args are appended to the preset's
    fixed args (for path presets). requires_env entries are forwarded
    via inherit_env only when present in the environment.
    """
    preset = MCP_PRESETS.get(name)
    if preset is None:
        return None, f"未知 MCP 预置：{name}"
    env = environ if environ is not None else os.environ
    missing_keys = [key for key in preset["requires_env"] if not env.get(key)]
    if missing_keys:
        return (
            None,
            f"MCP 预置 {name} 需要环境变量 {', '.join(missing_keys)}，未设置，已跳过",
        )
    args = list(preset["args"])
    if preset["requires_args"]:
        supplied = (preset_args or {}).get(name)
        if not isinstance(supplied, list) or not supplied or not all(
            isinstance(item, str) and item for item in supplied
        ):
            return (
                None,
                f"MCP 预置 {name} 需要在 mcp_preset_args 里提供路径，"
                f"如 {{\"mcp_preset_args\": {{\"{name}\": [\"<路径>\"]}}}}，已跳过",
            )
        args.extend(supplied)
    raw = {
        "command": preset["command"],
        "args": args,
        "env": dict(preset["env"]),
    }
    if name == "memory":
        # 知识图谱默认写进 npx 缓存目录，缓存一清就丢；改存到
        # ~/.nyra/memory.jsonl。用户在 env 里显式指定过则不动。
        graph_path = Path.home() / ".nyra" / "memory.jsonl"
        graph_path.parent.mkdir(parents=True, exist_ok=True)
        raw["env"].setdefault("MEMORY_FILE_PATH", str(graph_path))
    if preset["requires_env"]:
        raw["inherit_env"] = list(preset["requires_env"])
    return raw, None
