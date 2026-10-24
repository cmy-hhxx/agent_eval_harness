import assert from "node:assert/strict";
import test from "node:test";
import { traceComponentIdentities, isComponentLocator } from "./component-identity.js";
import { resolveEvidence } from "./evidence.js";
import { emptyAudit } from "../../../tests/fixtures/comparison.js";

const id = "11111111-1111-4111-8111-111111111111";
test("actor identities retain named planners and tools, while the anonymous final call has a proven role", () => {
  const raw = { messages: [
    { type: "llm_turn", name: "planner-search", input_messages: [], output: [] },
    { type: "llm_turn", name: "planner-finquery", input_messages: [], output: [] },
    { type: "tool_call", name: "finquery", call_id: "price-call", input: { query: "黄金" } },
    { type: "tool_result", call_id: "price-call", output: "GLD369" },
    { type: "llm_turn", name: "llm-call-0", input_messages: [{ role: "user", content: "黄金" }], output: [{ role: "assistant", content: "黄金3690" }] },
    { type: "final_answer", content: "黄金3690" },
  ] };
  const before = structuredClone(raw), actors = traceComponentIdentities(raw, id, 5);
  assert.deepEqual(actors.map(actor => actor.component), ["planner-search", "planner-finquery", "finquery", "最终作答节点（原始名称未提供）"]);
  assert.deepEqual(actors[2].message_indices, [2, 3]);
  assert.deepEqual(actors[3].message_indices, [4, 5]);
  assert.equal(actors[3].identity_status, "role_only");
  for (const actor of actors) for (const evidence of actor.identity_evidence)
    assert.equal(resolveEvidence(raw, { evidence_id: evidence.evidence_id }, "answer", emptyAudit(), "/identity", id).quote, evidence.quote);
  assert(actors.every(actor => !isComponentLocator(actor.component)));
  assert.deepEqual(raw, before);
});

test("multiple unnamed and same-name model records remain individually navigable without invented roles or model names", () => {
  const raw = { messages: [
    { type: "llm_turn", name: "llm-call-1", model: "opaque-model", output: [] },
    { type: "llm_turn", name: "a49b50c9-d2cb-42ea-8995-5f588b93d0b0", output: [] },
    { type: "llm_turn", name: "Planner", output: [] },
    { type: "llm_turn", name: "Planner", output: [] },
    { role: "assistant", content: "完成" },
  ] };
  const actors = traceComponentIdentities(raw, id, 4);
  assert.equal(new Set(actors.map(actor => actor.component)).size, 5);
  assert.deepEqual(actors.map(actor => actor.message_indices), [[0], [1], [2], [3], [4]]);
  assert(actors.slice(0, 2).every(actor => actor.identity_status === "unknown_identity" && actor.identity_gap));
  assert(!JSON.stringify(actors.map(actor => actor.component)).includes("opaque-model"));
  assert.equal(actors[2].component, "Planner（同名记录1）");
  assert.equal(actors[3].component, "Planner（同名记录2）");
});

test("an explicit final node name takes precedence over the anonymous generation locator", () => {
  const raw = { messages: [
    { type: "llm_turn", name: "llm-call-0", input_messages: [], output: [{ role: "assistant", content: "完成" }] },
    { type: "final_answer", name: "最终作答节点", content: "完成" },
  ] };
  const [actor] = traceComponentIdentities(raw, id, 1);
  assert.equal(actor.component, "最终作答节点");
  assert.deepEqual(actor.message_indices, [0, 1]);
  assert(actor.identity_evidence.some(evidence => evidence.message_index === 1 && evidence.quote === "最终作答节点"));
});

test("bare execution locators are not component display names", () => {
  for (const locator of ["llm-call-0", "span-4f26f1fabe23fc3c", "4f26f1fabe23fc3c", "a49b50c9-d2cb-42ea-8995-5f588b93d0b0"])
    assert(isComponentLocator(locator), locator);
  for (const name of ["planner-finquery", "request-router", "trace-search", "finquery", "display", "最终作答节点"]) assert(!isComponentLocator(name), name);
});
