from __future__ import annotations

import re
from collections import defaultdict

from .core import Json, strings

TRACE_REF = re.compile(r'<trace\b[^>]*(?:anchor|ref)\s*=\s*["\']([^"\']+)', re.I)
TRACE_ID = re.compile(r'\b(?:serial_number|trace_id|anchor|ref|uid|id)\\?["\']?\s*:\s*\\?["\']([^"\'\\]+)', re.I)
ID_FIELDS = {"serial_number", "trace_id", "anchor", "ref", "uid", "id"}


def tool_name(value: str | None) -> str | None:
    if not value:
        return None
    return {"search": "Search", "web_search": "Search", "finquery": "FinQuery",
            "finquery_market_data": "FinQueryMarketData", "web_fetch": "WebFetch",
            "accessingfulltext": "AccessingFullText", "codeinterpreter": "CodeInterpreter",
            "backtest": "Backtest", "tickerchart": "TickerChart"}.get(value.lower().replace("-", "_"), value)


def annotate_findings(raw: Json, findings: list[Json]) -> list[Json]:
    """Locate cited messages and resolve only references present in each finding's quotes."""
    messages = raw["messages"]
    calls = {}
    for message in messages:
        if message.get("type") in ("function_call", "tool_call"):
            for key in ("call_id", "id"):
                if message.get(key):
                    calls[str(message[key])] = tool_name(message.get("name"))
    direct = {}
    for index, message in enumerate(messages):
        kind = message.get("type")
        name = (calls.get(str(message.get("call_id"))) if kind == "function_call_output" else
                tool_name(message.get("name")) if kind in ("function_call", "tool_call", "tool_result") else None)
        if name:
            direct[index] = name
    last_user = max((i for i, m in enumerate(messages) if m.get("type") == "user_question" or m.get("role") == "user"), default=-1)
    final = max((i for i, m in enumerate(messages) if m.get("type") == "final_answer" or
                 (m.get("type") == "message" and m.get("role") == "assistant")), default=-1)
    candidates = sorted({name for i, name in direct.items() if last_user < i < final})
    citations: dict[str, set[int]] = defaultdict(set)
    anchors: dict[str, set[int]] = defaultdict(set)
    for index, name in direct.items():
        message = messages[index]
        if not last_user < index < final or message.get("type") not in ("function_call_output", "tool_result"):
            continue
        for path, text in strings(message.get("output", message.get("content", ""))):
            for ref in re.findall(r'<referencable-result>\s*ID:\s*(\d+)', text, re.I):
                citations[ref].add(index)
            refs = set(TRACE_REF.findall(text)) | set(TRACE_ID.findall(text))
            if path.rsplit("/", 1)[-1] in ID_FIELDS:
                refs.add(text)
            for ref in refs:
                anchors[ref].add(index)

    annotations = []
    for finding in findings:
        evidence_indices = set()
        cited_indices = set()
        quote_citations = set()
        quote_anchors = set()
        for evidence in finding["evidence"]:
            index, quote = evidence["message_index"], evidence["quote"]
            evidence_indices.add(index)
            if index in direct:
                cited_indices.add(index)
            quote_citations.update(re.findall(r'\[\^(\d+)\]', quote))
            quote_anchors.update(TRACE_REF.findall(quote))
        resolved = [citations[ref] for ref in sorted(quote_citations)] + [anchors[ref] for ref in sorted(quote_anchors)]
        resolved_indices = {i for indices in resolved if len({direct[i] for i in indices}) == 1 for i in indices}
        sources = cited_indices | resolved_indices
        tools = sorted({direct[i] for i in sources})
        ambiguous = any(len({direct[i] for i in indices}) != 1 for indices in resolved)
        confidence = "high" if tools and not ambiguous else "medium" if tools or candidates else "none"
        source = ("evidence_message" if cited_indices else "quote_reference" if tools else
                  "same_turn_tool_chain" if candidates else "none")
        trace: Json = {"tools": tools, "confidence": confidence, "source": source,
                       "locations": [{"message_index": i, "tool_name": direct.get(i)} for i in sorted(sources or evidence_indices)]}
        if confidence != "high" and candidates:
            trace["candidate_tools"] = candidates
        annotations.append({"stage_trace": trace})
    return annotations
