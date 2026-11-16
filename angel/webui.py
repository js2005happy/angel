"""Angel 本地网页界面：`python3 -m angel ui`。

纯标准库（http.server + threading），页面是内嵌的单个 HTML/CSS/JS，
不引用任何外部资源。复用 agent.py 的 Agent、memory.py 的会话存储和
tools.py 的审批门（通过 ToolContext.approve_fn），不重写核心逻辑。

安全：
- 默认只监听 127.0.0.1；绑定非本机地址时打印警告。
- 每次启动随机生成一个 token，页面通过 URL 参数 ?token= 带入，之后
  所有 API 请求都要在 X-Angel-Token 请求头里带上它（防 CSRF；跨站页面
  无法设置自定义请求头而不触发预检，服务器也不回应 CORS）。
- 监听本机地址时校验 Host 头，防 DNS 重绑定。
- API Key 只报告“是否已配置”，绝不回显其值。
"""

import argparse
import ipaddress
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.parse
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

from . import __version__
from . import config as config_module
from . import memory as memory_module
from .agent import Agent, AgentError
from .groups import GroupStore, GroupError
from .config import (
    PROVIDERS,
    VALID_MODES,
    load_config,
    resolve_profile,
    resolve_provider,
    validate_mode,
)
from .providers import Provider, describe_provider
from .usage import context_limit
from .webui_page import PAGE_HTML

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
APPROVAL_TIMEOUT = 600.0
MAX_BODY = 256 * 1024
MAX_EVENT_TEXT = 4000
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")


