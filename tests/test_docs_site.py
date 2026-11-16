"""Checks for the static project website in docs/ (GitHub Pages)."""

import re
import unittest
from html.parser import HTMLParser
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"


class _Collector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.refs = []  # (tag, attr, value)

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name == "id" and value:
                self.ids.add(value)
            if name in ("href", "src", "action", "poster", "srcset", "data") and value is not None:
                self.refs.append((tag, name, value))


def _parse(path):
    collector = _Collector()
    collector.feed(path.read_text(encoding="utf-8"))
    return collector


class DocsSiteTests(unittest.TestCase):
    def test_required_files_exist(self):
        self.assertTrue((DOCS / "index.html").is_file())
        self.assertTrue((DOCS / ".nojekyll").is_file())

    def test_internal_links_and_anchors_resolve(self):
        page = _parse(DOCS / "index.html")
        for tag, attr, value in page.refs:
            if value.startswith(("https://", "mailto:")):
                continue
            if value.startswith("#"):
                self.assertIn(value[1:], page.ids, f"missing anchor {value}")
                continue
            target = value.split("#", 1)[0].split("?", 1)[0]
            self.assertTrue((DOCS / target).is_file(), f"missing file {value}")

    def test_no_external_resources_loaded(self):
        # Only <a href> may point off-site (GitHub links). Nothing may be *loaded*
        # from another origin: no CDN scripts, styles, fonts, images or trackers.
        page = _parse(DOCS / "index.html")
        for tag, attr, value in page.refs:
            if tag == "a" and attr == "href":
                continue
            self.assertFalse(
                re.match(r"^(https?:)?//", value.strip(), re.I),
                f"external resource <{tag} {attr}={value}>",
            )
        for path in list(DOCS.rglob("*.css")) + list(DOCS.rglob("*.js")) + [DOCS / "index.html"]:
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"@import", text), path)
            self.assertIsNone(re.search(r"url\(\s*['\"]?(https?:)?//", text, re.I), path)
            self.assertIsNone(re.search(r"fetch\(|XMLHttpRequest|sendBeacon", text), path)

    def test_external_links_are_https(self):
        page = _parse(DOCS / "index.html")
        for tag, attr, value in page.refs:
            self.assertFalse(value.startswith("http://"), value)

    def test_bilingual_blocks_are_paired(self):
        text = (DOCS / "index.html").read_text(encoding="utf-8")
        self.assertEqual(text.count('data-l="zh"'), text.count('data-l="en"'))
        self.assertIn('data-lang="zh"', text)


if __name__ == "__main__":
    unittest.main()
