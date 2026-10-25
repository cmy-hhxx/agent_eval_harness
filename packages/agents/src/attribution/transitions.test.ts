import test from "node:test";
import assert from "node:assert/strict";
import { validateEvidenceBankSources } from "@eval/contracts";
import { cite, evidenceSources, parseEvidenceCoordinates, selectEvidenceSource, traceComponentIdentities } from "@eval/tools";
import { buildAttributionExecutionNodes, buildAttributionTransitions, type TransitionBoundary } from "./transitions.js";
import type { BusinessChain } from "./types.js";

const inputId = "11ff7f2a-382f-442c-8903-fce0b57e4c63";
type Raw = { messages: unknown[] };
const proof = (raw: Raw, index: number, path: string) => {
  const selected = selectEvidenceSource(evidenceSources(raw.messages[index]), path)!;
  return cite(inputId, index, selected.source, selected.start, selected.end);
};
const originalText = (raw: Raw, boundary: TransitionBoundary) => {
  const point = parseEvidenceCoordinates(boundary.evidence_id)!;
  assert(point.kind !== "image");
  return evidenceSources(raw.messages[point.message_index]).find(source => source.kind === point.kind && source.path === point.path)!
    .text.slice(point.start, point.end);
};
function chain(raw: Raw, index: number, request: number, returned: number, consumed: [number, string][]): BusinessChain {
  return { chain_index: index, tool_component: "lookup", request_index: request, return_indices: [returned], planner_index: null,
    context_indices: [...new Set(consumed.map(([message]) => message))], link_basis: "call_id", references: [], delivery_changed: false,
    checkpoints: Array.from({ length: 8 }, (_, step) => ({ step: String(step), availability: "available",
      evidence: step === 3 ? [proof(raw, returned, "/output")] : step === 5 ? consumed.map(([message, path]) => proof(raw, message, path)) : [], note: "" })),
    final_evidence: [] };
}
function build(raw: Raw, chains: BusinessChain[]) {
  const finalIndex = raw.messages.length - 1, actors = traceComponentIdentities(raw, inputId, finalIndex);
  return { actors, transitions: buildAttributionTransitions({ raw, inputId, finalIndex, actors, chains }) };
}

test("large captured histories index structured content without repeated whole-source scans", () => {
  const entries = Array.from({ length: 6000 }, (_, index) => ({ role: "user", content: [{ text: `public-${index}` }] }));
  const raw = { messages: [{ type: "llm_turn", input_messages: [
    { role: "system", content: "private_instruction_omitted" }, ...entries,
  ], output: [{ role: "assistant", content: "Reviewed" }] }, { type: "final_answer", content: "Reviewed" }] };
  const started = performance.now();
  const { transitions } = build(raw, []);
  const elapsed = performance.now() - started;
  assert.equal(transitions.find(event => event.kind === "generation")!.before.length, entries.length);
  assert(elapsed < 3000, `structured history assembly took ${Math.round(elapsed)} ms`);
});

test("captured tool_call_id links a truncated actual input without content matching or invented actors", () => {
  const args = { command: "fetch SPY and RSP" }, call = { id: "captured-call", type: "function", function: { name: "shell", arguments: JSON.stringify(args) } };
  const capturedInput = { role: "tool", name: "shell", tool_call_id: "captured-call", content: '{"stdout":"SPY=-0.183256;RSP=-0.582027\n…[earlier tool output truncated to save context]' };
  const raw = { messages: [
    { type: "llm_turn", parent_span: "planner", input_messages: [{ role: "user", content: "Review breadth" }], output: [{ role: "assistant", content: null, tool_calls: [call] }] },
    { type: "tool_call", name: "shell", parent_span: "planner", input: args },
    { type: "tool_result", name: "shell", output: { stdout: "SPY=-0.183256;RSP=-0.582027;full remaining data" } },
    { type: "llm_turn", input_messages: [capturedInput], output: [{ role: "assistant", content: "Gap is three tenths." }] },
    { type: "final_answer", content: "Gap is three tenths." },
  ] };
  const chains = [chain(raw, 1, 1, 2, [])];
  const { transitions } = build(raw, chains);
  const transfer = transitions.find(item => item.kind === "transfer")!;
  assert(transfer);
  assert.equal(transfer.input_path, "/input_messages/0");
  assert.equal(transfer.actor_index, null, "call identity proves a source link, not the missing truncation actor");
  assert.equal(transfer.relation, "unresolved");
  assert.equal(originalText(raw, transfer.after[0]), capturedInput.content);
  const execution = transitions.find(item => item.kind === "execution")!;
  assert.deepEqual(transfer.predecessors, [execution.transition_index]);
  assert(transitions.find(item => item.kind === "generation")!.predecessors.includes(transfer.transition_index));
  capturedInput.tool_call_id = "unobserved-call";
  assert(!build(raw, chains).transitions.some(item => item.kind === "transfer"), "similar text cannot replace missing call identity");
});

