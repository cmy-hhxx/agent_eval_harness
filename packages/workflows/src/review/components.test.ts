import test from "node:test";
import assert from "node:assert/strict";
import { processComponents, actorCatalog } from "./components.js";
import { attributionSessionSource } from "./public-trace.js";
import { parseEvidenceCoordinates, evidenceSources, cite, displayEvidence } from "@eval/tools";

test("component directory preserves named models and actual tools across flattened turns", () => {
  const turns = [0, 1].map(() => ({ messages: [
    { type: "llm_turn", name: "llm-call-7", model: "AIME-Atlas", parent_span: "parent", system_prompt: "PRIVATE_SENTINEL", output: [] },
    { type: "tool_call", name: "shell", call_id: "same", parent_span: "parent", input: { command: "python /work/render.py" } },
    { type: "tool_result", name: "shell", tool_call_id: "same", output: "done" },
  ] }));
  const id = "11111111-1111-4111-8111-111111111111";
  const source = attributionSessionSource({ messages: [], turns }, id);
  const directory = processComponents(source.raw, source.original, id, source.positions);
  assert.deepEqual(directory.map(entry => [entry.component_index, entry.name, entry.kind]), [[1, "AIME-Atlas", "model"], [2, "shell", "tool"]]);
  assert.deepEqual(directory[1]!.positions.map(position => position.trace_index), [0, 0, 1, 1]);
  assert.deepEqual(directory[1]!.invoked_by, [1]);
  assert(!JSON.stringify(directory).includes("PRIVATE_SENTINEL"));
  assert(!JSON.stringify(directory).includes("限制披露"));
  const before = structuredClone(directory), view = actorCatalog(directory);
  assert.deepEqual(view.map(entry => [entry.actor_index, entry.kind, entry.name]), [[1, "model", "AIME-Atlas"], [2, "tool", "shell"]]);
  assert.deepEqual(Object.keys(view[1]!).sort(), ["actor_index", "kind", "name", "source_evidence"]);
  assert.deepEqual(view[1]!.source_evidence, directory[1]!.source_evidence);
  assert.deepEqual(directory, before);
  for (const component of directory) for (const proof of component.source_evidence as {reference:{evidence_id:string}}[])
    assert.equal(parseEvidenceCoordinates(proof.reference.evidence_id)?.input_id, id);
});

test("a source-identified inner service remains distinct from its shell transport", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const raw = { messages: [
    { type: "llm_turn", model: "AIME-Atlas", parent_span: "parent", output: [] },
    { type: "tool_call", name: "shell", call_id: "request", parent_span: "parent", input: { command: "python finquery.py" } },
    { type: "tool_result", name: "shell", tool_call_id: "request", output: { tool: "finquery", status_code: -3222 } },
  ] };
  const positions = raw.messages.map((_, message_index) => ({ trace_index: 0, message_index }));
  const source = evidenceSources(raw.messages[2]).find(source => source.path === "/output/tool")!;
  const evidence = displayEvidence(cite(id, 2, source, 0, source.text.length));
  const components = processComponents(raw, raw, id, positions, [{ kind: "tool", name: "finquery", source_evidence: [evidence],
    component_index: 999, invoked_by: [999], identity_basis: "source_record" }]);
  assert.deepEqual(components.map(component => component.name), ["AIME-Atlas", "shell", "finquery"]);
  assert.deepEqual(components[2]!.invoked_by, [1]);
  assert.deepEqual(components[2]!.source_evidence, [evidence]);
  assert.equal(components[2]!.identity_basis, "source_reference");
  assert.equal(components[0]!.identity_basis, "source_record");
  assert.equal(components[2]!.component_index, 3);
  assert.equal(components[0]!.positions.length, 1);
});
