from __future__ import annotations

from typing import Any

from .core import Json, Record, content_text, digest, strings


def audit_paths(draft: Json) -> list[str]:
    return [path for path, _ in strings(draft)
            if path == "/verdict/reason" or path.startswith("/task_analysis/")
            or (path.startswith("/evaluations/") and path.rsplit("/", 1)[-1] in ("summary", "text", "reason"))]


def audit_materials(candidates: dict[str, Record], draft: Json) -> Json:
    """Keep full final answers and context around cited evidence, not the entire trace."""
    materials = {}
    for label, record in candidates.items():
        messages = record.raw["messages"]
        cited = []
        seen = set()
        for finding in draft["evaluation"]["evaluations"][label]["findings"]:
            for evidence in finding["evidence"]:
                index, quote = evidence["message_index"], evidence["quote"]
                if index == record.final_index or (index, quote) in seen:
                    continue
                seen.add((index, quote))
                context = []
                for path, text in strings(messages[index]):
                    position = text.find(quote)
                    if position >= 0 and not path.startswith("/input_messages"):
                        context.append({"path": path, "text": text[max(0, position - 800):position + len(quote) + 800]})
                cited.append({**evidence, "context": context[:2]})
        # Recent dialogue resolves anaphora; earlier traces remain available via read/search.
        dialogue = [{"message_index": i, "role": message.get("role"),
                     "text": content_text(message.get("content"))}
                    for i, message in enumerate(messages[:record.final_index])
                    if message.get("role") in ("user", "assistant") and message.get("content")]
        materials[label] = {"question": record.question,
                            "final_answer": content_text(messages[record.final_index].get("content")),
                            "recent_dialogue": dialogue[-4:], "cited_context": cited}
    return {"draft": draft["evaluation"], "source_answers": materials,
            "calculations": draft.get("calculations", [])}


def validate_audit(audit: Json, draft: Json) -> None:
    for issue in audit["issues"]:
        value: Any = draft
        path = issue["path"]
        if not path.startswith("/"):
            raise ValueError("复核 path 必须是指向草稿的 JSON Pointer")
        try:
            for part in path[1:].split("/"):
                key = part.replace("~1", "/").replace("~0", "~")
                value = value[int(key)] if isinstance(value, list) and key.isdecimal() else value[key]
        except (KeyError, IndexError, TypeError, ValueError):
            raise ValueError(f"复核 path 不存在: {path}") from None
        if not isinstance(value, str) or not issue["quote"] or issue["quote"] not in value:
            raise ValueError(f"复核 quote 不是草稿逐字原文: {path}")


def validate_quality_receipt(result: Json) -> None:
    receipt = result.get("quality_audit", {})
    if (receipt.get("evaluation_hash") != digest(result["evaluation"])
            or receipt.get("status") not in ("passed", "advisory", "revised", "unavailable", "unresolved")):
        raise ValueError("比较结果缺少质检状态记录，或质检后文本发生变化")
