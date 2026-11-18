"""OpenAI-compatible chat providers with environment and connector authentication."""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

from .config import ProviderConfig, plaintext_http_error, resolve_provider
from .net import build_opener_for


class ProviderError(Exception):
    """Model API failure with a machine-readable kind for fallback decisions.

    `status` is the HTTP status code when the failure came from an HTTP
    response, otherwise None. `kind` is one of: auth, quota, rate_limit,
    server, client, timeout, network, config, parse, redirect, unknown.
    Only quota / rate_limit / server / timeout / network are recoverable:
    those mean the same request may succeed on another provider. Auth
    failures (401/403) and local configuration problems never trigger a
    fallback, because switching models cannot fix them.
    """

    RECOVERABLE_KINDS = ("quota", "rate_limit", "server", "timeout", "network")

    def __init__(self, message, *, status=None, kind="unknown"):
        super().__init__(message)
        self.status = status
        self.kind = kind

    @property
    def recoverable(self):
        return self.kind in self.RECOVERABLE_KINDS


def is_recoverable_provider_error(exc):
    """True when a provider failure is worth retrying on another provider."""
    return isinstance(exc, ProviderError) and exc.recoverable


def _kind_for_status(code: int) -> str:
    """Map an HTTP status code to a ProviderError kind."""
    if code in (401, 403):
        return "auth"
    if code == 402:
        return "quota"
    if code == 429:
        return "rate_limit"
    if 500 <= code < 600:
        return "server"
    if 400 <= code < 500:
        return "client"
    return "server"


def _http_error(code: int, body: str, action: str = "API 请求") -> ProviderError:
    """Build a ProviderError for a failed HTTP response (body already redacted)."""
    kind = _kind_for_status(code)
    if kind == "auth":
        message = (
            f"认证失败 (HTTP {code})：API Key 无效或无权限，请检查凭证。"
            f"详情：{body}"
        )
    elif kind == "quota":
        message = f"余额不足 (HTTP 402)：请充值后再试。详情：{body}"
    elif kind == "rate_limit":
        message = f"请求过于频繁 (HTTP 429)：请稍后再试。详情：{body}"
    else:
        message = f"{action}失败 (HTTP {code})：{body}"
    return ProviderError(message, status=code, kind=kind)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProviderError("API 请求被重定向，已拒绝", kind="redirect")


_surrogate: object | None = None


def _load_surrogate() -> object:
    global _surrogate

    if _surrogate is None:
        try:
            sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
            from dynamic_credentials import add_surrogate_to_request

            _surrogate = add_surrogate_to_request
        except Exception:
            raise ProviderError(
                "无法加载已保存的连接器凭证，请设置环境变量 API Key 后重试"
            ) from None

    return _surrogate


def _normalize_messages(messages: list[dict]) -> list[dict]:
    """Normalize chat messages for the OpenAI-compatible chat API.

    ``str`` content goes out unchanged. A ``list`` of content parts
    (OpenAI shape, e.g. ``[{"type": "text", "text": ...},
    {"type": "image_url", ...}]`` as built by ``nyra.vision``) is
    passed through unchanged so a vision model can receive
    screenshots; malformed parts (not a dict, or no "type") are
    dropped rather than sent to the API. Anything else is coerced
    to ``str``. The Codex CLI path is text-only and flattens parts
    separately in ``_serialize_codex_prompt``.
    """
    normalized: list[dict] = []
    for message in messages:
        if not isinstance(message, dict):
            normalized.append(message)
            continue
        content = message.get("content")
        if isinstance(content, list):
            parts = [
                part for part in content
                if isinstance(part, dict) and "type" in part
            ]
            item = dict(message)
            item["content"] = parts
            normalized.append(item)
        elif isinstance(content, str) or content is None:
            normalized.append(message)
        else:
            item = dict(message)
            item["content"] = str(content)
            normalized.append(item)
    return normalized


