"""断点续跑保持未知副作用和审批边界。"""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from pathlib import Path
import tempfile

from nyra import memory
from nyra.agent import Agent
from nyra.runs import RunRecorder, RunStore


class ResumeTests(unittest.TestCase):
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

    def test_failed_tool_and_interrupt_resume(self):
        from nyra.runs import prepare_resume
        for failure in (RuntimeError('中断'), KeyboardInterrupt()):
            class Provider:
                def chat(self, messages, tools):
                    return {'choices': [{'message': {'tool_calls': [
                        {'id': '未知', 'function': {'name': 'write_file', 'arguments': '{}'}}]}}]}
            first = Agent(Provider(), self.root, skills_dirs=[])
            first.ctx.approved_file_tools.add('write_file')
            first.ctx.approved_shell_commands.add('echo 旧审批')
            recorder = RunRecorder(self.store, first, '原任务')
            with patch.object(first, 'build_system_prompt', return_value='系统'), patch('nyra.agent.execute_tool', side_effect=failure) as execute:
                with self.assertRaises(type(failure)):
                    recorder.run('原任务')
                self.assertEqual(execute.call_count, 1)
            state = self.store.load(recorder.run_id)
            self.assertEqual(state['status'], 'interrupted' if isinstance(failure, KeyboardInterrupt) else 'failed')
            state, messages, count = prepare_resume(self.store, recorder.run_id)
            self.assertEqual(count, 1)
            self.assertEqual(messages[-1]['content'], '中断：该调用结果未知（可能已部分执行）。请先核实当前状态再决定是否重做。')
            seen = []
            class FinalProvider:
                def chat(self, history, tools):
                    seen.extend(history)
                    return {'choices': [{'message': {'content': '完成'}}]}
            agent = Agent(FinalProvider(), self.root, session_id=state['session_id'], messages=messages, skills_dirs=[])
            self.assertFalse(agent.ctx.approved_file_tools)
            self.assertFalse(agent.ctx.approved_shell_commands)
            resumed = RunRecorder(self.store, agent, state['task'], state=state, interrupted_tool_calls=count)
            with patch.object(agent, 'build_system_prompt', return_value='系统') as system, patch('nyra.agent.execute_tool') as execute:
                self.assertIn('完成', resumed.run(state['task']))
                execute.assert_not_called()
                system.assert_called_once_with('原任务')
            self.assertEqual(sum(m['role'] == 'user' for m in seen), 1)
            final = self.store.load(recorder.run_id)
            self.assertEqual(final['status'], 'completed_unverified')
            self.assertEqual(final['turn'], 2)
            self.assertEqual(len(memory.load_session(state['session_id'])), 4)

    def test_status_mode_workdir_and_stale(self):
        from nyra.runs import prepare_resume
        state = self.create(status='failed')
        rid = state['run_id']
        memory.save_session('session', [{'role': 'user', 'content': '任务'}])
        for status in ('verified', 'completed_unverified', 'queued', 'running'):
            self.store.set_status(rid, status)
            with self.assertRaises(ValueError):
                prepare_resume(self.store, rid)
        with patch('nyra.runs._pid_alive', return_value=False):
            loaded, _, _ = prepare_resume(self.store, rid)
        self.assertEqual(loaded['status'], 'interrupted')
        self.assertEqual(prepare_resume(self.store, rid)[0]['mode'], 'auto')
        with self.assertRaises(ValueError):
            prepare_resume(self.store, rid, workdir=self.root / 'other')
        loaded, _, _ = prepare_resume(self.store, rid, mode='full')
        self.assertEqual(loaded['mode'], 'full')
        events = (self.store.base_dir / rid / 'events.jsonl').read_text(encoding='utf-8')
        self.assertIn('mode_override', events)

    def test_approvals_are_requested_again(self):
        from nyra.runs import prepare_resume
        from nyra.tools import execute_tool
        class Provider:
            def chat(self, messages, tools):
                return {'choices': [{'message': {'content': '完成'}}]}
        first = Agent(Provider(), self.root, interactive=True, skills_dirs=[])
        args = {'path': '审批.txt', 'content': '内容'}
        with patch('builtins.input', return_value='a') as approve:
            execute_tool('write_file', args, first.ctx)
            execute_tool('shell', {'command': 'echo approval'}, first.ctx)
            self.assertEqual(approve.call_count, 2)
        self.assertTrue(first.ctx.approved_file_tools)
        self.assertTrue(first.ctx.approved_shell_commands)
        memory.save_session(first.session_id, [{'role': 'user', 'content': '原任务'}])
        state = self.store.create('原任务', first.session_id, self.root, 'auto', 3, status='incomplete')
        state, messages, count = prepare_resume(self.store, state['run_id'])
        resumed = Agent(Provider(), self.root, interactive=True, session_id=state['session_id'], messages=messages, skills_dirs=[])
        recorder = RunRecorder(self.store, resumed, state['task'], state=state, interrupted_tool_calls=count)
        with patch('builtins.input', return_value='y') as approve:
            execute_tool('write_file', args, resumed.ctx)
            execute_tool('shell', {'command': 'echo approval'}, resumed.ctx)
            self.assertEqual(approve.call_count, 2)
        raw = (self.store.base_dir / recorder.run_id / 'state.json').read_text(encoding='utf-8')
        self.assertNotIn('approved_', raw)

    def test_repair_keeps_known_results_and_final_turn(self):
        from nyra.runs import prepare_resume
        calls = [{'id': str(n), 'function': {'name': 'read_file', 'arguments': '{}'}} for n in (1, 2)]
        state = self.create(status='failed')
        memory.save_session('session', [{'role': 'assistant', 'tool_calls': calls},
                                       {'role': 'tool', 'tool_call_id': '1', 'content': '已知'}])
        state, messages, count = prepare_resume(self.store, state['run_id'])
        self.assertEqual(count, 1)
        self.assertEqual(sum(m.get('content') == '已知' for m in messages), 1)
        self.assertEqual([m.get('tool_call_id') or m.get('role') for m in messages],
                         ['assistant', '1', '2'])
        self.assertEqual(messages[1]['content'], '已知')
        self.assertIn('结果未知', messages[2]['content'])
        self.assertEqual(prepare_resume(self.store, state['run_id'])[2], 0)
        memory.save_session('session', [{'role': 'assistant', 'content': '尚未落盘完成事件'}])
        state, messages, _ = prepare_resume(self.store, state['run_id'])
        histories = []
        class Provider:
            def chat(self, history, tools):
                histories.extend(history)
                return {'choices': [{'message': {'content': '完成'}}]}
        agent = Agent(Provider(), self.root, messages=messages, session_id='session', skills_dirs=[])
        with patch.object(agent, 'build_system_prompt', return_value='系统'):
            RunRecorder(self.store, agent, '任务', state=state).run('任务')
        self.assertEqual(histories[-1]['content'], '（续跑）请继续完成原任务；先核实当前状态。')


