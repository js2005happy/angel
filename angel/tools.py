"""Angel CLI tool schemas, approval checks, and standard-library implementations."""

from dataclasses import dataclass, field
import html
import posixpath
from pathlib import Path
import re
import shlex
import subprocess
from typing import Callable
import urllib.error
import urllib.parse
import urllib.request

from .memory import append_memory
from .skills import save_skill_file
from .evidence import EvidenceStore
from .net import open_url


class ToolError(Exception):
    pass


@dataclass
class ToolContext:
    workdir: Path
    mode: str
    interactive: bool
    memory_path: Path
    skills_dir: Path
    delegate_fn: Callable[[str, int], str] | None = None
    evidence: EvidenceStore | None = None
    # Execution backend for file and shell tools. None means local execution;
    # an E2BBackend routes those tools into a sandbox instead.
    backend: object | None = None
    # Optional approval callback (tool_name, summary) -> bool. When set, it
    # replaces the terminal [y/N] prompt for interactive auto mode, so other
    # front ends (such as the local web UI) reuse the same approval gate.
    approve_fn: Callable[[str, str], bool] | None = None
    # Explicit, session-local approvals for a small set of file tools and
    # identical shell command strings. Never persisted or reused by other runs.
    approved_file_tools: set[str] = field(default_factory=set)
    approved_shell_commands: set[str] = field(default_factory=set)


MUTATING_TOOLS = {
    "write_file",
    "edit_file",
    "shell",
    "memory_append",
    "save_skill",
    "plan",
    "http_post",
    # All MCP tools are treated as potentially mutating: the server's
    # advertised name/description cannot establish whether it is read-only.
    "mcp",
}

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取文件内容",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "创建或覆盖写入文件",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "精确替换文件中的一段文本",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_text": {"type": "string"},
                    "new_text": {"type": "string"},
                },
                "required": ["path", "old_text", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "列出目录内容",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "default": "."}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shell",
            "description": "执行 shell 命令",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string"},
                    "timeout": {"type": "integer", "default": 60},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "抓取网页文本内容",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "联网搜索",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "count": {"type": "integer", "default": 8},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_append",
            "description": "把一条重要信息写入长期记忆",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_skill",
            "description": "把一次成功做法保存为可复用技能",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "when": {"type": "string"},
                    "keywords": {
                        "type": "string",
                        "description": "用逗号分隔的关键词",
                    },
                    "instructions": {"type": "string"},
                },
                "required": [
                    "name",
                    "description",
                    "when",
                    "keywords",
                    "instructions",
                ],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delegate",
            "description": (
                "把子任务交给子 agent 执行并返回摘要；每次主任务最多 "
                "8 个子 agent，最多嵌套 3 层，单个子任务最多 12 轮"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {"type": "string", "minLength": 1},
                    "max_turns": {
                        "type": "integer", "default": 6, "minimum": 1, "maximum": 12
                    },
                },
                "required": ["task"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "plan",
            "description": "先写一份执行计划文件",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "steps": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "path": {"type": "string", "default": "plan.md"},
                },
                "required": ["title", "steps"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep_search",
            "description": "在目录里搜索文件内容（子串或正则），返回 文件:行号: 内容",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "path": {"type": "string", "default": "."},
                    "regex": {"type": "boolean", "default": False},
                    "case_sensitive": {"type": "boolean", "default": False},
                    "max_results": {"type": "integer", "default": 50},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "git_status",
            "description": "只读查看 git 仓库状态和改动统计（不修改任何内容）",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "default": "."}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "http_post",
            "description": "向 URL 发送 HTTP POST 请求（会对外发数据，需审批）",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "body": {"type": "string", "default": ""},
                    "content_type": {
                        "type": "string",
                        "default": "application/json",
                    },
                },
                "required": ["url"],
            },
        },
    },
]

MAX_OUTPUT_CHARS = 8000


def _truncate(text: str) -> str:
    if len(text) > MAX_OUTPUT_CHARS:
        return (
            text[:MAX_OUTPUT_CHARS]
            + f"\n……（输出过长，已截断，共 {len(text)} 字符）"
        )
    return text


