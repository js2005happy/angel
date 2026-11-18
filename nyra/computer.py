"""Desktop control for Nyra (computer use).

让 Agent 操作电脑桌面：鼠标、键盘、截屏、窗口。只用标准库。

后端按操作系统自动选：
- Linux/X11：xdotool（鼠标/键盘/窗口）+ ImageMagick、scrot
  或 gnome-screenshot（截屏）。
- Windows：ctypes 直调 user32.dll / gdi32.dll（无第三方库）。
- macOS：osascript（System Events / CoreGraphics）+ screencapture。

诚实边界（每个后端都一样）：
- 本模块不知道屏幕上有什么：截屏只是字节，坐标必须来自用户、
  computer_windows 的窗口几何，或者配置了视觉模型的 Agent 看了
  截屏后报的坐标。没有视觉模型时，Agent 不能靠“看”定位元素。
  视觉模型的接线见 nyra/vision.py。
- 永远不自动启动 X 服务器、不装任何软件、不联网。
- 所有动作失败时都抛 ComputerError，带一句能照着修的说明，
  绝不静默失败、绝不挂住。
"""

import ctypes
import os
import platform
import shutil
import struct
import subprocess
import tempfile
import time
import zlib
from pathlib import Path

# NOTE：本文件刻意不用反斜杠转义写字符串字面量（历史教训：写文件
# 工具层曾把反斜杠翻倍）。换行用 chr(10)，反斜杠用 chr(92)，
# PNG 魔数用整数元组拼。
_NL = chr(10)
_BS = chr(92)
_DQ = chr(34)

_MAX_COORD = 100000
_PNG_MAGIC = bytes((0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))


class ComputerError(Exception):
    """Raised when the desktop is unavailable or a desktop action fails."""


# ---- key names ----

_MODIFIERS = frozenset({"ctrl", "alt", "shift", "win"})

_KEY_ALIASES = {
    "return": "enter",
    "escape": "esc",
    "del": "delete",
    "backspace": "backspace",
    "pgup": "page_up",
    "pgdn": "page_down",
    "pageup": "page_up",
    "pagedown": "page_down",
    "control": "ctrl",
    "option": "alt",
    "super": "win",
    "cmd": "win",
    "command": "win",
    "meta": "win",
}

_SINGLE_KEYS = frozenset({
    "enter", "tab", "esc", "space", "backspace", "delete", "insert",
    "home", "end", "page_up", "page_down", "up", "down", "left", "right",
    "caps_lock", "num_lock", "print_screen",
    "f1", "f2", "f3", "f4", "f5", "f6",
    "f7", "f8", "f9", "f10", "f11", "f12",
})


def _is_single_key(name: str) -> bool:
    if name in _SINGLE_KEYS:
        return True
    return len(name) == 1 and name.isalnum()


def normalize_key(key: str) -> tuple[tuple[str, ...], str]:
    """Normalize a key name like 'ctrl+c' -> (('ctrl',), 'c').

    Accepts aliases (return/escape/del/pgup/control/option/super/cmd)
    and f1-f12, single letters/digits, and '+'-joined combos.
    Raises ComputerError for empty, malformed, repeated-modifier,
    multi-main-key, or unknown names.
    """
    if not isinstance(key, str) or not key.strip():
        raise ComputerError("按键名不能为空")
    parts = [part.strip().lower() for part in key.split("+")]
    if any(not part for part in parts):
        raise ComputerError(
            "按键名格式不对：" + repr(key) + "（用 + 连接，如 ctrl+c）"
        )
    mods: list[str] = []
    base: str | None = None
    for part in parts:
        name = _KEY_ALIASES.get(part, part)
        if name in _MODIFIERS:
            if name in mods:
                raise ComputerError("重复的修饰键：" + repr(key))
            mods.append(name)
        elif base is not None:
            raise ComputerError("一次只能按一个主键：" + repr(key))
        elif _is_single_key(name):
            base = name
        else:
            raise ComputerError(
                "不认识的按键：" + repr(part)
                + "（支持 enter/tab/esc/space/方向键/f1-f12/字母/数字/"
                + "ctrl+c 这类组合）"
            )
    if base is None:
        raise ComputerError(
            "按键名里没有主键：" + repr(key) + "（如 ctrl+c 中的 c）"
        )
    return tuple(mods), base


