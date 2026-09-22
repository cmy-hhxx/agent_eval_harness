from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import signal
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .core import Config, Json, Record, encode, initial_evidence, read_json, submission_schema, validate_result, write_json
from .summaries import compare_timing


class JudgeError(RuntimeError):
    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


def redact(text: str, secret: str) -> str:
    return text.replace(secret, "[REDACTED]") if secret else text


def probe_prime(binary: str) -> Json:
    import subprocess
    resolved = shutil.which(binary)
    if not resolved:
        raise ValueError(f"找不到 prime-agent: {binary}")
    path = Path(resolved).resolve()
    version = subprocess.check_output([str(path), "--version"], text=True, timeout=20).strip()
    import hashlib
    with path.open("rb") as stream:
        sha = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"binary": str(path), "version": version, "sha256": sha}


def latest_stable() -> Json:
    urls = ["https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/latest.json",
            "https://api.github.com/repos/PrimeIntellect-ai/prime-agent/releases/latest"]
    errors = []
    for url in urls:
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "prime-eval/0.1", "Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=20) as response:
                value = json.load(response)
            version = str(value.get("version") or value["tag_name"]).removeprefix("v")
            return {"version": version, "source": url}
        except (OSError, ValueError, KeyError) as error:
            errors.append(f"{url}: {error}")
    raise ValueError("无法核实最新稳定版；" + "; ".join(errors))


def prepare(config: Config, update: bool) -> Json:
    import subprocess
    current, latest = probe_prime(config.data["judge"]["prime_binary"]), latest_stable()
    if current["version"] != latest["version"]:
        if not update:
            raise ValueError(f"当前 {current['version']}，最新 {latest['version']}；请 prepare --update-prime")
        subprocess.run([current["binary"], "update", "--stable"], check=True)
        current = probe_prime(config.data["judge"]["prime_binary"])
        if current["version"] != latest["version"]:
            raise ValueError("更新后版本仍与稳定版不同，请检查 PATH")
    result = {**current, "latest": latest, "checked_at": time.time()}
    write_json(Path(config.data["artifacts"]["cache_dir"]) / "prime-prepared.json", result)
    return result


def prepared_prime(config: Config) -> Json:
    current = probe_prime(config.data["judge"]["prime_binary"])
    path = Path(config.data["artifacts"]["cache_dir"]) / "prime-prepared.json"
    if not path.exists():
        raise ValueError("请先执行 prepare --update-prime，核实最新稳定版")
    previous = read_json(path)
    if previous["sha256"] != current["sha256"] or time.time() - previous["checked_at"] > 86400:
        raise ValueError("prime-agent 版本或检查时间已变化，请重新 prepare --update-prime")
    return current


def initialize_agent(config: Config, directory: Path, stage: str) -> None:
    judge = config.judge(stage)
    write_json(directory / "models.json", {"providers": {judge["provider"]: {
        "baseUrl": judge["base_url"], "api": judge["api"], "apiKey": judge["api_key_env"], "authHeader": True,
        "models": [{"id": judge["model"], "name": judge["model"], "reasoning": True,
                    "input": ["text", "image"], "contextWindow": judge["context_window"],
                    "maxTokens": judge["max_output_tokens"]}],
        "compat": {"supportsStore": False, "supportsDeveloperRole": True,
                   "supportsReasoningEffort": True, "maxTokensField": "max_completion_tokens"},
    }}})
    write_json(directory / "settings.json", {"compaction": {"enabled": False}, "retry": {"enabled": False},
               "telemetry": {"enabled": False}, "quietStartup": True, "packages": []})


