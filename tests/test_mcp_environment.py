"""MCP subprocess environment isolation tests (stdlib only)."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nyra.mcp import MCPClient, MCPError, MCPServerConfig

PROBE_SERVER = r'''
import json
import os
import sys

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "probe", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "env_probe", "inputSchema": {"type": "object"}}]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": json.dumps({
            "leaked_secret": "NYRA_TEST_PRIVATE_API_KEY" in os.environ,
            "explicit": os.environ.get("NYRA_TEST_EXPLICIT"),
            "inherited": os.environ.get("NYRA_TEST_ALLOWED"),
            "encoding": os.environ.get("PYTHONIOENCODING"),
        })}]}
    else:
        # 旧版服务器对握手前收到的未知方法回方法未找到，客户端据此回退。
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Method not found"}}) + "\n")
        sys.stdout.flush()
        continue
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}) + "\n")
    sys.stdout.flush()
'''


class MCPEnvironmentTest(unittest.TestCase):
    def test_default_excludes_unrelated_provider_credentials(self):
        with patch.dict(os.environ, {
            "DEEPSEEK_API_KEY": "hidden",
            "OPENAI_API_KEY": "hidden",
            "NYRA_TEST_PRIVATE_API_KEY": "hidden",
        }):
            cfg = MCPServerConfig(name="probe", command=sys.executable)
            env = MCPClient(cfg)._subprocess_env()
            for name in ("DEEPSEEK_API_KEY", "OPENAI_API_KEY", "NYRA_TEST_PRIVATE_API_KEY"):
                self.assertNotIn(name, env)
            self.assertIn("PATH", env)
            self.assertEqual(env["PYTHONIOENCODING"], "utf-8")

    def test_explicit_inheritance_and_overrides(self):
        with patch.dict(os.environ, {"NYRA_TEST_ALLOWED": "from-parent", "NYRA_TEST_PRIVATE_API_KEY": "hidden"}):
            cfg = MCPServerConfig.from_dict("probe", {
                "command": sys.executable,
                "inherit_env": ["NYRA_TEST_ALLOWED"],
                "env": {"NYRA_TEST_EXPLICIT": "allowed", "NYRA_TEST_ALLOWED": "override"},
            })
            env = MCPClient(cfg)._subprocess_env()
            self.assertEqual(env["NYRA_TEST_ALLOWED"], "override")
            self.assertEqual(env["NYRA_TEST_EXPLICIT"], "allowed")
            self.assertNotIn("NYRA_TEST_PRIVATE_API_KEY", env)

    def test_config_rejects_invalid_inheritance_shapes(self):
        for bad in (None, "HOME", [123], ["INVALID-NAME"], ["a=b"], [{}]):
            with self.subTest(bad=bad):
                with self.assertRaises(MCPError):
                    MCPServerConfig.from_dict("probe", {
                        "command": sys.executable, "inherit_env": bad,
                    })
        for bad in ("A=B", "", "INVALID-NAME"):
            with self.subTest(env=bad):
                with self.assertRaises(MCPError):
                    MCPServerConfig.from_dict("probe", {
                        "command": sys.executable, "env": {bad: "value"},
                    })

    def test_actual_subprocess_does_not_inherit_secret_by_default(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "mcp_probe.py"
            script.write_text(PROBE_SERVER, encoding="utf-8")
            cfg = MCPServerConfig(
                name="probe", command=sys.executable, args=["-u", str(script)],
                env={"NYRA_TEST_EXPLICIT": "allowed"},
                inherit_env=["NYRA_TEST_ALLOWED"],
            )
            with patch.dict(os.environ, {
                "NYRA_TEST_PRIVATE_API_KEY": "never-send-this",
                "NYRA_TEST_ALLOWED": "parent-allowed",
            }):
                with MCPClient(cfg, timeout=5) as client:
                    result = json.loads(client.call_tool("env_probe", {}))
            self.assertFalse(result["leaked_secret"])
            self.assertEqual(result["explicit"], "allowed")
            self.assertEqual(result["inherited"], "parent-allowed")
            self.assertEqual(result["encoding"], "utf-8")


if __name__ == "__main__":
    unittest.main()
