from __future__ import annotations

import asyncio
import os
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .core import (Config, EvaluationPlan, Json, Record, atomic_text, digest, read_json,
                   validate_result, write_json, write_jsonl)
from .prime import JudgeError, invoke, prepared_prime, probe_prime, redact

SUBJECTIVE_CORRECTNESS = {"is_correct": None, "correctness_reason": "", "evidence": []}


def task_descriptor(stage: str, candidates: dict[str, Record], reference: Any, fingerprint: str) -> Json:
    identity = {k: {**r.identity(), "llm": r.llm} for k, r in candidates.items()}
    task_id = stage + "-" + digest({"stage": stage, "inputs": {k: r.hash for k, r in candidates.items()},
                                  "identities": {k: r.key for k, r in candidates.items()},
                                  "reference": reference, "fingerprint": fingerprint})[:24]
    return {"id": task_id, "stage": stage, "candidates": identity, "reference": reference}


def comparison_row(run: Path, task: Json, evaluation: Json) -> Json:
    a = task["candidates"]["A"]
    evaluations = {}
    for candidate, dependency in task["dependencies"].items():
        check = read_json(run / "tasks" / dependency / "result.json")["evaluation"] if dependency else SUBJECTIVE_CORRECTNESS
        evaluations[candidate] = {"is_correct": check["is_correct"], "correctness_reason": check["correctness_reason"],
                                  **evaluation["evaluations"][candidate]}
    return {
        "schema_version": "3.1", "evaluation_type": "pairwise_model_comparison",
        "comparison_id": "cmp_" + digest({"batch": a["batch_id"], "case": a["case_id"], "pair": task["pair"]})[:32],
        "case": {"batch_id": a["batch_id"], "case_id": a["case_id"]},
        "ground_truth": {"available": task["reference"] is not None, "value": task["reference"]},
        "models": {k: {"version": r["name"], "llm": r["llm"], "trace_id": r["trace_id"]} for k, r in task["candidates"].items()},
        "verdict": evaluation["verdict"], "evaluations": evaluations,
    }


