import test from "node:test";
import assert from "node:assert/strict";
import type { PlannedTask, RunState, SubmissionReceipt } from "@eval/contracts";
import type { ComparisonResult, TaskData } from "./types.js";
import { comparisonRow, displayComparisonRow, encodeResult } from "./results.js";
import { display, displayComparison } from "./candidate-display.js";
import { acceptedRewriteProjection } from "./rewrite-projection.js";
import { bindTask } from "./binding.js";
import { polishComparisonRow } from "./commentary.js";
import { attributionResult, emptyAudit, fakeEvaluatorVersion, fakeJudge } from "../../../../tests/fixtures/comparison.js";
import { rewriteProfile } from "@eval/agents/rewrite";
import example from "../../../agents/src/comparison/fixtures/example.json" with { type: "json" };

const names = { A: "B组Expert", B: "A组Expert" };
for (const [subject, text, expected] of [
  ["北方稀土", "A 把下周一标为11月2日；B 把下周一写成10月28日（星期三）。", "B组Expert 把下周一标为11月2日；A组Expert 把下周一写成10月28日（星期三）。"],
  ["利通电子定增", "A 的资产负债率42.63%与公告口径对得上；B 把融资后资产负债率写成约31%。", "B组Expert 的资产负债率42.63%与公告口径对得上；A组Expert 把融资后资产负债率写成约31%。"],
]) test(`${subject}: winner, comparison prose and rewrite retain the actual swapped identities`, () => {
  const result = structuredClone(example.result) as ComparisonResult;
  result.ranking = [["A"], ["B"]]; result.assessments.B.meets_core = false;
  result.assessments.A.summary = text; result.decision_basis.tradeoff = text;
  const candidates = { A: { version: "b_expert", name: "B Expert", input_id: "input-a", batch_id: "b1", case_id: subject },
    B: { version: "a_expert", name: "A Expert", input_id: "input-b", batch_id: "b1", case_id: subject } };
  const task = { id: "comparison", stage: "comparison", inputIds: {}, dependencies: { A: "attr-a", B: "attr-b" },
    data: { stage: "comparison", candidates, group: ["a_expert", "b_expert"], reference: null } } as unknown as PlannedTask;
  const attribution = attributionResult(false, "A 原始证据与 B 引文保持原样。"), before = structuredClone(attribution);
  const receipts = new Map(["attr-a", "attr-b"].map(taskId => [taskId, { taskId, evaluation: attribution } as SubmissionReceipt]));
  const row = comparisonRow({ "input-b": {} }, task, result, receipts, { a_expert: "A组Expert", b_expert: "B组Expert" }, fakeEvaluatorVersion);
  assert.equal((row.verdicts as any).a_expert__vs__b_expert.winner_name, "B组Expert");
  assert.equal((row.decision_basis as any).tradeoff, expected);
  assert.equal((row.assessments as any).b_expert.summary, expected);
  assert.deepEqual((row.evaluations as any).a_expert, before);
  const rewrite = { id: "rewrite", stage: "rewrite", inputIds: {}, dependencies: { source: task.id }, data: {
    ...(task.data as TaskData), stage: "rewrite", case: { batch_id: "b1", case_id: subject }, rewriteOf: { stage: "comparison", taskId: task.id },
    rewriteNames: names, comparisonRewriteScope: "all",
  } } as PlannedTask;
  const source = { taskId: task.id, evaluation: result, submitted: { relative_preference: "A" } } as SubmissionReceipt;
  const input = bindTask(rewrite, {}, { source }, { tasks: [task, rewrite] }).request.input as any;
  assert.equal(input.items.find((item: any) => item.id === "tradeoff").text, expected);
  const state = { manifest: { tasks: [task, rewrite] }, receipts: { rewrite: { taskId: "rewrite", acceptedAt: 1,
    evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, audit: emptyAudit(), evaluation: { rewrites: [
      { id: "tradeoff", text }, { id: "verdict.A__vs__B.reason", text },
    ] } } } } as unknown as RunState;
  const projection = acceptedRewriteProjection(state, task.id)!;
  assert(projection.rewritten.rewrites.every(item => item.text === expected));
  const own = Object.fromEntries(projection.rewritten.rewrites.map(item => [item.id, item.text]));
  const polished = polishComparisonRow(row, task, { of: id => id === task.id ? own : undefined }) as any;
  assert.equal(polished.verdicts.a_expert__vs__b_expert.reason, expected);
  assert.equal(polished.verdicts.a_expert__vs__b_expert.winner_name, "B组Expert");
  assert.deepEqual(polished.evaluations.a_expert, before);
  state.receipts[task.id] = { ...source, exported: { id: String(row.comparison_id), file: "comparison.jsonl", row } };
  const written = encodeResult(rewrite, state, {})!.row as any;
  assert.equal(written.verdicts.a_expert__vs__b_expert.reason, expected,
    "the durable JSONL must apply the accepted rewrite to verdict.reason, not only attach rewritten");
  assert.equal(written.verdicts.a_expert__vs__b_expert.winner_version, "b_expert");
  assert.doesNotMatch(written.verdicts.a_expert__vs__b_expert.reason, /候选[A-Z]/u);
  const saved = structuredClone(row) as any;
  saved.decision_basis.tradeoff = text;
  saved.assessments.b_expert.summary = text;
  saved.rewritten = { evaluator_version: fakeEvaluatorVersion, rewrites: [{ id: "assessment.A.summary", text }] };
  const durable = { ...source, exported: { id: saved.comparison_id, file: "comparison.jsonl", row: saved } };
  const replay = encodeResult(task, { receipts: { [task.id]: durable } } as unknown as RunState, {})!;
  assert.equal(replay.auxiliary, true);
  assert.equal((replay.row.decision_basis as any).tradeoff, expected);
  assert.deepEqual((replay.row.rewritten as any).rewrites, [{ id: "assessment.A.summary", text: expected }]);
  assert.deepEqual(replay.row.evaluations, saved.evaluations);
  assert.deepEqual(replay.row.ranking, saved.ranking);
  assert.deepEqual(displayComparisonRow(replay.row, task), replay.row);
  assert.equal(saved.decision_basis.tradeoff, text);
});

