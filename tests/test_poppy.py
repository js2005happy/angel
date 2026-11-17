"""Poppy discovery: protocol-version, redirect, SSRF and opt-in regressions.

No tests contact public sites, start MCP, sign in or use paid providers.
"""

import io
import ipaddress
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import nyra.agent as agent_module
import nyra.cli as cli
import nyra.poppy as poppy
from nyra.agent import Agent
from nyra.tools import ToolContext, execute_tool


def document(host="store.example.com", version="1.0", **fields):
    doc = {
        "protocol_version": version,
        "organization": {"name": "Example Store", "domain": host},
        "auth": {
            "scopes": {
                "orders:read": "Read orders",
                "orders:write": "Modify orders",
            },
            "scope_hints": {
                "orders:read": {"changes": "none", "personal_data": True},
                "orders:write": {"changes": "irreversible", "personal_data": True},
            },
        },
        "apis": [
            {"type": "mcp", "url": "https://mcp.example.com/mcp",
             "description": "Search for products"},
            {"type": "openapi", "url": "https://api.example.com/openapi.json",
             "description": "Read product catalog"},
        ],
        "agent": {"protocols": [
            {"type": "poppy", "endpoint": "https://help.example.com/poppy",
             "description": "Customer service"},
        ]},
        "web": {"disabled": True},
    }
    doc.update(fields)
    return json.dumps(doc).encode("utf-8")


