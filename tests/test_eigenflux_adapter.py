"""EigenFlux bare CLI: no auto-install, no network actions, per-bot isolation."""

import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import angel.cli as cli
import angel.eigenflux_adapter as eigenflux
from angel.groups import GroupStore


class _EigenFluxFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "angel"
        self.root.mkdir()
        # Windows Temp may use 8.3 alias in one API and canonical long path
        # in Path.resolve(). Compare paths in the same canonical spelling.
        self.root = self.root.resolve()
        self.groups = GroupStore(self.root / "groups")
        self.groups.create("alpha", "Alpha")
        self.groups.create("beta", "Beta")

    def tearDown(self):
        self.temp.cleanup()

class EigenFluxHomeTests(_EigenFluxFixture, unittest.TestCase):
    """Tests of home identity isolation."""

    def test_main_home_is_stable_not_session_or_cwd_dependent(self):
        first = eigenflux.home_for_agent(root=self.root)
        self.assertEqual(first.name, ".eigenflux")
        self.assertEqual(first, self.root / "eigenflux/agents/main/.eigenflux")
        with mock.patch("pathlib.Path.cwd", return_value=Path("/a/different/cwd")):
            again = eigenflux.home_for_agent(root=self.root)
        self.assertEqual(first, again)
        self.assertFalse(first.exists())

    def test_group_bots_get_separate_persistent_homes(self):
        first = eigenflux.home_for_agent(
            root=self.root, room="alpha", bot="lead"
        )
        second = eigenflux.home_for_agent(
            root=self.root, room="alpha", bot="builder"
        )
        third = eigenflux.home_for_agent(
            root=self.root, room="beta", bot="lead"
        )
        main = eigenflux.home_for_agent(root=self.root)
        self.assertEqual(len({first, second, third, main}), 4)
        self.assertEqual(first, self.root /
                         "eigenflux/agents/rooms/alpha/bots/lead/.eigenflux")
        self.assertFalse(any(x.exists() for x in (first, second, third, main)))

    def test_unknown_bot_room_and_partial_ids_fail_closed(self):
        bad = [
            {"room": "alpha", "bot": "visitor"},
            {"room": "missing", "bot": "lead"},
            {"room": "alpha", "bot": None},
            {"room": None, "bot": "lead"},
            {"room": "../alpha", "bot": "lead"},
            {"room": "alpha", "bot": "../builder"},
            {"room": "Alpha", "bot": "lead"},
        ]
        for arguments in bad:
            with self.subTest(arguments=arguments), self.assertRaises(
                eigenflux.EigenFluxAdapterError
            ):
                eigenflux.home_for_agent(root=self.root, **arguments)

    def test_symlink_homes_rejected_to_prevent_identity_reuse(self):
        target = self.root / "elsewhere"
        target.mkdir()
        bad = self.root / "eigenflux"
        try:
            bad.symlink_to(target, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with self.assertRaisesRegex(
            eigenflux.EigenFluxAdapterError, "符号链接"
        ):
            eigenflux.home_for_agent(root=self.root)
        with self.assertRaisesRegex(
            eigenflux.EigenFluxAdapterError, "符号链接"
        ):
            eigenflux.home_for_agent(root=self.root, room="alpha", bot="lead")

    def test_group_room_symlink_not_accepted(self):
        outside = self.root / "external"
        outside.mkdir()
        (self.root / "groups/alpha/room.json").unlink()
        (self.root / "groups/alpha").rmdir()
        try:
            (self.root / "groups/alpha").symlink_to(
                outside, target_is_directory=True
            )
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with self.assertRaisesRegex(
            eigenflux.EigenFluxAdapterError, "符号链接"
        ):
            eigenflux.home_for_agent(root=self.root, room="alpha", bot="lead")


class EigenFluxDoctorTests(_EigenFluxFixture, unittest.TestCase):
    def test_default_dry_run_never_executes_cli_or_creates_identity(self):
        with mock.patch("angel.eigenflux_adapter.shutil.which") as which, \
             mock.patch("angel.eigenflux_adapter.subprocess.run") as execute:
            report = eigenflux.doctor(root=self.root)
        self.assertEqual(report["status"], "not_checked")
        self.assertFalse(report["checked"])
        self.assertFalse(report["broadcast_enabled"])
        self.assertFalse(report["network_actions_allowed"])
        self.assertFalse(report["scheduled_checks_enabled"])
        self.assertFalse(report["onboarding_complete"])
        self.assertFalse(report["home_exists"])
        which.assert_not_called()
        execute.assert_not_called()
        self.assertFalse((self.root / "eigenflux").exists())

    def test_opt_in_check_when_binary_missing_stops_without_actions(self):
        with mock.patch("angel.eigenflux_adapter.shutil.which", return_value=None), \
             mock.patch("angel.eigenflux_adapter.subprocess.run") as execute:
            report = eigenflux.doctor(root=self.root, check=True)
        self.assertEqual(report["status"], "cli_not_installed")
        self.assertFalse(report["network_actions_allowed"])
        self.assertFalse(report["onboarding_complete"])
        self.assertTrue(report["checked"])
        execute.assert_not_called()

    def test_opt_in_runs_only_two_allowlisted_cli_probes(self):
        calls = []
        def fake_run(argv, **kwargs):
            calls.append((list(argv), kwargs))
            return subprocess.CompletedProcess(
                argv, 0, stdout="EigenFlux v1.0.2\nextra\n", stderr="",
            )
        with mock.patch(
            "angel.eigenflux_adapter.shutil.which",
            return_value="/usr/bin/eigenflux",
        ), mock.patch(
            "angel.eigenflux_adapter.subprocess.run",
            side_effect=fake_run,
        ), mock.patch.dict(
            os.environ,
            {"OPENAI_API_KEY": "SECRET", "EIGENFLUX_TOKEN": "ANOTHER_SECRET"},
        ):
            report = eigenflux.doctor(
                root=self.root, room="alpha", bot="lead", check=True
            )
        self.assertEqual(report["status"], "local_cli_verified")
        self.assertEqual(report["identity"], "room:alpha/bot:lead")
        self.assertEqual(len(calls), 2)
        home = report["home"]
        self.assertEqual(calls[0][0], [
            "/usr/bin/eigenflux", "--homedir", home, "version",
        ])
        self.assertEqual(calls[1][0], [
            "/usr/bin/eigenflux", "--homedir", home,
            "skills", "path", "--host", "terminal",
        ])
        for args, kws in calls:
            self.assertIs(kws["shell"], False)
            self.assertEqual(kws["timeout"], 8)
            self.assertEqual(kws["env"]["EIGENFLUX_HOME"], home)
            self.assertNotIn("OPENAI_API_KEY", kws["env"])
            self.assertNotIn("EIGENFLUX_TOKEN", kws["env"])
        self.assertFalse(report["network_actions_allowed"])
        self.assertFalse(report["onboarding_complete"])

    def test_failed_probe_is_partial_not_success(self):
        def fake_run(argv, **kwargs):
            result = "bad"
            return subprocess.CompletedProcess(
                argv, 1 if "skills" in argv else 0,
                stdout=result, stderr="broken config",
            )
        with mock.patch(
            "angel.eigenflux_adapter.shutil.which",
            return_value="/usr/bin/eigenflux",
        ), mock.patch(
            "angel.eigenflux_adapter.subprocess.run",
            side_effect=fake_run,
        ):
            report = eigenflux.doctor(root=self.root, check=True)
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["diagnostics"]["skills"]["status"], "failed")
        self.assertNotIn("broken config", str(report))
        self.assertFalse(report["network_actions_allowed"])

    def test_timeout_does_not_claim_success(self):
        with mock.patch(
            "angel.eigenflux_adapter.shutil.which",
            return_value="/usr/bin/eigenflux",
        ), mock.patch(
            "angel.eigenflux_adapter.subprocess.run",
            side_effect=subprocess.TimeoutExpired(["eigenflux"], 8),
        ):
            report = eigenflux.doctor(root=self.root, check=True)
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["diagnostics"]["version"]["reason"],
                         "TimeoutExpired")

    def test_cli_runs_without_provider_mcp_scheduler_or_installer(self):
        with mock.patch.object(eigenflux, "ANGEL_HOME", self.root), \
             mock.patch.object(cli, "Provider") as provider, \
             mock.patch.object(cli, "build_mcp_manager") as mcp, \
             mock.patch("angel.eigenflux_adapter.shutil.which") as which, \
             mock.patch("angel.eigenflux_adapter.subprocess.run") as runner, \
             mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            code = cli.main(["eigenflux", "doctor", "--room", "alpha",
                             "--bot", "lead"])
        self.assertEqual(code, 0)
        report = json.loads(output.getvalue())
        self.assertEqual(report["status"], "not_checked")
        self.assertEqual(report["identity"], "room:alpha/bot:lead")
        provider.assert_not_called()
        mcp.assert_not_called()
        which.assert_not_called()
        runner.assert_not_called()

    def test_missing_binary_returns_nonzero_and_json_status(self):
        with mock.patch.object(eigenflux, "ANGEL_HOME", self.root), \
             mock.patch(
                 "angel.eigenflux_adapter.shutil.which", return_value=None,
             ), mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            code = cli.main(["eigenflux", "doctor", "--check"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue())["status"], "cli_not_installed")


if __name__ == "__main__":
    unittest.main()
