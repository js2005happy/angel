"""Checks for the Linux installer (scripts/install.sh).

The installer only writes inside $HOME: it copies a Nyra checkout to a
prefix (default ~/.local/share/nyra), drops a launcher in ~/.local/bin,
creates ~/.nyra (0700) and optionally installs the systemd user unit.
These tests run the real script against a temporary HOME, with stub
`python3` / `systemctl` executables on PATH where the behaviour under test
needs them. Nothing here starts the scheduler daemon or calls a model:
the only Nyra command exercised is `nyra --version`.

Execution tests need bash + POSIX tools, so they are skipped on Windows
(the installer itself is documented Linux-only); the static checks run
everywhere.
"""

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "install.sh"

POSIX = os.name == "posix" and shutil.which("bash") is not None


def _write_stub(path, body):
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


class InstallScriptStaticTests(unittest.TestCase):
    def test_script_exists_and_is_executable(self):
        self.assertTrue(SCRIPT.is_file(), "scripts/install.sh missing")
        self.assertTrue(
            bool(SCRIPT.stat().st_mode & stat.S_IXUSR),
            "scripts/install.sh should be executable",
        )

    def test_no_privilege_escalation_or_remote_pipe(self):
        text = SCRIPT.read_text(encoding="utf-8")
        for needle in ("sudo", "curl", "wget", "pip install", "rm -rf /"):
            self.assertNotIn(needle, text, f"installer must not use: {needle}")
        for needle in ("--with-systemd", "--uninstall", "--prefix", "--source"):
            self.assertIn(needle, text)

    def test_unit_template_and_doc_referenced(self):
        text = SCRIPT.read_text(encoding="utf-8")
        self.assertIn("systemd/nyra-scheduler.service", text)
        self.assertIn("docs/linux-systemd.md", text)
        self.assertTrue((ROOT / "systemd" / "nyra-scheduler.service").is_file())


