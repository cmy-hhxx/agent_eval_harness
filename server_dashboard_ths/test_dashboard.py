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
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError


ROOT = Path(__file__).resolve().parent
try:
    import py7zr
    HAS_PY7ZR = True
except ModuleNotFoundError:
    HAS_PY7ZR = False
    fake_py7zr = types.ModuleType("py7zr")
    fake_py7zr.SevenZipFile = object
    sys.modules.setdefault("py7zr", fake_py7zr)
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


class PostTrainingArchiveTest(unittest.TestCase):
    def test_v1_members_map_to_post_training_without_accepting_other_variants(self):
        for member in (
            "629d3a74073c434f_AA-post_train_fast_V1.incr00001.jsonl",
            "629d3a74073c434f_AA-post_train_fast_V1.incr00002.jsonl",
            "sub/run_B-post_train_fast_V1.jsonl",
            "AA-post_train_fast_v1.INCR00003.JSONL",
        ):
            with self.subTest(member=member):
                self.assertEqual(app.model_for_member(member), "b_post_train_fast")
        for member in ("AA-post_train_fast_V2.jsonl", "AA-post_train_fast_V10.jsonl",
                       "AA-post_train_fast_V1_extra.jsonl", "A-post_train_fast_V1.jsonl"):
            with self.subTest(member=member):
                self.assertIsNone(app.model_for_member(member))

    def test_v1_incremental_archives_publish_all_three_models(self):
        with tempfile.TemporaryDirectory(prefix="post-training-test-") as folder:
            root = Path(folder)
            post = app.Dataset(root / "archives", root / "state", app.POST_TRAINING_MODELS,
                               "/post_training_model")
            post.archive_dir.mkdir()
            post.state_dir.mkdir()
            names = ("629d3a74073c434f_20261020_141107.7z", "629d3a74073c434f_20261020_163255.7z")
            for increment, name in enumerate(names, 1):
                members = {}
                for model, label in zip(post.models, ("A-fast", "AA-fast", "AA-post_train_fast_V1")):
                    member = f"629d3a74073c434f_{label}.incr{increment:05}.jsonl"
                    rows = [archive_row(model, case, request_time="2026-10-20 14:00:00",
                                        answer=f"answer-{increment}", meta_fields={"testset_name": "post-20261019"})
                            for case in ("shared", f"increment-{increment}")]
                    members[member] = "".join(json.dumps(row) + "\n" for row in rows)
                (post.archive_dir / name).write_text(json.dumps(members), encoding="utf-8")
            signature = app.archive_signature(post.archive_dir)
            with patch.object(app, "SevenZipFile", FakeArchive):
                post.process_archives(signature)
            state = post.load_archive_state()
            self.assertEqual(state["failed_archives"], [])
            self.assertEqual(state["dates"], ["2026-10-19"])
            self.assertEqual(post.pending_archives(signature), [])
            for model in post.models:
                rows = [json.loads(line) for line in
                        (post.output_dir / model / "2026-10-19.jsonl").read_text().splitlines()]
                self.assertEqual({row["case_id"] for row in rows}, {"shared", "increment-1", "increment-2"})
                shared = next(row for row in rows if row["case_id"] == "shared")
                self.assertEqual(shared["messages"][-1]["content"], "answer-2")
                self.assertEqual(shared["version"], app.VERSION_NAMES[model])
                self.assertTrue(shared["_source"]["original_file"].startswith(names[1] + "/"))


