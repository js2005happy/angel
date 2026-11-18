"""运行记录只接受真实事件，私有落盘且不保存模型数据。"""
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from nyra import memory
from nyra.agent import Agent
from nyra.runs import RUN_STATUSES, RunStore, RunRecorder, _redact


class RunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = RunStore(self.root / 'runs')
        for target, value in [('nyra.agent.NYRA_HOME', self.root),
                              ('nyra.memory.SESSIONS_DIR', self.root / 'sessions')]:
            p = patch(target, value)
            p.start()
            self.addCleanup(p.stop)

    def create(self, **kw):
        return self.store.create('任务', 'session', str(self.root), 'auto', 2, **kw)

    def test_status_and_ids(self):
        self.assertEqual(set(RUN_STATUSES), set('queued running awaiting_approval interrupted failed incomplete completed_unverified verified verify_failed'.split()))
        state = self.create()
        for bad in ('done', '', None):
            with self.assertRaises(ValueError):
                self.store.set_status(state['run_id'], bad)
        for bad in ('../escape', 'x', '20260101-000000-ABCDEF'):
            with self.assertRaises(ValueError):
                self.store.load(bad)

    def test_atomic_permissions_and_events(self):
        state = self.create()
        rid = state['run_id']
        path = self.store.base_dir / rid / 'state.json'
        old = path.read_bytes()
        with patch('nyra.runs.os.replace', side_effect=OSError('失败')):
            with self.assertRaises(OSError):
                self.store.update(rid, turn=8)
        self.assertEqual(path.read_bytes(), old)
        self.store.append_event(rid, 'tool_result', id='1', name='read_file', ok=True,
                                arguments='秘密', result='秘密')
        self.assertNotIn('秘密', (path.parent / 'events.jsonl').read_text(encoding='utf-8'))
        if os.name != 'nt':
            for directory in (self.store.base_dir, path.parent):
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            for file in path.parent.iterdir():
                self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)

    def test_symlinks(self):
        state = self.create()
        directory = self.store.base_dir / state['run_id']
        path = directory / 'state.json'
        destination = self.root / 'outside'
        destination.write_text('{}', encoding='utf-8')
        path.unlink()
        try:
            path.symlink_to(destination)
        except OSError:
            self.skipTest('不能创建符号链接')
        with self.assertRaises(ValueError):
            self.store.load(state['run_id'])
        with self.assertRaises(ValueError):
            self.store.update(state['run_id'], turn=1)
        path.unlink()
        (directory / 'events.jsonl').unlink()
        directory.rmdir()
        directory.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.store.load(state['run_id'])

    def test_redaction_and_stale(self):
        for text in ('sk-test-SECRET1234567890abcdef', 'xai-secret123',
                     'Bearer abcdef', 'api_key=abcdef', 'a' * 40):
            self.assertNotIn(text, _redact(text))
        state = self.create()
        with patch('nyra.runs._pid_alive', return_value=False):
            self.assertEqual(self.store.effective_status(state), 'interrupted')
            self.store.mark_stale(state['run_id'])
        self.assertEqual(self.store.load(state['run_id'])['status'], 'interrupted')

    def run_agent(self, responses, max_turns=2, **kwargs):
        class Provider:
            config = {'api_key': 'sk-provider-SECRET1234567890abcdef'}
            def chat(self, messages, tools):
                item = responses.pop(0)
                if isinstance(item, BaseException):
                    raise item
                return {'choices': [{'message': item}]}
        agent = Agent(Provider(), self.root, max_turns=max_turns, skills_dirs=[], **kwargs)
        recorder = RunRecorder(self.store, agent, '任务')
        with patch.object(agent, 'build_system_prompt', return_value='系统'):
            try:
                recorder.run('任务')
            except (KeyboardInterrupt, RuntimeError):
                pass
        return self.store.load(recorder.run_id)

    def test_real_event_statuses(self):
        for responses, expected in [([{'content': '已全部验证通过，改了 fake.py'}], 'completed_unverified'),
                                    ([KeyboardInterrupt()], 'interrupted'),
                                    ([RuntimeError('api_key=secret')], 'failed')]:
            state = self.run_agent(responses)
            self.assertEqual(state['status'], expected)
            self.assertEqual(state['changed_files'], [])
        call = {'id': '1', 'function': {'name': 'read_file', 'arguments': json.dumps({'path': 'sk-test-SECRET1234567890abcdef'})}}
        state = self.run_agent([{'tool_calls': [call]}], max_turns=1)
        self.assertEqual(state['status'], 'incomplete')
        self.assertEqual(state['turn'], 1)
        for path in self.store.base_dir.rglob('*'):
            if path.is_file():
                self.assertNotIn('sk-test-SECRET1234567890abcdef', path.read_text(encoding='utf-8'))
                self.assertNotIn('sk-provider-SECRET1234567890abcdef', path.read_text(encoding='utf-8'))

    def test_callback_chain_and_event_filter(self):
        seen = []
        self.run_agent([{'content': '完成'}], on_event=lambda kind, data: seen.append(kind))
        self.assertEqual(seen, ['final'])
        state = self.create()
        with self.assertRaises(ValueError):
            self.store.append_event(state['run_id'], 'unknown')
        with self.assertRaises(ValueError):
            self.store.update(state['run_id'], provider_config={'api_key': 'secret'})
        self.store.update(state['run_id'], task='api_key=secret', error='Bearer secret')
        raw = (self.store.base_dir / state['run_id'] / 'state.json').read_text(encoding='utf-8')
        self.assertNotIn('secret', raw)

    def test_checkpoint_and_approval(self):
        seen = []
        def approve(name, summary):
            seen.append(self.store.list()[0]['status'])
            return True
        call = {'id': '1', 'function': {'name': 'write_file', 'arguments': json.dumps({'path': 'real.txt', 'content': '内容'})}}
        state = self.run_agent([{'tool_calls': [call]}, {'content': '改了 fake.py'}],
                               interactive=True, approve_fn=approve)
        self.assertEqual(seen, ['awaiting_approval'])
        self.assertEqual(state['changed_files'], ['real.txt'])
        events = [json.loads(x) for x in (self.store.base_dir / state['run_id'] / 'events.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertTrue(any(x.get('from') == 'awaiting_approval' and x.get('to') == 'running' for x in events))


class RunStoreRobustnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = RunStore(self.root / 'runs')
        for target, value in [('nyra.agent.NYRA_HOME', self.root),
                              ('nyra.memory.SESSIONS_DIR', self.root / 'sessions')]:
            p = patch(target, value)
            p.start()
            self.addCleanup(p.stop)

    def create(self, **kw):
        return self.store.create('任务', 'session', str(self.root), 'auto', 2, **kw)

    def test_list_skips_corrupt_record_instead_of_failing(self):
        import io
        from contextlib import redirect_stderr

        good = self.create()
        bad = self.create()
        bad_dir = self.store.base_dir / bad["run_id"]
        (bad_dir / "state.json").write_text("{broken", encoding="utf-8")
        orphan = self.store.base_dir / "20261119-000000-abcdef"
        orphan.mkdir()
        err = io.StringIO()
        with redirect_stderr(err):
            listed = self.store.list()
        self.assertEqual([s["run_id"] for s in listed], [good["run_id"]])
        self.assertIn("跳过损坏的运行记录", err.getvalue())
        # 损坏的记录留在原地供人工检查，没有被删掉。
        self.assertTrue((bad_dir / "state.json").exists())

    def test_tool_result_ok_counts_execution_failure(self):
        from nyra.runs import RunRecorder

        class StubProvider:
            name = "mock"
            model = "mock"

            def chat(self, messages, tools=None, timeout=120):
                return {"choices": [{"message": {"role": "assistant", "content": "done"}}]}

        agent = Agent(StubProvider(), workdir=self.root, mode="readonly",
                      interactive=False, skills_dirs=[])
        recorder = RunRecorder(self.store, agent, "任务")
        try:
            recorder("tool_result", {"id": "1", "name": "shell",
                                     "result": "执行失败：RuntimeError: boom"})
            recorder("tool_result", {"id": "2", "name": "shell",
                                     "result": "错误：拒绝"})
            recorder("tool_result", {"id": "3", "name": "read_file",
                                     "result": "文件内容"})
        finally:
            agent.on_event = recorder.previous
        events = [json.loads(x) for x in
                  (self.store.base_dir / recorder.run_id / "events.jsonl")
                  .read_text(encoding="utf-8").splitlines()]
        by_id = {e.get("id"): e for e in events if e.get("type") == "tool_result"}
        self.assertIs(by_id["1"]["ok"], False)
        self.assertIs(by_id["2"]["ok"], False)
        self.assertIs(by_id["3"]["ok"], True)


class RunVerifyCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workdir = self.root / "work"
        self.workdir.mkdir()

    def _ctx(self, backend=None):
        from nyra.tools import ToolContext

        return ToolContext(
            workdir=self.workdir, mode="full", interactive=False,
            memory_path=self.root / "memory", skills_dir=self.root / "skills",
            backend=backend,
        )

    def test_non_utf8_verify_output_does_not_crash(self):
        import sys as _sys
        from nyra.runs import run_verify_command

        script = self.root / "emit_bytes.py"
        script.write_text(
            "import sys; sys.stdout.buffer.write(b'\\xff\\xfe bad\\n')\n",
            encoding="utf-8",
        )
        result = run_verify_command(
            self._ctx(), f'"{_sys.executable}" "{script}"', timeout=30)
        self.assertEqual(result["exit_code"], 0)
        self.assertTrue(result["passed"])

    def test_backend_output_without_marker_is_not_a_timeout(self):
        from nyra.runs import run_verify_command

        class FakeBackend:
            def run_command(self, command, cwd=None, timeout=None):
                return "命令输出里提到了超时二字，但没有退出码标记\n"

        result = run_verify_command(self._ctx(backend=FakeBackend()),
                                    "true", timeout=30)
        self.assertIsNone(result["exit_code"])
        self.assertFalse(result["passed"])
        self.assertFalse(result.get("timeout"))
