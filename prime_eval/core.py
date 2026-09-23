from __future__ import annotations

import hashlib
import itertools
import json
import math
import os
import re
import tempfile
import tomllib
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any, Iterator

from jsonschema import Draft202012Validator

Json = dict[str, Any]
ADAPTER_VERSION = "1"
ALLOWED_PAIRS = (("a_fast", "aa_fast"), ("a_expert", "aa_expert"))


def comparison_pair(versions: list[str]) -> tuple[str, str]:
    for pair in ALLOWED_PAIRS:
        if len(versions) == 2 and set(versions) == set(pair):
            return pair
    raise ValueError(f"不允许的对比: {versions}；仅允许 A Fast ↔ AA Fast、A Expert ↔ AA Expert")


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(encode(value).encode()).hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def write_json(path: Path, value: Any) -> None:
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def write_jsonl(path: Path, values: list[Json]) -> None:
    atomic_text(path, "".join(encode(value) + "\n" for value in values))


def strings(value: Any, path: str = "") -> Iterator[tuple[str, str]]:
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from strings(child, f"{path}/{index}")
    elif isinstance(value, dict):
        for key, child in value.items():
            escaped = str(key).replace("~", "~0").replace("/", "~1")
            yield from strings(child, f"{path}/{escaped}")


def content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(content_text(item) for item in value if isinstance(item, (str, dict)))
    if isinstance(value, dict):
        return str(value.get("text", ""))
    return ""


def normalize_question(value: str) -> str:
    return re.sub(r"\s+", "", value).strip()


@dataclass
class Config:
    path: Path
    data: Json
    schema: Json
    prompts: dict[str, str]

    @property
    def versions(self) -> list[Json]:
        return self.data["inputs"]["versions"]

    def judge(self, stage: str) -> Json:
        shared = self.data["judge"]
        return {**{k: v for k, v in shared.items() if k not in ("correctness", "pairwise")}, **shared[stage]}

    def fingerprint(self, stage: str | None = None) -> str:
        # Paths/filtering/concurrency do not change an individual judgment.
        engine = {p.name: p.read_text() for p in sorted(Path(__file__).parent.glob("*.py"))}
        execution = self.data["execution"]
        return digest({
            "judge": self.judge(stage) if stage else self.data["judge"],
            "schema": stage_schema(self.schema, stage) if stage else self.schema,
            "prompts": {k: v for k, v in self.prompts.items() if not stage or k in ("system", stage, "repair")},
            "extension": Path(self.data["artifacts"]["extension"]).read_text(),
            "adapter": ADAPTER_VERSION, "engine": engine,
            "timing_units": {v["id"]: v["timing_unit"] for v in self.versions},
            "settings": {k: execution[k] for k in ("initial_context_chars", "max_tool_calls", "seed", "repair_attempts")},
        })


def load_config(path: Path) -> Config:
    path = path.resolve()
    with path.open("rb") as stream:
        data = tomllib.load(stream)
    for section in ("inputs", "judge", "execution", "prompts", "artifacts"):
        if section not in data:
            raise ValueError(f"配置缺少 {section}")
    for item in data["inputs"]["versions"]:
        item.setdefault("timing_unit", data["inputs"].get("timing_unit", "ms"))
        if item["timing_unit"] not in ("ms", "s"):
            raise ValueError("inputs.timing_unit 必须为 ms 或 s")
        if not re.fullmatch(r"[a-z][a-z0-9_]*", item["id"]):
            raise ValueError(f"非法版本 id: {item['id']}")
        if item["adapter"] not in ("a", "aa"):
            raise ValueError("adapter 必须为 a 或 aa")
        item["path"] = str((path.parent / item["path"]).resolve())
    versions = data["inputs"]["versions"]
    if len(versions) < 2 or len({v["id"] for v in versions}) != len(versions) or len({v["name"] for v in versions}) != len(versions):
        raise ValueError("至少需要两个版本，id 和 name 均不得重复")
    display_names = [v.get("display_name", v["name"]) for v in versions]
    if any(not isinstance(name, str) or not name.strip() for name in display_names) or len(set(display_names)) != len(versions):
        raise ValueError("display_name 必须非空且不得重复")
    data["execution"].setdefault("report_interval_seconds", 30)
    for key in ("concurrency", "timeout_seconds", "idle_timeout_seconds", "max_tool_calls", "initial_context_chars", "report_interval_seconds"):
        if not isinstance(data["execution"][key], int) or data["execution"][key] <= 0:
            raise ValueError(f"execution.{key} 必须为正整数")
    for key in ("retries", "repair_attempts", "retry_delay_seconds"):
        if not isinstance(data["execution"][key], int) or data["execution"][key] < 0:
            raise ValueError(f"execution.{key} 必须为非负整数")
    for stage in ("correctness", "pairwise"):
        for key in ("context_window", "max_output_tokens"):
            if not isinstance(data["judge"][stage][key], int) or data["judge"][stage][key] <= 0:
                raise ValueError(f"judge.{stage}.{key} 必须为正整数")
    if data["judge"]["api"] not in ("openai-completions", "openai-responses"):
        raise ValueError("judge.api 必须为 openai-completions 或 openai-responses")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", data["judge"]["api_key_env"]):
        raise ValueError("api_key_env 必须是环境变量名，不是密钥值")
    for section in ("prompts", "artifacts"):
        for key, value in data[section].items():
            data[section][key] = str((path.parent / value).resolve())
    prompts = {name: Path(p).read_text(encoding="utf-8") for name, p in data["prompts"].items()}
    schema = read_json(Path(data["artifacts"]["schema"]))
    Draft202012Validator.check_schema(schema)
    return Config(path, data, schema, prompts)


