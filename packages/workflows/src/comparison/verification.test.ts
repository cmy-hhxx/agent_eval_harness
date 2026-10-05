import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { canonical, DEFAULT_POLICY, emptyUsage, projectEvidenceReferences, type AttemptSpec, type JsonObject, type PlannedTask, type RunState, type SubmissionReceipt, type ToolAudit } from "@eval/contracts";
import { randomUUID } from "node:crypto";
import { RunStore } from "@eval/host";
import { cite, evidenceSources } from "@eval/tools";
import { agents, services } from "../../../../tests/fixtures/services.js";
import { attributionResult, comparisonResult, criteriaResultForTask, emptyAudit, fakeEvaluatorVersion, fakeJudge,
  fixtureConfig, inspectedReceiptFor, raw, fakeIdentity } from "../../../../tests/fixtures/comparison.js";
import { comparisonSourceReviews, comparisonInspectionSubmission } from "../../../../tests/fixtures/comparison-submission.js";
import type { ComparisonMaterialInspection } from "@eval/agents/comparison";
import { buildPlan } from "./input.js";
import { bindTask } from "./binding.js";
import { reconcileRun } from "./run-data.js";
import { comparisonWorkflow } from "./workflow.js";
import { comparisonCodec } from "./codec.js";
import { deliveryCoverage, pilotTaskIds } from "./delivery.js";
import { encodeResult } from "./results.js";
import { advanceReview } from "./review.js";
import type { ComparisonResult, RawInput, TaskData } from "./types.js";

const receipt = (task: PlannedTask, evaluation: unknown): SubmissionReceipt => ({ taskId: task.id,
  attemptId: task.id, submissionId: task.id, status: "succeeded", acceptedAt: 1,
  evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, evaluation, audit: emptyAudit(), usage: emptyUsage() });
async function setup(rewrite = true, clustering = true, rows?: RawInput[][]) {
  const fixture = await fixtureConfig(rows, rewrite, clustering);
  const plan = await buildPlan(fixture.config);
  const draft = plan.tasks.find(task => (task.data as TaskData).verificationPending)!;
  const verification = plan.tasks.find(task => (task.data as TaskData).verificationOf)!;
  const criteria = plan.tasks.find(task => task.stage === "criteria")!;
  const analysis = criteriaResultForTask(criteria, plan.inputs);
  const state = { manifest: { format: "evaluation-run", runId: "verification", engine: "pi", evaluatorVersion: fakeEvaluatorVersion,
    config: fixture.config, preflight: plan.summary, tasks: plan.tasks, inputCatalog: plan.catalog,
    inputs: {}, states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])) },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0 } as unknown as RunState;
  state.receipts[criteria.id] = receipt(criteria, analysis);
  for (const task of plan.tasks.filter(task => task.stage === "attribution")) {
    const candidate = (task.data as TaskData).candidates.A!, actual = plan.inputs[candidate.input_id] as RawInput;
    const final = evidenceSources(actual.messages[candidate.final_index]).find(source => source.kind === "text" && source.path === "/content")!;
    const answer = cite(candidate.input_id, candidate.final_index, final, 0, final.text.length);
    const questionIndex = actual.messages.findLastIndex((message, index) => index < candidate.final_index && message.role === "user");
    const question = evidenceSources(actual.messages[questionIndex]).find(source => source.kind === "text" && source.path === "/content")!;
    const result = attributionResult(true, final.text, true, candidate.input_id); result.task_analysis = analysis;
    result.correctness_evidence = [answer]; result.findings[0]!.evidence = [answer];
    result.criterion_assessments[0]!.evidence = [answer, cite(candidate.input_id, questionIndex, question, 0, question.text.length)];
    state.receipts[task.id] = receipt(task, result);
  }
  const result = comparisonResult(); result.task_analysis = analysis;
  state.receipts[draft.id] = receipt(draft, result);
  state.manifest.states[draft.id] = { status: "succeeded", attempts: 4 };
  const dependencies = (task: PlannedTask) => Object.fromEntries(Object.entries(task.dependencies).map(([key, id]) => [key, state.receipts[id]]));
  return { ...fixture, plan, state, draft, verification, result, dependencies };
}

