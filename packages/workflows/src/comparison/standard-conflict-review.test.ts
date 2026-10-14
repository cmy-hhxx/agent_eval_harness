import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { emptyUsage, type PlannedTask, type RunState, type SubmissionReceipt, type WorkflowDefinition } from "@eval/contracts";
import { standardConflictReviewInstructions } from "@eval/agents/attribution";
import { evidenceId } from "@eval/tools";
import { attributionResult, criteriaResult, emptyAudit, fakeIdentity, fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";
import { buildPlan } from "./input.js";
import { bindTask } from "./binding.js";
import { comparisonWorkflow } from "./workflow.js";
import { reconcileRun } from "./run-data.js";
import { summarizeResults } from "./report.js";
import type { TaskData } from "./types.js";

function apply(state: RunState, change: ReturnType<NonNullable<WorkflowDefinition["advance"]>>) {
  for (const replacement of change.replace ?? []) state.manifest.tasks[state.manifest.tasks.findIndex(task => task.id === replacement.id)] = replacement;
  for (const added of change.tasks) {
    state.manifest.tasks.push(added); state.manifest.states[added.id] = { status: "pending", attempts: 0 };
  }
}

for (const confirmed of [false, true]) test(`standard conflict review ${confirmed ? "confirms" : "withdraws"} the proposal once before comparison and rewrite`, async () => {
  const spaced = raw(); spaced.messages[0].content = "计算 2 + 2";
  const fixture = await fixtureConfig([[raw()], [], [spaced], []], true, true);
  try {
    const plan = await buildPlan(fixture.config), criteria = plan.tasks.find(task => task.stage === "criteria")!;
    const source = plan.tasks.find(task => task.stage === "attribution")!;
    const evaluationFor = (task: PlannedTask) => {
      const evaluation = attributionResult(false, "2+2=4", true, task.inputIds.answer);
      const question = (task.data as TaskData).candidates.A.question;
      evaluation.criterion_assessments[0].evidence[1] = {
        evidence_id: evidenceId(task.inputIds.answer, 0, "text", "/content", 0, question.length), message_index: 0, quote: question,
      };
      return evaluation;
    };
    const value = evaluationFor(source);
    value.standard_conflict = true;
    const receipt = (taskId: string, evaluation: unknown): SubmissionReceipt => ({ taskId, evaluation,
      attemptId: taskId, submissionId: taskId, acceptedAt: 1, status: "succeeded", evaluatorVersion: "fixture",
      judge: "fixture", audit: emptyAudit(), usage: emptyUsage() });
    const receipts = { [criteria.id]: receipt(criteria.id, criteriaResult()), [source.id]: receipt(source.id, value) };
    const state: RunState = { usage: emptyUsage(), recordedAttempts: 0, receipts, manifest: {
      format: "evaluation-run", runId: "standard-review", debug: false, status: "running", startedAt: 1,
      engine: fakeIdentity, evaluatorVersion: "fixture", config: fixture.config,
      inputCatalog: plan.catalog, inputs: {}, preflight: plan.summary,
      tasks: [...plan.tasks], states: Object.fromEntries(plan.tasks.map(task =>
        [task.id, { status: receipts[task.id] ? "succeeded" : "pending", attempts: 0 }])) } };
    const before = structuredClone(receipts[source.id]);
    const counterpart = plan.tasks.find(task => task.stage === "attribution" && task.id !== source.id)!;
    state.manifest.states[counterpart.id].status = "running";
    const change = comparisonWorkflow.advance!(source, receipts[source.id], state, plan.inputs);
    const reviews = change.tasks.filter(task => task.stage === "attribution");
    assert.equal(reviews.length, 2, "both sides are reviewed even while the other original attribution is running");
    const review = reviews.find(task => (task.data as TaskData).reviewOf!.taskId === source.id)!;
    const peerReview = reviews.find(task => (task.data as TaskData).reviewOf!.taskId === counterpart.id)!;
    assert.equal((review.data as TaskData).standardConflictReview, true);
    assert.equal((review.data as TaskData).reviewOf!.taskId, source.id);
    assert.deepEqual(source.inputIds, { answer: source.inputIds.answer }, "ordinary attribution remains isolated");
    assert.deepEqual(review.inputIds, { answer: source.inputIds.answer, peer_1: counterpart.inputIds.answer });
    assert.deepEqual((review.data as TaskData).referenceCandidates, { peer_1: (counterpart.data as TaskData).candidates.A });
    assert.deepEqual(review.dependencies, source.dependencies, "fresh review does not read the proposed judgment");
    assert.deepEqual(peerReview.inputIds, { answer: counterpart.inputIds.answer, peer_1: source.inputIds.answer });
    assert.deepEqual(peerReview.dependencies, counterpart.dependencies);
    assert.deepEqual((peerReview.data as TaskData).reviewOf!.reasons, (review.data as TaskData).reviewOf!.reasons);
    apply(state, change);
    const consumers = state.manifest.tasks.filter(task => Object.values(task.dependencies).some(id => reviews.some(review => review.id === id)));
    assert(consumers.some(task => task.stage === "comparison"));
    assert(consumers.some(task => task.stage === "clustering"));
    const polish = consumers.find(task => task.stage === "rewrite" && task.dependencies.source === review.id)!;
    assert.equal((polish.data as TaskData).rewriteOf!.taskId, review.id);
    assert.equal((polish.data as TaskData).rewriteOf!.resultId, review.id);
    const resumed = await reconcileRun(fixture.directory, state, fixture.config);
    const resumedReview = resumed.tasks.find(task => task.id === review.id)!;
    assert(resumedReview, "resume preserves the unpaid independent review");
    assert.deepEqual(resumedReview.inputIds, review.inputIds, "resume retains the same original opponent input");
    assert.deepEqual((resumedReview.data as TaskData).referenceCandidates, (review.data as TaskData).referenceCandidates);
    assert.deepEqual(resumed.tasks.find(task => task.id === peerReview.id)!.inputIds, peerReview.inputIds);
    for (const consumer of consumers) assert.deepEqual(resumed.tasks.find(task => task.id === consumer.id)!.dependencies,
      consumer.dependencies, "resume must not restore the unreviewed proposal as a source");
    assert(state.manifest.tasks.filter(task => task.stage === "clustering").every(task => !comparisonWorkflow.canStart!(task, state.manifest)));
    const bound = bindTask(review, plan.inputs, { criteria: receipts[criteria.id] }, { tasks: state.manifest.tasks });
    assert.deepEqual(bound.request.input.review_context, { reasons: [standardConflictReviewInstructions] });
    assert.equal(bound.request.sources.peer_1.id, counterpart.inputIds.answer);
    assert.deepEqual(bound.request.sources.peer_1.value, plan.inputs[counterpart.inputIds.answer]);
    const peer = (bound.request.input.reference_materials as Record<string, { final_answer: string; grader_only: boolean }>).peer_1;
    assert.equal(peer.final_answer, "2+2=4");
    assert.equal(peer.grader_only, true);
    assert.equal(bound.request.input.attributions, undefined, "fresh review receives original answers without earlier judgments");
    const boundPeer = bindTask(peerReview, plan.inputs, { criteria: receipts[criteria.id] }, { tasks: state.manifest.tasks });
    assert.deepEqual(boundPeer.request.sources.peer_1.value, plan.inputs[source.inputIds.answer]);
    assert.deepEqual(boundPeer.request.input.review_context, bound.request.input.review_context);
    assert.deepEqual(comparisonWorkflow.advance!(source, receipts[source.id], state, plan.inputs).tasks, [], "replaying advancement cannot duplicate the review");
    const reviewed = { ...value, standard_conflict: confirmed };
    state.receipts[review.id] = receipt(review.id, reviewed); state.manifest.states[review.id].status = "succeeded";
    const next = comparisonWorkflow.advance!(review, state.receipts[review.id], state, plan.inputs);
    assert.equal(next.tasks.filter(task => (task.data as TaskData).standardConflictReview).length, 0, "confirmation does not loop");
    apply(state, next);
    const comparison = state.manifest.tasks.find(task => task.stage === "comparison")!;
    assert(Object.values(comparison.dependencies).includes(peerReview.id));
    assert(Object.values(comparison.dependencies).some(id => !state.receipts[id]), "comparison waits for the second review");
    const peerValue = evaluationFor(counterpart); peerValue.standard_conflict = confirmed;
    state.receipts[peerReview.id] = receipt(peerReview.id, peerValue);
    state.manifest.states[peerReview.id].status = "succeeded";
    const peerNext = comparisonWorkflow.advance!(peerReview, state.receipts[peerReview.id], state, plan.inputs);
    assert(peerNext.tasks.every(task => task.stage === "rewrite"), "accepted source reviews only expand their independent text groups");
    apply(state, peerNext);
    for (const accepted of [review, peerReview]) {
      const groups = state.manifest.tasks.filter(task => task.stage === "rewrite" && task.dependencies.source === accepted.id)
        .map(task => (task.data as TaskData).rewriteSlotIds!);
      assert.equal(groups.length, 3, "overview, criterion checks and the finding own separate text work");
      assert(groups.some(ids => ids.includes("summary") && ids.includes("core_assessment.reason")));
      assert(groups.some(ids => ids.every(id => id.startsWith("criterion_assessments."))));
      assert(groups.some(ids => ids.every(id => id.startsWith("findings.0."))));
      assert.deepEqual(comparisonWorkflow.advance!(accepted, state.receipts[accepted.id], state, plan.inputs), { tasks: [] },
        "replaying an accepted review must preserve its already scheduled rewrite groups");
    }
    state.receipts[counterpart.id] = receipt(counterpart.id, { ...peerValue, standard_conflict: true }); state.manifest.states[counterpart.id].status = "succeeded";
    assert.deepEqual(comparisonWorkflow.advance!(counterpart, state.receipts[counterpart.id], state, plan.inputs), { tasks: [] },
      "a late original proposal neither duplicates review nor changes downstream sources");
    assert(state.manifest.tasks.filter(task => task.stage === "clustering").every(task => comparisonWorkflow.canStart!(task, state.manifest)));
    const rows = [review, peerReview, counterpart, source].map(task => ({
      task_id: task.id, ...(task.data as TaskData).candidates.A,
      is_correct: false, standard_conflict: (state.receipts[task.id].evaluation as { standard_conflict: boolean }).standard_conflict,
    }));
    const statistics = summarizeResults(state.manifest.tasks, [], rows, [], [], []);
    assert.deepEqual((statistics.standard_conflicts ?? []).map(row => row.task_id).sort(), confirmed ? reviews.map(task => task.id).sort() : [],
      "late original rows cannot replace either reviewed source in statistics");
    assert.deepEqual(receipts[source.id], before, "original evidence and judgment history stay intact");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("standard review uses only distinct current opponents and leaves absent peer evidence absent", async () => {
  const fixture = await fixtureConfig([[raw()], [], [raw()], []], false, false);
  try {
    const plan = await buildPlan(fixture.config), source = plan.tasks.find(task => task.stage === "attribution")!;
    const pair = plan.tasks.find(task => task.stage === "comparison")!;
    const receipt = { taskId: source.id, evaluation: { standard_conflict: true } } as SubmissionReceipt;
    const state = { manifest: { config: fixture.config, tasks: [...plan.tasks, { ...pair, id: "same-opponent-another-pair" }], states: {} },
      receipts: { [source.id]: receipt } } as unknown as RunState;
    const withPeer = comparisonWorkflow.advance!(source, receipt, state, plan.inputs).tasks[0]!;
    assert.equal(Object.keys((withPeer.data as TaskData).referenceCandidates!).length, 1);
    state.receipts[pair.id] = { taskId: pair.id } as SubmissionReceipt;
    state.receipts["same-opponent-another-pair"] = { taskId: "same-opponent-another-pair" } as SubmissionReceipt;
    const withoutPeer = comparisonWorkflow.advance!(source, receipt, state, plan.inputs).tasks[0]!;
    assert.deepEqual(withoutPeer.inputIds, { answer: source.inputIds.answer });
    assert.deepEqual((withoutPeer.data as TaskData).referenceCandidates, {});
    assert.deepEqual((withoutPeer.data as TaskData).reviewOf!.reasons, [standardConflictReviewInstructions],
      "the independent reviewer decides from available evidence; the workflow does not invent answer agreement");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

for (const status of ["running", "succeeded"] as const) test(`standard review preserves ${status} consumers and creates replacement polish`, async () => {
  const fixture = await fixtureConfig([[raw()], [], [raw()], []], true, true);
  try {
    const plan = await buildPlan(fixture.config), source = plan.tasks.find(task => task.stage === "attribution")!;
    const counterpart = plan.tasks.find(task => task.stage === "attribution" && task.id !== source.id)!;
    const pair = plan.tasks.find(task => task.stage === "comparison")!;
    const polish = plan.tasks.find(task => task.stage === "rewrite" && task.dependencies.source === counterpart.id)!;
    const protectedPair = { ...pair, id: "already-started-pair" };
    const receipt = { taskId: source.id, evaluation: { standard_conflict: true } } as SubmissionReceipt;
    const state = { manifest: { config: fixture.config, tasks: [...plan.tasks, protectedPair], states: {
      [polish.id]: { status }, [protectedPair.id]: { status },
    } }, receipts: { [source.id]: receipt,
      ...(status === "succeeded" ? { [polish.id]: { taskId: polish.id }, [protectedPair.id]: { taskId: protectedPair.id } } : {}),
    } } as unknown as RunState;
    const change = comparisonWorkflow.advance!(source, receipt, state, plan.inputs);
    assert(!(change.replace ?? []).some(task => task.id === polish.id || task.id === protectedPair.id));
    const review = change.tasks.find(task => task.stage === "attribution" && (task.data as TaskData).reviewOf!.taskId === counterpart.id)!;
    const replacementPolish = change.tasks.find(task => task.stage === "rewrite")!;
    assert.notEqual(replacementPolish.id, polish.id);
    assert.equal(replacementPolish.dependencies.source, review.id);
    const replacementPair = change.replace!.find(task => task.id === pair.id)!;
    assert(Object.values(replacementPair.dependencies).includes(review.id));
    assert.equal(change.tasks.filter(task => task.stage === "attribution").length, 2);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("coverage review retains shared standard evidence and cannot restore late original sources", async () => {
  const fixture = await fixtureConfig([[raw()], [], [raw()], []], false, true);
  try {
    const plan = await buildPlan(fixture.config), criteria = plan.tasks.find(task => task.stage === "criteria")!;
    const source = plan.tasks.find(task => task.stage === "attribution")!;
    const receipt = (task: PlannedTask, evaluation: unknown) => ({ taskId: task.id, evaluation, status: "succeeded", audit: emptyAudit() }) as SubmissionReceipt;
    const state = { manifest: { config: fixture.config, tasks: [...plan.tasks], states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])) },
      receipts: { [criteria.id]: receipt(criteria, criteriaResult()) } } as unknown as RunState;
    const original = attributionResult(true, "2+2=4", true, source.inputIds.answer); original.standard_conflict = true;
    state.receipts[source.id] = receipt(source, original);
    apply(state, comparisonWorkflow.advance!(source, state.receipts[source.id], state, plan.inputs));
    const reviews = state.manifest.tasks.filter(task => (task.data as TaskData).standardConflictReview);
    for (const review of reviews) {
      const evaluation = attributionResult(true, "2+2=4", true, review.inputIds.answer); evaluation.standard_conflict = true;
      const finding = evaluation.findings[0];
      finding.type = "problem"; finding.assessment.requirement_index = null;
      finding.problem = { component: ["模型自身推理"], label: "附加说明缺乏依据", definition: "附加说明无法从给定资料得到。" };
      state.receipts[review.id] = receipt(review, evaluation); state.manifest.states[review.id].status = "succeeded";
      apply(state, comparisonWorkflow.advance!(review, state.receipts[review.id], state, plan.inputs));
    }
    const coverage = state.manifest.tasks.filter(task => (task.data as TaskData).coverageReview);
    assert.equal(coverage.length, 2);
    for (const next of coverage) {
      const prior = reviews.find(task => task.id === (next.data as TaskData).reviewOf!.taskId)!;
      assert.equal((next.data as TaskData).standardConflictReview, true);
      assert.deepEqual(next.inputIds, prior.inputIds);
      assert.deepEqual((next.data as TaskData).referenceCandidates, (prior.data as TaskData).referenceCandidates);
      assert((next.data as TaskData).reviewOf!.reasons.includes(standardConflictReviewInstructions));
      assert.doesNotThrow(() => bindTask(next, plan.inputs, { criteria: state.receipts[criteria.id] }, { tasks: state.manifest.tasks }));
      state.receipts[next.id] = receipt(next, original); state.manifest.states[next.id].status = "succeeded";
      apply(state, comparisonWorkflow.advance!(next, state.receipts[next.id], state, plan.inputs));
    }
    const old = plan.tasks.find(task => task.stage === "attribution" && task.id !== source.id)!;
    (old.data as TaskData).coverageReview = true;
    const late = receipt(old, { ...original, standard_conflict: false });
    assert.deepEqual(comparisonWorkflow.advance!(old, late, state, plan.inputs), { tasks: [] },
      "a late non-proposing coverage source cannot replace the standard review in clustering");
    assert.equal(state.manifest.tasks.filter(task => (task.data as TaskData).standardConflictReview).length, 4,
      "coverage retains the review context rather than starting another standard round");
    for (const cluster of state.manifest.tasks.filter(task => task.stage === "clustering"))
      for (const [inputId, taskId] of Object.entries(cluster.dependencies))
        assert.equal(taskId, coverage.find(task => task.inputIds.answer === inputId)!.id);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("an ordinary standard mismatch does not request an extra standard review", async () => {
  const fixture = await fixtureConfig([[raw()], [], [raw()], []], false, false);
  try {
    const plan = await buildPlan(fixture.config), task = plan.tasks.find(task => task.stage === "attribution")!;
    const evaluation = attributionResult(false, "2+2=4", true, task.inputIds.answer);
    evaluation.standard_conflict = false;
    const receipt = { taskId: task.id, evaluation } as SubmissionReceipt;
    const state = { manifest: { config: fixture.config, tasks: plan.tasks }, receipts: { [task.id]: receipt } } as unknown as RunState;
    assert.deepEqual(comparisonWorkflow.advance!(task, receipt, state, plan.inputs).tasks, []);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
