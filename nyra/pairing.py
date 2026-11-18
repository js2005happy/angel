"""Nyra 配对码协作：两个 Nyra agent 用 6 位配对码配对后一起工作。

只在可信网络上配对。配对码和会话 token 都是明文传输的（HTTP 与 UDP
都没有加密），任何能抓到局域网流量的人都能看到它们；不要在公共
Wi-Fi 或其他不可信网络上使用。

安全硬规则：
- 远端任务只跑 readonly 模式：不写文件、不跑 shell、不发网络请求。
- 配对会话只传任务文本和结果，绝不传 API Key 或任何凭据。
- 配对码 6 位数字、有效期 10 分钟、一次性使用；失败 5 次作废。
- 会话 token 只放内存，用 hmac.compare_digest 比对。

用法：
    python3 -m nyra.pairing host        # 宿主：打印配对码，服务到 Ctrl-C
    python3 -m nyra.pairing join CODE   # 客人：发现、配对，逐行读任务

配对成功后客人还能读宿主的记忆快照（GET /memory，须 Bearer token，
返回宿主脱敏后的快照；读记忆也只读，绝不传凭据。见 memory_exchange.py）。

手机配对（网页界面 / PWA，见 docs/mobile-pwa.md）也在这里：
DeviceRegistry 发一次性配对码（6 位、5 分钟有效、一次性、错 5 次作废），
手机用配对码换取设备专属的长期 token；磁盘上只存 token 的 SHA-256，
可以随时撤销。命令行：
    python3 -m nyra.pairing devices         # 列出已配对的手机
    python3 -m nyra.pairing revoke ID       # 撤销一台手机
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DISCOVERY_PORT = 47831
DISCOVERY_MAGIC = "NYRA-PAIR-SEARCH"
CODE_TTL_SECONDS = 600  # 配对码有效期：10 分钟
MAX_FAILED_ATTEMPTS = 5
DISCOVERY_TIMEOUT = 5.0


class PairingError(Exception):
    pass


def generate_code() -> str:
    """生成一个 6 位数字配对码（首位不为 0）。"""
    return f"{secrets.randbelow(900000) + 100000:06d}"


def _local_ip_for(peer_ip: str) -> str:
    """返回本机上能到达 peer_ip 的那个网卡地址（只做本地路由查询，不发包）。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect((peer_ip, 1))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def _default_runner(task: str) -> str:
    """默认任务执行：用只读模式的 Agent 跑任务。

    在函数内 lazy import nyra.agent，避免循环引用。readonly 模式下
    Agent 不写文件、不跑 shell、不发网络请求，只调用模型作答。
    """
    from nyra.agent import Agent
    from nyra.config import load_config, resolve_provider
    from nyra.providers import Provider

    config = load_config()
    provider = Provider(resolve_provider(config.get("provider"), config.get("model")))
    agent = Agent(
        provider=provider,
        mode="readonly",
        interactive=False,
        max_turns=config.get("max_turns") or 20,
    )
    return agent.run(task)


