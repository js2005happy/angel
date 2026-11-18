"""Nyra smoke tests (stdlib unittest only).

Run from the project root:
    python3 -m unittest discover tests
or directly:
    python3 tests/test_smoke.py

A FakeProvider returns canned tool calls so the agent loop can be tested
without any API key or network access.
"""

import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nyra.agent import Agent, AgentError  # noqa: E402
from nyra.compact import (  # noqa: E402
    build_compact_messages,
    compact_messages,
    compact_session_file,
)
from nyra.config import (  # noqa: E402
    NYRA_HOME,
    list_profiles,
    resolve_profile,
    resolve_provider,
)
from nyra.evidence import EvidenceStore  # noqa: E402
from nyra.mcp import (  # noqa: E402
    MCPClient,
    MCPError,
    MCPServerConfig,
    MCPToolManager,
    load_mcp_servers,
)
from nyra.memory import (  # noqa: E402
    load_session,
    new_session_id,
    save_session,
)
from nyra.scheduler import (  # noqa: E402
    ScheduleError,
    add_task,
    due_tasks,
    is_due,
    list_tasks,
    load_schedule,
    remove_task,
    run_daemon,
    run_due_tasks,
    save_schedule,
)
from nyra.skills import (  # noqa: E402
    load_skills,
    match_skills,
    parse_skill_file,
)
from nyra.tools import (  # noqa: E402
    ToolContext,
    _parse_baidu_html,
    _parse_bing_html,
    execute_tool,
)
import nyra.tools as tools_module  # noqa: E402


def tool_call(call_id, name, arguments):
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def assistant_message(content="", calls=None):
    msg = {"role": "assistant", "content": content}
    if calls:
        msg["tool_calls"] = calls
    return {"choices": [{"message": msg}]}


