#!/usr/bin/env python3
"""Finite AIME ingestion using the data service's normalization and transactional publisher.

This module never starts a server, watcher, scheduler, or evaluation model.
Quarantine entries contain original coordinates; the original archive remains the source of truth.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import subprocess
import sys
import time
import signal
from pathlib import Path

import app
from multi_agent_inputs import AgentDataset


def trace_id(row):
    traces = row.get("traces")
    value = (traces[0].get("meta", {}).get("trace_id") if isinstance(traces, list) and len(traces) == 1
             else row.get("trace_id") or row.get("meta", {}).get("trace_id") if traces is None else None)
    return value.strip() if isinstance(value, str) and value.strip() else None


def comparable(row):
    # trace_id is independently checked against the captured trace, not synthesized from the session ID.
    return {key: value for key, value in app.comparable_row(row).items() if key != "trace_id"}


def wait_stable(path, stable_seconds, timeout_seconds, *, clock=time.monotonic, sleep=time.sleep):
    start = clock()
    previous = app.file_signature(path)
    unchanged = start
    while clock() - start < timeout_seconds:
        sleep(min(1, stable_seconds))
        current = app.file_signature(path)
        if current != previous:
            unchanged, previous = clock(), current
        if clock() - unchanged >= stable_seconds:
            return current
    return None


class AimeOnceDataset(AgentDataset):
    def __init__(self, archive_dir, input_dir, data_state, validator, node, seven_zip):
        super().__init__(Path(input_dir).parent.parent, Path(data_state).parent, "aime", "/data/aime")
        self.archive_dir, self.output_dir, self.state_dir = Path(archive_dir), Path(input_dir), Path(data_state)
        self.root_archive_state_file = self.state_dir / "root-archives.json"
        self.validator, self.node, self.seven_zip = validator, node, seven_zip
        self.trace_rows = {}
        self.baseline_ambiguous = set()

    def normalize_record(self, item, archive, member, line, index, issues):
        try:
            json.dumps(item, allow_nan=False)
        except (ValueError, RecursionError):
            raise app.InvalidRecord('invalid_json_number_or_depth')
        if isinstance(item, dict) and isinstance(item.get("meta"), dict):
            traces = item.get("traces")
            if isinstance(traces, list) and len(traces) > 1:
                raise app.InvalidRecord("multiple_traces_not_supported")
            meta = item["meta"]
            signals = [str(meta.get("agent_mode") or "").split("-", 1)[0], meta.get("session_type")]
            if isinstance(traces, list):
                signals += [t.get("meta", {}).get("mode") for t in traces if isinstance(t, dict) and isinstance(t.get("meta"), dict)]
            modes = {str(mode) for mode in signals if mode}
            if modes - {"fast", "expert"}:
                raise app.InvalidRecord("aime_mode_unknown")
            if len(modes) > 1:
                raise app.InvalidRecord("aime_mode_conflict")
            if item.get("request_time") is not None and meta.get("request_time") is not None:
                outer = app.request_day_and_value(item, {})[0]
                inner = app.request_day_and_value({}, meta)[0]
                if outer != inner:
                    raise app.InvalidRecord("request_date_conflict")
        model, day, row = super().normalize_record(item, archive, member, line, index, issues)
        identity = trace_id(row)
        if identity is None:
            raise app.InvalidRecord("trace_id_missing")
        row["trace_id"] = identity
        row["_source"]["business_date"] = day
        return model, day, row

    def index_existing_traces(self):
        self.trace_rows.clear()
        self.baseline_ambiguous.clear()
        for model in self.models:
            for file in sorted((self.output_dir / model).glob("*.jsonl")):
                before = file.stat()
                with file.open("rb") as stream:
                    offset = 0
                    for number, raw in enumerate(stream, 1):
                        if raw.strip():
                            row = json.loads(raw)
                            identity = trace_id(row)
                            if identity:
                                if identity in self.trace_rows:
                                    self.baseline_ambiguous.add(identity)
                                else:
                                    self.trace_rows[identity] = (file, offset, len(raw), model, number)
                        offset += len(raw)
                after = file.stat()
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise RuntimeError(f"input changed while indexing: {file}")

    @staticmethod
    def read_indexed(location):
        file, offset, length, _, _ = location
        with file.open("rb") as stream:
            stream.seek(offset)
            return json.loads(stream.read(length))

    def read_archive_records(self, info):
        check = subprocess.run([self.seven_zip, "t", "-y", "--", str(self.archive_dir / info["name"])],
                               capture_output=True, text=True)
        if check.returncode:
            raise app.ArchiveReadError("archive_integrity_failed: " + (check.stderr or check.stdout)[-2000:])
        records, report = super().read_archive_records(info)
        if not records:
            return records, report
        validation = self.staging / "validation.json"
        result = subprocess.run([self.node, self.validator, "--input", str(self.staging / "normalized.jsonl"),
                                 "--output", str(validation)], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError("TypeScript input validator failed: " + result.stderr[-2000:])
        for invalid in json.loads(validation.read_text())["invalid"]:
            key = ("aime", *invalid["key"])
            row = records.pop(key).row
            report.exclude_row(key[1], "evaluator_input_invalid", row)
            report.excluded[-1]["detail"] = invalid["error"]
        incoming = {}
        for key, record in list(records.items()):
            row, identity = record.row, trace_id(record.row)
            previous = self.trace_rows.get(identity)
            prior = incoming.get(identity)
            if previous or prior:
                old = self.read_indexed(previous) if previous else prior
                identical = identity not in self.baseline_ambiguous and comparable(old) == comparable(row)
                report.exclude_row(key[1], "duplicate_trace" if identical else "trace_identity_conflict", row)
                report.excluded[-1]["trace_id"] = identity
                del records[key]
            else:
                incoming[identity] = row
        return records, report

    def remember_published(self, report):
        indexes = {}
        for record in report.get("records", []):
            scope = (record["date"], record["model"])
            if scope not in indexes:
                indexes[scope] = json.loads(self.record_index_path(*scope).read_text())["offsets"]
            offset, length = indexes[scope][record["input_index"]]
            location = (Path(record["input_file"]), offset, length, record["model"], record["input_index"] + 1)
            row = self.read_indexed(location)
            identity = trace_id(row)
            record["trace_id"] = identity
            self.trace_rows[identity] = location


def snapshot(dataset):
    signature = sorted(app.archive_signature(dataset.archive_dir), key=lambda item: (item['mtime_ns'], item['name']))
    recorded = {entry["name"]: entry for entry in dataset.load_archive_state()["archives"]}
    failed = {entry["name"] for entry in dataset.load_archive_state()["failed_archives"]}
    pending = [entry["name"] for entry in signature if recorded.get(entry["name"]) != entry or entry["name"] in failed]
    return {"scanned_archives": len(signature), "new_archives": sum(name not in recorded for name in pending),
            "updated_archives": sum(name in recorded and recorded[name] != item for item in signature for name in [item["name"]] if name in pending),
            "retry_archives": sum(name in failed for name in pending), "names": pending,
            "archives": [{**item, "mtime_ns": str(item["mtime_ns"])} for item in signature if item["name"] in pending]}


def process_snapshot(dataset, names, stable_seconds, timeout_seconds, checkpoint=None):
    result = {"reports": [], "deferred": [], "baseline_ambiguous_trace_ids": []}
    journal = json.loads(checkpoint.read_text()) if checkpoint and checkpoint.exists() else {"names": names, "prepared": {}}
    if journal["names"] != names:
        raise ValueError("ingestion checkpoint does not match the frozen scan")
    # Recover durable publication before looking up receipts or sampling source coordinates.
    dataset.process_archives([])
    dataset.index_existing_traces()
    result["baseline_ambiguous_trace_ids"] = sorted(dataset.baseline_ambiguous)
    for name in names:
        if Path(name).name != name or Path(name).suffix.lower() != ".7z":
            raise ValueError("invalid archive name")
        path = dataset.archive_dir / name
        try:
            prepared = journal["prepared"].get(name)
            if prepared:
                db = dataset.open_archive_index()
                try:
                    prior = db.execute("SELECT report FROM cleaning_reports WHERE name=? AND size=? AND mtime_ns=?",
                                       (name, prepared["size"], prepared["mtime_ns"])).fetchone()
                finally:
                    db.close()
                if prior:
                    report = json.loads(prior[0])
                    dataset.remember_published(report)
                    result["reports"].append({"archive": name, "recovered": True, "signature": {**prepared, "mtime_ns": str(prepared["mtime_ns"])}, **report})
                    continue
            info = wait_stable(path, stable_seconds, timeout_seconds)
            if info is None or name in dataset.open_archive_writers():
                result["deferred"].append({"archive": name, "reason": "archive_not_stable"})
                continue
            if prepared and prepared != info:
                result["deferred"].append({"archive": name, "reason": "archive_replaced_before_publication"})
                continue
            journal["prepared"][name] = info
            if checkpoint:
                app.write_json_atomic(checkpoint, journal)
            dataset.process_archives([info], retry_failed=True)
            db = dataset.open_archive_index()
            try:
                saved = db.execute("SELECT report FROM cleaning_reports WHERE name=? AND size=? AND mtime_ns=?",
                                   (name, info["size"], info["mtime_ns"])).fetchone()
            finally:
                db.close()
            if saved is None:
                result["deferred"].append({"archive": name, "reason": "archive_changed_during_processing"})
                continue
            report = json.loads(saved[0])
            dataset.remember_published(report)
            result["reports"].append({"archive": name, "recovered": False, "signature": {**info, "mtime_ns": str(info["mtime_ns"])}, **report})
        except FileNotFoundError:
            result["deferred"].append({"archive": name, "reason": "archive_missing"})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["scan", "process"])
    for name in ["archive-dir", "input-dir", "data-state", "validator", "output"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--names-file")
    parser.add_argument("--node", default="node")
    parser.add_argument("--seven-zip", default="7z")
    parser.add_argument("--stable-seconds", type=float, default=3)
    parser.add_argument("--timeout-seconds", type=float, default=30)
    args = parser.parse_args()
    if args.stable_seconds <= 0 or args.timeout_seconds <= args.stable_seconds:
        parser.error("0 < stable-seconds < timeout-seconds is required")
    dataset = AimeOnceDataset(args.archive_dir, args.input_dir, args.data_state, args.validator, args.node, args.seven_zip)
    if not dataset.archive_dir.is_dir():
        parser.error("archive-dir does not exist")
    dataset.state_dir.mkdir(parents=True, exist_ok=True)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    with dataset.archive_lock(), contextlib.redirect_stdout(sys.stderr):
        result = snapshot(dataset) if args.operation == "scan" else process_snapshot(
            dataset, json.loads(Path(args.names_file).read_text()), args.stable_seconds, args.timeout_seconds,
            Path(args.output + ".checkpoint.json"))
        app.write_json_atomic(Path(args.output), result)


if __name__ == "__main__":
    main()
