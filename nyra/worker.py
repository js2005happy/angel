"""Python worker entry for the hybrid Go migration (Batch 1).

Invocation (module form)::

    python3 -m nyra.worker [--session ID] [--workdir DIR]
                            [--provider NAME] [--model MODEL]
                            [--mode MODE] [--max-turns N]

Why the module form: the design doc's ``python3 -m nyra worker`` (space
form) would need a change to ``nyra/__main__.py`` or ``nyra/cli.py``,
and Batch 1 adds files only -- it never modifies an existing entry point
or a frozen file. ``python3 -m nyra.worker`` is behaviorally identical;
the host spawns this form. The space form can be added later with a few
lines in ``__main__.py`` once the freeze lifts; the protocol is the same.

One worker process is one session with one provider (chosen at startup).
It reads JSONL requests from stdin, runs an :class:`nyra.agent.Agent`
in-process, and writes JSONL events to stdout. See
:mod:`nyra.worker_protocol` for the versioned contract.

Approval authority stays in Python: the worker's ``approve_fn`` only
relays the decision the host human made. It never approves on its own,
and any protocol problem (timeout, unmatched or malformed decision,
stdin closed) is a refusal, never an approval.
"""

from __future__ import annotations

import argparse
import queue
import sys
import threading
from contextlib import redirect_stdout
from pathlib import Path

from .agent import Agent, AgentError
from .compact import (
    DEFAULT_AUTO_COMPACT_THRESHOLD,
    validate_auto_compact_threshold,
)
from .config import load_config, resolve_provider, validate_mode
from .memory import load_session
from .providers import ProviderError, build_provider_chain
from .usage import context_limit
from .worker_protocol import (
    APPROVAL_TIMEOUT,
    decode_line,
    encode_line,
    ensure_request_id,
    new_id,
    validate_approval_decision,
    validate_run_request,
)

EXIT_SUCCESS = 0
EXIT_RUNTIME = 1
EXIT_ARGUMENT = 2
EXIT_INTERRUPTED = 130


def _log(message: str) -> None:
    """Write a log line to stderr (never part of the protocol)."""
    print(message, file=sys.stderr, flush=True)


class _WorkerShutdown(BaseException):
    """Raised when the host is gone (stdout broken); exit cleanly."""

    def __init__(self, exit_code: int = EXIT_SUCCESS) -> None:
        super().__init__(exit_code)
        self.exit_code = exit_code


class WorkerEmitter:
    """Thread-safe stdout JSONL writer.

    stdout carries ONLY protocol lines, one JSON object per line, flushed
    after every write. The stream object is captured at construction, so
    the emitter keeps writing to the real stdout even while ``agent.run``
    redirects ``sys.stdout`` to stderr.
    """

    def __init__(self, stream) -> None:
        self._stream = stream
        self._lock = threading.Lock()
        self.seq = 0

    def emit(self, event_type: str, **payload) -> None:
        with self._lock:
            self.seq += 1
            line = encode_line(event_type, self.seq, **payload)
            try:
                self._stream.write(line + "\n")
                self._stream.flush()
            except (BrokenPipeError, OSError):
                # The host is gone; there is nobody left to report to.
                raise _WorkerShutdown(EXIT_SUCCESS) from None


