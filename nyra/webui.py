"""Nyra 本地网页界面：`python3 -m nyra ui`。

纯标准库（http.server + threading），页面是内嵌的单个 HTML/CSS/JS，
不引用任何外部资源。复用 agent.py 的 Agent、memory.py 的会话存储和
tools.py 的审批门（通过 ToolContext.approve_fn），不重写核心逻辑。

安全：
- 默认只监听 127.0.0.1；绑定非本机地址时打印警告。
- 每次启动随机生成一个 token，页面通过 URL 参数 ?token= 带入，之后
  所有 API 请求都要在 X-Nyra-Token 请求头里带上它（防 CSRF；跨站页面
  无法设置自定义请求头而不触发预检，服务器也不回应 CORS）。
- 监听本机地址时校验 Host 头，防 DNS 重绑定。
- API Key 只报告“是否已配置”，绝不回显其值。
- 手机（PWA，`/m`）：用一次性配对码换设备专属 token（请求头
  X-Nyra-Device），磁盘上只存哈希，可在设置里撤销；只有带 --pair 或
  --host 时才监听局域网。配对、撤销、查看设备只认电脑端的启动 token，
  手机 token 不能再去配对别的设备。见 docs/mobile-pwa.md。
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
from .memory_browser import (
    MemoryBrowserError, MemoryConflict, inspect_memory, replace_memory,
)
from .agent import Agent, AgentError
from .groups import GroupStore, GroupError
from .config import (
    PROVIDERS,
    VALID_MODES,
    get_provider_presets,
    load_config,
    resolve_fallback_chain,
    resolve_profile,
    resolve_provider,
    validate_mode,
)
from .providers import Provider, build_provider_chain, describe_provider
from .skills import load_skills
from .tools import APPROVE_ALWAYS, SESSION_GRANT_TOOLS, TOOL_SCHEMAS
from .usage import context_limit
from .compact import validate_auto_compact_threshold, DEFAULT_AUTO_COMPACT_THRESHOLD
from .webui_page import PAGE_HTML
from .webui_mobile import MOBILE_HTML, MOBILE_MANIFEST, STARTUP_SIZES, solid_png
from .webui_mobile_assets import ICONS as MOBILE_ICONS
from . import qrcode as qr_module
from .pairing import (
    DeviceRegistry, PairingError, default_devices_path, lan_ipv4_addresses,
)
from .webui_fonts import FONTS as UI_FONTS

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
APPROVAL_TIMEOUT = 600.0
MAX_BODY = 256 * 1024
MAX_EVENT_TEXT = 4000
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
DEVICE_ID_RE = re.compile(r"^[0-9a-f]{16}$")
# Session -> working directory, written by the web UI when a session sends
# its first message, so the sidebar can group sessions by project. Lives
# next to the session files (list_sessions only reads *.jsonl).
PROJECTS_FILE = "ui-projects.json"
MAX_PROJECT_ENTRIES = 2000


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


def _fallback_notice(record) -> None:
    """Print a provider-switch notice to the server console (stderr).

    The web UI has no per-run stdout channel, so switches are reported
    where the operator runs the server, mirroring the CLI behaviour.
    """
    reason = record["error"]
    if len(reason) > 120:
        reason = reason[:117] + "…"
    print(
        f"模型切换：{record['from']} 失败（{reason}），已切换到 {record['to']} 继续",
        file=sys.stderr,
    )


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
        auto_compact_enabled: bool = False,
        auto_compact_threshold: float = DEFAULT_AUTO_COMPACT_THRESHOLD,
        devices: DeviceRegistry | None = None,
    ) -> None:
        self._devices = devices
        self._devices_lock = threading.Lock()
        # Base URL a phone on the LAN can reach (set by make_server when the
        # server listens beyond loopback); None means pairing is unavailable.
        self.pair_origin: str | None = None
        self.workdir = Path(workdir)
        self.mode = validate_mode(mode)
        self.groups = GroupStore(config_module.NYRA_HOME / "groups")
        self.token = token or secrets.token_urlsafe(24)
        self.provider_name = provider_name
        self.model = model
        self.profile = profile
        self.max_turns = max_turns
        self.context_window_tokens = context_limit(context_window_tokens)
        self.auto_compact_enabled = bool(auto_compact_enabled)
        self.auto_compact_threshold = validate_auto_compact_threshold(auto_compact_threshold)
        self.mcp_manager = mcp_manager
        self._provider_factory = provider_factory
        self._provider = None
        self.runs: dict[str, Run] = {}
        self.approvals: dict[str, tuple[Run, dict]] = {}
        self.lock = threading.Lock()
        self._mode_lock = threading.Lock()
        self._projects_lock = threading.Lock()

    def _on_switch(self, record) -> None:
        """Report a provider switch to the server log and to the chat.

        The stderr notice keeps the CLI behaviour; the model_switch event
        goes into every currently running run so the page shows the switch
        inline instead of silently answering from another model.
        """
        _fallback_notice(record)
        with self.lock:
            runs = list(self.runs.values())
        for run in runs:
            with run.lock:
                running = run.status == "running"
            if running:
                self._record(run, "model_switch", record)

    # -- provider -----------------------------------------------------------
    def provider(self):
        if self._provider is None:
            if self._provider_factory is not None:
                self._provider = self._provider_factory()
            else:
                cfg = load_config()
                prof = resolve_profile(self.profile, cfg)
                primary_cfg = resolve_provider(
                    self.provider_name or prof["provider"],
                    self.model or prof["model"],
                )
                # Same fallback chain as the CLI entries: on a recoverable
                # failure the call moves to the next provider. Fallback is
                # off by default and only the allowlist in
                # `fallback_providers` may be switched to. The chain
                # object is cached, but every chat() starts from the
                # primary again; switches are printed to the server log
                # and recorded as model_switch events in the running chat.
                self._provider = build_provider_chain(
                    primary_cfg,
                    resolve_fallback_chain(primary_cfg.name, cfg),
                    on_switch=self._on_switch,
                    provider_cls=Provider,
                    resolver=resolve_provider,
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
            # provider/model above already name the provider that answered
            # last; surface the switches too so the panel never implies
            # the configured primary answered when a fallback did.
            switches = getattr(prov, "switches", None)
            if switches:
                out["model_switches"] = list(switches)
            # The chain itself (primary first) so the model card can show
            # the configured fallback order, not just the last answer.
            chain = getattr(prov, "providers", None)
            if isinstance(chain, list) and chain:
                out["fallback_chain"] = [getattr(p, "name", "?") for p in chain]
            else:
                out["fallback_chain"] = [out["provider"]] if out.get("provider") else []
        except Exception as exc:  # unknown provider, bad profile …
            out["provider"] = None
            out["model"] = None
            out["provider_desc"] = ""
            out["credentials"] = False
            out["provider_error"] = str(exc)
            out["fallback_chain"] = []
        # Keys table: include custom providers too (built-ins alone would
        # hide a configured custom provider). A malformed custom entry
        # must not break /api/info, so fall back to the built-ins.
        try:
            key_presets = get_provider_presets(load_config())
        except Exception:
            key_presets = PROVIDERS
        keys = []
        for name, preset in key_presets.items():
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
                "auto_compact_enabled": self.auto_compact_enabled,
                "auto_compact_threshold": self.auto_compact_threshold,
                "mcp_enabled": bool(cfg.get("mcp_enabled")),
                "sandbox": cfg.get("sandbox") or "local",
                "profiles": sorted(profiles) if isinstance(profiles, dict) else [],
            }
        except Exception:
            out["config"] = {}
        out["mcp_tools"] = (
            len(self.mcp_manager.tool_schemas) if self.mcp_manager is not None else 0
        )
        # For the skills / settings views: full provider presets (14),
        # the 15 built-in tools with their approval flag, and skills.
        out["providers"] = list_providers()
        out["provider_count"] = len(out["providers"])
        out["tools"] = list_tools()
        out["tool_count"] = len(out["tools"])
        out["skills"] = list_skills()
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

    def set_provider(self, name: str, model: str | None = None) -> dict:
        """Switch the provider used for new sessions/agents (runtime-only).

        Validated with resolve_provider so unknown names, missing base
        URLs and plaintext-http external hosts fail here with a clear
        message instead of at the next chat call. Only the cached chain
        is reset: agents that already exist keep the provider they started
        with, so a switch never disturbs a running task. The switch does
        not persist to config.json; a restart restores the configured
        provider.
        """
        cfg = resolve_provider(name, model)
        with self._mode_lock:
            self.provider_name = cfg.name
            self.model = cfg.model
            self._provider = None
        return {"provider": cfg.name, "model": cfg.model}

    # -- persistent memory --------------------------------------------------
    def memory_scopes(self) -> list[dict]:
        """Known, existing memory owners; never enumerate arbitrary paths."""
        scopes = [{"scope": "global", "label": "Nyra · 全局记忆"}]
        for room in self.groups.list_rooms()[:50]:
            try:
                details = self.groups.get(room["id"])
            except GroupError:
                continue
            for bot in details.get("bots", []):
                if not isinstance(bot, dict):
                    continue
                scopes.append({
                    "scope": "bot", "room": room["id"], "bot": bot["id"],
                    "label": f"{room['name']} · {bot.get('name', bot['id'])}",
                })
        return scopes

    def memory_target(self, scope: str, room: str | None,
                      bot: str | None) -> tuple[Path, Path | None]:
        if scope == "global" and room is None and bot is None:
            return memory_module.MEMORY_PATH, None
        if scope != "bot" or not isinstance(room, str) or not isinstance(bot, str):
            raise MemoryBrowserError("记忆范围无效")
        try:
            data = self.groups.get(room)
        except GroupError as exc:
            raise MemoryBrowserError("机器人群不存在") from exc
        if not any(
            isinstance(entry, dict) and entry.get("id") == bot
            for entry in data.get("bots", [])
        ):
            raise MemoryBrowserError("指定机器人不属于该群")
        return self.groups.root / room / "bots" / bot / "MEMORY.md", self.groups.root

    def memory_view(self, scope: str, room: str | None,
                    bot: str | None) -> dict:
        path, root = self.memory_target(scope, room, bot)
        return inspect_memory(path, root=root)

    def memory_save(self, scope: str, room: str | None, bot: str | None,
                    revision: str, content: str) -> dict:
        path, root = self.memory_target(scope, room, bot)
        return replace_memory(path, revision, content, root=root)

    # -- phones -------------------------------------------------------------
    @property
    def devices(self) -> DeviceRegistry:
        with self._devices_lock:
            if self._devices is None:
                self._devices = DeviceRegistry(default_devices_path())
            return self._devices

    def pair_link(self, code: str) -> str:
        """The URL a phone scans: LAN address + one-time code in the fragment
        (the fragment never reaches server logs or Referer headers)."""
        if not self.pair_origin:
            raise PairingError(
                "网页界面只监听本机（127.0.0.1），手机连不上。请用 "
                "python3 -m nyra ui --pair 重新启动"
            )
        return f"{self.pair_origin}/m#pair={code}"

    def start_pairing(self) -> dict:
        if not self.pair_origin:
            self.pair_link("")  # raises with the explanation
        info = self.devices.start_pairing()
        url = self.pair_link(info["code"])
        matrix = qr_module.encode(url, "M")
        return {
            "code": info["code"],
            "expires_in": info["expires_in"],
            "url": url,
            "svg": qr_module.to_svg(matrix, title="Nyra 配对二维码"),
        }

    def pending_approvals(self) -> list[dict]:
        """Every approval waiting right now, across sessions (for the phone's
        badge / title). No secrets: tool name and the same summary the
        approval card shows."""
        with self.lock:
            items = list(self.approvals.items())
        out = []
        for approval_id, (run, pending) in items:
            out.append({
                "id": approval_id,
                "session": run.session_id,
                "tool": pending.get("tool"),
                "summary": pending.get("summary"),
                "always": bool(pending.get("always")),
            })
        return out

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
            "auto_compact_count": run.agent.auto_compact_count if run is not None and run.agent is not None else 0,
        }

    # -- projects -----------------------------------------------------------
    def _projects_path(self) -> Path:
        return Path(memory_module.SESSIONS_DIR) / PROJECTS_FILE

    def _load_projects(self) -> dict:
        try:
            data = json.loads(self._projects_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict):
            return {}
        return {
            k: v for k, v in data.items()
            if isinstance(k, str) and isinstance(v, str) and SESSION_ID_RE.match(k)
        }

    def _remember_project(self, session_id: str) -> None:
        """Record which working directory a session ran in (best effort)."""
        workdir = str(self.workdir.resolve())
        with self._projects_lock:
            data = self._load_projects()
            if data.get(session_id) == workdir:
                return
            data[session_id] = workdir
            if len(data) > MAX_PROJECT_ENTRIES:
                data = dict(list(data.items())[-MAX_PROJECT_ENTRIES:])
            path = self._projects_path()
            try:
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                tmp = path.with_name(path.name + f".{secrets.token_hex(4)}.tmp")
                tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
                os.replace(tmp, path)
            except OSError:
                pass  # grouping is cosmetic; never fail a run over it

    def sessions_view(self) -> dict:
        """Session list plus the project (working directory) each ran in.

        Sessions the web UI never ran (CLI sessions, older sessions) have
        project None: the page lists them under "other", it never guesses.
        """
        projects = self._load_projects()
        sessions = []
        for item in memory_module.list_sessions():
            item = dict(item)
            workdir = projects.get(item.get("id", ""))
            item["workdir"] = workdir
            item["project"] = Path(workdir).name if workdir else None
            sessions.append(item)
        current = self.workdir.resolve()
        return {
            "sessions": sessions,
            "project": {"name": current.name or str(current), "workdir": str(current)},
        }

    # -- plan mode ----------------------------------------------------------
    def plan(self, session_id: str, text: str) -> Run:
        """Read-only planning (same path as `nyra --plan`): writes only plan.md."""
        with self._mode_lock:
            run = self.get_run(session_id)
            with run.lock:
                if run.status == "running":
                    raise RuntimeError("这个会话正在执行任务，请等它完成")
                run.events = []
                run.error = ""
                run.status = "running"
            run.base_messages = (
                list(run.agent.messages) if run.agent is not None
                else (memory_module.load_session(session_id) or [])
            )
        self._record(run, "user", {"content": text, "plan": True})
        thread = threading.Thread(
            target=self._plan_work, args=(run, text),
            name=f"nyra-ui-plan-{session_id}", daemon=True,
        )
        run.thread = thread
        thread.start()
        return run

    def _plan_work(self, run: Run, text: str) -> None:
        from .plan_mode import PlanError, build_plan, render_plan, save_plan
        from .providers import ProviderError

        try:
            provider = self.provider()
            has = getattr(provider, "has_credentials", None)
            if callable(has) and not has():
                raise PlanError(
                    "未找到可用的 API 凭据：请设置对应 provider 的环境变量 Key 后重启 ui"
                )
            details = build_plan(provider, text, self.workdir)
            body = render_plan(text, details)
            digest = save_plan(self.workdir, body)
            self._remember_project(run.session_id)
            # "plan" is not clipped by _record (plans are capped by plan_mode).
            self._record(run, "plan_ready", {"plan": body, "sha256": digest, "path": "plan.md"})
            with run.lock:
                run.status = "done"
        except (PlanError, ProviderError, ValueError, OSError) as exc:
            with run.lock:
                run.status = "error"
                run.error = f"规划失败：{exc}"
        except Exception as exc:  # never kill the server thread silently
            with run.lock:
                run.status = "error"
                run.error = f"规划失败：{type(exc).__name__}: {exc}"

    def execute_plan(self, session_id: str, digest: str) -> Run:
        """Run the reviewed plan.md, verified by its exact SHA-256."""
        from .plan_mode import approved_execution_task, read_approved_plan

        if self.mode == "readonly":
            raise ValueError("只读模式不能执行计划，请切换到 auto 或 full 模式")
        approved = read_approved_plan(self.workdir, digest)  # PlanError is a ValueError
        return self.send(session_id, approved_execution_task(approved))

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
                    auto_compact_enabled=self.auto_compact_enabled,
                    auto_compact_threshold=self.auto_compact_threshold,
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
        self._remember_project(session_id)
        thread = threading.Thread(
            target=self._work, args=(run, text), name=f"nyra-ui-{session_id}", daemon=True
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

    def _approve(self, run: Run, tool: str, summary: str) -> bool | str:
        approval_id = secrets.token_hex(8)
        waiter = threading.Event()
        # "always" says whether a session grant is possible for this tool
        # (same scopes as the terminal's "a" answer; see tools.py).
        can_always = tool in SESSION_GRANT_TOOLS
        pending = {
            "id": approval_id,
            "tool": tool,
            "summary": summary,
            "always": can_always,
            "event": waiter,
            "decision": None,
        }
        with self.lock:
            self.approvals[approval_id] = (run, pending)
        with run.lock:
            run.pending = pending
        self._record(run, "approval", {
            "id": approval_id, "tool": tool, "summary": summary, "always": can_always,
        })
        answered = waiter.wait(APPROVAL_TIMEOUT)
        with self.lock:
            self.approvals.pop(approval_id, None)
        with run.lock:
            run.pending = None
        decision = pending["decision"] if answered else None
        approved = bool(decision)
        always = decision == APPROVE_ALWAYS
        self._record(
            run,
            "approval_result",
            {"id": approval_id, "approved": approved, "always": always,
             "timeout": not answered},
        )
        return APPROVE_ALWAYS if always else approved

    def decide(self, approval_id: str, approve: bool, always: bool = False) -> bool:
        """Answer a pending approval. always=True grants it for the session.

        Raises ValueError when a session grant is asked for a tool that has
        no session scope (it would silently become a one-time approval).
        """
        with self.lock:
            item = self.approvals.get(approval_id)
        if item is None:
            return False
        _, pending = item
        if approve and always:
            if not pending.get("always"):
                raise ValueError("这个操作不支持“本会话始终允许”，请逐次批准")
            pending["decision"] = APPROVE_ALWAYS
        else:
            pending["decision"] = bool(approve)
        pending["event"].set()
        return True


# Tools that need human approval before they run (they write, execute or
# send something). The rest are read-only. This mirrors the _check_approval
# call sites in tools.py; plan writes a plan file, so it needs approval.
NEEDS_APPROVAL_TOOLS = frozenset({
    "write_file", "edit_file", "apply_patch", "shell",
    "http_post", "memory_append", "save_skill", "plan",
    "browser_navigate", "browser_click", "browser_screenshot",
    "computer_screenshot", "computer_click", "computer_type",
    "computer_key", "computer_windows",
})


def list_tools() -> list[dict]:
    """The 24 built-in tools with their approval flag (no poppy tools)."""
    out = []
    for schema in TOOL_SCHEMAS:
        fn = schema.get("function") or {}
        name = fn.get("name") or schema.get("name")
        if not name or name.startswith("poppy_"):
            continue
        out.append({
            "name": name,
            "description": fn.get("description") or "",
            "needs_approval": name in NEEDS_APPROVAL_TOOLS,
        })
    return out


def list_skills() -> list[dict]:
    """Built-in + user skills (name + description only)."""
    dirs = [
        Path(__file__).parent.parent / "skills",
        config_module.NYRA_HOME / "skills",
    ]
    try:
        return [
            {"name": s.name, "description": s.description}
            for s in load_skills(dirs)
        ]
    except Exception:
        return []


def list_providers() -> list[dict]:
    """All provider presets (13, custom included) with their defaults."""
    try:
        presets = get_provider_presets(load_config())
    except Exception:
        presets = PROVIDERS
    out = []
    for name, preset in presets.items():
        env_key = preset.get("env_key")
        out.append({
            "name": name,
            "default_model": preset.get("default_model"),
            "env_key": env_key,
            "configured": bool(env_key and os.environ.get(env_key)),
            "models": list(preset.get("models") or []),
        })
    return out


def list_evidence(session_id: str) -> list[dict]:
    """Read evidence headers without creating anything on disk."""
    base = config_module.NYRA_HOME / "evidence" / session_id
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
    server_version = "NyraUI"
    sys_version = ""
    state: UIState  # set on the server
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet by default; never log tokens
        if getattr(self.server, "verbose", False):
            path = self.path.split("?", 1)[0]
            sys.stderr.write(f"[nyra ui] {self.command} {path}\n")

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
        supplied = self.headers.get("X-Nyra-Token") or ""
        if not supplied and allow_query:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            supplied = (query.get("token") or [""])[0]
        return bool(supplied) and secrets.compare_digest(
            supplied.encode("utf-8", "surrogateescape"), self.state.token.encode("utf-8")
        )

    def _device(self) -> dict | None:
        """The paired phone presenting a valid X-Nyra-Device token, if any."""
        supplied = self.headers.get("X-Nyra-Device") or ""
        if not supplied:
            return None
        return self.state.devices.authenticate(supplied)

    def _api_auth(self) -> str | None:
        """'owner' (desktop start token), 'device' (paired phone) or None
        after an error response has been sent."""
        if self._token_ok():
            return "owner"
        if self.headers.get("X-Nyra-Device"):
            if self._device() is not None:
                return "device"
            self._error(HTTPStatus.UNAUTHORIZED, "这台设备未配对或已被撤销")
            return None
        self._error(HTTPStatus.FORBIDDEN, "token 无效")
        return None

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("Content-Length 无效") from None
        if length < 0:
            # 负值会让 rfile.read(length) 读到连接关闭（挂起/耗尽），
            # 必须当作无效请求拒绝。
            raise ValueError("Content-Length 无效")
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

    def _mobile_get(self, path: str) -> bool:
        """Public phone shell: the page and its static assets carry no
        secrets, so they need no token (an installed app opens /m without
        one). Every API call they make is still authenticated."""
        if path in ("/m", "/m/"):
            self._send(HTTPStatus.OK, MOBILE_HTML.encode("utf-8"),
                       "text/html; charset=utf-8", {"Content-Security-Policy": CSP})
            return True
        if path == "/m/manifest.json":
            self._send(HTTPStatus.OK,
                       json.dumps(MOBILE_MANIFEST, ensure_ascii=False).encode("utf-8"),
                       "application/manifest+json")
            return True
        match = re.fullmatch(r"/m/icon-(180|192|512)\.png", path)
        if match:
            self._send(HTTPStatus.OK, MOBILE_ICONS[int(match.group(1))], "image/png")
            return True
        match = re.fullmatch(r"/m/startup/(\d{3,4})x(\d{3,4})\.png", path)
        if match:
            size = (int(match.group(1)), int(match.group(2)))
            if size not in STARTUP_SIZES:
                self._error(HTTPStatus.NOT_FOUND, "未找到")
                return True
            self._send(HTTPStatus.OK, solid_png(*size), "image/png")
            return True
        return False

    # -- verbs --------------------------------------------------------------
    def do_GET(self):
        if not self._host_ok():
            return self._error(HTTPStatus.MISDIRECTED_REQUEST, "Host 不被允许")
        path, query = self._route()
        if path.startswith("/m") and self._mobile_get(path):
            return None
        if path in ("/", "/index.html"):
            if not self._token_ok(allow_query=True):
                body = FORBIDDEN_PAGE.encode("utf-8")
                return self._send(HTTPStatus.FORBIDDEN, body, "text/html; charset=utf-8", {"Content-Security-Policy": CSP})
            return self._send(HTTPStatus.OK, PAGE_HTML.encode("utf-8"), "text/html; charset=utf-8", {"Content-Security-Policy": CSP})
        if path == "/favicon.ico":
            return self._send(HTTPStatus.NO_CONTENT, b"", "image/x-icon")
        match = re.fullmatch(r"/assets/fonts/([a-z0-9-]+\.woff)", path)
        if match:
            # Fonts ship inside the package (nyra/webui_fonts.py) and are
            # fetched by the page with the token header, then loaded via
            # the FontFace API: no font-src needed in the CSP.
            if not self._token_ok() and self._device() is None:
                return self._error(HTTPStatus.FORBIDDEN, "token 无效")
            data = UI_FONTS.get(match.group(1))
            if data is None:
                return self._error(HTTPStatus.NOT_FOUND, "未找到")
            return self._send(HTTPStatus.OK, data, "font/woff")
        if path == "/manifest.json":
            # Browsers fetch the manifest as a subresource without the
            # X-Nyra-Token header, so the token rides in the query string,
            # exactly like the page itself. The page JS rewrites this link
            # with the token on load (see webui_page.py).
            if not self._token_ok(allow_query=True):
                return self._error(HTTPStatus.FORBIDDEN, "token 无效")
            return self._send(
                HTTPStatus.OK,
                json.dumps(MANIFEST, ensure_ascii=False).encode("utf-8"),
                "application/manifest+json",
            )
        if path == "/nyra-mark.svg":
            # Same token rule as the manifest (the browser fetches the icon
            # as a subresource). 404 when the repo's docs tree is absent
            # (e.g. an installed copy without docs/).
            if not self._token_ok(allow_query=True):
                return self._error(HTTPStatus.FORBIDDEN, "token 无效")
            icon_path = (
                Path(__file__).resolve().parent.parent
                / "docs"
                / "assets"
                / "nyra-mark.svg"
            )
            try:
                data = icon_path.read_bytes()
            except OSError:
                return self._error(HTTPStatus.NOT_FOUND, "未找到")
            return self._send(HTTPStatus.OK, data, "image/svg+xml")
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
        who = self._api_auth()
        if who is None:
            return None
        if path == "/api/approvals":
            return self._json(HTTPStatus.OK, {"approvals": self.state.pending_approvals()})
        if path in ("/api/devices", "/api/pair/status"):
            if who != "owner":
                return self._error(HTTPStatus.FORBIDDEN, "只能在电脑上管理已配对设备")
            return self._json(HTTPStatus.OK, {
                "devices": self.state.devices.list_devices(),
                "pairing": self.state.devices.pairing_status(),
                "lan": bool(self.state.pair_origin),
            })
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
        if path == "/api/schedule":
            try:
                from . import scheduler as scheduler_module
                data = scheduler_module.load_schedule()
                tasks = scheduler_module.list_tasks(data)
            except Exception as exc:
                return self._error(HTTPStatus.BAD_REQUEST, f"定时任务读取失败：{exc}")
            return self._json(HTTPStatus.OK, {"tasks": tasks})
        if path == "/api/memory/scopes":
            return self._json(
                HTTPStatus.OK, {"scopes": self.state.memory_scopes()}
            )
        if path == "/api/memory":
            scope = (query.get("scope") or ["global"])[0]
            room = (query.get("room") or [None])[0]
            bot = (query.get("bot") or [None])[0]
            try:
                result = self.state.memory_view(scope, room, bot)
            except (MemoryBrowserError, OSError) as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return self._json(HTTPStatus.OK, result)
        if path == "/api/sessions":
            return self._json(HTTPStatus.OK, self.state.sessions_view())
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
        if path == "/api/pair":
            # The one unauthenticated API: a phone trades the one-time code
            # (short-lived, single use, limited attempts) for its own token.
            try:
                body = self._body()
            except (ValueError, UnicodeDecodeError) as exc:
                return self._error(HTTPStatus.BAD_REQUEST, f"请求无效：{exc}")
            try:
                device = self.state.devices.redeem(
                    str(body.get("code") or ""), str(body.get("name") or "")
                )
            except PairingError as exc:
                return self._error(HTTPStatus.UNAUTHORIZED, str(exc))
            except OSError as exc:
                return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, f"保存设备失败：{exc}")
            return self._json(HTTPStatus.OK, device)
        who = self._api_auth()
        if who is None:
            return None
        try:
            body = self._body()
        except (ValueError, UnicodeDecodeError) as exc:
            return self._error(HTTPStatus.BAD_REQUEST, f"请求无效：{exc}")
        if path == "/api/pair/start" or re.fullmatch(r"/api/devices/[^/]+/revoke", path):
            if who != "owner":
                return self._error(HTTPStatus.FORBIDDEN, "只能在电脑上管理已配对设备")
            if path == "/api/pair/start":
                try:
                    return self._json(HTTPStatus.OK, self.state.start_pairing())
                except PairingError as exc:
                    return self._error(HTTPStatus.CONFLICT, str(exc))
            device_id = path.split("/")[3]
            if not DEVICE_ID_RE.match(device_id):
                return self._error(HTTPStatus.BAD_REQUEST, "设备 id 无效")
            if not self.state.devices.revoke(device_id):
                return self._error(HTTPStatus.NOT_FOUND, "设备不存在")
            return self._json(HTTPStatus.OK, {"ok": True})
        if path == "/api/memory":
            try:
                result = self.state.memory_save(
                    body.get("scope", "global"), body.get("room"), body.get("bot"),
                    body.get("revision"), body.get("content"),
                )
            except MemoryConflict as exc:
                return self._error(HTTPStatus.CONFLICT, str(exc))
            except (MemoryBrowserError, OSError) as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return self._json(HTTPStatus.OK, result)
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
        if path == "/api/provider":
            name = str(body.get("provider") or "").strip()
            raw_model = body.get("model")
            model = str(raw_model).strip() if isinstance(raw_model, str) else None
            if not name:
                return self._error(HTTPStatus.BAD_REQUEST, "请指定 provider")
            try:
                switched = self.state.set_provider(name, model or None)
            except ValueError as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return self._json(HTTPStatus.OK, switched)

        if path == "/api/mode":
            try:
                mode = self.state.set_mode(str(body.get("mode", "")))
            except ValueError as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            except RuntimeError as exc:
                return self._error(HTTPStatus.CONFLICT, str(exc))
            return self._json(HTTPStatus.OK, {"mode": mode})
        if path == "/api/schedule":
            try:
                from . import scheduler as scheduler_module
                data = scheduler_module.load_schedule()
                action = str(body.get("action") or "")
                if action == "add":
                    # 网页端新建定时任务暂缓开放：等任务队列合并（E）后恢复。
                    # 现在 main 上的任务默认用 full 模式，E 合并后会拒绝这种
                    # 情况；请用 `nyra schedule add` 命令添加。
                    return self._error(
                        HTTPStatus.CONFLICT,
                        "网页端新建定时任务暂缓开放，等任务队列合并（E）后恢复；"
                        "请用 nyra schedule add 命令添加",
                    )
                if action == "toggle":
                    name = str(body.get("name") or "")
                    for task in data.get("tasks", []):
                        if task.get("name") == name:
                            task["enabled"] = not task.get("enabled", True)
                            scheduler_module.save_schedule(data)
                            return self._json(HTTPStatus.OK, {"task": task})
                    return self._error(HTTPStatus.NOT_FOUND, "任务不存在")
                if action == "remove":
                    name = str(body.get("name") or "")
                    if scheduler_module.remove_task(data, name):
                        scheduler_module.save_schedule(data)
                        return self._json(HTTPStatus.OK, {"ok": True})
                    return self._error(HTTPStatus.NOT_FOUND, "任务不存在")
                return self._error(HTTPStatus.BAD_REQUEST, "未知的操作")
            except Exception as exc:
                return self._error(HTTPStatus.BAD_REQUEST, f"定时任务操作失败：{exc}")
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
        match = re.fullmatch(r"/api/sessions/([^/]+)/plan", path)
        if match:
            sid = urllib.parse.unquote(match.group(1))
            if not SESSION_ID_RE.match(sid):
                return self._error(HTTPStatus.BAD_REQUEST, "会话 id 无效")
            text = str(body.get("text") or "").strip()
            if not text:
                return self._error(HTTPStatus.BAD_REQUEST, "任务不能为空")
            try:
                run = self.state.plan(sid, text)
            except RuntimeError as exc:
                return self._error(HTTPStatus.CONFLICT, str(exc))
            return self._json(HTTPStatus.ACCEPTED, {"id": sid, "status": run.status, "error": run.error})
        match = re.fullmatch(r"/api/sessions/([^/]+)/plan/execute", path)
        if match:
            sid = urllib.parse.unquote(match.group(1))
            if not SESSION_ID_RE.match(sid):
                return self._error(HTTPStatus.BAD_REQUEST, "会话 id 无效")
            digest = str(body.get("sha256") or "")
            if not SHA256_RE.match(digest):
                return self._error(HTTPStatus.BAD_REQUEST, "需要完整的 64 位 SHA-256 计划校验值")
            try:
                run = self.state.execute_plan(sid, digest)
            except RuntimeError as exc:
                return self._error(HTTPStatus.CONFLICT, str(exc))
            except (ValueError, OSError) as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return self._json(HTTPStatus.ACCEPTED, {"id": sid, "status": run.status, "error": run.error})
        match = re.fullmatch(r"/api/approvals/([0-9a-f]{16})", path)
        if match:
            try:
                ok = self.state.decide(
                    match.group(1), bool(body.get("approve")), always=bool(body.get("always"))
                )
            except ValueError as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            if not ok:
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
            "token 就能操作 Nyra（读写文件、执行命令）。除非你清楚风险，请使用默认的 127.0.0.1。",
            file=stream,
        )
    server = UIServer((host, port), state, verbose=verbose)
    if not is_loopback_host(host):
        state.pair_origin = lan_origin(server)
    return server


def lan_origin(server: UIServer) -> str | None:
    """http://<LAN IP>:<port> for a server bound beyond loopback."""
    host, port = server.server_address[:2]
    if host in ("0.0.0.0", "", "::"):
        candidates = lan_ipv4_addresses()
        if not candidates:
            return None
        host = candidates[0]
    if ":" in host:
        host = f"[{host}]"
    return f"http://{host}:{port}"


