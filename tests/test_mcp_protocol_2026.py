"""MCP 协议升级到 2026-07-28 的回归测试：双时代协商。

现代版（2026-07-28）：无握手，每次请求在 _meta 里自带协议版本与能力，
先用 server/discover 探测；旧版（2025-11-25 及以前）：initialize 握手。
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nyra import __version__ as NYRA_VERSION
from nyra.mcp import (
    MCPClient,
    MCPError,
    MCPRequestError,
    MCPServerConfig,
)

FAKE_SERVER = r'''
import json
import sys
import time

MODE = sys.argv[1]
LOG = sys.argv[2]

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def log_request(req):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(req, ensure_ascii=False) + "\n")

def err(rid, code, message, data=None):
    error = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    send({"jsonrpc": "2.0", "id": rid, "error": error})

def ok(rid, result):
    send({"jsonrpc": "2.0", "id": rid, "result": result})

DISCOVER_RESULT = {
    "resultType": "complete",
    "supportedVersions": ["2026-07-28", "2025-11-25"],
    "capabilities": {"tools": {}},
    "instructions": "test server",
    "_meta": {"io.modelcontextprotocol/serverInfo": {"name": "modern", "version": "1"}},
}
TOOLS = [{"name": "echo", "inputSchema": {"type": "object"}}]

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except ValueError:
        continue
    log_request(req)
    rid = req.get("id")
    if rid is None:
        continue
    method = req.get("method")
    if MODE == "modern":
        if method == "server/discover":
            ok(rid, DISCOVER_RESULT)
        elif method == "tools/list":
            ok(rid, {"resultType": "complete", "tools": TOOLS})
        elif method == "tools/call":
            ok(rid, {"resultType": "complete", "content": [{"type": "text", "text": "modern-ok"}]})
        else:
            err(rid, -32601, "Method not found")
    elif MODE == "modern-slow-discover":
        if method == "server/discover":
            # 模拟 npx/uvx 首次下载：服务器 7 秒后才回探测。
            # 探测超时（60 秒）必须等到它，不能误判为旧版。
            time.sleep(7)
            ok(rid, DISCOVER_RESULT)
        elif method == "tools/list":
            ok(rid, {"resultType": "complete", "tools": TOOLS})
        elif method == "tools/call":
            ok(rid, {"resultType": "complete", "content": [{"type": "text", "text": "modern-ok"}]})
        else:
            err(rid, -32601, "Method not found")
    elif MODE == "modern-paged":
        if method == "server/discover":
            ok(rid, DISCOVER_RESULT)
        elif method == "tools/list":
            cursor = (req.get("params") or {}).get("cursor")
            if cursor is None:
                ok(rid, {"resultType": "complete", "tools": TOOLS, "nextCursor": "p2"})
            elif cursor == "p2":
                ok(rid, {"resultType": "complete", "tools": [{"name": "shout", "inputSchema": {"type": "object"}}]})
            else:
                err(rid, -32602, "bad cursor")
        elif method == "tools/call":
            ok(rid, {"resultType": "complete", "content": [{"type": "text", "text": "modern-ok"}]})
        else:
            err(rid, -32601, "Method not found")
    elif MODE == "modern-input-required":
        if method == "server/discover":
            ok(rid, DISCOVER_RESULT)
        elif method == "tools/list":
            ok(rid, {"resultType": "complete", "tools": TOOLS})
        elif method == "tools/call":
            ok(rid, {
                "resultType": "input_required",
                "inputRequests": {"ir_1": {"method": "elicitation/create"}},
                "requestState": "state-1",
            })
        else:
            err(rid, -32601, "Method not found")
    elif MODE == "modern-endless-pages":
        if method == "server/discover":
            ok(rid, DISCOVER_RESULT)
        elif method == "tools/list":
            cursor = (req.get("params") or {}).get("cursor") or "0"
            nxt = str(int(cursor) + 1)
            ok(rid, {"resultType": "complete", "tools": TOOLS, "nextCursor": nxt})
        elif method == "tools/call":
            ok(rid, {"resultType": "complete", "content": [{"type": "text", "text": "modern-ok"}]})
        else:
            err(rid, -32601, "Method not found")
    elif MODE == "modern-image-only":
        if method == "server/discover":
            ok(rid, DISCOVER_RESULT)
        elif method == "tools/list":
            ok(rid, {"resultType": "complete", "tools": TOOLS})
        elif method == "tools/call":
            ok(rid, {"resultType": "complete", "content": [{"type": "image", "data": "QUJD" * 5000, "mimeType": "image/png"}]})
        else:
            err(rid, -32601, "Method not found")
    elif MODE in ("legacy", "legacy-old", "legacy-empty-discover",
                  "legacy-unknown-version", "modern-32022-legacy-only",
                  "silent-discover"):
        if method == "server/discover":
            if MODE == "silent-discover":
                time.sleep(2.5)
                err(rid, -32601, "Method not found")
            elif MODE == "legacy-empty-discover":
                ok(rid, {})
            elif MODE == "modern-32022-legacy-only":
                err(rid, -32022, "Unsupported protocol version",
                    {"supported": ["2025-11-25"], "requested": "2026-07-28"})
            else:
                err(rid, -32601, "Method not found")
        elif method == "initialize":
            version = "2025-11-25"
            if MODE == "legacy-old":
                version = "2024-11-05"
            elif MODE == "legacy-unknown-version":
                version = "2099-01-01"
            ok(rid, {"protocolVersion": version, "capabilities": {},
                     "serverInfo": {"name": "legacy", "version": "1"}})
        elif method == "tools/list":
            ok(rid, {"tools": TOOLS})
        elif method == "tools/call":
            ok(rid, {"content": [{"type": "text", "text": "legacy-ok"}]})
        else:
            err(rid, -32601, "Method not found")
    else:
        err(rid, -32601, "Method not found")
'''


class MCPProtocol2026Test(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.script = self.root / "fake_server.py"
        self.script.write_text(FAKE_SERVER, encoding="utf-8")
        self.log = self.root / "requests.jsonl"
        self.log.write_text("", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def config(self, mode):
        return MCPServerConfig(
            name="fake", command=sys.executable,
            args=["-u", str(self.script), mode, str(self.log)],
        )

    def requests(self):
        text = self.log.read_text(encoding="utf-8").strip()
        if not text:
            return []
        return [json.loads(line) for line in text.splitlines()]

    def methods(self):
        return [req.get("method") for req in self.requests()]

    def test_subprocess_env_passes_proxy_without_credentials(self):
        # 子进程要拿到代理与 CA 变量才能联网（npx/uvx 首次下载），
        # 但代理 URL 里嵌的密码必须去掉；API Key 之类的凭据仍不传。
        env = {
            "https_proxy": "http://user:pass@proxy.example:3128",
            "HTTP_PROXY": "http://proxy.example:3128",
            "NODE_EXTRA_CA_CERTS": "/run/hatch/egress-tls/ca-bundle.pem",
            "NO_PROXY": "localhost",
            "DEEPSEEK_API_KEY": "sk-secret",
        }
        with patch.dict(os.environ, env, clear=True):
            client = MCPClient(self.config("modern"), timeout=10.0)
            child_env = client._subprocess_env()
        self.assertEqual(
            child_env["https_proxy"], "http://proxy.example:3128"
        )
        self.assertEqual(child_env["HTTP_PROXY"], "http://proxy.example:3128")
        self.assertEqual(
            child_env["NODE_EXTRA_CA_CERTS"],
            "/run/hatch/egress-tls/ca-bundle.pem",
        )
        self.assertEqual(child_env["NO_PROXY"], "localhost")
        self.assertNotIn("DEEPSEEK_API_KEY", child_env)

    def test_subprocess_env_explicit_proxy_wins(self):
        # 用户在 inherit_env 里显式声明的代理变量优先，不被去凭据覆盖。
        config = self.config("modern")
        config.inherit_env = ["https_proxy"]
        with patch.dict(
            os.environ,
            {"https_proxy": "http://user:pass@proxy.example:3128"},
            clear=True,
        ):
            client = MCPClient(config, timeout=10.0)
            child_env = client._subprocess_env()
        self.assertEqual(
            child_env["https_proxy"], "http://user:pass@proxy.example:3128"
        )

    def test_modern_server_uses_discover_and_meta(self):
        client = MCPClient(self.config("modern"), timeout=10.0)
        try:
            client.start()
            self.assertEqual(client.era, "modern")
            self.assertEqual(client.negotiated_version, "2026-07-28")
            self.assertEqual(client.server_info, {"name": "modern", "version": "1"})
            self.assertEqual([t["name"] for t in client.tools], ["echo"])
            self.assertEqual(client.call_tool("echo", {}), "modern-ok")
        finally:
            client.stop()

        methods = self.methods()
        self.assertNotIn("initialize", methods)
        self.assertNotIn("notifications/initialized", methods)
        self.assertEqual(methods[0], "server/discover")
        for req in self.requests():
            meta = (req.get("params") or {}).get("_meta")
            self.assertIsInstance(meta, dict, req)
            self.assertEqual(
                meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28"
            )
            self.assertEqual(meta["io.modelcontextprotocol/clientCapabilities"], {})
            self.assertEqual(
                meta["io.modelcontextprotocol/clientInfo"],
                {"name": "Nyra", "version": NYRA_VERSION},
            )

    def test_slow_start_server_still_negotiates_modern(self):
        # 服务器 7 秒后才回探测（模拟 npx/uvx 首次下载）：探测必须
        # 等到它，走现代版；不能因超时误判为旧版、发 initialize。
        client = MCPClient(self.config("modern-slow-discover"), timeout=30.0)
        try:
            client.start()
            self.assertEqual(client.era, "modern")
            self.assertEqual(client.negotiated_version, "2026-07-28")
            self.assertEqual([t["name"] for t in client.tools], ["echo"])
        finally:
            client.stop()
        self.assertNotIn("initialize", self.methods())

    def test_legacy_server_falls_back_to_handshake(self):
        client = MCPClient(self.config("legacy"), timeout=10.0)
        try:
            client.start()
            self.assertEqual(client.era, "legacy")
            self.assertEqual(client.negotiated_version, "2025-11-25")
            self.assertEqual(client.server_info, {"name": "legacy", "version": "1"})
            self.assertEqual([t["name"] for t in client.tools], ["echo"])
            self.assertEqual(client.call_tool("echo", {}), "legacy-ok")
        finally:
            client.stop()

        seen = self.requests()
        self.assertEqual(seen[0]["method"], "server/discover")
        init = next(req for req in seen if req.get("method") == "initialize")
        self.assertEqual(
            init["params"]["protocolVersion"], "2025-11-25"
        )
        # 旧版握手请求不带现代 _meta，之后也不带。
        self.assertNotIn("_meta", init["params"])
        for req in seen:
            if req.get("method") in ("tools/list", "tools/call"):
                self.assertNotIn("_meta", req.get("params") or {})
        self.assertIn("notifications/initialized", self.methods())

    def test_legacy_server_with_older_version_accepted(self):
        client = MCPClient(self.config("legacy-old"), timeout=10.0)
        try:
            client.start()
            self.assertEqual(client.era, "legacy")
            self.assertEqual(client.negotiated_version, "2024-11-05")
            self.assertEqual(client.call_tool("echo", {}), "legacy-ok")
        finally:
            client.stop()

    def test_empty_discover_result_falls_back_to_legacy(self):
        client = MCPClient(self.config("legacy-empty-discover"), timeout=10.0)
        try:
            client.start()
            self.assertEqual(client.era, "legacy")
            self.assertEqual(client.negotiated_version, "2025-11-25")
        finally:
            client.stop()

    def test_unsupported_version_with_legacy_only_falls_back(self):
        client = MCPClient(self.config("modern-32022-legacy-only"), timeout=10.0)
        try:
            client.start()
            self.assertEqual(client.era, "legacy")
            self.assertEqual(client.negotiated_version, "2025-11-25")
            self.assertEqual(client.call_tool("echo", {}), "legacy-ok")
        finally:
            client.stop()

    def test_unknown_legacy_version_rejected(self):
        client = MCPClient(self.config("legacy-unknown-version"), timeout=10.0)
        with self.assertRaisesRegex(MCPError, "2099-01-01"):
            client.start()

    def test_silent_discover_times_out_then_falls_back(self):
        # 探测超时后回退握手；探测的迟到响应不能冲掉握手的 id 匹配。
        # 客户端超时 2 秒：探测在 2 秒超时，服务器 2.5 秒才回探测的错误，
        # 握手须在 4 秒截止前拿到响应。
        client = MCPClient(self.config("silent-discover"), timeout=2.0)
        try:
            client.start()
            self.assertEqual(client.era, "legacy")
            self.assertEqual(client.negotiated_version, "2025-11-25")
            self.assertEqual(client.call_tool("echo", {}), "legacy-ok")
        finally:
            client.stop()

    def test_tools_list_follows_pagination(self):
        client = MCPClient(self.config("modern-paged"), timeout=10.0)
        try:
            client.start()
            self.assertEqual(
                [t["name"] for t in client.tools], ["echo", "shout"]
            )
        finally:
            client.stop()
        list_calls = [
            req for req in self.requests()
            if req.get("method") == "tools/list"
        ]
        self.assertEqual(len(list_calls), 2)
        self.assertNotIn("cursor", list_calls[0].get("params") or {})
        self.assertEqual(list_calls[1]["params"]["cursor"], "p2")

    def test_input_required_raises_clear_error(self):
        client = MCPClient(self.config("modern-input-required"), timeout=10.0)
        try:
            client.start()
            with self.assertRaisesRegex(MCPError, "多轮往返"):
                client.call_tool("echo", {})
        finally:
            client.stop()

    def test_tools_list_endless_pagination_is_capped(self):
        from nyra.mcp import MAX_TOOL_LIST_PAGES

        client = MCPClient(self.config("modern-endless-pages"), timeout=10.0)
        try:
            with self.assertRaises(MCPError):
                client.start()
        finally:
            client.stop()
        list_calls = [
            req for req in self.requests()
            if req.get("method") == "tools/list"
        ]
        self.assertEqual(len(list_calls), MAX_TOOL_LIST_PAGES)

    def test_call_tool_image_only_does_not_dump_base64(self):
        client = MCPClient(self.config("modern-image-only"), timeout=10.0)
        try:
            client.start()
            out = client.call_tool("echo", {})
        finally:
            client.stop()
        self.assertIn("非文本内容", out)
        self.assertNotIn("QUJD", out)

    def test_pick_modern_version(self):
        self.assertEqual(
            MCPClient._pick_modern_version({"supported": ["2026-07-28"]}),
            "2026-07-28",
        )
        self.assertIsNone(
            MCPClient._pick_modern_version({"supported": ["2025-11-25"]})
        )
        self.assertIsNone(MCPClient._pick_modern_version({"supported": []}))
        self.assertIsNone(MCPClient._pick_modern_version({"supported": "x"}))
        self.assertIsNone(MCPClient._pick_modern_version(None))
        self.assertIsNone(MCPClient._pick_modern_version("2026-07-28"))

    def test_use_modern_rejects_incompatible_versions(self):
        client = MCPClient(self.config("modern"), timeout=10.0)
        with self.assertRaisesRegex(MCPError, "不支持任何"):
            client._use_modern({"supportedVersions": ["2025-11-25"]}, "2026-07-28")
        with self.assertRaisesRegex(MCPError, "supportedVersions"):
            client._use_modern({}, "2026-07-28")
        client._use_modern(
            {
                "supportedVersions": ["2026-07-28"],
                "_meta": {
                    "io.modelcontextprotocol/serverInfo": {"name": "s", "version": "2"}
                },
            },
            "2026-07-28",
        )
        self.assertEqual(client.era, "modern")
        self.assertEqual(client.negotiated_version, "2026-07-28")
        self.assertEqual(client.server_info, {"name": "s", "version": "2"})

    def test_32022_retry_with_listed_modern_version(self):
        client = MCPClient(self.config("modern"), timeout=10.0)
        discover_result = {
            "supportedVersions": ["2026-07-28"],
            "capabilities": {"tools": {}},
        }
        calls = []

        def fake_discover(version):
            calls.append(version)
            if len(calls) == 1:
                raise MCPRequestError(
                    "MCP 错误：Unsupported protocol version",
                    -32022,
                    {"supported": ["2026-07-28"], "requested": "2026-07-28"},
                )
            return discover_result

        with patch.object(client, "_discover", side_effect=fake_discover), \
             patch.object(client, "_initialize_legacy") as legacy:
            client._negotiate()
        legacy.assert_not_called()
        self.assertEqual(calls, ["2026-07-28", "2026-07-28"])
        self.assertEqual(client.era, "modern")
        self.assertEqual(client.negotiated_version, "2026-07-28")


if __name__ == "__main__":
    unittest.main()
