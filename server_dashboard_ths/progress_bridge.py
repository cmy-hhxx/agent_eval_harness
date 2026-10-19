#!/usr/bin/env python3
"""Report per-date A/B Comparison progress from local evaluation state files."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_ENDPOINT = "http://117.50.195.94:2256/evaluation-progress"
FAILED = {"failed", "timed_out", "cancelled", "blocked"}
PAIR_BY_GROUP = {
    ("a_fast", "b_fast"): "fast",
    ("a_expert", "b_expert"): "expert",
}
DATE_PATTERN = re.compile(r"(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)")
PAIR_FIELDS = ("total_cases", "completed_cases", "running_cases", "queued_cases", "failed_cases", "skipped_cases")


def day_in(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    for match in DATE_PATTERN.findall(value):
        try:
            return date.fromisoformat(match).isoformat()
        except ValueError:
            continue
    return None


def task_day(candidates: list[dict[str, object]]) -> str | None:
    source_days = {day for candidate in candidates if (day := day_in(candidate.get("source")))}
    if len(source_days) == 1:
        return source_days.pop()
    if source_days:
        return None
    identity_days = {
        day
        for candidate in candidates
        for value in (candidate.get("batch_id"), candidate.get("case_id"))
        if (day := day_in(value))
    }
    return next(iter(identity_days)) if len(identity_days) == 1 else None


def task_pair(group: object) -> str | None:
    if not isinstance(group, list) or not all(isinstance(version, str) for version in group):
        return None
    return PAIR_BY_GROUP.get(tuple(sorted(group)))


def progress_from_states(states: list[dict[str, object]], updated_at: int | None = None) -> dict[str, object]:
    if not states:
        raise ValueError("at least one state.json is required")
    engines = set()
    run_statuses = set()
    run_records = []
    case_statuses: dict[tuple[str, str, str, str], list[str]] = defaultdict(list)

    for state in states:
        status = state.get("status")
        engine_info = state.get("engine")
        engine = engine_info.get("engine") if isinstance(engine_info, dict) else None
        tasks = state.get("tasks")
        inputs = state.get("inputs")
        if status not in {"running", "finished", "interrupted"}:
            raise ValueError("state.json has an unsupported run status")
        if engine not in {"pi", "prime"}:
            raise ValueError("state.json has an unsupported engine")
        if not isinstance(tasks, dict) or not isinstance(inputs, dict):
            raise ValueError("state.json has no checkpoint tasks or inputs")
        engines.add(engine)
        run_statuses.add(status)
        run_records.append(state)
        for task in tasks.values():
            if not isinstance(task, dict) or task.get("stage") != "comparison":
                continue
            data = task.get("data")
            input_ids = task.get("inputIds")
            if not isinstance(data, dict) or not isinstance(input_ids, dict):
                continue
            pair = task_pair(data.get("group"))
            candidates = [inputs.get(input_id) for input_id in input_ids.values()]
            candidates = [candidate for candidate in candidates if isinstance(candidate, dict)]
            day = task_day(candidates)
            if pair is None or day is None or not candidates:
                continue
            first = candidates[0]
            case_id = first.get("case_id")
            batch_id = first.get("batch_id", "")
            if not isinstance(case_id, str) or not case_id:
                continue
            case_statuses[(day, pair, str(batch_id), case_id)].append(str(task.get("status", "pending")))

        preflight = state.get("preflight")
        skipped = preflight.get("skipped") if isinstance(preflight, dict) else None
        if isinstance(skipped, list):
            for entry in skipped:
                if not isinstance(entry, dict):
                    continue
                pair = task_pair(entry.get("versions"))
                sources = entry.get("sources")
                source_candidates = [source for source in sources if isinstance(source, dict)] if isinstance(sources, list) else []
                batch_id, case_id = entry.get("batch_id"), entry.get("case_id")
                day = task_day(source_candidates) or day_in(batch_id) or day_in(case_id)
                if pair is None or day is None or not isinstance(case_id, str) or not case_id:
                    continue
                case_statuses[(day, pair, str(batch_id or ""), case_id)].append("skipped")

    if len(engines) != 1:
        raise ValueError("state files must use the same engine")
    by_day: dict[str, dict[str, dict[str, int]]] = defaultdict(
        lambda: {pair: {field: 0 for field in PAIR_FIELDS} for pair in ("fast", "expert")}
    )
    for (day, pair, _, _), statuses in case_statuses.items():
        counts = by_day[day][pair]
        counts["total_cases"] += 1
        if any(item == "running" for item in statuses):
            counts["running_cases"] += 1
        elif any(item in FAILED for item in statuses):
            counts["failed_cases"] += 1
        elif any(item == "succeeded" for item in statuses):
            counts["completed_cases"] += 1
        elif any(item == "skipped" for item in statuses):
            counts["skipped_cases"] += 1
        else:
            counts["queued_cases"] += 1

    latest = max(run_records, key=lambda item: int(item.get("startedAt", 0)))
    latest_status = "running" if "running" in run_statuses else "interrupted" if "interrupted" in run_statuses else "finished"
    return {
        "run_id": str(latest.get("runId", "")),
        "engine": next(iter(engines)),
        "status": latest_status,
        "started_at": max(int(state.get("startedAt", 0)) for state in run_records),
        "updated_at": updated_at or int(time.time() * 1000),
        "dates": [
            {"date": day, "pairs": pairs}
            for day, pairs in sorted(by_day.items(), reverse=True)
        ],
    }


def read_state(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("state.json must contain an object")
    return value


def post_progress(endpoint: str, progress: dict[str, object]) -> None:
    request = Request(
        endpoint,
        data=json.dumps(progress).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=3) as response:
        if response.status != 200:
            raise RuntimeError(f"progress endpoint returned HTTP {response.status}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("states", type=Path, nargs="+", help="one or more local run state.json files")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--interval", type=float, default=10)
    parser.add_argument("--once", action="store_true", help="send one snapshot and exit")
    args = parser.parse_args()
    if args.interval <= 0:
        parser.error("--interval must be positive")

    last_signature = None
    progress = None
    while True:
        try:
            stats = [path.stat() for path in args.states]
            signature = tuple((stat.st_mtime_ns, stat.st_size) for stat in stats)
            changed = signature != last_signature
            if changed:
                updated_at = max(int(stat.st_mtime_ns / 1_000_000) for stat in stats)
                progress = progress_from_states([read_state(path) for path in args.states], updated_at)
                progress["updated_at"] = max(updated_at, cast(int, progress["started_at"]))
                last_signature = signature
            if progress is None:
                raise ValueError("state.json is not ready")
            post_progress(args.endpoint, progress)
            if changed:
                print(f"reported {progress['run_id']}: {len(cast(list[object], progress['dates']))} dates", flush=True)
            if args.once or progress["status"] != "running":
                return 0
        except HTTPError as exc:
            if exc.code == 409:
                print("report rejected: a newer run is active", file=sys.stderr, flush=True)
                return 0
            print(f"progress report failed: HTTP {exc.code}", file=sys.stderr, flush=True)
            if args.once:
                return 1
        except (OSError, URLError, ValueError, RuntimeError) as exc:
            print(f"progress report failed: {exc}", file=sys.stderr, flush=True)
            if args.once:
                return 1
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
