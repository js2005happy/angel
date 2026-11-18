"""Tests for nyra.skills: parse/load/match/render/save of Markdown skills."""

import tempfile
import unittest
from pathlib import Path

from nyra.skills import (
    load_skills,
    match_skills,
    parse_skill_file,
    render_skill,
    save_skill_file,
)

HEADER = """---
name: demo
description: 演示技能
when: 需要演示时
keywords: 演示、demo
---
做演示。
"""


class SkillsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def _write(self, name, text=HEADER):
        path = self.dir / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_parse_roundtrip(self):
        skill = parse_skill_file(self._write("demo.md"))
        self.assertEqual(skill.name, "demo")
        self.assertEqual(skill.keywords, ["演示", "demo"])
        self.assertEqual(skill.instructions, "做演示。")
        self.assertIn("演示技能", render_skill(skill))

    def test_parse_rejects_missing_frontmatter(self):
        with self.assertRaises(ValueError):
            parse_skill_file(self._write("bad.md", "no frontmatter\n"))

    def test_load_skips_bad_files_and_dedupes(self):
        self._write("a.md")
        self._write("b.md", HEADER.replace("name: demo", "name: demo"))
        self._write("bad.md", "junk")
        skills = load_skills([self.dir])
        self.assertEqual([s.name for s in skills], ["demo"])

    def test_match_prefers_keyword_and_name(self):
        skill = parse_skill_file(self._write("demo.md"))
        other = parse_skill_file(
            self._write("other.md", HEADER.replace("demo", "other"))
        )
        matched = match_skills("请做一个演示", [skill, other], top_n=2)
        self.assertEqual(matched[0].name, "demo")
        self.assertEqual(match_skills("", [skill]), [])
        self.assertEqual(match_skills("演示", [skill], top_n=0), [])

    def test_save_rejects_newline_in_frontmatter_fields(self):
        # A newline in description/when/keywords would inject a new
        # frontmatter line on the next load (e.g. a smuggled "name:"
        # line renames the skill). All such fields must be rejected.
        with self.assertRaises(ValueError):
            save_skill_file(
                self.dir, "x", "ok\nname: evil", "when", ["k"], "do"
            )
        with self.assertRaises(ValueError):
            save_skill_file(
                self.dir, "x", "ok", "when\nkeywords: evil", ["k"], "do"
            )
        with self.assertRaises(ValueError):
            save_skill_file(
                self.dir, "x", "ok", "when", ["good\nname: evil"], "do"
            )
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_save_roundtrip(self):
        path = save_skill_file(
            self.dir, "saved", "保存测试", "需要保存时",
            ["保存", "save"], "保存内容。",
        )
        skill = parse_skill_file(path)
        self.assertEqual(skill.name, "saved")
        self.assertEqual(skill.keywords, ["保存", "save"])
        self.assertEqual(skill.instructions, "保存内容。")


if __name__ == "__main__":
    unittest.main()
