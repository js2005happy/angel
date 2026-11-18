"""Checks for the systemd user unit that keeps the scheduler daemon running.

The unit itself is only a static file; these tests assert its fields are
consistent with the repository (paths, entry point) and that the daemon
command it runs actually starts. No real scheduled task runs and no model
is called: the smoke test uses a temporary HOME with an empty schedule.
"""

import configparser
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UNIT = ROOT / "systemd" / "nyra-scheduler.service"
DOC = ROOT / "docs" / "linux-systemd.md"


def _parse_unit():
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str  # systemd keys are case-sensitive
    parser.read(UNIT, encoding="utf-8")
    return parser


class SystemdUnitTests(unittest.TestCase):
    def test_unit_file_exists_and_parses(self):
        self.assertTrue(UNIT.is_file(), "systemd/nyra-scheduler.service missing")
        unit = _parse_unit()
        for section in ("Unit", "Service", "Install"):
            self.assertIn(section, unit.sections(), f"[{section}] missing")

    def test_service_type_and_restart(self):
        unit = _parse_unit()
        service = unit["Service"]
        self.assertEqual(service.get("Type"), "simple")
        self.assertEqual(service.get("Restart"), "on-failure")
        self.assertIn("RestartSec", service)

    def test_working_directory_uses_home_variable(self):
        unit = _parse_unit()
        workdir = unit["Service"].get("WorkingDirectory", "")
        self.assertEqual(workdir, "%h/nyra")
        # The checkout the unit points at is this repository.
        self.assertTrue((ROOT / "nyra" / "cli.py").is_file())

    @unittest.skipIf(os.name == "nt", "systemd unit paths are POSIX-only")
    def test_exec_start_runs_the_scheduler_daemon(self):
        unit = _parse_unit()
        exec_start = unit["Service"].get("ExecStart", "")
        parts = exec_start.split()
        self.assertGreaterEqual(len(parts), 3)
        exe = parts[0]
        self.assertTrue(
            Path(exe).is_file() or shutil.which(exe),
            f"ExecStart executable not found: {exe}",
        )
        self.assertEqual(parts[1:4], ["-m", "nyra", "schedule"])
        self.assertIn("daemon", parts)

    def test_no_hardcoded_home_and_no_user_directive(self):
        text = UNIT.read_text(encoding="utf-8")
        self.assertNotIn("/home/", text)
        self.assertNotIn("/root/", text)
        unit = _parse_unit()
        service = unit["Service"]
        self.assertNotIn("User", service, "user units must not set User=")
        self.assertNotIn("Group", service, "user units must not set Group=")
        # Only the system python path is absolute; the checkout path uses %h.
        self.assertNotIn(str(ROOT), text)

    def test_hardening_flags_present(self):
        unit = _parse_unit()
        service = unit["Service"]
        self.assertEqual(service.get("NoNewPrivileges"), "true")
        self.assertEqual(service.get("PrivateTmp"), "true")
        self.assertEqual(service.get("ProtectSystem"), "true")

    def test_doc_exists_and_covers_install_linger_uninstall(self):
        self.assertTrue(DOC.is_file(), "docs/linux-systemd.md missing")
        text = DOC.read_text(encoding="utf-8")
        for needle in (
            "systemctl --user enable --now",
            "daemon-reload",
            "enable-linger",
            "journalctl --user",
            "systemctl --user disable --now",
        ):
            self.assertIn(needle, text, f"doc should mention: {needle}")

    def test_daemon_smoke_with_empty_schedule(self):
        """`nyra schedule daemon --rounds 1` with a temp HOME: no tasks, no model."""
        with tempfile.TemporaryDirectory() as tmp:
            env = {k: v for k, v in os.environ.items() if not k.endswith("_API_KEY")}
            env["HOME"] = tmp
            env["PYTHONIOENCODING"] = "utf-8"
            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "nyra",
                    "schedule",
                    "daemon",
                    "--interval",
                    "0.1",
                    "--rounds",
                    "1",
                ],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=60,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("守护进程", proc.stdout)
            self.assertIn("共运行 1 轮", proc.stdout)

    @unittest.skipIf(
        shutil.which("systemd-analyze") is None
        or not os.path.isdir("/run/systemd/system"),
        "systemd-analyze not installed or systemd not running (e.g. container)",
    )
    def test_systemd_analyze_verify(self):
        proc = subprocess.run(
            ["systemd-analyze", "verify", str(UNIT)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)


if __name__ == "__main__":
    unittest.main()
