"""后台任务队列：审批停下、单 worker 锁、定时任务入队。"""
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
import unittest
from unittest.mock import patch

from nyra import memory
from nyra.runs import RunStore, ApprovalRequired
from nyra.tasks import (
    add_task, approve_task, cancel_task, list_tasks, show_task,
    worker_once, WorkerLock, append_inbox, load_inbox, format_unread_inbox,
    mark_inbox_read, handle_task, TaskError,
)


class TaskQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.workdir = self.root / "work"
        self.workdir.mkdir()
        self.store = RunStore(self.home / "runs")
        for target, value in [
            ("nyra.tasks.NYRA_HOME", self.home),
            ("nyra.runs.NYRA_HOME", self.home),
            ("nyra.agent.NYRA_HOME", self.home),
            ("nyra.memory.SESSIONS_DIR", self.home / "sessions"),
        ]:
            p = patch(target, value)
            p.start()
            self.addCleanup(p.stop)

    def test_add_list_cancel_and_mode(self):
        state = add_task("整理文件", workdir=self.workdir, store=self.store)
        self.assertEqual(state["status"], "queued")
        self.assertEqual(list_tasks(self.store)[0]["run_id"], state["run_id"])
        shown, events = show_task(state["run_id"], self.store)
        self.assertEqual(shown["status"], "queued")
        self.assertTrue(events)
        cancel_task(state["run_id"], self.store)
        self.assertEqual(self.store.load(state["run_id"])["status"], "interrupted")
        with self.assertRaises(TaskError):
            cancel_task(state["run_id"], self.store)
        with self.assertRaises(TaskError):
            add_task("x", workdir=self.workdir, mode="full", store=self.store)

    def test_worker_stops_for_approval_and_continues(self):
        target = self.workdir / "secret.txt"
        add_task("请写文件", workdir=self.workdir, store=self.store)
        add_task("只打招呼", workdir=self.workdir, store=self.store)

        class Provider:
            def chat(self, messages, tools):
                blob = json.dumps(messages, ensure_ascii=False)
                if "请写文件" in blob and not any(m.get("role") == "tool" for m in messages):
                    return {"choices": [{"message": {"tool_calls": [{
                        "id": "w1",
                        "function": {"name": "write_file", "arguments": json.dumps({
                            "path": "secret.txt", "content": "不应写入",
                        })},
                    }]}}]}
                return {"choices": [{"message": {"content": "你好"}}]}

        processed = worker_once(store=self.store, provider=Provider(), config={})
        statuses = {item[0]["task"]: item[0]["status"] for item in processed}
        self.assertEqual(statuses["请写文件"], "awaiting_approval")
        self.assertEqual(statuses["只打招呼"], "completed_unverified")
        self.assertFalse(target.exists())
        waiting = [s for s in list_tasks(self.store) if s["status"] == "awaiting_approval"][0]
        self.assertEqual(waiting["pending_approval"]["tool"], "write_file")
        # 队列里下一项已跑完，写操作没有落地。
        inbox = load_inbox(self.home)
        self.assertTrue(any(i["status"] == "awaiting_approval" for i in inbox))
        self.assertTrue(any(i["status"] == "completed_unverified" for i in inbox))

    def test_awaiting_approval_survives_worker_exit(self):
        """worker 退出后 list/show 不得把等审批的任务改成 interrupted。"""
        add_task("请写文件", workdir=self.workdir, store=self.store)

        class Provider:
            def chat(self, messages, tools):
                if not any(m.get("role") == "tool" for m in messages):
                    return {"choices": [{"message": {"tool_calls": [{
                        "id": "w1",
                        "function": {"name": "write_file", "arguments": json.dumps({
                            "path": "x.txt", "content": "x",
                        })},
                    }]}}]}
                return {"choices": [{"message": {"content": "好"}}]}

        processed = worker_once(store=self.store, provider=Provider(), config={})
        run_id = processed[0][0]["run_id"]
        self.assertEqual(processed[0][0]["status"], "awaiting_approval")
        with patch("nyra.runs._pid_alive", return_value=False):
            self.assertEqual(list_tasks(self.store)[0]["status"], "awaiting_approval")
            shown, _ = show_task(run_id, self.store)
            self.assertEqual(shown["status"], "awaiting_approval")
            self.assertEqual(self.store.load(run_id)["status"], "awaiting_approval")
            # 交互式运行（无 pending_approval）进程死了仍判为 interrupted。
            self.store.update(run_id, pending_approval=None)
            self.assertEqual(list_tasks(self.store)[0]["status"], "interrupted")

    def test_worker_lock_exclusive(self):
        lock_path = self.home / "runs" / "worker.lock"
        first = WorkerLock(lock_path)
        self.assertTrue(first.acquire())
        second = WorkerLock(lock_path)
        self.assertFalse(second.acquire())
        first.release()
        self.assertTrue(second.acquire())
        second.release()
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(lock_path.stat().st_mode), 0o600)

    def test_inbox_permissions_and_unread(self):
        append_inbox("20260101-000000-abc123", "verified", "api_key=secret-token", home=self.home)
        path = self.home / "inbox.jsonl"
        raw = path.read_text(encoding="utf-8")
        self.assertNotIn("secret-token", raw)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        text = format_unread_inbox(self.home)
        self.assertIn("20260101-000000-abc123", text)
        mark_inbox_read(self.home)
        self.assertFalse(format_unread_inbox(self.home))

    def test_handle_task_cli_and_no_model_tool(self):
        import inspect
        import nyra.tools as toolmod
        source = inspect.getsource(toolmod.execute_tool)
        self.assertNotIn("task_add", source)
        self.assertNotIn("add_task", source)
        from nyra.agent import Agent
        class _P:
            def chat(self, messages, tools):
                return {"choices": [{"message": {"content": "x"}}]}
        names = [t["function"]["name"] for t in Agent(_P(), self.workdir, skills_dirs=[]).tool_schemas()]
        self.assertFalse(any(n == "task_add" or n.startswith("task_") for n in names))

        class Provider:
            def chat(self, messages, tools):
                return {"choices": [{"message": {"content": "好了"}}]}

            def has_credentials(self):
                return True

        with patch("nyra.tasks._build_provider", return_value=(Provider(), {})), \
             patch("nyra.tasks.load_config", return_value={"max_turns": 3, "sandbox": "local"}):
            code = handle_task(["add", "来自命令行", "--workdir", str(self.workdir)], self.workdir)
        self.assertEqual(code, 0)
        self.assertEqual(list_tasks(self.store)[0]["status"], "queued")

    def test_schedule_enqueues(self):
        from nyra.cli import _run_scheduled_task
        text = _run_scheduled_task({"prompt": "定时清理", "mode": "full"}, self.workdir)
        self.assertTrue(text.startswith("已入队 "))
        state = list_tasks(self.store)[0]
        self.assertEqual(state["status"], "queued")
        self.assertEqual(state["mode"], "auto")
        self.assertEqual(state["task"], "定时清理")

    def test_approve_uses_resume_and_asks_again(self):
        add_task("请写文件", workdir=self.workdir, store=self.store)

        def write_call(cid):
            return {"choices": [{"message": {"tool_calls": [{
                "id": cid,
                "function": {"name": "write_file", "arguments": json.dumps({
                    "path": "ok.txt", "content": "允许",
                })},
            }]}}]}

        class Provider:
            def chat(self, messages, tools):
                if any(m.get("role") == "tool" and "已写入" in str(m.get("content")) for m in messages):
                    return {"choices": [{"message": {"content": "写完了"}}]}
                if any("结果未知" in str(m.get("content")) for m in messages):
                    return write_call("w2")
                if not any(m.get("role") == "tool" for m in messages):
                    return write_call("w1")
                return {"choices": [{"message": {"content": "写完了"}}]}

        provider = Provider()
        worker_once(store=self.store, provider=provider, config={})
        state = [s for s in list_tasks(self.store) if s["status"] == "awaiting_approval"][0]
        # 前台批准：重新询问，不沿用任何缓存。
        asked = []

        def approve(name, summary):
            asked.append(name)
            return True

        # approve_task builds its own agent; hook via Agent constructor wrap is heavy.
        # 直接走 prepare_resume + 新 Agent 验证审批集合为空，再用 approve_fn 跑完。
        from nyra.runs import prepare_resume
        from nyra.agent import Agent
        from nyra.runs import RunRecorder
        cleared = self.store.update(state["run_id"], pending_approval=None)
        resumed, messages, count = prepare_resume(self.store, state["run_id"])
        agent = Agent(provider, self.workdir, mode="auto", session_id=resumed["session_id"],
                      messages=messages, interactive=True, approve_fn=approve, skills_dirs=[],
                      max_turns=resumed["max_turns"])
        self.assertFalse(agent.ctx.approved_file_tools)
        recorder = RunRecorder(self.store, agent, resumed["task"], state=resumed, interrupted_tool_calls=count)
        with patch.object(agent, "build_system_prompt", return_value="系统"):
            recorder.run(resumed["task"])
        self.assertEqual(asked, ["write_file"])
        self.assertEqual(self.store.load(state["run_id"])["status"], "completed_unverified")
        self.assertTrue((self.workdir / "ok.txt").exists())


if __name__ == "__main__":
    unittest.main()