class TraceFormatTest(unittest.TestCase):
    def test_sample_projection_exposes_stored_format_and_real_trace_ids(self):
        flat = archive_row("a_fast", "case")
        flat["trace_id"] = "actual-trace"
        flat["meta"].update(trace_id="session-alias", session_id="session-one", n_traces=4)
        view = app.visible_record(flat)
        self.assertEqual((view["format"], view["trace_id"], view["session_id"]), ("trace", "actual-trace", "session-one"))
        session = {"meta": {"session_id": "session-two", "trace_id": "outer-session"}, "traces": [
            {"meta": {"trace_id": "round-one"}, "messages": flat["messages"]},
            {"meta": {}, "messages": flat["messages"]},
        ]}
        view = app.visible_record(session)
        self.assertEqual((view["format"], view["session_id"]), ("session", "session-two"))
        self.assertEqual([turn["trace_id"] for turn in view["turns"]], ["round-one", None])
        self.assertNotIn("messages", json.dumps(view))

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
                self.assertEqual(app.visible_record(normalized), {"format": "trace", "trace_id": "actual-trace", "session_id": "thread-session", "question": "Question", "answer": "Answer"})
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
        self.data = app.Dataset(root / "archives", root / "state", app.ROOT_MODELS)
        self.gpt = app.Dataset(root / "archives" / "gpt", root / "state" / "gpt", app.MODELS, "/gpt")
        self.legacy_date_dir = root / "legacy-dates"
        self.data.archive_dir.mkdir(parents=True)
        self.gpt.archive_dir.mkdir()
        self.legacy_date_dir.mkdir()
        self.data.state_dir.mkdir()
        self.gpt.state_dir.mkdir()
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
            folder = self.data.output_dir / model
            folder.mkdir(parents=True)
            (folder / f"{self.day}.jsonl").write_text(json.dumps(row) + "\n", encoding="utf-8")
        for model in self.data.models:
            (self.data.output_dir / model).mkdir(parents=True, exist_ok=True)
        self.data.register_local_import(self.day)
        self.server = app.DashboardServer(("127.0.0.1", 0), {"": self.data, "/gpt": self.gpt})
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

    def test_post_training_archive_routes_progress_and_recovery_are_isolated(self):
        datasets = app.make_datasets(self.data.root, self.data.state_dir)
        post = datasets["/post_training_model"]
        self.server.datasets[post.prefix] = post
        post.archive_dir.mkdir()
        post.state_dir.mkdir()
        self.assertEqual(self.get_json(post.prefix + "/dashboard-data")["dates"], [])
        root_before = (self.data.output_dir / "a_fast" / f"{self.day}.jsonl").read_bytes()
        members = {}
        for model, member in zip(post.models, ("run_A-fast.jsonl", "run_AA-fast.incr00001.jsonl", "sub/run_AA-post_train_fast.jsonl")):
            self.assertEqual(app.model_for_member(member), model)
            self.assertEqual(app.model_for_member(f"run_{model}.incr00002.jsonl"), model)
            row = archive_row(model, "shared", request_time="2026-10-21 01:00:00",
                              meta_fields={"testset_name": "post-20261020"})
            if model == "b_post_train_fast":
                row["version"] = "AA post_train_fast"
            members[member] = json.dumps(row) + "\n"
        archive = post.archive_dir / "post_20261020_010000.7z"
        archive.write_text(json.dumps(members))
        signature = app.archive_signature(post.archive_dir)
        with patch.object(app, "SevenZipFile", FakeArchive):
            post.process_archives(signature)
        day = "2026-10-20"
        models = self.get_json(post.prefix + "/dashboard-data")["dates"][0]["models"]
        self.assertEqual(set(models), set(post.models))
        self.assertTrue(all(item == {"ready": True, "row_count": 1} for item in models.values()))
        for model in post.models:
            with urlopen(f"{self.base}{post.prefix}/data/{day}/{model}.jsonl") as response:
                row = json.loads(response.read())
                self.assertEqual(row["version"], app.VERSION_NAMES[model])
                self.assertEqual(row["batch_id"], day)
            self.assertEqual(self.get_json(f"{post.prefix}/records/{day}/{model}")["total"], 1)
        recovered = app.make_datasets(self.data.root, self.data.state_dir)[post.prefix]
        with patch.object(app, "SevenZipFile", side_effect=AssertionError("accepted archives must not replay")):
            recovered.process_archives(signature)
        recovered.archive_processed(signature)
        self.assertFalse(archive.exists())
        self.assertEqual(len(list(post.archived_dir.rglob("*.7z"))), 1)
        self.assertEqual((self.data.output_dir / "a_fast" / f"{self.day}.jsonl").read_bytes(), root_before)
        self.assertEqual(self.get_json("/gpt/dashboard-data")["dates"], [])
        tasks = {pair: {"stage": "comparison", "status": "succeeded", "data": {"group": list(post.models)},
                        "inputIds": {"A": left, "B": right}} for pair, (left, right) in post.pairs.items()}
        state = {"status": "finished", "engine": {"engine": "pi"}, "runId": "post", "startedAt": 1,
                 "tasks": tasks, "inputs": {model: {"version": model, "batch_id": day, "case_id": "shared"} for model in post.models},
                 "preflight": {"skipped": []}}
        progress = bridge.progress_from_states([state], updated_at=2, dataset="post_training_model")
        self.assertEqual(set(progress["dates"][0]["pairs"]), set(post.pairs))
        self.assertTrue(all(item["completed_cases"] == 1 for item in progress["dates"][0]["pairs"].values()))
        request = Request(self.base + post.prefix + "/evaluation-progress", data=json.dumps(progress).encode(),
                          headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(request) as response:
            self.assertEqual(response.status, 200)
        self.assertIsNone(self.get_json("/dashboard-data")["evaluation"])
        self.assertIsNone(self.get_json("/gpt/dashboard-data")["evaluation"])
        self.assertEqual(self.get_json(post.prefix + "/dashboard-data")["evaluation"]["dates"], progress["dates"])
        progress["dates"][0]["pairs"] = {"fast": dict.fromkeys(bridge.PAIR_FIELDS, 0)}
        request.data = json.dumps(progress).encode()
        with self.assertRaises(HTTPError) as error:
            urlopen(request)
        self.assertEqual(error.exception.code, 400)

    def test_six_model_files_are_discoverable_and_downloadable(self):
        for model in self.gpt.models:
            self.assertEqual(app.model_for_member(f"run_{model}.incr00002.jsonl"), model)
            folder = self.gpt.output_dir / model
            folder.mkdir(parents=True, exist_ok=True)
            row = archive_row(model, f"case-{model}")
            _, normalized = app.normalize_row(row, model, "source.7z", f"{model}.jsonl", 1)
            self.assertEqual(normalized["version"], app.VERSION_NAMES[model])
            (folder / f"{self.day}.jsonl").write_text(json.dumps(normalized) + "\n")
        self.gpt.register_local_import(self.day)
        catalog = self.get_json("/gpt/dashboard-data")
        self.assertEqual(len(catalog["dates"][0]["models"]), 6)
        for model in self.gpt.models:
            self.assertEqual(catalog["dates"][0]["models"][model], {"ready": True, "row_count": 1})
            with urlopen(f"{self.base}/gpt/data/{self.day}/{model}.jsonl", timeout=3) as response:
                self.assertEqual(json.loads(response.read())["version"], app.VERSION_NAMES[model])
            self.assertEqual(self.get_json(f"/gpt/records/{self.day}/{model}")["total"], 1)

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

    def test_gpt_processing_is_incremental_isolated_and_archived(self):
        name = "1234567890abcdef_20261019_010000.7z"
        day = "2026-09-29"
        def write(dataset, members):
            (dataset.archive_dir / name).write_text(json.dumps({
                f"run_{model}.jsonl": json.dumps(archive_row(model, "same-case", answer=answer)) + "\n"
                for model, answer in members.items()
            }), encoding="utf-8")

        write(self.data, {"a_fast": "original root"})
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        root_files = list(self.data.output_dir.rglob("*")) + [
            path for path in self.data.state_dir.rglob("*") if "gpt" not in path.relative_to(self.data.state_dir).parts
        ]
        before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in root_files if path.is_file()}
        write(self.gpt, {"a_fast": "GPT old", "6_luna": "Luna"})
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.gpt.process_archives(app.archive_signature(self.gpt.archive_dir))
        models = self.get_json("/gpt/dashboard-data")["dates"][0]["models"]
        self.assertEqual([model for model, item in models.items() if item["ready"]], ["a_fast", "6_luna"])
        self.assertEqual(self.get_json("/gpt/dates")["dates"], [{"date": day, "models": ["6_luna", "a_fast"]}])
        with self.assertRaises(HTTPError) as error:
            urlopen(f"{self.base}/gpt/data/{day}/6.1sol.jsonl")
        self.assertEqual(error.exception.code, 404)
        luna = self.gpt.output_dir / "6_luna" / f"{day}.jsonl"
        luna_before = (luna.read_bytes(), luna.stat().st_mtime_ns)
        write(self.gpt, {"a_fast": "GPT new", "6.1sol": "Sol"})
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.gpt.process_archives(app.archive_signature(self.gpt.archive_dir))
        self.assertEqual(self.get_json(f"/gpt/records/{day}/a_fast")["items"][0]["answer"], "GPT new")
        self.assertEqual(self.get_json(f"/records/{day}/a_fast")["items"][0]["answer"], "original root")
        self.assertEqual((luna.read_bytes(), luna.stat().st_mtime_ns), luna_before)
        signature = app.archive_signature(self.gpt.archive_dir)
        with patch.object(app, "SevenZipFile", side_effect=AssertionError("unchanged archive must not replay")):
            self.gpt.process_archives(signature)
        self.gpt.archive_processed(signature)
        self.assertFalse((self.gpt.archive_dir / name).exists())
        self.assertTrue((self.gpt.archived_dir / "2026-10-19" / "part-0001" / name).exists())
        self.assertEqual({path: (path.read_bytes(), path.stat().st_mtime_ns) for path in before}, before)
        self.assertEqual(self.get_json(f"/gpt/records/{day}/6.1sol")["total"], 1)

    def test_gpt_routes_and_progress_do_not_read_or_overwrite_root(self):
        self.assertEqual(self.get_json("/gpt/dashboard-data"), {"dates": [], "evaluation": None})
        self.assertEqual(self.get_json("/gpt/dates"), {"dates": []})
        for prefix in ("", "/gpt"):
            with urlopen(self.base + prefix + "/") as response:
                html = response.read().decode()
            self.assertIn(f'href="{prefix}/dashboard.css"', html)
            self.assertIn(f'src="{prefix}/dashboard.js"', html)
            self.assertNotIn("__BASE__", html)
        counts = dict.fromkeys(bridge.PAIR_FIELDS, 0)
        counts.update({"total_cases": 3, "completed_cases": 3})
        payload = {"run_id": "six-model-test", "engine": "pi", "status": "finished",
                   "started_at": 100, "updated_at": 200, "dates": [
                       {"date": f"2026-10-{day:02d}", "pairs": {pair: counts for pair in self.gpt.pairs}}
                       for day in range(1, 20)
                   ]}
        self.assertGreater(len(json.dumps(payload)), 8192)
        def post(prefix, body):
            request = Request(self.base + prefix + "/evaluation-progress", data=json.dumps(body).encode(),
                              headers={"Content-Type": "application/json"}, method="POST")
            return urlopen(request, timeout=3)
        with post("/gpt", payload) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(self.get_json("/gpt/dashboard-data")["evaluation"]["dates"], payload["dates"])
        self.assertIsNone(self.get_json("/dashboard-data")["evaluation"])
        with self.assertRaises(HTTPError) as error:
            post("", payload)
        self.assertEqual(error.exception.code, 400)
        payload["dates"] = [{"date": self.day, "pairs": {"fast": counts}}]
        with self.assertRaises(HTTPError) as error:
            post("/gpt", payload)
        self.assertEqual(error.exception.code, 400)

    def test_root_progress_accepts_all_dates_with_a_bounded_request(self):
        counts = dict.fromkeys(bridge.PAIR_FIELDS, 0)
        counts.update({"total_cases": 3, "completed_cases": 3})
        payload = {"run_id": "daily-all-dates", "engine": "pi", "status": "running",
                   "started_at": 100, "updated_at": 200, "dates": [
                       {"date": f"2026-10-{day:02d}", "pairs": {pair: counts for pair in self.data.pairs}}
                       for day in range(1, 32)
                   ]}
        body = json.dumps(payload).encode()
        self.assertGreater(len(body), 8192)
        request = Request(self.base + "/evaluation-progress", data=body,
                          headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(request, timeout=3) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(self.get_json("/dashboard-data")["evaluation"]["dates"], payload["dates"])
        self.assertIsNone(self.get_json("/gpt/dashboard-data")["evaluation"])
        request = Request(self.base + "/evaluation-progress", data=b"{}",
                          headers={"Content-Type": "application/json", "Content-Length": str(1024 * 1024 + 1)}, method="POST")
        with self.assertRaises(HTTPError) as error:
            urlopen(request, timeout=3)
        self.assertEqual(error.exception.code, 413)
        self.assertEqual(self.get_json("/dashboard-data")["evaluation"]["dates"], payload["dates"])

    @unittest.skipUnless(HAS_PY7ZR, "real 7z integration requires requirements.txt")
    def test_real_gpt_7z_extracts_six_models_and_single_trace_messages(self):
        path = self.gpt.archive_dir / "abcdef0123456789_20261019_020000.7z"
        day = "2026-10-15"
        with app.SevenZipFile(path, mode="w") as archive:
            for model in self.gpt.models:
                row = trace_row(model)
                if model in ("6_luna", "6.1sol"):
                    row["traces"][0]["messages"] = [
                        {"role": "user", "content": "Question"},
                        {"role": "assistant", "content": "GPT answer"},
                    ]
                member = f"nested/run_{model}.incr00002.jsonl"
                archive.writestr(json.dumps(row) + "\n", member)
        self.gpt.process_archives(app.archive_signature(self.gpt.archive_dir))
        catalog = self.get_json("/gpt/dashboard-data")
        self.assertEqual(catalog["dates"][0]["date"], day)
        self.assertTrue(all(item == {"ready": True, "row_count": 1} for item in catalog["dates"][0]["models"].values()))
        for model in self.gpt.models:
            with urlopen(f"{self.base}/gpt/data/{day}/{model}.jsonl") as response:
                row = json.loads(response.read())
            self.assertEqual(row["version"], app.VERSION_NAMES[model])
            self.assertEqual(row["trace_id"], "actual-trace")
            self.assertNotIn("traces", row)
        self.assertEqual(len(self.get_json("/dashboard-data")["dates"]), 1)

    @unittest.skipUnless(HAS_PY7ZR, "real 7z integration requires requirements.txt")
    def test_gpt_collector_names_and_sol_spans_are_published_without_losing_messages(self):
        path = self.gpt.archive_dir / "646afd038ef24b84.7z"
        names = {"a_fast": "A-fast", "b_fast": "AA-fast", "a_expert": "A-expert", "b_expert": "AA-expert",
                 "6_luna": "GPT-luna", "6.1sol": "GPT-sol"}
        originals = {}
        with app.SevenZipFile(path, "w") as archive:
            for model, name in names.items():
                row = trace_row(model)
                row["meta"]["ask_time"] = 1792156215804
                row["meta"]["testset_name"] = "complex_queries_rued_20261016"
                if model in ("6_luna", "6.1sol"):
                    row["meta"]["ask_time"] = 1792415415804  # Collected three days after the test set.
                    row["traces"][0]["meta"].pop("timestamp")
                    row["traces"][0]["messages"] = [{"type": "message", "role": "user", "content": "Question"},
                                                           {"type": "message", "role": "assistant", "content": "GPT answer"}]
                if model == "6.1sol":
                    row["traces"][0]["messages"].insert(1, {"type": "span", "name": "reasoning", "duration": 165200})
                originals[model] = row["traces"][0]["messages"]
                archive.writestr(json.dumps(row) + "\n", f"646afd038ef24b84/646afd038ef24b84_{name}.jsonl")
        self.gpt.process_archives(app.archive_signature(self.gpt.archive_dir))
        state = json.loads(self.gpt.root_archive_state_file.read_text())
        self.assertEqual(state["failed_archives"], [])
        for model in self.gpt.models:
            day = "2026-10-16"
            with urlopen(f"{self.base}/gpt/data/{day}/{model}.jsonl") as response:
                result = json.load(response)
            self.assertEqual(result["messages"], originals[model])
            self.assertEqual(result["version"], app.VERSION_NAMES[model])
            self.assertEqual(result["batch_id"], "2026-10-16")
            self.assertEqual(result["meta"]["ask_time"], 1792415415804 if model in ("6_luna", "6.1sol") else 1792156215804)
        self.assertEqual(len(self.get_json("/dashboard-data")["dates"]), 1)

    def test_gpt_progress_bridge_reports_all_six_actual_pairings(self):
        groups = (("a_fast", "b_fast", "6_luna"), ("a_expert", "b_expert", "6.1sol"))
        inputs = {model: {"version": model, "batch_id": self.day, "case_id": "same-case"}
                  for group in groups for model in group}
        tasks = {pair: {"stage": "comparison", "status": "succeeded", "data": {"group": list(group)},
                        "inputIds": {"A": left, "B": right}}
                 for group in groups for index, left in enumerate(group) for right in group[index + 1:]
                 for pair in ["__vs__".join(sorted((left, right)))]}
        state = {"status": "finished", "engine": {"engine": "pi"}, "runId": "six", "startedAt": 1,
                 "tasks": tasks, "inputs": inputs, "preflight": {"skipped": []}}
        progress = bridge.progress_from_states([state], updated_at=2, dataset="gpt")
        pairs = progress["dates"][0]["pairs"]
        self.assertEqual(set(pairs), set(self.gpt.pairs))
        self.assertTrue(all(counts["completed_cases"] == 1 for counts in pairs.values()))

    def test_incremental_archives_merge_partial_models_and_replace_same_source_cases(self):
        def write_archive(name, members):
            payload = {
                member: "\n".join(json.dumps(row) for row in rows) + "\n"
                for member, rows in members.items()
            }
            (self.data.archive_dir / name).write_text(json.dumps(payload), encoding="utf-8")

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
            self.data.process_archives(app.archive_signature(self.data.archive_dir))

        def rows(model):
            path = self.data.output_dir / model / "2026-09-29.jsonl"
            return [json.loads(line) for line in path.read_text().splitlines()]

        a_fast = rows("a_fast")
        self.assertEqual(len(a_fast), 3)
        shared = next(row for row in a_fast if row["case_id"] == "shared")
        self.assertEqual(shared["messages"][-1]["content"], "latest answer")
        a_expert = rows("a_expert")
        self.assertEqual({row["case_id"] for row in a_expert}, {"expert-base", "delta-one", "delta-two"})
        self.assertEqual(len(rows("b_fast")), 1)
        self.assertEqual(len(rows("b_expert")), 1)
        state = json.loads(self.data.root_archive_state_file.read_text())
        self.assertEqual(state["failed_archives"], [])
        self.assertEqual(self.data.pending_archives(state["archives"]), [])

    def test_records_api_projects_format_identifiers_and_visible_answers(self):
        a_fast = self.get_json(f"/records/{self.day}/a_fast")
        self.assertEqual(a_fast["items"][0], {
            "format": "trace", "trace_id": None, "session_id": None, "question": "A question", "answer": "A final answer", "standard_answer": "A standard"
        })
        b_fast = self.get_json(f"/records/{self.day}/b_fast")
        self.assertEqual(b_fast["items"][0], {
            "format": "trace", "trace_id": None, "session_id": None, "question": "B question", "answer": "B final answer", "standard_answer": "B standard"
        })
        a_expert = self.get_json(f"/records/{self.day}/a_expert")
        self.assertEqual(a_expert["items"][0], {"format": "trace", "trace_id": None, "session_id": None, "question": "No reference", "answer": "Answer"})
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
        for model in self.data.models:
            model_dir = self.data.output_dir / model
            (model_dir / f"{new_data_day}.jsonl").write_text("{}\n", encoding="utf-8")
        self.data.progress_file.write_text(json.dumps({
            "status": "running", "updated_at": 0,
            "dates": [{"date": progress_only_day}],
        }), encoding="utf-8")

        data = self.get_json("/dashboard-data")
        dates = [entry["date"] for entry in data["dates"]]
        self.assertEqual(dates, [progress_only_day, new_data_day, self.day])
        self.assertFalse(data["dates"][1]["ready"])

    def test_dashboard_has_no_download_control_and_uses_current_model_labels(self):
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

    def test_root_archive_preserves_local_import_and_processes_other_dates(self):
        archive_day = "2026-09-29"
        previous = {
            model: (self.data.output_dir / model / f"{self.day}.jsonl").read_bytes()
            for model in self.records
        }
        payload = {}
        for model in self.data.models:
            member = f"answers_{model.upper()}.jsonl"
            rows = [
                archive_row(model, f"local-{model}", request_time=f"{self.day} 12:00:00"),
                archive_row(model, f"archive-{model}", request_time=f"{archive_day} 12:00:00"),
            ]
            payload[member] = "\n".join(json.dumps(row) for row in rows) + "\n"
        (self.data.archive_dir / "later.7z").write_text(json.dumps(payload), encoding="utf-8")

        with patch.object(app, "SevenZipFile", FakeArchive):
            signature = app.archive_signature(self.data.archive_dir)
            self.data.process_archives(signature)

        for model in self.records:
            self.assertEqual((self.data.output_dir / model / f"{self.day}.jsonl").read_bytes(), previous[model])
        self.assertTrue(self.data.is_ready(self.day))
        for model in self.data.models:
            archive_rows = (self.data.output_dir / model / f"{archive_day}.jsonl").read_text().splitlines()
            self.assertEqual(len(archive_rows), 1)
            self.assertEqual(json.loads(archive_rows[0])["case_id"], f"archive-{model}")
        self.assertTrue(self.data.is_ready(archive_day))
        root_state = json.loads(self.data.root_archive_state_file.read_text())
        self.assertEqual(root_state["archives"], signature)
        self.assertEqual(root_state["dates"], [archive_day])

    def test_archive_mixes_flat_messages_and_single_traces(self):
        day = "2026-10-15"
        previous = (self.data.output_dir / "b_fast" / f"{self.day}.jsonl").read_bytes()
        payload = {}
        for model in self.data.models:
            rows = [trace_row(model), archive_row(model, "flat-case", request_time=f"{day} 00:30:00")]
            member = f"answers_{(model.replace('b_', 'aa_').replace('_', '-') if model.startswith(('a_', 'b_')) else model).upper()}.incr00091.jsonl"
            payload[member] = "\n".join(json.dumps(row) for row in rows) + "\n"
        (self.data.archive_dir / "new.7z").write_text(json.dumps(payload), encoding="utf-8")
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        data = self.get_json("/dashboard-data")
        self.assertEqual(data["dates"][0]["date"], day)
        self.assertTrue(data["dates"][0]["ready"])
        for model in self.data.models:
            self.assertEqual(data["dates"][0]["models"][model]["row_count"], 2)
            records = self.get_json(f"/records/{day}/{model}")
            self.assertEqual([{key: item[key] for key in ("question", "answer")} for item in records["items"]], [{"question": "Question", "answer": "Answer"}] * 2)
            self.assertTrue(all(item["format"] == "trace" for item in records["items"]))
        self.assertEqual((self.data.output_dir / "b_fast" / f"{self.day}.jsonl").read_bytes(), previous)

    def test_root_archives_group_filter_and_emit_required_header_fields(self):
        day_next = "2026-09-30"
        shanghai = ZoneInfo("Asia/Shanghai")
        ask_time = int(datetime(2026, 9, 30, 12, 0, tzinfo=shanghai).timestamp() * 1000)
        payload = {}
        for model in self.data.models:
            member = f"answers_{model.upper()}.jsonl"
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
        (self.data.archive_dir / "daily.7z").write_text(json.dumps(payload), encoding="utf-8")

        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))

        for model in self.data.models:
            for day in ("2026-09-28", "2026-09-29", day_next):
                path = self.data.output_dir / model / f"{day}.jsonl"
                rows = [json.loads(line) for line in path.read_text().splitlines()]
                self.assertEqual(len(rows), 1)
                self.assertEqual(list(rows[0])[:3], ["request_time", "has_standard_answer", "versions"])
                self.assertIsInstance(rows[0]["has_standard_answer"], bool)
                expected_versions = "0929-big-fast" if model == "b_fast" and day >= "2026-09-29" else "default"
                self.assertEqual(rows[0]["versions"], expected_versions)
                self.assertTrue(self.data.is_ready(day))
                if day == "2026-09-29":
                    self.assertEqual(rows[0]["request_time"], "2026-09-29 11:00:00")
                    self.assertTrue(rows[0]["has_standard_answer"])
                elif day == day_next:
                    self.assertEqual(rows[0]["request_time"], "2026-09-30 12:00:00")
                    self.assertFalse(rows[0]["has_standard_answer"])
                else:
                    self.assertEqual(rows[0]["request_time"], "2026-09-28 11:00:00")
                    self.assertFalse(rows[0]["has_standard_answer"])

    def test_incremental_only_opens_new_archives_and_keeps_other_dates_untouched(self):
        def write_archive(name, day):
            payload = {"answers_A-fast.jsonl": json.dumps(archive_row("a_fast", name, request_time=f"{day} 12:00:00")) + "\n"}
            (self.data.archive_dir / name).write_text(json.dumps(payload), encoding="utf-8")

        opened = []

        class TrackedArchive(FakeArchive):
            def __init__(self, path, mode):
                opened.append(Path(path).name)
                super().__init__(path, mode)

        write_archive("old.7z", "2026-09-29")
        with patch.object(app, "SevenZipFile", TrackedArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
            historical = [self.data.output_dir / model / "2026-09-29.jsonl" for model in self.data.models]
            historical += [self.data.record_index_path("2026-09-29", model) for model in self.data.models]
            historical.append(self.data.ready_path("2026-09-29"))
            before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in historical}
            opened.clear()
            write_archive("new.7z", "2026-10-19")
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
            self.assertEqual(opened, ["new.7z"])
            self.assertEqual({path: (path.read_bytes(), path.stat().st_mtime_ns) for path in historical}, before)
            opened.clear()
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
            self.assertEqual(opened, [])
        self.assertEqual(self.get_json("/records/2026-10-19/a_fast")["total"], 1)

    def test_archives_only_successful_unchanged_packages_without_changing_published_data(self):
        name = "0123456789abcdef_20261019_010000.7z"
        payload = json.dumps({"answers_A-fast.jsonl": json.dumps(archive_row("a_fast", "one")) + "\n"})
        path = self.data.archive_dir / name
        path.write_text(payload)
        broken = self.data.archive_dir / "broken.7z"
        broken.write_text("unfinished")
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        files = list(self.data.output_dir.glob("*/*.jsonl")) + list(self.data.state_dir.glob("*.ready.json")) + list(self.data.state_dir.glob("records/*/*.json"))
        before = {file: (file.read_bytes(), file.stat().st_mtime_ns) for file in files}
        receipts = self.data.root_archive_state_file.read_bytes()
        metadata = app.file_signature(path)
        (self.data.archive_dir / "new.7z").write_text(payload)
        self.data.archive_processed(app.archive_signature(self.data.archive_dir))
        archived = self.data.archived_dir / "2026-10-19" / "part-0001" / name
        self.assertEqual(archived.read_text(), payload)
        self.assertEqual(app.file_signature(archived), metadata)
        self.assertFalse(path.exists())
        self.assertTrue(broken.exists())
        self.assertTrue((self.data.archive_dir / "new.7z").exists())
        self.assertEqual(self.data.root_archive_state_file.read_bytes(), receipts)
        self.assertEqual({file: (file.read_bytes(), file.stat().st_mtime_ns) for file in files}, before)
        with patch.object(app, "SevenZipFile", side_effect=AssertionError("must not replay archived packages")):
            self.data.process_archives([app.file_signature(broken)])
        self.assertTrue(self.data.is_ready("2026-09-29"))

    def test_archiving_keeps_reuploads_and_incrementally_merges_the_same_name(self):
        name = "0123456789abcdef_20261019_010000.7z"
        path = self.data.archive_dir / name
        payloads = []
        with patch.object(app, "SevenZipFile", FakeArchive):
            for case in ("one", "two"):
                payload = json.dumps({"answers_A-fast.jsonl": json.dumps(archive_row("a_fast", case)) + "\n"})
                payloads.append(payload)
                path.write_text(payload)
                self.data.process_archives(app.archive_signature(self.data.archive_dir))
                self.data.archive_processed(app.archive_signature(self.data.archive_dir))
                self.assertFalse(path.exists())
        archived = list(self.data.archived_dir.rglob("*.7z"))
        self.assertEqual(len(archived), 2)
        self.assertEqual({file.name for file in archived}, {name})
        self.assertEqual({file.read_text() for file in archived}, set(payloads))
        self.assertEqual(self.get_json("/records/2026-09-29/a_fast")["total"], 2)
        self.assertEqual(self.data.pending_archives(app.archive_signature(self.data.archive_dir)), [])

    def test_archive_inspection_partitions_history_without_reextracting_or_changing_files(self):
        folder = self.data.archived_dir / "2026-10-19"
        paths = [folder / "a.7z", folder / "b.7z", folder / "reuploads" / "one" / "a.7z",
                 *[folder / "part-0001" / f"old-{i}.7z" for i in range(3)], folder / "large.7z"]
        for index, path in enumerate(paths):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(bytes([index + 1]) * (11 if path.name == "large.7z" else 4))
        before = {(p.stat().st_ino, p.stat().st_mtime_ns, p.read_bytes()) for p in paths}
        published = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.data.output_dir.glob("*/*.jsonl")}
        with patch.object(self.data, "archive_part_files", 2), patch.object(app, "ARCHIVE_PART_BYTES", 10), \
             patch.object(app, "SevenZipFile", side_effect=AssertionError("must not decompress archives")):
            report = self.data.organize_archives()
            after = list(self.data.archived_dir.glob("*/part-*/*.7z"))
            self.assertEqual(report["packages"], len(paths))
            self.assertEqual(report["bytes"], sum(len(raw) for _, _, raw in before))
            self.assertEqual(len(report["oversized"]), 1)
            self.assertEqual({(p.stat().st_ino, p.stat().st_mtime_ns, p.read_bytes()) for p in after}, before)
            for part in {p.parent for p in after}:
                files = list(part.glob("*.7z"))
                self.assertLessEqual(len(files), 2)
                self.assertTrue(sum(p.stat().st_size for p in files) <= 10 or len(files) == 1)
            snapshot = {p: p.stat().st_mtime_ns for p in after}
            self.data.organize_archives()
            self.assertEqual({p: p.stat().st_mtime_ns for p in self.data.archived_dir.glob("*/part-*/*.7z")}, snapshot)
        self.assertEqual({p: (p.read_bytes(), p.stat().st_mtime_ns) for p in published}, published)

    def test_processing_status_distinguishes_unprocessed_failures_and_archive_inspection(self):
        self.assertEqual(self.get_json("/gpt/processing-status"), {
            "received_at": None, "published_at": None, "pending": 0, "failed": [], "archive": None, "error": None,
        })
        broken = self.gpt.archive_dir / "broken.7z"
        broken.write_text("incomplete")
        self.assertEqual(self.get_json("/gpt/processing-status")["pending"], 1)
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.gpt.process_archives(app.archive_signature(self.gpt.archive_dir))
        self.gpt.organize_archives()
        status = self.get_json("/gpt/processing-status")
        self.assertEqual(status["pending"], 0)
        self.assertEqual(status["failed"][0]["name"], "broken.7z")
        self.assertEqual(status["received_at"], broken.stat().st_mtime_ns // 1_000_000)
        self.assertEqual(status["archive"]["packages"], 0)
        self.assertEqual(self.get_json("/processing-status")["failed"], [])

    def test_archive_inspection_command_does_not_process_input_packages(self):
        with patch.object(app.sys, "argv", ["app.py", "--organize-archives"]), \
             patch.object(app, "make_datasets", return_value={"": self.data, "/gpt": self.gpt}), \
             patch.object(app.Dataset, "process_archives", side_effect=AssertionError("must not process new inputs")):
            app.main()
        self.assertTrue((self.data.state_dir / "archive-maintenance.json").is_file())
        self.assertTrue((self.gpt.state_dir / "archive-maintenance.json").is_file())

    def test_archiving_defers_changed_or_open_for_writing_packages(self):
        path = self.data.archive_dir / "writing.7z"
        payload = json.dumps({"answers_A-fast.jsonl": json.dumps(archive_row("a_fast", "one")) + "\n"})
        path.write_text(payload)
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        signature = app.archive_signature(self.data.archive_dir)
        with patch.object(self.data, "open_archive_writers", return_value={path.name}):
            self.data.archive_processed(signature)
        self.assertTrue(path.exists())
        path.write_text(payload + " ")
        self.data.archive_processed(signature)
        self.data.archive_processed(app.archive_signature(self.data.archive_dir))
        self.assertTrue(path.exists())
        self.assertFalse(self.data.archived_dir.exists())

    def test_failed_archive_move_leaves_source_and_receipt_for_retry(self):
        path = self.data.archive_dir / "move.7z"
        path.write_text(json.dumps({"answers_A-fast.jsonl": json.dumps(archive_row("a_fast", "one")) + "\n"}))
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        signature = app.archive_signature(self.data.archive_dir)
        receipts = self.data.root_archive_state_file.read_bytes()
        with patch.object(Path, "rename", side_effect=OSError("move unavailable")):
            with self.assertRaisesRegex(OSError, "move unavailable"):
                self.data.archive_processed(signature)
        self.assertTrue(path.exists())
        self.assertEqual(self.data.root_archive_state_file.read_bytes(), receipts)
        self.data.archive_processed(signature)
        self.assertFalse(path.exists())
        self.assertTrue(self.data.is_ready("2026-09-29"))

    def test_same_name_archive_growth_and_new_archive_merge_without_duplicates(self):
        day = "2026-09-29"

        def write_archive(name, case_ids):
            payload = {}
            for model in self.data.models:
                member = f"answers_{model.upper()}.jsonl"
                payload[member] = "\n".join(
                    json.dumps(archive_row(model, f"{case_id}-{model}")) for case_id in case_ids
                ) + "\n"
            (self.data.archive_dir / name).write_text(json.dumps(payload), encoding="utf-8")

        def count_rows(model):
            path = self.data.output_dir / model / f"{day}.jsonl"
            return len(path.read_text().splitlines())

        write_archive("first.7z", ["first"])
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
            self.assertTrue(self.data.is_ready(day))
            previous_signature = app.archive_signature(self.data.archive_dir)
            write_archive("first.7z", ["first", "grown"])
            grown_signature = app.archive_signature(self.data.archive_dir)
            self.assertNotEqual(previous_signature, grown_signature)
            self.data.process_archives(grown_signature)
            for model in self.data.models:
                self.assertEqual(count_rows(model), 2)
            write_archive("second.7z", ["second"])
            (self.data.archive_dir / "partial.7z").write_bytes(b"not a complete archive")
            signature = app.archive_signature(self.data.archive_dir)
            self.data.process_archives(signature)
            self.data.process_archives(signature)
            for model in self.data.models:
                self.assertEqual(count_rows(model), 3)
            root_state = json.loads(self.data.root_archive_state_file.read_text())
            self.assertEqual([item["name"] for item in root_state["failed_archives"]], ["partial.7z"])
            self.assertTrue(self.data.is_ready(day))
            self.assertEqual(self.data.pending_archives(signature), [])

    def test_changed_archive_upserts_valid_rows_without_removing_previous_rows(self):
        name = "0123456789abcdef_20261019_010000.7z"

        def write(name, rows):
            payload = {"answers_A-fast.jsonl": "\n".join(json.dumps(row) for row in rows) + "\n"}
            (self.data.archive_dir / name).write_text(json.dumps(payload), encoding="utf-8")

        with patch.object(app, "SevenZipFile", FakeArchive):
            shared = archive_row("a_fast", "shared", answer="old")
            shared["_source"] = {"original_file": "untrusted.7z/answers_A-fast.jsonl"}
            write(name, [archive_row("a_fast", "kept"), shared])
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
            other = self.data.output_dir / "b_fast" / "2026-09-29.jsonl"
            before = (other.read_bytes(), other.stat().st_mtime_ns)
            write(name, [archive_row("a_fast", "shared", answer="new"), archive_row("a_fast", "added")])
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
            self.assertEqual((other.read_bytes(), other.stat().st_mtime_ns), before)
            rows = [json.loads(line) for line in (self.data.output_dir / "a_fast" / "2026-09-29.jsonl").read_text().splitlines()]
            self.assertEqual({row["case_id"] for row in rows}, {"kept", "shared", "added"})
            self.assertEqual(next(row for row in rows if row["case_id"] == "shared")["messages"][-1]["content"], "new")
            write("0123456789abcdef_20261019_020000.7z", [archive_row("a_fast", "shared", answer="latest")])
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
            current = self.data.output_dir / "a_fast" / "2026-09-29.jsonl"
            before = (current.read_bytes(), current.stat().st_mtime_ns)
            write(name, [archive_row("a_fast", "shared", answer="older archive corrected later")])
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
            self.assertEqual((current.read_bytes(), current.stat().st_mtime_ns), before)
            write("fedcba9876543210_20261019_030000.7z", [archive_row("a_fast", "shared", answer="independent source")])
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
            self.assertEqual(self.get_json("/records/2026-09-29/a_fast")["total"], 4)

    def test_corrected_request_date_moves_only_the_same_business_record(self):
        path = self.data.archive_dir / "same.7z"

        def write(day):
            row = archive_row("a_fast", "move", request_time=f"{day} 12:00:00", meta_fields={"batch_id": "fixed-batch"})
            path.write_text(json.dumps({"answers_A-fast.jsonl": json.dumps(row) + "\n"}), encoding="utf-8")

        with patch.object(app, "SevenZipFile", FakeArchive):
            write("2026-10-18")
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
            write("2026-10-19")
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        self.assertEqual(self.get_json("/records/2026-10-18/a_fast")["total"], 0)
        self.assertEqual(self.get_json("/records/2026-10-19/a_fast")["total"], 1)

    def test_unrelated_arriving_archive_does_not_discard_a_stable_archive(self):
        payload = json.dumps({"answers_A-fast.jsonl": json.dumps(archive_row("a_fast", "one")) + "\n"})
        (self.data.archive_dir / "first.7z").write_text(payload, encoding="utf-8")
        signature = app.archive_signature(self.data.archive_dir)
        archive_dir = self.data.archive_dir

        class ArrivingArchive(FakeArchive):
            def extract(self, path, targets):
                super().extract(path, targets)
                (archive_dir / "arriving.7z").write_text(payload, encoding="utf-8")

        with patch.object(app, "SevenZipFile", ArrivingArchive):
            self.data.process_archives(signature)
        self.assertTrue(self.data.is_ready("2026-09-29"))
        self.assertEqual([item["name"] for item in self.data.pending_archives(app.archive_signature(self.data.archive_dir))], ["arriving.7z"])

    def test_an_archive_changing_during_read_is_deferred_without_losing_old_data(self):
        payload = json.dumps({"answers_A-fast.jsonl": json.dumps(archive_row("a_fast", "one")) + "\n"})
        path = self.data.archive_dir / "changing.7z"
        path.write_text(payload, encoding="utf-8")
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        target = self.data.output_dir / "a_fast" / "2026-09-29.jsonl"
        before = (target.read_bytes(), target.stat().st_mtime_ns)
        payload = json.dumps({"answers_A-fast.jsonl": "\n".join(json.dumps(archive_row("a_fast", case)) for case in ("one", "two")) + "\n"})
        path.write_text(payload, encoding="utf-8")

        class GrowingArchive(FakeArchive):
            def extract(self, folder=None, targets=None, **kwargs):
                super().extract(kwargs.get("path", folder), targets)
                path.write_text(payload + " ", encoding="utf-8")

        with patch.object(app, "SevenZipFile", GrowingArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        self.assertTrue(self.data.is_ready("2026-09-29"))
        self.assertEqual((target.read_bytes(), target.stat().st_mtime_ns), before)
        self.assertEqual(len(self.data.pending_archives(app.archive_signature(self.data.archive_dir))), 1)
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        self.assertTrue(self.data.is_ready("2026-09-29"))
        self.assertEqual(self.get_json("/records/2026-09-29/a_fast")["total"], 2)

    def test_publication_recovers_after_a_partial_file_replacement_without_reextracting(self):
        path = self.data.archive_dir / "recover.7z"

        def write(cases):
            path.write_text(json.dumps({"answers_A-fast.jsonl": "\n".join(json.dumps(archive_row("a_fast", case)) for case in cases) + "\n"}), encoding="utf-8")

        with patch.object(app, "SevenZipFile", FakeArchive):
            write(["one"])
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
            write(["one", "two"])
            original = self.data.publish_pending

            def interrupt(db):
                saved = db.execute("SELECT plan FROM pending WHERE id = 1").fetchone()
                if saved:
                    plan = json.loads(saved[0])
                    self.data.ready_path("2026-09-29").unlink()
                    artifact = plan["files"][0]
                    os.replace(artifact["stage"], artifact["target"])
                    raise RuntimeError("simulated interruption")
                original(db)

            with patch.object(self.data, "publish_pending", side_effect=interrupt):
                with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
                    self.data.process_archives(app.archive_signature(self.data.archive_dir))
        with patch.object(app, "SevenZipFile", side_effect=AssertionError("must not extract again")):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        self.assertTrue(self.data.is_ready("2026-09-29"))
        self.assertEqual(self.get_json("/records/2026-09-29/a_fast")["total"], 2)

    def test_first_identity_index_reads_published_data_without_replaying_archives(self):
        path = self.data.archive_dir / "baseline.7z"
        path.write_text(json.dumps({"answers_A-fast.jsonl": json.dumps(archive_row("a_fast", "one")) + "\n"}), encoding="utf-8")
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        files = list(self.data.output_dir.glob("*/*.jsonl")) + list(self.data.state_dir.glob("*.ready.json"))
        before = {file: (file.read_bytes(), file.stat().st_mtime_ns) for file in files}
        (self.data.state_dir / "archive-records.sqlite").unlink()
        with patch.object(app, "SevenZipFile", side_effect=AssertionError("must not replay baseline")):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        self.assertEqual({file: (file.read_bytes(), file.stat().st_mtime_ns) for file in files}, before)

    def test_unchanged_failed_archives_are_not_retried_but_a_replacement_is(self):
        path = self.data.archive_dir / "broken.7z"
        path.write_text("unfinished archive", encoding="utf-8")
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        with patch.object(app, "SevenZipFile", side_effect=AssertionError("unchanged failure must not retry")):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        path.write_text(json.dumps({"answers_A-fast.jsonl": json.dumps(archive_row("a_fast", "fixed")) + "\n"}), encoding="utf-8")
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        self.assertEqual(json.loads(self.data.root_archive_state_file.read_text())["failed_archives"], [])
        self.assertTrue(self.data.is_ready("2026-09-29"))

    def test_missing_archive_receipts_do_not_cause_replaying_published_data(self):
        path = self.data.archive_dir / "published.7z"
        path.write_text(json.dumps({"answers_A-fast.jsonl": json.dumps(archive_row("a_fast", "one")) + "\n"}), encoding="utf-8")
        with patch.object(app, "SevenZipFile", FakeArchive):
            self.data.process_archives(app.archive_signature(self.data.archive_dir))
        path.unlink()
        self.data.process_archives([])
        self.assertTrue(self.data.is_ready("2026-09-29"))
        self.data.root_archive_state_file.unlink()
        with patch.object(app, "SevenZipFile", side_effect=AssertionError("must not replay")):
            with self.assertRaisesRegex(ValueError, "receipts missing"):
                self.data.process_archives(app.archive_signature(self.data.archive_dir))

    def test_scanner_does_not_let_a_growing_archive_block_another_stable_archive(self):
        tick = [0]
        processed = []
        stable = {"name": "stable.7z", "size": 1, "mtime_ns": 1}

        def sleep(_):
            tick[0] += 1
            if tick[0] == 4:
                raise StopIteration()

        with patch.object(app, "archive_signature", side_effect=lambda _: [stable, {"name": "growing.7z", "size": tick[0], "mtime_ns": 1}]), \
             patch.object(self.data, "pending_archives", side_effect=lambda signature: signature), \
             patch.object(self.data, "process_archives", side_effect=lambda signature: processed.append(signature)), \
             patch.object(self.data, "archive_processed") as archive_processed, \
             patch.object(app.time, "monotonic", side_effect=lambda: tick[0] * 10), \
             patch.object(app.time, "sleep", side_effect=sleep):
            with self.assertRaises(StopIteration):
                self.data.processing_loop()
        self.assertEqual([batch for batch in processed if batch], [[stable]])
        self.assertEqual([call.args[0] for call in archive_processed.call_args_list if call.args[0]], [[stable]])

    def test_new_archive_keeps_last_published_root_snapshot_visible(self):
        day = "2026-09-29"
        payload = {
            f"answers_{model.upper()}.jsonl": json.dumps(archive_row(model, model)) + "\n"
            for model in self.data.models
        }
        (self.data.archive_dir / "first.7z").write_text(json.dumps(payload), encoding="utf-8")
        with patch.object(app, "SevenZipFile", FakeArchive):
            signature = app.archive_signature(self.data.archive_dir)
            self.data.process_archives(signature)
            self.assertTrue(self.data.is_ready(day))

            (self.data.archive_dir / "next.7z").write_text(json.dumps(payload), encoding="utf-8")

            self.assertTrue(self.data.is_ready(day))
            dashboard = self.data.dashboard_data()
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
