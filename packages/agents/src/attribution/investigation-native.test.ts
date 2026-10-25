import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseEvidenceCoordinates, type ToolAudit } from "@eval/contracts";
import { cite, evidenceSources, selectEvidenceSource } from "@eval/tools";
import { bindAttributionMaterial } from "@eval/workflows/review";
import type { Candidate, RawInput } from "@eval/workflows/inputs";
import type { AttributionTransition } from "./transitions.js";
import type { Evidence, ProblemProposal, Responsibility, TransitionCheck } from "./types.js";
import { investigationIssues } from "./investigation.js";
import { attributionSubmissionSchema } from "./submission-schema.js";

function nativeFixture(loss = false, unrelated = false) {
  const question = "核对XOM的MA50支撑，并给出结论。";
  const query = "XOM MA50 support resistance", returned = { serial_number: "xom-source", query, MA50: 165.7899, support: 162, resistance: 170 };
  const delivered = "XOM的MA50支撑为170–172。";
  const args = { query }, call = { id: "xom-call", type: "function", function: { name: "finquery", arguments: JSON.stringify(args) } };
  const messages: RawInput["messages"] = [{ type: "user_question", role: "user", content: question }];
  if (unrelated) messages.push(
    { type: "llm_turn", name: "天气参数", input_messages: [{ role: "user", content: "查询北京天气。" }], output: [{ role: "assistant", content: "", tool_calls: [{ id: "weather-call", type: "function", function: { name: "weather", arguments: '{"city":"Beijing"}' } }] }] },
    { type: "tool_call", name: "weather", call_id: "weather-call", input: { city: "Beijing" } },
    { type: "tool_result", name: "weather", call_id: "weather-call", output: { city: "Beijing", temperature: 20 } },
  );
  messages.push(
    { type: "llm_turn", name: "XOM取数参数", input_messages: [{ role: "user", content: question }], output: [{ role: "assistant", content: "", tool_calls: [call] }] },
    { type: "tool_call", name: "finquery", call_id: "xom-call", input: args },
    { type: "tool_result", name: "finquery", call_id: "xom-call", output: returned },
    { type: "llm_turn", name: "XOM技术位分析", input_messages: [{ role: "user", content: question }, { role: "tool", tool_call_id: "xom-call", content: JSON.stringify(loss ? { serial_number: returned.serial_number, query, resistance: 170 } : returned) }], output: [{ role: "assistant", content: delivered }] },
    { type: "final_answer", role: "assistant", content: delivered },
  );
  return material(messages, question);
}
function material(messages: RawInput["messages"], question: string) {
  const candidate: Candidate = { batch_id: "native", case_id: "native", version: "aime", name: "aime", input_id: randomUUID(), trace_id: null,
    source: "test", line: 1, question, answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: null, source_unit: "s", source_values: {}, source_fields: {} },
    final_index: messages.length - 1, reference: null, llm: null };
  const binding = bindAttributionMaterial(candidate, { messages });
  const transitions = (binding.request.input.answer as { transitions: AttributionTransition[] }).transitions;
  const evidence = [...new Map(transitions.flatMap(item => [...item.before, ...item.after])
    .flatMap(item => {
      const point = parseEvidenceCoordinates(item.evidence_id)!;
      if (point.kind === "image") return [];
      const source = evidenceSources(messages[point.message_index]).find(source => source.kind === point.kind && source.path === point.path)!;
      return [{ ...item, quote: source.text.slice(point.start, point.end) }];
    }).map(item => [item.evidence_id, item])).values()];
  const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], calculations: [], artifacts: [], traceReads: evidence.flatMap(item => {
    const coordinate = parseEvidenceCoordinates(item.evidence_id)!;
    return coordinate.kind === "image" ? [] : [{ candidate: "answer", message_index: coordinate.message_index, kind: coordinate.kind,
      path: coordinate.path, start: coordinate.start, end: coordinate.end }];
  }) };
  return { binding, transitions, evidence, audit };
}
function check(transition: AttributionTransition, outcome: TransitionCheck["outcome"] = "preserved"): TransitionCheck {
  return { transition_index: transition.transition_index, kind: transition.kind, outcome,
    observation: "核对所引两侧字段、对象、单位与期间，按实际记录保留已知边界。",
    before_evidence_ids: transition.before.map(item => item.evidence_id), after_evidence_ids: transition.after.map(item => item.evidence_id) };
}
function cause(transition: AttributionTransition, row: TransitionCheck, fields: Partial<Responsibility> = {}): Responsibility {
  return { transition_index: transition.transition_index, actor_index: transition.actor_index, chain_index: transition.chain_index,
    role: "primary", basis: "input_deviation", technical_domain: "生成模型", functional_component: "回答生成", component: "XOM技术位分析",
    business_component: "XOM技术位字段对照与价位表述", chain_step: "模型实际输入", failure_stage: "数据解释与计算", field_names: [],
    mechanism_source: "boundary_comparison", certainty: "inferred", mechanism: "所引输入与输出存在价位差异；中间处理机制未记录，保留记忆补写等替代解释。",
    reason: "相关差异影响技术位结论。", evidence_ids: [...new Set([...row.before_evidence_ids, ...row.after_evidence_ids])],
    evidence_gap: "没有隐藏推理动作记录。", alternatives: ["可能存在记忆补写。"], ...fields };
}
function problem(component: Responsibility[], investigation: TransitionCheck[]): ProblemProposal {
  return { component, investigation, calculations: [], diagnosis: "context_loss", label: "MA50缺失及无据支撑位", definition: "MA50字段与支撑位表述不一致。" };
}
const inspect = (f: ReturnType<typeof material>, value: ProblemProposal, evidence: Evidence[] = f.evidence) =>
  investigationIssues(f.binding.request, value, evidence, f.audit, "/problem");