def is_loopback_host(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def _clip(text, limit: int = MAX_EVENT_TEXT) -> str:
    text = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    if len(text) > limit:
        return text[:limit] + f"\n…（已截断，共 {len(text)} 字）"
    return text


class Run:
    """One session's agent plus the live events of its current task."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.agent: Agent | None = None
        self.events: list[dict] = []
        self.status = "idle"  # idle | running | done | error
        self.error = ""
        self.pending: dict | None = None
        # Transcript as it was when the current task started; the live part
        # of a running task is delivered as events instead.
        self.base_messages: list[dict] = []
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None


class UIState:
    """Shared state of the web UI server."""

    def __init__(
        self,
        workdir: Path,
        mode: str = "auto",
        provider_factory: Callable[[], object] | None = None,
        token: str | None = None,
        provider_name: str | None = None,
        model: str | None = None,
        profile: str | None = None,
        max_turns: int | None = None,
        mcp_manager=None,
        context_window_tokens: int | None = None,
    ) -> None:
        self.workdir = Path(workdir)
        self.mode = validate_mode(mode)
        self.groups = GroupStore(config_module.ANGEL_HOME / "groups")
        self.token = token or secrets.token_urlsafe(24)
        self.provider_name = provider_name
        self.model = model
        self.profile = profile
        self.max_turns = max_turns
        self.context_window_tokens = context_limit(context_window_tokens)
        self.mcp_manager = mcp_manager
        self._provider_factory = provider_factory
        self._provider = None
        self.runs: dict[str, Run] = {}
        self.approvals: dict[str, tuple[Run, dict]] = {}
        self.lock = threading.Lock()
        self._mode_lock = threading.Lock()

    # -- provider -----------------------------------------------------------
    def provider(self):
        if self._provider is None:
            if self._provider_factory is not None:
                self._provider = self._provider_factory()
            else:
                cfg = load_config()
                prof = resolve_profile(self.profile, cfg)
                self._provider = Provider(
                    resolve_provider(
                        self.provider_name or prof["provider"],
                        self.model or prof["model"],
                    )
                )
                if self.max_turns is None:
                    self.max_turns = cfg.get("max_turns") or 20
                if self.context_window_tokens is None:
                    self.context_window_tokens = context_limit(cfg.get("context_window_tokens"))
        return self._provider

    def info(self) -> dict:
        """Non-secret settings. Keys are reported only as configured or not."""
        out: dict = {
            "version": __version__,
            "mode": self.mode,
            "modes": list(VALID_MODES),
            "workdir": str(self.workdir),
        }
        try:
            prov = self.provider()
            out["provider"] = getattr(prov, "name", "?")
            out["model"] = getattr(prov, "model", "?")
            if isinstance(prov, Provider):
                out["provider_desc"] = describe_provider(prov)
                out["credentials"] = bool(prov.has_credentials())
            else:
                out["provider_desc"] = f"{out['provider']} / {out['model']}"
                has = getattr(prov, "has_credentials", None)
                out["credentials"] = bool(has()) if callable(has) else True
        except Exception as exc:  # unknown provider, bad profile …
            out["provider"] = None
            out["model"] = None
            out["provider_desc"] = ""
            out["credentials"] = False
            out["provider_error"] = str(exc)
        keys = []
        for name, preset in PROVIDERS.items():
            env_key = preset.get("env_key")
            keys.append(
                {
                    "provider": name,
                    "env": env_key,
                    "configured": bool(env_key and os.environ.get(env_key)),
                    "connector": bool(preset.get("connector")),
                    "needs_key": env_key is not None and name != "ollama",
                }
            )
        out["keys"] = keys
        try:
            cfg = load_config()
            profiles = cfg.get("profiles") or {}
            out["config"] = {
                "max_turns": cfg.get("max_turns"),
                "context_window_tokens": context_limit(cfg.get("context_window_tokens")),
                "mcp_enabled": bool(cfg.get("mcp_enabled")),
                "sandbox": cfg.get("sandbox") or "local",
                "profiles": sorted(profiles) if isinstance(profiles, dict) else [],
            }
        except Exception:
            out["config"] = {}
        out["mcp_tools"] = (
            len(self.mcp_manager.tool_schemas) if self.mcp_manager is not None else 0
        )
        return out

    def set_mode(self, new_mode: str) -> str:
        """Apply mode changes to MCP processes and existing agents safely."""
        new_mode = validate_mode(new_mode)
        with self._mode_lock:
            with self.lock:
                runs = list(self.runs.values())
            for run in runs:
                with run.lock:
                    if run.status == "running":
                        raise RuntimeError("有任务正在执行，请完成后再切换模式")
            if new_mode == self.mode:
                return new_mode
            # Stop previous MCP processes before switching to a lower-trust mode.
            previous = self.mcp_manager
            self.mcp_manager = None
            for run in runs:
                if run.agent is not None:
                    run.agent.mcp_manager = None
            if previous is not None:
                previous.stop_all()
            from .agent import build_mcp_manager

            manager = build_mcp_manager(mode=new_mode, interactive=False)
            self.mcp_manager = manager
            self.mode = new_mode
            for run in runs:
                if run.agent is not None:
                    run.agent.mode = new_mode
                    run.agent.ctx.mode = new_mode
                    run.agent.mcp_manager = manager
            return new_mode

    # -- sessions -----------------------------------------------------------
    def get_run(self, session_id: str, create: bool = True) -> Run | None:
        with self.lock:
            run = self.runs.get(session_id)
            if run is None and create:
                run = Run(session_id)
                self.runs[session_id] = run
            return run

    def new_session(self) -> str:
        sid = memory_module.new_session_id()
        self.get_run(sid)
        return sid

    def session_messages(self, session_id: str) -> list[dict]:
        run = self.get_run(session_id, create=False)
        if run is not None and run.status == "running":
            return list(run.base_messages)
        if run is not None and run.agent is not None:
            return list(run.agent.messages)
        return memory_module.load_session(session_id) or []

    def session_view(self, session_id: str, since: int = 0) -> dict:
        run = self.get_run(session_id, create=False)
        messages = self.session_messages(session_id)
        events: list[dict] = []
        status = "idle"
        pending = None
        error = ""
        if run is not None:
            with run.lock:
                events = run.events[since:]
                status = run.status
                pending = dict(run.pending) if run.pending else None
                error = run.error
                total = len(run.events)
        else:
            total = 0
        if pending:
            pending.pop("event", None)
            pending.pop("decision", None)
        return {
            "id": session_id,
            "status": status,
            "error": error,
            "messages": messages,
            "events": events,
            "next": total,
            "pending": pending,
            "evidence": list_evidence(session_id),
            "plan": find_plan(messages, events, status),
            "usage": run.agent.usage.snapshot() if run is not None and run.agent is not None else None,
        }

    # -- running ------------------------------------------------------------
    def send(self, session_id: str, text: str) -> Run:
        # Serialize new runs with mode switches to avoid a race with MCP stop.
        with self._mode_lock:
            return self._send_unlocked(session_id, text)

    def _send_unlocked(self, session_id: str, text: str) -> Run:
        run = self.get_run(session_id)
        with run.lock:
            if run.status == "running":
                raise RuntimeError("这个会话正在执行任务，请等它完成")
            run.events = []
            run.error = ""
            run.status = "running"
        try:
            if run.agent is None:
                provider = self.provider()
                run.agent = Agent(
                    provider=provider,
                    workdir=self.workdir,
                    mode=self.mode,
                    max_turns=self.max_turns or 20,
                    session_id=session_id,
                    interactive=True,
                    messages=memory_module.load_session(session_id),
                    mcp_manager=self.mcp_manager,
                    on_event=lambda kind, data: self._record(run, kind, data),
                    approve_fn=lambda tool, summary: self._approve(run, tool, summary),
                    context_window_tokens=self.context_window_tokens,
                )
            else:
                run.agent.mode = self.mode
                run.agent.ctx.mode = self.mode
            run.base_messages = list(run.agent.messages)
        except Exception as exc:
            with run.lock:
                run.status = "error"
                run.error = f"无法启动：{exc}"
            return run
        self._record(run, "user", {"content": text})
        thread = threading.Thread(
            target=self._work, args=(run, text), name=f"angel-ui-{session_id}", daemon=True
        )
        run.thread = thread
        thread.start()
        return run

    def _work(self, run: Run, text: str) -> None:
        try:
            if hasattr(run.agent.provider, "has_credentials") and not run.agent.provider.has_credentials():
                raise AgentError(
                    "未找到可用的 API 凭据：请设置对应 provider 的环境变量 Key 后重启 ui"
                )
            run.agent.run(text)
            with run.lock:
                run.status = "done"
        except AgentError as exc:
            with run.lock:
                run.status = "error"
                run.error = str(exc)
        except Exception as exc:  # never kill the server thread silently
            with run.lock:
                run.status = "error"
                run.error = f"{type(exc).__name__}: {exc}"

    def _record(self, run: Run, kind: str, data: dict) -> None:
        clean = {}
        for key, value in data.items():
            if key in ("content", "result"):
                clean[key] = _clip(value)
            elif key == "arguments":
                clean[key] = value if isinstance(value, dict) else _clip(value, 1000)
            else:
                clean[key] = value
        with run.lock:
            run.events.append({"seq": len(run.events), "type": kind, "data": clean, "ts": time.time()})

    def _approve(self, run: Run, tool: str, summary: str) -> bool:
        approval_id = secrets.token_hex(8)
        waiter = threading.Event()
        pending = {
            "id": approval_id,
            "tool": tool,
            "summary": summary,
            "event": waiter,
            "decision": None,
        }
        with self.lock:
            self.approvals[approval_id] = (run, pending)
        with run.lock:
            run.pending = pending
        self._record(run, "approval", {"id": approval_id, "tool": tool, "summary": summary})
        answered = waiter.wait(APPROVAL_TIMEOUT)
        with self.lock:
            self.approvals.pop(approval_id, None)
        with run.lock:
            run.pending = None
        approved = bool(answered and pending["decision"])
        self._record(
            run,
            "approval_result",
            {"id": approval_id, "approved": approved, "timeout": not answered},
        )
        return approved

    def decide(self, approval_id: str, approve: bool) -> bool:
        with self.lock:
            item = self.approvals.get(approval_id)
        if item is None:
            return False
        _, pending = item
        pending["decision"] = bool(approve)
        pending["event"].set()
        return True


def list_evidence(session_id: str) -> list[dict]:
    """Read evidence headers without creating anything on disk."""
    base = config_module.ANGEL_HOME / "evidence" / session_id
    if not base.is_dir():
        return []
    items = []
    for path in sorted(base.glob("*.md"))[:200]:
        source = kind = fetched = query = ""
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for _ in range(8):
                    line = handle.readline()
                    if not line:
                        break
                    if line.startswith("- 来源："):
                        source = line.split("：", 1)[1].strip()
                    elif line.startswith("- 类型："):
                        kind = line.split("：", 1)[1].strip()
                    elif line.startswith("- 抓取时间："):
                        fetched = line.split("：", 1)[1].strip()
                    elif line.startswith("- 搜索词："):
                        query = line.split("：", 1)[1].strip()
        except OSError:
            continue
        items.append(
            {"file": path.name, "source": source, "kind": kind, "time": fetched, "query": query}
        )
    return items


def find_plan(messages: list[dict], events: list[dict], status: str) -> dict | None:
    """The most recent `plan` tool call, from live events or the transcript."""
    candidates: list = []
    for msg in messages:
        for call in msg.get("tool_calls") or []:
            fn = call.get("function") or {}
            if fn.get("name") == "plan":
                candidates.append(fn.get("arguments"))
    for event in events:
        if event.get("type") == "tool_start" and (event.get("data") or {}).get("name") == "plan":
            candidates.append(event["data"].get("arguments"))
    for raw in reversed(candidates):
        args = raw
        if isinstance(raw, str):
            try:
                args = json.loads(raw)
            except ValueError:
                continue
        if isinstance(args, dict) and isinstance(args.get("steps"), list):
            return {
                "title": str(args.get("title") or ""),
                "steps": [str(step) for step in args["steps"]],
                "state": "running" if status == "running" else "finished",
            }
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "AngelUI"
    sys_version = ""
    state: UIState  # set on the server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet by default; never log tokens
        if getattr(self.server, "verbose", False):
            path = self.path.split("?", 1)[0]
            sys.stderr.write(f"[angel ui] {self.command} {path}\n")

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

    def _token_ok(self, allow_query: bool = False) -> bool:
        supplied = self.headers.get("X-Angel-Token") or ""
        if not supplied and allow_query:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            supplied = (query.get("token") or [""])[0]
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

    # -- verbs --------------------------------------------------------------
    def do_GET(self):
        if not self._host_ok():
            return self._error(HTTPStatus.MISDIRECTED_REQUEST, "Host 不被允许")
        path, query = self._route()
        if path in ("/", "/index.html"):
            if not self._token_ok(allow_query=True):
                body = FORBIDDEN_PAGE.encode("utf-8")
                return self._send(HTTPStatus.FORBIDDEN, body, "text/html; charset=utf-8", {"Content-Security-Policy": CSP})
            return self._send(HTTPStatus.OK, PAGE_HTML.encode("utf-8"), "text/html; charset=utf-8", {"Content-Security-Policy": CSP})
        if path == "/favicon.ico":
            return self._send(HTTPStatus.NO_CONTENT, b"", "image/x-icon")
        if path == "/groups":
            if not self._token_ok(allow_query=True):
                return self._send(
                    HTTPStatus.FORBIDDEN, FORBIDDEN_PAGE.encode("utf-8"),
                    "text/html; charset=utf-8", {"Content-Security-Policy": GROUP_CSP},
                )
            html = (Path(__file__).parent / "group_ui.html").read_bytes()
            return self._send(
                HTTPStatus.OK, html, "text/html; charset=utf-8",
                {"Content-Security-Policy": GROUP_CSP},
            )
        if path == "/group-ui.js":
            code = (Path(__file__).parent / "group-ui.js").read_bytes()
            return self._send(
                HTTPStatus.OK, code, "text/javascript; charset=utf-8",
            )
        if not path.startswith("/api/"):
            return self._error(HTTPStatus.NOT_FOUND, "未找到")
        if not self._token_ok():
            return self._error(HTTPStatus.FORBIDDEN, "token 无效")
        if path == "/api/groups":
            return self._json(
                HTTPStatus.OK, {"groups": self.state.groups.list_rooms()}
            )
        match = re.fullmatch(r"/api/groups/([a-z][a-z0-9_-]{0,31})", path)
        if match:
            try:
                return self._json(
                    HTTPStatus.OK, self.state.groups.get(match.group(1))
                )
            except GroupError as exc:
                return self._error(HTTPStatus.NOT_FOUND, str(exc))
        if path == "/api/info":
            return self._json(HTTPStatus.OK, self.state.info())
        if path == "/api/sessions":
            return self._json(HTTPStatus.OK, {"sessions": memory_module.list_sessions()})
        match = re.fullmatch(r"/api/sessions/([^/]+)", path)
        if match:
            sid = urllib.parse.unquote(match.group(1))
            if not SESSION_ID_RE.match(sid):
                return self._error(HTTPStatus.BAD_REQUEST, "会话 id 无效")
            try:
                since = max(0, int((query.get("since") or ["0"])[0]))
            except ValueError:
                since = 0
            return self._json(HTTPStatus.OK, self.state.session_view(sid, since))
        return self._error(HTTPStatus.NOT_FOUND, "未找到")

    def do_POST(self):
        if not self._host_ok():
            return self._error(HTTPStatus.MISDIRECTED_REQUEST, "Host 不被允许")
        path, _ = self._route()
        if not self._token_ok():
            return self._error(HTTPStatus.FORBIDDEN, "token 无效")
        try:
            body = self._body()
        except (ValueError, UnicodeDecodeError) as exc:
            return self._error(HTTPStatus.BAD_REQUEST, f"请求无效：{exc}")
        if path == "/api/groups":
            try:
                room = self.state.groups.create(
                    body.get("id"), body.get("name"), body.get("bots")
                )
            except GroupError as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return self._json(HTTPStatus.CREATED, room)
        match = re.fullmatch(r"/api/groups/([a-z][a-z0-9_-]{0,31})/messages", path)
        if match:
            try:
                result = self.state.groups.send(
                    match.group(1), body.get("text"), body.get("rounds", 1)
                )
            except GroupError as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return self._json(HTTPStatus.OK, result)
        if path == "/api/sessions":
            return self._json(HTTPStatus.CREATED, {"id": self.state.new_session()})
        if path == "/api/mode":
            try:
                mode = self.state.set_mode(str(body.get("mode", "")))
            except ValueError as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            except RuntimeError as exc:
                return self._error(HTTPStatus.CONFLICT, str(exc))
            return self._json(HTTPStatus.OK, {"mode": mode})
        match = re.fullmatch(r"/api/sessions/([^/]+)/messages", path)
        if match:
            sid = urllib.parse.unquote(match.group(1))
            if not SESSION_ID_RE.match(sid):
                return self._error(HTTPStatus.BAD_REQUEST, "会话 id 无效")
            text = str(body.get("text") or "").strip()
            if not text:
                return self._error(HTTPStatus.BAD_REQUEST, "消息不能为空")
            try:
                run = self.state.send(sid, text)
            except RuntimeError as exc:
                return self._error(HTTPStatus.CONFLICT, str(exc))
            return self._json(HTTPStatus.ACCEPTED, {"id": sid, "status": run.status, "error": run.error})
        match = re.fullmatch(r"/api/approvals/([0-9a-f]{16})", path)
        if match:
            if not self.state.decide(match.group(1), bool(body.get("approve"))):
                return self._error(HTTPStatus.NOT_FOUND, "审批已失效")
            return self._json(HTTPStatus.OK, {"ok": True})
        return self._error(HTTPStatus.NOT_FOUND, "未找到")

    def do_OPTIONS(self):  # no CORS: cross-origin pages get nothing
        self._error(HTTPStatus.FORBIDDEN, "不支持跨域请求")


class UIServer(ThreadingHTTPServer):
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
) -> UIServer:
    """Create the server and print a warning when binding beyond this machine."""
    if state is None:
        state = UIState(Path.cwd())
    if not is_loopback_host(host):
        stream = warn_stream if warn_stream is not None else sys.stderr
        print(
            f"警告：网页界面正在监听非本机地址 {host}。同一网络里的其他设备只要拿到 "
            "token 就能操作 Angel（读写文件、执行命令）。除非你清楚风险，请使用默认的 127.0.0.1。",
            file=stream,
        )
    return UIServer((host, port), state, verbose=verbose)


def ui_url(server: UIServer) -> str:
    host, port = server.server_address[:2]
    shown = "127.0.0.1" if host in ("0.0.0.0", "") else host
    if ":" in shown:
        shown = f"[{shown}]"
    return f"http://{shown}:{port}/?token={server.state.token}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="angel ui", description="启动 Angel 本地网页界面")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址（默认 127.0.0.1，只允许本机访问）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="端口（默认 8765，0 表示随机）")
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
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

    # The browser cannot approve local MCP process startup. Auto/readonly
    # do not launch MCP subprocesses; full is an explicit opt-in.
    mcp_manager = build_mcp_manager(mode=mode, interactive=False)
    state = UIState(
        workdir,
        mode=mode,
        provider_name=args.provider,
        model=args.model,
        profile=args.profile,
        mcp_manager=mcp_manager,
        context_window_tokens=context_limit(cfg.get("context_window_tokens")),
    )
    try:
        server = make_server(args.host, args.port, state, verbose=args.verbose)
    except OSError as exc:
        print(f"错误：无法监听 {args.host}:{args.port}：{exc}")
        if mcp_manager is not None:
            mcp_manager.stop_all()
        return 1
    url = ui_url(server)
    print(f"Angel {__version__} 网页界面已启动：{url}")
    print("这个链接里含有本次启动的访问 token，请不要分享。按 Ctrl+C 停止。")
    if args.open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        server.server_close()
        if mcp_manager is not None:
            mcp_manager.stop_all()
    return 0


CSP = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; "
    "frame-ancestors 'none'"
)
# Group UI uses a separate first-party JavaScript asset instead of inline JS.
GROUP_CSP = CSP.replace("script-src 'unsafe-inline'", "script-src 'self'")

FORBIDDEN_PAGE = """<!doctype html><meta charset="utf-8"><title>Angel</title>
<body style="font:16px system-ui;padding:40px;color:#111A42;background:#FAF8F4">
<h1>需要访问 token</h1><p>请使用启动 <code>python3 -m angel ui</code> 时终端里打印的完整链接（含 <code>?token=</code>）。</p>
<p>Open the full link printed in the terminal (it contains <code>?token=</code>).</p></body>"""

