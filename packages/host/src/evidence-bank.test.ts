import test from "node:test";
import assert from "node:assert/strict";
import { evidenceId, evidenceSelectionSchema, projectEvidenceReferences, resolveEvidenceSelections,
  ValidationError, type AgentBinding, type AgentProfile } from "@eval/contracts";
import { AgentRegistry } from "./agents.js";
const id = "11111111-1111-4111-8111-111111111111", first = evidenceId(id, 0, "text", "/content", 0, 4),
  second = evidenceId(id, 1, "text", "/content", 0, 4);
const refSchema = { type: "object", additionalProperties: false, required: ["evidence_id"],
  properties: { evidence_id: { type: "string" }, observation: { type: "string" } } };
const schema = { type: "object", required: ["proof"], additionalProperties: false, properties: { proof: refSchema } };
function fixture() {
  const profile: AgentProfile = { id: "default", evidenceSelections: true, requestSchema: { type: "object" }, submissionSchema: schema,
    inspection: { schema, modelSchema: evidenceSelectionSchema(schema),
      resolve: (_request, value, audit) => resolveEvidenceSelections(value, audit.evidenceBank ?? []), validate() {} },
    systemPrompt: "Evaluate.", instructions: "Submit JSON.", submissionNudge: "Submit.", toolNames: ["inspect_material"], fileSubmission: false,
    toolDescriptions: { inspect_material: "Inspect.", submit_evaluation: "Submit." }, renderPrompt: value => JSON.stringify(value) };
  const binding: AgentBinding = { agent: "fixture", profile: "default", request: { input: {}, sources: { answer: { id, value: { messages: [{ content: "回答一。" }, { content: "依据二。" }] } } } },
    modelInput: { proof: { reference: { evidence_id: first } } }, inspectionInput: { proof: { reference: { evidence_id: second } }, hidden: "only after inspection" },
    projectModelInput: (value, bank) => projectEvidenceReferences(value, bank) };
  const registry = () => new AgentRegistry([{ id: "fixture", profiles: { default: profile } }]);
  return { binding, profile, registry };
}
test("raw choices resolve before canonical inspection and restoration never applies a new raw model schema", () => {
  const { binding, profile, registry } = fixture(), agents = registry(), prepared = agents.prepare(binding);
  assert(!prepared.prompt.includes(first));
  assert(prepared.prompt.includes('"evidence_index":1'));
  assert.deepEqual(prepared.evidenceBank, [first]);
  const audit = { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [], evidenceBank: [...prepared.evidenceBank] };
  const value = agents.resolveInspection(binding, { proof: { evidence_index: 1 } }, audit);
  assert.deepEqual(value, { proof: { evidence_id: first } });
  const canonicalMaterial = agents.inspectCanonical(binding, value, audit);
  const revealed = agents.projectMaterial(binding, canonicalMaterial, audit.evidenceBank);
  assert.deepEqual(audit.evidenceBank, [first, second]);
  assert.equal(JSON.stringify(revealed).includes(first), false);
  profile.inspection!.modelSchema = { ...evidenceSelectionSchema(schema), required: ["proof", "new_raw_field"] };
  const recovered = registry().prepare(binding);
  const prompt = recovered.renderAttempt({ timeoutSeconds: 1, idleTimeoutSeconds: 1, maxToolCalls: 1, repairAttempts: 3, codeTimeoutSeconds: 1, maxOutputChars: 1000 },
    { evidenceBank: [...audit.evidenceBank], inspection: { id: "saved", value, proof: { traceReads: [], viewedImages: [] } },
      errors: [], contentSubmissions: 1, fileErrors: 0, repeatedErrors: 0, stopped: false, attemptId: "prior" });
  assert(prompt.includes("only after inspection")); assert(!prompt.includes(first));
  assert.deepEqual(recovered.evidenceBank, [first, second]);
});

test("validated inspection reveals profile-owned material context and restores it without changing the checkpoint", () => {
  const { binding, profile, registry } = fixture(), context = { allowed_choices: [0, 1] };
  profile.inspection!.materialContext = () => context;
  const agents = registry(), prepared = agents.prepare(binding);
  assert(!prepared.prompt.includes("inspection_context"));
  const audit = { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [],
    evidenceBank: [...prepared.evidenceBank] };
  const canonical = agents.resolveInspection(binding, { proof: { evidence_index: 1 } }, audit);
  const revealed = agents.projectMaterial(binding, agents.inspectCanonical(binding, canonical, audit), audit.evidenceBank);
  assert.deepEqual(revealed.inspection_context, { allowed_choices: [0, 1] });
  (revealed.inspection_context as { allowed_choices: number[] }).allowed_choices.push(2);
  assert.deepEqual(context, { allowed_choices: [0, 1] });
  const recovery = { evidenceBank: [...audit.evidenceBank], inspection: { id: "saved", value: canonical,
    proof: { traceReads: [], viewedImages: [] } }, errors: [], contentSubmissions: 1, fileErrors: 0,
    repeatedErrors: 0, stopped: false, attemptId: "prior" }, before = structuredClone(recovery);
  const prompt = prepared.renderAttempt({ timeoutSeconds: 1, idleTimeoutSeconds: 1, maxToolCalls: 1, repairAttempts: 2,
    codeTimeoutSeconds: 1, maxOutputChars: 1000 }, recovery);
  assert.deepEqual(JSON.parse(prompt).inspection_context, { allowed_choices: [0, 1] });
  assert.deepEqual(recovery, before);
  assert.deepEqual(prepared.evidenceBank, [first, second]);
  assert.throws(() => agents.inspectCanonical(binding, { proof: {} }, audit), ValidationError);
});
test("model coordinates are rejected; unavailable numeric choices preserve their exact path and never substitute proof", () => {
  const { binding, profile, registry } = fixture(); delete profile.inspection;
  const agents = registry(), audit = { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [], evidenceBank: [first] };
  assert.deepEqual(agents.resolve(binding, { proof: { evidence_index: 1 } }, audit), { proof: { evidence_id: first } });
  assert.throws(() => agents.resolve(binding, { proof: { evidence_id: first } }, audit), ValidationError);
  assert.throws(() => agents.resolve(binding, { proof: { evidence_index: 2 } }, audit), error => {
    assert(error instanceof ValidationError); assert.equal(error.issues![0]!.path, "/proof");
    assert.equal(error.issues![0]!.code, "evidence_selection_invalid"); return true;
  });
  assert.deepEqual(audit.evidenceBank, [first]);
});