test("native gate separates lost fields from independent generation and leaves correct execution innocent", () => {
  const f = nativeFixture(true), generation = f.transitions.find(item => item.kind === "generation")!, transfer = f.transitions.find(item => item.kind === "transfer")!;
  assert(transfer, "a referenced return must be linked to the observed input");
  const checks = f.transitions.filter(item => item.kind !== "delivery").map(item => check(item, item.kind === "transfer" || item.kind === "generation" ? "changed" : "preserved"));
  const byId = new Map(checks.map(row => [row.transition_index, row]));
  const value = problem([cause(transfer, byId.get(transfer.transition_index)!, { basis: "unknown_transition" }),
    cause(generation, byId.get(generation.transition_index)!, { role: "contributing", basis: "independent_addition" })], checks);
  assert.deepEqual(inspect(f, value), []);
  const execution = f.transitions.find(item => item.kind === "execution")!;
  const incorrectlyBlamed = cause(execution, byId.get(execution.transition_index)!, { role: "contributing" });
  assert(inspect(f, { ...value, component: [...value.component, incorrectlyBlamed] }).some(item => item.code === "responsibility_formation"));
  const generationPrimary = problem([cause(generation, byId.get(generation.transition_index)!, { basis: "independent_addition" })], checks);
  assert.deepEqual(inspect(f, generationPrimary), []);
  generationPrimary.component[0].basis = "input_deviation";
  assert(inspect(f, generationPrimary).some(item => item.code === "responsibility_generation_formation"));
});

test("native gate requires actual checks and keeps boundary certainty inferred", () => {
  const f = nativeFixture(), generation = f.transitions.find(item => item.kind === "generation")!;
  const checks = f.transitions.filter(item => item.kind !== "delivery").map(item => check(item, item === generation ? "changed" : "preserved"));
  const value = problem([cause(generation, checks.find(item => item.transition_index === generation.transition_index)!)], checks);
  assert.deepEqual(inspect(f, value), []);
  assert(inspect(f, { ...value, investigation: [] }).some(item => item.code === "responsibility_check_required"));
  assert(investigationIssues(f.binding.request, value, f.evidence, { ...f.audit, traceReads: [] }, "/problem")
    .some(item => item.code === "investigation_read_required"));
  value.component[0].certainty = "confirmed";
  assert(inspect(f, value).some(item => item.code === "responsibility_mechanism_inferred"));
});

