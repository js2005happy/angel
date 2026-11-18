"""Terminal UI (nyra/tui.py): rendering, key parsing, mode cycling, capability checks."""

import io
import re
import unittest
from types import SimpleNamespace
from unittest import mock

from nyra import tui

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def plain(lines):
    return [ANSI.sub("", line) for line in lines]


class _Stream(io.StringIO):
    def __init__(self, tty=True, encoding="utf-8"):
        super().__init__()
        self._tty = tty
        self._encoding = encoding

    @property
    def encoding(self):
        return self._encoding

    def isatty(self):
        return self._tty


class WidthTests(unittest.TestCase):
    def test_cjk_counts_two_columns(self):
        self.assertEqual(tui.text_width("ab"), 2)
        self.assertEqual(tui.text_width("上下文"), 6)

    def test_truncate_respects_columns(self):
        self.assertEqual(tui.truncate("hello", 10), "hello")
        cut = tui.truncate("你好世界你好世界", 9)
        self.assertLessEqual(tui.text_width(cut), 9)
        self.assertTrue(cut.endswith("…"))
        self.assertEqual(tui.truncate("abc", 0), "")

    def test_wrap_never_exceeds_width(self):
        text = tui.t("trust_body", "zh") + " " + tui.t("trust_body", "en")
        for width in (20, 37, 60):
            for line in tui.wrap(text, width):
                self.assertLessEqual(tui.text_width(line), width)


class HeaderTests(unittest.TestCase):
    def test_wide_has_logo_and_three_info_lines(self):
        lines = tui.render_header("0.3.0", "deepseek-flash", "deepseek · API 计费", "/home/me/p", 100)
        self.assertEqual(len(lines), len(tui.LOGO))
        self.assertIn("Nyra v0.3.0", lines[0])
        self.assertIn("deepseek-flash · deepseek · API 计费", lines[1])
        self.assertIn("/home/me/p", lines[2])
        self.assertTrue(lines[0].startswith(tui.LOGO[0]))

    def test_logo_is_four_rows_single_width(self):
        self.assertEqual(len(tui.LOGO), 4)
        self.assertTrue(all(tui.text_width(row) == tui.LOGO_WIDTH for row in tui.LOGO))
        self.assertTrue(all(set(row) <= set(" ▀▄█") for row in tui.LOGO))
        self.assertEqual([len(r) for r in tui.LOGO_ASCII], [tui.LOGO_WIDTH] * 4)

    def test_narrow_drops_logo_and_fits(self):
        lines = tui.render_header("0.3.0", "m", "p", "/" + "x" * 200, 40)
        self.assertEqual(len(lines), 3)
        for line in lines:
            self.assertLess(tui.text_width(line), 40)
        self.assertNotIn("█", "".join(lines))

    def test_no_ansi_without_color(self):
        lines = tui.render_header("0.3.0", "m", "p", "/w", 100, color=False)
        self.assertFalse(any("\x1b[" in line for line in lines))
        colored = tui.render_header("0.3.0", "m", "p", "/w", 100, color=True)
        self.assertTrue(any("\x1b[" in line for line in colored))
        self.assertEqual(plain(colored), lines)

    def test_header_has_no_old_project_name(self):
        text = "\n".join(tui.render_header("0.3.0", "m", "p", "/w", 100))
        self.assertNotIn("an" + "gel", text.lower())


class StatusBarTests(unittest.TestCase):
    def test_wide_auto(self):
        lines = tui.render_status("deepseek-flash", "proj", "auto", 120, context_pct=12)
        self.assertEqual(lines[0].strip(), "[deepseek-flash] │ proj")
        self.assertEqual(lines[1].strip(), "上下文 12%")
        self.assertIn("›› auto", lines[2])
        self.assertIn("shift+tab", lines[2])

    def test_unknown_context_is_not_shown(self):
        lines = tui.render_status("m", "proj", "auto", 120, context_pct=None)
        self.assertEqual(len(lines), 2)
        self.assertNotIn("%", "".join(lines))

    def test_full_is_red_and_warned(self):
        lines = tui.render_status("m", "proj", "full", 120, color=True)
        self.assertIn("\x1b[31;1m", lines[-1])
        self.assertIn("full", plain(lines)[-1])
        self.assertIn(tui.t("full_warn", "zh"), plain(lines)[-1])

    def test_armed_shows_confirmation_hint(self):
        lines = plain(tui.render_status("m", "p", "auto", 120, armed_full=True))
        self.assertIn(tui.t("arm_full", "zh"), lines[-1])

    def test_narrow_lines_fit(self):
        for width in (30, 45, 59):
            for mode in ("readonly", "auto", "full"):
                for armed in (False, True):
                    lines = tui.render_status(
                        "a-really-long-model-identifier-v4-pro", "项目名称很长很长很长很长", mode,
                        width, context_pct=88, armed_full=armed, color=True,
                    )
                    for line in plain(lines):
                        self.assertLess(tui.text_width(line), width, (width, line))

    def test_no_color_has_no_escapes(self):
        lines = tui.render_status("m", "p", "full", 80, context_pct=5, color=False)
        self.assertFalse(any("\x1b" in line for line in lines))

    def test_ascii_glyphs(self):
        lines = tui.render_status("m", "p", "auto", 80, unicode=False)
        joined = "".join(lines)
        self.assertIn(">> auto", joined)
        self.assertIn("|", joined)
        self.assertNotIn("›", joined)
        self.assertNotIn("│", joined)

    def test_right_side_only_when_given(self):
        base = tui.render_status("m", "p", "auto", 100)
        self.assertEqual(base[0].rstrip(), base[0])
        with_right = tui.render_status("m", "p", "auto", 100, right="plan")
        self.assertTrue(with_right[0].endswith("plan"))

    def test_english(self):
        lines = tui.render_status("m", "p", "auto", 100, context_pct=3, lang="en")
        self.assertIn("context 3%", lines[1])
        self.assertIn("shift+tab to switch", lines[2])


