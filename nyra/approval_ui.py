"""Interactive approval selector (stdlib only, no deps).

Replaces the old terminal ``[y/N/a]`` line prompt. The layout follows the
Claude Code selector the user pointed at: numbered options, ``>`` on the
selected row, ``Enter to confirm · Esc to cancel`` footer, default
selection is the first option (yes).

Behaviour:
- On a TTY: arrow-key menu (Up/Down move, Enter confirms, Esc cancels).
  Number keys (1/2/3) and y/n/a jump straight to a choice.
- Otherwise (piped stdin, tests, CI): line input fallback; an empty line
  means yes (the default), EOF or Ctrl-C means no (fail-closed).
- Never raises for bad input: anything unrecognised is "no".
"""

import os
import sys

YES = "yes"
NO = "no"
ALWAYS = "always"

_FOOTER = "Enter to confirm \u00b7 Esc to cancel"


def approval_options(allow_always: bool, always_label: str | None = None):
    """(label, value) rows for the selector. First row is the default."""
    options = [("\u662f\uff0c\u6267\u884c\u4e00\u6b21", YES), ("\u5426", NO)]
    if allow_always:
        label = always_label or "\u59cb\u7ec8\u5141\u8bb8\uff08\u672c\u6b21\u4f1a\u8bdd\uff09"
        options.append((label, ALWAYS))
    return options


def _render(options, selected: int) -> str:
    lines = []
    for index, (label, _value) in enumerate(options):
        marker = "> " if index == selected else "  "
        text = f"{marker}{index + 1}. {label}"
        if index == selected:
            text = f"\x1b[7m{text}\x1b[0m"
        lines.append(text)
    lines.append("")
    lines.append(_FOOTER)
    return "\n".join(lines) + "\n"


def _menu_select(options, read_key, write) -> str:
    """Pure menu loop over key tokens. Returns the chosen value.

    read_key() -> one of "up" | "down" | "enter" | "esc" | "y" | "n" |
    "a" | "1".."9". write(text) receives each full re-render.
    """
    selected = 0
    count = len(options)
    write(_render(options, selected))
    while True:
        key = read_key()
        if key == "up":
            selected = (selected - 1) % count
        elif key == "down":
            selected = (selected + 1) % count
        elif key == "enter":
            return options[selected][1]
        elif key in ("esc", "ctrl-c"):
            return NO
        elif key == "y":
            return YES
        elif key == "n":
            return NO
        elif key == "a":
            for _label, value in options:
                if value == ALWAYS:
                    return ALWAYS
            return NO
        elif key.isdigit():
            index = int(key) - 1
            if 0 <= index < count:
                return options[index][1]
            continue
        else:
            continue
        write(f"\x1b[{count + 2}A\x1b[J" + _render(options, selected))


def _read_key_windows():
    import msvcrt

    first = msvcrt.getch()
    if first in (b"\xe0", b"\x00"):
        second = msvcrt.getch()
        if second == b"H":
            return "up"
        if second == b"P":
            return "down"
        return ""
    if first == b"\r":
        return "enter"
    if first == b"\x03":
        return "ctrl-c"
    if first == b"\x1b":
        return "esc"
    try:
        return first.decode("utf-8", "ignore").lower()
    except Exception:
        return ""


def _read_key_posix():
    import termios
    import tty

    fd = sys.stdin.fileno()
    first = os.read(fd, 1)
    if first == b"\x1b":
        second = os.read(fd, 1)
        if second == b"[":
            third = os.read(fd, 1)
            if third == b"A":
                return "up"
            if third == b"B":
                return "down"
            return ""
        return "esc"
    if first in (b"\r", b"\n"):
        return "enter"
    if first == b"\x03":
        return "ctrl-c"
    try:
        return first.decode("utf-8", "ignore").lower()
    except Exception:
        return ""


def _tty_menu(options) -> str:
    """Arrow-key menu on a real terminal. Raises on setup failure."""
    if os.name == "nt":
        read_key = _read_key_windows

        def write(text: str) -> None:
            sys.stdout.write(text)
            sys.stdout.flush()

        return _menu_select(options, read_key, write)
    import termios
    import tty

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)

        def write(text: str) -> None:
            sys.stdout.write(text)
            sys.stdout.flush()

        return _menu_select(options, _read_key_posix, write)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def _line_fallback(prompt: str, allow_always: bool) -> str:
    """Line input for non-TTY stdin. Empty line = yes (the default)."""
    try:
        answer = input(prompt + " [\u662f/\u5426] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        return NO
    if answer in ("", "y", "yes", "1"):
        return YES
    if allow_always and answer in ("a", "always", "3"):
        return ALWAYS
    if answer == "2":
        return NO
    return NO


def ask_approval(prompt: str, allow_always: bool = False,
                 always_label: str | None = None) -> str:
    """Ask for approval. Returns "yes" | "no" | "always".

    Selector menu on a TTY (default: yes), line input otherwise.
    """
    options = approval_options(allow_always, always_label)
    stdin_tty = False
    stdout_tty = False
    try:
        stdin_tty = sys.stdin.isatty()
    except Exception:
        stdin_tty = False
    try:
        stdout_tty = sys.stdout.isatty()
    except Exception:
        stdout_tty = False
    if stdin_tty and stdout_tty:
        try:
            sys.stdout.write(prompt + "\n")
            sys.stdout.flush()
            return _tty_menu(options)
        except Exception:
            pass
    return _line_fallback(prompt, allow_always)
