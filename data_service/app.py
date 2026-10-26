#!/usr/bin/env python3
"""Process independent input sources and stream ready JSONL from one HTTP service."""

from __future__ import annotations

import json
import fcntl
import os
import re
import signal
import sqlite3
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import NamedTuple, Protocol, cast
from urllib.parse import parse_qs, urlsplit

CODE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(CODE_DIR / ".packages"))

from py7zr import SevenZipFile  # noqa: E402
from cleaning_report import CleaningReport  # noqa: E402
from metadata import normalize_meta  # noqa: E402

POLL_SECONDS = 5
STABLE_SECONDS = 30
ARCHIVE_PART_FILES = 50
ARCHIVE_PART_BYTES = 2 * 1024 ** 3
SHANGHAI = timezone(timedelta(hours=8))
TOP_LEVEL_FIELD_ORDER = ("request_time", "has_standard_answer", "versions")
ROOT_MODELS = ("a_fast", "b_fast", "a_expert", "b_expert")
MODELS = ("a_fast", "b_fast", "a_expert", "b_expert", "6_luna", "6.1sol")
POST_TRAINING_MODELS = ("b_fast", "b_post_train_fast")
STAGES = ("criteria", "attribution", "clustering")
TASK_COUNTS = {"total", "completed", "running", "pending", "failed", "blocked", "cancelled"}
VERSION_NAMES = {
    "a_fast": "A Fast",
    "b_fast": "B Fast",
    "a_expert": "A Expert",
    "b_expert": "B Expert",
    "b_post_train_fast": "B post_train_fast",
    "6_luna": "6_luna",
    "6.1sol": "6.1sol",
}
MEMBER_MODEL = re.compile(r"(?:^|[_-])(aa|b|a)-(fast|expert)(?:\.incr\d+)?\.jsonl$", re.IGNORECASE)
MEMBER_INCREMENT = re.compile(r"\.incr(\d+)\.jsonl$", re.IGNORECASE)
ARCHIVE_SOURCE_ID = re.compile(r"^([0-9a-f]{16})(?:_\d{8}_\d{6})?\.7z$", re.IGNORECASE)


def archive_signature(folder: Path) -> list[dict[str, object]]:
    result = []
    for path in sorted(folder.glob("*.7z")):
        stat = path.stat()
        result.append({"name": path.name, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns})
    return result


def valid_iso_day(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def model_for_member(member: str) -> str | None:
    explicit = re.search(r"(?:^|[_-])(a_fast|b_fast|b_post_train_fast|a_expert|b_expert|6_luna|6\.1sol)(?:\.incr\d+)?\.jsonl$", PurePosixPath(member).name, re.IGNORECASE)
    if explicit:
        return explicit.group(1).lower()
    gpt = re.search(r"(?:^|[_-])gpt-(luna|sol)(?:\.incr\d+)?\.jsonl$", PurePosixPath(member).name, re.IGNORECASE)
    if gpt:
        return {"luna": "6_luna", "sol": "6.1sol"}[gpt.group(1).lower()]
    if re.search(r"(?:^|[_-])(?:aa|b)-post_train_fast(?:_V1)?(?:\.incr\d+)?\.jsonl$", PurePosixPath(member).name, re.IGNORECASE):
        return "b_post_train_fast"
    match = MEMBER_MODEL.search(PurePosixPath(member).name)
    if not match:
        return None
    group = "a" if match.group(1).lower() == "a" else "b"
    return f"{group}_{match.group(2).lower()}"


def archive_source_id(name: str) -> str:
    match = ARCHIVE_SOURCE_ID.fullmatch(PurePosixPath(name).name)
    return match.group(1).lower() if match else name


def member_increment(member: str) -> int:
    match = MEMBER_INCREMENT.search(PurePosixPath(member).name)
    return int(match.group(1)) if match else 0


class InvalidRecord(ValueError):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def request_day_and_value(row: dict[str, object], meta: dict[str, object]) -> tuple[str, str]:
    request_time = row.get("request_time")
    if request_time is None:
        request_time = meta.get("request_time")
    if request_time is not None:
        if not isinstance(request_time, str) or not request_time.strip():
            raise InvalidRecord("request_time_invalid")
        try:
            parsed = datetime.fromisoformat(request_time.strip().replace("Z", "+00:00"))
        except ValueError as exc:
            raise InvalidRecord("request_time_invalid") from exc
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=SHANGHAI)
        local = parsed.astimezone(SHANGHAI)
        return local.date().isoformat(), request_time.strip()

    timestamp = meta.get("timestamp_time")
    if timestamp is None:
        raise InvalidRecord("request_time_missing")
    if type(timestamp) is not int or timestamp <= 0:
        raise InvalidRecord("timestamp_time_invalid")
    try:
        local = datetime.fromtimestamp(timestamp / 1000, SHANGHAI)
    except (OverflowError, OSError, ValueError) as exc:
        raise InvalidRecord("timestamp_time_invalid") from exc
    return local.date().isoformat(), local.isoformat(sep=" ", timespec="milliseconds")


def record_versions(day: str, model: str) -> str:
    if model == "b_fast" and date.fromisoformat(day) >= date(2026, 9, 29):
        return "0929-big-fast"
    return "default"


def standard_answer_flag(row: dict[str, object], meta: dict[str, object]) -> bool:
    if "has_standard_answer" in row:
        flag = row["has_standard_answer"]
    else:
        flag = meta.get("has_standard_answer")
    if flag is None and "has_standard_answer" not in row:
        flag = any(meta.get(key) not in (None, "") for key in ("ground_truth", "std_answer"))
    if type(flag) is not bool:
        raise InvalidRecord("standard_answer_flag_invalid")
    if flag:
        references = [meta.get(key) for key in ("ground_truth", "std_answer") if meta.get(key) not in (None, "")]
        if len({json.dumps(item, ensure_ascii=False, sort_keys=True) for item in references}) > 1:
            raise InvalidRecord("standard_answer_conflict")
    return flag


def top_level_fields(request_time: str, has_standard_answer: bool, day: str, model: str) -> dict[str, object]:
    fields = {
        "request_time": request_time,
        "has_standard_answer": has_standard_answer,
        "versions": record_versions(day, model),
    }
    if tuple(fields) != TOP_LEVEL_FIELD_ORDER:
        raise RuntimeError("top-level field order is inconsistent")
    return fields


