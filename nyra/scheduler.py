"""Nyra 的文件式定时任务调度器。

任务存在 ~/.nyra/schedule.json，支持按固定间隔（every_seconds）或每天
固定时间（at "HH:MM"）运行 Nyra 任务，适合无人值守自动化。
时间处理用 naive 本地时间（datetime.now()），不涉及时区。
"""

import json
import os
import shutil
import tempfile
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from .config import NYRA_HOME
from .console import configure_stdio


SCHEDULE_PATH = NYRA_HOME / "schedule.json"


class ScheduleError(Exception):
    pass


def _validate_task(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ScheduleError("任务缺少有效的 name")

    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ScheduleError("任务缺少有效的 name")

    prompt = raw.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ScheduleError(f"任务 {name} 缺少有效的 prompt")

    every_seconds = raw.get("every_seconds")
    at = raw.get("at")

    if every_seconds is None and at is None:
        raise ScheduleError(f"任务 {name} 需要 every_seconds 或 at")

    if every_seconds is not None:
        if (
            not isinstance(every_seconds, int)
            or isinstance(every_seconds, bool)
            or every_seconds <= 0
        ):
            raise ScheduleError(f"任务 {name} 的 every_seconds 必须是正整数")

    if at is not None:
        if not isinstance(at, str) or re.fullmatch(
            r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", at
        ) is None:
            raise ScheduleError(f"任务 {name} 的 at 必须是 HH:MM 格式")

    mode = raw.get("mode", "auto")
    if mode not in ("readonly", "auto"):
        raise ScheduleError(f"任务 {name} 的 mode 无效（定时任务与队列一样不允许 full）")

    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        enabled = True

    return {
        "name": name,
        "prompt": prompt,
        "provider": raw.get("provider"),
        "profile": raw.get("profile"),
        "model": raw.get("model"),
        "mode": mode,
        "every_seconds": every_seconds,
        "at": at,
        "enabled": enabled,
        "last_run": raw.get("last_run"),
        "last_status": raw.get("last_status"),
        "last_summary": raw.get("last_summary"),
    }


def load_schedule(path: Path | None = None) -> dict:
    path = SCHEDULE_PATH if path is None else Path(path)

    try:
        contents = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {"tasks": []}
    except UnicodeError as exc:
        _backup_corrupt(path)
        raise ScheduleError("schedule.json 格式错误") from exc

    try:
        data = json.loads(contents)
    except (ValueError, RecursionError) as exc:
        _backup_corrupt(path)
        raise ScheduleError("schedule.json 格式错误（已备份为 .corrupt-*）") from exc

    if not isinstance(data, dict):
        _backup_corrupt(path)
        raise ScheduleError("schedule.json 格式错误（已备份为 .corrupt-*）")

    raw_tasks = data.get("tasks", [])
    if not isinstance(raw_tasks, list):
        raw_tasks = []

    tasks = []
    names = set()
    for raw in raw_tasks:
        try:
            task = _validate_task(raw)
            name = task["name"]
            if name in names:
                raise ScheduleError(f"已存在同名定时任务：{name}")
        except ScheduleError as exc:
            print(f"跳过无效定时任务：{exc}", file=sys.stderr)
            continue

        tasks.append(task)
        names.add(name)

    return {"tasks": tasks}


def save_schedule(data: dict, path: Path | None = None) -> Path:
    path = SCHEDULE_PATH if path is None else Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 原子写：先写同目录临时文件再 os.replace，崩溃/并发时不会留下半截 JSON。
    fd, tmp_name = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(data, indent=2, ensure_ascii=False))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return path


def _backup_corrupt(path: Path) -> None:
    """损坏的 schedule.json 先备份成 .corrupt-<时间戳>，避免下次保存时被覆盖丢失。"""
    try:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, path.with_name(f"{path.name}.corrupt-{stamp}"))
    except OSError:
        pass


def add_task(data: dict, task: dict) -> dict:
    cleaned = _validate_task(task)
    name = cleaned["name"]
    tasks = data.setdefault("tasks", [])

    if any(existing.get("name") == name for existing in tasks):
        raise ScheduleError(f"已存在同名定时任务：{name}")

    tasks.append(cleaned)
    return data


def remove_task(data: dict, name: str) -> bool:
    tasks = data.get("tasks", [])
    for index, task in enumerate(tasks):
        if task.get("name") == name:
            del tasks[index]
            return True
    return False


def list_tasks(data: dict) -> list[dict]:
    return list(data.get("tasks", []))


def is_due(task: dict, now: datetime) -> bool:
    if task.get("enabled", True) is False:
        return False

    every_seconds = task.get("every_seconds")
    if every_seconds is not None:
        last_run = task.get("last_run")
        if last_run is None:
            return True
        try:
            last_run = datetime.fromisoformat(last_run)
        except (TypeError, ValueError, OverflowError):
            return True
        return (now - last_run).total_seconds() >= every_seconds

    at = task.get("at")
    if at is None:
        return False

    hour, minute = map(int, at.split(":"))
    scheduled_time = now.replace(
        hour=hour,
        minute=minute,
        second=0,
        microsecond=0,
    )

    # 每天固定时间的任务：还没到今天的执行时间就不到期（即使从未运行过）。
    if now < scheduled_time:
        return False

    last_run = task.get("last_run")
    if last_run is None:
        return True
    try:
        last_run = datetime.fromisoformat(last_run)
    except (TypeError, ValueError, OverflowError):
        return True
    if last_run.date() == now.date():
        return False
    return True


def due_tasks(data: dict, now: datetime | None = None) -> list[dict]:
    if now is None:
        now = datetime.now()
    return [task for task in data.get("tasks", []) if is_due(task, now)]


def run_due_tasks(
    data: dict, agent_factory, now: datetime | None = None
) -> list[dict]:
    if now is None:
        now = datetime.now()

    results = []
    for task in due_tasks(data, now):
        name = task["name"]
        try:
            summary = agent_factory(task)[:200]
            status = "ok"
        except Exception as exc:
            summary = f"失败：{exc}"[:200]
            status = "error"

        task["last_run"] = now.isoformat()
        task["last_status"] = status
        task["last_summary"] = summary
        results.append(
            {
                "name": name,
                "status": status,
                "summary": summary,
            }
        )

    return results


def run_daemon(
    agent_factory,
    interval: float = 60.0,
    path: Path | None = None,
    stop_after: int | None = None,
) -> int:
    configure_stdio()
    rounds = 0

    try:
        while stop_after is None or rounds < stop_after:
            try:
                data = load_schedule(path)
            except (ScheduleError, OSError) as exc:
                print(f"加载定时任务失败：{exc}", file=sys.stderr)
                data = {"tasks": []}

            results = run_due_tasks(data, agent_factory)
            save_schedule(data, path)

            for result in results:
                name = result["name"]
                status = result["status"]
                summary = result["summary"][:100]
                print(
                    f"[定时任务] {name}：{status} - {summary}",
                    flush=True,
                )

            rounds += 1
            if stop_after is not None and rounds >= stop_after:
                break
            time.sleep(interval)
    except KeyboardInterrupt:
        print("定时任务守护进程已停止", flush=True)

    return rounds