class ContextPercentTests(unittest.TestCase):
    def test_needs_both_numbers(self):
        self.assertIsNone(tui.context_percent(None))
        self.assertIsNone(tui.context_percent({"context_window_tokens": None, "last_prompt_tokens": 10}))
        self.assertIsNone(tui.context_percent({"context_window_tokens": 1000, "last_prompt_tokens": None}))
        self.assertEqual(tui.context_percent({"context_window_tokens": 1000, "last_prompt_tokens": 125}), 13)
        self.assertEqual(tui.context_percent({"context_window_tokens": 100, "last_prompt_tokens": 500}), 100)

    def test_from_real_tracker(self):
        from nyra.usage import UsageTracker

        tracker = UsageTracker(configured_window=200)
        self.assertIsNone(tui.context_percent(tracker.snapshot()))
        tracker.record({"usage": {"prompt_tokens": 50, "completion_tokens": 5}})
        self.assertEqual(tui.context_percent(tracker.snapshot()), 25)
        self.assertIsNone(tui.context_percent(UsageTracker().snapshot()))


class TrustRenderTests(unittest.TestCase):
    def test_contents_and_selection(self):
        lines = plain(tui.render_trust("/srv/proj", 100, selected=0))
        text = "\n".join(lines)
        self.assertIn(tui.t("trust_title", "zh"), text)
        self.assertIn("/srv/proj", text)
        self.assertIn("> 1. " + tui.t("trust_yes", "zh"), text)
        self.assertIn("  2. " + tui.t("trust_no", "zh"), text)
        self.assertIn("Enter", text)
        self.assertIn("Esc", text)
        self.assertIn("Nyra", text)
        lines = plain(tui.render_trust("/srv/proj", 100, selected=1))
        self.assertIn("> 2. " + tui.t("trust_no", "zh"), "\n".join(lines))

    def test_narrow_wraps_inside_width(self):
        for line in tui.render_trust("/" + "deep/" * 30, 40):
            self.assertLessEqual(tui.text_width(ANSI.sub("", line)), 40)

    def test_title_uses_accent_colour(self):
        lines = tui.render_trust("/p", 80, color=True)
        self.assertIn("\x1b[33;1m", lines[1])


class ModeCycleTests(unittest.TestCase):
    def test_full_cycle_needs_two_presses(self):
        self.assertEqual(tui.cycle_mode("readonly", False), ("auto", False))
        self.assertEqual(tui.cycle_mode("auto", False), ("auto", True))
        self.assertEqual(tui.cycle_mode("auto", True), ("full", False))
        self.assertEqual(tui.cycle_mode("full", False), ("readonly", False))

    def test_sequence(self):
        mode, armed, seen = "readonly", False, []
        for _ in range(4):
            mode, armed = tui.cycle_mode(mode, armed)
            seen.append(mode)
        self.assertEqual(seen, ["auto", "auto", "full", "readonly"])


class PosixKeyTests(unittest.TestCase):
    def keys(self, data, final=True):
        return tui.parse_posix(data, final=final)[0]

    def test_text_and_enter(self):
        self.assertEqual(self.keys("hi你好\r"), [("text", "hi你好"), "enter"])

    def test_arrows_and_shift_tab(self):
        self.assertEqual(
            self.keys("\x1b[A\x1b[B\x1b[C\x1b[D\x1b[Z\x1bOH\x1b[3~\x1b[1;5C"),
            ["up", "down", "right", "left", "shift_tab", "home", "delete", "right"],
        )

    def test_control_keys(self):
        self.assertEqual(
            self.keys("\x03\x04\x7f\x08\t\x15\x0c"),
            ["ctrl_c", "ctrl_d", "backspace", "backspace", "tab", "ctrl_u", "ctrl_l"],
        )

    def test_lone_escape(self):
        self.assertEqual(self.keys("\x1b"), ["esc"])
        keys, rest = tui.parse_posix("a\x1b", final=False)
        self.assertEqual((keys, rest), ([("text", "a")], "\x1b"))
        keys, rest = tui.parse_posix("\x1b[", final=False)
        self.assertEqual((keys, rest), ([], "\x1b["))

    def test_split_sequence_then_completed(self):
        keys, rest = tui.parse_posix("\x1b[", final=False)
        self.assertEqual(self.keys(rest + "Z"), ["shift_tab"])


