#!/usr/bin/env python3
"""aime/ifind source adapters for the unified dashboard's incremental processor."""

from __future__ import annotations

import json
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import app

SOURCES = {
    "aime": ("1_aime", ("aime_fast", "aime_expert")),
    "ifind": ("2_ifind", ("ifind_normal_agent", "ifind_deep_research")),
}


def normalize_session(value: dict, provider: str, archive: str, member: str, line: int, item: int, metadata_issues: list | None = None) -> tuple[str, str, dict]:
    meta = app.normalize_meta(value["meta"], metadata_issues)
    traces = value["traces"]
    if "messages" in value or not isinstance(traces, list) or not traces:
        raise app.InvalidRecord("session_traces_invalid")
    if meta.get("ok") is False:
        raise app.InvalidRecord("collection_failed")
    for trace in traces:
        if (not isinstance(trace, dict) or not isinstance(trace.get("meta"), dict) or
                not isinstance(trace.get("messages"), list) or
                any(not isinstance(message, dict) for message in trace["messages"])):
            raise app.InvalidRecord("session_trace_invalid")
    # Retain every round, including failed/empty rounds, when the session has an answer.
    views = [app.visible_record({"messages": trace["messages"]}) for trace in traces]
    if not any(view.get("question") for view in views) and not meta.get("question"):
        raise app.InvalidRecord("question_missing")
    if not any(view.get("answer") for view in views):
        raise app.InvalidRecord("answer_empty")
    if provider == "aime":
        mode = str(meta.get("agent_mode") or "").split("-", 1)[0] or meta.get("session_type")
        modes = {trace["meta"].get("mode") for trace in traces} - {None}
        mode = mode or (next(iter(modes)) if len(modes) == 1 else None)
        if mode not in ("fast", "expert"):
            raise app.InvalidRecord("aime_mode_unknown")
        channel = "aime_" + mode
    else:
        mode = meta.get("agent_mode") or meta.get("session_type")
        modes = {trace["meta"].get("mode") for trace in traces} - {None}
        mode = mode or (next(iter(modes)) if len(modes) == 1 else None)
        named = next((mode for mode in ("normal_agent", "deep_research") if "ifind_" + mode in archive + "/" + member), None)
        mode = mode or named
        if mode not in ("normal_agent", "deep_research") or (named and named != mode):
            raise app.InvalidRecord("ifind_mode_unknown_or_conflicting")
        channel = "ifind_" + mode
    timing = meta
    if value.get("request_time") is None and meta.get("request_time") is None and meta.get("timestamp_time") is None:
        timing = {**meta, "request_time": next((trace["meta"]["timestamp"] for trace in traces if trace["meta"].get("timestamp")), None)}
    day, request_time = app.request_day_and_value(value, timing)
    identity = meta.get("session_id") or value.get("case_id") or meta.get("case_id")
    if not identity and len(traces) == 1:
        identity = traces[0]["meta"].get("trace_id") or meta.get("trace_id")
    if isinstance(identity, bool) or not isinstance(identity, (str, int)) or not str(identity).strip():
        raise app.InvalidRecord("session_identity_missing")
    batch = value.get("batch_id") or meta.get("batch_id") or day
    if not isinstance(batch, str) or not batch.strip():
        raise app.InvalidRecord("batch_id_invalid")
    row = {"request_time": request_time, "has_standard_answer": app.standard_answer_flag(value, meta), "versions": "default",
           **{key: field for key, field in value.items() if key not in ("request_time", "has_standard_answer", "versions")}}
    row.update(batch_id=batch, case_id=str(identity).strip(), version=channel, meta=meta,
               _source={"original_file": archive + "/" + member, "original_line": line, "original_item": item})
    return channel, day, row


