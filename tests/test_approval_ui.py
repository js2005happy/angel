"""Tests for nyra.approval_ui (Claude-style selector, default yes)."""

import io
import unittest
from unittest import mock

from nyra.approval_ui import (
    _menu_select,
    _render,
    approval_options,
    ask_approval,
)


def _keys(*tokens):
    it = iter(tokens)

    def read_key():
        return next(it)

    return read_key


class ApprovalOptionsTests(unittest.TestCase):
    def test_default_first_row_is_yes(self):
        options = approval_options(False)
        self.assertEqual([value for _label, value in options], ["yes", "no"])

    def test_allow_always_adds_third_row(self):
        options = approval_options(True, always_label="始终允许：本次会话")
        self.assertEqual(
            [value for _label, value in options], ["yes", "no", "always"]
        )
        self.assertEqual(options[2][0], "始终允许：本次会话")


class MenuSelectTests(unittest.TestCase):
    def test_enter_confirms_default_yes(self):
        out = []
        value = _menu_select(
            approval_options(False), _keys("enter"), out.append
        )
        self.assertEqual(value, "yes")

    def test_down_then_enter_picks_no(self):
        out = []
        value = _menu_select(
            approval_options(False), _keys("down", "enter"), out.append
        )
        self.assertEqual(value, "no")

    def test_up_from_first_wraps_to_last(self):
        out = []
        value = _menu_select(
            approval_options(True), _keys("up", "enter"), out.append
        )
        self.assertEqual(value, "always")

    def test_digit_key_confirms_immediately(self):
        out = []
        value = _menu_select(
            approval_options(True), _keys("3"), out.append
        )
        self.assertEqual(value, "always")

    def test_letter_shortcuts(self):
        self.assertEqual(
            _menu_select(approval_options(False), _keys("y"), lambda s: None),
            "yes",
        )
        self.assertEqual(
            _menu_select(approval_options(False), _keys("n"), lambda s: None),
            "no",
        )
        self.assertEqual(
            _menu_select(approval_options(True), _keys("a"), lambda s: None),
            "always",
        )

    def test_esc_cancels_to_no(self):
        value = _menu_select(
            approval_options(True), _keys("esc"), lambda s: None
        )
        self.assertEqual(value, "no")

    def test_render_marks_default_with_arrow_and_footer(self):
        text = _render(approval_options(True), 0)
        self.assertIn("> 1. ", text)
        self.assertIn("Enter to confirm", text)
        self.assertIn("Esc to cancel", text)


class AskApprovalFallbackTests(unittest.TestCase):
    def _no_tty(self):
        stdin = mock.Mock()
        stdin.isatty.return_value = False
        stdout = mock.Mock()
        stdout.isatty.return_value = False
        return stdin, stdout

    def test_empty_line_is_yes(self):
        stdin, stdout = self._no_tty()
        import nyra.approval_ui as ui

        with mock.patch.object(ui.sys, "stdin", stdin), mock.patch.object(
            ui.sys, "stdout", stdout
        ), mock.patch("builtins.input", return_value=""):
            self.assertEqual(ask_approval("允许执行吗？"), "yes")

    def test_n_is_no(self):
        stdin, stdout = self._no_tty()
        import nyra.approval_ui as ui

        with mock.patch.object(ui.sys, "stdin", stdin), mock.patch.object(
            ui.sys, "stdout", stdout
        ), mock.patch("builtins.input", return_value="n"):
            self.assertEqual(ask_approval("允许执行吗？"), "no")

    def test_a_is_always_when_allowed(self):
        stdin, stdout = self._no_tty()
        import nyra.approval_ui as ui

        with mock.patch.object(ui.sys, "stdin", stdin), mock.patch.object(
            ui.sys, "stdout", stdout
        ), mock.patch("builtins.input", return_value="a"):
            self.assertEqual(
                ask_approval("允许执行吗？", allow_always=True), "always"
            )

    def test_a_is_no_when_not_allowed(self):
        stdin, stdout = self._no_tty()
        import nyra.approval_ui as ui

        with mock.patch.object(ui.sys, "stdin", stdin), mock.patch.object(
            ui.sys, "stdout", stdout
        ), mock.patch("builtins.input", return_value="a"):
            self.assertEqual(ask_approval("允许执行吗？"), "no")

    def test_eof_is_no(self):
        stdin, stdout = self._no_tty()
        import nyra.approval_ui as ui

        with mock.patch.object(ui.sys, "stdin", stdin), mock.patch.object(
            ui.sys, "stdout", stdout
        ), mock.patch("builtins.input", side_effect=EOFError):
            self.assertEqual(ask_approval("允许执行吗？"), "no")


if __name__ == "__main__":
    unittest.main()
