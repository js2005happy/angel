"""Angel 命令行入口，支持单次任务执行与交互式会话。"""

import argparse
import sys
from pathlib import Path

from . import __version__
from .console import ToolPrinter, configure_stdio, style, use_color
from .config import (
    ANGEL_HOME,
    VALID_MODES,
    list_profiles,
    load_config,
    resolve_profile,
    resolve_provider,
    resolve_sandbox,
    validate_mode,
)
from .e2b_backend import DEFAULT_SANDBOX_WORKDIR, E2BError, connect_backend
from .providers import Provider, ProviderError, describe_provider
from .agent import Agent, AgentError, build_mcp_manager
from .compact import compact_session_file
from .scheduler import (
    SCHEDULE_PATH,
    ScheduleError,
    add_task,
    list_tasks,
    load_schedule,
    remove_task,
    run_daemon,
    run_due_tasks,
    save_schedule,
)
from .skills import load_skills
from .memory import list_sessions, load_session, new_session_id
from .usage import UsageTracker, context_limit, format_usage
from .compact import validate_auto_compact_threshold, DEFAULT_AUTO_COMPACT_THRESHOLD


REPL_COMMANDS = (
    ("/help", "显示本帮助"),
    ("/mode <模式>", "切换审批模式（readonly / auto / full）"),
    ("/skills", "列出已加载的技能"),
    ("/sessions", "列出历史会话"),
    ("/compact", "压缩当前会话（模型摘要 + 保留最近消息）"),
    ("/status", "显示模型调用与 Token 用量、参考上下文余量"),
    ("/clear", "清空当前对话历史"),
    ("/new", "开始一个新会话"),
    ("/exit 或 /quit", "退出"),
)


def _display_width(text: str) -> int:
    """Terminal column width: CJK and full-width characters take two columns."""
    import unicodedata

    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def format_repl_help(color: bool = False) -> str:
    """Render the REPL help as an aligned table (plain text when color is off)."""
    width = max(_display_width(cmd) for cmd, _ in REPL_COMMANDS) + 2
    lines = [style("可用命令", "bold", enabled=color)]
    for cmd, desc in REPL_COMMANDS:
        pad = " " * (width - _display_width(cmd))
        lines.append(f"  {style(cmd, 'cyan', enabled=color)}{pad}{desc}")
    lines.append("")
    lines.append(style("直接输入文字即向 Angel 提问。", "dim", enabled=color))
    return "\n".join(lines)


REPL_HELP = format_repl_help(color=False)


def format_banner(
    provider_desc: str, mode: str, session_id: str, color: bool = False
) -> str:
    """The REPL start-up banner."""
    halo = style("◯", "gold", enabled=color)
    title = style(f"Angel {__version__}", "bold", enabled=color)
    label = lambda text: style(text, "dim", enabled=color)  # noqa: E731
    return "\n".join(
        [
            f"{halo} {title}  {label('全能 AI 助手 · Python 标准库')}",
            f"  {label('模型')}  {provider_desc}",
            f"  {label('模式')}  {mode}",
            f"  {label('会话')}  {session_id}",
        ]
    )


def repl_prompt(mode: str, color: bool = False) -> str:
    name = style("angel", "gold", "bold", enabled=color)
    tag = style(f"[{mode}]", "dim", enabled=color)
    return f"{name}{tag} › "


def _make_task_agent(task: dict, workdir: Path) -> Agent:
    """为一条定时任务创建一个 Agent（定时任务默认 full 模式）。"""
    config = load_config()
    profile = resolve_profile(task.get("profile"), config)
    provider_name = task.get("provider") or profile["provider"]
    model = task.get("model") or profile["model"]
    mode = task.get("mode") or profile["mode"] or "full"
    provider = Provider(resolve_provider(provider_name, model))
    if not provider.has_credentials():
        raise AgentError(f"定时任务 {task['name']} 没有可用的模型凭证")
    return Agent(
        provider=provider,
        workdir=workdir,
        mode=validate_mode(mode),
        max_turns=config.get("max_turns") or 20,
        interactive=False,
    )


def _run_scheduled_task(task: dict, workdir: Path) -> str:
    agent = _make_task_agent(task, workdir)
    return agent.run(task["prompt"])


