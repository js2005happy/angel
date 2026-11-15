"""OpenAI-compatible chat providers with environment and connector authentication."""

import json
import sys
import urllib.error
import urllib.request

from .config import ProviderConfig


class ProviderError(Exception):
    pass


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
            with urllib.request.build_opener(_NoRedirect()).open(
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
            raise ProviderError(message) from None

        except urllib.error.URLError as exc:
            # socket.timeout is an alias of TimeoutError in Python 3.12.
            if isinstance(exc.reason, TimeoutError):
                raise ProviderError("API 请求超时，请稍后重试") from None
            message = self._redact(
                f"网络错误，无法连接到 {self.base_url}：{exc.reason}",
                request,
            )
            raise ProviderError(message) from None

        except TimeoutError:
            raise ProviderError("API 请求超时，请稍后重试") from None


def describe_provider(provider: Provider) -> str:
    summary = provider._redact(
        f"{provider.name} / {provider.model} @ {provider.base_url}"
    )
    return " ".join(summary.splitlines())
