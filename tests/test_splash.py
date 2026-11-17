"""The Nyra opening animation is inline, self-contained and skippable."""
import re
import unittest
from pathlib import Path

from angel.webui_page import PAGE_HTML

DOCS = Path(__file__).resolve().parent.parent / "docs" / "index.html"


class SplashTests(unittest.TestCase):
    def _check(self, html):
        self.assertEqual(html.count('id="nyra-splash"'), 1)
        self.assertIn("NyraSplash", html)
        self.assertIn("prefers-reduced-motion", html)       # honours reduced motion
        self.assertIn("nyra-splash-seen", html)             # once per session
        self.assertRegex(html, r"\['click','keydown','touchstart'\]")  # skippable
        start = html.index('id="nyra-splash"')
        block = html[start:html.index("</script>", start)]
        self.assertIsNone(re.search(r"<script[^>]+src=|fetch\(|XMLHttpRequest|@import", block))
        self.assertNotIn("已就绪", block)

    def test_web_ui_has_splash(self):
        self._check(PAGE_HTML)

    def test_docs_site_has_splash(self):
        self._check(DOCS.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
