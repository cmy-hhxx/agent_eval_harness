import test from "node:test";
import assert from "node:assert/strict";
import { calculate, checkAudit, checkEvidence, textLeaves } from "../extensions/evaluation-tools.js";
import extension from "../extensions/evaluation-tools.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("calculator handles numeric ratios without executing expressions", () => {
  assert.equal(Number(calculate("divide", ["17400", "1288.97"]).result).toFixed(2), "13.50");
  assert.throws(() => calculate("divide", ["1", "0"]));
  assert.throws(() => calculate("add", ["process.exit()", "1"]));
});

test("nested evidence is checked against raw text including Unicode separators", () => {
  const records = { A: { messages: [{ output: { text: "a\u2028b\n原始文本" } }] } };
  const result = { evidence: [{ message_index: 0, quote: "b\n原始文本" }] };
  assert.deepEqual(checkEvidence(result, "correctness", records, new Set())[0].paths, ["/output/text"]);
  assert.equal(textLeaves(records.A.messages[0])[0].text, "a\u2028b\n原始文本");
  assert.throws(() => checkEvidence({ evidence: [{ message_index: 0, quote: "伪造引文" }] }, "correctness", records, new Set()));
  assert.throws(() => checkEvidence({ evidence: [{ message_index: 0, quote: "[图像观察]趋势上升" }] }, "correctness", records, new Set()));
});

test("audit findings must quote a real draft field", () => {
  const draft = { verdict: { reason: "候选完成得更少" }, task_analysis: { red_flags: ["本题209.93%"] } };
  checkAudit({ issues: [{ path: "/verdict/reason", quote: "完成得更少" },
    { path: "/task_analysis/red_flags/0", quote: "209.93%" }] }, draft);
  for (const issue of [{ path: "/missing", quote: "原文" }, { path: "/verdict/reason", quote: "伪造原文" }]) {
    assert.throws(() => checkAudit({ issues: [issue] }, draft));
  }
});