test("BE quarterly mislabelling belongs to captured code formation before correct shell execution", () => {
  const data = { action_id: "quarter", stdout: "Q3 NetIncome=248976000; Q2 NetIncome=198856000" };
  const command = "print('q3_ni', 198856000)", generated = { role: "assistant", content: null,
    tool_calls: [{ id: "calc", function: { name: "shell", arguments: JSON.stringify({ command }) } }] };
  const result = { action_id: "calc001", stdout: "q3_ni 198856000" };
  const raw = { messages: [
    { role: "user", content: "Review Q3" },
    { type: "tool_call", name: "finquery", call_id: "query", input: { query: "Q3 and Q2" } },
    { type: "tool_result", name: "finquery", call_id: "query", output: data },
    { type: "llm_turn", input_messages: [{ role: "tool", content: JSON.stringify(data) }], output: [generated] },
    { type: "tool_call", name: "shell", call_id: "calc", input: { command } },
    { type: "tool_result", name: "shell", call_id: "calc", output: result },
    { type: "llm_turn", input_messages: [{ role: "tool", content: JSON.stringify(data) }, generated,
      { role: "tool", content: JSON.stringify(result) }], output: [{ role: "assistant", content: "Q3 net income is 199M" }] },
    { type: "final_answer", content: "Q3 net income is 199M" },
  ] };
  const chains = [chain(raw, 1, 1, 2, [[3, "/input_messages/0/content"], [6, "/input_messages/0/content"], [6, "/input_messages/1/tool_calls"]]),
    chain(raw, 2, 4, 5, [[6, "/input_messages/2/content"]])];
  const { actors, transitions } = build(raw, chains);
  const formation = transitions.find(event => event.kind === "request_formation")!;
  assert.deepEqual(actors[formation.actor_index! - 1].message_indices, [3]);
  assert(formation.before.some(item => originalText(raw, item).includes("248976000")));
  assert(formation.after.some(item => item.message_index === 3 && originalText(raw, item).includes("q3_ni")));
  const execution = transitions.find(event => event.kind === "execution" && event.chain_index === 2)!;
  assert.equal(actors[execution.actor_index! - 1].kind, "tool");
  assert(execution.predecessors.includes(formation.transition_index));
  const final = transitions.find(event => event.kind === "generation" && event.after.some(item => item.message_index === 6))!;
  assert(final.before.some(item => originalText(raw, item).includes("248976000")));
  assert(final.before.some(item => originalText(raw, item).includes("q3_ni 198856000")));
  assert(final.predecessors.some(index => transitions[index - 1].before.some(item => item.message_index === 5)));
  const propagated = transitions.find(event => event.kind === "transfer" && event.after.some(item => item.evidence_id.endsWith("/input_messages/1/tool_calls")))
    ?? transitions.find(event => event.kind === "transfer" && event.before.some(item => item.message_index === 3));
  assert(propagated);
  assert(propagated.before.every(item => item.message_index === 3), "a captured model output is not relabelled as the original tool return");
  assert(propagated.predecessors.includes(formation.transition_index));
  for (const event of transitions) assert(event.predecessors.every(index => index < event.transition_index), "all predecessor edges point to earlier observations");
  validateEvidenceBankSources(transitions.flatMap(event => [...event.before, ...event.after].map(item => item.evidence_id)), new Map([[inputId, raw]]));
});

test("chart parameters, rendering execution, model generation and final delivery remain distinct", () => {
  const command = 'render --title "P/E vs drawdown" --series P/E';
  const generated = { role: "assistant", content: "", tool_calls: [{ id: "draw", function: { name: "shell", arguments: JSON.stringify({ command }) } }] };
  const result = { action_id: "chart01", stdout: JSON.stringify({ type: "vis-html", id: "html-chart" }) };
  const raw = { messages: [
    { role: "user", content: "Compare stocks" },
    { type: "llm_turn", input_messages: [{ role: "user", content: "Compare stocks" }], output: [generated] },
    { type: "tool_call", name: "shell", call_id: "draw", input: { command } },
    { type: "tool_result", name: "shell", call_id: "draw", output: result },
    { type: "llm_turn", input_messages: [generated, { role: "tool", content: JSON.stringify(result) }],
      output: [{ role: "assistant", content: 'Chart. <vis-html ref="html-chart"/>' }] },
    { type: "final_answer", content: [{ type: "output_text", text: "Chart." }, { type: "output_image", image_url: "data:image/png;base64,AA==" }] },
  ] };
  const { actors, transitions } = build(raw, [chain(raw, 1, 2, 3, [[4, "/input_messages/1/content"]])]);
  const formation = transitions.find(event => event.kind === "request_formation")!;
  assert.deepEqual(actors[formation.actor_index! - 1].message_indices, [1]);
  assert(formation.after.some(item => item.evidence_id.endsWith("/output/0/tool_calls/0/function/arguments")));
  const generation = transitions.find(event => event.kind === "generation")!, delivery = transitions.find(event => event.kind === "delivery")!;
  assert(generation.after.every(item => item.message_index === 4));
  assert(delivery.after.every(item => item.message_index === 5));
  assert.equal(delivery.actor_index, null, "the final capture does not identify a renderer");
  assert.deepEqual(delivery.predecessors, [generation.transition_index]);
  assert(transitions.filter(event => event.kind === "transfer").every(event => event.actor_index === null));
  assert(transitions.every(event => [...event.before, ...event.after].every(item => !Object.hasOwn(item, "quote"))));
});

