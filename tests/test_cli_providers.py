"""Codex CLI provider tests (stdlib unittest only, no network, no keys).

Covers: fixed-path binary resolution (never from config/env), version
and login checks, fixed prompt prefix, fixed argv (read-only, no
approval-skipping flags), prompt via stdin, -o file parsing with JSONL
fallback, error classification, timeout kill, env minimization, no
credential-file access, fallback-chain exclusion, and the scheduled-task
refusal (direct Provider() construction).
"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nyra.cli import _make_task_agent  # noqa: E402
from nyra.config import ProviderConfig, resolve_fallback_chain, resolve_provider  # noqa: E402
from nyra.providers import (  # noqa: E402
    CODEX_MIN_VERSION,
    CODEX_PROMPT_PREFIX,
    CliProvider,
    FallbackProvider,
    Provider,
    ProviderError,
    _classify_codex_error,
    _codex_available,
    _find_codex_binary,
    _reset_codex_cache,
    _serialize_codex_prompt,
    build_provider_chain,
)


class FakePopen:
    """Stand-in for subprocess.Popen emulating `codex exec`."""

    output_text = ""
    stdout_text = ""
    stderr_text = ""
    returncode = 0
    raise_timeout = False

    def __init__(self, argv, **kwargs):
        self.argv = list(argv)
        self.kwargs = kwargs
        self.pid = 12345
        self.communicated_input = None
        self.communicated_timeout = None
        self.killed = False

    def communicate(self, input=None, timeout=None):
        self.communicated_input = input
        self.communicated_timeout = timeout
        if FakePopen.raise_timeout:
            raise subprocess.TimeoutExpired(cmd=self.argv, timeout=timeout)
        if "-o" in self.argv:
            index = self.argv.index("-o")
            with open(self.argv[index + 1], "w", encoding="utf-8") as handle:
                handle.write(FakePopen.output_text)
        return (FakePopen.stdout_text, FakePopen.stderr_text)

    def wait(self, timeout=None):
        return FakePopen.returncode

    def kill(self):
        self.killed = True


def _completed(args, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args, returncode, stdout, stderr)


class CodexBinaryResolutionTests(unittest.TestCase):
    def setUp(self):
        _reset_codex_cache()

    def test_fixed_path_preferred_over_path_lookup(self):
        with (
            mock.patch("nyra.providers.os.path.isfile", return_value=True),
            mock.patch("nyra.providers.os.access", return_value=True),
            mock.patch(
                "nyra.providers.shutil.which",
                side_effect=AssertionError("PATH lookup must not run"),
            ),
        ):
            self.assertEqual(
                _find_codex_binary(), "/opt/hatch-image/bin/codex"
            )

    def test_path_lookup_is_last_resort(self):
        with (
            mock.patch("nyra.providers.os.path.isfile", return_value=False),
            mock.patch("nyra.providers.shutil.which", return_value="/usr/bin/codex"),
        ):
            self.assertEqual(_find_codex_binary(), "/usr/bin/codex")

    def test_missing_binary_is_config_error(self):
        with (
            mock.patch("nyra.providers.os.path.isfile", return_value=False),
            mock.patch("nyra.providers.shutil.which", return_value=None),
        ):
            with self.assertRaises(ProviderError) as ctx:
                _find_codex_binary()
            self.assertEqual(ctx.exception.kind, "config")

    def test_env_and_config_paths_are_ignored(self):
        # No NYRA_CODEX_PATH / codex_path knob exists: the binary is
        # never taken from environment or configuration.
        with (
            mock.patch.dict(os.environ, {"NYRA_CODEX_PATH": "/tmp/evil/codex"}),
            mock.patch("nyra.providers.os.path.isfile", return_value=True),
            mock.patch("nyra.providers.os.access", return_value=True),
        ):
            self.assertEqual(
                _find_codex_binary(), "/opt/hatch-image/bin/codex"
            )


class CodexAvailabilityTests(unittest.TestCase):
    def setUp(self):
        _reset_codex_cache()

    def _run(self, version_stdout, login_text, login_code=0, version_code=0):
        # The real CLI prints the login marker to stderr, not stdout.
        def fake_run(argv, **kwargs):
            if argv[1] == "--version":
                return _completed(argv, version_code, version_stdout)
            return _completed(argv, login_code, "", login_text)

        with (
            mock.patch(
                "nyra.providers._find_codex_binary",
                return_value="/fake/codex",
            ),
            mock.patch("nyra.providers.subprocess.run", side_effect=fake_run),
        ):
            return _codex_available()

    def test_logged_in_and_new_enough(self):
        self.assertTrue(
            self._run("codex-cli 0.164.0-alpha.9\n", "Logged in using ChatGPT\n")
        )

    def test_old_version_refused(self):
        self.assertFalse(
            self._run("codex-cli 0.100.0\n", "Logged in using ChatGPT\n")
        )

    def test_unparseable_version_refused(self):
        self.assertFalse(self._run("codex version unknown\n", "Logged in\n"))

    def test_not_logged_in_refused(self):
        self.assertFalse(self._run("codex-cli 0.164.0\n", "Not logged in\n"))

    def test_login_failure_refused(self):
        self.assertFalse(
            self._run("codex-cli 0.164.0\n", "", login_code=1)
        )

    def test_minimum_version_is_the_verified_one(self):
        self.assertEqual(CODEX_MIN_VERSION, (0, 164, 0))


class CodexPromptTests(unittest.TestCase):
    def test_prefix_is_fixed_and_first(self):
        first = _serialize_codex_prompt(
            [{"role": "user", "content": "hello"}]
        )
        second = _serialize_codex_prompt(
            [{"role": "system", "content": "be nice"},
             {"role": "user", "content": "something else entirely"}]
        )
        self.assertTrue(first.startswith(CODEX_PROMPT_PREFIX))
        self.assertTrue(second.startswith(CODEX_PROMPT_PREFIX))
        common = os.path.commonprefix([first, second])
        # The shared leading bytes are at least the whole fixed prefix
        # (plus the joiner before the first role marker).
        self.assertTrue(common.startswith(CODEX_PROMPT_PREFIX))
        self.assertGreaterEqual(len(common), len(CODEX_PROMPT_PREFIX))

    def test_serialization_marks_roles(self):
        text = _serialize_codex_prompt(
            [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "yo"},
            ]
        )
        self.assertIn("[system]\nsys", text)
        self.assertIn("[user]\nhi", text)
        self.assertIn("[assistant]\nyo", text)


class CodexChatTests(unittest.TestCase):
    def setUp(self):
        _reset_codex_cache()
        FakePopen.output_text = "你好，我是 Codex。"
        FakePopen.stdout_text = ""
        FakePopen.stderr_text = ""
        FakePopen.returncode = 0
        FakePopen.raise_timeout = False
        self.provider = CliProvider(resolve_provider("codex"))

    def _run_chat(self, **kwargs):
        with (
            mock.patch(
                "nyra.providers._find_codex_binary",
                return_value="/fake/codex",
            ),
            mock.patch("nyra.providers._codex_available", return_value=True),
            mock.patch("nyra.providers.subprocess.Popen", FakePopen) as popen,
        ):
            result = self.provider.chat(
                [{"role": "user", "content": "hi"}], **kwargs
            )
            return result, popen

    def test_success_returns_openai_shape(self):
        result, _ = self._run_chat()
        self.assertEqual(
            result["choices"][0]["message"]["content"], "你好，我是 Codex。"
        )
        self.assertEqual(result["model"], "codex-default")

    def test_argv_is_fixed_read_only_and_has_no_forbidden_flags(self):
        with (
            mock.patch(
                "nyra.providers._find_codex_binary",
                return_value="/fake/codex",
            ),
            mock.patch("nyra.providers._codex_available", return_value=True),
        ):
            seen = {}

            class RecordingPopen(FakePopen):
                def __init__(self, argv, **kwargs):
                    super().__init__(argv, **kwargs)
                    seen["argv"] = list(argv)
                    seen["kwargs"] = kwargs

            with mock.patch(
                "nyra.providers.subprocess.Popen", RecordingPopen
            ):
                self.provider.chat([{"role": "user", "content": "hi"}])
        argv = seen["argv"]
        self.assertEqual(argv[:2], ["/fake/codex", "exec"])
        self.assertIn("--json", argv)
        self.assertIn("-s", argv)
        self.assertEqual(argv[argv.index("-s") + 1], "read-only")
        self.assertIn("--ephemeral", argv)
        self.assertIn("--skip-git-repo-check", argv)
        self.assertIn("features.browser_use=false", argv)
        self.assertIn("features.computer_use=false", argv)
        self.assertIn("features.plugins=false", argv)
        # Default model (codex-default): no -m flag, the CLI picks its
        # own default (explicit -m gpt-5 is rejected for ChatGPT logins).
        self.assertNotIn("-m", argv)
        for forbidden in (
            "--dangerously-bypass-approvals-and-sandbox",
            "--approve-for-me",
            "--dangerously-bypass-hook-trust",
            "-y",
            "--full-auto",
        ):
            self.assertNotIn(forbidden, argv)

    def test_explicit_model_is_passed_with_m(self):
        from nyra.config import ProviderConfig

        provider = CliProvider(
            ProviderConfig(
                name="codex",
                base_url="cli://codex",
                model="gpt-5-codex",
                api_key=None,
                auth="cli",
                connector_name=None,
                allowed_hosts=[],
            )
        )
        with (
            mock.patch(
                "nyra.providers._find_codex_binary",
                return_value="/fake/codex",
            ),
            mock.patch("nyra.providers._codex_available", return_value=True),
        ):
            seen = {}

            class RecordingPopen(FakePopen):
                def __init__(self, argv, **kwargs):
                    super().__init__(argv, **kwargs)
                    seen["argv"] = list(argv)

            with mock.patch(
                "nyra.providers.subprocess.Popen", RecordingPopen
            ):
                provider.chat([{"role": "user", "content": "hi"}])
        argv = seen["argv"]
        self.assertIn("-m", argv)
        self.assertEqual(argv[argv.index("-m") + 1], "gpt-5-codex")

    def test_prompt_goes_via_stdin_with_fixed_prefix(self):
        with (
            mock.patch(
                "nyra.providers._find_codex_binary",
                return_value="/fake/codex",
            ),
            mock.patch("nyra.providers._codex_available", return_value=True),
        ):
            seen = {}

            class RecordingPopen(FakePopen):
                def __init__(self, argv, **kwargs):
                    super().__init__(argv, **kwargs)
                    seen["argv"] = list(argv)

                def communicate(self, input=None, timeout=None):
                    seen["input"] = input
                    return super().communicate(input=input, timeout=timeout)

            with mock.patch(
                "nyra.providers.subprocess.Popen", RecordingPopen
            ):
                self.provider.chat([{"role": "user", "content": "hi"}])
        self.assertTrue(seen["input"].startswith(CODEX_PROMPT_PREFIX))
        self.assertIn("[user]\nhi", seen["input"])
        # The prompt is not in argv (ps-visible): it goes via stdin.
        self.assertNotIn("hi", seen["argv"])

    def test_workdir_is_an_empty_temp_dir(self):
        with (
            mock.patch(
                "nyra.providers._find_codex_binary",
                return_value="/fake/codex",
            ),
            mock.patch("nyra.providers._codex_available", return_value=True),
        ):
            seen = {}

            class RecordingPopen(FakePopen):
                def __init__(self, argv, **kwargs):
                    super().__init__(argv, **kwargs)
                    seen["kwargs"] = kwargs
                    seen["argv"] = list(argv)

            with mock.patch(
                "nyra.providers.subprocess.Popen", RecordingPopen
            ):
                self.provider.chat([{"role": "user", "content": "hi"}])
        workdir = seen["kwargs"]["cwd"]
        self.assertTrue(workdir.startswith(tempfile.gettempdir()))
        self.assertIn("nyra-codex-", workdir)
        self.assertEqual(seen["argv"][seen["argv"].index("-C") + 1], workdir)
        self.assertFalse(os.path.exists(workdir))

    def test_tools_are_ignored(self):
        with (
            mock.patch(
                "nyra.providers._find_codex_binary",
                return_value="/fake/codex",
            ),
            mock.patch("nyra.providers._codex_available", return_value=True),
        ):
            seen = {}

            class RecordingPopen(FakePopen):
                def communicate(self, input=None, timeout=None):
                    seen["input"] = input
                    return super().communicate(input=input, timeout=timeout)

            with mock.patch(
                "nyra.providers.subprocess.Popen", RecordingPopen
            ):
                self.provider.chat(
                    [{"role": "user", "content": "hi"}],
                    tools=[{"type": "function", "function": {"name": "test-tool"}}],
                )
        self.assertNotIn("test-tool", seen["input"])

    def test_child_env_drops_api_keys(self):
        with (
            mock.patch.dict(
                os.environ, {"DEEPSEEK_API_KEY": "sk-test", "PATH": "/usr/bin"}
            ),
            mock.patch(
                "nyra.providers._find_codex_binary",
                return_value="/fake/codex",
            ),
            mock.patch("nyra.providers._codex_available", return_value=True),
        ):
            seen = {}

            class RecordingPopen(FakePopen):
                def __init__(self, argv, **kwargs):
                    super().__init__(argv, **kwargs)
                    seen["env"] = kwargs.get("env", {})

            with mock.patch(
                "nyra.providers.subprocess.Popen", RecordingPopen
            ):
                self.provider.chat([{"role": "user", "content": "hi"}])
        self.assertNotIn("DEEPSEEK_API_KEY", seen["env"])
        self.assertIn("PATH", seen["env"])

    def test_child_env_drops_other_credential_vars(self):
        # 只删 *_API_KEY 会把 GITHUB_TOKEN、密码箱密码等漏给子进程。
        with (
            mock.patch.dict(
                os.environ,
                {
                    "GITHUB_TOKEN": "ghp-test",
                    "MY_SERVICE_SECRET": "s3cr3t",
                    "SOME_PASSWORD": "hunter2",
                    "NYRA_VAULT_PASSWORD": "vault-pw",
                    "PATH": "/usr/bin",
                },
            ),
            mock.patch(
                "nyra.providers._find_codex_binary",
                return_value="/fake/codex",
            ),
            mock.patch("nyra.providers._codex_available", return_value=True),
        ):
            seen = {}

            class RecordingPopen(FakePopen):
                def __init__(self, argv, **kwargs):
                    super().__init__(argv, **kwargs)
                    seen["env"] = kwargs.get("env", {})

            with mock.patch(
                "nyra.providers.subprocess.Popen", RecordingPopen
            ):
                self.provider.chat([{"role": "user", "content": "hi"}])
        for name in (
            "GITHUB_TOKEN",
            "MY_SERVICE_SECRET",
            "SOME_PASSWORD",
            "NYRA_VAULT_PASSWORD",
        ):
            self.assertNotIn(name, seen["env"], name)
        self.assertIn("PATH", seen["env"])

    def test_no_credential_file_is_opened(self):
        opened = []
        real_open = open

        def recording_open(path, *args, **kwargs):
            opened.append(str(path))
            return real_open(path, *args, **kwargs)

        with (
            mock.patch(
                "nyra.providers._find_codex_binary",
                return_value="/fake/codex",
            ),
            mock.patch("nyra.providers._codex_available", return_value=True),
            mock.patch("builtins.open", side_effect=recording_open),
            mock.patch("nyra.providers.subprocess.Popen", FakePopen),
        ):
            self.provider.chat([{"role": "user", "content": "hi"}])
        for path in opened:
            self.assertNotIn("auth.json", path)
            self.assertNotIn(".codex", path)

    def test_jsonl_fallback_when_output_file_empty(self):
        FakePopen.output_text = ""
        FakePopen.stdout_text = (
            '{"type": "thread.started"}\n'
            '{"type": "agent_message", "message": "from jsonl"}\n'
        )
        result, _ = self._run_chat()
        self.assertEqual(result["choices"][0]["message"]["content"], "from jsonl")

    def test_jsonl_usage_is_recorded(self):
        FakePopen.output_text = "done"
        FakePopen.stdout_text = (
            '{"type": "token_count", "usage": {"prompt_tokens": 10, '
            '"completion_tokens": 5, "total_tokens": 15}}\n'
        )
        result, _ = self._run_chat()
        self.assertEqual(result["usage"]["total_tokens"], 15)

    def test_empty_output_is_parse_error(self):
        FakePopen.output_text = ""
        FakePopen.stdout_text = ""
        with self.assertRaises(ProviderError) as ctx:
            self._run_chat()
        self.assertEqual(ctx.exception.kind, "parse")

    def test_nonzero_exit_classified(self):
        cases = [
            ("Error: not logged in", "auth"),
            ("Error: usage limit reached", "quota"),
            ("Error: rate limit exceeded", "rate_limit"),
            ("Error: something broke", "unknown"),
        ]
        for stderr, kind in cases:
            with self.subTest(stderr=stderr):
                FakePopen.returncode = 1
                FakePopen.stderr_text = stderr
                FakePopen.output_text = ""
                FakePopen.stdout_text = ""
                with self.assertRaises(ProviderError) as ctx:
                    self._run_chat()
                self.assertEqual(ctx.exception.kind, kind)
                FakePopen.returncode = 0
                FakePopen.stderr_text = ""

    @unittest.skipUnless(hasattr(os, "killpg"), "process groups are POSIX-only")
    def test_timeout_kills_process_group(self):
        FakePopen.raise_timeout = True
        with (
            mock.patch(
                "nyra.providers._find_codex_binary",
                return_value="/fake/codex",
            ),
            mock.patch("nyra.providers._codex_available", return_value=True),
            mock.patch("nyra.providers.subprocess.Popen", FakePopen),
            mock.patch.object(os, "killpg") as killpg,
        ):
            with self.assertRaises(ProviderError) as ctx:
                self.provider.chat([{"role": "user", "content": "hi"}], timeout=5)
            self.assertEqual(ctx.exception.kind, "timeout")
            killpg.assert_called_once()

    def test_list_models(self):
        self.assertEqual(self.provider.list_models(), ["codex-default"])


class CodexErrorClassificationTests(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(_classify_codex_error("Not logged in"), "auth")
        self.assertEqual(
            _classify_codex_error("You have hit your weekly limit"), "quota"
        )
        self.assertEqual(_classify_codex_error("429 Too Many Requests"), "rate_limit")
        self.assertEqual(
            _classify_codex_error("connection reset by peer"), "network"
        )
        self.assertEqual(
            _classify_codex_error(
                "The 'gpt-5' model is not supported when using Codex "
                "with a ChatGPT account. (model_not_found)"
            ),
            "config",
        )
        self.assertEqual(_classify_codex_error("weird failure"), "unknown")


class CodexFallbackExclusionTests(unittest.TestCase):
    def test_codex_primary_has_no_fallback(self):
        chain = resolve_fallback_chain(
            "codex",
            config={
                "fallback_enabled": True,
                "fallback_providers": ["deepseek", "xai", "ollama"],
            },
        )
        self.assertEqual(chain, ["codex"])

    def test_codex_never_a_fallback_target(self):
        chain = resolve_fallback_chain(
            "deepseek",
            config={
                "fallback_enabled": True,
                "fallback_providers": ["codex", "xai"],
            },
        )
        self.assertNotIn("codex", chain)
        self.assertIn("xai", chain)

    def test_build_chain_dispatches_cli_primary_alone(self):
        provider = build_provider_chain(resolve_provider("codex"), ["codex"])
        self.assertIsInstance(provider, CliProvider)
        self.assertEqual(provider.name, "codex")

    def test_build_chain_skips_cli_candidates(self):
        def fake_resolver(name):
            if name == "codex":
                return resolve_provider("codex")
            return ProviderConfig(
                name=name,
                base_url=f"https://{name}.example.com/v1",
                model="m",
                api_key="sk-x",
                auth="env",
                connector_name=None,
                allowed_hosts=[],
            )

        provider = build_provider_chain(
            fake_resolver("deepseek"),
            ["deepseek", "codex", "xai"],
            provider_cls=Provider,
            resolver=fake_resolver,
        )
        self.assertIsInstance(provider, FallbackProvider)
        self.assertEqual(
            [p.name for p in provider.providers], ["deepseek", "xai"]
        )

    def test_direct_construction_refused(self):
        with self.assertRaises(ProviderError) as ctx:
            Provider(resolve_provider("codex"))
        self.assertEqual(ctx.exception.kind, "config")

    def test_scheduled_task_agent_refuses_codex(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ProviderError):
                _make_task_agent(
                    {"name": "t", "provider": "codex", "prompt": "hi"},
                    Path(tmp),
                )


class CodexPresetTests(unittest.TestCase):
    def test_preset_is_cli_auth_without_key(self):
        cfg = resolve_provider("codex")
        self.assertEqual(cfg.auth, "cli")
        self.assertIsNone(cfg.api_key)
        self.assertEqual(cfg.model, "codex-default")
        self.assertEqual(cfg.base_url, "cli://codex")

    def test_codex_resolves_without_api_key_env(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DEEPSEEK_API_KEY", None)
            cfg = resolve_provider("codex")
            self.assertEqual(cfg.name, "codex")


if __name__ == "__main__":
    unittest.main()
