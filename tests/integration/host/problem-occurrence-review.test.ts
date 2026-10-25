import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  emptyUsage, evidenceId,
  type ProblemLibrary, type RunState, type SubmissionReceipt,
} from "@eval/contracts";
import {
  fileSourceReader, problemLibraryFile, readJson, withProblemLibraryLock, writeJson, writeJsonl,
} from "@eval/data";
import { applyClustering, type ClusteringResult, type ProblemOccurrenceReviewDecision } from "@eval/agents/clustering";
import { buildPlan, createResultWriter, listConfiguredProblemLibrary, readConfiguredProblemClass, readRunState, reviewProblemOccurrences, syncProblemLibrary, taskObservations, writeRunState, type TaskData } from "@eval/workflows/comparison";
import { type Candidate } from "@eval/workflows/inputs";
import { ROOT } from "../../fixtures/services.js";
import {
  attributionResult, emptyAudit, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw,
} from "../../fixtures/comparison.js";

async function fixture(peer = false) {
  const source = (caseId: string) => ({
    ...raw(caseId, "4", "2+2=5"),
    messages: [...raw(caseId, "4", "2+2=5").messages, { type: "message", role: "tool", name: "Search", content: "来源全文：数值为4。" }],
  });
  const peerRows = [raw("q1"), raw("q2")];
  if (peer) for (const value of peerRows) value.messages[0]!.timestamp = "2026-09-28T07:00:00+08:00";
  const { directory, config } = await fixtureConfig([[source("q1"), source("q2")], [], peerRows, []], false, true);
  const plan = await buildPlan(config), runId = "original", run = path.join(config.output.path, runId);
  const ownerTasks = plan.tasks.filter(task => task.stage === "attribution" && (task.data as TaskData).candidates.A.version === "a_fast");
  const cluster = plan.tasks.find(task => task.stage === "clustering" && (task.data as TaskData).scope!.version === "a_fast")!;
  if (peer) for (const task of ownerTasks) {
    const owner = (task.data as TaskData).candidates.A;
    const other = (plan.catalog as Candidate[]).find(candidate => candidate.version === "b_fast" && candidate.case_id === owner.case_id)!;
    task.inputIds.peer_B = other.input_id;
    (task.data as TaskData).referenceCandidates = { peer_B: other };
  }
  const receipt = (taskId: string, evaluation: unknown): SubmissionReceipt => ({
    taskId, attemptId: randomUUID(), submissionId: randomUUID(), evaluation,
    audit: emptyAudit(), usage: emptyUsage(), evaluatorVersion: fakeEvaluatorVersion,
    judge: "fixture", acceptedAt: Date.now(), status: "succeeded",
  });
  const receipts: Record<string, SubmissionReceipt> = {};
  for (const task of ownerTasks) {
    const evaluation = attributionResult(false, "2+2=5");

    receipts[task.id] = receipt(task.id, evaluation);

  }
  const observations = taskObservations(cluster, id => receipts[id]);
  const result: ClusteringResult = {
    assignments: observations.map(item => ({ item_id: item.id, new_class_key: "n" })),
    new_classes: [{ key: "n", component: observations[0].component, label: "算术错误", definition: "计算与事实不符。",
      closest_existing: null, novelty: "首次出现。", category_paths: [["数值可靠性"]] }],
    merges: [],
  };
  receipts[cluster.id] = receipt(cluster.id, result);
  const state: RunState = {
    manifest: {
      format: "evaluation-run", runId, status: "interrupted", engine: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion, config, debug: false, tasks: plan.tasks,
      inputCatalog: plan.catalog!, inputs: Object.fromEntries(Object.keys(plan.inputs).map(id => [id, { id, name: id }])),
      states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: receipts[task.id] ? "succeeded" : "pending", attempts: receipts[task.id] ? 1 : 0 }])),
      preflight: plan.summary, startedAt: Date.now(), concurrency: 1,
    }, receipts, usage: emptyUsage(), recordedAttempts: Object.keys(receipts).length,
  };
  await createResultWriter(run, plan.inputs)(state);
  await writeRunState(run, state);
  await syncProblemLibrary(state);
  await writeJson(path.join(run, "stats.json"), { historical: "unchanged" });
  await writeJson(path.join(run, "report.json"), { historical: "unchanged" });
  await writeJsonl(path.join(directory, "comparison-statistics-log.jsonl"), [{ historical: "unchanged" }]);
  const file = problemLibraryFile(config.problemLibrary, "a_fast"), library = await readJson<ProblemLibrary>(file);
  const occurrence = library.occurrences[0]!;
  const decision: ProblemOccurrenceReviewDecision = {
    id: randomUUID(), model: "a_fast",
    items: [{ occurrence_id: occurrence.id, reason: "显式来源复核：完整原工具材料给出了支持值。",
      evidence: [{ evidence_id: evidenceId(occurrence.input_id, 2, "text", "/content", 0, "来源全文：数值为4。".length) }] }],
  };
  const protectedFiles = [path.join(run, "state.json"), path.join(run, "stats.json"), path.join(run, "report.json"),
    path.join(run, "results", "attribution.jsonl"), path.join(run, "results", "clustering.jsonl"),
    path.join(directory, "comparison-statistics-log.jsonl")];
  return { directory, config, run, state, file, library, decision, protectedFiles, cluster };
}
const snapshots = async (files: string[]) => Promise.all(files.map(file => readFile(file, "utf8")));