class FakeProvider:
    """Returns a scripted list of responses, one per chat() call."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0

    def chat(self, messages, tools=None, timeout=120):
        self.calls += 1
        if not self.responses:
            return assistant_message("没有更多预设回复。")
        return self.responses.pop(0)


class AgentLoopTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.sessions = []

    def tearDown(self):
        for sid in self.sessions:
            p = NYRA_HOME / "sessions" / f"{sid}.jsonl"
            if p.exists():
                p.unlink()

    def make_agent(self, provider, mode="full", max_turns=10):
        agent = Agent(
            provider=provider,
            workdir=self.tmp,
            mode=mode,
            max_turns=max_turns,
            interactive=False,
        )
        self.sessions.append(agent.session_id)
        return agent

    def test_write_then_read_then_answer(self):
        """Core loop: model writes a file, reads it back, answers."""
        provider = FakeProvider(
            [
                assistant_message(
                    calls=[tool_call("c1", "write_file", {"path": "hello.txt", "content": "你好，Nyra！"})]
                ),
                assistant_message(
                    calls=[tool_call("c2", "read_file", {"path": "hello.txt"})]
                ),
                assistant_message("文件已创建并读取完毕。"),
            ]
        )
        agent = self.make_agent(provider)
        result = agent.run("创建一个问候文件并读回来")
        self.assertEqual(result, "文件已创建并读取完毕。")
        self.assertEqual((self.tmp / "hello.txt").read_text(encoding="utf-8"), "你好，Nyra！")
        self.assertEqual(provider.calls, 3)

    def test_delegate_subagent(self):
        """delegate tool runs a child loop and returns its summary."""
        provider = FakeProvider(
            [
                assistant_message(
                    calls=[tool_call("c1", "delegate", {"task": "数一下有多少文件", "max_turns": 3})]
                ),
                assistant_message("子任务说：共 0 个文件。"),
            ]
        )
        # Child agent consumes the next scripted response.
        provider.responses.insert(1, assistant_message("共 0 个文件。"))
        agent = self.make_agent(provider)
        result = agent.run("把数文件的任务交给子 agent")
        self.assertIn("0 个文件", result)

    def test_session_saved_and_resumable(self):
        provider = FakeProvider([assistant_message("好的。")])
        agent = self.make_agent(provider)
        agent.run("打个招呼")
        loaded = load_session(agent.session_id)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded[-1]["content"], "好的。")
        # Resume: the new agent continues the same history.
        resumed = Agent(
            provider=FakeProvider([assistant_message("继续。")]),
            workdir=self.tmp,
            mode="full",
            max_turns=5,
            interactive=False,
            session_id=agent.session_id,
            messages=loaded,
        )
        self.sessions.append(resumed.session_id)
        out = resumed.run("继续")
        self.assertEqual(out, "继续。")
        self.assertEqual(len(resumed.messages), len(loaded) + 2)

    def test_max_turns_stops_loop(self):
        provider = FakeProvider(
            [assistant_message(calls=[tool_call(f"c{i}", "list_dir", {"path": "."})]) for i in range(10)]
        )
        agent = self.make_agent(provider, max_turns=3)
        result = agent.run("一直列目录")
        self.assertIn("最大轮数", result)
        self.assertEqual(provider.calls, 3)

    def test_provider_error_surfaces(self):
        from nyra.providers import ProviderError

        class FailingProvider:
            def chat(self, messages, tools=None, timeout=120):
                raise ProviderError("认证失败 (HTTP 401)：API Key 无效")

        agent = self.make_agent(FailingProvider())
        with self.assertRaises(AgentError) as ctx:
            agent.run("你好")
        self.assertIn("401", str(ctx.exception))


class ToolsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.ctx = ToolContext(
            workdir=self.tmp,
            mode="full",
            interactive=False,
            memory_path=NYRA_HOME / "MEMORY.md",
            skills_dir=NYRA_HOME / "skills",
        )

    def test_write_read_edit_list(self):
        self.assertIn("已写入", execute_tool("write_file", {"path": "a.txt", "content": "hello"}, self.ctx))
        self.assertEqual(execute_tool("read_file", {"path": "a.txt"}, self.ctx), "hello")
        self.assertIn("已编辑", execute_tool("edit_file", {"path": "a.txt", "old_text": "hello", "new_text": "hi"}, self.ctx))
        self.assertEqual(execute_tool("read_file", {"path": "a.txt"}, self.ctx), "hi")
        listing = execute_tool("list_dir", {"path": "."}, self.ctx)
        self.assertIn("a.txt", listing)

    def test_edit_ambiguous_is_rejected(self):
        execute_tool("write_file", {"path": "b.txt", "content": "x x x"}, self.ctx)
        out = execute_tool("edit_file", {"path": "b.txt", "old_text": "x", "new_text": "y"}, self.ctx)
        self.assertIn("错误", out)

    def test_shell_denylist(self):
        for cmd in ("rm -rf /", "rm -rf ~", "rm -rf $HOME", "mkfs.ext4 /dev/sda1",
                    "dd if=/dev/zero of=/dev/sda", "shutdown now", ":(){ :|:& };:"):
            out = execute_tool("shell", {"command": cmd}, self.ctx)
            self.assertTrue(out.startswith("错误："), f"{cmd!r} was not blocked: {out}")

    def test_shell_denylist_rm_flag_variants(self):
        # 只认 "-rf" 会被拆开/长选项/组合标志写法绕过：这些都必须拦。
        for cmd in (
            "rm -r -f /",
            "rm -f -r /",
            "rm -R -f ~",
            "rm --recursive --force /",
            "rm -r --force /",
            "rm -rfv /",
            "rm -rf -- /",
            "rm -rf $HOME/",
            "rm -rf ${HOME}",
            "rm -rf ~/x",
            "rm -rf /*",
            "rm -rf .",
            "rm -rf ..",
            "dd if=/dev/zero of =/dev/sda",
            "chmod -R 777 /",
            "chmod 777 -R /",
        ):
            out = execute_tool("shell", {"command": cmd}, self.ctx)
            self.assertTrue(out.startswith("错误："), f"{cmd!r} was not blocked: {out}")

    def test_shell_denylist_allows_scoped_rm(self):
        # 有范围的删除仍放行：黑名单只拦根目录/家目录/通配目标。
        (self.tmp / "build").mkdir()
        for cmd in ("rm -rf build", "rm -r -f ./build", "rm --recursive --force build"):
            out = execute_tool("shell", {"command": cmd}, self.ctx)
            self.assertFalse(out.startswith("错误："), f"{cmd!r} was wrongly blocked: {out}")
            (self.tmp / "build").mkdir(exist_ok=True)

    def test_web_fetch_rejects_metadata_service(self):
        out = execute_tool(
            "web_fetch", {"url": "http://169.254.169.254/latest/meta-data/"}, self.ctx
        )
        self.assertIn("元数据", out)
        out = execute_tool(
            "web_fetch", {"url": "http://metadata.google.internal/"}, self.ctx
        )
        self.assertIn("元数据", out)

    def test_shell_runs(self):
        out = execute_tool("shell", {"command": "echo 42"}, self.ctx)
        self.assertIn("42", out)

    def test_readonly_blocks_writes(self):
        ro = ToolContext(
            workdir=self.tmp, mode="readonly", interactive=False,
            memory_path=NYRA_HOME / "MEMORY.md", skills_dir=NYRA_HOME / "skills",
        )
        out = execute_tool("write_file", {"path": "c.txt", "content": "x"}, ro)
        self.assertIn("只读模式", out)
        self.assertFalse((self.tmp / "c.txt").exists())
        self.assertEqual(execute_tool("read_file", {"path": "a.txt"}, ro), "错误：文件不存在：a.txt")

    def test_auto_non_interactive_blocks_writes(self):
        auto = ToolContext(
            workdir=self.tmp, mode="auto", interactive=False,
            memory_path=NYRA_HOME / "MEMORY.md", skills_dir=NYRA_HOME / "skills",
        )
        out = execute_tool("write_file", {"path": "d.txt", "content": "x"}, auto)
        self.assertIn("非交互模式", out)
        self.assertFalse((self.tmp / "d.txt").exists())

    def test_unknown_tool(self):
        out = execute_tool("no_such_tool", {}, self.ctx)
        self.assertIn("未知工具", out)

    def test_plan_writes_file(self):
        out = execute_tool("plan", {"title": "测试计划", "steps": ["第一步", "第二步"]}, self.ctx)
        self.assertIn("已写入计划", out)
        content = (self.tmp / "plan.md").read_text(encoding="utf-8")
        self.assertIn("# 测试计划", content)
        self.assertIn("1. 第一步", content)


class SkillsTest(unittest.TestCase):
    def test_parse_and_match(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "demo.md"
            p.write_text(
                "---\nname: demo\ndescription: 演示技能\nwhen: 测试时用\nkeywords: 搜索, 最新\n---\n先搜索再核实。\n",
                encoding="utf-8",
            )
            skill = parse_skill_file(p)
            self.assertEqual(skill.name, "demo")
            self.assertEqual(skill.keywords, ["搜索", "最新"])
            self.assertIn("先搜索", skill.instructions)
            matched = match_skills("帮我搜索最新的消息", [skill])
            self.assertEqual([s.name for s in matched], ["demo"])
            self.assertEqual(match_skills("写一首诗", [skill]), [])

    def test_load_skills_skips_bad_files(self):
        with tempfile.TemporaryDirectory() as d:
            bad = Path(d) / "bad.md"
            bad.write_text("没有 frontmatter\n", encoding="utf-8")
            good = Path(d) / "good.md"
            good.write_text("---\nname: good\ndescription: 好技能\n---\n内容。\n", encoding="utf-8")
            skills = load_skills([Path(d)])
            self.assertEqual([s.name for s in skills], ["good"])


class ConfigAndSessionTest(unittest.TestCase):
    def test_deepseek_preset(self):
        cfg = resolve_provider("deepseek")
        self.assertEqual(cfg.base_url, "https://api.deepseek.com/v1")
        self.assertEqual(cfg.model, "deepseek-flash")

    def test_unknown_provider(self):
        with self.assertRaises(ValueError):
            resolve_provider("no-such-provider")

    def test_session_id_unique(self):
        self.assertNotEqual(new_session_id(), new_session_id())

    def test_save_load_session_roundtrip(self):
        sid = new_session_id()
        try:
            msgs = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
            save_session(sid, msgs)
            self.assertEqual(load_session(sid), msgs)
        finally:
            p = NYRA_HOME / "sessions" / f"{sid}.jsonl"
            if p.exists():
                p.unlink()


class CliTest(unittest.TestCase):
    def test_list_skills_lists_shipped_skills(self):
        root = Path(__file__).resolve().parent.parent
        env = dict(os.environ)
        env["PYTHONPATH"] = str(root)
        out = subprocess.run(
            [sys.executable, "-m", "nyra", "--list-skills"],
            cwd=root, env=env, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("web-research", out.stdout)
        self.assertIn("file-organizer", out.stdout)

    def test_version_flag(self):
        root = Path(__file__).resolve().parent.parent
        out = subprocess.run(
            [sys.executable, "-m", "nyra", "--version"],
            cwd=root, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(out.returncode, 0)
        self.assertIn("Nyra 0.3.0", out.stdout)


FAKE_MCP_SERVER = '''\
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except ValueError:
        continue
    method = req.get("method")
    rid = req.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "fake", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [{"name": "echo", "description": "回显文本", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}]}})
    elif method == "tools/call":
        args = (req.get("params") or {}).get("arguments") or {}
        send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": "回显：" + str(args.get("text", ""))}], "isError": False}})
    elif rid is not None:
        # 旧版服务器对握手前收到的未知方法回方法未找到，客户端据此回退。
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "Method not found"}})
    # 通知（无 id）直接忽略
'''


class _EchoHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = "<html><head><title>测试页</title></head><body>你好，证据链。</body></html>".encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length)
        body = "收到：".encode("utf-8") + data
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class MCPTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.server_script = self.tmp / "fake_mcp.py"
        self.server_script.write_text(FAKE_MCP_SERVER, encoding="utf-8")
        self.clients = []

    def tearDown(self):
        for client in self.clients:
            try:
                client.stop()
            except Exception:
                pass

    def _config(self):
        return MCPServerConfig(
            name="fake", command=sys.executable, args=[str(self.server_script)]
        )

    def test_config_validation(self):
        with self.assertRaises(MCPError):
            MCPServerConfig.from_dict("x", {"args": []})
        with self.assertRaises(MCPError):
            MCPServerConfig.from_dict("x", {"command": "python3", "args": "not-a-list"})
        cfg = MCPServerConfig.from_dict("x", {"command": "python3", "args": ["-u"]})
        self.assertEqual(cfg.command, "python3")

    def test_load_mcp_servers_skips_bad(self):
        servers = load_mcp_servers(
            {
                "mcp_servers": {"good": {"command": "python3"}, "bad": {"args": []}},
                "mcp_presets": [],
            }
        )
        self.assertEqual(list(servers), ["good"])

    def test_client_list_and_call(self):
        client = MCPClient(self._config(), timeout=10.0)
        self.clients.append(client)
        client.start()
        tools = client.list_tools()
        self.assertEqual([t["name"] for t in tools], ["echo"])
        out = client.call_tool("echo", {"text": "你好"})
        self.assertEqual(out, "回显：你好")

    def test_manager_start_execute_unknown(self):
        manager = MCPToolManager({"fake": self._config()}, timeout=10.0)
        try:
            manager.start_all()
            self.assertTrue(manager.has_tools())
            names = [s["function"]["name"] for s in manager.tool_schemas]
            self.assertEqual(names, ["mcp_fake_echo"])
            out = manager.execute("mcp_fake_echo", {"text": "abc"})
            self.assertEqual(out, "回显：abc")
            self.assertIn("未知 MCP 工具", manager.execute("mcp_fake_nope", {}))
        finally:
            manager.stop_all()
            self.assertFalse(manager.has_tools())

    def test_bad_server_fails_gracefully(self):
        manager = MCPToolManager(
            {"bad": MCPServerConfig(name="bad", command="/nonexistent/binary-xyz")},
            timeout=5.0,
        )
        manager.start_all()
        self.assertFalse(manager.has_tools())
        manager.stop_all()


class SchedulerTest(unittest.TestCase):
    def _task(self, **overrides):
        task = {
            "name": "t1",
            "prompt": "做点事",
            "provider": None,
            "profile": None,
            "model": None,
            "mode": "auto",
            "every_seconds": 3600,
            "at": None,
            "enabled": True,
            "last_run": None,
            "last_status": None,
            "last_summary": None,
        }
        task.update(overrides)
        return task

    def test_validate_rejects_bad_tasks(self):
        from nyra.scheduler import _validate_task

        for bad in (
            {},
            {"name": "", "prompt": "x"},
            {"name": "a"},
            {"name": "a", "prompt": "x"},
            {"name": "a", "prompt": "x", "every_seconds": 0},
            {"name": "a", "prompt": "x", "at": "25:00"},
            {"name": "a", "prompt": "x", "every_seconds": 10, "mode": "bad"},
            {"name": "a", "prompt": "x", "every_seconds": 10, "mode": "full"},
        ):
            with self.assertRaises(ScheduleError, msg=str(bad)):
                _validate_task(bad)

    def test_add_remove_list(self):
        data = {"tasks": []}
        add_task(data, self._task())
        self.assertEqual([t["name"] for t in list_tasks(data)], ["t1"])
        with self.assertRaises(ScheduleError):
            add_task(data, self._task())
        self.assertTrue(remove_task(data, "t1"))
        self.assertFalse(remove_task(data, "t1"))

    def test_is_due_interval(self):
        now = datetime(2026, 11, 16, 10, 0, 0)
        self.assertTrue(is_due(self._task(), now))
        self.assertTrue(
            is_due(self._task(last_run="2026-11-16T08:00:00"), now)
        )
        self.assertFalse(
            is_due(self._task(last_run="2026-11-16T09:30:00"), now)
        )
        self.assertFalse(is_due(self._task(enabled=False), now))
        self.assertTrue(is_due(self._task(last_run="not-a-date"), now))

    def test_is_due_daily_at(self):
        now = datetime(2026, 11, 16, 9, 0, 0)
        base = self._task(every_seconds=None, at="08:30")
        self.assertTrue(is_due(base, now))
        self.assertFalse(
            is_due(self._task(every_seconds=None, at="08:30", last_run="2026-11-16T08:35:00"), now)
        )
        self.assertFalse(
            is_due(self._task(every_seconds=None, at="10:30"), now)
        )
        self.assertTrue(
            is_due(self._task(every_seconds=None, at="08:30", last_run="2026-11-15T08:35:00"), now)
        )

    def test_run_due_tasks_ok_and_error(self):
        now = datetime(2026, 11, 16, 10, 0, 0)
        data = {"tasks": [self._task(name="ok"), self._task(name="bad")]}

        def factory(task):
            if task["name"] == "bad":
                raise RuntimeError("炸了")
            return "完成：" + task["name"]

        results = run_due_tasks(data, factory, now=now)
        self.assertEqual(
            [(r["name"], r["status"]) for r in results],
            [("ok", "ok"), ("bad", "error")],
        )
        self.assertEqual(data["tasks"][0]["last_status"], "ok")
        self.assertIn("炸了", data["tasks"][1]["last_summary"])
        self.assertEqual(data["tasks"][0]["last_run"], now.isoformat())

    def test_save_load_roundtrip_and_daemon(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "schedule.json"
            data = {"tasks": [self._task()]}
            save_schedule(data, path)
            loaded = load_schedule(path)
            self.assertEqual(loaded["tasks"][0]["name"], "t1")
            calls = []
            rounds = run_daemon(
                lambda task: calls.append(task["name"]) or "done",
                # run_daemon 要求 interval 为正数（0 会 busy-loop）；用 0.01
                # 仍能无等待跑完两轮。
                interval=0.01,
                path=path,
                stop_after=2,
            )
            self.assertEqual(rounds, 2)
            self.assertEqual(calls, ["t1"])


class CompactTest(unittest.TestCase):
    def _msgs(self, n=6):
        msgs = []
        for i in range(n):
            role = "user" if i % 2 == 0 else "assistant"
            msgs.append({"role": role, "content": f"消息 {i}"})
        return msgs

    def test_build_compact_messages(self):
        msgs = self._msgs(6)
        out = build_compact_messages(msgs, "摘要内容", keep_last=2)
        self.assertEqual(out[0]["content"], "[此前会话摘要]\n摘要内容")
        self.assertEqual(out[1]["content"], "已压缩会话，继续。")
        self.assertEqual(out[2:], msgs[-2:])
        self.assertEqual(len(msgs), 6)

    def test_compact_messages_model_path(self):
        provider = FakeProvider([assistant_message("要点：A 已定；B 待办。")])
        new_msgs, info = compact_messages(provider, self._msgs(6), keep_last=2)
        self.assertEqual(info["method"], "model")
        self.assertEqual(info["before"], 6)
        self.assertEqual(info["after"], 4)
        self.assertIn("要点：A 已定", new_msgs[0]["content"])
        self.assertEqual(provider.calls, 1)

    def test_compact_messages_fallback(self):
        class FailingProvider:
            def chat(self, messages, tools=None, timeout=120):
                raise RuntimeError("模型挂了")

        new_msgs, info = compact_messages(FailingProvider(), self._msgs(6), keep_last=2)
        self.assertEqual(info["method"], "fallback")
        self.assertIn("压缩失败", new_msgs[0]["content"])
        self.assertEqual(new_msgs[1], {"role": "user", "content": "消息 0"})
        self.assertEqual(new_msgs[-2:], self._msgs(6)[-2:])

    def test_compact_messages_empty(self):
        new_msgs, info = compact_messages(FakeProvider([]), [], keep_last=4)
        self.assertEqual((new_msgs, info["method"]), ([], "none"))

    def test_compact_session_file(self):
        with tempfile.TemporaryDirectory() as d:
            sid = "test-compact-001"
            path = Path(d) / f"{sid}.jsonl"
            msgs = self._msgs(6)
            path.write_text(
                "\n".join(json.dumps(m, ensure_ascii=False) for m in msgs),
                encoding="utf-8",
            )
            info = compact_session_file(
                sid,
                FakeProvider([assistant_message("摘要：全部完成。")]),
                sessions_dir=Path(d),
            )
            self.assertEqual(info["method"], "model")
            self.assertEqual(info["session_id"], sid)
            lines = path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 6)
            self.assertIn("摘要：全部完成", lines[0])


class ProfilesTest(unittest.TestCase):
    def _config(self):
        return {
            "provider": "deepseek",
            "model": "deepseek-flash",
            "mode": "auto",
            "profiles": {
                "strong": {
                    "provider": "deepseek",
                    "model": "deepseek-v4-pro",
                    "mode": "full",
                },
                "cheap": {"model": "deepseek-flash"},
            },
        }

    def test_resolve_profile_defaults(self):
        prof = resolve_profile(None, self._config())
        self.assertEqual(prof["provider"], "deepseek")
        self.assertEqual(prof["model"], "deepseek-flash")
        self.assertEqual(prof["mode"], "auto")

    def test_resolve_profile_named(self):
        prof = resolve_profile("strong", self._config())
        self.assertEqual(prof, {"provider": "deepseek", "model": "deepseek-v4-pro", "mode": "full"})
        cheap = resolve_profile("cheap", self._config())
        self.assertEqual(cheap["provider"], "deepseek")
        self.assertEqual(cheap["mode"], "auto")

    def test_resolve_profile_unknown(self):
        with self.assertRaises(ValueError):
            resolve_profile("nope", self._config())

    def test_list_profiles(self):
        self.assertEqual(list_profiles(self._config()), ["cheap", "strong"])


class EvidenceTest(unittest.TestCase):
    def test_store_saves_and_lists(self):
        with tempfile.TemporaryDirectory() as d:
            store = EvidenceStore(Path(d), "sess-1")
            p1 = store.save("web_fetch", "https://example.com/a", "内容 A")
            p2 = store.save("web_search", "https://bing.com/search?q=x", "内容 B", query="x")
            self.assertTrue(p1.exists())
            self.assertTrue(p2.exists())
            self.assertIn("https://example.com/a", p1.read_text(encoding="utf-8"))
            self.assertIn("搜索词：x", p2.read_text(encoding="utf-8"))
            self.assertEqual(store.list(), [p1, p2])

    def test_web_fetch_saves_evidence(self):
        server, port = _start_local_server()
        try:
            with tempfile.TemporaryDirectory() as d:
                store = EvidenceStore(Path(d), "sess-2")
                ctx = ToolContext(
                    workdir=Path(d),
                    mode="full",
                    interactive=False,
                    memory_path=NYRA_HOME / "MEMORY.md",
                    skills_dir=NYRA_HOME / "skills",
                    evidence=store,
                )
                out = execute_tool(
                    "web_fetch", {"url": f"http://127.0.0.1:{port}/"}, ctx
                )
                self.assertIn("证据已保存", out)
                self.assertIn("证据链", out)
                self.assertEqual(len(store.list()), 1)
        finally:
            server.shutdown()
            server.server_close()


def _start_local_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _EchoHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, server.server_address[1]


class NewToolsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server, cls.port = _start_local_server()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.ctx = ToolContext(
            workdir=self.tmp,
            mode="full",
            interactive=False,
            memory_path=NYRA_HOME / "MEMORY.md",
            skills_dir=NYRA_HOME / "skills",
        )

    def test_grep_search_plain_and_regex(self):
        (self.tmp / "a.txt").write_text("hello world\nfoo bar\n", encoding="utf-8")
        sub = self.tmp / "sub"
        sub.mkdir()
        (sub / "b.txt").write_text("HELLO again\n", encoding="utf-8")
        out = execute_tool("grep_search", {"pattern": "hello", "path": "."}, self.ctx)
        self.assertIn("a.txt:1: hello world", out)
        self.assertIn("b.txt:1: HELLO again", out)
        out = execute_tool(
            "grep_search",
            {"pattern": "hello", "path": ".", "case_sensitive": True},
            self.ctx,
        )
        self.assertIn("a.txt", out)
        self.assertNotIn("b.txt", out)
        out = execute_tool(
            "grep_search",
            {"pattern": "h.llo", "path": ".", "regex": True},
            self.ctx,
        )
        self.assertIn("a.txt:1", out)
        self.assertIn("未找到匹配内容", execute_tool("grep_search", {"pattern": "zzz"}, self.ctx))
        self.assertIn("正则表达式无效", execute_tool("grep_search", {"pattern": "[bad", "regex": True}, self.ctx))

    def test_git_status_not_a_repo(self):
        out = execute_tool("git_status", {"path": "."}, self.ctx)
        self.assertIn("不是 git 仓库", out)

    def test_git_status_real_repo(self):
        if shutil.which("git") is None:
            self.skipTest("本机无 git")
        subprocess.run(["git", "init", "-q"], cwd=self.tmp, check=True)
        subprocess.run(["git", "config", "user.email", "t@t.t"], cwd=self.tmp, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=self.tmp, check=True)
        (self.tmp / "f.txt").write_text("hi\n", encoding="utf-8")
        out = execute_tool("git_status", {"path": "."}, self.ctx)
        self.assertIn("f.txt", out)

    def test_http_post_echo(self):
        out = execute_tool(
            "http_post",
            {"url": f"http://127.0.0.1:{self.port}/submit", "body": '{"a": 1}'},
            self.ctx,
        )
        self.assertIn("HTTP 200", out)
        self.assertIn('{"a": 1}', out)

    def test_http_post_blocked_readonly(self):
        ro = ToolContext(
            workdir=self.tmp, mode="readonly", interactive=False,
            memory_path=NYRA_HOME / "MEMORY.md", skills_dir=NYRA_HOME / "skills",
        )
        out = execute_tool(
            "http_post", {"url": f"http://127.0.0.1:{self.port}/x", "body": "{}"}, ro
        )
        self.assertIn("只读模式", out)


class WebSearchParserTest(unittest.TestCase):
    def test_parse_bing_html(self):
        html_doc = (
            '<li class="b_algo"><h2><a href="https://example.com/a">标题一</a></h2>'
            '<p>摘要一</p></li>'
            '<li class="b_algo"><h2><a href="https://example.com/b">标题二</a></h2>'
            '<p>摘要二</p></li>'
        )
        results = _parse_bing_html(html_doc, 8)
        self.assertEqual(len(results), 2)
        self.assertIn("标题一", results[0])
        self.assertIn("https://example.com/a", results[0])
        self.assertIn("摘要二", results[1])

    def test_parse_bing_captcha(self):
        from nyra.tools import ToolError

        with self.assertRaises(ToolError):
            _parse_bing_html("<html>captcha challenge</html>", 8)

    def test_parse_baidu_html(self):
        html_doc = (
            '<div class="result c-container"><h3 class="t">'
            '<a href="https://example.com/a">标题一</a></h3>'
            '<div class="c-abstract">摘要一</div></div>'
            '<div class="result c-container"><h3 class="t">'
            '<a href="https://example.com/b">标题二</a></h3>'
            '<div class="c-abstract">摘要二</div></div>'
        )
        results = _parse_baidu_html(html_doc, 8)
        self.assertEqual(len(results), 2)
        self.assertIn("标题一", results[0])
        self.assertIn("摘要二", results[1])

    def test_parse_baidu_blocked(self):
        from nyra.tools import ToolError

        with self.assertRaises(ToolError):
            _parse_baidu_html("<html>百度安全验证</html>", 8)

    def test_search_all_backends_fail_reports_clearly(self):
        ctx = ToolContext(
            workdir=Path(tempfile.mkdtemp()),
            mode="full",
            interactive=False,
            memory_path=NYRA_HOME / "MEMORY.md",
            skills_dir=NYRA_HOME / "skills",
        )
        original = tools_module._fetch_search_page

        def _boom(url):
            raise OSError("网络不通")

        tools_module._fetch_search_page = _boom
        try:
            out = execute_tool("web_search", {"query": "测试"}, ctx)
        finally:
            tools_module._fetch_search_page = original
        self.assertIn("错误：搜索失败", out)
        self.assertIn("Bing", out)
        self.assertIn("百度", out)
        self.assertNotIn("标题", out)


class FakeBackend:
    """In-memory execution backend: proves tools route through it, not local."""

    name = "fake"

    def __init__(self):
        self.files = {}
        self.commands = []

    def run_command(self, command, cwd=None, timeout=60):
        self.commands.append(command)
        return "fake-output"

    def read_file(self, path):
        if path not in self.files:
            return f"错误：文件不存在：{path}"
        return self.files[path]

    def write_file(self, path, content):
        self.files[path] = content
        return f"已写入 {path}（{len(content)} 字符）"

    def list_dir(self, path):
        names = sorted(
            p[len(path):].lstrip("/") for p in self.files if p.startswith(path + "/")
        )
        return "\n".join(names) or "（空目录）"

    def close(self):
        pass


class SandboxBackendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.backend = FakeBackend()
        self.ctx = ToolContext(
            workdir=Path("/home/user"),
            mode="full",
            interactive=False,
            memory_path=NYRA_HOME / "MEMORY.md",
            skills_dir=NYRA_HOME / "skills",
            backend=self.backend,
        )

    def test_backend_routes_file_ops(self):
        out = execute_tool("write_file", {"path": "hello.txt", "content": "你好"}, self.ctx)
        self.assertIn("已写入", out)
        self.assertEqual(self.backend.files["/home/user/hello.txt"], "你好")
        self.assertEqual(execute_tool("read_file", {"path": "hello.txt"}, self.ctx), "你好")
        self.assertIn("已写入", execute_tool("edit_file", {"path": "hello.txt", "old_text": "你好", "new_text": "你好，Nyra"}, self.ctx))
        self.assertEqual(self.backend.files["/home/user/hello.txt"], "你好，Nyra")
        self.assertIn("hello.txt", execute_tool("list_dir", {"path": "/home/user"}, self.ctx))
        # Nothing touched the local filesystem.
        self.assertEqual(list(self.tmp.iterdir()), [])
        self.assertIn("文件不存在", execute_tool("read_file", {"path": "nope.txt"}, self.ctx))

    def test_backend_routes_shell_and_denylist(self):
        out = execute_tool("shell", {"command": "echo 42"}, self.ctx)
        self.assertEqual(out, "fake-output")
        self.assertEqual(self.backend.commands, ["echo 42"])
        # The denylist still applies before anything reaches the backend.
        blocked = execute_tool("shell", {"command": "rm -rf /"}, self.ctx)
        self.assertTrue(blocked.startswith("错误："))
        self.assertEqual(len(self.backend.commands), 1)

    def test_backend_routes_plan(self):
        out = execute_tool("plan", {"title": "计划", "steps": ["一步", "二步"]}, self.ctx)
        self.assertIn("已写入计划", out)
        self.assertIn("# 计划", self.backend.files["/home/user/plan.md"])

    def test_backend_grep_and_git_status(self):
        self.backend.files["/home/user/a.txt"] = "hello world\n"
        out = execute_tool("grep_search", {"pattern": "hello", "path": "/home/user"}, self.ctx)
        self.assertEqual(out, "fake-output")
        self.assertTrue(any("grep" in c and "hello" in c for c in self.backend.commands))
        out = execute_tool("git_status", {"path": "/home/user"}, self.ctx)
        self.assertIn("fake-output", out)
        self.assertIn("改动统计", out)
        self.assertTrue(any("git" in c for c in self.backend.commands))

    def test_backend_readonly_still_blocks(self):
        ro = ToolContext(
            workdir=Path("/home/user"), mode="readonly", interactive=False,
            memory_path=NYRA_HOME / "MEMORY.md",
            skills_dir=NYRA_HOME / "skills",
            backend=self.backend,
        )
        out = execute_tool("write_file", {"path": "x.txt", "content": "x"}, ro)
        self.assertIn("只读模式", out)
        self.assertNotIn("/home/user/x.txt", self.backend.files)

    def test_e2b_backend_missing_sdk(self):
        from nyra.e2b_backend import E2BBackend, E2BError

        with unittest.mock.patch.dict(sys.modules, {"e2b": None}):
            with self.assertRaises(E2BError) as ctx:
                E2BBackend().connect()
        self.assertIn("pip install e2b", str(ctx.exception))

    def test_resolve_e2b_api_key_prefers_env(self):
        from nyra.e2b_backend import resolve_e2b_api_key

        with unittest.mock.patch.dict(os.environ, {"E2B_API_KEY": "env-key-123"}):
            self.assertEqual(resolve_e2b_api_key(), "env-key-123")

    def test_resolve_sandbox_defaults_env_and_invalid(self):
        from nyra.config import resolve_sandbox

        base = {"sandbox": "local", "e2b_template": "base", "e2b_timeout": 3600, "e2b_sandbox_id": None}
        settings = resolve_sandbox(config=base)
        self.assertEqual(settings.backend, "local")
        self.assertEqual(settings.template, "base")
        self.assertEqual(settings.timeout, 3600)
        with unittest.mock.patch.dict(os.environ, {"ANGEL_SANDBOX": "e2b", "ANGEL_E2B_SANDBOX_ID": "sbx-1"}):
            settings = resolve_sandbox(config=base)
        self.assertEqual(settings.backend, "e2b")
        self.assertEqual(settings.sandbox_id, "sbx-1")
        settings = resolve_sandbox(config=base, backend="local")
        self.assertEqual(settings.backend, "local")
        with self.assertRaises(ValueError):
            resolve_sandbox(config=base, backend="nope")

    def test_agent_delegate_keeps_backend(self):
        provider = FakeProvider(
            [
                assistant_message(
                    calls=[tool_call("c1", "delegate", {"task": "写个文件", "max_turns": 3})]
                ),
                assistant_message("子任务写完了。"),
            ]
        )
        provider.responses.insert(
            1,
            assistant_message(
                calls=[tool_call("c2", "write_file", {"path": "child.txt", "content": "子任务文件"})]
            ),
        )
        provider.responses.insert(2, assistant_message("已写好。"))
        agent = Agent(
            provider=provider,
            workdir=Path("/home/user"),
            mode="full",
            max_turns=5,
            interactive=False,
            backend=self.backend,
        )
        result = agent.run("让子 agent 写个文件")
        self.assertIn("子任务写完了", result)
        self.assertEqual(self.backend.files["/home/user/child.txt"], "子任务文件")
        self.assertEqual(list(self.tmp.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
