"""CLI：配置里的 max_turns 必须是正整数，不能悄悄走样。"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import nyra.cli as cli_module
import nyra.config as config_module
from nyra.agent import AgentError


class MaxTurnsValidationTests(unittest.TestCase):
    def test_validated_max_turns(self):
        self.assertEqual(cli_module._validated_max_turns(None), 20)
        self.assertEqual(cli_module._validated_max_turns(5), 5)
        for bad in (0, -1, "20", 2.5, True):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                cli_module._validated_max_turns(bad)

    def test_make_task_agent_rejects_bad_config_max_turns(self):
        config = {"provider": "deepseek", "model": "deepseek-flash",
                  "max_turns": "20"}
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(cli_module, "load_config", return_value=config), \
                mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key"}):
            with self.assertRaises(AgentError):
                cli_module._make_task_agent(
                    {"name": "t", "prompt": "hi"}, Path(tmp))

    def test_main_rejects_bad_config_max_turns(self):
        config = {"provider": "deepseek", "model": "deepseek-flash",
                  "mode": "auto", "max_turns": -5}
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(cli_module, "load_config", return_value=config), \
                mock.patch.object(config_module, "load_config", return_value=config):
            code = cli_module.main(["hello"])
        self.assertEqual(code, 1)

    def test_main_rejects_zero_cli_max_turns(self):
        config = {"provider": "deepseek", "model": "deepseek-flash",
                  "mode": "auto", "max_turns": 20}
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(cli_module, "load_config", return_value=config), \
                mock.patch.object(config_module, "load_config", return_value=config):
            code = cli_module.main(["--max-turns", "0", "hello"])
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