def ui_url(server: UIServer) -> str:
    host, port = server.server_address[:2]
    shown = "127.0.0.1" if host in ("0.0.0.0", "") else host
    if ":" in shown:
        shown = f"[{shown}]"
    return f"http://{shown}:{port}/?token={server.state.token}"


def url_json(server: UIServer) -> str:
    """One machine-readable line for a parent process (the desktop app).

    The desktop shell starts `nyra ui --port 0 --print-url-json` and reads
    the first stdout line; everything human-readable goes to stderr in that
    mode so the line is always first. It carries the same token the printed
    link does, over a private pipe, so treat it like that link.
    """
    host, port = server.server_address[:2]
    return json.dumps(
        {
            "nyra": "ui",
            "version": __version__,
            "url": ui_url(server),
            "host": host,
            "port": port,
            "token": server.state.token,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def watch_stdin_close(on_close: Callable[[], None], stream=None) -> threading.Thread:
    """Call on_close once stdin reaches EOF (the parent app went away)."""
    source = stream if stream is not None else sys.stdin

    def run() -> None:
        try:
            buffer = getattr(source, "buffer", source)
            while buffer.read(4096):
                pass
        except (OSError, ValueError):
            pass
        on_close()

    thread = threading.Thread(target=run, name="nyra-stdin-watch", daemon=True)
    thread.start()
    return thread


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="nyra ui", description="启动 Nyra 本地网页界面")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址（默认 127.0.0.1，只允许本机访问）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="端口（默认 8765，0 表示随机）")
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    parser.add_argument(
        "--pair", action="store_true",
        help="连接手机：监听局域网（默认 0.0.0.0），并在终端显示配对二维码",
    )
    parser.add_argument("--workdir", default=".", help="工作目录")
    parser.add_argument("--mode", choices=VALID_MODES, default=None, help="审批模式（默认读配置，一般为 auto）")
    parser.add_argument("--provider", default=None, help="模型 provider")
    parser.add_argument("--model", default=None, help="模型 id")
    parser.add_argument("--profile", default=None, help="provider 档案")
    parser.add_argument("--verbose", action="store_true", help="打印请求日志（不含 token）")
    parser.add_argument(
        "--print-url-json", action="store_true",
        help="供桌面端读取：标准输出第一行打印一行 JSON（含地址与 token），其余提示改写到标准错误",
    )
    parser.add_argument(
        "--exit-on-stdin-close", action="store_true",
        help="标准输入关闭时退出（桌面端退出后自动停止）",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.pair and args.host == DEFAULT_HOST:
        args.host = "0.0.0.0"
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
    url = ui_url(server)
    human = sys.stdout
    if args.print_url_json:
        print(url_json(server), flush=True)
        human = sys.stderr
    display_url = url
    if args.print_url_json:
        # 该模式下人类可读行走 stderr，桌面端会把它显示在引导页上；
        # 真实 token 只应走 stdout 的 JSON 行（父进程私有管道），
        # stderr 里打码，避免活 token 明文出现在屏幕上。
        display_url = re.sub(r"([?&]token=)[^&\s]*", r"\1<redacted>", url)
    print(f"Nyra {__version__} 网页界面已启动：{display_url}", file=human)
    print("这个链接里含有本次启动的访问 token，请不要分享。按 Ctrl+C 停止。", file=human)
    if args.exit_on_stdin_close:
        watch_stdin_close(lambda: threading.Thread(target=server.shutdown, daemon=True).start())
    if args.pair:
        print_pairing(state, stream=human if args.print_url_json else None)
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


def print_pairing(state: UIState, stream=None) -> bool:
    """Print the phone-pairing QR code (Unicode blocks) and the one-time code."""
    out = stream if stream is not None else sys.stdout
    try:
        info = state.start_pairing()
    except PairingError as exc:
        print(f"无法生成配对码：{exc}", file=out)
        return False
    ansi = hasattr(out, "isatty") and out.isatty() and os.environ.get("NO_COLOR") is None
    print("", file=out)
    print("用手机相机扫描下面的二维码，连接这台电脑上的 Nyra：", file=out)
    try:
        print(qr_module.to_terminal(qr_module.encode(info["url"], "M"), ansi=ansi), file=out)
    except UnicodeEncodeError:
        print("（终端不支持方块字符，二维码无法显示，请手动打开下面的地址）", file=out)
    print(f"或在手机浏览器打开：{state.pair_origin}/m  并输入配对码 {info['code']}", file=out)
    minutes = max(1, info["expires_in"] // 60)
    print(
        f"配对码 {minutes} 分钟内有效、只能用一次、错 5 次作废；过期后在网页“设置 → 手机”里点“连接手机”重新生成。",
        file=out,
    )
    print("只在自己信任的 Wi-Fi 里配对；已配对的手机可以在设置里撤销。", file=out)
    return True


CSP = (
    "default-src 'none'; manifest-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; "
    "frame-ancestors 'none'"
)
# Group UI uses a separate first-party JavaScript asset instead of inline JS.
GROUP_CSP = CSP.replace("script-src 'unsafe-inline'", "script-src 'self'")

FORBIDDEN_PAGE = """<!doctype html><meta charset="utf-8"><title>Nyra</title>
<body style="font:16px system-ui;padding:40px;color:#2A2D34;background:#F3F5F4">
<h1>需要访问 token</h1><p>请使用启动 <code>python3 -m nyra ui</code> 时终端里打印的完整链接（含 <code>?token=</code>）。</p>
<p>Open the full link printed in the terminal (it contains <code>?token=</code>).</p></body>"""

# Web App Manifest for installing the UI on a phone ("Add to Home Screen").
# Colors follow the desktop v2 design (black-and-white): paper #FFFFFF,
# ink #0B0B0C (the page sets light/dark theme-color itself).
# start_url is "/" on purpose: the access token is random per start, so it
# cannot be baked into this static manifest. Tapping the installed icon
# opens the token-required page; open the printed link (with token) first,
# then install. See docs/mobile-pwa.md.
MANIFEST = {
    "name": "Nyra",
    "short_name": "Nyra",
    "description": "Nyra — 本地 AI 助手（网页界面）",
    "start_url": "/",
    "scope": "/",
    "display": "standalone",
    "background_color": "#FFFFFF",
    "theme_color": "#0B0B0C",
    "icons": [
        {
            "src": "/nyra-mark.svg",
            "sizes": "any",
            "type": "image/svg+xml",
            "purpose": "any",
        },
    ],
}

