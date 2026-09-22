from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import pytest

from prime_eval.core import adapt, load_config, write_json
from prime_eval.prime import JudgeError, invoke

ROOT = Path(__file__).resolve().parents[1]


def test_validated_terminating_tool_does_not_wait_for_agent_end(tmp_path, monkeypatch):
    config = load_config(ROOT / "configs/eval.toml")
    config.data["execution"]["timeout_seconds"] = 8
    monkeypatch.setenv("PRIME_EVAL_API_KEY", "fake-local-test-key")
    raw = {"batch_id": "batch", "case_id": "case", "meta": {"ok": True, "ground_truth": "4"},
           "messages": [{"role": "user", "type": "message", "content": "2+2？"},
                        {"role": "assistant", "type": "message", "content": "答案是4。\u2028保持原文"}]}
    record = adapt(raw, config.versions[0], "test.jsonl", 1, None)
    source = tmp_path / "input.json"
    write_json(source, raw)
    script = tmp_path / "fake-prime"
    script.write_text(f"#!{sys.executable}\n" + '''
import json,os,sys
def emit(value):
    print(json.dumps(value,ensure_ascii=False),flush=True)
for line in sys.stdin:
    cmd=json.loads(line)
    typ=cmd['type']
    if typ=='abort': break
    if typ=='get_state':
        emit({'type':'response','command':typ,'success':True,'data':{'model':{'id':'gpt-5.4-mini','provider':'evaluation-gateway'},'thinkingLevel':'low'}})
    elif typ.startswith('set_auto_'):
        emit({'type':'response','command':typ,'success':True})
    elif typ=='prompt':
        emit({'type':'response','command':typ,'success':True})
        emit({'type':'message_end','message':{'role':'assistant','stopReason':'toolUse','usage':{'input':10,'output':5,'totalTokens':15}}})
        emit({'type':'tool_execution_start','toolName':'submit_evaluation'})
        value={'is_correct':True,'correctness_reason':'匹配标准答案','evidence':[{'message_index':1,'quote':'答案是4。\\u2028保持原文'}]}
        emit({'type':'tool_execution_end','toolName':'submit_evaluation','isError':False,'result':{'details':{'evaluation':value}}})
        # Intentionally never emit agent_end. The runner must stop this process.
''', encoding="utf-8")
    script.chmod(0o755)
    start = time.monotonic()
    result = asyncio.run(invoke(config, {"binary": str(script)}, "correctness", {"A": record}, "4", {}, tmp_path / "attempt", {"A": source}))
    assert time.monotonic() - start < 5
    assert result["completion"] == "validated_terminating_tool"
    assert result["usage"]["totalTokens"] == 15
    assert result["evaluation"]["evidence"][0]["quote"].endswith("\u2028保持原文")
    prompt = (tmp_path / "attempt" / "prompt.txt").read_text()
    assert '"catalog"' not in prompt
    assert '"final_answer"' in prompt


def test_missing_credentials_fails_before_starting_process(tmp_path, monkeypatch):
    config = load_config(ROOT / "configs/eval.toml")
    monkeypatch.delenv("PRIME_EVAL_API_KEY", raising=False)
    with pytest.raises(JudgeError, match="环境变量"):
        asyncio.run(invoke(config, {"binary": "/does/not/exist"}, "correctness", {}, None, {}, tmp_path / "attempt", {}))


def test_silent_stream_is_retryable_without_waiting_for_total_timeout(tmp_path, monkeypatch):
    config = load_config(ROOT / "configs/eval.toml")
    config.data["execution"]["idle_timeout_seconds"] = 1
    config.data["execution"]["timeout_seconds"] = 30
    monkeypatch.setenv("PRIME_EVAL_API_KEY", "fake-local-test-key")
    script = tmp_path / "silent-prime"
    script.write_text(f"#!{sys.executable}\n" + '''
import json,sys,time
for line in sys.stdin:
    cmd=json.loads(line)
    typ=cmd['type']
    if typ=='prompt': time.sleep(60)
    data={'model':{'id':'gpt-5.4-mini','provider':'evaluation-gateway'},'thinkingLevel':'low'} if typ=='get_state' else {}
    print(json.dumps({'type':'response','command':typ,'success':True,'data':data}),flush=True)
''')
    script.chmod(0o755)
    start = time.monotonic()
    with pytest.raises(JudgeError, match="静默") as raised:
        asyncio.run(invoke(config, {"binary": str(script)}, "correctness", {}, "4", {}, tmp_path / "attempt", {}))
    assert raised.value.retryable
    assert time.monotonic() - start < 5
