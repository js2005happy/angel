"""OpenAI-compatible chat providers with environment and connector authentication."""

import json
import sys
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


class Provider:
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

        payload = {"model": self.model, "messages": messages}
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


def build_provider_chain(
    primary_cfg,
    chain_names,
    on_switch=None,
    *,
    provider_cls=None,
    resolver=None,
):
    """Build the provider for a run: plain Provider or FallbackProvider.

    `primary_cfg` is the resolved ProviderConfig for the primary provider;
    `chain_names` is the ordered provider names from resolve_fallback_chain
    (primary first). Fallback entries use their own default models. Unknown
    or unresolvable names are skipped; with a single provider left, the
    plain Provider is returned unchanged.

    `provider_cls` / `resolver` default to the real Provider /
    resolve_provider; callers pass their own namespace bindings so tests
    can substitute fakes.
    """
    provider_cls = provider_cls or Provider
    resolver = resolver or resolve_provider
    providers = [provider_cls(primary_cfg)]
    for name in chain_names[1:]:
        try:
            providers.append(provider_cls(resolver(name)))
        except (ValueError, ProviderError):
            continue
    if len(providers) == 1:
        return providers[0]
    return FallbackProvider(providers, on_switch=on_switch)
