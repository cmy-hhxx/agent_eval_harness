import json
import os
import tempfile
import unittest
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from test_dashboard import FakeArchive, HAS_PY7ZR
import multi_agent_inputs as worker


def row(provider="aime", mode="fast", case="case", day="2026-10-14", answer="Answer"):
    meta = {"case_id": case, "question": "Question", "request_time": day + " 12:00:00",
            "session_id": "session", "session_round": None, "ok": True,
            "agent_mode": mode + "-quick-agent" if provider == "aime" else mode}
    messages = [{"role": "user", "type": "user_question", "content": "Question"},
                {"type": "llm_turn", "turn": 1},
                {"role": "assistant", "type": "final_answer", "content": answer}]
    return {"meta": meta, "messages": messages}


class MultiAgentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="multi-agent-input-test-")
        self.root = Path(self.temp.name)
        self.aime = worker.AgentDataset(self.root, self.root / "state", "aime", "/data/aime")
        self.ifind = worker.AgentDataset(self.root, self.root / "state", "ifind", "/data/ifind")
        for data in (self.aime, self.ifind):
            data.archive_dir.mkdir(parents=True)
            data.state_dir.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, data, name, rows, member="data.jsonl"):
        path = data.archive_dir / name
        path.write_text(json.dumps({member: "\n".join(json.dumps(item) for item in rows) + "\n"}))
        return path

    def process(self, data):
        with patch.object(worker.app, "SevenZipFile", FakeArchive):
            data.process_archives(worker.app.archive_signature(data.archive_dir))

    def read(self, data, model, day="2026-10-14"):
        return [json.loads(line) for line in (data.output_dir / model / (day + ".jsonl")).read_text().splitlines()]

    def test_local_start_keeps_all_dataset_directories_in_eval_data_and_state_roots(self):
        root = self.root / "local-data"
        factory = worker.app.make_datasets
        mkdir = Path.mkdir
        def local_mkdir(path, *args, **kwargs):
            self.assertTrue(path.is_relative_to(self.root), f"startup writes outside local data: {path}")
            return mkdir(path, *args, **kwargs)
        environment = {"DATA_ROOT": str(root), "STATE_ROOT": str(self.root / "state")}
        with patch.dict(os.environ, environment, clear=True), \
             patch.object(worker.app.sys, "argv", ["app.py"]), \
             patch.object(worker.app, "make_datasets", side_effect=factory), \
             patch.object(worker.app, "DashboardServer") as server, \
             patch.object(worker.app.threading, "Thread"), \
             patch.object(Path, "mkdir", autospec=True, side_effect=local_mkdir):
            worker.app.main()
        datasets = server.call_args.args[1]
        for provider, (directory, models) in worker.SOURCES.items():
            data = datasets["/data/" + provider]
            self.assertEqual(data.root, root / directory)
            self.assertTrue(data.archive_dir.is_dir())
            self.assertTrue(data.state_dir.is_dir())
            self.assertTrue(all((data.output_dir / model).is_dir() for model in models))
        server.return_value.serve_forever.assert_called_once()

    def test_ifind_session_mode_fallbacks_publish_complete_sessions(self):
        rows = []
        for identity, metadata, modes in (
            ("session-type", {"session_type": "normal_agent"}, ["deep_research", "deep_research"]),
            ("trace-mode", {}, ["deep_research", "deep_research"]),
            ("agent-mode", {"agent_mode": "normal_agent", "session_type": "deep_research"}, ["deep_research"]),
            ("ambiguous", {}, ["normal_agent", "deep_research"]),
        ):
            value = row("ifind", "normal_agent")
            messages = value.pop("messages")
            value["meta"].pop("agent_mode")
            value["meta"].update(session_id=identity, **metadata)
            value["traces"] = [{"meta": {"trace_id": f"{identity}-{index}", "mode": mode}, "messages": messages}
                               for index, mode in enumerate(modes)]
            rows.append(value)
        self.archive(self.ifind, "sessions_20261014_010000.7z", rows)
        self.process(self.ifind)
        normal = self.read(self.ifind, "ifind_normal_agent")
        deep = self.read(self.ifind, "ifind_deep_research")
        self.assertEqual({value["case_id"] for value in normal}, {"session-type", "agent-mode"})
        self.assertEqual([value["case_id"] for value in deep], ["trace-mode"])
        for value in normal + deep:
            original = next(row for row in rows if row["meta"]["session_id"] == value["case_id"])
            self.assertEqual(value["traces"], original["traces"])
            self.assertEqual(value["meta"], original["meta"])

    def test_flat_inputs_and_complete_session_records_are_both_preserved(self):
        flat = row(case=None)
        flat["meta"].update(trace_id="session-one", session_round=1)
        traced = row(mode="expert", case=None)
        messages = traced.pop("messages")
        traced["meta"].update(session_type="expert", agent_mode="fast-quick-agent", request_time=None)
        traced["traces"] = [{"meta": {"trace_id": "real-trace", "mode": "fast", "timestamp": "2026-10-13T16:10:00Z"}, "messages": messages}]
        self.archive(self.aime, "ainvest_20261014_010000.7z", [flat, traced, row(mode="expert", case="expert")])
        self.process(self.aime)
        rows = self.read(self.aime, "aime_fast")
        self.assertEqual(len(rows), 2)
        self.assertEqual({item["case_id"] for item in rows}, {"session-one:round:1", "session"})
        self.assertEqual(rows[1]["traces"][0]["messages"], messages)
        self.assertEqual(rows[1]["meta"]["session_type"], "expert")
        self.assertNotIn("messages", rows[1])
        self.assertEqual(len(self.read(self.aime, "aime_expert")), 1)
        self.assertEqual(self.ifind.known_days(), [])

    def test_ifind_unwraps_outer_arrays_and_keeps_rounds_and_modes_separate(self):
        one = row("ifind", "normal_agent", case=None)
        one["meta"].update(trace_id="same-session", session_round=1)
        two = row("ifind", "normal_agent", case=None)
        two["meta"].update(trace_id="same-session", session_round=2)
        self.archive(self.ifind, "ifind_normal_agent_20261014_010000.7z", [[one, two]], "ifind_normal_agent.jsonl")
        self.archive(self.ifind, "ifind_deep_research_20261014_010000.7z", [[row("ifind", "deep_research")]], "ifind_deep_research.jsonl")
        self.process(self.ifind)
        self.assertEqual(len(self.read(self.ifind, "ifind_normal_agent")), 2)
        deep = self.read(self.ifind, "ifind_deep_research")
        self.assertEqual(len(deep), 1)
        self.assertEqual(deep[0]["version"], "ifind_deep_research")
        self.assertEqual(deep[0]["_source"]["original_item"], 1)

    def test_new_session_keeps_every_trace_and_does_not_replay_published_archives(self):
        original = self.archive(self.aime, "ainvest_20261014_010000.7z", [row()])
        self.process(self.aime)
        old = self.aime.output_dir / "aime_fast/2026-10-14.jsonl"
        before = old.read_bytes(), old.stat().st_mtime_ns
        value = row(day="2026-10-18")
        first = value.pop("messages")
        value["meta"].update(session_id="session-new", n_traces=3)
        value["traces"] = [
            {"meta": {"trace_id": "one", "mode": "fast", "session_id": "session-new"}, "messages": first},
            {"meta": {"trace_id": "two", "mode": "fast", "session_id": "session-new"}, "messages": []},
            {"meta": {"trace_id": "three", "mode": "fast", "session_id": "session-new"}, "messages": row(answer="Last")["messages"]},
        ]
        self.archive(self.aime, "ainvest_20261018_010000.7z", [value])
        opened = []
        class CountingArchive(FakeArchive):
            def __init__(self, path, mode):
                opened.append(Path(path).name)
                super().__init__(path, mode)
        with patch.object(worker.app, "SevenZipFile", CountingArchive):
            self.aime.process_archives(worker.app.archive_signature(self.aime.archive_dir))
        self.assertEqual(opened, ["ainvest_20261018_010000.7z"])
        self.assertEqual((old.read_bytes(), old.stat().st_mtime_ns), before)
        result = self.read(self.aime, "aime_fast", "2026-10-18")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["case_id"], "session-new")
        self.assertEqual(result[0]["meta"], value["meta"])
        self.assertEqual(result[0]["traces"], value["traces"])
        self.assertNotIn("messages", result[0])
        self.assertEqual([turn["answer"] for turn in worker.app.visible_record(result[0])["turns"]], ["Answer", "", "Last"])
        self.assertTrue(original.exists())

    def test_incremental_new_packages_deduplicate_business_ids_and_preserve_unrelated_files(self):
        self.archive(self.aime, "ainvest_20261014_010000.7z", [row(answer="old"), row(mode="expert", case="untouched")])
        self.process(self.aime)
        expert = self.aime.output_dir / "aime_expert/2026-10-14.jsonl"
        before = expert.read_bytes(), expert.stat().st_mtime_ns
        self.archive(self.aime, "ainvest_20261014_020000.7z", [row(answer="new"), row(case="another")])
        opened = []
        class CountingArchive(FakeArchive):
            def __init__(self, path, mode):
                opened.append(Path(path).name)
                super().__init__(path, mode)
        with patch.object(worker.app, "SevenZipFile", CountingArchive):
            self.aime.process_archives(worker.app.archive_signature(self.aime.archive_dir))
        self.assertEqual(opened, ["ainvest_20261014_020000.7z"])
        self.assertEqual(len(self.read(self.aime, "aime_fast")), 2)
        self.assertEqual(self.read(self.aime, "aime_fast")[0]["messages"][-1]["content"], "new")
        self.assertEqual((expert.read_bytes(), expert.stat().st_mtime_ns), before)
        with patch.object(worker.app, "SevenZipFile", side_effect=AssertionError("must not replay")):
            self.aime.process_archives(worker.app.archive_signature(self.aime.archive_dir))

    def test_payloads_are_staged_on_disk_and_not_retained_in_identity_records(self):
        self.archive(self.aime, "ainvest_20261014_010000.7z", [row(answer="x" * 1_000_000)])
        with tempfile.TemporaryDirectory(dir=self.aime.state_dir) as folder:
            self.aime.staging = Path(folder)
            with patch.object(worker.app, "SevenZipFile", FakeArchive):
                records, _ = self.aime.read_archive_records(worker.app.archive_signature(self.aime.archive_dir)[0])
            record = next(iter(records.values()))
            self.assertIsInstance(record, worker.StagedRecord)
            self.assertNotIn("row", vars(record))
            self.assertEqual(len(record.row["messages"][-1]["content"]), 1_000_000)
            self.aime.staging = None

    def test_restart_recovers_publication_after_staging_cache_is_removed(self):
        self.archive(self.aime, "ainvest_20261014_010000.7z", [row()])
        publish = self.aime.publish_pending
        def interrupt(db):
            if db.execute("select count(*) from pending").fetchone()[0]:
                raise RuntimeError("interrupted publication")
            publish(db)
        with patch.object(worker.app, "SevenZipFile", FakeArchive), patch.object(self.aime, "publish_pending", side_effect=interrupt):
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                self.aime.process_archives(worker.app.archive_signature(self.aime.archive_dir))
        self.assertEqual(list(self.aime.state_dir.glob("ingest-*")), [])
        restarted = worker.AgentDataset(self.root, self.root / "state", "aime", "/data/aime")
        with patch.object(worker.app, "SevenZipFile", side_effect=AssertionError("must not extract again")):
            restarted.recover()
        self.assertEqual(len(self.read(restarted, "aime_fast")), 1)

    def test_restart_removes_only_abandoned_owned_staging_after_recovery(self):
        self.archive(self.aime, "ainvest_20261014_010000.7z", [row()])
        self.process(self.aime)
        target = self.aime.output_dir / "aime_fast/2026-10-14.jsonl"
        before = target.read_bytes(), target.stat().st_mtime_ns
        orphan = self.aime.state_dir / "ingest-abandoned"
        orphan.mkdir(); (orphan / "normalized.jsonl").write_text("temporary body")
        stage = target.parent / ".2026-10-14.abcd1234.tmp"
        stage.write_text("unfinished stage")
        retained = target.parent / "user-notes.tmp"
        retained.write_text("keep")
        self.aime.recover()
        self.assertFalse(orphan.exists())
        self.assertFalse(stage.exists())
        self.assertTrue(retained.exists())
        self.assertEqual((target.read_bytes(), target.stat().st_mtime_ns), before)

    def test_new_archive_parts_hold_at_most_one_hundred_packages(self):
        for index in range(101):
            (self.aime.archive_dir / f"aime_20261014_{index:06d}.7z").write_bytes(b"raw")
        signature = worker.app.archive_signature(self.aime.archive_dir)
        worker.app.write_json_atomic(self.aime.root_archive_state_file, {"archives": signature, "dates": [], "failed_archives": []})
        self.aime.archive_processed(signature)
        parts = sorted(self.aime.archived_dir.glob("*/part-*"))
        self.assertEqual([len(list(part.glob("*.7z"))) for part in parts], [100, 1])
        self.assertEqual(self.aime.organize_archives()["packages"], 101)

    def test_daily_inspection_is_built_into_the_worker_loop(self):
        now = [100000]
        loops = [0]
        def sleep(_):
            loops[0] += 1
            if loops[0] == 3:
                raise StopIteration()
            now[0] += 43200
        with patch.object(worker.app.time, "time", side_effect=lambda: now[0]), \
             patch.object(worker.app.time, "monotonic", side_effect=lambda: now[0]), \
             patch.object(worker.app.time, "sleep", side_effect=sleep), \
             patch.object(self.aime, "process_archives"), patch.object(self.aime, "archive_processed"), \
             patch.object(self.aime, "organize_archives") as inspect:
            with self.assertRaises(StopIteration):
                self.aime.processing_loop()
        self.assertEqual(inspect.call_count, 2)
        self.assertTrue(self.aime.daily_archive_check)

    @unittest.skipUnless(HAS_PY7ZR, "real 7z requires requirements.txt")
    def test_real_archive_handles_ifind_openai_blocks_and_multiple_dates(self):
        items = []
        for day in ("2026-10-12", "2026-10-13"):
            item = row("ifind", "normal_agent", day=day)
            item["messages"] = [{"role": "user", "type": "message", "content": [{"type": "text", "text": "Question"}]},
                                {"role": "assistant", "type": "message", "content": [{"type": "text", "text": "Answer"}]}]
            items.append(item)
        path = self.ifind.archive_dir / "ifind_normal_agent_20261014_010000.7z"
        session = row("ifind", "normal_agent", day="2026-10-14")
        messages = session.pop("messages")
        session["meta"]["session_id"] = "ifind-session"
        session["traces"] = [{"meta": {"trace_id": "first"}, "messages": messages},
                             {"meta": {"trace_id": "second"}, "messages": messages}]
        with worker.app.SevenZipFile(path, "w") as archive:
            archive.writestr("\n".join([*(json.dumps([item]) for item in items), json.dumps(session)]) + "\n", "ifind_normal_agent.jsonl")
        self.ifind.process_archives(worker.app.archive_signature(self.ifind.archive_dir))
        self.assertEqual(self.ifind.known_days(), ["2026-10-12", "2026-10-13", "2026-10-14"])
        self.assertEqual(len(self.read(self.ifind, "ifind_normal_agent", "2026-10-12")), 1)
        self.assertEqual(self.read(self.ifind, "ifind_normal_agent")[0]["traces"], session["traces"])

    def test_one_server_exposes_sources_downloads_samples_and_isolated_stage_progress(self):
        self.archive(self.aime, "ainvest_20261014_010000.7z", [row()])
        self.archive(self.ifind, "ifind_normal_agent_20261014_010000.7z", [[row("ifind", "normal_agent")]])
        self.process(self.aime); self.process(self.ifind)
        datasets = worker.app.make_datasets(self.root, self.root / "state")
        server = worker.app.DashboardServer(("127.0.0.1", 0), datasets)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        def get(route):
            with urlopen(base + route, timeout=3) as response:
                return json.load(response)
        try:
            for provider, model in (("aime", "aime_fast"), ("ifind", "ifind_normal_agent")):
                self.assertTrue(get(f"/data/{provider}/health")["ok"])
                self.assertEqual(get(f"/data/{provider}/dashboard-data")["dates"][0]["models"][model]["row_count"], 1)
                self.assertEqual(get(f"/data/{provider}/data/2026-10-14/{model}.jsonl")["version"], model)
                self.assertEqual(get(f"/data/{provider}/records/2026-10-14/{model}")["items"][0]["answer"], "Answer")
                with urlopen(base + "/data/" + provider) as response:
                    self.assertEqual(response.url, base + "/data/" + provider + "/")
                    self.assertIn(f'/data/{provider}/dashboard.js', response.read().decode())
            state = {"runId": "aime-test", "startedAt": 1, "status": "running", "engine": {"engine": "pi"},
                     "inputs": {"answer": {"version": "aime_fast", "batch_id": "2026-10-14", "case_id": "q"}},
                     "tasks": {"c": {"stage": "criteria", "status": "succeeded", "receipt": {"status": "succeeded"}, "inputIds": {"A": "answer"}},
                               "a": {"stage": "attribution", "status": "running", "inputIds": {"answer": "answer"}},
                               "g": {"stage": "clustering", "status": "pending", "data": {"scope": {"version": "aime_fast", "batch_id": "2026-10-14"}}}}}
            def count(total=0, completed=0, running=0, pending=0):
                return {"total": total, "completed": completed, "running": running, "pending": pending,
                        "failed": 0, "blocked": 0, "cancelled": 0}
            stages = {"criteria": count(1, 1), "attribution": count(1, 0, 1), "clustering": count(1, 0, 0, 1)}
            progress = {"run_id": "aime-test", "engine": "pi", "status": "running", "started_at": 1, "updated_at": 2,
                        "dates": [{"date": "2026-10-14", "models": {"aime_fast": stages}}]}
            self.assertEqual(stages["criteria"]["completed"], 1)
            self.assertEqual(stages["attribution"]["running"], 1)
            self.assertEqual(stages["clustering"]["pending"], 1)
            def post(provider, payload):
                request = Request(base + f"/data/{provider}/evaluation-progress", data=json.dumps(payload).encode(),
                                  headers={"Content-Type": "application/json"})
                with urlopen(request, timeout=3) as response:
                    return json.load(response)
            self.assertTrue(post("aime", progress)["saved"])
            self.assertEqual(get("/data/aime/dashboard-data")["evaluation"]["dates"], progress["dates"])
            self.assertIsNone(get("/data/ifind/dashboard-data")["evaluation"])
            with self.assertRaises(HTTPError) as root_error:
                get("/dashboard-data")
            self.assertEqual(root_error.exception.code, 404)
            for provider, payload in (("ifind", progress), ("aime", {**progress, "dates": [{"date": "2026-10-14", "pairs": {}}]})):
                with self.assertRaises(HTTPError) as error:
                    post(provider, payload)
                self.assertEqual(error.exception.code, 400)
            stages["criteria"]["completed"] = 2
            with self.assertRaises(HTTPError): post("aime", progress)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