test("audit uses strict schema and can return issues without rewriting a verdict", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-eval-audit-"));
  const original = process.env.PRIME_EVAL_TASK;
  try {
    const task = path.join(dir, "task.json");
    fs.writeFileSync(task, JSON.stringify({ stage: "audit", inputs: {}, evidence_bank: [],
      max_tool_calls: 8, max_submissions: 2, draft: { verdict: { reason: "赢家完成得更少" } },
      schema: { type: "object", properties: { issues: { type: "array" } }, required: ["issues"], additionalProperties: false } }));
    process.env.PRIME_EVAL_TASK = task;
    const hooks = {}, tools = {};
    extension({ registerTool: tool => { tools[tool.name] = tool; }, on: (name, hook) => { hooks[name] = hook; }, setActiveTools() {} });
    const payload = hooks.before_provider_request({ payload: { tools: [{ type: "function", function: { name: "submit_evaluation" } }] } });
    assert.equal(payload.tools[0].function.strict, true);
    const issue = { category: "consistency", path: "/verdict/reason", problem: "比较方向反了", instruction: "核对方向" };
    const result = await tools.submit_evaluation.execute("audit", { issues: [issue] });
    assert.equal(result.terminate, true);
    assert.deepEqual(result.details.evaluation, { issues: [{ ...issue, quote: "赢家完成得更少" }] });
    assert.deepEqual(result.details.evidence_locations, []);
  } finally {
    if (original === undefined) delete process.env.PRIME_EVAL_TASK;
    else process.env.PRIME_EVAL_TASK = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("strict submission uses per-candidate reference enum and expands to output evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-eval-test-"));
  const original = process.env.PRIME_EVAL_TASK;
  try {
    const input = path.join(dir, "input.json");
    fs.writeFileSync(input, JSON.stringify({ messages: [{ role: "assistant", content: "答案是 4" }] }));
    const task = path.join(dir, "task.json");
    fs.writeFileSync(task, JSON.stringify({ stage: "correctness", inputs: { A: input },
      final_indices: { A: 0 }, max_tool_calls: 8, max_submissions: 2,
      evidence_bank: [{ ref: "A-0-0", candidate: "A", message_index: 0, quote: "答案是 4", path: "/content" }],
      schema: { type: "object", properties: { evidence: { type: "array", items: {
        type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false,
      } } }, required: ["evidence"], additionalProperties: false },
    }));
    process.env.PRIME_EVAL_TASK = task;
    const hooks = {}, tools = {};
    let active;
    extension({ registerTool: tool => { tools[tool.name] = tool; }, on: (name, hook) => { hooks[name] = hook; }, setActiveTools: names => { active = names; } });
    hooks.session_start();
    assert.deepEqual(active, ["calculate", "submit_evaluation"]);
    assert.equal(tools.read_trace, undefined);
    const payload = hooks.before_provider_request({ payload: { messages: [], model: "test", tools: [{ type: "function", function: { name: "submit_evaluation" } }] } });
    assert.equal(payload.tool_choice, "required");
    assert.equal(payload.parallel_tool_calls, false);
    assert.equal(payload.tools[0].function.strict, true);
    assert.deepEqual(payload.tools[0].function.parameters.properties.evidence.items.properties.ref.enum, ["A-0-0"]);
    const invalid = await tools.submit_evaluation.execute("id", { evidence: [{ ref: "B-0-0" }] });
    assert.equal(invalid.isError, true);
    const result = await tools.submit_evaluation.execute("id", { evidence: [{ ref: "A-0-0" }] });
    assert.equal(result.terminate, true);
    assert.deepEqual(result.details.evaluation.evidence, [{ message_index: 0, quote: "答案是 4" }]);
    assert.deepEqual(result.details.submission.evidence, [{ ref: "A-0-0" }]);
  } finally {
    if (original === undefined) delete process.env.PRIME_EVAL_TASK;
    else process.env.PRIME_EVAL_TASK = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("numeric comparisons cannot submit until both candidates have been calculated", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-eval-math-"));
  const original = process.env.PRIME_EVAL_TASK;
  try {
    const input = path.join(dir, "input.json");
    fs.writeFileSync(input, JSON.stringify({ messages: [{ content: "4/2=2" }] }));
    const evidenceSchema = () => ({ items: { properties: { ref: { type: "string" } } } });
    const reviewSchema = () => ({ properties: { findings: { items: { properties: { evidence: evidenceSchema() } } } } });
    const taskFile = path.join(dir, "task.json");
    fs.writeFileSync(taskFile, JSON.stringify({ stage: "pairwise", inputs: { A: input, B: input },
      required_calculations: ["A", "B"], timing_comparable: false, max_tool_calls: 8, max_submissions: 2,
      evidence_bank: ["A", "B"].map(candidate => ({ ref: `${candidate}-0`, candidate, message_index: 0, quote: "4/2=2" })),
      schema: { properties: { evaluations: { properties: { A: reviewSchema(), B: reviewSchema() } } } },
    }));
    process.env.PRIME_EVAL_TASK = taskFile;
    const hooks = {}, tools = {};
    extension({ registerTool: tool => { tools[tool.name] = tool; }, on: (name, hook) => { hooks[name] = hook; }, setActiveTools: () => {} });
    const payload = () => hooks.before_provider_request({ payload: { messages: [], tools: Object.values(tools).map(tool =>
      ({ type: "function", function: { name: tool.name, parameters: tool.parameters } })) } });
    const canSubmit = () => payload().tools.some(tool => tool.function.name === "submit_evaluation");
    assert.equal(canSubmit(), false);
    await tools.calculate.execute("a", { candidate: "A", operation: "divide", operands: ["4", "2"] });
    assert.equal(canSubmit(), false);
    await tools.calculate.execute("b", { candidate: "B", operation: "divide", operands: ["4", "2"] });
    assert.equal(canSubmit(), true);
    const params = { verdict: { result: "A_better", reason: "【候选A】更好。A耗时数据缺失，不能据此奖励速度。" },
      task_analysis: { timing_analysis: "" },
      evaluations: Object.fromEntries(["A", "B"].map(candidate => [candidate, { summary: "4除以2得2。", findings: [
        { text: "算式正确", reason: "结果是2。", evidence: [{ ref: `${candidate}-0` }] },
      ] }])) };
    assert.equal((await tools.submit_evaluation.execute("bad", params)).isError, true);
    params.verdict.reason = "【候选A】更好。直接给出算式和结果。";
    assert.equal((await tools.submit_evaluation.execute("ok", params)).terminate, true);
  } finally {
    if (original === undefined) delete process.env.PRIME_EVAL_TASK;
    else process.env.PRIME_EVAL_TASK = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
