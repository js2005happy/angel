"""Checks for the Linux packager (scripts/build_package.sh).

The script builds a release tarball and (when dpkg-deb is available) a
Debian package from the current checkout, with the version read from
nyra/__init__.py. Tests build once into a temporary directory and check
both artifacts: names, whitelisted contents, no __pycache__ / .git /
.venv leakage, and that the payload actually runs (`nyra --version`).

Execution tests need bash + tar on a POSIX host, so they are skipped on
Windows; the static checks run everywhere. Nothing here installs
anything system-wide, starts the scheduler daemon, or calls a model.
"""

import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "build_package.sh"

POSIX = os.name == "posix" and shutil.which("bash") is not None
HAS_TAR = shutil.which("tar") is not None
HAS_DPKG_DEB = shutil.which("dpkg-deb") is not None


def _version():
    text = (ROOT / "nyra" / "__init__.py").read_text(encoding="utf-8")
    match = re.search(r'^__version__ = "(.*)"', text, re.M)
    assert match is not None, "__version__ missing from nyra/__init__.py"
    return match.group(1)


VERSION = _version()


class PackagingStaticTests(unittest.TestCase):
    def test_script_exists_and_is_executable(self):
        self.assertTrue(SCRIPT.is_file(), "scripts/build_package.sh missing")
        self.assertTrue(bool(SCRIPT.stat().st_mode & stat.S_IXUSR),
                        "scripts/build_package.sh is not executable")

    def test_bash_syntax_ok(self):
        if not POSIX:
            self.skipTest("bash syntax check needs bash")
        result = subprocess.run(["bash", "-n", str(SCRIPT)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_help_exits_zero(self):
        if not POSIX:
            self.skipTest("--help needs bash")
        result = subprocess.run([str(SCRIPT), "--help"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--out-dir", result.stdout)

    def test_unknown_option_fails(self):
        if not POSIX:
            self.skipTest("option parsing needs bash")
        result = subprocess.run([str(SCRIPT), "--nope"],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)


@unittest.skipUnless(POSIX and HAS_TAR, "packaging needs bash + tar on POSIX")
class PackagingBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.out_dir = Path(cls._tmp.name) / "dist"
        result = subprocess.run(
            [str(SCRIPT), "--out-dir", str(cls.out_dir)],
            cwd=ROOT, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        cls.tarball = cls.out_dir / f"nyra-{VERSION}.tar.gz"
        cls.deb = cls.out_dir / f"nyra_{VERSION}_all.deb"

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_tarball_exists_and_is_named_after_version(self):
        self.assertTrue(self.tarball.is_file(), "tarball missing")
        self.assertGreater(self.tarball.stat().st_size, 0)

    def test_tarball_contents_are_whitelisted(self):
        with tarfile.open(self.tarball, "r:gz") as tf:
            names = tf.getnames()
        top = f"nyra-{VERSION}/"
        self.assertTrue(all(n == top.rstrip("/") or n.startswith(top)
                            for n in names),
                        "tarball entries must live under nyra-<version>/")
        for bad in ("__pycache__", ".git", ".venv", "dist/"):
            self.assertFalse(any(bad in n for n in names),
                             f"tarball leaks {bad}")
        for expected in (
            f"{top}nyra/__main__.py",
            f"{top}nyra/worker.py",
            f"{top}scripts/install.sh",
            f"{top}systemd/nyra-scheduler.service",
            f"{top}README.md",
            f"{top}LICENSE",
            f"{top}docs/linux-install.md",
            f"{top}docs/linux-packaging.md",
        ):
            self.assertIn(expected, names, f"tarball missing {expected}")

    def test_tarball_extract_runs_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            with tarfile.open(self.tarball, "r:gz") as tf:
                tf.extractall(tmp)
            result = subprocess.run(
                [sys.executable, "-m", "nyra", "--version"],
                cwd=Path(tmp) / f"nyra-{VERSION}",
                capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"Nyra {VERSION}", result.stdout)

    def test_no_deb_flag_builds_tarball_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "dist"
            result = subprocess.run(
                [str(SCRIPT), "--out-dir", str(out), "--no-deb"],
                cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((out / f"nyra-{VERSION}.tar.gz").is_file())
            self.assertFalse((out / f"nyra_{VERSION}_all.deb").exists())

    @unittest.skipUnless(HAS_DPKG_DEB, "deb checks need dpkg-deb")
    def test_deb_exists(self):
        self.assertTrue(self.deb.is_file(), ".deb missing")

    @unittest.skipUnless(HAS_DPKG_DEB, "deb checks need dpkg-deb")
    def test_deb_control_fields(self):
        result = subprocess.run(["dpkg-deb", "--info", str(self.deb)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"Version: {VERSION}", result.stdout)
        self.assertIn("Architecture: all", result.stdout)
        self.assertIn("Depends: python3 (>= 3.10)", result.stdout)

    @unittest.skipUnless(HAS_DPKG_DEB, "deb checks need dpkg-deb")
    def test_deb_contents_and_payload_runs(self):
        result = subprocess.run(["dpkg-deb", "--contents", str(self.deb)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for expected in (
            "./usr/bin/nyra",
            "./usr/share/nyra/nyra/__main__.py",
            "./usr/share/nyra/systemd/nyra-scheduler.service",
            "./usr/share/nyra/scripts/install.sh",
        ):
            self.assertIn(expected, result.stdout,
                          f".deb missing {expected}")
        with tempfile.TemporaryDirectory() as tmp:
            extract = Path(tmp) / "root"
            result = subprocess.run(
                ["dpkg-deb", "-x", str(self.deb), str(extract)],
                capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            launcher = extract / "usr" / "bin" / "nyra"
            self.assertTrue(bool(launcher.stat().st_mode & stat.S_IXUSR),
                            "launcher in .deb is not executable")
            self.assertIn("PYTHONPATH=/usr/share/nyra",
                          launcher.read_text(encoding="utf-8"))
            env = dict(os.environ)
            env["PYTHONPATH"] = str(extract / "usr" / "share" / "nyra")
            result = subprocess.run(
                [sys.executable, "-m", "nyra", "--version"],
                capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"Nyra {VERSION}", result.stdout)


if __name__ == "__main__":
    unittest.main()
