from __future__ import annotations

from .core import Json
from .presentation import display_text


def compare_timing(measurements: Json) -> Json:
    a, b = (measurements[label]["finish_seconds"] for label in ("A", "B"))
    if a is None or b is None:
        return {"finish_comparable": False, "faster_candidate": None, "finish_difference_seconds": None}
    return {"finish_comparable": True, "faster_candidate": "A" if a < b else "B" if b < a else "tie",
            "finish_difference_seconds": round(abs(a - b), 6)}


def task_summary(task: Json, row: Json, analysis: Json) -> Json:
    timings = {identity["version"]: identity["answer_timing"] for identity in task["candidates"].values()}
    names = {label: row["models"][identity["version"]]["version"] for label, identity in task["candidates"].items()}
    analysis = display_text(analysis, names)
    comparison = compare_timing({label: identity["answer_timing"] for label, identity in task["candidates"].items()})
    faster = comparison.pop("faster_candidate")
    comparison["faster_version"] = task["candidates"][faster]["version"] if faster in ("A", "B") else None
    return {
        "summary_version": "1.1", "comparison_id": row["comparison_id"], "case": row["case"],
        "question": task["candidates"]["A"]["question"],
        "task_type": analysis["task_type"], "goal": analysis["goal"], "requirements": analysis["requirements"],
        "conclusion": row["verdict"],
        "candidates": {label: {"model": row["models"][label], "summary": review["summary"],
                               "strengths": [f for f in review["findings"] if f["type"] == "strength"],
                               "weaknesses": [f for f in review["findings"] if f["type"] == "problem"]}
                       for label, review in row["evaluations"].items()},
        "timing": {"measurements": timings, "comparison": comparison,
                   "analysis": analysis["timing_analysis"]},
        "scoring_points": analysis["scoring_points"], "red_flags": analysis["red_flags"],
    }


def render_summaries(summaries: list[Json]) -> str:
    lines: list[str] = []
    verdicts = {"tie": "平局", "not_comparable": "材料不足以比较"}
    for item in summaries:
        lines += [f"# {item['case']['case_id']}", "", "## 问题", ""]
        lines.extend("> " + line for line in item["question"].splitlines())
        lines += ["", item["goal"], "", "**要点**", ""]
        lines.extend(f"- {text}" for text in item["requirements"])
        conclusion = item["conclusion"]
        title = f"{conclusion['winner_name']} 更好" if conclusion["result"] == "win" else verdicts[conclusion["result"]]
        lines += ["", "## 结论", "", f"**{title}**。{conclusion['reason']}", ""]
        timing_lines = []
        for label, timing in item["timing"]["measurements"].items():
            if timing["finish_seconds"] is not None:
                name = item["candidates"][label]["model"]["version"]
                timing_lines.append(f"{name} {timing['finish_seconds']:.3f}秒")
        if timing_lines:
            lines += ["**回答耗时**：" + "；".join(timing_lines) + "。", ""]
        if item["timing"]["analysis"]:
            lines += [item["timing"]["analysis"], ""]
        for label, review in item["candidates"].items():
            lines += [f"## {review['model']['version']}", "", review["summary"], ""]
            for title, key in (("优势", "strengths"), ("不足", "weaknesses")):
                if not review[key]:
                    continue
                lines += [f"### {title}", ""]
                for finding in review[key]:
                    lines += [f"- **{finding['text']}**：{finding['reason']}", ""]
                    for evidence in finding["evidence"]:
                        quote = evidence["quote"].replace("\n", " ")
                        lines += [f"> 原始消息 #{evidence['message_index']}：{quote}", ""]
        lines += ["## 得分点", ""]
        lines.extend(f"- {text}" for text in item["scoring_points"])
        lines += ["", "## Red flags：不能犯的错误", ""]
        lines.extend(f"- {text}" for text in item["red_flags"])
        lines += ["", "---", ""]
    return "\n".join(lines)
