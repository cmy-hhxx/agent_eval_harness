import { responsibilityFixture } from "../../../../tests/fixtures/responsibility.js";
import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import type { AttributionResult, TaskData } from "./types.js";
import { modelBehavior, modelBehaviorDetails } from "./model-behavior.js";

function task(id: string, input = "answer", version = "a"): PlannedTask {
  return { id, stage: "attribution", inputIds: { answer: input }, dependencies: {},
    data: { stage: "attribution", reference: null, candidates: { A: { input_id: input, version, batch_id: "batch", case_id: "case",
      name: version, trace_id: null, source: "/fixture/input.jsonl", line: 1, question: "问题", final_index: 1, reference: null, llm: null,
      answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: null,
        source_unit: "ms", source_values: {}, source_fields: {} } } } } satisfies TaskData };
}
function finding(id: string, component: string[], options: { uncertain?: boolean; strength?: boolean; text?: string } = {}): AttributionResult["findings"][number] {
  return { finding_id: id, type: options.strength ? "strength" : "problem", text: options.text ?? `具体行为 ${id}`, reason: "来源可核对",
    dimension: "reasoning", stage: "final_answer", importance: "medium", evidence: [],
    assessment: { requirement_index: null, observation: "已观察行为", evidence_status: options.uncertain ? "uncertain" : "established", impact: "影响交付" },
    problem: options.strength ? null : { diagnosis: "other", investigation: [], component:component.map((name,index)=>responsibilityFixture(name,{role:index?"contributing":"primary"})), label: "问题", definition: "已记录问题" } };
}
function receipt(id: string, findings: AttributionResult["findings"]): SubmissionReceipt {
  return { taskId: id, submissionId: `${id}-receipt`, evaluatorVersion: "test", judge: "judge", acceptedAt: 1,
    status: "succeeded", attemptId: `${id}-attempt`, evaluation: { findings } as AttributionResult,
    usage: emptyUsage(), audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] } };
}

test("model behavior counts mixed and unknown responsibility once without attributing strengths", () => {
  const findings = [finding("f1", ["最终回答组织"]), finding("f2", ["最终回答组织", "search", "search"]),
    finding("f3", ["search"]), finding("f4", []), finding("f5", ["最终回答组织"], { uncertain: true }),
    finding("f6", [], { strength: true })];
  const source = receipt("source", findings), copy = receipt("copy", findings);
  const result = modelBehavior([task("source"), task("copy"), task("pending", "unreviewed")], { source, copy });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].findings.length, 5);
  assert.equal(result.rows[0].findings[1].sources.length, 2);
  assert.deepEqual(result.summary.by_version.a, { planned_answers: 2, accepted_answers: 1,
    problems: { model: 1, mixed: 1, other: 1, unknown: 1, unconfirmed: 1 } });
  assert(!JSON.stringify(result.rows).includes('"evidence"'));
  assert.equal(result.rows[0].findings[3].responsibility, "unknown");
});

test("model behavior follows current attribution references and stays independent of the product winner", () => {
  const tasks = [task("old"), task("current"), task("other", "b-answer", "b")];
  tasks.push({ id: "comparison", stage: "comparison", inputIds: { A: "answer", B: "b-answer" },
    dependencies: { A: "current", B: "other" },
    data: { candidates: { A: { input_id: "answer" }, B: { input_id: "b-answer" } } } });
  const receipts = { old: receipt("old", [finding("f1", ["search"])]),
    current: receipt("current", [finding("f1", ["最终回答组织"])]), other: receipt("other", []) };
  const result = modelBehavior(tasks, receipts);
  assert.deepEqual(result.rows[0].sources.map(item => item.task_id), ["current"]);
  assert.equal(result.summary.by_version.a.problems.model, 1);
  assert.equal(result.summary.by_version.b.problems.model, 0);
  assert(!JSON.stringify(result).includes('"winner"'));
  assert(modelBehaviorDetails(result.rows).join("\n").includes("具体行为 f1"));
});

test("different accepted descriptions at one finding coordinate stay unconfirmed and retain both sources", () => {
  const result = modelBehavior([task("first"), task("second")], {
    first: receipt("first", [finding("f1", ["最终回答组织"], { text: "单位错误" })]),
    second: receipt("second", [finding("f1", [], { text: "来源无法核实" })]),
  });
  const item = result.rows[0].findings[0];
  assert.equal(item.source_conflict, true);
  assert.equal(item.responsibility, "unconfirmed");
  assert.deepEqual(item.sources.map(source => source.task_id), ["first", "second"]);
  assert.equal(result.summary.by_version.a.problems.model, 0);
});

