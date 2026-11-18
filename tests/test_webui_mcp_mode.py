"""Regression tests for MCP subprocess lifetime in the local Web UI."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from nyra.webui import UIState


class WebUIMCPModeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workdir = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_downgrade_to_readonly_stops_existing_mcp_server(self):
        manager = MagicMock()
        state = UIState(self.workdir, mode="full", mcp_manager=manager)
        run = state.get_run("session-1")
        run.agent = MagicMock()
        with patch("nyra.agent.build_mcp_manager", return_value=None) as builder:
            self.assertEqual(state.set_mode("readonly"), "readonly")
        manager.stop_all.assert_called_once()
        builder.assert_called_once_with(mode="readonly", interactive=False)
        self.assertIsNone(state.mcp_manager)
        self.assertIsNone(run.agent.mcp_manager)
        self.assertEqual(run.agent.mode, "readonly")
        self.assertEqual(run.agent.ctx.mode, "readonly")

    def test_switch_to_full_starts_only_after_mode_change_requested(self):
        state = UIState(self.workdir, mode="auto")
        manager = MagicMock()
        with patch("nyra.agent.build_mcp_manager", return_value=manager) as builder:
            self.assertIsNone(state.mcp_manager)
            self.assertEqual(state.set_mode("full"), "full")
        builder.assert_called_once_with(mode="full", interactive=False)
        self.assertIs(state.mcp_manager, manager)

    def test_mode_switch_denied_if_any_session_running(self):
        manager = MagicMock()
        state = UIState(self.workdir, mode="full", mcp_manager=manager)
        run = state.get_run("running-session")
        with run.lock:
            run.status = "running"
        with patch("nyra.agent.build_mcp_manager") as builder:
            with self.assertRaisesRegex(RuntimeError, "正在执行"):
                state.set_mode("readonly")
        manager.stop_all.assert_not_called()
        builder.assert_not_called()
        self.assertEqual(state.mode, "full")

    def test_same_mode_does_not_restart_mcp(self):
        manager = MagicMock()
        state = UIState(self.workdir, mode="full", mcp_manager=manager)
        with patch("nyra.agent.build_mcp_manager") as builder:
            self.assertEqual(state.set_mode("full"), "full")
        builder.assert_not_called()
        manager.stop_all.assert_not_called()


if __name__ == "__main__":
    unittest.main()
