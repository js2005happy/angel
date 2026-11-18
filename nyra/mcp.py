"""Nyra 的最小 MCP（Model Context Protocol）客户端。

通过 stdio（子进程 stdin/stdout）用 JSON-RPC 2.0 与 MCP 服务器通信，
把 MCP 服务器提供的工具变成 Nyra 可调用的工具。
配置来自 ~/.nyra/config.json 的 "mcp_servers" 一节，格式与 Claude Code 的
mcpServers 一致：{"name": {"command": "...", "args": [...], "env": {...}}}。
内置预置见 nyra/mcp_presets.py，由 "mcp_presets" 列表启用（默认
memory、sequential-thinking、fetch、time），需要密钥/路径的预置按名
启用，用户在 mcp_servers 里写的同名条目会覆盖预置。

协议版本（MCP 规范 https://modelcontextprotocol.io/specification/）：
双时代客户端——优先现代版 ``2026-07-28``（无状态无握手，每次请求在
``_meta`` 里自带协议版本与客户端能力，先用 ``server/discover`` 探测），
探测失败（非现代错误或超时）时回退旧版握手（``initialize``，最新握手版
``2025-11-25``）。不支持多轮往返（MRTR）：服务器要求补充输入时直接
报错，不做交互式追问。HTTP 传输不在本客户端范围，只做 stdio。
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
import urllib.parse
from dataclasses import dataclass, field


class MCPError(Exception):
    pass


class MCPRequestError(MCPError):
    """服务器返回的 JSON-RPC 错误，保留错误码与 data 供协商逻辑判断。"""

    def __init__(self, message: str, code: int | None = None, data=None):
        super().__init__(message)
        self.code = code
        self.data = data


try:
    from nyra import __version__ as CLIENT_VERSION
except ImportError:  # 直接以脚本方式运行时退回包内版本号
    CLIENT_VERSION = "0.3.0"


# MCP 协议版本（规范 https://modelcontextprotocol.io/specification/）。
# 现代版（2026-07-28 及以后）：无状态，每次请求在 _meta 里自带版本与能力。
# 旧版（2025-11-25 及以前）：initialize 握手建会话。
LATEST_PROTOCOL_VERSION = "2026-07-28"
MODERN_PROTOCOL_VERSIONS = ("2026-07-28",)
LEGACY_HANDSHAKE_VERSION = "2025-11-25"
LEGACY_PROTOCOL_VERSIONS = (
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
)
UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022

# _meta 保留键（规范基本/生命周期一节）。
META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"
META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo"
META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

# 发现探测最多等这么久：沉默的旧版服务器不会回 server/discover，
# 超时即按旧版处理，不必等满整个请求超时。
# 发现探测只等这么久：服务器可能要现装依赖（npx/uvx 首次下载常需
# 几十秒），探测超时后会回退旧版握手；探测等太短会把还没启动好的
# 服务器误判为旧版。60 秒覆盖常规首次下载，仍有上限；客户端超时
# 更短时取两者中更小的值。
PROBE_TIMEOUT = 60.0


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


# 代理与受信 CA 是网络引导配置，不是凭据：npx/uvx 首次下载、
# 以及 MCP 服务器自身的联网都要走代理；出口代理做 TLS 拦截时
# 工具要靠这些 CA 变量认它的自签 CA 才连得上。只在父环境里有
# 才传；代理 URL 里嵌的 userinfo（user:pass@host）去掉再传——
# 本机代理允许无认证访问，而把代理密码交给第三方 MCP 服务器
# 进程不值得。代理必须认证的，请用户在该服务器的 inherit_env
# 里显式声明完整 URL。
_PROXY_ENV_VARS = (
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
    "NODE_USE_ENV_PROXY",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO", "AWS_CA_BUNDLE",
)


def _strip_proxy_credentials(value: str) -> str:
    """去掉代理 URL 里的 userinfo；非 URL 的值（如 NO_PROXY 列表）原样返回。"""
    if "://" not in value:
        return value
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return value
    if "@" not in parts.netloc:
        return value
    host = parts.netloc.rsplit("@", 1)[1]
    return urllib.parse.urlunsplit(
        (parts.scheme, host, parts.path, parts.query, parts.fragment)
    )


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
        # 协商结果：era 为 "modern" 或 "legacy"，negotiated_version 为
        # 实际用的协议版本；_stale_ids 记已放弃请求的 id，迟到响应按此丢弃。
        self.negotiated_version: str | None = None
        self.era: str | None = None
        self.server_info: dict | None = None
        self._stale_ids: set = set()

    def _subprocess_env(self) -> dict[str, str]:
        """Pass only bootstrap values and explicitly requested variables.

        This limits accidental credential forwarding. It does not sandbox
        an untrusted MCP executable or prevent access to local user files.
        """
        names = set(MCP_BOOTSTRAP_ENV) | set(self.config.inherit_env)
        env = {key: os.environ[key] for key in names if key in os.environ}
        env.update(self.config.env)
        # 代理变量：用户在 inherit_env / env 里显式声明的优先，不覆盖。
        for key in _PROXY_ENV_VARS:
            if key not in env and key in os.environ:
                env[key] = _strip_proxy_credentials(os.environ[key])
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
            step = "协商协议版本"
            self._negotiate()
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
            # 子进程可能在 poll() 检查和 flush 之间退出：Windows 上往已死
            # 子进程的 stdin 写会报 [Errno 22] Invalid argument（POSIX 上是
            # BrokenPipeError）。这时真正的事件是“服务器已退出”，而不是写失败。
            # 但写失败的瞬间子进程可能还没被 poll() 看到已退出（Windows 上
            # 管道断开与进程退出状态可见之间有竞态）：先等一小会儿让子进程
            # 被回收，再复查退出状态；仍在运行才报写失败。
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
            if process.poll() is not None:
                raise MCPError(
                    f"MCP 服务器已退出（退出码 {process.returncode}）"
                ) from exc
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

    def _modern_meta(self, version: str) -> dict:
        """现代版每次请求自带的 _meta（协议版本 + 客户端能力 + 身份）。"""
        return {
            META_PROTOCOL_VERSION: version,
            META_CLIENT_CAPABILITIES: {},
            META_CLIENT_INFO: {"name": "Nyra", "version": CLIENT_VERSION},
        }

    def _send_request(
        self,
        method: str,
        params: dict | None = None,
        meta: dict | None = None,
        timeout: float | None = None,
    ) -> dict:
        """发一个 JSON-RPC 请求并等它的响应。

        meta 不为 None 时原样放进 params["_meta"]（发现探测用）；
        meta 为 None 且已协商为现代版时，自动附上当前协商版本的 _meta；
        旧版不附 _meta。timeout 为 None 时用 self.timeout。
        """
        request_id = self.next_id
        self.next_id += 1
        body: dict = dict(params or {})
        if meta is not None:
            body["_meta"] = meta
        elif self.era == "modern":
            body["_meta"] = self._modern_meta(
                self.negotiated_version or LATEST_PROTOCOL_VERSION
            )
        self._write_message(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": body,
            }
        )

        deadline = time.monotonic() + (
            self.timeout if timeout is None else timeout
        )
        try:
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
                    # 现代版里服务器本不该发请求，旧版里的 sampling /
                    # elicitation / roots 一样不在支持范围，统一回方法未找到。
                    self._write_message(
                        {
                            "jsonrpc": "2.0",
                            "id": response["id"],
                            "error": {
                                "code": -32601,
                                "message": "Nyra 不支持服务器主动请求的方法",
                            },
                        }
                    )
                    continue

                if response.get("id") != request_id:
                    if response.get("id") in self._stale_ids:
                        # 已超时放弃的旧请求的迟到响应，直接丢弃。
                        self._stale_ids.discard(response["id"])
                        continue
                    raise MCPError("MCP 响应格式无效：请求 id 不匹配")

                if "error" in response:
                    error = response["error"]
                    if isinstance(error, dict):
                        message = error.get("message", "服务器未提供错误说明")
                        code = error.get("code")
                        data = error.get("data")
                    else:
                        message = "服务器返回了无效的错误对象"
                        code = None
                        data = None
                    raise MCPRequestError(f"MCP 错误：{message}", code, data)

                if "result" not in response:
                    raise MCPError("MCP 响应格式无效：缺少 result")
                result = response["result"]
                if not isinstance(result, dict):
                    raise MCPError("MCP 响应格式无效：result 必须是字典")
                return result
        except MCPError:
            # 本次请求已放弃：之后若它的响应迟到，按旧响应丢弃，
            # 不让它冲掉下一个请求的 id 匹配。
            self._stale_ids.add(request_id)
            raise

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

    def _discover(self, version: str) -> dict:
        """现代版发现：问服务器支持哪些协议版本、能力与身份。"""
        return self._send_request(
            "server/discover",
            {},
            meta=self._modern_meta(version),
            timeout=min(self.timeout, PROBE_TIMEOUT),
        )

    @staticmethod
    def _pick_modern_version(data) -> str | None:
        """从 -32022 错误的 supported 列表里挑一个我们支持的现代版。"""
        if not isinstance(data, dict):
            return None
        supported = data.get("supported")
        if not isinstance(supported, list):
            return None
        for version in MODERN_PROTOCOL_VERSIONS:
            if version in supported:
                return version
        return None

    def _use_modern(self, result: dict, requested: str) -> None:
        """采用 server/discover 的结果进入现代版。"""
        supported = result.get("supportedVersions")
        if not isinstance(supported, list) or not supported:
            raise MCPError("MCP 发现结果格式无效：supportedVersions 必须是列表")
        if requested in supported:
            version = requested
        else:
            version = next(
                (v for v in MODERN_PROTOCOL_VERSIONS if v in supported),
                None,
            )
            if version is None:
                raise MCPError(
                    "MCP 服务器不支持任何 Nyra 能用的现代协议版本："
                    + ", ".join(str(v) for v in supported)
                )
        self.negotiated_version = version
        self.era = "modern"
        meta = result.get("_meta")
        if isinstance(meta, dict):
            info = meta.get(META_SERVER_INFO)
            if isinstance(info, dict):
                self.server_info = info

    def _initialize_legacy(self) -> None:
        """旧版握手：initialize + notifications/initialized。"""
        result = self._send_request(
            "initialize",
            {
                "protocolVersion": LEGACY_HANDSHAKE_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "Nyra", "version": CLIENT_VERSION},
            },
        )
        server_version = result.get("protocolVersion")
        if (
            not isinstance(server_version, str)
            or server_version not in LEGACY_PROTOCOL_VERSIONS
        ):
            raise MCPError(
                f"MCP 服务器返回了不支持的协议版本：{server_version!r}"
            )
        self.negotiated_version = server_version
        self.era = "legacy"
        info = result.get("serverInfo")
        if isinstance(info, dict):
            self.server_info = info
        self._send_notification("notifications/initialized")

    def _negotiate(self) -> None:
        """双时代协商（规范 stdio 向后兼容一节）。

        1. 先用 server/discover 探测，带首选现代版 2026-07-28。
        2. 拿到 DiscoverResult：现代版，按 supportedVersions 选版。
        3. 拿到 -32022（版本不支持）：现代服务器，按它列出的版本重试
           现代版；没有共同版本时回退旧版握手。
        4. 其他错误或超时：旧版服务器，回退 initialize 握手。
        """
        try:
            result = self._discover(LATEST_PROTOCOL_VERSION)
        except MCPRequestError as exc:
            if exc.code == UNSUPPORTED_PROTOCOL_VERSION_CODE:
                version = self._pick_modern_version(exc.data)
                if version is not None:
                    try:
                        result = self._discover(version)
                        self._use_modern(result, version)
                    except MCPError:
                        self._initialize_legacy()
                    return
            self._initialize_legacy()
            return
        except MCPError:
            self._initialize_legacy()
            return
        try:
            self._use_modern(result, LATEST_PROTOCOL_VERSION)
        except MCPError:
            # 发现结果不合规（例如旧版服务器对未知方法回了空结果），
            # 按旧版服务器处理。
            self._initialize_legacy()

    def list_tools(self) -> list[dict]:
        tools: list[dict] = []
        cursor: str | None = None
        while True:
            params: dict = {}
            if cursor is not None:
                params["cursor"] = cursor
            result = self._send_request("tools/list", params)
            raw_tools = result.get("tools")
            if not isinstance(raw_tools, list):
                raise MCPError("MCP 工具列表格式无效：tools 必须是列表")

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

            cursor = result.get("nextCursor")
            if not isinstance(cursor, str) or not cursor:
                break

        self.tools = tools
        return self.tools

    def call_tool(self, name: str, arguments: dict) -> str:
        result = self._send_request(
            "tools/call", {"name": name, "arguments": arguments}
        )
        if result.get("resultType") == "input_required":
            # 多轮往返（MRTR）：服务器要补充输入才继续，Nyra 暂不支持
            # 交互式追问，直接报清原因，不假装完成。
            requests = result.get("inputRequests")
            detail = ""
            if isinstance(requests, dict) and requests:
                detail = "（需要：" + "、".join(sorted(requests)) + "）"
            elif isinstance(requests, list) and requests:
                detail = f"（需要 {len(requests)} 项输入）"
            raise MCPError(
                "MCP 服务器要求补充输入后重试（多轮往返），"
                f"Nyra 暂不支持{detail}"
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
    """Load MCP server configs: built-in presets first, user entries win.

    Presets come from config["mcp_presets"] (a list of preset names;
    defaults to DEFAULT_MCP_PRESETS when the key is absent; an
    explicitly empty list disables all presets). A preset that needs
    a key or a path is skipped with a stderr message when the
    requirement is missing. User entries in config["mcp_servers"]
    override a preset of the same name.
    """
    from nyra.mcp_presets import DEFAULT_MCP_PRESETS, resolve_preset

    servers = {}

    preset_names = config.get("mcp_presets", DEFAULT_MCP_PRESETS)
    if not isinstance(preset_names, list) or not all(
        isinstance(name, str) for name in preset_names
    ):
        print(
            "mcp_presets 应为预置名列表，已忽略并使用默认预置",
            file=sys.stderr,
        )
        preset_names = list(DEFAULT_MCP_PRESETS)
    preset_args = config.get("mcp_preset_args") or {}
    if not isinstance(preset_args, dict):
        preset_args = {}
    for name in preset_names:
        raw, reason = resolve_preset(name, preset_args)
        if raw is None:
            print(reason, file=sys.stderr)
            continue
        try:
            servers[name] = MCPServerConfig.from_dict(name, raw)
        except MCPError as exc:
            print(
                f"跳过无效 MCP 预置 {name}: {exc}",
                file=sys.stderr,
            )

    raw_servers = config.get("mcp_servers", {})
    if not isinstance(raw_servers, dict):
        return servers

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