class Provider:
    def __new__(cls, cfg=None, *args, **kwargs):
        # CLI provider（Codex）禁止直接构造：全仓库唯一的直接
        # Provider() 调用点是 cli._make_task_agent（定时任务），而 CLI
        # provider 绝不能在定时任务与队列里跑。直接构造遇到 CLI 配置
        # 时明确拒绝，而不是悄悄跑起来；交互使用请走
        # build_provider_chain，它会把 CLI 配置分派给 CliProvider。
        if (
            cls is Provider
            and cfg is not None
            and getattr(cfg, "auth", None) == "cli"
        ):
            raise ProviderError(
                "Codex CLI provider 不能直接构造：定时任务与队列不得使用 "
                "CLI provider；交互使用请走 build_provider_chain 显式选用 "
                "--provider codex",
                kind="config",
            )
        return super().__new__(cls)

    def __init__(self, cfg: ProviderConfig) -> None:
        self.name = cfg.name
        self.base_url = cfg.base_url.rstrip("/")
        self.model = cfg.model
        self.api_key = cfg.api_key
        self.auth = cfg.auth
        self.connector_name = cfg.connector_name
        self.allowed_hosts = cfg.allowed_hosts

    def has_credentials(self) -> bool:
        try:
            if self.auth == "none":
                return True
            if self.api_key is not None:
                return True
            if self.auth == "connector":
                _load_surrogate()
                return True
            return False
        except Exception:
            return False

    def _redact(
        self,
        text: str,
        request: urllib.request.Request | None = None,
    ) -> str:
        secrets: set[str] = set()
        if self.api_key:
            secrets.add(self.api_key)

        if request is not None:
            for name, value in request.header_items():
                if name.lower() == "authorization" and value:
                    secrets.add(value)
                    parts = value.split(None, 1)
                    if len(parts) == 2 and parts[1]:
                        secrets.add(parts[1])

        for secret in sorted(secrets, key=len, reverse=True):
            text = text.replace(secret, "[已隐藏]")
        return text

    def _apply_auth(self, request: urllib.request.Request) -> None:
        """Add the Authorization header for this provider's auth method.

        Raises ProviderError(kind="config") when the key is missing or
        the connector cannot be used. Shared by chat() and list_models().
        """
        if self.auth == "env":
            if self.api_key is None:
                name = self._redact(self.name)
                raise ProviderError(
                    f"provider {name} 未设置 API Key，请设置对应的环境变量 API Key 后重试",
                    kind="config",
                )
            request.add_header("Authorization", f"Bearer {self.api_key}")
        elif self.auth == "connector":
            if self.connector_name is None:
                raise ProviderError("该 provider 未配置连接器凭证", kind="config")
            add_surrogate_to_request = _load_surrogate()
            try:
                add_surrogate_to_request(
                    request,
                    self.connector_name,
                    allowed_hosts=self.allowed_hosts,
                )
            except Exception:
                raise ProviderError(
                    "无法使用已保存的连接器凭证，请检查连接器配置或设置环境变量 API Key 后重试",
                    kind="config",
                ) from None
        elif self.auth == "none":
            pass
        else:
            raise ProviderError("该 provider 的认证方式无效", kind="config")

    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        timeout: float = 120.0,
    ) -> dict:
        # 第二道防线：哪怕绕过配置解析直接构造了 Provider，也绝不能把
        # Key 用明文 http 发往外网。配置错误不兜底，直接抛出。
        err = plaintext_http_error(self.name, self.base_url)
        if err is not None:
            raise ProviderError(err, kind="config")

        payload = {"model": self.model, "messages": _normalize_messages(messages)}
        if tools is not None:
            payload["tools"] = tools

        request = urllib.request.Request(
            self.base_url + "/chat/completions",
            method="POST",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )

        self._apply_auth(request)

        try:
            with build_opener_for(request.full_url, _NoRedirect()).open(
                request, timeout=timeout
            ) as response:
                raw_body = response.read()

            try:
                result = json.loads(raw_body)
            except (ValueError, UnicodeError):
                raise ProviderError("API 返回了无法解析的响应", kind="parse") from None

            if not isinstance(result, dict):
                raise ProviderError("API 返回了无法解析的响应", kind="parse")
            return result

        except urllib.error.HTTPError as exc:
            try:
                body = exc.read().decode("utf-8", errors="replace")
            finally:
                exc.close()
            body = self._redact(body, request)[:1000]
            raise _http_error(exc.code, body) from None

        except urllib.error.URLError as exc:
            # socket.timeout is an alias of TimeoutError in Python 3.12.
            if isinstance(exc.reason, TimeoutError):
                raise ProviderError("API 请求超时，请稍后重试", kind="timeout") from None
            message = self._redact(
                f"网络错误，无法连接到 {self.base_url}：{exc.reason}",
                request,
            )
            raise ProviderError(message, kind="network") from None

        except TimeoutError:
            raise ProviderError("API 请求超时，请稍后重试", kind="timeout") from None

    def list_models(self, timeout: float = 30.0) -> list[str]:
        """Return model ids from GET {base_url}/models (OpenAI shape).

        Works for any OpenAI-compatible endpoint (including local
        Ollama). Raises ProviderError with the same error kinds as
        chat(): auth failures are not recoverable, quota / rate limit /
        server / timeout / network errors are. A response without a
        `data` list, or entries without a string `id`, is a parse error.
        """
        # 与 chat() 同一道防线：发请求前先拒绝明文 http 外网地址。
        err = plaintext_http_error(self.name, self.base_url)
        if err is not None:
            raise ProviderError(err, kind="config")

        request = urllib.request.Request(
            self.base_url + "/models",
            method="GET",
            headers={"Content-Type": "application/json"},
        )
        self._apply_auth(request)

        try:
            with build_opener_for(request.full_url, _NoRedirect()).open(
                request, timeout=timeout
            ) as response:
                raw_body = response.read()
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read().decode("utf-8", errors="replace")
            finally:
                exc.close()
            body = self._redact(body, request)[:1000]
            raise _http_error(exc.code, body, action="列出模型") from None
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, TimeoutError):
                raise ProviderError("API 请求超时，请稍后重试", kind="timeout") from None
            message = self._redact(
                f"网络错误，无法连接到 {self.base_url}：{exc.reason}",
                request,
            )
            raise ProviderError(message, kind="network") from None
        except TimeoutError:
            raise ProviderError("API 请求超时，请稍后重试", kind="timeout") from None

        try:
            result = json.loads(raw_body)
        except (ValueError, UnicodeError):
            raise ProviderError("API 返回了无法解析的响应", kind="parse") from None
        if not isinstance(result, dict) or not isinstance(result.get("data"), list):
            raise ProviderError("API 返回了无法解析的模型列表", kind="parse")
        models = []
        for item in result["data"]:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                models.append(item["id"])
        return models


