"""Hard limits for nested agents and their shared tool-call budgets."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nyra import agent as agent_module
from nyra.agent import Agent, MAX_DELEGATE_CALLS, MAX_DELEGATE_DEPTH, MAX_DELEGATE_TURNS


class Provider:
    def __init__(self):
        self.calls = 0

    def chat(self, messages, tools=None, timeout=120):
        self.calls += 1
        return {"choices": [{"message": {"content": "完成"}}]}


class DelegationLimitTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home_patch = patch.object(agent_module, "NYRA_HOME",
                                       Path(self.temp.name) / "home")
        self.home_patch.start()
        self.provider = Provider()

    def tearDown(self):
        self.home_patch.stop()
        self.temp.cleanup()

    def agent(self, **kwargs):
        return Agent(self.provider, workdir=self.temp.name, skills_dirs=[],
                     mode="readonly", interactive=False, **kwargs)

    def test_invalid_turns_rejected_without_provider_calls(self):
        root = self.agent()
        for turns in (0, -1, MAX_DELEGATE_TURNS + 1, True, "3"):
            self.assertIn("max_turns", root.delegate("task", turns))
        self.assertIn("非空", root.delegate(" ", 1))
        self.assertEqual(self.provider.calls, 0)

    def test_bounded_depth(self):
        deepest = self.agent(delegate_depth=MAX_DELEGATE_DEPTH)
        self.assertIn("深度", deepest.delegate("further", 1))
        self.assertEqual(self.provider.calls, 0)

    def test_shared_budget_across_multiple_child_agents(self):
        root = self.agent()
        sibling = self.agent(delegate_depth=1, delegate_budget=root._delegate_budget)
        for i in range(MAX_DELEGATE_CALLS):
            member = root if i % 2 == 0 else sibling
            self.assertEqual(member.delegate("task", 1), "完成")
        self.assertEqual(self.provider.calls, MAX_DELEGATE_CALLS)
        self.assertIn("最多创建", root.delegate("extra", 1))
        self.assertIn("最多创建", sibling.delegate("extra", 1))
        self.assertEqual(self.provider.calls, MAX_DELEGATE_CALLS)

    def test_each_top_level_run_resets_budget(self):
        root = self.agent()
        for _ in range(MAX_DELEGATE_CALLS):
            self.assertEqual(root.delegate("task", 1), "完成")
        self.assertIn("最多创建", root.delegate("extra", 1))
        self.assertEqual(root.run("new request"), "完成")
        self.assertEqual(root.delegate("new child", 1), "完成")

    def test_delegate_inherits_parent_persona_and_memory_path(self):
        from nyra.memory import load_memory_summary
        memory = Path(self.temp.name) / "private" / "MEMORY.md"
        memory.parent.mkdir(parents=True)
        memory.write_text("my own memory\n", encoding="utf-8")
        root = self.agent(system_instructions="independent reviewer",
                          memory_path=memory)
        self.assertIn("independent reviewer", root.build_system_prompt("task"))
        self.assertIn("my own memory", root.build_system_prompt("task"))
        self.assertEqual(root.delegate("child", 1), "完成")


if __name__ == "__main__":
    unittest.main()
