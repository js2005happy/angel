"""The REPL start-up banner: a NYRA wordmark drawn in code, plus the model line.

Pure text, standard library only. On a dark terminal the wordmark is gold;
with colour off the output is plain text with no ANSI escapes.
"""

from .console import style

# NYRA wordmark: big bold block letters drawn with code characters, in the
# style of the ALMA wordmark on alma.now — tall, uniform, no gradient, no
# noise. The angel figure was tried three ways (line art, photo density
# rendering per the benchmark video "硅基初醒，代码凝眸", hand-drawn line
# art with halo and wings) and none of them read well, so the user settled
# this: the four letters, drawn in code. Max width 42, 11 rows.
WORDMARK = [
    "###   ###  ###   ###  ######        ###",
    "###   ###  ###   ###  ###  ###     #####",
    "##### ###  ###   ###  ###  ###     ## ##",
    "##### ###   ### ###   ###  ###    ##   ##",
    "### #####    #####    ######      ##   ##",
    "### #####     ###     ### ###    ###   ###",
    "###  ####     ###     ###  ###   #########",
    "###  ####     ###     ###   ###  ###   ###",
    "###   ###     ###     ###   ###  ###   ###",
    "###   ###     ###     ###   ###  ###   ###",
    "###   ###     ###     ###   ###  ###   ###",
]

# Centre the whole art block in a fixed 60-column field (one shared pad)
# on a standard 80-column terminal.
_FIELD_WIDTH = 60


def _centre(lines: list) -> list:
    pad = max(0, (_FIELD_WIDTH - max(len(line) for line in lines)) // 2)
    return [" " * pad + line for line in lines]


def wordmark_lines(color: bool = False) -> list:
    """The wordmark art, gold on a dark terminal, plain text otherwise."""
    lines = _centre(WORDMARK)
    if not color:
        return lines
    styled = []
    for i, line in enumerate(lines):
        if i == 0:
            styled.append(style(line, "gold", "bold", enabled=True))
        else:
            styled.append(style(line, "gold", enabled=True))
    return styled


def render_banner(
    version: str, provider_desc: str, mode: str, session_id: str, color: bool = False
) -> str:
    """Full start-up banner: wordmark, title, and the model in use.

    ``provider_desc`` is printed verbatim on its own line right under the
    wordmark so the current model is unmissable.
    """
    label = lambda text: style(text, "dim", enabled=color)  # noqa: E731
    title = style(f"Nyra {version}", "bold", enabled=color)
    model_label = style("模型：", "gold", "bold", enabled=color)
    model = style(provider_desc, "bold", enabled=color)
    lines = wordmark_lines(color=color)
    lines += [
        f"{title}  {label('全能 AI 助手 · Python 标准库')}",
        f"{model_label}{model}",
        f"{label('模式：')}{mode}",
        f"{label('会话：')}{session_id}",
    ]
    return "\n".join(lines)