# ---- Codex CLI provider: no API key, reuses the local CLI login ----
#
# Security conditions (enforced in code, not just documented):
#  1. The binary is resolved only from fixed locations
#     (_find_codex_binary); no path ever comes from configuration,
#     environment, or user input.
#  2. No credential is ever read, copied, or logged: availability is
#     checked only via `codex --version` / `codex login status`
#     (exit code + "Logged in" marker). The CLI authenticates from its
#     own home directory, which Nyra never touches.
#  3. The fixed argv never contains approval-skipping flags (see
#     _CODEX_FORBIDDEN_ARGS); the CLI runs with `-s read-only` in an
#     empty temp workdir, with browser/computer/plugins off.
#  4. This provider never enters a fallback chain and never runs in
#     scheduled tasks or queues: resolve_fallback_chain and
#     build_provider_chain skip CLI providers, and direct Provider()
#     construction refuses CLI configs (the only direct construction
#     site is the scheduled-task path).
# The provider is used as a text model only: `tools` are ignored and
# tool schemas are never passed to the CLI.

CODEX_PROMPT_PREFIX = (
    "You are Nyra, a text-only assistant. Reply in the user's language, "
    "concisely and directly. Do not call tools, run commands, browse the "
    "web, or modify files. Answer with text only.\n\n"
)
"""Fixed prompt prefix for Codex CLI calls.

Byte-identical at the start of every Codex request: the leading bytes
of the prompt never change, so a provider-side prefix cache can match
and reuse the cached prefix instead of reprocessing it. The rest of
the prompt (the serialized conversation) varies per call, so only the
prefix itself is cacheable — the benefit is bounded to these bytes.
The prefix also states the model-only constraint in plain text.
"""

CODEX_MIN_VERSION = (0, 164, 0)