test("field-loss transfer stays unknown while actual generation is separately owned", () => {
  const raw = { messages: [{ role: "user", content: "Technical levels" },
    { type: "tool_call", name: "finquery", call_id: "q", input: { query: "MA50" } },
    { type: "tool_result", name: "finquery", call_id: "q", output: { MA50: 165.7899, price: 183.22 } },
    { type: "llm_turn", input_messages: [{ role: "user", content: "source=q; price=183.22; is_truncated=true" }],
      output: [{ role: "assistant", content: "MA50 supports 170–172" }] },
    { type: "final_answer", content: "MA50 supports 170–172" }] };
  const { transitions } = build(raw, [chain(raw, 1, 1, 2, [[3, "/input_messages/0/content"]])]);
  const transfer = transitions.find(event => event.kind === "transfer")!;
  assert.equal(transfer.actor_index, null); assert.equal(transfer.relation, "unresolved");
  assert(transfer.before.some(item => originalText(raw, item).includes("165.7899")));
  assert(transfer.after.every(item => !originalText(raw, item).includes("165.7899")));
  assert.equal(transfer.input_path, "/input_messages/0");
  assert.notEqual(transitions.find(event => event.kind === "generation")?.actor_index, null);
});

test("an unlinked source has no invented transfer and a final capture is never generation", () => {
  const raw = { messages: [{ role: "user", content: "Question" },
    { type: "tool_call", name: "lookup", call_id: "q", input: {} },
    { type: "tool_result", name: "lookup", call_id: "q", output: "source" },
    { type: "final_answer", content: "Delivered without captured generation" }] };
  const { transitions } = build(raw, [chain(raw, 1, 1, 2, [])]);
  assert.deepEqual(transitions.map(event => event.kind), ["execution", "delivery"]);
  assert.deepEqual(transitions[1].before, []); assert.deepEqual(transitions[1].predecessors, []);
});

test("captured process fields are generation evidence while input reasoning stays before the boundary", () => {
  for (const field of ["reasoning_content", "analysis", "thinking", "calculation_steps"]) {
    const raw = { messages: [{ role: "user", content: "Calculate growth" },
      { type: "llm_turn", input_messages: [{ role: "user", content: "Input: 100 and 110" }],
        output: [{ role: "assistant", content: "Growth is 20%", [field]: "(110-100)/100=0.2" }] },
      { type: "final_answer", content: "Growth is 20%" }] };
    const { transitions } = build(raw, []);
    const generation = transitions.find(event => event.kind === "generation")!;
    assert(generation.after.some(item => originalText(raw, item) === "(110-100)/100=0.2"), field);
    assert(generation.after.every(item => !originalText(raw, item).includes("Input:")));
    assert(generation.before.some(item => originalText(raw, item).includes("Input:")));
  }
});

