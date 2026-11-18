"""Tests for pairing-code collaboration (nyra/pairing.py). All offline,
loopback only: no network access, no paid model calls (the default
runner is tested with a patched Agent, never run for real).
"""

import json
import os
import re
import socket
import sys
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _udp_send_works() -> bool:
    """本环境是否允许 UDP 发送（本机沙箱禁 UDP 时返回 False）。"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.sendto(b"probe", ("127.0.0.1", 47831))
        finally:
            sock.close()
        return True
    except OSError:
        return False


UDP_AVAILABLE = _udp_send_works()

from nyra.pairing import (
    DISCOVERY_PORT,
    PairingClient,
    PairingError,
    PairingHost,
    _default_runner,
    generate_code,
)


def _fake_runner(task: str) -> str:
    return f"回显：{task}"


class PairingTestBase(unittest.TestCase):
    def start_host(self, **kwargs):
        host = PairingHost(runner=_fake_runner, **kwargs)
        host.start()
        self.addCleanup(host.stop)
        return host

    def _post(self, host, path, payload=None, headers=None):
        url = f"http://127.0.0.1:{host.port}{path}"
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=body, method="POST")
        if body is not None:
            req.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        return urllib.request.urlopen(req, timeout=5)


class GenerateCodeTest(unittest.TestCase):
    def test_code_is_six_digits_and_varies(self):
        codes = [generate_code() for _ in range(5)]
        for code in codes:
            self.assertRegex(code, r"^\d{6}$")
        self.assertGreater(len(set(codes)), 1)


class DirectPairTest(PairingTestBase):
    def test_direct_pair_success(self):
        host = self.start_host()
        client = PairingClient()
        token = client.pair("127.0.0.1", host.port, host.code)
        self.assertRegex(token, r"^[0-9a-f]{64}$")
        self.assertEqual(client.token, token)

    def test_wrong_code_rejected(self):
        host = self.start_host()
        client = PairingClient()
        with self.assertRaises(PairingError):
            client.pair("127.0.0.1", host.port, "000000")
        self.assertEqual(host._failed_attempts, 1)

    def test_expired_code_rejected(self):
        host = self.start_host(code_ttl=0.2)
        time.sleep(0.3)
        client = PairingClient()
        with self.assertRaises(PairingError):
            client.pair("127.0.0.1", host.port, host.code)

    def test_five_failures_void_code(self):
        host = self.start_host()
        client = PairingClient()
        for _ in range(5):
            with self.assertRaises(PairingError):
                client.pair("127.0.0.1", host.port, "000000")
        with self.assertRaises(PairingError):
            client.pair("127.0.0.1", host.port, host.code)

    def test_code_single_use(self):
        host = self.start_host()
        client = PairingClient()
        client.pair("127.0.0.1", host.port, host.code)
        with self.assertRaises(PairingError):
            client.pair("127.0.0.1", host.port, host.code)

    def test_ping_no_auth(self):
        host = self.start_host()
        client = PairingClient()
        self.assertTrue(client.ping("127.0.0.1", host.port))


class TaskAuthTest(PairingTestBase):
    def test_task_without_token_401(self):
        host = self.start_host()
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._post(host, "/task", {"task": "hi"})
        self.assertEqual(ctx.exception.code, 401)

    def test_task_with_fake_runner(self):
        host = self.start_host()
        client = PairingClient()
        client.pair("127.0.0.1", host.port, host.code)
        self.assertEqual(client.run_task("你好"), "回显：你好")

    def test_task_wrong_token_401(self):
        host = self.start_host()
        client = PairingClient()
        client.pair("127.0.0.1", host.port, host.code)
        client.token = "0" * 64
        with self.assertRaises(PairingError):
            client.run_task("你好")

    def test_run_task_without_pairing(self):
        client = PairingClient()
        with self.assertRaises(PairingError):
            client.run_task("你好")


class DefaultRunnerTest(unittest.TestCase):
    def test_default_runner_uses_readonly(self):
        with mock.patch("nyra.agent.Agent") as mock_agent:
            mock_agent.return_value.run.return_value = "done"
            result = _default_runner("test task")
        self.assertEqual(result, "done")
        self.assertEqual(mock_agent.call_args.kwargs["mode"], "readonly")
        mock_agent.return_value.run.assert_called_once_with("test task")


class DiscoveryPacketTest(PairingTestBase):
    """发现包处理逻辑（不走真实 UDP，本机沙箱禁 UDP 发送也能跑）。"""

    def test_correct_code_replies(self):
        host = self.start_host()
        reply = host._handle_discovery_packet(
            f"NYRA-PAIR-SEARCH {host.code}".encode(), ("127.0.0.1", 12345)
        )
        self.assertIsNotNone(reply)
        info = json.loads(reply.decode("utf-8"))
        self.assertEqual(info, {"host": "127.0.0.1", "port": host.port})

    def test_wrong_code_no_reply(self):
        host = self.start_host()
        reply = host._handle_discovery_packet(
            b"NYRA-PAIR-SEARCH 000000", ("127.0.0.1", 12345)
        )
        self.assertIsNone(reply)

    def test_malformed_packet_no_reply(self):
        host = self.start_host()
        for bad in (
            b"hello",
            b"NYRA-PAIR-SEARCH",
            b"NYRA-PAIR-SEARCH 123456 extra",
            b"\xff\xfe",
        ):
            self.assertIsNone(
                host._handle_discovery_packet(bad, ("127.0.0.1", 12345)), bad
            )

    def test_no_reply_after_pairing(self):
        host = self.start_host()
        client = PairingClient()
        client.pair("127.0.0.1", host.port, host.code)
        reply = host._handle_discovery_packet(
            f"NYRA-PAIR-SEARCH {host.code}".encode(), ("127.0.0.1", 12345)
        )
        self.assertIsNone(reply)

    def test_no_reply_when_expired(self):
        host = self.start_host(code_ttl=0.2)
        time.sleep(0.3)
        reply = host._handle_discovery_packet(
            f"NYRA-PAIR-SEARCH {host.code}".encode(), ("127.0.0.1", 12345)
        )
        self.assertIsNone(reply)

    def test_wrong_discovery_attempts_void_code(self):
        # 发现接口是配对码预言机：错码必须计入失败次数，否则攻击者
        # 可用 UDP 无限暴力破解 6 位码，绕过 /pair 的 5 次作废限制。
        host = self.start_host()
        for _ in range(5):
            self.assertIsNone(
                host._handle_discovery_packet(
                    b"NYRA-PAIR-SEARCH 000000", ("127.0.0.1", 12345)
                )
            )
        # 5 次错码后，即使是正确码也不再回包，/pair 也应拒绝。
        self.assertIsNone(
            host._handle_discovery_packet(
                f"NYRA-PAIR-SEARCH {host.code}".encode(),
                ("127.0.0.1", 12345),
            )
        )
        ok, _reason = host.verify_code(host.code)
        self.assertFalse(ok)

    def test_discovery_and_pair_share_failure_budget(self):
        # 发现错码 + /pair 错码共用同一个 5 次预算。
        host = self.start_host()
        for _ in range(3):
            host._handle_discovery_packet(
                b"NYRA-PAIR-SEARCH 000000", ("127.0.0.1", 12345)
            )
        for _ in range(2):
            ok, _reason = host.verify_code("000000")
            self.assertFalse(ok)
        ok, _reason = host.verify_code(host.code)
        self.assertFalse(ok)


@unittest.skipUnless(
    UDP_AVAILABLE, "本环境禁止 UDP 发送，跳过真实 UDP 发现测试"
)
class DiscoveryTest(PairingTestBase):
    def test_discovery_unicast(self):
        host = self.start_host()
        client = PairingClient()
        found = client.discover(host.code, address="127.0.0.1")
        self.assertIsNotNone(found)
        self.assertEqual(found[0], "127.0.0.1")
        self.assertEqual(found[1], host.port)
        client.pair(found[0], found[1], host.code)
        self.assertEqual(client.run_task("hi"), "回显：hi")

    def test_discovery_wrong_code_finds_nothing(self):
        self.start_host()
        client = PairingClient()
        found = client.discover("000000", address="127.0.0.1", timeout=1.0)
        self.assertIsNone(found)


if __name__ == "__main__":
    unittest.main()
