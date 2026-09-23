from __future__ import annotations

from pathlib import Path

from pi_eval.annotations import annotate_findings
from pi_eval.core import load_config, submission_schema


def trace(quote, index=5, duplicate=False):
    raw = {"messages": [
        {"type": "message", "role": "user", "content": "问题"},
        {"type": "function_call", "name": "FinQuery", "call_id": "f"},
        {"type": "function_call_output", "call_id": "f", "output": "<referencable-result>\nID: 1\n财务数据"},
        {"type": "function_call", "name": "web_search", "call_id": "s"},
        {"type": "function_call_output", "call_id": "s", "output": f"<referencable-result>\nID: {1 if duplicate else 2}\n新闻"},
        {"type": "message", "role": "assistant", "content": "财务数据[^1]。新闻[^2]。"},
    ]}
    finding = {"evidence": [{"message_index": index, "quote": quote}]}
    return annotate_findings(raw, [finding])[0]["stage_trace"]


def test_quote_uses_only_its_own_tool_reference():
    result = trace("财务数据[^1]")
    assert result["tools"] == ["FinQuery"]
    assert result["confidence"] == "high"
    assert result["locations"] == [{"message_index": 2, "tool_name": "FinQuery"}]


def test_direct_tool_message_and_multiple_quoted_tools():
    assert trace("新闻", index=4)["source"] == "evidence_message"
    assert trace("新闻", index=4)["tools"] == ["Search"]
    result = trace("财务数据[^1]。新闻[^2]。")
    assert result["tools"] == ["FinQuery", "Search"]
    assert [item["message_index"] for item in result["locations"]] == [2, 4]


def test_missing_or_ambiguous_quote_reference_does_not_claim_tool_provenance():
    for result in (trace("财务数据"), trace("财务数据[^1]", duplicate=True), trace("未知[^3]")):
        assert result["tools"] == []
        assert result["confidence"] == "medium"
        assert result["candidate_tools"] == ["FinQuery", "Search"]
        assert result["locations"] == [{"message_index": 5, "tool_name": None}]


def test_aa_trace_anchor_and_plain_answer():
    raw = {"messages": [
        {"type": "user_question", "role": "user", "content": "问题"},
        {"type": "tool_call", "name": "finquery_market_data", "id": "f"},
        {"type": "tool_result", "name": "finquery_market_data", "output": {"data": {"serial_number": "abc-123", "text": "财务数据"}}},
        {"type": "final_answer", "role": "assistant", "content": '<trace ref="abc-123">财务数据</trace>'},
    ]}
    finding = {"evidence": [{"message_index": 3, "quote": '<trace ref="abc-123">财务数据</trace>'}]}
    result = annotate_findings(raw, [finding])[0]["stage_trace"]
    assert result["tools"] == ["FinQueryMarketData"]
    assert result["locations"] == [{"message_index": 2, "tool_name": "FinQueryMarketData"}]
    assert result["confidence"] == "high"
    raw["messages"][2]["output"] = '{"serial_number": "abc-123", "text": "财务数据"}'
    assert annotate_findings(raw, [finding])[0]["stage_trace"] == result
    plain = annotate_findings({"messages": [raw["messages"][0], {"type": "final_answer", "content": "回答"}]},
                              [{"evidence": [{"message_index": 1, "quote": "回答"}]}])[0]
    assert plain == {"stage_trace": {"tools": [], "confidence": "none", "source": "none",
                                     "locations": [{"message_index": 1, "tool_name": None}]}}


def test_tool_trace_is_not_a_judge_submission_field():
    config = load_config(Path(__file__).resolve().parents[1] / "configs/pi-eval.toml")
    schema = submission_schema(config.schema, "pairwise")
    finding = schema["properties"]["evaluations"]["properties"]["A"]["properties"]["findings"]["items"]
    assert "stage_trace" not in finding["properties"]
