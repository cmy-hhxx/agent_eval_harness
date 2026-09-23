import test from "node:test";
import assert from "node:assert/strict";
import { calculate, checkDecision, checkEvidence, textLeaves } from "../pi_eval/extensions/evaluation-tools.js";
import extension from "../pi_eval/extensions/evaluation-tools.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const contract = { task_type: "数值计算", goal: "按题目计算结果", requirements: ["给出计算结果"], scoring_points: ["使用题目输入"], red_flags: ["替换输入"] };
const contractSchema = { type: "object", required: [...Object.keys(contract), "timing_analysis"], properties: Object.fromEntries(
  Object.entries({ ...contract, timing_analysis: "" }).map(([key, value]) => [key, { type: Array.isArray(value) ? "array" : "string" }])) };

test("decision links reject uncertainty, missing evidence and ignored counterevidence", () => {
  const review = type => ({ findings: [{ type, importance: "high", assessment: { requirement_index: 0, evidence_status: "established" } }] });
  const original = { task_analysis: contract, verdict: { result: "A_better" }, evaluations: { A: review("strength"), B: review("problem") },
    decision_basis: { decisive_findings: ["A", "B"].map(candidate => ({ candidate, finding_index: 0 })), counterevidence: [] } };
  checkDecision(original);
  for (const kind of ["uncertain", "missing", "reverse", "counter", "requirement", "one_sided"]) {
    const value = structuredClone(original);
    if (kind === "uncertain") value.evaluations.A.findings[0].assessment.evidence_status = "uncertain";
    if (kind === "missing") value.decision_basis.decisive_findings[0].finding_index = 99;
    if (kind === "reverse") value.verdict.result = "B_better";
    if (kind === "counter") value.evaluations.A.findings.push(review("problem").findings[0]);
    if (kind === "requirement") value.evaluations.A.findings[0].assessment.requirement_index = 99;
    if (kind === "one_sided") value.decision_basis.decisive_findings.pop();
    assert.throws(() => checkDecision(value), undefined, kind);
  }
  const addressed = structuredClone(original);
  addressed.evaluations.A.findings.push(review("problem").findings[0]);
  addressed.decision_basis.counterevidence.push({ candidate: "A", finding_index: 1 });
  checkDecision(addressed);
  addressed.verdict.result = "not_comparable";
  addressed.evaluations.A.findings[0].assessment.evidence_status = "uncertain";
  checkDecision(addressed);
});

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