test("malformed model fields still report independent coverage and evidence errors in the same feedback", () => {
  const { binding, profile, registry } = fixture(); delete profile.inspection;
  profile.submissionSchema = { ...schema, required: ["proof", "summary"], properties: { ...schema.properties, summary: { type: "string" } } };
  profile.validateSubmission = (_request, value) => {
    const proof = (value as { proof?: { evidence_id?: string } }).proof;
    return [{ category: "decision", code: "criterion_missing", path: "/criterion_assessments", message: "Complete the known criterion." },
      ...(proof?.evidence_id === second ? [{ category: "evidence" as const, code: "evidence_final_required", path: "/proof", actual: proof,
        message: "Source evidence cannot replace the answer." }] : [])];
  };
  const audit = { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [], evidenceBank: [first, second] };
  assert.throws(() => registry().resolve(binding, { summary: null, proof: { evidence_index: 2 } }, audit), error => {
    assert(error instanceof ValidationError);
    assert.deepEqual(new Set(error.issues!.map(issue => issue.category)), new Set(["structure", "decision", "evidence"]));
    assert.equal(error.issues!.filter(issue => issue.code === "criterion_missing").length, 1);
    assert.equal(error.issues!.some(issue => issue.path.includes("evidence_id")), false);
    assert.equal(JSON.stringify(error.issues).includes(second), false);
    return true;
  });
});

test("feedback reoffers existing choices and sends new source suggestions to a real read without allocating an unpersisted number", () => {
  const { binding, profile, registry } = fixture();
  const issues = [{ category: "evidence" as const, code: "source_missing", path: "/proof", message: "Read the actual source.",
    expected: { suggested_evidence: [{ quote: "回答一。", reference: { evidence_id: first } }, { quote: "依据二。", reference: { evidence_id: second } }] } }];
  const audit = { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [], evidenceBank: [first] };
  const assertFeedback = (operation: () => unknown) => assert.throws(operation, error => {
    assert(error instanceof ValidationError); assert.deepEqual(audit.evidenceBank, [first]);
    const shown = error.issues![0]!.expected as { suggested_evidence: Record<string, unknown>[] };
    assert.deepEqual(shown.suggested_evidence[0]!.reference, { evidence_index: 1 });
    assert.equal(Object.hasOwn(shown.suggested_evidence[1]!, "reference"), false);
    assert.deepEqual(shown.suggested_evidence[1]!.read_request, { tool: "read_trace", arguments: {
      candidate: "answer", message_index: 1, path: "/content", offset: 0, max_chars: 4 } });
    assert.equal(JSON.stringify(error.issues).includes(second), false); return true;
  });
  profile.inspection!.validate = () => { throw new ValidationError(issues); };
  assertFeedback(() => registry().resolveInspection(binding, { proof: { evidence_index: 1 } }, audit));
  delete profile.inspection;
  profile.validateSubmission = () => issues;
  assertFeedback(() => registry().resolve(binding, { proof: { evidence_index: 1 } }, audit));
  profile.validateSubmission = undefined;
  profile.validate = () => { throw new ValidationError(issues); };
  assertFeedback(() => registry().validate(binding, { proof: { evidence_id: first } }, audit));
  profile.renderPrompt = (_input, _policy, recovery) => JSON.stringify({ errors: recovery?.errors });
  const prepared = registry().prepare(binding), policy = { timeoutSeconds: 1, idleTimeoutSeconds: 1, maxToolCalls: 1,
    repairAttempts: 3, codeTimeoutSeconds: 1, maxOutputChars: 1000 };
  const prompt = prepared.renderAttempt(policy, { evidenceBank: [first], errors: issues, contentSubmissions: 1, fileErrors: 0,
    repeatedErrors: 0, stopped: false, attemptId: "prior" });
  assert.deepEqual(prepared.evidenceBank, [first]); assert(prompt.includes('"read_request"')); assert(!prompt.includes(second));
});
