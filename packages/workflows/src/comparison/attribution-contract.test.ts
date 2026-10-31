import test from "node:test";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { PlannedTask, RunState, SubmissionReceipt } from "@eval/contracts";
import { emptyUsage } from "@eval/contracts";
import { sessionAttributionResultSchema, sessionProblems, sessionProblemEntries } from "@eval/agents/attribution";
import { attributionResult, emptyAudit, fakeEvaluatorVersion, fakeJudge } from "../../../../tests/fixtures/comparison.js";
import { comparisonAttribution } from "./comparison-attribution.js";
import { attributionRow, stageResult, encodeResult } from "./results.js";
import { comparisonCodec } from "./codec.js";
import { attributionSlots, polishAttribution } from "./commentary.js";
import { groupObservations } from "./observations.js";

function fixture() {
  const value = attributionResult(false, "2+2=5", true);
  const candidate = { input_id: value.session_meta.input_id, batch_id: "b1", case_id: "q1", version: "v1", source: "/source.jsonl", line: 1 };
  const task = { id: "attribution-session", stage: "attribution-session", inputIds: {}, dependencies: { criteria: "criteria-task" },
    data: { stage: "attribution-session", candidate, candidates: { A: candidate } } } as unknown as PlannedTask;
  const receipt = { taskId: task.id, submissionId: "submission", status: "succeeded", evaluation: value,
    evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, audit: emptyAudit(), usage: emptyUsage(), acceptedAt: 1 } as SubmissionReceipt;
  return { value, task, receipt };
}

test("canonical session attribution is the only exported attribution contract", () => {
  const { task, receipt, value } = fixture(), row = attributionRow(task, receipt);
  assert.deepEqual(row, value);
  assert(new Ajv2020({ strict: false }).compile(sessionAttributionResultSchema)(row));
  assert.throws(() => comparisonCodec.resultId(row), /检查点行引用/);
  assert.deepEqual(stageResult("attribution-session", row), row);
  const state = { manifest: { runId: "run-1", tasks: [task] }, receipts: { [task.id]: receipt } } as unknown as RunState;
  assert.deepEqual(encodeResult(task, state, {})!.row, row);
  assert.equal(encodeResult(task, state, {})!.id, task.id);
});

test("formal turn and session problems require severity without filling missing values", () => {
  const validate = new Ajv2020({ strict: false }).compile(sessionAttributionResultSchema);
  const { value } = fixture();
  value.session_problem = [structuredClone(value.turns[0]!.problem[0]!)];
  assert(validate(value));
  for (const scope of ["turn", "session"]) for (const field of ["severity", "severity_reason"]) {
    const invalid = structuredClone(value), problem = scope === "turn" ? invalid.turns[0]!.problem[0]! : invalid.session_problem[0]!;
    delete (problem as unknown as Record<string, unknown>)[field];
    assert(!validate(invalid), `${scope} problem requires ${field}`);
  }
});

test("rewrite slots address canonical turn and session problems", () => {
  const { value } = fixture(), problems = sessionProblems(value);
  assert.equal(problems.length, 1);
  const slots = attributionSlots(value);
  assert(slots.some(item => item.id === "session_summary"));
  assert(slots.some(item => item.id === "turns.0.problem.0.reason"));
  const polished = polishAttribution(value, { "turns.0.problem.0.reason": "有效改写。" });
  assert.equal(sessionProblems(polished)[0]!.reason, "有效改写。");
  assert.deepEqual(sessionProblems(polished)[0]!.evidence, problems[0]!.evidence);
  assert.equal(sessionProblems(polished)[0]!.severity, problems[0]!.severity);
  assert.equal(sessionProblems(polished)[0]!.severity_reason, problems[0]!.severity_reason);
});

test("comparison projection maps canonical session problems without private responsibility fields", () => {
  const { value } = fixture(), projection = comparisonAttribution(value);
  assert.equal(projection.Problem[0]!.problem_path, "/turns/0/problem/0");
  assert.equal(projection.Problem[0]!.text, "2+2 应得 4，实际回答给出了不同结果。");
  assert.deepEqual(Object.keys(projection).sort(), ["Problem", "correct_reason", "has_standard_answer", "is_correct", "summary"]);
  assert(!Object.hasOwn(projection.Problem[0]!, "responsibility_boundary"));
  value.turns[0]!.problem[0]!.severity = "P3";
  value.turns[0]!.problem[0]!.severity_reason = "仅有轻微影响。";
  assert.deepEqual(comparisonAttribution(value), projection, "severity annotations do not change comparison material");
});

test("P4 process defects stay in formal attribution but never decide a comparison", () => {
  const { value } = fixture();
  value.turns[0]!.problem.push({ ...structuredClone(value.turns[0]!.problem[0]!), label: "首次取数报错", severity: "P4",
    severity_reason: "重试后取得正确数据，无交付影响。" });
  assert(new Ajv2020({ strict: false }).compile(sessionAttributionResultSchema)(value), "P4 is a formal severity");
  assert.deepEqual(sessionProblems(value).map(problem => problem.severity), ["P1", "P4"], "reports keep P4 alongside delivery findings");
  assert.deepEqual(comparisonAttribution(value).Problem.map(problem => problem.problem_path), ["/turns/0/problem/0"]);
});

test("clustering consumes canonical problem label, definition and phenomenon", () => {
  const { value } = fixture(), problem = sessionProblemEntries(value)[0]!;
  const rows = groupObservations([{ input_id: String(value.session_meta.input_id), case_id: "q1", source: { file: "source", line: 1 },
    problems: [problem] }, { input_id: "second-input", case_id: "q2", source: { file: "source", line: 2 },
    problems: [{ ...problem, severity: "P3", severity_reason: "仅有轻微影响。" }] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, problem.label);
  assert.equal(rows[0]!.definition, problem.definition);
  assert.equal(rows[0]!.refs[0]!.problem_path, "/turns/0/problem/0");
  assert.equal(rows[0]!.refs.length, 2, "different severity does not split the same problem class");
});

test("problem coordinates distinguish turns and session scope without modifying accepted problem bodies", () => {
  const { value } = fixture();
  value.turns.push(structuredClone(value.turns[0]!));
  value.session_problem.push(structuredClone(value.turns[0]!.problem[0]!));
  const before = structuredClone(value), entries = sessionProblemEntries(value);
  assert.deepEqual(entries.map(entry => entry.problem_path), ["/turns/0/problem/0", "/turns/1/problem/0", "/session_problem/0"]);
  assert.deepEqual(value, before);
  const validate = new Ajv2020({ strict: false }).compile(sessionAttributionResultSchema);
  assert(validate(value));
  const invalid = structuredClone(value);
  Object.assign(invalid.turns[0]!.problem[0]!, { problem_id: "p1" });
  assert(!validate(invalid), "new formal rows cannot contain program-invented problem IDs");
});
