"""EigenFlux local per-agent ceilings are opt-in, isolated, and never online."""

import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import angel.cli as cli
import angel.eigenflux_adapter as adapter
import angel.eigenflux_policy as policy_mod
from angel.eigenflux_policy import (
    CAPABILITIES, NetworkPolicy, NetworkPolicyConflict, NetworkPolicyError,
)
from angel.groups import GroupStore


class PolicyFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = (Path(self.temp.name) / "angel").resolve()
        self.root.mkdir()
        self.groups = GroupStore(self.root / "groups")
        self.groups.create("alpha", "Alpha")
        self.groups.create("beta", "Beta")
        self.policy = NetworkPolicy(root=self.root)

    def tearDown(self):
        self.temp.cleanup()


class NetworkPolicyTests(PolicyFixture, unittest.TestCase):
    def test_new_policy_is_deny_by_default_and_has_no_side_effects(self):
        with mock.patch("angel.eigenflux_adapter.subprocess.run") as process, \
             mock.patch("angel.eigenflux_adapter.shutil.which") as which:
            state = self.policy.show()
            alpha = self.policy.show(room="alpha", bot="lead")
        for state_item in (state, alpha):
            self.assertFalse(state_item["network_actions_enabled"])
            self.assertFalse(state_item["official_onboarding_verified"])
            self.assertFalse(state_item["stale_identity_policy_ignored"])
            self.assertTrue(all(
                item["local_intent"] == "denied"
                and item["effective_network_permission"] is False
                for item in state_item["capabilities"].values()
            ))
        self.assertEqual(set(state["capabilities"]), set(CAPABILITIES))
        self.assertEqual(state["revision"], "missing")
        self.assertEqual(self.policy.audit()["events"], [])
        self.assertFalse(self.policy.path.exists())
        process.assert_not_called()
        which.assert_not_called()

    def test_allow_requires_foreground_confirmation_and_does_not_execute(self):
        with self.assertRaisesRegex(NetworkPolicyError, "--confirm"):
            self.policy.change("allow", "feed_read")
        self.assertFalse(self.policy.path.exists())
        result = self.policy.change("allow", "feed_read", confirmed=True)
        self.assertTrue(result["changed"])
        self.assertFalse(result["network_actions_enabled"])
        state = self.policy.show()
        self.assertEqual(state["capabilities"]["feed_read"]["local_intent"], "allowed")
        self.assertFalse(
            state["capabilities"]["feed_read"]["effective_network_permission"]
        )
        self.assertEqual(
            state["capabilities"]["public_broadcast"]["local_intent"], "denied"
        )

    def test_separate_room_bot_identity_and_exact_capabilities(self):
        self.policy.change(
            "allow", "public_broadcast", room="alpha", bot="lead",
            confirmed=True,
        )
        self.policy.change(
            "allow", "feed_read", room="alpha", bot="builder",
            confirmed=True,
        )
        for room, bot, allowed in (
            ("alpha", "lead", ("public_broadcast",)),
            ("alpha", "builder", ("feed_read",)),
            ("alpha", "architect", ()),
            ("beta", "lead", ()),
        ):
            with self.subTest(room=room, bot=bot):
                state = self.policy.show(room=room, bot=bot)
                actual = {
                    cap for cap, spec in state["capabilities"].items()
                    if spec["local_intent"] == "allowed"
                }
                self.assertEqual(actual, set(allowed))
                self.assertFalse(state["network_actions_enabled"])
        self.assertEqual(
            {c for c, v in self.policy.show()["capabilities"].items()
             if v["local_intent"] == "allowed"}, set()
        )

    def test_revoke_and_audit_trail_persist_across_reopen(self):
        first = self.policy.change(
            "allow", "direct_message", confirmed=True
        )
        again = self.policy.change(
            "allow", "direct_message", confirmed=True
        )
        self.assertFalse(again["changed"])
        self.assertEqual(first["revision"], again["revision"])
        revoked = self.policy.change("deny", "direct_message")
        self.assertTrue(revoked["changed"])
        self.assertEqual(self.policy.show()["capabilities"]["direct_message"]["local_intent"],
                         "denied")
        events = self.policy.audit()["events"]
        self.assertEqual([x["operation"] for x in events], ["deny", "allow"])
        self.assertTrue(all(e["actor"] == "explicit_cli_user" for e in events))
        reopened = NetworkPolicy(root=self.root)
        self.assertEqual(reopened.show()["capabilities"]["direct_message"]["local_intent"],
                         "denied")
        self.assertEqual(reopened.audit()["events"], events)
        if os.name != "nt":
            self.assertEqual(self.policy.path.stat().st_mode & 0o777, 0o600)

    def test_optimistic_revision_blocks_stale_concurrent_updates(self):
        version = self.policy.show()["revision"]
        first = self.policy.change(
            "allow", "feed_read", expected_revision=version, confirmed=True
        )
        self.assertNotEqual(first["revision"], version)
        with self.assertRaises(NetworkPolicyConflict):
            self.policy.change(
                "allow", "public_broadcast", expected_revision=version,
                confirmed=True,
            )
        self.assertEqual(self.policy.show()["capabilities"]["public_broadcast"]["local_intent"],
                         "denied")
        with self.assertRaises(NetworkPolicyConflict):
            self.policy.change(
                "deny", "feed_read", expected_revision=version
            )
        self.assertEqual(self.policy.show()["capabilities"]["feed_read"]["local_intent"],
                         "allowed")

    def test_recreate_group_does_not_inherit_old_home_or_permissions(self):
        previous_home = adapter.home_for_agent(
            root=self.root, room="alpha", bot="lead"
        )
        marker = self.groups.get("alpha")["instance_id"]
        self.assertEqual(len(marker), 32)
        self.policy.change(
            "allow", "public_broadcast",
            room="alpha", bot="lead", confirmed=True,
        )
        self.assertEqual(
            self.policy.show(room="alpha", bot="lead")
            ["capabilities"]["public_broadcast"]["local_intent"], "allowed"
        )
        # Simulate an admin deleting an old group and re-creating its id.
        folder = self.root / "groups" / "alpha"
        (folder / "room.json").unlink()
        folder.rmdir()
        replacement = self.groups.create("alpha", "New Group")
        self.assertNotEqual(replacement["instance_id"], marker)
        new_home = adapter.home_for_agent(
            root=self.root, room="alpha", bot="lead"
        )
        self.assertNotEqual(new_home, previous_home)
        state = self.policy.show(room="alpha", bot="lead")
        self.assertTrue(state["stale_identity_policy_ignored"])
        self.assertEqual(
            state["capabilities"]["public_broadcast"]["local_intent"], "denied"
        )
        denied = self.policy.change(
            "deny", "public_broadcast", room="alpha", bot="lead",
        )
        self.assertTrue(denied["changed"])
        self.assertFalse(
            self.policy.show(room="alpha", bot="lead")
            ["stale_identity_policy_ignored"]
        )

    def test_existing_legacy_room_keeps_previous_home(self):
        room_file = self.root / "groups" / "alpha" / "room.json"
        data = json.loads(room_file.read_text(encoding="utf-8"))
        data.pop("instance_id")
        room_file.write_text(json.dumps(data), encoding="utf-8")
        expected = (self.root / "eigenflux" / "agents" / "rooms" /
                    "alpha" / "bots" / "lead" / ".eigenflux")
        self.assertEqual(
            adapter.home_for_agent(root=self.root, room="alpha", bot="lead"),
            expected,
        )
        self.policy.change(
            "allow", "feed_read", room="alpha", bot="lead", confirmed=True,
        )
        self.assertEqual(
            self.policy.show(room="alpha", bot="lead")
            ["capabilities"]["feed_read"]["local_intent"], "allowed"
        )

    def test_invalid_capabilities_identity_and_room_members_fail(self):
        for cap in ("all", "*", "network_admin", "private_keys", "", None):
            with self.subTest(cap=cap), self.assertRaises(NetworkPolicyError):
                self.policy.change("allow", cap, confirmed=True)
        for room, bot in (("alpha", "outsider"), ("../alpha", "lead"),
                          ("beta", None), (None, "lead")):
            with self.subTest(room=room, bot=bot), self.assertRaises(ValueError):
                self.policy.show(room=room, bot=bot)
        with self.assertRaises(NetworkPolicyError):
            self.policy.change("delete_all", "feed_read")
        with self.assertRaises(NetworkPolicyError):
            self.policy.change(
                "allow", "feed_read", confirmed=True,
                expected_revision="wrong",
            )

    def test_file_corruption_and_symlink_fail_closed(self):
        self.policy.path.parent.mkdir(parents=True, exist_ok=True)
        self.policy.path.write_text("not-json", encoding="utf-8")
        with self.assertRaises(NetworkPolicyError):
            self.policy.show()
        with self.assertRaises(NetworkPolicyError):
            self.policy.change("allow", "feed_read", confirmed=True)
        self.policy.path.unlink()
        outside = self.root / "outside.txt"
        outside.write_text("outside file", encoding="utf-8")
        try:
            self.policy.path.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with self.assertRaisesRegex(NetworkPolicyError, "符号链接"):
            self.policy.show()
        with self.assertRaisesRegex(NetworkPolicyError, "符号链接"):
            self.policy.change("allow", "feed_read", confirmed=True)
        self.assertEqual(outside.read_text(encoding="utf-8"), "outside file")

    def test_tampering_cannot_inject_unrecognized_actions(self):
        self.policy.change("allow", "feed_read", confirmed=True)
        data = json.loads(self.policy.path.read_text(encoding="utf-8"))
        data["agents"]["main"]["allowed"].append("leak_everything")
        self.policy.path.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(NetworkPolicyError):
            self.policy.show()
        with self.assertRaises(NetworkPolicyError):
            self.policy.change("deny", "feed_read")

    def test_policy_cannot_be_written_outside_angel_home(self):
        other = self.root.parent / "external-policy.json"
        policy = NetworkPolicy(root=self.root, path=other)
        with self.assertRaises(NetworkPolicyError):
            policy.show()
        with self.assertRaises(NetworkPolicyError):
            policy.change("allow", "feed_read", confirmed=True)
        self.assertFalse(other.exists())

    def test_audit_query_bounds(self):
        for limit in (0, -1, 101, "10", True):
            with self.subTest(limit=limit), self.assertRaises(NetworkPolicyError):
                self.policy.audit(limit=limit)