class WorkerIO:
    """Reads stdin lines on a daemon thread into a queue.

    The reader thread answers ``ping`` immediately (so health checks work
    even while a run is executing) and drops malformed lines with a stderr
    log. Everything else is queued for the main loop. EOF puts a ``None``
    sentinel in the queue so the main loop can exit gracefully.
    """

    def __init__(self, instream, emitter: WorkerEmitter) -> None:
        self._queue: queue.Queue = queue.Queue()
        self._emitter = emitter
        self._thread = threading.Thread(
            target=self._read_loop, args=(instream,), daemon=True
        )
        self._thread.start()

    def _read_loop(self, instream) -> None:
        try:
            while True:
                try:
                    line = instream.readline()
                except Exception as exc:  # noqa: BLE001 - stdin may die oddly
                    _log(f"worker: 读取 stdin 失败：{type(exc).__name__}")
                    break
                if not line:
                    break  # EOF
                obj, error = decode_line(line)
                if error is not None:
                    _log(f"worker: 忽略一行非法输入（{error}）")
                    continue
                if obj is None:
                    continue  # blank line, skip silently
                if obj.get("type") == "ping":
                    try:
                        self._emitter.emit("pong", id=ensure_request_id(obj))
                    except _WorkerShutdown:
                        break
                    continue
                self._queue.put(obj)
        finally:
            self._queue.put(None)

    def read(self, timeout=None):
        """Return the next parsed request dict, ``None`` on EOF.

        Raises ``queue.Empty`` when ``timeout`` expires with nothing read.
        """
        return self._queue.get(timeout=timeout)

    def join(self, timeout=None) -> None:
        """Wait for the reader thread to finish (stdin EOF or error)."""
        self._thread.join(timeout=timeout)