def _resolve_backend_path(ctx: ToolContext, path: str) -> str:
    """Resolve sandbox paths as POSIX paths, independent of the host OS.

    On Windows, Path("/home/user") becomes a Windows path ("\\home\\user").
    Sending that to a Linux E2B sandbox breaks all file tools.
    """
    base = str(ctx.workdir).replace("\\", "/")
    target = str(path).replace("\\", "/")
    if posixpath.isabs(target):
        return posixpath.normpath(target)
    return posixpath.normpath(posixpath.join(base, target))


def _resolve_path(ctx: ToolContext, path: str) -> Path:
    if Path(path).is_absolute():
        return Path(path)
    return ctx.workdir / path


def _workspace_write_path(ctx: ToolContext, path: str) -> Path | str:
    """Keep built-in file writes under workdir, even in full mode.

    Local paths are resolved before use, so existing symlinks in any ancestor
    cannot redirect writes outside the workspace. The remote E2B backend is
    restricted lexically; it cannot inspect sandbox symlink targets here.
    This is not a shell/OS-level sandbox.
    """
    if not isinstance(path, str) or not path or "\x00" in path:
        raise ToolError("写入文件路径无效")
    if ctx.backend is not None:
        base = posixpath.normpath(str(ctx.workdir).replace("\\", "/"))
        target = _resolve_backend_path(ctx, path)
        if (not base.startswith("/") or target == base
                or not (target == base or target.startswith(base.rstrip("/") + "/"))):
            raise ToolError("禁止写入工作目录之外的路径")
        return target

    root = ctx.workdir.resolve()
    target = (root / path).resolve()
    if target == root or not target.is_relative_to(root):
        raise ToolError("禁止写入工作目录之外的路径")
    return target


_SESSION_FILE_TOOLS = frozenset(("write_file", "edit_file", "plan"))


def _check_approval(
    ctx: ToolContext, tool_name: str, summary: str, *, command: str | None = None
) -> None:
    if tool_name not in MUTATING_TOOLS:
        return
    if ctx.mode == "readonly":
        raise ToolError(
            f"只读模式下不允许执行 {tool_name}，请用 --mode auto 或 --mode full"
        )
    if ctx.mode == "auto":
        if not ctx.interactive:
            raise ToolError(
                "非交互模式下 auto 模式不执行写入操作，请使用 --mode full 重新运行"
            )
        # Session-wide approvals are *explicit* and narrowly scoped. No
        # wildcard approval for MCP, HTTP POST, memory or skill writes.
        if tool_name in _SESSION_FILE_TOOLS and tool_name in ctx.approved_file_tools:
            return
        if tool_name == "shell" and command is not None and command in ctx.approved_shell_commands:
            return
        if ctx.approve_fn is not None:
            if not ctx.approve_fn(tool_name, summary):
                raise ToolError("用户拒绝执行")
            return
        print(summary)
        allow_repeat = tool_name in _SESSION_FILE_TOOLS or (tool_name == "shell" and command is not None)
        prompt = "允许执行吗？[y/N/a] (a=本次会话同类文件工具或完全相同命令始终允许) " if allow_repeat else "允许执行吗？[y/N] "
        answer = input(prompt).strip().lower()
        if answer in ("y", "yes"):
            return
        if allow_repeat and answer in ("a", "always"):
            if tool_name in _SESSION_FILE_TOOLS:
                ctx.approved_file_tools.add(tool_name)
            elif tool_name == "shell" and command is not None:
                ctx.approved_shell_commands.add(command)
            return
        raise ToolError("用户拒绝执行")
    if ctx.mode == "full":
        return


