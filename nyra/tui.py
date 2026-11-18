"""Terminal UI for the interactive REPL: header, workspace-trust prompt,
framed input line and a status bar with shift+tab mode cycling.

Standard library only. Rendering functions are pure (text in, lines out)
so they can be unit tested; the interactive parts read raw keys through
``termios`` on macOS / Linux and ``msvcrt`` on Windows.

When the terminal cannot do this (stdin or stdout is not a TTY,
TERM=dumb, NYRA_TUI=0, or Windows refuses VT mode) the caller keeps the
previous plain ``input()`` REPL. NO_COLOR only removes colour; the layout
stays.
"""

from __future__ import annotations

import os
import shutil
import sys
import unicodedata

from .console import style

ESC = "\x1b"

# ---------------------------------------------------------------------------
# Text (Chinese first; English when config "language" / NYRA_LANG is "en").

TEXT = {
    "zh": {
        "trust_title": "正在访问工作区：",
        "trust_body": "安全确认：这是你自己创建或信任的项目吗？（比如你自己的代码、知名开源项目或团队的工作）如果不是，请先看看这个文件夹里有什么。",
        "trust_power": "Nyra 可以在这里读取、修改和执行文件。",
        "trust_yes": "是，我信任这个文件夹",
        "trust_no": "否，退出",
        "trust_keys": "Enter 确认 · Esc 取消",
        "trust_plain_ask": "输入 1 信任并继续，输入 2 或直接回车退出：",
        "trust_declined": "未信任此文件夹，Nyra 已退出。",
        "context": "上下文",
        "cycle": "shift+tab 切换",
        "full_warn": "全权模式：写文件与执行命令不再逐项确认",
        "arm_full": "再按 shift+tab 进入 full（全权，不再逐项确认）· 其他键取消",
        "mode_readonly": "只读",
        "mode_auto": "逐项确认",
        "mode_full": "全权",
        "hint": "输入 /help 查看命令 · Ctrl+D 退出",
        "session": "会话",
        "billing_api": "API 计费",
        "billing_local": "本地模型",
        "billing_cli": "CLI 登录",
    },
    "en": {
        "trust_title": "Opening workspace:",
        "trust_body": "Safety check: did you create this project, or do you trust it? (Your own code, a well-known open-source project, your team's work.) If not, look through this folder first.",
        "trust_power": "Nyra can read, change and run files here.",
        "trust_yes": "Yes, I trust this folder",
        "trust_no": "No, exit",
        "trust_keys": "Enter confirm · Esc cancel",
        "trust_plain_ask": "Type 1 to trust and continue, 2 or Enter to exit: ",
        "trust_declined": "Folder not trusted; Nyra exited.",
        "context": "context",
        "cycle": "shift+tab to switch",
        "full_warn": "full access: writes and commands run without asking",
        "arm_full": "press shift+tab again for full (no per-step approval) · any other key cancels",
        "mode_readonly": "read only",
        "mode_auto": "ask each time",
        "mode_full": "full access",
        "hint": "/help for commands · Ctrl+D to quit",
        "session": "session",
        "billing_api": "API billing",
        "billing_local": "local model",
        "billing_cli": "CLI login",
    },
}


def language(config: dict | None = None) -> str:
    value = os.environ.get("NYRA_LANG") or (config or {}).get("language") or "zh"
    return "en" if str(value).lower().startswith("en") else "zh"


def t(key: str, lang: str = "zh") -> str:
    return TEXT.get(lang, TEXT["zh"]).get(key) or TEXT["zh"][key]


# ---------------------------------------------------------------------------
# Width helpers (CJK and full-width characters take two columns).


def char_width(ch: str) -> int:
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in "WF" else 1


def text_width(text: str) -> int:
    return sum(char_width(ch) for ch in text)


def truncate(text: str, width: int, ellipsis: str = "…") -> str:
    """Cut plain text to at most ``width`` columns."""
    if width <= 0:
        return ""
    if text_width(text) <= width:
        return text
    out, used = [], 0
    limit = width - text_width(ellipsis)
    for ch in text:
        w = char_width(ch)
        if used + w > limit:
            break
        out.append(ch)
        used += w
    return "".join(out) + ellipsis


