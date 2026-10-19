import importlib.util
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
fake_py7zr = types.ModuleType("py7zr")
fake_py7zr.SevenZipFile = object
sys.modules.setdefault("py7zr", fake_py7zr)
os.environ["DATA_ROOT"] = tempfile.mkdtemp(prefix="remote-dashboard-data-")
spec = importlib.util.spec_from_file_location("remote_dashboard_app", ROOT / "app.py")
app = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = app
spec.loader.exec_module(app)
bridge_spec = importlib.util.spec_from_file_location("remote_dashboard_bridge", ROOT / "progress_bridge.py")
bridge = importlib.util.module_from_spec(bridge_spec)
sys.modules[bridge_spec.name] = bridge
bridge_spec.loader.exec_module(bridge)


class FakeArchive:
    def __init__(self, archive_path, mode):
        self.members = json.loads(Path(archive_path).read_text(encoding="utf-8"))

    def __enter__(self): return self
    def __exit__(self, *_): return None
    def getnames(self): return list(self.members)

    def extract(self, path, targets):
        for member in targets:
            target = Path(path) / member
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(self.members[member], encoding="utf-8")


def archive_row(model, case_id, request_time="2026-09-29 11:00:00", answer="Answer", meta_fields=None):
    meta = {"case_id": case_id, "question": "Question", **(meta_fields or {})}
    if request_time is not None:
        meta["request_time"] = request_time
    a_model = model.startswith("a_")
    return {
        "meta": meta,
        "messages": [
            {"type": "message" if a_model else "user_question", "role": "user", "content": "Question"},
            {"type": "message" if a_model else "final_answer", "role": "assistant", "content": answer},
        ],
    }


def trace_row(model="b_fast"):
    row = archive_row(model, "trace-case", request_time=None)
    messages = row.pop("messages")
    row["meta"].update({"ok": True, "fetcher": "new", "session_id": "thread-session", "trace_id": "thread-session"})
    row["traces"] = [{
        "meta": {"trace_id": "actual-trace", "session_id": "thread-session", "timestamp": "2026-10-14T16:30:00Z", "model": "aime-fast-new"},
        "messages": messages,
    }]
    return row


class TraceFormatTest(unittest.TestCase):
    def test_single_trace_preserves_messages_and_uses_trace_time_and_identity(self):
        for model in app.MODELS:
            with self.subTest(model=model):
                row = trace_row(model)
                trace = row["traces"][0]
                trace["messages"].insert(1, {"type": "function_call_output" if model.startswith("a_") else "tool_result", "output": {"values": [1, 2]}})
                day, normalized = app.normalize_row(row, model, "new.7z", "answers.jsonl", 3)
                self.assertEqual(day, "2026-10-15")
                self.assertEqual(normalized["request_time"], trace["meta"]["timestamp"])
                self.assertEqual(normalized["messages"], trace["messages"])
                self.assertEqual(normalized["trace_id"], "actual-trace")
                self.assertEqual(normalized["meta"]["session_id"], "thread-session")
                self.assertEqual(normalized["meta"]["model"], "aime-fast-new")
                self.assertEqual(normalized["version"], app.VERSION_NAMES[model])
                self.assertNotIn("traces", normalized)
                self.assertEqual(app.visible_record(normalized), {"question": "Question", "answer": "Answer"})
                self.assertNotIn("messages", row)

    def test_outer_request_time_reference_and_ask_time_take_priority(self):
        row = trace_row()
        row["meta"].update({"request_time": "2026-10-14 23:59:00", "std_answer": "Reference"})
        day, normalized = app.normalize_row(row, "b_fast", "new.7z", "answers.jsonl", 1)
        self.assertEqual(day, "2026-10-14")
        self.assertTrue(normalized["has_standard_answer"])
        self.assertEqual(app.visible_record(normalized)["standard_answer"], "Reference")
        row["meta"].pop("request_time")
        row["meta"]["ask_time"] = 1791979200000  # 2026-10-14 20:00:00 UTC+8
        day, _ = app.normalize_row(row, "b_fast", "new.7z", "answers.jsonl", 1)
        self.assertEqual(day, "2026-10-14")

    def test_invalid_trace_shape_and_failed_or_empty_answer_are_rejected(self):
        for traces, reason in ((None, "traces_invalid"), ([], "single_trace_required"), ([{}, {}], "single_trace_required"), ([None], "trace_invalid"), ([{"meta": []}], "trace_meta_invalid")):
            with self.subTest(traces=traces):
                row = trace_row()
                row["traces"] = traces
                with self.assertRaises(app.InvalidRecord) as error:
                    app.normalize_row(row, "b_fast", "new.7z", "answers.jsonl", 1)
                self.assertEqual(error.exception.reason, reason)
        for failed in (True, False):
            row = trace_row()
            if failed:
                row["meta"]["ok"] = False
            else:
                row["traces"][0]["messages"][-1]["content"] = " "
            with self.assertRaises(app.InvalidRecord):
                app.normalize_row(row, "b_fast", "new.7z", "answers.jsonl", 1)


class DashboardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="remote-dashboard-test-")
        root = Path(self.temp.name)
        app.ARCHIVE_DIR = root / "archives"
        app.OUTPUT_DIR = root / "output"
        self.legacy_date_dir = root / "legacy-dates"
        app.STATE_DIR = root / "state"
        app.PROGRESS_FILE = app.STATE_DIR / "evaluation-progress.json"
        app.ROOT_ARCHIVE_STATE_FILE = app.STATE_DIR / "root-archives.json"
        app.ARCHIVE_DIR.mkdir()
        self.legacy_date_dir.mkdir()
        app.STATE_DIR.mkdir()
        self.day = "2026-09-22"
        self.records = {
            "a_fast": {
                "has_standard_answer": True,
                "meta": {"question": "A question", "ground_truth": "A standard"},
                "messages": [
                    {"role": "user", "content": [{"type": "input_text", "text": "A question"}]},
                    {"type": "reasoning", "summary": [{"text": "do not expose this"}]},
                    {"role": "assistant", "content": [{"type": "output_text", "text": "A final answer"}]},
                ],
            },
            "b_fast": {
                "has_standard_answer": True,
                "meta": {"question": "B question", "std_answer": "B standard"},
                "messages": [
                    {"type": "user_question", "role": "user", "content": "B question"},
                    {"type": "tool_result", "output": "do not expose this"},
                    {"type": "final_answer", "role": "assistant", "content": "B final answer"},
                ],
            },
            "a_expert": {
                "has_standard_answer": False,
                "meta": {"question": "No reference"},
                "messages": [
                    {"role": "user", "content": "No reference"},
                    {"role": "assistant", "content": "Answer"},
                ],
            },
            "b_expert": {
                "meta": {"question": "Question"},
                "messages": [
                    {"type": "user_question", "role": "user", "content": "Question"},
                    {"type": "final_answer", "role": "assistant", "content": "Answer"},
                ],
            },
        }
        for model, row in self.records.items():
            folder = app.OUTPUT_DIR / model
            folder.mkdir(parents=True)
            (folder / f"{self.day}.jsonl").write_text(json.dumps(row) + "\n", encoding="utf-8")
        app.register_local_import(self.day)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def get_json(self, path):
        with urlopen(self.base + path, timeout=3) as response:
            return json.loads(response.read())

    def test_aa_archive_members_are_normalized_to_b_models(self):
        for member, model, source_version, expected_version in (
            ("answers_AA-fast.jsonl", "b_fast", "AA Fast", "B Fast"),
            ("answers_AA-expert.jsonl", "b_expert", "AA Expert", "B Expert"),
            ("answers_AA-fast.incr00002.jsonl", "b_fast", "AA Fast", "B Fast"),
        ):
            self.assertEqual(app.model_for_member(member), model)
            row = archive_row(model, f"case-{model}")
            row["version"] = source_version
            _, normalized = app.normalize_row(row, model, "archive.7z", member, 1)
            self.assertEqual(normalized["version"], expected_version)

    def test_incremental_archives_merge_partial_models_and_replace_same_source_cases(self):
        def write_archive(name, members):
            payload = {
                member: "\n".join(json.dumps(row) for row in rows) + "\n"
                for member, rows in members.items()
            }
            (app.ARCHIVE_DIR / name).write_text(json.dumps(payload), encoding="utf-8")

        first = {
            f"run_A-fast.jsonl": [
                archive_row("a_fast", "shared", answer="old answer"),
                archive_row("a_fast", "old-only"),
            ],
            "run_A-expert.jsonl": [archive_row("a_expert", "expert-base")],
            "run_AA-fast.jsonl": [archive_row("b_fast", "bfast-base")],
            "run_AA-expert.jsonl": [
                archive_row("b_expert", "bexpert-base"),
                archive_row("b_expert", "bexpert-base"),
            ],
        }
        latest_snapshot = {
            "run_A-fast.incr00001.jsonl": [
                archive_row("a_fast", "shared", answer="latest answer"),
                archive_row("a_fast", "old-only"),
                archive_row("a_fast", "new-case"),
            ],
        }
        delta_one = {
            "run_A-expert.incr00001.jsonl": [archive_row("a_expert", "delta-one")],
        }
        delta_two = {
            "run_A-expert.incr00002.jsonl": [archive_row("a_expert", "delta-two")],
        }
        write_archive("0123456789abcdef.7z", first)
        write_archive("0123456789abcdef_20261001_010000.7z", latest_snapshot)
        write_archive("fedcba9876543210_20261001_030744.7z", delta_one)
        write_archive("fedcba9876543210_20261001_030821.7z", delta_two)

        with patch.object(app, "SevenZipFile", FakeArchive):
            app.process_archives(app.archive_signature(app.ARCHIVE_DIR))

        def rows(model):
            path = app.OUTPUT_DIR / model / "2026-09-29.jsonl"
            return [json.loads(line) for line in path.read_text().splitlines()]

        a_fast = rows("a_fast")
        self.assertEqual(len(a_fast), 3)
        shared = next(row for row in a_fast if row["case_id"] == "shared")
        self.assertEqual(shared["messages"][-1]["content"], "latest answer")
        a_expert = rows("a_expert")
        self.assertEqual({row["case_id"] for row in a_expert}, {"expert-base", "delta-one", "delta-two"})
        self.assertEqual(len(rows("b_fast")), 1)
        self.assertEqual(len(rows("b_expert")), 1)
        state = json.loads(app.ROOT_ARCHIVE_STATE_FILE.read_text())
        self.assertEqual(state["failed_archives"], [])
        self.assertTrue(app.root_archive_import_is_current(state["archives"]))

    def test_records_api_projects_only_question_answer_and_optional_reference(self):
        a_fast = self.get_json(f"/records/{self.day}/a_fast")
        self.assertEqual(a_fast["items"][0], {
            "question": "A question", "answer": "A final answer", "standard_answer": "A standard"
        })
        b_fast = self.get_json(f"/records/{self.day}/b_fast")
        self.assertEqual(b_fast["items"][0], {
            "question": "B question", "answer": "B final answer", "standard_answer": "B standard"
        })
        a_expert = self.get_json(f"/records/{self.day}/a_expert")
        self.assertEqual(a_expert["items"][0], {"question": "No reference", "answer": "Answer"})
        self.assertEqual(a_fast["total"], 1)

    def test_catalog_counts_ready_rows_and_keeps_full_download_route(self):
        data = self.get_json("/dashboard-data")
        self.assertTrue(data["dates"][0]["models"]["b_fast"]["ready"])
        self.assertEqual(data["dates"][0]["models"]["b_fast"]["row_count"], 1)
        with urlopen(self.base + f"/data/{self.day}/a_fast.jsonl", timeout=3) as response:
            raw = response.read().decode()
        self.assertIn("do not expose this", raw)

    def test_catalog_discovers_new_data_and_progress_dates_without_a_fixed_window(self):
        new_data_day = "2026-10-08"
        progress_only_day = "2026-10-09"
        (self.legacy_date_dir / "2026-10-07").mkdir()
        for model in app.MODELS:
            model_dir = app.OUTPUT_DIR / model
            (model_dir / f"{new_data_day}.jsonl").write_text("{}\n", encoding="utf-8")
        app.PROGRESS_FILE.write_text(json.dumps({
            "status": "running", "updated_at": 0,
            "dates": [{"date": progress_only_day}],
        }), encoding="utf-8")

        data = self.get_json("/dashboard-data")
        dates = [entry["date"] for entry in data["dates"]]
        self.assertEqual(dates, [progress_only_day, new_data_day, self.day])
        self.assertFalse(data["dates"][1]["ready"])

    def test_dashboard_has_no_download_control_and_answers_start_collapsed(self):
        dashboard = (ROOT / "dashboard.html").read_text(encoding="utf-8")
        dashboard_script = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        records_script = (ROOT / "records.js").read_text(encoding="utf-8")
        self.assertNotIn("下载", dashboard + dashboard_script)
        self.assertNotIn("evaluation-panel", dashboard)
        self.assertIn('<table class="results-table">', dashboard)
        self.assertNotIn('id="date-cards"', dashboard)
        self.assertIn("A Fast 对 B组 Fast", dashboard_script)
        self.assertIn('b_fast: "B组 Fast"', dashboard_script)
        self.assertIn('b_expert: "B组 Expert"', dashboard_script)
        self.assertIn('b_fast: "B组 Fast"', records_script)
        self.assertIn('b_expert: "B组 Expert"', records_script)
        self.assertIn('document.createElement("details")', records_script)
        self.assertIn('summary.textContent = "展开回答"', records_script)
        self.assertNotIn("details.open = true", records_script)

    def test_root_archive_preserves_local_import_and_processes_other_dates(self):
        archive_day = "2026-09-29"
        previous = {
            model: (app.OUTPUT_DIR / model / f"{self.day}.jsonl").read_bytes()
            for model in app.MODELS
        }
        payload = {}
        for model in app.MODELS:
            member = f"answers_{model.replace('_', '-').upper()}.jsonl"
            rows = [
                archive_row(model, f"local-{model}", request_time=f"{self.day} 12:00:00"),
                archive_row(model, f"archive-{model}", request_time=f"{archive_day} 12:00:00"),
            ]
            payload[member] = "\n".join(json.dumps(row) for row in rows) + "\n"
        (app.ARCHIVE_DIR / "later.7z").write_text(json.dumps(payload), encoding="utf-8")

        with patch.object(app, "SevenZipFile", FakeArchive):
            signature = app.archive_signature(app.ARCHIVE_DIR)
            app.process_archives(signature)

        for model in app.MODELS:
            self.assertEqual((app.OUTPUT_DIR / model / f"{self.day}.jsonl").read_bytes(), previous[model])
        self.assertTrue(app.is_ready(self.day))
        for model in app.MODELS:
            archive_rows = (app.OUTPUT_DIR / model / f"{archive_day}.jsonl").read_text().splitlines()
            self.assertEqual(len(archive_rows), 1)
            self.assertEqual(json.loads(archive_rows[0])["case_id"], f"archive-{model}")
        self.assertTrue(app.is_ready(archive_day))
        root_state = json.loads(app.ROOT_ARCHIVE_STATE_FILE.read_text())
        self.assertEqual(root_state["archives"], signature)
        self.assertEqual(root_state["dates"], [archive_day])

    def test_archive_mixes_flat_messages_and_single_traces(self):
        day = "2026-10-15"
        previous = (app.OUTPUT_DIR / "b_fast" / f"{self.day}.jsonl").read_bytes()
        payload = {}
        for model in app.MODELS:
            rows = [trace_row(model), archive_row(model, "flat-case", request_time=f"{day} 00:30:00")]
            member = f"answers_{model.replace('b_', 'aa_').replace('_', '-').upper()}.incr00091.jsonl"
            payload[member] = "\n".join(json.dumps(row) for row in rows) + "\n"
        (app.ARCHIVE_DIR / "new.7z").write_text(json.dumps(payload), encoding="utf-8")
        with patch.object(app, "SevenZipFile", FakeArchive):
            app.process_archives(app.archive_signature(app.ARCHIVE_DIR))
        data = self.get_json("/dashboard-data")
        self.assertEqual(data["dates"][0]["date"], day)
        self.assertTrue(data["dates"][0]["ready"])
        for model in app.MODELS:
            self.assertEqual(data["dates"][0]["models"][model]["row_count"], 2)
            records = self.get_json(f"/records/{day}/{model}")
            self.assertEqual(records["items"], [{"question": "Question", "answer": "Answer"}] * 2)
        self.assertEqual((app.OUTPUT_DIR / "b_fast" / f"{self.day}.jsonl").read_bytes(), previous)

    def test_root_archives_group_filter_and_emit_required_header_fields(self):
        day_next = "2026-09-30"
        shanghai = ZoneInfo("Asia/Shanghai")
        ask_time = int(datetime(2026, 9, 30, 12, 0, tzinfo=shanghai).timestamp() * 1000)
        payload = {}
        for model in app.MODELS:
            member = f"answers_{model.replace('_', '-').upper()}.jsonl"
            rows = [
                archive_row(model, f"before-{model}", request_time="2026-09-28 11:00:00"),
                archive_row(model, f"dated-{model}", meta_fields={"std_answer": "Reference"}),
                archive_row(model, f"ask-{model}", request_time=None, meta_fields={"ask_time": ask_time}),
                archive_row(model, f"empty-{model}", answer="  "),
                archive_row(model, f"failed-{model}", meta_fields={"ok": False}),
                archive_row(model, f"unknown-{model}"),
                archive_row(model, f"no-time-{model}", request_time=None),
            ]
            rows[5]["messages"][0]["type"] = "unsupported"
            payload[member] = "not-json\n" + "\n".join(json.dumps(row) for row in rows) + "\n"
        (app.ARCHIVE_DIR / "daily.7z").write_text(json.dumps(payload), encoding="utf-8")

        with patch.object(app, "SevenZipFile", FakeArchive):
            app.process_archives(app.archive_signature(app.ARCHIVE_DIR))

        for model in app.MODELS:
            for day in ("2026-09-28", "2026-09-29", day_next):
                path = app.OUTPUT_DIR / model / f"{day}.jsonl"
                rows = [json.loads(line) for line in path.read_text().splitlines()]
                self.assertEqual(len(rows), 1)
                self.assertEqual(list(rows[0])[:3], ["request_time", "has_standard_answer", "versions"])
                self.assertIsInstance(rows[0]["has_standard_answer"], bool)
                expected_versions = "0929-big-fast" if model == "b_fast" and day >= "2026-09-29" else "default"
                self.assertEqual(rows[0]["versions"], expected_versions)
                self.assertTrue(app.is_ready(day))
                if day == "2026-09-29":
                    self.assertEqual(rows[0]["request_time"], "2026-09-29 11:00:00")
                    self.assertTrue(rows[0]["has_standard_answer"])
                elif day == day_next:
                    self.assertEqual(rows[0]["request_time"], "2026-09-30 12:00:00")
                    self.assertFalse(rows[0]["has_standard_answer"])
                else:
                    self.assertEqual(rows[0]["request_time"], "2026-09-28 11:00:00")
                    self.assertFalse(rows[0]["has_standard_answer"])

    def test_same_name_archive_growth_and_new_archive_rebuild_without_duplicates(self):
        day = "2026-09-29"

        def write_archive(name, case_ids):
            payload = {}
            for model in app.MODELS:
                member = f"answers_{model.replace('_', '-').upper()}.jsonl"
                payload[member] = "\n".join(
                    json.dumps(archive_row(model, f"{case_id}-{model}")) for case_id in case_ids
                ) + "\n"
            (app.ARCHIVE_DIR / name).write_text(json.dumps(payload), encoding="utf-8")

        def count_rows(model):
            path = app.OUTPUT_DIR / model / f"{day}.jsonl"
            return len(path.read_text().splitlines())

        write_archive("first.7z", ["first"])
        with patch.object(app, "SevenZipFile", FakeArchive):
            app.process_archives(app.archive_signature(app.ARCHIVE_DIR))
            self.assertTrue(app.is_ready(day))
            previous_signature = app.archive_signature(app.ARCHIVE_DIR)
            write_archive("first.7z", ["first", "grown"])
            grown_signature = app.archive_signature(app.ARCHIVE_DIR)
            self.assertNotEqual(previous_signature, grown_signature)
            app.process_archives(grown_signature)
            for model in app.MODELS:
                self.assertEqual(count_rows(model), 2)
            write_archive("second.7z", ["second"])
            (app.ARCHIVE_DIR / "partial.7z").write_bytes(b"not a complete archive")
            signature = app.archive_signature(app.ARCHIVE_DIR)
            app.process_archives(signature)
            app.process_archives(signature)
            for model in app.MODELS:
                self.assertEqual(count_rows(model), 3)
            root_state = json.loads(app.ROOT_ARCHIVE_STATE_FILE.read_text())
            self.assertEqual([item["name"] for item in root_state["failed_archives"]], ["partial.7z"])
            self.assertTrue(app.is_ready(day))
            self.assertFalse(app.root_archive_import_is_current(signature))

    def test_new_archive_keeps_last_published_root_snapshot_visible(self):
        day = "2026-09-29"
        payload = {
            f"answers_{model.replace('_', '-').upper()}.jsonl": json.dumps(archive_row(model, model)) + "\n"
            for model in app.MODELS
        }
        (app.ARCHIVE_DIR / "first.7z").write_text(json.dumps(payload), encoding="utf-8")
        with patch.object(app, "SevenZipFile", FakeArchive):
            signature = app.archive_signature(app.ARCHIVE_DIR)
            app.process_archives(signature)
            self.assertTrue(app.is_ready(day))

            (app.ARCHIVE_DIR / "next.7z").write_text(json.dumps(payload), encoding="utf-8")

            self.assertTrue(app.is_ready(day))
            dashboard = app.dashboard_data()
            day_entry = next(item for item in dashboard["dates"] if item["date"] == day)
            self.assertTrue(day_entry["ready"])
            self.assertEqual(day_entry["models"]["a_fast"]["row_count"], 1)

    def test_progress_bridge_groups_checkpoint_cases_by_date_and_pair(self):
        inputs = {}
        tasks = {}

        def comparison(task_id, pair, day, case_id, status):
            left, right = ("a_fast", "b_fast") if pair == "fast" else ("a_expert", "b_expert")
            input_ids = {}
            for label, model in zip(("A", "B"), (left, right)):
                input_id = f"{task_id}-{label}"
                input_ids[label] = input_id
                inputs[input_id] = {
                    "version": model, "batch_id": "batch", "case_id": case_id,
                    "source": f"/inputs/{model}/{day}.jsonl",
                }
            tasks[task_id] = {
                "stage": "comparison", "status": status,
                "data": {"group": [left, right]}, "inputIds": input_ids,
            }

        comparison("fast-done", "fast", "2026-09-22", "one", "succeeded")
        comparison("fast-running", "fast", "2026-09-22", "two", "running")
        comparison("expert-blocked", "expert", "2026-09-23", "three", "blocked")
        tasks["rewrite"] = {"stage": "rewrite", "status": "failed", "data": {}, "inputIds": {}}
        state = {
            "status": "running", "engine": {"engine": "pi"}, "runId": "run-1", "startedAt": 123,
            "executionScope": ["expert-blocked"],
            "tasks": tasks, "inputs": inputs,
            "preflight": {"skipped": [{
                "batch_id": "batch", "case_id": "four", "versions": ["a_expert", "b_expert"],
                "sources": [{"source": "/inputs/a_expert/2026-09-23.jsonl"}],
            }, {
                "batch_id": "2026-09-23", "case_id": "five", "versions": ["a_expert", "b_expert"],
                "sources": [],
            }]},
        }
        later = {
            "status": "finished", "engine": {"engine": "pi"}, "runId": "run-2", "startedAt": 124,
            "tasks": {}, "inputs": {}, "preflight": {"skipped": []},
        }
        progress = bridge.progress_from_states([state, later], updated_at=200)
        by_date = {entry["date"]: entry["pairs"] for entry in progress["dates"]}
        self.assertEqual(progress["run_id"], "run-2")
        self.assertEqual(by_date["2026-09-22"]["fast"], {
            "total_cases": 2, "completed_cases": 1, "running_cases": 1,
            "queued_cases": 0, "failed_cases": 0, "skipped_cases": 0,
        })
        self.assertEqual(by_date["2026-09-23"]["expert"]["total_cases"], 3)
        self.assertEqual(by_date["2026-09-23"]["expert"]["failed_cases"], 1)
        self.assertEqual(by_date["2026-09-23"]["expert"]["skipped_cases"], 2)

    def test_progress_endpoint_accepts_date_pair_counts(self):
        empty_pair = {
            "total_cases": 0, "completed_cases": 0, "running_cases": 0,
            "queued_cases": 0, "failed_cases": 0, "skipped_cases": 0,
        }
        fast_pair = {
            "total_cases": 3, "completed_cases": 1, "running_cases": 0,
            "queued_cases": 0, "failed_cases": 0, "skipped_cases": 2,
        }
        payload = {
            "run_id": "sample-run", "engine": "pi", "status": "running",
            "started_at": 100, "updated_at": 200,
            "dates": [{"date": "2026-10-08", "pairs": {"fast": fast_pair, "expert": empty_pair}}],
        }
        request = Request(self.base + "/evaluation-progress", data=json.dumps(payload).encode(),
                          headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(request, timeout=3) as response:
            self.assertEqual(response.status, 200)
        dashboard = self.get_json("/dashboard-data")
        self.assertEqual(dashboard["dates"][0]["date"], "2026-10-08")
        progress = dashboard["evaluation"]
        self.assertEqual(progress["dates"][0]["pairs"]["fast"]["completed_cases"], 1)
        self.assertEqual(progress["dates"][0]["pairs"]["fast"]["total_cases"], 3)
        self.assertEqual(progress["dates"][0]["pairs"]["fast"]["skipped_cases"], 2)


if __name__ == "__main__":
    unittest.main()
