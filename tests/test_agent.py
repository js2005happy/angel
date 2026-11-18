"""Agent 主循环：畸形模型响应必须报 AgentError，而不是裸 KeyError。"""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import nyra.agent as agent_module
import nyra.memory as memory_module
from nyra.agent import Agent, AgentError


class ScriptedProvider:
    name = "mock"
    model = "mock"

    def __init__(self, replies):
        self.replies = list(replies)

    def has_credentials(self):
        return True

    def chat(self, messages, tools=None, timeout=120):
        result = self.replies.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class MalformedResponseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workdir = Path(self.tmp.name)
        self.p1 = mock.patch.object(agent_module, "NYRA_HOME", self.workdir / "home")
        self.p2 = mock.patch.object(memory_module, "SESSIONS_DIR", self.workdir / "sessions")
        self.p1.start()
        self.p2.start()

    def tearDown(self):
        self.p2.stop()
        self.p1.stop()
        self.tmp.cleanup()

    def agent(self, provider):
        return Agent(
            provider, workdir=self.workdir, mode="readonly", interactive=False,
            skills_dirs=[], max_turns=3,
        )

    def test_empty_dict_response_is_agent_error(self):
        with self.assertRaises(AgentError):
            self.agent(ScriptedProvider([{}])).run("hi")

    def test_empty_choices_is_agent_error(self):
        with self.assertRaises(AgentError):
            self.agent(ScriptedProvider([{"choices": []}])).run("hi")

    def test_non_dict_message_is_agent_error(self):
        with self.assertRaises(AgentError):
            self.agent(ScriptedProvider([
                {"choices": [{"message": "not-a-dict"}]},
            ])).run("hi")

    def test_non_list_tool_calls_is_agent_error(self):
        with self.assertRaises(AgentError):
            self.agent(ScriptedProvider([
                {"choices": [{"message": {
                    "role": "assistant", "content": "",
                    "tool_calls": "not-a-list",
                }}]},
            ])).run("hi")

    def test_malformed_tool_call_entry_is_agent_error(self):
        with self.assertRaises(AgentError):
            self.agent(ScriptedProvider([
                {"choices": [{"message": {
                    "role": "assistant", "content": "",
                    "tool_calls": [{"id": "c1", "function": "not-a-dict"}],
                }}]},
            ])).run("hi")

    def test_well_formed_response_still_runs(self):
        agent = self.agent(ScriptedProvider([
            {"choices": [{"message": {"role": "assistant", "content": "ok"}}]},
        ]))
        self.assertEqual(agent.run("hi"), "ok")


if __name__ == "__main__":
    unittest.main()