def _check_shell_denied(command: str) -> str | None:
    # Tokenization here is deliberately lightweight, not a shell parser.
    tokens = re.findall(
        r"""(?:[^\s;&|<>()"'\\]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+|[;&|<>()]""",
        command,
    )
    tokens = [
        token[1:-1]
        if len(token) >= 2 and token[0] == token[-1] and token[0] in "\"'"
        else token
        for token in tokens
    ]
    dangerous_targets = {"/", "~", "$HOME", "${HOME}", "*", ".", ".."}
    separators = {";", "&", "|", "<", ">", "(", ")"}
    for index, token in enumerate(tokens):
        if token != "rm" and not token.endswith("/rm"):
            continue
        arguments: list[str] = []
        for argument in tokens[index + 1 :]:
            if argument in separators:
                break
            arguments.append(argument)
        if any(argument in ("-rf", "-fr") for argument in arguments):
            if any(
                argument in dangerous_targets or argument.startswith("/*")
                for argument in arguments
            ):
                return "禁止 rm -rf 删除根目录、家目录或通配路径"

    rules = [
        (r"\bsudo\s+rm\b", "禁止 sudo rm"),
        (r"\bmkfs(\.\w+)?\b", "禁止 mkfs 格式化命令"),
        (r"\bdd\b.*\bof=/dev/", "禁止 dd 写入设备"),
        (r"\b(shutdown|reboot|poweroff|halt)\b", "禁止关机/重启命令"),
        (r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;", "禁止 fork 炸弹"),
        (r">\s*/dev/(sd|hd|nvme|vd)[a-z0-9]*", "禁止重定向写入磁盘设备"),
        (r"\bchmod\s+-R\s+777\s+/", "禁止 chmod -R 777 /"),
        (r"\bchown\s+-R\b.*\s/$", "禁止 chown -R 到根目录"),
    ]
    for pattern, reason in rules:
        if re.search(pattern, command):
            return reason
    return None


def _tool_read_file(ctx: ToolContext, path: str) -> str:
    if ctx.backend is not None:
        return _truncate(ctx.backend.read_file(_resolve_backend_path(ctx, path)))
    target = _resolve_path(ctx, path)
    if not target.is_file():
        return f"错误：文件不存在：{path}"
    return _truncate(target.read_text(encoding="utf-8", errors="replace"))


def _tool_write_file(ctx: ToolContext, path: str, content: str) -> str:
    target = _workspace_write_path(ctx, path)
    _check_approval(ctx, "write_file", f"写入文件：{path}（{len(content)} 字符）")
    if ctx.backend is not None:
        return ctx.backend.write_file(str(target), content)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"已写入 {path}（{len(content)} 字符）"


def _tool_edit_file(
    ctx: ToolContext, path: str, old_text: str, new_text: str
) -> str:
    target = _workspace_write_path(ctx, path)
    _check_approval(ctx, "edit_file", f"编辑文件：{path}")
    if ctx.backend is not None:
        resolved = str(target)
        content = ctx.backend.read_file(resolved)
        if content.startswith("错误："):
            return content
        count = content.count(old_text)
        if count == 0:
            return "错误：未找到要替换的文本"
        if count > 1:
            return f"错误：找到 {count} 处匹配，请提供更精确的 old_text"
        return ctx.backend.write_file(resolved, content.replace(old_text, new_text, 1))
    if not target.is_file():
        return f"错误：文件不存在：{path}"
    content = target.read_text(encoding="utf-8")
    count = content.count(old_text)
    if count == 0:
        return "错误：未找到要替换的文本"
    if count > 1:
        return f"错误：找到 {count} 处匹配，请提供更精确的 old_text"
    target.write_text(content.replace(old_text, new_text, 1), encoding="utf-8")
    return f"已编辑 {path}"


def _tool_list_dir(ctx: ToolContext, path: str = ".") -> str:
    if ctx.backend is not None:
        return ctx.backend.list_dir(_resolve_backend_path(ctx, path))
    target = _resolve_path(ctx, path)
    if not target.is_dir():
        return f"错误：目录不存在：{path}"
    entries = sorted(target.iterdir(), key=lambda entry: (not entry.is_dir(), entry.name))
    lines = [
        f"{entry.name}/"
        if entry.is_dir()
        else f"{entry.name} ({entry.stat().st_size} 字节)"
        for entry in entries
    ]
    return "\n".join(lines) or "（空目录）"


def _tool_shell(
    ctx: ToolContext,
    command: str,
    cwd: str | None = None,
    timeout: int = 60,
) -> str:
    denied = _check_shell_denied(command)
    if denied:
        return f"错误：{denied}"
    _check_approval(ctx, "shell", f"执行命令：{command}", command=command)
    if ctx.backend is not None:
        resolved_cwd = _resolve_backend_path(ctx, cwd or ".")
        return _truncate(
            ctx.backend.run_command(command, cwd=resolved_cwd, timeout=timeout)
        ) or "（无输出）"
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=(ctx.workdir / cwd if cwd else ctx.workdir),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"错误：命令超时（{timeout} 秒）"
    combined = result.stdout
    if result.stderr:
        if combined and not combined.endswith("\n"):
            combined += "\n"
        combined += "标准错误：\n" + result.stderr
    return _truncate(combined) or "（无输出）"


def _tool_web_fetch(ctx: ToolContext, url: str) -> str:
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Angel/0.2"})
        with open_url(request, 30) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            text = response.read().decode(charset, errors="replace")
        cleaned = re.sub(r"<[^>]+>", " ", text)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        body = _truncate(cleaned)
        if ctx.evidence is not None:
            path = ctx.evidence.save("web_fetch", url, cleaned)
            body += f"\n\n[证据已保存：{path}，来源：{url}]"
        return body
    except Exception as exc:
        return f"错误：抓取失败：{exc}"


def _parse_baidu_html(text: str, count: int) -> list[str]:
    """Parse Baidu result titles/abstracts into display lines."""
    lowered = text.lower()
    if (
        "百度安全验证" in text
        or "请输入验证码" in text
        or "captcha" in lowered
    ):
        raise ToolError("百度要求安全验证")
    titles = re.findall(
        r"<h3[^>]*>\s*<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>",
        text,
        re.S,
    )
    abstracts = re.findall(
        r"class=\"c-abstract[^\"]*\"[^>]*>(.*?)</(?:div|span)>",
        text,
        re.S,
    )
    results: list[str] = []
    for index, (href, title) in enumerate(titles[:max(0, count)]):
        href = html.unescape(href).strip()
        title = html.unescape(re.sub(r"<[^>]+>", "", title)).strip()
        if not title or not href:
            continue
        snippet = abstracts[index] if index < len(abstracts) else ""
        snippet = html.unescape(re.sub(r"<[^>]+>", "", snippet)).strip()
        results.append(f"{index + 1}. {title}\n   {href}\n   {snippet}")
    return results


def _parse_bing_html(text: str, count: int) -> list[str]:
    """Parse Bing result blocks into display lines."""
    lowered = text.lower()
    if "captcha" in lowered or "请输入验证码" in text or "not a robot" in lowered:
        raise ToolError("Bing 要求人机验证")
    blocks = re.findall(
        r'<li class="b_algo".*?<h2><a[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?<p[^>]*>(.*?)</p>',
        text,
        re.S,
    )
    results: list[str] = []
    for index, (href, title, snippet) in enumerate(blocks[:max(0, count)]):
        href = html.unescape(href).strip()
        title = html.unescape(re.sub(r"<[^>]+>", "", title)).strip()
        snippet = html.unescape(re.sub(r"<[^>]+>", "", snippet)).strip()
        if not title and not href:
            continue
        results.append(f"{index + 1}. {title}\n   {href}\n   {snippet}")
    return results


def _fetch_search_page(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
            ),
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    )
    with open_url(request, 30) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def _tool_web_search(ctx: ToolContext, query: str, count: int = 8) -> str:
    """Search the web with a fallback chain; never fabricate results.

    后端顺序按 IllusionAgent 的做法：必应优先，百度兜底。每次搜索都用
    全新的请求（不共享 cookie/会话），失败时明确报错，不编结果。
    """
    errors: list[str] = []
    sources = [
        (
            "Bing",
            "https://www.bing.com/search?q=" + urllib.parse.quote(query),
            _parse_bing_html,
        ),
        (
            "百度",
            "https://www.baidu.com/s?wd=" + urllib.parse.quote(query),
            _parse_baidu_html,
        ),
    ]
    for name, url, parser in sources:
        try:
            results = parser(_fetch_search_page(url), count)
        except ToolError as exc:
            errors.append(f"{name}：{exc}")
            continue
        except Exception as exc:
            errors.append(f"{name}：请求失败（{exc}）")
            continue
        if results:
            body = "\n\n".join(results)
            if ctx.evidence is not None:
                path = ctx.evidence.save("web_search", url, body, query=query)
                body += f"\n\n[证据已保存：{path}]"
            return body
        errors.append(f"{name}：未返回可解析的结果")
    return "错误：搜索失败（" + "；".join(errors) + "），请稍后重试或换个网络"