@dataclass
class Record:
    batch: str
    case: str
    version: str
    name: str
    raw: Json
    source: str
    line: int
    question: str
    final_index: int
    reference: Any
    llm: str | None
    timing_unit: str = "ms"

    @property
    def key(self) -> tuple[str, str, str]:
        return self.batch, self.case, self.version

    @cached_property
    def hash(self) -> str:
        return digest(self.raw)

    @property
    def trace_id(self) -> str | None:
        value = self.raw.get("trace_id") or self.raw.get("meta", {}).get("trace_id")
        return str(value) if value else None

    def identity(self) -> Json:
        return {"batch_id": self.batch, "case_id": self.case, "version": self.version, "name": self.name,
                "input_hash": self.hash, "trace_id": self.trace_id, "source": self.source, "line": self.line,
                "question": self.question, "answer_timing": self.answer_timing}

    @property
    def answer_timing(self) -> Json:
        fields = {"first_token_seconds": "first_token_time_cost", "first_answer_seconds": "first_answer_time_cost",
                  "finish_seconds": "finish_answer_time_cost"}
        meta = self.raw.get("meta") or {}
        values = {key: meta.get(field) for key, field in fields.items()}
        seconds = {key: (value / (1000 if self.timing_unit == "ms" else 1)
                        if isinstance(value, (int, float)) and not isinstance(value, bool)
                        and math.isfinite(value) and value >= 0 else None) for key, value in values.items()}
        return {**seconds, "source_unit": self.timing_unit, "source_values": values,
                "source_fields": {key: f"meta.{field}" for key, field in fields.items()}}

    def material(self, budget: int) -> Json:
        messages = self.raw["messages"]
        final = content_text(messages[self.final_index].get("content"))
        displayed: list[Json] = []
        used = len(final) + len(self.question)
        # Current answer and history always take priority over system/tool bulk.
        priorities = sorted(range(len(messages)), key=lambda i: (messages[i].get("role") not in ("user", "assistant"), -i))
        for i in priorities:
            if i == self.final_index:
                continue
            message = messages[i]
            # llm_turn.input_messages repeats history; leave it available via tools.
            visible = {k: v for k, v in message.items() if k not in ("input_messages", "model", "model_parameters")}
            text = encode(visible)
            if used + len(text) <= budget and "data:image/" not in text:
                displayed.append({"message_index": i, "value": visible})
                used += len(text)
        displayed.sort(key=lambda item: item["message_index"])
        return {
            "question": self.question, "final_answer": final, "final_message_index": self.final_index,
            "catalog": [{"message_index": i, "type": m.get("type", "message"), "role": m.get("role"),
                         "name": m.get("name"), "chars": len(encode(m))} for i, m in enumerate(messages)],
            "initial_material": displayed,
            "note": "完整问题和最终回答已展示；catalog 中其他内容可通过本地工具按索引查阅，不代表已被裁剪删除。",
        }