test("native gate rejects final-delivery evidence substituted for actual generation", () => {
  const f = nativeFixture(), generation = f.transitions.find(item => item.kind === "generation")!, delivery = f.transitions.find(item => item.kind === "delivery")!;
  const checks = f.transitions.filter(item => item.kind !== "delivery").map(item => check(item, item === generation ? "changed" : "preserved"));
  const row = checks.find(item => item.transition_index === generation.transition_index)!;
  row.after_evidence_ids = delivery.after.map(item => item.evidence_id);
  assert(inspect(f, problem([cause(generation, row)], checks)).some(item => item.code === "investigation_boundary_evidence"));
});

test("a wrong delivery selection points back to the argument evidence's actual formation boundary", () => {
  const f = nativeFixture(), formation = f.transitions.find(item => item.kind === "request_formation")!;
  const delivery = f.transitions.find(item => item.kind === "delivery")!;
  const proof = f.evidence.find(item => item.evidence_id === formation.after[0].evidence_id)!;
  f.audit.evidenceBank = [proof.evidence_id];
  const row = check(delivery, "changed");
  row.before_evidence_ids = [proof.evidence_id];
  const issues = inspect(f, problem([], [row]));
  const issue = issues.find(item => item.code === "investigation_boundary_evidence")!;
  const expected = issue.expected as { mismatched_reference: { evidence_id: string }; matching_boundaries: {
    total: number; candidates: { transition_index: number; kind: string; matched_sides: string[]; read_execution: unknown }[]; read_execution: unknown } };
  assert.equal(expected.mismatched_reference.evidence_id, proof.evidence_id);
  assert(expected.matching_boundaries.candidates.some(item => item.transition_index === formation.transition_index &&
    item.kind === "request_formation" && item.matched_sides.includes("after")));
  assert(expected.matching_boundaries.candidates.length <= 4);
  assert.deepEqual(expected.matching_boundaries.read_execution, { candidate: "answer", view: "boundaries", evidence_index: 1, offset: 0 });
  assert(!expected.matching_boundaries.candidates.some(item => item.transition_index === delivery.transition_index));
  assert.equal(row.transition_index, delivery.transition_index, "feedback never silently changes the submitted responsibility");
});

test("native gate never turns a captured chart-parameter creator into an unknown actor", () => {
  const question = "绘制P/E与回撤对照图。", args = { title: "P/E vs drawdown", series: [{ name: "P/E", data: [12, 13] }] };
  const f = material([{ type: "user_question", role: "user", content: question },
    { type: "llm_turn", name: "图表参数生成", input_messages: [{ role: "user", content: question }], output: [{ role: "assistant", content: "", tool_calls: [{ id: "chart", type: "function", function: { name: "render", arguments: JSON.stringify(args) } }] }] },
    { type: "tool_call", name: "render", call_id: "chart", input: args },
    { type: "tool_result", name: "render", call_id: "chart", output: { status: "ok", image: "chart.png" } },
    { type: "llm_turn", name: "图表交付说明", input_messages: [{ role: "tool", content: '{"status":"ok","image":"chart.png"}' }], output: [{ role: "assistant", content: "图表已生成。" }] },
    { type: "final_answer", role: "assistant", content: "图表已生成。" }], question);
  const creator = f.transitions.find(item => item.kind === "request_formation")!, row = check(creator, "changed");
  assert.notEqual(creator.actor_index, null);
  const value = problem([cause(creator, row, { basis: "independent_addition", mechanism_source: "explicit_process", certainty: "confirmed" })], [row]);
  assert.deepEqual(inspect(f, value), []);
  Object.assign(value.component[0], { actor_index: null, basis: "unknown_transition" });
  const codes = inspect(f, value).map(item => item.code);
  assert(codes.includes("responsibility_transition_actor"));
  assert(codes.includes("responsibility_basis"));
});

