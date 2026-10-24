"""Canonical business labels and answer efficiency metrics for cleaned inputs."""
from copy import deepcopy
import math


def rued_to_difficulty(R: int, U: int, E: int, D: int) -> dict:
    if not all(type(value) is int for value in (R, U, E, D)):
        raise ValueError("R、U、E、D 必须是整数")
    if not (0 <= R <= 8 and 0 <= U <= 3 and 0 <= E <= 7 and D >= 1):
        raise ValueError("要求 R∈[0,8]、U∈[0,3]、E∈[0,7]、D≥1")
    # The sigmoid already rounds to 1 at this distance; avoid overflowing for unbounded D.
    eta = (0.9783441714100146 * R + 1.5687846715589533 * U
           + 0.705878816282252 * E + 1.4419084167224514 * (min(D, 1000) - 1))
    score = 50 * (1 / (1 + math.exp(1.3944910557482442 - eta))
                  + 1 / (1 + math.exp(5.496550951538168 - eta)))
    difficulty = "简单" if score <= 26.261252253428474 else "中等" if score <= 73.73874774657152 else "复杂"
    return {"difficulty": difficulty, "score": score}


def normalize_meta(source: dict, issues: list | None = None) -> dict:
    """Invalid optional metrics become null, never zero or a reason to drop an answer.

    Keep source-specific metadata and info for provenance; consumers use the canonical
    top-level labels, millisecond costs and usage. Never infer metrics from traces.
    """
    meta = deepcopy(source)
    issues = issues if issues is not None else []

    def warn(field, reason, error):
        issues.append({"field": "meta." + field, "reason": reason, "error": error})

    def count(value, field, *, integral_float=False):
        if value is None:
            return None
        if type(value) is int and 0 <= value <= 9007199254740991:
            return value
        if (integral_float and type(value) is float and math.isfinite(value)
                and 0 <= value <= 9007199254740991 and value.is_integer()):
            return int(value)
        warn(field, "metadata_invalid", "应为非负安全整数，已记为未知")
        return None

    info = meta.get("info")
    if info is not None and not isinstance(info, dict):
        warn("info", "metadata_invalid", "应为对象，未用于补充标签")
    info = info if isinstance(info, dict) else {}
    label_fields = ("task", "subtask", "agent_mode", "difficulty", "difficulty_reason",
                    "rued", "rued_reason", "testset_name")
    for field in label_fields:
        direct, nested = meta.get(field), info.get(field)
        if isinstance(direct, str):
            direct = direct.strip()
            meta[field] = direct
        if isinstance(nested, str):
            nested = nested.strip()
        if direct in (None, "") and nested not in (None, ""):
            meta[field] = deepcopy(nested)
        elif direct not in (None, "") and nested not in (None, "") and direct != nested:
            warn(field, "metadata_conflict", "与 meta.info 同名字段冲突，保留 meta 直接值")
        if field not in ("rued", "rued_reason") and meta.get(field) is not None and not isinstance(meta[field], str):
            warn(field, "metadata_invalid", "标签应为字符串，已记为未知")
            meta[field] = None
    if meta.get("rued") is not None:
        rued = meta["rued"]
        try:
            if not isinstance(rued, dict) or any(key not in rued for key in ("R", "U", "E", "D")):
                raise ValueError("rued 必须是包含 R、U、E、D 的对象")
            result = rued_to_difficulty(*(rued[key] for key in ("R", "U", "E", "D")))
        except ValueError as exc:
            meta["difficulty_score"] = None
            warn("rued", "rued_invalid", str(exc))
        else:
            meta["difficulty_score"] = result["score"]
            if not meta.get("difficulty"):
                meta["difficulty"] = result["difficulty"]
            elif meta["difficulty"] != result["difficulty"]:
                warn("difficulty", "difficulty_conflict",
                     f"既有标签 {meta['difficulty']}；RUED 计算为 {result['difficulty']}，保留既有标签")

    for field in ("first_token_time_cost", "first_answer_time_cost", "finish_answer_time_cost", "answer_len", "visual_count"):
        if field in meta:
            meta[field] = count(meta[field], field, integral_float=field.endswith("_time_cost"))
    for field in ("has_visual",):
        if type(meta.get(field)) is int and meta[field] in (0, 1):
            meta[field] = bool(meta[field])
        if meta.get(field) is not None and type(meta[field]) is not bool:
            warn(field, "metadata_invalid", "应为布尔值，已记为未知")
            meta[field] = None
    # These are redundant source representations, not alternative business metrics.
    for field in ("cost", "first_cost", "first_answer_cost"):
        meta.pop(field, None)

    if "usage" in meta or any(field in meta for field in ("input_tokens", "output_tokens", "cached_read_tokens")):
        usage = meta.get("usage")
        if usage is not None and not isinstance(usage, dict):
            warn("usage", "metadata_invalid", "应为对象，Token 指标已记为未知")
            usage = {"input_tokens": None, "output_tokens": None}
        usage = dict(usage or {})
        for field in ("input_tokens", "output_tokens"):
            if field not in usage:
                usage[field] = meta.get(field)
            elif meta.get(field) is not None and meta[field] != usage[field]:
                warn("usage." + field, "metadata_conflict", "与扁平字段冲突，使用 usage 值")
            usage[field] = count(usage[field], "usage." + field)
        total = count(usage.get("total_tokens"), "usage.total_tokens")
        incoming, outgoing = usage["input_tokens"], usage["output_tokens"]
        if incoming is not None and outgoing is not None:
            if "total_tokens" not in usage:
                total = count(incoming + outgoing, "usage.total_tokens")
            elif total is not None and total != incoming + outgoing:
                warn("usage.total_tokens", "metadata_conflict", "与输入及输出 Token 之和不一致，已记为未知")
                total = None
        usage["total_tokens"] = total
        details = usage.get("input_tokens_details")
        if details is not None and not isinstance(details, dict):
            warn("usage.input_tokens_details", "metadata_invalid", "应为对象，缓存量已记为未知")
            details = {"cached_tokens": None}
        details = dict(details or {})
        cached = details.get("cached_tokens") if "cached_tokens" in details else usage.get("cached_read_tokens", meta.get("cached_read_tokens"))
        if "cached_tokens" in details and usage.get("cached_read_tokens") is not None and usage["cached_read_tokens"] != cached:
            warn("usage.input_tokens_details.cached_tokens", "metadata_conflict", "缓存字段冲突，使用 input_tokens_details 值")
        if ("cached_tokens" in details or "cached_read_tokens" in usage) and meta.get("cached_read_tokens") is not None and meta["cached_read_tokens"] != cached:
            warn("usage.input_tokens_details.cached_tokens", "metadata_conflict", "与扁平缓存字段冲突，使用 usage 值")
        cached = count(cached, "usage.input_tokens_details.cached_tokens")
        if cached is not None and incoming is not None and cached > incoming:
            warn("usage.input_tokens_details.cached_tokens", "metadata_conflict", "缓存 Token 超过输入 Token，已记为未知")
            cached = None
        details["cached_tokens"] = cached
        usage["input_tokens_details"] = details
        usage.pop("cached_read_tokens", None)
        meta["usage"] = usage
        for field in ("input_tokens", "output_tokens", "cached_read_tokens"):
            meta.pop(field, None)
    return meta