# CLI 默认模型哨兵：模型名是它时不传 -m，让 codex 用自己的默认模型。
# 实测：ChatGPT 订阅登录时 -m gpt-5 / -m gpt-5-codex 都会被服务端以
# model_not_found 拒绝，唯有不传 -m 能跑通。
CODEX_DEFAULT_MODEL = "codex-default"
"""Lowest Codex CLI version this provider accepts (the version whose
--json / -o / --ephemeral / --skip-git-repo-check flags were verified
on this machine). Older versions are refused with a clear upgrade
message, never silently run with missing flags."""

_CODEX_FORBIDDEN_ARGS = frozenset(
    {
        "--dangerously-bypass-approvals-and-sandbox",
        "--approve-for-me",
        "--dangerously-bypass-hook-trust",
        "-y",
        "--full-auto",
    }
)
"""Arguments that must never be passed to the Codex CLI: they skip
approval prompts or sandboxing. The fixed argv is built in
CliProvider.chat(); tests assert none of these appear in it."""

_CODEX_BINARY_CANDIDATES = (
    "/opt/hatch-image/bin/codex",
    os.path.expanduser("~/.local/bin/codex"),
    "/usr/local/bin/codex",
    "/usr/bin/codex",
)
"""Fixed locations the Codex binary is resolved from, in order (POSIX).
Windows candidates are appended at import time below. No path is ever
taken from configuration, environment, or user input."""

if os.name == "nt":
    _CODEX_BINARY_CANDIDATES += (
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Codex\codex.exe"),
        os.path.expandvars(r"%APPDATA%\npm\codex.cmd"),
    )

_codex_binary_cache: str | None = None
_codex_binary_checked = False
_codex_available_cache: bool | None = None


def _reset_codex_cache() -> None:
    """Forget cached Codex binary/version/login results (tests only)."""
    global _codex_binary_cache, _codex_binary_checked, _codex_available_cache
    _codex_binary_cache = None
    _codex_binary_checked = False
    _codex_available_cache = None


def _find_codex_binary() -> str:
    """Resolve the Codex binary from fixed locations (never from config).

    Checks the fixed candidate paths first, then the OS PATH lookup as
    a last resort for machines where the install path varies (e.g. the
    user's Windows computer). The path never comes from configuration,
    environment variables, or user input, so a crafted config or prompt
    cannot point Nyra at an arbitrary executable. Raises
    ProviderError(kind="config") when no Codex CLI is found.
    """
    global _codex_binary_cache, _codex_binary_checked
    if _codex_binary_checked:
        if _codex_binary_cache is None:
            raise ProviderError(
                "未找到 Codex CLI，请先安装 Codex 后重试", kind="config"
            )
        return _codex_binary_cache
    _codex_binary_checked = True
    for candidate in _CODEX_BINARY_CANDIDATES:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            _codex_binary_cache = candidate
            return candidate
    found = shutil.which("codex")
    if found:
        _codex_binary_cache = found
        return found
    raise ProviderError("未找到 Codex CLI，请先安装 Codex 后重试", kind="config")