class WindowsKeyTests(unittest.TestCase):
    def test_special_prefixes(self):
        self.assertEqual(
            tui.parse_windows("\x00\x0f\xe0H\xe0P\xe0K\xe0M\xe0S"),
            ["shift_tab", "up", "down", "left", "right", "delete"],
        )

    def test_text_and_controls(self):
        self.assertEqual(
            tui.parse_windows("ab中\r\x08\x1b\x03"),
            [("text", "ab中"), "enter", "backspace", "esc", "ctrl_c"],
        )


class CapabilityTests(unittest.TestCase):
    def test_non_tty_falls_back(self):
        self.assertFalse(tui.tui_available(_Stream(tty=False), _Stream(), {}))
        self.assertFalse(tui.tui_available(_Stream(), _Stream(tty=False), {}))

    def test_dumb_term_and_opt_out(self):
        self.assertFalse(tui.tui_available(_Stream(), _Stream(), {"TERM": "dumb"}))
        self.assertFalse(tui.tui_available(_Stream(), _Stream(), {"NYRA_TUI": "0"}))

    @unittest.skipIf(__import__("os").name == "nt", "termios is POSIX only")
    def test_tty_on_posix(self):
        with mock.patch("nyra.tui.os.name", "posix"):
            self.assertTrue(tui.tui_available(_Stream(), _Stream(), {"TERM": "xterm"}))

    def test_windows_needs_vt(self):
        with mock.patch("nyra.tui.os.name", "nt"), \
                mock.patch("nyra.tui._enable_windows_vt", return_value=False):
            self.assertFalse(tui.tui_available(_Stream(), _Stream(), {}))
        with mock.patch("nyra.tui.os.name", "nt"), \
                mock.patch("nyra.tui._enable_windows_vt", return_value=True):
            self.assertTrue(tui.tui_available(_Stream(), _Stream(), {}))

    def test_no_color_keeps_layout(self):
        # NO_COLOR is about colour only: layout is still available.
        self.assertTrue(
            tui.tui_available(_Stream(), _Stream(), {"NO_COLOR": "1", "TERM": "xterm"})
            or __import__("os").name == "nt"
        )

    def test_unicode_detection(self):
        self.assertTrue(tui.supports_unicode(_Stream(encoding="utf-8")))
        self.assertFalse(tui.supports_unicode(_Stream(encoding="ascii")))
        self.assertFalse(tui.supports_unicode(_Stream(encoding="cp1252")))


class LanguageTests(unittest.TestCase):
    def test_default_chinese(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(tui.language({}), "zh")
            self.assertEqual(tui.language({"language": "en"}), "en")
        with mock.patch.dict("os.environ", {"NYRA_LANG": "en_US"}):
            self.assertEqual(tui.language({}), "en")

    def test_tables_have_same_keys(self):
        self.assertEqual(set(tui.TEXT["zh"]), set(tui.TEXT["en"]))
        joined = " ".join(tui.TEXT["zh"].values()) + " ".join(tui.TEXT["en"].values())
        self.assertNotIn("an" + "gel", joined.lower())


class ProviderSummaryTests(unittest.TestCase):
    def test_kinds(self):
        api = SimpleNamespace(name="deepseek", model="deepseek-flash", base_url="https://api.deepseek.com/v1", auth="env")
        local = SimpleNamespace(name="ollama", model="qwen", base_url="http://localhost:11434/v1", auth="none")
        cli_ = SimpleNamespace(name="codex", model="codex-default", base_url="cli://codex", auth="none")
        self.assertEqual(tui.provider_summary(api), ("deepseek-flash", "deepseek", "billing_api"))
        self.assertEqual(tui.provider_summary(local)[2], "billing_local")
        self.assertEqual(tui.provider_summary(cli_)[2], "billing_cli")
        chain = SimpleNamespace(providers=[api, local], model="deepseek-flash", name="deepseek")
        self.assertEqual(tui.provider_summary(chain)[2], "billing_api")


class PromptViewTests(unittest.TestCase):
    def test_horizontal_scroll_keeps_cursor_visible(self):
        prompt = tui.Prompt(stdout=_Stream())
        buf = list("x" * 100)
        visible, col = prompt._input_view(buf, 100, 20)
        self.assertLessEqual(tui.text_width(visible), 19)
        self.assertLessEqual(col, 19)
        visible, col = prompt._input_view(list("你好" * 30), 0, 20)
        self.assertEqual(col, 0)
        self.assertLessEqual(tui.text_width(visible), 19)


if __name__ == "__main__":
    unittest.main()