def handle_schedule(argv: list[str], workdir: Path) -> int:
    """处理 `angel schedule <list|add|remove|run|daemon>` 子命令。"""
    if not argv:
        print("用法：angel schedule <list|add|remove|run|daemon> [选项]")
        print("  list                                  列出定时任务")
        print("  add --name 名称 --prompt 任务 [--every 秒 | --at HH:MM]")
        print("      [--provider 名称] [--profile 名称] [--model 模型] [--mode 模式]")
        print("  remove --name 名称                     删除定时任务")
        print("  run                                   立即执行所有到期任务")
        print("  daemon [--interval 秒]                 守护进程：每隔 interval 秒检查一次")
        return 1

    action = argv[0]

    if action == "list":
        try:
            data = load_schedule()
        except ScheduleError as exc:
            print(f"错误：{exc}")
            return 1
        tasks = list_tasks(data)
        if not tasks:
            print(f"暂无定时任务（{SCHEDULE_PATH}）")
            return 0
        for task in tasks:
            when = (
                f"每 {task['every_seconds']} 秒"
                if task.get("every_seconds")
                else f"每天 {task.get('at')}"
            )
            state = "启用" if task.get("enabled", True) else "停用"
            last = task.get("last_run") or "从未运行"
            print(
                f"- {task['name']} [{state}] {when} 上次：{last} "
                f"({task.get('last_status') or '-'})"
            )
            print(f"  {task['prompt'][:80]}")
        return 0

    if action == "add":
        parser = argparse.ArgumentParser(prog="angel schedule add")
        parser.add_argument("--name", required=True)
        parser.add_argument("--prompt", required=True)
        parser.add_argument("--every", type=int, default=None)
        parser.add_argument("--at", default=None)
        parser.add_argument("--provider", default=None)
        parser.add_argument("--profile", default=None)
        parser.add_argument("--model", default=None)
        parser.add_argument("--mode", default="full")
        parser.add_argument("--disable", action="store_true")
        args = parser.parse_args(argv[1:])
        task = {
            "name": args.name,
            "prompt": args.prompt,
            "provider": args.provider,
            "profile": args.profile,
            "model": args.model,
            "mode": args.mode,
            "every_seconds": args.every,
            "at": args.at,
            "enabled": not args.disable,
        }
        try:
            data = load_schedule()
            add_task(data, task)
            save_schedule(data)
        except ScheduleError as exc:
            print(f"错误：{exc}")
            return 1
        print(f"已添加定时任务 {args.name}")
        return 0

    if action == "remove":
        parser = argparse.ArgumentParser(prog="angel schedule remove")
        parser.add_argument("--name", required=True)
        args = parser.parse_args(argv[1:])
        try:
            data = load_schedule()
        except ScheduleError as exc:
            print(f"错误：{exc}")
            return 1
        if not remove_task(data, args.name):
            print(f"错误：找不到定时任务 {args.name}")
            return 1
        save_schedule(data)
        print(f"已删除定时任务 {args.name}")
        return 0

    if action == "run":
        try:
            data = load_schedule()
        except ScheduleError as exc:
            print(f"错误：{exc}")
            return 1
        results = run_due_tasks(
            data, lambda task: _run_scheduled_task(task, workdir)
        )
        save_schedule(data)
        if not results:
            print("没有到期的定时任务")
            return 0
        for result in results:
            print(f"[定时任务] {result['name']}：{result['status']} - {result['summary'][:100]}")
        return 0

    if action == "daemon":
        parser = argparse.ArgumentParser(prog="angel schedule daemon")
        parser.add_argument("--interval", type=float, default=60.0)
        parser.add_argument("--rounds", type=int, default=None)
        args = parser.parse_args(argv[1:])
        print(f"定时任务守护进程已启动（每 {args.interval} 秒检查一次，Ctrl+C 停止）")
        rounds = run_daemon(
            lambda task: _run_scheduled_task(task, workdir),
            interval=args.interval,
            stop_after=args.rounds,
        )
        print(f"守护进程共运行 {rounds} 轮")
        return 0

    print(f"错误：未知的 schedule 子命令：{action}")
    return 1


