from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path
from typing import Any

import pytest

from prime_eval.core import adapt, build_plan, load_config, validate_result, write_json, write_jsonl
from prime_eval.runner import run_evaluation, validate_run
from prime_eval.summaries import compare_timing

ROOT = Path(__file__).resolve().parents[1]


def raw(case: str = "q1", batch: str = "b1", reference: Any = "答案是 4", answer: str = "答案是 4") -> dict:
    return {"batch_id": batch, "case_id": case, "trace_id": f"{batch}-{case}",
            "messages": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "2+2是多少？"}]},
                         {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": answer}]}],
            "meta": {"ok": True, "ground_truth": reference}}


@pytest.fixture
def config(tmp_path):
    cfg = load_config(ROOT / "configs/eval.toml")
    cfg.data = copy.deepcopy(cfg.data)
    for version in cfg.versions:
        version["path"] = str(tmp_path / f"{version['id']}.jsonl")
        version["adapter"] = "a"
        write_jsonl(Path(version["path"]), [])
    cfg.data["artifacts"]["cache_dir"] = str(tmp_path / "cache")
    cfg.data["execution"]["retry_delay_seconds"] = 0
    return cfg


def fill(config, records_by_version):
    for version, records in zip(config.versions, records_by_version):
        write_jsonl(Path(version["path"]), records)


def test_alignment_missing_and_batches(config):
    fill(config, [[raw("q1"), raw("q2"), raw("q1", "b2")],
                  [raw("q2"), raw("q1"), raw("q1", "b2")], [raw("q1")], []])
    plan = build_plan(config)
    assert len(plan.pairs) == 5
    assert plan.summary()["correctness_tasks"] == 7
    assert len(plan.skipped) == 13
    assert all(a.key[:2] == b.key[:2] for a, b in plan.pairs)


def test_duplicate_does_not_choose_arbitrary_input(config):
    fill(config, [[raw(), raw()], [raw()], [raw()], []])
    plan = build_plan(config)
    assert len(plan.pairs) == 1
    assert all(r.version != "a_fast" for pair in plan.pairs for r in pair)
    assert "duplicate_input" in plan.issues[0]["reason"]


def test_reference_conflict_isolates_case(config):
    fill(config, [[raw(reference="4"), raw("ok")], [raw(reference="5"), raw("ok")]])
    plan = build_plan(config)
    assert len(plan.pairs) == 1
    assert plan.pairs[0][0].case == "ok"
    assert any(i["reason"] == "question_or_reference_conflict" for i in plan.issues)


def test_subjective_skips_correctness_and_empty_answer(config):
    invalid = raw("empty")
    invalid["messages"] = []
    fill(config, [[raw(reference=None), invalid], [raw(reference=None), raw("empty")]])
    plan = build_plan(config)
    assert len(plan.pairs) == 1
    assert plan.summary()["correctness_tasks"] == 0
    assert plan.summary()["subjective_inputs_skipping_correctness"] == 2


def test_a_and_aa_reference_final_and_index(config):
    version = config.versions[2] | {"adapter": "aa"}
    data = raw()
    data["meta"] = {"ok": True, "std_answer": "4"}
    data["messages"] = [{"type": "user_question", "role": "user", "content": "2+2是多少？"},
                        {"type": "llm_turn", "model": "source-model", "input_messages": [], "output": []},
                        {"type": "final_answer", "role": "assistant", "content": "4"}]
    record = adapt(data, version, "input.jsonl", 1, None)
    assert (record.final_index, record.reference, record.llm) == (2, "4", "source-model")
    assert record.material(1000)["final_answer"] == "4"


def test_evidence_must_be_exact_and_final_for_correctness(config):
    record = adapt(raw(), config.versions[0], "input.jsonl", 1, None)
    result = {"is_correct": True, "correctness_reason": "匹配", "evidence": [{"message_index": 1, "quote": "答案是 4"}]}
    validate_result(config.schema, "correctness", result, {"A": record})
    result["evidence"][0]["quote"] = "答案为四"
    with pytest.raises(ValueError, match="原文"):
        validate_result(config.schema, "correctness", result, {"A": record})
    result["evidence"][0] = {"message_index": 0, "quote": "2+2是多少？"}
    with pytest.raises(ValueError, match="最终回答"):
        validate_result(config.schema, "correctness", result, {"A": record})


