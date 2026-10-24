import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Install the existing optional-dependency substitute before importing the application.
from test_dashboard import FakeArchive
import app
import aime_ingest_once as once

ROOT = Path(__file__).resolve().parent.parent
VALIDATOR = ROOT / "dist/apps/host/src/aime-validate-inputs.js"
REAL_RUN = subprocess.run


def session(identity="one", mode="fast", request="2026-10-22T16:10:00Z"):
    return {"meta": {"session_id": identity, "trace_id": identity, "agent_mode": mode + "-analyst",
                     "session_type": mode, "request_time": request, "ok": True},
            "traces": [{"meta": {"trace_id": "trace-" + identity, "mode": mode, "model": "aime-" + mode},
                        "messages": [{"type": "user_question", "role": "user", "content": "计算2+2"},
                                     {"type": "final_answer", "role": "assistant", "content": "2+2=4"}]}]}


class AimeOnceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aime-once-test-")
        self.root = Path(self.temp.name)
        self.data = once.AimeOnceDataset(self.root / "1_aime/1_7z_data/online_data", self.root / "1_aime/2_daily_eval_input",
                                        self.root / "state/data-service/aime", str(VALIDATOR), shutil.which("node"), "fake-7z")
        self.data.archive_dir.mkdir(parents=True)
        self.data.state_dir.mkdir(parents=True)
        self.archive_patch = patch.object(app, "SevenZipFile", FakeArchive)
        self.archive_patch.start()
        self.command_patch = patch.object(once.subprocess, "run", side_effect=lambda args, **kw:
                                         subprocess.CompletedProcess(args, 0, "Everything is Ok", "") if args[0] == "fake-7z" else REAL_RUN(args, **kw))
        self.command_patch.start()

    def tearDown(self):
        self.command_patch.stop()
        self.archive_patch.stop()
        self.temp.cleanup()

    def archive(self, name, rows):
        file = self.data.archive_dir / name
        file.write_text(json.dumps({"answers.jsonl": "".join(json.dumps(row) + "\n" for row in rows)}))
        return file

    def process(self, names, checkpoint=None):
        with self.data.archive_lock():
            return once.process_snapshot(self.data, names, .001, .1, checkpoint)

    def rows(self, mode="fast"):
        return [json.loads(line) for line in (self.data.output_dir / ("aime_" + mode) / "2026-10-23.jsonl").read_text().splitlines()]

    def test_record_dates_modes_and_source_metadata_use_actual_records(self):
        fast, expert = session(), session("two", "expert")
        self.archive("unrelated_19990101.7z", [fast, expert])
        report = self.process(["unrelated_19990101.7z"])
        self.assertEqual(report["reports"][0]["accepted"], 2)
        row = self.rows()[0]
        self.assertEqual(row["trace_id"], "trace-one")
        self.assertEqual(row["meta"]["trace_id"], "one")
        self.assertEqual(row["traces"], fast["traces"])
        self.assertEqual(row["_source"], {"original_file": "unrelated_19990101.7z/answers.jsonl", "original_line": 1,
                                          "original_item": 1, "business_date": "2026-10-23"})
        self.assertEqual(self.rows("expert")[0]["version"], "aime_expert")
        self.assertEqual(report["reports"][0]["records"][0]["trace_id"], "trace-one")

    def test_new_same_name_changed_and_renamed_archives_do_not_duplicate_published_answers(self):
        file = self.archive("batch.7z", [session()])
        self.assertEqual(once.snapshot(self.data)["new_archives"], 1)
        self.process([file.name])
        self.assertEqual(once.snapshot(self.data)["names"], [])
        self.archive(file.name, [session(), session("two")])
        self.assertEqual(once.snapshot(self.data)["updated_archives"], 1)
        report = self.process([file.name])["reports"][0]
        self.assertEqual(report["accepted"], 1)
        self.assertEqual(report["exclusions"][0]["reason"], "duplicate_trace")
        self.archive("renamed.7z", [session(), session("two")])
        report = self.process(["renamed.7z"])["reports"][0]
        self.assertEqual(report["accepted"], 0)
        self.assertEqual(report["excluded"], 2)
        self.assertEqual(len(self.rows()), 2)

    def test_multitrace_conflicts_missing_metadata_and_actual_adapter_errors_are_quarantined(self):
        multiple = session("multi"); multiple["traces"] *= 2
        conflict = session("conflict"); conflict["meta"]["session_type"] = "expert"
        missing = session("missing"); del missing["traces"][0]["meta"]["trace_id"]
        invalid = session("invalid"); invalid["traces"][0]["meta"]["n_messages"] = 999
        self.archive("batch.7z", [session(), multiple, conflict, missing, invalid])
        report = self.process(["batch.7z"])["reports"][0]
        self.assertEqual(report["accepted"], 1)
        self.assertEqual({r["reason"] for r in report["exclusions"]}, {"multiple_traces_not_supported", "aime_mode_conflict", "trace_id_missing", "evaluator_input_invalid"})
        self.assertEqual({r["original_line"] for r in report["exclusions"]}, {2, 3, 4, 5})

    def test_partial_archive_and_changed_trace_are_reported_without_overwriting_inputs(self):
        self.archive("good.7z", [session()]); self.process(["good.7z"])
        changed = session(); changed["traces"][0]["messages"][-1]["content"] = "changed answer"
        self.archive("updated.7z", [changed])
        report = self.process(["updated.7z"])["reports"][0]
        self.assertEqual(report["exclusions"][0]["reason"], "trace_identity_conflict")
        self.assertEqual(self.rows()[0]["traces"][0]["messages"][-1]["content"], "2+2=4")
        self.archive("partial.7z", [session("new")])
        with patch.object(once.subprocess, "run", return_value=subprocess.CompletedProcess([], 2, "", "Unexpected end")):
            report = self.process(["partial.7z"])["reports"][0]
        self.assertIn("archive_integrity_failed", report["error"])
        self.assertEqual(report["accepted"], 0)
        self.assertIn("partial.7z", once.snapshot(self.data)["names"])

    def test_stability_wait_is_bounded_and_scan_does_not_follow_later_arrivals(self):
        ticks = [0.0]
        def sleep(seconds): ticks[0] += seconds
        def info(_path): return {"name": "growing.7z", "size": min(int(ticks[0]), 4), "mtime_ns": min(int(ticks[0]), 4)}
        with patch.object(app, "file_signature", side_effect=info):
            self.assertEqual(once.wait_stable(Path("growing.7z"), 2, 10, clock=lambda: ticks[0], sleep=sleep)["size"], 4)
            ticks[0] = 0
            self.assertIsNone(once.wait_stable(Path("growing.7z"), 2, 3, clock=lambda: ticks[0], sleep=sleep))
        self.archive("first.7z", [session()]); names = once.snapshot(self.data)["names"]
        self.archive("later.7z", [session("later")]); report = self.process(names)
        self.assertEqual([r["archive"] for r in report["reports"]], ["first.7z"])
        self.assertEqual(once.snapshot(self.data)["names"], ["later.7z"])

    def test_crash_after_publication_commit_recovers_without_extracting_or_appending_again(self):
        self.archive("batch.7z", [session()]); checkpoint = self.root / "checkpoint.json"
        original = self.data.publish_pending
        def interrupt(db):
            if db.execute("SELECT 1 FROM pending").fetchone():
                raise OSError("simulated process interruption")
            return original(db)
        with patch.object(self.data, "publish_pending", side_effect=interrupt):
            with self.assertRaises(OSError): self.process(["batch.7z"], checkpoint)
        with patch.object(self.data, "read_archive_records", side_effect=AssertionError("must recover committed publication")):
            report = self.process(["batch.7z"], checkpoint)
        self.assertEqual(report["reports"][0]["accepted"], 1)
        self.assertEqual(len(self.rows()), 1)

    def test_atomic_append_preserves_an_existing_valid_record_without_final_newline(self):
        self.archive("first.7z", [session()]); self.process(["first.7z"])
        file = self.data.output_dir / "aime_fast/2026-10-23.jsonl"
        file.write_bytes(file.read_bytes().rstrip(b"\n"))
        ready = self.data.ready_state("2026-10-23")
        self.assertIsNone(ready)
        ready = json.loads(self.data.ready_path("2026-10-23").read_text())
        ready["files"]["aime_fast"] = self.data.write_record_index(file, [[0, file.stat().st_size]])
        app.write_json_atomic(self.data.ready_path("2026-10-23"), ready)
        self.archive("second.7z", [session("two")]); self.process(["second.7z"])
        self.assertEqual(len(self.rows()), 2)
        self.assertTrue(file.read_bytes().endswith(b"\n"))

    def test_historical_catalog_returns_coordinates_and_quarantines_missing_trace(self):
        file = self.data.output_dir / "aime_fast/2026-10-23.jsonl"
        file.parent.mkdir(parents=True)
        valid = {**session(), "batch_id": "2026-10-23", "case_id": "historical",
                 "_source": {"original_file": "old.7z/answers.jsonl", "original_line": 8, "original_item": 2}}
        invalid = {"batch_id": "2026-10-23", "case_id": "invalid", "meta": {}}
        file.write_text(json.dumps(valid) + "\n" + json.dumps(invalid) + "\n")
        result = once.existing_records(self.data)
        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual((record["model"], record["date"], record["trace_id"], record["input_index"]),
                         ("aime_fast", "2026-10-23", "trace-one", 0))
        self.assertEqual(record["original_line"], 8)
        self.assertNotIn("meta", record)
        self.assertNotIn("traces", record)
        self.assertEqual(result["exclusions"][0]["reason"], "trace_id_missing")

    def test_pause_finishes_the_current_archive_and_leaves_the_next_unopened(self):
        self.archive("first.7z", [session("first")])
        self.archive("second.7z", [session("second")])
        paused = False
        process = self.data.process_archives
        def pause_after_current(signature, **kwargs):
            nonlocal paused
            result = process(signature, **kwargs)
            if signature:
                paused = True
            return result
        with self.data.archive_lock(), patch.object(self.data, "process_archives", side_effect=pause_after_current):
            result = once.process_snapshot(self.data, ["first.7z", "second.7z"], .001, .1, paused=lambda: paused)
        self.assertEqual([report["archive"] for report in result["reports"]], ["first.7z"])
        self.assertEqual(result["deferred"], [{"archive": "second.7z", "reason": "paused"}])
        self.assertEqual(once.snapshot(self.data)["names"], ["second.7z"])
        self.assertEqual(len(self.rows()), 1)
