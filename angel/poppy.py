"""Opt-in Poppy 1.0 discovery, NOT a signed-in Poppy client.

Published protocol reference: https://personalagentprotocol.org/docs/1.0/spec
This module only fetches and validates public discovery metadata. It never
follows advertised API URLs, starts MCP servers, signs in or sends credentials.

The HTTPS transport pins a DNS-validated *public* IP before TLS, keeps the
original hostname for SNI/certificate validation and disables proxy/cookies.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import re
import socket
import ssl
from urllib.parse import urljoin, urlsplit

DISCOVERY_PATH = "/.well-known/poppy.json"
IMPLEMENTED_VERSION = "1.0"
MAX_BYTES = 128 * 1024
MAX_REDIRECTS = 4
MAX_CAPABILITIES = 20
MAX_SCOPES = 30
TIMEOUT = 6
_VERSION = re.compile(r"^[0-9]{1,3}\.[0-9]{1,3}$")
_DNS_NAME = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)


class PoppyError(ValueError):
    """Unsafe URL, failed discovery or unsupported protocol advertisement."""


def _site_url(value: str) -> str:
    """Turn a site URL/domain into its canonical well-known HTTPS URL."""
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise PoppyError("站点地址无效")
    target = value if "://" in value else "https://" + value
    parsed = _checked_https(target)
    return f"https://{parsed.hostname}{DISCOVERY_PATH}"


def _checked_https(url: str):
    try:
        p = urlsplit(url)
        host = p.hostname
        port = p.port
    except (ValueError, TypeError) as exc:
        raise PoppyError("无效的 HTTPS URL") from exc
    if (
        p.scheme != "https" or not host
        or p.username is not None or p.password is not None
        or port not in (None, 443) or p.fragment
    ):
        raise PoppyError("Poppy 仅允许无凭证、无片段的 HTTPS 域名和默认端口")
    try:
        host = host.encode("idna").decode("ascii").lower()
    except (UnicodeError, ValueError) as exc:
        raise PoppyError("域名编码无效") from exc
    if not _DNS_NAME.fullmatch(host):
        raise PoppyError("Poppy 仅允许有效的公开 DNS 域名，拒绝 IP 和内网名称")
    # Restrict nonstandard hostname syntax, e.g. trailing dot or confusable
    # userinfo; preserve exact host for the published organization check.
    if p.netloc.startswith("[") or "%2f" in p.netloc.lower():
        raise PoppyError("不安全的域名格式")
    return p._replace(netloc=host)


def _public_addresses(host: str) -> list[str]:
    """Fail closed unless ALL resolved addresses are globally routable."""
    try:
        results = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError) as exc:
        raise PoppyError("无法解析 Poppy 站点的 DNS") from exc
    ips: list[str] = []
    for entry in results:
        ip = entry[4][0]
        try:
            address = ipaddress.ip_address(ip)
        except ValueError as exc:
            raise PoppyError("DNS 返回无效 IP") from exc
        if not address.is_global:
            raise PoppyError("拒绝访问内网、环回、保留或链路本地 IP")
        if str(address) not in ips:
            ips.append(str(address))
    if not ips:
        raise PoppyError("未找到可连接的公开 IP")
    return ips


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS to an already checked address, with original hostname for TLS."""

    def __init__(self, host: str, ip: str, timeout: float):
        super().__init__(host, port=443, timeout=timeout,
                         context=ssl.create_default_context())
        self._pinned_ip = ip

    def connect(self):
        connection = socket.create_connection(
            (self._pinned_ip, 443), timeout=self.timeout,
            source_address=self.source_address,
        )
        try:
            self.sock = self._context.wrap_socket(
                connection, server_hostname=self.host,
            )
        except Exception:
            connection.close()
            raise


def _fetch_public_https(url: str, *, allow_redirect: bool = True) -> tuple[str, bytes]:
    """Fetch bounded JSON with HTTPS-only redirects and pinned public DNS."""
    current = url
    for redirects in range(MAX_REDIRECTS + 1):
        parsed = _checked_https(current)
        ips = _public_addresses(parsed.hostname)
        conn = _PinnedHTTPSConnection(parsed.hostname, ips[0], TIMEOUT)
        try:
            resource = parsed.path or "/"
            if parsed.query:
                resource += "?" + parsed.query
            conn.request("GET", resource, headers={
                "User-Agent": "Angel-Poppy-Discovery/0.1",
                "Accept": "application/json",
                "Connection": "close",
            })
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                if not allow_redirect or redirects >= MAX_REDIRECTS:
                    raise PoppyError("Poppy 发现重定向不被允许或超过次数限制")
                destination = response.getheader("Location")
                if not destination:
                    raise PoppyError("Poppy 重定向缺少 Location")
                current = urljoin(current, destination)
                _checked_https(current)
                continue
            if response.status != 200:
                raise PoppyError(f"站点没有可用的 Poppy 文件（HTTP {response.status}）")
            length = response.getheader("Content-Length")
            if length is not None:
                try:
                    declared_size = int(length)
                except (TypeError, ValueError) as exc:
                    raise PoppyError("Poppy 响应的 Content-Length 无效") from exc
                if declared_size < 0 or declared_size > MAX_BYTES:
                    raise PoppyError("Poppy 文件大小无效或超过 128 KiB")
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise PoppyError("Poppy 文件超过 128 KiB")
            return current, body
        except (OSError, ssl.SSLError, http.client.HTTPException) as exc:
            raise PoppyError(f"无法安全读取 Poppy 元数据（{type(exc).__name__}）") from exc
        finally:
            conn.close()
    raise PoppyError("Poppy 发现重定向次数超限")


