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
"""

from __future__ import annotations

import hmac
import json
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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
    print("用法：python3 -m nyra.pairing host | join <6 位配对码>", flush=True)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
