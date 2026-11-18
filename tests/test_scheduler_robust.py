import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from nyra import scheduler


class SchedulerRobustTests(unittest.TestCase):
    def test_corrupt_file_backed_up(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "schedule.json"
            p.write_text("{broken", encoding="utf-8")
            with self.assertRaises(scheduler.ScheduleError):
                scheduler.load_schedule(p)
            backups = list(Path(d).glob("schedule.json.corrupt-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(encoding="utf-8"), "{broken")

    def test_non_dict_backed_up(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "schedule.json"
            p.write_text("[1]", encoding="utf-8")
            with self.assertRaises(scheduler.ScheduleError):
                scheduler.load_schedule(p)
            self.assertEqual(len(list(Path(d).glob("*.corrupt-*"))), 1)

    def test_save_atomic_no_temp_left(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "schedule.json"
            scheduler.save_schedule({"tasks": []}, p)
            self.assertEqual(json.loads(p.read_text(encoding="utf-8")), {"tasks": []})
            self.assertEqual([x.name for x in Path(d).iterdir()], ["schedule.json"])

    def test_failed_save_keeps_old_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "schedule.json"
            scheduler.save_schedule({"tasks": []}, p)
            with mock.patch("os.replace", side_effect=OSError("boom")):
                with self.assertRaises(OSError):
                    scheduler.save_schedule({"tasks": [1]}, p)
            self.assertEqual(json.loads(p.read_text(encoding="utf-8")), {"tasks": []})
            self.assertEqual([x.name for x in Path(d).iterdir()], ["schedule.json"])


if __name__ == "__main__":
    unittest.main()


class SchedulerDaemonTests(unittest.TestCase):
    def test_daemon_does_not_clobber_corrupt_schedule(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "schedule.json"
            p.write_text("{broken", encoding="utf-8")
            scheduler.run_daemon(lambda task: "x", interval=60, path=p, stop_after=1)
            # 原损坏文件原样保留，只多了一个备份；绝不能被空任务表覆盖。
            self.assertEqual(p.read_text(encoding="utf-8"), "{broken")
            self.assertEqual(len(list(Path(d).glob("schedule.json.corrupt-*"))), 1)

    def test_daemon_rejects_bad_interval(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "schedule.json"
            for bad in (-1, 0, float("nan"), float("inf"), "60", True):
                with self.subTest(bad=bad), self.assertRaises(ValueError):
                    scheduler.run_daemon(lambda task: "x", interval=bad, path=p, stop_after=1)

    def test_workdir_and_verify_survive_load_save_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "schedule.json"
            data = {"tasks": [{
                "name": "nightly", "prompt": "巡检",
                "every_seconds": 3600, "mode": "auto",
                "workdir": "/tmp/work", "verify": "pytest -q",
            }]}
            scheduler.save_schedule(data, p)
            loaded = scheduler.load_schedule(p)
            task = loaded["tasks"][0]
            self.assertEqual(task["workdir"], "/tmp/work")
            self.assertEqual(task["verify"], "pytest -q")
            # 再存一次也不丢。
            scheduler.save_schedule(loaded, p)
            self.assertEqual(
                json.loads(p.read_text(encoding="utf-8"))["tasks"][0]["verify"],
                "pytest -q",
            )

    def test_add_task_keeps_workdir_and_verify(self):
        data = {"tasks": []}
        scheduler.add_task(data, {
            "name": "t", "prompt": "p", "every_seconds": 60,
            "workdir": "/tmp/w", "verify": "make check",
        })
        self.assertEqual(data["tasks"][0]["workdir"], "/tmp/w")
        self.assertEqual(data["tasks"][0]["verify"], "make check")