def fake_evaluation(stage, candidates):
    if stage == "correctness":
        record = candidates["A"]
        return {"is_correct": True, "correctness_reason": "与标准答案一致。", "evidence": [{"message_index": record.final_index, "quote": "答案是 4"}]}
    return {"verdict": {"result": "A_better", "reason": "A 的表达更直接。"},
            "task_analysis": {"task_type": "整数加法", "goal": "计算2+2的结果", "requirements": ["给出数值4"],
                              "scoring_points": ["算式与结果一致"], "red_flags": ["将2+2算成5"],
                              "timing_analysis": "双方缺少原始回答完成时间，不比较快慢。"},
            "evaluations": {label: {"summary": "完成任务。", "findings": [{"type": "strength", "dimension": "completeness", "stage": "final_answer",
                          "importance": "high", "text": "回答核心问题", "reason": "给出结果。",
                          "evidence": [{"message_index": r.final_index, "quote": "答案是 4"}]}]} for label, r in candidates.items()}}


def test_two_stages_resume_cache_and_consistency(config, tmp_path, monkeypatch):
    import prime_eval.runner as runner
    fill(config, [[raw(), raw("subjective", reference=None)] for _ in range(4)])
    prime = {"binary": "fake", "sha256": "fake", "version": "0"}
    monkeypatch.setattr(runner, "prepared_prime", lambda _: prime)
    monkeypatch.setattr(runner, "probe_prime", lambda _: prime)
    calls = []

    async def invoke(cfg, prime, stage, candidates, reference, correctness, directory, paths):
        calls.append(stage)
        directory.mkdir(parents=True, exist_ok=True)
        write_json(directory / "metrics.json", {"usage": {"input": 10, "output": 5}})
        if stage == "correctness":
            assert reference is not None
        return {"evaluation": fake_evaluation(stage, candidates), "viewed_images": [], "usage": {}, "duration_seconds": 0.01}

    monkeypatch.setattr(runner, "invoke", invoke)
    plan = build_plan(config)
    run = tmp_path / "run"
    first = asyncio.run(run_evaluation(config, plan, run, False, stage="correctness"))
    assert calls == ["correctness"] * 4
    assert first["status"] == "correctness_complete"
    second = asyncio.run(run_evaluation(config, plan, run, True, stage="pairwise"))
    assert calls == ["correctness"] * 4 + ["pairwise"] * 12
    assert second["completed_comparisons"] == 12
    assert len(second["result_files"]) == 6
    assert validate_run(run)["valid"]
    summaries = [json.loads(line) for line in (run / "task_summaries.jsonl").read_text().splitlines()]
    assert len(summaries) == 12
    assert summaries[0]["question"] == "2+2是多少？"
    assert summaries[0]["scoring_points"] == ["算式与结果一致"]
    assert summaries[0]["red_flags"] == ["将2+2算成5"]
    assert summaries[0]["timing"]["comparison"]["finish_comparable"] is False
    assert summaries[0]["candidates"]["A"]["strengths"][0]["evidence"][0]["quote"] == "答案是 4"
    assert "原始回答耗时" in (run / "task_summaries.md").read_text()
    assert second["correctness"]["A Fast"]["subjective_not_assessed"] == 1
    assert second["correctness"]["A Fast"]["correct"] == 1
    asyncio.run(run_evaluation(config, plan, run, True))
    assert len(calls) == 16
    asyncio.run(run_evaluation(config, plan, tmp_path / "new-run", False))
    assert len(calls) == 16
    result_file = next((run / "results").glob("*.jsonl"))
    rows = [json.loads(line) for line in result_file.read_text().split("\n") if line]
    rows[0]["models"]["A"]["trace_id"] = "wrong-trace"
    write_jsonl(result_file, rows)
    assert not validate_run(run)["valid"]


