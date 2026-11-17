"""后台任务队列：只由 CLI 用户入队，worker 遇到审批就停，绝不自动放行。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import time

from . import memory
from .agent import Agent, AgentError
from .config import NYRA_HOME, load_config, resolve_profile, resolve_provider, validate_mode
from .providers import Provider
from .runs import (
    ApprovalRequired,
    RunNotResumable,
    RunRecorder,
    RunStore,
    _private,
    _redact,
    format_run_report,
    prepare_resume,
    resolve_verify_command,
    resolve_verify_settings,
)

WORKER_LOCK = "worker.lock"
INBOX_NAME = "inbox.jsonl"


class TaskError(ValueError):
    """用户可见的任务队列错误。"""


class WorkerLock:
    """跨平台互斥锁：同一时刻只允许一个 worker。"""

    def __init__(self, path: Path):
        self.path = path
        self.fd = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_CREAT | os.O_RDWR
        if hasattr(os, "O_NOFOLLOW"):
            # 锁文件若是符号链接则拒绝。
            try:
                self.fd = os.open(self.path, flags | os.O_NOFOLLOW, 0o600)
            except OSError:
                if self.path.is_symlink():
                    raise TaskError("worker 锁文件不能是符号链接")
                self.fd = os.open(self.path, flags, 0o600)
        else:
            if self.path.is_symlink():
                raise TaskError("worker 锁文件不能是符号链接")
            self.fd = os.open(self.path, flags, 0o600)
        _private(self.path, 0o600)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self.fd)
            self.fd = None
            return False
        return True

    def release(self) -> None:
        if self.fd is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(self.fd)
        finally:
            self.fd = None

    def __enter__(self):
        if not self.acquire():
            raise TaskError("已有 worker 在运行")
        return self

    def __exit__(self, *exc):
        self.release()
        return False


def _store(base_dir=None) -> RunStore:
    return RunStore(base_dir if base_dir is not None else NYRA_HOME / "runs")


def add_task(task, *, workdir=".", mode="auto", verify_cmd=None, max_turns=20, store=None, config=None):
    """由 CLI / 调度器入队。模型工具不得调用本函数。"""
    if not isinstance(task, str) or not task.strip():
        raise TaskError("任务内容不能为空")
    if mode not in ("readonly", "auto"):
        raise TaskError("任务队列只允许 --mode readonly 或 auto，需审批的操作会进入 awaiting_approval")
    root = Path(workdir).resolve()
    if not root.is_dir():
        raise TaskError("工作目录不存在")
    store = store or _store()
    session_id = memory.new_session_id()
    memory.save_session(session_id, [{"role": "user", "content": task}])
    frozen = resolve_verify_command(verify_cmd, config, root)
    return store.create(
        task, session_id, root, mode, max_turns, status="queued", verify_cmd=frozen,
    )


def cancel_task(run_id, store=None):
    store = store or _store()
    state = store.load(run_id)
    if state["status"] != "queued":
        raise TaskError(f"只能取消排队中的任务，当前状态为 {state['status']}")
    return store.set_status(run_id, "interrupted", error="已取消")


def list_tasks(store=None):
    store = store or _store()
    result = []
    for state in store.list():
        try:
            state = store.mark_stale(state["run_id"])
        except (ValueError, OSError):
            pass
        result.append(state)
    return result


def show_task(run_id, store=None, event_limit=20):
    store = store or _store()
    state = store.mark_stale(run_id)
    events = []
    path = store.base_dir / run_id / "events.jsonl"
    if path.is_file() and not path.is_symlink():
        lines = path.read_text(encoding="utf-8").splitlines()
        for line in lines[-event_limit:]:
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return state, events


def append_inbox(run_id, status, summary, home=None):
    home = Path(home) if home is not None else NYRA_HOME
    home.mkdir(parents=True, exist_ok=True)
    _private(home, 0o700)
    path = home / INBOX_NAME
    if path.is_symlink():
        raise TaskError("inbox 不能是符号链接")
    entry = {
        "run_id": run_id,
        "status": status,
        "summary": _redact(str(summary)[:200]),
        "read": False,
        "at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as handle:
        _private(path, 0o600)
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def load_inbox(home=None, unread_only=False):
    home = Path(home) if home is not None else NYRA_HOME
    path = home / INBOX_NAME
    if not path.is_file() or path.is_symlink():
        return []
    items = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict) and (not unread_only or not item.get("read")):
            items.append(item)
    return items


def mark_inbox_read(home=None):
    home = Path(home) if home is not None else NYRA_HOME
    path = home / INBOX_NAME
    items = load_inbox(home)
    if not items or not any(not i.get("read") for i in items):
        return 0
    import tempfile

    counted = 0
    fd, temp = tempfile.mkstemp(prefix=".inbox-", dir=home)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for item in items:
                if not item.get("read"):
                    item["read"] = True
                    counted += 1
                handle.write(json.dumps(item, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        _private(temp, 0o600)
        os.replace(temp, path)
        _private(path, 0o600)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return counted


def format_unread_inbox(home=None) -> str:
    items = load_inbox(home, unread_only=True)
    if not items:
        return ""
    lines = [f"未读任务通知（{len(items)}）："]
    for item in items:
        lines.append(f"- {item.get('run_id')}  {item.get('status')}  {item.get('summary', '')}")
    return "\n".join(lines)


def _defer_approval(tool, summary):
    raise ApprovalRequired(tool, summary)


def _build_provider(config=None):
    config = config if config is not None else load_config()
    profile = resolve_profile(None, config)
    provider = Provider(resolve_provider(profile["provider"], profile["model"]))
    if not provider.has_credentials():
        raise TaskError("当前模型没有可用凭证")
    return provider, config


def run_one(state, *, store, provider, config=None, resume=False, interactive=False, approve_fn=None):
    """执行或续跑一条已入队的任务。"""
    timeout, retries = resolve_verify_settings(None, None, config)
    messages = memory.load_session(state["session_id"]) or []
    defer = approve_fn if approve_fn is not None else (_defer_approval if not interactive else None)
    # 使用 approve_fn 拦截审批时必须 interactive=True，否则 auto 会在询问前直接拒绝。
    agent = Agent(
        provider,
        workdir=state["workdir"],
        mode=state["mode"],
        max_turns=state["max_turns"],
        session_id=state["session_id"],
        messages=messages,
        interactive=True if defer is not None else interactive,
        approve_fn=defer,
        skills_dirs=[],
    )
    recorder = RunRecorder(
        store, agent, state["task"], state=state,
        verify_timeout=timeout, verify_retries=retries,
    )
    try:
        output = recorder.run(state["task"])
        final = store.load(recorder.run_id)
        append_inbox(final["run_id"], final["status"], output)
        return final, output
    except ApprovalRequired:
        final = store.load(recorder.run_id)
        pending = final.get("pending_approval") or {}
        note = f"等待审批：{pending.get('tool', '')}"
        append_inbox(final["run_id"], "awaiting_approval", note)
        return final, note


def worker_once(store=None, provider=None, config=None):
    """按创建时间顺序执行当前排队任务，一次一个。"""
    store = store or _store()
    provider = provider or _build_provider(config)[0]
    processed = []
    while True:
        queued = [s for s in reversed(list_tasks(store)) if s["status"] == "queued"]
        if not queued:
            break
        state = store.claim(queued[0]["run_id"])
        final, output = run_one(state, store=store, provider=provider, config=config, interactive=False)
        processed.append((final, output))
    return processed


def approve_task(run_id, *, store=None, provider=None, config=None):
    store = store or _store()
    state = store.mark_stale(run_id)
    if state["status"] != "awaiting_approval":
        raise TaskError(f"只能批准处于 awaiting_approval 的任务，当前状态为 {state['status']}")
    store.update(run_id, pending_approval=None)
    state, messages, count = prepare_resume(store, run_id)
    provider = provider or _build_provider(config)[0]
    timeout, retries = resolve_verify_settings(None, None, config)
    agent = Agent(
        provider,
        workdir=state["workdir"],
        mode=state["mode"],
        max_turns=state["max_turns"],
        session_id=state["session_id"],
        messages=messages,
        interactive=True,
        skills_dirs=[],
    )
    recorder = RunRecorder(
        store, agent, state["task"], state=state, interrupted_tool_calls=count,
        verify_timeout=timeout, verify_retries=retries,
    )
    output = recorder.run(state["task"])
    final = store.load(recorder.run_id)
    append_inbox(final["run_id"], final["status"], output)
    return final, output


def handle_task(argv, workdir: Path) -> int:
    """处理 `nyra task <add|list|show|cancel|worker|approve>`。"""
    if not argv:
        print("用法：nyra task <add|list|show|cancel|worker|approve> [选项]")
        return 2
    action = argv[0]
    store = _store()

    if action == "add":
        import argparse
        parser = argparse.ArgumentParser(prog="nyra task add")
        parser.add_argument("task", help="任务内容")
        parser.add_argument("--workdir", default=str(workdir))
        parser.add_argument("--verify", default=None)
        parser.add_argument("--mode", choices=("readonly", "auto"), default="auto")
        parser.add_argument("--max-turns", type=int, default=None)
        args = parser.parse_args(argv[1:])
        config = load_config()
        max_turns = args.max_turns if args.max_turns is not None else config.get("max_turns") or 20
        try:
            state = add_task(
                args.task, workdir=args.workdir, mode=args.mode,
                verify_cmd=args.verify, max_turns=max_turns, store=store, config=config,
            )
        except TaskError as exc:
            print(f"错误：{exc}", file=sys.stderr)
            return 2
        print(state["run_id"])
        return 0

    if action == "list":
        for state in list_tasks(store):
            preview = state["task"].replace("\n", " ")[:60]
            print(f"{state['run_id']}  {state['status']}  {preview}")
        return 0

    if action == "show":
        import argparse
        parser = argparse.ArgumentParser(prog="nyra task show")
        parser.add_argument("run_id")
        args = parser.parse_args(argv[1:])
        try:
            state, events = show_task(args.run_id, store)
        except (ValueError, OSError) as exc:
            print(f"错误：{exc}", file=sys.stderr)
            return 2
        print(json.dumps({"state": state, "events": events}, ensure_ascii=False, indent=2))
        return 0

    if action == "cancel":
        import argparse
        parser = argparse.ArgumentParser(prog="nyra task cancel")
        parser.add_argument("run_id")
        args = parser.parse_args(argv[1:])
        try:
            cancel_task(args.run_id, store)
        except (TaskError, ValueError, OSError) as exc:
            print(f"错误：{exc}", file=sys.stderr)
            return 2
        print(f"已取消 {args.run_id}")
        return 0

    if action == "worker":
        import argparse
        parser = argparse.ArgumentParser(prog="nyra task worker")
        parser.add_argument("--once", action="store_true", help="处理完当前队列后退出")
        parser.add_argument("--interval", type=float, default=2.0)
        args = parser.parse_args(argv[1:])
        lock = WorkerLock(store.base_dir / WORKER_LOCK)
        if not lock.acquire():
            print("错误：已有 worker 在运行", file=sys.stderr)
            return 1
        try:
            while True:
                try:
                    provider, config = _build_provider()
                    processed = worker_once(store=store, provider=provider, config=config)
                    for final, output in processed:
                        print(f"{final['run_id']}  {final['status']}  {str(output).splitlines()[0][:80]}")
                except TaskError as exc:
                    print(f"错误：{exc}", file=sys.stderr)
                    if args.once:
                        return 1
                if args.once:
                    return 0
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print("worker 已停止")
            return 0
        finally:
            lock.release()

    if action == "approve":
        import argparse
        parser = argparse.ArgumentParser(prog="nyra task approve")
        parser.add_argument("run_id")
        args = parser.parse_args(argv[1:])
        try:
            final, output = approve_task(args.run_id, store=store)
        except (TaskError, RunNotResumable, ValueError, AgentError, OSError) as exc:
            print(f"错误：{exc}", file=sys.stderr)
            return 2
        print(output)
        return 0 if final["status"] != "verify_failed" else 4

    print(f"错误：未知子命令 task {action}", file=sys.stderr)
    return 2
