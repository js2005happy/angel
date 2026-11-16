"""Angel 的最小 MCP（Model Context Protocol）客户端。

通过 stdio（子进程 stdin/stdout）用 JSON-RPC 2.0 与 MCP 服务器通信，
把 MCP 服务器提供的工具变成 Angel 可调用的工具。
配置来自 ~/.angel/config.json 的 "mcp_servers" 一节，格式与 Claude Code 的
mcpServers 一致：{"name": {"command": "...", "args": [...], "env": {...}}}。
"""

from __future__ import annotations

import json
import os
import re
import queue
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field


class MCPError(Exception):
    pass


# MCP servers run outside the agent's tool approval boundary while starting.
# Avoid exposing unrelated provider credentials or tokens via os.environ.
# These are ordinary process bootstrap variables, not an execution sandbox.
MCP_BOOTSTRAP_ENV = (
    "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
    "VIRTUAL_ENV",
)
ENV_NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


@dataclass
class MCPServerConfig:
    name: str
    command: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    inherit_env: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, name: str, raw: dict) -> "MCPServerConfig":
        if not isinstance(raw, dict):
            raise MCPError("服务器配置必须是字典")

        command = raw.get("command")
        if not isinstance(command, str) or not command.strip():
            raise MCPError("command 必须是非空字符串")

        args = raw.get("args", [])
        if not isinstance(args, list):
            raise MCPError("args 必须是列表")
        if any(not isinstance(arg, str) for arg in args):
            raise MCPError("args 中的每一项必须是字符串")

        env = raw.get("env", {})
        if not isinstance(env, dict):
            raise MCPError("env 必须是字典")
        if any(
            not isinstance(key, str) or not isinstance(value, str)
            for key, value in env.items()
        ):
            raise MCPError("env 的键和值必须是字符串")
        if any(not ENV_NAME_PATTERN.fullmatch(key) for key in env):
            raise MCPError("env 包含非法的环境变量名称")

        inherit_env = raw.get("inherit_env", [])
        if not isinstance(inherit_env, list) or any(
            not isinstance(key, str) or not ENV_NAME_PATTERN.fullmatch(key)
            for key in inherit_env
        ):
            raise MCPError("inherit_env 必须是合法环境变量名称列表")

        return cls(
            name=name, command=command, args=list(args),
            env=dict(env), inherit_env=list(inherit_env),
        )


