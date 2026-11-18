"""Minimal WebSocket client (RFC 6455), standard library only.

Built on ``socket`` + ``http.client``: the HTTP Upgrade handshake is done
with ``http.client.HTTPResponse`` over the raw socket, then frames are read
and written directly. No third-party code. Used by the CDP browser client;
it does not know anything about CDP.

Limits: text messages up to 10 MB (larger messages raise); binary frames
are accepted and decoded as UTF-8 (CDP only sends text). The client always
masks outgoing frames, as the spec requires. A ``sock`` object may be
injected for tests (it must provide ``sendall``, ``makefile``,
``settimeout`` and ``close``).
"""

import base64
import hashlib
import http.client
import os
import socket
import ssl
import urllib.parse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE_BYTES = 10 * 1024 * 1024

# Opcodes (RFC 6455 §5.2).
_OP_CONTINUATION = 0x0
_OP_TEXT = 0x1
_OP_BINARY = 0x2
_OP_CLOSE = 0x8
_OP_PING = 0x9
_OP_PONG = 0xA


class WebSocketError(Exception):
    """Raised for handshake failures, protocol errors and closed connections."""


class WebSocketClient:
    """A small blocking WebSocket client."""

    def __init__(self, url: str, timeout: float = 10.0, sock=None, key: str | None = None):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("ws", "wss"):
            raise WebSocketError(f"只支持 ws:// 或 wss://，不是：{url}")
        if not parsed.hostname:
            raise WebSocketError(f"WebSocket 地址缺少主机名：{url}")
        self._url = url
        self._secure = parsed.scheme == "wss"
        self._host = parsed.hostname
        self._port = parsed.port or (443 if self._secure else 80)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        self._path = path
        self._timeout = timeout
        self._sock = sock
        self._key = key
        self._fp = None
        self._http_response = None
        self._closed = True
        self._last_pong: bytes | None = None

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def last_pong(self) -> bytes | None:
        """Payload of the most recent pong frame, if any."""
        return self._last_pong

    def connect(self) -> None:
        """Perform the HTTP Upgrade handshake. Raises WebSocketError on failure."""
        key = self._key or base64.b64encode(os.urandom(16)).decode("ascii")
        owned_sock = False
        if self._sock is None:
            sock = socket.create_connection((self._host, self._port), timeout=self._timeout)
            self._sock = sock
            owned_sock = True
            if self._secure:
                try:
                    context = ssl.create_default_context()
                    sock = context.wrap_socket(sock, server_hostname=self._host)
                except Exception as exc:
                    try:
                        sock.close()
                    except Exception:
                        pass
                    self._sock = None
                    raise WebSocketError(f"WebSocket TLS 握手失败：{exc}") from exc
                self._sock = sock
        else:
            sock = self._sock
        try:
            self._handshake(sock, key)
        except WebSocketError:
            # A failed handshake must not leak a socket this client
            # created: close it and drop the reference so a retry does
            # not reuse a dead socket. An injected (caller-owned) socket
            # is left alone for its owner to close.
            if owned_sock:
                try:
                    sock.close()
                except Exception:
                    pass
                self._sock = None
            self._closed = True
            raise

    def _handshake(self, sock, key: str) -> None:
        request = (
            f"GET {self._path} HTTP/1.1\r\n"
            f"Host: {self._host}:{self._port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        try:
            sock.sendall(request.encode("ascii"))
        except OSError as exc:
            raise WebSocketError(f"发送握手请求失败：{exc}") from exc
        try:
            response = http.client.HTTPResponse(sock, method="GET")
            response.begin()
        except Exception as exc:
            raise WebSocketError(f"读取握手响应失败：{exc}") from exc
        if response.status != 101:
            raise WebSocketError(f"WebSocket 握手失败：HTTP {response.status}")
        expected = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
        ).decode("ascii")
        accept = (response.getheader("Sec-WebSocket-Accept") or "").strip()
        if accept != expected:
            raise WebSocketError("WebSocket 握手失败：Sec-WebSocket-Accept 不匹配")
        # Keep the buffered reader: bytes already read past the headers are
        # the start of the first frame, and must not be lost. Keep the
        # HTTPResponse object alive too: its __del__ closes the reader.
        self._fp = response.fp
        self._http_response = response
        self._closed = False

    # ---- framing ----

    def _read_exact(self, count: int) -> bytes:
        chunks = []
        remaining = count
        while remaining > 0:
            try:
                chunk = self._fp.read(remaining)
            except OSError as exc:
                raise WebSocketError(f"读取失败：{exc}") from exc
            if not chunk:
                raise WebSocketError("连接已关闭")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _send_frame(self, opcode: int, payload: bytes, fin: bool = True) -> None:
        if self._closed:
            raise WebSocketError("连接已关闭，无法发送")
        header = bytearray()
        header.append((0x80 if fin else 0x00) | opcode)
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(length.to_bytes(2, "big"))
        else:
            header.append(0x80 | 127)
            header.extend(length.to_bytes(8, "big"))
        mask = os.urandom(4)
        header.extend(mask)
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        try:
            self._sock.sendall(bytes(header) + masked)
        except OSError as exc:
            raise WebSocketError(f"发送失败：{exc}") from exc

    def _recv_frame(self) -> tuple[bool, int, bytes]:
        """Read one frame; returns (fin, opcode, payload)."""
        first = self._read_exact(2)
        fin = bool(first[0] & 0x80)
        opcode = first[0] & 0x0F
        masked = bool(first[1] & 0x80)
        length = first[1] & 0x7F
        if length == 126:
            length = int.from_bytes(self._read_exact(2), "big")
        elif length == 127:
            length = int.from_bytes(self._read_exact(8), "big")
        # Reject an over-limit frame before reading its payload: without
        # this, a peer advertising a multi-GB frame makes the client
        # buffer it all in memory (recv_text only checks the total
        # after the whole frame has been read).
        if length > MAX_MESSAGE_BYTES:
            raise WebSocketError("消息超过 10MB 上限")
        mask = self._read_exact(4) if masked else b""
        payload = self._read_exact(length) if length else b""
        if masked:
            payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        return fin, opcode, payload

    # ---- public API ----

    def send_text(self, text: str) -> None:
        self._send_frame(_OP_TEXT, text.encode("utf-8"))

    def ping(self, payload: bytes = b"") -> None:
        self._send_frame(_OP_PING, payload)

    def recv_text(self, timeout: float | None = None) -> str:
        """Return the next complete text message, reassembling fragments.

        Ping frames are answered with a pong automatically; pong frames are
        recorded; a close frame raises WebSocketError. ``timeout`` bounds
        the whole wait; a timeout raises WebSocketError.
        """
        if self._closed:
            raise WebSocketError("连接已关闭")
        if timeout is not None:
            try:
                self._sock.settimeout(timeout)
            except OSError:
                pass
        parts: list[bytes] = []
        total = 0
        try:
            while True:
                try:
                    fin, opcode, payload = self._recv_frame()
                except socket.timeout as exc:
                    raise WebSocketError("等待消息超时") from exc
                if opcode == _OP_CLOSE:
                    self._closed = True
                    raise WebSocketError("对方已关闭连接")
                if opcode == _OP_PING:
                    self._send_frame(_OP_PONG, payload)
                    continue
                if opcode == _OP_PONG:
                    self._last_pong = payload
                    continue
                if opcode not in (_OP_TEXT, _OP_BINARY, _OP_CONTINUATION):
                    raise WebSocketError(f"不支持的操作码：{opcode}")
                total += len(payload)
                if total > MAX_MESSAGE_BYTES:
                    raise WebSocketError("消息超过 10MB 上限")
                parts.append(payload)
                if fin:
                    break
        finally:
            if timeout is not None:
                try:
                    self._sock.settimeout(self._timeout)
                except OSError:
                    pass
        try:
            return b"".join(parts).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WebSocketError(f"消息不是有效 UTF-8 文本：{exc}") from exc

    def close(self, code: int = 1000) -> None:
        """Send a close frame and shut the socket. Idempotent."""
        if self._closed:
            return
        try:
            self._send_frame(_OP_CLOSE, code.to_bytes(2, "big"))
        except WebSocketError:
            pass
        self._closed = True
        try:
            self._sock.settimeout(1.0)
            try:
                self._recv_frame()
            except Exception:
                pass
        except Exception:
            pass
        try:
            if self._fp is not None:
                self._fp.close()
        except Exception:
            pass
        self._http_response = None
        try:
            self._sock.close()
        except Exception:
            pass
        # Drop the references so a later connect() opens a fresh socket
        # instead of reusing this closed one.
        self._sock = None
        self._fp = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False