def build_parser() -> argparse.ArgumentParser:
    """构建命令行参数解析器。"""
    parser = argparse.ArgumentParser(
        prog="angel",
        description="Angel — 全能 AI 助手",
        epilog=(
            "子命令：angel schedule <list|add|remove|run|daemon> 管理定时任务；"
            "angel ui [--host 127.0.0.1] [--port 8765] [--open] 启动本地网页界面"
        ),
    )
    parser.add_argument(
        "prompt",
        nargs="?",
        help="一句话任务（给出则一次性执行，不给则进入交互模式）",
    )
    parser.add_argument(
        "--provider",
        help="模型 provider：deepseek / xai / openrouter / ollama / openai / custom",
    )
    parser.add_argument("--model", help="模型 id")
    parser.add_argument(
        "--profile",
        help="使用配置中的 provider 档案（见 ~/.angel/config.json 的 profiles）",
    )
    parser.add_argument(
        "--compact", metavar="SESSION_ID", help="压缩指定会话后退出"
    )
    parser.add_argument(
        "--list-mcp", action="store_true", help="列出已配置的 MCP 服务器工具"
    )
    parser.add_argument(
        "--list-profiles", action="store_true", help="列出已配置的 provider 档案"
    )
    parser.add_argument(
        "--mode",
        choices=VALID_MODES,
        help="审批模式：readonly 只读 / auto 每次确认 / full 全权",
    )
    parser.add_argument("--resume", help="继续指定会话 id")
    parser.add_argument("--list-skills", action="store_true", help="列出已加载的技能")
    parser.add_argument(
        "--list-sessions", action="store_true", help="列出历史会话"
    )
    parser.add_argument(
        "--max-turns", type=int, default=None, help="最大执行轮数"
    )
    parser.add_argument(
        "--context-window", type=int, default=None,
        help="已确认的模型上下文窗口 token 上限（未知时不估算）",
    )
    parser.add_argument(
        "--auto-compact", action="store_true",
        help="达到配置的上下文阈值时自动压缩（需要设置 --context-window，可能增加模型费用）",
    )
    parser.add_argument(
        "--auto-compact-threshold", type=float, default=None,
        help="触发自动压缩的上下文占比，0.50 到 0.95（默认 0.80）",
    )
    parser.add_argument("--workdir", default=".", help="工作目录")
    parser.add_argument(
        "--sandbox",
        choices=("local", "e2b"),
        default=None,
        help="执行后端：local 本地执行 / e2b 在 E2B 沙盒里执行（默认 local）",
    )
    parser.add_argument(
        "--sandbox-id",
        default=None,
        help="连接已有的 E2B 沙盒（不给则新建一台）",
    )
    parser.add_argument(
        "--sandbox-template",
        default=None,
        help="新建 E2B 沙盒用的模板（默认 base）",
    )
    parser.add_argument(
        "--sandbox-timeout",
        type=int,
        default=None,
        help="新建 E2B 沙盒的超时秒数（默认 3600，到期自动销毁）",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"Angel {__version__}",
    )
    return parser


def print_setup_help(provider_name: str) -> None:
    """显示凭据配置说明。"""
    print("未找到可用的 API 凭据。")
    print("设置方法（二选一）：")
    print(
        "  1. 环境变量：export DEEPSEEK_API_KEY=你的 Key（DeepSeek）/ "
        "export XAI_API_KEY=你的 Key（Grok）/ export OPENROUTER_API_KEY=你的 Key"
    )
    print("     或通用：export ANGEL_API_KEY=... ANGEL_BASE_URL=... ANGEL_MODEL=...")
    print(
        "  2. 已保存的连接器：如果 DeepSeek / xAI 的 Key 已通过安全流程保存，"
        "直接用 --provider deepseek 或 --provider xai 即可，无需再填 Key。"
    )
    print(f"当前 provider：{provider_name}")