test("native gate cannot discharge relevant XOM upstream checks using unrelated weather execution", () => {
  const f = nativeFixture(false, true), generation = f.transitions.find(item => item.kind === "generation")!;
  assert(generation.predecessors.length);
  const irrelevant = f.transitions.filter(item => item.chain_index === 1 && ["request_formation", "execution"].includes(item.kind));
  assert.equal(irrelevant.length, 2);
  const row = check(generation, "changed");
  row.before_evidence_ids = generation.before.filter(item => f.evidence.find(source => source.evidence_id === item.evidence_id)?.quote === "核对XOM的MA50支撑，并给出结论。").map(item => item.evidence_id);
  assert.equal(row.before_evidence_ids.length, 1);
  const checks = [...irrelevant.map(item => check(item)), row];
  const selectedIds = new Set(checks.flatMap(item => [...item.before_evidence_ids, ...item.after_evidence_ids]));
  const issues = inspect(f, problem([cause(generation, row)], checks), f.evidence.filter(item => selectedIds.has(item.evidence_id)));
  assert(issues.some(item => item.code === "responsibility_upstream_required"), "unrelated weather cannot satisfy XOM upstream review");
});

test("a claim follows its paired input and source without traversing unrelated carried history", () => {
  const original = nativeFixture(false, true), raw = original.binding.request.sources.answer.value as RawInput;
  const weather = { role: "tool", tool_call_id: "weather-call", content: JSON.stringify(raw.messages[3].output) };
  (raw.messages[4].input_messages as unknown[]).push(weather);
  (raw.messages[7].input_messages as unknown[]).push(weather);
  const f = material(raw.messages, "核对XOM的MA50支撑，并给出结论。"), generation = f.transitions.find(item => item.kind === "generation")!;
  const transfer = f.transitions.find(item => item.kind === "transfer" && item.chain_index === 2)!;
  const upstream = f.transitions.filter(item => item.chain_index === 2 && ["request_formation", "execution", "transfer"].includes(item.kind));
  const checks = upstream.map(item => {
    const value = check(item);
    if (item.kind === "request_formation") value.before_evidence_ids = item.before.filter(boundary =>
      f.evidence.some(proof => proof.evidence_id === boundary.evidence_id && proof.quote === "核对XOM的MA50支撑，并给出结论。")).map(item => item.evidence_id);
    return value;
  });
  const generated = check(generation, "changed");
  generated.before_evidence_ids = transfer.after.map(item => item.evidence_id);
  checks.push(generated);
  const value = problem([cause(generation, generated)], checks);
  // Extra evidence selected for the finding is not a declaration that all history caused it.
  assert.deepEqual(inspect(f, value), []);
  const incomplete = inspect(f, { ...value, investigation: [generated] });
  const required = incomplete.filter(issue => issue.code === "responsibility_upstream_required")
    .map(issue => (issue.expected as { transition_index: number }).transition_index);
  assert.deepEqual(new Set(required), new Set(upstream.map(item => item.transition_index)), "the known source/request segment is requested together");

  const selected = selectEvidenceSource(evidenceSources(raw.messages[7]), "/input_messages")!;
  const broad = cite(f.binding.request.sources.answer.id, 7, selected.source, selected.start, selected.end);
  generated.before_evidence_ids = [broad.evidence_id];
  value.component = [cause(generation, generated)];
  const wide = inspect(f, value, [...f.evidence, broad]);
  assert(wide.some(issue => issue.code === "responsibility_evidence_scope"), "a whole history block must be narrowed, not audited as every source");
  assert(!wide.some(issue => issue.code === "responsibility_upstream_required" &&
    f.transitions.some(item => item.chain_index === 1 && item.transition_index === (issue.expected as { transition_index: number })?.transition_index)));
});