def adapt(raw: Json, item: Json, source: str, line: int, default_batch: str | None) -> Record:
    meta = raw.get("meta") or {}
    batch = raw.get("batch_id") or meta.get("batch_id") or default_batch
    case = raw.get("case_id") or meta.get("case_id")
    if not batch or not case:
        raise ValueError("缺少 batch_id 或 case_id；旧输入请在配置中提供 default_batch_id")
    if raw.get("version") and raw["version"] != item["name"]:
        raise ValueError("输入 version 与配置版本不一致")
    if raw.get("case_id") and meta.get("case_id") and raw["case_id"] != meta["case_id"]:
        raise ValueError("顶层 case_id 与 meta.case_id 冲突")
    messages = raw.get("messages")
    if meta.get("ok") is False or not isinstance(messages, list) or not messages:
        raise ValueError("缺少有效回答或采集失败")
    if not all(isinstance(m, dict) for m in messages):
        raise ValueError("messages 必须为对象数组")
    supported = ({"message", "reasoning", "function_call", "function_call_output"} if item["adapter"] == "a"
                 else {"user_question", "llm_turn", "tool_call", "tool_result", "final_answer"})
    if any(m.get("type", "message") not in supported for m in messages):
        raise ValueError("链路含未支持的消息类型")
    users = [i for i, m in enumerate(messages) if m.get("role") == "user"]
    if not users:
        raise ValueError("无法定位用户问题")
    last_user = users[-1]
    finals = [i for i, m in enumerate(messages) if i > last_user and m.get("role") == "assistant" and content_text(m.get("content")).strip()]
    if not finals:
        raise ValueError("最后一轮没有完整最终回答")
    question_content = messages[last_user].get("content")
    # A's later content blocks are explicitly generated device/time metadata.
    question = content_text(question_content[:1] if isinstance(question_content, list) else question_content).strip()
    if not question:
        question = str(meta.get("question") or "").strip()
    if not question:
        raise ValueError("用户问题为空")
    if meta.get("question") and normalize_question(question) != normalize_question(meta["question"]):
        raise ValueError("meta.question 与最后一条用户问题不一致")
    references = [meta[k] for k in ("ground_truth", "std_answer") if meta.get(k) not in (None, "")]
    if len({encode(v) for v in references}) > 1:
        raise ValueError("ground_truth 与 std_answer 冲突")
    llm = (meta.get("usage") or {}).get("type")
    if item["adapter"] == "aa":
        llm = next((m.get("model") for m in reversed(messages[:finals[-1]]) if m.get("type") == "llm_turn" and m.get("model")), llm)
    return Record(str(batch), str(case), item["id"], item["name"], raw, source, line, question, finals[-1],
                  references[0] if references else None, str(llm) if llm else None, item.get("timing_unit", "ms"))


@dataclass
class EvaluationPlan:
    records: dict[tuple[str, str, str], Record] = field(default_factory=dict)
    pairs: list[tuple[Record, Record]] = field(default_factory=list)
    issues: list[Json] = field(default_factory=list)
    skipped: list[Json] = field(default_factory=list)
    references: dict[tuple[str, str], Any] = field(default_factory=dict)

    def summary(self) -> Json:
        return {"valid_inputs": len(self.records), "cases": len({r.key[:2] for r in self.records.values()}),
                "correctness_tasks": len({r.key for pair in self.pairs for r in pair if self.references[r.key[:2]] is not None}),
                "subjective_inputs_skipping_correctness": len({r.key for pair in self.pairs for r in pair if self.references[r.key[:2]] is None}),
                "pairwise_tasks": len(self.pairs),
                "allowed_pairs": [list(pair) for pair in ALLOWED_PAIRS],
                "pair_counts": {name: sum(f"{a.version}__vs__{b.version}" == name for a, b in self.pairs)
                                for name in sorted({f"{a.version}__vs__{b.version}" for a, b in self.pairs})},
                "issues": self.issues, "skipped": self.skipped}


