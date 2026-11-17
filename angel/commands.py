"""User-defined slash commands and the /init AGENTS.md starter.

Custom commands are plain Markdown files, one per command, loaded from
``<workdir>/.angel/commands/*.md`` (project level, wins on name conflict)
and ``~/.angel/commands/*.md`` (user level). A file may start with a small
frontmatter block (``description:`` and ``argument-hint:``); the rest of
the file is the prompt template sent to the agent. ``$ARGUMENTS`` is
replaced with the words typed after the command, ``$1``..``$9`` with the
individual words. A command body is only a prompt: it cannot run code,
read files, or change settings by itself.

``/init`` writes a starter ``AGENTS.md`` into the working directory
through the normal ``write_file`` tool, so approval, the workdir boundary,
and checkpoints apply exactly as they do for any other file write.
"""

import re
import sys
from dataclasses import dataclass
from pathlib import Path

from .config import ANGEL_HOME

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_PLACEHOLDER_RE = re.compile(r"\$(\d+|ARGUMENTS)")

# Directories searched for custom commands, highest priority first.
USER_COMMANDS_DIR = ANGEL_HOME / "commands"


def command_dirs(workdir: Path) -> list[Path]:
    """Project commands first, then user-level commands."""
    return [workdir / ".angel" / "commands", USER_COMMANDS_DIR]


@dataclass
class CustomCommand:
    name: str
    description: str
    argument_hint: str
    instructions: str
    path: Path
    source: str  # "project" or "user"


def parse_command_file(path: Path, source: str = "user") -> CustomCommand:
    """Read one command file; the command name comes from the file name."""
    name = path.stem
    if not _NAME_RE.match(name):
        raise ValueError(f"自定义命令名称只允许字母、数字、- 和 _: {path}")
    if path.is_symlink():
        raise ValueError(f"自定义命令拒绝符号链接文件: {path}")

    lines = path.read_text(encoding="utf-8").splitlines()
    metadata: dict[str, str] = {}
    body_start = 0
    if lines and lines[0] == "---":
        try:
            closing_index = lines.index("---", 1)
        except ValueError:
            raise ValueError(f"自定义命令 frontmatter 未闭合: {path}") from None
        for line in lines[1:closing_index]:
            key, separator, value = line.partition(":")
            if separator and key.strip() in {"description", "argument-hint"}:
                metadata[key.strip()] = value.strip()
        body_start = closing_index + 1

    body_lines = lines[body_start:]
    start = 0
    end = len(body_lines)
    while start < end and not body_lines[start].strip():
        start += 1
    while end > start and not body_lines[end - 1].strip():
        end -= 1
    instructions = "\n".join(body_lines[start:end])
    if not instructions:
        raise ValueError(f"自定义命令正文为空: {path}")

    return CustomCommand(
        name=name,
        description=metadata.get("description", ""),
        argument_hint=metadata.get("argument-hint", ""),
        instructions=instructions,
        path=path,
        source=source,
    )


def load_commands(
    dirs: list[Path], project_dir: Path | None = None
) -> list[CustomCommand]:
    """Load commands in directory order, keeping the first of each name.

    Files under ``project_dir`` are marked source "project"; the rest are
    "user" commands.
    """
    commands: list[CustomCommand] = []
    seen_names: set[str] = set()
    for directory in dirs:
        if not directory.is_dir():
            continue
        source = (
            "project"
            if project_dir is not None and directory == project_dir
            else "user"
        )
        for path in sorted(directory.glob("*.md"), key=lambda item: item.name):
            try:
                command = parse_command_file(path, source=source)
            except (ValueError, OSError) as exc:
                print(f"跳过无效自定义命令 {path}: {exc}", file=sys.stderr)
                continue
            if command.name not in seen_names:
                seen_names.add(command.name)
                commands.append(command)
    return commands


def find_command(commands: list[CustomCommand], name: str) -> CustomCommand | None:
    for command in commands:
        if command.name == name:
            return command
    return None


def render_command(command: CustomCommand, args: str) -> str:
    """Substitute $ARGUMENTS / $1..$9; append args when no placeholder exists."""
    words = args.split()

    def replace(match: re.Match[str]) -> str:
        token = match.group(1)
        if token == "ARGUMENTS":
            return args
        index = int(token)
        return words[index - 1] if 1 <= index <= len(words) else ""

    rendered = _PLACEHOLDER_RE.sub(replace, command.instructions)
    if args and not _PLACEHOLDER_RE.search(command.instructions):
        rendered = rendered.rstrip() + "\n\n" + args
    return rendered


AGENTS_TEMPLATE = """# AGENTS.md

<!-- Angel /init 生成的起始模板：按本项目实际情况改写，Agent 每次任务都会读它。 -->

## 项目简介

<!-- 一句话：这个项目是做什么的，给谁用的。 -->

## 常用命令

<!-- 怎么构建、测试、运行，逐条写清楚，Agent 会照着跑。 -->

- 构建：
- 测试：
- 运行：

## 约定

<!-- 代码风格、目录划分、不要碰的文件、提交信息格式等。 -->

## 注意事项

<!-- 已知坑、外部依赖、需要真人确认的操作。 -->
"""