def test_answer_timing_conversion_missing_values_and_comparison(config):
    data = raw()
    data["meta"].update(first_token_time_cost=0, first_answer_time_cost=1450, finish_answer_time_cost=9349)
    a = adapt(copy.deepcopy(data), config.versions[0], "a.jsonl", 1, None)
    assert a.answer_timing["first_token_seconds"] == 0
    assert a.answer_timing["first_answer_seconds"] == 1.45
    assert a.answer_timing["finish_seconds"] == 9.349
    assert a.answer_timing["source_fields"]["finish_seconds"] == "meta.finish_answer_time_cost"
    b = adapt(raw(), config.versions[1], "b.jsonl", 1, None)
    assert b.answer_timing["finish_seconds"] is None
    assert compare_timing({"A": a.answer_timing, "B": b.answer_timing})["faster_candidate"] is None
    data["meta"]["finish_answer_time_cost"] = 17.883
    b = adapt(data, config.versions[1] | {"timing_unit": "s"}, "b.jsonl", 1, None)
    comparison = compare_timing({"A": a.answer_timing, "B": b.answer_timing})
    assert comparison == {"finish_comparable": True, "faster_candidate": "A", "finish_difference_seconds": 8.534}
    for invalid in (-1, "1000", True, float("nan")):
        data["meta"]["finish_answer_time_cost"] = invalid
        assert adapt(data, config.versions[0], "bad.jsonl", 1, None).answer_timing["finish_seconds"] is None


def test_task_analysis_is_required_and_checked_for_workflow_narration(config):
    from jsonschema import ValidationError
    record = adapt(raw(reference=None), config.versions[0], "input.jsonl", 1, None)
    candidates = {"A": record, "B": record}
    result = fake_evaluation("pairwise", candidates)
    del result["task_analysis"]
    with pytest.raises(ValidationError, match="task_analysis"):
        validate_result(config.schema, "pairwise", result, candidates)
    result = fake_evaluation("pairwise", candidates)
    result["task_analysis"]["goal"] = "没有标准答案，所以只做比较"
    with pytest.raises(ValueError, match="流程说明"):
        validate_result(config.schema, "pairwise", result, candidates)


def test_summary_tampering_is_detected(config, tmp_path, monkeypatch):
    import prime_eval.runner as runner
    fill(config, [[raw(reference=None)], [raw(reference=None)]])
    monkeypatch.setattr(runner, "prepared_prime", lambda _: {"binary": "fake", "version": "0", "sha256": "fake"})

    async def invoke(cfg, prime, stage, candidates, reference, correctness, directory, paths):
        directory.mkdir(parents=True)
        return {"evaluation": fake_evaluation(stage, candidates), "duration_seconds": 99, "viewed_images": []}

    monkeypatch.setattr(runner, "invoke", invoke)
    run = tmp_path / "run"
    asyncio.run(run_evaluation(config, build_plan(config), run, False))
    assert validate_run(run)["valid"]
    row = json.loads((run / "task_summaries.jsonl").read_text())
    assert row["timing"]["measurements"]["A"]["finish_seconds"] is None  # Never use the judge's 99 seconds.
    row["conclusion"]["reason"] = "tampered"
    write_jsonl(run / "task_summaries.jsonl", [row])
    result = validate_run(run)
    assert any("逐题总结" in error for error in result["errors"])


def test_stage_config_is_decoupled(config):
    first = config.fingerprint("correctness")
    config.data["judge"]["pairwise"]["model"] = "another-fast-model"
    assert config.fingerprint("correctness") == first
    config.prompts["correctness"] += "\n新规则"
    assert config.fingerprint("correctness") != first


def test_comparison_does_not_explain_subjective_evaluation_process(config):
    record = adapt(raw(reference=None), config.versions[0], "input.jsonl", 1, None)
    candidates = {"A": record, "B": record}
    result = fake_evaluation("pairwise", candidates)
    result["verdict"]["reason"] = "A更直接，且本题无标准答案、未进行独立正确性判定。"
    with pytest.raises(ValueError, match="流程说明"):
        validate_result(config.schema, "pairwise", result, candidates)