def normalize(value: object, provider: str, archive: str, member: str, line: int, item: int, metadata_issues: list | None = None) -> tuple[str, str, dict]:
    if not isinstance(value, dict) or not isinstance(value.get("meta"), dict):
        raise app.InvalidRecord("record_or_meta_invalid")
    if "traces" in value:
        return normalize_session(value, provider, archive, member, line, item, metadata_issues)
    row = dict(value)
    meta = app.normalize_meta(row["meta"], metadata_issues)
    if meta.get("ok") is False:
        raise app.InvalidRecord("collection_failed")
    messages = row.get("messages")
    if not isinstance(messages, list) or not messages or any(not isinstance(message, dict) for message in messages):
        raise app.InvalidRecord("messages_invalid")
    last_user = max((i for i, message in enumerate(messages) if message.get("role") == "user"), default=-1)
    if last_user < 0 or not (app.content_text(messages[last_user].get("content")).strip() or meta.get("question")):
        raise app.InvalidRecord("question_missing")
    if not any(message.get("role") == "assistant" and app.content_text(message.get("content")).strip()
               for message in messages[last_user + 1:]):
        raise app.InvalidRecord("answer_empty")
    if provider == "aime":
        mode = str(meta.get("agent_mode") or "").split("-", 1)[0] or meta.get("session_type")
        if mode not in ("fast", "expert"):
            raise app.InvalidRecord("aime_mode_unknown")
        channel = "aime_" + mode
    else:
        mode = meta.get("agent_mode")
        named = next((mode for mode in ("normal_agent", "deep_research") if "ifind_" + mode in archive + "/" + member), None)
        mode = mode or named
        if mode not in ("normal_agent", "deep_research") or (named and named != mode):
            raise app.InvalidRecord("ifind_mode_unknown_or_conflicting")
        channel = "ifind_" + mode
    day, request_time = app.request_day_and_value(row, meta)
    batch = row.get("batch_id") or meta.get("batch_id") or day
    if not isinstance(batch, str) or not batch.strip():
        raise app.InvalidRecord("batch_id_invalid")
    identity = row.get("case_id") or meta.get("case_id") or meta.get("item_id") or meta.get("question_id")
    if not identity:
        identity = meta.get("trace_id") or meta.get("session_id")
        if meta.get("session_round") is not None:
            identity = f"{identity}:round:{meta['session_round']}" if identity else None
    if isinstance(identity, bool) or not isinstance(identity, (str, int)) or not str(identity).strip():
        raise app.InvalidRecord("identity_missing")
    normalized = {
        "request_time": request_time, "has_standard_answer": app.standard_answer_flag(row, meta), "versions": "default",
        **{key: value for key, value in row.items() if key not in ("request_time", "has_standard_answer", "versions")},
    }
    normalized.update({"batch_id": batch,
                       "case_id": str(identity).strip(), "version": channel, "meta": meta,
                       "trace_id": meta.get("trace_id"),
                       "_source": {"original_file": archive + "/" + member, "original_line": line, "original_item": item}})
    return channel, day, normalized


@dataclass(frozen=True)
class StagedRecord:
    day: str
    cache: Path
    offset: int
    length: int
    archive: str
    member: str

    @property
    def row(self) -> dict:
        with self.cache.open("rb") as stream:
            stream.seek(self.offset)
            return json.loads(stream.read(self.length))


