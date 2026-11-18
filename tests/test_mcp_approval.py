"""Regression tests for MCP tool approval and mode isolation.

MCP server descriptions cannot be trusted to indicate side effects. These
tests make sure the built-in approval boundary is respected for every call.
"""

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nyra.agent import Agent


def response(content="", calls=None):
    message = {"role": "assistant", "content": content}
    if calls:
        message["tool_calls"] = [
            {
                "id": f"call-{i}",
                "type": "function",
                "function": {
                    "name": "mcp_demo_write",
                    "arguments": json.dumps(arguments),
                },
            }
            for i, arguments in enumerate(calls, start=1)
        ]
    return {"choices": [{"message": message}]}


class ScriptedProvider:
    def __init__(self, responses):
        self.responses = list(responses)

    def chat(self, messages, tools=None, timeout=120):
        return self.responses.pop(0)


class RecordingMCPManager:
    tool_schemas = [
        {
            "type": "function",
            "function": {
                "name": "mcp_demo_write",
                "description": "An untrusted MCP tool",
                "parameters": {"type": "object", "properties": {}},
            },
        },
    ]

    def __init__(self):
        self.calls = []

    def has_tools(self):
        return True

    def execute(self, name, arguments):
        self.calls.append((name, arguments))
        return "executed"


class MCPApprovalTest(unittest.TestCase):
    def run_agent(self, mode, interactive, calls=None, answer=None):
        manager = RecordingMCPManager()
        calls = calls if calls is not None else [{"text": "hello"}]
        provider = ScriptedProvider([response(calls=calls), response("done")])

        with tempfile.TemporaryDirectory() as temp:
            # Keep tests independent of ~/.nyra and external providers.
            with patch("nyra.agent.EvidenceStore"), \
                 patch("nyra.agent.load_memory_summary", return_value=""), \
                 patch("nyra.agent.load_agents_md", return_value=""), \
                 patch("nyra.agent.save_session"), \
                 patch("builtins.input", side_effect=answer) as input_mock, \
                 patch("sys.stdout", new_callable=io.StringIO) as stdout:
                agent = Agent(
                    provider=provider,
                    workdir=Path(temp),
                    mode=mode,
                    interactive=interactive,
                    skills_dirs=[],
                    mcp_manager=manager,
                    max_turns=3,
                )
                result = agent.run("call the external tool")
                tool_messages = [
                    msg["content"] for msg in agent.messages
                    if msg["role"] == "tool"
                ]
                return result, tool_messages, manager.calls, input_mock.call_count, stdout.getvalue()

    def test_readonly_rejects_mcp_even_with_read_like_name(self):
        result, messages, calls, prompts, _ = self.run_agent(
            mode="readonly", interactive=False
        )
        self.assertEqual(result, "done")
        self.assertEqual(calls, [])
        self.assertEqual(prompts, 0)
        self.assertIn("只读模式", messages[0])

    def test_auto_without_terminal_rejects_mcp(self):
        _, messages, calls, prompts, _ = self.run_agent(
            mode="auto", interactive=False
        )
        self.assertEqual(calls, [])
        self.assertEqual(prompts, 0)
        self.assertIn("非交互", messages[0])

    def test_auto_user_denial_rejects_mcp(self):
        _, messages, calls, prompts, _ = self.run_agent(
            mode="auto", interactive=True, answer=["n"]
        )
        self.assertEqual(calls, [])
        self.assertEqual(prompts, 1)
        self.assertIn("用户拒绝", messages[0])

    def test_auto_user_approval_allows_one_call(self):
        _, messages, calls, prompts, output = self.run_agent(
            mode="auto", interactive=True, answer=["y"]
        )
        self.assertEqual(prompts, 1)
        self.assertEqual(calls, [("mcp_demo_write", {"text": "hello"})])
        self.assertEqual(messages, ["executed"])
        self.assertIn("mcp_demo_write", output)

    def test_each_external_call_needs_separate_approval(self):
        _, messages, calls, prompts, _ = self.run_agent(
            mode="auto",
            interactive=True,
            calls=[{"text": "one"}, {"text": "two"}],
            answer=["yes", "no"],
        )
        self.assertEqual(prompts, 2)
        self.assertEqual(calls, [("mcp_demo_write", {"text": "one"})])
        self.assertEqual(messages[0], "executed")
        self.assertIn("用户拒绝", messages[1])

    def test_full_mode_allows_mcp_without_prompt(self):
        _, messages, calls, prompts, _ = self.run_agent(
            mode="full", interactive=False
        )
        self.assertEqual(prompts, 0)
        self.assertEqual(calls, [("mcp_demo_write", {"text": "hello"})])
        self.assertEqual(messages, ["executed"])

    def test_approval_prompt_does_not_print_arguments(self):
        _, _, _, _, output = self.run_agent(
            mode="auto", interactive=True,
            calls=[{"password": "SHOULD_NOT_BE_PRINTED"}],
            answer=["n"],
        )
        self.assertIn("mcp_demo_write", output)
        self.assertNotIn("SHOULD_NOT_BE_PRINTED", output)


if __name__ == "__main__":
    unittest.main()