class PairingHost:
    """配对宿主：HTTP 服务（配对/任务）+ UDP 发现监听。"""

    def __init__(
        self,
        runner=None,
        code_ttl: float = CODE_TTL_SECONDS,
        max_attempts: int = MAX_FAILED_ATTEMPTS,
    ):
        self.runner = runner or _default_runner
        self.code = generate_code()
        self._code_ttl = code_ttl
        self._max_attempts = max_attempts
        self._code_expires_at = time.monotonic() + code_ttl
        self._failed_attempts = 0
        self._paired = False
        self._token: str | None = None
        self._lock = threading.Lock()
        self._httpd: ThreadingHTTPServer | None = None
        self._udp_sock: socket.socket | None = None
        self._http_thread: threading.Thread | None = None
        self._udp_thread: threading.Thread | None = None
        self._running = False
        self.port = 0

    @property
    def token(self) -> str | None:
        return self._token

    def _code_expired(self) -> bool:
        return time.monotonic() >= self._code_expires_at

    def verify_code(self, code: str) -> tuple[bool, str | None]:
        """验配对码。成功返回 (True, None) 并生成会话 token；失败返回
        (False, 原因)。一次性使用：配对成功后码即作废。"""
        with self._lock:
            if self._paired:
                return False, "配对码已使用"
            if self._code_expired():
                return False, "配对码已过期"
            if self._failed_attempts >= self._max_attempts:
                return False, "配对失败次数过多，配对码已作废"
            if not hmac.compare_digest(code, self.code):
                self._failed_attempts += 1
                return False, "配对码错误"
            self._paired = True
            self._token = secrets.token_hex(32)
            return True, None

    def check_token(self, presented: str) -> bool:
        """用 compare_digest 比对会话 token（只放内存）。"""
        token = self._token
        if token is None:
            return False
        return hmac.compare_digest(presented, token)

    def run_task(self, task: str) -> str:
        result = self.runner(task)
        return result if isinstance(result, str) else str(result)

    def start(self) -> None:
        """启动 HTTP 服务（0.0.0.0 临时端口）与 UDP 发现监听。"""
        if self._running:
            return
        self._httpd = ThreadingHTTPServer(("0.0.0.0", 0), _PairingRequestHandler)
        self._httpd.pairing_host = self
        self.port = self._httpd.server_address[1]
        self._udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._udp_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._udp_sock.settimeout(0.5)
        self._udp_sock.bind(("0.0.0.0", DISCOVERY_PORT))
        self._running = True
        self._http_thread = threading.Thread(
            target=self._httpd.serve_forever, daemon=True
        )
        self._http_thread.start()
        self._udp_thread = threading.Thread(target=self._discovery_loop, daemon=True)
        self._udp_thread.start()

    def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        try:
            if self._httpd is not None:
                self._httpd.shutdown()
                self._httpd.server_close()
        except Exception:
            pass
        try:
            if self._udp_sock is not None:
                self._udp_sock.close()
        except Exception:
            pass
        for thread in (self._http_thread, self._udp_thread):
            if thread is not None:
                thread.join(timeout=2.0)

    def __enter__(self) -> "PairingHost":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()

    def _handle_discovery_packet(self, data: bytes, addr) -> bytes | None:
        """处理一条发现请求；码正确且可用时返回要回的包，否则返回 None
       （错码、过期、已用过、失败次数超限、格式不对都不回包）。"""
        try:
            text = data.decode("utf-8").strip()
        except UnicodeDecodeError:
            return None
        parts = text.split()
        if len(parts) != 2 or parts[0] != DISCOVERY_MAGIC:
            return None
        with self._lock:
            usable = (
                not self._paired
                and not self._code_expired()
                and self._failed_attempts < self._max_attempts
            )
        if not usable:
            return None
        if not hmac.compare_digest(parts[1], self.code):
            return None
        return json.dumps(
            {"host": _local_ip_for(addr[0]), "port": self.port}
        ).encode("utf-8")

    def _discovery_loop(self) -> None:
        """回 UDP 发现广播：只有配对码正确、未过期、未用过、未超失败次数
        时才回 {host, port}；错码不回包。"""
        assert self._udp_sock is not None
        while self._running:
            try:
                data, addr = self._udp_sock.recvfrom(1024)
            except socket.timeout:
                continue
            except OSError:
                break
            reply = self._handle_discovery_packet(data, addr)
            if reply is None:
                continue
            try:
                self._udp_sock.sendto(reply, addr)
            except OSError:
                pass