class DiscoveryTests(unittest.TestCase):
    def test_site_url_normalization(self):
        self.assertEqual(poppy._site_url("store.example.com/products?foo=bar"),
                         "https://store.example.com/.well-known/poppy.json")
        self.assertEqual(poppy._site_url("https://store.example.com/"),
                         "https://store.example.com/.well-known/poppy.json")

    def test_readonly_discovery_declares_but_never_invokes_endpoints(self):
        requests = []
        def fetch(url, *, allow_redirect=True):
            requests.append((url, allow_redirect))
            return url, document()
        output = poppy.discover_poppy("https://store.example.com/cart", fetch=fetch)
        self.assertEqual(requests, [
            ("https://store.example.com/.well-known/poppy.json", True)
        ])
        self.assertEqual(output["status"], "metadata_only")
        self.assertEqual(output["version"], "1.0")
        self.assertTrue(output["read_only_discovery"])
        self.assertEqual(output["organization"]["domain"], "store.example.com")
        self.assertEqual(
            [item["type"] for item in output["channels"]],
            ["mcp", "openapi", "company_agent", "web"],
        )
        self.assertEqual(output["scopes"][1]["changes"], "irreversible")
        self.assertTrue(output["channels"][-1]["disabled"])
        self.assertIn("尚未建立", output["warning"])

    def test_redirect_final_well_known_path_must_be_exact(self):
        def broken(url, *, allow_redirect=True):
            return "https://store.example.com/public/uploads/poppy.json", document()
        with self.assertRaisesRegex(poppy.PoppyError, "well-known"):
            poppy.discover_poppy("store.example.com", fetch=broken)
        def query(url, *, allow_redirect=True):
            return url + "?source=upload", document()
        with self.assertRaisesRegex(poppy.PoppyError, "well-known"):
            poppy.discover_poppy("store.example.com", fetch=query)

    def test_rejects_incorrect_organization_domain_after_redirect(self):
        def fake(url, *, allow_redirect=True):
            return "https://api.example.com/.well-known/poppy.json", document()
        with self.assertRaisesRegex(poppy.PoppyError, "organization.domain"):
            poppy.discover_poppy("store.example.com", fetch=fake)

    def test_supported_version_selected_only_on_same_final_host(self):
        initial = document(version="0.4", supported_versions={
            "1.0": "https://store.example.com/poppy/v1.json",
        })
        calls = []
        def fetch(url, *, allow_redirect=True):
            calls.append((url, allow_redirect))
            if "v1.json" in url:
                return url, document()
            return url, initial
        result = poppy.discover_poppy("store.example.com", fetch=fetch)
        self.assertEqual(result["version"], "1.0")
        self.assertEqual(calls[1], (
            "https://store.example.com/poppy/v1.json", False
        ))

    def test_rejects_no_version_and_other_host_version(self):
        old = document(version="0.4")
        with self.assertRaisesRegex(poppy.PoppyError, "不支持"):
            poppy.discover_poppy("store.example.com",
                                 fetch=lambda url, **kw: (url, old))
        wrong = document(version="0.4", supported_versions={
            "1.0": "https://evil.example.com/v1.json",
        })
        with self.assertRaisesRegex(poppy.PoppyError, "同一个"):
            poppy.discover_poppy("store.example.com",
                                 fetch=lambda url, **kw: (url, wrong))

    def test_rejects_version_redirect_or_wrong_version_in_alternate(self):
        initial = document(version="0.4", supported_versions={
            "1.0": "https://store.example.com/v1.json",
        })
        def malicious(url, *, allow_redirect=True):
            if url.endswith("/v1.json"):
                return "https://store.example.com/v2.json", document()
            return url, initial
        with self.assertRaisesRegex(poppy.PoppyError, "不得重定向"):
            poppy.discover_poppy("store.example.com", fetch=malicious)
        def wrong(url, *, allow_redirect=True):
            return (url, document(version="0.4") if url.endswith("/v1.json")
                    else initial)
        with self.assertRaisesRegex(poppy.PoppyError, "protocol_version"):
            poppy.discover_poppy("store.example.com", fetch=wrong)

    def test_rejects_nonhttps_credentials_private_literals_ports(self):
        bad = [
            "http://store.example.com",
            "ftp://store.example.com",
            "https://user:pass@store.example.com",
            "https://127.0.0.1",
            "https://192.168.1.50",
            "https://[::1]",
            "https://store.example.com:8000",
            "https://store.example.com#credentials",
            "localhost",
            "internal",
            "",
        ]
        for url in bad:
            with self.subTest(url=url), self.assertRaises(poppy.PoppyError):
                poppy._site_url(url)

    def test_dns_rejects_private_mixed_and_reserved_responses(self):
        for hosts in (
            ["127.0.0.1"], ["10.0.0.1"], ["169.254.1.2"],
            ["192.168.2.2"], ["::1"], ["2001:db8::1"],
            ["8.8.8.8", "10.0.0.1"],
        ):
            with self.subTest(ips=hosts), mock.patch(
                "nyra.poppy.socket.getaddrinfo",
                return_value=[
                    (2, 1, 6, "", (ip, 443))
                    for ip in hosts
                ],
            ):
                with self.assertRaisesRegex(poppy.PoppyError, "拒绝访问"):
                    poppy._public_addresses("store.example.com")

    def test_transport_pins_public_dns_and_never_uses_proxy(self):
        class FakeResponse:
            status = 200
            def getheader(self, key):
                return None
            def read(self, limit):
                return document()

        connections = []
        class FakeConn:
            def __init__(self, hostname, ip, timeout):
                self.host = hostname
                self.ip = ip
                connections.append(self)
            def request(self, method, path, headers):
                self.requested = (method, path, headers)
            def getresponse(self):
                return FakeResponse()
            def close(self):
                pass

        with mock.patch("nyra.poppy.socket.getaddrinfo", return_value=[
            (2, 1, 6, "", ("8.8.8.8", 443))
        ]), mock.patch("nyra.poppy._PinnedHTTPSConnection", FakeConn):
            final, raw = poppy._fetch_public_https(
                "https://store.example.com/.well-known/poppy.json"
            )
        self.assertEqual(connections[0].ip, "8.8.8.8")
        self.assertEqual(connections[0].host, "store.example.com")
        self.assertEqual(connections[0].requested[0], "GET")
        self.assertNotIn("Authorization", connections[0].requested[2])
        self.assertIn("protocol_version", raw.decode("utf-8"))
        self.assertEqual(final, "https://store.example.com/.well-known/poppy.json")

    def test_transport_https_redirect_rejects_private_target(self):
        class RedirectResponse:
            status = 302
            def getheader(self, key):
                return "http://localhost/.well-known/poppy.json"
        class FakeConn:
            def __init__(self, *args):
                pass
            def request(self, *args, **kwargs):
                pass
            def getresponse(self):
                return RedirectResponse()
            def close(self):
                pass
        with mock.patch("nyra.poppy.socket.getaddrinfo", return_value=[
            (2, 1, 6, "", ("8.8.8.8", 443))
        ]), mock.patch("nyra.poppy._PinnedHTTPSConnection", FakeConn):
            with self.assertRaisesRegex(poppy.PoppyError, "HTTPS"):
                poppy._fetch_public_https(
                    "https://store.example.com/.well-known/poppy.json"
                )

    def test_invalid_http_length_is_a_clear_discovery_error(self):
        class BadResponse:
            status = 200
            def getheader(self, key):
                return "not-a-number" if key == "Content-Length" else None
            def read(self, limit):
                raise AssertionError("invalid length must fail before body read")
        class FakeConn:
            def __init__(self, *args):
                pass
            def request(self, *args, **kwargs):
                pass
            def getresponse(self):
                return BadResponse()
            def close(self):
                pass
        with mock.patch("nyra.poppy.socket.getaddrinfo", return_value=[
            (2, 1, 6, "", ("8.8.8.8", 443))
        ]), mock.patch("nyra.poppy._PinnedHTTPSConnection", FakeConn):
            with self.assertRaisesRegex(poppy.PoppyError, "Content-Length"):
                poppy._fetch_public_https(
                    "https://store.example.com/.well-known/poppy.json"
                )

    def test_large_json_document_rejected(self):
        with self.assertRaises(poppy.PoppyError):
            poppy._doc(b"[]" , "store.example.com")
        with self.assertRaises(poppy.PoppyError):
            poppy._doc(b"{invalid}", "store.example.com")


class OptInToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.ctx = ToolContext(
            workdir=self.root, mode="readonly", interactive=False,
            memory_path=self.root / "MEMORY.md", skills_dir=self.root / "skills",
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_disabled_by_default_even_when_tool_name_forced(self):
        with mock.patch("nyra.tools.discover_poppy") as discovery:
            result = execute_tool("poppy_discover", {"site": "store.example.com"}, self.ctx)
        self.assertIn("未启用", result)
        discovery.assert_not_called()

    def test_explicitly_enabled_tool_works_in_readonly_without_signin(self):
        self.ctx.poppy_enabled = True
        with mock.patch("nyra.tools.discover_poppy", return_value={
            "version": "1.0", "status": "metadata_only",
        }) as discovery:
            result = execute_tool("poppy_discover", {"site": "store.example.com"}, self.ctx)
        self.assertEqual(json.loads(result)["status"], "metadata_only")
        discovery.assert_called_once_with("store.example.com")

    def test_agent_only_advertises_tool_when_enabled_and_delegates_inherit(self):
        from nyra.agent import Agent
        with mock.patch.object(agent_module, "NYRA_HOME", self.root / "home"):
            a = Agent(object(), workdir=self.root, mode="readonly", interactive=False,
                      skills_dirs=[], poppy_enabled=False)
            b = Agent(object(), workdir=self.root, mode="readonly", interactive=False,
                      skills_dirs=[], poppy_enabled=True)
        self.assertNotIn("poppy_discover", [s["function"]["name"] for s in a.tool_schemas()])
        self.assertIn("poppy_discover", [s["function"]["name"] for s in b.tool_schemas()])
        self.assertTrue(b.ctx.poppy_enabled)

    def test_jsonl_conflict_still_emits_structured_error(self):
        with mock.patch("sys.stdout", new_callable=io.StringIO) as stdout:
            status = cli.main(["--json", "--discover-poppy", "store.example.com"])
        self.assertEqual(status, 2)
        output = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(len(output), 1)
        self.assertEqual(output[0]["type"], "run_failed")

    def test_standalone_cli_does_not_require_provider_or_mcp(self):
        with mock.patch("nyra.poppy.discover_poppy", return_value={
            "version": "1.0", "status": "metadata_only"
        }), mock.patch.object(cli, "Provider") as provider, \
             mock.patch.object(cli, "build_mcp_manager") as mcp, \
             mock.patch("sys.stdout", new_callable=io.StringIO) as stdout:
            code = cli.main(["--discover-poppy", "store.example.com"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue())["version"], "1.0")
        provider.assert_not_called()
        mcp.assert_not_called()


if __name__ == "__main__":
    unittest.main()
