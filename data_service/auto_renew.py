"""Daily input adapter and read-only cleaner observation for auto_renew.sh.

Business cleaning belongs to the external pipeline. Only ingestion calls the
existing data-service publisher; snapshot/publish never invoke a cleaner.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import signal
import sys
from datetime import datetime
from pathlib import Path

STOP_REQUESTED = False


def request_stop(_signal, _frame):
    global STOP_REQUESTED
    STOP_REQUESTED = True


def signature(file):
    info = file.stat()
    if not file.is_file() or file.is_symlink():
        raise ValueError(f"not a regular file: {file}")
    return {"size": info.st_size, "mtime_ns": str(info.st_mtime_ns),
            "ctime_ns": str(info.st_ctime_ns), "ino": str(info.st_ino), "dev": str(info.st_dev)}


@contextlib.contextmanager
def read_lock(file):
    # Never create or rewrite an external cleaner's lock or status file.
    with file.open("rb") as stream:
        fcntl.flock(stream, fcntl.LOCK_SH | fcntl.LOCK_NB)
        yield


def complete(entry):
    counts = [entry.get(key) for key in ("line", "read_line", "processed_lines", "total_lines")]
    zeros = [entry.get(key) for key in ("inflight_records", "ready_to_commit", "blocked_records",
                                      "translation_backlog_records", "annotation_backlog_records")]
    return (entry.get("status") == "completed" and
            all(type(value) is int and value >= 0 for value in counts) and len(set(counts)) == 1 and
            all(type(value) is int and value == 0 for value in zeros) and
            entry.get("schema_repair_pending", 0) == 0)


def snapshot_unlocked(request):
    model, name = request["model"], request["name"]
    if Path(model).name != model or not re.fullmatch(r"\d{4}-\d{2}-\d{2}\.jsonl", name):
        raise ValueError("invalid model or daily file name")
    clean = Path(request["cleanDirectory"]) / model
    status_file = clean / "status.json"
    status_before = signature(status_file)
    entry = json.loads(status_file.read_text())["files"].get(name, {})
    if not complete(entry):
        return {"ready": False, "reason": "cleaning_incomplete", "status": entry.get("status", "missing")}
    raw = Path(request["inputDirectory"]) / model / name
    raw_info = signature(raw)
    ready_file = Path(request["dataState"]) / (name[:-6] + ".ready.json")
    ready = json.loads(ready_file.read_text())
    metadata = ready.get("files", {}).get(model, {})
    if (ready.get("rows", {}).get(model) != entry["total_lines"] or
            metadata.get("size_bytes") != raw_info["size"] or
            str(metadata.get("mtime_ns")) != raw_info["mtime_ns"]):
        return {"ready": False, "reason": "input_not_fully_cleaned"}
    # The cleaner timestamps to whole seconds. A newer replacement with the same
    # row count must not inherit a previous file's completed status.
    updated = datetime.fromisoformat(entry["updated_at"])
    if updated.tzinfo is None:
        raise ValueError("cleaner updated_at must include timezone")
    if int(raw_info["mtime_ns"]) >= int((updated.timestamp() + 1) * 1_000_000_000):
        return {"ready": False, "reason": "input_newer_than_cleaning"}
    cleaned = signature(clean / name)
    if signature(status_file) != status_before:
        return {"ready": False, "reason": "status_changed"}
    return {"ready": True, "raw": raw_info, "clean": cleaned, "entry": entry}


def observe(request, publish=False):
    clean = Path(request["cleanDirectory"]) / request["model"]
    try:
        with read_lock(Path(request["dataState"]) / "archive.lock"), read_lock(clean / ".status.lock"):
            current = snapshot_unlocked(request)
            if publish:
                if not current["ready"] or current != request["expected"]:
                    return {"ready": False, "reason": "changed_during_slim"}
                temporary, target = Path(request["temporary"]), Path(request["target"])
                if temporary.parent != target.parent or not temporary.name.startswith(".auto-renew-"):
                    raise ValueError("invalid publication staging path")
                with temporary.open("rb") as stream:
                    os.fsync(stream.fileno())
                os.replace(temporary, target)
                sync_directory(target.parent)
                return {"ready": True, "output": signature(target)}
            return current
    except BlockingIOError:
        return {"ready": False, "reason": "writer_active"}
    except FileNotFoundError as error:
        return {"ready": False, "reason": "missing_cleaning_evidence", "path": str(error.filename)}


def sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def archive_package(file, destination, expected=None):
    destination.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        os.link(file, destination)  # Exclusive create: never overwrite a same-name upload.
        created = True
    except FileExistsError:
        if not os.path.samefile(file, destination):
            raise ValueError(f"archive destination already exists: {destination}")
    # Linking changes ctime itself. Size, mtime and identity must still describe
    # the package whose input publication committed, not a replacement upload.
    linked = signature(destination)
    if not os.path.samefile(file, destination) or (expected is not None and
            any(linked[key] != expected[key] for key in ("size", "mtime_ns", "ino", "dev"))):
        if created:
            destination.unlink()
        raise ValueError("package replaced during archival; inbox retained")
    sync_directory(destination.parent)
    file.unlink()
    sync_directory(file.parent)


def ingest(request):
    import app
    dataset = app.make_datasets(Path(request["dataRoot"]), Path(request["stateRoot"]))["/data/" + request["id"]]
    dataset.state_dir.mkdir(parents=True, exist_ok=True)
    events = []
    with (dataset.state_dir / "archive.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"events": [{"event": "ingest_wait", "reason": "data_service_busy"}]}
        dataset.process_archives([])  # Finish any durable interrupted publication first.
        writers = dataset.open_archive_writers()
        for item in request["packages"]:
            if STOP_REQUESTED:
                events.append({"event": "ingest_stopped", "reason": "signal"})
                break
            name = item["name"]
            if Path(name).name != name or not name.lower().endswith(".7z"):
                raise ValueError("invalid package name")
            file = dataset.archive_dir / name
            try:
                if name in writers or signature(file) != item["signature"]:
                    events.append({"event": "package_wait", "package": name, "reason": "upload_changed_or_open"})
                    continue
                match = re.search(r"_(\d{8})_\d{6}\.7z$", name, re.IGNORECASE)
                if not match or datetime.strptime(match[1], "%Y%m%d").strftime("%Y%m%d") != match[1]:
                    raise ValueError("package name has no valid YYYYMMDD_HHMMSS date")
                target = dataset.archive_dir / "3_processed_archives" / match[1] / name
                if target.exists() and not os.path.samefile(file, target):
                    raise ValueError(f"archive destination already exists: {target}")
                info = app.file_signature(file)
                if info is None:
                    raise ValueError("package disappeared before extraction")
                dataset.process_archives([info], retry_failed=True)
                state = dataset.load_archive_state()
                if info not in state["archives"] or any(entry["name"] == name for entry in state["failed_archives"]):
                    raise ValueError("input publication failed; package retained")
                if signature(file) != item["signature"] or name in dataset.open_archive_writers():
                    raise ValueError("package changed after extraction; not archived")
                db = dataset.open_archive_index()
                try:
                    summary = db.execute("SELECT json_extract(report, '$.read'), json_extract(report, '$.accepted'), "
                                         "json_extract(report, '$.excluded') FROM cleaning_reports "
                                         "WHERE name=? AND size=? AND mtime_ns=?",
                                         (info["name"], info["size"], info["mtime_ns"])).fetchone()
                finally:
                    db.close()
                archive_package(file, target, item["signature"])
                events.append({"event": "package_archived", "package": name, "destination": str(target),
                               "inputDirectory": str(dataset.output_dir), "bytes": info["size"],
                               "read": summary[0] if summary else None, "accepted": summary[1] if summary else None,
                               "excluded": summary[2] if summary else None,
                               "reportDatabase": str(dataset.state_dir / "archive-records.sqlite")})
            except (OSError, ValueError, RuntimeError) as error:
                events.append({"event": "package_error", "package": name, "error": str(error)})
    return {"events": events}


def monitor(request):
    matches = []
    for process in Path("/proc").glob("[0-9]*"):
        try:
            args = (process / "cmdline").read_bytes().decode(errors="replace").split("\0")
            # Scope by daily input/output arguments, never by a generic python PID.
            paths = {value.split("=", 1)[-1].rstrip("/") for value in args}
            if not any(value.rstrip("/") in paths for value in (request["inputDirectory"], request["cleanDirectory"])):
                continue
            scripts = [Path(value).name for value in args if value.endswith(".py")]
            if scripts:
                matches.append({"pid": int(process.name), "script": scripts[0]})
        except (OSError, ValueError):
            continue
    return {"processes": matches, "status": "observed" if matches else "daily_cleaner_not_identified"}


def main():
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    request = json.load(sys.stdin)
    operation = request.pop("operation")
    with contextlib.redirect_stdout(sys.stderr):
        if operation == "ingest":
            result = ingest(request)
        elif operation in ("snapshot", "publish"):
            result = observe(request, operation == "publish")
        elif operation == "monitor":
            result = monitor(request)
        elif operation == "check":
            import app
            result = {"ok": True}
        else:
            raise ValueError("unknown operation")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