def wrap(text: str, width: int) -> list:
    """Wrap plain text to ``width`` columns, breaking at spaces when it can
    and anywhere inside CJK runs."""
    width = max(1, width)
    lines, line, used = [], "", 0
    for ch in text:
        w = char_width(ch)
        if used + w > width:
            cut = line.rfind(" ")
            if cut > 0 and ch != " " and not any(char_width(c) == 2 for c in line[cut:]):
                lines.append(line[:cut])
                line = line[cut + 1:]
                used = text_width(line)
            else:
                lines.append(line.rstrip())
                line, used = "", 0
            if ch == " " and not line:
                continue
        line += ch
        used += w
    if line or not lines:
        lines.append(line)
    return lines


# ---------------------------------------------------------------------------
# Glyphs. Box / block characters need a UTF-capable stream; otherwise ASCII.

UNICODE_GLYPHS = {"rule": "─", "bar": "│", "chev": "››", "dot": "·", "sel": ">"}
ASCII_GLYPHS = {"rule": "-", "bar": "|", "chev": ">>", "dot": "-", "sel": ">"}

# The Nyra mark (a solid circle with the pointer cut out of it) as 4 rows of
# half-block characters, 12 columns. Single colour.
LOGO = [
    " ▄█▀██████▄ ",
    "███  ▀██████",
    "███  ▄▄█████",
    " ▀█▄█▄▄███▀ ",
]
LOGO_ASCII = [
    " .#'######. ",
    "###  '######",
    "###  ..#####",
    " '#.#..###' ",
]
LOGO_WIDTH = 12


def supports_unicode(stream=None) -> bool:
    stream = sys.stdout if stream is None else stream
    encoding = getattr(stream, "encoding", None) or "ascii"
    try:
        ("".join(LOGO) + "─│››·").encode(encoding)
        return True
    except (LookupError, UnicodeEncodeError):
        return False


# ---------------------------------------------------------------------------
# Rendering (pure).


def provider_summary(provider) -> tuple:
    """(model, billing label key) for the header, without secrets."""
    primary = provider
    chain = getattr(provider, "providers", None)
    if chain:
        primary = chain[0]
    model = str(getattr(provider, "model", "") or "")
    name = str(getattr(primary, "name", "") or "")
    base_url = str(getattr(primary, "base_url", "") or "")
    auth = getattr(primary, "auth", None)
    cfg = getattr(primary, "config", None)
    if auth is None and cfg is not None:
        auth = getattr(cfg, "auth", None)
    if base_url.startswith("cli://"):
        billing = "billing_cli"
    elif auth == "none" or "localhost" in base_url or "127.0.0.1" in base_url:
        billing = "billing_local"
    else:
        billing = "billing_api"
    return model, name, billing


def render_header(
    version: str,
    model: str,
    provider_label: str,
    cwd: str,
    width: int,
    color: bool = False,
    unicode: bool = True,
) -> list:
    """Logo on the left, three lines on the right; text-only below 60 cols."""
    info = [
        (f"Nyra v{version}", "title"),
        (" · ".join(x for x in (model, provider_label) if x), "dim"),
        (cwd, "dim"),
    ]
    show_logo = width >= 60
    gap = 2
    text_room = width - (LOGO_WIDTH + gap if show_logo else 0) - 1
    lines = []
    logo = LOGO if unicode else LOGO_ASCII
    rows = len(logo) if show_logo else len(info)
    for i in range(rows):
        left = ""
        text, kind = info[i] if i < len(info) else ("", "")
        if show_logo:
            art = logo[i] if text else logo[i].rstrip()
            left = style(art, "bold", enabled=color) + (" " * gap if text else "")
        text = truncate(text, text_room)
        if kind == "title":
            name, _, ver = text.partition(" ")
            text = style(name, "bold", enabled=color) + (" " + style(ver, "dim", enabled=color) if ver else "")
        elif kind == "dim":
            text = style(text, "dim", enabled=color)
        lines.append((left + text).rstrip())
    return lines


def render_rule(width: int, color: bool = False, unicode: bool = True) -> str:
    glyph = (UNICODE_GLYPHS if unicode else ASCII_GLYPHS)["rule"]
    return style(glyph * max(1, width), "dim", enabled=color)