def normalize_row(value: object, model: str, archive_name: str, member: str, line_number: int, *, testset_dates: bool = False, metadata_issues: list | None = None) -> tuple[str, dict[str, object]]:
    if not isinstance(value, dict):
        raise InvalidRecord("record_not_object")
    row = value
    raw_meta = row.get("meta")
    if raw_meta is not None and not isinstance(raw_meta, dict):
        raise InvalidRecord("meta_invalid")
    meta = raw_meta or {}
    if "traces" in row:
        traces = row["traces"]
        if not isinstance(traces, list):
            raise InvalidRecord("traces_invalid")
        if len(traces) != 1:
            raise InvalidRecord("single_trace_required")
        trace = traces[0]
        if not isinstance(trace, dict):
            raise InvalidRecord("trace_invalid")
        trace_meta = trace.get("meta")
        if not isinstance(trace_meta, dict):
            raise InvalidRecord("trace_meta_invalid")
        meta = {**trace_meta, **meta}
        if row.get("request_time") is None and meta.get("request_time") is None and meta.get("timestamp_time") is None:
            meta["request_time"] = trace_meta.get("timestamp")
        row = {key: item for key, item in row.items() if key != "traces"}
        row.update({
            "meta": meta,
            "messages": trace.get("messages"),
            "trace_id": trace_meta.get("trace_id") or row.get("trace_id") or meta.get("trace_id"),
        })

    meta = normalize_meta(meta, metadata_issues)
    batch_id = row.get("batch_id") or meta.get("batch_id")
    testset = meta.get("testset_name") if testset_dates else None
    case_id = row.get("case_id") or meta.get("case_id") or meta.get("item_id")
    if row.get("case_id") and meta.get("case_id") and row["case_id"] != meta["case_id"]:
        raise InvalidRecord("case_id_conflict")
    if not isinstance(case_id, str) or not case_id.strip():
        raise InvalidRecord("case_id_missing")
    version = row.get("version")
    accepted_versions = {VERSION_NAMES[model]}
    if model.startswith("b_"):
        accepted_versions.add(VERSION_NAMES[model].replace("B ", "AA ", 1))
    if version and version not in accepted_versions:
        raise InvalidRecord("version_mismatch")
    if batch_id is not None and (not isinstance(batch_id, str) or not batch_id.strip()):
        raise InvalidRecord("batch_id_invalid")

    messages = row.get("messages")
    if meta.get("ok") is False or not isinstance(messages, list) or not messages or any(not isinstance(message, dict) for message in messages):
        raise InvalidRecord("message_chain_invalid")
    accepted_types = (
        {"message", "reasoning", "function_call", "function_call_output"}
        if model.startswith("a_")
        else {"user_question", "llm_turn", "tool_call", "tool_result", "final_answer"}
    )
    if model in ("6_luna", "6.1sol"):
        accepted_types |= {"message", "reasoning", "function_call", "function_call_output", "span"}
    fallback_type = "message" if not model.startswith("b_") else None
    if any(str(message.get("type") or fallback_type) not in accepted_types for message in messages):
        raise InvalidRecord("message_type_unsupported")
    last_user = max((index for index, message in enumerate(messages) if message.get("role") == "user"), default=-1)
    if last_user < 0:
        raise InvalidRecord("question_missing")
    answer = next((content_text(message.get("content")).strip() for message in reversed(messages[last_user + 1:])
                   if message.get("role") == "assistant" and content_text(message.get("content")).strip()), "")
    if not answer:
        raise InvalidRecord("answer_empty")
    user_content = messages[last_user].get("content")
    question = content_text(user_content[:1] if isinstance(user_content, list) else user_content).strip()
    meta_question = str(meta.get("question") or "").strip()
    question = question or meta_question
    if not question or (meta_question and re.sub(r"\s+", "", question) != re.sub(r"\s+", "", meta_question)):
        raise InvalidRecord("question_invalid")

    has_standard_answer = standard_answer_flag(row, meta)
    day, request_time = request_day_and_value(row, meta)
    if isinstance(testset, str):
        dates = re.findall(r"(?<!\d)(\d{4})-?(\d{2})-?(\d{2})(?!\d)", testset)
        if len(dates) > 1:
            raise InvalidRecord("testset_date_ambiguous")
        if dates:
            try:
                day = date(*map(int, dates[0])).isoformat()
            except ValueError as exc:
                raise InvalidRecord("testset_date_invalid") from exc
    header = top_level_fields(request_time, has_standard_answer, day, model)
    normalized = {**header, **{key: item for key, item in row.items() if key not in header}}
    normalized["batch_id"] = batch_id or day
    normalized["case_id"] = case_id.strip()
    normalized["version"] = VERSION_NAMES[model]
    normalized["meta"] = meta
    normalized["trace_id"] = row.get("trace_id") or meta.get("trace_id")
    normalized["_source"] = {
        "original_file": f"{archive_name}/{member}",
        "original_line": line_number,
    }
    return day, normalized


def members_by_model(archive: SevenZipFile, archive_path: Path, models: tuple[str, ...], report: CleaningReport) -> dict[str, list[str]]:
    grouped = {model: [] for model in models}
    for member in archive.getnames():
        if not member.lower().endswith(".jsonl"):
            continue
        safe_member = PurePosixPath(member.replace("\\", "/"))
        if safe_member.is_absolute() or ".." in safe_member.parts:
            raise ValueError(f"unsafe archive path: {member}")
        model = model_for_member(member)
        if model not in grouped:
            report.file_errors.append({"original_file": f"{archive_path.name}/{member}", "reason": "model_unknown"})
            continue
        grouped[model].append(member)
    if not any(grouped.values()):
        raise ValueError(f"{archive_path.name} has no recognized model JSONL files")
    for members in grouped.values():
        members.sort(key=lambda member: (member_increment(member), PurePosixPath(member).name.casefold()))
    return grouped


RecordKey = tuple[str, str, str, str]


class ArchiveRecord(NamedTuple):
    day: str
    row: dict[str, object]
    archive: str
    member: str


class IncomingRecord(Protocol):
    @property
    def day(self) -> str: ...
    @property
    def row(self) -> dict[str, object]: ...
    @property
    def archive(self) -> str: ...
    @property
    def member(self) -> str: ...


class ArchiveReadError(ValueError):
    pass


