"""Linux shell isolation with bubblewrap; the rest of Angel stays local."""

from __future__ import annotations

import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import threading


SANDBOX_ROOT = "/workspace"
MAX_CAPTURE_BYTES_PER_STREAM = 512 * 1024
_SANDBOX_ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": "/tmp",
    "TMPDIR": "/tmp",
    "LANG": "C",
    "LC_ALL": "C",
    "TERM": "dumb",
    "USER": "angel",
    "LOGNAME": "angel",
}


class BubblewrapError(RuntimeError):
    """Bubblewrap is missing or cannot provide the required isolation."""


class BubblewrapBackend:
    """Run shell, grep and git commands in a strict, networkless Linux namespace.

    Only the selected workspace is writable and visible from the host. Angel's
    dedicated file tools continue to use their existing local path checks.
    """

    name = "bubblewrap"

    def __init__(self, workdir: str | Path, executable: str | None = None) -> None:
        if platform.system() != "Linux":
            raise BubblewrapError("Bubblewrap 本地沙箱仅支持 Linux")
        try:
            self.workdir = Path(workdir).resolve(strict=True)
        except OSError as exc:
            raise BubblewrapError("Bubblewrap 工作目录不可用") from exc
        if not self.workdir.is_dir():
            raise BubblewrapError("Bubblewrap 工作目录必须是目录")
        self.executable = executable or shutil.which("bwrap")
        if not self.executable:
            raise BubblewrapError(
                "未找到 bwrap；请先安装 Bubblewrap，或选择 --sandbox local"
            )

    def sandbox_path(self, host_path: str | Path) -> str:
        """Map an existing or prospective workspace path into the mount namespace."""
        target = Path(host_path)
        if not target.is_absolute():
            target = self.workdir / target
        try:
            resolved = target.resolve(strict=False)
            relative = resolved.relative_to(self.workdir)
        except (OSError, RuntimeError, ValueError) as exc:
            raise BubblewrapError("沙箱路径必须位于工作目录内") from exc
        return SANDBOX_ROOT if str(relative) == "." else f"{SANDBOX_ROOT}/{relative.as_posix()}"

    def _base_args(self, cwd: str) -> list[str]:
        if not cwd.startswith(SANDBOX_ROOT) or (
            cwd != SANDBOX_ROOT and not cwd.startswith(SANDBOX_ROOT + "/")
        ):
            raise BubblewrapError("沙箱 cwd 必须位于工作目录内")
        args = [
            self.executable,
            "--die-with-parent",
            "--new-session",
            "--unshare-user",
            "--unshare-pid",
            "--unshare-net",
            "--unshare-ipc",
            "--unshare-uts",
            "--disable-userns",
            "--cap-drop", "ALL",
            "--hostname", "angel-sandbox",
            "--ro-bind", "/usr", "/usr",
        ]

        # Build only the common executable/library skeleton, not the host root.
        for source in ("/bin", "/sbin", "/lib", "/lib64"):
            path = Path(source)
            if path.is_symlink():
                args.extend(("--symlink", os.readlink(path), source))
            elif path.is_dir():
                args.extend(("--ro-bind", source, source))

        args.extend(("--dir", "/etc"))
        for directory in ("/etc/alternatives", "/etc/ssl", "/etc/ssl/certs"):
            args.extend(("--dir", directory))
        for source, destination in (
            ("/etc/alternatives", "/etc/alternatives"),
            ("/etc/ssl/certs", "/etc/ssl/certs"),
            ("/etc/ld.so.cache", "/etc/ld.so.cache"),
            ("/etc/localtime", "/etc/localtime"),
            ("/etc/nsswitch.conf", "/etc/nsswitch.conf"),
        ):
            source_path = Path(source)
            if source_path.is_dir() and not source_path.is_symlink():
                args.extend(("--ro-bind", source, destination))
            elif source_path.is_file():
                args.extend(("--ro-bind", source, destination))

        args.extend((
            "--proc", "/proc",
            "--dev", "/dev",
            "--tmpfs", "/tmp",
            "--tmpfs", "/run",
            "--dir", SANDBOX_ROOT,
            "--bind", str(self.workdir), SANDBOX_ROOT,
            "--chdir", cwd,
            "--clearenv",
        ))
        for name, value in _SANDBOX_ENV.items():
            args.extend(("--setenv", name, value))
        return args

    def _run_argv(self, argv: list[str], cwd: str, timeout: int) -> tuple[int, str, str, bool]:
        command = [*self._base_args(cwd), "--", *argv]
        captured = {"stdout": bytearray(), "stderr": bytearray()}
        truncated = {"stdout": False, "stderr": False}

        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=False,
                env=_SANDBOX_ENV,
                start_new_session=True,
            )
        except OSError as exc:
            return 127, "", f"Bubblewrap 启动失败：{type(exc).__name__}", False

        def drain(name: str, stream) -> None:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    return
                remaining = MAX_CAPTURE_BYTES_PER_STREAM - len(captured[name])
                if remaining > 0:
                    captured[name].extend(chunk[:remaining])
                if len(chunk) > remaining:
                    truncated[name] = True

        readers = [
            threading.Thread(target=drain, args=("stdout", process.stdout), daemon=True),
            threading.Thread(target=drain, args=("stderr", process.stderr), daemon=True),
        ]
        for reader in readers:
            reader.start()

        timed_out = False
        try:
            returncode = process.wait(timeout=max(1, min(int(timeout), 3600)))
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                process.kill()
            except OSError:
                pass
            process.wait()
            returncode = process.returncode
        for reader in readers:
            reader.join(timeout=2)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()

        stdout = bytes(captured["stdout"]).decode("utf-8", errors="replace")
        stderr = bytes(captured["stderr"]).decode("utf-8", errors="replace")
        if any(truncated.values()):
            marker = "\n……（沙箱输出流超过 512 KiB，已截断）"
            stdout += marker if truncated["stdout"] else ""
            stderr += marker if truncated["stderr"] else ""
        return returncode, stdout, stderr, timed_out

    def probe(self) -> None:
        """Fail closed if required namespace/mount options are unavailable."""
        code, _stdout, stderr, timed_out = self._run_argv(
            ["/bin/true"], cwd=SANDBOX_ROOT, timeout=10
        )
        if timed_out or code != 0:
            detail = " ".join(stderr.split())[:400]
            suffix = f"：{detail}" if detail else ""
            raise BubblewrapError(
                "Bubblewrap 隔离预检失败；未启动 Agent shell" + suffix
            )

    def run_command(
        self, command: str, cwd: str | Path | None = None, timeout: int = 60
    ) -> str:
        if not isinstance(command, str) or not command.strip() or "\x00" in command:
            return "错误：shell 命令无效"
        try:
            sandbox_cwd = self.sandbox_path(cwd or self.workdir)
        except BubblewrapError as exc:
            return f"错误：{exc}"
        code, stdout, stderr, timed_out = self._run_argv(
            ["/bin/sh", "-c", command], cwd=sandbox_cwd, timeout=timeout
        )
        if timed_out:
            return f"错误：命令超时（{max(1, min(int(timeout), 3600))} 秒）"
        combined = stdout
        if stderr:
            if combined and not combined.endswith("\n"):
                combined += "\n"
            combined += "标准错误：\n" + stderr
        if code == 127 and not combined:
            return "错误：Bubblewrap 或沙箱命令无法启动"
        return combined or "（无输出）"


def connect_bubblewrap(workdir: str | Path, *, probe: bool = True) -> BubblewrapBackend:
    """Create a local Bubblewrap backend and optionally verify it can isolate."""
    backend = BubblewrapBackend(workdir)
    if probe:
        backend.probe()
    return backend
