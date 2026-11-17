"""Versioned JSON Lines output for non-interactive Nyra runs.

The protocol writes ONLY machine-readable lines to the original stdout.
Any legacy print from providers, tools or startup is redirected to stderr.
This is a CLI transport, not a separate tool permission system.

Exit codes:
  0 completed
  1 runtime/provider/tool failure
  2 invalid configuration or command arguments
  3 model reached max_turns without a final answer
  4 verification command failed (verify_failed)
  130 interrupted by the user
"""

from contextlib import redirect_stdout
import json
from pathlib import Path
import sys

from .agent import Agent, AgentError, build_mcp_manager
from .compact import DEFAULT_AUTO_COMPACT_THRESHOLD, validate_auto_compact_threshold
from .config import (
    load_config, resolve_fallback_chain, resolve_profile, resolve_provider,
    resolve_sandbox, validate_mode,
)
from .e2b_backend import DEFAULT_SANDBOX_WORKDIR, E2BError, connect_backend
from .memory import load_session
from .providers import Provider, build_provider_chain
from .usage import context_limit
from .runs import (
    RunRecorder, RunStore, prepare_resume, RunNotResumable,
    resolve_verify_command, resolve_verify_settings, tests_modified,
)

SCHEMA_VERSION = 1
EXIT_SUCCESS = 0
EXIT_RUNTIME = 1
EXIT_ARGUMENT = 2
EXIT_INCOMPLETE = 3
EXIT_VERIFY = 4
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
        elif kind == "verify_started":
            self.emit("verify_started", command=data.get("command", ""))
        elif kind == "verify_result":
            self.emit(
                "verify_result",
                command=data.get("command", ""),
                exit_code=data.get("exit_code"),
                passed=bool(data.get("passed")),
                attempt=data.get("attempt"),
                tests_modified=bool(data.get("tests_modified")),
            )
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
    recorder = None

    # Existing modules contain human-readable diagnostics. They must never
    # corrupt the machine-readable stdout channel.
    with redirect_stdout(sys.stderr):
        try:
            if not args.resume_run and (not isinstance(args.prompt, str) or not args.prompt.strip()):
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
                resume_state = None
                interrupted_tool_calls = 0
                if args.resume_run:
                    resume_state, resume_messages, interrupted_tool_calls = prepare_resume(
                        RunStore(), args.resume_run,
                        workdir=args.workdir if getattr(args, 'workdir_explicit', args.workdir != '.') else None,
                        mode=args.mode, max_turns=args.max_turns)
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
                if resume_state:
                    mode = resume_state['mode']
                    max_turns = resume_state['max_turns']
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
                if resume_state:
                    workdir = Path(resume_state['workdir'])
                if settings.backend == "local" and not workdir.is_dir():
                    raise ValueError("工作目录不存在")
                messages = None
                if args.resume:
                    messages = load_session(args.resume)
                    if messages is None:
                        raise ValueError("指定的会话不存在")
                if resume_state:
                    messages = resume_messages
            except RunNotResumable as exc:
                return out.failed('run_not_resumable', str(exc), EXIT_ARGUMENT)
            except (ValueError, OSError) as exc:
                return out.failed("invalid_configuration", str(exc), EXIT_ARGUMENT)

            # --json uses the same fallback chain as the CLI entries:
            # on a recoverable failure (402/429/5xx/timeout/network) the
            # call moves to the next provider; 401/403 and config errors
            # raise immediately. Switches are reported as model_switch
            # events so the JSON stream never misreports the provider.
            provider = build_provider_chain(
                provider_config,
                resolve_fallback_chain(
                    provider_config.name,
                    config,
                    enabled=(
                        True
                        if getattr(args, "fallback", False)
                        else (
                            False
                            if getattr(args, "no_fallback", False)
                            else None
                        )
                    ),
                ),
                on_switch=lambda record: out.emit("model_switch", **record),
                provider_cls=Provider,
                resolver=resolve_provider,
            )
            if not provider.has_credentials():
                return out.failed(
                    "missing_credentials",
                    "当前模型没有可用凭证，请检查模型配置",
                    EXIT_ARGUMENT,
                )

            if settings.backend == "e2b" and not resume_state:
                backend = connect_backend(settings)
            # Non-interactive auto/readonly never starts MCP processes.
            mcp_manager = build_mcp_manager(mode=mode, interactive=False)
            agent = Agent(
                provider=provider, workdir=workdir, mode=mode,
                max_turns=max_turns, session_id=resume_state["session_id"] if resume_state else args.resume, messages=messages,
                interactive=False, backend=backend, mcp_manager=mcp_manager,
                context_window_tokens=window,
                auto_compact_enabled=auto_compact,
                auto_compact_threshold=threshold,
                on_event=out.agent_event,
                poppy_enabled=args.poppy,
            )
            task = resume_state['task'] if resume_state else args.prompt
            timeout, retries = resolve_verify_settings(
                getattr(args, 'verify_timeout', None),
                getattr(args, 'verify_retries', None),
                config,
            )
            verify_cmd = None if resume_state else resolve_verify_command(
                getattr(args, 'verify', None), config, workdir)
            recorder = RunRecorder(
                RunStore(), agent, task, state=resume_state,
                interrupted_tool_calls=interrupted_tool_calls,
                verify_cmd=verify_cmd, verify_timeout=timeout, verify_retries=retries,
            )
            if resume_state:
                out.emit('run_resumed', run_id=recorder.run_id, session_id=agent.session_id,
                         turn=resume_state['turn'], interrupted_tool_calls=interrupted_tool_calls)
            else:
                out.emit(
                    "run_started", run_id=recorder.run_id, session_id=agent.session_id,
                    provider=provider.name, model=provider.model, mode=mode,
                )
            answer = recorder.run(task)
            usage = agent.usage.snapshot()
            # provider/model always name the provider that actually
            # answered, not the one configured first; model_switches
            # lists every switch that happened during this run.
            final_provider = provider.name
            final_model = provider.model
            switches = list(getattr(provider, "switches", []))
            state = recorder.store.load(recorder.run_id)
            status = state["status"]
            modified = bool(tests_modified(state.get("changed_files") or []))
            if out.incomplete:
                out.emit(
                    "run_incomplete", exit_code=EXIT_INCOMPLETE,
                    output=answer, usage=usage,
                    provider=final_provider, model=final_model,
                    model_switches=switches, verified=False,
                    tests_modified=modified, status=status,
                )
                return EXIT_INCOMPLETE
            if status == "verify_failed":
                out.emit(
                    "run_failed",
                    error={"code": "verify_failed", "message": "验证未通过"},
                    exit_code=EXIT_VERIFY, output=answer, usage=usage,
                    provider=final_provider, model=final_model,
                    model_switches=switches,
                    verified=False, tests_modified=modified, status=status,
                )
                return EXIT_VERIFY
            out.emit(
                "run_completed", exit_code=EXIT_SUCCESS,
                output=answer, usage=usage,
                provider=final_provider, model=final_model,
                model_switches=switches,
                verified=(status == "verified"),
                tests_modified=modified, status=status,
            )
            return EXIT_SUCCESS
        except KeyboardInterrupt:
            return out.failed("interrupted", "任务已中断", EXIT_INTERRUPTED)
        except (AgentError, E2BError) as exc:
            return out.failed("runtime_error", str(exc), EXIT_RUNTIME)
        except Exception as exc:
            # Unknown errors can embed file contents or credentials in str(exc).
            print(f"Nyra JSONL runtime exception: {type(exc).__name__}", file=sys.stderr)
            return out.failed("runtime_error", "执行失败，请查看 stderr", EXIT_RUNTIME)
        finally:
            if recorder is not None:
                out.emit("run_state", run_id=recorder.run_id,
                         status=recorder.store.load(recorder.run_id)["status"])
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
