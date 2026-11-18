"""顶层任务运行记录；只记录状态和小型事件，不记录模型或工具内容。"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import socket
import tempfile

from .config import NYRA_HOME

RUN_STATUSES = frozenset('queued running awaiting_approval interrupted failed incomplete completed_unverified verified verify_failed'.split())
_RUN_ID = re.compile(r'[0-9]{8}-[0-9]{6}-[0-9a-f]{6}\Z')
_EVENT_FIELDS = {
    'resumed': ('interrupted_tool_calls', 'turn'), 'mode_override': ('from', 'to'),
    'run_started': (), 'turn': ('turn',), 'tool_start': ('id', 'name'),
    'tool_result': ('id', 'name', 'ok'), 'approval_wait': ('tool',),
    'approval_done': ('tool', 'approved'), 'final': (), 'max_turns': (),
    'error': ('error_type',), 'interrupted': (), 'status': ('from', 'to'),
}


def _now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _redact(text):
    if text is None:
        return None
    text = str(text)
    for pattern in (r'\b(?:sk|xai)-[\w-]+', r'(?i)\bBearer\s+\S+',
                    r'(?i)\b(?:api[_-]?key|token|authorization)\s*[:=]\s*[^\s,;]+',
                    r'(?<![\w])[A-Za-z0-9+/=_-]{32,}(?![\w])'):
        text = re.sub(pattern, '[已隐藏]', text)
    return text


def _private(path, mode):
    try:
        os.chmod(path, mode)
    except OSError:
        if os.name != 'nt':
            raise


def _pid_alive(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return True  # 无法确认时不误报中断。
    if os.name == 'nt':
        try:
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.OpenProcess(0x1000, False, pid)
            if not handle:
                return ctypes.get_last_error() != 87
            try:
                code = wintypes.DWORD()
                if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return True
                return code.value == 259
            finally:
                kernel.CloseHandle(handle)
        except Exception:
            return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return True
    return True


class RunStore:
    def __init__(self, base_dir=None):
        self.base_dir = Path(base_dir) if base_dir is not None else NYRA_HOME / 'runs'

    def _directory(self, run_id):
        if not isinstance(run_id, str) or not _RUN_ID.fullmatch(run_id):
            raise ValueError('运行 ID 无效')
        directory = self.base_dir / run_id
        if self.base_dir.is_symlink() or directory.is_symlink() or directory.resolve().parent != self.base_dir.resolve():
            raise ValueError('运行目录不安全')
        return directory

    def _path(self, run_id, name):
        path = self._directory(run_id) / name
        if path.is_symlink():
            raise ValueError('运行文件不能是符号链接')
        return path

    def _validate(self, state, run_id):
        if not isinstance(state, dict) or state.get('run_id') != run_id or state.get('schema_version') != 1:
            raise ValueError('运行记录格式无效')
        if state.get('status') not in RUN_STATUSES:
            raise ValueError('运行状态无效')
        required = {'session_id', 'task', 'workdir', 'mode', 'turn', 'max_turns', 'created_at', 'updated_at', 'verify_cmd', 'verify_result', 'changed_files', 'error', 'pid', 'host'}
        if set(state) != required | {'schema_version', 'run_id', 'status'} or not isinstance(state['changed_files'], list):
            raise ValueError('运行记录字段无效')
        if (not all(isinstance(state[key], str) for key in
                    ('session_id', 'task', 'workdir', 'mode', 'created_at', 'updated_at', 'host'))
                or not all(isinstance(state[key], int) and not isinstance(state[key], bool)
                           for key in ('turn', 'max_turns', 'pid'))
                or state['turn'] < 0 or state['max_turns'] < 1
                or not all(isinstance(path, str) for path in state['changed_files'])
                or (state['error'] is not None and not isinstance(state['error'], str))):
            raise ValueError('运行记录字段类型无效')
        return state

    def _write(self, state):
        run_id = state['run_id']
        self._validate(state, run_id)
        path = self._path(run_id, 'state.json')
        fd, temp = tempfile.mkstemp(prefix='.state-', dir=path.parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                json.dump(state, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            _private(temp, 0o600)
            self._path(run_id, 'state.json')
            os.replace(temp, path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

    def create(self, task, session_id, workdir, mode, max_turns, status='running'):
        if status not in RUN_STATUSES:
            raise ValueError('运行状态无效')
        if self.base_dir.is_symlink():
            raise ValueError('运行目录不安全')
        self.base_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        _private(self.base_dir, 0o700)
        while True:
            run_id = datetime.now().strftime('%Y%m%d-%H%M%S-') + secrets.token_hex(3)
            directory = self._directory(run_id)
            try:
                directory.mkdir(mode=0o700)
                break
            except FileExistsError:
                continue
        _private(directory, 0o700)
        state = dict(schema_version=1, run_id=run_id, session_id=session_id,
                     task=_redact(task), workdir=str(workdir), mode=mode, status=status,
                     turn=0, max_turns=max_turns, created_at=_now(), updated_at=_now(),
                     verify_cmd=None, verify_result=None, changed_files=[], error=None,
                     pid=os.getpid(), host=socket.gethostname())
        self._write(state)
        self.append_event(run_id, 'run_started')
        return state

    def load(self, run_id):
        with self._path(run_id, 'state.json').open(encoding='utf-8') as handle:
            return self._validate(json.load(handle), run_id)

    def claim(self, run_id):
        """当前前台进程接管运行，不继承任何审批。"""
        return self.set_status(run_id, 'running', pid=os.getpid(),
                               host=socket.gethostname(), error=None)

    def list(self):
        if not self.base_dir.exists():
            return []
        states = [self.load(path.name) for path in self.base_dir.iterdir()
                  if _RUN_ID.fullmatch(path.name)]
        return sorted(states, key=lambda state: state['created_at'], reverse=True)

    def update(self, run_id, **fields):
        state = self.load(run_id)
        if set(fields) - (set(state) - {'schema_version', 'run_id', 'created_at', 'updated_at'}):
            raise ValueError('未知或不可修改的运行字段')
        for key in ('task', 'error'):
            if key in fields:
                fields[key] = _redact(fields[key])
        state.update(fields, updated_at=_now())
        self._write(state)
        return state

    def set_status(self, run_id, status, **fields):
        if status not in RUN_STATUSES:
            raise ValueError('运行状态无效')
        old = self.load(run_id)['status']
        state = self.update(run_id, status=status, **fields)
        self.append_event(run_id, 'status', **{'from': old, 'to': status})
        return state

    def append_event(self, run_id, type, **fields):
        if type not in _EVENT_FIELDS:
            raise ValueError('运行事件无效')
        event = {'at': _now(), 'type': type}
        for key in _EVENT_FIELDS[type]:
            if key in fields:
                value = fields[key]
                if not isinstance(value, (str, bool, int, None.__class__)):
                    raise ValueError('运行事件字段无效')
                event[key] = _redact(value) if isinstance(value, str) else value
        path = self._path(run_id, 'events.jsonl')
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'a', encoding='utf-8') as handle:
            _private(path, 0o600)
            handle.write(json.dumps(event, ensure_ascii=False) + '\n')
            handle.flush()
            os.fsync(handle.fileno())

    def effective_status(self, state):
        if state['status'] in ('running', 'awaiting_approval') and state['host'] == socket.gethostname() and not _pid_alive(state['pid']):
            return 'interrupted'
        return state['status']

    def mark_stale(self, run_id):
        state = self.load(run_id)
        status = self.effective_status(state)
        return self.set_status(run_id, status) if status != state['status'] else state


class RunRecorder:
    """链接已有观察器；异常由顶层调用包装捕获，不改变 Agent/审批行为。"""
    def __init__(self, store, agent, task, *, state=None, interrupted_tool_calls=0):
        self.store, self.agent = store, agent
        self.previous = agent.on_event
        self.previous_approval = agent.ctx.approval_observer
        self.turn = state['turn'] if state else 0
        self.continuing = state is not None
        self.previous_files = list(state['changed_files']) if state else []
        agent.turn = self.turn
        self.position = agent.checkpoints.record_position() if agent.checkpoints else 0
        if state is None:
            self.run_id = store.create(task, agent.session_id, agent.workdir, agent.mode, agent.max_turns)['run_id']
        else:
            self.run_id = state['run_id']
            store.claim(self.run_id)
            store.update(self.run_id, max_turns=agent.max_turns)
            store.append_event(self.run_id, 'resumed', interrupted_tool_calls=interrupted_tool_calls, turn=self.turn)
        agent.on_event = self
        agent.ctx.approval_observer = self.approval

    def changed(self):
        files = self.agent.checkpoints.files_changed_since(self.position) if self.agent.checkpoints else []
        self.store.update(self.run_id, changed_files=sorted(set(self.previous_files) | set(files)))

    def __call__(self, kind, data):
        turn = getattr(self.agent, 'turn', 0)
        if isinstance(turn, int) and turn != self.turn:
            self.turn = turn
            self.store.update(self.run_id, turn=turn)
            self.store.append_event(self.run_id, 'turn', turn=turn)
        if kind in ('tool_start', 'tool_result', 'final', 'max_turns'):
            fields = dict(data)
            if kind == 'tool_result':
                fields['ok'] = not str(data.get('result', '')).startswith('错误：')
            self.store.append_event(self.run_id, kind, **fields)
        if kind in ('tool_result', 'final', 'max_turns'):
            self.changed()
        if kind == 'final':
            self.store.set_status(self.run_id, 'completed_unverified')
        elif kind == 'max_turns':
            self.store.set_status(self.run_id, 'incomplete')
        if self.previous:
            self.previous(kind, data)

    def approval(self, tool, approved):
        if approved is None:
            self.store.set_status(self.run_id, 'awaiting_approval')
            self.store.append_event(self.run_id, 'approval_wait', tool=tool)
        else:
            self.store.append_event(self.run_id, 'approval_done', tool=tool, approved=approved)
            self.store.set_status(self.run_id, 'running')
        if self.previous_approval:
            self.previous_approval(tool, approved)

    def run(self, task):
        try:
            result = self.agent.resume(task) if self.continuing else self.agent.run(task)
            self.changed()
            return result
        except KeyboardInterrupt:
            self.changed()
            self.store.append_event(self.run_id, 'interrupted')
            self.store.set_status(self.run_id, 'interrupted')
            raise
        except Exception as exc:
            self.changed()
            self.store.append_event(self.run_id, 'error', error_type=type(exc).__name__)
            self.store.set_status(self.run_id, 'failed', error=f'{type(exc).__name__}: {exc}')
            raise
        finally:
            self.agent.on_event = self.previous
            self.agent.ctx.approval_observer = self.previous_approval


class RunNotResumable(ValueError):
    """运行已结束或仍有进程持有。"""


def prepare_resume(store, run_id, *, workdir=None, mode=None, max_turns=None):
    """校验并修复最后一轮未知结果；从不重放旧工具调用。"""
    from . import memory
    state = store.mark_stale(run_id)
    if state['status'] not in ('interrupted', 'failed', 'incomplete', 'awaiting_approval', 'verify_failed'):
        raise RunNotResumable(f"运行 {run_id} 当前状态为 {state['status']}，不能续跑")
    root = Path(state['workdir']).resolve()
    if not root.is_dir():
        raise ValueError('原工作目录不存在')
    if workdir is not None and Path(workdir).resolve() != root:
        raise ValueError('续跑不能更换工作目录')
    if state['mode'] not in ('readonly', 'auto', 'full'):
        raise ValueError('原运行模式无效')
    if mode is not None and mode not in ('readonly', 'auto', 'full'):
        raise ValueError('运行模式无效')
    budget = max_turns if max_turns is not None else state['max_turns']
    if isinstance(budget, bool) or not isinstance(budget, int) or budget < 1:
        raise ValueError('--max-turns 必须为正整数')
    messages = memory.load_session(state['session_id'])
    if messages is None:
        raise ValueError('指定运行的会话不存在')
    count = 0
    # 逐个调用轮次匹配结果，避免跨轮重复 ID 掩盖未知调用。
    # 先保留本轮已有工具结果，再把未知结果追加在本轮末尾，避免打乱顺序。
    repaired = []
    index = 0
    while index < len(messages):
        message = messages[index]
        repaired.append(message)
        calls = message.get('tool_calls') if message.get('role') == 'assistant' else None
        if not calls:
            index += 1
            continue
        end = index + 1
        while end < len(messages) and messages[end].get('role') == 'tool':
            repaired.append(messages[end])
            end += 1
        results = {m.get('tool_call_id') for m in messages[index + 1:end]}
        for call in calls:
            if call.get('id', '') not in results:
                count += 1
                repaired.append({'role': 'tool', 'tool_call_id': call.get('id', ''),
                                 'content': '中断：该调用结果未知（可能已部分执行）。请先核实当前状态再决定是否重做。'})
        index = end
    memory.save_session(state['session_id'], repaired)
    if mode is not None and mode != state['mode']:
        store.append_event(run_id, 'mode_override', **{'from': state['mode'], 'to': mode})
        state = store.update(run_id, mode=mode)
    state = dict(state, max_turns=budget)
    return state, repaired, count