def main(argv: list[str] | None = None) -> int:
    """执行命令行任务或启动交互式会话。"""
    configure_stdio()
    raw = list(sys.argv[1:] if argv is None else argv)
    if raw and raw[0] == "schedule":
        return handle_schedule(raw[1:], Path.cwd())
    if raw and raw[0] == "ui":
        from .webui import main as ui_main

        return ui_main(raw[1:])

    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        sandbox_settings = resolve_sandbox(
            backend=args.sandbox,
            sandbox_id=args.sandbox_id,
            template=args.sandbox_template,
            timeout=args.sandbox_timeout,
        )
    except ValueError as exc:
        print(f"错误：{exc}")
        return 1

    if sandbox_settings.backend == "e2b":
        # 工作目录是沙盒里的路径，不在本地校验。
        workdir = (
            Path(args.workdir)
            if args.workdir != "."
            else Path(DEFAULT_SANDBOX_WORKDIR)
        )
    else:
        workdir = Path(args.workdir).resolve()
        if not workdir.is_dir():
            print(f"错误：工作目录不存在：{workdir}")
            return 1

    if args.list_skills:
        skills = load_skills(
            [
                Path(__file__).resolve().parent.parent / "skills",
                ANGEL_HOME / "skills",
            ]
        )
        if not skills:
            print("暂无技能")
        else:
            for skill in skills:
                print(f"- {skill.name}：{skill.description}")
        return 0

    if args.list_sessions:
        sessions = list_sessions()
        if not sessions:
            print("暂无历史会话")
        else:
            for s in sessions:
                print(f"- {s['id']}（{s['count']} 条消息）{s['preview']}")
        return 0

    config = load_config()

    if args.list_profiles:
        profiles = list_profiles(config)
        if not profiles:
            print("暂无 provider 档案（在 ~/.angel/config.json 的 profiles 里添加）")
        else:
            for name in profiles:
                print(f"- {name}")
        return 0

    try:
        profile = resolve_profile(args.profile, config)
    except ValueError as exc:
        print(f"错误：{exc}")
        return 1

    mode = validate_mode(args.mode or profile["mode"] or "auto")
    max_turns = args.max_turns or config.get("max_turns") or 20
    if args.context_window is not None and context_limit(args.context_window) is None:
        print("错误：--context-window 必须为正整数")
        return 1
    window = context_limit(
        args.context_window if args.context_window is not None
        else config.get("context_window_tokens")
    )
    enabled_auto_compact = bool(args.auto_compact or config.get("auto_compact_enabled", False))
    try:
        threshold = validate_auto_compact_threshold(
            args.auto_compact_threshold if args.auto_compact_threshold is not None
            else config.get("auto_compact_threshold", DEFAULT_AUTO_COMPACT_THRESHOLD)
        )
    except ValueError as exc:
        print(f"错误：{exc}")
        return 1

    try:
        provider_cfg = resolve_provider(
            args.provider or profile["provider"],
            args.model or profile["model"],
        )
    except ValueError as exc:
        print(f"错误：{exc}")
        return 1

    provider = Provider(provider_cfg)
    if not provider.has_credentials():
        print_setup_help(provider.name)
        return 1

    interactive = sys.stdin.isatty()
    if args.list_mcp:
        manager = build_mcp_manager(mode=mode, interactive=interactive)
        if manager is None:
            print("MCP 未启用或无可用服务器。")
            print("在 ~/.angel/config.json 里设置 \"mcp_enabled\": true 并配置 mcp_servers 后可用。")
            return 0
        try:
            for schema in manager.tool_schemas:
                fn = schema["function"]
                print(f"- {fn['name']}：{fn.get('description', '')}")
        finally:
            manager.stop_all()
        return 0

    if args.compact:
        try:
            info = compact_session_file(args.compact, provider)
        except FileNotFoundError as exc:
            print(f"错误：{exc}")
            return 1
        except Exception as exc:
            print(f"错误：压缩失败：{exc}")
            return 1
        print(
            f"已压缩会话 {info['session_id']}："
            f"{info['before']} 条 → {info['after']} 条"
            f"（方式：{info['method']}，摘要 {info['summary_chars']} 字）"
        )
        return 0

    messages = None
    session_id = None
    if args.resume:
        loaded = load_session(args.resume)
        if loaded is None:
            print(f"错误：找不到会话 {args.resume}")
            return 1
        messages = loaded
        session_id = args.resume

    backend = None
    if sandbox_settings.backend == "e2b":
        try:
            backend = connect_backend(sandbox_settings)
        except E2BError as exc:
            print(f"错误：{exc}")
            return 1
        print(
            f"沙盒已连接：E2B {backend.sandbox_id}"
            f"（超时 {sandbox_settings.timeout} 秒，到期自动销毁）"
        )
        print("文件与命令将在沙盒里执行，不在本地机器上。")
    mcp_manager = build_mcp_manager(mode=mode, interactive=interactive)
    agent = Agent(
        provider=provider,
        workdir=workdir,
        mode=mode,
        max_turns=max_turns,
        session_id=session_id,
        interactive=interactive,
        messages=messages,
        mcp_manager=mcp_manager,
        backend=backend,
        context_window_tokens=window,
        auto_compact_enabled=enabled_auto_compact,
        auto_compact_threshold=threshold,
    )

    try:
        if args.prompt is not None:
            try:
                result = agent.run(args.prompt)
                print(result)
                return 0
            except AgentError as exc:
                print(f"错误：{exc}")
                return 1
            finally:
                # One-shot stdout remains answer-only; metrics go to stderr.
                print("本次运行用量：\n" + format_usage(agent.usage.snapshot()), file=sys.stderr)

        color = use_color()
        print(
            format_banner(
                describe_provider(provider), mode, agent.session_id, color=color
            )
        )
        if interactive:
            # Group tool activity under each answer; only in the REPL, so
            # one-shot output stays exactly as before.
            agent.on_event = ToolPrinter(color=color)
        if backend is not None:
            print(f"沙盒：E2B {backend.sandbox_id}，工作目录：{workdir}")
        if mcp_manager is not None:
            print(f"MCP 工具已加载：{len(mcp_manager.tool_schemas)} 个")
        print(style("输入 /help 查看命令，直接输入文字开始对话。", "dim", enabled=color))

        while True:
            try:
                line = input(repl_prompt(agent.ctx.mode, color=color))
            except EOFError:
                print()
                break
            except KeyboardInterrupt:
                print()
                break

            line = line.strip()
            if not line:
                continue

            if line in ("/exit", "/quit"):
                break
            elif line == "/help":
                print(format_repl_help(color=color))
                continue
            elif line.startswith("/mode "):
                new_mode = line.split(None, 1)[1].strip()
                try:
                    validate_mode(new_mode)
                    if new_mode != agent.mode:
                        # Permission changes must apply to running subprocesses,
                        # not just subsequent tool invocations.
                        if mcp_manager is not None:
                            try:
                                mcp_manager.stop_all()
                            finally:
                                mcp_manager = None
                                agent.mcp_manager = None
                        mcp_manager = build_mcp_manager(
                            mode=new_mode, interactive=interactive
                        )
                        agent.mcp_manager = mcp_manager
                    agent.mode = new_mode
                    agent.ctx.mode = new_mode
                    print(f"已切换为 {new_mode} 模式")
                except ValueError as exc:
                    print(f"错误：{exc}")
                continue
            elif line == "/skills":
                if not agent.skills:
                    print("暂无技能")
                else:
                    for s in agent.skills:
                        print(f"- {s.name}：{s.description}")
                continue
            elif line == "/sessions":
                sessions = list_sessions()
                if not sessions:
                    print("暂无历史会话")
                else:
                    for s in sessions:
                        print(f"- {s['id']}（{s['count']} 条消息）{s['preview']}")
                continue
            elif line == "/status":
                print(
                    f"会话：{agent.session_id}；模型：{provider.name} / {provider.model}；模式：{agent.mode}\n"
                    + format_usage(agent.usage.snapshot())
                    + (f"\n自动压缩：已触发 {agent.auto_compact_count} 次" if enabled_auto_compact else "\n自动压缩：未启用")
                )
                continue
            elif line == "/compact":
                info = agent.compact()
                print(
                    f"已压缩当前会话：{info['before']} 条 → {info['after']} 条"
                    f"（方式：{info['method']}）"
                )
                continue
            elif line == "/clear":
                agent.messages = []
                agent.usage = UsageTracker(configured_window=window)
                print("已清空对话历史")
                continue
            elif line == "/new":
                agent.messages = []
                agent.usage = UsageTracker(configured_window=window)
                agent.session_id = new_session_id()
                print(f"已开始新会话：{agent.session_id}")
                continue
            else:
                try:
                    result = agent.run(line)
                    print(result)
                except AgentError as exc:
                    print(style(f"错误：{exc}", "red", enabled=color))

        return 0
    finally:
        if backend is not None:
            backend.close()
        if mcp_manager is not None:
            mcp_manager.stop_all()


if __name__ == "__main__":
    raise SystemExit(main())