test("strict submission uses per-candidate reference enum and expands to output evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-eval-test-"));
  const original = process.env.PI_EVAL_TASK;
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
    process.env.PI_EVAL_TASK = task;
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
    if (original === undefined) delete process.env.PI_EVAL_TASK;
    else process.env.PI_EVAL_TASK = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const mode of ["single", "pair"]) {
test(`numeric comparisons require bilateral calculations (${mode})`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-eval-math-"));
  const original = process.env.PI_EVAL_TASK;
  try {
    const input = path.join(dir, "input.json");
    fs.writeFileSync(input, JSON.stringify({ messages: [{ content: "4/2=2" }] }));
    const evidenceSchema = () => ({ items: { properties: { ref: { type: "string" } } } });
    const reviewSchema = () => ({ properties: { findings: { items: { properties: { evidence: evidenceSchema() } } } } });
    const taskFile = path.join(dir, "task.json");
    fs.writeFileSync(taskFile, JSON.stringify({ stage: "pairwise", inputs: { A: input, B: input },
      required_calculations: ["A", "B"], timing_comparable: false, max_tool_calls: 8, max_submissions: 2,
      evidence_bank: ["A", "B"].map(candidate => ({ ref: `${candidate}-0`, candidate, message_index: 0, quote: "4/2=2" })),
      evaluation_materials: { candidates: { A: "4/2=2", B: "4/2=2" } },
      schema: { properties: { task_analysis: contractSchema, evaluations: { properties: { A: reviewSchema(), B: reviewSchema() } } } },
    }));
    process.env.PI_EVAL_TASK = taskFile;
    const hooks = {}, tools = {};
    extension({ registerTool: tool => { tools[tool.name] = tool; }, on: (name, hook) => { hooks[name] = hook; }, setActiveTools: () => {} });
    const payload = () => hooks.before_provider_request({ payload: { messages: [], tools: Object.values(tools).map(tool =>
      ({ type: "function", function: { name: tool.name, parameters: tool.parameters } })) } });
    const canSubmit = () => payload().tools.some(tool => tool.function.name === "submit_evaluation");
    assert.equal(canSubmit(), false);
    assert.deepEqual(payload().tools.map(tool => tool.function.name), ["set_task_contract"]);
    assert.equal((await tools.calculate.execute("early", { candidate: "A", operation: "divide", operands: ["4", "2"] })).isError, true);
    assert.equal((await tools.set_task_contract.execute("invalid", { ...contract, requirements: [] })).isError, true);
    const fixed = await tools.set_task_contract.execute("contract", contract);
    assert.deepEqual(fixed.details.evaluation_materials.candidates, { A: "4/2=2", B: "4/2=2" });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "task-contract.json"))), contract);
    assert.equal((await tools.set_task_contract.execute("rewrite", { ...contract, goal: "change winner" })).isError, true);
    assert.equal(payload().tools.some(tool => tool.function.name === "set_task_contract"), false);
    if (mode === "single") {
      await tools.calculate.execute("a", { candidate: "A", operation: "divide", operands: ["4", "2"] });
      assert.equal(canSubmit(), false);
      await tools.calculate.execute("b", { candidate: "B", operation: "divide", operands: ["4", "2"] });
    } else {
      const rejected = await tools.calculate_pair.execute("bad-pair", {
        A: { operation: "divide", operands: ["4", "2"] }, B: { operation: "divide", operands: ["4", "0"] },
      });
      assert.equal(rejected.isError, true);
      assert.equal(canSubmit(), false);
      const result = await tools.calculate_pair.execute("pair", {
        A: { operation: "divide", operands: ["174205820.63", "12889714.19"] },
        B: { operation: "divide", operands: ["17400", "1288.97"] },
      });
      assert.deepEqual(result.details.calculations.map(c => [c.candidate, Number(c.result).toFixed(2)]),
        [["A", "13.52"], ["B", "13.50"]]);
    }
    assert.equal(canSubmit(), true);
    const wire = payload().tools.find(tool => tool.function.name === "submit_evaluation").function.parameters;
    assert.deepEqual(wire.properties.task_analysis.properties.goal.enum, [contract.goal]);
    assert.equal(wire.properties.task_analysis.properties.requirements.enum, undefined);
    const params = { verdict: { result: "A_better", reason: "【候选A】更好。A耗时数据缺失，不能据此奖励速度。" },
      task_analysis: { ...contract, timing_analysis: "" },
      decision_basis: { decisive_findings: ["A", "B"].map(candidate => ({ candidate, finding_index: 0 })), counterevidence: [], tradeoff: "比较结果与必要说明。" },
      evaluations: Object.fromEntries(["A", "B"].map(candidate => [candidate, { summary: "4除以2得2。", findings: [
        { type: "strength", importance: "low", text: "算式正确", reason: "结果是2。", evidence: [{ ref: `${candidate}-0` }],
          assessment: { requirement_index: 0, observation: "列出算式", evidence_status: "established", impact: "可以核算" } },
      ] }])) };
    assert.equal((await tools.submit_evaluation.execute("bad", params)).isError, true);
    params.verdict.reason = "【候选A】更好。直接给出算式和结果。";
    assert.equal((await tools.submit_evaluation.execute("ok", params)).terminate, true);
  } finally {
    if (original === undefined) delete process.env.PI_EVAL_TASK;
    else process.env.PI_EVAL_TASK = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
}
