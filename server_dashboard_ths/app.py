#!/usr/bin/env python3
"""Process root-level 7z archives by request date and stream ready JSONL over HTTP."""

from __future__ import annotations

import json
import math
import os
import re
import sys
import tempfile
import threading
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import cast
from urllib.parse import parse_qs, urlsplit

CODE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(CODE_DIR / ".packages"))

from py7zr import SevenZipFile  # noqa: E402

ROOT = Path(os.environ.get("DATA_ROOT", "/mnt/fin_bench/A_AA_comparision_data"))
ARCHIVE_DIR = ROOT
OUTPUT_DIR = ROOT / "2_eval_data_input"
STATE_DIR = CODE_DIR / "state"
PROGRESS_FILE = STATE_DIR / "evaluation-progress.json"
ROOT_ARCHIVE_STATE_FILE = STATE_DIR / "root-archives.json"
PROGRESS_LOCK = threading.Lock()
PORT = int(os.environ.get("PORT", "8081"))
POLL_SECONDS = 5
STABLE_SECONDS = 30
SHANGHAI = timezone(timedelta(hours=8))
TOP_LEVEL_FIELD_ORDER = ("request_time", "has_standard_answer", "versions")
MODELS = ("a_fast", "b_fast", "a_expert", "b_expert")
VERSION_NAMES = {
    "a_fast": "A Fast",
    "b_fast": "B Fast",
    "a_expert": "A Expert",
    "b_expert": "B Expert",
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


def ready_path(day: str) -> Path:
    return STATE_DIR / f"{day}.ready.json"


def record_index_path(day: str, model: str) -> Path:
    return STATE_DIR / "records" / model / f"{day}.json"


def write_record_index(file_path: Path, offsets: list[list[int]], metadata: os.stat_result | None = None) -> dict[str, int]:
    stat = metadata or file_path.stat()
    index_path = record_index_path(file_path.stem, file_path.parent.name)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = index_path.with_suffix(".tmp")
    temp_path.write_text(json.dumps({"size_bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns, "offsets": offsets}, separators=(",", ":")))
    os.replace(temp_path, index_path)
    return {"size_bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def valid_iso_day(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def known_days() -> list[str]:
    days = set()
    for path in STATE_DIR.glob("*.ready.json"):
        day = path.name.removesuffix(".ready.json")
        if valid_iso_day(day):
            days.add(day)
    for model in MODELS:
        for path in (OUTPUT_DIR / model).glob("*.jsonl"):
            if valid_iso_day(path.stem):
                days.add(path.stem)
    progress = evaluation_progress()
    progress_dates = progress.get("dates") if isinstance(progress, dict) else None
    if isinstance(progress_dates, list):
        for entry in progress_dates:
            day = entry.get("date") if isinstance(entry, dict) else None
            if valid_iso_day(day):
                days.add(day)
    return sorted(days)


def ready_state(day: str) -> dict[str, object] | None:
    try:
        state = json.loads(ready_path(day).read_text())
        if not isinstance(state, dict):
            return None
        if state.get("source") not in ("root_archives", "local_import"):
            return None
        rows = state.get("rows")
        files = state.get("files")
        if not isinstance(rows, dict) or any(type(rows.get(model)) is not int or rows[model] < 0 for model in MODELS):
            return None
        if not isinstance(files, dict):
            return None
        for model in MODELS:
            file_path = OUTPUT_DIR / model / f"{day}.jsonl"
            metadata = files.get(model)
            if not file_path.is_file() or not isinstance(metadata, dict):
                return None
            stat = file_path.stat()
            if metadata.get("size_bytes") != stat.st_size or metadata.get("mtime_ns") != stat.st_mtime_ns:
                return None
            if not record_index_path(day, model).is_file():
                return None
        return state
    except (OSError, ValueError):
        return None


def is_ready(day: str) -> bool:
    return ready_state(day) is not None


def evaluation_progress() -> dict[str, object] | None:
    with PROGRESS_LOCK:
        try:
            progress = json.loads(PROGRESS_FILE.read_text())
        except (OSError, ValueError):
            return None
    if not isinstance(progress, dict):
        return None
    progress["stale"] = progress["status"] == "running" and time.time() * 1000 - progress["updated_at"] > 60_000
    return progress


def available_dates() -> list[dict[str, object]]:
    return [{"date": day, "models": list(MODELS)} for day in known_days() if is_ready(day)]


def dashboard_data() -> dict[str, object]:
    dates = []
    for day in reversed(known_days()):
        state = ready_state(day)
        ready = state is not None
        rows = cast(dict[str, int], state["rows"]) if state else {}
        models = {model: {"ready": ready, "row_count": rows.get(model, 0)} for model in MODELS}
        dates.append({"date": day, "ready": ready, "models": models})
    return {"dates": dates, "evaluation": evaluation_progress()}


def model_for_member(member: str) -> str | None:
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

    ask_time = meta.get("ask_time")
    if isinstance(ask_time, bool) or not isinstance(ask_time, (int, float)) or not math.isfinite(ask_time) or ask_time <= 0:
        raise InvalidRecord("request_time_missing")
    try:
        local = datetime.fromtimestamp(ask_time / 1000, SHANGHAI)
    except (OverflowError, OSError, ValueError) as exc:
        raise InvalidRecord("ask_time_invalid") from exc
    return local.date().isoformat(), local.strftime("%Y-%m-%d %H:%M:%S")


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


def normalize_row(value: object, model: str, archive_name: str, member: str, line_number: int) -> tuple[str, dict[str, object]]:
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
        if row.get("request_time") is None and meta.get("request_time") is None and meta.get("ask_time") is None:
            meta["request_time"] = trace_meta.get("timestamp")
        row = {key: item for key, item in row.items() if key != "traces"}
        row.update({
            "meta": meta,
            "messages": trace.get("messages"),
            "trace_id": trace_meta.get("trace_id") or row.get("trace_id") or meta.get("trace_id"),
        })

    batch_id = row.get("batch_id") or meta.get("batch_id")
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
    fallback_type = "message" if model.startswith("a_") else None
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
    header = top_level_fields(request_time, has_standard_answer, day, model)
    normalized = {**header, **{key: item for key, item in row.items() if key not in header}}
    normalized["batch_id"] = batch_id or day
    normalized["case_id"] = case_id.strip()
    normalized["version"] = VERSION_NAMES[model]
    normalized["trace_id"] = row.get("trace_id") or meta.get("trace_id")
    if not normalized.get("_source"):
        normalized["_source"] = {
            "original_file": f"{archive_name}/{PurePosixPath(member).name}",
            "original_line": line_number,
        }
    return day, normalized


def members_by_model(archive: SevenZipFile, archive_path: Path) -> dict[str, list[str]]:
    grouped = {model: [] for model in MODELS}
    for member in archive.getnames():
        if not member.lower().endswith(".jsonl"):
            continue
        safe_member = PurePosixPath(member.replace("\\", "/"))
        if safe_member.is_absolute() or ".." in safe_member.parts:
            raise ValueError(f"unsafe archive path: {member}")
        model = model_for_member(member)
        if model is None:
            raise ValueError(f"unrecognized model JSONL in {archive_path.name}: {member}")
        grouped[model].append(member)
    if not any(grouped.values()):
        raise ValueError(f"{archive_path.name} has no recognized model JSONL files")
    for members in grouped.values():
        members.sort(key=lambda member: (member_increment(member), PurePosixPath(member).name.casefold()))
    return grouped


def process_archives(signature: list[dict[str, object]]) -> None:
    stage_paths: dict[tuple[str, str], Path] = {}
    stage_streams = {}
    row_counts: dict[str, dict[str, int]] = {}
    row_offsets: dict[tuple[str, str], list[list[int]]] = {}
    skipped = Counter()
    deduplicated = Counter()
    seen_source_cases = set()
    failed_archives = []
    days = set()
    local_import_days = set()
    for state_path in STATE_DIR.glob("*.ready.json"):
        try:
            previous_state = json.loads(state_path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(previous_state, dict) and previous_state.get("source") == "local_import":
            local_import_days.add(state_path.name.removesuffix(".ready.json"))

    def stage(day: str, model: str):
        key = (day, model)
        if key not in stage_streams:
            output_folder = OUTPUT_DIR / model
            output_folder.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(prefix=f".{day}.", suffix=".tmp", dir=output_folder)
            stage_paths[key] = Path(name)
            stage_streams[key] = os.fdopen(fd, "wb")
            row_offsets[key] = []
            row_counts.setdefault(day, {item: 0 for item in MODELS})
        return stage_streams[key]

    try:
        for archive_info in reversed(signature):
            archive_path = ARCHIVE_DIR / str(archive_info["name"])
            source_id = archive_source_id(archive_path.name)
            with tempfile.TemporaryDirectory(prefix="extract-", dir=CODE_DIR) as temp_name:
                temp_dir = Path(temp_name)
                try:
                    with SevenZipFile(archive_path, mode="r") as archive:
                        grouped = members_by_model(archive, archive_path)
                        archive.extract(path=temp_dir, targets=[name for names in grouped.values() for name in names])
                    sources = {
                        (model, member): temp_dir.joinpath(*PurePosixPath(member.replace("\\", "/")).parts)
                        for model, members in grouped.items() for member in members
                    }
                    missing = [member for (_, member), source in sources.items() if not source.is_file()]
                    if missing:
                        raise ValueError(f"extracted members not found: {', '.join(missing)}")
                except Exception as exc:
                    failed_archives.append({"name": archive_path.name, "error": str(exc)})
                    print(f"archive {archive_path.name} skipped: {exc}", flush=True)
                    continue

                for model, members in grouped.items():
                    for member in reversed(members):
                        source = sources[(model, member)]
                        with source.open("rb") as stream:
                            for line_number, raw_line in enumerate(stream, 1):
                                if not raw_line.strip():
                                    continue
                                try:
                                    line = raw_line.decode("utf-8-sig")
                                    value = json.loads(line)
                                except (UnicodeDecodeError, ValueError):
                                    skipped[(model, "invalid_json")] += 1
                                    continue
                                try:
                                    day, row = normalize_row(value, model, archive_path.name, member, line_number)
                                except InvalidRecord as exc:
                                    skipped[(model, exc.reason)] += 1
                                    continue
                                if day in local_import_days:
                                    skipped[(model, "local_import_overlap")] += 1
                                    continue
                                source_case = (source_id, model, row["batch_id"], row["case_id"])
                                if source_case in seen_source_cases:
                                    deduplicated[model] += 1
                                    continue
                                seen_source_cases.add(source_case)
                                output = stage(day, model)
                                payload = (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                                row_offsets[(day, model)].append([output.tell(), len(payload)])
                                output.write(payload)
                                row_counts[day][model] += 1
                                days.add(day)

        for day in days:
            for model in MODELS:
                stage(day, model)
        for stream in stage_streams.values():
            stream.flush()
            os.fsync(stream.fileno())
            stream.close()
        stage_streams.clear()

        if archive_signature(ARCHIVE_DIR) != signature:
            raise RuntimeError("root .7z set changed while processing; discard snapshot")
        for day in days:
            try:
                previous_state = json.loads(ready_path(day).read_text())
            except (OSError, ValueError):
                previous_state = None
            if isinstance(previous_state, dict) and previous_state.get("source") == "local_import":
                raise ValueError(f"cannot merge root archive records into {day}: local_import data has no archive source")

        for day in days:
            ready_path(day).unlink(missing_ok=True)
            files = {}
            for model in MODELS:
                key = (day, model)
                output_path = OUTPUT_DIR / model / f"{day}.jsonl"
                os.replace(stage_paths[key], output_path)
                files[model] = write_record_index(output_path, row_offsets[key])
            state_tmp = ready_path(day).with_suffix(".tmp")
            state_tmp.write_text(json.dumps({
                "source": "root_archives", "archives": signature,
                "rows": row_counts[day], "files": files,
            }, separators=(",", ":")))
            os.replace(state_tmp, ready_path(day))

        state_tmp = ROOT_ARCHIVE_STATE_FILE.with_suffix(".tmp")
        state_tmp.write_text(json.dumps({
            "archives": signature, "dates": sorted(days), "failed_archives": failed_archives,
        }, separators=(",", ":")))
        os.replace(state_tmp, ROOT_ARCHIVE_STATE_FILE)
        skipped_summary = ", ".join(f"{model}/{reason}={count}" for (model, reason), count in sorted(skipped.items())) or "none"
        deduplicated_summary = ", ".join(f"{model}={count}" for model, count in sorted(deduplicated.items())) or "none"
        print(f"processed {len(signature)} root archive(s), {sum(sum(counts.values()) for counts in row_counts.values())} valid rows; deduplicated rows: {deduplicated_summary}; skipped rows: {skipped_summary}; incomplete archives: {len(failed_archives)}", flush=True)
    finally:
        for stream in stage_streams.values():
            stream.close()
        for path in stage_paths.values():
            path.unlink(missing_ok=True)


def register_local_import(day: str) -> None:
    date.fromisoformat(day)
    try:
        root_state = json.loads(ROOT_ARCHIVE_STATE_FILE.read_text())
    except (OSError, ValueError):
        root_state = None
    if isinstance(root_state, dict) and day in root_state.get("dates", []):
        raise ValueError(f"{day} has root archive data; use the normal processor")
    ready_path(day).unlink(missing_ok=True)
    rows = {}
    files = {}
    for model in MODELS:
        file_path = OUTPUT_DIR / model / f"{day}.jsonl"
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
        files[model] = write_record_index(file_path, offsets, after)
        rows[model] = count
    state_tmp = ready_path(day).with_suffix(".tmp")
    state_tmp.write_text(json.dumps({"source": "local_import", "rows": rows, "files": files}, separators=(",", ":")))
    os.replace(state_tmp, ready_path(day))
    print(f"registered local import {day}: {sum(rows.values())} records", flush=True)


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
    record: dict[str, object] = {"question": question, "answer": answer}
    if row.get("has_standard_answer") is not False and isinstance(meta, dict):
        reference = next((meta.get(key) for key in ("ground_truth", "std_answer") if meta.get(key) not in (None, "")), None)
        if reference is None:
            reference = next((row.get(key) for key in ("ground_truth", "std_answer") if row.get(key) not in (None, "")), None)
        if reference is not None:
            record["standard_answer"] = reference
    return record


def root_archive_import_is_current(signature: list[dict[str, object]]) -> bool:
    try:
        state = json.loads(ROOT_ARCHIVE_STATE_FILE.read_text())
    except (OSError, ValueError):
        return False
    if not isinstance(state, dict) or state.get("archives") != signature or not isinstance(state.get("dates"), list):
        return False
    if not isinstance(state.get("failed_archives"), list) or state["failed_archives"]:
        return False
    return all(
        isinstance(day, str)
        and (day_state := ready_state(day)) is not None
        and day_state.get("source") == "root_archives"
        for day in state["dates"]
    )


def processing_loop() -> None:
    stable_signature = None
    stable_since = 0.0
    failed_signature = None
    while True:
        try:
            signature = archive_signature(ARCHIVE_DIR)
            if signature != stable_signature:
                stable_signature = signature
                stable_since = time.monotonic()
                failed_signature = None
            if not signature or time.monotonic() - stable_since < STABLE_SECONDS:
                time.sleep(POLL_SECONDS)
                continue
            if root_archive_import_is_current(signature) or failed_signature == signature:
                time.sleep(POLL_SECONDS)
                continue
            try:
                process_archives(signature)
                failed_signature = None if root_archive_import_is_current(signature) else signature
            except Exception as exc:
                failed_signature = signature
                print(f"processing root archives failed: {exc}", flush=True)
        except Exception as exc:
            print(f"scanner error: {exc}", flush=True)
        time.sleep(POLL_SECONDS)


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status: int, value: object) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, file_path: Path, content_type: str) -> None:
        try:
            body = file_path.read_bytes()
        except OSError:
            self.send_json(404, {"error": "not found"})
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        static_files = {
            "/": ("dashboard.html", "text/html; charset=utf-8"),
            "/dashboard.css": ("dashboard.css", "text/css; charset=utf-8"),
            "/dashboard.js": ("dashboard.js", "application/javascript; charset=utf-8"),
            "/records": ("records.html", "text/html; charset=utf-8"),
            "/records/": ("records.html", "text/html; charset=utf-8"),
            "/records.js": ("records.js", "application/javascript; charset=utf-8"),
            "/docs": ("docs.html", "text/html; charset=utf-8"),
            "/docs/": ("docs.html", "text/html; charset=utf-8"),
            "/docs/handoff.md": ("docs/handoff.md", "text/markdown; charset=utf-8"),
        }
        if path in static_files:
            filename, content_type = static_files[path]
            self.send_static(CODE_DIR / filename, content_type)
            return
        if path == "/health":
            self.send_json(200, {"ok": True})
            return
        if path == "/dashboard-data":
            self.send_json(200, dashboard_data())
            return
        if path == "/dates":
            self.send_json(200, {"dates": available_dates()})
            return

        records_match = re.fullmatch(r"/records/(\d{4}-\d{2}-\d{2})/([a-z_]+)", path)
        if records_match:
            day, model = records_match.groups()
            try:
                date.fromisoformat(day)
            except ValueError:
                self.send_json(404, {"error": "not found"})
                return
            if model not in MODELS:
                self.send_json(404, {"error": "not found"})
                return
            state = ready_state(day)
            if state is None:
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
            index_path = record_index_path(day, model)
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
                file_path = OUTPUT_DIR / model / f"{day}.jsonl"
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

        match = re.fullmatch(r"/data/(\d{4}-\d{2}-\d{2})/([a-z_]+)\.jsonl", path)
        if not match:
            self.send_json(404, {"error": "not found"})
            return
        day, model = match.groups()
        try:
            date.fromisoformat(day)
        except ValueError:
            self.send_json(404, {"error": "not found"})
            return
        if model not in MODELS or not is_ready(day):
            self.send_json(404, {"error": "data not ready"})
            return

        file_path = OUTPUT_DIR / model / f"{day}.jsonl"
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
        if urlsplit(self.path).path != "/evaluation-progress":
            self.send_json(404, {"error": "not found"})
            return
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            self.send_json(415, {"error": "application/json required"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length < 1 or length > 8192:
            self.send_json(413 if length > 8192 else 400, {"error": "invalid request size"})
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
        if value["engine"] not in ("pi", "prime") or value["status"] not in ("running", "finished", "interrupted"):
            self.send_json(400, {"error": "invalid engine or status"})
            return
        if not isinstance(value["dates"], list):
            self.send_json(400, {"error": "dates must be a list"})
            return
        seen_dates = set()
        for entry in value["dates"]:
            if not isinstance(entry, dict) or set(entry) != {"date", "pairs"}:
                self.send_json(400, {"error": "invalid date progress"})
                return
            day = entry["date"]
            try:
                valid_day = isinstance(day, str) and date.fromisoformat(day).isoformat() == day
            except ValueError:
                valid_day = False
            pairs = entry["pairs"]
            if not valid_day or day in seen_dates or not isinstance(pairs, dict) or set(pairs) != {"fast", "expert"}:
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
        with PROGRESS_LOCK:
            try:
                current = json.loads(PROGRESS_FILE.read_text())
            except (OSError, ValueError):
                current = None
            if isinstance(current, dict):
                old_run = current.get("run_id") != progress["run_id"]
                older_run = old_run and progress["started_at"] < current.get("started_at", 0)
                older_update = not old_run and progress["updated_at"] < current.get("updated_at", 0)
                if older_run or older_update:
                    self.send_json(409, {"error": "stale progress update"})
                    return
            progress_tmp = PROGRESS_FILE.with_suffix(".tmp")
            progress_tmp.write_text(json.dumps(progress, separators=(",", ":")))
            os.replace(progress_tmp, PROGRESS_FILE)
        self.send_json(200, {"saved": True})

    def log_message(self, format: str, *args) -> None:
        print(f"http {self.address_string()} {format % args}", flush=True)


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--register-local-import":
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        register_local_import(sys.argv[2])
        return
    if len(sys.argv) != 1:
        raise SystemExit("usage: app.py [--register-local-import YYYY-MM-DD]")
    for model in MODELS:
        (OUTPUT_DIR / model).mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    threading.Thread(target=processing_loop, name="archive-processor", daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"serving on 0.0.0.0:{PORT}; data root: {ROOT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