def _validate_coord(value: object, name: str) -> int:
    if isinstance(value, bool):
        raise ComputerError(name + " 必须是整数")
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if not isinstance(value, int):
        raise ComputerError(name + " 必须是整数，收到 " + repr(value))
    if value < 0 or value > _MAX_COORD:
        raise ComputerError(
            name + " 超出合理范围：" + str(value)
            + "（应为 0-" + str(_MAX_COORD) + " 的整数）"
        )
    return value


def _validate_button(button: str) -> str:
    if button not in ("left", "middle", "right"):
        raise ComputerError(
            "鼠标键必须是 left/middle/right，收到 " + repr(button)
        )
    return button


# ---- minimal PNG encoder (stdlib only) ----

def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def _encode_png(width: int, height: int, rgb_rows: list[bytes]) -> bytes:
    """Encode raw RGB rows as a PNG (filter 0 on every scanline)."""
    if len(rgb_rows) != height:
        raise ComputerError("PNG 行数与高度不一致")
    body = b"".join(bytes([0]) + row for row in rgb_rows)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        _PNG_MAGIC
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(body))
        + _png_chunk(b"IEND", b"")
    )


def _check_png(data: bytes, source: str) -> bytes:
    if not data.startswith(_PNG_MAGIC):
        raise ComputerError(source + " 没有返回有效的 PNG 数据")
    return data


# ---- xdotool key names (Linux/X11) ----

_XDOTOOL_KEYS = {
    "enter": "Return",
    "esc": "Escape",
    "space": "space",
    "backspace": "BackSpace",
    "delete": "Delete",
    "insert": "Insert",
    "home": "Home",
    "end": "End",
    "page_up": "Prior",
    "page_down": "Next",
    "up": "Up",
    "down": "Down",
    "left": "Left",
    "right": "Right",
    "tab": "Tab",
    "caps_lock": "Caps_Lock",
    "num_lock": "Num_Lock",
    "print_screen": "Print",
    "ctrl": "ctrl",
    "alt": "alt",
    "shift": "shift",
    "win": "Super_L",
}

_XDOTOOL_BUTTONS = {"left": "1", "middle": "2", "right": "3"}


