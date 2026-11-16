"""Angel 的工具驱动代理循环、系统提示词和子任务委派。"""

import json
from pathlib import Path

from .config import ANGEL_HOME, load_config
from .providers import Provider, ProviderError
from .tools import TOOL_SCHEMAS, ToolContext, ToolError, _check_approval, execute_tool
from .skills import Skill, load_skills, match_skills, render_skill
from .memory import load_memory_summary, load_agents_md, new_session_id, save_session
from .compact import compact_messages
from .evidence import EvidenceStore
from .mcp import MCPToolManager, load_mcp_servers


class AgentError(Exception):
    pass


SYSTEM_PROMPT_BASE: str = """你是 Angel，一个全能 AI 助手，通过调用工具完成任务，而不是只靠说话。
多步骤任务先调用 plan 写计划，再按计划执行；复杂子任务可以用 delegate 交给子 agent。
需要读取文件、执行命令、联网查资料时直接调用工具；不要猜测文件内容，不要编造信息。
修改文件前先调用 read_file 了解现状；edit_file 的 old_text 必须精确匹配且唯一。
shell 命令保持简单、安全，不执行破坏性命令。
需要查证事实时按“搜索→打开官网→逐项核对→存证→附链接交付”走：先 web_search 找来源，再 web_fetch 打开官网原文逐项核对，
引用网上信息时必须附上来源链接；web_fetch / web_search 的结果已存为会话内证据文件，结论要能用证据复核，不要把搜索摘要当不可验证的答案。
任务完成后，如果这次的做法值得复用，用 save_skill 把它保存为技能。
所有回答使用中文，任务结束时简要汇报做了什么。"""

MODE_NOTES = {
    "readonly": "当前为只读模式：你只能读取文件、联网查询，不能写入文件或执行命令；外部 MCP 工具也不可调用。",
    "auto": "当前为自动确认模式：写入文件、执行命令或调用外部 MCP 工具前，系统会请用户确认。", 
    "full": "当前为全权模式：你可以写入文件和执行命令，请谨慎操作。",
}


