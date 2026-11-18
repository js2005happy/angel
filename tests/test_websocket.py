"""Tests for the stdlib WebSocket client (nyra/websocket.py).

All network is mocked: a FakeSocket feeds canned handshake responses and
frames, so no real socket is ever opened.
"""

import io
import unittest

from nyra.websocket import MAX_MESSAGE_BYTES, WebSocketClient, WebSocketError

# RFC 6455 §1.3 example key and its expected accept value.
SAMPLE_KEY = "dGhlIHNhbXBsZSBub25jZQ=="
SAMPLE_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="


def handshake_response(accept=SAMPLE_ACCEPT, status=101):
    reason = "Switching Protocols" if status == 101 else "OK"
    return (
        f"HTTP/1.1 {status} {reason}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n"
        "\r\n"
    ).encode("ascii")


def server_frame(payload: bytes, opcode: int = 0x1, fin: bool = True) -> bytes:
    """Build one unmasked server frame (servers never mask)."""
    header = bytearray()
    header.append((0x80 if fin else 0x00) | opcode)
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(length.to_bytes(2, "big"))
    else:
        header.append(127)
        header.extend(length.to_bytes(8, "big"))
    return bytes(header) + payload


def parse_client_frames(data: bytes):
    """Parse masked client frames out of raw sent bytes (after the HTTP request)."""
    request_end = data.index(b"\r\n\r\n") + 4
    frames = []
    pos = request_end
    while pos < len(data):
        first, second = data[pos], data[pos + 1]
        pos += 2
        fin = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = int.from_bytes(data[pos:pos + 2], "big")
            pos += 2
        elif length == 127:
            length = int.from_bytes(data[pos:pos + 8], "big")
            pos += 8
        assert masked, "client frames must be masked"
        mask = data[pos:pos + 4]
        pos += 4
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(data[pos:pos + length]))
        pos += length
        frames.append((fin, opcode, payload))
    return frames


class FakeSocket:
    """A socket stand-in: records what was sent, replays canned bytes."""

    def __init__(self, recv_bytes: bytes = b""):
        self.sent = bytearray()
        self._in = io.BytesIO(recv_bytes)
        self.timeout = None
        self.closed = False

    def sendall(self, data: bytes) -> None:
        self.sent += data

    def makefile(self, mode: str):
        return self._in

    def settimeout(self, timeout) -> None:
        self.timeout = timeout

    def close(self) -> None:
        self.closed = True


def connect_client(extra: bytes = b"", **kwargs) -> tuple[WebSocketClient, FakeSocket]:
    sock = FakeSocket(handshake_response() + extra)
    client = WebSocketClient("ws://127.0.0.1:9222/devtools/page/ABC", sock=sock, key=SAMPLE_KEY, **kwargs)
    client.connect()
    return client, sock


class HandshakeTests(unittest.TestCase):
    def test_handshake_success_verifies_upgrade_and_accept(self):
        client, sock = connect_client()
        self.assertFalse(client.closed)
        sent = bytes(sock.sent).decode("ascii")
        self.assertIn("GET /devtools/page/ABC HTTP/1.1", sent)
        self.assertIn("Upgrade: websocket", sent)
        self.assertIn("Connection: Upgrade", sent)
        self.assertIn(f"Sec-WebSocket-Key: {SAMPLE_KEY}", sent)
        self.assertIn("Sec-WebSocket-Version: 13", sent)

    def test_handshake_non_101_raises(self):
        sock = FakeSocket(handshake_response(status=200))
        client = WebSocketClient("ws://127.0.0.1:9222/x", sock=sock, key=SAMPLE_KEY)
        with self.assertRaises(WebSocketError) as ctx:
            client.connect()
        self.assertIn("200", str(ctx.exception))

    def test_handshake_bad_accept_raises(self):
        sock = FakeSocket(handshake_response(accept="wrong"))
        client = WebSocketClient("ws://127.0.0.1:9222/x", sock=sock, key=SAMPLE_KEY)
        with self.assertRaises(WebSocketError):
            client.connect()

    def test_non_ws_scheme_rejected(self):
        with self.assertRaises(WebSocketError):
            WebSocketClient("http://127.0.0.1:9222/x")


class FrameTests(unittest.TestCase):
    def test_text_round_trip_and_masked_send(self):
        client, sock = connect_client(server_frame("hello".encode()))
        client.send_text("hi")
        frames = parse_client_frames(bytes(sock.sent))
        self.assertEqual(frames, [(True, 0x1, b"hi")])
        self.assertEqual(client.recv_text(), "hello")

    def test_fragmented_message_reassembled(self):
        extra = server_frame(b"hel", opcode=0x1, fin=False) + server_frame(b"lo", opcode=0x0, fin=True)
        client, _ = connect_client(extra)
        self.assertEqual(client.recv_text(), "hello")

    def test_medium_message_uses_126_length(self):
        payload = b"x" * 1000
        client, _ = connect_client(server_frame(payload))
        self.assertEqual(client.recv_text(), payload.decode())

    def test_large_message_uses_127_length(self):
        payload = b"y" * 100_000
        client, _ = connect_client(server_frame(payload))
        self.assertEqual(len(client.recv_text()), 100_000)

    def test_message_over_10mb_raises(self):
        chunk = b"z" * (6 * 1024 * 1024)
        extra = server_frame(chunk, opcode=0x1, fin=False) + server_frame(chunk, opcode=0x0, fin=True)
        client, _ = connect_client(extra)
        with self.assertRaises(WebSocketError) as ctx:
            client.recv_text()
        self.assertIn("10MB", str(ctx.exception))

    def test_ping_is_answered_with_pong(self):
        extra = server_frame(b"abc", opcode=0x9) + server_frame(b"hi")
        client, sock = connect_client(extra)
        self.assertEqual(client.recv_text(), "hi")
        frames = parse_client_frames(bytes(sock.sent))
        self.assertIn((True, 0xA, b"abc"), frames)

    def test_received_pong_is_recorded(self):
        extra = server_frame(b"xyz", opcode=0xA) + server_frame(b"hi")
        client, _ = connect_client(extra)
        self.assertEqual(client.recv_text(), "hi")
        self.assertEqual(client.last_pong, b"xyz")

    def test_close_frame_raises_on_recv(self):
        extra = server_frame(b"", opcode=0x8)
        client, _ = connect_client(extra)
        with self.assertRaises(WebSocketError):
            client.recv_text()
        self.assertTrue(client.closed)

    def test_close_sends_close_frame_and_is_idempotent(self):
        client, sock = connect_client()
        client.close()
        frames = parse_client_frames(bytes(sock.sent))
        self.assertEqual(frames, [(True, 0x8, (1000).to_bytes(2, "big"))])
        self.assertTrue(client.closed)
        self.assertTrue(sock.closed)
        sent_before = bytes(sock.sent)
        client.close()
        self.assertEqual(bytes(sock.sent), sent_before)

    def test_send_after_close_raises(self):
        client, _ = connect_client()
        client.close()
        with self.assertRaises(WebSocketError):
            client.send_text("hi")

    def test_recv_after_close_raises(self):
        client, _ = connect_client()
        client.close()
        with self.assertRaises(WebSocketError):
            client.recv_text()


if __name__ == "__main__":
    unittest.main()