class MCPClient:
    def __init__(self, config: MCPServerConfig, timeout: float = 30.0):
        self.config = config
        self.timeout = timeout
        self.process = None
        self.next_id = 1
        self.tools: list[dict] = []
        self._lines: queue.Queue[tuple[str, str]] = queue.Queue()
        self._reader: threading.Thread | None = None

    def _subprocess_env(self) -> dict[str, str]:
        """Pass only bootstrap values and explicitly requested variables.

        This limits accidental credential forwarding. It does not sandbox
        an untrusted MCP executable or prevent access to local user files.
        """
        names = set(MCP_BOOTSTRAP_ENV) | set(self.config.inherit_env)
        env = {key: os.environ[key] for key in names if key in os.environ}
        env.update(self.config.env)
        # Keep stdio JSON-RPC valid on Windows even with legacy code pages.
        env.setdefault("PYTHONIOENCODING", "utf-8")
        return env

    def start(self) -> None:
        if self.process is not None:
            raise MCPError("MCP 客户端已经启动，请先停止")

        self.tools = []
        self._lines = queue.Queue()
        self._reader = None
        step = "启动进程"
        try:
            env = self._subprocess_env()
            self.process = subprocess.Popen(
                [self.config.command] + self.config.args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
            )
            # Windows select() only accepts sockets, not subprocess pipes.
            # A background reader gives stdio the same timeout semantics on
            # Windows, Linux and macOS without blocking the main agent loop.
            self._reader = threading.Thread(
                target=self._pump_stdout,
                args=(self.process.stdout, self._lines),
                daemon=True,
            )
            self._reader.start()
            step = "初始化"
            self.initialize()
            step = "获取工具列表"
            self.list_tools()
        except Exception as exc:
            cleanup_error = None
            try:
                self.stop()
            except Exception as stop_exc:
                cleanup_error = stop_exc

            message = f"MCP 服务器 {self.config.name} {step}失败：{exc}"
            if cleanup_error is not None:
                message += f"；清理进程失败：{cleanup_error}"
            raise MCPError(message) from exc

    def _write_message(self, message: dict) -> None:
        process = self.process
        if process is None or process.stdin is None:
            raise MCPError("MCP 服务器尚未启动")
        if process.poll() is not None:
            raise MCPError("MCP 服务器已退出")

        try:
            payload = json.dumps(message, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise MCPError(f"MCP 请求 JSON 编码失败：{exc}") from exc

        try:
            process.stdin.write(payload + "\n")
            process.stdin.flush()
        except (OSError, ValueError) as exc:
            raise MCPError(f"写入 MCP 服务器失败：{exc}") from exc

    @staticmethod
    def _pump_stdout(stdout, lines: queue.Queue[tuple[str, str]]) -> None:
        """Read blocking text pipes off-thread (select cannot watch pipes on Windows)."""
        try:
            for line in stdout:
                lines.put(("line", line.strip()))
        except (OSError, ValueError) as exc:
            lines.put(("error", str(exc)))
        finally:
            lines.put(("eof", ""))

    def _read_line(self, deadline: float) -> str:
        if self.process is None or self.process.stdout is None:
            raise MCPError("MCP 服务器尚未启动")

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise MCPError("MCP 服务器响应超时")
        try:
            kind, value = self._lines.get(timeout=remaining)
        except queue.Empty as exc:
            raise MCPError("MCP 服务器响应超时") from exc

        if kind == "error":
            raise MCPError(f"读取 MCP 服务器响应失败：{value}")
        if kind == "eof":
            raise MCPError("MCP 服务器已退出")
        if not value:
            raise MCPError("MCP 服务器返回空行")
        return value

    def _send_request(self, method: str, params: dict | None = None) -> dict:
        request_id = self.next_id
        self.next_id += 1
        self._write_message(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params or {},
            }
        )

        deadline = time.monotonic() + self.timeout
        while True:
            line = self._read_line(deadline)
            try:
                response = json.loads(line)
            except (ValueError, RecursionError) as exc:
                raise MCPError(f"MCP 响应 JSON 解析失败：{exc}") from exc

            if not isinstance(response, dict):
                raise MCPError("MCP 响应格式无效：必须是 JSON 对象")
            if response.get("jsonrpc") != "2.0":
                raise MCPError("MCP 响应格式无效：jsonrpc 必须是 2.0")

            if "method" in response:
                if "id" not in response:
                    # 服务器通知不属于当前请求的响应。
                    continue
                # 最小客户端不支持服务器主动发起的请求。
                self._write_message(
                    {
                        "jsonrpc": "2.0",
                        "id": response["id"],
                        "error": {
                            "code": -32601,
                            "message": "Angel 不支持服务器主动请求的方法",
                        },
                    }
                )
                continue

            if response.get("id") != request_id:
                raise MCPError("MCP 响应格式无效：请求 id 不匹配")

            if "error" in response:
                error = response["error"]
                message = (
                    error.get("message", "服务器未提供错误说明")
                    if isinstance(error, dict)
                    else "服务器返回了无效的错误对象"
                )
                raise MCPError(f"MCP 错误：{message}")

            if "result" not in response:
                raise MCPError("MCP 响应格式无效：缺少 result")
            result = response["result"]
            if not isinstance(result, dict):
                raise MCPError("MCP 响应格式无效：result 必须是字典")
            return result

    def _send_notification(
        self, method: str, params: dict | None = None
    ) -> None:
        self._write_message(
            {
                "jsonrpc": "2.0",
                "method": method,
                "params": params or {},
            }
        )

    def initialize(self) -> None:
        self._send_request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "Angel", "version": "0.2.0"},
            },
        )
        self._send_notification("notifications/initialized")

    def list_tools(self) -> list[dict]:
        result = self._send_request("tools/list")
        raw_tools = result.get("tools")
        if not isinstance(raw_tools, list):
            raise MCPError("MCP 工具列表格式无效：tools 必须是列表")

        tools = []
        for tool in raw_tools:
            if not isinstance(tool, dict):
                raise MCPError("MCP 工具格式无效：工具必须是字典")
            name = tool.get("name")
            if not isinstance(name, str) or not name:
                raise MCPError("MCP 工具格式无效：name 必须是非空字符串")
            tools.append(
                {
                    "name": name,
                    "description": tool.get("description", ""),
                    "inputSchema": tool.get(
                        "inputSchema",
                        {"type": "object", "properties": {}},
                    ),
                }
            )

        self.tools = tools
        return self.tools

    def call_tool(self, name: str, arguments: dict) -> str:
        result = self._send_request(
            "tools/call", {"name": name, "arguments": arguments}
        )
        content = result.get("content", [])
        if not isinstance(content, list):
            raise MCPError("MCP 工具响应格式无效：content 必须是列表")

        texts = []
        for item in content:
            if not isinstance(item, dict):
                raise MCPError("MCP 工具响应格式无效：内容项必须是字典")
            if item.get("type") == "text":
                text = item.get("text")
                if not isinstance(text, str):
                    raise MCPError("MCP 工具响应格式无效：text 必须是字符串")
                texts.append(text)

        output = (
            "\n".join(texts)
            if texts
            else json.dumps(result, ensure_ascii=False)
        )
        if result.get("isError"):
            output = "MCP 工具返回错误：\n" + output
        return output

    def stop(self) -> None:
        process = self.process
        if process is None:
            return

        try:
            if process.poll() is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=2)
        except (OSError, subprocess.SubprocessError) as exc:
            raise MCPError(f"停止 MCP 服务器失败：{exc}") from exc
        finally:
            self.process = None
            self.tools = []
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError as exc:
                        print(f"关闭 MCP 进程管道失败：{exc}", file=sys.stderr)
            if self._reader is not None:
                self._reader.join(timeout=0.2)
            self._reader = None
            self._lines = queue.Queue()

    def __enter__(self) -> "MCPClient":
        self.start()
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.stop()