class ComputerControl:
    """One desktop session. Backend is picked by OS unless given.

    ``backend`` is one of "x11", "windows", "macos". ``_user32`` and
    ``_gdi32`` accept injected fakes for tests; on real Windows they
    resolve lazily from ``ctypes.windll``. There is no persistent
    connection to close: every action is a fresh subprocess call or a
    direct system call, so no disconnect step is needed.
    """

    def __init__(self, backend: str | None = None,
                 _user32=None, _gdi32=None):
        system = platform.system()
        if backend is None:
            if system == "Linux":
                backend = "x11"
            elif system == "Windows":
                backend = "windows"
            elif system == "Darwin":
                backend = "macos"
            else:
                raise ComputerError(
                    "不支持的操作系统：" + system
                    + "（只支持 Linux/X11、Windows、macOS）"
                )
        if backend not in ("x11", "windows", "macos"):
            raise ComputerError("不认识的后端：" + repr(backend))
        self.backend = backend
        self._user32 = _user32
        self._gdi32 = _gdi32

    # ---- public API (backend dispatch) ----

    def screenshot(self) -> bytes:
        """Capture the whole screen as PNG bytes."""
        if self.backend == "x11":
            return self._x11_screenshot()
        if self.backend == "windows":
            return self._windows_screenshot()
        return self._macos_screenshot()

    def screen_size(self) -> tuple[int, int]:
        """Return (width, height) of the primary screen in pixels."""
        if self.backend == "x11":
            return self._x11_screen_size()
        if self.backend == "windows":
            return self._windows_screen_size()
        return self._macos_screen_size()

    def move(self, x: int, y: int) -> None:
        """Move the mouse pointer to (x, y)."""
        x = _validate_coord(x, "x")
        y = _validate_coord(y, "y")
        if self.backend == "x11":
            self._x11_run(["xdotool", "mousemove", str(x), str(y)])
        elif self.backend == "windows":
            self._windows_move(x, y)
        else:
            self._macos_move(x, y)

    def click(self, x: int, y: int, button: str = "left") -> None:
        """Move to (x, y) and click the given button."""
        x = _validate_coord(x, "x")
        y = _validate_coord(y, "y")
        button = _validate_button(button)
        if self.backend == "x11":
            self._x11_run([
                "xdotool", "mousemove", str(x), str(y),
                "click", _XDOTOOL_BUTTONS[button],
            ])
        elif self.backend == "windows":
            self._windows_click(x, y, button)
        else:
            self._macos_click(x, y, button)

    def type_text(self, text: str) -> None:
        """Type text as if on the keyboard. Empty text is a no-op."""
        if not isinstance(text, str):
            raise ComputerError("要输入的文本必须是字符串")
        if text == "":
            return
        if self.backend == "x11":
            self._x11_run(["xdotool", "type", "--clearmodifiers", "--", text])
        elif self.backend == "windows":
            self._windows_type_text(text)
        else:
            self._macos_type_text(text)

    def press(self, key: str) -> None:
        """Press one key or a '+'-joined combo like 'ctrl+c'."""
        mods, base = normalize_key(key)
        if self.backend == "x11":
            combo = "+".join(
                [_XDOTOOL_KEYS.get(m, m) for m in mods]
                + [_XDOTOOL_KEYS.get(base, base)]
            )
            self._x11_run(["xdotool", "key", combo])
        elif self.backend == "windows":
            self._windows_press(mods, base)
        else:
            self._macos_press(mods, base)

    def windows(self) -> list[dict]:
        """List visible windows as {id, title, x, y, width, height}.

        Fields a backend cannot provide are omitted, never invented.
        """
        if self.backend == "x11":
            return self._x11_windows()
        if self.backend == "windows":
            return self._windows_windows()
        return self._macos_windows()

    # ---- Linux/X11 backend ----

    def _require_display(self) -> None:
        if not os.environ.get("DISPLAY"):
            raise ComputerError(
                "没有桌面会话（DISPLAY 未设置）。请先在图形桌面里运行，"
                "或用 Xvfb 起一个虚拟桌面再设 DISPLAY。"
            )

    def _require_xdotool(self) -> str:
        path = shutil.which("xdotool")
        if path is None:
            raise ComputerError(
                "找不到 xdotool（Linux 桌面控制靠它）。请先安装："
                "Debian/Ubuntu 用 sudo apt-get install xdotool，"
                "Fedora 用 sudo dnf install xdotool。"
            )
        return path

    def _x11_run(self, argv: list[str], *, timeout: float = 10.0) -> bytes:
        self._require_display()
        self._require_xdotool()
        try:
            proc = subprocess.run(
                argv, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            raise ComputerError(
                "桌面命令超时：" + " ".join(argv)
            ) from None
        except OSError as exc:
            raise ComputerError("运行桌面命令失败：" + str(exc)) from exc
        if proc.returncode != 0:
            detail = proc.stderr.decode("utf-8", "replace").strip()
            message = (
                "桌面命令失败（退出码 " + str(proc.returncode) + "）："
                + " ".join(argv)
            )
            if detail:
                message += "：" + detail
            raise ComputerError(message)
        return proc.stdout

    def _x11_screen_size(self) -> tuple[int, int]:
        out = self._x11_run(["xdotool", "getdisplaygeometry"])
        parts = out.decode("utf-8", "replace").split()
        if len(parts) != 2:
            raise ComputerError(
                "读屏幕尺寸失败，xdotool 输出无法解析：" + repr(out[:100])
            )
        try:
            return int(parts[0]), int(parts[1])
        except ValueError:
            raise ComputerError(
                "读屏幕尺寸失败，xdotool 输出无法解析：" + repr(out[:100])
            ) from None

    def _x11_windows(self) -> list[dict]:
        out = self._x11_run(["xdotool", "search", "--onlyvisible", "--name", "."])
        found: list[dict] = []
        for line in out.decode("utf-8", "replace").split(_NL):
            wid = line.strip()
            if not wid:
                continue
            try:
                title = self._x11_run(
                    ["xdotool", "getwindowname", wid]
                ).decode("utf-8", "replace").strip()
                geom = self._x11_run(
                    ["xdotool", "getwindowgeometry", "--shell", wid]
                ).decode("utf-8", "replace")
            except ComputerError:
                continue
            fields: dict[str, int] = {}
            for gline in geom.split(_NL):
                if "=" not in gline:
                    continue
                name, value = gline.split("=", 1)
                try:
                    fields[name.strip()] = int(value.strip())
                except ValueError:
                    continue
            item: dict = {"id": wid, "title": title}
            if "X" in fields:
                item["x"] = fields["X"]
            if "Y" in fields:
                item["y"] = fields["Y"]
            if "WIDTH" in fields:
                item["width"] = fields["WIDTH"]
            if "HEIGHT" in fields:
                item["height"] = fields["HEIGHT"]
            found.append(item)
        return found

    def _x11_screenshot(self) -> bytes:
        self._require_display()
        tried: list[str] = []
        attempts = (
            ("import", ["import", "-window", "root", "png:-"]),
            ("scrot", ["scrot", "-o", "-"]),
            ("gnome-screenshot", ["gnome-screenshot", "-f", "-"]),
        )
        for tool, argv in attempts:
            if shutil.which(tool) is None:
                tried.append(tool + "（未安装）")
                continue
            try:
                proc = subprocess.run(
                    argv, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, timeout=15.0,
                )
            except (subprocess.TimeoutExpired, OSError):
                tried.append(tool + "（运行失败）")
                continue
            if proc.returncode == 0 and proc.stdout.startswith(_PNG_MAGIC):
                return proc.stdout
            tried.append(tool + "（未返回有效 PNG）")
        raise ComputerError(
            "截屏需要 ImageMagick（import）、scrot 或 gnome-screenshot，"
            "三个都不可用：" + "；".join(tried)
            + "。请先装其中一个再试。"
        )

    # ---- Windows backend ----

    def _win32(self):
        """Return (user32, gdi32), resolving real windll on first use.

        Injected fakes (tests) are returned as-is, without prototypes.
        """
        if self._user32 is not None and self._gdi32 is not None:
            return self._user32, self._gdi32
        try:
            windll = ctypes.windll
        except AttributeError:
            raise ComputerError(
                "Windows 桌面控制只能在 Windows 上运行"
            ) from None
        user32 = windll.user32
        gdi32 = windll.gdi32
        user32.GetDC.restype = ctypes.c_void_p
        user32.GetDC.argtypes = [ctypes.c_void_p]
        user32.ReleaseDC.restype = ctypes.c_int
        user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        user32.GetSystemMetrics.restype = ctypes.c_int
        user32.GetSystemMetrics.argtypes = [ctypes.c_int]
        user32.SetCursorPos.restype = ctypes.c_bool
        user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
        user32.mouse_event.restype = None
        user32.mouse_event.argtypes = [
            ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
            ctypes.c_ulong, ctypes.c_void_p,
        ]
        user32.keybd_event.restype = None
        user32.keybd_event.argtypes = [
            ctypes.c_ubyte, ctypes.c_ubyte,
            ctypes.c_ulong, ctypes.c_void_p,
        ]
        user32.SendInput.restype = ctypes.c_uint
        user32.SendInput.argtypes = [
            ctypes.c_uint, ctypes.POINTER(INPUT), ctypes.c_int,
        ]
        user32.EnumWindows.restype = ctypes.c_bool
        user32.EnumWindows.argtypes = [_ENUMPROC, ctypes.c_void_p]
        user32.IsWindowVisible.restype = ctypes.c_bool
        user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
        user32.GetWindowTextLengthW.restype = ctypes.c_int
        user32.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
        user32.GetWindowTextW.restype = ctypes.c_int
        user32.GetWindowTextW.argtypes = [
            ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int,
        ]
        user32.GetWindowRect.restype = ctypes.c_bool
        user32.GetWindowRect.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(_Rect),
        ]
        gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
        gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
        gdi32.CreateCompatibleBitmap.restype = ctypes.c_void_p
        gdi32.CreateCompatibleBitmap.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
        ]
        gdi32.SelectObject.restype = ctypes.c_void_p
        gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        gdi32.BitBlt.restype = ctypes.c_bool
        gdi32.BitBlt.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
            ctypes.c_int, ctypes.c_int, ctypes.c_void_p,
            ctypes.c_int, ctypes.c_int, ctypes.c_ulong,
        ]
        gdi32.GetDIBits.restype = ctypes.c_int
        gdi32.GetDIBits.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint,
            ctypes.c_uint, ctypes.c_void_p,
            ctypes.POINTER(_BitmapInfo), ctypes.c_uint,
        ]
        gdi32.DeleteObject.restype = ctypes.c_bool
        gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
        gdi32.DeleteDC.restype = ctypes.c_bool
        gdi32.DeleteDC.argtypes = [ctypes.c_void_p]
        if self._user32 is None:
            self._user32 = user32
        if self._gdi32 is None:
            self._gdi32 = gdi32
        return self._user32, self._gdi32

    def _windows_screen_size(self) -> tuple[int, int]:
        user32, _gdi32 = self._win32()
        return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)

    def _windows_move(self, x: int, y: int) -> None:
        user32, _gdi32 = self._win32()
        if not user32.SetCursorPos(x, y):
            raise ComputerError("Windows 移动鼠标失败")

    def _windows_click(self, x: int, y: int, button: str) -> None:
        user32, _gdi32 = self._win32()
        self._windows_move(x, y)
        down, up = _MOUSE_EVENTS[button]
        user32.mouse_event(down, 0, 0, 0, 0)
        time.sleep(0.05)
        user32.mouse_event(up, 0, 0, 0, 0)

    def _windows_press(self, mods: tuple[str, ...], base: str) -> None:
        user32, _gdi32 = self._win32()
        vk = _win_vk(base)
        mod_vks = [_win_vk(m) for m in mods]
        for code in mod_vks:
            user32.keybd_event(code, 0, 0, 0)
        user32.keybd_event(vk, 0, 0, 0)
        user32.keybd_event(vk, 0, _KEYEVENTF_KEYUP, 0)
        for code in reversed(mod_vks):
            user32.keybd_event(code, 0, _KEYEVENTF_KEYUP, 0)

    def _windows_type_text(self, text: str) -> None:
        user32, _gdi32 = self._win32()
        units = text.encode("utf-16-le", "surrogatepass")
        events = []
        for i in range(0, len(units), 2):
            code = units[i] | (units[i + 1] << 8)
            events.append(
                _win_keyboard_event(code, _KEYEVENTF_UNICODE)
            )
            events.append(
                _win_keyboard_event(
                    code, _KEYEVENTF_UNICODE | _KEYEVENTF_KEYUP
                )
            )
        arr = (INPUT * len(events))(*events)
        sent = user32.SendInput(len(events), arr, ctypes.sizeof(INPUT))
        if sent != len(events):
            raise ComputerError(
                "Windows 输入失败：只发出了 " + str(sent) + "/"
                + str(len(events)) + " 个按键事件"
            )

    def _windows_capture_bgra(self) -> tuple[int, int, bytes]:
        """BitBlt the screen into a BGRA byte string (top-down rows)."""
        user32, gdi32 = self._win32()
        width, height = self._windows_screen_size()
        hdc = user32.GetDC(None)
        if not hdc:
            raise ComputerError("Windows 截屏失败：拿不到屏幕设备上下文")
        mem_dc = None
        bitmap = None
        old = None
        try:
            mem_dc = gdi32.CreateCompatibleDC(hdc)
            if not mem_dc:
                raise ComputerError("Windows 截屏失败：建不兼容 DC")
            bitmap = gdi32.CreateCompatibleBitmap(hdc, width, height)
            if not bitmap:
                raise ComputerError("Windows 截屏失败：建位图失败")
            old = gdi32.SelectObject(mem_dc, bitmap)
            if not gdi32.BitBlt(
                mem_dc, 0, 0, width, height, hdc, 0, 0, _SRCCOPY
            ):
                raise ComputerError("Windows 截屏失败：BitBlt 失败")
            info = _BitmapInfo()
            info.bmiHeader.biSize = ctypes.sizeof(_BitmapInfoHeader)
            info.bmiHeader.biWidth = width
            info.bmiHeader.biHeight = -height
            info.bmiHeader.biPlanes = 1
            info.bmiHeader.biBitCount = 32
            info.bmiHeader.biCompression = 0
            size = width * height * 4
            buf = (ctypes.c_ubyte * size)()
            lines = gdi32.GetDIBits(
                mem_dc, bitmap, 0, height, buf, ctypes.byref(info), 0
            )
            if lines != height:
                raise ComputerError(
                    "Windows 截屏失败：GetDIBits 只读到 "
                    + str(lines) + " 行"
                )
            return width, height, bytes(buf)
        finally:
            if old is not None:
                try:
                    gdi32.SelectObject(mem_dc, old)
                except Exception:
                    pass
            if bitmap is not None:
                try:
                    gdi32.DeleteObject(bitmap)
                except Exception:
                    pass
            if mem_dc is not None:
                try:
                    gdi32.DeleteDC(mem_dc)
                except Exception:
                    pass
            try:
                user32.ReleaseDC(None, hdc)
            except Exception:
                pass

    def _windows_screenshot(self) -> bytes:
        width, height, bgra = self._windows_capture_bgra()
        rows: list[bytes] = []
        for y in range(height):
            row = bgra[y * width * 4:(y + 1) * width * 4]
            rgb = bytearray(3 * width)
            rgb[0::3] = row[2::4]
            rgb[1::3] = row[1::4]
            rgb[2::3] = row[0::4]
            rows.append(bytes(rgb))
        return _encode_png(width, height, rows)

    def _windows_windows(self) -> list[dict]:
        user32, _gdi32 = self._win32()
        found: list[dict] = []

        def callback(hwnd, _lparam):
            try:
                if not user32.IsWindowVisible(hwnd):
                    return True
                length = user32.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                rect = _Rect()
                if not user32.GetWindowRect(hwnd, rect):
                    return True
                found.append({
                    "id": str(hwnd),
                    "title": buf.value or "",
                    "x": rect.left,
                    "y": rect.top,
                    "width": rect.right - rect.left,
                    "height": rect.bottom - rect.top,
                })
            except Exception:
                pass
            return True

        proc = _ENUMPROC(callback)
        if not user32.EnumWindows(proc, None):
            raise ComputerError("Windows 列窗口失败")
        return found

    # ---- macOS backend ----

    def _macos_run(self, lines: list[str], *, timeout: float = 10.0) -> str:
        argv: list[str] = ["osascript"]
        for line in lines:
            argv.extend(["-e", line])
        try:
            proc = subprocess.run(
                argv, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            raise ComputerError("macOS 桌面命令超时：osascript") from None
        except OSError as exc:
            raise ComputerError("运行 osascript 失败：" + str(exc)) from exc
        if proc.returncode != 0:
            detail = proc.stderr.decode("utf-8", "replace").strip()
            message = "osascript 失败（退出码 " + str(proc.returncode) + "）"
            if detail:
                message += "：" + detail
            raise ComputerError(message)
        return proc.stdout.decode("utf-8", "replace")

    def _macos_screen_size(self) -> tuple[int, int]:
        out = self._macos_run([
            'tell application "Finder" to get bounds of window of desktop',
        ])
        nums = _parse_braced_numbers(out)
        if len(nums) != 4:
            raise ComputerError(
                "读屏幕尺寸失败，Finder 返回无法解析：" + repr(out[:100])
            )
        return nums[2] - nums[0], nums[3] - nums[1]

    def _macos_move(self, x: int, y: int) -> None:
        point = "{" + str(x) + ", " + str(y) + "}"
        self._macos_run([
            'use framework "CoreGraphics"',
            "set mouseEvent to current application's "
            + "CGEventCreateMouseEvent(missing value, 1, "
            + point + ", 0)",
            "current application's CGEventPost(0, mouseEvent)",
        ])

    def _macos_click(self, x: int, y: int, button: str) -> None:
        down, up, btn = {
            "left": (2, 3, 0), "middle": (6, 7, 2), "right": (4, 5, 1),
        }[button]
        point = "{" + str(x) + ", " + str(y) + "}"
        self._macos_run([
            'use framework "CoreGraphics"',
            "set downEvent to current application's "
            + "CGEventCreateMouseEvent(missing value, " + str(down)
            + ", " + point + ", " + str(btn) + ")",
            "set upEvent to current application's "
            + "CGEventCreateMouseEvent(missing value, " + str(up)
            + ", " + point + ", " + str(btn) + ")",
            "current application's CGEventPost(0, downEvent)",
            "current application's CGEventPost(0, upEvent)",
        ])

    def _macos_type_text(self, text: str) -> None:
        self._macos_run([
            'tell application "System Events" to keystroke '
            + _applescript_quote(text),
        ])

    def _macos_press(self, mods: tuple[str, ...], base: str) -> None:
        code = _MAC_KEY_CODES.get(base)
        if code is None:
            raise ComputerError("macOS 不支持这个按键：" + repr(base))
        using = ""
        if mods:
            names = [_MAC_MODIFIERS[m] for m in mods]
            using = " using {" + ", ".join(n + " down" for n in names) + "}"
        self._macos_run([
            'tell application "System Events" to key code '
            + str(code) + using,
        ])

    def _macos_windows(self) -> list[dict]:
        out = self._macos_run([
            'tell application "System Events"',
            'set out to ""',
            "repeat with p in (every process whose visible is true)",
            "repeat with w in (every window of p)",
            "set out to out & (name of w) & \"|\" & (position of w as string)"
            + " & \"|\" & (size of w as string) & \"|\" & (id of w as string) & return",
            "end repeat",
            "end repeat",
            "return out",
            "end tell",
        ])
        found: list[dict] = []
        for line in out.split(_NL):
            if not line.strip():
                continue
            parts = line.rsplit("|", 3)
            if len(parts) != 4:
                continue
            title, pos, size, wid = parts
            xy = _parse_braced_numbers(pos)
            wh = _parse_braced_numbers(size)
            item: dict = {"id": wid.strip(), "title": title}
            if len(xy) == 2:
                item["x"] = xy[0]
                item["y"] = xy[1]
            if len(wh) == 2:
                item["width"] = wh[0]
                item["height"] = wh[1]
            found.append(item)
        return found

    def _macos_screenshot(self) -> bytes:
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        tmp.close()
        path = Path(tmp.name)
        try:
            try:
                proc = subprocess.run(
                    ["screencapture", "-x", "-t", "png", tmp.name],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, timeout=15.0,
                )
            except subprocess.TimeoutExpired:
                raise ComputerError("macOS 截屏超时") from None
            except OSError as exc:
                raise ComputerError(
                    "运行 screencapture 失败：" + str(exc)
                ) from exc
            if proc.returncode != 0:
                detail = proc.stderr.decode("utf-8", "replace").strip()
                message = "screencapture 失败（退出码 "
                message += str(proc.returncode) + "）"
                if detail:
                    message += "：" + detail
                raise ComputerError(message)
            try:
                data = path.read_bytes()
            except OSError as exc:
                raise ComputerError(
                    "screencapture 没写出截图文件：" + str(exc)
                ) from exc
            return _check_png(data, "screencapture")
        finally:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass


# ---- macOS key codes and AppleScript helpers ----

_MAC_KEY_CODES = {
    "enter": 36, "tab": 48, "esc": 53, "space": 49, "backspace": 51,
    "delete": 117, "insert": 114, "home": 115, "end": 119,
    "page_up": 116, "page_down": 121, "up": 126, "down": 125,
    "left": 123, "right": 124, "caps_lock": 57,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31,
    "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9,
    "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
    "7": 26, "8": 28, "9": 25,
}

_MAC_MODIFIERS = {
    "ctrl": "control", "alt": "option",
    "shift": "shift", "win": "command",
}


def _applescript_quote(text: str) -> str:
    """Wrap text in AppleScript double quotes, escaping as needed."""
    return _DQ + text.replace(_BS, _BS + _BS).replace(_DQ, _BS + _DQ) + _DQ


def _parse_braced_numbers(text: str) -> list[int]:
    """Parse '{100, 200}' -> [100, 200]; anything else -> []."""
    cleaned = text.strip()
    if not cleaned.startswith("{") or not cleaned.endswith("}"):
        return []
    out: list[int] = []
    for part in cleaned[1:-1].split(","):
        try:
            out.append(int(part.strip()))
        except ValueError:
            return []
    return out


# ---- Windows backend (ctypes, user32/gdi32) ----

_WIN_VK = {
    "enter": 0x0D, "tab": 0x09, "esc": 0x1B, "space": 0x20,
    "backspace": 0x08, "delete": 0x2E, "insert": 0x2D,
    "home": 0x24, "end": 0x23, "page_up": 0x21, "page_down": 0x22,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "caps_lock": 0x14, "num_lock": 0x90, "print_screen": 0x2C,
    "ctrl": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B,
}

_MOUSE_EVENTS = {
    "left": (0x0002, 0x0004),
    "middle": (0x0020, 0x0040),
    "right": (0x0008, 0x0010),
}

_KEYEVENTF_KEYUP = 0x0002
_KEYEVENTF_UNICODE = 0x0004
_SRCCOPY = 0x00CC0020


class _KeybdInput(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.c_void_p),
    ]


