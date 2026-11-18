"""Poppy 1.0 OAuth metadata binding tests: no credentials or remote actions."""

import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import nyra.cli as cli
import nyra.poppy_identity as identity
from nyra.agent import Agent
from nyra.poppy import PoppyError
from nyra.tools import ToolContext, execute_tool


DOMAIN = "store.example.com"
RESOURCE_URL = "https://" + DOMAIN + "/.well-known/oauth-protected-resource"
ISSUER = "https://auth.example.com"
ISSUER_META = ISSUER + "/.well-known/oauth-authorization-server"


def company(issuer_hint=None, disabled=False):
    return {
        "version": "1.0",
        "organization": {"name": "Store", "domain": DOMAIN},
        "auth_issuer_hint": issuer_hint, "auth_disabled": disabled,
    }


def protected(servers=None, resource=None, **extra):
    d = {
        "resource": "https://" + DOMAIN if resource is None else resource,
        "authorization_servers": [ISSUER] if servers is None else servers,
        "scopes_supported": ["orders:read"],
    }
    d.update(extra)
    return d


def issuer_metadata(issuer=ISSUER, resources=None, grants=None, **extra):
    d = {
        "issuer": issuer,
        "protected_resources": (
            ["https://" + DOMAIN] if resources is None else resources
        ),
        "token_endpoint": ISSUER + "/oauth/token",
        "revocation_endpoint": ISSUER + "/oauth/revoke",
        "authorization_endpoint": ISSUER + "/oauth/authorize",
        "grant_types_supported": (
            ["refresh_token", "authorization_code"] if grants is None else grants
        ),
        "scopes_supported": ["orders:read", "orders:write"],
    }
    d.update(extra)
    return d


def fake_transport(entries, calls):
    def fetch(url, *, allow_redirect=False, allow_not_found=False):
        calls.append((url, allow_redirect, allow_not_found))
        if url not in entries:
            raise AssertionError("unexpected OAuth metadata URL: " + url)
        value = entries[url]
        if isinstance(value, Exception):
            raise value
        if value is None:
            return url, None
        if isinstance(value, bytes):
            return url, value
        return url, json.dumps(value).encode("utf-8")
    return fetch


