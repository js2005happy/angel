import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from angel import scheduler


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
