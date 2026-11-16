"""Poppy 1.0 OAuth issuer preflight: public metadata only, no account access.

Poppy 1.0 §3.2 requires two-sided issuer verification:
  company protected resource metadata -> selected issuer,
  issuer OAuth server metadata -> company protected resource.

This module NEVER performs sign-in, obtains tokens, creates JWTs, follows
metadata redirects, or invokes the advertised token/API endpoints.
"""

from __future__ import annotations

import json
from urllib.parse import urlsplit

from .poppy import (
    PoppyError, _checked_https, _fetch_public_https, discover_poppy,
)

PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource"
AUTH_SERVER_WELL_KNOWN = "/.well-known/oauth-authorization-server"
MAX_SCOPES = 100


class IdentityError(PoppyError):
    """Identity claim failed verification or metadata is unsafe/incomplete."""


def _metadata_json(body: bytes | None, label: str) -> dict:
    if body is None:
        raise IdentityError(f"{label} 不存在")
    try:
        def no_duplicates(pairs):
            result = {}
            for k, v in pairs:
                if k in result:
                    raise ValueError("duplicate JSON key")
                result[k] = v
            return result
        data = json.loads(body.decode("utf-8"), object_pairs_hook=no_duplicates)
    except (UnicodeError, ValueError) as exc:
        raise IdentityError(f"{label} 不是有效的、无重复键的 UTF-8 JSON") from exc
    if not isinstance(data, dict):
        raise IdentityError(f"{label} 必须为 JSON 对象")
    return data


def _exact_issuer(value: str) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise IdentityError("OAuth issuer 必须是有界 HTTPS URL")
    try:
        p = _checked_https(value)
    except PoppyError as exc:
        raise IdentityError(f"OAuth issuer URL 不安全：{exc}") from exc
    if p.query or p.fragment or (p.path and (p.path.startswith("//") or
                                              "/../" in p.path or "/./" in p.path)):
        raise IdentityError("OAuth issuer 不能包含 query、fragment 或路径穿越")
    return value


def _server_metadata_url(issuer: str) -> str:
    _exact_issuer(issuer)
    p = urlsplit(issuer)
    # RFC 8414 §3.1: insert the well-known path BEFORE any issuer path.
    suffix = p.path.rstrip("/")
    return "https://" + p.hostname + AUTH_SERVER_WELL_KNOWN + suffix


def _resource_match(value: object, domain: str) -> bool:
    """Poppy compares the canonical HTTPS origin with lowercase DNS host."""
    if not isinstance(value, str):
        return False
    try:
        p = _checked_https(value)
    except PoppyError:
        return False
    # Poppy §3.2 demands exactly the company HTTPS origin (no explicit
    # :443, trailing slash, query or path), allowing only host case-folding.
    return (value.lower() == "https://" + domain.lower()
            and not p.path and not p.query and p.hostname == domain)


def _endpoint(value: object, key: str) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise IdentityError(f"{key} 缺少 HTTPS 地址")
    try:
        p = _checked_https(value)
    except PoppyError as exc:
        raise IdentityError(f"{key} 地址无效：{exc}") from exc
    if p.query or p.fragment:
        raise IdentityError(f"{key} 不能含 query 或 fragment")
    return value


def _string_array(obj: dict, key: str, *, mandatory: bool = False) -> list[str]:
    value = obj.get(key)
    if value is None and not mandatory:
        return []
    if not isinstance(value, list) or len(value) > 100 or not all(
        isinstance(x, str) and 0 < len(x) <= 2048 for x in value
    ):
        raise IdentityError(f"{key} 必须是长度受限的字符串数组")
    return value


def _get_metadata(fetcher, url: str, *, allow_not_found: bool = False) -> bytes | None:
    # Never redirect when fetching issuer metadata, and never attach tokens.
    final, data = fetcher(url, allow_redirect=False, allow_not_found=allow_not_found)
    if final != url:
        raise IdentityError("OAuth 元数据禁止重定向")
    return data


