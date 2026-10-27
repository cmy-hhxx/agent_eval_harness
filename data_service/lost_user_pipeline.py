"""Read-only external-cleaner checks and atomic publication for the night pipeline."""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

from auto_renew import archive_package, complete, signature, sync_directory


def snapshot(request):
    model, name = request["model"], request["name"]
    if model not in ("aime_fast", "aime_expert") or not re.fullmatch(r"\d{4}-\d{2}-\d{2}\.jsonl", name):
        raise ValueError("invalid lost-user input coordinate")
    source = Path(request["inputDirectory"])
    clean = Path(request["cleanDirectory"]) / model
    status_file = clean / "status.json"
    entry = json.loads(status_file.read_text())["files"].get(name, {})
    rows = entry.get("output_records")
    if rows is None:
        return {"ready": False, "reason": "no_committed_output", "status": entry.get("status", "missing")}
    if type(rows) is not int or rows < 0:
        raise ValueError("invalid cleaner output_records")
    manifest_file = source / ".extract-lost-user.json"
    manifest_before = signature(manifest_file)
    receipt = json.loads(manifest_file.read_text())["files"].get(model + "/" + name[:-6], {})
    raw = signature(source / model / name)
    if receipt.get("bytes") != raw["size"]:
        return {"ready": False, "reason": "input_receipt_changing"}
    if type(receipt.get("rows")) is not int or rows > receipt["rows"]:
        raise ValueError("invalid cleaner output_records")
    updated = datetime.fromisoformat(entry["updated_at"])
    if updated.tzinfo is None:
        raise ValueError("cleaner updated_at must include timezone")
    finished = (complete(entry) and receipt["rows"] == entry["total_lines"] and
                int(raw["mtime_ns"]) < int((updated.timestamp() + 1) * 1_000_000_000))
    output = signature(clean / name) if rows or (clean / name).exists() else None
    if signature(manifest_file) != manifest_before:
        return {"ready": False, "reason": "cleaning_evidence_changed"}
    # The cleaner fsyncs appended rows before atomically publishing output_records.
    # Its status lock spans the whole run, so readers use this committed prefix.
    return {"ready": True, "complete": finished, "raw": raw, "clean": output, "entry": entry, "rows": rows}


def same_prefix_source(current, expected):
    if not current["ready"] or current["rows"] < expected["rows"]:
        return False
    if expected["clean"] is None:
        return expected["rows"] == 0
    return (current["clean"] is not None and
            all(current["clean"][key] == expected["clean"][key] for key in ("ino", "dev")) and
            current["clean"]["size"] >= expected["clean"]["size"])


def observe(request, operation):
    try:
        current = snapshot(request)
        if operation == "snapshot":
            return current
        expected = request["expected"]
        if not same_prefix_source(current, expected):
            return {"ready": False, "reason": "changed_during_slim"}
        captured, temporary, target = (Path(request[key]) for key in ("captured", "temporary", "target"))
        if any(p.parent != target.parent or not p.name.startswith(".night-") for p in (captured, temporary)):
            raise ValueError("invalid publication path")
        source = Path(request["cleanDirectory"]) / request["model"] / request["name"]
        if operation == "capture":
            with captured.open("xb") as output:
                if expected["rows"]:
                    with source.open("rb") as stream:
                        for _ in range(expected["rows"]):
                            line = stream.readline()
                            if not line.endswith(b"\n"):
                                raise ValueError("清洗输出行数不符或已提交记录未完整落盘")
                            output.write(line)
            if not same_prefix_source(snapshot(request), expected):
                return {"ready": False, "reason": "changed_during_slim"}
            return {"ready": True}
        # Appends are allowed; replacing, truncating or editing the captured prefix is not.
        with source.open("rb") as stream, captured.open("rb") as prefix:
            while chunk := prefix.read(1024 * 1024):
                if stream.read(len(chunk)) != chunk:
                    return {"ready": False, "reason": "changed_during_slim"}
        if not same_prefix_source(snapshot(request), expected):
            return {"ready": False, "reason": "changed_during_slim"}
        with temporary.open("rb") as stream:
            os.fsync(stream.fileno())
        os.link(temporary, target)
        temporary.unlink()
        sync_directory(target.parent)
        return {"ready": True, "output": signature(target)}
    except FileNotFoundError as error:
        return {"ready": False, "reason": "missing_cleaning_evidence", "path": str(error.filename)}


def writing(file):
    target = str(Path(file).resolve())
    for process in Path("/proc").glob("[0-9]*"):
        try:
            for descriptor in (process / "fd").iterdir():
                try:
                    if os.readlink(descriptor) != target:
                        continue
                    info = (process / "fdinfo" / descriptor.name).read_text()
                    flags = next(line.split()[1] for line in info.splitlines() if line.startswith("flags:"))
                    if int(flags, 8) & os.O_ACCMODE:
                        return True
                except (OSError, StopIteration):
                    continue
        except OSError:
            continue
    return False


def main():
    request = json.load(sys.stdin)
    operation = request.pop("operation")
    if operation in ("snapshot", "capture", "publish"):
        result = observe(request, operation)
    elif operation == "writable":
        result = {"writing": writing(request["file"])}
    elif operation == "archive":
        if writing(request["file"]):
            raise ValueError("package is still being written")
        archive_package(Path(request["file"]), Path(request["target"]), request["expected"])
        result = {"archived": True}
    else:
        raise ValueError("unknown lost-user operation")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