class _MouseInput(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.c_void_p),
    ]


class _HardwareInput(ctypes.Structure):
    _fields_ = [
        ("uMsg", ctypes.c_ulong),
        ("wParamL", ctypes.c_ushort),
        ("wParamH", ctypes.c_ushort),
    ]


class _InputUnion(ctypes.Union):
    _fields_ = [
        ("mi", _MouseInput),
        ("ki", _KeybdInput),
        ("hi", _HardwareInput),
    ]


class INPUT(ctypes.Structure):
    """SendInput event (type 1 = keyboard). Exposed for tests."""

    _fields_ = [("type", ctypes.c_ulong), ("u", _InputUnion)]


class _Rect(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class _BitmapInfoHeader(ctypes.Structure):
    _fields_ = [
        ("biSize", ctypes.c_ulong),
        ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long),
        ("biPlanes", ctypes.c_ushort),
        ("biBitCount", ctypes.c_ushort),
        ("biCompression", ctypes.c_ulong),
        ("biSizeImage", ctypes.c_ulong),
        ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", ctypes.c_ulong),
        ("biClrImportant", ctypes.c_ulong),
    ]


class _BitmapInfo(ctypes.Structure):
    _fields_ = [
        ("bmiHeader", _BitmapInfoHeader),
        ("bmiColors", ctypes.c_ulong * 1),
    ]


try:
    _ENUMPROC = ctypes.WINFUNCTYPE(
        ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p
    )
except AttributeError:  # WINFUNCTYPE is Windows-only; CFUNCTYPE for tests.
    _ENUMPROC = ctypes.CFUNCTYPE(
        ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p
    )


def _win_keyboard_event(scan: int, flags: int) -> INPUT:
    event = INPUT()
    event.type = 1
    event.u.ki.wVk = 0
    event.u.ki.wScan = scan
    event.u.ki.dwFlags = flags
    event.u.ki.time = 0
    event.u.ki.dwExtraInfo = None
    return event


def _win_vk(name: str) -> int:
    if name in _WIN_VK:
        return _WIN_VK[name]
    if name.startswith("f") and name[1:].isdigit():
        num = int(name[1:])
        if 1 <= num <= 12:
            return 0x70 + num - 1
    if len(name) == 1:
        ch = name.upper()
        if "A" <= ch <= "Z":
            return 0x41 + ord(ch) - 0x41
        if "0" <= ch <= "9":
            return 0x30 + ord(ch) - 0x30
    raise ComputerError("Windows 不支持这个按键：" + repr(name))
