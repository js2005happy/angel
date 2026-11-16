"""Angel 命令行入口，支持单次任务执行与交互式会话。"""

import argparse
import sys
from pathlib import Path

from . import __version__
from .console import ToolPrinter, configure_stdio, format_provider_fallback, style, use_color
from .config import (
    ANGEL_HOME,
    VALID_MODES,
    list_profiles,
    load_config,
    resolve_profile,
    resolve_provider_chain,
    resolve_sandbox,
    validate_mode,
)
from .e2b_backend import DEFAULT_SANDBOX_WORKDIR, E2BError, connect_backend
from .providers import ProviderError, build_provider, describe_provider
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
from .memory import list_sessions, load_session, new_session_id, save_session
from .checkpoints import CheckpointStore, CheckpointError
from .usage import CostLedger, context_limit, format_usage
from .compact import validate_auto_compact_threshold, DEFAULT_AUTO_COMPACT_THRESHOLD


REPL_COMMANDS = (
    ("/help", "显示本帮助"),
    ("/mode <模式>", "切换审批模式（readonly / auto / full）"),
    ("/skills", "列出已加载的技能"),
    ("/sessions", "列出历史会话"),
    ("/compact", "压缩当前会话（模型摘要 + 保留最近消息）"),
    ("/status", "显示模型调用与 Token 用量、参考上下文余量"),
    ("/diff", "查看最近一轮本地文件检查点的实际修改差异"),
    ("/undo", "撤销当前会话最近一轮内置本地文件修改"),
    ("/rewind N", "撤销最近 N 轮文件检查点（最多 10），若有外部改动则拒绝"),
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
    provider = build_provider(
        resolve_provider_chain(provider_name, model, profile["fallback_providers"])
    )
    if not provider.has_credentials():
        raise AgentError(f"定时任务 {task['name']} 没有可用的模型凭证")
    return Agent(
        provider=provider,
        workdir=workdir,
        mode=validate_mode(mode),
        max_turns=config.get("max_turns") or 20,
        interactive=False,
        model_pricing=config.get("model_pricing"),
        cost_budget_usd=config.get("cost_budget_usd"),
    )


def _run_scheduled_task(task: dict, workdir: Path) -> str:
    agent = _make_task_agent(task, workdir)
    result = agent.run(task["prompt"])
    if agent._trace_outcome == "incomplete":
        raise AgentError(result)
    return result


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
            "angel ui [--host 127.0.0.1] [--port 8765] [--open] 启动本地网页界面；"
            "angel permissions <list|check|grant|revoke|audit> 管理 Poppy 站点授权意向；"
            "angel eigenflux doctor [--room ID --bot ID] [--check] 接入检测；"
            "angel eigenflux policy <show|allow|deny|audit> 管理逐机器人本地网络限制"
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
        "--cost-budget-usd", default=None,
        help="当前 Agent 的费用停止阈值（需配置 model_pricing；单次请求可能超出）",
    )
    parser.add_argument(
        "--json", dest="json_mode", action="store_true",
        help="单次非交互任务输出 JSON Lines（机器可读事件 + 稳定退出码）",
    )
    parser.add_argument(
        "--trace", action="store_true",
        help="输出本次任务的模型与工具执行追踪（token/耗时/状态，不含提示词和工具结果）",
    )
    parser.add_argument(
        "--auto-compact", action="store_true",
        help="达到配置的上下文阈值时自动压缩（需要设置 --context-window，可能增加模型费用）",
    )
    parser.add_argument(
        "--auto-compact-threshold", type=float, default=None,
        help="触发自动压缩的上下文占比，0.50 到 0.95（默认 0.80）",
    )
    parser.add_argument(
        "--poppy", action="store_true",
        help="显式启用只读 Poppy 1.0 公共协议发现工具（默认关闭）",
    )
    parser.add_argument(
        "--discover-poppy", metavar="HTTPS_SITE", default=None,
        help="仅检查站点 Poppy 元数据后退出，无需模型 API Key",
    )
    parser.add_argument(
        "--inspect-poppy-identity", metavar="HTTPS_SITE", default=None,
        help="只读核验 Poppy 公司域名与 OAuth issuer 的元数据归属，无需模型 Key",
    )
    parser.add_argument(
        "--plan", dest="plan_mode", action="store_true",
        help="先只读分析，生成工作目录中的 plan.md，不执行任务",
    )
    parser.add_argument(
        "--execute-plan", action="store_true",
        help="执行经 SHA-256 校验值批准的 plan.md（工具仍受审批模式约束）",
    )
    parser.add_argument(
        "--approve-plan", default=None, metavar="SHA256",
        help="批准完整 plan.md 的 SHA-256 校验值，仅用于 --execute-plan",
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
    if raw and raw[0] == "permissions":
        from .poppy_permissions_cli import main as permissions_main

        return permissions_main(raw[1:])
    if raw and raw[0] == "eigenflux":
        from .eigenflux_adapter import main as eigenflux_main

        return eigenflux_main(raw[1:])
    if raw and raw[0] == "knowledge":
        from .knowledge_cli import main as knowledge_main

        return knowledge_main(raw[1:])
    if raw and raw[0] == "eval":
        from .evaluation import main as evaluation_main

        return evaluation_main(raw[1:])

    parser = build_parser()
    if "--json" in raw and not any(flag in raw for flag in ("--help", "-h")):
        try:
            args = parser.parse_args(raw)
        except SystemExit as exc:
            # argparse uses exit code 2 for invalid flags/values. Emit JSONL
            # too, so CI consumers never receive malformed stdout on errors.
            if exc.code == 0:
                return 0
            from .json_mode import invalid_arguments

            return invalid_arguments(sys.stdout)
    else:
        args = parser.parse_args(raw)

    if args.inspect_poppy_identity is not None:
        if args.json_mode:
            from .json_mode import invalid_arguments
            return invalid_arguments(
                sys.stdout, "--inspect-poppy-identity 不能与 --json 混用"
            )
        if (
            args.discover_poppy is not None or args.prompt is not None
            or args.plan_mode or args.execute_plan or args.approve_plan
        ):
            print("错误：--inspect-poppy-identity 是独立的只读诊断命令", file=sys.stderr)
            return 2
        import json
        from .poppy_identity import inspect_poppy_identity
        from .poppy import PoppyError
        try:
            result = inspect_poppy_identity(args.inspect_poppy_identity)
        except (PoppyError, OSError) as exc:
            print(f"Poppy 身份核验失败：{exc}", file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.discover_poppy is not None:
        if args.json_mode:
            from .json_mode import invalid_arguments
            return invalid_arguments(
                sys.stdout, "--discover-poppy 不能与 --json 混用"
            )
        if (args.prompt is not None or args.plan_mode or args.execute_plan
                or args.approve_plan):
            print("错误：--discover-poppy 是独立只读命令，不能混用任务执行")
            return 2
        import json
        from .poppy import PoppyError, discover_poppy
        try:
            result = discover_poppy(args.discover_poppy)
        except PoppyError as exc:
            print(f"Poppy 发现失败：{exc}", file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.json_mode:
        from .json_mode import invalid_arguments, run_json

        if args.plan_mode or args.execute_plan or args.approve_plan:
            return invalid_arguments(
                sys.stdout, "--json 与 --plan/--execute-plan 不能组合使用"
            )
        return run_json(args)

    # Plan generation is a separate code path: no Agent, MCP server,
    # E2B sandbox, session store, shell, or mutating tool is instantiated.
    # Only plan.md is persisted in the selected working directory.
    if args.plan_mode or args.execute_plan or args.approve_plan:
        from .plan_mode import (
            PlanError, build_plan, render_plan, save_plan,
            read_approved_plan, approved_execution_task,
        )

        plan_flags = (
            args.compact or args.list_mcp or args.list_profiles
            or args.list_skills or args.list_sessions or args.resume
        )
        if (
            (args.plan_mode and args.execute_plan)
            or (args.approve_plan and not args.execute_plan)
            or plan_flags
            or (args.plan_mode and (not args.prompt or args.approve_plan))
            or (args.execute_plan and (args.prompt is not None or not args.approve_plan))
        ):
            print("错误：--plan 需要任务文本；--execute-plan 需要 --approve-plan SHA256，且不能混用其他会话命令")
            return 2

        if args.plan_mode:
            if args.sandbox == "e2b" or args.sandbox_id or args.sandbox_template or args.sandbox_timeout:
                print("错误：计划生成阶段只支持本地只读分析，不启动沙盒")
                return 2
            try:
                config = load_config()
                profile = resolve_profile(args.profile, config)
                provider_cfgs = resolve_provider_chain(
                    args.provider or profile["provider"],
                    args.model or profile["model"],
                    profile["fallback_providers"],
                )
                provider = build_provider(provider_cfgs)
                if not provider.has_credentials():
                    print_setup_help(provider.name)
                    return 2
                root = Path(args.workdir).resolve()
                details = build_plan(provider, args.prompt, root)
                fallback = provider.consume_fallback_event() if hasattr(provider, "consume_fallback_event") else None
                if fallback:
                    print(format_provider_fallback(fallback), file=sys.stderr)
                digest = save_plan(root, render_plan(args.prompt, details))
            except (PlanError, ValueError, ProviderError, OSError) as exc:
                print(f"规划失败：{exc}")
                return 1
            print(f"已生成只读计划：{root / 'plan.md'}")
            print(f"SHA-256：{digest}")
            print(f"审核内容后执行：python -m angel --workdir {str(root)!r} --execute-plan --approve-plan {digest}")
            print("执行阶段默认 auto：写入/命令仍需逐项确认，除非明确选择 --mode full。")
            return 0

        if args.execute_plan:
            if args.sandbox == "e2b" or args.sandbox_id or args.sandbox_template or args.sandbox_timeout:
                print("错误：当前计划执行只支持本地工作目录，请先审核计划并在本机运行")
                return 2
            if args.mode == "readonly":
                print("错误：readonly 不适合执行写入计划，请使用默认 auto 模式")
                return 2
            try:
                approved = read_approved_plan(
                    Path(args.workdir).resolve(), args.approve_plan
                )
            except (PlanError, OSError) as exc:
                print(f"计划审批失败：{exc}")
                return 2
            args.prompt = approved_execution_task(approved)
            args.mode = args.mode or "auto"
            # Do not inherit a saved e2b setting when the approval is local.
            args.sandbox = "local"

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
        provider_cfgs = resolve_provider_chain(
            args.provider or profile["provider"],
            args.model or profile["model"],
            profile["fallback_providers"],
        )
    except ValueError as exc:
        print(f"错误：{exc}")
        return 1

    provider = build_provider(provider_cfgs)
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
        cost_ledger = CostLedger(
            config.get("model_pricing"),
            args.cost_budget_usd
            if args.cost_budget_usd is not None
            else config.get("cost_budget_usd"),
        )
        try:
            info = compact_session_file(args.compact, provider, cost_ledger=cost_ledger)
            consume = getattr(provider, "consume_fallback_event", None)
            fallback = consume() if callable(consume) else None
            if fallback:
                if fallback.get("failed"):
                    cost_ledger.mark_unknown("fallback_attempt")
                print(format_provider_fallback(fallback), file=sys.stderr)
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
        poppy_enabled=args.poppy,
        trace_enabled=args.trace,
        model_pricing=config.get("model_pricing"),
        cost_budget_usd=(
            args.cost_budget_usd
            if args.cost_budget_usd is not None
            else config.get("cost_budget_usd")
        ),
    )

    try:
        if args.prompt is not None:
            try:
                result = agent.run(args.prompt)
                print(result)
                return 3 if agent._trace_outcome == "incomplete" else 0
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
                    if agent.mode != new_mode:
                        agent.ctx.approved_file_tools.clear()
                        agent.ctx.approved_shell_commands.clear()
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
            elif line == "/diff":
                if agent.checkpoints is None:
                    print("当前执行后端不支持本地文件差异检查")
                else:
                    try:
                        print(agent.checkpoints.latest_diff())
                    except (CheckpointError, OSError) as exc:
                        print(f"差异查看失败：{exc}")
                continue
            elif line == "/compact":
                info = agent.compact()
                print(
                    f"已压缩当前会话：{info['before']} 条 → {info['after']} 条"
                    f"（方式：{info['method']}）"
                )
                continue
            elif line == "/undo" or line == "/rewind" or line.startswith("/rewind "):
                if agent.checkpoints is None:
                    print("错误：当前执行后端不支持本地文件检查点撤销")
                    continue
                try:
                    if line == "/undo" or line == "/rewind":
                        count = 1
                    else:
                        pieces = line.split()
                        if len(pieces) != 2 or not pieces[1].isdigit():
                            raise CheckpointError("用法：/rewind N（1 至 10）")
                        count = int(pieces[1])
                    result = agent.checkpoints.undo(count)
                except (CheckpointError, OSError) as exc:
                    print(f"撤销失败：{exc}")
                    continue
                # The model's history must not silently claim undone file
                # changes are still present. Log the rollback as a user turn.
                agent.messages.append({
                    "role": "user", "content": (
                        f"[Angel 撤销记录] 已恢复最近 {result['turns']} 轮中的 "
                        f"{result['files']} 个本地文件；此前工具执行结果可能已失效。"
                        "后续操作请重新读取文件，不要假设此前改动仍存在。"
                    ),
                })
                save_session(agent.session_id, agent.messages)
                agent.ctx.approved_file_tools.clear()
                agent.ctx.approved_shell_commands.clear()
                print(f"已撤销 {result['turns']} 轮，恢复 {result['files']} 个本地文件。")
                print("注意：Shell、MCP、E2B、记忆/技能等副作用不在撤销范围内。")
                continue
            elif line == "/clear":
                agent.messages = []
                agent.ctx.approved_file_tools.clear()
                agent.ctx.approved_shell_commands.clear()
                agent.reset_usage(configured_window=window)
                print("已清空对话历史")
                continue
            elif line == "/new":
                agent.messages = []
                agent.ctx.approved_file_tools.clear()
                agent.ctx.approved_shell_commands.clear()
                agent.reset_usage(configured_window=window)
                agent.session_id = new_session_id()
                if agent.checkpoints is not None:
                    agent.checkpoints = CheckpointStore(
                        ANGEL_HOME / "checkpoints", agent.session_id, agent.workdir
                    )
                    agent.ctx.checkpoint = agent.checkpoints
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