test("an accepted review replaces its earlier responsibility findings while a pending review does not", () => {
  const original = task("original"), review = task("review"), pending = task("pending");
  (review.data as TaskData).reviewOf = { taskId: original.id, round: 1, reasons: ["核实原问题"] };
  (pending.data as TaskData).reviewOf = { taskId: review.id, round: 2, reasons: ["继续核实"] };
  const receipts: Record<string, SubmissionReceipt> = {
    original: receipt(original.id, [finding("f0", ["最终回答组织"])]),
    review: receipt(review.id, []),
  };
  const tasks = [original, review, pending], result = modelBehavior(tasks, receipts);
  assert.deepEqual(result.rows[0].sources.map(source => source.task_id), [review.id]);
  assert.deepEqual(result.rows[0].findings, []);
  assert.equal(result.summary.accepted_answers, 1);
  assert.equal(result.summary.planned_answers, 1);
  assert.equal(result.summary.by_version.a.problems.model, 0);
  receipts.pending = receipt(pending.id, [finding("f0", ["最终回答组织", "search"])]);
  const latest = modelBehavior(tasks, receipts);
  assert.deepEqual(latest.rows[0].sources.map(source => source.task_id), [pending.id]);
  assert.equal(latest.summary.by_version.a.problems.mixed, 1);
  assert.equal(latest.summary.by_version.a.problems.unconfirmed, 0);
  assert.equal((receipts.original.evaluation as AttributionResult).findings.length, 1, "source receipts remain unchanged");
});

test("accepted reviews replace old findings even when separate pairs still reference both sources", () => {
  for (const reviewedFindings of [[], [finding("f0", ["最终回答组织", "search"])]]) {
    const original = task("original"), review = task("review"), firstPeer = task("first-peer", "b-answer", "b"),
      secondPeer = task("second-peer", "c-answer", "c");
    (review.data as TaskData).reviewOf = { taskId: original.id, round: 1, reasons: ["核实原问题"] };
    const comparisons: PlannedTask[] = [[original, firstPeer], [review, secondPeer]].map(([source, peer], index) => ({
      id: `comparison-${index}`, stage: "comparison", inputIds: { A: "answer", B: peer.inputIds.answer },
      dependencies: { A: source.id, B: peer.id },
      data: { candidates: { A: { input_id: "answer" }, B: { input_id: peer.inputIds.answer } } },
    }));
    const tasks = [original, review, firstPeer, secondPeer, ...comparisons];
    const receipts: Record<string, SubmissionReceipt> = {
      original: receipt(original.id, [finding("f0", ["最终回答组织"])]),
      [firstPeer.id]: receipt(firstPeer.id, []), [secondPeer.id]: receipt(secondPeer.id, []),
    };
    const beforePending = structuredClone({ tasks, receipts }), pending = modelBehavior(tasks, receipts);
    assert.deepEqual(pending.rows.find(row => row.input_id === "answer")!.sources.map(source => source.task_id), [original.id]);
    assert.equal(pending.summary.by_version.a.problems.model, 1, "pending review retains the last accepted finding once");
    assert.equal(pending.summary.accepted_answers, 3);
    assert.equal(pending.summary.planned_answers, 3);
    assert.deepEqual({ tasks, receipts }, beforePending);

    receipts.review = receipt(review.id, reviewedFindings);
    const beforeAccepted = structuredClone({ tasks, receipts }), accepted = modelBehavior(tasks, receipts);
    const answer = accepted.rows.find(row => row.input_id === "answer")!;
    assert.deepEqual(answer.sources.map(source => source.task_id), [review.id]);
    assert.equal(answer.findings.length, reviewedFindings.length);
    assert(answer.findings.every(item => !item.source_conflict && item.responsibility === "mixed"));
    assert.deepEqual(accepted.summary.by_version.a, { planned_answers: 1, accepted_answers: 1,
      problems: { model: 0, mixed: reviewedFindings.length, other: 0, unknown: 0, unconfirmed: 0 } });
    assert.equal(accepted.summary.accepted_answers, 3);
    assert.equal(accepted.summary.planned_answers, 3);
    assert.deepEqual({ tasks, receipts }, beforeAccepted, "reports preserve source receipts and historical comparison bindings");
  }
});

