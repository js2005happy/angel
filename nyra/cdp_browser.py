"""Chrome DevTools Protocol client over the stdlib WebSocket client.

让 Agent 像 Alma 那样操作自己的浏览器：打开网址、在页面里点元素、
截图。只连本机 Chrome（DevTools 的 ``/json`` 与 WebSocket 都只走
loopback），从不自动启动 Chrome——Chrome 没开就明确报错，让用户自己
用 ``chrome --remote-debugging-port=9222`` 启动。

连接是惰性的：``import nyra.tools`` 不会连 Chrome，第一个 browser_*
工具调用时才连，同一个会话里复用；会话结束时由
``nyra.tools.disconnect_browser`` 关闭。已知缺口：目前没有统一的
会话结束钩子（cli.py / agent.py / webui.py 都没有 teardown 回调），
所以断开只发生在显式调用 ``disconnect_browser`` 时；进程退出时
socket 随进程关闭。

只用标准库。所有方法在 Chrome 没开、目标消失或超时时都抛 CDPError，
绝不挂住。
"""

import base64
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from .net import open_url
from .websocket import WebSocketClient, WebSocketError

DEFAULT_PORT = 9222
CONNECT_TIMEOUT = 10.0
CALL_TIMEOUT = 30.0
LOAD_WAIT_TIMEOUT = 10.0

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


class CDPError(Exception):
    """Raised when Chrome is not reachable or a CDP command fails."""


