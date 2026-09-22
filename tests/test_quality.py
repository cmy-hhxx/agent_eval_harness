from __future__ import annotations

import asyncio
import copy
from pathlib import Path

import pytest

from prime_eval.core import digest, load_config, write_json
from prime_eval.prime import JudgeError, invoke
from prime_eval.quality import validate_audit, validate_quality_receipt

ROOT = Path(__file__).resolve().parents[1]


def issue():
    return {"severity": "critical", "category": "consistency", "path": "/verdict/reason", "quote": "完成得更少",
            "problem": "理由与胜负方向相反", "instruction": "重新核对并修正方向"}


def test_audit_feedback_must_locate_actual_draft_text():
    draft = {"verdict": {"reason": "候选完成得更少"}}
    review = {"issues": [issue()]}
    validate_audit(review, draft)
    for bad in ({"path": "/missing"}, {"quote": "不存在的引文"}, {"path": "/verdict"}):
        with pytest.raises(ValueError):
            validate_audit({"issues": [{**issue(), **bad}]}, draft)


@pytest.mark.parametrize("mode", ["passed", "advisory", "revised", "audit_timeout", "repair_timeout"])
def test_light_audit_never_loops_or_blocks_delivery(tmp_path, monkeypatch, mode):
    import prime_eval.prime as prime
    config = load_config(ROOT / "configs/eval.toml")
    draft = {"verdict": {"result": "A_better", "reason": "【候选A】更好。完成得更少"}, "evaluations": {}}
    calls = []

    async def fake_invoke(config, binary, stage, candidates, reference, correctness, directory, paths, extra=None):
        calls.append((stage, extra))
        write_json(directory / "metrics.json", {"usage": {"input": 10, "output": 5}, "tool_calls": 1})
        if stage == "audit":
            if mode == "audit_timeout":
                raise TimeoutError()
            value = {"issues": [] if mode == "passed" else [
                {**issue(), "severity": "minor" if mode == "advisory" else "critical"}]}
        else:
            if extra and mode == "repair_timeout":
                raise TimeoutError()
            value = copy.deepcopy(draft)
            if extra:
                assert extra["revision_feedback"] == [issue()]
                value["verdict"]["reason"] = "【候选A】更好。完成得更多"
        return {"evaluation": value, "usage": {"input": 10, "output": 5}, "tool_calls": 1}

    monkeypatch.setattr(prime, "_invoke", fake_invoke)
    result = asyncio.run(invoke(config, {}, "pairwise", {}, None, {}, tmp_path, {}))
    validate_quality_receipt(result)
    expected = {"audit_timeout": "unavailable", "repair_timeout": "unresolved"}.get(mode, mode)
    assert result["quality_audit"]["status"] == expected
    assert result["quality_audit"]["revision_count"] == (1 if mode == "revised" else 0)
    assert [stage for stage, _ in calls] == ["pairwise", "audit"] + (["pairwise"] if mode in ("revised", "repair_timeout") else [])
    assert result["usage"] == {"input": 10 * len(calls), "output": 5 * len(calls)}
    assert "完成得更少" in (tmp_path / "draft-0.json").read_text()
    if mode != "revised":
        assert result["evaluation"] == draft
    result["evaluation"]["verdict"]["reason"] = "人工改写"
    with pytest.raises(ValueError, match="文本发生变化"):
        validate_quality_receipt(result)


def test_audit_config_changes_invalidate_pairwise_cache_only():
    config = load_config(ROOT / "configs/eval.toml")
    original = {stage: config.fingerprint(stage) for stage in ("pairwise", "correctness")}
    config.prompts["audit"] += "\n更改复核标准"
    assert config.fingerprint("pairwise") != original["pairwise"]
    assert config.fingerprint("correctness") == original["correctness"]


def test_missing_or_failed_quality_receipt_is_rejected():
    evaluation = {"verdict": {"reason": "测试"}}
    for receipt in ({}, {"evaluation_hash": digest(evaluation), "issues": [issue()]}):
        with pytest.raises(ValueError, match="质检"):
            validate_quality_receipt({"evaluation": evaluation, "quality_audit": receipt})
