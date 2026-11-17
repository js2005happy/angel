"""本机请求绕过环境代理的回归测试（不联网，代理指向不可用端口）。"""

import http.server
import os
import threading
import unittest
import urllib.request
from unittest import mock

from nyra.net import build_opener_for, is_loopback_host, is_loopback_url, open_url


class _OkHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"local-ok"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


# 一个不会有人监听的代理地址：如果请求走了代理就会失败。
_DEAD_PROXY = {
    "HTTP_PROXY": "http://127.0.0.1:9",
    "http_proxy": "http://127.0.0.1:9",
    "HTTPS_PROXY": "http://127.0.0.1:9",
    "https_proxy": "http://127.0.0.1:9",
    "NO_PROXY": "",
    "no_proxy": "",
}


class LoopbackDetectionTest(unittest.TestCase):
    def test_loopback_hosts(self):
        for host in ["localhost", "LOCALHOST", "api.localhost", "127.0.0.1",
                     "127.1.2.3", "::1", "[::1]"]:
            self.assertTrue(is_loopback_host(host), host)

    def test_non_loopback_hosts(self):
        for host in [None, "", "example.com", "localhost.example.com",
                     "10.0.0.1", "192.168.1.1", "0.0.0.0", "128.0.0.1"]:
            self.assertFalse(is_loopback_host(host), host)

    def test_urls(self):
        self.assertTrue(is_loopback_url("http://localhost:11434/v1"))
        self.assertTrue(is_loopback_url("http://[::1]:8080/x"))
        self.assertFalse(is_loopback_url("https://api.deepseek.com/v1"))
        self.assertFalse(is_loopback_url("not a url"))
        self.assertFalse(is_loopback_url("http://[bad"))


class ProxyBypassTest(unittest.TestCase):
    def _proxy_handlers(self, opener):
        return [h for h in opener.handlers if isinstance(h, urllib.request.ProxyHandler)]

    def test_loopback_opener_has_no_proxies(self):
        with mock.patch.dict(os.environ, _DEAD_PROXY):
            opener = build_opener_for("http://127.0.0.1:11434/v1/chat/completions")
        for handler in self._proxy_handlers(opener):
            self.assertEqual(handler.proxies, {})

    def test_remote_opener_keeps_env_proxy(self):
        with mock.patch.dict(os.environ, _DEAD_PROXY):
            opener = build_opener_for("https://api.example.com/v1")
        proxies = [h.proxies for h in self._proxy_handlers(opener)]
        self.assertTrue(any(p.get("https") == "http://127.0.0.1:9" for p in proxies))

    def test_local_server_reachable_despite_dead_proxy(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _OkHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}/"
            with mock.patch.dict(os.environ, _DEAD_PROXY):
                with open_url(urllib.request.Request(url), 5) as response:
                    self.assertEqual(response.read(), b"local-ok")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
