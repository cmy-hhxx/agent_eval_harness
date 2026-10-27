import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from test_dashboard import FakeArchive, HAS_PY7ZR, archive_row
import app
import auto_renew as renew


class RenewTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dataset = app.make_datasets(self.root / "data", self.root / "state")["/data/wencai"]
        self.dataset.archive_dir.mkdir(parents=True)
        self.name = "batch_20261027_120000.7z"
        self.file = self.dataset.archive_dir / self.name
        self.file.write_text(json.dumps({"A-fast.jsonl": json.dumps(archive_row("a_fast", "one"))}))
        self.request = {"dataRoot": str(self.root / "data"), "stateRoot": str(self.root / "state"), "id": "wencai"}
        self.archive = patch.object(app, "SevenZipFile", FakeArchive)
        self.archive.start()
        self.addCleanup(self.archive.stop)

    def ingest(self):
        return renew.ingest({**self.request, "packages": [{"name": self.name, "signature": renew.signature(self.file)}]})

    def test_publish_archive_and_repeated_scan_keep_one_record(self):
        result = self.ingest()
        self.assertEqual(result["events"][0]["event"], "package_archived")
        target = Path(result["events"][0]["destination"])
        self.assertTrue(target.exists())
        self.assertFalse(self.file.exists())
        self.assertEqual(len((self.dataset.output_dir / "a_fast/2026-09-29.jsonl").read_text().splitlines()), 1)
        self.assertEqual(renew.ingest({**self.request, "packages": []}), {"events": []})

    def test_resume_after_publication_before_archival_does_not_extract_twice(self):
        with patch.object(renew, "archive_package", side_effect=RuntimeError("interrupted")):
            self.assertEqual(self.ingest()["events"][0]["event"], "package_error")
        with patch.object(app.Dataset, "read_archive_records", side_effect=AssertionError("must reuse receipt")):
            self.assertEqual(self.ingest()["events"][0]["event"], "package_archived")
        self.assertEqual(len((self.dataset.output_dir / "a_fast/2026-09-29.jsonl").read_text().splitlines()), 1)

    def test_collision_preserves_both_packages_and_does_not_publish(self):
        target = self.dataset.archive_dir / "3_processed_archives/20261027" / self.name
        target.parent.mkdir(parents=True)
        target.write_text("original")
        result = self.ingest()
        self.assertEqual(result["events"][0]["event"], "package_error")
        self.assertTrue(self.file.exists())
        self.assertEqual(target.read_text(), "original")
        self.assertFalse((self.dataset.output_dir / "a_fast/2026-09-29.jsonl").exists())

    def test_interrupted_link_move_is_recoverable(self):
        target = self.dataset.archive_dir / "3_processed_archives/20261027" / self.name
        target.parent.mkdir(parents=True)
        os.link(self.file, target)
        renew.archive_package(self.file, target)
        self.assertFalse(self.file.exists())
        self.assertTrue(target.exists())

    def test_changed_or_open_upload_is_deferred(self):
        request = {**self.request, "packages": [{"name": self.name, "signature": renew.signature(self.file)}]}
        self.file.write_text(self.file.read_text() + " ")
        self.assertEqual(renew.ingest(request)["events"][0]["event"], "package_wait")
        with patch.object(app.Dataset, "open_archive_writers", return_value={self.name}):
            self.assertEqual(self.ingest()["events"][0]["event"], "package_wait")
        self.assertTrue(self.file.exists())

    def test_busy_ingestion_lock_does_not_block(self):
        self.dataset.state_dir.mkdir(parents=True)
        with (self.dataset.state_dir / "archive.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertEqual(self.ingest()["events"][0]["reason"], "data_service_busy")

    def test_backlog_missing_counters_and_incomplete_cursor_are_not_completed(self):
        entry = {"status": "completed", "line": 1, "read_line": 1, "processed_lines": 1, "total_lines": 1,
                 "inflight_records": 0, "ready_to_commit": 0, "blocked_records": 0,
                 "translation_backlog_records": 0, "annotation_backlog_records": 0}
        self.assertTrue(renew.complete(entry))
        for changed in ({"status": "completed_with_backlog"}, {"blocked_records": 1},
                        {"read_line": 0}, {"inflight_records": None}, {"schema_repair_pending": 1}):
            self.assertFalse(renew.complete({**entry, **changed}))


@unittest.skipUnless(HAS_PY7ZR, "real 7z end-to-end test requires existing data-service dependencies")
class RenewShellTest(unittest.TestCase):
    def test_real_archives_both_sources_backlog_delivery_restart_and_signal(self):
        import py7zr
        from test_aime_ingest_once import session
        project = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data, runtime = root / "data", root / "runtime"
            definitions = [
                ("wencai", "0_wencai", "A_AA_comparision_data", "a_fast", "A-fast.jsonl",
                 archive_row("a_fast", "one", request_time="2026-10-27 12:00:00")),
                ("aime", "1_aime", "online_data", "aime_fast", "answers.jsonl",
                 session(request="2026-10-27T12:00:00+08:00")),
            ]
            sources, packages = [], []
            for identity, source, inbox, model, member, row in definitions:
                directory = data / source
                (directory / "1_7z_data" / inbox).mkdir(parents=True)
                (directory / "clean").mkdir()
                package = directory / "1_7z_data" / inbox / "batch_20261027_120000.7z"
                member_file = root / member
                member_file.write_text(json.dumps(row) + "\n")
                with py7zr.SevenZipFile(package, "w") as archive:
                    archive.write(member_file, member)
                packages.append(package)
                sources.append({"id": identity, "cleanDirectory": f"{source}/clean", "targetDirectory": f"{source}/slim"})
            config = root / "config.json"
            config.write_text(json.dumps({"dataRoot": str(data), "runtimeRoot": str(runtime), "python": sys.executable,
                                          "intervalSeconds": .1, "stableSeconds": .01, "sources": sources}))
            command = ["bash", str(project / "auto_renew.sh"), "--config", str(config)]
            env = {**os.environ, "AUTO_RENEW_MISE": "1"}

            def once():
                result = subprocess.run([*command, "--once"], cwd=project, env=env, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

            once()
            self.assertTrue(all(file.exists() for file in packages))
            time.sleep(.02)
            once()
            self.assertTrue(all(not file.exists() for file in packages))
            for package in packages:
                self.assertTrue((package.parent / "3_processed_archives/20261027" / package.name).exists())
            statuses, targets = [], []
            for identity, source, inbox, model, member, row in definitions:
                raw = data / source / "2_daily_eval_input" / model / "2026-10-27.jsonl"
                clean = data / source / "clean" / model
                clean.mkdir()
                shutil.copyfile(raw, clean / raw.name)
                (clean / ".status.lock").touch()
                status = {"status": "completed", "line": 1, "read_line": 1, "processed_lines": 1, "total_lines": 1,
                          "inflight_records": 0, "ready_to_commit": 0, "blocked_records": 0,
                          "translation_backlog_records": 0, "annotation_backlog_records": 0,
                          "updated_at": datetime.now(timezone.utc).isoformat()}
                if identity == "aime":
                    status.update(status="completed_with_backlog", annotation_backlog_records=1)
                status_path = clean / "status.json"
                status_path.write_text(json.dumps({"files": {raw.name: status}}))
                statuses.append((status_path, raw.name, status))
                targets.append(data / source / "slim" / model / raw.name)
            once()
            self.assertTrue(targets[0].exists())
            self.assertFalse(targets[1].exists())
            status_file, name, status = statuses[1]
            status.update(status="completed", annotation_backlog_records=0)
            status_file.write_text(json.dumps({"files": {name: status}}))
            once()
            self.assertTrue(targets[1].exists())
            stamps = [file.stat().st_mtime_ns for file in targets]
            once()
            self.assertEqual(stamps, [file.stat().st_mtime_ns for file in targets])
            state = json.loads((runtime / "state/auto-renew/state.json").read_text())
            self.assertEqual(set(state["sources"]), {"wencai", "aime"})
            self.assertTrue(all(len(source["deliveries"]) == 1 and not source["pending"] for source in state["sources"].values()))
            logs = [json.loads(line) for line in (runtime / "log/runtime.log").read_text().splitlines()]
            self.assertEqual(sum(row["event"] == "package_archived" for row in logs), 2)
            self.assertEqual(sum(row["event"] == "delivered" for row in logs), 2)
            process = subprocess.Popen(command, cwd=project, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                assert process.stdout is not None
                self.assertIn("started", process.stdout.readline())
                duplicate = subprocess.run([*command, "--once"], cwd=project, env=env, capture_output=True, text=True, timeout=10)
                self.assertNotEqual(duplicate.returncode, 0)
                self.assertIn("Run already owned", duplicate.stderr)
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, stderr + stdout)
                self.assertIn("stopped", stdout)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            once()


if __name__ == "__main__":
    unittest.main()