def export_results(run: Path) -> Json:
    manifest = read_json(run / "manifest.json")
    groups: dict[str, list[Json]] = defaultdict(list)
    correctness: list[Json] = [{**identity, **SUBJECTIVE_CORRECTNESS, "assessment_status": "subjective_not_assessed"}
                               for identity in manifest.get("subjective_inputs", [])]
    outcomes: list[Json] = []
    result_count = 0
    statuses: Counter[str] = Counter()
    usage: Counter[str] = Counter()
    for task in manifest["tasks"]:
        path = run / "tasks" / task["id"] / "result.json"
        if not path.exists():
            statuses["pending"] += 1
            continue
        result = read_json(path)
        status = result["status"]
        not_comparable = (status == "succeeded" and task["stage"] == "pairwise"
                          and result["evaluation"]["verdict"]["result"] == "not_comparable")
        if not_comparable:
            status = "not_comparable"
        statuses[status] += 1
        outcomes.append({"task_id": task["id"], "stage": task["stage"], "status": status,
                         "candidates": task["candidates"], "reason": result["evaluation"]["verdict"]["reason"] if not_comparable else result.get("reason"),
                         "cached": result.get("cached", False), "raw_artifact": result.get("raw_artifact"),
                         "duration_seconds": result.get("duration_seconds")})
        if status != "succeeded":
            continue
        evaluation = result["evaluation"]
        if task["stage"] == "correctness":
            correctness.append({**task["candidates"]["A"], **evaluation, "task_id": task["id"], "assessment_status": "assessed"})
            continue
        if evaluation["verdict"]["result"] == "not_comparable":
            continue
        row = comparison_row(run, task, evaluation)
        groups["__vs__".join(task["pair"])].append(row)
        result_count += 1
    output = run / "results"
    output.mkdir(exist_ok=True)
    for pair, rows in groups.items():
        rows.sort(key=lambda row: (row["case"]["batch_id"], row["case"]["case_id"]))
        write_jsonl(output / f"{pair}.jsonl", rows)
    # Only remove our own derived files whose previous results no longer exist.
    for old in output.glob("*__vs__*.jsonl"):
        if old.stem not in groups:
            old.unlink()
    write_jsonl(run / "correctness.jsonl", correctness)
    write_jsonl(run / "task_outcomes.jsonl", outcomes)
    failures = [item for item in outcomes if item["status"] in ("failed", "blocked")]
    write_jsonl(run / "failures.jsonl", failures)
    write_jsonl(run / "not_comparable.jsonl", [item for item in outcomes if item["status"] == "not_comparable"])
    for metrics_file in (run / "tasks").glob("*/attempt-*/metrics.json"):
        for key, value in read_json(metrics_file)["usage"].items():
            usage[key] += value
    per_version: Json = {}
    for record in correctness:
        stats = per_version.setdefault(record["name"], {"correct": 0, "incorrect": 0, "undetermined": 0, "subjective_not_assessed": 0})
        stats["subjective_not_assessed" if record["assessment_status"] == "subjective_not_assessed" else
              "correct" if record["is_correct"] is True else "incorrect" if record["is_correct"] is False else "undetermined"] += 1
    for stats in per_version.values():
        total = stats["correct"] + stats["incorrect"] + stats["undetermined"]
        decided = stats["correct"] + stats["incorrect"]
        stats.update({"evaluated": total, "decidable_coverage": decided / total if total else None,
                      "accuracy_among_decidable": stats["correct"] / decided if decided else None})
    pair_summary: Json = {}
    for pair, rows in groups.items():
        names = pair.split("__vs__")
        wins = Counter({name: 0 for name in names})
        ties = 0
        for row in rows:
            verdict = row["verdict"]["result"]
            if verdict == "tie":
                ties += 1
            else:
                winner = row["models"]["A" if verdict == "A_better" else "B"]["version"]
                version_id = next(v["id"] for v in manifest["config"]["inputs"]["versions"] if v["name"] == winner)
                wins[version_id] += 1
        pair_summary[pair] = {"evaluated": len(rows), "wins": dict(wins), "ties": ties,
                              "case_ids": [row["case"] for row in rows]}
    summary = {"run_id": manifest["run_id"], "status": manifest["status"], "planned": manifest["preflight"],
               "task_statuses": dict(statuses), "completed_comparisons": result_count,
               "result_files": [str(output / f"{pair}.jsonl") for pair in sorted(groups)],
               "correctness": per_version, "pairs": pair_summary, "usage_this_run_including_failed_attempts": dict(usage),
               "wall_seconds": (manifest.get("finished_at") or time.time()) - manifest["started_at"],
               "note": "胜率分母为各配对实际成功评测数；正确性仅统计有标准答案的唯一批次/case/版本，主观题与未判定单列。"}
    write_json(run / "summary.json", summary)
    lines = [f"# 评测运行 {manifest['run_id']}", "", f"状态：{manifest['status']}；完成比较：{result_count}。", "",
             "各组合题集可能不同，不能直接将胜率当成同题集排名。", "",
             "| 配对 | 有效比较 | 胜出数量 | 平局 |", "|---|---:|---|---:|"]
    for pair, stats in pair_summary.items():
        lines.append(f"| {pair} | {stats['evaluated']} | {stats['wins']} | {stats['ties']} |")
    lines += ["", "| 版本 | 正确 | 错误 | 客观题未判定 | 主观题跳过 | 可判定题正确率 |", "|---|---:|---:|---:|---:|---:|"]
    for name, stats in per_version.items():
        accuracy = f"{stats['accuracy_among_decidable']:.1%}" if stats["accuracy_among_decidable"] is not None else "—"
        lines.append(f"| {name} | {stats['correct']} | {stats['incorrect']} | {stats['undetermined']} | {stats['subjective_not_assessed']} | {accuracy} |")
    lines += ["", "缺失配对见 skipped.jsonl；输入异常见 preflight.json；任务失败见 failures.jsonl。",
              "每次调用的原始事件、提示词与耗时位于 tasks/；缓存命中记录保留原始调用目录链接。"]
    atomic_text(run / "report.md", "\n".join(lines) + "\n")
    return summary


