"""Tests for nyra.e2b_backend with a stubbed E2B SDK (no network, no SDK)."""

import sys
import types
import unittest
from unittest import mock

from nyra.e2b_backend import E2BBackend, E2BError


class _Entry:
    """An SDK file-list entry; `size` is optional, like real entries."""

    def __init__(self, name, kind, size=None):
        self.name = name
        self.type = kind
        if size is not None:
            self.size = size


class _Files:
    def __init__(self, entries):
        self._entries = entries

    def list(self, path):
        return list(self._entries)

    def read(self, path):
        if path == "/home/user/missing.txt":
            raise FileNotFoundError("not found")
        return "hello"

    def write(self, path, content):
        return None


class _Commands:
    def run(self, command, cwd=None, timeout=60):
        return types.SimpleNamespace(stdout="out\n", stderr="")


class _Sandbox:
    def __init__(self, entries):
        self.sandbox_id = "sbx-test"
        self.files = _Files(entries)
        self.commands = _Commands()

    @classmethod
    def create(cls, template=None, timeout=None, api_key=None):
        return cls([_Entry("a.txt", "file", 3), _Entry("dir", "dir")])

    @classmethod
    def connect(cls, sandbox_id, api_key=None):
        return cls([_Entry("a.txt", "file", 3)])


def _install_fake_e2b(test_case):
    module = types.ModuleType("e2b")
    module.Sandbox = _Sandbox
    patcher = mock.patch.dict(sys.modules, {"e2b": module})
    patcher.start()
    test_case.addCleanup(patcher.stop)


class E2BBackendTest(unittest.TestCase):
    def setUp(self):
        _install_fake_e2b(self)

    def _backend(self):
        backend = E2BBackend(api_key="test-key")
        backend.connect()
        return backend

    def test_list_dir_entry_without_size(self):
        # Directory entries (and some SDK versions) carry no `size`:
        # listing them used to raise AttributeError out of list_dir.
        backend = self._backend()
        out = backend.list_dir("/home/user")
        self.assertIn("a.txt (3 字节)", out)
        self.assertIn("dir/", out)

    def test_list_dir_not_found(self):
        class MissingFiles(_Files):
            def list(self, path):
                raise FileNotFoundError("not found")

        backend = E2BBackend(api_key="test-key")
        backend._sbx = _Sandbox([])
        backend._sbx.files = MissingFiles([])
        self.assertIn("目录不存在", backend.list_dir("/nope"))

    def test_run_command_and_read_file(self):
        backend = self._backend()
        self.assertEqual(backend.run_command("echo hi"), "out\n")
        self.assertEqual(backend.read_file("/home/user/a.txt"), "hello")
        self.assertIn("文件不存在", backend.read_file("/home/user/missing.txt"))

    def test_requires_connect_first(self):
        backend = E2BBackend(api_key="test-key")
        with self.assertRaises(E2BError):
            backend.run_command("echo hi")


if __name__ == "__main__":
    unittest.main()