test("native gate distinguishes a recovered upstream unit error from later generation deviation", () => {
  const question = "查询XOM的MA50，所有价格必须用美元。", query = "XOM MA50 in cents";
  const args = { query }, returned = { query, MA50: 16578.99, unit: "cents" }, restored = { query, MA50: 165.7899, unit: "USD" };
  const f = material([{ type: "user_question", role: "user", content: question },
    { type: "llm_turn", name: "技术位查询参数", input_messages: [{ role: "user", content: question }], output: [{ role: "assistant", content: "", tool_calls: [{ id: "price", type: "function", function: { name: "finquery", arguments: JSON.stringify(args) } }] }] },
    { type: "tool_call", name: "finquery", call_id: "price", input: args },
    { type: "tool_result", name: "finquery", call_id: "price", output: returned },
    { type: "llm_turn", name: "技术位说明", input_messages: [{ role: "user", content: question }, { role: "tool", tool_call_id: "price", content: JSON.stringify(restored) }], output: [{ role: "assistant", content: "MA50为170美元。" }] },
    { type: "final_answer", role: "assistant", content: "MA50为170美元。" }], question);
  const generation = f.transitions.find(item => item.kind === "generation")!;
  const checks = f.transitions.filter(item => item.kind !== "delivery").map(item => check(item,
    item.kind === "request_formation" || item.kind === "generation" ? "changed" : item.kind === "transfer" ? "recovered" : "preserved"));
  const value = problem([cause(generation, checks.find(item => item.transition_index === generation.transition_index)!)], checks);
  assert.deepEqual(inspect(f, value), []);
});

test("shared upstream predecessors are visited once while recovery cuts only its own branch", () => {
  const original = nativeFixture();
  const raw = original.binding.request.sources.answer.value as RawInput;
  const input = raw.messages[4].input_messages as Record<string, unknown>[];
  input.push(structuredClone(input[1])); // The same real return appears at two distinct actual input positions.
  const f = material(raw.messages, "核对XOM的MA50支撑，并给出结论。");
  const generation = f.transitions.find(item => item.kind === "generation")!;
  const execution = f.transitions.find(item => item.kind === "execution")!;
  const transfers = f.transitions.filter(item => item.kind === "transfer");
  assert.equal(transfers.length, 2);
  assert(transfers.every(item => item.predecessors.includes(execution.transition_index)), "both branches share the same captured execution");
  const checks = f.transitions.filter(item => item.kind !== "delivery").map(item => check(item, item === generation ? "changed" : "preserved"));
  const value = problem([cause(generation, checks.find(item => item.transition_index === generation.transition_index)!)], checks);
  const executionCheck = checks.find(item => item.transition_index === execution.transition_index)!;
  let visits = 0, outcome: TransitionCheck["outcome"] = "preserved";
  Object.defineProperty(executionCheck, "outcome", { get: () => { visits++; return outcome; } });
  assert.deepEqual(inspect(f, value), []);
  assert.equal(visits, 1, "shared upstream work is evaluated by node, not once per path");
  outcome = "changed";
  const transferChecks = transfers.map(item => checks.find(row => row.transition_index === item.transition_index)!);
  transferChecks[0].outcome = "recovered";
  assert(inspect(f, value).some(issue => issue.code === "responsibility_generation_formation"), "recovery on one branch cannot hide the other unrecovered path");
  transferChecks[1].outcome = "recovered";
  visits = 0;
  assert.deepEqual(inspect(f, value), []);
  assert.equal(visits, 0, "all recovered branches stop before the shared earlier defect");
});