def load_mcp_servers(config: dict) -> dict[str, MCPServerConfig]:
    raw_servers = config.get("mcp_servers", {})
    if not isinstance(raw_servers, dict):
        return {}

    servers = {}
    for name, raw in raw_servers.items():
        try:
            servers[name] = MCPServerConfig.from_dict(name, raw)
        except MCPError as exc:
            print(
                f"跳过无效 MCP 服务器配置 {name}: {exc}",
                file=sys.stderr,
            )
    return servers


class MCPToolManager:
    def __init__(
        self, servers: dict[str, MCPServerConfig], timeout: float = 30.0
    ):
        self.servers = dict(servers)
        self.timeout = timeout
        self.clients: dict[str, MCPClient] = {}
        self.tool_schemas: list[dict] = []
        self._tool_routes: dict[str, tuple[str, str]] = {}

    @staticmethod
    def _sanitize(name: str) -> str:
        return re.sub(r"[^a-zA-Z0-9_]", "_", name)

    def start_all(self) -> None:
        for server_name, config in self.servers.items():
            if server_name in self.clients:
                continue

            client = MCPClient(config, timeout=self.timeout)
            try:
                client.start()
                tools = client.list_tools()
                schemas = []
                routes = {}

                for tool in tools:
                    tool_name = (
                        f"mcp_{self._sanitize(server_name)}_"
                        f"{self._sanitize(tool['name'])}"
                    )
                    if tool_name in self._tool_routes or tool_name in routes:
                        raise MCPError(f"工具名称规范化后发生冲突：{tool_name}")

                    parameters = tool.get("inputSchema")
                    if not isinstance(parameters, dict):
                        parameters = {"type": "object", "properties": {}}

                    schemas.append(
                        {
                            "type": "function",
                            "function": {
                                "name": tool_name,
                                "description": (
                                    f"[{server_name}] "
                                    f"{tool.get('description', '')}"
                                ),
                                "parameters": parameters,
                            },
                        }
                    )
                    routes[tool_name] = (server_name, tool["name"])

            except Exception as exc:
                try:
                    client.stop()
                except Exception as stop_exc:
                    print(
                        f"MCP 服务器 {server_name} 清理失败：{stop_exc}",
                        file=sys.stderr,
                    )
                print(
                    f"MCP 服务器 {server_name} 启动失败：{exc}",
                    file=sys.stderr,
                )
                continue

            self.clients[server_name] = client
            self.tool_schemas.extend(schemas)
            self._tool_routes.update(routes)

    def execute(self, tool_name: str, arguments: dict) -> str:
        # 按最长前缀检查，并用映射保留被规范化前的原始工具名。
        server_names = sorted(
            self.clients,
            key=lambda name: len(self._sanitize(name)),
            reverse=True,
        )
        route = self._tool_routes.get(tool_name)
        for server_name in server_names:
            prefix = f"mcp_{self._sanitize(server_name)}_"
            if not tool_name.startswith(prefix):
                continue
            if route is None or route[0] != server_name:
                continue
            try:
                return self.clients[server_name].call_tool(route[1], arguments)
            except Exception as exc:
                return f"MCP 调用失败：{exc}"
        return f"错误：未知 MCP 工具 {tool_name}"

    def has_tools(self) -> bool:
        return bool(self.tool_schemas)

    def stop_all(self) -> None:
        errors = []
        for name, client in list(self.clients.items()):
            try:
                client.stop()
            except Exception as exc:
                errors.append(f"{name}：{exc}")

        self.clients.clear()
        self.tool_schemas.clear()
        self._tool_routes.clear()
        if errors:
            raise MCPError("停止 MCP 服务器失败：" + "；".join(errors))