def _tool_memory_append(ctx: ToolContext, text: str) -> str:
    _check_approval(ctx, "memory_append", f"写入记忆：{text[:60]}")
    append_memory(text, path=ctx.memory_path)
    return "已写入长期记忆"


def _tool_save_skill(
    ctx: ToolContext,
    name: str,
    description: str,
    when: str,
    keywords: str | list[str],
    instructions: str,
) -> str:
    _check_approval(ctx, "save_skill", f"保存技能：{name}")
    keywords_list = (
        [keyword.strip() for keyword in re.split(r"[,、]", keywords) if keyword.strip()]
        if isinstance(keywords, str)
        else keywords
    )
    save_skill_file(
        ctx.skills_dir, name, description, when, keywords_list, instructions
    )
    return f"已保存技能 {name}"


def _tool_delegate(ctx: ToolContext, task: str, max_turns: int = 6) -> str:
    if ctx.delegate_fn is None:
        return "错误：子 agent 不可用"
    return ctx.delegate_fn(task, max_turns)


def _tool_plan(
    ctx: ToolContext,
    title: str,
    steps: list[str],
    path: str = "plan.md",
) -> str:
    target = _workspace_write_path(ctx, path)
    _check_approval(ctx, "plan", f"写入计划文件：{path}")
    content = (
        f"# {title}\n\n"
        + "\n".join(f"{i}. {s}" for i, s in enumerate(steps, 1))
        + "\n"
    )
    if ctx.backend is not None:
        ctx.backend.write_file(str(target), content)
        return f"已写入计划 {path}（{len(steps)} 步）"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"已写入计划 {path}（{len(steps)} 步）"


_SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", ".idea", ".vscode"}


def _tool_grep_search(
    ctx: ToolContext,
    pattern: str,
    path: str = ".",
    regex: bool = False,
    case_sensitive: bool = False,
    max_results: int = 50,
) -> str:
    if ctx.backend is not None:
        if regex:
            try:
                re.compile(pattern, 0 if case_sensitive else re.IGNORECASE)
            except re.error as exc:
                return f"错误：正则表达式无效：{exc}"
        flags = ["-rn"]
        if regex:
            flags.append("-E")
        if not case_sensitive:
            flags.append("-i")
        excludes = " ".join(
            f"--exclude-dir={d}" for d in sorted(_SKIP_DIRS | {".*"})
        )
        command = (
            f"grep {' '.join(flags)} {excludes} -- "
            f"{shlex.quote(pattern)} {shlex.quote(_resolve_backend_path(ctx, path))}"
        )
        out = ctx.backend.run_command(command, cwd=_resolve_backend_path(ctx, "."), timeout=30)
        if "No such file or directory" in out:
            return f"错误：路径不存在：{path}"
        lines = [line for line in out.splitlines() if line.strip()]
        if not lines:
            return "未找到匹配内容"
        found = lines[:max_results]
        result = "\n".join(found)
        if len(lines) > max_results:
            result += f"\n……（已达上限 {max_results} 条）"
        return result
    root = _resolve_path(ctx, path)
    if not root.exists():
        return f"错误：路径不存在：{path}"
    if regex:
        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            compiled = re.compile(pattern, flags)
        except re.error as exc:
            return f"错误：正则表达式无效：{exc}"
        match = lambda line: compiled.search(line) is not None
    else:
        needle = pattern if case_sensitive else pattern.lower()
        match = lambda line: needle in (line if case_sensitive else line.lower())

    found: list[str] = []
    files = [root] if root.is_file() else sorted(root.rglob("*"))
    for entry in files:
        if len(found) >= max_results:
            break
        if entry.is_dir():
            continue
        if any(part in _SKIP_DIRS or part.startswith(".") and part != "." for part in entry.relative_to(root).parts[:-1]):
            continue
        try:
            text = entry.read_text(encoding="utf-8", errors="strict")
        except (OSError, UnicodeDecodeError, ValueError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if match(line):
                rel = entry.relative_to(ctx.workdir) if entry.is_relative_to(ctx.workdir) else entry
                found.append(f"{rel}:{lineno}: {line.strip()[:200]}")
                if len(found) >= max_results:
                    break
    if not found:
        return "未找到匹配内容"
    out = "\n".join(found)
    if len(found) >= max_results:
        out += f"\n……（已达上限 {max_results} 条）"
    return out


def _tool_git_status(ctx: ToolContext, path: str = ".") -> str:
    if ctx.backend is not None:
        target = _resolve_backend_path(ctx, path)
        out = ctx.backend.run_command(
            f"git -C {shlex.quote(str(target))} status --short --branch",
            cwd=_resolve_backend_path(ctx, "."),
            timeout=15,
        )
        if "fatal: not a git repository" in out or "不是一个 git 仓库" in out:
            return "错误：该目录不是 git 仓库（或 git 报错）"
        diff = ctx.backend.run_command(
            f"git -C {shlex.quote(str(target))} diff --stat",
            cwd=_resolve_backend_path(ctx, "."),
            timeout=15,
        )
        combined = out.strip() or "（工作区干净）"
        if diff.strip() and "fatal" not in diff:
            combined += "\n\n改动统计：\n" + diff.strip()
        return _truncate(combined)
    target = _resolve_path(ctx, path)
    if not target.is_dir():
        return f"错误：目录不存在：{path}"
    try:
        status = subprocess.run(
            ["git", "-C", str(target), "status", "--short", "--branch"],
            capture_output=True, text=True, timeout=15,
        )
    except FileNotFoundError:
        return "错误：本机未安装 git"
    except subprocess.TimeoutExpired:
        return "错误：git status 超时"
    if status.returncode != 0:
        return "错误：该目录不是 git 仓库（或 git 报错）"
    diff = subprocess.run(
        ["git", "-C", str(target), "diff", "--stat"],
        capture_output=True, text=True, timeout=15,
    )
    out = (status.stdout or "（工作区干净）").strip()
    if diff.returncode == 0 and diff.stdout.strip():
        out += "\n\n改动统计：\n" + diff.stdout.strip()
    return _truncate(out)


def _tool_http_post(
    ctx: ToolContext,
    url: str,
    body: str = "",
    content_type: str = "application/json",
) -> str:
    _check_approval(ctx, "http_post", f"POST 请求：{url}")
    try:
        request = urllib.request.Request(
            url,
            data=body.encode("utf-8"),
            method="POST",
            headers={"Content-Type": content_type, "User-Agent": "Angel/0.2"},
        )
        with open_url(request, 30) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            text = response.read().decode(charset, errors="replace")
        return f"HTTP {response.status}\n{_truncate(text)}"
    except urllib.error.HTTPError as exc:
        try:
            text = exc.read().decode("utf-8", errors="replace")
        except Exception:
            text = ""
        return f"HTTP {exc.code}\n{_truncate(text)}"
    except Exception as exc:
        return f"错误：POST 请求失败：{exc}"


def execute_tool(name: str, arguments: dict, ctx: ToolContext) -> str:
    dispatch: dict[str, Callable[..., str]] = {
        "read_file": _tool_read_file,
        "write_file": _tool_write_file,
        "edit_file": _tool_edit_file,
        "list_dir": _tool_list_dir,
        "shell": _tool_shell,
        "web_fetch": _tool_web_fetch,
        "web_search": _tool_web_search,
        "memory_append": _tool_memory_append,
        "save_skill": _tool_save_skill,
        "delegate": _tool_delegate,
        "plan": _tool_plan,
        "grep_search": _tool_grep_search,
        "git_status": _tool_git_status,
        "http_post": _tool_http_post,
    }
    tool = dispatch.get(name)
    if tool is None:
        return f"错误：未知工具 {name}"
    try:
        return tool(ctx, **arguments)
    except ToolError as exc:
        return f"错误：{exc}"
    except TypeError as exc:
        return f"错误：工具参数不正确：{exc}"
    except Exception as exc:
        return f"执行失败：{type(exc).__name__}: {exc}"
