"""Workspace trust store (nyra/trust.py) and the CLI trust gate."""

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from nyra import trust
from nyra import cli


class TrustStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.work = Path(self.tmp.name) / "project"
        self.work.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_untrusted_by_default(self):
        self.assertFalse(trust.is_trusted(self.work, home=self.home))
        self.assertEqual(trust.load_trusted(home=self.home), {})

    def test_add_then_trusted_one_entry_per_absolute_path(self):
        key = trust.add_trusted(self.work, home=self.home)
        self.assertTrue(os.path.isabs(key))
        self.assertTrue(trust.is_trusted(self.work, home=self.home))
        trust.add_trusted(str(self.work) + os.sep, home=self.home)  # same folder
        data = json.loads(trust.trust_file(self.home).read_text(encoding="utf-8"))
        self.assertEqual(data["version"], 1)
        self.assertEqual(list(data["folders"]), [key])

    def test_relative_path_resolves(self):
        old = os.getcwd()
        os.chdir(self.work)
        try:
            trust.add_trusted(".", home=self.home)
        finally:
            os.chdir(old)
        self.assertTrue(trust.is_trusted(self.work, home=self.home))

    def test_exact_path_only(self):
        child = self.work / "sub"
        child.mkdir()
        trust.add_trusted(self.work, home=self.home)
        self.assertFalse(trust.is_trusted(child, home=self.home))
        self.assertFalse(trust.is_trusted(self.work.parent, home=self.home))

    def test_corrupt_file_means_untrusted(self):
        self.home.mkdir(parents=True)
        trust.trust_file(self.home).write_text("{not json", encoding="utf-8")
        self.assertFalse(trust.is_trusted(self.work, home=self.home))
        trust.trust_file(self.home).write_text('{"folders": []}', encoding="utf-8")
        self.assertFalse(trust.is_trusted(self.work, home=self.home))
        # A new trust overwrites the broken file cleanly.
        trust.add_trusted(self.work, home=self.home)
        self.assertTrue(trust.is_trusted(self.work, home=self.home))

    def test_remove(self):
        trust.add_trusted(self.work, home=self.home)
        self.assertTrue(trust.remove_trusted(self.work, home=self.home))
        self.assertFalse(trust.is_trusted(self.work, home=self.home))
        self.assertFalse(trust.remove_trusted(self.work, home=self.home))

    @unittest.skipIf(os.name == "nt", "no POSIX permission bits on Windows")
    def test_file_is_private(self):
        trust.add_trusted(self.work, home=self.home)
        mode = trust.trust_file(self.home).stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_no_temp_files_left(self):
        trust.add_trusted(self.work, home=self.home)
        names = [p.name for p in self.home.iterdir()]
        self.assertEqual(names, [trust.TRUST_FILENAME])


class _Tty(io.StringIO):
    def isatty(self):
        return True


class TrustGateTests(unittest.TestCase):
    """cli._ensure_workspace_trusted: when it asks, and what each answer does."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.work = Path(self.tmp.name) / "project"
        self.work.mkdir()
        self.patch = mock.patch("nyra.trust._home", lambda home: self.home if home is None else Path(home))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def gate(self, trust_flag=False, config=None, tty=True, answer=None):
        args = SimpleNamespace(trust=trust_flag)
        stdin = _Tty() if tty else io.StringIO()
        stdout = _Tty() if tty else io.StringIO()
        with mock.patch.object(sys, "stdin", stdin), mock.patch.object(sys, "stdout", stdout), \
                mock.patch("nyra.tui.tui_available", return_value=True), \
                mock.patch("nyra.tui.trust_prompt", return_value=answer) as prompt:
            result = cli._ensure_workspace_trusted(self.work, args, config or {})
        return result, prompt, stdout.getvalue()

    def test_non_tty_never_asks(self):
        result, prompt, _ = self.gate(tty=False)
        self.assertIsNone(result)
        prompt.assert_not_called()
        self.assertFalse(trust.is_trusted(self.work))

    def test_trust_flag_records_without_asking(self):
        result, prompt, _ = self.gate(trust_flag=True)
        self.assertIsNone(result)
        prompt.assert_not_called()
        self.assertTrue(trust.is_trusted(self.work))

    def test_config_skip(self):
        result, prompt, _ = self.gate(config={"skip_workspace_trust": True})
        self.assertIsNone(result)
        prompt.assert_not_called()

    def test_yes_records_and_continues(self):
        result, prompt, _ = self.gate(answer=True)
        self.assertIsNone(result)
        prompt.assert_called_once()
        self.assertTrue(trust.is_trusted(self.work))
        # Second run: already trusted, no question.
        result, prompt, _ = self.gate(answer=False)
        self.assertIsNone(result)
        prompt.assert_not_called()

    def test_no_exits_and_records_nothing(self):
        result, prompt, out = self.gate(answer=False)
        self.assertEqual(result, 1)
        self.assertIn("Nyra", out)
        self.assertFalse(trust.is_trusted(self.work))


class TrustFlagParserTests(unittest.TestCase):
    def test_trust_flag_parses(self):
        args = cli.build_parser().parse_args(["--trust"])
        self.assertTrue(args.trust)
        self.assertFalse(cli.build_parser().parse_args([]).trust)


if __name__ == "__main__":
    unittest.main()
