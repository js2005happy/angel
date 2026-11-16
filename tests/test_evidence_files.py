"""Regression tests for evidence file naming and collision handling."""

import tempfile
import unittest
from pathlib import Path

from angel.evidence import EvidenceStore


class EvidenceFileTests(unittest.TestCase):
    def test_existing_filename_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            store = EvidenceStore(Path(temp), "session")
            # Simulate another writer creating the candidate after initialization.
            existing = store.dir / "001_fetch_example-com.md"
            existing.write_text("original", encoding="utf-8")
            saved = store.save("fetch", "https://example.com", "new content")
            self.assertNotEqual(saved, existing)
            self.assertEqual(existing.read_text(encoding="utf-8"), "original")
            self.assertIn("new content", saved.read_text(encoding="utf-8"))
            self.assertEqual(saved.name, "002_fetch_example-com.md")

    def test_kind_cannot_escape_evidence_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            store = EvidenceStore(Path(temp), "session")
            saved = store.save("../../escape", "https://example.com", "data")
            self.assertEqual(saved.parent, store.dir)
            self.assertEqual(saved.name, "001_escape_example-com.md")
            self.assertTrue(saved.is_file())

    def test_sequential_saves_have_unique_names(self):
        with tempfile.TemporaryDirectory() as temp:
            store = EvidenceStore(Path(temp), "session")
            first = store.save("search", "https://example.com", "first")
            second = store.save("search", "https://example.com", "second")
            self.assertNotEqual(first, second)
            self.assertEqual(first.read_text(encoding="utf-8").splitlines()[-1], "first")
            self.assertEqual(second.read_text(encoding="utf-8").splitlines()[-1], "second")


if __name__ == "__main__":
    unittest.main()
