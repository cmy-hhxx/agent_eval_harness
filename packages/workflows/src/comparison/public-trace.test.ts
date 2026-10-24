import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bindAttributionMaterial } from "./binding.js";
import { attributionTrace, validateOriginalAttributionEvidence } from "./public-trace.js";
import { bindInstructionReview, instructionReviewFollowup } from "./instruction-review.js";
import type { Candidate, RawInput } from "./types.js";
import type { PlannedTask, RunState } from "@eval/contracts";
import { cite, evidenceSources, resolveEvidence, selectEvidenceSource } from "@eval/tools";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";

test("main attribution excludes private rules from both prompt and readable sources while preserving factual coordinates", () => {
  const id = randomUUID(), question = "查询价格。", fact = "ETF价格为369美元。";
  const raw: RawInput = { messages: [
    { role: "system", content: "SYS_PRIVATE_SENTINEL" }, { role: "user", content: question },
    { type: "tool_call", name: "view_skill", input: { name: "price" } },
    { type: "tool_result", name: "view_skill", output: '<skill_content name="price">SKILL_PRIVATE_SENTINEL</skill_content>' },
    { type: "tool_result", name: "prices", output: fact },
    { type: "llm_turn", name: "llm-call-1", input_messages: [{ role: "developer", content: "DEV_PRIVATE_SENTINEL" },
      { role: "tool", content: fact }], output: [{role:"assistant",content:"现货金价为3690美元。"}] },
    { type:"final_answer", role: "assistant", content: "现货金价为3690美元。" },
  ] };
  const candidate = { input_id: id, question, final_index: 6, reference: null, answer_timing: { finish_seconds: null } } as Candidate;
  const before = structuredClone(raw), binding = bindAttributionMaterial(candidate, raw);
  for (const value of [binding.modelInput, binding.request]) {
    const text = JSON.stringify(value);
    for (const secret of ["SYS_PRIVATE_SENTINEL", "DEV_PRIVATE_SENTINEL", "SKILL_PRIVATE_SENTINEL"]) assert(!text.includes(secret));
    assert(text.includes(fact));
  }
  const view = attributionTrace(raw, id, 6);
  const leaf = evidenceSources(view.messages[5]).find(source => source.path === "/input_messages/1/content")!;
  const evidence = cite(id, 5, leaf, 0, leaf.text.length);
  assert.equal(resolveEvidence(raw, { evidence_id: evidence.evidence_id }, "answer", emptyAudit(), "/evidence", id).quote, fact);
  validateOriginalAttributionEvidence({evidence}, {[id]:raw}, emptyAudit());
  const parent = selectEvidenceSource(evidenceSources(view.messages[5]), "/input_messages")!;
  const projected = cite(id, 5, parent.source, parent.start, parent.end);
  assert.throws(() => validateOriginalAttributionEvidence({evidence:projected}, {[id]:raw}, emptyAudit()), /原始数据源|原文/);
  const omitted = evidenceSources(view.messages[0]).find(source => source.path === "/type")!;
  assert.throws(() => validateOriginalAttributionEvidence(cite(id,0,omitted,0,omitted.text.length), {[id]:raw}, emptyAudit()),
    error => error instanceof Error && /原始数据源/u.test(error.message) && !error.message.includes("SYS_PRIVATE_SENTINEL"));
  const check = bindInstructionReview(candidate, raw);
  const text = JSON.stringify(check.request);
  for (const secret of ["SYS_PRIVATE_SENTINEL", "DEV_PRIVATE_SENTINEL", "SKILL_PRIVATE_SENTINEL"]) assert(text.includes(secret));
  assert(!Object.hasOwn(check.request.input, "attribution"));
  assert.deepEqual(raw, before);
  const serialized = { messages: [{ type: "llm_turn", input_messages: JSON.stringify(raw.messages[5].input_messages) }] };
  assert(!JSON.stringify(attributionTrace(serialized, id, 0)).includes("DEV_PRIVATE_SENTINEL"));
});

test("each accepted attribution schedules exactly one separate instruction session without joining comparison dependencies", () => {
  const inputId = randomUUID();
  const parent: PlannedTask = { id: randomUUID(), stage: "attribution", inputIds: { answer: inputId }, dependencies: {},
    data: { candidates: { A: { input_id: inputId } } } };
  const state = { manifest: { tasks: [parent] } } as RunState;
  const [check] = instructionReviewFollowup(parent, state);
  assert.equal(check.stage, "instruction-review");
  assert.notEqual(check.id, parent.id);
  assert.deepEqual(check.dependencies, { source: parent.id });
  assert.deepEqual(parent.dependencies, {});
  state.manifest.tasks.push(check);
  assert.deepEqual(instructionReviewFollowup(parent, state), []);
  assert.deepEqual(instructionReviewFollowup(check, state), []);
});