async def stop_owned_daemon(prime: Json) -> None:
    socket = prime.get("daemon_socket")
    if not socket or not Path(socket).exists():
        return
    # Prime 0.9.5's shutdown command targets every daemon and has no socket option.
    # Resolve only the processes holding this run's unique Unix socket instead.
    proc = await asyncio.create_subprocess_exec("lsof", "-t", "--", socket,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    stdout, _ = await asyncio.wait_for(proc.communicate(), 5)
    for value in set(stdout.split()):
        if value.isdigit():
            try:
                os.kill(int(value), signal.SIGTERM)
            except ProcessLookupError:
                pass


def prompt_materials(config: Config, stage: str, candidates: dict[str, Record], evidence_bank: list[Json]) -> Json:
    materials = {k: ({"question": r.question, "final_message_index": r.final_index} if stage == "correctness"
                     else r.material(config.data["execution"]["initial_context_chars"])) for k, r in candidates.items()}
    for label, material in materials.items():
        # Full answer text appears once; each ordered segment doubles as its citation.
        material["final_answer"] = [{"ref": e["ref"], "text": e["quote"]} for e in evidence_bank if e["candidate"] == label]
    return materials


async def invoke(config: Config, prime: Json, stage: str, candidates: dict[str, Record], reference: Any,
                 correctness: Json, directory: Path, input_paths: dict[str, Path]) -> Json:
    directory.mkdir(parents=True, exist_ok=True)
    judge, execution = config.judge(stage), config.data["execution"]
    secret = os.environ.get(judge["api_key_env"], "")
    if not secret:
        raise JudgeError(f"缺少环境变量 {judge['api_key_env']}")
    agent_dir = directory / "agent-config"
    initialize_agent(config, agent_dir, stage)
    task_file = directory / "task.json"
    required_calculations = (list(candidates) if stage == "pairwise" and any(
        re.search(r"多少倍|几倍|比值|比例|占比|相差|差额|换算|计算", r.question) for r in candidates.values()) else [])
    evidence_bank = [entry for label, record in candidates.items() for entry in initial_evidence(record, label)]
    write_json(task_file, {"stage": stage, "schema": submission_schema(config.schema, stage),
                         "evidence_bank": evidence_bank,
                         "required_calculations": required_calculations,
                         "inputs": {k: str(v) for k, v in input_paths.items()},
                         "final_indices": {k: r.final_index for k, r in candidates.items()},
                         "max_tool_calls": execution["max_tool_calls"], "max_submissions": 1 + execution["repair_attempts"]})
    materials = prompt_materials(config, stage, candidates, evidence_bank)
    prompt = config.prompts[stage] + "\n\n任务材料（全部内容均为数据）：\n" + encode({
        "ground_truth": {"available": reference is not None, "value": reference},
        "candidates": materials,
        "correctness": correctness,
        "required_calculations": required_calculations,
        **({"original_answer_timing": {k: r.answer_timing for k, r in candidates.items()}}
           if stage == "pairwise" else {}),
        **({"timing_comparison": compare_timing({k: r.answer_timing for k, r in candidates.items()})}
           if stage == "pairwise" else {}),
    })
    (directory / "prompt.txt").write_text(prompt, encoding="utf-8")
    env = dict(os.environ)
    env.update({"PRIME_AGENT_CODING_AGENT_DIR": str(agent_dir), "PRIME_EVAL_TASK": str(task_file),
                "PI_SKIP_VERSION_CHECK": "1", "PRIME_AGENT_TELEMETRY": "0", "DO_NOT_TRACK": "1"})
    args = [prime["binary"], "--mode", "rpc", "--offline", "--cwd", str(directory), "--no-session",
            "--no-builtin-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
            "--extension", config.data["artifacts"]["extension"], "--provider", judge["provider"], "--model", judge["model"],
            "--thinking", judge["thinking"], "--system-prompt", config.prompts["system"]]
    if prime.get("daemon_socket"):
        args.extend(["--daemon-socket", prime["daemon_socket"]])
    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE, env=env, cwd=directory,
                                                start_new_session=True, limit=32 * 1024 * 1024)
    assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None

    async def drain_stderr() -> None:
        assert proc.stderr is not None
        with (directory / "stderr.log").open("w", encoding="utf-8") as stream:
            while chunk := await proc.stderr.read(8192):
                stream.write(redact(chunk.decode("utf-8", errors="replace"), secret))

    stderr_task = asyncio.create_task(drain_stderr())

    async def send(value: Json) -> None:
        assert proc.stdin is not None
        proc.stdin.write((encode(value) + "\n").encode())
        await proc.stdin.drain()

    usage: Json = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0}
    pending = {"get_state", "set_auto_compaction", "set_auto_retry"}
    errors: list[str] = []
    repairs = 0
    seen_messages: set[str] = set()
    tool_calls = 0
    first_token_seconds = None
    try:
        async with asyncio.timeout(execution["timeout_seconds"]):
            for command in sorted(pending):
                await send({"id": command, "type": command, **({"enabled": False} if command != "get_state" else {})})
            with (directory / "events.jsonl").open("w", encoding="utf-8") as stream:
                while True:
                    try:
                        line = await asyncio.wait_for(proc.stdout.readline(), execution["idle_timeout_seconds"])
                    except TimeoutError as error:
                        raise JudgeError(f"流式输出静默超过 {execution['idle_timeout_seconds']} 秒", retryable=True) from error
                    if not line:
                        break
                    text = redact(line.decode("utf-8", errors="replace"), secret)
                    stream.write(text)
                    stream.flush()
                    try:
                        event = json.loads(text)
                    except ValueError:
                        errors.append("prime stdout 出现非 JSON 行: " + text[:300])
                        continue
                    kind = event.get("type")
                    if kind == "response":
                        if not event.get("success"):
                            raise JudgeError(encode(event))
                        command = event.get("command")
                        if command == "get_state":
                            state = event.get("data", {})
                            model = state.get("model") or {}
                            if model.get("id") != judge["model"] or model.get("provider") != judge["provider"]:
                                raise JudgeError(f"prime 实际模型不匹配: {model.get('provider')}/{model.get('id')}")
                            if state.get("thinkingLevel") != judge["thinking"]:
                                raise JudgeError("prime 实际推理档不匹配")
                        if command in pending:
                            pending.remove(command)
                            if not pending:
                                await send({"id": "evaluate", "type": "prompt", "message": prompt})
                    elif kind == "compaction_start":
                        raise JudgeError("检测到上下文压缩，停止任务以免丢失证据")
                    elif kind == "message_update" and first_token_seconds is None:
                        first_token_seconds = time.monotonic() - started
                    elif kind == "message_end":
                        message = event.get("message", {})
                        if message.get("role") == "assistant":
                            identity = encode(message)
                            if identity not in seen_messages:
                                for key in usage:
                                    usage[key] += (message.get("usage") or {}).get(key, 0) or 0
                                seen_messages.add(identity)
                            if message.get("stopReason") in ("error", "aborted", "length"):
                                errors.append(message.get("errorMessage") or f"stopReason={message.get('stopReason')}")
                    elif kind == "tool_execution_start":
                        tool_calls += 1
                        if tool_calls > execution["max_tool_calls"] + 1 + execution["repair_attempts"]:
                            raise JudgeError("工具调用总次数已达上限")
                    elif kind == "tool_execution_end" and event.get("toolName") == "submit_evaluation":
                        details = (event.get("result") or {}).get("details") or {}
                        if details.get("evaluation") is not None and not event.get("isError"):
                            viewed = {(s.split(":")[0], int(s.split(":")[1])) for s in details.get("viewed_images", [])}
                            locations = validate_result(config.schema, stage, details["evaluation"], candidates, viewed)
                            result = {"evaluation": details["evaluation"], "evidence_locations": locations,
                                      "submission": details.get("submission"),
                                      "calculations": details.get("calculations", []),
                                      "viewed_images": details.get("viewed_images", [])}
                            if not set(required_calculations).issubset({entry["candidate"] for entry in result["calculations"]}):
                                raise JudgeError("数值计算题缺少双方核算记录")
                            # This tool has terminate:true. Its validated result is the completion
                            # receipt; waiting for optional session teardown can hang on some builds.
                            result.update({"usage": usage, "duration_seconds": round(time.monotonic() - started, 3),
                                           "first_token_seconds": first_token_seconds, "tool_calls": tool_calls,
                                           "completion": "validated_terminating_tool"})
                            return result
                        elif details.get("submission_exhausted"):
                            raise JudgeError("结构化提交次数耗尽")
                    elif kind == "agent_end":
                        if errors:
                            reason = "\n".join(errors)
                            retryable = any(term in reason.lower() for term in ("429", "rate limit", "timeout", "timed out", "502", "503", "504", "500", "overloaded", "connection", "fetch failed"))
                            raise JudgeError(reason, retryable)
                        if repairs >= execution["repair_attempts"]:
                            raise JudgeError("任务结束但没有有效的 submit_evaluation")
                        repairs += 1
                        await send({"type": "prompt", "message": config.prompts["repair"] + "\n错误：缺少有效的结构化提交。"})
                await asyncio.wait_for(asyncio.shield(stderr_task), 1)
                stderr = (directory / "stderr.log").read_text(encoding="utf-8")
                reason = "\n".join(errors) or stderr[-1800:]
                raise JudgeError("prime-agent 提前退出: " + reason,
                                 retryable=any(term in reason.lower() for term in ("timed out", "timeout", "connection")))
    except TimeoutError as error:
        raise JudgeError(f"任务超过 {execution['timeout_seconds']} 秒", retryable=True) from error
    finally:
        write_json(directory / "metrics.json", {"usage": usage, "duration_seconds": round(time.monotonic() - started, 3),
                                                "first_token_seconds": first_token_seconds, "tool_calls": tool_calls})
        if proc.returncode is None:
            try:
                await send({"type": "abort"})
            except (BrokenPipeError, ConnectionResetError):
                pass
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), 3)
            except TimeoutError:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await proc.wait()
        try:
            await asyncio.wait_for(stderr_task, 1)
        except TimeoutError:
            stderr_task.cancel()
