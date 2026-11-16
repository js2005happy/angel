"""Permission ledger: exact domain/account/scope, CAS, audit, and no OAuth claims."""

import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import angel.cli as cli
import angel.poppy_permissions as permissions
from angel.agent import Agent
from angel.poppy_permissions import (
    PermissionConflict, PermissionError, PermissionLedger,
    classify_scope, identity_key, scope_name, site_host,
)
from angel.tools import ToolContext, execute_tool


class PermissionLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / "private" / "permissions.json"
        self.ledger = PermissionLedger(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def test_denied_by_default_and_no_claim_of_real_authorization(self):
        result = self.ledger.check("store.example.com", "orders:read")
        self.assertEqual(result["site"], "store.example.com")
        self.assertEqual(result["local_intent"], "denied")
        self.assertFalse(result["oauth_grant_verified"])
        self.assertFalse(result["poppy_session_verified"])
        self.assertFalse(result["may_execute_remote_action"])
        self.assertTrue(result["risk"]["requires_human_approval"])
        self.assertFalse(self.path.exists())

    def test_grant_requires_explicit_user_confirmation(self):
        with self.assertRaisesRegex(PermissionError, "--confirm"):
            self.ledger.grant("store.example.com", "orders:read")
        self.assertFalse(self.path.exists())
        recorded = self.ledger.grant("store.example.com", "orders:read", confirmed=True)
        self.assertTrue(recorded["changed"])
        decision = self.ledger.check("https://store.example.com/cart", "orders:read")
        self.assertEqual(decision["local_intent"], "recorded")
        self.assertFalse(decision["may_execute_remote_action"])
        self.assertEqual(self.ledger.list()["count"], 1)

    def test_exact_host_and_account_alias_are_isolated(self):
        self.ledger.grant("store.example.com", "orders:read",
                          account="personal", confirmed=True)
        self.ledger.grant("store.example.com", "orders:write",
                          account="business", confirmed=True)
        for host, scope, account in (
            ("shop.store.example.com", "orders:read", "personal"),
            ("store.example.com", "orders:read", None),
            ("store.example.com", "orders:read", "business"),
            ("store.example.com", "orders:write", "personal"),
            ("other.example.com", "orders:read", "personal"),
        ):
            with self.subTest(host=host, scope=scope, account=account):
                result = self.ledger.check(host, scope, account=account)
                self.assertEqual(result["local_intent"], "denied")
        self.assertEqual(
            self.ledger.check("store.example.com", "orders:read",
                              account="personal")["local_intent"],
            "recorded",
        )

    def test_revoke_removes_intent_but_preserves_bounded_audit(self):
        self.ledger.grant("store.example.com", "orders:read", confirmed=True)
        revoked = self.ledger.revoke("store.example.com", "orders:read")
        self.assertTrue(revoked["changed"])
        self.assertEqual(self.ledger.list()["count"], 0)
        self.assertEqual(
            [x["operation"] for x in self.ledger.audit()],
            ["revoke", "grant"],
        )
        self.assertEqual(self.ledger.revoke(
            "store.example.com", "orders:read",
        )["changed"], False)
        self.assertEqual(len(self.ledger.audit()), 2)

    def test_revision_cas_prevents_stale_admin_changes(self):
        original = self.ledger.list()["revision"]
        self.assertEqual(original, "missing")
        first = self.ledger.grant(
            "store.example.com", "orders:read", confirmed=True,
            expected_revision=original,
        )
        self.assertNotEqual(first["revision"], original)
        with self.assertRaises(PermissionConflict):
            self.ledger.grant(
                "store.example.com", "orders:write", confirmed=True,
                expected_revision=original,
            )
        self.assertEqual(self.ledger.list()["count"], 1)
        with self.assertRaises(PermissionConflict):
            self.ledger.revoke(
                "store.example.com", "orders:read",
                expected_revision=original,
            )
        self.assertEqual(self.ledger.list()["count"], 1)

    def test_storage_is_private_and_reopen_retains_intents(self):
        self.ledger.grant("store.example.com", "orders:read", confirmed=True)
        reopened = PermissionLedger(self.path)
        self.assertEqual(reopened.list()["count"], 1)
        saved = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(saved["version"], 1)
        self.assertEqual(saved["events"][0]["actor"], "explicit_cli_user")
        if os.name != "nt":
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_corrupt_file_and_symlink_are_fail_closed(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("not json", encoding="utf-8")
        with self.assertRaisesRegex(PermissionError, "损坏"):
            self.ledger.list()
        with self.assertRaisesRegex(PermissionError, "损坏"):
            self.ledger.grant("store.example.com", "orders:read", confirmed=True)
        self.path.unlink()
        target = self.root / "other.json"
        target.write_text("PRIVATE", encoding="utf-8")
        try:
            self.path.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are unavailable")
        with self.assertRaisesRegex(PermissionError, "符号链接"):
            self.ledger.list()
        with self.assertRaisesRegex(PermissionError, "符号链接"):
            self.ledger.grant("store.example.com", "orders:read", confirmed=True)
        self.assertEqual(target.read_text(encoding="utf-8"), "PRIVATE")

    def test_malformed_sites_scopes_and_accounts_rejected(self):
        sites = ["http://store.example.com", "127.0.0.1", "localhost",
                 "https://user:pass@store.example.com",
                 "store.example.com:8080", "store.example.com#frag"]
        for site in sites:
            with self.subTest(site=site), self.assertRaises(PermissionError):
                site_host(site)
        for scope in ("", "*", "orders:*", "a b", "one\nanother", 'a"b',
                      "x" * 129):
            with self.subTest(scope=scope), self.assertRaises(PermissionError):
                scope_name(scope)
        for account in ("", "../admin", "secret@company.com", "x" * 49):
            with self.subTest(account=account), self.assertRaises(PermissionError):
                identity_key(account)
        self.assertEqual(identity_key(), "visitor")
        self.assertEqual(identity_key("work_2"), "account:work_2")

    def test_never_trust_claimed_scope_risk_without_human_consent(self):
        safe = classify_scope({"changes": "none", "personal_data": False})
        self.assertFalse(safe["requires_human_approval"])
        for hint in (
            None, {}, {"changes": "later", "personal_data": False},
            {"changes": "none"}, {"changes": "reversible", "personal_data": False},
            {"changes": "irreversible", "personal_data": True},
            {"changes": "none", "personal_data": True},
        ):
            with self.subTest(hint=hint):
                self.assertTrue(classify_scope(hint)["requires_human_approval"])
        self.assertEqual(
            classify_scope({"changes": "new-future-value", "personal_data": False})["changes"],
            "irreversible",
        )
        # Even a public-read claim is NOT a verified OAuth grant or remote permission.
        d = self.ledger.check(
            "store.example.com", "catalog:read",
            hint={"changes": "none", "personal_data": False},
        )
        self.assertFalse(d["may_execute_remote_action"])

    def test_bounded_scope_intent_and_audit(self):
        with self.assertRaises(PermissionError):
            self.ledger.grant(
                "store.example.com", "orders:write", confirmed=True,
                expected_revision="invalid revision",
            )
        with self.assertRaises(PermissionError):
            self.ledger.audit(limit=0)
        with self.assertRaises(PermissionError):
            self.ledger.audit(limit=101)


class PermissionCLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / "poppy" / "permissions.json"

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, *args):
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(permissions, "DEFAULT_PATH", self.path), \
             mock.patch.object(cli, "Provider") as provider, \
             mock.patch.object(cli, "build_mcp_manager") as mcp, \
             mock.patch("sys.stdout", output), mock.patch("sys.stderr", errors):
            exit_code = cli.main(["permissions", *args])
        provider.assert_not_called()
        mcp.assert_not_called()
        try:
            content = json.loads(output.getvalue()) if output.getvalue() else None
        except json.JSONDecodeError:
            content = None
        return exit_code, content, errors.getvalue()

    def test_end_to_end_grant_check_audit_revoke(self):
        code, data, _ = self.run_cli(
            "grant", "--site", "store.example.com",
            "--scope", "orders:read", "--account", "personal",
        )
        self.assertEqual(code, 1)
        self.assertIsNone(data)
        self.assertFalse(self.path.exists())
        code, granted, _ = self.run_cli(
            "grant", "--site", "store.example.com",
            "--scope", "orders:read", "--account", "personal", "--confirm",
        )
        self.assertEqual(code, 0)
        self.assertTrue(granted["changed"])
        _, decision, _ = self.run_cli(
            "check", "--site", "store.example.com",
            "--scope", "orders:read", "--account", "personal",
        )
        self.assertEqual(decision["local_intent"], "recorded")
        self.assertFalse(decision["may_execute_remote_action"])
        _, listed, _ = self.run_cli("list", "--site", "store.example.com")
        self.assertEqual(listed["count"], 1)
        _, revoked, _ = self.run_cli(
            "revoke", "--site", "store.example.com",
            "--scope", "orders:read", "--account", "personal",
        )
        self.assertTrue(revoked["changed"])
        _, audit, _ = self.run_cli("audit", "--site", "store.example.com")
        self.assertEqual(
            [event["operation"] for event in audit["events"]],
            ["revoke", "grant"],
        )

    def test_tool_cannot_change_permission_ledger(self):
        with mock.patch.object(permissions, "DEFAULT_PATH", self.path):
            ctx = ToolContext(
                workdir=self.root, mode="readonly", interactive=False,
                memory_path=self.root / "MEMORY.md", skills_dir=self.root / "skills",
            )
            result = execute_tool("poppy_permission_check", {
                "site": "store.example.com", "scope": "orders:read",
            }, ctx)
            self.assertIn("未启用", result)
            ctx.poppy_enabled = True
            result = json.loads(execute_tool("poppy_permission_check", {
                "site": "store.example.com", "scope": "orders:read",
            }, ctx))
            self.assertEqual(result["local_intent"], "denied")
            self.assertFalse(self.path.exists())
            # Only CLI grant with --confirm can create permission records.
            self.assertIn("未知工具", execute_tool(
                "poppy_permission_grant",
                {"site": "store.example.com", "scope": "orders:write"}, ctx,
            ))

    def test_agent_exposes_readonly_permission_check_only_when_poppy_enabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = Agent(object(), workdir=root, mode="readonly", interactive=False,
                      skills_dirs=[], poppy_enabled=False)
            b = Agent(object(), workdir=root, mode="readonly", interactive=False,
                      skills_dirs=[], poppy_enabled=True)
            def names(agent):
                return [s["function"]["name"] for s in agent.tool_schemas()]
            self.assertNotIn("poppy_permission_check", names(a))
            self.assertIn("poppy_permission_check", names(b))
            self.assertNotIn("poppy_permission_grant", names(b))

    def test_site_hints_unknown_are_not_marked_safe_in_discovery(self):
        from angel.poppy import discover_poppy
        site = "https://store.example.com/.well-known/poppy.json"
        doc = {
            "protocol_version": "1.0",
            "organization": {"name": "Store", "domain": "store.example.com"},
            "auth": {
                "scopes": {"mystery": "Unknown risk", "orders:read": "Read data"},
                "scope_hints": {
                    "mystery": {"changes": "some-future-value"},
                    "orders:read": {"changes": "none", "personal_data": False},
                },
            },
            "web": {"disabled": False},
        }
        summary = discover_poppy(
            "store.example.com",
            fetch=lambda url, **kw: (site, json.dumps(doc).encode("utf-8")),
        )
        self.assertEqual(summary["scopes"][0]["changes"], "irreversible")
        self.assertIsNone(summary["scopes"][0]["personal_data"])
        self.assertTrue(summary["scopes"][0]["requires_human_approval"])
        self.assertFalse(summary["scopes"][1]["requires_human_approval"])


if __name__ == "__main__":
    unittest.main()