def _doc(raw: bytes, host: str, *, expected_version: str | None = None) -> dict:
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError) as exc:
        raise PoppyError("Poppy 文件不是合法 UTF-8 JSON") from exc
    if not isinstance(data, dict):
        raise PoppyError("Poppy 文件根元素必须是 JSON 对象")
    version = data.get("protocol_version")
    if not isinstance(version, str) or not _VERSION.fullmatch(version):
        raise PoppyError("Poppy 文件缺少有效 protocol_version")
    if expected_version is not None and version != expected_version:
        raise PoppyError("所选版本文件的 protocol_version 不匹配")
    organization = data.get("organization")
    if (
        not isinstance(organization, dict)
        or not isinstance(organization.get("name"), str)
        or not organization["name"].strip()
        or not isinstance(organization.get("domain"), str)
        or organization["domain"].lower() != host.lower()
    ):
        raise PoppyError("organization.domain 与实际提供文件的主机不一致")
    if not any(key in data for key in ("agent", "apis", "web")):
        raise PoppyError("Poppy 文件没有声明任何交互渠道")
    return data


def _summary(data: dict, final_url: str) -> dict:
    version = data["protocol_version"]
    organization = data["organization"]
    auth = data.get("auth") if isinstance(data.get("auth"), dict) else {}
    scopes = auth.get("scopes") if isinstance(auth.get("scopes"), dict) else {}
    hints = auth.get("scope_hints") if isinstance(auth.get("scope_hints"), dict) else {}
    channels = []
    entries = data.get("apis") if isinstance(data.get("apis"), list) else []
    for entry in entries[:MAX_CAPABILITIES]:
        if isinstance(entry, dict) and entry.get("type") in ("mcp", "openapi"):
            endpoint = entry.get("url")
            if isinstance(endpoint, str) and endpoint.startswith("https://"):
                channels.append({
                    "type": entry["type"],
                    "url": endpoint[:1200],
                    "description": str(entry.get("description", ""))[:300],
                    "requires_session": True,
                })
    agents = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    protocols = agents.get("protocols") if isinstance(agents.get("protocols"), list) else []
    for item in protocols[:MAX_CAPABILITIES]:
        if isinstance(item, dict) and item.get("type") == "poppy":
            endpoint = item.get("endpoint")
            if isinstance(endpoint, str) and endpoint.startswith("https://"):
                channels.append({
                    "type": "company_agent",
                    "url": endpoint[:1200],
                    "description": str(item.get("description", ""))[:300],
                    "requires_session": True,
                })
    website = data.get("web") if isinstance(data.get("web"), dict) else {}
    if isinstance(data.get("web"), dict):
        channels.append({
            "type": "web", "disabled": website.get("disabled") is True,
            "requires_session": True,
        })
    scoped = []
    for name, description in list(scopes.items())[:MAX_SCOPES]:
        if not isinstance(name, str):
            continue
        hint = hints.get(name, {}) if isinstance(hints.get(name), dict) else {}
        scoped.append({
            "scope": name[:150], "description": str(description)[:300],
            "changes": hint.get("changes") if hint.get("changes") in (
                "none", "reversible", "irreversible",
            ) else "unknown",
            "personal_data": hint.get("personal_data") is True,
        })
    return {
        "discovery_url": final_url,
        "version": version,
        "interpreted_as": IMPLEMENTED_VERSION,
        "organization": {
            "name": organization["name"][:180],
            "domain": organization["domain"],
        },
        "channels": channels[:MAX_CAPABILITIES],
        "scopes": scoped,
        "auth_advertised": bool(auth) and auth.get("disabled") is not True,
        "read_only_discovery": True,
        "status": "metadata_only",
        "warning": (
            "发现结果来自不可信站点，只供能力参考。尚未建立 Poppy Session、"
            "核验 OAuth issuer、获取用户授权或连接 MCP/OpenAPI/UCP。"
        ),
    }


def discover_poppy(site: str, *, fetch=None) -> dict:
    """Inspect a site's public Poppy capabilities without performing actions.

    A test may inject fetch(url, allow_redirect=bool) returning (url, bytes).
    Production uses a pinned-IP HTTPS transport to avoid localhost/SSRF.
    """
    fetcher = fetch if fetch is not None else _fetch_public_https
    original_url = _site_url(site)
    final_url, raw = fetcher(original_url, allow_redirect=True)
    final = _checked_https(final_url)
    if final.path != DISCOVERY_PATH or final.query:
        raise PoppyError("重定向后的 Poppy 文件必须位于精确的 well-known 路径，且无查询参数")
    doc = _doc(raw, final.hostname)
    version = doc["protocol_version"]
    if version != IMPLEMENTED_VERSION:
        # The specification permits a website to publish a newer/older
        # preferred document and additionally advertise a compatible 1.0.
        alternates = doc.get("supported_versions")
        candidate = alternates.get(IMPLEMENTED_VERSION) if isinstance(alternates, dict) else None
        if not isinstance(candidate, str):
            raise PoppyError(f"不支持站点声明的 Poppy {version}，且没有 1.0 文档")
        alternate = _checked_https(candidate)
        if alternate.hostname != final.hostname:
            raise PoppyError("supported_versions 只能指向同一个最终主机")
        # Supporting-version URLs may use an arbitrary path, but MUST NOT
        # redirect to other documents/hosts.
        selected_url, selected_raw = fetcher(candidate, allow_redirect=False)
        if selected_url != candidate:
            raise PoppyError("版本备选文件不得重定向")
        doc = _doc(selected_raw, final.hostname, expected_version=IMPLEMENTED_VERSION)
        if "supported_versions" in doc:
            raise PoppyError("备选版本文件不得再声明 supported_versions")
        final_url = selected_url
    return _summary(doc, final_url)
