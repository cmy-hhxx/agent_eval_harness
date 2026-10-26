import test from "node:test";
import assert from "node:assert/strict";
import * as evidence from "./evidence-selection.js";
import { evidenceId } from "./evidence.js";
import { ValidationError } from "./validation.js";
const source = "11111111-1111-4111-8111-111111111111";
const first = evidenceId(source, 0, "text", "/content", 0, 6);
const second = evidenceId(source, 1, "image");
test("evidence bank appends coordinates, reuses a choice and preserves observations outside the bank", () => {
  const bank: string[] = [];
  assert.deepEqual(evidence.selectEvidence(bank, { evidence_id: first }), { evidence_index: 1 });
  assert.deepEqual(evidence.selectEvidence(bank, { evidence_id: second, observation: "图上数值是六" }), { evidence_index: 2, observation: "图上数值是六" });
  assert.deepEqual(evidence.selectEvidence(bank, { evidence_id: first }), { evidence_index: 1 });
  assert.deepEqual(bank, [first, second]);
  assert.deepEqual(evidence.resolveEvidenceSelection(bank, { evidence_index: 2, observation: "图上数值是六" }, "/evidence/0"), { evidence_id: second, observation: "图上数值是六" });
});
test("invalid and unavailable choices never guess or append evidence", () => {
  const bank = [first];
  for (const choice of [0, -1, 1.5, 2, "1", null])
    assert.throws(() => evidence.resolveEvidenceSelection(bank, { evidence_index: choice }, "/proof"), ValidationError);
  assert.throws(() => evidence.resolveEvidenceSelection(bank, { evidence_index: 1, evidence_id: first }, "/proof"), ValidationError);
  assert.throws(() => evidence.selectEvidence(bank, { evidence_id: "ev_invented" }), ValidationError);
  assert.deepEqual(bank, [first]);
});
test("restoration accepts only an unchanged prefix; independent concurrent registration is synchronous", async () => {
  const bank = [first];
  await Promise.all([Promise.resolve().then(() => evidence.selectEvidence(bank, { evidence_id: second })),
    Promise.resolve().then(() => evidence.selectEvidence(bank, { evidence_id: second }))]);
  evidence.validateEvidenceBank(bank, [first]);
  assert.deepEqual(bank, [first, second]);
  for (const replacement of [[second, first], [second], [], [first, first]])
    assert.throws(() => evidence.validateEvidenceBank(replacement, [first]), ValidationError);
});
test("model projection changes generated refs and raw schema, preserving unrelated evidence_index fields", () => {
  const bank: string[] = [];
  const canonical = { proof: [{ evidence_id: first }], numeric_checks: [{ evidence_index: 0, actual: "6" }] };
  const selected = evidence.projectEvidenceReferences(canonical, bank);
  assert.deepEqual(selected, { proof: [{ evidence_index: 1 }], numeric_checks: [{ evidence_index: 0, actual: "6" }] });
  assert.deepEqual(evidence.resolveEvidenceSelections(selected, bank), canonical);
  const schema = { type: "object", required: ["evidence_id"], additionalProperties: false,
    properties: { evidence_id: { type: "string" }, observation: { type: "string" } } };
  assert.deepEqual(evidence.evidenceSelectionSchema(schema), { ...schema, required: ["evidence_index"],
    properties: { evidence_index: { type: "integer", minimum: 1 }, observation: { type: "string" } } });
  assert(schema.properties.evidence_id);
});
test("quote-limited profiles expose quote_chars instead of a selectable overlong coordinate", () => {
  const bank: string[] = [], long = evidenceId(source, 0, "text", "/content", 0, 401);
  assert.deepEqual(evidence.projectEvidenceReferences({ reference: { evidence_id: long } }, bank, 400), {
    reference: { quote_chars: 401, repair_action: "引用超过 400 字，未分配 evidence_index；按 read_request 读取该位置以获得合规片段。" },
  });
  assert.deepEqual(bank, []);
});
