"""Versioned JSON Lines output for non-interactive Angel runs.

The protocol writes ONLY machine-readable lines to the original stdout.
Any legacy print from providers, tools or startup is redirected to stderr.
This is a CLI transport, not a separate tool permission system.

Exit codes:
  0 completed
  1 runtime/provider/tool failure
  2 invalid configuration or command arguments
  3 model reached max_turns without a final answer
  130 interrupted by the user
"""

from contextlib import redirect_stdout
import json
from pathlib import Path
import sys

from .agent import Agent, AgentError, build_mcp_manager
from .compact import DEFAULT_AUTO_COMPACT_THRESHOLD, validate_auto_compact_threshold
from .config import (
    load_config, resolve_profile, resolve_provider, resolve_sandbox, validate_mode,
)
from .e2b_backend import DEFAULT_SANDBOX_WORKDIR, E2BError, connect_backend
from .memory import load_session
from .providers import Provider
from .usage import context_limit

SCHEMA_VERSION = 1
EXIT_SUCCESS = 0
EXIT_RUNTIME = 1
EXIT_ARGUMENT = 2
EXIT_INCOMPLETE = 3
EXIT_INTERRUPTED = 130


class JsonLines:
    """Write strictly one JSON object per stdout line with stable sequence IDs."""

    def __init__(self, stream):
        self.stream = stream
        self.seq = 0
        self.incomplete = False

    def emit(self, event_type: str, **payload) -> None:
        self.seq += 1
        event = {
            "schema_version": SCHEMA_VERSION,
            "seq": self.seq,
            "type": event_type,
        }
        event.update(payload)
        self.stream.write(json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n")
        self.stream.flush()

    def agent_event(self, kind: str, data: dict) -> None:
        """Expose useful events, but never dump raw tool arguments or results."""
        if kind in ("usage", "auto_compact", "auto_compact_failed", "auto_compact_skipped"):
            self.emit(kind, **data)
        elif kind == "tool_start":
            self.emit("tool_start", id=data.get("id", ""), name=data.get("name", ""))
        elif kind == "tool_result":
            result = data.get("result", "")
            # Raw tool output can contain API keys, private files or secrets.
            self.emit(
                "tool_result", id=data.get("id", ""), name=data.get("name", ""),
                ok=not (isinstance(result, str) and result.startswith("错误：")),
            )
        elif kind == "assistant":
            self.emit("assistant", content=data.get("content", ""))
        elif kind == "max_turns":
            self.incomplete = True
            self.emit("turn_limit", max_turns=data.get("max_turns"))

    def failed(self, code: str, message: str, exit_code: int) -> int:
        self.emit(
            "run_failed",
            error={"code": code, "message": message},
            exit_code=exit_code,
        )
        return exit_code


def invalid_arguments(stream, message: str = "参数无效，请运行 --help 查看用法") -> int:
    """Return valid JSONL even when argparse rejects a --json invocation."""
    return JsonLines(stream).failed("invalid_arguments", message, EXIT_ARGUMENT)


def run_json(args) -> int:
    """Execute one prompt and emit deterministic, versioned JSON Lines."""
    out = JsonLines(sys.stdout)
    backend = None
    mcp_manager = None
    agent = None

    # Existing modules contain human-readable diagnostics. They must never
    # corrupt the machine-readable stdout channel.
    with redirect_stdout(sys.stderr):
        try:
            if not isinstance(args.prompt, str) or not args.prompt.strip():
                return out.failed(
                    "invalid_arguments",
                    "--json 仅支持单次非交互任务，请提供任务文本",
                    EXIT_ARGUMENT,
                )
            if any((
                args.compact, args.list_mcp, args.list_profiles,
                args.list_sessions, args.list_skills,
            )):
                return out.failed(
                    "invalid_arguments",
                    "--json 不能与 --compact / --list-* 组合使用",
                    EXIT_ARGUMENT,
                )

            try:
                config = load_config()
                settings = resolve_sandbox(
                    config=config,
                    backend=args.sandbox, sandbox_id=args.sandbox_id,
                    template=args.sandbox_template, timeout=args.sandbox_timeout,
                )
                profile = resolve_profile(args.profile, config)
                mode = validate_mode(args.mode or profile["mode"] or "auto")
                max_turns = (
                    args.max_turns if args.max_turns is not None
                    else config.get("max_turns") or 20
                )
                if isinstance(max_turns, bool) or not isinstance(max_turns, int) or max_turns < 1:
                    raise ValueError("--max-turns 必须为正整数")
                if args.context_window is not None and context_limit(args.context_window) is None:
                    raise ValueError("--context-window 必须为正整数")
                window = context_limit(
                    args.context_window if args.context_window is not None
                    else config.get("context_window_tokens")
                )
                auto_compact = bool(
                    args.auto_compact or config.get("auto_compact_enabled", False)
                )
                threshold = validate_auto_compact_threshold(
                    args.auto_compact_threshold if args.auto_compact_threshold is not None
                    else config.get("auto_compact_threshold", DEFAULT_AUTO_COMPACT_THRESHOLD)
                )
                provider_config = resolve_provider(
                    args.provider or profile["provider"],
                    args.model or profile["model"],
                )
                workdir = (
                    Path(args.workdir) if args.workdir != "."
                    else Path(DEFAULT_SANDBOX_WORKDIR)
                ) if settings.backend == "e2b" else Path(args.workdir).resolve()
                if settings.backend == "local" and not workdir.is_dir():
                    raise ValueError("工作目录不存在")
                messages = None
                if args.resume:
                    messages = load_session(args.resume)
                    if messages is None:
                        raise ValueError("指定的会话不存在")
            except ValueError as exc:
                return out.failed("invalid_configuration", str(exc), EXIT_ARGUMENT)

            provider = Provider(provider_config)
            if not provider.has_credentials():
                return out.failed(
                    "missing_credentials",
                    "当前模型没有可用凭证，请检查模型配置",
                    EXIT_ARGUMENT,
                )

            if settings.backend == "e2b":
                backend = connect_backend(settings)
            # Non-interactive auto/readonly never starts MCP processes.
            mcp_manager = build_mcp_manager(mode=mode, interactive=False)
            agent = Agent(
                provider=provider, workdir=workdir, mode=mode,
                max_turns=max_turns, session_id=args.resume, messages=messages,
                interactive=False, backend=backend, mcp_manager=mcp_manager,
                context_window_tokens=window,
                auto_compact_enabled=auto_compact,
                auto_compact_threshold=threshold,
                on_event=out.agent_event,
                poppy_enabled=args.poppy,
            )
            out.emit(
                "run_started", session_id=agent.session_id,
                provider=provider.name, model=provider.model, mode=mode,
            )
            answer = agent.run(args.prompt)
            usage = agent.usage.snapshot()
            if out.incomplete:
                out.emit(
                    "run_incomplete", exit_code=EXIT_INCOMPLETE,
                    output=answer, usage=usage,
                )
                return EXIT_INCOMPLETE
            out.emit(
                "run_completed", exit_code=EXIT_SUCCESS,
                output=answer, usage=usage,
            )
            return EXIT_SUCCESS
        except KeyboardInterrupt:
            return out.failed("interrupted", "任务已中断", EXIT_INTERRUPTED)
        except (AgentError, E2BError) as exc:
            return out.failed("runtime_error", str(exc), EXIT_RUNTIME)
        except Exception as exc:
            # Unknown errors can embed file contents or credentials in str(exc).
            print(f"Angel JSONL runtime exception: {type(exc).__name__}", file=sys.stderr)
            return out.failed("runtime_error", "执行失败，请查看 stderr", EXIT_RUNTIME)
        finally:
            if mcp_manager is not None:
                try:
                    mcp_manager.stop_all()
                except Exception:
                    print("MCP shutdown failed", file=sys.stderr)
            if backend is not None:
                try:
                    backend.close()
                except Exception:
                    print("Sandbox shutdown failed", file=sys.stderr)
