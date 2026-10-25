import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { evidenceId, type ProblemLibrary } from "@eval/contracts";
import { applyClustering, countProblemSamples, emptyLibrary, projectLibrary } from "./library.js";
import {
  acceptedProblemOccurrenceReview, applyProblemOccurrenceReview, effectiveProblemOccurrences,
  problemAssociation, validateProblemOccurrenceReview,
  type ProblemOccurrenceReviewDecision, type ProblemOccurrenceReviewTarget,
} from "./occurrence-review.js";

function fixture() {
  const inputId = randomUUID();
  const observations = ["模型自身推理", "Search", "模型自身推理"].map((component, index) => ({
    id: "o" + index, component, label: "现象" + index, definition: "独立现象边界。",
    count: 1, established_count: 0, uncertain_count: 1, established_answer_ids: [],
    examples: [{ finding: "原主张", reason: "原理由", evidence_status: "uncertain" as const }],
    refs: [{ input_id: inputId, case_id: "case", source: { file: "source.jsonl", line: 1 },
      finding_id: "f0", message_index: 1, quote: "原回答", evidence_status: "uncertain" as const }],
  }));
  const receipt = {
    run_id: "run", evaluator_version: "before", task_id: randomUUID(), submission_id: randomUUID(),
    version: "a_fast", batch_id: "batch", observations,
    result: { assignments: observations.map((item, index) => ({ item_id: item.id, new_class_key: "n" + index })),
      new_classes: observations.map((item, index) => ({ key: "n" + index, component: item.component, label: item.label,
        definition: item.definition, closest_existing: null, novelty: "独立现象。", category_paths: [["来源可靠性"]] })), merges: [] },
  };
  const library = applyClustering(emptyLibrary("a_fast"), receipt);
  const decision: ProblemOccurrenceReviewDecision = {
    id: randomUUID(), model: library.model,
    items: [{ occurrence_id: library.occurrences[0]!.id, reason: "原工具全文已给出该数值，模型责任不成立。",
      evidence: [{ evidence_id: evidenceId(inputId, 1, "text", "/content", 0, 3) }] }],
  };
  return { library, decision, receipt, inputId };
}
function proof(library: ProblemLibrary, decision: ProblemOccurrenceReviewDecision): ProblemOccurrenceReviewTarget[] {
  return decision.items.map(item => {
    const occurrence = library.occurrences.find(entry => entry.id === item.occurrence_id)!;
    return { occurrence_id: occurrence.id, association: problemAssociation(library, occurrence), class_id_at_review: occurrence.class_id,
      origin: { run_id: occurrence.run_id, task_id: occurrence.task_id, submission_id: occurrence.submission_id },
      attribution: { task_id: randomUUID(), submission_id: randomUUID() } };
  });
}

test("explicit source review appends one immutable audit and retracts only the selected component", () => {
  const { library, decision } = fixture(), before = structuredClone(library), targets = proof(library, decision);
  const next = applyProblemOccurrenceReview(library, decision, targets, { evaluatorVersion: "after", at: "2026-10-04T01:00:00Z" });
  assert.deepEqual(library, before);
  assert.equal(next.occurrences, library.occurrences, "original sample bodies are not rewritten");
  assert.equal(next.classes, library.classes);
  assert.equal(next.events.length, library.events.length + 1);
  assert.equal(next.events.at(-1)!.id, decision.id);
  assert.equal(next.events.at(-1)!.detail.evaluator_version, "after");
  assert.deepEqual(next.events.at(-1)!.detail.targets, targets);
  const effective = effectiveProblemOccurrences(next);
  assert.equal(effective.length, 1, "both physical rows on the same wrong component are excluded");
  assert.equal(problemAssociation(next, effective[0]!).component_id, Object.values(next.components).find(item => item.label === "Search")!.id);
  assert.equal(countProblemSamples(effective), 1, "another responsible component keeps the same finding");
  assert.deepEqual(projectLibrary(next).components.flatMap(item => item.classes).map(item => item.occurrences).sort(), [0, 0, 1]);
});

test("operation UUID retries are no-ops and a conflicting decision is rejected", () => {
  const { library, decision } = fixture();
  const next = applyProblemOccurrenceReview(library, decision, proof(library, decision), { evaluatorVersion: "after" });
  assert.equal(applyProblemOccurrenceReview(next, structuredClone(decision), [], { evaluatorVersion: "later" }), next);
  assert(acceptedProblemOccurrenceReview(next, decision));
  assert.throws(() => applyProblemOccurrenceReview(next, { ...decision, items: [{ ...decision.items[0]!, reason: "另一个决定" }] },
    [], { evaluatorVersion: "later" }), /冲突决定/);
  const sameKey = { ...decision, id: randomUUID() };
  const second = applyProblemOccurrenceReview(next, sameKey, proof(next, sameKey), { evaluatorVersion: "later" });
  assert.equal(second.events.length, next.events.length + 1);
  assert.deepEqual(effectiveProblemOccurrences(second), effectiveProblemOccurrences(next));
});