class ResumeCLITests(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for target, value in [('nyra.agent.NYRA_HOME', self.root),
                              ('nyra.cli.NYRA_HOME', self.root),
                              ('nyra.runs.NYRA_HOME', self.root),
                              ('nyra.memory.SESSIONS_DIR', self.root / 'sessions')]:
            p = patch(target, value)
            p.start()
            self.addCleanup(p.stop)
        from nyra.runs import RunStore
        self.store = RunStore(self.root / 'runs')

    def invoke(self, argv, replies=None, profile_mode='full'):
        import io
        from contextlib import ExitStack, redirect_stdout, redirect_stderr
        from nyra import cli, json_mode
        from tests.test_json_mode import FakeProvider, assistant
        provider = FakeProvider(replies or [assistant('完成')])
        out, err = io.StringIO(), io.StringIO()
        with ExitStack() as stack:
            stack.enter_context(redirect_stdout(out))
            stack.enter_context(redirect_stderr(err))
            for module in (cli, json_mode):
                stack.enter_context(patch.object(module, 'load_config', return_value={'sandbox': 'local'}))
                stack.enter_context(patch.object(module, 'resolve_profile', return_value={'mode': profile_mode, 'provider': None, 'model': None}))
                stack.enter_context(patch.object(module, 'resolve_provider', return_value=SimpleNamespace(name='mock', model='fake-model')))
                stack.enter_context(patch.object(module, 'Provider', return_value=provider))
                stack.enter_context(patch.object(module, 'build_mcp_manager', return_value=None))
            stack.enter_context(patch.object(Agent, 'build_system_prompt', return_value='系统'))
            code = cli.main(argv)
        return code, out.getvalue(), err.getvalue()

    def create(self, status='failed'):
        memory.save_session('session', [{'role': 'user', 'content': '原任务'}])
        return self.store.create('原任务', 'session', self.root, 'auto', 3, status=status)['run_id']

    def test_json_and_plain_resume_mode_and_events(self):
        for json_flag in ([], ['--json']):
            rid = self.create()
            self.store.update(rid, turn=4, changed_files=['旧文件.txt'])
            code, out, err = self.invoke(json_flag + ['--resume-run', rid])
            self.assertEqual(code, 0, err + out)
            state = self.store.load(rid)
            self.assertEqual(state['mode'], 'auto')
            self.assertEqual(state['max_turns'], 3)
            self.assertEqual(state['turn'], 5)
            self.assertEqual(state['changed_files'], ['旧文件.txt'])
            if json_flag:
                events = [json.loads(line) for line in out.splitlines()]
                self.assertEqual(events[0]['type'], 'run_resumed')
                self.assertEqual(events[0]['turn'], 4)
                self.assertEqual(events[-1]['type'], 'run_state')
                self.assertEqual(events[-1]['status'], 'completed_unverified')
                self.assertNotIn('run_started', [e['type'] for e in events])
            else:
                self.assertTrue(out.startswith('完成'))
                self.assertIn('未验证', out)
                self.assertIn('续跑运行记录：' + rid, err)
        rid = self.create()
        code, out, err = self.invoke(['--json', '--resume-run', rid, '--mode', 'full', '--max-turns', '7'])
        self.assertEqual(code, 0, out + err)
        self.assertEqual(self.store.load(rid)['mode'], 'full')
        self.assertEqual(self.store.load(rid)['max_turns'], 7)
        events = [json.loads(line) for line in (self.store.base_dir / rid / 'events.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertTrue(any(e['type'] == 'mode_override' and e['from'] == 'auto' and e['to'] == 'full' for e in events))

    def test_invalid_combinations_and_finished_runs(self):
        for flags in (['任务'], ['--resume', 'session'], ['--plan'], ['--execute-plan'],
                      ['--compact', 'session'], ['--list-mcp'], ['--list-profiles'],
                      ['--list-sessions'], ['--list-skills']):
            for json_flag in ([], ['--json']):
                with self.subTest(flags=flags, json=json_flag):
                    code, out, err = self.invoke(json_flag + ['--resume-run', 'invalid'] + flags)
                    self.assertEqual(code, 2, out + err)
                    if json_flag:
                        self.assertEqual(json.loads(out)['error']['code'], 'invalid_arguments')
        for status in ('verified', 'completed_unverified', 'queued', 'running'):
            rid = self.create(status)
            code, out, err = self.invoke(['--json', '--resume-run', rid])
            self.assertEqual(code, 2, out + err)
            self.assertEqual(json.loads(out)['error']['code'], 'run_not_resumable')