class AgentDataset(app.Dataset):
    def __init__(self, root: Path, state_root: Path, provider: str, url_prefix: str):
        directory, models = SOURCES[provider]
        dataset_root = root / directory
        super().__init__(dataset_root, state_root / provider, models, provider, url_prefix=url_prefix)
        self.provider = provider
        self.archive_dir = dataset_root / "1_7z_data"
        self.archived_dir = dataset_root / "0_archive"
        self.output_dir = dataset_root / "2_daily_eval_input"
        self.archive_part_files = 100
        self.independent = True
        self.pairs = {}
        self.staging: Path | None = None

    def record_identity(self, row: dict, model: str) -> app.RecordKey:
        batch, case = row.get("batch_id"), row.get("case_id")
        if not isinstance(batch, str) or not batch or not isinstance(case, str) or not case:
            raise ValueError("record has no business identity")
        return self.provider, model, batch, case

    def recover(self) -> None:
        self.process_archives([])
        # Publication recovery uses durable output stages, never the normalization cache.
        for folder in self.state_dir.glob("ingest-*"):
            if folder.is_dir():
                shutil.rmtree(folder)
        for model in self.models:
            for directory in (self.output_dir / model, self.state_dir / "records" / model):
                for path in directory.glob(".*.tmp"):
                    if re.fullmatch(r"\.\d{4}-\d{2}-\d{2}\.[a-z0-9_]{8}\.tmp", path.name):
                        path.unlink()

    def process_archives(self, signature: list[dict[str, object]], *, retry_failed: bool = False) -> None:
        temporary_root = self.state_dir / "tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=f"ths-ingest-{self.provider}-", dir=temporary_root) as folder:
            self.staging = Path(folder)
            try:
                super().process_archives(signature, retry_failed=retry_failed)
            finally:
                self.staging = None

    def normalize_record(self, item, archive, member, line, index, issues):
        return normalize(item, self.provider, archive, member, line, index, issues)

    def read_archive_records(self, info: dict[str, object]) -> tuple[dict[app.RecordKey, app.IncomingRecord], app.CleaningReport]:
        if self.staging is None:
            raise RuntimeError("archive processing has no staging directory")
        path = self.archive_dir / str(info["name"])
        cache = self.staging / "normalized.jsonl"
        records: dict[app.RecordKey, app.IncomingRecord] = {}
        skipped = app.CleaningReport()
        with tempfile.TemporaryDirectory(prefix="raw-", dir=self.staging) as folder:
            try:
                with app.SevenZipFile(path, "r") as archive:
                    members = sorted(name for name in archive.getnames() if name.lower().endswith(".jsonl"))
                    if not members:
                        raise ValueError("archive has no JSONL files")
                    for member in members:
                        safe = PurePosixPath(member.replace("\\", "/"))
                        if safe.is_absolute() or ".." in safe.parts:
                            raise ValueError("unsafe archive member: " + member)
                    archive.extract(path=folder, targets=members)

            except Exception as exc:
                raise app.ArchiveReadError(str(exc)) from exc
            with cache.open("wb") as output:
                for member in members:
                    source = Path(folder).joinpath(*PurePosixPath(member.replace("\\", "/")).parts)
                    for line, raw in skipped.lines(source, path.name, member):
                        if not raw.strip():
                            continue
                        try:
                            value = json.loads(raw.decode("utf-8-sig"))
                        except (ValueError, UnicodeDecodeError):
                            skipped.read += 1
                            skipped.exclude(self.provider, "invalid_json", path.name, member, line)
                            continue
                        items = value if isinstance(value, list) else [value]
                        if not items:
                            skipped.read += 1
                            skipped.exclude(self.provider, "empty_session", path.name, member, line)
                        for index, item in enumerate(items, 1):
                            skipped.read += 1
                            try:
                                issues = []
                                model, day, row = self.normalize_record(item, path.name, member, line, index, issues)
                                key = self.record_identity(row, model)
                            except app.InvalidRecord as exc:
                                skipped.exclude(self.provider, exc.reason, path.name, member, line, index, item)
                                continue
                            skipped.note_metadata(model, row, issues)
                            if key in records:
                                reason = "duplicate_case" if app.comparable_row(records[key].row) == app.comparable_row(row) else "identity_conflict"
                                skipped.exclude_row(model, reason, row)
                                continue
                            encoded = (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
                            records[key] = StagedRecord(day, cache, output.tell(), len(encoded), path.name, member)
                            output.write(encoded)
                            output.flush()
                        if line % 200 == 0:
                            print(f"staged {path.name}: {line} lines, {len(records)} valid unique records", flush=True)
        return records, skipped