async def run_evaluation(config: Config, plan: EvaluationPlan, run: Path, resume: bool, retry_failed: bool = False, stage: str = "all") -> Json:
    if resume and (run / "manifest.json").exists():
        prime = probe_prime(config.data["judge"]["prime_binary"])
    else:
        prime = prepared_prime(config)
    fingerprint = digest({"config": config.fingerprint(), "prime": prime})
    stage_fingerprints = {name: digest({"config": config.fingerprint(name), "prime": prime}) for name in ("correctness", "pairwise")}
    lookup = plan.records
    checks: dict[tuple[str, str, str], Json] = {}
    pair_tasks = []
    for a, b in plan.pairs:
        reference = plan.references[a.key[:2]]
        if reference is not None:
            for record in (a, b):
                checks.setdefault(record.key, task_descriptor("correctness", {"A": record}, reference, stage_fingerprints["correctness"]))
        ordered = [a, b]
        if int(digest([config.data["execution"]["seed"], a.batch, a.case, a.version, b.version])[-1], 16) % 2:
            ordered.reverse()
        candidates: dict[str, Record] = dict(zip(("A", "B"), ordered))
        task = task_descriptor("pairwise", candidates, reference, stage_fingerprints["pairwise"])
        task.update({"pair": [a.version, b.version], "dependencies": {k: checks[r.key]["id"] if reference is not None else None for k, r in candidates.items()}})
        pair_tasks.append(task)
    tasks = list(checks.values()) + pair_tasks
    selection = digest([task["id"] for task in tasks])
    manifest_file = run / "manifest.json"
    if manifest_file.exists():
        if not resume:
            raise ValueError("运行目录已存在；请指定新的 --run-id 或使用 --resume")
        manifest = read_json(manifest_file)
        if manifest["fingerprint"] != fingerprint or manifest["selection"] != selection:
            raise ValueError("输入、程序、模型、提示词或 prime 版本已变化；请创建新 run，未变化任务会自动复用缓存")
    else:
        subjective = {r.key: r.identity() for pair in plan.pairs for r in pair if plan.references[r.key[:2]] is None}
        manifest = {"run_id": run.name, "fingerprint": fingerprint, "selection": selection, "prime": prime,
                    "config": config.data, "prompts": config.prompts, "tasks": tasks,
                    "subjective_inputs": list(subjective.values()),
                    "preflight": plan.summary(), "started_at": time.time()}
        write_json(run / "schema.json", config.schema)
        write_json(run / "preflight.json", plan.summary())
        write_jsonl(run / "skipped.jsonl", plan.skipped)
        for record in lookup.values():
            write_json(run / "inputs" / f"{record.hash}.json", record.raw)
    manifest.update({"status": "running", "finished_at": None})
    write_json(manifest_file, manifest)
    semaphore = asyncio.Semaphore(config.data["execution"]["concurrency"])
    cache_dir = Path(config.data["artifacts"]["cache_dir"]) / "results"
    secret = os.environ.get(config.data["judge"]["api_key_env"], "")
    completed = 0

    async def execute(task: Json, correctness: Json) -> Json:
        nonlocal completed
        task_dir = run / "tasks" / task["id"]
        result_file = task_dir / "result.json"
        candidates = {k: lookup[(r["batch_id"], r["case_id"], r["version"])] for k, r in task["candidates"].items()}
        cache_key = digest([task["id"], correctness])
        cache_file = cache_dir / f"{cache_key}.json"
        result = None
        if result_file.exists():
            previous = read_json(result_file)
            if previous["status"] == "succeeded" or not retry_failed:
                result = previous
        if result is None and cache_file.exists():
            cached = read_json(cache_file)
            if Path(cached.get("raw_artifact", "missing")).is_dir():
                try:
                    viewed = {(s.split(":")[0], int(s.split(":")[1])) for s in cached.get("viewed_images", [])}
                    validate_result(config.schema, task["stage"], cached["evaluation"], candidates, viewed)
                    result = {**cached, "cached": True}
                except (ValueError, KeyError):
                    pass
        if result is None:
            attempts = len(list(task_dir.glob("attempt-*"))) if task_dir.exists() else 0
            for attempt in range(config.data["execution"]["retries"] + 1):
                attempt_dir = task_dir / f"attempt-{attempts + attempt + 1:03d}"
                try:
                    async with semaphore:
                        value = await invoke(config, prime, task["stage"], candidates, task["reference"], correctness,
                                             attempt_dir, {k: run / "inputs" / f"{r.hash}.json" for k, r in candidates.items()})
                    result = {**value, "status": "succeeded", "cached": False, "raw_artifact": str(attempt_dir), "cache_key": cache_key}
                    write_json(cache_file, result)
                    break
                except Exception as error:
                    reason = redact(str(error), secret)
                    write_json(attempt_dir / "error.json", {"type": type(error).__name__, "reason": reason})
                    result = {"status": "failed", "reason": reason, "raw_artifact": str(attempt_dir), "cache_key": cache_key}
                    if not isinstance(error, JudgeError) or not error.retryable or attempt >= config.data["execution"]["retries"]:
                        break
                    await asyncio.sleep(config.data["execution"]["retry_delay_seconds"] * 2 ** attempt)
        assert result is not None
        write_json(result_file, result)
        completed += 1
        print(f"[{completed}/{len(tasks)}] {task['stage']} {result['status']} {task['id']}" + (" (cache)" if result.get("cached") else ""), flush=True)
        export_results(run)
        return result

    async def compare(task: Json) -> Json:
        values = {}
        for candidate, dependency in task["dependencies"].items():
            path = run / "tasks" / str(dependency) / "result.json"
            values[candidate] = (read_json(path) if path.exists() else {"status": "blocked"}) if dependency else {"status": "succeeded", "evaluation": SUBJECTIVE_CORRECTNESS}
        if any(value["status"] != "succeeded" for value in values.values()):
            result = {"status": "blocked", "reason": "独立正确性核验失败，未生成配对结论"}
            write_json(run / "tasks" / task["id"] / "result.json", result)
            return result
        return await execute(task, {k: v["evaluation"] for k, v in values.items()})

    futures: list[asyncio.Task[Json]] = []
    try:
        if stage in ("all", "correctness"):
            futures = [asyncio.create_task(execute(task, {})) for task in checks.values()]
            await asyncio.gather(*futures)
        if stage in ("all", "pairwise"):
            futures = [asyncio.create_task(compare(task)) for task in pair_tasks]
            await asyncio.gather(*futures)
        manifest["status"] = "correctness_complete" if stage == "correctness" else "finished"
    except BaseException:
        manifest["status"] = "interrupted"
        for future in futures:
            future.cancel()
        await asyncio.gather(*futures, return_exceptions=True)
        raise
    finally:
        manifest["finished_at"] = time.time()
        write_json(manifest_file, manifest)
        export_results(run)
    return export_results(run)


