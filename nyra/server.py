"""Nyra HTTP API server: the agent core exposed over JSON + SSE streaming.

Pure standard library (http.server + threading). This is the Server layer
of the decoupled architecture: it owns one ``UIState`` — the same core the
web UI drives — and exposes it as a JSON API plus a Server-Sent Events
stream, so a separate client (desktop app or web page) can drive the agent
without touching the core.

Endpoints (all under ``/api/``):

- ``GET  /api/health`` — no token needed: ``{"ok": true, ...}``.
- ``POST /api/sessions`` — create a session, ``{"id": ...}``.
- ``GET  /api/sessions/{id}/messages`` — the session view: transcript
  (``messages``), live ``events``, ``status``, ``next`` cursor, pending
  approval and usage.
- ``POST /api/sessions/{id}/send`` — ``{"text": ...}`` starts an agent
  run and returns immediately with the run status.
- ``GET  /api/sessions/{id}/events?since=N`` — ``text/event-stream``:
  every event as a ``data:`` line, missed events replayed from the
  ``since`` cursor, a heartbeat comment every ~15s, and a final
  ``run_finished`` event when the run ends.
- ``POST /api/approvals/{id}/decide`` — ``{"approve": true|false,
  "always": false}``; ``always`` grants it for the session (400 when the
  tool has no session scope).

Security mirrors the web UI exactly: loopback only by default (a
non-loopback bind prints a warning), every request except health must
carry the per-start token in the ``X-Nyra-Token`` header (constant-time
compare; the query string is never accepted for API calls), the Host
header is checked on loopback binds (DNS-rebinding defence), and there
is no CORS — OPTIONS is refused.

Run it with ``python3 -m nyra.server``. Nothing here changes how the
agent itself behaves; it only serves what ``UIState`` already does.
"""

import argparse
import json
import re
import secrets
import sys
import threading
import time
import traceback
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import __version__
from . import memory as memory_module
from .config import (
    VALID_MODES,
    load_config,
    resolve_profile,
    validate_mode,
)
from .usage import context_limit
from .webui import (
    MAX_BODY,
    SESSION_ID_RE,
    UIState,
    is_loopback_host,
)
from .compact import DEFAULT_AUTO_COMPACT_THRESHOLD, validate_auto_compact_threshold

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766  # the web UI uses 8765
HEARTBEAT_SECONDS = 15.0
POLL_SECONDS = 0.2
APPROVAL_ID_RE = re.compile(r"^[0-9a-f]{16}$")


class ApiServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, state: UIState, verbose: bool = False):
        super().__init__(address, Handler)
        self.state = state
        self.verbose = verbose
        self.check_host = is_loopback_host(address[0])


def make_server(
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    state: UIState | None = None,
    warn_stream=None,
    verbose: bool = False,
) -> ApiServer:
    """Create the server and warn when binding beyond this machine."""
    if state is None:
        state = UIState(Path.cwd())
    if not is_loopback_host(host):
        stream = warn_stream if warn_stream is not None else sys.stderr
        print(
            f"警告：API 服务正在监听非本机地址 {host}。同一网络里的其他设备只要拿到 "
            "token 就能操作 Nyra（读写文件、执行命令）。除非你清楚风险，请使用默认的 127.0.0.1。",
            file=stream,
        )
    return ApiServer((host, port), state, verbose=verbose)


def api_url(server: ApiServer) -> str:
    host, port = server.server_address[:2]
    shown = "127.0.0.1" if host in ("0.0.0.0", "") else host
    if ":" in shown:
        shown = f"[{shown}]"
    return f"http://{shown}:{port}"


