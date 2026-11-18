"""Execution backends: run Nyra's file and shell tools locally or in an E2B sandbox.

The core of Nyra stays standard library only. The E2B backend is an
optional extra: it lazily imports the official `e2b` SDK (``pip install e2b``)
and authenticates with a stored credential surrogate when available, so no
API key ever has to sit in a file or an environment variable.

A backend implements four methods, all returning plain strings the same way
the local implementations in tools.py do:
    run_command(command, cwd=None, timeout=60) -> str
    read_file(path) -> str
    write_file(path, content) -> str
    list_dir(path) -> str
"""

import os
import sys

DEFAULT_TEMPLATE = "base"
DEFAULT_TIMEOUT = 3600
DEFAULT_SANDBOX_WORKDIR = "/home/user"


class E2BError(Exception):
    pass


def _load_e2b():
    """Import the official E2B SDK, or explain how to get it."""
    try:
        import e2b  # type: ignore

        return e2b
    except ImportError as exc:
        raise E2BError(
            "E2B 沙盒需要安装官方 SDK：pip install e2b（建议放在虚拟环境里）"
        ) from exc


def resolve_e2b_api_key() -> str:
    """Resolve an E2B API key without ever writing the real key down.

    Order: explicit E2B_API_KEY environment variable, then the stored
    Muse connector credential (returned as a surrogate that only the
    runtime can swap for the real key, on requests to api.e2b.dev).
    """
    key = os.environ.get("E2B_API_KEY")
    if key:
        return key
    try:
        sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
        from dynamic_credentials import dynamic_credential_entry

        return dynamic_credential_entry("custom.e2b")["surrogate"]
    except Exception:
        raise E2BError(
            "没有可用的 E2B 凭证：请设置 E2B_API_KEY，"
            "或在 Muse 里保存 E2B 连接器"
        ) from None


class E2BBackend:
    """Run file and shell operations inside an E2B sandbox.

    Create a fresh sandbox, or attach to an existing one by id. The sandbox
    is left running when the backend closes; it dies by its own timeout.
    """

    name = "e2b"

    def __init__(
        self,
        sandbox_id: str | None = None,
        template: str = DEFAULT_TEMPLATE,
        timeout: int = DEFAULT_TIMEOUT,
        api_key: str | None = None,
    ) -> None:
        self.sandbox_id = sandbox_id
        self.template = template
        self.timeout = timeout
        self._api_key = api_key
        self._sbx = None

    def connect(self) -> str:
        """Attach to (or create) the sandbox and return its id."""
        e2b = _load_e2b()
        key = self._api_key or resolve_e2b_api_key()
        if self.sandbox_id:
            self._sbx = e2b.Sandbox.connect(self.sandbox_id, api_key=key)
        else:
            self._sbx = e2b.Sandbox.create(
                template=self.template, timeout=self.timeout, api_key=key
            )
            self.sandbox_id = self._sbx.sandbox_id
        return self.sandbox_id

    def _require_sandbox(self):
        if self._sbx is None:
            raise E2BError("沙盒未连接，请先调用 connect()")
        return self._sbx

    def run_command(
        self,
        command: str,
        cwd: str | None = None,
        timeout: int = 60,
    ) -> str:
        sbx = self._require_sandbox()
        try:
            result = sbx.commands.run(command, cwd=cwd, timeout=timeout)
        except Exception as exc:
            message = str(exc)
            if "timeout" in message.lower() or "timed out" in message.lower():
                return f"错误：命令超时（{timeout} 秒）"
            return f"执行失败：{type(exc).__name__}: {exc}"
        combined = result.stdout or ""
        if result.stderr:
            if combined and not combined.endswith("\n"):
                combined += "\n"
            combined += "标准错误：\n" + result.stderr
        return combined or "（无输出）"

    def read_file(self, path: str) -> str:
        sbx = self._require_sandbox()
        try:
            content = sbx.files.read(path)
        except Exception as exc:
            message = str(exc).lower()
            if "not found" in message or "not_found" in message:
                return f"错误：文件不存在：{path}"
            return f"错误：读取失败：{exc}"
        if isinstance(content, bytes):
            return content.decode("utf-8", errors="replace")
        return content

    def write_file(self, path: str, content: str) -> str:
        sbx = self._require_sandbox()
        try:
            sbx.files.write(path, content)
        except Exception as exc:
            return f"执行失败：{type(exc).__name__}: {exc}"
        return f"已写入 {path}（{len(content)} 字符）"

    def list_dir(self, path: str) -> str:
        sbx = self._require_sandbox()
        try:
            entries = sbx.files.list(path)
        except Exception as exc:
            message = str(exc).lower()
            if "not found" in message or "not_found" in message:
                return f"错误：目录不存在：{path}"
            return f"执行失败：{type(exc).__name__}: {exc}"
        rows = []
        for entry in sorted(
            entries,
            key=lambda e: (
                str(getattr(e.type, "value", e.type)).lower() != "dir",
                e.name,
            ),
        ):
            kind = str(getattr(entry.type, "value", entry.type)).lower()
            if kind == "dir":
                rows.append(f"{entry.name}/")
            else:
                rows.append(f"{entry.name} ({entry.size} 字节)")
        return "\n".join(rows) or "（空目录）"

    def close(self) -> None:
        """Drop the connection. The sandbox keeps running until its timeout."""
        self._sbx = None


def connect_backend(settings) -> E2BBackend | None:
    """Build and connect the backend for the given sandbox settings.

    Returns None for the local backend. Raises E2BError when the E2B
    backend is requested but cannot be started.
    """
    if getattr(settings, "backend", "local") != "e2b":
        return None
    backend = E2BBackend(
        sandbox_id=getattr(settings, "sandbox_id", None),
        template=getattr(settings, "template", DEFAULT_TEMPLATE),
        timeout=getattr(settings, "timeout", DEFAULT_TIMEOUT),
    )
    backend.connect()
    return backend
