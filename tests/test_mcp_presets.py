"""Tests for built-in MCP server presets (nyra/mcp_presets.py).

Unit tests run offline. Live tests (real npx/uvx servers) only run
with NYRA_LIVE_MCP_TESTS=1, because the suite is otherwise mock-only
and must not need network access.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from nyra.config import DEFAULT_CONFIG
from nyra.mcp import MCPClient, load_mcp_servers
from nyra.mcp_presets import (
    DEFAULT_MCP_PRESETS,
    MCP_PRESETS,
    get_preset,
    list_presets,
    resolve_preset,
)

LIVE = os.environ.get("NYRA_LIVE_MCP_TESTS") == "1"


class PresetCatalogTest(unittest.TestCase):
    def test_every_preset_has_required_fields(self):
        self.assertTrue(MCP_PRESETS)
        for name, preset in MCP_PRESETS.items():
            self.assertRegex(name, r"^[a-z0-9-]+$", name)
            self.assertIn(preset["command"], ("npx", "uvx"), name)
            self.assertIsInstance(preset["args"], list, name)
            self.assertTrue(preset["args"], name)
            self.assertIsInstance(preset["args"][0], str, name)
            self.assertIsInstance(preset["description"], str, name)
            self.assertTrue(preset["description"], name)
            self.assertIsInstance(preset["note"], str, name)
            self.assertIsInstance(preset["requires_env"], list, name)
            self.assertIsInstance(preset["requires_args"], bool, name)
            self.assertIsInstance(preset["env"], dict, name)

    def test_default_presets_are_ready_tier_only(self):
        self.assertTrue(DEFAULT_MCP_PRESETS)
        for name in DEFAULT_MCP_PRESETS:
            preset = MCP_PRESETS[name]
            self.assertEqual(preset["requires_env"], [], name)
            self.assertFalse(preset["requires_args"], name)

    def test_default_config_matches_preset_defaults(self):
        self.assertEqual(
            DEFAULT_CONFIG["mcp_presets"], list(DEFAULT_MCP_PRESETS)
        )
        self.assertEqual(DEFAULT_CONFIG["mcp_preset_args"], {})

    def test_get_and_list_presets(self):
        self.assertEqual(get_preset("memory")["command"], "npx")
        self.assertIsNone(get_preset("not-a-preset"))
        names = [p["name"] for p in list_presets()]
        self.assertEqual(names, sorted(MCP_PRESETS))
        self.assertEqual(names, sorted(names))


class ResolvePresetTest(unittest.TestCase):
    def test_ready_preset_resolves(self):
        raw, reason = resolve_preset("memory", {})
        self.assertIsNone(reason)
        self.assertEqual(raw["command"], "npx")
        self.assertEqual(
            raw["args"], ["-y", "@modelcontextprotocol/server-memory"]
        )
        self.assertNotIn("inherit_env", raw)

    def test_unknown_preset(self):
        raw, reason = resolve_preset("nope", {})
        self.assertIsNone(raw)
        self.assertIn("未知", reason)

    def test_key_preset_skipped_without_key(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            raw, reason = resolve_preset("github", {})
        self.assertIsNone(raw)
        self.assertIn("GITHUB_PERSONAL_ACCESS_TOKEN", reason)

    def test_key_preset_resolves_with_key(self):
        with mock.patch.dict(
            os.environ, {"GITHUB_PERSONAL_ACCESS_TOKEN": "x"}, clear=True
        ):
            raw, reason = resolve_preset("github", {})
        self.assertIsNone(reason)
        self.assertEqual(raw["inherit_env"], ["GITHUB_PERSONAL_ACCESS_TOKEN"])

    def test_path_preset_needs_args(self):
        raw, reason = resolve_preset("filesystem", {})
        self.assertIsNone(raw)
        self.assertIn("mcp_preset_args", reason)
        raw, reason = resolve_preset(
            "filesystem", {"filesystem": ["/tmp"]}, {}
        )
        self.assertIsNone(reason)
        self.assertEqual(
            raw["args"],
            ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        )

    def test_path_preset_rejects_bad_args(self):
        for bad in ({"filesystem": []}, {"filesystem": "x"}, {"filesystem": [1]}):
            raw, reason = resolve_preset("filesystem", bad)
            self.assertIsNone(raw, bad)
            self.assertIn("mcp_preset_args", reason)


class LoadPresetsTest(unittest.TestCase):
    def test_empty_config_loads_default_presets(self):
        servers = load_mcp_servers({})
        self.assertEqual(list(servers), list(DEFAULT_MCP_PRESETS))

    def test_empty_preset_list_disables_presets(self):
        servers = load_mcp_servers({"mcp_presets": []})
        self.assertEqual(servers, {})

    def test_non_list_presets_falls_back_to_default(self):
        servers = load_mcp_servers({"mcp_presets": "memory"})
        self.assertEqual(list(servers), list(DEFAULT_MCP_PRESETS))

    def test_unknown_preset_name_skipped(self):
        servers = load_mcp_servers({"mcp_presets": ["memory", "nope"]})
        self.assertEqual(list(servers), ["memory"])

    def test_user_entry_overrides_preset(self):
        servers = load_mcp_servers(
            {
                "mcp_presets": ["memory"],
                "mcp_servers": {"memory": {"command": "python3"}},
            }
        )
        self.assertEqual(list(servers), ["memory"])
        self.assertEqual(servers["memory"].command, "python3")

    def test_key_preset_via_load(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            servers = load_mcp_servers({"mcp_presets": ["github"]})
        self.assertEqual(servers, {})
        with mock.patch.dict(
            os.environ, {"GITHUB_PERSONAL_ACCESS_TOKEN": "x"}, clear=True
        ):
            servers = load_mcp_servers({"mcp_presets": ["github"]})
        self.assertEqual(list(servers), ["github"])
        self.assertEqual(
            servers["github"].inherit_env, ["GITHUB_PERSONAL_ACCESS_TOKEN"]
        )

    def test_path_preset_via_load(self):
        servers = load_mcp_servers(
            {
                "mcp_presets": ["filesystem"],
                "mcp_preset_args": {"filesystem": ["/tmp"]},
            }
        )
        self.assertEqual(list(servers), ["filesystem"])
        self.assertEqual(
            servers["filesystem"].args,
            ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        )


@unittest.skipUnless(LIVE, "live preset tests need NYRA_LIVE_MCP_TESTS=1")
@unittest.skipUnless(shutil.which("npx"), "npx not installed")
class LiveReadyPresetTest(unittest.TestCase):
    """Start each ready-tier preset for real and list its tools."""

    def _check_preset(self, name):
        servers = load_mcp_servers({"mcp_presets": [name]})
        self.assertEqual(list(servers), [name])
        client = MCPClient(servers[name], timeout=120.0)
        client.start()
        try:
            tools = client.list_tools()
            self.assertTrue(tools, name)
            self.assertTrue(
                all(re.match(r"^[A-Za-z0-9_.-]+$", t["name"]) for t in tools),
                name,
            )
        finally:
            client.stop()

    def test_memory(self):
        self._check_preset("memory")

    def test_sequential_thinking(self):
        self._check_preset("sequential-thinking")


@unittest.skipUnless(LIVE, "live preset tests need NYRA_LIVE_MCP_TESTS=1")
@unittest.skipUnless(shutil.which("uvx"), "uvx not installed")
class LiveUvxPresetTest(unittest.TestCase):
    """Start each uvx-based preset for real and list its tools."""

    def _check_preset(self, name):
        servers = load_mcp_servers({"mcp_presets": [name]})
        self.assertEqual(list(servers), [name])
        client = MCPClient(servers[name], timeout=120.0)
        client.start()
        try:
            tools = client.list_tools()
            self.assertTrue(tools, name)
        finally:
            client.stop()

    def test_fetch(self):
        self._check_preset("fetch")

    def test_time(self):
        self._check_preset("time")

    def test_git(self):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(
                ["git", "init", "-q", tmp],
                check=True,
                capture_output=True,
            )
            servers = load_mcp_servers(
                {
                    "mcp_presets": ["git"],
                    "mcp_preset_args": {"git": [tmp]},
                }
            )
            self.assertEqual(list(servers), ["git"])
            client = MCPClient(servers["git"], timeout=120.0)
            client.start()
            try:
                self.assertTrue(client.list_tools())
            finally:
                client.stop()

    def test_sqlite(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "test.db")
            servers = load_mcp_servers(
                {
                    "mcp_presets": ["sqlite"],
                    "mcp_preset_args": {"sqlite": [db]},
                }
            )
            self.assertEqual(list(servers), ["sqlite"])
            client = MCPClient(servers["sqlite"], timeout=120.0)
            client.start()
            try:
                self.assertTrue(client.list_tools())
            finally:
                client.stop()


@unittest.skipUnless(LIVE, "live preset tests need NYRA_LIVE_MCP_TESTS=1")
@unittest.skipUnless(shutil.which("npx"), "npx not installed")
class LivePathAndKeyPresetTest(unittest.TestCase):
    """Path presets (real temp dirs) and key presets (dummy keys)."""

    def test_filesystem(self):
        with tempfile.TemporaryDirectory() as tmp:
            servers = load_mcp_servers(
                {
                    "mcp_presets": ["filesystem"],
                    "mcp_preset_args": {"filesystem": [tmp]},
                }
            )
            client = MCPClient(servers["filesystem"], timeout=120.0)
            client.start()
            try:
                self.assertTrue(client.list_tools())
            finally:
                client.stop()

    def test_github_with_dummy_key(self):
        with mock.patch.dict(
            os.environ, {"GITHUB_PERSONAL_ACCESS_TOKEN": "dummy"}, clear=False
        ):
            servers = load_mcp_servers({"mcp_presets": ["github"]})
            client = MCPClient(servers["github"], timeout=120.0)
            client.start()
        try:
            self.assertTrue(client.list_tools())
        finally:
            client.stop()

    def test_brave_search_with_dummy_key(self):
        with mock.patch.dict(
            os.environ, {"BRAVE_API_KEY": "dummy"}, clear=False
        ):
            servers = load_mcp_servers({"mcp_presets": ["brave-search"]})
            client = MCPClient(servers["brave-search"], timeout=120.0)
            client.start()
        try:
            self.assertTrue(client.list_tools())
        finally:
            client.stop()


if __name__ == "__main__":
    unittest.main()