class CDPBrowser:
    """A thin CDP client: one page target, request/response over WebSocket."""

    def __init__(self, ws_url: str | None = None, transport=None,
                 timeout: float = CALL_TIMEOUT):
        self.ws_url = ws_url
        self._ws = transport
        self._timeout = timeout
        self._next_id = 1
        self._closed = False

    # ---- connection ----

    @classmethod
    def connect(cls, ws_url: str, timeout: float = CONNECT_TIMEOUT) -> "CDPBrowser":
        parsed = urllib.parse.urlparse(ws_url)
        host = (parsed.hostname or "").lower()
        if parsed.scheme not in ("ws", "wss") or host not in _LOOPBACK_HOSTS:
            raise CDPError("只允许连接本机 Chrome（ws://127.0.0.1/...）")
        ws = WebSocketClient(ws_url, timeout=timeout)
        try:
            ws.connect()
        except WebSocketError as exc:
            raise CDPError(f"连接 Chrome 失败：{exc}") from exc
        return cls(ws_url, transport=ws, timeout=timeout)

    @classmethod
    def connect_to_chrome(cls, port: int = DEFAULT_PORT,
                          timeout: float = CONNECT_TIMEOUT) -> "CDPBrowser":
        """Find the first page target on the local Chrome and connect to it."""
        try:
            # Loopback must bypass any HTTP(S)_PROXY, exactly like the
            # other local services (see nyra/net.py): a plain urlopen
            # would forward http://127.0.0.1 to the proxy and report
            # "no Chrome" on proxied networks.
            request = urllib.request.Request(f"http://127.0.0.1:{port}/json")
            with open_url(request, timeout=timeout) as response:
                targets = json.loads(response.read().decode("utf-8", "replace"))
        except urllib.error.URLError as exc:
            raise CDPError(
                f"未检测到本机 Chrome（http://127.0.0.1:{port}/json 无法访问）。"
                f"请先用 chrome --remote-debugging-port={port} 启动 Chrome。"
            ) from exc
        except (ValueError, OSError) as exc:
            raise CDPError(f"读取 Chrome 目标列表失败：{exc}") from exc
        if not isinstance(targets, list):
            raise CDPError("Chrome 目标列表格式异常")
        for target in targets:
            if not isinstance(target, dict):
                continue
            ws_url = target.get("webSocketDebuggerUrl")
            if target.get("type") == "page" and ws_url:
                return cls.connect(ws_url, timeout=timeout)
        raise CDPError("Chrome 正在运行，但没有可用的页面目标（请先打开一个标签页）")

    # ---- low-level call ----

    def call(self, method: str, params: dict | None = None,
             timeout: float | None = None) -> dict:
        """Send one CDP command and return its ``result`` dict.

        Events arriving meanwhile are skipped; a CDP ``error`` or a
        timeout raises CDPError instead of hanging.
        """
        if self._ws is None or self._closed:
            raise CDPError("浏览器连接已关闭")
        msg_id = self._next_id
        self._next_id += 1
        payload = {"id": msg_id, "method": method, "params": params or {}}
        try:
            self._ws.send_text(json.dumps(payload))
        except WebSocketError as exc:
            raise CDPError(f"发送 CDP 命令失败：{exc}") from exc
        deadline = time.monotonic() + (timeout if timeout is not None else self._timeout)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CDPError(f"Chrome 未响应（{method} 超时）")
            try:
                raw = self._ws.recv_text(timeout=remaining)
            except WebSocketError as exc:
                raise CDPError(f"等待 Chrome 响应失败：{exc}") from exc
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(message, dict) or message.get("id") != msg_id:
                continue  # an event, or another call's response
            if "error" in message:
                error = message["error"]
                detail = error.get("message", error) if isinstance(error, dict) else error
                raise CDPError(f"CDP 错误 {method}：{detail}")
            result = message.get("result")
            return result if isinstance(result, dict) else {}

    def _wait_for_event(self, method: str, timeout: float) -> bool:
        """Read messages until the named event arrives or the timeout hits."""
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            try:
                raw = self._ws.recv_text(timeout=remaining)
            except WebSocketError:
                return False
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if isinstance(message, dict) and message.get("method") == method:
                return True

    # ---- page actions ----

    def navigate(self, url: str) -> str:
        """Open *url* in the page; returns the frame id.

        Only http/https URLs. Waits up to LOAD_WAIT_TIMEOUT for the page
        load event, then returns anyway — a slow page must not hang the
        agent; the caller reads whatever text is available.
        """
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise CDPError(f"只支持打开 http/https 网址：{url}")
        self.call("Page.enable")
        result = self.call("Page.navigate", {"url": url})
        self._wait_for_event("Page.loadEventFired", LOAD_WAIT_TIMEOUT)
        return result.get("frameId", "")

    def evaluate(self, expression: str, timeout: float | None = None):
        """Run JS in the page; return its value, or raise with the JS error."""
        result = self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
            timeout=timeout,
        )
        if "exceptionDetails" in result:
            details = result["exceptionDetails"]
            exception = details.get("exception") or {}
            text = (
                exception.get("description")
                or details.get("text")
                or "JS 执行失败"
            )
            raise CDPError(f"页面 JS 报错：{text}")
        value = result.get("result", {})
        if isinstance(value, dict) and value.get("subtype") == "error":
            raise CDPError(f"页面 JS 报错：{value.get('description', 'JS 错误')}")
        if isinstance(value, dict):
            return value.get("value")
        return None

    def click(self, selector: str) -> str:
        """Click the element matching *selector*; raises if it is not found."""
        expression = (
            "(function(){var el=document.querySelector("
            + json.dumps(selector)
            + "); if(!el) return 'NOT_FOUND'; el.click(); return 'OK';})()"
        )
        outcome = self.evaluate(expression)
        if outcome == "NOT_FOUND":
            raise CDPError(f"未找到元素：{selector}")
        return f"已点击：{selector}"

    def screenshot(self) -> bytes:
        """Capture the current viewport as PNG bytes."""
        result = self.call("Page.captureScreenshot", {"format": "png"})
        data = result.get("data")
        if not data:
            raise CDPError("截图失败：Chrome 未返回图片数据")
        try:
            raw = base64.b64decode(data, validate=True)
        except Exception as exc:
            raise CDPError(f"截图数据无法解码：{exc}") from exc
        if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise CDPError("截图失败：Chrome 返回的不是 PNG 数据")
        return raw

    def title(self) -> str:
        return str(self.evaluate("document.title") or "")

    def current_url(self) -> str:
        return str(self.evaluate("window.location.href") or "")

    def visible_text(self, limit: int = 8000) -> str:
        """Visible page text (innerText), truncated to *limit* characters."""
        text = self.evaluate(
            "document.body ? document.body.innerText.slice(0, "
            + str(int(limit))
            + ") : ''"
        )
        return str(text or "")

    def close(self) -> None:
        """Close the WebSocket. Idempotent."""
        if self._closed:
            return
        self._closed = True
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False