test("candidate display is idempotent and preserves source quotes and business identifiers", () => {
  const value = { summary: "A优于B；A股、B股、A/B类、ABC、A1与B组Expert保留。", quote: "A优于B【候选A】" };
  const shown = displayComparison(value, names);
  assert.deepEqual(shown, { summary: "B组Expert优于A组Expert；A股、B股、A/B类、ABC、A1与B组Expert保留。", quote: value.quote });
  assert.deepEqual(displayComparison(shown, names), shown);
  assert.equal(display("A 原始归因", names), "A 原始归因");
});

test("failed-answer wins retain actual identities and the failure qualifier through export and rewritten verdicts", () => {
  for (const winner of ["A", "B"]) {
    const loser = winner === "A" ? "B" : "A";
    const result = structuredClone(example.result) as ComparisonResult;
    for (const assessment of Object.values(result.assessments)) {
      assessment.meets_core = false; assessment.core_failure_refs = ["sum"];
    }
    result.ranking = [[winner], [loser]];
    result.decision_basis.tradeoff = `双方均未给出可核实结果；【候选${winner}】如实说明缺口，【候选${loser}】编造数字，会误导使用。`;
    const candidates = { A: { version: "b_expert", name: names.A, input_id: "input-a", batch_id: "b1", case_id: "missing-result" },
      B: { version: "a_expert", name: names.B, input_id: "input-b", batch_id: "b1", case_id: "missing-result" } };
    const task = { id: "comparison", stage: "comparison", inputIds: {}, dependencies: { A: "attr-a", B: "attr-b" },
      data: { stage: "comparison", candidates, group: ["a_expert", "b_expert"], reference: null } } as unknown as PlannedTask;
    const receipts = new Map(["attr-a", "attr-b"].map(taskId => [taskId, { taskId, evaluation: attributionResult(false) } as SubmissionReceipt]));
    const row = comparisonRow({}, task, result, receipts, { a_expert: names.B, b_expert: names.A }, fakeEvaluatorVersion);
    const winnerName = winner === "A" ? names.A : names.B, winnerVersion = winner === "A" ? "b_expert" : "a_expert";
    const verdict = (row.verdicts as any).a_expert__vs__b_expert;
    assert.equal(verdict.result, "win");
    assert.equal(verdict.winner_version, winnerVersion);
    assert.equal(verdict.winner_name, winnerName);
    assert.match(verdict.reason, /双方均未完成核心要求/);
    const rewrite = { id: "rewrite", stage: "rewrite", inputIds: {}, dependencies: { source: task.id }, data: {
      ...(task.data as TaskData), stage: "rewrite", case: { batch_id: "b1", case_id: "missing-result" },
      rewriteOf: { stage: "comparison", taskId: task.id }, rewriteNames: names,
    } } as PlannedTask;
    const source = { taskId: task.id, evaluation: result, submitted: { relative_preference: winner },
      exported: { id: String(row.comparison_id), file: "comparison.jsonl", row } } as SubmissionReceipt;
    const request = bindTask(rewrite, {}, { source }, { tasks: [task, rewrite] }).request;
    const items = request.input.items as { id: string; text: string; preference: string }[];
    assert.equal(items.length, 1);
    assert.equal(items[0].preference, `${winnerName}相对更好，但双方均未完成核心要求`);
    const rewritten = { rewrites: [{ id: items[0].id, text: `${items[0].preference}：${items[0].text}` }] };
    rewriteProfile.validate!(request, rewritten, emptyAudit());
    assert.throws(() => rewriteProfile.validate!(request, { rewrites: [{ id: items[0].id, text: `${winnerName}更好：给出了可用结果。` }] }, emptyAudit()), /已确定偏好/);
    const state = { manifest: { tasks: [task, rewrite] }, receipts: { [task.id]: source, rewrite: {
      taskId: rewrite.id, acceptedAt: 1, evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, audit: emptyAudit(), evaluation: rewritten,
    } } } as unknown as RunState;
    const written = encodeResult(rewrite, state, {})!.row as any;
    assert.equal(written.verdicts.a_expert__vs__b_expert.reason, rewritten.rewrites[0].text);
    assert.equal(written.verdicts.a_expert__vs__b_expert.winner_version, winnerVersion);
    assert(Object.values(written.assessments).every((item: any) => item.meets_core === false));
    assert.doesNotMatch(written.verdicts.a_expert__vs__b_expert.reason, /候选[A-Z]/u);
    result.ranking = [["A", "B"]];
    const tied = comparisonRow({}, task, result, receipts, {}, fakeEvaluatorVersion) as any;
    assert.equal(tied.verdicts.a_expert__vs__b_expert.result, "both_bad");
    assert.equal(tied.verdicts.a_expert__vs__b_expert.winner_version, null);
  }
});