def build_plan(config: Config, batches: list[str] | None = None, cases: list[str] | None = None, limit: int | None = None) -> EvaluationPlan:
    plan = EvaluationPlan()
    inputs = config.data["inputs"]
    batch_filter, case_filter = set(batches or inputs.get("batches", [])), set(cases or inputs.get("case_ids", []))
    seen: set[tuple[str, str, str]] = set()
    invalid: set[tuple[str, str, str]] = set()
    all_cases: set[tuple[str, str]] = set()
    for item in config.versions:
        path = Path(item["path"])
        if not path.is_file():
            plan.issues.append({"source": str(path), "reason": "input_file_missing", "version": item["id"]})
            continue
        with path.open(encoding="utf-8-sig") as stream:
            for line, text in enumerate(stream, 1):
                if not text.strip():
                    continue
                key = None
                try:
                    raw = json.loads(text)
                    if not isinstance(raw, dict):
                        raise ValueError("JSONL 每行必须为对象")
                    batch = raw.get("batch_id") or (raw.get("meta") or {}).get("batch_id") or inputs.get("default_batch_id")
                    case = raw.get("case_id") or (raw.get("meta") or {}).get("case_id")
                    if batch_filter and batch not in batch_filter or case_filter and case not in case_filter:
                        continue
                    if batch and case:
                        key = (str(batch), str(case), item["id"])
                        all_cases.add(key[:2])
                        if key in seen:
                            invalid.add(key)
                            plan.records.pop(key, None)
                            raise ValueError("duplicate_input: 同一批次、case、版本出现多条记录")
                        seen.add(key)
                    record = adapt(raw, item, str(path), line, inputs.get("default_batch_id"))
                    if record.key not in invalid:
                        plan.records[record.key] = record
                except (ValueError, TypeError, KeyError) as error:
                    if key:
                        invalid.add(key)
                        plan.records.pop(key, None)
                    plan.issues.append({"source": str(path), "line": line, "identity": key, "reason": str(error)})
    selected_cases = sorted(all_cases)[:limit] if limit is not None else sorted(all_cases)
    plan.records = {key: record for key, record in plan.records.items() if key[:2] in selected_cases}
    configured = {v["id"] for v in config.versions}
    for batch, case in selected_cases:
        records = [plan.records[(batch, case, v["id"])] for v in config.versions if (batch, case, v["id"]) in plan.records]
        references = {encode(r.reference): r.reference for r in records if r.reference is not None}
        conflict = len({normalize_question(r.question) for r in records}) > 1 or len(references) > 1
        plan.references[(batch, case)] = next(iter(references.values()), None)
        if conflict:
            plan.issues.append({"batch_id": batch, "case_id": case, "reason": "question_or_reference_conflict"})
        for a, b in ALLOWED_PAIRS:
            if not {a, b} <= configured:
                continue
            left, right = plan.records.get((batch, case, a)), plan.records.get((batch, case, b))
            if left and right and not conflict:
                plan.pairs.append((left, right))
            else:
                plan.skipped.append({"batch_id": batch, "case_id": case, "versions": [a, b],
                                     "reason": "case_conflict" if conflict else "missing_or_invalid_answer",
                                     "missing": [v for v, r in ((a, left), (b, right)) if r is None]})
    return plan


def stage_schema(schema: Json, stage: str) -> Json:
    def expand(node: Any) -> Any:
        if isinstance(node, list):
            return [expand(v) for v in node]
        if isinstance(node, dict):
            if "$ref" in node:
                return expand(schema["$defs"][node["$ref"].rsplit("/", 1)[1]])
            return {k: expand(v) for k, v in node.items()}
        return node
    return expand(schema["$defs"][stage])


def submission_schema(schema: Json, stage: str) -> Json:
    """Use verified source handles on the wire; expand them to output evidence locally."""
    result = stage_schema(schema, stage)

    def replace(node: Any) -> None:
        if isinstance(node, dict):
            # Tool provenance is derived locally from the original trace, never guessed by the judge.
            node.get("properties", {}).pop("stage_trace", None)
            if "evidence" in node.get("properties", {}):
                node["properties"]["evidence"]["items"] = {
                    "type": "object", "additionalProperties": False, "required": ["ref"],
                    "properties": {"ref": {"type": "string"}},
                }
            for child in node.values():
                replace(child)
        elif isinstance(node, list):
            for child in node:
                replace(child)
    replace(result)
    return result


def initial_evidence(record: Record, candidate: str) -> list[Json]:
    bank: list[Json] = []
    for path, text in strings(record.raw["messages"][record.final_index].get("content"), "/content"):
        if path != "/content" and not path.endswith("/text"):
            continue
        for line in text.splitlines(keepends=True):
            for offset in range(0, len(line), 640):
                quote = line[offset:offset + 640]
                if not quote:
                    continue
                bank.append({"ref": f"{candidate}-{record.final_index}-{len(bank)}", "candidate": candidate,
                             "message_index": record.final_index, "quote": quote, "path": path})
    return bank


