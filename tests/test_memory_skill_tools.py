"""Tests for the memory_append and save_skill tools.

These two tools write real files under ~/.nyra/ and had no unit tests
(VERIFICATION.md v1 known limitation 3). memory_append now writes to the
ToolContext's memory_path instead of the process-wide default, so the tests
below never touch the real ~/.nyra/MEMORY.md.
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nyra import memory as memory_mod
from nyra.skills import load_skills, parse_skill_file
from nyra.tools import ToolContext, execute_tool


def _ctx(tmp: Path, mode: str = "full", interactive: bool = False) -> ToolContext:
    return ToolContext(
        workdir=tmp,
        mode=mode,
        interactive=interactive,
        memory_path=tmp / "MEMORY.md",
        skills_dir=tmp / "skills",
    )


class MemoryAppendTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.addCleanup(self._tmpdir.cleanup)

    def test_writes_timestamped_line_to_context_path(self):
        ctx = _ctx(self.tmp)
        out = execute_tool("memory_append", {"text": "用户喜欢用竖屏视频"}, ctx)
        self.assertIn("已写入长期记忆", out)
        content = (self.tmp / "MEMORY.md").read_text(encoding="utf-8")
        self.assertIn("用户喜欢用竖屏视频", content)
        self.assertEqual(len(content.strip().splitlines()), 1)
        self.assertRegex(content, r"^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] ")

    def test_multiline_text_collapses_to_one_line(self):
        execute_tool("memory_append", {"text": "第一行\n第二行"}, _ctx(self.tmp))
        lines = (self.tmp / "MEMORY.md").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        self.assertIn("第一行 第二行", lines[0])

    def test_blank_text_writes_nothing(self):
        out = execute_tool("memory_append", {"text": "  \n "}, _ctx(self.tmp))
        self.assertIn("已写入长期记忆", out)
        self.assertFalse((self.tmp / "MEMORY.md").exists())

    def test_readonly_blocks(self):
        ctx = _ctx(self.tmp, mode="readonly")
        out = execute_tool("memory_append", {"text": "不该写入"}, ctx)
        self.assertIn("只读模式", out)
        self.assertFalse((self.tmp / "MEMORY.md").exists())

    def test_auto_non_interactive_blocks(self):
        ctx = _ctx(self.tmp, mode="auto", interactive=False)
        out = execute_tool("memory_append", {"text": "不该写入"}, ctx)
        self.assertIn("非交互模式", out)
        self.assertFalse((self.tmp / "MEMORY.md").exists())

    def test_append_memory_default_path_and_summary(self):
        target = self.tmp / "alt-MEMORY.md"
        with mock.patch.object(memory_mod, "MEMORY_PATH", target):
            memory_mod.append_memory("直接调用也写默认路径")
            self.assertIn("直接调用也写默认路径", memory_mod.load_memory_summary())


class SaveSkillTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.addCleanup(self._tmpdir.cleanup)

    def _save(self, ctx, **kwargs):
        args = {
            "name": "demo-skill",
            "description": "演示技能",
            "when": "测试时用",
            "keywords": "搜索, 最新",
            "instructions": "先搜索再核实。",
        }
        args.update(kwargs)
        return execute_tool("save_skill", args, ctx)

    def test_writes_parseable_skill_file(self):
        out = self._save(_ctx(self.tmp))
        self.assertIn("已保存技能 demo-skill", out)
        path = self.tmp / "skills" / "demo-skill.md"
        self.assertTrue(path.exists())
        skill = parse_skill_file(path)
        self.assertEqual(skill.name, "demo-skill")
        self.assertEqual(skill.description, "演示技能")
        self.assertEqual(skill.keywords, ["搜索", "最新"])
        self.assertIn("先搜索再核实", skill.instructions)
        self.assertEqual(
            [s.name for s in load_skills([self.tmp / "skills"])], ["demo-skill"]
        )

    def test_keywords_list_and_overwrite(self):
        ctx = _ctx(self.tmp)
        self._save(ctx, keywords=["甲", "乙"])
        out = self._save(ctx, keywords=["甲", "乙"], instructions="新版说明。")
        self.assertIn("已保存技能", out)
        skill = parse_skill_file(self.tmp / "skills" / "demo-skill.md")
        self.assertEqual(skill.keywords, ["甲", "乙"])
        self.assertIn("新版说明", skill.instructions)

    def test_invalid_name_rejected_without_file(self):
        ctx = _ctx(self.tmp)
        out = self._save(ctx, name="bad name!")
        self.assertIn("执行失败", out)
        self.assertIn("Skill 名称", out)
        self.assertFalse((self.tmp / "skills" / "bad name!.md").exists())

    def test_readonly_blocks(self):
        ctx = _ctx(self.tmp, mode="readonly")
        out = self._save(ctx)
        self.assertIn("只读模式", out)
        self.assertFalse((self.tmp / "skills" / "demo-skill.md").exists())

    def test_auto_non_interactive_blocks(self):
        ctx = _ctx(self.tmp, mode="auto", interactive=False)
        out = self._save(ctx)
        self.assertIn("非交互模式", out)
        self.assertFalse((self.tmp / "skills" / "demo-skill.md").exists())


if __name__ == "__main__":
    unittest.main()