test("each pair has distinct draft/check UUIDs and publication dependencies while pilot and preflight count one pair", async () => {
  const f = await setup();
  try {
    assert.notEqual(f.draft.id, f.verification.id);
    assert.equal(f.plan.summary.comparison_tasks, 1);
    assert.equal(f.plan.summary.comparison_verification_tasks, 1);
    assert.equal(f.verification.dependencies.draft, f.draft.id);
    const pairPolish = f.plan.tasks.find(task => (task.data as TaskData).rewriteOf?.stage === "comparison")!;
    assert.equal(pairPolish.dependencies.source, f.verification.id);
    for (const cluster of f.plan.tasks.filter(task => task.stage === "clustering")) {
      assert(Object.values(cluster.dependencies).includes(f.verification.id));
      assert(!Object.values(cluster.dependencies).includes(f.draft.id));
    }
    const selected = pilotTaskIds(f.plan, 1);
    assert(selected.includes(f.draft.id) && selected.includes(f.verification.id));
    const exported = encodeResult(f.draft, f.state, f.plan.inputs);
    assert.equal(exported.file, "comparison-draft.jsonl"); assert.equal(exported.id, f.draft.id);
    assert.equal(exported.row.evaluation_type, "comparison_draft");
    assert.equal(deliveryCoverage(f.state).by_batch.b1.planned, 1);
    assert.equal(deliveryCoverage(f.state).by_batch.b1.accepted, 0);
    assert.equal(f.state.manifest.states[f.verification.id].attempts, 0, "draft content attempts do not consume the independent check's budget");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("delivery inspects every source rewrite when an accepted history follows the selected pending refresh", async () => {
  const f = await setup();
  try {
    f.state.receipts[f.verification.id] = receipt(f.verification, f.result);
    f.state.manifest.states[f.verification.id] = { status: "succeeded", attempts: 1 };
    const old = f.plan.tasks.find(task => (task.data as TaskData).rewriteOf?.taskId === f.verification.id)!;
    const pending = { ...structuredClone(old), id: randomUUID() };
    const binding = bindTask(old, {}, { source: f.state.receipts[f.verification.id] }, { tasks: f.plan.tasks });
    f.state.receipts[old.id] = receipt(old, { rewrites: (binding.request.input.items as { id: string; text: string }[])
      .map(item => ({ id: item.id, text: item.text })) });
    f.state.manifest.tasks = f.plan.tasks.filter(task => task.id !== old.id).concat(pending, old);
    f.state.manifest.executionScope = [pending.id];
    f.state.receipts[f.verification.id].exported = encodeResult(old, f.state, f.plan.inputs);
    for (const selectedOnly of [false, true]) {
      const coverage = deliveryCoverage(f.state, { rewriteScopes: ["verdicts"], selectedOnly });
      assert.equal(coverage.by_batch.b1?.planned, 1);
      assert.equal(coverage.filled_slots, coverage.required_slots, "saved historical text is still filled");
      assert.equal(coverage.valid, false);
      assert(coverage.errors.some(error => error.includes("requested rewrite not completed")));
    }
    // An accepted checkpoint-only refresh has not replaced the persisted source yet.
    const accepted = receipt(pending, { rewrites: (f.state.receipts[old.id].evaluation as { rewrites: { id: string; text: string }[] }).rewrites
      .map(item => ({ ...item, text: item.text + "新文案" })) });
    accepted.acceptedAt = 2;
    accepted.evaluatorVersion = "checkpoint-polish";
    f.state.receipts[pending.id] = accepted;
    f.state.receipts[old.id].exported = f.state.receipts[f.verification.id].exported;
    const checkpoint = comparisonCodec.encode(f.state);
    const restored = comparisonCodec.decode(checkpoint, () => f.state.receipts[f.verification.id].exported!.row);
    assert.deepEqual(restored.receipts[old.id].evaluation, f.state.receipts[old.id].evaluation);
    assert.deepEqual(restored.receipts[pending.id].evaluation, accepted.evaluation);
    assert.equal((encodeResult(pending, restored, {}).row.rewritten as JsonObject).evaluator_version, "checkpoint-polish");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("verification uses the immutable draft plus full primary facts, and both receipts restore from distinct files", async () => {
  const f = await setup();
  try {
    const before = canonical(f.state.receipts[f.draft.id]);
    const binding = bindTask(f.verification, f.plan.inputs, f.dependencies(f.verification), { tasks: f.plan.tasks });
    assert.equal(binding.profile, "verification");
    const prepared = agents.prepare(binding);
    assert.equal(prepared.evaluation.profile, "verification");
    const model = binding.modelInput as { sections: { materials?: Record<string, unknown>[] }[] };
    const answers = model.sections[0].materials!.filter(material => material.kind === "answer");
    for (const material of answers) {
      assert.equal(material.final_answer, "2+2=4");
      assert(!Object.hasOwn(material, "instruction_sources"));
      assert(Object.hasOwn(material, "original_user_timestamp"));
    }
    const accepted = await inspectedReceiptFor(f.verification, f.state, f.plan.inputs);
    const resolved = accepted.evaluation as ComparisonResult;
    agents.validate(binding, resolved, accepted.audit);
    assert.deepEqual(resolved, f.result);
    assert.notEqual(resolved, f.result);
    assert.equal(canonical(f.state.receipts[f.draft.id]), before);
    assert(accepted.audit.inspection, "the restore receipt retains the actual successful Host inspection");
    assert.equal(accepted.submissionStats!.contentSubmissions, 2);
    f.state.receipts[f.verification.id] = accepted;
    f.state.manifest.states[f.verification.id] = { status: "succeeded", attempts: 1 };
    for (const task of f.plan.tasks) if (f.state.receipts[task.id]) f.state.receipts[task.id].exported = encodeResult(task, f.state, f.plan.inputs);
    const checkpoint = comparisonCodec.encode(f.state);
    assert.equal(checkpoint.tasks[f.draft.id].receipt!.exported!.taskId, f.draft.id);
    assert.equal(checkpoint.tasks[f.verification.id].receipt!.exported!.comparisonId, (f.verification.data as TaskData).comparisonId);
    assert.equal(checkpoint.tasks[f.draft.id].receipt!.evaluation, undefined);
    const rows = new Map(Object.values(f.state.receipts).map(r => [r.exported!.file + ":" + r.exported!.id, r.exported!.row]));
    const restored = comparisonCodec.decode(checkpoint, ref => rows.get(ref.file + ":" + ref.id)!);
    assert.deepEqual(restored.receipts[f.draft.id], f.state.receipts[f.draft.id]);
    assert.deepEqual(restored.receipts[f.verification.id], f.state.receipts[f.verification.id]);
    assert.equal(restored.manifest.states[f.draft.id].attempts, 4);
    assert.equal(restored.manifest.states[f.verification.id].attempts, 1);
    assert.throws(() => bindTask(f.verification, f.plan.inputs, { ...f.dependencies(f.verification), draft: undefined }, { tasks: f.plan.tasks }), /草稿/);
    checkpoint.tasks[f.draft.id].receipt!.exported!.file = "comparison.jsonl";
    assert.throws(() => comparisonCodec.decode(checkpoint, ref => rows.get(ref.file + ":" + ref.id)!), /草稿/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("only the check drives one source-review round, and peer facts require the registered question and preserve each source’s original time", async () => {
  const f = await setup();
  try {
    const pending: ComparisonResult = { ...f.result, status: "needs_review", ranking: [],
      review_requests: [{ candidate: "A", criterion_ids: [f.result.task_analysis.requirements[0].id], finding_indices: [], reason: "请核实来源支持。" }] };
    const fromDraft = advanceReview(f.draft, receipt(f.draft, pending), f.state, f.plan.inputs)!;
    assert.equal(fromDraft.tasks!.length, 0);
    const parent = { ...await inspectedReceiptFor(f.verification, f.state, f.plan.inputs), evaluation: pending };
    f.state.receipts[f.verification.id] = parent;
    const changed = advanceReview(f.verification, parent, f.state, f.plan.inputs)!;
    const reviews = changed.tasks!.filter(task => task.stage === "attribution");
    assert.equal(reviews.length, 1);
    const data = reviews[0].data as TaskData;
    assert.equal(Object.keys(data.referenceCandidates!).length, 1, "two unknown dates remain unknown but the registered same question can be a grader-only fact source");
    const reviewBinding = bindTask(reviews[0], f.plan.inputs, f.dependencies(reviews[0]),
      { tasks: [...f.plan.tasks, ...changed.tasks!] });
    const peer = Object.values(reviewBinding.request.input.reference_materials as Record<string, Record<string, unknown>>)[0];
    assert.equal(peer.grader_only, true); assert.equal(peer.original_user_timestamp, null);
    assert(!Object.hasOwn(peer, "instruction_sources"));
    const peerKey = Object.keys(data.referenceCandidates!)[0];
    const modelPeer = (reviewBinding.modelInput!.reference_materials as Record<string, { final_evidence: { reference: { evidence_id: string } }[] }>)[peerKey];
    assert.deepEqual(Object.keys(modelPeer.final_evidence[0].reference), ["evidence_id"]);
    assert(modelPeer.final_evidence[0].reference.evidence_id.startsWith(`ev_${data.referenceCandidates![peerKey].input_id}_`));
    const followupDraft = changed.tasks!.find(task => (task.data as TaskData).verificationPending)!;
    const followupCheck = changed.tasks!.find(task => (task.data as TaskData).verificationOf)!;
    assert.equal(followupCheck.dependencies.draft, followupDraft.id);
    assert.equal((followupCheck.data as TaskData).reviewOf!.round, 1);
    assert.notEqual(followupCheck.id, f.verification.id);
    const terminal = advanceReview(followupCheck, receipt(followupCheck, pending), f.state, f.plan.inputs)!;
    assert.equal(terminal.tasks!.length, 0);
    const peerCandidate = Object.values(data.referenceCandidates!)[0];
    const changedInputs = { ...f.plan.inputs };
    const rawPeer = changedInputs[peerCandidate.input_id] as RawInput;
    rawPeer.messages[0].timestamp = "2026-09-25T00:00:00Z";
    const datedBinding = bindTask(reviews[0], changedInputs, f.dependencies(reviews[0]),
      { tasks: [...f.plan.tasks, ...changed.tasks!] });
    const datedPeer = Object.values(datedBinding.request.input.reference_materials as Record<string, Record<string, unknown>>)[0];
    assert.equal(datedPeer.original_user_timestamp, "2026-09-25T00:00:00Z");
    assert.equal((datedBinding.modelInput!.task_focus as { answers: { answer: { question_timestamp: unknown } } }).answers.answer.question_timestamp, null,
      "the peer's known date never fills the answer's unknown native date");
    const invalid = structuredClone(reviews[0]);
    (invalid.data as TaskData).referenceCandidates![peerKey].question = "不同原问";
    assert.throws(() => bindTask(invalid, changedInputs, f.dependencies(invalid),
      { tasks: [...f.plan.tasks, ...changed.tasks!] }), /事实复核来源/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});


test("an accepted unmarked standalone comparison remains its original task and formal receipt on same-run planning and restore", async () => {
  const f = await setup();
  try {
    const standalone = structuredClone(f.verification);
    delete (standalone.data as TaskData).verificationOf;
    delete standalone.dependencies.draft;
    const previous = { ...f.plan, tasks: f.plan.tasks.filter(task => task.id !== f.draft.id)
      .map(task => task.id === standalone.id ? standalone : task) };
    f.state.manifest.tasks = previous.tasks;
    delete f.state.manifest.states[f.draft.id]; delete f.state.receipts[f.draft.id];
    f.state.receipts[standalone.id] = { ...receipt(standalone, f.result), submitted: { status: "decided" } };
    f.state.manifest.states[standalone.id] = { status: "succeeded", attempts: 4 };
    for (const task of previous.tasks) if (f.state.receipts[task.id])
      f.state.receipts[task.id].exported = encodeResult(task, f.state, f.plan.inputs);
    assert.equal(f.state.receipts[standalone.id].exported!.file, "comparison.jsonl");
    const before = structuredClone(f.state.receipts[standalone.id]);
    const next = await buildPlan(f.config, previous, { acceptedTaskIds: new Set([standalone.id]) });
    assert.equal(next.tasks.filter(task => task.stage === "comparison").length, 0,
      "fresh planning does not create a draft/check pair for a pair already accepted by its existing definition");
    const checkpoint = comparisonCodec.encode(f.state);
    const rows = new Map(Object.values(f.state.receipts).map(r => [r.exported!.file + ":" + r.exported!.id, r.exported!.row]));
    const restored = comparisonCodec.decode(checkpoint, ref => rows.get(ref.file + ":" + ref.id)!);
    const restoredTask = restored.manifest.tasks.find(task => task.id === standalone.id)!;
    assert.equal((restoredTask.data as TaskData).verificationOf, undefined);
    assert.equal((restoredTask.data as TaskData).verificationPending, undefined);
    assert.equal(restored.manifest.states[standalone.id].attempts, 4);
    assert.deepEqual(restored.receipts[standalone.id], before);
    const bound = bindTask(restoredTask, f.plan.inputs, f.dependencies(restoredTask), { tasks: previous.tasks });
    assert.equal(bound.profile, "default");
    assert(!Object.hasOwn(bound.request.input, "comparison_draft"));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});


test("same-run reconciliation continues a pending standalone definition without duplicating the pair or resetting its attempts", async () => {
  const f = await setup(false, false);
  try {
    const standalone = structuredClone(f.verification);
    delete (standalone.data as TaskData).verificationOf;
    delete standalone.dependencies.draft;
    f.state.manifest.tasks = f.plan.tasks.filter(task => task.id !== f.draft.id)
      .map(task => task.id === standalone.id ? standalone : task);
    delete f.state.receipts[f.draft.id]; delete f.state.manifest.states[f.draft.id];
    f.state.manifest.states[standalone.id] = { status: "pending", attempts: 4 };
    const before = structuredClone(standalone);
    f.config.clustering.enabled = true;
    await reconcileRun(f.directory, f.state, f.config);
    const comparisons = f.state.manifest.tasks.filter(task => task.stage === "comparison");
    assert.deepEqual(comparisons, [before]);
    assert.equal(f.state.manifest.states[standalone.id].attempts, 4);
    assert.equal(f.state.manifest.preflight.comparison_tasks, 1);
    assert.equal(f.state.manifest.preflight.comparison_verification_tasks, 0);
    assert.equal(f.state.receipts[standalone.id], undefined);
    const binding = bindTask(comparisons[0], f.plan.inputs, f.dependencies(comparisons[0]), { tasks: f.state.manifest.tasks });
    assert.equal(binding.profile, "default");
    const clusters = f.state.manifest.tasks.filter(task => task.stage === "clustering");
    assert.equal(clusters.length, 2);
    for (const cluster of clusters) assert(Object.values(cluster.dependencies).includes(standalone.id));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});


test("enabling clustering on same-run resume gates new shards on the active followup check and uses its reviewed attribution", async () => {
  const f = await setup(false, false);
  try {
    const pending: ComparisonResult = { ...f.result, status: "needs_review", ranking: [],
      review_requests: [{ candidate: "A", criterion_ids: [f.result.task_analysis.requirements[0].id], finding_indices: [], reason: "核实实际来源。" }] };
    f.state.receipts[f.verification.id] = receipt(f.verification, pending);
    const changed = advanceReview(f.verification, f.state.receipts[f.verification.id], f.state, f.plan.inputs)!;
    const replaced = new Map(changed.replace!.map(task => [task.id, task]));
    f.state.manifest.tasks = [...f.state.manifest.tasks.map(task => replaced.get(task.id) ?? task), ...changed.tasks!];
    for (const task of changed.tasks!) f.state.manifest.states[task.id] = { status: "pending", attempts: 0 };
    const reviewed = changed.tasks!.find(task => task.stage === "attribution")!;
    const oldSourceId = (reviewed.data as TaskData).reviewOf!.taskId;
    f.state.receipts[reviewed.id] = receipt(reviewed, structuredClone(f.state.receipts[oldSourceId].evaluation));
    const followupDraft = changed.tasks!.find(task => (task.data as TaskData).verificationPending)!;
    const followupCheck = changed.tasks!.find(task => (task.data as TaskData).verificationOf)!;
    f.state.receipts[followupDraft.id] = receipt(followupDraft, f.result);
    const before = structuredClone(f.state.receipts);
    f.config.clustering.enabled = true;
    f.config.clustering.maxCasesPerTask = 1;
    await reconcileRun(f.directory, f.state, f.config);
    const clusters = f.state.manifest.tasks.filter(task => task.stage === "clustering");
    assert.equal(clusters.length, 2, "one shard per current answer, without separately classifying the superseded source attribution");
    for (const cluster of clusters) {
      const data = cluster.data as TaskData;
      assert.equal(Object.keys(data.scope!.cases).length, 1);
      assert(Object.values(cluster.dependencies).includes(followupCheck.id));
      assert(!Object.values(cluster.dependencies).includes(f.verification.id));
      assert(!Object.values(cluster.dependencies).includes(f.draft.id));
      assert(!Object.values(cluster.dependencies).includes(followupDraft.id));
      assert(!Object.values(cluster.dependencies).includes(oldSourceId));
      const id = Object.keys(data.scope!.cases)[0];
      if (id === reviewed.inputIds.answer) assert.equal(cluster.dependencies[id], reviewed.id);
    }
    assert.equal(f.state.receipts[followupCheck.id], undefined, "the current check remains pending and gates the new shards");
    assert.deepEqual(f.state.receipts, before);
    // The same gate also survives a terminal accepted needs_review check.
    f.state.receipts[followupCheck.id] = receipt(followupCheck, pending);
    await reconcileRun(f.directory, f.state, f.config);
    for (const cluster of f.state.manifest.tasks.filter(task => task.stage === "clustering")) {
      assert(Object.values(cluster.dependencies).includes(followupCheck.id));
      const dependencies = Object.fromEntries(Object.entries(cluster.dependencies).map(([key, id]) => [key, f.state.receipts[id]]));
      assert.equal(comparisonWorkflow.blockedReason!(cluster, dependencies), "Independent review is unresolved");
    }
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Host-accepted unselected private norm discovery routes only its owner through one bounded Attribution review", async () => {
  const norm = "## Delivery\nEnd text replies with one question.\n\nA delivered file is exempt.";
  const own = raw(); own.messages.unshift({ role: "system", content: norm });
  const f = await setup(true, true, [[own], [own], [own], [own]]);
  try {
    const candidate = (f.verification.data as TaskData).candidates.A!, originalSourceId = f.verification.dependencies.A;
    const beforeReceipts = structuredClone(f.state.receipts), beforeTasks = new Set(f.state.manifest.tasks.map(task => task.id));
    f.state.manifest.engine = fakeIdentity;
    const binding = comparisonWorkflow.bind(f.verification, f.plan.inputs, f.dependencies(f.verification), { tasks: f.plan.tasks });
    const prepared = agents.prepare(binding), source = binding.request.sources.A!;
    const actual = source.value as RawInput, leaf = evidenceSources(actual.messages[0]).find(item => item.kind === "text" && item.path === "/content")!;
    const value = { checks: Object.entries((binding.request.input.candidates as unknown as Record<string, { candidate_id: string; final_message_index: number }>))
      .flatMap(([label, material]) => f.result.task_analysis.requirements.filter(requirement => !requirement.applies_to.length || requirement.applies_to.includes(material.candidate_id))
        .map(requirement => {
          const owner = binding.request.sources[label]!, answer = evidenceSources((owner.value as RawInput).messages[material.final_message_index])
            .find(item => item.kind === "text" && item.path === "/content")!;
          return { candidate: label, criterion_id: requirement.id, result: "supported", source_evidence: [], observation: "The actual common arithmetic deliverable is correct.",
            answer_evidence: [{ evidence_id: cite(owner.id, material.final_message_index, answer, 0, answer.text.length).evidence_id }] };
        })), concerns: [{ candidate: "A", criterion_ids: [],
        answer_evidence: [{ evidence_id: cite(source.id, candidate.final_index, evidenceSources(actual.messages[candidate.final_index])
          .find(item => item.kind === "text" && item.path === "/content")!, 0, "2+2=4".length).evidence_id }],
        source_evidence: [{ evidence_id: cite(source.id, 0, leaf, 0, norm.length).evidence_id }],
        reason: "A's own applicable SYS rule requires a final question; this text reply lacks it, and the file exception is inapplicable." }] };
    const spec: AttemptSpec = { ...prepared, taskId: f.verification.id, attemptId: randomUUID(), runId: f.state.manifest.runId,
      inputRevision: 1, engine: fakeIdentity, model: { provider: "fixture", baseUrl: "http://127.0.0.1:1", api: "openai-completions",
        apiKeyEnv: "FIXTURE_KEY", model: fakeJudge, thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 }, policy: DEFAULT_POLICY,
      inputs: Object.entries(f.verification.inputIds).map(([name, id]) => ({ name, id })), deadline: Date.now() + 60000, hostUrl: "http://127.0.0.1:1" };
    const store = new RunStore(f.directory + "/local-review", f.state, f.plan.inputs, services);
    await store.activate(spec);
    const audit: ToolAudit = { ...emptyAudit(), evidenceBank: [...prepared.evidenceBank] };
    const selected = projectEvidenceReferences(comparisonInspectionSubmission(binding.request, value as ComparisonMaterialInspection), audit.evidenceBank!);
    const inspected = await store.inspect({ taskId: f.verification.id, attemptId: spec.attemptId,
      inspectionId: randomUUID(), value: selected as unknown as JsonObject, audit, contentSubmissions: 1 });
    audit.inspection = inspected.inspection;
    audit.evidenceBank = inspected.evidenceBank;
    const review = { candidate: "A", criterion_ids: [], finding_indices: [], reason: value.concerns[0].reason };
    const accepted = await store.accept({ taskId: f.verification.id, attemptId: spec.attemptId, submissionId: randomUUID(),
      evaluation: { concern_matches: [], concern_refutations: [], source_reviews: comparisonSourceReviews(binding.request) }, audit, usage: emptyUsage(),
      submissionStats: { contentSubmissions: 2, fileErrors: 0 } });
    assert.deepEqual((accepted.evaluation as ComparisonResult).review_requests, [review]);
    assert.equal(accepted.submissionStats!.contentSubmissions, 2, "actual Host inspection and final submission share the original task budget");
    const added = f.state.manifest.tasks.filter(task => !beforeTasks.has(task.id)), attribution = added.filter(task => task.stage === "attribution");
    assert.equal(attribution.length, 1); assert.equal(attribution[0].inputIds.answer, candidate.input_id);
    assert.equal((attribution[0].data as TaskData).reviewOf!.taskId, originalSourceId);
    for (const [taskId, old] of Object.entries(beforeReceipts)) {
      const { exported: _oldExport, ...before } = old, { exported: _newExport, ...current } = f.state.receipts[taskId];
      assert.deepEqual(current, before, "existing accepted source/core/winner receipts stay intact");
    }
    const followup = added.find(task => (task.data as TaskData).verificationOf)!;
    assert.equal((followup.data as TaskData).reviewOf!.round, 1);
    assert.equal(followup.dependencies.previous_review, f.verification.id, "the previous accepted concern remains a task dependency");
    const reviewed = attribution[0]!;
    const reviewBinding = comparisonWorkflow.bind(reviewed, f.plan.inputs, f.dependencies(reviewed), { tasks: f.state.manifest.tasks });
    const reviewContext = reviewBinding.request.input.review_context as { concerns: { answer_evidence: { evidence_id: string }[]; source_evidence: { evidence_id: string }[] }[] };
    const originalConcern = (accepted.audit.inspection!.value as unknown as ComparisonMaterialInspection).concerns[0]!;
    assert.equal(reviewContext.concerns.length, 1);
    assert.deepEqual(reviewContext.concerns[0]!.answer_evidence, originalConcern.answer_evidence);
    assert.deepEqual(reviewContext.concerns[0]!.source_evidence, originalConcern.source_evidence);
    const sourcePrepared = agents.prepare(reviewBinding);
    assert(!sourcePrepared.prompt.includes('"evidence_id":'), "the reviewed source receives generated numeric references");
    const normDisplay = (reviewBinding.modelInput!.review_context as { concerns: { source_evidence: {
      read_request: { candidate: string; message_index: number; path: string; offset: number }; end_offset: number;
    }[] }[] }).concerns[0]!.source_evidence[0]!;
    assert.equal(normDisplay.read_request.candidate, "answer");
    assert.equal(normDisplay.read_request.message_index, 0);
    assert.equal(normDisplay.read_request.offset, 0);
    assert.equal(normDisplay.end_offset, norm.length, "the review can read the entire original norm and its file exception");
    f.state.receipts[reviewed.id] = receipt(reviewed, f.state.receipts[originalSourceId]!.evaluation);
    const followupDraft = added.find(task => (task.data as TaskData).verificationPending)!;
    f.state.receipts[followupDraft.id] = receipt(followupDraft, f.result);
    const nextBinding = comparisonWorkflow.bind(followup, f.plan.inputs, f.dependencies(followup), { tasks: f.state.manifest.tasks });
    assert.equal((nextBinding.request.input.pending_concerns as unknown[]).length, 1);
    assert(!JSON.stringify(nextBinding.modelInput).includes(value.concerns[0]!.reason), "new independent inspection stays blind to prior findings");
    const fresh = { checks: value.checks, concerns: [] } as ComparisonMaterialInspection;
    const nextAudit: ToolAudit = { ...emptyAudit(), evidenceBank: [...agents.prepare(nextBinding).evidenceBank] };
    const freshSelected = projectEvidenceReferences(comparisonInspectionSubmission(nextBinding.request, fresh), nextAudit.evidenceBank!);
    const nextInspection = agents.resolveInspection(nextBinding, freshSelected as unknown as JsonObject, nextAudit);
    nextAudit.inspection = { id: randomUUID(), value: nextInspection, proof: { traceReads: [], viewedImages: [] } };
    const revealed = agents.inspectCanonical(nextBinding, nextInspection, nextAudit);
    assert(JSON.stringify(revealed).includes(value.concerns[0]!.reason), "the accepted unresolved proof is revealed after the new blind inspection");
    const projected = nextBinding.projectModelInput!(revealed, nextAudit.evidenceBank!);
    const revealedProof = (projected.inspection_context as { verification_concerns: { source_evidence: { evidence_index: number }[] }[] })
      .verification_concerns[0]!.source_evidence[0]!;
    assert(Number.isSafeInteger(revealedProof.evidence_index));
    assert(!Object.hasOwn(revealedProof, "evidence_id"), "the merged program concern directory only offers numeric selections");
    const stillPending = agents.resolve(nextBinding, { concern_matches: [], concern_refutations: [], source_reviews: [] }, nextAudit) as ComparisonResult;
    assert.equal(stillPending.status, "needs_review", "fresh supported checks and empty concerns cannot erase the previous private discovery");
    assert(stillPending.review_requests.some(item => item.reason === value.concerns[0]!.reason));
    const rows = new Map(Object.values(f.state.receipts).filter(item => item.exported)
      .map(item => [item.exported!.file + ":" + item.exported!.id, item.exported!.row]));
    const restored = comparisonCodec.decode(comparisonCodec.encode(f.state), reference => rows.get(reference.file + ":" + reference.id)!);
    const restoredFollowup = restored.manifest.tasks.find(task => task.id === followup.id)!;
    const restoredBinding = comparisonWorkflow.bind(restoredFollowup, f.plan.inputs,
      Object.fromEntries(Object.entries(restoredFollowup.dependencies).map(([key, id]) => [key, restored.receipts[id]])),
      { tasks: restored.manifest.tasks });
    assert.deepEqual(restoredBinding.request.input.pending_concerns, nextBinding.request.input.pending_concerns,
      "restore derives the same exact evidence from the parent receipt without copying it into the new task");
    const checkpoint = comparisonCodec.encode(f.state);
    assert(!JSON.stringify(checkpoint.tasks[followup.id]!.data).includes("answer_evidence"));
    assert.deepEqual(f.state.manifest.states[followup.id], restored.manifest.states[followup.id], "restoring pending proof never resets its budget");
    const swapped = structuredClone(followup), swappedDraft = structuredClone(followupDraft);
    for (const task of [swapped, swappedDraft]) {
      [task.inputIds.A, task.inputIds.B] = [task.inputIds.B, task.inputIds.A];
      [task.dependencies.A, task.dependencies.B] = [task.dependencies.B, task.dependencies.A];
      const candidates = (task.data as TaskData).candidates;
      [candidates.A, candidates.B] = [candidates.B, candidates.A];
    }
    const swappedBinding = comparisonWorkflow.bind(swapped, f.plan.inputs, f.dependencies(swapped),
      { tasks: f.state.manifest.tasks.map(task => task.id === swappedDraft.id ? swappedDraft : task) });
    const swappedPending = swappedBinding.request.input.pending_concerns as unknown as ComparisonMaterialInspection["concerns"];
    assert.equal(swappedPending[0]!.candidate, "B", "the parent A concern follows its actual input UUID when aliases swap");
    assert.deepEqual(swappedPending[0]!.answer_evidence, originalConcern.answer_evidence);
    const terminal = advanceReview(followup, receipt(followup, accepted.evaluation), f.state, f.plan.inputs)!;
    assert.deepEqual(terminal.tasks, [], "the local discovery does not add another review round");
    assert(terminal.blocked!.length > 0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