test("merge, accepted receipt replay and another class assignment cannot revive a rejected association", () => {
  const { library, decision, receipt } = fixture();
  const targets = proof(library, decision);
  const modelClasses = Object.values(library.classes).filter(item => item.component_id === targets[0]!.association.component_id);
  let next = applyProblemOccurrenceReview(library, decision, targets, { evaluatorVersion: "after" });
  next = applyClustering(next, { ...receipt, submission_id: randomUUID(), observations: [],
    result: { assignments: [], new_classes: [], merges: [{ from: [modelClasses[0]!.id], into: modelClasses[1]!.id, reason: "同组件归并。" }] } });
  assert.equal(effectiveProblemOccurrences(next).length, 1);
  assert.equal(next.classes[modelClasses[0]!.id]!.status, "merged");
  assert.equal(next.occurrences[0]!.previous_class_id, modelClasses[0]!.id);
  next = applyClustering(next, receipt);
  assert.equal(effectiveProblemOccurrences(next).length, 1);
  next = applyClustering(next, { ...receipt, submission_id: randomUUID(),
    observations: [receipt.observations[0]!],
    result: { assignments: [{ item_id: "o0", new_class_key: "extra" }],
      new_classes: [{ key: "extra", component: "模型自身推理", label: "另一类", definition: "另一类。",
        closest_existing: modelClasses[1]!.id, novelty: "明确维护。", category_paths: [["数值可靠性"]] }], merges: [] } });
  assert(next.occurrences.length > library.occurrences.length);
  assert.equal(effectiveProblemOccurrences(next).length, 1);
  assert.equal(applyProblemOccurrenceReview(next, decision, [], { evaluatorVersion: "later" }), next);
});

test("a new registered input and removal of all actual components have distinct counts", () => {
  const { library, decision, receipt } = fixture();
  let next = applyProblemOccurrenceReview(library, decision, proof(library, decision), { evaluatorVersion: "after" });
  const toolOccurrence = effectiveProblemOccurrences(next)[0]!;
  const all = { ...decision, id: randomUUID(), items: [{ ...decision.items[0]!, occurrence_id: toolOccurrence.id }] };
  next = applyProblemOccurrenceReview(next, all, proof(next, all), { evaluatorVersion: "after" });
  assert.equal(countProblemSamples(effectiveProblemOccurrences(next)), 0);
  const newInput = randomUUID();
  next = applyClustering(next, { ...receipt, submission_id: randomUUID(),
    observations: receipt.observations.map(item => ({ ...item, refs: item.refs.map(ref => ({ ...ref, input_id: newInput })) })) });
  assert.equal(countProblemSamples(effectiveProblemOccurrences(next)), 1);
  assert(effectiveProblemOccurrences(next).every(item => item.input_id === newInput));
});

test("unknown, duplicated and malformed review targets or source-only fields fail without mutation", () => {
  const { library, decision } = fixture(), before = structuredClone(library);
  assert.throws(() => validateProblemOccurrenceReview(library, { ...decision, model: "b_fast" }), /模型身份/);
  assert.throws(() => validateProblemOccurrenceReview(library, { ...decision, items: [decision.items[0], decision.items[0]] }), /目标重复/);
  assert.throws(() => validateProblemOccurrenceReview(library, { ...decision, items: [{ ...decision.items[0], occurrence_id: randomUUID() }] }), /未知问题样本/);
  assert.throws(() => validateProblemOccurrenceReview(library, { ...decision, items: [{ ...decision.items[0], reason: "  " }] }), /理由不能为空/);
  assert.throws(() => validateProblemOccurrenceReview(library, { ...decision, items: [{ ...decision.items[0], source: "answer" }] }));
  assert.throws(() => validateProblemOccurrenceReview(library, { ...decision, items: [{ ...decision.items[0], evidence: [{ evidence_id: "id", source: "answer" }] }] }));
  assert.deepEqual(library, before);
});

test("invalid audit events cannot silently restore samples or drift to another component", () => {
  const { library, decision } = fixture();
  const next = applyProblemOccurrenceReview(library, decision, proof(library, decision), { evaluatorVersion: "after" });
  const corrupted = structuredClone(next);
  const detail = corrupted.events.at(-1)!.detail as unknown as { targets: ProblemOccurrenceReviewTarget[] };
  detail.targets[0]!.association.component_id = randomUUID();
  assert.throws(() => effectiveProblemOccurrences(corrupted), /原来源或组件不一致/);
  const missing = structuredClone(next);
  delete missing.classes[next.occurrences[0]!.class_id];
  assert.throws(() => effectiveProblemOccurrences(missing), /缺少真实问题类/);
  const collision = structuredClone(library);
  collision.events.push({ id: decision.id, type: "class_updated", at: "", detail: {} });
  assert.throws(() => acceptedProblemOccurrenceReview(collision, decision), /其他事件/);
});