def artifact_evidence(record: Record, candidate: str) -> list[Json]:
    """Expose compact SVG labels from this turn without sending large source files."""
    bank: list[Json] = []
    seen: set[str] = set()
    messages = record.raw["messages"]
    last_user = max(i for i, message in enumerate(messages[:record.final_index]) if message.get("role") == "user")
    for index in range(last_user + 1, record.final_index):
        for path, text in strings(messages[index]):
            if path.startswith("/input_messages") or "<svg" not in text:
                continue
            for match in re.finditer(r">([^<>\r\n]{1,240})</text>", text):
                quote = match.group(1)
                if quote in seen or not quote.strip():
                    continue
                seen.add(quote)
                bank.append({"ref": f"{candidate}-artifact-{index}-{len(bank)}", "candidate": candidate,
                             "message_index": index, "quote": quote, "path": path})
                if len(bank) >= 80:
                    return bank
    return bank


def validate_result(schema: Json, stage: str, result: Json, candidates: dict[str, Record], viewed: set[tuple[str, int]] | None = None) -> list[Json]:
    if stage == "pairwise":
        comparison_pair([r.version for r in candidates.values()])
    Draft202012Validator(stage_schema(schema, stage) if stage != "output" else schema).validate(result)
    if stage == "pairwise":
        verdict = result["verdict"]
        openings = {"A_better": ("【候选A】更好。",), "B_better": ("【候选B】更好。",),
                    "tie": ("两个都好。", "两个都差。")}
        if verdict["result"] in openings and not verdict["reason"].startswith(openings[verdict["result"]]):
            raise ValueError("结论开头必须与胜负一致；平局明确两个都好或两个都差")
    if stage == "correctness" and re.search(r"候选\s*[AB]", result["correctness_reason"]):
        raise ValueError("独立正确性理由请使用‘该回答’，避免配对位置变化后称谓错误")
    if stage in ("pairwise", "output"):
        editorial = [result["verdict"]["reason"]]
        if stage == "pairwise":
            editorial.extend(text for _, text in strings(result["task_analysis"]))
        for review in result["evaluations"].values():
            editorial.append(review["summary"])
            editorial.extend(text for finding in review["findings"] for text in (finding["text"], finding["reason"]))
        if any(re.search(r"无标准答案|没有标准答案|未进行独立正确性|未进行正确性判定|未做独立正确性|通过核验|通过校验|已被核验|独立判定", text) for text in editorial):
            raise ValueError("评语只能描述答案内容，不得加入标准答案缺失或独立评测流程说明")
        missing_timing = r"(?:耗时|用时|时延|首\s*token|首回答|完成时间|时间数据)(?:数据|记录|信息|数值|字段|的|均|都|仍|也|完全|未|没有|被|\s){0,6}(?:缺失|缺少|未提供|不可用|未记录|不完整)|(?:缺失|缺少|未提供|没有|未记录)(?:双方|两方|一方|另一方|原始|回答|的|对应|具体|可用|任何|有效|完整|相关|\s){0,8}(?:耗时|用时|时延|首\s*token|首回答|完成时间)|(?:无法|不能|不宜|不应|不做|不作|不)(?:[^。！？\n]{0,12})(?:比较快慢|奖励速度)|未发现(?:有证据支持的)?(?:明显|实质)(?:优势|不足|问题)|暂无(?:明显)?(?:优势|不足|问题)"
        if any(re.search(missing_timing, text, re.IGNORECASE) for text in editorial):
            raise ValueError("删除耗时缺失说明或空项占位话；只写实际发现")
        if stage == "pairwise" and any(r.answer_timing["finish_seconds"] is None for r in candidates.values()) and result["task_analysis"]["timing_analysis"]:
            raise ValueError("无完整双方耗时时 timing_analysis 必须为空字符串")
    located: list[Json] = []
    for candidate, record in candidates.items():
        groups = ([result["evidence"]] if stage == "correctness"
                  else [f["evidence"] for f in result["evaluations"][candidate]["findings"]])
        for evidence in itertools.chain.from_iterable(groups):
            index, quote = evidence["message_index"], evidence["quote"]
            if stage == "correctness" and index != record.final_index:
                raise ValueError("独立判对错只允许引用最终回答")
            if index >= len(record.raw["messages"]):
                raise ValueError(f"{candidate}: message_index {index} 越界")
            if quote.startswith("[图像观察]"):
                if (candidate, index) not in (viewed or set()):
                    raise ValueError(f"{candidate}[{index}]: 引用了未读取的图片")
                paths = ["image_observation"]
            else:
                paths = [path for path, text in strings(record.raw["messages"][index]) if quote in text]
                if not paths:
                    raise ValueError(f"{candidate}[{index}]: quote 不是对应消息的原文")
            located.append({"candidate": candidate, "message_index": index, "quote": quote, "paths": paths})
    return located