def inspect_poppy_identity(site: str, *, discoverer=None, fetch=None) -> dict:
    """Verify company-to-issuer and issuer-to-company public trust linkage.

    The result describes *public issuer metadata*. It does not prove account
    ownership, consent, Session JWT validity or permission to invoke an API.
    Mockable discoverer/fetch are supplied by tests, never by model calls.
    """
    discoverer = discoverer or discover_poppy
    fetcher = fetch or _fetch_public_https
    company = discoverer(site)
    if company.get("version") != "1.0":
        raise IdentityError("当前只支持 Poppy 1.0")
    organization = company.get("organization")
    if not isinstance(organization, dict):
        raise IdentityError("Poppy 文件缺少公司身份")
    domain = organization.get("domain")
    if not isinstance(domain, str):
        raise IdentityError("公司域名无效")
    # Validate domain through the same public-DNS-name restrictions as Poppy.
    try:
        _checked_https("https://" + domain)
    except PoppyError as exc:
        raise IdentityError("Poppy 公司域名不安全") from exc
    resource = "https://" + domain
    hint = company.get("auth_issuer_hint")
    if hint is not None:
        _exact_issuer(hint)
    disabled = company.get("auth_disabled") is True

    metadata_url = resource + PROTECTED_RESOURCE_PATH
    protected_bytes = _get_metadata(fetcher, metadata_url, allow_not_found=True)
    if protected_bytes is None:
        if hint is not None:
            raise IdentityError("站点声明 auth.issuer，但资源元数据返回 404")
        return {
            "company": domain, "identifier": resource,
            "issuer": None, "issuer_link_verified": False,
            "status": "signed_out_metadata_only",
            "signed_in_available": False,
            "protected_resource_status": "not_found",
            "session_ready": False, "oauth_ready": False,
            "remote_calls_allowed": False,
        }

    protected = _metadata_json(protected_bytes, "受保护资源元数据")
    if not _resource_match(protected.get("resource"), domain):
        raise IdentityError("protected resource 的 resource 与公司域名不一致")
    servers = _string_array(protected, "authorization_servers")
    if len(servers) != len(set(servers)):
        raise IdentityError("authorization_servers 存在重复 issuer")
    for issuer in servers:
        _exact_issuer(issuer)
    if not servers:
        if hint is not None:
            raise IdentityError("auth.issuer 与空授权服务器列表冲突")
        return {
            "company": domain, "identifier": resource,
            "issuer": None, "issuer_link_verified": False,
            "status": "signed_out_metadata_only",
            "signed_in_available": False,
            "protected_resource_status": "valid_without_issuer",
            "session_ready": False, "oauth_ready": False,
            "remote_calls_allowed": False,
        }
    if len(servers) > 1 and hint is None:
        raise IdentityError("多个 authorization_servers 时必须有 auth.issuer")
    chosen = hint if hint is not None else servers[0]
    if chosen not in servers:
        raise IdentityError("auth.issuer 不在 authorization_servers 清单")
    issuer_url = _server_metadata_url(chosen)
    issuer_data = _metadata_json(
        _get_metadata(fetcher, issuer_url), "OAuth issuer 元数据"
    )
    if issuer_data.get("issuer") != chosen:
        raise IdentityError("OAuth issuer 元数据的 issuer 不完全匹配")
    resources = _string_array(issuer_data, "protected_resources", mandatory=True)
    if not any(_resource_match(item, domain) for item in resources):
        raise IdentityError("OAuth issuer 未将公司域名列入 protected_resources")
    _endpoint(issuer_data.get("token_endpoint"), "token_endpoint")
    _endpoint(issuer_data.get("revocation_endpoint"), "revocation_endpoint")
    grants = _string_array(issuer_data, "grant_types_supported", mandatory=True)
    if "refresh_token" not in grants:
        raise IdentityError("issuer 必须提供 refresh_token grant")
    direct = "authorization_code" in grants
    device = "urn:ietf:params:oauth:grant-type:device_code" in grants
    if direct:
        _endpoint(issuer_data.get("authorization_endpoint"),
                  "authorization_endpoint")
    if device:
        _endpoint(issuer_data.get("device_authorization_endpoint"),
                  "device_authorization_endpoint")
    scopes = sorted(set(
        _string_array(protected, "scopes_supported") +
        _string_array(issuer_data, "scopes_supported")
    ))
    if len(scopes) > MAX_SCOPES:
        scopes = scopes[:MAX_SCOPES]
    return {
        "company": domain, "identifier": chosen,
        "issuer": chosen, "issuer_link_verified": True,
        "status": "issuer_metadata_verified",
        "signed_in_available": not disabled,
        "sign_in_disabled_by_company": disabled,
        "sign_in_hints": {
            "direct": direct and not disabled,
            "device": device and not disabled,
        },
        "scopes_supported": scopes,
        "protected_resource_status": "valid_with_issuer",
        "session_ready": False, "oauth_ready": False,
        "remote_calls_allowed": False,
        "warning": (
            "只验证公开元数据双方的 issuer 归属；未注册 OAuth client，"
            "未完成用户登录、密钥委派、Poppy Session 签名或远端调用。"
        ),
    }
