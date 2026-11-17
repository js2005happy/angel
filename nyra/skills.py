"""Parse, load, match, render, and save Markdown skills for Nyra."""

from dataclasses import dataclass
from pathlib import Path
import sys


@dataclass
class Skill:
    name: str
    description: str
    when: str
    keywords: list[str]
    instructions: str
    path: Path


def parse_skill_file(path: Path) -> Skill:
    """Read a skill from a UTF-8 Markdown file with frontmatter."""
    lines = path.read_text(encoding="utf-8").splitlines()
    format_error = f"Skill 文件格式错误（缺少 frontmatter）: {path}"

    if not lines or lines[0] != "---":
        raise ValueError(format_error)

    try:
        closing_index = lines.index("---", 1)
    except ValueError:
        raise ValueError(format_error) from None

    metadata: dict[str, str] = {}
    for line in lines[1:closing_index]:
        key, separator, value = line.partition(":")
        if separator and key.strip() in {"name", "description", "when", "keywords"}:
            metadata[key.strip()] = value.strip()

    name = metadata.get("name", "")
    if not name:
        raise ValueError(f"Skill 缺少 name: {path}")

    keywords = [
        keyword.strip()
        for keyword in metadata.get("keywords", "").replace("、", ",").split(",")
        if keyword.strip()
    ]

    body_lines = lines[closing_index + 1:]
    start = 0
    end = len(body_lines)
    while start < end and not body_lines[start].strip():
        start += 1
    while end > start and not body_lines[end - 1].strip():
        end -= 1

    return Skill(
        name=name,
        description=metadata.get("description", ""),
        when=metadata.get("when", ""),
        keywords=keywords,
        instructions="\n".join(body_lines[start:end]),
        path=path,
    )


def load_skills(dirs: list[Path]) -> list[Skill]:
    """Load skills in directory order, keeping the first occurrence of each name."""
    skills: list[Skill] = []
    seen_names: set[str] = set()

    for directory in dirs:
        if not directory.is_dir():
            continue

        for path in sorted(directory.glob("*.md"), key=lambda item: item.name):
            try:
                skill = parse_skill_file(path)
            except (ValueError, OSError) as exc:
                print(f"跳过无效 skill 文件 {path}: {exc}", file=sys.stderr)
                continue

            if skill.name not in seen_names:
                seen_names.add(skill.name)
                skills.append(skill)

    return skills


def match_skills(
    task: str, skills: list[Skill], top_n: int = 2
) -> list[Skill]:
    """Return the highest-scoring skills for a case-insensitive task."""
    if not task or not skills or top_n <= 0:
        return []

    task_text = task.lower()
    scored: list[tuple[int, Skill]] = []

    for skill in skills:
        score = sum(
            1 for keyword in skill.keywords if keyword.lower() in task_text
        )
        if skill.name.lower() in task_text:
            score += 3
        if any(
            len(word) > 1 and word.lower() in task_text
            for word in skill.description.split()
        ):
            score += 1
        if score > 0:
            scored.append((score, skill))

    scored.sort(key=lambda item: (-item[0], item[1].name))
    return [skill for _, skill in scored[:top_n]]


def render_skill(skill: Skill) -> str:
    """Render a skill as a Markdown block for a system prompt."""
    lines = [f"## Skill: {skill.name}"]
    if skill.description:
        lines.append(skill.description)
    if skill.when:
        lines.append(f"何时使用：{skill.when}")
    lines.append(skill.instructions)
    return "\n".join(lines)


def save_skill_file(
    skills_dir: Path,
    name: str,
    description: str,
    when: str,
    keywords: list[str],
    instructions: str,
) -> Path:
    """Validate a skill name and write its UTF-8 Markdown file."""
    alphanumeric = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    allowed = alphanumeric + "_-"
    if (
        not name
        or name[0] not in alphanumeric
        or any(character not in allowed for character in name)
    ):
        raise ValueError("Skill 名称只允许字母、数字、- 和 _")

    skills_dir.mkdir(parents=True, exist_ok=True)
    path = skills_dir / f"{name}.md"
    content = (
        "---\n"
        f"name: {name}\n"
        f"description: {description}\n"
        f"when: {when}\n"
        f"keywords: {', '.join(keywords)}\n"
        "---\n"
        f"{instructions}"
    )
    if not content.endswith("\n"):
        content += "\n"
    path.write_text(content, encoding="utf-8")
    return path
