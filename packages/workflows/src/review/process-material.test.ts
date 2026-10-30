import test from "node:test";
import assert from "node:assert/strict";
import { structuredProcessFacts, referencedProcessFacts, processExecutionFacts, processMaterial } from "./process-material.js";
import { attributionSessionSource } from "./public-trace.js";
import { parseEvidenceCoordinates, resolveEvidence } from "@eval/tools";
import { presentedMaterialReads, projectComparisonEvidence } from "./evidence-presentation.js";

test("recorded model output distinguishes empty text from a structured tool request", () => {
  const raw = { messages: ["", [{ role: "assistant", content: "" }],
    [{ role: "assistant", content: "", tool_calls: [{ name: "query", arguments: {} }] }],
    [{ role: "assistant", content: "[]" }], [{ role: "assistant", content: "正常结果。" }]]
    .map(output => ({ type: "llm_turn", name: "worker", output })) };
  const rows = processExecutionFacts(raw, raw, "11111111-1111-4111-8111-111111111111")[0]!.model_outputs;
  assert.deepEqual(rows.map(row => row.output_form), ["empty_text", "empty_text", "structured_output", "empty_json_array", "nonempty_text"]);
});

test("execution links distinguish returned data from data actually present in a model input", () => {
  const raw = { messages: [
    { type: "llm_turn", parent_span: "p", output: [{ tool_calls: [{ id: "call", function: { name: "shell", arguments: "{}" } }] }] },
    { type: "tool_call", name: "shell", call_id: "call", parent_span: "p", input: {} },
    { type: "tool_result", name: "shell", tool_call_id: "call", output: "actual observation" },
    { type: "llm_turn", input_messages: [], output: [{ content: "原模型声称已经读取返回。" }] },
    { type: "llm_turn", input_messages: { messages: [{ role: "tool", name: "shell", tool_call_id: "call", content: "actual observation" }] }, output: [] },
  ] };
  const facts = processExecutionFacts(raw, raw, "11111111-1111-4111-8111-111111111111")[0] as unknown as Record<string, unknown>;
  assert.deepEqual(facts.execution_links, [{ request_message_index: 1, return_message_indices: [2],
    invoking_model_message_index: 0, model_inputs: [{ message_index: 4, path: "/input_messages/messages/0/content" }], link_basis: "call_id" }]);
  raw.messages.splice(3, 0, { ...raw.messages[1]! });
  const ambiguous = processExecutionFacts(raw, raw, "11111111-1111-4111-8111-111111111111")[0] as any;
  assert.deepEqual(ambiguous.execution_links[0].model_inputs, [], "a reused call ID cannot identify which response entered the model");
});

test("repeated input locations stay global across turns and do not merge redacted differences", () => {
  const turn = { messages: [
    { type: "tool_call", name: "shell", call_id: "call", input: {} },
    { type: "tool_result", name: "shell", tool_call_id: "call", output: "observed" },
    ...["PRIVATE_A", "PRIVATE_B", "PRIVATE_A"].map(content => ({ type: "llm_turn", model: "M",
      input_messages: [{ role: "tool", tool_call_id: "call", content }], output: [] })),
  ] };
  const original = { messages: [...turn.messages, ...structuredClone(turn.messages)] };
  const raw = structuredClone(original);
  for (const message of raw.messages) if ("input_messages" in message) message.input_messages![0]!.content = "omitted";
  const positions = raw.messages.map((_, index) => ({ trace_index: Math.floor(index / 5), message_index: index % 5 }));
  const facts = processExecutionFacts(raw, original, "11111111-1111-4111-8111-111111111111", positions);
  assert.deepEqual(facts[1]!.execution_links[0]!.model_inputs, [
    { message_index: 7, path: "/input_messages/0/content", additional_input_locations: [{ message_index: 9, path: "/input_messages/0/content" }] },
    { message_index: 8, path: "/input_messages/0/content" },
  ]);
  assert(!JSON.stringify(facts).includes("PRIVATE_"));
});

test("numeric menus retain original payload context before large nested series", () => {
  const raw = { messages: [{ type: "tool_result", output: {
    rows: Array.from({ length: 100 }, (_, i) => ({ revenue: 27.3 + i, margin: 0.12, expense: 8.4 })),
    entity: "ABC", unit: "USD millions", period: "FY 2026",
  } }] };
  const [facts] = structuredProcessFacts(raw, 180);
  assert.equal(facts!.fields["/unit"], "USD millions");
  assert.equal(facts!.fields["/period"], "FY 2026");
  assert.equal(facts!.fields["/entity"], "ABC");
  assert.equal(facts!.fields["/rows/0/revenue"], 27.3);
  assert.equal(facts!.partial, true);
});