class _PairingRequestHandler(BaseHTTPRequestHandler):
    """宿主 HTTP 接口，全是 JSON。"""

    def log_message(self, *args) -> None:
        pass

    @property
    def _host(self) -> PairingHost:
        return self.server.pairing_host

    def _send_json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def do_GET(self) -> None:
        if self.path == "/ping":
            self._send_json(200, {"ok": True})
            return
        if self.path == "/memory":
            auth = self.headers.get("Authorization") or ""
            if not auth.startswith("Bearer "):
                self._send_json(401, {"error": "未授权"})
                return
            if not self._host.check_token(auth[len("Bearer "):].strip()):
                self._send_json(401, {"error": "未授权"})
                return
            try:
                from nyra.memory_exchange import SnapshotError, export_snapshot_report

                report = export_snapshot_report()
            except SnapshotError as exc:
                self._send_json(404, {"error": str(exc)})
                return
            except Exception as exc:
                self._send_json(500, {"error": str(exc)})
                return
            self._send_json(
                200,
                {"snapshot": report["snapshot"], "scrubbed": report["scrubbed"]},
            )
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path == "/pair":
            data = self._read_json()
            if not isinstance(data, dict) or not isinstance(data.get("code"), str):
                self._send_json(400, {"error": '需要 JSON：{"code": "123456"}'})
                return
            ok, reason = self._host.verify_code(data["code"])
            if not ok:
                self._send_json(401, {"error": reason})
                return
            self._send_json(200, {"token": self._host.token})
            return
        if self.path == "/task":
            auth = self.headers.get("Authorization") or ""
            if not auth.startswith("Bearer "):
                self._send_json(401, {"error": "未授权"})
                return
            if not self._host.check_token(auth[len("Bearer "):].strip()):
                self._send_json(401, {"error": "未授权"})
                return
            data = self._read_json()
            if not isinstance(data, dict) or not isinstance(data.get("task"), str):
                self._send_json(400, {"error": '需要 JSON：{"task": "..."}'})
                return
            try:
                result = self._host.run_task(data["task"])
            except Exception as exc:
                self._send_json(500, {"error": str(exc)})
                return
            self._send_json(200, {"result": result})
            return
        self._send_json(404, {"error": "not found"})


