"""Tests for user-defined slash commands and the /init AGENTS.md starter."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from angel.commands import (
    AGENTS_TEMPLATE,
    command_dirs,
    find_command,
    load_commands,
    parse_command_file,
    render_command,
)
from angel.tools import ToolContext, execute_tool


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _ctx(tmp: Path, mode: str = "full", interactive: bool = False) -> ToolContext:
    return ToolContext(
        workdir=tmp,
        mode=mode,
        interactive=interactive,
        memory_path=tmp / "MEMORY.md",
        skills_dir=tmp / "skills",
    )


class ParseCommandFileTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.addCleanup(self._tmpdir.cleanup)

    def test_frontmatter_and_body(self):
        path = _write(
            self.tmp / "review.md",
            "---\n"
            "description: 审查这段代码\n"
            "argument-hint: <文件>\n"
            "---\n"
            "审查以下代码并列出问题：$ARGUMENTS\n",
        )
        command = parse_command_file(path)
        self.assertEqual(command.name, "review")
        self.assertEqual(command.description, "审查这段代码")
        self.assertEqual(command.argument_hint, "<文件>")
        self.assertEqual(command.instructions, "审查以下代码并列出问题：$ARGUMENTS")

    def test_no_frontmatter_is_plain_body(self):
        path = _write(self.tmp / "hello.md", "向用户打招呼。\n")
        command = parse_command_file(path)
        self.assertEqual(command.name, "hello")
        self.assertEqual(command.description, "")
        self.assertEqual(command.instructions, "向用户打招呼。")

    def test_empty_body_rejected(self):
        path = _write(self.tmp / "empty.md", "---\ndescription: 空\n---\n\n")
        with self.assertRaises(ValueError):
            parse_command_file(path)

    def test_unclosed_frontmatter_rejected(self):
        path = _write(self.tmp / "bad.md", "---\ndescription: 没关上\n")
        with self.assertRaises(ValueError):
            parse_command_file(path)

    def test_invalid_name_rejected(self):
        path = _write(self.tmp / "bad name.md", "做点事\n")
        with self.assertRaises(ValueError):
            parse_command_file(path)

    def test_symlink_rejected(self):
        target = _write(self.tmp / "real.md", "做点事\n")
        link = self.tmp / "linked.md"
        link.symlink_to(target)
        with self.assertRaises(ValueError):
            parse_command_file(link)


class LoadCommandsTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.addCleanup(self._tmpdir.cleanup)
        self.project_dir = self.tmp / "work" / ".angel" / "commands"
        self.user_dir = self.tmp / "home" / "commands"

    def test_project_wins_over_user_on_name_conflict(self):
        _write(self.user_dir / "review.md", "用户版：审查 $ARGUMENTS\n")
        _write(self.project_dir / "review.md", "项目版：审查 $ARGUMENTS\n")
        commands = load_commands(
            [self.project_dir, self.user_dir], project_dir=self.project_dir
        )
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0].instructions, "项目版：审查 $ARGUMENTS")
        self.assertEqual(commands[0].source, "project")

    def test_user_command_source_and_missing_dirs(self):
        _write(self.user_dir / "hello.md", "打招呼\n")
        commands = load_commands(
            [self.project_dir, self.user_dir], project_dir=self.project_dir
        )
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0].source, "user")
        # Missing directories are tolerated.
        self.assertEqual(
            load_commands([self.tmp / "nope"], project_dir=self.project_dir), []
        )

    def test_invalid_file_skipped_not_fatal(self):
        _write(self.user_dir / "broken.md", "")
        _write(self.user_dir / "ok.md", "能用\n")
        commands = load_commands([self.user_dir])
        self.assertEqual([c.name for c in commands], ["ok"])

    def test_find_command(self):
        _write(self.user_dir / "hello.md", "打招呼\n")
        commands = load_commands([self.user_dir])
        self.assertIsNotNone(find_command(commands, "hello"))
        self.assertIsNone(find_command(commands, "missing"))


class RenderCommandTest(unittest.TestCase):
    def _command(self, body: str):
        import tempfile

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "cmd.md"
        path.write_text(body, encoding="utf-8")
        return parse_command_file(path)

    def test_arguments_placeholder(self):
        command = self._command("检查 $ARGUMENTS 并汇报\n")
        self.assertEqual(
            render_command(command, "a.py b.py"), "检查 a.py b.py 并汇报"
        )

    def test_positional_placeholders(self):
        command = self._command("比较 $1 和 $2\n")
        self.assertEqual(render_command(command, "旧 新"), "比较 旧 和 新")

    def test_missing_positional_becomes_empty(self):
        command = self._command("比较 $1 和 $2\n")
        self.assertEqual(render_command(command, "只有"), "比较 只有 和 ")

    def test_args_appended_without_placeholder(self):
        command = self._command("审查代码\n")
        self.assertEqual(render_command(command, "a.py"), "审查代码\n\na.py")

    def test_no_args_no_append(self):
        command = self._command("审查代码\n")
        self.assertEqual(render_command(command, ""), "审查代码")


class InitTemplateTest(unittest.TestCase):
    def test_template_has_expected_sections(self):
        for section in ("项目简介", "常用命令", "约定", "注意事项"):
            self.assertIn(section, AGENTS_TEMPLATE)
        self.assertTrue(AGENTS_TEMPLATE.startswith("# AGENTS.md"))

    def test_init_write_path_via_tools(self):
        """The exact calls /init makes: read (missing) then write."""
        with tempfile.TemporaryDirectory() as name:
            tmp = Path(name)
            ctx = _ctx(tmp)
            self.assertTrue(
                execute_tool("read_file", {"path": "AGENTS.md"}, ctx).startswith(
                    "错误："
                )
            )
            out = execute_tool(
                "write_file",
                {"path": "AGENTS.md", "content": AGENTS_TEMPLATE},
                ctx,
            )
            self.assertIn("已写入", out)
            self.assertEqual(
                (tmp / "AGENTS.md").read_text(encoding="utf-8"), AGENTS_TEMPLATE
            )
            # Second read now finds it, so /init must refuse to overwrite.
            self.assertFalse(
                execute_tool("read_file", {"path": "AGENTS.md"}, ctx).startswith(
                    "错误："
                )
            )

    def test_init_refused_in_readonly_mode(self):
        with tempfile.TemporaryDirectory() as name:
            tmp = Path(name)
            ctx = _ctx(tmp, mode="readonly")
            out = execute_tool(
                "write_file",
                {"path": "AGENTS.md", "content": AGENTS_TEMPLATE},
                ctx,
            )
            self.assertIn("错误", out)
            self.assertFalse((tmp / "AGENTS.md").exists())


class CommandDirsTest(unittest.TestCase):
    def test_project_dir_first(self):
        with tempfile.TemporaryDirectory() as name:
            workdir = Path(name)
            dirs = command_dirs(workdir)
            self.assertEqual(dirs[0], workdir / ".angel" / "commands")
            self.assertTrue(str(dirs[1]).endswith(".angel/commands"))


if __name__ == "__main__":
    unittest.main()
