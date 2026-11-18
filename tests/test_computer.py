"""Tests for nyra.computer (desktop control) and the computer_* tools.

Mock-only: no real desktop, no xdotool, no Chrome. subprocess.run is
patched; the Windows ctypes calls run against fake user32/gdi32
objects; the macOS osascript calls are argv-checked, never executed.
"""

import ctypes
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import zlib

from nyra.computer import (
    ComputerControl,
    ComputerError,
    INPUT,
    _check_png,
    _encode_png,
    _validate_coord,
    normalize_key,
)
from nyra.evidence import EvidenceStore
from nyra.tools import (
    MUTATING_TOOLS,
    TOOL_SCHEMAS,
    ToolContext,
    execute_tool,
)

PNG_MAGIC = bytes((0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
PNG = PNG_MAGIC + b"fake-png-body"
NL = chr(10)
BS = chr(92)


class _Proc:
    def __init__(self, returncode=0, stdout=b"", stderr=b""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class _FakeRun:
    """subprocess.run replacement: exact argv -> _Proc, calls recorded."""

    def __init__(self, mapping):
        self.mapping = mapping
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        key = tuple(argv)
        return self.mapping.get(key, _Proc())


class _FakeComputer:
    """Stand-in for ComputerControl, injected into ToolContext."""

    def __init__(self):
        self.calls = []
        self.png = PNG
        self.window_list = []
        self.backend = "x11"

    def screenshot(self):
        self.calls.append(("screenshot",))
        return self.png

    def click(self, x, y, button="left"):
        self.calls.append(("click", x, y, button))

    def move(self, x, y):
        self.calls.append(("move", x, y))

    def type_text(self, text):
        self.calls.append(("type_text", text))

    def press(self, key):
        self.calls.append(("press", key))

    def windows(self):
        self.calls.append(("windows",))
        return self.window_list


class TestKeyNormalization(unittest.TestCase):
    def test_simple_and_combo(self):
        self.assertEqual(normalize_key("enter"), ((), "enter"))
        self.assertEqual(normalize_key("ctrl+c"), (("ctrl",), "c"))
        self.assertEqual(
            normalize_key("ctrl+shift+tab"), (("ctrl", "shift"), "tab")
        )
        self.assertEqual(normalize_key("F1"), ((), "f1"))
        self.assertEqual(normalize_key("a"), ((), "a"))

    def test_aliases_and_case(self):
        self.assertEqual(normalize_key("return"), ((), "enter"))
        self.assertEqual(normalize_key("escape"), ((), "esc"))
        self.assertEqual(normalize_key("del"), ((), "delete"))
        self.assertEqual(normalize_key("CTRL+C"), (("ctrl",), "c"))
        self.assertEqual(normalize_key("control+alt+del"), (("ctrl", "alt"), "delete"))
        self.assertEqual(normalize_key("pgup"), ((), "page_up"))
        self.assertEqual(normalize_key("super+r"), (("win",), "r"))

    def test_bad_keys(self):
        for bad in ("", "  ", "ctrl", "ctrl+ctrl+c", "a+b", "bogus",
                    "ctrl+", "+c", "ctrl+shift"):
            with self.assertRaises(ComputerError, msg=bad):
                normalize_key(bad)


class TestCoordValidation(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(_validate_coord(0, "x"), 0)
        self.assertEqual(_validate_coord(100.0, "x"), 100)
        self.assertEqual(_validate_coord(100000, "x"), 100000)

    def test_invalid(self):
        for bad in (-1, 100001, True, "5", 5.5, None):
            with self.assertRaises(ComputerError, msg=repr(bad)):
                _validate_coord(bad, "x")


class TestPngEncoder(unittest.TestCase):
    def test_encode_1x1_red(self):
        png = _encode_png(1, 1, [bytes([255, 0, 0])])
        self.assertTrue(png.startswith(PNG_MAGIC))
        width, height = struct.unpack(">II", png[16:24])
        self.assertEqual((width, height), (1, 1))
        idat = self._idat(png)
        self.assertEqual(zlib.decompress(idat), bytes([0, 255, 0, 0]))

    def test_encode_wrong_row_count(self):
        with self.assertRaises(ComputerError):
            _encode_png(1, 2, [bytes([0, 0, 0])])

    def test_check_png_rejects(self):
        with self.assertRaises(ComputerError):
            _check_png(b"not a png", "test")
        self.assertEqual(_check_png(PNG, "test"), PNG)

    @staticmethod
    def _idat(png):
        pos = 8
        out = b""
        while pos < len(png):
            length = struct.unpack(">I", png[pos:pos + 4])[0]
            tag = png[pos + 4:pos + 8]
            data = png[pos + 8:pos + 8 + length]
            if tag == b"IDAT":
                out += data
            pos += 12 + length
        return out


class TestX11Backend(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"DISPLAY": ":99"})
        self.env.start()
        self.which = mock.patch(
            "nyra.computer.shutil.which", return_value="/usr/bin/xdotool"
        )
        self.which.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.which.stop)

    def _control(self, mapping):
        run = _FakeRun(mapping)
        patcher = mock.patch("nyra.computer.subprocess.run", run)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.run = run
        return ComputerControl(backend="x11")

    def test_move_builds_argv(self):
        ctl = self._control({})
        ctl.move(10, 20)
        self.assertEqual(self.run.calls, [["xdotool", "mousemove", "10", "20"]])

    def test_click_right_button(self):
        ctl = self._control({})
        ctl.click(5, 6, "right")
        self.assertEqual(
            self.run.calls,
            [["xdotool", "mousemove", "5", "6", "click", "3"]],
        )

    def test_click_bad_button(self):
        ctl = self._control({})
        with self.assertRaises(ComputerError):
            ctl.click(5, 6, "double")

    def test_type_text(self):
        ctl = self._control({})
        ctl.type_text("hi")
        self.assertEqual(
            self.run.calls,
            [["xdotool", "type", "--clearmodifiers", "--", "hi"]],
        )
        ctl.type_text("")
        self.assertEqual(len(self.run.calls), 1)

    def test_press_combo_and_names(self):
        ctl = self._control({})
        ctl.press("ctrl+c")
        ctl.press("enter")
        ctl.press("page_up")
        self.assertEqual(self.run.calls, [
            ["xdotool", "key", "ctrl+c"],
            ["xdotool", "key", "Return"],
            ["xdotool", "key", "Prior"],
        ])

    def test_screen_size(self):
        ctl = self._control({
            ("xdotool", "getdisplaygeometry"): _Proc(stdout=b"1920 1080" + NL.encode()),
        })
        self.assertEqual(ctl.screen_size(), (1920, 1080))

    def test_screen_size_bad_output(self):
        ctl = self._control({
            ("xdotool", "getdisplaygeometry"): _Proc(stdout=b"garbage"),
        })
        with self.assertRaises(ComputerError):
            ctl.screen_size()

    def test_windows(self):
        geom1 = """X=10
Y=20
WIDTH=800
HEIGHT=600
"""
        geom2 = """X=0
Y=0
WIDTH=400
HEIGHT=300
"""
        ctl = self._control({
            ("xdotool", "search", "--onlyvisible", "--name", "."): _Proc(
                stdout=("111" + NL + "222" + NL).encode()
            ),
            ("xdotool", "getwindowname", "111"): _Proc(stdout=b"Terminal" + NL.encode()),
            ("xdotool", "getwindowgeometry", "--shell", "111"): _Proc(
                stdout=geom1.encode()
            ),
            ("xdotool", "getwindowname", "222"): _Proc(stdout=b"Browser" + NL.encode()),
            ("xdotool", "getwindowgeometry", "--shell", "222"): _Proc(
                stdout=geom2.encode()
            ),
        })
        found = ctl.windows()
        self.assertEqual(found, [
            {"id": "111", "title": "Terminal", "x": 10, "y": 20,
             "width": 800, "height": 600},
            {"id": "222", "title": "Browser", "x": 0, "y": 0,
             "width": 400, "height": 300},
        ])

    def test_windows_skips_dead_window(self):
        ctl = self._control({
            ("xdotool", "search", "--onlyvisible", "--name", "."): _Proc(
                stdout=b"111" + NL.encode()
            ),
            ("xdotool", "getwindowname", "111"): _Proc(
                returncode=1, stderr=b"window gone"
            ),
        })
        self.assertEqual(ctl.windows(), [])

    def test_screenshot_prefers_import(self):
        ctl = self._control({
            ("import", "-window", "root", "png:-"): _Proc(stdout=PNG),
        })
        self.assertEqual(ctl.screenshot(), PNG)
        self.assertEqual(
            self.run.calls, [["import", "-window", "root", "png:-"]]
        )

    def test_screenshot_falls_back_to_scrot(self):
        def which(name):
            return None if name == "import" else "/usr/bin/" + name

        with mock.patch("nyra.computer.shutil.which", side_effect=which):
            ctl = self._control({
                ("scrot", "-o", "-"): _Proc(stdout=PNG),
            })
            self.assertEqual(ctl.screenshot(), PNG)
        self.assertEqual(self.run.calls, [["scrot", "-o", "-"]])

    def test_screenshot_no_tool(self):
        with mock.patch("nyra.computer.shutil.which", return_value=None):
            ctl = self._control({})
            with self.assertRaises(ComputerError) as cm:
                ctl.screenshot()
        self.assertIn("import", str(cm.exception))
        self.assertIn("scrot", str(cm.exception))

    def test_no_display_raises(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            ctl = ComputerControl(backend="x11")
            with self.assertRaises(ComputerError) as cm:
                ctl.click(1, 2)
            self.assertIn("DISPLAY", str(cm.exception))
            with self.assertRaises(ComputerError):
                ctl.screenshot()

    def test_xdotool_missing_raises(self):
        with mock.patch("nyra.computer.shutil.which", return_value=None):
            ctl = ComputerControl(backend="x11")
            with self.assertRaises(ComputerError) as cm:
                ctl.move(1, 2)
            self.assertIn("xdotool", str(cm.exception))

    def test_nonzero_exit_raises(self):
        ctl = self._control({})
        with mock.patch(
            "nyra.computer.subprocess.run",
            return_value=_Proc(returncode=1, stderr=b"no such window"),
        ):
            with self.assertRaises(ComputerError) as cm:
                ctl.move(1, 2)
        self.assertIn("退出码 1", str(cm.exception))

    def test_timeout_raises(self):
        import subprocess

        ctl = self._control({})
        with mock.patch(
            "nyra.computer.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="xdotool", timeout=10),
        ):
            with self.assertRaises(ComputerError) as cm:
                ctl.move(1, 2)
        self.assertIn("超时", str(cm.exception))


class TestMacOSBackend(unittest.TestCase):
    def _control(self, mapping):
        run = _FakeRun(mapping)
        patcher = mock.patch("nyra.computer.subprocess.run", run)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.run = run
        return ComputerControl(backend="macos")

    def test_move_argv(self):
        ctl = self._control({})
        ctl.move(10, 20)
        self.assertEqual(self.run.calls[0][0], "osascript")
        joined = NL.join(self.run.calls[0])
        self.assertIn("CGEventCreateMouseEvent(missing value, 1, {10, 20}, 0)", joined)
        self.assertIn("CGEventPost(0, mouseEvent)", joined)

    def test_click_right(self):
        ctl = self._control({})
        ctl.click(1, 2, "right")
        joined = NL.join(self.run.calls[0])
        self.assertIn("CGEventCreateMouseEvent(missing value, 4, {1, 2}, 1)", joined)
        self.assertIn("CGEventCreateMouseEvent(missing value, 5, {1, 2}, 1)", joined)

    def test_type_text_escapes_quotes(self):
        ctl = self._control({})
        ctl.type_text('a"b')
        line = self.run.calls[0][-1]
        expected = 'tell application "System Events" to keystroke "a' + BS + '"b"'
        self.assertEqual(line, expected)

    def test_press_combo(self):
        ctl = self._control({})
        ctl.press("ctrl+c")
        ctl.press("enter")
        self.assertIn(
            'tell application "System Events" to key code 8 using {control down}',
            self.run.calls[0],
        )
        self.assertIn(
            'tell application "System Events" to key code 36',
            self.run.calls[1],
        )

    def test_screen_size(self):
        ctl = self._control({
            ("osascript", "-e",
             'tell application "Finder" to get bounds of window of desktop'): _Proc(
                stdout=b"{0, 0, 1920, 1080}" + NL.encode()
            ),
        })
        self.assertEqual(ctl.screen_size(), (1920, 1080))

    def test_windows_parsed(self):
        script = [
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
        ]
        argv = ["osascript"]
        for line in script:
            argv.extend(["-e", line])
        out = "Terminal|{10, 20}|{800, 600}|42" + NL + "Mail|{0, 0}|{400, 300}|43" + NL
        ctl = self._control({tuple(argv): _Proc(stdout=out.encode())})
        self.assertEqual(ctl.windows(), [
            {"id": "42", "title": "Terminal", "x": 10, "y": 20,
             "width": 800, "height": 600},
            {"id": "43", "title": "Mail", "x": 0, "y": 0,
             "width": 400, "height": 300},
        ])

    def test_screenshot(self):
        ctl = self._control({})
        with mock.patch(
            "nyra.computer.subprocess.run",
            return_value=_Proc(stdout=b""),
        ) as run, mock.patch(
            "pathlib.Path.read_bytes", return_value=PNG
        ):
            self.assertEqual(ctl.screenshot(), PNG)
        argv = run.call_args[0][0]
        self.assertEqual(argv[:4], ["screencapture", "-x", "-t", "png"])
        self.assertTrue(argv[4].endswith(".png"))

    def test_screenshot_failure(self):
        ctl = self._control({})
        with mock.patch(
            "nyra.computer.subprocess.run",
            return_value=_Proc(returncode=1, stderr=b"no display"),
        ):
            with self.assertRaises(ComputerError) as cm:
                ctl.screenshot()
        self.assertIn("退出码 1", str(cm.exception))


class _FakeUser32:
    def __init__(self):
        self.calls = []
        self.metrics = {0: 800, 1: 600}
        self.titles = {}
        self.rects = {}
        self.hwnds = []

    def SetCursorPos(self, x, y):
        self.calls.append(("SetCursorPos", x, y))
        return 1

    def mouse_event(self, flags, dx, dy, data, extra):
        self.calls.append(("mouse_event", flags, dx, dy, data, extra))

    def keybd_event(self, vk, scan, flags, extra):
        self.calls.append(("keybd_event", vk, scan, flags, extra))

    def SendInput(self, n, arr, size):
        self.calls.append(("SendInput", n, arr, size))
        return n

    def GetSystemMetrics(self, index):
        return self.metrics[index]

    def IsWindowVisible(self, hwnd):
        return True

    def GetWindowTextLengthW(self, hwnd):
        return len(self.titles.get(hwnd, ""))

    def GetWindowTextW(self, hwnd, buf, n):
        buf.value = self.titles.get(hwnd, "")
        return len(buf.value)

    def GetWindowRect(self, hwnd, rect):
        x, y, w, h = self.rects[hwnd]
        rect.left, rect.top = x, y
        rect.right, rect.bottom = x + w, y + h
        return 1

    def EnumWindows(self, proc, lparam):
        for hwnd in self.hwnds:
            if not proc(hwnd, lparam):
                break
        return 1

    def GetDC(self, hwnd):
        self.calls.append(("GetDC", hwnd))
        return 7

    def ReleaseDC(self, hwnd, hdc):
        self.calls.append(("ReleaseDC", hwnd, hdc))
        return 1


class _FakeGdi32:
    def __init__(self, bgra=b""):
        self.calls = []
        self.bgra = bgra

    def CreateCompatibleDC(self, hdc):
        self.calls.append(("CreateCompatibleDC", hdc))
        return 8

    def CreateCompatibleBitmap(self, hdc, w, h):
        self.calls.append(("CreateCompatibleBitmap", hdc, w, h))
        return 9

    def SelectObject(self, dc, obj):
        self.calls.append(("SelectObject", dc, obj))
        return 0

    def BitBlt(self, *args):
        self.calls.append(("BitBlt",) + args)
        return 1

    def GetDIBits(self, dc, bitmap, start, lines, buf, info, usage):
        self.calls.append(("GetDIBits", dc, bitmap, start, lines, usage))
        ctypes.memmove(buf, self.bgra, len(self.bgra))
        return lines

    def DeleteObject(self, obj):
        return 1

    def DeleteDC(self, dc):
        return 1


class TestWindowsBackend(unittest.TestCase):
    def setUp(self):
        self.user32 = _FakeUser32()
        self.gdi32 = _FakeGdi32()
        self.ctl = ComputerControl(
            backend="windows", _user32=self.user32, _gdi32=self.gdi32
        )

    def test_move_and_click(self):
        self.ctl.move(3, 4)
        self.assertIn(("SetCursorPos", 3, 4), self.user32.calls)
        self.ctl.click(5, 6, "right")
        kinds = [c[0] for c in self.user32.calls if c[0] == "mouse_event"]
        flags = [c[1] for c in self.user32.calls if c[0] == "mouse_event"]
        self.assertEqual(kinds, ["mouse_event", "mouse_event"])
        self.assertEqual(flags, [0x0008, 0x0010])
        self.assertIn(("SetCursorPos", 5, 6), self.user32.calls)

    def test_press_combo_sequence(self):
        self.ctl.press("ctrl+c")
        keys = [
            (c[1], c[3]) for c in self.user32.calls
            if c[0] == "keybd_event"
        ]
        self.assertEqual(keys, [
            (0x11, 0), (0x43, 0), (0x43, 0x0002), (0x11, 0x0002),
        ])

    def test_press_fkey_and_arrow(self):
        self.ctl.press("f5")
        self.assertEqual(
            [c[1] for c in self.user32.calls if c[0] == "keybd_event"],
            [0x74, 0x74],
        )
        self.ctl.press("up")
        self.assertIn(
            (0x26, 0),
            [(c[1], c[3]) for c in self.user32.calls if c[0] == "keybd_event"],
        )

    def test_type_text_unicode_via_sendinput(self):
        self.ctl.type_text("a" + chr(20320))
        sent = [c for c in self.user32.calls if c[0] == "SendInput"]
        self.assertEqual(len(sent), 1)
        n, arr, _size = sent[0][1], sent[0][2], sent[0][3]
        self.assertEqual(n, 4)
        scans = [arr[i].u.ki.wScan for i in range(n)]
        flags = [arr[i].u.ki.dwFlags for i in range(n)]
        self.assertEqual(scans, [ord("a"), ord("a"), 20320, 20320])
        self.assertEqual(flags, [0x0004, 0x0006, 0x0004, 0x0006])
        self.assertTrue(all(arr[i].u.ki.wVk == 0 for i in range(n)))

    def test_screen_size(self):
        self.assertEqual(self.ctl.screen_size(), (800, 600))

    def test_windows(self):
        self.user32.hwnds = [100, 200]
        self.user32.titles = {100: "Notepad", 200: "Calc"}
        self.user32.rects = {100: (10, 20, 300, 200), 200: (0, 0, 100, 100)}
        self.assertEqual(self.ctl.windows(), [
            {"id": "100", "title": "Notepad", "x": 10, "y": 20,
             "width": 300, "height": 200},
            {"id": "200", "title": "Calc", "x": 0, "y": 0,
             "width": 100, "height": 100},
        ])

    def test_screenshot_png(self):
        self.user32.metrics = {0: 2, 1: 2}
        bgra = bytes([
            10, 20, 30, 255, 40, 50, 60, 255,
            70, 80, 90, 255, 100, 110, 120, 255,
        ])
        self.gdi32.bgra = bgra
        png = self.ctl.screenshot()
        self.assertTrue(png.startswith(PNG_MAGIC))
        width, height = struct.unpack(">II", png[16:24])
        self.assertEqual((width, height), (2, 2))
        idat = TestPngEncoder._idat(png)
        rows = zlib.decompress(idat)
        self.assertEqual(rows, bytes([
            0, 30, 20, 10, 60, 50, 40,
            0, 90, 80, 70, 120, 110, 100,
        ]))

    @unittest.skipUnless(sys.platform.startswith("linux"), "real windll exists on Windows")
    def test_no_real_windll_on_linux(self):
        ctl = ComputerControl(backend="windows")
        with self.assertRaises(ComputerError) as cm:
            ctl.screen_size()
        self.assertIn("Windows", str(cm.exception))


class TestBackendSelection(unittest.TestCase):
    def test_unknown_backend(self):
        with self.assertRaises(ComputerError):
            ComputerControl(backend="amiga")

    def test_unknown_platform(self):
        with mock.patch("nyra.computer.platform.system", return_value="Plan9"):
            with self.assertRaises(ComputerError):
                ComputerControl()


class TestComputerTools(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.fake = _FakeComputer()

    def _ctx(self, mode="full", interactive=False, approve_fn=None,
             with_evidence=False):
        ctx = ToolContext(
            workdir=self.tmp,
            mode=mode,
            interactive=interactive,
            memory_path=self.tmp / "MEMORY.md",
            skills_dir=self.tmp / "skills",
            approve_fn=approve_fn,
        )
        ctx.computer = self.fake
        if with_evidence:
            ctx.evidence = EvidenceStore(self.tmp, "sess1")
        return ctx

    def test_schemas_and_mutating_set_include_computer_tools(self):
        names = {s["function"]["name"] for s in TOOL_SCHEMAS}
        for name in ("computer_screenshot", "computer_click",
                     "computer_type", "computer_key", "computer_windows"):
            self.assertIn(name, names)
            self.assertIn(name, MUTATING_TOOLS)

    def test_screenshot_description_is_honest_about_vision(self):
        schemas = {s["function"]["name"]: s["function"] for s in TOOL_SCHEMAS}
        desc = schemas["computer_screenshot"]["description"]
        self.assertIn("暂不能直接看图", desc)
        self.assertIn("视觉接线", desc)
        self.assertNotIn("看不见", desc)

    def test_screenshot_saves_png_to_evidence(self):
        ctx = self._ctx(with_evidence=True)
        out = execute_tool("computer_screenshot", {}, ctx)
        self.assertEqual(self.fake.calls, [("screenshot",)])
        self.assertIn("已截屏并保存", out)
        self.assertIn("暂不能直接看图", out)
        saved = list((self.tmp / "sess1").glob("computer_screenshot_*.png"))
        self.assertEqual(len(saved), 1)
        self.assertTrue(saved[0].read_bytes().startswith(PNG_MAGIC))

    def test_screenshot_without_evidence_uses_workdir(self):
        ctx = self._ctx()
        out = execute_tool("computer_screenshot", {}, ctx)
        self.assertIn(str(self.tmp), out)
        self.assertEqual(len(list(self.tmp.glob("computer_screenshot_*.png"))), 1)

    def test_click_passes_coords(self):
        ctx = self._ctx()
        out = execute_tool(
            "computer_click", {"x": 10, "y": 20, "button": "right"}, ctx
        )
        self.assertEqual(self.fake.calls, [("click", 10, 20, "right")])
        self.assertIn("已点击（10, 20，right键）", out)
        out = execute_tool("computer_click", {"x": 10.0, "y": 20}, ctx)
        self.assertEqual(self.fake.calls[-1], ("click", 10, 20, "left"))

    def test_type_and_key(self):
        ctx = self._ctx()
        execute_tool("computer_type", {"text": "hello"}, ctx)
        execute_tool("computer_key", {"key": "ctrl+c"}, ctx)
        self.assertEqual(self.fake.calls, [
            ("type_text", "hello"), ("press", "ctrl+c"),
        ])

    def test_windows_returns_untrusted_list(self):
        self.fake.window_list = [
            {"id": "1", "title": "Terminal", "x": 0, "y": 0,
             "width": 100, "height": 100},
        ]
        ctx = self._ctx()
        out = execute_tool("computer_windows", {}, ctx)
        self.assertIn("Terminal", out)
        self.assertIn("【不可信外部数据开始】", out)

    def test_windows_empty(self):
        ctx = self._ctx()
        self.assertEqual(
            execute_tool("computer_windows", {}, ctx), "当前没有可见窗口"
        )

    def test_readonly_refuses_all_five(self):
        ctx = self._ctx(mode="readonly")
        for name, args in (
            ("computer_screenshot", {}),
            ("computer_click", {"x": 1, "y": 2}),
            ("computer_type", {"text": "x"}),
            ("computer_key", {"key": "enter"}),
            ("computer_windows", {}),
        ):
            out = execute_tool(name, args, ctx)
            self.assertIn("只读模式", out, name)
        self.assertEqual(self.fake.calls, [])

    def test_auto_noninteractive_refuses(self):
        ctx = self._ctx(mode="auto", interactive=False)
        out = execute_tool("computer_click", {"x": 1, "y": 2}, ctx)
        self.assertIn("非交互模式", out)
        self.assertEqual(self.fake.calls, [])

    def test_auto_approve_fn_denies_and_allows(self):
        ctx = self._ctx(
            mode="auto", interactive=True, approve_fn=lambda *a: False
        )
        out = execute_tool("computer_click", {"x": 1, "y": 2}, ctx)
        self.assertIn("用户拒绝执行", out)
        self.assertEqual(self.fake.calls, [])
        ctx = self._ctx(
            mode="auto", interactive=True, approve_fn=lambda *a: True
        )
        execute_tool("computer_click", {"x": 1, "y": 2}, ctx)
        self.assertEqual(self.fake.calls, [("click", 1, 2, "left")])

    def test_backend_error_surfaces_cleanly(self):
        class _Broken(_FakeComputer):
            def click(self, x, y, button="left"):
                raise ComputerError("没有桌面会话（DISPLAY 未设置）")

        ctx = self._ctx()
        ctx.computer = _Broken()
        out = execute_tool("computer_click", {"x": 1, "y": 2}, ctx)
        self.assertIn("错误：没有桌面会话", out)


if __name__ == "__main__":
    unittest.main()