class OAuthIdentityTests(unittest.TestCase):
    def preflight(self, entries, discovery=None):
        calls = []
        result = identity.inspect_poppy_identity(
            DOMAIN, discoverer=lambda s: company() if discovery is None else discovery,
            fetch=fake_transport(entries, calls),
        )
        return result, calls

    def test_two_sided_verified_issuer_metadata(self):
        result, calls = self.preflight({
            RESOURCE_URL: protected(),
            ISSUER_META: issuer_metadata(),
        })
        self.assertEqual(
            [x[0] for x in calls], [RESOURCE_URL, ISSUER_META]
        )
        self.assertTrue(all(x[1] is False for x in calls))
        self.assertTrue(calls[0][2])
        self.assertFalse(calls[1][2])
        self.assertTrue(result["issuer_link_verified"])
        self.assertEqual(result["identifier"], ISSUER)
        self.assertEqual(result["issuer"], ISSUER)
        self.assertTrue(result["signed_in_available"])
        self.assertTrue(result["sign_in_hints"]["direct"])
        self.assertEqual(result["scopes_supported"], [
            "orders:read", "orders:write"
        ])
        self.assertFalse(result["session_ready"])
        self.assertFalse(result["oauth_ready"])
        self.assertFalse(result["remote_calls_allowed"])

    def test_no_issuer_is_signed_out_only_not_a_verified_session(self):
        for data, status in (
            (None, "not_found"),
            (protected(servers=[]), "valid_without_issuer"),
        ):
            with self.subTest(status=status):
                result, calls = self.preflight({RESOURCE_URL: data})
                self.assertIsNone(result["issuer"])
                self.assertEqual(result["protected_resource_status"], status)
                self.assertEqual(result["status"], "signed_out_metadata_only")
                self.assertFalse(result["signed_in_available"])
                self.assertFalse(result["session_ready"])
                self.assertEqual(len(calls), 1)

    def test_404_never_falls_back_when_company_claims_issuer(self):
        for data in (None, protected(servers=[])):
            with self.subTest(data=data), self.assertRaises(identity.IdentityError):
                self.preflight({RESOURCE_URL: data}, company(ISSUER))

    def test_timeout_or_403_does_not_get_interpreted_as_no_issuer(self):
        for error in (PoppyError("HTTP 403"), PoppyError("network timeout")):
            with self.subTest(error=error), self.assertRaises(PoppyError):
                self.preflight({RESOURCE_URL: error})

    def test_resource_must_identify_exact_company_origin(self):
        for resource in (
            "https://elsewhere.example.com",
            "http://" + DOMAIN,
            "https://" + DOMAIN + "/",
            "https://" + DOMAIN + ":443",
            "https://" + DOMAIN + "/api",
        ):
            with self.subTest(resource=resource), self.assertRaisesRegex(
                identity.IdentityError, "resource"
            ):
                self.preflight({RESOURCE_URL: protected(resource=resource)})

    def test_multiple_issuers_require_poppy_selection(self):
        servers = ["https://staff.example.com", ISSUER]
        with self.assertRaisesRegex(identity.IdentityError, "多个"):
            self.preflight({RESOURCE_URL: protected(servers=servers)})
        result, _ = self.preflight({
            RESOURCE_URL: protected(servers=servers), ISSUER_META: issuer_metadata()
        }, company(ISSUER))
        self.assertEqual(result["issuer"], ISSUER)

    def test_claimed_issuer_not_in_protected_resource_rejected(self):
        with self.assertRaisesRegex(identity.IdentityError, "不在"):
            self.preflight({
                RESOURCE_URL: protected(servers=["https://other.example.com"])
            }, company(ISSUER))

    def test_issuer_metadata_must_match_issuer_exactly(self):
        with self.assertRaisesRegex(identity.IdentityError, "不完全匹配"):
            self.preflight({
                RESOURCE_URL: protected(),
                ISSUER_META: issuer_metadata(issuer="https://another.example.com"),
            })

    def test_issuer_must_confirm_company_resource(self):
        for resources in ([], ["https://evil.example.com"],
                          ["https://" + DOMAIN + "/login"]):
            with self.subTest(resources=resources), self.assertRaisesRegex(
                identity.IdentityError, "protected_resources"
            ):
                self.preflight({
                    RESOURCE_URL: protected(),
                    ISSUER_META: issuer_metadata(resources=resources),
                })

    def test_issuer_metadata_requires_refresh_and_token_revocation(self):
        cases = (
            issuer_metadata(grants=["authorization_code"]),
            issuer_metadata(token_endpoint=None),
            issuer_metadata(revocation_endpoint="http://auth.example.com/revoke"),
            issuer_metadata(authorization_endpoint=None),
            issuer_metadata(grants=[
                "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"
            ]),
        )
        for metadata in cases:
            with self.subTest(metadata=metadata), self.assertRaises(identity.IdentityError):
                self.preflight({
                    RESOURCE_URL: protected(),
                    ISSUER_META: metadata,
                })

    def test_metadata_must_not_redirect_or_contain_duplicate_json_keys(self):
        calls = []
        def redirected(url, *, allow_redirect=False, allow_not_found=False):
            calls.append(url)
            if url == RESOURCE_URL:
                return "https://other.example.com/metadata", b"{}"
            raise AssertionError("must fail before another fetch")
        with self.assertRaisesRegex(identity.IdentityError, "禁止重定向"):
            identity.inspect_poppy_identity(
                DOMAIN, discoverer=lambda s: company(), fetch=redirected,
            )
        malicious = (
            b'{"resource":"https://store.example.com",'
            b'"resource":"https://evil.example.com"}'
        )
        with self.assertRaisesRegex(identity.IdentityError, "重复键"):
            self.preflight({RESOURCE_URL: malicious})

    def test_disabled_signin_keeps_issuer_identity_verified(self):
        result, _ = self.preflight({
            RESOURCE_URL: protected(),
            ISSUER_META: issuer_metadata(),
        }, company(ISSUER, disabled=True))
        self.assertTrue(result["issuer_link_verified"])
        self.assertFalse(result["signed_in_available"])
        self.assertFalse(result["sign_in_hints"]["direct"])
        self.assertFalse(result["remote_calls_allowed"])

    def test_issuer_with_path_gets_rfc8414_wellknown_position(self):
        self.assertEqual(identity._server_metadata_url(
            "https://auth.example.com/shop-a"
        ), "https://auth.example.com/.well-known/oauth-authorization-server/shop-a")
        self.assertRaises(identity.IdentityError, identity._exact_issuer,
                          "https://user@auth.example.com")
        self.assertRaises(identity.IdentityError, identity._exact_issuer,
                          "https://127.0.0.1")
        self.assertRaises(identity.IdentityError, identity._exact_issuer,
                          "https://auth.example.com/tenant?state=abc")

    def test_only_public_identity_metadata_is_returned(self):
        result, _ = self.preflight({
            RESOURCE_URL: protected(),
            ISSUER_META: issuer_metadata(),
        })
        displayed = json.dumps(result)
        for secret in ("access_token", "refresh_token_value", "private_key"):
            self.assertNotIn(secret, displayed)


class OAuthIdentityToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workdir = Path(self.temp.name)
        self.ctx = ToolContext(
            workdir=self.workdir, mode="readonly", interactive=False,
            memory_path=self.workdir / "MEMORY.md",
            skills_dir=self.workdir / "skills",
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_agent_tool_disabled_unless_explicit_poppy_flag(self):
        with mock.patch("nyra.tools.inspect_poppy_identity") as check:
            result = execute_tool("poppy_identity_check", {"site": DOMAIN}, self.ctx)
        self.assertIn("未启用", result)
        check.assert_not_called()
        default = Agent(object(), workdir=self.workdir, mode="readonly",
                        interactive=False, skills_dirs=[])
        optin = Agent(object(), workdir=self.workdir, mode="readonly",
                      interactive=False, skills_dirs=[], poppy_enabled=True)
        self.assertNotIn("poppy_identity_check", [
            x["function"]["name"] for x in default.tool_schemas()
        ])
        self.assertIn("poppy_identity_check", [
            x["function"]["name"] for x in optin.tool_schemas()
        ])

    def test_enabled_readonly_tool_is_diagnostic_only(self):
        self.ctx.poppy_enabled = True
        with mock.patch("nyra.tools.inspect_poppy_identity", return_value={
            "issuer_link_verified": True, "remote_calls_allowed": False,
        }) as check:
            result = execute_tool("poppy_identity_check",
                                  {"site": DOMAIN}, self.ctx)
        self.assertTrue(json.loads(result)["issuer_link_verified"])
        self.assertFalse(json.loads(result)["remote_calls_allowed"])
        check.assert_called_once_with(DOMAIN)

    def test_cli_no_credentials_or_mcp_and_json_conflict(self):
        with mock.patch("nyra.poppy_identity.inspect_poppy_identity", return_value={
            "status": "issuer_metadata_verified",
            "remote_calls_allowed": False,
        }), mock.patch.object(cli, "Provider") as provider, \
             mock.patch.object(cli, "build_mcp_manager") as mcp, \
             mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            code = cli.main(["--inspect-poppy-identity", DOMAIN])
        self.assertEqual(code, 0)
        self.assertFalse(json.loads(out.getvalue())["remote_calls_allowed"])
        provider.assert_not_called()
        mcp.assert_not_called()

        with mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            code = cli.main(["--json", "--inspect-poppy-identity", DOMAIN])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(out.getvalue())["type"], "run_failed")


if __name__ == "__main__":
    unittest.main()