class Worker:
    """One session, one provider, driven by the worker protocol.

    ``agent`` may be ``None`` at construction (the caller wires it right
    after building the Agent with this worker's callbacks); :meth:`serve`
    requires it to be set.
    """

    def __init__(
        self,
        agent,
        emitter: WorkerEmitter,
        io: WorkerIO,
        approval_timeout: float = APPROVAL_TIMEOUT,
    ) -> None:
        self.agent = agent
        self.emitter = emitter
        self.io = io
        self.approval_timeout = approval_timeout
        self._run_id = None
        self._run_incomplete = False
        self._pending = None  # {"id", "approval_id"} while approval waits
        self._pending_stop = False

    # -- approval: the worker only relays a human decision ----------------

    def approve_fn(self, tool_name: str, summary: str) -> bool:
        """Ask the host human and return their decision (never approve alone)."""
        approval_id = new_id("appr")
        req_id = new_id("req")
        self._pending = {"id": req_id, "approval_id": approval_id}
        self.emitter.emit(
            "approval_request",
            id=req_id,
            approval_id=approval_id,
            tool=tool_name,
            description=summary,
            timeout=self.approval_timeout,
        )
        try:
            while True:
                try:
                    obj = self.io.read(timeout=self.approval_timeout)
                except queue.Empty:
                    self._finish_approval(False, "timeout")
                    return False
                if obj is None:  # stdin closed while waiting
                    self._pending_stop = True
                    self._finish_approval(False, "stdin_closed")
                    return False
                if not isinstance(obj, dict):
                    _log("worker: 审批等待中忽略一条非对象消息")
                    continue
                obj_type = obj.get("type")
                if obj_type == "approval_decision":
                    approved, error = validate_approval_decision(obj, self._pending)
                    if error is not None:
                        if (
                            obj.get("id") == req_id
                            or obj.get("approval_id") == approval_id
                        ):
                            # Names this approval but fails validation:
                            # a protocol violation, so fail closed.
                            _log(f"worker: 审批决定无效（{error}），已拒绝")
                            self._finish_approval(False, "invalid_decision")
                            return False
                        _log(f"worker: 忽略一条不匹配的审批决定（{error}）")
                        continue
                    self._finish_approval(approved, None)
                    return approved
                if obj_type == "stop":
                    self._pending_stop = True
                    self._finish_approval(False, "stop")
                    return False
                if obj_type == "ping":
                    self.emitter.emit("pong", id=ensure_request_id(obj))
                    continue
                _log(f"worker: 审批等待中忽略类型为 {obj_type!r} 的消息")
        finally:
            self._pending = None

    def _finish_approval(self, approved: bool, reason) -> None:
        pending = self._pending
        if pending is None:
            return
        payload = {
            "id": pending["id"],
            "approval_id": pending["approval_id"],
            "approved": approved,
        }
        if reason is not None:
            payload["reason"] = reason
        self.emitter.emit("approval_result", **payload)

    # -- Agent events -> protocol events -----------------------------------

    def on_agent_event(self, kind: str, data: dict) -> None:
        """Map Agent observer events to protocol events (whitelist only).

        Tool arguments and raw tool results are never forwarded: they may
        contain secrets. Only the tool name, the call id and a success flag
        cross the protocol, mirroring ``json_mode``.
        """
        if self._run_id is None:
            return
        if kind == "usage":
            self.emitter.emit("usage", id=self._run_id, **data)
        elif kind in ("auto_compact", "auto_compact_failed", "auto_compact_skipped"):
            self.emitter.emit(kind, id=self._run_id, **data)
        elif kind == "tool_start":
            self.emitter.emit(
                "tool_start",
                id=self._run_id,
                tool_call_id=data.get("id", ""),
                name=data.get("name", ""),
            )
        elif kind == "tool_result":
            result = data.get("result", "")
            ok = not (isinstance(result, str) and result.startswith("错误："))
            self.emitter.emit(
                "tool_result",
                id=self._run_id,
                tool_call_id=data.get("id", ""),
                name=data.get("name", ""),
                ok=ok,
            )
        elif kind == "assistant":
            self.emitter.emit("assistant", id=self._run_id, content=data.get("content", ""))
        elif kind == "final":
            self.emitter.emit("final", id=self._run_id, content=data.get("content", ""))
        elif kind == "max_turns":
            self._run_incomplete = True
            self.emitter.emit("turn_limit", id=self._run_id, max_turns=data.get("max_turns"))
        else:
            _log(f"worker: 忽略 Agent 事件 {kind!r}")

    # -- run handling --------------------------------------------------------

    def run_request(self, req: dict) -> None:
        """Execute one ``run`` request and emit exactly one terminal event."""
        req_id = req.get("id")
        if not isinstance(req_id, str) or not req_id:
            req_id = new_id("req")
            _log("worker: run 请求缺少 id，已生成一个")
        error = validate_run_request(req)
        if error is not None:
            self.emitter.emit("error", id=req_id, code="invalid_request", message=error)
            return
        self._run_id = req_id
        self._run_incomplete = False
        self.emitter.emit(
            "run_started",
            id=req_id,
            session_id=self.agent.session_id,
            provider=self.agent.provider.name,
            model=self.agent.provider.model,
            mode=self.agent.mode,
        )
        failure = None
        answer = ""
        try:
            # Stray prints from providers/tools must never corrupt stdout.
            with redirect_stdout(sys.stderr):
                answer = self.agent.run(req["task"])
        except AgentError as exc:
            failure = ("runtime_error", str(exc))
        except Exception as exc:  # noqa: BLE001 - never leak internals
            _log(f"worker: run 异常 {type(exc).__name__}")
            failure = ("runtime_error", "执行失败，请查看 stderr")
        incomplete = self._run_incomplete
        self._run_id = None
        if failure is not None:
            code, message = failure
            self.emitter.emit(
                "run_failed",
                id=req_id,
                error={"code": code, "message": message},
                exit_code=EXIT_RUNTIME,
            )
            return
        usage = self.agent.usage.snapshot()
        terminal = "run_incomplete" if incomplete else "run_completed"
        self.emitter.emit(
            terminal,
            id=req_id,
            output=answer,
            usage=usage,
            provider=self.agent.provider.name,
            model=self.agent.provider.model,
            # Single-provider worker: no switch can ever happen.
            model_switches=[],
        )

    # -- main loop -----------------------------------------------------------

    def serve(self) -> int:
        """Read requests until `stop`, stdin EOF, or the host goes away."""
        if self.agent is None:
            raise RuntimeError("Worker.serve 需要先设置 agent")
        try:
            while True:
                if self._pending_stop:
                    return EXIT_SUCCESS
                obj = self.io.read()
                if obj is None:
                    return EXIT_SUCCESS
                if not isinstance(obj, dict):
                    _log("worker: 忽略一条非对象消息")
                    continue
                obj_type = obj.get("type")
                if obj_type == "run":
                    self.run_request(obj)
                elif obj_type == "stop":
                    return EXIT_SUCCESS
                elif obj_type == "approval_decision":
                    _log("worker: 忽略一条无待处理审批的审批决定")
                elif obj_type == "ping":
                    self.emitter.emit("pong", id=ensure_request_id(obj))
                else:
                    _log(f"worker: 忽略未知请求类型 {obj_type!r}")
        except _WorkerShutdown as exc:
            return exc.exit_code
        except KeyboardInterrupt:
            return EXIT_INTERRUPTED


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nyra.worker",
        description="Nyra worker：通过 stdio JSONL 协议跑一个 Agent 会话（混合 Go 迁移第 1 批）。",
    )
    parser.add_argument("--session", default=None, help="继续指定会话 id（默认新建会话）")
    parser.add_argument("--workdir", default=".", help="工作目录（默认当前目录）")
    parser.add_argument("--provider", default=None, help="模型 provider 名（默认按配置）")
    parser.add_argument("--model", default=None, help="模型 id（默认按配置）")
    parser.add_argument("--mode", default=None, help="模式：readonly / auto / full（默认 auto）")
    parser.add_argument("--max-turns", type=int, default=None, help="最大轮数（默认按配置）")
    return parser


