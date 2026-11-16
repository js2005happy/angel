"""OpenAI-compatible chat providers with environment and connector authentication."""

import json
import sys
import urllib.error
import urllib.request

from .config import ProviderConfig
from .net import build_opener_for


class ProviderError(Exception):
    def __init__(
        self,
        message: str,
        *,
        retryable: bool = False,
        status_code: int | None = None,
        failure_reason: str | None = None,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code
        self.failure_reason = failure_reason


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProviderError("API 请求被重定向，已拒绝")


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

    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        timeout: float = 120.0,
    ) -> dict:
        payload = {"model": self.model, "messages": messages}
        if tools is not None:
            payload["tools"] = tools

        request = urllib.request.Request(
            self.base_url + "/chat/completions",
            method="POST",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )

        if self.auth == "env":
            if self.api_key is None:
                name = self._redact(self.name)
                raise ProviderError(
                    f"provider {name} 未设置 API Key，请设置对应的环境变量 API Key 后重试"
                )
            request.add_header("Authorization", f"Bearer {self.api_key}")
        elif self.auth == "connector":
            if self.connector_name is None:
                raise ProviderError("该 provider 未配置连接器凭证")
            add_surrogate_to_request = _load_surrogate()
            try:
                add_surrogate_to_request(
                    request,
                    self.connector_name,
                    allowed_hosts=self.allowed_hosts,
                )
            except Exception:
                raise ProviderError(
                    "无法使用已保存的连接器凭证，请检查连接器配置或设置环境变量 API Key 后重试"
                ) from None
        elif self.auth == "none":
            pass
        else:
            raise ProviderError("该 provider 的认证方式无效")

        try:
            with build_opener_for(request.full_url, _NoRedirect()).open(
                request, timeout=timeout
            ) as response:
                raw_body = response.read()

            try:
                result = json.loads(raw_body)
            except (ValueError, UnicodeError):
                raise ProviderError("API 返回了无法解析的响应") from None

            if not isinstance(result, dict):
                raise ProviderError("API 返回了无法解析的响应")
            return result

        except urllib.error.HTTPError as exc:
            try:
                body = exc.read().decode("utf-8", errors="replace")
            finally:
                exc.close()
            body = self._redact(body, request)[:1000]

            if exc.code in (401, 403):
                message = (
                    f"认证失败 (HTTP {exc.code})："
                    f"API Key 无效或无权限，请检查凭证。详情：{body}"
                )
            elif exc.code == 402:
                message = f"余额不足 (HTTP 402)：请充值后再试。详情：{body}"
            elif exc.code == 429:
                message = f"请求过于频繁 (HTTP 429)：请稍后再试。详情：{body}"
            else:
                message = f"API 请求失败 (HTTP {exc.code})：{body}"
            retryable = exc.code in (402, 408, 425, 429) or 500 <= exc.code <= 599
            raise ProviderError(
                message,
                retryable=retryable,
                status_code=exc.code,
                failure_reason=f"HTTP {exc.code}",
            ) from None

        except urllib.error.URLError as exc:
            # socket.timeout is an alias of TimeoutError in Python 3.12.
            if isinstance(exc.reason, TimeoutError):
                raise ProviderError(
                    "API 请求超时，请稍后重试",
                    retryable=True,
                    failure_reason="timeout",
                ) from None
            message = self._redact(
                f"网络错误，无法连接到 {self.base_url}：{exc.reason}",
                request,
            )
            raise ProviderError(
                message, retryable=True, failure_reason="network error"
            ) from None

        except TimeoutError:
            raise ProviderError(
                "API 请求超时，请稍后重试",
                retryable=True,
                failure_reason="timeout",
            ) from None


class FallbackProvider:
    """Ordered, opt-in provider failover for transient API failures.

    Once a backup succeeds, it stays active for the rest of this provider
    instance. Permanent request/configuration errors never trigger failover.
    """

    def __init__(self, providers: list[Provider]) -> None:
        if len(providers) < 2:
            raise ValueError("FallbackProvider needs a primary and at least one backup")
        self.providers = list(providers)
        self.active_index = 0
        self._pending_fallback: dict | None = None

    @property
    def active(self) -> Provider:
        return self.providers[self.active_index]

    @property
    def name(self) -> str:
        return self.active.name

    @property
    def model(self) -> str:
        return self.active.model

    @property
    def base_url(self) -> str:
        return self.active.base_url

    def _redact(self, text: str, request=None) -> str:
        return self.active._redact(text, request)

    def has_credentials(self) -> bool:
        return self.providers[0].has_credentials()

    def consume_fallback_event(self) -> dict | None:
        event, self._pending_fallback = self._pending_fallback, None
        return event

    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        timeout: float = 120.0,
    ) -> dict:
        self._pending_fallback = None
        start = self.active_index
        failures: list[tuple[int, ProviderError]] = []
        for index in range(start, len(self.providers)):
            try:
                response = self.providers[index].chat(
                    messages, tools=tools, timeout=timeout
                )
            except ProviderError as exc:
                failures.append((index, exc))
                if not exc.retryable or index == len(self.providers) - 1:
                    break
                continue

            if index > start:
                self.active_index = index
                self._pending_fallback = {
                    "from_provider": self.providers[start].name,
                    "from_model": self.providers[start].model,
                    "to_provider": self.providers[index].name,
                    "to_model": self.providers[index].model,
                    "failed": [
                        {
                            "provider": self.providers[failed_index].name,
                            "model": self.providers[failed_index].model,
                            "reason": error.failure_reason or "transient error",
                        }
                        for failed_index, error in failures
                    ],
                }
            return response

        if len(failures) == 1:
            raise failures[0][1]
        details = "; ".join(
            f"{self.providers[index].name} / {self.providers[index].model}: {error}"
            for index, error in failures
        )
        last_error = failures[-1][1]
        raise ProviderError(
            "当前模型和已配置的备用模型均失败：" + details,
            retryable=last_error.retryable,
            status_code=last_error.status_code,
            failure_reason=last_error.failure_reason,
        ) from None


def build_provider(configs: list[ProviderConfig]) -> Provider | FallbackProvider:
    """Build one provider or an explicit ordered failover chain."""
    providers = [Provider(config) for config in configs]
    if len(providers) == 1:
        return providers[0]
    return FallbackProvider(providers)


def describe_provider(provider: Provider | FallbackProvider) -> str:
    summary = provider._redact(
        f"{provider.name} / {provider.model} @ {provider.base_url}"
    )
    summary = " ".join(summary.splitlines())
    if isinstance(provider, FallbackProvider):
        backups = provider.providers[provider.active_index + 1:]
        if backups:
            route = " → ".join(f"{item.name} / {item.model}" for item in backups)
            summary += f" · 故障兜底：{route}"
    return summary