test("shared assistant transfer is one physical boundary across chains while distinct outputs remain distinct", () => {
  for (const shared of [true, false]) {
    const outputs = shared ? [{ role: "assistant", content: "Alpha and Beta summary" }]
      : [{ role: "assistant", content: "Alpha summary" }, { role: "assistant", content: "Beta summary" }];
    const raw = { messages: [{ role: "user", content: "Compare" },
      { type: "tool_call", name: "lookup", call_id: "a", input: { query: "Alpha" } },
      { type: "tool_result", name: "lookup", call_id: "a", output: "Alpha return" },
      { type: "tool_call", name: "lookup", call_id: "b", input: { query: "Beta" } },
      { type: "tool_result", name: "lookup", call_id: "b", output: "Beta return" },
      { type: "llm_turn", input_messages: [{ role: "tool", content: "Alpha return" }, { role: "tool", content: "Beta return" }], output: outputs },
      { type: "llm_turn", input_messages: outputs, output: [{ role: "assistant", content: "Compared" }] },
      { type: "final_answer", content: "Compared" }] };
    const chains = [chain(raw, 1, 1, 2, [[5, "/input_messages/0/content"], [6, "/input_messages/0/content"]]),
      chain(raw, 2, 3, 4, [[5, "/input_messages/1/content"], [6, `/input_messages/${shared ? 0 : 1}/content`]])];
    const { transitions } = build(raw, chains);
    const transferred = transitions.filter(event => event.kind === "transfer" && event.after.some(item => item.message_index === 6));
    assert.equal(transferred.length, shared ? 1 : 2);
    assert.deepEqual(transferred.map(event => event.chain_index).sort(), shared ? [null] : [1, 2]);
    assert.deepEqual(transferred.map(event => event.chain_indices), shared ? [[1, 2]] : [[1], [2]]);
    assert.deepEqual(new Set(transferred.flatMap(event => event.before.map(item => item.evidence_id))),
      new Set(outputs.map((_, index) => proof(raw, 5, `/output/${index}/content`).evidence_id)));
    assert.deepEqual(new Set(transferred.flatMap(event => event.after.map(item => item.evidence_id))),
      new Set(outputs.map((_, index) => proof(raw, 6, `/input_messages/${index}/content`).evidence_id)));
    const generation = transitions.find(event => event.kind === "generation" && event.after.some(item => item.message_index === 5))!;
    assert(transferred.every(event => event.predecessors.includes(generation.transition_index)));
    assert.equal(transitions.filter(event => event.kind === "execution").length, 2);
    assert.equal(transitions.filter(event => event.kind === "transfer" && event.after.some(item => item.message_index === 5)).length, 2);
  }
});

test("execution nodes count actual calls once regardless of copied history, generated requests or returns", () => {
  const messages: unknown[] = [];
  for (let i = 0; i < 45; i++) {
    if (i < 34) messages.push({ type: "llm_turn", input_messages: [{ role: "assistant", tool_calls: [{ id: `history-${i}` }] }],
      output: [{ role: "assistant", content: "", tool_calls: [{ id: `call-${i}` }] }] });
    messages.push({ type: "tool_call", name: "lookup", call_id: `call-${i}`, input: {} },
      { type: "tool_result", name: "lookup", call_id: `call-${i}`, output: "returned" });
  }
  messages.push({ type: "final_answer", content: "Delivered" });
  const nodes = buildAttributionExecutionNodes({ messages }, []);
  assert.equal(nodes.length, 79);
  assert.equal(nodes.filter(node => node.kind === "model").length, 34);
  assert.equal(nodes.filter(node => node.kind === "tool").length, 45);
  assert.deepEqual(nodes.map(node => node.execution_node_index), Array.from({ length: 79 }, (_, i) => i + 1));
  assert(nodes.every(node => ["llm_turn", "tool_call"].includes((messages[node.message_index] as { type: string }).type)));
  const spans = { messages: [{ type: "tool_call", name: "tool-render", call_id: "a", input: {} },
    { type: "span", name: "tool-render", call_id: "a", output: "paired return" },
    { type: "span", name: "tool-standalone", output: "captured execution" },
    { type: "tool_call", name: "pending", call_id: "no-return", input: {} },
    { type: "tool_result", name: "orphan-return", output: "unknown request" }] };
  assert.deepEqual(buildAttributionExecutionNodes(spans, []).map(node => node.message_index), [0, 2, 3]);
});

test("the same output consumed twice in one actual input has two positions and no new execution", () => {
  const summary = { role: "assistant", content: "Original summary" };
  const raw = { messages: [{ role: "user", content: "Check" },
    { type: "tool_call", name: "lookup", call_id: "q", input: {} },
    { type: "tool_result", name: "lookup", call_id: "q", output: "Original source" },
    { type: "llm_turn", input_messages: [{ role: "tool", content: "Original source" }], output: [summary] },
    { type: "llm_turn", input_messages: [summary, summary], output: [{ role: "assistant", content: "Done" }] },
    { type: "final_answer", content: "Done" }] };
  const { actors, transitions } = build(raw, [chain(raw, 1, 1, 2,
    [[3, "/input_messages/0/content"], [4, "/input_messages/0/content"], [4, "/input_messages/1/content"]])]);
  const nodes = buildAttributionExecutionNodes(raw, actors), transfers = transitions.filter(event => event.kind === "transfer" && event.after.some(item => item.message_index === 4));
  assert.equal(nodes.length, 3); assert.equal(transfers.length, 2);
  assert.deepEqual(transfers.map(event => event.input_path), ["/input_messages/0", "/input_messages/1"]);
  assert(transfers.every(event => event.execution_node_index === null && event.source_node_index === nodes[1].execution_node_index && event.target_node_index === nodes[2].execution_node_index));
  assert.deepEqual(transfers[0].before, transfers[1].before);
  assert.notDeepEqual(transfers[0].after, transfers[1].after);
});