test("large column metadata cannot hide later numeric table values from compact", () => {
  const result = {
    columns: Array.from({ length: 20 }, (_, i) => ({ name: `metric-${i}`, definition: "column description ".repeat(6), unit: "元" })),
    datas: [{ price: 230.46, growth: "33.7", period: "2026Q4" }],
  };
  for (const output of [result, JSON.stringify(result)]) {
    const [facts] = structuredProcessFacts({ messages: [{ role: "tool", output }] }, 240);
    assert.equal(facts!.fields["/datas/0/price"], 230.46);
    assert.equal(facts!.fields["/datas/0/growth"], "33.7");
    assert.equal(facts!.partial, true);
    assert.equal(facts!.path, "/output");
  }
});

test("key_data never copies image payloads as text and distinguishes empty JSON keys from a scalar root", () => {
  const raw = { messages: [{ output: { "": 100, image: "data:image/png;base64,AA==", count: 2 } }, { output: "false" }] };
  const facts = referencedProcessFacts(raw, raw, "11111111-1111-4111-8111-111111111111",
    raw.messages.map((_, message_index) => ({ trace_index: 0, message_index })));
  assert(!JSON.stringify(facts).includes("base64"));
  assert(facts.some(fact => fact.location.field_path === "/" && fact.value === 100));
  assert(facts.some(fact => fact.location.field_path === "" && fact.value === false));
});

test("snapshot-only tool returns retain original coordinates across privacy projection and turns", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const guard = "Tool execution is forbidden because the maximum tool-call iteration limit has been reached.";
  const returned = { role: "tool", name: "shell", tool_call_id: "guard", content: guard };
  const turn = { messages: [
    { type: "tool_call", name: "shell", call_id: "done", input: { command: "check" } },
    { type: "tool_result", name: "shell", tool_call_id: "done", output: "checked" },
    { type: "llm_turn", input_messages: { messages: [{ role: "system", content: "PRIVATE_SENTINEL" },
      { role: "tool", name: "shell", tool_call_id: "done", content: "checked" }, returned] }, output: [] },
    { type: "llm_turn", input_messages: { messages: [returned] }, output: [] },
  ] };
  const source = attributionSessionSource({ messages: [], turns: [turn, turn] }, id);
  const material = processMaterial(source.raw, source.original, id, "answer", 12000, source.positions);
  const proofs = material.process_evidence.filter(entry => entry.quote === guard);
  assert.equal(proofs.length, 2, "repeated snapshots are deduplicated within each turn, not across turns");
  assert.deepEqual(proofs.map(entry => parseEvidenceCoordinates(entry.reference.evidence_id)), [2, 6].map(message_index => ({
    input_id: id, message_index, kind: "text", path: "/input_messages/messages/2/content", start: 0, end: guard.length,
  })));
  assert(!JSON.stringify(material).includes("PRIVATE_SENTINEL"));
  assert(!material.process_evidence.some(entry => entry.read_request.path.startsWith("/input_messages") && entry.quote === "checked"));
  const reads = presentedMaterialReads(material, "answer", id);
  const bank: string[] = [];
  const projected = projectComparisonEvidence({ answer: material }, bank, 400);
  for (const proof of proofs) {
    assert.equal(resolveEvidence(source.original, proof.reference, "answer", { traceReads: reads, viewedImages: [] }, "/proof", id).quote, guard);
    assert.equal(resolveEvidence(source.raw, proof.reference, "answer", { traceReads: reads, viewedImages: [] }, "/proof", id).quote, guard);
    assert(bank.includes(proof.reference.evidence_id));
  }
  assert(!JSON.stringify(projected).includes("PRIVATE_SENTINEL"));
  assert.deepEqual(material.execution_facts.map(turn => turn.tool_calls.map(call => call.count)), [[1], [1]]);
});

test("large tool returns preserve explicit error fields in a bounded process view", () => {
  const raw = { messages: [
    ...Array.from({ length: 150 }, () => ({ type: "llm_turn", output: [{ content: "ordinary record" }] })),
    { type: "tool_result", name: "finquery", output: { datas: "x".repeat(3000), status_code: -3222,
      status_msg: "问句解析结果异常", warns: ["unknown field debt_to_equity_ratio"], tail: "y".repeat(3000) } },
  ] };
  const material = processMaterial(raw, raw, "11111111-1111-4111-8111-111111111111", "answer", 8000);
  assert(material.process_evidence.some(entry => entry.quote.includes("unknown field debt_to_equity_ratio")));
  assert(material.process_evidence.some(entry => entry.quote.includes("-3222")));
  assert(material.process_evidence.reduce((sum, entry) => sum + entry.quote.length, 0) <= 8000);
});
