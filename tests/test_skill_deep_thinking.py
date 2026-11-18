"""Tests for the shipped deep-thinking skill (Khazix ten prompts)."""

from pathlib import Path
import unittest

from nyra.skills import load_skills, match_skills, parse_skill_file

ROOT = Path(__file__).resolve().parent.parent
SKILL_PATH = ROOT / "skills" / "deep-thinking.md"

# 每条提示词各取一个标志性短语，十条缺一不可。
PROMPT_MARKERS = (
    "第一性原理",
    "3版方案",
    "症状误认为原因",
    "二阶、三阶",
    "跨领域",
    "最强反对者",
    "历史包袱",
    "认知成本",
    "最慢的那几个",
    "共同的根因",
)


class TestDeepThinkingSkill(unittest.TestCase):
    def test_parses_with_expected_metadata(self):
        skill = parse_skill_file(SKILL_PATH)
        self.assertEqual(skill.name, "deep-thinking")
        self.assertTrue(skill.description)
        self.assertTrue(skill.when)
        self.assertIn("第一性原理", skill.keywords)
        self.assertIn("复盘", skill.keywords)

    def test_contains_all_ten_prompts(self):
        skill = parse_skill_file(SKILL_PATH)
        for marker in PROMPT_MARKERS:
            self.assertIn(marker, skill.instructions, marker)

    def test_matches_relevant_tasks(self):
        skills = load_skills([ROOT / "skills"])
        names = [skill.name for skill in skills]
        self.assertIn("deep-thinking", names)

        matched = match_skills("全面复盘最近两周的 Bug、返工和回滚", skills)
        self.assertIn("deep-thinking", [s.name for s in matched])

        matched = match_skills("从第一性原理分析这个故障的本质原因", skills)
        self.assertIn("deep-thinking", [s.name for s in matched])

        matched = match_skills("写一首诗", skills)
        self.assertNotIn("deep-thinking", [s.name for s in matched])

    def test_shipped_skills_all_load(self):
        skills = load_skills([ROOT / "skills"])
        self.assertEqual(
            {s.name for s in skills},
            {"file-organizer", "verify-research", "web-research", "deep-thinking",
             "debugging"},
        )


if __name__ == "__main__":
    unittest.main()
