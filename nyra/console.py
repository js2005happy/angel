"""Console output helpers for legacy Windows code pages.

Keep the existing stream encoding; escape only characters that cannot be
represented by the active terminal, instead of crashing a CLI or daemon.
"""

import os
import sys


def configure_stream(stream) -> None:
    reconfigure = getattr(stream, "reconfigure", None)
    if not callable(reconfigure):
        return
    try:
        reconfigure(errors="backslashreplace")
    except (OSError, ValueError, TypeError):
        # Embedded streams and test doubles may not support reconfiguration.
        pass


def configure_stdio() -> None:
    configure_stream(sys.stdout)
    configure_stream(sys.stderr)


# ---------------------------------------------------------------------------
# Terminal styling for the interactive REPL.
#
# Colour is used only when the stream is a TTY, NO_COLOR is unset
# (https://no-color.org) and TERM is not "dumb". Everything degrades to
# plain text, so piped output and logs stay clean.

_STYLES = {
    "bold": "1",
    "dim": "2",
    "gold": "33",
    "blue": "34",
    "cyan": "36",
    "green": "32",
    "red": "31",
}


def use_color(stream=None) -> bool:
    stream = sys.stdout if stream is None else stream
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("TERM") == "dumb":
        return False
    isatty = getattr(stream, "isatty", None)
    try:
        return bool(callable(isatty) and isatty())
    except (OSError, ValueError):
        return False


def style(text: str, *names: str, enabled: bool | None = None) -> str:
    """Wrap text in ANSI styles when colour is enabled."""
    if enabled is None:
        enabled = use_color()
    codes = [_STYLES[name] for name in names if name in _STYLES]
    if not enabled or not codes:
        return text
    return f"\033[{';'.join(codes)}m{text}\033[0m"


def one_line(value, limit: int = 80) -> str:
    """Compact any value into a single printable line of at most `limit` chars."""
    if isinstance(value, dict):
        parts = []
        for key, item in value.items():
            if isinstance(item, (dict, list)):
                item = "…"
            parts.append(f"{key}={item}")
        text = " ".join(parts)
    else:
        text = str(value)
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[: max(0, limit - 1)] + "…"
    return text


class ToolPrinter:
    """Print grouped tool-call activity for the REPL (an Agent on_event hook)."""

    def __init__(self, stream=None, color: bool | None = None) -> None:
        self.stream = sys.stdout if stream is None else stream
        self.color = use_color(self.stream) if color is None else color

    def _s(self, text: str, *names: str) -> str:
        return style(text, *names, enabled=self.color)

    def __call__(self, kind: str, data: dict) -> None:
        if kind == "tool_start":
            name = data.get("name", "")
            args = one_line(data.get("arguments", ""), 70)
            line = f"{self._s('┌', 'dim')} {self._s(name, 'cyan', 'bold')} {self._s(args, 'dim')}"
        elif kind == "tool_result":
            result = str(data.get("result", ""))
            failed = result.startswith(("错误：", "执行失败："))
            mark = self._s("✗", "red") if failed else self._s("✓", "green")
            line = f"{self._s('└', 'dim')} {mark} {self._s(one_line(result, 90), 'dim')}"
        elif kind == "tool_stream":
            # Live shell output line, shown as it arrives (Claude-style).
            text = str(data.get("text", "")).rstrip("\n")
            if len(text) > 200:
                text = text[:199] + "…"
            if data.get("stream") == "stderr":
                line = f"{self._s('│', 'dim')} {self._s(text, 'red')}"
            else:
                line = f"{self._s('│', 'dim')} {self._s(text, 'dim')}"
        elif kind == "assistant":
            line = self._s("· " + one_line(data.get("content", ""), 100), "dim")
        else:
            return
        print(line, file=self.stream, flush=True)