class Agent:
    """通过提供商调用工具并维护会话历史的代理。"""

    def __init__(
        self,
        provider: Provider,
        workdir: str | Path = ".",
        mode: str = "auto",
        max_turns: int = 20,
        session_id: str | None = None,
        interactive: bool = True,
        skills_dirs: list[Path] | None = None,
        messages: list[dict] | None = None,
        mcp_manager: MCPToolManager | None = None,
        backend: object | None = None,
    ) -> None:
        self.provider = provider
        self.workdir = Path(workdir)
        self.mode = mode
        self.max_turns = max_turns
        self.interactive = interactive
        self.session_id = session_id or new_session_id()
        self.messages: list[dict] = list(messages) if messages is not None else []
        self.skills_dirs: list[Path] = (
            skills_dirs
            if skills_dirs is not None
            else [
                Path(__file__).resolve().parent.parent / "skills",
                ANGEL_HOME / "skills",
            ]
        )
        self.skills: list[Skill] = load_skills(self.skills_dirs)
        self.mcp_manager = mcp_manager
        self.backend = backend
        self.evidence = EvidenceStore(ANGEL_HOME / "evidence", self.session_id)
        self.ctx = ToolContext(
            workdir=self.workdir,
            mode=mode,
            interactive=interactive,
            memory_path=ANGEL_HOME / "MEMORY.md",
            skills_dir=ANGEL_HOME / "skills",
            delegate_fn=self.delegate,
            evidence=self.evidence,
            backend=backend,
        )

    def tool_schemas(self) -> list[dict]:
        """内置工具 + 已启动的 MCP 服务器工具。"""
        schemas = list(TOOL_SCHEMAS)
        if self.mcp_manager is not None and self.mcp_manager.has_tools():
            schemas.extend(self.mcp_manager.tool_schemas)
        return schemas

    def compact(self, keep_last: int = 4) -> dict:
        """压缩当前会话：模型摘要 + 保留最近几条消息，并保存。"""
        new_messages, info = compact_messages(
            self.provider, self.messages, keep_last=keep_last
        )
        self.messages = new_messages
        save_session(self.session_id, self.messages)
        return info

    def build_system_prompt(self, task: str) -> str:
        sections = [SYSTEM_PROMPT_BASE, MODE_NOTES.get(self.mode, "")]
        if self.backend is not None:
            sections.append(
                f"当前执行后端是 {self.backend.name} 沙盒："
                "文件读写与命令都在沙盒里执行，不在本地机器上；"
                "工作目录是沙盒里的工作目录。"
            )

        agents_md = load_agents_md(self.workdir)
        if agents_md:
            sections.append(agents_md)

        matched = match_skills(task, self.skills, top_n=2)
        if matched:
            sections.append(
                "## 相关技能\n" + "\n\n".join(render_skill(s) for s in matched)
            )

        memory = load_memory_summary()
        if memory:
            sections.append("## 长期记忆\n" + memory)

        return "\n\n".join(sections)

    def run(self, task: str) -> str:
        system = self.build_system_prompt(task)
        messages: list[dict] = (
            [{"role": "system", "content": system}]
            + self.messages
            + [{"role": "user", "content": task}]
        )

        for _ in range(self.max_turns):
            try:
                resp = self.provider.chat(messages, tools=self.tool_schemas())
            except ProviderError as exc:
                raise AgentError(str(exc)) from exc

            choice = resp["choices"][0]
            msg = choice.get("message") or {}
            assistant_msg: dict = {
                "role": "assistant",
                "content": msg.get("content") or "",
            }
            tool_calls = msg.get("tool_calls") or []
            if tool_calls:
                assistant_msg["tool_calls"] = tool_calls
            messages.append(assistant_msg)

            if not tool_calls:
                final = msg.get("content") or ""
                self.messages = messages[1:]
                save_session(self.session_id, self.messages)
                return final

            for tc in tool_calls:
                fn_name = tc.get("function", {}).get("name", "")
                args_raw = tc.get("function", {}).get("arguments") or "{}"
                try:
                    args = json.loads(args_raw)
                except Exception:
                    args = None

                if args is None or not isinstance(args, dict):
                    result = "错误：工具参数不是合法的 JSON 对象"
                elif fn_name.startswith("mcp_") and self.mcp_manager is not None:
                    # MCP servers can expose side-effecting tools without declaring
                    # it in their schema. Never trust their names as proof of safety.
                    # Approval must happen at the same boundary as built-in tools.
                    try:
                        _check_approval(
                            self.ctx,
                            "mcp",
                            f"调用外部 MCP 工具：{fn_name}（可能产生外部副作用）",
                        )
                    except ToolError as exc:
                        result = f"错误：{exc}"
                    else:
                        result = self.mcp_manager.execute(fn_name, args)
                else:
                    result = execute_tool(fn_name, args, self.ctx)

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.get("id", ""),
                        "content": result,
                    }
                )

            save_session(self.session_id, messages[1:])

        self.messages = messages[1:]
        save_session(self.session_id, self.messages)
        return "（已达到最大轮数，任务未完成，请拆分任务或提高 --max-turns 后重试）"

    def delegate(self, task: str, max_turns: int = 6) -> str:
        child = Agent(
            provider=self.provider,
            workdir=self.workdir,
            mode=self.mode,
            max_turns=max_turns,
            session_id=None,
            interactive=self.interactive,
            skills_dirs=self.skills_dirs,
            mcp_manager=self.mcp_manager,
            backend=self.backend,
        )
        try:
            return child.run(task)
        except AgentError as exc:
            return f"子任务失败：{exc}"
        except Exception as exc:
            return f"子任务异常：{type(exc).__name__}: {exc}"


def build_mcp_manager(
    timeout: float = 30.0,
    *,
    mode: str = "auto",
    interactive: bool = False,
) -> MCPToolManager | None:
    """按执行权限决定是否启动 MCP 服务，而不只检查调用权限。

    启动本机 MCP 程序本身就可能产生副作用，即使不调用它的工具也是如此。
    readonly 或非交互 auto 一律不启动；交互 auto 按服务器逐一确认。
    """
    if mode not in ("auto", "full"):
        return None
    if mode == "auto" and not interactive:
        return None

    try:
        config = load_config()
    except Exception:
        return None
    if not config.get("mcp_enabled"):
        return None
    servers = load_mcp_servers(config)
    if not servers:
        return None

    if mode == "auto":
        approved = {}
        for name, server in servers.items():
            # Server commands and env can contain secrets; only show the name.
            print(
                f"外部 MCP 服务 {name} 将以当前系统用户启动，"
                "可能访问本机文件和网络。"
            )
            try:
                answer = input("允许启动该 MCP 服务吗？[y/N] ")
            except (EOFError, KeyboardInterrupt):
                answer = ""
            if answer.strip().lower() in ("y", "yes"):
                approved[name] = server
        servers = approved
        if not servers:
            return None

    manager = MCPToolManager(servers, timeout=timeout)
    manager.start_all()
    if not manager.has_tools():
        manager.stop_all()
        return None
    return manager
