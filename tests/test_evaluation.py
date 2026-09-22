from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path
from typing import Any

import pytest

from prime_eval.core import adapt, artifact_evidence, build_plan, initial_evidence, load_config, read_json, validate_result, write_json, write_jsonl
from prime_eval.presentation import display_text, save_presentation
from prime_eval.runner import comparison_row, export_results, read_progress, run_evaluation, validate_run
from prime_eval.summaries import compare_timing, render_summaries, task_summary

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
    return {"verdict": {"result": "A_better", "reason": "【候选A】更好。表达更直接。"},
            "task_analysis": {"task_type": "整数加法", "goal": "计算2+2的结果", "requirements": ["给出数值4"],
                              "scoring_points": ["算式与结果一致"], "red_flags": ["将2+2算成5"],
                              "timing_analysis": ""},
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
    assert next(iter(summaries[0]["candidates"].values()))["strengths"][0]["evidence"][0]["quote"] == "答案是 4"
    assert "耗时" not in (run / "task_summaries.md").read_text()
    assert second["correctness"]["A组Fast"]["subjective_not_assessed"] == 1
    assert second["correctness"]["A组Fast"]["correct"] == 1
    asyncio.run(run_evaluation(config, plan, run, True))
    assert len(calls) == 16
    asyncio.run(run_evaluation(config, plan, tmp_path / "new-run", False))
    assert len(calls) == 16
    result_file = next((run / "results").glob("*.jsonl"))
    rows = [json.loads(line) for line in result_file.read_text().split("\n") if line]
    next(iter(rows[0]["models"].values()))["trace_id"] = "wrong-trace"
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
    assert row["timing"]["measurements"]["a_fast"]["finish_seconds"] is None  # Never use the judge's 99 seconds.
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
    result["verdict"]["reason"] = "【候选A】更好。且本题无标准答案、未进行独立正确性判定。"
    with pytest.raises(ValueError, match="流程说明"):
        validate_result(config.schema, "pairwise", result, candidates)


def test_version_names_replace_roles_without_changing_quotes_or_stock_terms(config, tmp_path):
    names = {"A": "AA组Expert", "B": "A组Fast"}
    value = {"summary": "【候选A】更慢；候选 B更快。A使用原始数据，A/B都提及A股、B类及ETF、GDP、ABC。",
             "evidence": [{"quote": "A/B都提及A股"}]}
    mapped = display_text(value, names)
    assert mapped["summary"] == "AA组Expert更慢；A组Fast更快。AA组Expert使用原始数据，AA组Expert/A组Fast都提及A股、B类及ETF、GDP、ABC。"
    assert mapped["evidence"] == value["evidence"]
    assert value["summary"].startswith("【候选A】")
    records = {label: adapt(raw(reference=None), config.versions[index], "in.jsonl", 1, None)
               for label, index in (("A", 1), ("B", 0))}
    task = {"candidates": {key: {**r.identity(), "llm": None} for key, r in records.items()},
            "dependencies": {"A": None, "B": None}, "reference": None, "pair": ["a_fast", "a_expert"]}
    save_presentation(tmp_path, config)
    result = fake_evaluation("pairwise", records)
    row = comparison_row(tmp_path, task, result)
    assert set(row["models"]) == {"a_fast", "a_expert"}
    assert row["verdict"] == {"result": "win", "winner_version": "a_expert", "winner_name": "A组Expert", "reason": "A组Expert更好。表达更直接。"}
    result["verdict"]["result"] = "tie"
    assert comparison_row(tmp_path, task, result)["verdict"]["winner_version"] is None


@pytest.mark.parametrize("supplement", [[], ["A"], ["A", "B"]])
def test_numeric_export_preserves_grounded_verdict(config, tmp_path, supplement):
    records = {label: adapt(raw(reference=None, answer=answer), config.versions[index], "in.jsonl", 1, None)
               for label, index, answer in (("A", 1, "2+2=4"), ("B", 0, "2+3=5"))}
    task = {"id": "numeric", "stage": "pairwise",
            "candidates": {key: {**record.identity(), "llm": None} for key, record in records.items()},
            "dependencies": {"A": None, "B": None}, "reference": None,
            "pair": ["a_fast", "a_expert"]}
    save_presentation(tmp_path, config)
    evaluation = fake_evaluation("pairwise", records)
    evaluation["verdict"]["reason"] = (
        "【候选A】更好。题目已给出2+2，候选A按2+2得到4；候选B擅自改成2+3得到5，核心结果错误。"
        "候选A虽缺少展开说明，但不影响本题计算正确性，因此仍胜出。")
    calculations = [
        {"candidate": "A", "operation": "add", "operands": ["2", "2"], "result": "4"},
        {"candidate": "B", "operation": "add", "operands": ["2", "3"], "result": "5"},
        *[{"candidate": label, "operation": "multiply", "operands": ["4", "100"], "result": "400"}
          for label in supplement],
    ]
    receipt = {"status": "succeeded", "evaluation": evaluation, "calculations": calculations}
    write_json(tmp_path / "tasks" / task["id"] / "result.json", receipt)
    write_json(tmp_path / "manifest.json", {"run_id": "numeric", "status": "finished", "tasks": [task],
                                            "preflight": {}, "started_at": 0, "finished_at": 1})
    export_results(tmp_path)
    row = json.loads((tmp_path / "results" / "a_fast__vs__a_expert.jsonl").read_text())
    expected = display_text(evaluation["verdict"]["reason"], {"A": "A组Expert", "B": "A组Fast"})
    assert row["verdict"]["reason"] == expected
    assert row["verdict"]["winner_version"] == "a_expert"
    summary = json.loads((tmp_path / "task_summaries.jsonl").read_text())
    assert summary["conclusion"]["reason"] == expected
    assert expected.split("。", 1)[1] in render_summaries([summary])
    assert read_json(tmp_path / "tasks" / task["id"] / "result.json") == receipt


def test_verdict_opening_agrees_with_winner_and_ties_are_explicit(config, tmp_path):
    records = {label: adapt(raw(reference=None), config.versions[i], "in.jsonl", 1, None)
               for i, label in enumerate(("A", "B"))}
    result = fake_evaluation("pairwise", records)
    result["verdict"]["reason"] = "【候选B】更好。"
    with pytest.raises(ValueError, match="结论开头"):
        validate_result(config.schema, "pairwise", result, records)
    result["verdict"]["result"] = "tie"
    result["verdict"]["reason"] = "质量相当。"
    with pytest.raises(ValueError, match="两个都好"):
        validate_result(config.schema, "pairwise", result, records)
    for opening in ("两个都好。", "两个都差。"):
        result["verdict"]["reason"] = opening + "双方情况如下。"
        validate_result(config.schema, "pairwise", result, records)
        task = {"candidates": {key: {**r.identity(), "llm": None} for key, r in records.items()},
                "dependencies": {"A": None, "B": None}, "reference": None, "pair": ["a_fast", "a_expert"]}
        save_presentation(tmp_path, config)
        row = comparison_row(tmp_path, task, result)
        markdown = render_summaries([task_summary(task, row, result["task_analysis"])])
        assert markdown.index("**结论：" + opening[:-1]) < markdown.index("## 问题")
        assert "平局" not in markdown


def test_full_answer_survives_soft_budget_and_history_prefers_recent(config):
    answer = "  第一行保持缩进\n\n" + "数据" * 800 + "\n末尾\n"
    record = adapt(raw(answer=answer), config.versions[0], "in.jsonl", 1, None)
    assert record.material(10)["final_answer"] == answer
    bank = initial_evidence(record, "A")
    assert "".join(entry["quote"] for entry in bank) == answer
    assert all(entry["quote"] in answer for entry in bank)
    data = raw()
    data["messages"] = [
        {"type": "message", "role": "user", "content": "旧" * 200},
        {"type": "message", "role": "assistant", "content": "新" * 200},
        *data["messages"],
    ]
    record = adapt(data, config.versions[0], "in.jsonl", 1, None)
    selected = record.material(450)["initial_material"]
    assert {item["message_index"] for item in selected} == {1, 2}


def test_subjective_comparison_runs_while_correctness_is_pending(config, tmp_path, monkeypatch):
    import prime_eval.runner as runner
    fill(config, [[raw(), raw("subjective", reference=None)] for _ in range(2)])
    monkeypatch.setattr(runner, "prepared_prime", lambda _: {"binary": "fake"})
    calls = []

    async def scenario():
        subjective_finished = asyncio.Event()

        async def invoke(cfg, prime, stage, candidates, reference, correctness, directory, paths):
            directory.mkdir(parents=True)
            if stage == "correctness":
                await asyncio.wait_for(subjective_finished.wait(), 1)
            elif reference is None:
                subjective_finished.set()
            calls.append((stage, reference))
            return {"evaluation": fake_evaluation(stage, candidates), "viewed_images": []}

        monkeypatch.setattr(runner, "invoke", invoke)
        return await run_evaluation(config, build_plan(config), tmp_path / "pipeline", False)

    result = asyncio.run(scenario())
    assert calls[0] == ("pairwise", None)
    assert result["task_statuses"] == {"succeeded": 4}


def test_interruption_resume_and_corrupt_receipt_recovery(config, tmp_path, monkeypatch):
    import prime_eval.runner as runner
    fill(config, [[raw("q1", reference=None), raw("q2", reference=None)] for _ in range(2)])
    monkeypatch.setattr(runner, "prepared_prime", lambda _: {"binary": "fake"})
    monkeypatch.setattr(runner, "probe_prime", lambda _: {"binary": "fake"})
    calls = []
    interrupted = False
    exports = []

    def export(run):
        exports.append(run)
        return export_results(run)

    async def invoke(cfg, prime, stage, candidates, reference, correctness, directory, paths):
        nonlocal interrupted
        case = candidates["A"].case
        calls.append(case)
        directory.mkdir(parents=True)
        if case == "q2" and not interrupted:
            interrupted = True
            raise asyncio.CancelledError()
        return {"evaluation": fake_evaluation(stage, candidates), "viewed_images": []}

    monkeypatch.setattr(runner, "invoke", invoke)
    monkeypatch.setattr(runner, "export_results", export)
    plan, run = build_plan(config), tmp_path / "resume"
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(run_evaluation(config, plan, run, False))
    assert len(exports) == 1  # No full report rewrite per task.
    assert read_progress(run)["status"] == "interrupted"
    assert read_progress(run)["task_statuses"] == {"succeeded": 1, "pending": 1}
    result = asyncio.run(run_evaluation(config, plan, run, True))
    assert calls == ["q1", "q2", "q2"]
    assert result["completed_comparisons"] == 2
    assert read_progress(run)["reused_this_session"] == 1
    assert validate_run(run)["valid"]
    task = read_json(run / "manifest.json")["tasks"][0]
    receipt = run / "tasks" / task["id"] / "result.json"
    cached = read_json(receipt)
    (Path(config.data["artifacts"]["cache_dir"]) / "results" / f"{cached['cache_key']}.json").unlink()
    receipt.write_text('{"status":"succeeded","evaluation":{}}')
    asyncio.run(run_evaluation(config, plan, run, True))
    assert calls == ["q1", "q2", "q2", "q1"]
    assert validate_run(run)["valid"]
    config.prompts["pairwise"] += "\nchanged"
    with pytest.raises(ValueError, match="已变化"):
        asyncio.run(run_evaluation(config, plan, run, True))


def test_failed_tasks_require_retry_flag_and_new_inputs_reuse_existing(config, tmp_path, monkeypatch):
    import prime_eval.runner as runner
    from prime_eval.prime import JudgeError
    fill(config, [[raw(reference=None)] for _ in range(2)])
    monkeypatch.setattr(runner, "prepared_prime", lambda _: {"binary": "fake"})
    monkeypatch.setattr(runner, "probe_prime", lambda _: {"binary": "fake"})
    calls = []

    async def invoke(cfg, prime, stage, candidates, reference, correctness, directory, paths):
        calls.append(candidates["A"].case)
        directory.mkdir(parents=True)
        if len(calls) == 1:
            raise JudgeError("synthetic failure")
        return {"evaluation": fake_evaluation(stage, candidates), "viewed_images": []}

    monkeypatch.setattr(runner, "invoke", invoke)
    run, plan = tmp_path / "run", build_plan(config)
    asyncio.run(run_evaluation(config, plan, run, False))
    asyncio.run(run_evaluation(config, plan, run, True))
    assert len(calls) == 1
    asyncio.run(run_evaluation(config, plan, run, True, retry_failed=True))
    assert len(calls) == 2
    fill(config, [[raw(reference=None), raw("q2", reference=None)] for _ in range(2)])
    new_run = tmp_path / "incremental"
    result = asyncio.run(run_evaluation(config, build_plan(config), new_run, False))
    assert calls == ["q1", "q1", "q2"]
    assert result["completed_comparisons"] == 2
    assert read_progress(new_run)["reused_this_session"] == 1
    # Updating presentation regenerates output without touching original judgments.
    task = read_json(new_run / "manifest.json")["tasks"][0]
    receipt = new_run / "tasks" / task["id"] / "result.json"
    before = receipt.read_bytes()
    config.versions[0]["display_name"] = "实验组Fast"
    save_presentation(new_run, config)
    export_results(new_run)
    assert receipt.read_bytes() == before and len(calls) == 3
    assert "实验组Fast" in (new_run / "task_summaries.md").read_text()
    assert validate_run(new_run)["valid"]


def test_editorial_omits_missing_metadata_but_keeps_real_answer_omissions(config, tmp_path):
    records = {label: adapt(raw(reference=None), config.versions[i], "in.jsonl", 1, None)
               for i, label in enumerate(("A", "B"))}
    evaluation = fake_evaluation("pairwise", records)
    for phrase in ("A组Fast耗时数据缺失，不能据此奖励速度。", "双方缺少原始回答完成时间，不比较快慢。", "未发现有证据支持的明显问题。"):
        evaluation["verdict"]["reason"] = "【候选A】更好。" + phrase
        with pytest.raises(ValueError, match="占位话"):
            validate_result(config.schema, "pairwise", evaluation, records)
    evaluation["verdict"]["reason"] = "【候选A】更好。用户要机器人板块的涨停家数，对方答案没有给。"
    validate_result(config.schema, "pairwise", evaluation, records)
    evaluation["task_analysis"]["timing_analysis"] = "慢了70秒。"
    with pytest.raises(ValueError, match="空字符串"):
        validate_result(config.schema, "pairwise", evaluation, records)
    evaluation["task_analysis"]["timing_analysis"] = ""
    records["A"].raw["meta"]["finish_answer_time_cost"] = 8000
    records["B"].raw["meta"]["finish_answer_time_cost"] = 78000
    evaluation["task_analysis"]["timing_analysis"] = "耗时78秒却没有交代涨停家数，多等70秒也没补齐答案。"
    validate_result(config.schema, "pairwise", evaluation, records)
    records["B"].raw["meta"].pop("finish_answer_time_cost")
    evaluation["task_analysis"]["timing_analysis"] = ""
    task = {"candidates": {label: {**r.identity(), "llm": None} for label, r in records.items()},
            "dependencies": {"A": None, "B": None}, "reference": None, "pair": ["a_fast", "a_expert"]}
    save_presentation(tmp_path, config)
    row = comparison_row(tmp_path, task, evaluation)
    markdown = render_summaries([task_summary(task, row, evaluation["task_analysis"])])
    assert "A组Fast 8.000秒" in markdown
    for absent in ("A组Expert 0.000", "缺失", "未发现", "### 不足", "是否触犯", "比较记录", "首 token"):
        assert absent not in markdown


def test_chart_labels_are_exact_current_turn_evidence_not_final_answer(config):
    from prime_eval.prime import prompt_materials
    svg = '<svg><text>涨幅</text><text>209.93%</text><text>涨幅</text></svg>'
    data = raw(reference=None, answer="正文涨幅9.93%")
    data["messages"].insert(1, {"type": "function_call", "input": {"command": svg},
                                "input_messages": [{"content": '<svg><text>旧图999%</text></svg>'}]})
    record = adapt(data, config.versions[0], "chart.jsonl", 1, None)
    labels = artifact_evidence(record, "A")
    assert [entry["quote"] for entry in labels] == ["涨幅", "209.93%"]
    materials = prompt_materials(config, "pairwise", {"A": record}, initial_evidence(record, "A") + labels)
    assert "".join(item["text"] for item in materials["A"]["final_answer"]) == "正文涨幅9.93%"
    assert materials["A"]["artifact_labels"][1]["message_index"] == 1
    assert labels[1]["quote"] in svg
