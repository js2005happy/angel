"""Tests for the NYRA wordmark start-up banner (nyra/banner.py)."""

import unittest

from nyra import __version__ as VERSION
from nyra.banner import WORDMARK, render_banner, wordmark_lines
from nyra.cli import _display_width, format_banner

ANSI = "\x1b["

DESC = "deepseek / deepseek-flash @ https://api.deepseek.com/v1"


class RenderBannerTests(unittest.TestCase):
    def test_contains_identity_and_model(self):
        text = render_banner(VERSION, DESC, "auto", "20261118-121346-58a3")
        self.assertIn("Nyra", text)
        self.assertIn(VERSION, text)
        self.assertIn(DESC, text)  # provider description printed verbatim
        self.assertIn("deepseek-flash", text)
        self.assertIn("auto", text)
        self.assertIn("20261118-121346-58a3", text)

    def test_model_line_is_its_own_line_under_the_wordmark(self):
        lines = render_banner(VERSION, DESC, "auto", "sid-1").splitlines()
        model_lines = [i for i, line in enumerate(lines) if line.startswith("模型：")]
        self.assertEqual(len(model_lines), 1)
        self.assertEqual(lines[model_lines[0]], f"模型：{DESC}")
        # The wordmark art is above the model line.
        self.assertGreater(model_lines[0], len(WORDMARK) - 1)

    def test_every_line_within_terminal_width(self):
        text = render_banner(VERSION, DESC, "auto", "20261118-121346-58a3")
        for line in text.splitlines():
            self.assertLessEqual(
                _display_width(line), 78, f"line too wide: {line!r}"
            )

    def test_wordmark_fits_sixty_columns(self):
        self.assertLessEqual(max(len(line) for line in WORDMARK), 60)
        for line in wordmark_lines():
            self.assertLessEqual(len(line), 60)

    def test_wordmark_spells_nyra(self):
        # Bold block letters: 11 rows, every row filled, first and last
        # rows non-empty, and the four letterforms present — the N's
        # diagonal, the Y's fork, the R's bowl and the A's crossbar.
        self.assertEqual(len(WORDMARK), 11)
        self.assertTrue(all(line.strip() for line in WORDMARK))
        art = "\n".join(WORDMARK)
        self.assertIn("##### ###", art)  # N diagonal
        self.assertIn("###   ###", art)  # Y arms / A legs
        self.assertIn("######", art)  # R bowl
        self.assertIn("#########", art)  # A crossbar
        self.assertTrue(all(set(line) <= set("# ") for line in WORDMARK))

    def test_no_ansi_without_color(self):
        text = render_banner(VERSION, DESC, "auto", "sid-1", color=False)
        self.assertNotIn(ANSI, text)
        self.assertNotIn(ANSI, "\n".join(wordmark_lines(color=False)))

    def test_ansi_with_color(self):
        text = render_banner(VERSION, DESC, "auto", "sid-1", color=True)
        self.assertIn(ANSI, text)

    def test_render_is_deterministic(self):
        args = (VERSION, DESC, "auto", "sid-1")
        self.assertEqual(render_banner(*args), render_banner(*args))
        self.assertEqual(
            render_banner(*args, color=True), render_banner(*args, color=True)
        )


class CliBannerWiringTests(unittest.TestCase):
    def test_format_banner_delegates_to_render_banner(self):
        banner = format_banner(DESC, "auto", "sid-1")
        self.assertEqual(
            banner, render_banner(VERSION, DESC, "auto", "sid-1")
        )
        self.assertIn("Nyra", banner)
        self.assertIn(DESC, banner)
        self.assertIn("sid-1", banner)
        self.assertNotIn(ANSI, banner)

    def test_format_banner_color(self):
        self.assertIn(ANSI, format_banner(DESC, "auto", "sid-1", color=True))


if __name__ == "__main__":
    unittest.main()