def validate_run(run: Path) -> Json:
    from jsonschema import Draft202012Validator
    manifest, schema = read_json(run / "manifest.json"), read_json(run / "schema.json")
    errors = []
    count = 0
    seen: set[tuple[str, str, tuple[str, ...]]] = set()
    consistency: dict[tuple[str, str, str], tuple[Any, str]] = {}
    expected_rows: dict[str, Json] = {}
    for task in manifest["tasks"]:
        path = run / "tasks" / task["id"] / "result.json"
        if not path.exists():
            errors.append(f"未完成任务: {task['id']}")
            continue
        result = read_json(path)
        if result["status"] != "succeeded":
            continue
        from .core import adapt
        candidates = {}
        for label, identity in task["candidates"].items():
            raw = read_json(run / "inputs" / f"{identity['input_hash']}.json")
            if digest(raw) != identity["input_hash"]:
                errors.append(f"输入快照哈希不匹配: {identity['input_hash']}")
            version = next(v for v in manifest["config"]["inputs"]["versions"] if v["id"] == identity["version"])
            candidates[label] = adapt(raw, version, identity["source"], identity["line"], identity["batch_id"])
        try:
            viewed = {(s.split(":")[0], int(s.split(":")[1])) for s in result.get("viewed_images", [])}
            validate_result(schema, task["stage"], result["evaluation"], candidates, viewed)
            if task["stage"] == "pairwise" and result["evaluation"]["verdict"]["result"] != "not_comparable":
                expected = comparison_row(run, task, result["evaluation"])
                expected_rows[expected["comparison_id"]] = {"row": expected, "file": "__vs__".join(task["pair"]) + ".jsonl"}
        except Exception as error:
            errors.append(f"{task['id']}: {error}")
    for path in sorted((run / "results").glob("*.jsonl")):
        with path.open(encoding="utf-8") as stream:
            for line, text in enumerate(stream, 1):
                try:
                    import json
                    row = json.loads(text)
                    Draft202012Validator(schema).validate(row)
                    expected = expected_rows.get(row["comparison_id"])
                    if not expected or row != expected["row"] or path.name != expected["file"]:
                        raise ValueError("结果与原始任务、正确性记录或候选映射不一致")
                    batch, case = row["case"]["batch_id"], row["case"]["case_id"]
                    pair = tuple(sorted(m["version"] for m in row["models"].values()))
                    key = (batch, case, pair)
                    if key in seen or len(set(pair)) != 2:
                        raise ValueError("重复配对或自身比较")
                    seen.add(key)
                    for label in ("A", "B"):
                        identity = (batch, case, row["models"][label]["version"])
                        check = row["evaluations"][label]
                        value = (check["is_correct"], check["correctness_reason"])
                        if identity in consistency and consistency[identity] != value:
                            raise ValueError("跨配对正确性结论不一致")
                        consistency[identity] = value
                    count += 1
                except Exception as error:
                    errors.append(f"{path.name}:{line}: {error}")
    expected = 0
    for task in manifest["tasks"]:
        path = run / "tasks" / task["id"] / "result.json"
        if task["stage"] == "pairwise" and path.exists():
            result = read_json(path)
            if result["status"] == "succeeded" and result["evaluation"]["verdict"]["result"] != "not_comparable":
                expected += 1
    if count != expected:
        errors.append(f"输出数量 {count} 与成功比较数 {expected} 不一致")
    result = {"valid": not errors, "comparisons": count, "errors": errors}
    write_json(run / "validation.json", result)
    return result