test("a comparison awaiting multiple reviews retains the nearest accepted source and planned input", () => {
  const original = task("original"), review = task("review"), latest = task("latest"), peer = task("peer", "b-answer", "b");
  (review.data as TaskData).reviewOf = { taskId: original.id, round: 1, reasons: ["核实原问题"] };
  (latest.data as TaskData).reviewOf = { taskId: review.id, round: 2, reasons: ["继续核实"] };
  const comparison: PlannedTask = { id: "comparison", stage: "comparison", inputIds: { A: "answer", B: "b-answer" },
    dependencies: { A: latest.id, B: peer.id }, data: { candidates: { A: { input_id: "answer" }, B: { input_id: "b-answer" } } } };
  const tasks = [original, review, latest, peer, comparison];
  const receipts: Record<string, SubmissionReceipt> = { peer: receipt(peer.id, []) };
  const waiting = modelBehavior(tasks, receipts);
  assert.equal(waiting.summary.planned_answers, 2);
  assert.equal(waiting.summary.accepted_answers, 1);
  receipts.original = receipt(original.id, [finding("f0", ["最终回答组织"])]);
  const first = modelBehavior(tasks, receipts);
  assert.equal(first.summary.planned_answers, 2);
  assert.equal(first.summary.accepted_answers, 2);
  assert.deepEqual(first.rows.find(row => row.input_id === "answer")!.sources.map(source => source.task_id), [original.id]);
  receipts.review = receipt(review.id, []);
  const reviewed = modelBehavior(tasks, receipts);
  assert.deepEqual(reviewed.rows.find(row => row.input_id === "answer")!.sources.map(source => source.task_id), [review.id]);
  assert.equal(reviewed.summary.by_version.a.problems.model, 0);
  receipts.latest = receipt(latest.id, [finding("f0", ["最终回答组织", "search"])]);
  const accepted = modelBehavior(tasks, receipts);
  assert.deepEqual(accepted.rows.find(row => row.input_id === "answer")!.sources.map(source => source.task_id), [latest.id]);
  assert.equal(accepted.summary.by_version.a.problems.mixed, 1);
  assert.equal(accepted.summary.by_version.a.problems.unconfirmed, 0);
  assert.equal((receipts.original.evaluation as AttributionResult).findings.length, 1, "source receipts remain unchanged");
});

test("a pending comparison review cannot recover an accepted source through another input", () => {
  const original = task("original"), bridge = task("bridge", "b-answer", "b"), pending = task("pending"), peer = task("peer", "b-answer", "b");
  (bridge.data as TaskData).reviewOf = { taskId: original.id, round: 1, reasons: ["错误的跨输入链"] };
  (pending.data as TaskData).reviewOf = { taskId: bridge.id, round: 2, reasons: ["错误的跨输入链"] };
  const comparison: PlannedTask = { id: "comparison", stage: "comparison", inputIds: { A: "answer", B: "b-answer" },
    dependencies: { A: pending.id, B: peer.id }, data: { candidates: { A: { input_id: "answer" }, B: { input_id: "b-answer" } } } };
  const result = modelBehavior([original, bridge, pending, peer, comparison], {
    original: receipt(original.id, [finding("f0", ["最终回答组织"])]), peer: receipt(peer.id, []),
  });
  assert.equal(result.summary.planned_answers, 2);
  assert.equal(result.summary.accepted_answers, 1);
  assert.equal(result.summary.by_version.a.accepted_answers, 0);
  assert.deepEqual(result.rows.flatMap(row => row.sources.map(source => source.task_id)), [peer.id]);
});

test("a problem and a strength at the same coordinate remain disputed regardless of source order", () => {
  for (const order of [["problem", "strength"], ["strength", "problem"]]) {
    const result = modelBehavior(order.map(id => task(id)), {
      problem: receipt("problem", [finding("f0", ["最终回答组织"])]),
      strength: receipt("strength", [finding("f0", [], { strength: true })]),
    });
    const item = result.rows[0].findings[0];
    assert.equal(item.source_conflict, true);
    assert.equal(item.responsibility, "unconfirmed");
    assert.deepEqual(item.sources.map(source => source.task_id).sort(), ["problem", "strength"]);
    assert.equal(result.summary.by_version.a.problems.model, 0);
    assert.equal(result.summary.by_version.a.problems.unconfirmed, 1);
  }
});
