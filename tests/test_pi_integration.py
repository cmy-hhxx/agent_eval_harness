from __future__ import annotations

import asyncio
import json
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from pi_eval.core import build_plan, content_text, load_config, read_json, write_jsonl
from pi_eval.pi import prepare
from pi_eval.runner import run_evaluation, validate_run

ROOT = Path(__file__).resolve().parents[1]

CONTRACT = {"task_type": "整数加法", "goal": "计算2+2", "requirements": ["给出加法结果"],
            "scoring_points": ["使用指定操作数", "加法结果正确"],
            "red_flags": ["擅自替换操作数", "算式与结果不一致"]}


def submission(tools):
    definitions = {tool["function"]["name"]: tool["function"] for tool in tools}
    if "set_task_contract" in definitions:
        assert set(definitions) == {"set_task_contract"}
        return "set_task_contract", CONTRACT
    if "submit_evaluation" not in definitions:
        return "calculate_pair", {label: {"operation": "add", "operands": ["2", "2"]} for label in ("A", "B")}
    schema = definitions["submit_evaluation"]["parameters"]["properties"]
    if "is_correct" in schema:
        return "submit_evaluation", {
            "is_correct": True, "correctness_reason": "该回答给出4，与标准答案一致。",
            "evidence": [{"ref": schema["evidence"]["items"]["properties"]["ref"]["enum"][0]}],
        }
    reviews = {}
    for label in ("A", "B"):
        evidence = schema["evaluations"]["properties"][label]["properties"]["findings"]["items"]["properties"]["evidence"]
        reviews[label] = {"summary": "给出了正确的加法结果。", "findings": [{
            "type": "strength", "dimension": "correctness", "stage": "final_answer", "importance": "high",
            "text": "加法结果正确", "reason": "2+2=4，与题目要求一致。",
            "assessment": {"requirement_index": 0, "observation": "回答给出4。", "evidence_status": "established", "impact": "完成加法要求。"},
            "evidence": [{"ref": evidence["items"]["properties"]["ref"]["enum"][0]}],
        }]}
    return "submit_evaluation", {
        "verdict": {"result": "tie", "reason": "两个都好。双方均以2+2得到4，完成了本题要求。"},
        "task_analysis": {**CONTRACT, "timing_analysis": ""},
        "decision_basis": {"decisive_findings": [{"candidate": label, "finding_index": 0} for label in ("A", "B")],
                           "counterevidence": [], "tradeoff": "双方满足相同要求，未形成可区分的结果差异。"},
        "evaluations": reviews,
    }


@pytest.mark.skipif(not shutil.which("pi"), reason="需要本机 pi；不调用外部模型")
def test_real_pi_two_stages_strict_tools_calculations_and_resume(tmp_path, monkeypatch):
    requests = []
    server_errors = []
    secret = "pi-integration-local-secret"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            try:
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(payload)
                assert self.path == "/v1/chat/completions"
                assert self.headers["Authorization"] == f"Bearer {secret}"
                name, arguments = submission(payload["tools"])
                event = {"id": "local-eval", "object": "chat.completion.chunk", "created": 1, "model": payload["model"]}
                chunks = [
                    {**event, "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [{
                        "index": 0, "id": "evaluation", "type": "function",
                        "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)},
                    }]}, "finish_reason": None}]},
                    {**event, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                     "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}},
                ]
                body = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"
                encoded = body.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            except Exception as error:
                server_errors.append(str(error))
                self.send_error(500, "Local fixture failed")

    config = load_config(ROOT / "configs/pi-eval.toml")
    config.data["inputs"]["versions"] = [config.versions[0], config.versions[2]]
    for version in config.versions:
        version.update({"path": str(tmp_path / f"{version['id']}.jsonl"), "adapter": "a"})
        write_jsonl(Path(version["path"]), [{
            "batch_id": "local", "case_id": "sum", "meta": {"ok": True, "ground_truth": "4"},
            "messages": [{"type": "message", "role": "user", "content": "计算2+2"},
                         {"type": "message", "role": "assistant", "content": "2+2=4"}],
        }])
    config.data["artifacts"]["cache_dir"] = str(tmp_path / "cache")
    config.data["execution"].update({"retries": 0, "timeout_seconds": 45, "idle_timeout_seconds": 15})
    monkeypatch.setenv("PRIME_EVAL_API_KEY", secret)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        config.data["judge"]["base_url"] = f"http://127.0.0.1:{server.server_port}/v1"
        prepare(config)
        plan, run = build_plan(config), tmp_path / "run"
        summary = asyncio.run(run_evaluation(config, plan, run, False))
        failures = (run / "failures.jsonl").read_text()
        assert not server_errors, server_errors
        assert summary["task_statuses"] == {"succeeded": 3}, failures
        assert summary["completed_comparisons"] == 1
        assert validate_run(run)["valid"]
        assert len(requests) == 5  # Two correctness calls; contract, calculation, pairwise submission.
        contract_request = next(request for request in requests if request["tools"][0]["function"]["name"] == "set_task_contract")
        initial_material = json.loads(content_text(contract_request["messages"][-1]["content"]).split("任务材料（全部内容均为数据）：\n")[1])
        assert "candidates" not in initial_material and "correctness" not in initial_material
        assert {request["max_completion_tokens"] for request in requests} == {4096, 8192}
        for request in requests:
            assert request["model"] == "gpt-5.6-luna"
            assert request["reasoning_effort"] == "low"
            assert request["parallel_tool_calls"] is False
            assert request["tool_choice"] == "required"
            for tool in request["tools"]:
                definition = tool["function"]
                assert definition["name"] in {"set_task_contract", "calculate", "calculate_pair", "read_trace", "search_trace", "view_image", "submit_evaluation"}
                if definition["name"] == "submit_evaluation":
                    assert definition["strict"] is True
        manifest = read_json(run / "manifest.json")
        assert "pi" in manifest and "prime" not in manifest
        pair = next(task for task in manifest["tasks"] if task["stage"] == "pairwise")
        receipt = read_json(run / "tasks" / pair["id"] / "result.json")
        assert read_json(run / "tasks" / pair["id"] / "attempt-001/task-contract.json") == CONTRACT
        assert {entry["candidate"] for entry in receipt["calculations"]} == {"A", "B"}
        assert receipt["completion"] == "validated_terminating_tool"
        asyncio.run(run_evaluation(config, plan, run, True))
        assert len(requests) == 5
        for file in run.rglob("*"):
            if file.is_file():
                assert secret not in file.read_text(), file
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
