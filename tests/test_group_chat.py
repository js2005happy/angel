"""Independent bot identities, persistence, routing and bounded chat tests."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from angel import agent as agent_module
from angel import memory as memory_module
from angel.groups import Bot, GroupError, GroupStore, MAX_BOTS, MAX_ROUNDS


class SpyProvider:
    def __init__(self, bot):
        self.bot = bot
        self.prompts = []
        self.calls = 0

    def has_credentials(self):
        return True

    def chat(self, messages, tools=None, timeout=120):
        self.calls += 1
        self.prompts.append(messages)
        return {"choices": [{"message": {
            "role": "assistant",
            "content": self.bot.id + " 独立意见 " + str(self.calls),
        }}]}


class ScriptedProvider:
    """A fake provider whose scripted outcomes may raise ProviderError."""

    def __init__(self, name, model, outcomes):
        self.name = name
        self.model = model
        self.base_url = f"https://{name}.example.com/v1"
        self.outcomes = list(outcomes)
        self.calls = 0

    def has_credentials(self):
        return True

    def chat(self, messages, tools=None, timeout=120):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class GroupChatTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sessions_patch = patch.object(
            memory_module, "SESSIONS_DIR", self.root / "sessions"
        )
        self.home_patch = patch.object(agent_module, "ANGEL_HOME", self.root / "home")
        self.sessions_patch.start()
        self.home_patch.start()
        self.providers = {}

        def make_provider(bot):
            provider = SpyProvider(bot)
            self.providers.setdefault(bot.id, []).append(provider)
            return provider

        self.store = GroupStore(self.root / "groups", provider_factory=make_provider)

    def tearDown(self):
        self.home_patch.stop()
        self.sessions_patch.stop()
        self.tmp.cleanup()

    def test_create_room_has_distinct_personas_and_workspaces(self):
        room = self.store.create("dev", "开发群")
        self.assertEqual(len(room["bots"]), 4)
        self.assertEqual(len({bot["id"] for bot in room["bots"]}), 4)
        result = self.store.send("dev", "设计一个小型 SaaS")
        self.assertEqual(result["total"], 5)
        self.assertEqual([m["sender"] for m in result["messages"]],
                         ["user", "lead", "architect", "builder", "reviewer"])
        for bot in room["bots"]:
            botid = bot["id"]
            self.assertTrue(
                (self.root / "groups" / "dev" / "bots" / botid / "workspace").is_dir()
            )
            session = self.root / "sessions" / ("group-dev-" + botid + ".jsonl")
            self.assertTrue(session.is_file())
            prompts = self.providers[botid][0].prompts
            self.assertIn(bot["name"], prompts[0][0]["content"])
            self.assertIn(bot["role"], prompts[0][0]["content"])

    def test_mention_routes_only_to_selected_member(self):
        self.store.create("dev", "开发群")
        result = self.store.send("dev", "@architect 请提出独立方案")
        self.assertEqual([m["sender"] for m in result["messages"]],
                         ["user", "architect"])
        self.assertEqual(set(self.providers), {"architect"})

    def test_explicit_second_round_is_bounded(self):
        self.store.create("dev", "开发群")
        result = self.store.send("dev", "@builder @reviewer 讨论测试", rounds=2)
        self.assertEqual([m["sender"] for m in result["messages"]],
                         ["user", "builder", "reviewer", "builder", "reviewer"])
        with self.assertRaises(GroupError):
            self.store.send("dev", "无限循环", rounds=MAX_ROUNDS + 1)
        self.assertEqual(self.store.get("dev")["messages"], result["messages"])

    def test_invalid_mentions_do_not_charge_or_save(self):
        self.store.create("dev", "开发群")
        with self.assertRaisesRegex(GroupError, "未知机器人"):
            self.store.send("dev", "@unknown 请回答")
        self.assertEqual(self.store.get("dev")["messages"], [])
        self.assertEqual(self.providers, {})

    def test_default_bot_provider_uses_fallback_chain(self):
        from types import SimpleNamespace

        import angel.groups as groups_module
        from angel.providers import FallbackProvider, ProviderError

        primary = ScriptedProvider(
            "deepseek", "deepseek-flash",
            [ProviderError("余额不足", status=402, kind="quota")],
        )
        backup = ScriptedProvider("xai", "grok-4.3", ["备用模型答复"])
        fakes = {"deepseek": primary, "xai": backup}
        config = {"fallback_providers": ["xai"], "profiles": {}}
        bot = Bot(
            "lead", "组长", "拆分任务", "先确认目标。",
            provider="deepseek", model="deepseek-flash",
        )
        with patch.object(groups_module, "load_config", return_value=config), \
            patch.object(groups_module, "resolve_provider", side_effect=(
                lambda name, model=None: SimpleNamespace(
                    name=name, model=model or f"{name}-model")
            )), \
            patch.object(groups_module, "Provider", side_effect=lambda cfg: fakes[cfg.name]):
            store = GroupStore(self.root / "groups")
            provider = store._provider(bot)
            self.assertIsInstance(provider, FallbackProvider)
            result = provider.chat([{"role": "user", "content": "hi"}])
            self.assertEqual(result, "备用模型答复")
            self.assertEqual(provider.name, "xai")
            self.assertEqual(primary.calls, 1)
            self.assertEqual(backup.calls, 1)

    def test_history_and_sessions_survive_store_recreation(self):
        self.store.create("dev", "开发群")
        self.store.send("dev", "@lead 第一项任务")
        store2 = GroupStore(self.root / "groups", provider_factory=self.store.provider_factory)
        self.assertEqual(store2.list_rooms()[0]["messages"], 2)
        store2.send("dev", "@lead 继续上一次任务")
        previous = self.providers["lead"][-1].prompts[-1]
        self.assertTrue(any(m.get("role") == "assistant" for m in previous))
        self.assertEqual(len(store2.get("dev")["messages"]), 4)

    def test_creation_validation_and_private_paths(self):
        for bad_id in ("../parent", "Uppercase", "/tmp", ""):
            with self.assertRaises(GroupError):
                self.store.create(bad_id, "bad")
        with self.assertRaises(GroupError):
            self.store.create("empty", "botless", bots=[])
        with self.assertRaises(GroupError):
            self.store.create("bad", "invalid", bots=[
                {"id": "one", "name": "One", "role": "Role", "instructions": "Think",
                 "mode": "full"},
                {"id": "two", "name": "Two", "role": "Role", "instructions": "Think"},
            ])
        self.store.create("dev", "开发群")
        with self.assertRaises(GroupError):
            self.store.create("dev", "duplicate")
        self.assertEqual(len(self.store.list_rooms()), 1)

    def test_bot_count_and_rounds_have_hard_caps(self):
        def bot(i):
            return {"id": "bot" + str(i), "name": "Bot", "role": "Role",
                    "instructions": "Independent"}
        with self.assertRaises(GroupError):
            self.store.create("too_many", "too many",
                              bots=[bot(i) for i in range(MAX_BOTS + 1)])
        with self.assertRaises(GroupError):
            self.store.create("duplicate", "duplicate", bots=[bot(1), bot(1)])
        self.store.create("dev", "开发群")
        for invalid in (0, 3, True, "1"):
            with self.assertRaises(GroupError):
                self.store.send("dev", "Hello", rounds=invalid)

    def test_memory_stays_private(self):
        from angel.agent import Agent
        from angel.tools import execute_tool

        self.store.create("dev", "开发群")
        a = self.root / "groups" / "dev" / "bots" / "lead" / "MEMORY.md"
        b = self.root / "groups" / "dev" / "bots" / "builder" / "MEMORY.md"
        provider = SpyProvider(Bot("lead", "lead", "Role", "Independent"))
        agent = Agent(provider, mode="full", interactive=False, skills_dirs=[],
                      workdir=self.root, memory_path=a)
        self.assertIn("已写入", execute_tool(
            "memory_append", {"text": "only lead knows"}, agent.ctx
        ))
        self.assertIn("only lead knows", a.read_text(encoding="utf-8"))
        self.assertFalse(b.exists())
        self.assertIn("only lead knows", agent.build_system_prompt("task"))

    def test_model_selection_is_per_member(self):
        bots = [
            {"id": "bot1", "name": "One", "role": "R", "instructions": "Own ideas",
             "provider": "deepseek", "model": "deepseek-flash"},
            {"id": "bot2", "name": "Two", "role": "R", "instructions": "Own ideas",
             "provider": "ollama", "model": "qwen2.5:7b"},
        ]
        room = self.store.create("mix", "混合模型", bots=bots)
        self.assertEqual([b["model"] for b in room["bots"]],
                         ["deepseek-flash", "qwen2.5:7b"])
        self.store.send("mix", "都发表自己的意见")
        self.assertEqual(set(self.providers), {"bot1", "bot2"})


if __name__ == "__main__":
    unittest.main()
