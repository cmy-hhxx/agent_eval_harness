import test from "node:test";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { JsonObject, PlannedTask, RunState, SubmissionReceipt } from "@eval/contracts";
import { emptyUsage } from "@eval/contracts";
import { sessionAttributionResultSchema, sessionProblems } from "@eval/agents/attribution";
import { attributionResult, emptyAudit, fakeEvaluatorVersion, fakeJudge } from "../../../../tests/fixtures/comparison.js";
import { comparisonAttribution } from "./comparison-attribution.js";
import { attributionRow, stageResult, encodeResult } from "./results.js";
import { comparisonCodec } from "./codec.js";
import { caseResultView } from "./dashboard-view.js";
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

test("rewrite slots and dashboard views address canonical turn and session problems", () => {
  const { value } = fixture(), problems = sessionProblems(value);
  assert.equal(problems.length, 1);
  const slots = attributionSlots(value);
  assert(slots.some(item => item.id === "session_summary"));
  assert(slots.some(item => item.id === "turns.0.problem.0.reason"));
  const polished = polishAttribution(value, { "turns.0.problem.0.reason": "有效改写。" });
  assert.equal(sessionProblems(polished)[0]!.reason, "有效改写。");
  assert.deepEqual(sessionProblems(polished)[0]!.evidence, problems[0]!.evidence);
  const shown = caseResultView("attribution-session", value as unknown as JsonObject)!;
  assert.deepEqual(Object.keys(shown).filter(key => ["session_meta", "turns", "session_summary", "session_problem"].includes(key)).sort(),
    ["session_meta", "session_problem", "session_summary", "turns"]);
});

test("comparison projection maps canonical session problems without private responsibility fields", () => {
  const { value } = fixture(), projection = comparisonAttribution(value);
  assert.equal(projection.Problem[0]!.problem_id, "p1");
  assert.equal(projection.Problem[0]!.text, "2+2 应得 4，实际回答给出了不同结果。");
  assert.deepEqual(Object.keys(projection).sort(), ["Problem", "correct_reason", "has_standard_answer", "is_correct", "summary"]);
  assert(!Object.hasOwn(projection.Problem[0]!, "responsibility_boundary"));
});

test("clustering consumes canonical problem label, definition and phenomenon", () => {
  const { value } = fixture(), problem = sessionProblems(value)[0]!;
  const rows = groupObservations([{ input_id: String(value.session_meta.input_id), case_id: "q1", source: { file: "source", line: 1 },
    problems: [problem] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, problem.label);
  assert.equal(rows[0]!.definition, problem.definition);
  assert.equal(rows[0]!.refs[0]!.finding_id, "p1");
});