def build_agent(args, on_event, approve_fn) -> Agent:
    """Build the worker's single Agent (one provider, no fallback chain).

    The chain passed to :func:`build_provider_chain` has exactly one
    entry, so no switch can ever happen; a CLI primary (Codex) is
    returned alone by that function. ``interactive=True`` is deliberate:
    in protocol terms the worker *is* interactive -- a human answers
    approvals through the host -- so auto-mode approvals reach
    ``approve_fn`` instead of being refused outright (see
    ``tools._check_approval``).
    """
    config = load_config()
    provider_cfg = resolve_provider(args.provider, args.model)
    mode = validate_mode(args.mode or config.get("mode") or "auto")
    max_turns = (
        args.max_turns if args.max_turns is not None
        else config.get("max_turns") or 20
    )
    if isinstance(max_turns, bool) or not isinstance(max_turns, int) or max_turns < 1:
        raise ValueError("--max-turns 必须为正整数")
    window = context_limit(config.get("context_window_tokens"))
    auto_compact = bool(config.get("auto_compact_enabled", False))
    threshold = validate_auto_compact_threshold(
        config.get("auto_compact_threshold", DEFAULT_AUTO_COMPACT_THRESHOLD)
    )
    workdir = Path(args.workdir).resolve()
    if not workdir.is_dir():
        raise ValueError("工作目录不存在")
    provider = build_provider_chain(provider_cfg, [provider_cfg.name])
    if not provider.has_credentials():
        raise ValueError("当前模型没有可用凭证，请检查模型配置")
    messages = None
    if args.session:
        messages = load_session(args.session)
        if messages is None:
            raise ValueError("指定的会话不存在")
    return Agent(
        provider=provider,
        workdir=workdir,
        mode=mode,
        max_turns=max_turns,
        session_id=args.session,
        messages=messages,
        interactive=True,
        context_window_tokens=window,
        auto_compact_enabled=auto_compact,
        auto_compact_threshold=threshold,
        on_event=on_event,
        approve_fn=approve_fn,
    )


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    emitter = WorkerEmitter(sys.stdout)
    try:
        worker = Worker(agent=None, emitter=emitter, io=WorkerIO(sys.stdin, emitter))
        agent = build_agent(
            args,
            on_event=worker.on_agent_event,
            approve_fn=worker.approve_fn,
        )
        worker.agent = agent
    except (ValueError, ProviderError) as exc:
        emitter.emit(
            "error", id=new_id("req"),
            code="invalid_configuration", message=str(exc),
        )
        return EXIT_ARGUMENT
    except Exception as exc:  # noqa: BLE001 - startup must not leak internals
        _log(f"worker: 启动异常 {type(exc).__name__}")
        emitter.emit(
            "error", id=new_id("req"),
            code="startup_error", message="worker 启动失败，请查看 stderr",
        )
        return EXIT_RUNTIME
    return worker.serve()


if __name__ == "__main__":
    raise SystemExit(main())
