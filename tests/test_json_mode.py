"""JSON Lines CLI protocol regression tests (stdlib, fake model, no API spend)."""

from contextlib import ExitStack
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import angel.agent as agent_module
import angel.cli as cli
import angel.json_mode as json_mode
import angel.memory as memory_module
from angel.providers import ProviderError


def assistant(content="", calls=None, usage=None):
    message = {"role": "assistant", "content": content}
    if calls:
        message["tool_calls"] = calls
    result = {"choices": [{"message": message}]}
    if usage is not None:
        result["usage"] = usage
    return result


def tool(name, arguments, identifier="call-1"):
    return {
        "id": identifier, "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


class FakeProvider:
    name = "mock"
    model = "fake-model"

    def __init__(self, responses, noisy=False, credentials=True):
        self.responses = list(responses)
        self.noisy = noisy
        self.credentials = credentials
        self.calls = 0

    def has_credentials(self):
        return self.credentials

    def chat(self, messages, tools=None, timeout=120):
        self.calls += 1
        if self.noisy:
            print("A human-readable provider warning", flush=True)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class JsonModeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patchers = [
            mock.patch.object(agent_module, "ANGEL_HOME", self.root / "angelhome"),
            mock.patch.object(memory_module, "SESSIONS_DIR", self.root / "sessions"),
            mock.patch.object(memory_module, "MEMORY_PATH", self.root / "private-memory"),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def run_json(self, argv=None, replies=None, credentials=True, noisy=False, config=None):
        argv = list(argv or [])
        provider = FakeProvider(
            replies if replies is not None else [assistant("已完成")],
            noisy=noisy, credentials=credentials,
        )
        options = {
            "provider": "deepseek", "model": "fake-model",
            "mode": "auto", "sandbox": "local",
            "auto_compact_enabled": False, "auto_compact_threshold": 0.8,
            "max_turns": 3, "context_window_tokens": 4096, "profiles": {},
        }
        if config:
            options.update(config)
        out, err = io.StringIO(), io.StringIO()
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(json_mode, "load_config", return_value=options))
            stack.enter_context(mock.patch.object(json_mode, "resolve_provider", return_value=SimpleNamespace(
                name="mock", model="fake-model",
            )))
            stack.enter_context(mock.patch.object(json_mode, "Provider", return_value=provider))
            stack.enter_context(mock.patch.object(json_mode, "build_mcp_manager", return_value=None))
            stack.enter_context(mock.patch("sys.stdout", out))
            stack.enter_context(mock.patch("sys.stderr", err))
            code = cli.main(["--json", "--workdir", str(self.root), *argv])
        lines = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
        return code, lines, err.getvalue(), provider

    def test_success_emits_valid_ordered_lines_and_usage(self):
        response = assistant("计划完成", usage={
            "prompt_tokens": 42, "completion_tokens": 18, "total_tokens": 60,
        })
        code, events, stderr, _ = self.run_json(
            ["--mode", "readonly", "请完成任务"],
            replies=[response], noisy=True,
        )
        self.assertEqual(code, 0)
        self.assertEqual([event["type"] for event in events],
                         ["run_started", "usage", "run_completed"])
        self.assertEqual([event["seq"] for event in events], [1, 2, 3])
        self.assertTrue(all(event["schema_version"] == 1 for event in events))
        self.assertEqual(events[-1]["output"], "计划完成")
        self.assertEqual(events[-1]["exit_code"], 0)
        self.assertEqual(events[-1]["usage"]["total_tokens"], 60)
        self.assertIn("human-readable provider warning", stderr.lower())
        self.assertNotIn("human-readable", str(events))

    def test_tool_events_never_echo_raw_arguments_or_tool_output(self):
        secret = "PRIVATE_SHOULD_NOT_APPEAR_IN_STDOUT"
        call = tool("read_file", {"path": secret})
        code, events, _, _ = self.run_json(
            ["--mode", "readonly", "inspect"],
            replies=[
                assistant(calls=[call]),
                assistant("done"),
            ],
        )
        self.assertEqual(code, 0)
        self.assertEqual(
            [event["type"] for event in events],
            ["run_started", "tool_start", "tool_result", "run_completed"],
        )
        self.assertEqual(events[1]["name"], "read_file")
        self.assertEqual(events[2]["id"], "call-1")
        self.assertNotIn(secret, json.dumps(events))
        self.assertNotIn("arguments", json.dumps(events))
        self.assertNotIn("result", json.dumps(events))

    def test_noninteractive_auto_denies_write_tools(self):
        target = self.root / "nope.txt"
        code, events, _, _ = self.run_json(
            ["--mode", "auto", "write something"],
            replies=[
                assistant(calls=[tool("write_file", {"path": str(target), "content": "secret"})]),
                assistant("已跳过"),
            ],
        )
        self.assertEqual(code, 0)
        self.assertFalse(target.exists())
        tool_event = next(event for event in events if event["type"] == "tool_result")
        self.assertFalse(tool_event["ok"])

    def test_missing_prompt_returns_json_error_and_exit_2(self):
        code, events, _, _ = self.run_json()
        self.assertEqual(code, 2)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "run_failed")
        self.assertEqual(events[0]["error"]["code"], "invalid_arguments")
        self.assertEqual(events[0]["exit_code"], 2)

    def test_invalid_flag_and_combination_have_json_error(self):
        code, events, _, _ = self.run_json(["--mode", "invalid", "task"])
        self.assertEqual(code, 2)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "run_failed")
        code, events, _, _ = self.run_json(["--list-skills", "task"])
        self.assertEqual(code, 2)
        self.assertEqual(events[0]["error"]["code"], "invalid_arguments")

    def test_unconfigured_credentials_are_not_printed(self):
        code, events, _, provider = self.run_json(
            ["task"], credentials=False,
        )
        self.assertEqual(code, 2)
        self.assertEqual(provider.calls, 0)
        self.assertEqual(events[0]["error"]["code"], "missing_credentials")

    def test_runtime_provider_failure_exits_1(self):
        code, events, _, _ = self.run_json(
            ["task"], replies=[ProviderError("network unavailable")],
        )
        self.assertEqual(code, 1)
        self.assertEqual([event["type"] for event in events],
                         ["run_started", "run_failed"])
        self.assertEqual(events[-1]["error"]["code"], "runtime_error")

    def test_max_turns_exits_3_without_claiming_success(self):
        code, events, _, _ = self.run_json(
            ["--mode", "readonly", "--max-turns", "1", "task"],
            replies=[assistant(calls=[tool("list_dir", {"path": "."})])],
        )
        self.assertEqual(code, 3)
        self.assertIn("turn_limit", [e["type"] for e in events])
        self.assertEqual(events[-1]["type"], "run_incomplete")
        self.assertEqual(events[-1]["exit_code"], 3)
        self.assertNotIn("run_completed", [e["type"] for e in events])

    def test_exception_does_not_expose_secret_in_json(self):
        secret = "secret-EXCEPTION-PASSWORD"
        code, events, stderr, _ = self.run_json(
            ["task"], replies=[RuntimeError(secret)],
        )
        self.assertEqual(code, 1)
        self.assertNotIn(secret, json.dumps(events))
        self.assertEqual(events[-1]["error"]["code"], "runtime_error")
        self.assertIn("RuntimeError", stderr)

    def test_json_mode_rejects_invalid_context_and_output_is_machine_readable(self):
        code, events, _, _ = self.run_json(
            ["--context-window", "-1", "task"],
        )
        self.assertEqual(code, 2)
        self.assertEqual(events[0]["error"]["code"], "invalid_configuration")


if __name__ == "__main__":
    unittest.main()
