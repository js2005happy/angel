"""Small urllib helpers shared by providers and tools.

本机地址（localhost、127.0.0.0/8、::1）的请求永远直连，不走 HTTP(S)_PROXY。
否则在设置了代理却没设置 NO_PROXY 的环境里（公司网络、CI、云端容器），
本地 Ollama、本地 MCP/HTTP 服务和测试用的本地服务器都会被转发到代理，
得到代理返回的 404/502 而不是本机服务的响应。
"""

import ipaddress
import urllib.parse
import urllib.request


def is_loopback_host(host: str | None) -> bool:
    """Return True when *host* names this machine's loopback interface."""
    if not host:
        return False
    host = host.strip().strip("[]").rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def is_loopback_url(url: str) -> bool:
    try:
        return is_loopback_host(urllib.parse.urlsplit(url).hostname)
    except ValueError:
        return False


def build_opener_for(url: str, *handlers: urllib.request.BaseHandler):
    """Build an opener that bypasses environment proxies for loopback URLs."""
    if is_loopback_url(url):
        handlers = (urllib.request.ProxyHandler({}),) + tuple(handlers)
    return urllib.request.build_opener(*handlers)


def open_url(request: urllib.request.Request, timeout: float, *handlers):
    """Like urllib.request.urlopen, but loopback requests never use a proxy."""
    scheme = urllib.parse.urlparse(request.full_url).scheme.lower()
    if scheme not in ("http", "https"):
        raise ValueError(f"只允许 http/https 链接，拒绝协议：{scheme or '空'}")
    return build_opener_for(request.full_url, *handlers).open(request, timeout=timeout)