@unittest.skipUnless(POSIX, "installer execution tests need bash + POSIX tools")
class InstallScriptTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.prefix = self.home / ".local" / "share" / "nyra"
        self.bin_dir = self.home / ".local" / "bin"
        self.stub_bin = self.base / "stubs"
        self.stub_bin.mkdir()
        self.systemctl_log = self.base / "systemctl.log"
        # Stub python3 that runs the real interpreter (so --version works).
        _write_stub(
            self.stub_bin / "python3",
            "#!/bin/sh\n"
            f'exec "{sys.executable}" "$@"\n',
        )
        # Stub systemctl that only records its invocations.
        _write_stub(
            self.stub_bin / "systemctl",
            "#!/bin/sh\n"
            'echo "systemctl $*" >> "$NYRA_TEST_SYSTEMCTL_LOG"\n'
            "exit 0\n",
        )

    def _env(self, extra_path=None):
        env = {k: v for k, v in os.environ.items() if not k.endswith("_API_KEY")}
        env["HOME"] = str(self.home)
        env["NYRA_TEST_SYSTEMCTL_LOG"] = str(self.systemctl_log)
        path = str(self.stub_bin)
        if extra_path:
            # Extra stubs (e.g. an old python3) must win over the defaults.
            path = extra_path + os.pathsep + path
        env["PATH"] = path + os.pathsep + os.environ.get("PATH", "")
        return env

    def _run_installer(self, args, env=None):
        return subprocess.run(
            ["bash", str(SCRIPT)] + args,
            cwd="/tmp",
            env=env if env is not None else self._env(),
            capture_output=True,
            text=True,
            timeout=120,
        )

    def _install_args(self, extra=()):
        return [
            "--source",
            str(ROOT),
            "--prefix",
            str(self.prefix),
            "--bin-dir",
            str(self.bin_dir),
        ] + list(extra)

    def test_help(self):
        proc = subprocess.run(
            ["bash", str(SCRIPT), "--help"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        for needle in ("--prefix", "--with-systemd", "--uninstall", "--source"):
            self.assertIn(needle, proc.stdout)

    def test_bash_syntax(self):
        proc = subprocess.run(
            ["bash", "-n", str(SCRIPT)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_install_from_local_source(self):
        proc = self._run_installer(self._install_args())
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertTrue((self.prefix / "nyra" / "cli.py").is_file())
        self.assertTrue((self.prefix / "scripts" / "install.sh").is_file())
        self.assertFalse((self.prefix / ".git").exists(), ".git must not be copied")
        launcher = self.bin_dir / "nyra"
        self.assertTrue(launcher.is_file())
        self.assertTrue(bool(launcher.stat().st_mode & stat.S_IXUSR))
        # Launcher works from an unrelated cwd (PYTHONPATH, not cwd).
        out = subprocess.run(
            [str(launcher), "--version"],
            cwd="/tmp",
            env=self._env(),
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("Nyra", out.stdout)
        # Config dir created with 0700; no systemd unit without the flag.
        config_dir = self.home / ".nyra"
        self.assertTrue(config_dir.is_dir())
        self.assertEqual(stat.S_IMODE(config_dir.stat().st_mode), 0o700)
        self.assertFalse(
            (self.home / ".config" / "systemd" / "user").exists(),
            "no systemd unit without --with-systemd",
        )

    def test_install_is_idempotent(self):
        for _ in range(2):
            proc = self._run_installer(self._install_args())
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        out = subprocess.run(
            [str(self.bin_dir / "nyra"), "--version"],
            cwd="/tmp",
            env=self._env(),
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("Nyra", out.stdout)

    def test_install_with_systemd(self):
        proc = self._run_installer(self._install_args(["--with-systemd"]))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        unit = self.home / ".config" / "systemd" / "user" / "nyra-scheduler.service"
        self.assertTrue(unit.is_file())
        text = unit.read_text(encoding="utf-8")
        self.assertIn(f"WorkingDirectory={self.prefix}", text)
        self.assertIn("schedule daemon", text)
        # The directive line itself must be substituted (the template's
        # comment header still mentions %h/nyra, which is fine).
        self.assertNotIn("WorkingDirectory=%h/nyra\n", text)
        log = self.systemctl_log.read_text(encoding="utf-8")
        self.assertIn("systemctl --user daemon-reload", log)
        self.assertIn(
            "systemctl --user enable --now nyra-scheduler.service", log
        )

    def test_uninstall_removes_install_but_keeps_data(self):
        proc = self._run_installer(self._install_args(["--with-systemd"]))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        marker = self.home / ".nyra" / "keep-me.txt"
        marker.write_text("user data", encoding="utf-8")
        proc = self._run_installer(self._install_args(["--uninstall"]))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertFalse(self.prefix.exists())
        self.assertFalse((self.bin_dir / "nyra").exists())
        self.assertFalse(
            (self.home / ".config" / "systemd" / "user" / "nyra-scheduler.service").exists()
        )
        self.assertTrue(marker.is_file(), "~/.nyra user data must survive uninstall")
        log = self.systemctl_log.read_text(encoding="utf-8")
        self.assertIn(
            "systemctl --user disable --now nyra-scheduler.service", log
        )

    def test_old_python_rejected(self):
        old_bin = self.base / "oldpy"
        old_bin.mkdir()
        _write_stub(
            old_bin / "python3",
            "#!/bin/sh\n"
            'if [ "$1" = "--version" ]; then echo "Python 3.9.18"; exit 0; fi\n'
            'echo "stub python3: unsupported args" >&2\n'
            "exit 1\n",
        )
        proc = self._run_installer(
            self._install_args(), env=self._env(extra_path=str(old_bin))
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("3.9.18", proc.stderr)
        self.assertFalse(self.prefix.exists(), "nothing installed on failure")

    def test_missing_source_rejected(self):
        proc = self._run_installer(
            [
                "--source",
                str(self.base / "does-not-exist"),
                "--prefix",
                str(self.prefix),
                "--bin-dir",
                str(self.bin_dir),
            ]
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(self.prefix.exists())

    def test_dangerous_prefix_rejected(self):
        for bad in ("/", str(self.home)):
            proc = self._run_installer(
                [
                    "--source",
                    str(ROOT),
                    "--prefix",
                    bad,
                    "--bin-dir",
                    str(self.bin_dir),
                ]
            )
            self.assertNotEqual(proc.returncode, 0, f"prefix {bad} must be refused")

    def test_unknown_option_rejected(self):
        proc = self._run_installer(["--nope"])
        self.assertNotEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