class Handler(BaseHTTPRequestHandler):
    server_version = "NyraAPI"
    sys_version = ""
    state: UIState  # set on the server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet by default; never log tokens
        if getattr(self.server, "verbose", False):
            path = self.path.split("?", 1)[0]
            sys.stderr.write(f"[nyra api] {self.command} {path}\n")

    # -- helpers ------------------------------------------------------------
    @property
    def state(self) -> UIState:
        return self.server.state

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, data) -> None:
        self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _host_ok(self) -> bool:
        if not self.server.check_host:
            return True
        host = (self.headers.get("Host") or "").strip().lower()
        if host.startswith("["):
            name = host.split("]", 1)[0] + "]"
        else:
            name = host.rsplit(":", 1)[0] if ":" in host else host
        return name in ("127.0.0.1", "localhost", "[::1]")

    def _token_ok(self) -> bool:
        # Header only, exactly like the web UI's API routes: the token in
        # the query string is accepted for the HTML page only, never here.
        supplied = self.headers.get("X-Nyra-Token") or ""
        return bool(supplied) and secrets.compare_digest(
            supplied.encode("utf-8", "surrogateescape"), self.state.token.encode("utf-8")
        )

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length) if length else b"{}"
        data = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(data, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return data

    def _route(self) -> tuple[str, dict]:
        parts = urllib.parse.urlsplit(self.path)
        return parts.path, urllib.parse.parse_qs(parts.query)

    def _session_known(self, sid: str) -> bool:
        """A session exists if it has a live run or a saved transcript."""
        if self.state.get_run(sid, create=False) is not None:
            return True
        return memory_module.load_session(sid) is not None

    def _valid_sid(self, raw: str) -> str | None:
        sid = urllib.parse.unquote(raw)
        return sid if SESSION_ID_RE.match(sid) else None

    # -- SSE ----------------------------------------------------------------
    def _stream_events(self, sid: str, since: int) -> None:
        """Push session events as SSE until the run ends or the client leaves."""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        # The stream has no Content-Length: close the connection when the
        # handler returns so the client sees EOF at the end of the run.
        self.close_connection = True
        cursor = max(0, since)
        last_write = time.monotonic()
        try:
            self._sse_write(": connected\n\n")
            last_write = time.monotonic()
            while True:
                view = self.state.session_view(sid, since=cursor)
                for event in view["events"]:
                    self._sse_write(
                        "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
                    )
                    last_write = time.monotonic()
                cursor = view["next"]
                status = view["status"]
                if status in ("done", "error"):
                    self._sse_write(
                        "data: "
                        + json.dumps(
                            {
                                "type": "run_finished",
                                "data": {
                                    "status": status,
                                    "error": view["error"],
                                },
                                "ts": time.time(),
                            },
                            ensure_ascii=False,
                        )
                        + "\n\n"
                    )
                    return
                now = time.monotonic()
                if now - last_write >= HEARTBEAT_SECONDS:
                    self._sse_write(": heartbeat\n\n")
                    last_write = now
                time.sleep(POLL_SECONDS)
        except (BrokenPipeError, ConnectionResetError):
            return  # client went away; nothing to report
        except Exception:
            traceback.print_exc(file=sys.stderr)

    def _sse_write(self, text: str) -> None:
        self.wfile.write(text.encode("utf-8"))
        self.wfile.flush()

    # -- verbs --------------------------------------------------------------
    def do_GET(self):
        try:
            self._do_get()
        except Exception:
            traceback.print_exc(file=sys.stderr)
            try:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "服务器内部错误")
            except Exception:
                pass

    def _do_get(self):
        if not self._host_ok():
            return self._error(HTTPStatus.MISDIRECTED_REQUEST, "Host 不被允许")
        path, query = self._route()
        if path == "/api/health":
            return self._json(
                HTTPStatus.OK, {"ok": True, "version": __version__}
            )
        if not path.startswith("/api/"):
            return self._error(HTTPStatus.NOT_FOUND, "未找到")
        if not self._token_ok():
            return self._error(HTTPStatus.FORBIDDEN, "token 无效")
        match = re.fullmatch(r"/api/sessions/([^/]+)/events", path)
        if match:
            sid = self._valid_sid(match.group(1))
            if sid is None:
                return self._error(HTTPStatus.BAD_REQUEST, "会话 id 无效")
            if not self._session_known(sid):
                return self._error(HTTPStatus.NOT_FOUND, "会话不存在")
            try:
                since = max(0, int((query.get("since") or ["0"])[0]))
            except ValueError:
                since = 0
            self._stream_events(sid, since)
            return
        match = re.fullmatch(r"/api/sessions/([^/]+)/messages", path)
        if match:
            sid = self._valid_sid(match.group(1))
            if sid is None:
                return self._error(HTTPStatus.BAD_REQUEST, "会话 id 无效")
            if not self._session_known(sid):
                return self._error(HTTPStatus.NOT_FOUND, "会话不存在")
            return self._json(HTTPStatus.OK, self.state.session_view(sid))
        return self._error(HTTPStatus.NOT_FOUND, "未找到")

    def do_POST(self):
        try:
            self._do_post()
        except Exception:
            traceback.print_exc(file=sys.stderr)
            try:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "服务器内部错误")
            except Exception:
                pass

    def _do_post(self):
        if not self._host_ok():
            return self._error(HTTPStatus.MISDIRECTED_REQUEST, "Host 不被允许")
        path, _ = self._route()
        if not path.startswith("/api/"):
            return self._error(HTTPStatus.NOT_FOUND, "未找到")
        if not self._token_ok():
            return self._error(HTTPStatus.FORBIDDEN, "token 无效")
        try:
            body = self._body()
        except (ValueError, UnicodeDecodeError) as exc:
            return self._error(HTTPStatus.BAD_REQUEST, f"请求无效：{exc}")
        if path == "/api/sessions":
            return self._json(HTTPStatus.CREATED, {"id": self.state.new_session()})
        match = re.fullmatch(r"/api/sessions/([^/]+)/send", path)
        if match:
            sid = self._valid_sid(match.group(1))
            if sid is None:
                return self._error(HTTPStatus.BAD_REQUEST, "会话 id 无效")
            if not self._session_known(sid):
                return self._error(HTTPStatus.NOT_FOUND, "会话不存在")
            text = str(body.get("text") or "").strip()
            if not text:
                return self._error(HTTPStatus.BAD_REQUEST, "消息不能为空")
            try:
                run = self.state.send(sid, text)
            except RuntimeError as exc:
                return self._error(HTTPStatus.CONFLICT, str(exc))
            return self._json(
                HTTPStatus.ACCEPTED,
                {"id": sid, "status": run.status, "error": run.error},
            )
        match = re.fullmatch(r"/api/approvals/([^/]+)/decide", path)
        if match:
            approval_id = match.group(1)
            if not APPROVAL_ID_RE.match(approval_id):
                return self._error(HTTPStatus.NOT_FOUND, "审批已失效")
            try:
                ok = self.state.decide(
                    approval_id, bool(body.get("approve")), always=bool(body.get("always"))
                )
            except ValueError as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            if not ok:
                return self._error(HTTPStatus.NOT_FOUND, "审批已失效")
            return self._json(HTTPStatus.OK, {"ok": True})
        return self._error(HTTPStatus.NOT_FOUND, "未找到")

    def do_OPTIONS(self):  # no CORS: cross-origin pages get nothing
        self._error(HTTPStatus.FORBIDDEN, "不支持跨域请求")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nyra server", description="启动 Nyra HTTP API 服务（JSON + SSE）"
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址（默认 127.0.0.1，只允许本机访问）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="端口（默认 8766，0 表示随机）")
    parser.add_argument("--workdir", default=".", help="工作目录")
    parser.add_argument("--mode", choices=VALID_MODES, default=None, help="审批模式（默认读配置，一般为 auto）")
    parser.add_argument("--provider", default=None, help="模型 provider")
    parser.add_argument("--model", default=None, help="模型 id")
    parser.add_argument("--profile", default=None, help="provider 档案")
    parser.add_argument("--verbose", action="store_true", help="打印请求日志（不含 token）")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    workdir = Path(args.workdir).resolve()
    if not workdir.is_dir():
        print(f"错误：工作目录不存在：{workdir}")
        return 1
    cfg = load_config()
    try:
        profile = resolve_profile(args.profile, cfg)
        mode = validate_mode(args.mode or profile["mode"] or "auto")
    except ValueError as exc:
        print(f"错误：{exc}")
        return 1
    from .agent import build_mcp_manager

    # Same rule as the web UI: the client cannot approve local MCP process
    # startup. Auto/readonly do not launch MCP subprocesses; full is an
    # explicit opt-in.
    mcp_manager = build_mcp_manager(mode=mode, interactive=False)
    state = UIState(
        workdir,
        mode=mode,
        provider_name=args.provider,
        model=args.model,
        profile=args.profile,
        mcp_manager=mcp_manager,
        context_window_tokens=context_limit(cfg.get("context_window_tokens")),
        auto_compact_enabled=bool(cfg.get("auto_compact_enabled", False)),
        auto_compact_threshold=validate_auto_compact_threshold(
            cfg.get("auto_compact_threshold", DEFAULT_AUTO_COMPACT_THRESHOLD)
        ),
    )
    try:
        server = make_server(args.host, args.port, state, verbose=args.verbose)
    except OSError as exc:
        print(f"错误：无法监听 {args.host}:{args.port}：{exc}")
        if mcp_manager is not None:
            mcp_manager.stop_all()
        return 1
    print(f"Nyra {__version__} API 服务已启动：{api_url(server)}")
    print(f"访问 token：{server.state.token}")
    print("除 /api/health 外，所有请求都要在 X-Nyra-Token 请求头里带上这个 token；请不要分享。按 Ctrl+C 停止。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        server.server_close()
        if mcp_manager is not None:
            mcp_manager.stop_all()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
