from __future__ import annotations

from .core import Json


def compare_timing(measurements: Json) -> Json:
    a, b = (measurements[label]["finish_seconds"] for label in ("A", "B"))
    if a is None or b is None:
        return {"finish_comparable": False, "faster_candidate": None, "finish_difference_seconds": None}
    return {"finish_comparable": True, "faster_candidate": "A" if a < b else "B" if b < a else "tie",
            "finish_difference_seconds": round(abs(a - b), 6)}


def task_summary(task: Json, row: Json, analysis: Json) -> Json:
    timings = {label: identity["answer_timing"] for label, identity in task["candidates"].items()}
    return {
        "summary_version": "1.0", "comparison_id": row["comparison_id"], "case": row["case"],
        "question": task["candidates"]["A"]["question"],
        "task_type": analysis["task_type"], "goal": analysis["goal"], "requirements": analysis["requirements"],
        "conclusion": row["verdict"],
        "candidates": {label: {"model": row["models"][label], "summary": review["summary"],
                               "strengths": [f for f in review["findings"] if f["type"] == "strength"],
                               "weaknesses": [f for f in review["findings"] if f["type"] == "problem"]}
                       for label, review in row["evaluations"].items()},
        "timing": {"measurements": timings, "comparison": compare_timing(timings),
                   "analysis": analysis["timing_analysis"]},
        "scoring_points": analysis["scoring_points"], "red_flags": analysis["red_flags"],
    }


def render_summaries(summaries: list[Json]) -> str:
    lines: list[str] = []
    verdicts = {"A_better": "候选 A 更好", "B_better": "候选 B 更好", "tie": "平局", "not_comparable": "材料不足以比较"}
    for item in summaries:
        lines += [f"# {item['case']['case_id']}", "", f"比较记录：`{item['comparison_id']}`", "",
                  "## 问题明细", "", "**原始问题**", ""]
        lines.extend("> " + line for line in item["question"].splitlines())
        lines += ["", f"**任务类型**：{item['task_type']}", "", f"**任务目标**：{item['goal']}", "", "**核心要求**", ""]
        lines.extend(f"- {text}" for text in item["requirements"])
        lines += ["", "## 测评结论", "", f"**{verdicts[item['conclusion']['result']]}**。{item['conclusion']['reason']}", "",
                  "## 原始回答耗时", "", "| 候选及实际版本 | 首 token（秒） | 首回答（秒） | 完成（秒） |",
                  "|---|---:|---:|---:|"]
        for label, timing in item["timing"]["measurements"].items():
            values = ["缺失" if timing[key] is None else f"{timing[key]:.3f}"
                      for key in ("first_token_seconds", "first_answer_seconds", "finish_seconds")]
            name = item["candidates"][label]["model"]["version"]
            lines.append(f"| {label} · {name} | {' | '.join(values)} |")
        lines += ["", item["timing"]["analysis"], ""]
        for label, review in item["candidates"].items():
            lines += [f"## 候选 {label} · {review['model']['version']}：优劣势", "", review["summary"], ""]
            for title, key in (("优势", "strengths"), ("不足", "weaknesses")):
                lines += [f"### {title}", ""]
                if not review[key]:
                    lines += ["未发现有证据支持的明显" + ("优势。" if key == "strengths" else "问题。"), ""]
                for finding in review[key]:
                    lines += [f"- **{finding['text']}**：{finding['reason']}", ""]
                    for evidence in finding["evidence"]:
                        quote = evidence["quote"].replace("\n", " ")
                        lines += [f"> 原始消息 #{evidence['message_index']}：{quote}", ""]
        lines += ["## 此类任务的得分点", ""]
        lines.extend(f"- {text}" for text in item["scoring_points"])
        lines += ["", "## Red flags：不能犯的错误", ""]
        lines.extend(f"- {text}" for text in item["red_flags"])
        lines += ["", "红线列出此类题的判分标准；是否触犯，以以上有证据的具体发现为准。", "", "---", ""]
    return "\n".join(lines)
