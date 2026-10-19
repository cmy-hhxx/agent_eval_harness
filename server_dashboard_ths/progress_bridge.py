#!/usr/bin/env python3
"""Report battle or independent stage progress from local evaluation state files."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import defaultdict
from datetime import date
from itertools import combinations
from pathlib import Path
from typing import cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

DEFAULT_ENDPOINT = "http://117.50.195.94:2256/evaluation-progress"
FAILED = {"failed", "timed_out", "cancelled", "blocked"}
PAIR_BY_GROUP = {
    ("a_fast", "b_fast"): "fast",
    ("a_expert", "b_expert"): "expert",
}
GPT_PAIRS = {
    tuple(sorted(pair)): "__vs__".join(sorted(pair))
    for group in (("a_fast", "b_fast", "6_luna"), ("a_expert", "b_expert", "6.1sol"))
    for pair in combinations(group, 2)
}
DATE_PATTERN = re.compile(r"(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)")
PAIR_FIELDS = ("total_cases", "completed_cases", "running_cases", "queued_cases", "failed_cases", "skipped_cases")
SOURCE_MODELS = {
    "aime": ("aime_fast", "aime_expert"),
    "ifind": ("ifind_normal_agent", "ifind_deep_research"),
}
STAGES = ("criteria", "attribution", "clustering")


def independent_progress(states: list[dict], provider: str, updated_at: int | None) -> dict[str, object]:
    if not states or provider not in SOURCE_MODELS:
        raise ValueError("independent progress requires states and a known source")
    engines = set()
    by_day: dict[str, dict] = {}
    seen = set()
    for state in sorted(states, key=lambda item: int(item.get("startedAt", 0)), reverse=True):
        engine = state.get("engine", {}).get("engine")
        if engine not in ("pi", "prime") or state.get("status") not in ("running", "finished", "interrupted"):
            raise ValueError("unsupported run engine or status")
        engines.add(engine)
        tasks, inputs = state.get("tasks"), state.get("inputs")
        if not isinstance(tasks, dict) or not isinstance(inputs, dict):
            raise ValueError("state.json has no checkpoint tasks or inputs")
        active = state.get("executionScope")
        for task_id, task in tasks.items():
            stage = task.get("stage")
            if stage not in STAGES or task_id in seen or (isinstance(active, list) and task_id not in active):
                continue
            data = task.get("data", {})
            scope = data.get("scope", {})
            candidates = [inputs[input_id] for input_id in task.get("inputIds", {}).values() if input_id in inputs]
            if stage == "clustering":
                model, day = scope.get("version"), day_in(scope.get("batch_id"))
            else:
                models = {candidate.get("version") for candidate in candidates}
                model, day = (next(iter(models)) if len(models) == 1 else None), task_day(candidates)
            if model not in SOURCE_MODELS[provider] or day is None:
                continue
            seen.add(task_id)
            counts = by_day.setdefault(day, {}).setdefault(model, {
                name: dict.fromkeys(("total", "completed", "running", "pending", "failed", "blocked", "cancelled"), 0)
                for name in STAGES
            })[stage]
            status = task.get("status")
            if status not in ("succeeded", "running", "pending", "failed", "timed_out", "blocked", "cancelled"):
                raise ValueError("unsupported task status")
            field = "completed" if status == "succeeded" and task.get("receipt") else "failed" if status in ("failed", "timed_out", "succeeded") else status
            counts["total"] += 1
            counts[field] += 1
    if len(engines) != 1:
        raise ValueError("state files must use the same engine")
    latest = max(states, key=lambda item: int(item.get("startedAt", 0)))
    statuses = {state["status"] for state in states}
    return {"run_id": latest["runId"], "engine": next(iter(engines)),
            "status": "running" if "running" in statuses else "interrupted" if "interrupted" in statuses else "finished",
            "started_at": latest["startedAt"], "updated_at": updated_at if updated_at is not None else int(time.time() * 1000),
            "dates": [{"date": day, "models": models} for day, models in sorted(by_day.items(), reverse=True)]}


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


def task_pairs(group: object, gpt: bool) -> list[str]:
    if not isinstance(group, list) or not all(isinstance(version, str) for version in group):
        return []
    if gpt:
        return [GPT_PAIRS[pair] for pair in combinations(sorted(set(group)), 2) if pair in GPT_PAIRS]
    pair = PAIR_BY_GROUP.get(tuple(sorted(group)))
    return [pair] if pair else []


def progress_from_states(states: list[dict[str, object]], updated_at: int | None = None, *, gpt: bool = False) -> dict[str, object]:
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
            candidates = [inputs.get(input_id) for input_id in input_ids.values()]
            candidates = [candidate for candidate in candidates if isinstance(candidate, dict)]
            group = [candidate.get("version") for candidate in candidates] if gpt else data.get("group")
            pairs = task_pairs(group, gpt)
            day = task_day(candidates)
            if len(pairs) != 1 or day is None or not candidates:
                continue
            first = candidates[0]
            case_id = first.get("case_id")
            batch_id = first.get("batch_id", "")
            if not isinstance(case_id, str) or not case_id:
                continue
            case_statuses[(day, pairs[0], str(batch_id), case_id)].append(str(task.get("status", "pending")))

        preflight = state.get("preflight")
        skipped = preflight.get("skipped") if isinstance(preflight, dict) else None
        if isinstance(skipped, list):
            for entry in skipped:
                if not isinstance(entry, dict):
                    continue
                pairs = task_pairs(entry.get("versions"), gpt)
                sources = entry.get("sources")
                source_candidates = [source for source in sources if isinstance(source, dict)] if isinstance(sources, list) else []
                batch_id, case_id = entry.get("batch_id"), entry.get("case_id")
                day = task_day(source_candidates) or day_in(batch_id) or day_in(case_id)
                if not pairs or day is None or not isinstance(case_id, str) or not case_id:
                    continue
                for pair in pairs:
                    case_statuses[(day, pair, str(batch_id or ""), case_id)].append("skipped")

    if len(engines) != 1:
        raise ValueError("state files must use the same engine")
    by_day: dict[str, dict[str, dict[str, int]]] = defaultdict(
        lambda: {pair: {field: 0 for field in PAIR_FIELDS} for pair in (GPT_PAIRS.values() if gpt else PAIR_BY_GROUP.values())}
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
                states = [read_state(path) for path in args.states]
                prefix = urlsplit(args.endpoint).path.rstrip("/").removesuffix("/evaluation-progress").lstrip("/")
                progress = independent_progress(states, prefix, updated_at) if prefix in SOURCE_MODELS else progress_from_states(states, updated_at, gpt=prefix == "gpt")
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