def file_signature(path: Path) -> dict[str, object] | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return {"name": path.name, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def record_origin(row: dict) -> tuple[str, str]:
    source = row.get("_source")
    original = source.get("original_file") if isinstance(source, dict) else None
    if not isinstance(original, str):
        raise ValueError("published archive record has no original_file")
    archive, separator, member = original.partition("/")
    if not separator or not archive.endswith(".7z") or not member:
        raise ValueError("published archive record has an invalid archive origin")
    return archive, member


def record_key(row: dict, model: str) -> RecordKey:
    archive, _ = record_origin(row)
    batch, case = row.get("batch_id"), row.get("case_id")
    if not isinstance(batch, str) or not batch or not isinstance(case, str) or not case:
        raise ValueError("published archive record has no business identity")
    return archive_source_id(archive), model, batch, case


def comparable_row(row: dict) -> dict:
    return {key: value for key, value in row.items() if key != "_source"}


def write_json_atomic(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def content_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(content_text(item) for item in value if isinstance(item, (str, dict, list)))
    if isinstance(value, dict):
        return str(value.get("text") or "")
    return ""


def visible_record(row: dict[str, object]) -> dict[str, object]:
    meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
    meta = cast(dict, meta)
    def identifier(value: object) -> str | None:
        if isinstance(value, (str, int)) and not isinstance(value, bool):
            return str(value).strip() or None
        return None
    session_id = identifier(meta.get("session_id") or row.get("session_id"))
    traces = row.get("traces")
    if isinstance(traces, list):
        turns = [visible_record({"meta": trace.get("meta", {}), "messages": trace.get("messages", []),
                                 "has_standard_answer": row.get("has_standard_answer")})
                 for trace in traces if isinstance(trace, dict)]
        return {"format": "session", "session_id": session_id, "turns": turns}
    messages = row.get("messages")
    question = ""
    answer = ""
    if isinstance(messages, list):
        last_user = max((index for index, message in enumerate(messages) if isinstance(message, dict) and message.get("role") == "user"), default=-1)
        if last_user >= 0:
            content = messages[last_user].get("content")
            question = content_text(content[:1] if isinstance(content, list) else content).strip()
            for message in messages[last_user + 1:]:
                if isinstance(message, dict) and message.get("role") == "assistant":
                    text = content_text(message.get("content")).strip()
                    if text:
                        answer = text
    if not question and isinstance(meta, dict):
        question = str(meta.get("question") or "").strip()
    record: dict[str, object] = {"format": "trace", "trace_id": identifier(row.get("trace_id") or meta.get("trace_id")),
                                 "session_id": session_id, "question": question, "answer": answer}
    if row.get("has_standard_answer") is not False and isinstance(meta, dict):
        reference = next((meta.get(key) for key in ("ground_truth", "std_answer") if meta.get(key) not in (None, "")), None)
        if reference is None:
            reference = next((row.get(key) for key in ("ground_truth", "std_answer") if row.get(key) not in (None, "")), None)
        if reference is not None:
            record["standard_answer"] = reference
    return record


class Dataset:
    def __init__(self, root: Path, state_dir: Path, models: tuple[str, ...], kind: str = "", *,
                 url_prefix: str | None = None, archive_dir: Path | None = None, output_dir: Path | None = None):
        self.root = root
        self.archive_dir = archive_dir or root
        self.archived_dir = self.archive_dir / "3_processed_archives"
        self.output_dir = output_dir or root / "2_eval_data_input"
        self.state_dir = state_dir
        self.progress_file = state_dir / "evaluation-progress.json"
        self.root_archive_state_file = state_dir / "root-archives.json"
        self.progress_lock = threading.Lock()
        self.models = models
        self.kind = kind
        self.url_prefix = url_prefix if url_prefix is not None else ("" if not kind else "/" + kind)
        self.archive_part_files = ARCHIVE_PART_FILES
        self.independent = False
        self.clean_cancel = None
        self.pairs = ({"fast": ("a_fast", "b_fast"), "expert": ("a_expert", "b_expert")}
                      if not kind else {
                          "__vs__".join(sorted((left, right))): (left, right)
                          for group in ((models,) if kind == "post_training_model" else
                                        (("a_fast", "b_fast", "6_luna"), ("a_expert", "b_expert", "6.1sol")))
                          for index, left in enumerate(group) for right in group[index + 1:]
                      })

    def ready_path(self, day: str) -> Path:
        return self.state_dir / f"{day}.ready.json"

    def check_clean_cancelled(self) -> None:
        if self.clean_cancel is not None and self.clean_cancel.is_set():
            raise InterruptedError("清洗已取消")


    def record_identity(self, row: dict, model: str) -> RecordKey:
        return record_key(row, model)

    def recover(self) -> None:
        self.process_archives([])


    def record_index_path(self, day: str, model: str) -> Path:
        return self.state_dir / "records" / model / f"{day}.json"


    def write_record_index(self, file_path: Path, offsets: list[list[int]], metadata: os.stat_result | None = None) -> dict[str, int]:
        stat = metadata or file_path.stat()
        index_path = self.record_index_path(file_path.stem, file_path.parent.name)
        index_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = index_path.with_suffix(".tmp")
        temp_path.write_text(json.dumps({"size_bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns, "offsets": offsets}, separators=(",", ":")))
        os.replace(temp_path, index_path)
        return {"size_bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns}


    def known_days(self) -> list[str]:
        days = set()
        for path in self.state_dir.glob("*.ready.json"):
            day = path.name.removesuffix(".ready.json")
            if valid_iso_day(day):
                days.add(day)
        for model in self.models:
            for path in (self.output_dir / model).glob("*.jsonl"):
                if valid_iso_day(path.stem):
                    days.add(path.stem)
        progress = self.evaluation_progress()
        progress_dates = progress.get("dates") if isinstance(progress, dict) else None
        if isinstance(progress_dates, list):
            for entry in progress_dates:
                day = entry.get("date") if isinstance(entry, dict) else None
                if valid_iso_day(day):
                    days.add(day)
        return sorted(days)


    def ready_state(self, day: str) -> dict[str, object] | None:
        try:
            state = json.loads(self.ready_path(day).read_text())
            if not isinstance(state, dict):
                return None
            if state.get("source") not in ("root_archives", "local_import"):
                return None
            rows = state.get("rows")
            files = state.get("files")
            if not isinstance(rows, dict) or not rows or any(model not in self.models or type(count) is not int or count < 0 for model, count in rows.items()):
                return None
            if not isinstance(files, dict):
                return None
            for model in rows:
                file_path = self.output_dir / model / f"{day}.jsonl"
                metadata = files.get(model)
                if not file_path.is_file() or not isinstance(metadata, dict):
                    return None
                stat = file_path.stat()
                if metadata.get("size_bytes") != stat.st_size or metadata.get("mtime_ns") != stat.st_mtime_ns:
                    return None
                if not self.record_index_path(day, model).is_file():
                    return None
            return state
        except (OSError, ValueError):
            return None


    def is_ready(self, day: str) -> bool:
        return self.ready_state(day) is not None


    def evaluation_progress(self) -> dict[str, object] | None:
        with self.progress_lock:
            try:
                progress = json.loads(self.progress_file.read_text())
            except (OSError, ValueError):
                return None
        if not isinstance(progress, dict):
            return None
        progress["stale"] = progress["status"] == "running" and time.time() * 1000 - progress["updated_at"] > 60_000
        return progress


    def available_dates(self) -> list[dict[str, object]]:
        return [{"date": day, "models": list(cast(dict, state["rows"]))} for day in self.known_days() if (state := self.ready_state(day)) is not None]


    def dashboard_data(self) -> dict[str, object]:
        dates = []
        for day in reversed(self.known_days()):
            state = self.ready_state(day)
            ready = state is not None
            rows = cast(dict[str, int], state["rows"]) if state else {}
            models = {model: {"ready": ready and model in rows, "row_count": rows.get(model, 0)} for model in self.models}
            dates.append({"date": day, "ready": ready, "models": models})
        return {"dates": dates, "evaluation": self.evaluation_progress()}


    def load_archive_state(self) -> dict:
        if not self.root_archive_state_file.exists():
            if any(json.loads(marker.read_text()).get("source") == "root_archives" for marker in self.state_dir.glob("*.ready.json")):
                raise ValueError("archive receipts missing; refusing to replay published data")
            return {"archives": [], "dates": [], "failed_archives": []}
        value = json.loads(self.root_archive_state_file.read_text())
        if not isinstance(value, dict) or any(not isinstance(value.get(key), list) for key in ("archives", "dates", "failed_archives")):
            raise ValueError("invalid root archive receipts")
        return value


    def pending_archives(self, signature: list[dict[str, object]]) -> list[dict[str, object]]:
        recorded = {item["name"]: item for item in self.load_archive_state()["archives"]}
        return [item for item in signature if recorded.get(item["name"]) != item]


    def open_archive_writers(self) -> set[str]:
        writers = set()
        for fd in Path("/proc").glob("[0-9]*/fd/*"):
            try:
                target = fd.readlink()
                if target.parent != self.archive_dir or target.suffix != ".7z":
                    continue
                info = (fd.parent.parent / "fdinfo" / fd.name).read_text()
                flags = next(line.split(":", 1)[1].strip() for line in info.splitlines() if line.startswith("flags:"))
                if int(flags, 8) & 3:
                    writers.add(target.name)
            except (OSError, StopIteration):
                continue
        return writers


    @contextmanager
    def archive_lock(self):
        with (self.state_dir / "archive.lock").open("a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield


    def archive_target(self, day: str, source: Path, slots: dict[str, tuple[Path, int, int]]) -> Path:
        folder = self.archived_dir / day
        if day not in slots:
            parts = sorted((p for p in folder.glob("part-*") if p.is_dir() and re.fullmatch(r"part-\d{4,}", p.name)),
                           key=lambda p: int(p.name[5:]))
            part = parts[-1] if parts else folder / "part-0001"
            files = list(part.glob("*.7z"))
            slots[day] = (part, len(files), sum(p.stat().st_size for p in files))
        part, count, size = slots[day]
        incoming = source.stat().st_size
        if count >= self.archive_part_files or (count and size + incoming > ARCHIVE_PART_BYTES) or (part / source.name).exists():
            part = folder / f"part-{int(part.name[5:]) + 1:04d}"
            count, size = 0, 0
        part.mkdir(parents=True, exist_ok=True)
        slots[day] = (part, count + 1, size + incoming)
        return part / source.name


    def organize_archives(self) -> dict[str, object]:
        with self.archive_lock():
            slots: dict[str, tuple[Path, int, int]] = {}
            moved = 0
            for folder in sorted(self.archived_dir.glob("*")):
                if not folder.is_dir() or not valid_iso_day(folder.name):
                    continue
                retained: dict[Path, tuple[int, int]] = {}
                for source in sorted(folder.rglob("*.7z")):
                    part = source.parent
                    count, size = retained.get(part, (0, 0))
                    incoming = source.stat().st_size
                    partitioned = part.parent == folder and re.fullmatch(r"part-\d{4,}", part.name)
                    if partitioned and count < self.archive_part_files and (not count or size + incoming <= ARCHIVE_PART_BYTES):
                        retained[part] = (count + 1, size + incoming)
                        continue
                    target = self.archive_target(folder.name, source, slots)
                    source.rename(target)
                    moved += 1
            files = list(self.archived_dir.glob("*/part-*/*.7z"))
            report = {
                "checked_at": int(time.time() * 1000), "packages": len(files),
                "bytes": sum(p.stat().st_size for p in files),
                "partitions": len({p.parent for p in files}),
                "oversized": [str(p.relative_to(self.archived_dir)) for p in files if p.stat().st_size > ARCHIVE_PART_BYTES],
            }
            write_json_atomic(self.state_dir / "archive-maintenance.json", report)
            print(f"archive inspection {self.archived_dir}: {len(files)} packages, {report['partitions']} parts, {moved} moved", flush=True)
            return report


    def processing_status(self) -> dict[str, object]:
        try:
            state = self.load_archive_state()
            signature = archive_signature(self.archive_dir)
            recorded = {item["name"]: item for item in state["archives"]}
            stamps = [int(item["mtime_ns"]) // 1_000_000 for item in [*state["archives"], *signature]]
            published = [int(p.stat().st_mtime * 1000) for p in self.state_dir.glob("*.ready.json")]
            try:
                archive = json.loads((self.state_dir / "archive-maintenance.json").read_text())
            except FileNotFoundError:
                archive = None
            return {"received_at": max(stamps, default=None), "published_at": max(published, default=None),
                    "pending": sum(recorded.get(item["name"]) != item for item in signature),
                    "failed": state["failed_archives"], "archive": archive, "error": None}
        except (OSError, ValueError, KeyError, TypeError) as exc:
            return {"error": str(exc)}






    def open_archive_index(self) -> sqlite3.Connection:
        path = self.state_dir / "archive-records.sqlite"
        if not path.exists():
            self.state_dir.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(prefix=".archive-records-", suffix=".sqlite", dir=self.state_dir)
            os.close(fd)
            temporary = Path(name)
            db = sqlite3.connect(temporary)
            try:
                db.executescript("""
                    CREATE TABLE records (
                        source TEXT NOT NULL, model TEXT NOT NULL, batch_id TEXT NOT NULL,
                        case_id TEXT NOT NULL, day TEXT NOT NULL, archive TEXT NOT NULL, member TEXT NOT NULL,
                        PRIMARY KEY (source, model, batch_id, case_id)
                    );
                    CREATE TABLE pending (id INTEGER PRIMARY KEY CHECK (id = 1), plan TEXT NOT NULL);
                """)
                count = 0
                with db:
                    for marker in sorted(self.state_dir.glob("*.ready.json")):
                        day = marker.name.removesuffix(".ready.json")
                        state = json.loads(marker.read_text())
                        if state.get("source") != "root_archives":
                            continue
                        if self.ready_state(day) is None:
                            raise ValueError(f"cannot index incomplete published day: {day}")
                        for model in state["rows"]:
                            file_path = self.output_dir / model / f"{day}.jsonl"
                            rows = 0
                            with file_path.open("rb") as stream:
                                for raw in stream:
                                    if not raw.strip():
                                        continue
                                    row = json.loads(raw)
                                    key = self.record_identity(row, model)
                                    archive, member = record_origin(row)
                                    db.execute("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)", (*key, day, archive, member))
                                    rows += 1
                            if rows != state["rows"][model] or self.ready_state(day) != state:
                                raise ValueError(f"published data changed while indexing {day}/{model}")
                            count += rows
                db.close()
                os.replace(temporary, path)
                print(f"indexed {count} published archive identities; existing JSONL files unchanged", flush=True)
            finally:
                db.close()
                temporary.unlink(missing_ok=True)
        db = sqlite3.connect(path)
        db.execute("CREATE TABLE IF NOT EXISTS cleaning_reports (name TEXT, size INTEGER, mtime_ns INTEGER, report TEXT NOT NULL, PRIMARY KEY (name, size, mtime_ns))")
        return db


    def publish_pending(self, db: sqlite3.Connection) -> None:
        saved = db.execute("SELECT plan FROM pending WHERE id = 1").fetchone()
        if saved is None:
            return
        plan = json.loads(saved[0])
        for day in plan["ready"]:
            self.ready_path(day).unlink(missing_ok=True)
        for artifact in plan["files"]:
            stage, target = Path(artifact["stage"]), Path(artifact["target"])
            file_path = stage if stage.exists() else target
            stat = file_path.stat()
            if (stat.st_size, stat.st_mtime_ns) != (artifact["size_bytes"], artifact["mtime_ns"]):
                raise ValueError(f"pending publication file changed: {file_path}")
            if file_path == stage:
                os.replace(stage, target)
        for day, state in plan["ready"].items():
            write_json_atomic(self.ready_path(day), state)
        write_json_atomic(self.root_archive_state_file, plan["root"])
        with db:
            db.execute("DELETE FROM pending WHERE id = 1")


    def read_archive_records(self, info: dict[str, object]) -> tuple[dict[RecordKey, IncomingRecord], CleaningReport]:
        path = self.archive_dir / str(info["name"])
        records: dict[RecordKey, IncomingRecord] = {}
        skipped = CleaningReport()
        temporary_root = Path(os.environ.get("TEMP_ROOT", tempfile.gettempdir()))
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="extract-", dir=temporary_root) as name:
            folder = Path(name)
            try:
                with SevenZipFile(path, mode="r") as archive:
                    grouped = members_by_model(archive, path, self.models, skipped)
                    archive.extract(path=folder, targets=[member for members in grouped.values() for member in members])
                missing = [member for members in grouped.values() for member in members
                           if not folder.joinpath(*PurePosixPath(member.replace("\\", "/")).parts).is_file()]
                for member in missing:
                    skipped.file_errors.append({"original_file": f"{path.name}/{member}", "reason": "member_missing"})
            except Exception as exc:
                raise ArchiveReadError(str(exc)) from exc
            self.check_clean_cancelled()
            for model, members in grouped.items():
                for member in reversed(members):
                    self.check_clean_cancelled()
                    source = folder.joinpath(*PurePosixPath(member.replace("\\", "/")).parts)
                    for number, raw in skipped.lines(source, path.name, member):
                        self.check_clean_cancelled()
                        if not raw.strip():
                            continue
                        skipped.read += 1
                        try:
                            value = json.loads(raw.decode("utf-8-sig"))
                        except (UnicodeDecodeError, ValueError):
                            skipped.exclude(model, "invalid_json", path.name, member, number)
                            continue
                        try:
                            issues = []
                            day, row = normalize_row(value, model, path.name, member, number,
                                                     testset_dates=self.kind in ("gpt", "post_training_model"), metadata_issues=issues)
                        except InvalidRecord as exc:
                            skipped.exclude(model, exc.reason, path.name, member, number, value=value)
                            continue
                        skipped.note_metadata(model, row, issues)
                        key = self.record_identity(row, model)
                        if key in records:
                            previous = records[key].row
                            reason = "duplicate_case" if comparable_row(previous) == comparable_row(row) else "identity_conflict"
                            skipped.exclude_row(model, reason, row)
                            continue
                        records[key] = ArchiveRecord(day, row, path.name, member)
        return records, skipped


    def prepare_archive_files(self, changes: dict[RecordKey, IncomingRecord]) -> tuple[dict, list[dict]]:
        affected = {(record.day, key[1]) for key, record in changes.items()}
        ready = {}
        artifacts = []
        temporary_paths = []
        try:
            for day in sorted({day for day, _ in affected}):
                self.check_clean_cancelled()
                state = self.ready_state(day)
                if state is None:
                    if self.ready_path(day).exists() or any((self.output_dir / model / f"{day}.jsonl").exists() for model in self.models):
                        raise ValueError(f"cannot merge incomplete published day: {day}")
                    initial_models = self.models if not self.kind else ()
                    state = {"source": "root_archives", "rows": dict.fromkeys(initial_models, 0), "files": {}}
                    affected.update((day, model) for model in initial_models)
                if state["source"] != "root_archives":
                    raise ValueError(f"cannot merge into local-import day: {day}")
                ready[day] = {"source": "root_archives", "rows": dict(cast(dict, state["rows"])), "files": dict(cast(dict, state["files"]))}
            for day, model in sorted(affected):
                self.check_clean_cancelled()
                target = self.output_dir / model / f"{day}.jsonl"
                target.parent.mkdir(parents=True, exist_ok=True)
                fd, name = tempfile.mkstemp(prefix=f".{day}.", suffix=".tmp", dir=target.parent)
                stage = Path(name)
                temporary_paths.append(stage)
                offsets = []
                with os.fdopen(fd, "wb") as output:
                    if target.exists():
                        before = target.stat()
                        with target.open("rb") as source:
                            for raw in source:
                                self.check_clean_cancelled()
                                if raw.strip():
                                    if self.record_identity(json.loads(raw), model) in changes:
                                        raise ValueError("published identity is missing from the archive index; refusing to overwrite")
                                    offsets.append([output.tell(), len(raw)])
                                    # A valid last JSON value without a newline must not join the next append.
                                    if not raw.endswith(b"\n"):
                                        raw += b"\n"
                                        offsets[-1][1] = len(raw)
                                    output.write(raw)
                        after = target.stat()
                        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                            raise ValueError(f"published file changed while merging: {target}")
                    for key, record in changes.items():
                        self.check_clean_cancelled()
                        if (record.day, key[1]) == (day, model):
                            raw = (json.dumps(record.row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                            offsets.append([output.tell(), len(raw)])
                            output.write(raw)
                    output.flush()
                    os.fsync(output.fileno())
                stat = stage.stat()
                metadata = {"size_bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns}
                artifacts.append({"stage": str(stage), "target": str(target), **metadata})
                ready[day]["rows"][model] = len(offsets)
                ready[day]["files"][model] = metadata
                index_target = self.record_index_path(day, model)
                index_target.parent.mkdir(parents=True, exist_ok=True)
                fd, name = tempfile.mkstemp(prefix=f".{day}.", suffix=".tmp", dir=index_target.parent)
                index_stage = Path(name)
                temporary_paths.append(index_stage)
                with os.fdopen(fd, "w") as output:
                    json.dump({**metadata, "offsets": offsets}, output, separators=(",", ":"))
                    output.flush()
                    os.fsync(output.fileno())
                stat = index_stage.stat()
                artifacts.append({"stage": str(index_stage), "target": str(index_target), "size_bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns})
            return ready, artifacts
        except BaseException:
            for path in temporary_paths:
                path.unlink(missing_ok=True)
            raise


    def process_archives(self, signature: list[dict[str, object]], *, retry_failed: bool = False) -> None:
        db = self.open_archive_index()
        try:
            self.publish_pending(db)
            pending = self.pending_archives(signature)
            if retry_failed:
                failed = {item["name"] for item in self.load_archive_state()["failed_archives"]}
                pending = [info for info in signature if info in pending or info["name"] in failed]
            for info in reversed(pending):
                self.check_clean_cancelled()
                archive_path = self.archive_dir / str(info["name"])
                if file_signature(archive_path) != info:
                    continue
                error = None
                try:
                    records, skipped = self.read_archive_records(info)
                except ArchiveReadError as exc:
                    records, skipped = {}, CleaningReport()
                    error = str(exc)
                if file_signature(archive_path) != info:
                    print(f"archive {archive_path.name} changed while reading; deferred", flush=True)
                    continue
                changes = {}
                local_days = {
                    marker.name.removesuffix(".ready.json") for marker in self.state_dir.glob("*.ready.json")
                    if json.loads(marker.read_text()).get("source") == "local_import"
                }
                existing_rows = {}
                for key, record in records.items():
                    self.check_clean_cancelled()
                    if record.day in local_days:
                        skipped.exclude_row(key[1], "local_import_overlap", record.row)
                        continue
                    old = db.execute("SELECT day, archive, member FROM records WHERE source = ? AND model = ? AND batch_id = ? AND case_id = ?", key).fetchone()
                    if old:
                        location = (old[0], key[1])
                        if location not in existing_rows:
                            before = self.ready_state(old[0])
                            if before is None:
                                raise ValueError("published input is not ready")
                            matches = {}
                            with (self.output_dir / key[1] / f"{old[0]}.jsonl").open() as stream:
                                for raw in stream:
                                    if not raw.strip():
                                        continue
                                    previous_row = json.loads(raw)
                                    previous_key = self.record_identity(previous_row, key[1])
                                    if previous_key in records:
                                        matches[previous_key] = comparable_row(previous_row) == comparable_row(records[previous_key].row)
                            if self.ready_state(old[0]) != before:
                                raise ValueError("published input changed while checking duplicates")
                            existing_rows[location] = matches
                        identical = existing_rows[location].get(key)
                        if identical is None:
                            raise ValueError("published business record missing from source")
                        reason = "duplicate_case" if identical else "identity_conflict"
                        skipped.exclude_row(key[1], reason, record.row)
                        continue
                    changes[key] = record
                ready, artifacts = self.prepare_archive_files(changes)
                durable = False
                try:
                    if file_signature(archive_path) != info:
                        print(f"archive {archive_path.name} changed before publication; deferred", flush=True)
                        continue
                    root = self.load_archive_state()
                    receipts = {item["name"]: item for item in root["archives"]}
                    receipts[info["name"]] = info
                    failures = {item["name"]: item for item in root["failed_archives"]}
                    failures.pop(info["name"], None)
                    if error is not None:
                        failures[info["name"]] = {"name": info["name"], "error": error}
                    root = {"archives": sorted(receipts.values(), key=lambda item: item["name"]),
                            "dates": sorted(set(root["dates"]) | set(ready)),
                            "failed_archives": sorted(failures.values(), key=lambda item: item["name"])}
                    plan = {"files": artifacts, "ready": ready, "root": root}
                    report = skipped.finish(changes, self.pairs, self.output_dir, ready, error)
                    self.check_clean_cancelled()
                    with db:
                        db.execute("INSERT OR REPLACE INTO cleaning_reports VALUES (?, ?, ?, ?)",
                                   (info["name"], info["size"], info["mtime_ns"], json.dumps(report, ensure_ascii=False)))
                        for key, record in changes.items():
                            db.execute("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)", (*key, record.day, record.archive, record.member))
                        db.execute("INSERT INTO pending VALUES (1, ?)", (json.dumps(plan, separators=(",", ":")),))
                        self.check_clean_cancelled()
                    durable = True
                    self.publish_pending(db)
                finally:
                    if not durable:
                        for artifact in artifacts:
                            Path(artifact["stage"]).unlink(missing_ok=True)
                skipped_summary = ", ".join(f"{model}/{reason}={count}" for (model, reason), count in sorted(skipped.items())) or "none"
                print(f"processed archive {archive_path}: {len(changes)} merged rows, {len(artifacts) // 2} output files; skipped: {skipped_summary}; error: {error or 'none'}", flush=True)
        finally:
            db.close()


    def register_local_import(self, day: str) -> None:
        date.fromisoformat(day)
        try:
            root_state = json.loads(self.root_archive_state_file.read_text())
        except (OSError, ValueError):
            root_state = None
        if isinstance(root_state, dict) and day in root_state.get("dates", []):
            raise ValueError(f"{day} has root archive data; use the normal processor")
        self.ready_path(day).unlink(missing_ok=True)
        rows = {}
        files = {}
        for model in self.models:
            file_path = self.output_dir / model / f"{day}.jsonl"
            before = file_path.stat()
            offsets = []
            count = 0
            with file_path.open("rb") as stream:
                offset = 0
                for line_number, line in enumerate(stream, 1):
                    if line.strip():
                        try:
                            value = json.loads(line.decode("utf-8-sig"))
                        except (ValueError, UnicodeDecodeError) as exc:
                            raise ValueError(f"{file_path.name}:{line_number}: invalid JSON") from exc
                        if not isinstance(value, dict):
                            raise ValueError(f"{file_path.name}:{line_number}: JSON record must be an object")
                        offsets.append([offset, len(line)])
                        count += 1
                    offset += len(line)
            after = file_path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise RuntimeError(f"{file_path.name} changed while indexing")
            files[model] = self.write_record_index(file_path, offsets, after)
            rows[model] = count
        state_tmp = self.ready_path(day).with_suffix(".tmp")
        state_tmp.write_text(json.dumps({"source": "local_import", "rows": rows, "files": files}, separators=(",", ":")))
        os.replace(state_tmp, self.ready_path(day))
        print(f"registered local import {day}: {sum(rows.values())} records", flush=True)




class DashboardServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], datasets: dict[str, Dataset], catalog=None):
        self.datasets = datasets
        self.catalog = catalog
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    def dataset_path(self) -> tuple[Dataset | None, str]:
        path = urlsplit(self.path).path
        datasets = cast(DashboardServer, self.server).datasets
        for prefix in sorted(datasets, key=len, reverse=True):
            if path == prefix:
                self.send_response(308)
                self.send_header("Location", prefix + "/")
                self.end_headers()
                return None, path
            if path.startswith(prefix + "/"):
                return datasets[prefix], path[len(prefix):]
        self.send_json(404, {"error": "not found"})
        return None, path

    def send_json(self, status: int, value: object) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def workbench_request(self) -> bool:
        parsed = urlsplit(self.path)
        if not parsed.path.startswith("/data/workbench/"):
            return False
        from workbench_catalog import Conflict
        catalog = cast(DashboardServer, self.server).catalog
        if catalog is None:
            self.send_json(503, {"error": "工作台索引不可用"})
            return True
        path = parsed.path.removeprefix("/data/workbench/")
        task_clean = re.fullmatch(r"tasks/([a-f0-9-]+)/clean(?:/(stop|cancel))?", path)
        try:
            if self.command == "GET" and path == "catalog":
                self.send_json(200, catalog.snapshot(parse_qs(parsed.query)))
            elif self.command == "GET" and path == "analytics":
                self.send_json(200, catalog.analytics(parse_qs(parsed.query)))
            elif self.command == "GET" and task_clean and task_clean[2] is None:
                self.send_json(200, catalog.clean_status(task_clean[1]))
            elif self.command == "GET" and re.fullmatch(r"batches/[a-f0-9-]+/(report|sample)", path):
                action = catalog.sample if path.endswith("/sample") else catalog.report
                self.send_json(200, action(path.split("/")[1], parse_qs(parsed.query)))
            elif self.command == "POST" and (path in ("tasks", "assign", "clean", "evaluation-scope") or task_clean):
                if not self.headers.get("Content-Type", "").startswith("application/json"):
                    self.send_json(415, {"error": "application/json required"})
                    return True
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536:
                    self.send_json(413 if length > 65536 else 400, {"error": "invalid request size"})
                    return True
                value = json.loads(self.rfile.read(length))
                if task_clean:
                    result = (catalog.start_task_clean(task_clean[1], value) if task_clean[2] is None else
                              catalog.stop_task_clean(task_clean[1], value, cancel=task_clean[2] == "cancel"))
                    self.send_json(202, result)
                else:
                    action = {"tasks": catalog.create_task, "assign": catalog.assign, "clean": catalog.start_clean, "evaluation-scope": catalog.evaluation_scope}[path]
                    self.send_json(202 if path == "clean" else 201 if path == "tasks" else 200, action(value))
            else:
                self.send_json(404, {"error": "not found"})
        except Conflict as exc:
            self.send_json(409, {"error": str(exc)})
        except KeyError as exc:
            self.send_json(404, {"error": str(exc)})
        except (ValueError, TypeError, UnicodeDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            print(f"workbench API error: {exc}", file=sys.stderr, flush=True)
            self.send_json(500, {"error": str(exc)})
        return True

    def do_GET(self) -> None:
        if self.workbench_request():
            return
        dataset, path = self.dataset_path()
        if dataset is None:
            return
        if path == "/health":
            self.send_json(200, {"ok": True})
            return
        if path == "/dashboard-data":
            self.send_json(200, dataset.dashboard_data())
            return
        if path == "/processing-status":
            self.send_json(200, dataset.processing_status())
            return
        if path == "/dates":
            self.send_json(200, {"dates": dataset.available_dates()})
            return

        records_match = re.fullmatch(r"/records/(\d{4}-\d{2}-\d{2})/([a-z0-9_.-]+)", path)
        if records_match:
            day, model = records_match.groups()
            try:
                date.fromisoformat(day)
            except ValueError:
                self.send_json(404, {"error": "not found"})
                return
            if model not in dataset.models:
                self.send_json(404, {"error": "not found"})
                return
            state = dataset.ready_state(day)
            if state is None or model not in cast(dict, state["rows"]):
                self.send_json(404, {"error": "data not ready"})
                return
            query = parse_qs(urlsplit(self.path).query)
            try:
                page = int(query.get("page", ["1"])[0])
                page_size = int(query.get("page_size", ["20"])[0])
            except ValueError:
                self.send_json(400, {"error": "invalid page"})
                return
            if page < 1 or not 1 <= page_size <= 50:
                self.send_json(400, {"error": "page must be positive and page_size between 1 and 50"})
                return
            index_path = dataset.record_index_path(day, model)
            try:
                index = json.loads(index_path.read_text())
                offsets = index["offsets"]
                metadata = cast(dict[str, dict[str, int]], state["files"])[model]
                total = cast(dict[str, int], state["rows"])[model]
                if (index.get("size_bytes"), index.get("mtime_ns")) != (metadata["size_bytes"], metadata["mtime_ns"]):
                    raise ValueError("stale index")
                if not isinstance(offsets, list) or len(offsets) != total:
                    raise ValueError("invalid index")
                start = (page - 1) * page_size
                items = []
                file_path = dataset.output_dir / model / f"{day}.jsonl"
                with file_path.open("rb") as stream:
                    for entry in offsets[start:start + page_size]:
                        if (not isinstance(entry, list) or len(entry) != 2 or
                                any(type(value) is not int for value in entry) or entry[0] < 0 or entry[1] < 1):
                            raise ValueError("invalid index entry")
                        stream.seek(entry[0])
                        row = json.loads(stream.read(entry[1]).decode("utf-8-sig"))
                        if not isinstance(row, dict):
                            raise ValueError("invalid record")
                        items.append(visible_record(row))
            except (OSError, ValueError, KeyError, TypeError, IndexError):
                self.send_json(503, {"error": "record index unavailable"})
                return
            self.send_json(200, {"date": day, "model": model, "page": page, "page_size": page_size, "total": total, "items": items})
            return

        match = re.fullmatch(r"/data/(\d{4}-\d{2}-\d{2})/([a-z0-9_.-]+)\.jsonl", path)
        if not match:
            self.send_json(404, {"error": "not found"})
            return
        day, model = match.groups()
        try:
            date.fromisoformat(day)
        except ValueError:
            self.send_json(404, {"error": "not found"})
            return
        state = dataset.ready_state(day)
        if model not in dataset.models or state is None or model not in cast(dict, state["rows"]):
            self.send_json(404, {"error": "data not ready"})
            return

        file_path = dataset.output_dir / model / f"{day}.jsonl"
        try:
            size = file_path.stat().st_size
            stream = file_path.open("rb")
        except OSError:
            self.send_json(404, {"error": "data not ready"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f'attachment; filename="{day}.jsonl"')
        self.end_headers()
        try:
            with stream:
                while chunk := stream.read(1024 * 1024):
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self) -> None:
        if self.workbench_request():
            return
        dataset, path = self.dataset_path()
        if dataset is None:
            return
        if path != "/evaluation-progress":
            self.send_json(404, {"error": "not found"})
            return
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            self.send_json(415, {"error": "application/json required"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        max_length = 1024 * 1024
        if length < 1 or length > max_length:
            self.send_json(413 if length > max_length else 400, {"error": "invalid request size"})
            return
        try:
            value = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            self.send_json(400, {"error": "invalid JSON"})
            return
        required = {"run_id", "engine", "status", "started_at", "updated_at", "dates"}
        if not isinstance(value, dict) or set(value) != required:
            self.send_json(400, {"error": "invalid progress fields"})
            return
        if not isinstance(value["run_id"], str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", value["run_id"]):
            self.send_json(400, {"error": "invalid run_id"})
            return
        if value["engine"] != "pi" or value["status"] not in ("running", "finished", "interrupted"):
            self.send_json(400, {"error": "invalid engine or status"})
            return
        if not isinstance(value["dates"], list):
            self.send_json(400, {"error": "dates must be a list"})
            return
        seen_dates = set()
        for entry in value["dates"]:
            scope = "models" if dataset.independent else "pairs"
            if not isinstance(entry, dict) or set(entry) != {"date", scope}:
                self.send_json(400, {"error": "invalid date progress"})
                return
            day = entry["date"]
            try:
                valid_day = isinstance(day, str) and date.fromisoformat(day).isoformat() == day
            except ValueError:
                valid_day = False
            pairs = entry[scope]
            if dataset.independent:
                valid = (isinstance(pairs, dict) and set(pairs) <= set(dataset.models) and
                         all(isinstance(stages, dict) and set(stages) == set(STAGES) and
                             all(isinstance(count, dict) and set(count) == TASK_COUNTS and
                                 all(type(n) is int and n >= 0 for n in count.values()) and
                                 sum(n for key, n in count.items() if key != "total") == count["total"]
                                 for count in stages.values()) for stages in pairs.values()))
                if not valid_day or day in seen_dates or not valid:
                    self.send_json(400, {"error": "invalid date or independent stage counts"})
                    return
                seen_dates.add(day)
                continue
            valid_pairs = (isinstance(pairs, dict) and
                           (set(pairs) == set(dataset.pairs) if not dataset.kind else set(pairs) <= set(dataset.pairs)))
            if not valid_day or day in seen_dates or not valid_pairs:
                self.send_json(400, {"error": "invalid date or comparison pairs"})
                return
            seen_dates.add(day)
            for counts in pairs.values():
                fields = {"total_cases", "completed_cases", "running_cases", "queued_cases", "failed_cases", "skipped_cases"}
                if not isinstance(counts, dict) or set(counts) != fields:
                    self.send_json(400, {"error": "invalid pair counts"})
                    return
                if any(type(counts[key]) is not int or counts[key] < 0 for key in fields):
                    self.send_json(400, {"error": "case counts must be non-negative integers"})
                    return
                if sum(counts[key] for key in fields - {"total_cases"}) > counts["total_cases"]:
                    self.send_json(400, {"error": "case counts exceed total_cases"})
                    return
        time_fields = ("started_at", "updated_at")
        if any(type(value[key]) is not int or value[key] < 0 for key in time_fields):
            self.send_json(400, {"error": "timestamps must be non-negative integers"})
            return

        progress = {**value, "received_at": int(time.time() * 1000)}
        with dataset.progress_lock:
            try:
                current = json.loads(dataset.progress_file.read_text())
            except (OSError, ValueError):
                current = None
            if isinstance(current, dict):
                old_run = current.get("run_id") != progress["run_id"]
                older_run = old_run and progress["started_at"] < current.get("started_at", 0)
                older_update = not old_run and progress["updated_at"] < current.get("updated_at", 0)
                if older_run or older_update:
                    self.send_json(409, {"error": "stale progress update"})
                    return
            progress_tmp = dataset.progress_file.with_suffix(".tmp")
            progress_tmp.write_text(json.dumps(progress, separators=(",", ":")))
            os.replace(progress_tmp, dataset.progress_file)
        self.send_json(200, {"saved": True})

    def log_message(self, format: str, *args) -> None:
        return


def make_datasets(root: Path, state_root: Path) -> dict[str, Dataset]:
    wencai = root / "0_wencai"
    datasets = {
        "/data/wencai": Dataset(wencai, state_root / "wencai", ROOT_MODELS,
                                archive_dir=wencai / "1_7z_data/A_AA_comparision_data", output_dir=wencai / "2_daily_eval_input", url_prefix="/data/wencai"),
        "/data/post_training_model": Dataset(wencai, state_root / "post_training_model", POST_TRAINING_MODELS,
                                "post_training_model", url_prefix="/data/post_training_model",
                                archive_dir=wencai / "1_7z_data/post_train_model",
                                output_dir=wencai / "5_multi_task_eval_input/post_train_model_eval"),
    }
    from multi_agent_inputs import AgentDataset, SOURCES
    datasets.update({"/data/" + provider: AgentDataset(root, state_root, provider, "/data/" + provider) for provider in SOURCES})
    datasets["/data/aime"].archive_dir = root / "1_aime/1_7z_data/online_data"
    return datasets


def main() -> None:
    if "DATA_ROOT" not in os.environ or "STATE_ROOT" not in os.environ:
        raise SystemExit("DATA_ROOT and STATE_ROOT are required")
    root, state_root = Path(os.environ["DATA_ROOT"]), Path(os.environ["STATE_ROOT"])
    host, port = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8081"))
    datasets = make_datasets(root, state_root)
    if len(sys.argv) == 3 and sys.argv[1] == "--process-archives":
        dataset = datasets.get("/data/" + sys.argv[2])
        if dataset is None:
            raise SystemExit(f"unknown dataset: {sys.argv[2]}")
        dataset.state_dir.mkdir(parents=True, exist_ok=True)
        with dataset.archive_lock():
            signature = archive_signature(dataset.archive_dir)
            unstable = [item["name"] for item in dataset.pending_archives(signature)
                        if time.time_ns() - int(item["mtime_ns"]) < STABLE_SECONDS * 1_000_000_000]
            if unstable:
                raise SystemExit(f"archives are still changing: {', '.join(unstable)}")
            dataset.process_archives(signature)
            state = dataset.load_archive_state()
            if state["failed_archives"] or dataset.pending_archives(archive_signature(dataset.archive_dir)):
                raise SystemExit("archive processing incomplete; inspect processing status")
        print(json.dumps(dataset.dashboard_data(), ensure_ascii=False), flush=True)
        return
    if sys.argv[1:] == ["--organize-archives"]:
        for dataset in datasets.values():
            dataset.state_dir.mkdir(parents=True, exist_ok=True)
            dataset.organize_archives()
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--register-local-import":
        datasets["/data/wencai"].state_dir.mkdir(parents=True, exist_ok=True)
        datasets["/data/wencai"].register_local_import(sys.argv[2])
        return
    if len(sys.argv) != 1:
        raise SystemExit("usage: app.py [--register-local-import YYYY-MM-DD | --organize-archives | --process-archives DATASET]")
    from workbench_catalog import WorkbenchCatalog
    catalog = WorkbenchCatalog(datasets, state_root, sys.modules[__name__])
    server = DashboardServer((host, port), datasets, catalog)
    for dataset in datasets.values():
        dataset.archive_dir.mkdir(parents=True, exist_ok=True)
        dataset.state_dir.mkdir(parents=True, exist_ok=True)
        for model in dataset.models:
            (dataset.output_dir / model).mkdir(parents=True, exist_ok=True)
        with dataset.archive_lock():
            dataset.recover()
    threading.Thread(target=catalog.loop, name="workbench-discovery", daemon=True).start()
    print(f"serving on {host}:{port}; data root: {root}", flush=True)
    def stop(_signal: int, _frame: object) -> None:
        catalog.stop.set()
        threading.Thread(target=server.shutdown, name="dashboard-shutdown", daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever()
    server.server_close()


if __name__ == "__main__":
    # Source adapters import the same engine when this file is the script entry point.
    sys.modules["app"] = sys.modules[__name__]
    main()