def render_trust(
    path: str,
    width: int,
    selected: int = 0,
    color: bool = False,
    unicode: bool = True,
    lang: str = "zh",
) -> list:
    room = max(20, width - 1)
    lines = [render_rule(width - 1 if width > 1 else 1, color, unicode)]
    lines.append(style(t("trust_title", lang), "gold", "bold", enabled=color))
    lines.append("")
    lines += [style(part, "bold", enabled=color) for part in wrap(path, room)]
    lines.append("")
    lines += wrap(t("trust_body", lang), room)
    lines.append("")
    lines += wrap(t("trust_power", lang), room)
    lines.append("")
    for index, key in enumerate(("trust_yes", "trust_no")):
        label = truncate(f"{index + 1}. {t(key, lang)}", room - 2)
        if index == selected:
            lines.append(style("> " + label, "cyan", enabled=color) if color else "> " + label)
        else:
            lines.append("  " + label)
    lines.append("")
    lines.append(style(truncate(t("trust_keys", lang), room), "dim", enabled=color))
    return lines


def context_percent(snapshot: dict | None):
    """Percent of the configured window used by the last request's input,
    or None when either number is unknown (never estimated)."""
    if not snapshot:
        return None
    window = snapshot.get("context_window_tokens")
    used = snapshot.get("last_prompt_tokens")
    if not isinstance(window, int) or window <= 0 or not isinstance(used, int) or used < 0:
        return None
    return min(100, (used * 100 + window // 2) // window)


def render_status(
    model: str,
    project: str,
    mode: str,
    width: int,
    context_pct=None,
    armed_full: bool = False,
    color: bool = False,
    unicode: bool = True,
    lang: str = "zh",
    right: str = "",
) -> list:
    """Status bar under the input box. ``right`` is only filled by callers
    whose kernel really supports the shown state."""
    g = UNICODE_GLYPHS if unicode else ASCII_GLYPHS
    indent = "  "
    room = max(10, width - len(indent) - 1)
    first_plain = f"[{model}] {g['bar']} {project}" if project else f"[{model}]"
    first_plain = truncate(first_plain, room)
    head = truncate(f"[{model}]", room)
    rest = first_plain[len(head):]
    first = style(head, "cyan", enabled=color)
    if rest:
        bar = f" {g['bar']} "
        if rest.startswith(bar):
            first += style(bar, "dim", enabled=color) + style(rest[len(bar):], "gold", enabled=color)
        else:
            first += style(rest, "gold", enabled=color)
    if right:
        right_plain = truncate(right, max(0, room - text_width(first_plain) - 2))
        if right_plain and text_width(first_plain) + 2 + text_width(right_plain) <= room:
            pad = room - text_width(first_plain) - text_width(right_plain)
            first += " " * pad + style(right_plain, "dim", enabled=color)
    lines = [indent + first]
    if context_pct is not None:
        lines.append(indent + style(f"{t('context', lang)} {context_pct}%", "dim", enabled=color))
    if armed_full:
        text = truncate(f"{g['chev']} {t('arm_full', lang)}", room)
        lines.append(indent + style(text, "red", "bold", enabled=color))
    elif mode == "full":
        main = f"{g['chev']} full {t('full_warn', lang)}"
        tail = f"（{t('cycle', lang)}）" if lang == "zh" else f" ({t('cycle', lang)})"
        plain = truncate(main + tail, room)
        lines.append(indent + style(plain, "red", "bold", enabled=color))
    else:
        main = f"{g['chev']} {mode}"
        desc = t(f"mode_{mode}", lang) if mode in ("readonly", "auto") else ""
        tail = (f" {desc}" if desc else "") + (
            f"（{t('cycle', lang)}）" if lang == "zh" else f" ({t('cycle', lang)})"
        )
        plain = truncate(main + tail, room)
        if text_width(main) <= text_width(plain):
            lines.append(indent + style(main, "gold", enabled=color) + style(plain[len(main):], "dim", enabled=color))
        else:
            lines.append(indent + style(plain, "gold", enabled=color))
    return lines


# ---------------------------------------------------------------------------
# Mode cycling. readonly -> auto -> (armed) -> full -> readonly.
# Going to full takes two presses: the first only arms it and shows a red
# warning; any other key disarms.

MODE_ORDER = ("readonly", "auto", "full")


def cycle_mode(mode: str, armed: bool) -> tuple:
    """Return (new_mode, armed) after one shift+tab press."""
    if mode == "readonly":
        return "auto", False
    if mode == "auto":
        return ("full", False) if armed else ("auto", True)
    return "readonly", False


# ---------------------------------------------------------------------------
# Key parsing (pure). Keys are short names; printable text is ("text", s).

_CSI_KEYS = {
    "A": "up", "B": "down", "C": "right", "D": "left",
    "H": "home", "F": "end", "Z": "shift_tab",
}
_TILDE_KEYS = {"1": "home", "7": "home", "4": "end", "8": "end", "3": "delete"}
_CTRL_KEYS = {
    "\x01": "home", "\x05": "end", "\x03": "ctrl_c", "\x04": "ctrl_d",
    "\x15": "ctrl_u", "\x0b": "ctrl_k", "\x0c": "ctrl_l", "\x17": "ctrl_w",
    "\x02": "left", "\x06": "right", "\x10": "up", "\x0e": "down",
    "\r": "enter", "\n": "enter", "\t": "tab", "\x7f": "backspace", "\x08": "backspace",
}


def parse_posix(data: str, final: bool = True) -> tuple:
    """Split terminal input into keys. Returns (keys, leftover).

    ``final`` says no more bytes are coming right now, so a lone ESC is the
    Esc key rather than the start of a sequence.
    """
    keys, i, n = [], 0, len(data)
    text = []

    def flush():
        if text:
            keys.append(("text", "".join(text)))
            text.clear()

    while i < n:
        ch = data[i]
        if ch == ESC:
            if i + 1 >= n:
                if final:
                    flush(); keys.append("esc"); i += 1
                    continue
                break
            nxt = data[i + 1]
            if nxt in "[O":
                j = i + 2
                while j < n and not ("@" <= data[j] <= "~"):
                    j += 1
                if j >= n:
                    if final:
                        flush(); keys.append("esc"); i = n
                        continue
                    break
                params, end = data[i + 2:j], data[j]
                flush()
                if end == "~":
                    keys.append(_TILDE_KEYS.get(params.split(";")[0], "unknown"))
                else:
                    keys.append(_CSI_KEYS.get(end, "unknown"))
                i = j + 1
                continue
            flush()
            keys.append("esc")  # Alt+key: drop the modifier
            i += 1
            continue
        if ch in _CTRL_KEYS:
            flush()
            keys.append(_CTRL_KEYS[ch])
            i += 1
            continue
        if ord(ch) < 32:
            i += 1
            continue
        text.append(ch)
        i += 1
    flush()
    return keys, data[i:]


_WIN_SPECIAL = {
    "H": "up", "P": "down", "K": "left", "M": "right",
    "G": "home", "O": "end", "S": "delete", "\x0f": "shift_tab",
}


def parse_windows(chars: str) -> list:
    """Keys from ``msvcrt.getwch()`` output, where special keys arrive as
    a '\\x00' or '\\xe0' prefix plus a scan code."""
    keys, i, text = [], 0, []

    def flush():
        if text:
            keys.append(("text", "".join(text)))
            text.clear()

    while i < len(chars):
        ch = chars[i]
        if ch in ("\x00", "\xe0") and i + 1 < len(chars):
            flush()
            keys.append(_WIN_SPECIAL.get(chars[i + 1], "unknown"))
            i += 2
            continue
        if ch == ESC:
            flush(); keys.append("esc"); i += 1
            continue
        if ch in _CTRL_KEYS:
            flush(); keys.append(_CTRL_KEYS[ch]); i += 1
            continue
        if ord(ch) >= 32:
            text.append(ch)
        i += 1
    flush()
    return keys


# ---------------------------------------------------------------------------
# Terminal capability and raw key reading.


def _enable_windows_vt(stream) -> bool:
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = wintypes.DWORD()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        if mode.value & 0x0004:
            return True
        return bool(kernel32.SetConsoleMode(handle, mode.value | 0x0004))
    except Exception:
        return False


def tui_available(stdin=None, stdout=None, environ=None) -> bool:
    """True when the framed REPL can run; otherwise keep plain input()."""
    stdin = sys.stdin if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    env = os.environ if environ is None else environ
    if env.get("NYRA_TUI", "").strip().lower() in ("0", "off", "false", "no"):
        return False
    if env.get("TERM") == "dumb":
        return False
    for stream in (stdin, stdout):
        isatty = getattr(stream, "isatty", None)
        try:
            if not (callable(isatty) and isatty()):
                return False
        except (OSError, ValueError):
            return False
    if os.name == "nt":
        return _enable_windows_vt(stdout)
    try:
        import termios  # noqa: F401
    except ImportError:
        return False
    return True


class KeyReader:
    """Context manager that puts the terminal in raw mode and yields keys."""

    def __init__(self, stdin=None):
        self.stdin = sys.stdin if stdin is None else stdin
        self._saved = None
        self._pending = []
        self._buffer = ""

    def __enter__(self):
        if os.name != "nt":
            import termios

            fd = self.stdin.fileno()
            self._fd = fd
            self._saved = termios.tcgetattr(fd)
            mode = termios.tcgetattr(fd)
            mode[0] &= ~(termios.IXON | termios.ICRNL | termios.INLCR)
            mode[3] &= ~(termios.ICANON | termios.ECHO | termios.ISIG | termios.IEXTEN)
            mode[6][termios.VMIN] = 1
            mode[6][termios.VTIME] = 0
            termios.tcsetattr(fd, termios.TCSADRAIN, mode)
            import codecs

            self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        return self

    def __exit__(self, *exc):
        if self._saved is not None:
            import termios

            termios.tcsetattr(self._fd, termios.TCSADRAIN, self._saved)
            self._saved = None
        return False

    def read(self):
        """Block until at least one key is available; return the next key."""
        while not self._pending:
            if os.name == "nt":
                import msvcrt

                chars = msvcrt.getwch()
                if chars in ("\x00", "\xe0"):
                    chars += msvcrt.getwch()
                while msvcrt.kbhit():
                    nxt = msvcrt.getwch()
                    chars += nxt
                    if nxt in ("\x00", "\xe0"):
                        chars += msvcrt.getwch()
                self._pending.extend(parse_windows(chars))
            else:
                import select

                data = os.read(self._fd, 1024)
                if not data:
                    self._pending.append("ctrl_d")
                    break
                self._buffer += self._decoder.decode(data)
                while True:
                    keys, rest = parse_posix(self._buffer, final=False)
                    self._pending.extend(keys)
                    self._buffer = rest
                    if not rest:
                        break
                    ready, _, _ = select.select([self._fd], [], [], 0.05)
                    if ready:
                        more = os.read(self._fd, 1024)
                        if more:
                            self._buffer += self._decoder.decode(more)
                            continue
                    keys, rest = parse_posix(self._buffer, final=True)
                    self._pending.extend(keys)
                    self._buffer = rest
                    break
        return self._pending.pop(0)


def terminal_width(stream=None) -> int:
    try:
        return max(20, shutil.get_terminal_size((80, 24)).columns)
    except (OSError, ValueError):
        return 80


# ---------------------------------------------------------------------------
# Interactive widgets.


def _write(stream, text: str) -> None:
    stream.write(text)
    stream.flush()


def trust_prompt(path: str, color: bool, lang: str = "zh", stdin=None, stdout=None) -> bool:
    """Ask whether to trust ``path``. True only on an explicit yes."""
    stdout = sys.stdout if stdout is None else stdout
    unicode = supports_unicode(stdout)
    selected = 0
    drawn = 0
    try:
        with KeyReader(stdin) as keys:
            while True:
                lines = render_trust(path, terminal_width(stdout), selected, color, unicode, lang)
                prefix = (f"{ESC}[{drawn - 1}A\r" if drawn > 1 else "\r") + f"{ESC}[J" if drawn else ""
                _write(stdout, prefix + "\r\n".join(lines))
                drawn = len(lines)
                key = keys.read()
                if key in ("up", "left", "shift_tab"):
                    selected = 0
                elif key in ("down", "right", "tab"):
                    selected = 1
                elif key == ("text", "1"):
                    selected = 0
                    break
                elif key == ("text", "2"):
                    selected = 1
                    break
                elif key == "enter":
                    break
                elif key in ("esc", "ctrl_c", "ctrl_d"):
                    selected = 1
                    break
    except KeyboardInterrupt:
        selected = 1
    # Clear the question once answered so the session starts clean.
    _write(stdout, (f"{ESC}[{drawn - 1}A" if drawn > 1 else "") + f"\r{ESC}[J")
    return selected == 0


def trust_prompt_plain(path: str, lang: str = "zh") -> bool:
    """Line-based fallback for terminals without raw key support."""
    print(t("trust_title", lang))
    print(path)
    print(t("trust_body", lang))
    print(t("trust_power", lang))
    print(f"  1. {t('trust_yes', lang)}")
    print(f"  2. {t('trust_no', lang)}")
    try:
        answer = input(t("trust_plain_ask", lang))
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    return answer.strip() == "1"


class Prompt:
    """Framed single-line editor with a status bar underneath.

    ``status`` is a callable returning the current status lines (it is
    re-read on every redraw); ``on_shift_tab`` is called on shift+tab.
    """

    def __init__(self, stdout=None, stdin=None, color=False, lang="zh"):
        self.stdout = sys.stdout if stdout is None else stdout
        self.stdin = stdin
        self.color = color
        self.lang = lang
        self.unicode = supports_unicode(self.stdout)
        self.history = []

    def _input_view(self, buf: list, cursor: int, room: int) -> tuple:
        """Visible slice of the buffer and the cursor column within it."""
        widths = [char_width(c) for c in buf]
        start = 0
        while sum(widths[start:cursor]) > room - 1:
            start += 1
        end, used = start, 0
        while end < len(buf) and used + widths[end] <= room - 1:
            used += widths[end]
            end += 1
        return "".join(buf[start:end]), sum(widths[start:cursor])

    def read(self, status, on_shift_tab=None):
        """Return ("submit", text), ("eof", None) or ("interrupt", None)."""
        buf, cursor = [], 0
        hist_index = len(self.history)
        drawn_above = 0  # rows between the cursor row and the block's top
        out = self.stdout

        def draw():
            nonlocal drawn_above
            width = terminal_width(out)
            rule = render_rule(width - 1, self.color, self.unicode)
            visible, col = self._input_view(buf, cursor, width - 3)
            lines = [rule, style(">", "bold", enabled=self.color) + " " + visible, rule]
            lines += status()
            top = f"{ESC}[{drawn_above}A" if drawn_above else ""
            _write(out, top + "\r" + f"{ESC}[J" + "\r\n".join(lines))
            up = len(lines) - 2
            _write(out, (f"{ESC}[{up}A" if up else "") + "\r" + (f"{ESC}[{col + 2}C" if col + 2 else ""))
            drawn_above = 1

        def finish(echo: str | None):
            # Clear the block and leave a plain transcript line behind.
            _write(out, f"{ESC}[{drawn_above}A\r{ESC}[J" if drawn_above else f"\r{ESC}[J")
            if echo is not None:
                _write(out, style("> ", "dim", enabled=self.color) + echo + "\r\n")

        try:
            with KeyReader(self.stdin) as keys:
                draw()
                while True:
                    key = keys.read()
                    if isinstance(key, tuple):
                        chars = list(key[1].replace("\r", " ").replace("\n", " "))
                        buf[cursor:cursor] = chars
                        cursor += len(chars)
                    elif key == "enter":
                        text = "".join(buf)
                        finish(text)
                        if text.strip():
                            self.history.append(text)
                        return "submit", text
                    elif key == "backspace":
                        if cursor:
                            cursor -= 1
                            del buf[cursor]
                    elif key == "delete":
                        if cursor < len(buf):
                            del buf[cursor]
                    elif key == "left":
                        cursor = max(0, cursor - 1)
                    elif key == "right":
                        cursor = min(len(buf), cursor + 1)
                    elif key == "home":
                        cursor = 0
                    elif key == "end":
                        cursor = len(buf)
                    elif key == "ctrl_u":
                        del buf[:cursor]
                        cursor = 0
                    elif key == "ctrl_k":
                        del buf[cursor:]
                    elif key == "ctrl_w":
                        j = cursor
                        while j and buf[j - 1] == " ":
                            j -= 1
                        while j and buf[j - 1] != " ":
                            j -= 1
                        del buf[j:cursor]
                        cursor = j
                    elif key == "up" and self.history:
                        hist_index = max(0, hist_index - 1)
                        buf = list(self.history[hist_index]); cursor = len(buf)
                    elif key == "down" and self.history:
                        hist_index = min(len(self.history), hist_index + 1)
                        buf = list(self.history[hist_index]) if hist_index < len(self.history) else []
                        cursor = len(buf)
                    elif key == "shift_tab":
                        if on_shift_tab is not None:
                            on_shift_tab()
                    elif key == "ctrl_c":
                        if buf:
                            buf, cursor = [], 0
                        else:
                            finish(None)
                            return "interrupt", None
                    elif key == "ctrl_d":
                        if not buf:
                            finish(None)
                            return "eof", None
                        if cursor < len(buf):
                            del buf[cursor]
                    elif key == "ctrl_l":
                        _write(out, f"{ESC}[2J{ESC}[H")
                        drawn_above = 0
                    if key != "shift_tab" and on_shift_tab is not None:
                        disarm = getattr(on_shift_tab, "disarm", None)
                        if callable(disarm):
                            disarm()
                    draw()
        except KeyboardInterrupt:
            finish(None)
            return "interrupt", None