class PairingClient:
    """配对客人：发现、配对、调任务。"""

    def __init__(self, timeout: float = DISCOVERY_TIMEOUT):
        self.timeout = timeout
        self.token: str | None = None
        self.host: str | None = None
        self.port: int | None = None

    def discover(
        self,
        code: str,
        address: str = "255.255.255.255",
        timeout: float | None = None,
    ) -> tuple[str, int] | None:
        """发 UDP 发现广播，等宿主回 {host, port}；超时未收到返回 None。
        address 可改成单播地址（如 127.0.0.1）做回环测试。"""
        wait = self.timeout if timeout is None else timeout
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            # 只有真正发广播时才开 SO_BROADCAST：单播地址（如 127.0.0.1）
            # 不需要它，且某些沙箱环境会拒绝带该标记的 sendto。
            if address == "255.255.255.255" or address.endswith(".255"):
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.settimeout(wait)
            try:
                sock.sendto(
                    f"{DISCOVERY_MAGIC} {code}".encode("utf-8"),
                    (address, DISCOVERY_PORT),
                )
            except OSError:
                return None  # 发不出去（如沙箱禁 UDP）就当没发现宿主
            deadline = time.monotonic() + wait
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                sock.settimeout(remaining)
                try:
                    data, _addr = sock.recvfrom(1024)
                except socket.timeout:
                    return None
                try:
                    info = json.loads(data.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    continue
                if (
                    isinstance(info, dict)
                    and isinstance(info.get("host"), str)
                    and isinstance(info.get("port"), int)
                ):
                    return info["host"], info["port"]
        finally:
            sock.close()

    def _request(
        self,
        method: str,
        host: str,
        port: int,
        path: str,
        payload: dict | None = None,
        auth: bool = False,
    ) -> tuple[int, dict]:
        url = f"http://{host}:{port}{path}"
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=body, method=method)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if auth:
            if not self.token:
                raise PairingError("尚未配对")
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                data = json.loads(exc.read().decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                data = {"error": f"HTTP {exc.code}"}
            return exc.code, data
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise PairingError(f"连接 {host}:{port} 失败：{exc}") from exc

    def pair(self, host: str, port: int, code: str) -> str:
        """用配对码换会话 token；失败（401）抛 PairingError。"""
        status, data = self._request("POST", host, port, "/pair", {"code": code})
        if status != 200:
            raise PairingError(data.get("error", f"配对失败（HTTP {status}）"))
        token = data.get("token")
        if not isinstance(token, str) or not token:
            raise PairingError("宿主未返回会话 token")
        self.token = token
        self.host = host
        self.port = port
        return token

    def ping(self, host: str, port: int) -> bool:
        status, data = self._request("GET", host, port, "/ping")
        return status == 200 and data.get("ok") is True

    def run_task(self, task: str) -> str:
        """调宿主的 /task；未配对或 token 无效抛 PairingError。"""
        if self.host is None or self.port is None:
            raise PairingError("尚未配对")
        status, data = self._request(
            "POST", self.host, self.port, "/task", {"task": task}, auth=True
        )
        if status == 401:
            raise PairingError("会话 token 无效或已失效")
        if status != 200:
            raise PairingError(data.get("error", f"任务失败（HTTP {status}）"))
        return data.get("result", "")

    def read_peer_memory(self) -> str:
        """读宿主的 /memory（只读，返回脱敏后的快照文本）。

        未配对、token 无效、宿主暂无记忆时抛 PairingError。
        """
        if self.host is None or self.port is None:
            raise PairingError("尚未配对")
        status, data = self._request(
            "GET", self.host, self.port, "/memory", auth=True
        )
        if status == 401:
            raise PairingError("会话 token 无效或已失效")
        if status == 404:
            raise PairingError("宿主暂无记忆")
        if status != 200:
            raise PairingError(data.get("error", f"读记忆失败（HTTP {status}）"))
        snapshot = data.get("snapshot")
        if not isinstance(snapshot, str) or not snapshot:
            raise PairingError("宿主未返回记忆快照")
        return snapshot


# ---------------------------------------------------------------------------
# 手机配对：网页界面（PWA）用的一次性配对码 + 设备专属长期 token
# ---------------------------------------------------------------------------
DEVICE_CODE_TTL_SECONDS = 300  # 手机配对码：5 分钟
DEVICES_FILE = "devices.json"
MAX_DEVICES = 20
MAX_DEVICE_NAME = 40
LAST_SEEN_WRITE_INTERVAL = 60.0


def hash_device_token(token: str) -> str:
    """设备 token 的 SHA-256（十六进制）。token 是 32 字节随机数，不需要慢哈希。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _clean_name(name) -> str:
    text = "".join(ch for ch in str(name or "") if ch.isprintable()).strip()
    return text[:MAX_DEVICE_NAME] or "手机"


class DeviceRegistry:
    """已配对手机的登记表 + 当前一次性配对码。

    - 配对码：6 位数字，默认 5 分钟有效，一次性；错 ``max_attempts`` 次作废。
      同一时刻只有一个有效配对码，重新生成会让旧码立即失效。
    - 配对成功发一个设备专属 token（``secrets.token_urlsafe(32)``），只在
      这一次返回给手机；磁盘上只存它的 SHA-256。
    - 撤销即从登记表删除，之后该 token 立即失效。
    - 文件权限 0600（POSIX），原子写入。
    """

    def __init__(
        self,
        path: Path | str,
        code_ttl: float = DEVICE_CODE_TTL_SECONDS,
        max_attempts: int = MAX_FAILED_ATTEMPTS,
        clock=time.monotonic,
    ) -> None:
        self.path = Path(path)
        self.code_ttl = code_ttl
        self.max_attempts = max_attempts
        self._clock = clock
        self._lock = threading.Lock()
        self._code: str | None = None
        self._code_expires_at = 0.0
        self._failed = 0
        self._last_seen_written: dict[str, float] = {}
        self._mtime = None
        self._devices: list[dict] = self._load()

    # -- storage -------------------------------------------------------------
    def _stat_mtime(self):
        """文件“版本”：mtime + inode + 大小（原子替换会换 inode，粗粒度
        时间戳的文件系统上也能发现别的进程写过）。"""
        try:
            st = self.path.stat()
        except OSError:
            return None
        return (st.st_mtime_ns, st.st_ino, st.st_size)

    def _refresh(self) -> None:
        """登记表文件被别的进程改过（如命令行撤销）时重新读取。调用方持锁。"""
        mtime = self._stat_mtime()
        if mtime != self._mtime:
            self._devices = self._load()

    def _load(self) -> list[dict]:
        self._mtime = self._stat_mtime()
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        items = data.get("devices") if isinstance(data, dict) else None
        out = []
        for item in items or []:
            if (
                isinstance(item, dict)
                and isinstance(item.get("id"), str)
                and isinstance(item.get("token_sha256"), str)
                and len(item["token_sha256"]) == 64
            ):
                out.append(item)
        return out

    def _save(self) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + f".{secrets.token_hex(4)}.tmp")
        body = json.dumps({"devices": self._devices}, ensure_ascii=False, indent=1)
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(body)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass
        self._mtime = self._stat_mtime()

    # -- pairing code --------------------------------------------------------
    def start_pairing(self) -> dict:
        """生成新的一次性配对码（旧码立即作废）。"""
        with self._lock:
            self._code = generate_code()
            self._code_expires_at = self._clock() + self.code_ttl
            self._failed = 0
            return {"code": self._code, "expires_in": int(self.code_ttl)}

    def pairing_status(self) -> dict:
        with self._lock:
            active = self._code is not None and self._clock() < self._code_expires_at
            left = max(0, int(self._code_expires_at - self._clock())) if active else 0
            return {"active": active, "expires_in": left}

    def cancel_pairing(self) -> None:
        with self._lock:
            self._code = None

    def redeem(self, code: str, name: str = "") -> dict:
        """用配对码换设备 token。成功返回 {"id", "name", "token"}（token
        只此一次返回）；失败抛 PairingError（原因写在异常里）。"""
        if not isinstance(code, str):
            raise PairingError("配对码无效")
        code = code.strip()
        with self._lock:
            if self._code is None:
                raise PairingError("没有进行中的配对，请在电脑上重新生成配对码")
            if self._clock() >= self._code_expires_at:
                self._code = None
                raise PairingError("配对码已过期，请在电脑上重新生成")
            if not hmac.compare_digest(code.encode("utf-8"), self._code.encode("utf-8")):
                self._failed += 1
                if self._failed >= self.max_attempts:
                    self._code = None
                    raise PairingError("配对码错误次数过多，已作废，请在电脑上重新生成")
                raise PairingError("配对码错误")
            self._code = None  # 一次性
            self._refresh()
            if len(self._devices) >= MAX_DEVICES:
                raise PairingError(f"已配对设备太多（上限 {MAX_DEVICES}），请先撤销不用的设备")
            token = secrets.token_urlsafe(32)
            device = {
                "id": secrets.token_hex(8),
                "name": _clean_name(name),
                "token_sha256": hash_device_token(token),
                "created": _now_iso(),
                "last_seen": _now_iso(),
            }
            self._devices.append(device)
            self._save()
            return {"id": device["id"], "name": device["name"], "token": token}

    # -- tokens --------------------------------------------------------------
    def authenticate(self, token: str) -> dict | None:
        """token 有效返回该设备（不含哈希）的副本，否则 None。常量时间比对。"""
        if not token or not isinstance(token, str) or len(token) > 200:
            return None
        digest = hash_device_token(token)
        found = None
        with self._lock:
            self._refresh()
            for device in self._devices:
                if hmac.compare_digest(digest, device["token_sha256"]):
                    found = device
            if found is None:
                return None
            now = self._clock()
            last = self._last_seen_written.get(found["id"])
            if last is None or now - last >= LAST_SEEN_WRITE_INTERVAL:
                self._last_seen_written[found["id"]] = now
                found["last_seen"] = _now_iso()
                try:
                    self._save()
                except OSError:
                    pass
            return {k: v for k, v in found.items() if k != "token_sha256"}

    def list_devices(self) -> list[dict]:
        with self._lock:
            self._refresh()
            return [
                {k: v for k, v in d.items() if k != "token_sha256"}
                for d in self._devices
            ]

    def revoke(self, device_id: str) -> bool:
        with self._lock:
            self._refresh()
            before = len(self._devices)
            self._devices = [d for d in self._devices if d.get("id") != device_id]
            if len(self._devices) == before:
                return False
            self._last_seen_written.pop(device_id, None)
            self._save()
            return True


def default_devices_path() -> Path:
    from nyra import config as config_module

    return Path(config_module.NYRA_HOME) / DEVICES_FILE


def lan_ipv4_addresses() -> list[str]:
    """本机可能的局域网 IPv4（不发包：只做本地路由查询与主机名解析）。"""
    seen: list[str] = []
    for probe in ("10.255.255.255", "192.168.255.255", "172.31.255.255"):
        ip = _local_ip_for(probe)
        if ip and not ip.startswith("127.") and ip not in seen:
            seen.append(ip)
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in seen:
                seen.append(ip)
    except OSError:
        pass
    private = [ip for ip in seen if ip.startswith(("192.168.", "10.")) or
               (ip.startswith("172.") and 16 <= int(ip.split(".")[1]) <= 31)]
    return private + [ip for ip in seen if ip not in private]


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args:
        print("用法：python3 -m nyra.pairing host | join <6 位配对码>", flush=True)
        return 2
    if args[0] == "host":
        host = PairingHost()
        host.start()
        try:
            print(f"配对码：{host.code}", flush=True)
            print(f"地址：http://{socket.gethostname()}:{host.port}", flush=True)
            print("同一局域网内的另一台设备用本机局域网 IP 访问；", flush=True)
            print("配对码 10 分钟内有效，一次性使用。按 Ctrl-C 结束。", flush=True)
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n结束。", flush=True)
        finally:
            host.stop()
        return 0
    if args[0] == "devices":
        registry = DeviceRegistry(default_devices_path())
        devices = registry.list_devices()
        if not devices:
            print("还没有配对的手机。", flush=True)
        for d in devices:
            print(f"{d['id']}  {d['name']}  配对于 {d.get('created', '?')}  最近 {d.get('last_seen', '?')}", flush=True)
        return 0
    if args[0] == "revoke":
        if len(args) < 2:
            print("用法：python3 -m nyra.pairing revoke <设备 ID>", flush=True)
            return 2
        registry = DeviceRegistry(default_devices_path())
        if registry.revoke(args[1]):
            print(f"已撤销 {args[1]}，立即生效（运行中的网页界面会重新读取登记表）。", flush=True)
            return 0
        print(f"没有这个设备：{args[1]}", flush=True)
        return 1
    if args[0] == "join":
        if len(args) < 2:
            print("用法：python3 -m nyra.pairing join <6 位配对码>", flush=True)
            return 2
        code = args[1]
        client = PairingClient()
        found = client.discover(code)
        if found is None:
            print("未发现宿主（配对码可能不对，或不在同一网络）。", flush=True)
            return 1
        host_addr, port = found
        try:
            client.pair(host_addr, port, code)
        except PairingError as exc:
            print(f"配对失败：{exc}", flush=True)
            return 1
        print(f"已配对：{host_addr}:{port}。输入任务，每行一个，Ctrl-D 结束。", flush=True)
        for line in sys.stdin:
            task = line.strip()
            if not task:
                continue
            try:
                print(client.run_task(task), flush=True)
            except PairingError as exc:
                print(f"任务失败：{exc}", flush=True)
        return 0
    print("用法：python3 -m nyra.pairing host | join <6 位配对码> | devices | revoke <设备 ID>", flush=True)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