test("native gate closes the relevant source-to-input path instead of stopping at correct original returns", () => {
  const f = nativeFixture(true), generation = f.transitions.find(item => item.kind === "generation")!;
  for (const sourceKinds of [["request_formation"], ["request_formation", "execution"]]) {
    const sources = f.transitions.filter(item => sourceKinds.includes(item.kind));
    const row = check(generation, "changed");
    row.before_evidence_ids = generation.before.filter(item => f.evidence.find(source => source.evidence_id === item.evidence_id)?.quote === "核对XOM的MA50支撑，并给出结论。").map(item => item.evidence_id);
    const checks = [...sources.map(item => check(item)), row];
    const selectedIds = new Set(checks.flatMap(item => [...item.before_evidence_ids, ...item.after_evidence_ids]));
    const issues = inspect(f, problem([cause(generation, row)], checks), f.evidence.filter(item => selectedIds.has(item.evidence_id)));
    assert(issues.some(item => item.code === "responsibility_upstream_required"), "request or correct original MA50 does not prove that MA50 reached actual generation input");
  }
});

test("repair feedback pages transition boundaries and predecessors while protected reads retain direct coordinates", () => {
  const f = nativeFixture(), generation = f.transitions.find(item => item.kind === "generation")!, row = check(generation, "changed");
  const missingCheck = inspect(f, problem([cause(generation, row)], []))
    .find(issue => issue.code === "responsibility_check_required")!;
  assert.deepEqual(missingCheck.expected, { transition_index: generation.transition_index, kind: generation.kind,
    before: { count: generation.before.length, read_execution: { candidate: "answer", view: "before", transition_index: generation.transition_index, offset: 0 } },
    after: { count: generation.after.length, read_execution: { candidate: "answer", view: "after", transition_index: generation.transition_index, offset: 0 } } });
  row.before_evidence_ids = generation.before.filter(item => f.evidence.find(proof => proof.evidence_id === item.evidence_id)?.quote === "核对XOM的MA50支撑，并给出结论。").map(item => item.evidence_id);
  const selected = f.evidence.filter(item => [...row.before_evidence_ids, ...row.after_evidence_ids].includes(item.evidence_id));
  const missingUpstream = inspect(f, problem([cause(generation, row)], [row]), selected)
    .find(issue => issue.code === "responsibility_upstream_required" && issue.expected && Object.hasOwn(issue.expected as object, "upstream_choices"))!;
  assert.deepEqual(missingUpstream.expected, { transition_index: generation.transition_index,
    upstream_choices: { count: generation.predecessors.length,
      read_execution: { candidate: "answer", view: "predecessors", transition_index: generation.transition_index, offset: 0 } } });
  const unread = investigationIssues(f.binding.request, problem([], [check(generation, "changed")]), f.evidence,
    { ...f.audit, traceReads: [] }, "/problem").filter(issue => issue.code === "investigation_read_required");
  assert(unread.length);
  for (const issue of unread) {
    const read = issue.expected as { candidate: string; message_index: number; kind: string; path: string; start: number; end: number };
    assert.deepEqual(Object.keys(read).sort(), ["candidate", "message_index", "kind", "path", "start", "end"].sort());
    assert.equal(read.candidate, "answer");
    assert(read.end > read.start);
  }
});

test("transition submission IDs retain the exact contiguous legal range without an expanded enum", () => {
  const f = nativeFixture(), schema = attributionSubmissionSchema(f.binding.request);
  for (const key of ["checks", "causes"] as const) {
    const field: { type: string; minimum: number; maximum?: number } = schema.properties.problems.items.properties[key].items.properties.transition_index;
    assert(!Object.hasOwn(field, "enum"));
    const validate = new Ajv2020({ strict: false }).compile(field);
    assert.equal(field.minimum, 1);
    assert.equal(field.maximum, f.transitions.length);
    for (const transition of f.transitions) assert(validate(transition.transition_index));
    for (const invalid of [0, -1, f.transitions.length + 1, 1.5, "1"]) assert(!validate(invalid));
  }
});
