import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ValidationError, type ProblemObservationRef } from "@eval/contracts";
import { emptyLibrary } from "./library.js";
import { replacePendingObservations } from "./pending-observations.js";

const options = { at: "2026-10-14T08:00:00.000Z", run: "/runs/attribution/pilot" };
function ref(input = randomUUID(), finding = "f0", version = "a_fast"): ProblemObservationRef {
  return { version, input_id: input, finding_id: finding,
    attribution: { run: options.run, run_id: "pilot", task_id: randomUUID(), submission_id: randomUUID(), evaluator_version: "r210" },
    source: { file: "/inputs/original.jsonl", line: 3 }, batch_id: "2026-10-14", case_id: input,
    components: ["模型自身推理"], evidence_status: "established", importance: "high", summary: "判断方向与已有数据相反。" };
}

test("pending references preserve formal classes, occurrences and original responsibility arrays", () => {
  const library = emptyLibrary("a_fast"), componentId = randomUUID(), classId = randomUUID();
  library.components[componentId] = { id: componentId, label: "真实责任", definition: "真实组件", aliases: [], first_seen: null };
  library.classes[classId] = { id: classId, component_id: componentId, label: "正式类", definition: "既有定义", aliases: [], status: "active", merged_into: null, first_seen: null };
  const pending = [ref(), ref()]; pending[0]!.components = []; pending[1]!.components = ["工具A", "工具B"];
  library.occurrences.push({ id: randomUUID(), class_id: classId, version: "a_fast", evaluator_version: "r210",
    batch_id: "2026-10-14", case_id: "formal", input_id: randomUUID(), run_id: "formal", task_id: randomUUID(),
    submission_id: randomUUID(), finding_id: "f0", evidence_status: "established", message_index: 1,
    source: { file: "/inputs/formal.jsonl", line: 1 }, classification: "created", previous_class_id: null, at: options.at });
  const before = structuredClone(library), pendingBefore = structuredClone(pending);
  const next = replacePendingObservations(library, pending, options);
  assert.deepEqual(library, before);
  assert.deepEqual(pending, pendingBefore);
  assert.equal(next.classes, library.classes);
  assert.equal(next.components, library.components);
  assert.equal(next.occurrences, library.occurrences);
  assert.deepEqual(next.pending_observations, pending);
  assert.equal(next.updated_at, options.at);
  assert.equal(next.events.at(-1)!.type, "pending_observations_replaced");
  assert.deepEqual(next.events.at(-1)!.detail, { pending: 2, sourceRun: options.run });
  pending[0]!.summary = "随后变更调用者对象";
  assert.notEqual(next.pending_observations![0]!.summary, pending[0]!.summary);
});

test("pending observations reject another model's references", () => {
  assert.throws(() => replacePendingObservations(emptyLibrary("a_fast"), [ref(randomUUID(), "f0", "b_fast")], options), /模型不一致/);
});

test("one business problem appears only once even across attribution tasks", () => {
  const original = ref(), repeated = structuredClone(original);
  assert.throws(() => replacePendingObservations(emptyLibrary("a_fast"), [original, repeated], options), /引用重复/);
  repeated.attribution.task_id = randomUUID();
  assert.throws(() => replacePendingObservations(emptyLibrary("a_fast"), [original, repeated], options), /引用重复/);
  repeated.finding_id = "f1";
  assert.equal(replacePendingObservations(emptyLibrary("a_fast"), [original, repeated], options).pending_observations!.length, 2);
});

test("pending references reject quote bodies and missing attribution provenance", () => {
  const quote = { ...ref(), quote: "不允许保留证据正文" } as ProblemObservationRef;
  assert.throws(() => replacePendingObservations(emptyLibrary("a_fast"), [quote], options), ValidationError);
  const invalid = ref(); invalid.attribution.run = "";
  assert.throws(() => replacePendingObservations(emptyLibrary("a_fast"), [invalid], options), ValidationError);
  invalid.attribution.run = options.run; invalid.summary = "  ";
  assert.throws(() => replacePendingObservations(emptyLibrary("a_fast"), [invalid], options), ValidationError);
});

test("pending references require persistent attribution UUIDs and valid source coordinates", () => {
  for (const field of ["task_id", "submission_id"] as const) {
    const invalid = ref(); invalid.attribution[field] = "temporary-alias";
    assert.throws(() => replacePendingObservations(emptyLibrary("a_fast"), [invalid], options), ValidationError);
  }
  for (const line of [0, -1, 1.5]) {
    const invalid = ref(); invalid.source.line = line;
    assert.throws(() => replacePendingObservations(emptyLibrary("a_fast"), [invalid], options), ValidationError);
  }
  const invalid = ref(); invalid.source.file = "";
  assert.throws(() => replacePendingObservations(emptyLibrary("a_fast"), [invalid], options), ValidationError);
});

test("replacement clears pending references while retaining earlier audits and library entries", () => {
  const first = replacePendingObservations(emptyLibrary("a_fast"), [ref()], options);
  const next = replacePendingObservations(first, [], { ...options, at: "2026-10-14T09:00:00.000Z" });
  assert.deepEqual(next.pending_observations, []);
  assert.equal(next.events.length, 2);
  assert.equal(next.events[0], first.events[0]);
  assert.equal(first.pending_observations!.length, 1);
  assert.throws(() => replacePendingObservations(first, [], { ...options, at: "invalid-time" }), /更新时间无效/);
});