class NetworkPolicyCLITests(PolicyFixture, unittest.TestCase):
    def invoke(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(policy_mod, "ANGEL_HOME", self.root), \
             mock.patch.object(adapter, "ANGEL_HOME", self.root), \
             mock.patch.object(cli, "Provider") as provider, \
             mock.patch.object(cli, "build_mcp_manager") as mcp, \
             mock.patch("angel.eigenflux_adapter.subprocess.run") as exec_, \
             mock.patch("angel.eigenflux_adapter.shutil.which") as which, \
             mock.patch("sys.stdout", out), mock.patch("sys.stderr", err):
            code = cli.main(["eigenflux", "policy", *args])
        provider.assert_not_called()
        mcp.assert_not_called()
        exec_.assert_not_called()
        which.assert_not_called()
        return code, json.loads(out.getvalue()) if out.getvalue() else None, err.getvalue()

    def test_cli_allow_deny_and_audit_without_running_any_network_code(self):
        args = ("--room", "alpha", "--bot", "lead")
        status, initial, _ = self.invoke("show", *args)
        self.assertEqual(status, 0)
        self.assertEqual(initial["revision"], "missing")
        status, out, error = self.invoke(
            "allow", "--capability", "feed_read", *args
        )
        self.assertEqual(status, 1)
        self.assertIsNone(out)
        self.assertIn("--confirm", error)
        self.assertFalse(self.policy.path.exists())
        status, out, error = self.invoke(
            "allow", "--capability", "feed_read", *args, "--confirm"
        )
        self.assertEqual(status, 0)
        self.assertTrue(out["changed"])
        self.assertFalse(out["network_actions_enabled"])
        status, now, _ = self.invoke("show", *args)
        self.assertEqual(now["capabilities"]["feed_read"]["local_intent"], "allowed")
        self.assertEqual(now["capabilities"]["direct_message"]["local_intent"], "denied")
        status, out, _ = self.invoke(
            "deny", "--capability", "feed_read", *args
        )
        self.assertEqual(status, 0)
        status, audit, _ = self.invoke("audit", *args)
        self.assertEqual(status, 0)
        self.assertEqual(len(audit["events"]), 2)

    def test_cli_rejects_invalid_action_options(self):
        status, _, error = self.invoke("show", "--capability", "feed_read")
        self.assertEqual(status, 1)
        self.assertIn("不接受", error)
        status, _, error = self.invoke("deny")
        self.assertEqual(status, 1)
        self.assertIn("--capability", error)


if __name__ == "__main__":
    unittest.main()