def _parse_codex_version(text: str) -> tuple[int, int, int] | None:
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    if not match:
        return None
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def _codex_available() -> bool:
    """True when the Codex CLI exists, is new enough, and is logged in.

    Runs `codex --version` (parses the version, refuses below
    CODEX_MIN_VERSION) and `codex login status` (requires exit 0 and
    "Logged in" in the output — the CLI prints that marker to stderr).
    Only the exit code and that marker are read; no credential file is
    ever opened, copied, or logged.
    """
    global _codex_available_cache
    if _codex_available_cache is not None:
        return _codex_available_cache
    ok = False
    try:
        binary = _find_codex_binary()
        version = subprocess.run(
            [binary, "--version"], capture_output=True, text=True, timeout=30
        )
        parsed = _parse_codex_version(version.stdout or "")
        if (
            version.returncode == 0
            and parsed is not None
            and parsed >= CODEX_MIN_VERSION
        ):
            login = subprocess.run(
                [binary, "login", "status"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            login_text = (login.stdout or "") + (login.stderr or "")
            ok = login.returncode == 0 and "Logged in" in login_text
    except (OSError, subprocess.SubprocessError, ProviderError):
        ok = False
    _codex_available_cache = ok
    return ok


def _serialize_codex_prompt(messages: list[dict]) -> str:
    """Serialize chat messages into one prompt, after the fixed prefix.

    The fixed prefix is byte-identical at the very start of every
    request (see CODEX_PROMPT_PREFIX); the conversation follows with
    role markers. Tool schemas are never included: the CLI is used as
    a text model only.
    """
    parts = [CODEX_PROMPT_PREFIX]
    for message in messages or []:
        role = str(message.get("role", "user"))
        content = message.get("content")
        if isinstance(content, list):
            content = "\n".join(
                str(part.get("text", ""))
                for part in content
                if isinstance(part, dict)
            )
        elif content is None:
            content = ""
        else:
            content = str(content)
        parts.append(f"[{role}]\n{content}\n")
    return "\n".join(parts)


_CODEX_AUTH_MARKERS = (
    "not logged in",
    "login required",
    "authentication",
    "unauthorized",
    "invalid api key",
)
_CODEX_QUOTA_MARKERS = (
    "usage limit",
    "out of credits",
    "credits exhausted",
    "quota exceeded",
    "weekly limit",
    "monthly limit",
    "usage credits",
)
_CODEX_RATE_MARKERS = ("rate limit", "rate_limit", "too many requests", "429")
_CODEX_CONFIG_MARKERS = (
    "model_not_found",
    "model is not supported",
    "unknown model",
)
_CODEX_NETWORK_MARKERS = (
    "network",
    "connection",
    "econnrefused",
    "dns",
    "econnreset",
    "broken pipe",
)


def _classify_codex_error(text: str) -> str:
    """Classify a Codex CLI failure message into a ProviderError kind.

    Auth/quota failures are terminal for the chain; unknown failures
    default to "unknown" (not recoverable) so a CLI failure never
    silently burns a paid API key on another provider. A model name the
    server rejects (model_not_found) is a config error: the model was
    explicitly requested and is not available to this login.
    """
    lowered = (text or "").lower()
    if any(marker in lowered for marker in _CODEX_AUTH_MARKERS):
        return "auth"
    if any(marker in lowered for marker in _CODEX_QUOTA_MARKERS):
        return "quota"
    if any(marker in lowered for marker in _CODEX_RATE_MARKERS):
        return "rate_limit"
    if any(marker in lowered for marker in _CODEX_CONFIG_MARKERS):
        return "config"
    if any(marker in lowered for marker in _CODEX_NETWORK_MARKERS):
        return "network"
    if "timed out" in lowered or "timeout" in lowered:
        return "timeout"
    return "unknown"


def _event_message_text(event: dict) -> str | None:
    event_type = str(event.get("type", ""))
    if "message" not in event_type and "text" not in event_type:
        return None
    for key in ("message", "text", "content"):
        value = event.get(key)
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, dict):
            nested = value.get("text") or value.get("content")
            if isinstance(nested, str) and nested.strip():
                return nested
    return None


def _last_message_from_jsonl(text: str) -> str | None:
    """Best-effort extraction of the last agent message from --json output.

    Tolerant by design: unknown event shapes are ignored, only the last
    non-empty message text is kept. Used when the -o output file is
    missing or empty; returns None when nothing usable was found.
    """
    last = None
    for line in (text or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        message_text = _event_message_text(event)
        if message_text:
            last = message_text
    return last


def _usage_from_jsonl(text: str) -> dict | None:
    """Best-effort extraction of token usage from --json output."""
    usage = None
    for line in (text or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        candidate = event.get("usage")
        if isinstance(candidate, dict):
            usage = candidate
    if not usage:
        return None
    out = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens",
                "input_tokens", "output_tokens"):
        value = usage.get(key)
        if isinstance(value, int):
            out[key] = value
    return out or None


_CODEX_CHILD_ENV_DROP_SUFFIXES = (
    "_API_KEY",
    "_TOKEN",
    "_SECRET",
    "_PASSWORD",
    "_CREDENTIAL",
    "_CREDENTIALS",
)
_CODEX_CHILD_ENV_DROP_EXACT = {"NYRA_VAULT_PASSWORD"}


def _codex_child_env() -> dict:
    """Minimal environment for the Codex child process.

    Drops every *_API_KEY so Nyra's keys never leak into the CLI
    subprocess; the CLI authenticates from its own login (CODEX_HOME),
    which Nyra never touches. Other credential-shaped variables
    (*_TOKEN / *_SECRET / *_PASSWORD / *_CREDENTIAL[S] and the vault
    password) are dropped too: the child has no use for them, and a
    *_TOKEN such as GITHUB_TOKEN is a credential just like a key.
    """
    env = dict(os.environ)
    for key in list(env):
        if key in _CODEX_CHILD_ENV_DROP_EXACT or key.endswith(
            _CODEX_CHILD_ENV_DROP_SUFFIXES
        ):
            del env[key]
    return env


def _kill_process_group(proc: subprocess.Popen) -> None:
    """Kill a Codex child process and its group (timeout path)."""
    try:
        if hasattr(os, "killpg"):
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except (OSError, ProcessLookupError):
        pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


class CliProvider(Provider):
    """A model provider backed by a local CLI (Codex), not an HTTP API.

    Reuses the CLI's own login and subscription, so no API key is
    needed. Only ever used when explicitly selected (``--provider
    codex``); never a fallback target, never in scheduled tasks or
    queues. See the section header above for the four enforced
    security conditions.
    """

    def has_credentials(self) -> bool:
        return _codex_available()

    def list_models(self, timeout: float = 30.0) -> list[str]:
        return [self.model]

    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        timeout: float = 120.0,
    ) -> dict:
        # tools are deliberately ignored: the CLI is a text model only,
        # and its tool schemas are never passed to it.
        binary = _find_codex_binary()
        if not _codex_available():
            minimum = ".".join(str(part) for part in CODEX_MIN_VERSION)
            raise ProviderError(
                "Codex CLI 未登录或版本过低，请先在 Codex 里登录并升级到 "
                f"{minimum} 或更高版本后重试",
                kind="config",
            )
        prompt = _serialize_codex_prompt(messages)
        workdir = tempfile.mkdtemp(prefix="nyra-codex-")
        output_file = os.path.join(workdir, "last_message.txt")
        argv = [
            binary,
            "exec",
            "--json",
            "-o",
            output_file,
            "-s",
            "read-only",
            "-C",
            workdir,
            "--ephemeral",
            "--skip-git-repo-check",
            "-c",
            "features.browser_use=false",
            "-c",
            "features.computer_use=false",
            "-c",
            "features.plugins=false",
        ]
        if self.model != CODEX_DEFAULT_MODEL:
            # Explicit model only: the default (codex-default) means
            # "let the CLI pick", because -m gpt-5 / -m gpt-5-codex are
            # rejected by the server for ChatGPT-account logins.
            argv[2:2] = ["-m", self.model]
        for arg in argv:
            if arg in _CODEX_FORBIDDEN_ARGS:
                raise ProviderError(
                    "Codex 调用包含禁用的审批跳过参数，已拒绝", kind="config"
                )
        try:
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=workdir,
                env=_codex_child_env(),
                start_new_session=True,
            )
        except OSError as exc:
            shutil.rmtree(workdir, ignore_errors=True)
            raise ProviderError(
                f"无法启动 Codex CLI：{exc}", kind="config"
            ) from None
        try:
            stdout, stderr = proc.communicate(input=prompt, timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_process_group(proc)
            shutil.rmtree(workdir, ignore_errors=True)
            raise ProviderError(
                "Codex CLI 调用超时，请稍后重试", kind="timeout"
            ) from None
        output_text = ""
        try:
            with open(output_file, encoding="utf-8") as handle:
                output_text = handle.read().strip()
        except OSError:
            output_text = ""
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
        if proc.returncode != 0:
            detail = (stderr or stdout or "")[:1000]
            kind = _classify_codex_error(detail)
            raise ProviderError(
                f"Codex CLI 调用失败（退出码 {proc.returncode}）：{detail}",
                kind=kind,
            )
        if not output_text:
            output_text = _last_message_from_jsonl(stdout) or ""
        if not output_text:
            raise ProviderError("Codex CLI 没有返回可用的回复", kind="parse")
        result: dict = {
            "choices": [
                {"message": {"role": "assistant", "content": output_text}}
            ],
            "model": self.model,
        }
        usage = _usage_from_jsonl(stdout)
        if usage:
            result["usage"] = usage
        return result


def describe_provider(provider: Provider) -> str:
    summary = provider._redact(
        f"{provider.name} / {provider.model} @ {provider.base_url}"
    )
    return " ".join(summary.splitlines())


class FallbackProvider:
    """Try providers in order; on a recoverable error, switch and retry.

    A drop-in replacement for Provider with the same chat() interface.
    Each chat() call starts from the first provider in the chain (the
    primary the user configured). When it fails with a recoverable error
    (402 quota, 429 rate limit, 5xx, timeout or network error), the call
    moves to the next provider and retries once there. Auth failures
    (401/403) and local configuration problems are raised immediately:
    switching models cannot fix them.

    Every switch is recorded in `switches` and reported through the
    optional `on_switch` callback, so the user always knows the model
    changed. `name` / `model` / `base_url` always describe the provider
    that answered last (or the primary before the first call).
    """

    def __init__(self, providers, on_switch=None):
        if not providers:
            raise ValueError("FallbackProvider needs at least one provider")
        self.providers = list(providers)
        self.on_switch = on_switch
        self.active_index = 0
        self.switches = []

    @property
    def name(self):
        return self.providers[self.active_index].name

    @property
    def model(self):
        return self.providers[self.active_index].model

    @property
    def base_url(self):
        return self.providers[self.active_index].base_url

    def _redact(self, text, request=None):
        return self.providers[self.active_index]._redact(text, request)

    def has_credentials(self):
        # The primary decides: a cached chain must report the same
        # credentials state before and after a switch, so callers that
        # gate on credentials (CLI, web UI) always see the configured
        # primary provider instead of whichever provider answered last.
        return self.providers[0].has_credentials()

    def list_models(self, timeout=30.0):
        return self.providers[self.active_index].list_models(timeout=timeout)

    def chat(self, messages, tools=None, timeout=120.0):
        attempted = []
        for index, provider in enumerate(self.providers):
            try:
                result = provider.chat(messages, tools=tools, timeout=timeout)
            except ProviderError as exc:
                attempted.append((provider.name, str(exc)))
                if not exc.recoverable:
                    raise
                if index + 1 >= len(self.providers):
                    break
                nxt = self.providers[index + 1]
                record = {
                    "from": provider.name,
                    "to": nxt.name,
                    "error": str(exc),
                    "kind": exc.kind,
                    "status": exc.status,
                }
                self.switches.append(record)
                self.active_index = index + 1
                if self.on_switch is not None:
                    self.on_switch(record)
                continue
            self.active_index = index
            return result
        detail = "；".join(f"{name}：{error}" for name, error in attempted)
        raise ProviderError(
            f"全部 {len(self.providers)} 个模型都失败了：{detail}",
            kind="unknown",
        )


class KeyRotatingProvider:
    """Try API keys of one provider+model in order; rotate on ANY failure.

    A drop-in replacement for Provider with the same chat() interface.
    Wraps already-constructed Provider instances that share one provider
    and model but carry different api_keys (one per group-chat bot, see
    nyra.groups.Bot.api_keys — keys are per-bot, never shared across
    bots). Unlike FallbackProvider, EVERY ProviderError triggers a
    rotation — including 401/403 auth failures, because a different key
    of the same model can fix auth, while switching models cannot.
    Each chat() call starts from the first key again. Every rotation is
    recorded in `switches` (same record shape as FallbackProvider, with
    from/to naming the key index, e.g. "deepseek key 1"). When all keys
    fail, the single ProviderError lists each attempt by key index only
    — never by key value — and keeps the last failure's kind/status so
    an outer FallbackProvider can still decide whether the failure is
    recoverable.
    """

    def __init__(self, providers, on_switch=None):
        if not providers:
            raise ValueError("KeyRotatingProvider needs at least one provider")
        self.providers = list(providers)
        self.on_switch = on_switch
        self.active_index = 0
        self.switches = []

    @property
    def name(self):
        return self.providers[self.active_index].name

    @property
    def model(self):
        return self.providers[self.active_index].model

    @property
    def base_url(self):
        return self.providers[self.active_index].base_url

    def _redact(self, text, request=None):
        return self.providers[self.active_index]._redact(text, request)

    def has_credentials(self):
        # The first key decides, mirroring FallbackProvider (the primary
        # decides) so callers gating on credentials see a stable answer.
        return self.providers[0].has_credentials()

    def list_models(self, timeout=30.0):
        return self.providers[self.active_index].list_models(timeout=timeout)

    def _label(self, index):
        return f"{self.providers[index].name} key {index + 1}"

    def _safe_error(self, provider, exc):
        """Error text with this provider's key redacted, if it leaked in.

        Real Providers already redact their own key in error bodies;
        this is the second line of defence, so a leaky server echo can
        never put a key into the aggregated error, the switch records
        or the server log (via on_switch).
        """
        text = str(exc)
        redact = getattr(provider, "_redact", None)
        if callable(redact):
            try:
                return redact(text)
            except Exception:
                return text
        return text

    def chat(self, messages, tools=None, timeout=120.0):
        attempted = []
        last_exc = None
        for index, provider in enumerate(self.providers):
            try:
                result = provider.chat(messages, tools=tools, timeout=timeout)
            except ProviderError as exc:
                safe_error = self._safe_error(provider, exc)
                attempted.append((index, safe_error))
                last_exc = exc
                if index + 1 >= len(self.providers):
                    break
                nxt = self.providers[index + 1]
                record = {
                    "from": self._label(index),
                    "to": self._label(index + 1),
                    "error": safe_error,
                    "kind": exc.kind,
                    "status": exc.status,
                }
                self.switches.append(record)
                self.active_index = index + 1
                if self.on_switch is not None:
                    self.on_switch(record)
                continue
            self.active_index = index
            return result
        detail = "；".join(
            f"key {index + 1}：{error}" for index, error in attempted
        )
        raise ProviderError(
            f"全部 {len(self.providers)} 个 API Key 都失败了：{detail}",
            kind=last_exc.kind if last_exc is not None else "unknown",
            status=last_exc.status if last_exc is not None else None,
        )


def build_provider_chain(
    primary_cfg,
    chain_names,
    on_switch=None,
    *,
    provider_cls=None,
    resolver=None,
    cli_provider_cls=None,
):
    """Build the provider for a run: plain Provider or FallbackProvider.

    `primary_cfg` is the resolved ProviderConfig for the primary provider;
    `chain_names` is the ordered provider names from resolve_fallback_chain
    (primary first). Fallback entries use their own default models. Unknown,
    unresolvable, or credential-less names are skipped and logged to
    stderr — nothing outside the allowlist is silently substituted in;
    with a single provider left, the plain Provider is returned unchanged.
    The primary itself is never skipped here: callers gate on its
    credentials before the first call.

    A CLI primary (Codex) never participates in fallback at all: it is
    returned alone, and CLI names in the chain are skipped. `provider_cls`
    / `resolver` / `cli_provider_cls` default to the real Provider /
    resolve_provider / CliProvider; callers pass their own namespace
    bindings so tests can substitute fakes.
    """
    provider_cls = provider_cls or Provider
    resolver = resolver or resolve_provider
    cli_provider_cls = cli_provider_cls or CliProvider
    if getattr(primary_cfg, "auth", None) == "cli":
        return cli_provider_cls(primary_cfg)
    providers = [provider_cls(primary_cfg)]
    for name in chain_names[1:]:
        try:
            candidate_cfg = resolver(name)
        except (ValueError, ProviderError) as exc:
            print(
                f"兜底允许列表里跳过了无法解析的 provider {name}：{exc}",
                file=sys.stderr,
            )
            continue
        if getattr(candidate_cfg, "auth", None) == "cli":
            print(
                f"兜底允许列表里跳过了 CLI provider {name}（不进兜底链）",
                file=sys.stderr,
            )
            continue
        try:
            candidate = provider_cls(candidate_cfg)
        except (ValueError, ProviderError) as exc:
            print(
                f"兜底允许列表里跳过了无法解析的 provider {name}：{exc}",
                file=sys.stderr,
            )
            continue
        has = getattr(candidate, "has_credentials", None)
        if callable(has) and not has():
            print(
                f"兜底允许列表里跳过了未配置 Key 的 provider {name}",
                file=sys.stderr,
            )
            continue
        providers.append(candidate)
    if len(providers) == 1:
        return providers[0]
    return FallbackProvider(providers, on_switch=on_switch)
