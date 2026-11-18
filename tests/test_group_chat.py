"""Independent bot identities, persistence, routing and bounded chat tests."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nyra import agent as agent_module
from nyra import memory as memory_module
from nyra.groups import Bot, GroupError, GroupStore, MAX_BOTS, MAX_ROUNDS


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
        self.home_patch = patch.object(agent_module, "NYRA_HOME", self.root / "home")
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

        import nyra.groups as groups_module
        from nyra.providers import FallbackProvider, ProviderError

        primary = ScriptedProvider(
            "deepseek", "deepseek-flash",
            [ProviderError("余额不足", status=402, kind="quota")],
        )
        backup = ScriptedProvider("xai", "grok-4.3", ["备用模型答复"])
        fakes = {"deepseek": primary, "xai": backup}
        config = {
            "fallback_enabled": True,
            "fallback_providers": ["xai"],
            "profiles": {},
        }
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

    def test_bot_entry_carries_model_switches(self):
        from nyra.providers import FallbackProvider, ProviderError

        def reply(content):
            return {"choices": [{"message": {
                "role": "assistant", "content": content,
            }}]}

        primary = ScriptedProvider(
            "deepseek", "deepseek-flash",
            [ProviderError("余额不足", status=402, kind="quota")],
        )
        backup = ScriptedProvider("xai", "grok-4.3", [reply("备用模型答复")])

        def make_chain(bot):
            return FallbackProvider([primary, backup])

        store = GroupStore(self.root / "groups", provider_factory=make_chain)
        store.create("dev", "开发群")
        result = store.send("dev", "@lead 请回答")
        bot_entries = [m for m in result["messages"] if m["sender"] == "lead"]
        self.assertEqual(len(bot_entries), 1)
        self.assertEqual(bot_entries[0]["content"], "备用模型答复")
        switches = bot_entries[0].get("model_switches", [])
        self.assertEqual(len(switches), 1)
        self.assertEqual(switches[0]["from"], "deepseek")
        self.assertEqual(switches[0]["to"], "xai")
        # The user entry carries no switch record.
        self.assertNotIn("model_switches", result["messages"][0])

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
        from nyra.agent import Agent
        from nyra.tools import execute_tool

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


class LeakyProvider:
    """Fake whose server error echoes its own key (worst case).

    _redact mimics the real Provider: the key is replaced before the
    error text can reach an aggregated error, a switch record or a log.
    """

    def __init__(self, name, model, api_key):
        self.name = name
        self.model = model
        self.base_url = f"https://{name}.example.com/v1"
        self.api_key = api_key
        self.calls = 0

    def has_credentials(self):
        return bool(self.api_key)

    def _redact(self, text, request=None):
        return text.replace(self.api_key, "[已隐藏]")

    def chat(self, messages, tools=None, timeout=120):
        self.calls += 1
        from nyra.providers import ProviderError

        raise ProviderError(
            f"server said bad key {self.api_key}", status=401, kind="auth"
        )


class GroupApiKeysTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sessions_patch = patch.object(
            memory_module, "SESSIONS_DIR", self.root / "sessions"
        )
        self.home_patch = patch.object(agent_module, "NYRA_HOME", self.root / "home")
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

    # -- Bot.parse / validate -------------------------------------------

    def test_parse_accepts_api_keys(self):
        bot = Bot.parse({
            "id": "b1", "name": "One", "role": "R", "instructions": "Own ideas",
            "provider": "deepseek", "api_keys": ["k1", "k2"],
        })
        self.assertEqual(bot.api_keys, ["k1", "k2"])

    def test_parse_rejects_blank_and_too_many_keys(self):
        base = {"id": "b1", "name": "One", "role": "R", "instructions": "Own ideas"}
        for bad in ([""], ["   "], ["k1", 123], ["k1"] * 6):
            with self.assertRaises(GroupError):
                Bot.parse({**base, "api_keys": bad})
        with self.assertRaises(GroupError):
            Bot.parse({**base, "api_keys": "k1"})  # a string is not a list

    def test_parse_old_room_without_api_keys_still_works(self):
        bot = Bot.parse({
            "id": "b1", "name": "One", "role": "R", "instructions": "Own ideas",
        })
        self.assertIsNone(bot.api_keys)

    # -- KeyRotatingProvider (direct) ------------------------------------

    def test_rotation_on_401_succeeds_on_second_key(self):
        from nyra.providers import KeyRotatingProvider, ProviderError

        def reply(content):
            return {"choices": [{"message": {
                "role": "assistant", "content": content,
            }}]}

        first = ScriptedProvider(
            "deepseek", "deepseek-flash",
            [ProviderError("认证失败", status=401, kind="auth")],
        )
        second = ScriptedProvider(
            "deepseek", "deepseek-flash", [reply("第二把 key 答复")]
        )
        rotating = KeyRotatingProvider([first, second])
        result = rotating.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(
            result["choices"][0]["message"]["content"], "第二把 key 答复"
        )
        self.assertEqual(first.calls, 1)
        self.assertEqual(second.calls, 1)
        self.assertEqual(len(rotating.switches), 1)
        self.assertEqual(rotating.switches[0]["from"], "deepseek key 1")
        self.assertEqual(rotating.switches[0]["to"], "deepseek key 2")
        self.assertEqual(rotating.switches[0]["kind"], "auth")

    def test_rotation_on_429_and_402(self):
        from nyra.providers import KeyRotatingProvider, ProviderError

        def reply(content):
            return {"choices": [{"message": {
                "role": "assistant", "content": content,
            }}]}

        providers = [
            ScriptedProvider("deepseek", "deepseek-flash", [
                ProviderError("太频繁", status=429, kind="rate_limit"),
            ]),
            ScriptedProvider("deepseek", "deepseek-flash", [
                ProviderError("余额不足", status=402, kind="quota"),
            ]),
            ScriptedProvider("deepseek", "deepseek-flash", [reply("第三把 key 答复")]),
        ]
        rotating = KeyRotatingProvider(providers)
        result = rotating.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(
            result["choices"][0]["message"]["content"], "第三把 key 答复"
        )
        self.assertEqual(len(rotating.switches), 2)
        self.assertEqual(rotating.switches[1]["to"], "deepseek key 3")

    def test_all_keys_failing_names_indices_not_values(self):
        from nyra.providers import KeyRotatingProvider, ProviderError

        leaky1 = LeakyProvider("deepseek", "deepseek-flash", "sk-secret-AAA")
        leaky2 = LeakyProvider("deepseek", "deepseek-flash", "sk-secret-BBB")
        rotating = KeyRotatingProvider([leaky1, leaky2])
        with self.assertRaises(ProviderError) as ctx:
            rotating.chat([{"role": "user", "content": "hi"}])
        message = str(ctx.exception)
        self.assertIn("key 1", message)
        self.assertIn("key 2", message)
        self.assertNotIn("sk-secret-AAA", message)
        self.assertNotIn("sk-secret-BBB", message)
        for record in rotating.switches:
            self.assertNotIn("sk-secret-AAA", str(record))
            self.assertNotIn("sk-secret-BBB", str(record))

    def test_each_chat_starts_from_first_key_again(self):
        from nyra.providers import KeyRotatingProvider, ProviderError

        def reply(content):
            return {"choices": [{"message": {
                "role": "assistant", "content": content,
            }}]}

        first = ScriptedProvider("deepseek", "deepseek-flash", [
            ProviderError("认证失败", status=401, kind="auth"),
            reply("第一把 key 第二次答复"),
        ])
        second = ScriptedProvider("deepseek", "deepseek-flash", [reply("第二把 key 答复")])
        rotating = KeyRotatingProvider([first, second])
        rotating.chat([{"role": "user", "content": "hi"}])
        result = rotating.chat([{"role": "user", "content": "hi again"}])
        self.assertEqual(
            result["choices"][0]["message"]["content"], "第一把 key 第二次答复"
        )
        self.assertEqual(first.calls, 2)
        self.assertEqual(second.calls, 1)

    def test_single_key_behaves_like_plain_provider(self):
        from nyra.providers import KeyRotatingProvider

        def reply(content):
            return {"choices": [{"message": {
                "role": "assistant", "content": content,
            }}]}

        only = ScriptedProvider("deepseek", "deepseek-flash", [reply("一次成功")])
        rotating = KeyRotatingProvider([only])
        result = rotating.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(
            result["choices"][0]["message"]["content"], "一次成功"
        )
        self.assertEqual(rotating.switches, [])

    # -- GroupStore._provider wiring -------------------------------------

    def _keyed_store(self):
        """A store whose Provider construction is faked per api_key."""
        import nyra.groups as groups_module
        from nyra.config import ProviderConfig

        built = []

        class KeyedFake:
            def __init__(self, cfg):
                self.name = cfg.name
                self.model = cfg.model
                self.base_url = cfg.base_url
                self.api_key = cfg.api_key
                self.calls = 0
                built.append(self)

            def has_credentials(self):
                return bool(self.api_key)

            def chat(self, messages, tools=None, timeout=120):
                from nyra.providers import ProviderError

                self.calls += 1
                if self.api_key == "bad-401":
                    raise ProviderError("认证失败", status=401, kind="auth")
                if self.api_key == "bad-429":
                    raise ProviderError("太频繁", status=429, kind="rate_limit")
                return {"choices": [{"message": {
                    "role": "assistant",
                    "content": f"{self.name} 答复",
                }}]}

        def fake_resolve(name, model=None):
            return ProviderConfig(
                name=name,
                base_url=f"https://{name}.example.com/v1",
                model=model or f"{name}-model",
                api_key="env-key",
                auth="cli" if name == "codex" else "env",
                connector_name=None,
                allowed_hosts=[],
            )

        config = {
            "fallback_enabled": True,
            "fallback_providers": ["xai"],
            "profiles": {},
        }
        patches = [
            patch.object(groups_module, "load_config", return_value=config),
            patch.object(groups_module, "resolve_provider", side_effect=fake_resolve),
            patch.object(groups_module, "Provider", side_effect=KeyedFake),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return GroupStore(self.root / "groups"), built

    def test_provider_rotates_bot_keys(self):
        from nyra.providers import FallbackProvider

        store, built = self._keyed_store()
        bot = Bot("lead", "组长", "拆分任务", "先确认目标。",
                  provider="deepseek", model="deepseek-flash",
                  api_keys=["bad-401", "good-key"])
        provider = store._provider(bot)
        self.assertIsInstance(provider, FallbackProvider)
        rotating = provider.providers[0]
        result = provider.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(
            result["choices"][0]["message"]["content"], "deepseek 答复"
        )
        # Only this bot's own keys were used to build its providers.
        keyed = [p for p in built if p.name == "deepseek"]
        self.assertEqual([p.api_key for p in keyed], ["bad-401", "good-key"])
        self.assertEqual(len(rotating.switches), 1)
        self.assertEqual(rotating.switches[0]["from"], "deepseek key 1")
        self.assertEqual(rotating.switches[0]["to"], "deepseek key 2")

    def test_all_keys_recoverable_falls_back_to_next_model(self):
        from nyra.providers import FallbackProvider

        store, built = self._keyed_store()
        bot = Bot("lead", "组长", "拆分任务", "先确认目标。",
                  provider="deepseek", model="deepseek-flash",
                  api_keys=["bad-429", "bad-429"])
        provider = store._provider(bot)
        self.assertIsInstance(provider, FallbackProvider)
        result = provider.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(
            result["choices"][0]["message"]["content"], "xai 答复"
        )
        xai = [p for p in built if p.name == "xai"]
        self.assertEqual(len(xai), 1)
        self.assertEqual(xai[0].calls, 1)

    def test_all_keys_auth_failure_does_not_fall_back_to_next_model(self):
        from nyra.providers import FallbackProvider, ProviderError

        store, built = self._keyed_store()
        bot = Bot("lead", "组长", "拆分任务", "先确认目标。",
                  provider="deepseek", model="deepseek-flash",
                  api_keys=["bad-401", "bad-401"])
        provider = store._provider(bot)
        self.assertIsInstance(provider, FallbackProvider)
        with self.assertRaises(ProviderError):
            provider.chat([{"role": "user", "content": "hi"}])
        xai = [p for p in built if p.name == "xai"]
        self.assertEqual(xai[0].calls, 0)

    def test_cli_bot_with_api_keys_is_rejected(self):
        store, _ = self._keyed_store()
        bot = Bot("lead", "组长", "拆分任务", "先确认目标。",
                  provider="codex", model="codex-model", api_keys=["k1"])
        with self.assertRaisesRegex(GroupError, "没有 API Key"):
            store._provider(bot)

    def test_keys_are_per_bot_not_shared(self):
        store, built = self._keyed_store()
        bot1 = Bot("bot1", "One", "R", "Own ideas", provider="deepseek",
                   model="deepseek-flash", api_keys=["k1a", "k1b"])
        bot2 = Bot("bot2", "Two", "R", "Own ideas", provider="deepseek",
                   model="deepseek-flash", api_keys=["k2a"])
        store._provider(bot1)
        first_batch = [p.api_key for p in built if p.name == "deepseek"]
        built.clear()
        store._provider(bot2)
        second_batch = [p.api_key for p in built if p.name == "deepseek"]
        self.assertEqual(first_batch, ["k1a", "k1b"])
        self.assertEqual(second_batch, ["k2a"])
        self.assertFalse(set(first_batch) & set(second_batch))

    # -- keys never reach display data ------------------------------------

    def test_keys_never_appear_in_returned_room_data(self):
        import json

        bots = [
            {"id": "bot1", "name": "One", "role": "R", "instructions": "Own ideas",
             "provider": "deepseek", "api_keys": ["sk-lead-111"]},
            {"id": "bot2", "name": "Two", "role": "R", "instructions": "Own ideas",
             "provider": "deepseek", "api_keys": ["sk-arch-222", "sk-arch-333"]},
        ]
        created = self.store.create("dev", "开发群", bots=bots)
        for room in (created, self.store.get("dev")):
            self.assertNotIn("api_keys", json.dumps(room))
            self.assertNotIn("sk-lead-111", json.dumps(room))
            self.assertNotIn("sk-arch-222", json.dumps(room))
            self.assertNotIn("sk-arch-333", json.dumps(room))
            for bot in room["bots"]:
                self.assertNotIn("api_keys", bot)
        # But the keys ARE stored on disk for the bots' own use.
        stored = self.store._read("dev")
        self.assertEqual(stored["bots"][0]["api_keys"], ["sk-lead-111"])
        self.assertEqual(
            stored["bots"][1]["api_keys"], ["sk-arch-222", "sk-arch-333"]
        )
        # And a turn's transcript carries no keys either.
        result = self.store.send("dev", "@bot1 请回答")
        self.assertNotIn("sk-lead-111", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
