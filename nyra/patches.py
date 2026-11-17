"""Strict single-file unified patches and human-reviewable diff previews.

No shell, git apply, patch executable, external dependencies or fuzzy matching.
The caller is responsible for workdir confinement, approval and checkpointing.
"""

import difflib
import re

MAX_PATCH_CHARS = 64000
MAX_PATCH_FILE_BYTES = 2 * 1024 * 1024
MAX_PREVIEW_CHARS = 6000
MAX_PREVIEW_INPUT_BYTES = 128 * 1024

HUNK_HEADER = re.compile(
    r"^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?: .*)?$"
)
NO_NEWLINE = r"\ No newline at end of file"


class PatchError(ValueError):
    """The patch is unsafe, ambiguous, unsupported or does not match the file."""


def apply_unified_patch(original: str, patch: str, relative_path: str) -> str:
    """Apply one existing-file unified diff with exact contexts and line numbers.

    Required format:
      --- a/src/example.py
      +++ b/src/example.py
      @@ -2,2 +2,2 @@
       keep
      -old
      +new

    No file creation/deletion, rename, binary patch or multi-file changes.
    Newlines are preserved (including CRLF and missing terminal newline).
    """
    if not isinstance(original, str) or not isinstance(patch, str):
        raise PatchError("补丁和源文件必须是 UTF-8 文本")
    if not isinstance(relative_path, str) or not relative_path or "\x00" in relative_path:
        raise PatchError("补丁路径无效")
    if not patch or len(patch) > MAX_PATCH_CHARS or "\x00" in patch:
        raise PatchError("补丁为空、包含无效字符或超过 64,000 字符")
    if len(original.encode("utf-8")) > MAX_PATCH_FILE_BYTES:
        raise PatchError("补丁仅支持不超过 2 MiB 的文本文件")
    lines = patch.splitlines()
    if len(lines) < 4 or lines[0] != "--- a/" + relative_path or lines[1] != "+++ b/" + relative_path:
        raise PatchError("补丁必须以匹配目标文件的 --- a/路径 和 +++ b/路径 开头")
    non_crlf = original.replace("\r\n", "")
    if "\r" in non_crlf or ("\r\n" in original and "\n" in non_crlf):
        raise PatchError("暂不支持混用 LF/CRLF 或单独 CR 的换行风格")
    crlf = "\r\n" in original
    plain = original.replace("\r\n", "\n")
    old_lines = plain.split("\n")
    if plain.endswith("\n"):
        old_lines.pop()
    if not plain:
        old_lines = []
    output = []
    source_index = 0
    line_index = 2
    hunk_count = 0
    changed_eof = False
    no_newline_output_index = None
    saw_change = False

    while line_index < len(lines):
        header = HUNK_HEADER.fullmatch(lines[line_index])
        if header is None:
            raise PatchError("仅支持一个文件的标准 unified diff；hunk 行号无效或有额外文件")
        hunk_count += 1
        old_start = int(header.group(1))
        old_count = int(header.group(2) or "1")
        new_start = int(header.group(3))
        new_count = int(header.group(4) or "1")
        source_start = old_start - 1 if old_count else old_start
        if source_start < source_index or source_start > len(old_lines):
            raise PatchError("补丁 hunk 重叠或原始行号越界")
        output.extend(old_lines[source_index:source_start])
        if new_start != len(output) + (1 if new_count else 0):
            raise PatchError("补丁新行号与已匹配上下文不一致")
        line_index += 1
        source_index = source_start
        old_seen = 0
        new_seen = 0
        touched_eof = source_start == len(old_lines)
        hunk_changed = False
        while old_seen < old_count or new_seen < new_count:
            if line_index >= len(lines):
                raise PatchError("补丁 hunk 被截断，缺少上下文或修改行")
            text = lines[line_index]
            if not text or text[0] not in " +-":
                raise PatchError("hunk 只能包含以空格、+、- 开头的行")
            op, body = text[0], text[1:]
            if op in " -":
                if old_seen >= old_count or source_index >= len(old_lines):
                    raise PatchError("补丁源行数不匹配")
                if old_lines[source_index] != body:
                    raise PatchError(f"第 {source_index + 1} 行上下文不匹配，拒绝模糊替换")
                old_seen += 1
                source_index += 1
                touched_eof = touched_eof or source_index == len(old_lines)
            if op in " +":
                if new_seen >= new_count:
                    raise PatchError("补丁目标行数不匹配")
                output.append(body)
                new_seen += 1
            if op in "+-":
                hunk_changed = True
                saw_change = True
            line_index += 1
            if line_index < len(lines) and lines[line_index] == NO_NEWLINE:
                # Only an output (+ or context) line can specify its final
                # newline. For '-' this marker describes the old file.
                if op in " +":
                    no_newline_output_index = len(output) - 1
                line_index += 1
        if old_seen != old_count or new_seen != new_count:
            raise PatchError("补丁 hunk 行数不匹配")
        changed_eof = changed_eof or (touched_eof and hunk_changed)

    if not hunk_count or not saw_change:
        raise PatchError("没有有效的修改 hunk")
    output.extend(old_lines[source_index:])
    if not output:
        result = ""
    else:
        final_newline = plain.endswith("\n") or changed_eof
        if no_newline_output_index == len(output) - 1:
            final_newline = False
        result = "\n".join(output) + ("\n" if final_newline else "")
    if crlf:
        result = result.replace("\n", "\r\n")
    if result == original:
        raise PatchError("补丁未产生实际变化")
    if len(result.encode("utf-8")) > MAX_PATCH_FILE_BYTES:
        raise PatchError("修改后的文件超过 2 MiB")
    return result


def unified_preview(
    relative_path: str, before: bytes | None, after: bytes | None,
    max_chars: int = MAX_PREVIEW_CHARS,
) -> str:
    """Bounded, escaped-by-the-caller diff of exact bytes for a human reviewer."""
    if before == after:
        return "（内容未改变）"
    if max(len(before or b""), len(after or b"")) > MAX_PREVIEW_INPUT_BYTES:
        return "（文件超过 128 KiB，diff 预览不可用；请单独检查完整文件后再审批）"
    try:
        old_text = before.decode("utf-8") if before is not None else ""
        new_text = after.decode("utf-8") if after is not None else ""
    except UnicodeDecodeError:
        return "（原文件或目标文件不是 UTF-8 文本，无法展示文本 diff）"
    if "\x00" in old_text or "\x00" in new_text:
        return "（二进制文件变更，无法展示文本 diff）"
    prefix = "\n".join(difflib.unified_diff(
        old_text.splitlines(), new_text.splitlines(),
        fromfile=("a/" + relative_path if before is not None else "/dev/null"),
        tofile=("b/" + relative_path if after is not None else "/dev/null"),
        lineterm="",
    ))
    if not prefix:
        prefix = "（仅换行格式或末尾换行发生变化）"
    if len(prefix) > max_chars:
        return prefix[:max_chars] + "\n...（diff 预览已截断，请自行检查完整文件）"
    return prefix
