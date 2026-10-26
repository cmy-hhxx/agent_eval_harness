import json
import shutil
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from test_dashboard import app, FakeArchive, archive_row
from workbench_catalog import WorkbenchCatalog, Conflict


class WorkbenchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="workbench-intake-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.datasets = app.make_datasets(self.root / "data", self.root / "state")
        for dataset in self.datasets.values():
            dataset.archive_dir.mkdir(parents=True, exist_ok=True)
            dataset.state_dir.mkdir(parents=True, exist_ok=True)
        self.catalog = WorkbenchCatalog(self.datasets, self.root / "state", app)
        self.patch = patch.object(app, "SevenZipFile", FakeArchive)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.stable = patch.object(app, "STABLE_SECONDS", 0)
        self.stable.start()
        self.addCleanup(self.stable.stop)

    def package(self, name="batch.7z", rows=None, origin="/data/post_training_model", extra=None):
        dataset = self.datasets[origin]
        if rows is None:
            rows = [archive_row("b_fast", "one")]
        payload = {"nested/AA-fast.jsonl": "\n".join(json.dumps(row) for row in rows) + "\n", **(extra or {})}
        path = dataset.archive_dir / name
        path.write_text(json.dumps(payload))
        return path

    def discover_batches(self):
        self.catalog.discover()
        return self.catalog.snapshot({})["batches"]

    def task(self, source="wencai", category="task", profile="post_training_model"):
        return self.catalog.create_task({"name": "后训练新实验", "source": source, "category": category, "profile": profile})

    def clean(self, batch_ids):
        self.catalog.start_clean({"batch_ids": batch_ids}, background=False)

    def workbench_url(self):
        server = app.DashboardServer(("127.0.0.1", 0), self.datasets, self.catalog)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}/data/workbench/"

    def test_evaluation_scope_freezes_only_selected_cleaned_records(self):
        self.package("first.7z", rows=[archive_row("b_fast", "one")])
        first = self.discover_batches()[0]
        with self.assertRaises(Conflict):
            self.catalog.evaluation_scope({"batch_ids": [first["id"]]})
        self.clean([first["id"]])
        self.package("second.7z", rows=[archive_row("b_fast", "two")])
        second = next(row for row in self.discover_batches() if row["name"] == "second.7z")
        self.clean([second["id"]])
        scope = self.catalog.evaluation_scope({"batch_ids": [first["id"]]})
        self.assertEqual([row["case_id"] for row in scope["records"]], ["one"])
        self.assertEqual(scope["records"][0]["package_id"], first["id"])
        self.assertEqual(scope["records"][0]["input_index"], 0)
        self.assertIn("eval_output/1_task_eval/", scope["output_dir"])
        self.assertNotIn("messages", scope["records"][0])
        both = self.catalog.evaluation_scope({"batch_ids": [first["id"], second["id"]]})
        self.assertEqual({row["case_id"] for row in both["records"]}, {"one", "two"})
        with self.assertRaises(ValueError):
            self.catalog.evaluation_scope({"batch_ids": [first["id"], first["id"]]})

    def test_daily_evaluation_scope_uses_source_date_root_without_task_directory(self):
        self.package(rows=[archive_row("b_fast", "one")])
        batch = self.discover_batches()[0]
        task = self.task(category="daily")
        self.catalog.assign({"batch_ids": [batch["id"]], "task_id": task["id"]})
        self.clean([batch["id"]])
        scope = self.catalog.evaluation_scope({"batch_ids": [batch["id"]]})
        self.assertEqual(scope["task"]["category"], "daily")
        self.assertEqual(Path(scope["output_dir"]), self.root / "data/0_wencai/eval_output/0_daily_eval")

    def test_task_assignment_cleaning_report_and_sample_survive_restart(self):
        self.package(rows=[archive_row("b_fast", "one"), archive_row("b_fast", "empty", answer="")],
                     extra={"AA-post_train_fast_V1.jsonl": json.dumps(archive_row("b_post_train_fast", "one")) + "\n{bad\n"})
        batch = self.discover_batches()[0]
        task = self.task()
        self.catalog.assign({"batch_ids": [batch["id"]], "task_id": task["id"]})
        self.clean([batch["id"]])
        result = self.discover_batches()[0]
        self.assertEqual(result["status"], "cleaned")
        self.assertEqual((result["summary"]["read"], result["summary"]["accepted"], result["summary"]["excluded"]), (4, 2, 2))
        self.assertEqual(sum(result["summary"]["pairs"].values()), 1)
        report = self.catalog.report(batch["id"], {})
        self.assertEqual({row["reason"] for row in report["items"]}, {"answer_empty", "invalid_json"})
        self.assertTrue(all(row["original_line"] == 2 for row in report["items"]))
        sample = self.catalog.sample(batch["id"], {"index": ["0"]})
        self.assertEqual(sample["record"]["answer"], "Answer")
        self.assertNotIn("report", result)
        restarted = WorkbenchCatalog(self.datasets, self.root / "state", app)
        self.assertEqual(restarted.report(batch["id"], {}), report)
        self.assertEqual(restarted.snapshot({})["batches"][0]["id"], batch["id"])
        self.assertEqual(restarted.dataset(task).output_dir, self.root / "data/0_wencai/5_multi_task_eval_input" / task["id"])
        self.assertEqual(self.datasets["/data/post_training_model"].known_days(), [])
        with self.assertRaises(Conflict):
            self.clean([batch["id"]])
        self.assertTrue(Path(result["archive_path"]).is_file())

    def test_bad_pack_and_empty_records_do_not_block_good_pack(self):
        self.package("good.7z")
        bad = self.package("bad.7z")
        bad.write_bytes(b"broken")
        self.package("empty.7z", [archive_row("b_fast", "missing", answer="")])
        batches = self.discover_batches()
        self.clean([batch["id"] for batch in batches])
        states = {batch["name"]: batch["status"] for batch in self.discover_batches()}
        self.assertEqual(states, {"good.7z": "cleaned", "bad.7z": "failed", "empty.7z": "empty"})
        failed = next(batch for batch in self.discover_batches() if batch["name"] == "bad.7z")
        self.assertTrue(self.catalog.report(failed["id"], {})["summary"]["error"])

    def test_metadata_issues_are_paginated_locatable_and_do_not_exclude_answers(self):
        self.package(rows=[archive_row("b_fast", f"case-{index}", meta_fields={
            "rued": {"R": "1", "U": 0, "E": 0, "D": 1}, "first_token_time_cost": -1,
            "info": {"task": "交易建议"}}) for index in range(26)])
        batch = self.discover_batches()[0]
        self.clean([batch["id"]])
        summary = self.discover_batches()[0]["summary"]
        self.assertEqual((summary["accepted"], summary["excluded"], summary["metadata_issue_count"]), (26, 0, 52))
        self.assertNotIn("metadata_issues", summary)
        report = self.catalog.report(batch["id"], {"section": ["metadata_issues"]})
        self.assertEqual((report["total"], len(report["items"])), (52, 50))
        issue = report["items"][0]
        self.assertEqual((issue["original_file"], issue["original_line"], issue["case_id"], issue["field"]),
                         ("batch.7z/nested/AA-fast.jsonl", 1, "case-0", "meta.rued"))
        second = self.catalog.report(batch["id"], {"section": ["metadata_issues"], "page": ["2"]})
        self.assertEqual(len(second["items"]), 2)
        restarted = WorkbenchCatalog(self.datasets, self.root / "state", app)
        self.assertEqual(restarted.report(batch["id"], {"section": ["metadata_issues"]}), report)
        dataset = self.datasets["/data/post_training_model"]
        cleaned = json.loads((dataset.output_dir / "b_fast/2026-09-29.jsonl").read_text().splitlines()[0])
        self.assertIsNone(cleaned["meta"]["difficulty_score"])
        self.assertIsNone(cleaned["meta"]["first_token_time_cost"])
        self.assertEqual(cleaned["meta"]["task"], "交易建议")

    def test_upload_growth_keeps_uuid_then_published_revision_gets_new_unassigned_batch(self):
        with patch.object(app, "STABLE_SECONDS", 30):
            path = self.package()
            first = self.discover_batches()[0]
            self.assertEqual(first["status"], "uploading")
            path.write_text(path.read_text() + " ")
            second = self.discover_batches()[0]
            self.assertEqual(first["id"], second["id"])
            self.assertEqual(len(self.discover_batches()), 1)
            with self.assertRaises(Conflict):
                self.clean([first["id"]])
        self.clean([self.discover_batches()[0]["id"]])
        path.write_text(path.read_text() + " ")
        revision = next(batch for batch in self.discover_batches() if batch["id"] != first["id"])
        self.assertEqual(revision["revises"], first["id"])
        self.assertIsNone(revision["task_id"])
        with self.assertRaises(ValueError):
            self.clean([revision["id"]])

    def test_source_and_type_are_independent_and_assign_is_atomic(self):
        self.package()
        batch = self.discover_batches()[0]
        for source in ("aime", "ifind", "wencai"):
            for category in ("daily", "task"):
                task = self.task(source, category, source)
                self.assertEqual((task["source"], task["category"]), (source, category))
        other = self.task("aime", "task", "aime")
        with self.assertRaises(ValueError):
            self.catalog.assign({"batch_ids": [batch["id"]], "task_id": other["id"]})
        own = self.task()
        with self.assertRaises(ValueError):
            self.catalog.assign({"batch_ids": [batch["id"], "missing"], "task_id": own["id"]})
        self.assertEqual(self.discover_batches()[0]["task_id"], batch["task_id"])

    def test_interrupt_after_durable_publication_recovers_without_extracting_twice(self):
        self.package()
        batch = self.discover_batches()[0]
        dataset = self.datasets["/data/post_training_model"]
        publish = dataset.publish_pending
        def interrupt(db):
            if db.execute("SELECT 1 FROM pending").fetchone():
                raise RuntimeError("fixture interruption")
            publish(db)
        with patch.object(dataset, "publish_pending", side_effect=interrupt):
            self.clean([batch["id"]])
        self.assertEqual(self.discover_batches()[0]["status"], "failed")
        with patch.object(app, "SevenZipFile", side_effect=AssertionError("must recover publication")):
            self.clean([batch["id"]])
        self.assertEqual(self.discover_batches()[0]["status"], "cleaned")
        self.assertEqual(self.catalog.report(batch["id"], {})["summary"]["accepted"], 1)

    def test_concurrent_submission_and_changed_file_are_rejected(self):
        path = self.package()
        batch = self.discover_batches()[0]
        self.catalog.cleaning.acquire()
        try:
            with self.assertRaises(Conflict):
                self.clean([batch["id"]])
        finally:
            self.catalog.cleaning.release()
        path.write_text(path.read_text() + " ")
        with self.assertRaises(Conflict):
            self.clean([batch["id"]])
        self.assertEqual(next(item for item in self.discover_batches() if item["id"] == batch["id"])["status"], "ready")

    def test_duplicate_and_conflicting_business_records_are_reported_without_overwrite(self):
        self.package("0123456789abcdef_20261019_010000.7z")
        self.clean([self.discover_batches()[0]["id"]])
        self.package("0123456789abcdef_20261019_020000.7z", [archive_row("b_fast", "one"), archive_row("b_fast", "new")])
        new = next(batch for batch in self.discover_batches() if batch["status"] == "ready")
        self.clean([new["id"]])
        self.assertEqual(self.catalog.report(new["id"], {})["items"][0]["reason"], "duplicate_case")
        selected = self.catalog.sample(new["id"], {"index": ["0"]})
        self.assertEqual(selected["location"]["case_id"], "new")
        self.assertEqual(selected["location"]["input_index"], 1)
        self.package("0123456789abcdef_20261019_030000.7z", [archive_row("b_fast", "one", answer="changed")])
        conflict = next(batch for batch in self.discover_batches() if batch["status"] == "ready")
        self.clean([conflict["id"]])
        self.assertEqual(self.catalog.report(conflict["id"], {})["items"][0]["reason"], "identity_conflict")

    def test_discovery_never_starts_cleaning_until_explicitly_requested(self):
        daily = self.task("wencai", "daily", "wencai")
        special = self.task()
        for task in (daily, special):
            (Path(task["archive_dir"]) / "new.7z").write_text(json.dumps({"AA-fast.jsonl": json.dumps(archive_row("b_fast", "one"))}))
        batches = self.discover_batches()
        self.assertEqual({row["task_id"] for row in batches}, {daily["id"], special["id"]})
        with patch.object(self.catalog, "start_clean") as clean, \
                patch.object(self.catalog.stop, "wait", side_effect=lambda _: self.catalog.stop.set()):
            self.catalog.loop()
        clean.assert_not_called()
        picked = [next(row["id"] for row in batches if row["task_id"] == daily["id"])]
        self.clean(picked)
        self.assertEqual(self.catalog.report(picked[0], {})["summary"]["accepted"], 1)
        restarted = WorkbenchCatalog(app.make_datasets(self.root / "data", self.root / "state"), self.root / "state", app)
        self.assertEqual(len(restarted.snapshot({})["batches"]), 2)

    def test_daily_sources_bind_real_directories_and_keep_task_identity(self):
        before = self.catalog.snapshot({})
        for source, suffix in (("wencai", "0_wencai/1_7z_data/A_AA_comparision_data"), ("aime", "1_aime/1_7z_data/online_data")):
            task = next(task for task in before["tasks"] if task["dataset"] == "/data/" + source)
            self.assertEqual(task["category"], "daily")
            self.assertEqual(task["archive_dir"], str(self.root / "data" / suffix))
        restarted = WorkbenchCatalog(self.datasets, self.root / "state", app)
        self.assertEqual([task["id"] for task in before["tasks"]], [task["id"] for task in restarted.snapshot({})["tasks"]])

    def test_ready_filter_and_task_clean_use_a_finite_scope(self):
        self.package("first.7z", [archive_row("b_fast", "first")])
        batch = self.discover_batches()[0]
        task_id = batch["task_id"]
        query = {"source": ["wencai"], "task": [task_id], "status": ["ready"]}
        self.assertEqual(self.catalog.snapshot(query)["total"], 1)
        process = self.datasets[batch["origin"]].process_archives
        def receive_later(signature, **kwargs):
            process(signature, **kwargs)
            if signature:
                self.package("later.7z", [archive_row("b_fast", "later")])
        with patch.object(self.datasets[batch["origin"]], "process_archives", side_effect=receive_later):
            result = self.catalog.start_task_clean(task_id, {}, background=False)
        self.assertEqual((result["status"], result["completed"], result["remaining"]), ("finished", 1, 0))
        self.assertEqual(result["batch_ids"], [batch["id"]])
        self.catalog.discover()
        self.assertEqual([row["name"] for row in self.catalog.snapshot(query)["batches"]], ["later.7z"])

    def test_task_clean_stop_finishes_current_package_and_leaves_later_packages_ready(self):
        self.package("first.7z", [archive_row("b_fast", "first")])
        self.package("second.7z", [archive_row("b_fast", "second")])
        task_id = self.discover_batches()[0]["task_id"]
        dataset = self.datasets["/data/post_training_model"]
        process = dataset.process_archives
        def stop_after_current(signature, **kwargs):
            process(signature, **kwargs)
            if signature:
                self.assertEqual(self.catalog.start_task_clean(task_id, {})["status"], "running")
                self.assertEqual(self.catalog.stop_task_clean(task_id, {})["status"], "stopping")
        with patch.object(dataset, "process_archives", side_effect=stop_after_current):
            result = self.catalog.start_task_clean(task_id, {}, background=False)
        self.assertEqual((result["status"], result["completed"], result["remaining"]), ("stopped", 1, 1))
        self.assertEqual(sorted(batch["status"] for batch in self.discover_batches()), ["cleaned", "ready"])

    def test_task_cancel_before_commit_rolls_back_stages_and_can_resume(self):
        self.package("first.7z", [archive_row("b_fast", "first")])
        self.package("second.7z", [archive_row("b_fast", "second")])
        task_id = self.discover_batches()[0]["task_id"]
        dataset = self.datasets["/data/post_training_model"]
        prepare = dataset.prepare_archive_files
        def cancel_before_commit(changes):
            result = prepare(changes)
            self.assertEqual(self.catalog.stop_task_clean(task_id, {}, cancel=True)["status"], "cancelling")
            return result
        with patch.object(dataset, "prepare_archive_files", side_effect=cancel_before_commit):
            result = self.catalog.start_task_clean(task_id, {}, background=False)
        self.assertEqual((result["status"], result["completed"], result["remaining"]), ("cancelled", 0, 2))
        self.assertEqual(sorted(batch["status"] for batch in self.discover_batches()), ["interrupted", "ready"])
        self.assertEqual(dataset.known_days(), [])
        self.assertEqual(list(dataset.output_dir.rglob("*.tmp")), [])
        result = self.catalog.start_task_clean(task_id, {}, background=False)
        self.assertEqual((result["status"], result["completed"]), ("finished", 2))
        self.assertEqual({batch["status"] for batch in self.discover_batches()}, {"cleaned"})

    def test_discovery_observes_external_aime_publication_without_cleaning_again(self):
        dataset = self.datasets["/data/aime"]
        row = archive_row("a_fast", "aime-case", meta_fields={"agent_mode": "fast", "trace_id": "aime-trace"})
        (dataset.archive_dir / "aime.7z").write_text(json.dumps({"answers.jsonl": json.dumps(row)}))
        batch = next(batch for batch in self.discover_batches() if batch["origin"] == "/data/aime")
        self.assertEqual(batch["status"], "ready")
        with dataset.archive_lock(), patch("multi_agent_inputs.app.SevenZipFile", FakeArchive):
            dataset.process_archives(app.archive_signature(dataset.archive_dir))
        with patch.object(dataset, "process_archives", side_effect=AssertionError("discovery must only observe")):
            current = next(item for item in self.discover_batches() if item["id"] == batch["id"])
        self.assertEqual(current["status"], "cleaned")
        report = self.catalog.report(batch["id"], {"section": ["records"]})
        self.assertEqual(report["items"][0]["original_file"], "aime.7z/answers.jsonl")

    def test_discovery_never_adopts_an_unfinished_external_publication(self):
        self.package()
        batch = self.discover_batches()[0]
        dataset = self.datasets[batch["origin"]]
        with dataset.archive_lock():
            dataset.process_archives(app.archive_signature(dataset.archive_dir))
        source = dataset.open_archive_index()
        try:
            with source:
                source.execute("INSERT INTO pending VALUES (1, '{}')")
            self.assertEqual(self.discover_batches()[0]["status"], "ready")
            with source:
                source.execute("DELETE FROM pending")
            self.assertEqual(self.discover_batches()[0]["status"], "cleaned")
        finally:
            source.close()

    def test_analytics_aggregates_all_canonical_records_and_actual_exclusion_reasons(self):
        rows = [archive_row("b_fast", f"case-{index}", request_time=f"2026-09-{29 if index < 60 else 30} 11:00:00")
                for index in range(120)]
        self.package("0123456789abcdef_19990101_010000.7z", rows=rows, extra={
            "AA-post_train_fast_V1.jsonl": "\n".join(json.dumps(archive_row("b_post_train_fast", f"case-{index}")) for index in range(5))})
        first = self.discover_batches()[0]
        self.clean([first["id"]])
        self.package("0123456789abcdef_19990101_020000.7z", rows=[*rows[:3], archive_row("b_fast", "empty", answer="")])
        second = next(batch for batch in self.discover_batches() if batch["name"] == "0123456789abcdef_19990101_020000.7z")
        self.clean([second["id"]])
        self.package("different-task.7z")
        third = next(batch for batch in self.discover_batches() if batch["name"] == "different-task.7z")
        task = self.task()
        self.catalog.assign({"batch_ids": [third["id"]], "task_id": task["id"]})
        self.clean([third["id"]])
        with patch.object(self.catalog, "discover", side_effect=AssertionError("GET must not discover")), \
                patch.object(self.catalog, "dataset", side_effect=AssertionError("GET must not create datasets")), \
                patch.object(self.datasets[first["origin"]], "open_archive_index", side_effect=AssertionError("GET must not create an index")), \
                patch("workbench_catalog.json.loads", side_effect=AssertionError("GET must aggregate in SQL without decoding report bodies")):
            result = self.catalog.analytics({"task_id": [first["task_id"]]})
        self.assertEqual(result["totals"], {"rawRecords": 129, "answers": 125, "questions": 120, "excluded": 4,
                                             "duplicates": 3, "metadataIssues": 0, "packages": 2, "unreportedAnswers": 0})
        self.assertEqual(result["dates"], [{"date": "2026-09-29", "answers": 65, "questions": 60},
                                            {"date": "2026-09-30", "answers": 60, "questions": 60}])
        self.assertEqual(result["models"], [{"model": "b_fast", "answers": 120}, {"model": "b_post_train_fast", "answers": 5}])
        self.assertEqual(result["exclusions"], [{"reason": "duplicate_case", "count": 3}, {"reason": "answer_empty", "count": 1}])
        self.assertEqual(result["packages"], [{"status": "cleaned", "count": 1}, {"status": "empty", "count": 1}])
        self.assertTrue(result["reportsComplete"])
        self.assertEqual(self.catalog.analytics({"task_id": [task["id"]]})["totals"]["answers"], 1)

    def test_analytics_covers_external_publication_before_catalog_adoption_and_rejects_pending(self):
        self.package()
        batch = self.discover_batches()[0]
        dataset = self.datasets[batch["origin"]]
        with dataset.archive_lock():
            dataset.process_archives(app.archive_signature(dataset.archive_dir))
        result = self.catalog.analytics({"task_id": [batch["task_id"]]})
        self.assertEqual(result["totals"]["answers"], 1)
        self.assertEqual(result["totals"]["rawRecords"], 1)
        self.assertEqual(result["packages"], [{"status": "ready", "count": 1}])
        source = dataset.open_archive_index()
        try:
            with source:
                source.execute("INSERT INTO pending VALUES (1, '{}')")
            with self.assertRaisesRegex(Conflict, "发布中"):
                self.catalog.analytics({"task_id": [batch["task_id"]]})
        finally:
            source.close()

    def test_daily_date_counts_match_business_pairs_instead_of_model_row_minimums(self):
        self.package(origin="/data/wencai", rows=[archive_row("b_fast", case) for case in ("match", "only-b")], extra={
            "A-fast.jsonl": "\n".join(json.dumps(archive_row("a_fast", case)) for case in ("match", "only-a")),
            "A-expert.jsonl": json.dumps(archive_row("a_expert", "expert")),
            "AA-expert.jsonl": json.dumps(archive_row("b_expert", "expert")),
        })
        batch = self.discover_batches()[0]
        self.clean([batch["id"]])
        result = self.catalog.analytics({"task_id": [batch["task_id"]]})
        self.assertEqual({row["model"]: row["answers"] for row in result["dateModels"]},
                         {"a_fast": 2, "b_fast": 2, "a_expert": 1, "b_expert": 1})
        self.assertEqual(result["datePairs"], [
            {"date": "2026-09-29", "tier": "Expert", "paired": 1, "unpaired": 0},
            {"date": "2026-09-29", "tier": "Fast", "paired": 1, "unpaired": 2},
        ])

    def test_analytics_distinguishes_empty_input_from_missing_index_and_unreported_history(self):
        task = self.task()
        empty = self.catalog.analytics({"task_id": [task["id"]]})
        self.assertEqual(empty["totals"]["answers"], 0)
        self.assertEqual(empty["models"], [])
        self.assertEqual(empty["dates"], [])
        self.assertTrue(empty["reportsComplete"])
        self.package()
        batch = self.discover_batches()[0]
        self.clean([batch["id"]])
        dataset = self.datasets[batch["origin"]]
        source = dataset.open_archive_index()
        try:
            with source:
                source.execute("UPDATE records SET archive='historical.7z'")
        finally:
            source.close()
        result = self.catalog.analytics({"task_id": [batch["task_id"]]})
        self.assertEqual(result["totals"]["answers"], 1)
        self.assertEqual(result["totals"]["unreportedAnswers"], 1)
        self.assertFalse(result["reportsComplete"])
        self.assertTrue(all(result["totals"][key] is None for key in ("rawRecords", "excluded", "duplicates", "metadataIssues")))
        (dataset.state_dir / "archive-records.sqlite").rename(dataset.state_dir / "missing-index.sqlite")
        with self.assertRaisesRegex(Conflict, "索引缺失"):
            self.catalog.analytics({"task_id": [batch["task_id"]]})

    def test_analytics_http_validates_task_scope(self):
        base = self.workbench_url()
        for query in ("", "?task_id=", "?task_id=one&task_id=two"):
            with self.assertRaises(HTTPError) as caught:
                urlopen(base + "analytics" + query)
            self.assertEqual(caught.exception.code, 400)
        with self.assertRaises(HTTPError) as caught:
            urlopen(base + "analytics?task_id=missing")
        self.assertEqual(caught.exception.code, 404)
        task = self.task()
        with urlopen(base + "analytics?task_id=" + task["id"]) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read())["totals"]["answers"], 0)

    def test_missing_identity_index_cannot_silently_replace_a_published_answer(self):
        self.package("0123456789abcdef_20261019_010000.7z")
        self.clean([self.discover_batches()[0]["id"]])
        dataset = self.datasets["/data/post_training_model"]
        output = dataset.output_dir / "b_fast/2026-09-29.jsonl"
        before = output.read_bytes()
        db = dataset.open_archive_index()
        with db:
            db.execute("DELETE FROM records")
        db.close()
        self.package("0123456789abcdef_20261019_020000.7z", [archive_row("b_fast", "one", answer="changed")])
        batch = next(item for item in self.discover_batches() if item["status"] == "ready")
        self.clean([batch["id"]])
        result = next(item for item in self.discover_batches() if item["id"] == batch["id"])
        self.assertEqual(result["status"], "failed")
        self.assertIn("refusing to overwrite", result["error"])
        self.assertEqual(output.read_bytes(), before)

    def test_same_name_in_a_new_task_directory_cannot_reuse_another_origins_report(self):
        original = self.package()
        first = self.discover_batches()[0]
        task = self.task()
        self.catalog.assign({"batch_ids": [first["id"]], "task_id": task["id"]})
        self.clean([first["id"]])
        shutil.copy2(original, Path(task["archive_dir"]) / original.name)
        second = next(batch for batch in self.discover_batches() if batch["id"] != first["id"])
        self.clean([second["id"]])
        result = next(batch for batch in self.discover_batches() if batch["id"] == second["id"])
        self.assertEqual(result["status"], "failed")
        self.assertIn("同名包", result["error"])
        self.assertIsNone(result["summary"])

    def test_unreadable_member_does_not_discard_other_valid_member(self):
        self.package(extra={"unknown.jsonl": "{}"})
        batch = self.discover_batches()[0]
        self.clean([batch["id"]])
        report = self.catalog.report(batch["id"], {})
        self.assertEqual(report["status"], "partial")
        self.assertEqual(report["summary"]["accepted"], 1)
        self.assertEqual(report["summary"]["file_errors"][0]["reason"], "model_unknown")

    def test_catalog_http_reads_the_index_without_discovering_or_creating_datasets(self):
        self.package("indexed.7z")
        self.catalog.discover()
        self.package("not-yet-discovered.7z")
        base = self.workbench_url()
        with patch.object(self.catalog, "discover", side_effect=AssertionError("GET must not scan archives")), \
                patch.object(self.catalog, "dataset", side_effect=AssertionError("GET must not mutate dataset caches")):
            for route in ("catalog", "catalog?source=wencai&status=ready"):
                with urlopen(base + route, timeout=2) as response:
                    data = json.load(response)
                self.assertEqual(data["total"], 1)
                self.assertEqual([batch["name"] for batch in data["batches"]], ["indexed.7z"])
        self.catalog.discover()
        self.assertEqual(self.catalog.snapshot({})["total"], 2)

    def test_report_reads_committed_publication_while_discovery_is_scanning(self):
        self.package()
        batch = self.discover_batches()[0]
        self.clean([batch["id"]])
        entered, release, completed = threading.Event(), threading.Event(), threading.Event()
        result, errors = [], []
        scan = app.archive_signature

        def scanning(directory):
            entered.set()
            release.wait(5)
            return scan(directory)

        def reading():
            try:
                result.append(self.catalog.report(batch["id"], {"section": ["records"]}))
            except Exception as error:
                errors.append(error)
            finally:
                completed.set()

        with patch.object(app, "archive_signature", side_effect=scanning):
            writer = threading.Thread(target=self.catalog.discover, daemon=True)
            writer.start()
            reader = threading.Thread(target=reading, daemon=True)
            try:
                self.assertTrue(entered.wait(5), "discovery must reach the archive scan")
                reader.start()
                self.assertTrue(completed.wait(1), "published report must not wait for the archive scan")
            finally:
                release.set()
                writer.join(5)
                if reader.ident is not None:
                    reader.join(5)
        self.assertFalse(writer.is_alive())
        self.assertFalse(reader.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(result[0]["items"][0]["case_id"], "one")

    def test_report_only_decodes_requested_page_without_creating_dataset_or_index(self):
        self.package()
        batch = self.discover_batches()[0]
        self.clean([batch["id"]])
        report = self.catalog.published_report(batch)
        report["records"] = [{**report["records"][0], "case_id": f"case-{index}"} for index in range(2000)]
        dataset = self.datasets[batch["origin"]]
        db = dataset.open_archive_index()
        try:
            db.execute("UPDATE cleaning_reports SET report=? WHERE name=? AND size=? AND mtime_ns=?",
                       (json.dumps(report), batch["name"], batch["size"], batch["mtime_ns"]))
            db.commit()
        finally:
            db.close()
        decode = json.loads
        decoded_bytes = []

        def page_only(value, *args, **kwargs):
            decoded_bytes.append(len(value))
            self.assertLess(len(value), 10_000, "report GET must not decode the complete report")
            return decode(value, *args, **kwargs)

        with patch("workbench_catalog.json.loads", side_effect=page_only), \
                patch.object(self.catalog, "dataset", side_effect=AssertionError("GET must not create datasets")), \
                patch.object(dataset, "open_archive_index", side_effect=AssertionError("GET must not create an index")):
            page = self.catalog.report(batch["id"], {"section": ["records"], "page": ["2"], "page_size": ["10"]})
            self.assertEqual((page["total"], page["page_size"], len(page["items"])), (2000, 10, 10))
            self.assertEqual([row["case_id"] for row in page["items"]], [f"case-{index}" for index in range(10, 20)])
            empty = self.catalog.report(batch["id"], {"section": ["exclusions"]})
            self.assertEqual((empty["total"], empty["items"]), (0, []))
        self.assertLess(sum(decoded_bytes), 20_000)

    def test_catalog_and_report_page_size_controls_real_page_boundaries(self):
        for index in range(23):
            self.package(f"batch-{index}.7z")
        batches = self.discover_batches()
        expected = [row["id"] for row in batches]
        pages = [self.catalog.snapshot({"page": [str(page)], "page_size": ["10"]}) for page in range(1, 4)]
        self.assertEqual([len(page["batches"]) for page in pages], [10, 10, 3])
        self.assertEqual([row["id"] for page in pages for row in page["batches"]], expected)
        self.assertTrue(all((page["total"], page["page_size"]) == (23, 10) for page in pages))
        self.assertEqual(self.catalog.snapshot({"page": ["23"], "page_size": ["1"]})["batches"][0]["id"], expected[-1])
        self.assertEqual(len(self.catalog.snapshot({"page_size": ["100"]})["batches"]), 23)
        self.package("excluded.7z", rows=[archive_row("b_fast", f"case-{index}", answer="") for index in range(55)])
        batch = next(row for row in self.discover_batches() if row["name"] == "excluded.7z")
        self.clean([batch["id"]])
        for size in (1, 10, 20, 50, 100):
            pages = [self.catalog.report(batch["id"], {"page": [str(page)], "page_size": [str(size)]})
                     for page in range(1, (55 + size - 1) // size + 1)]
            self.assertEqual([row["case_id"] for page in pages for row in page["items"]], [f"case-{index}" for index in range(55)])
            self.assertTrue(all((page["total"], page["page_size"]) == (55, size) for page in pages))
        for size in ("0", "101", "bad"):
            with self.assertRaises(ValueError):
                self.catalog.snapshot({"page_size": [size]})
            with self.assertRaises(ValueError):
                self.catalog.report(batch["id"], {"page_size": [size]})

    def test_catalog_http_reads_the_committed_snapshot_while_discovery_holds_its_lock(self):
        self.package()
        batch = self.discover_batches()[0]
        base = self.workbench_url()
        entered, release = threading.Event(), threading.Event()

        def discovering():
            with self.catalog.lock, self.catalog.db() as db:
                db.execute("UPDATE batches SET status='uploading' WHERE id=?", (batch["id"],))
                entered.set()
                release.wait(5)

        writer = threading.Thread(target=discovering, daemon=True)
        writer.start()
        try:
            self.assertTrue(entered.wait(5), "discovery transaction must start")
            with urlopen(base + "catalog?status=ready", timeout=2) as response:
                data = json.load(response)
            self.assertEqual(data["total"], 1)
            self.assertEqual(data["batches"][0]["id"], batch["id"])
            self.assertEqual(data["batches"][0]["status"], "ready")
        finally:
            release.set()
            writer.join(5)
        self.assertFalse(writer.is_alive())
        self.assertEqual(self.catalog.snapshot({})["batches"][0]["status"], "uploading")

    def test_http_validation_pagination_and_report_sample(self):
        self.package(rows=[archive_row("b_fast", str(index), answer="") for index in range(55)])
        self.package("good.7z")
        self.clean([batch["id"] for batch in self.discover_batches()])
        base = self.workbench_url()
        with urlopen(base + "catalog") as response:
            data = json.load(response)
        task_id = next(task["id"] for task in data["tasks"] if task["source"] == "aime")
        clean_path = f"tasks/{task_id}/clean"
        with urlopen(base + clean_path) as response:
            self.assertEqual(json.load(response)["status"], "idle")
        for action in ("", "/stop", "/cancel"):
            with urlopen(Request(base + clean_path + action, data=b'{}', headers={"Content-Type": "application/json"})) as response:
                self.assertEqual(response.status, 202)
                self.assertEqual(json.load(response)["task_id"], task_id)
        with self.assertRaises(HTTPError) as invalid:
            urlopen(Request(base + clean_path, data=b'{"input_path":"/arbitrary"}', headers={"Content-Type": "application/json"}))
        self.assertEqual(invalid.exception.code, 400)
        invalid.exception.close()
        with urlopen(base + "catalog?source=wencai&status=ready") as response:
            self.assertEqual(json.load(response)["total"], 0)
        batch = next(item for item in data["batches"] if item["name"] == "batch.7z")
        with urlopen(base + f"batches/{batch['id']}/report?page=2") as response:
            self.assertEqual(len(json.load(response)["items"]), 5)
        for endpoint in ("catalog?page=0", f"batches/{batch['id']}/sample?index=-1"):
            with self.assertRaises(HTTPError) as error:
                urlopen(base + endpoint)
            self.assertEqual(error.exception.code, 400)
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(base + "tasks", data=b'{}', headers={"Content-Type": "application/json"}))
        self.assertEqual(error.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