test("public review preview has no writes and apply preserves all original run files and sample bodies", async () => {
  const f = await fixture();
  try {
    const protectedBefore = await snapshots(f.protectedFiles), libraryBefore = await readFile(f.file, "utf8");
    const preview = await reviewProblemOccurrences(f.config, f.decision, { evaluatorVersion: "review" });
    assert.equal(preview.applied, false);
    assert.equal(preview.before, 2);
    assert.equal(preview.after, 1);
    assert.deepEqual(preview.targets[0]!.affected_occurrence_ids, [f.decision.items[0]!.occurrence_id]);
    assert.equal(await readFile(f.file, "utf8"), libraryBefore);
    assert.deepEqual(await snapshots(f.protectedFiles), protectedBefore);
    const applied = await reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" });
    assert.equal(applied.applied, true);
    const after = await readJson<ProblemLibrary>(f.file);
    assert.deepEqual(after.occurrences, f.library.occurrences);
    assert.deepEqual(after.classes, f.library.classes);
    const event = after.events.at(-1)!;
    assert.equal(event.type, "occurrence_rejected");
    assert.equal(event.id, f.decision.id);
    const targets = event.detail.targets as { attribution: { task_id: string; submission_id: string } }[];
    const attrId = f.cluster.dependencies[f.library.occurrences[0]!.input_id]!;
    assert.equal(targets[0]!.attribution.task_id, attrId, "a clustering task is not mistaken for the attribution owner");
    assert.equal(targets[0]!.attribution.submission_id, f.state.receipts[attrId]!.submissionId);
    assert.deepEqual(await snapshots(f.protectedFiles), protectedBefore);
    const appliedBytes = await readFile(f.file, "utf8");
    assert.equal((await reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "later" })).before, 1);
    assert.equal(await readFile(f.file, "utf8"), appliedBytes);
    const conflicting = structuredClone(f.decision); conflicting.items[0]!.reason = "不同决定";
    await assert.rejects(reviewProblemOccurrences(f.config, conflicting, { apply: true, evaluatorVersion: "later" }), /冲突决定/);
    const stats = await syncProblemLibrary(await readRunState(f.run));
    assert.equal(stats.a_fast!.occurrences, 1, "replaying accepted receipts cannot revive the rejected association");
    assert.equal(stats.a_fast!.assigned, 2, "accepted assignment counters remain a historical receipt ledger");
    assert.deepEqual((await readJson<ProblemLibrary>(f.file)).occurrences, f.library.occurrences);
    assert.deepEqual(await snapshots(f.protectedFiles), protectedBefore);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("proof UUIDs route only to the original attribution source scope; image and invalid ranges cannot write", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.file, "utf8"), occurrence = f.library.occurrences[0]!;
    const peer = (f.state.manifest.inputCatalog as Candidate[]).find(candidate => candidate.version === "b_fast" && candidate.case_id === occurrence.case_id)!;
    const badIds = [
      evidenceId(peer.input_id, 1, "text", "/content", 0, 5),
      evidenceId(randomUUID(), 1, "text", "/content", 0, 5),
      evidenceId(occurrence.input_id, 2, "text", "/content", 0, 99999),
      evidenceId(occurrence.input_id, 1, "image"),
      "ev_2_text_0_9_/content",
    ];
    for (const id of badIds) {
      const decision = structuredClone(f.decision); decision.items[0]!.evidence = [{ evidence_id: id }];
      await assert.rejects(reviewProblemOccurrences(f.config, decision, { apply: true, evaluatorVersion: "review" }));
      assert.equal(await readFile(f.file, "utf8"), before);
    }
    const unknown = { ...f.decision, items: [{ ...f.decision.items[0]!, occurrence_id: randomUUID() }] };
    await assert.rejects(reviewProblemOccurrences(f.config, unknown, { apply: true, evaluatorVersion: "review" }), /未知问题样本/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("owner proof may include a registered peer without borrowing its clock", async () => {
  const f = await fixture(true);
  try {
    const occurrence = f.library.occurrences[0]!;
    const peer = (f.state.manifest.inputCatalog as Candidate[]).find(candidate => candidate.version === "b_fast" && candidate.case_id === occurrence.case_id)!;
    const decision = structuredClone(f.decision);
    decision.items[0]!.evidence.push({ evidence_id: evidenceId(peer.input_id, 1, "text", "/content", 0, "2+2=4".length) });
    const before = await snapshots(f.protectedFiles);
    assert.equal((await reviewProblemOccurrences(f.config, decision, { apply: true, evaluatorVersion: "review" })).after, 1);
    assert.deepEqual(await snapshots(f.protectedFiles), before);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("effective directory, topics, pagination and recall all use the same filtered finding set", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 50; index++) f.library.occurrences.push({
      ...f.library.occurrences[0]!, id: randomUUID(), input_id: randomUUID(), finding_id: "f" + index,
      at: "2026-01-01T00:00:" + String(index).padStart(2, "0") + "Z",
    });
    await writeJson(f.file, f.library);
    await reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" });
    const model = (await listConfiguredProblemLibrary(f.config)).find(item => item.model === "a_fast")!;
    assert.equal(model.totals.occurrences, 51);
    assert(model.categories.every(item => item.occurrences === 51));
    assert.equal(model.components[0]!.classes[0]!.occurrences, 51);
    const classId = f.library.occurrences[0]!.class_id;
    const first = (await readConfiguredProblemClass(f.config, "a_fast", classId, 1))!;
    const second = (await readConfiguredProblemClass(f.config, "a_fast", classId, 2))!;
    assert.equal(first.total, 51);
    assert.equal(first.occurrences.length, 50);
    assert.equal(second.total, 51);
    assert.equal(second.occurrences.length, 1);
    assert(![...first.occurrences, ...second.occurrences].some(item => item.id === f.decision.items[0]!.occurrence_id));
    assert(first.occurrences.some(item => item.recall.available), "another intact original sample remains callable");
    assert.equal((await readJson<ProblemLibrary>(f.file)).occurrences.length, 52);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("source edits while waiting for the model lock reject the review without a partial event", async (t) => {
  const f = await fixture();
  let release!: () => void, read!: () => void, entered!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const readSource = new Promise<void>(resolve => { read = resolve; });
  const held = withProblemLibraryLock(f.config.problemLibrary, "a_fast", async () => { entered(); await released; });
  await ready;
  const record = fileSourceReader.record;
  t.mock.method(fileSourceReader, "record", (...args: Parameters<typeof record>) => { const value = record(...args); read(); return value; });
  try {
    const before = await readFile(f.file, "utf8");
    const operation = reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" });
    const rejection = assert.rejects(operation, /原输入发生变化|输入文件发生变化/);
    await readSource;
    await writeJsonl(f.library.occurrences[0]!.source.file, [raw("q1", "4", "changed"), raw("q2")]);
    release(); await held; await rejection;
    assert.equal(await readFile(f.file, "utf8"), before);
  } finally { release(); await held; await rm(f.directory, { recursive: true, force: true }); }
});

test("a same-component merge during the review is retained and cannot make a withdrawn sample effective", async (t) => {
  const f = await fixture();
  let release!: () => void, read!: () => void, entered!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const readSource = new Promise<void>(resolve => { read = resolve; });
  const held = withProblemLibraryLock(f.config.problemLibrary, "a_fast", async () => { entered(); await released; });
  await ready;
  const record = fileSourceReader.record;
  t.mock.method(fileSourceReader, "record", (...args: Parameters<typeof record>) => { const value = record(...args); read(); return value; });
  try {
    const operation = reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" });
    await readSource;
    const original = f.library.occurrences[0]!.class_id, target = randomUUID();
    f.library.classes[target] = { ...f.library.classes[original]!, id: target, label: "合并后的类", aliases: [] };
    const merged = applyClustering(f.library, {
      run_id: "maintenance", task_id: randomUUID(), submission_id: randomUUID(), evaluator_version: "merge",
      version: "a_fast", batch_id: "b1", observations: [], result: {
        assignments: [], new_classes: [], merges: [{ from: [original], into: target, reason: "同组件近义合并。" }],
      },
    });
    await writeJson(f.file, merged);
    release(); await held;
    assert.equal((await operation).after, 1);
    const current = await readJson<ProblemLibrary>(f.file);
    assert.equal(current.classes[original]!.merged_into, target);
    assert.equal(current.occurrences[0]!.previous_class_id, original);
    assert.equal(current.occurrences[0]!.class_id, target);
    assert.equal((await readConfiguredProblemClass(f.config, "a_fast", target, 1))!.total, 1);
  } finally { release(); await held; await rm(f.directory, { recursive: true, force: true }); }
});

test("a responsibility component change while awaiting the lock cannot silently change the reviewed target", async (t) => {
  const f = await fixture();
  let release!: () => void, read!: () => void, entered!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const readSource = new Promise<void>(resolve => { read = resolve; });
  const held = withProblemLibraryLock(f.config.problemLibrary, "a_fast", async () => { entered(); await released; });
  await ready;
  const record = fileSourceReader.record;
  t.mock.method(fileSourceReader, "record", (...args: Parameters<typeof record>) => { const value = record(...args); read(); return value; });
  try {
    const operation = reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" });
    const rejection = assert.rejects(operation, /原来源或责任组件变化/);
    await readSource;
    const component = randomUUID();
    f.library.components[component] = { id: component, label: "Search", definition: "", aliases: [], first_seen: null };
    f.library.classes[f.library.occurrences[0]!.class_id]!.component_id = component;
    await writeJson(f.file, f.library);
    const changedBytes = await readFile(f.file, "utf8");
    release(); await held; await rejection;
    assert.equal(await readFile(f.file, "utf8"), changedBytes);
  } finally { release(); await held; await rm(f.directory, { recursive: true, force: true }); }
});

test("a missing original finding or a forged clustering submission has no maintenance side effect", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.file, "utf8");
    const attrId = f.cluster.dependencies[f.library.occurrences[0]!.input_id]!;
    const saved = f.state.receipts[attrId]!.exported!;
    const row = structuredClone(saved.row);
    (row.evaluation as { Problem: { problem_id: string }[] }).Problem[0].problem_id = "different";
    const rows = Object.values(f.state.receipts).filter(receipt => receipt.exported?.file === "attribution.jsonl")
      .map(receipt => receipt.taskId === attrId ? row : receipt.exported!.row);
    await writeJsonl(path.join(f.run, "results", "attribution.jsonl"), rows);
    await assert.rejects(reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" }), /原 finding/);
    assert.equal(await readFile(f.file, "utf8"), before);
    await writeJsonl(path.join(f.run, "results", "attribution.jsonl"),
      Object.values(f.state.receipts).filter(receipt => receipt.exported?.file === "attribution.jsonl").map(receipt => receipt.exported!.row));
    f.library.occurrences[0]!.submission_id = randomUUID();
    await writeJson(f.file, f.library);
    const forgedBytes = await readFile(f.file, "utf8");
    await assert.rejects(reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" }), /原 Clustering 收据/);
    assert.equal(await readFile(f.file, "utf8"), forgedBytes);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("review rejects peer-only proof even inside the original attribution scope", async () => {
  const f = await fixture(true);
  try {
    const occurrence = f.library.occurrences[0]!;
    const peer = (f.state.manifest.inputCatalog as Candidate[]).find(candidate => candidate.version === "b_fast" && candidate.case_id === occurrence.case_id)!;
    const decision = structuredClone(f.decision);
    decision.items[0]!.evidence = [{ evidence_id: evidenceId(peer.input_id, 1, "text", "/content", 0, "2+2=4".length) }];
    const before = await readFile(f.file, "utf8");
    await assert.rejects(reviewProblemOccurrences(f.config, decision, { apply: true, evaluatorVersion: "review" }), /本方|owner/);
    assert.equal(await readFile(f.file, "utf8"), before);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("review rejects a same-label finding that has no original accepted observation assignment", async () => {
  const f = await fixture();
  try {
    const occurrence = f.library.occurrences[0]!;
    const attrId = f.cluster.dependencies[occurrence.input_id]!;
    const original = f.state.receipts[attrId]!.exported!.row;
    const row = structuredClone(original);
    const evaluation = row.evaluation as ReturnType<typeof attributionResult>;
    const added = structuredClone(evaluation.Problem[0]!);
    added.problem_id = "never-clustered";
    added.reason = "\uffffAnother independent problem definition absent from the original clustering request.";
    evaluation.Problem.push(added);
    await writeJsonl(path.join(f.run, "results", "attribution.jsonl"),
      Object.values(f.state.receipts).filter(receipt => receipt.exported?.file === "attribution.jsonl")
        .map(receipt => receipt.taskId === attrId ? row : receipt.exported!.row));
    occurrence.finding_id = added.problem_id;
    await writeJson(f.file, f.library);
    const before = await readFile(f.file, "utf8");
    await assert.rejects(reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" }), /实际归类|原观察/);
    assert.equal(await readFile(f.file, "utf8"), before);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("review rejects a class unrelated to the original accepted assignment", async () => {
  const f = await fixture();
  try {
    const occurrence = f.library.occurrences[0]!, unrelated = randomUUID();
    f.library.classes[unrelated] = { ...f.library.classes[occurrence.class_id]!, id: unrelated, label: "Unrelated class", aliases: [] };
    occurrence.class_id = unrelated;
    await writeJson(f.file, f.library);
    const before = await readFile(f.file, "utf8");
    await assert.rejects(reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" }), /原归类|实际归类/);
    assert.equal(await readFile(f.file, "utf8"), before);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("review must retain the exact original observation message coordinate", async () => {
  const f = await fixture();
  try {
    f.library.occurrences[0]!.message_index++;
    await writeJson(f.file, f.library);
    const before = await readFile(f.file, "utf8");
    await assert.rejects(reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" }), /原观察.*实际归类/);
    assert.equal(await readFile(f.file, "utf8"), before);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("an accepted existing-class assignment supports the same original source association", async () => {
  const f = await fixture();
  try {
    const row = structuredClone(f.state.receipts[f.cluster.id]!.exported!.row);
    const result = row.result as unknown as ClusteringResult;
    result.assignments = result.assignments.map(assignment => ({ item_id: assignment.item_id, class_id: f.library.occurrences[0]!.class_id }));
    result.new_classes = [];
    await writeJsonl(path.join(f.run, "results", "clustering.jsonl"), [row]);
    assert.equal((await reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" })).after, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("source catalog changes while waiting for the model lock cannot commit a stale source review", async (t) => {
  const f = await fixture();
  let release!: () => void, read!: () => void, entered!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const readSource = new Promise<void>(resolve => { read = resolve; });
  const held = withProblemLibraryLock(f.config.problemLibrary, "a_fast", async () => { entered(); await released; });
  await ready;
  const record = fileSourceReader.record;
  t.mock.method(fileSourceReader, "record", (...args: Parameters<typeof record>) => { const value = record(...args); read(); return value; });
  try {
    const before = await readFile(f.file, "utf8");
    const operation = reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" });
    const rejection = assert.rejects(operation, /原 accepted 来源发生变化/);
    await readSource;
    const input = (f.state.manifest.inputCatalog as Candidate[]).find(candidate => candidate.input_id === f.library.occurrences[0]!.input_id)!;
    input.source = path.join(f.directory, "new-source.jsonl");
    await writeRunState(f.run, f.state);
    release(); await held; await rejection;
    assert.equal(await readFile(f.file, "utf8"), before);
  } finally { release(); await held; await rm(f.directory, { recursive: true, force: true }); }
});

test("an unrelated same-component class move while awaiting the lock is not a merge lineage", async (t) => {
  const f = await fixture();
  let release!: () => void, read!: () => void, entered!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const readSource = new Promise<void>(resolve => { read = resolve; });
  const held = withProblemLibraryLock(f.config.problemLibrary, "a_fast", async () => { entered(); await released; });
  await ready;
  const record = fileSourceReader.record;
  t.mock.method(fileSourceReader, "record", (...args: Parameters<typeof record>) => { const value = record(...args); read(); return value; });
  try {
    const operation = reviewProblemOccurrences(f.config, f.decision, { apply: true, evaluatorVersion: "review" });
    const rejection = assert.rejects(operation, /原归类.*变化/);
    await readSource;
    const occurrence = f.library.occurrences[0]!, unrelated = randomUUID();
    f.library.classes[unrelated] = { ...f.library.classes[occurrence.class_id]!, id: unrelated, label: "Unrelated during lock", aliases: [] };
    occurrence.class_id = unrelated;
    await writeJson(f.file, f.library);
    const changedBytes = await readFile(f.file, "utf8");
    release(); await held; await rejection;
    assert.equal(await readFile(f.file, "utf8"), changedBytes);
  } finally { release(); await held; await rm(f.directory, { recursive: true, force: true }); }
});

test("the real CLI defaults to preview, requires an explicit apply and keeps repeated apply idempotent", async () => {
  const f = await fixture();
  try {
    const configFile = path.join(f.directory, "maintenance-config.json"), decisionFile = path.join(f.directory, "decision.json");
    await writeJson(configFile, { evaluatorVersion: "review", ...f.config });
    await writeJson(decisionFile, f.decision);
    const entry = fileURLToPath(new URL("../../fixtures/cli.js", import.meta.url));
    // Carry the source verification hook when present; ordinary built tests use the normal CLI.
    const imports = process.execArgv.flatMap((value, index) => value === "--import" ? [value, process.execArgv[index + 1]!] : []);
    const exec = promisify(execFile), env = { ...process.env };
    const configArgs = ["--config", path.join(ROOT, "configs/host.json"), "--config", configFile];
    const args = [entry, f.directory, "review-problem-occurrences", ...configArgs, "--review-file", decisionFile];
    const before = await readFile(f.file, "utf8"), protectedBefore = await snapshots(f.protectedFiles);
    const preview = await exec(process.execPath, [...imports, ...args], { env });
    assert.equal(JSON.parse(preview.stdout).applied, false);
    assert.equal(await readFile(f.file, "utf8"), before);
    const applied = await exec(process.execPath, [...imports, ...args, "--apply"], { env });
    assert.equal(JSON.parse(applied.stdout).applied, true);
    const after = await readFile(f.file, "utf8");
    await exec(process.execPath, [...imports, ...args, "--apply"], { env });
    assert.equal(await readFile(f.file, "utf8"), after);
    assert.deepEqual(await snapshots(f.protectedFiles), protectedBefore);
    await assert.rejects(exec(process.execPath, [...imports, entry, f.directory, "review-problem-occurrences",
      ...configArgs, "--apply"], { env }), /--review-file required/);
    assert.equal(await readFile(f.file, "utf8"), after);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
