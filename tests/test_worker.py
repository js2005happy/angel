"""Worker：审批等待有绝对截止时间；启动期 stdout 断开时干净退出。"""

import io
import json
import time
import unittest
from unittest import mock

import nyra.worker as worker_module
from nyra.worker import Worker, WorkerEmitter


class PingFloodIO:
    """Every read returns a ping instantly, never a decision, never Empty."""

    def __init__(self):
        self.reads = 0

    def read(self, timeout=None):
        self.reads += 1
        return {"type": "ping", "id": "req-ping"}


class ApprovalDeadlineTests(unittest.TestCase):
    def test_ping_flood_cannot_extend_approval_forever(self):
        stdout = io.StringIO()
        worker = Worker(agent=None, emitter=WorkerEmitter(stdout),
                        io=PingFloodIO(), approval_timeout=0.3)
        started = time.monotonic()
        approved = worker.approve_fn("write_file", "写文件")
        elapsed = time.monotonic() - started
        self.assertIs(approved, False)
        self.assertLess(elapsed, 5.0)
        self.assertGreater(worker.io.reads, 1)  # ping 洪水确实到达过
        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        results = [e for e in events if e["type"] == "approval_result"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["reason"], "timeout")
        self.assertIs(results[0]["approved"], False)

    def test_tool_result_execution_failure_is_not_ok(self):
        stdout = io.StringIO()
        worker = Worker(agent=None, emitter=WorkerEmitter(stdout),
                        io=PingFloodIO())
        worker._run_id = "req-1"
        worker.on_agent_event("tool_result", {
            "id": "c1", "name": "shell", "result": "执行失败：boom"})
        worker.on_agent_event("tool_result", {
            "id": "c2", "name": "read_file", "result": "内容"})
        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        by_id = {e["tool_call_id"]: e for e in events
                 if e["type"] == "tool_result"}
        self.assertIs(by_id["c1"]["ok"], False)
        self.assertIs(by_id["c2"]["ok"], True)


class BrokenStdout(io.StringIO):
    def reconfigure(self, *args, **kwargs):
        pass

    def write(self, *args, **kwargs):
        raise BrokenPipeError("host is gone")

    def flush(self):
        raise BrokenPipeError("host is gone")


class StartupFailureTests(unittest.TestCase):
    def test_broken_stdout_during_startup_error_exits_cleanly(self):
        broken = BrokenStdout()
        with mock.patch.object(worker_module, "load_config", return_value={}), \
                mock.patch.object(worker_module.sys, "stdout", broken), \
                mock.patch.object(worker_module.sys, "stdin", io.StringIO("")), \
                mock.patch.object(worker_module.sys, "stderr", io.StringIO()):
            code = worker_module.main(["--mode", "bogus"])
        self.assertEqual(code, worker_module.EXIT_SUCCESS)


if __name__ == "__main__":
    unittest.main()
