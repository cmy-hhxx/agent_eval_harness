import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, evidenceId, projectEvidenceReferences, ValidationError, type AgentBinding, type AgentProfile, type ValidationIssue } from "@eval/contracts";
import { AgentRegistry } from "./agents.js";
import {traceReadCoverage} from "@eval/tools";
import { emptyAudit } from "../../../tests/fixtures/comparison.js";

const binding: AgentBinding = { agent: "partial", profile: "default", request: { input: {}, sources: {} } };
function fixture() {
  let resolutions = 0;
  const profile: AgentProfile = {
    id: "default", requestSchema: { type: "object" },
    submissionSchema: { type: "object", additionalProperties: false, required: ["value", "satisfies", "proof"],
      properties: { value: { type: "number" }, satisfies: { type: "boolean" }, proof: { type: "string" } } },
    systemPrompt: "Evaluate.", instructions: "Submit JSON.", submissionNudge: "Submit JSON.",
    toolNames: [], fileSubmission: false, toolDescriptions: { submit_evaluation: "Submit JSON." },
    renderPrompt: () => "Evaluate.",
    validateSubmission(_request, draft) {
      if (!draft || typeof draft !== "object" || Array.isArray(draft) || (draft as { satisfies?: unknown }).satisfies !== false) return [];
      return [{ category: "decision", code: "requirement_unmet", path: "/satisfies", actual: false, message: "Requirement is unmet." }];
    },
    resolve(_request, draft) {
      resolutions++;
      if ((draft as { proof: string }).proof !== "source") throw new ValidationError([
        { category: "evidence", code: "proof_invalid", path: "/proof", actual: (draft as { proof: string }).proof, message: "Proof is invalid." },
      ]);
      return draft;
    },
  };
  return { registry: new AgentRegistry([{ id: "partial", profiles: { default: profile } }]), profile, resolutions: () => resolutions };
}

test("all model profiles accept harmless extra fields and explicit numeric/boolean strings without mutating drafts", () => {
  const { registry } = fixture();
  const draft = { value: "1", satisfies: "true", proof: "source", explanation: "extra formatting" };
  assert.deepEqual(registry.resolve(binding, draft, emptyAudit()), { value: 1, satisfies: true, proof: "source" });
  assert.equal(draft.value, "1");
  assert.equal(draft.explanation, "extra formatting");
  for (const value of [null, "", "not a number"])
    assert.throws(() => registry.resolve(binding, { value, satisfies: true, proof: "source" }, emptyAudit()), ValidationError);
  assert.throws(() => registry.resolve(binding, { value: "1", satisfies: "true", proof: "fabricated" }, emptyAudit()),
    (error: unknown) => error instanceof ValidationError && error.issues!.some(issue => issue.code === "proof_invalid"));
});

test("submission structure and safe independent decisions share the first feedback", () => {
  const { registry, resolutions } = fixture();
  assert.throws(() => registry.resolve(binding, { value: "wrong", satisfies: false, proof: "unknown" }, emptyAudit()),
    (error: unknown) => {
      assert(error instanceof ValidationError);
      assert.deepEqual(error.issues!.map((issue) => [issue.category, issue.code, issue.path]), [
        ["structure", "schema_type", "/value"], ["decision", "requirement_unmet", "/satisfies"],
      ]);
      return true;
    });
  assert.equal(resolutions(), 0, "unsafe resolution waits until structural fields are valid");
});

test("valid submission structure permits resolution while independent and evidence issues are aggregated", () => {
  const { registry, resolutions } = fixture();
  assert.throws(() => registry.resolve(binding, { value: 1, satisfies: false, proof: "unknown" }, emptyAudit()),
    (error: unknown) => {
      assert(error instanceof ValidationError);
      assert.deepEqual(error.issues!.map((issue) => issue.code), ["requirement_unmet", "proof_invalid"]);
      return true;
    });
  assert.equal(resolutions(), 1);
});

test("safe partial validation preserves primitive structure rejection and successful resolution", () => {
  const { registry, resolutions } = fixture();
  assert.throws(() => registry.resolve(binding, null, emptyAudit()),
    (error: unknown) => error instanceof ValidationError && error.issues!.every((issue) => issue.category === "structure"));
  const accepted = { value: 1, satisfies: true, proof: "source" };
  assert.deepEqual(registry.resolve(binding, accepted, emptyAudit()), accepted);
  registry.validate(binding, accepted, emptyAudit());
  assert.equal(resolutions(), 1);
});

test("combined validation reports an identical issue once while retaining distinct repair details", () => {
  const { registry, profile } = fixture();
  const issue: ValidationIssue = { category: "decision", code: "criterion_missing", path: "/criteria",
    message: "Add the applicable criterion.", expected: { criterion_id: "r1", target_path: "/criteria/-" } };
  const otherCriterion = { ...issue, expected: { criterion_id: "r2", target_path: "/criteria/-" } };
  const otherPath = { ...issue, path: "/other" };
  profile.validateSubmission = () => [issue, issue];
  profile.resolve = () => { throw new ValidationError([
    { ...issue, expected: { target_path: "/criteria/-", criterion_id: "r1" } }, otherCriterion, otherPath,
  ]); };
  assert.throws(() => registry.resolve(binding, { value: 1, satisfies: true, proof: "source" }, emptyAudit()),
    (error: unknown) => {
      assert(error instanceof ValidationError);
      assert.deepEqual(error.issues, [issue, otherCriterion, otherPath]);
      return true;
    });
});

test("model submission schema follows the trusted request without changing Host validation", () => {
  const { registry, profile } = fixture();
  const original = structuredClone(profile.submissionSchema);
  profile.modelSubmissionSchema = (request) => {
    const schema = structuredClone(profile.submissionSchema) as {
      properties: Record<string, unknown>; required: string[];
    };
    if (request.input.omit_proof === true) {
      delete schema.properties.proof;
      schema.required = schema.required.filter((key) => key !== "proof");
    }
    return schema;
  };
  const projected = { ...binding, request: { input: { omit_proof: true }, sources: {} }, modelInput: { omit_proof: false } };
  const prepared = registry.prepare(projected);
  assert.equal(Object.hasOwn(prepared.evaluation.outputSchema.properties as object, "proof"), false);
  assert.deepEqual(prepared.evaluation.outputSchema.required, ["value", "satisfies"]);
  assert.deepEqual(profile.submissionSchema, original, "the registered Host schema remains unchanged");
  assert.throws(() => registry.resolve(projected, { value: 1, satisfies: true }, emptyAudit()),
    (error: unknown) => error instanceof ValidationError && error.issues!.some((issue) => issue.path === "/proof"));
  assert.deepEqual(registry.prepare(binding).evaluation.outputSchema, original);
});


test("profile feedback context annotates every rejection without changing checks, constraints or submitted values", () => {
  const { registry, profile } = fixture();
  const contexts: { value: unknown; path: string }[] = [];
  profile.validationIssueContext = (_request, value, issue) => {
    contexts.push({ value, path: issue.path });
    return { target: { path: issue.path, item_id: "stable" } };
  };
  const invalid = { value: "wrong", satisfies: false, proof: "unknown" }, before = structuredClone(invalid);
  assert.throws(() => registry.resolve(binding, invalid, emptyAudit()), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues!.map(issue => [issue.category, issue.code, issue.path]), [
      ["structure", "schema_type", "/value"], ["decision", "requirement_unmet", "/satisfies"],
    ]);
    assert.deepEqual(error.issues![0]!.expected, { type: "number", target: { path: "/value", item_id: "stable" } });
    assert.deepEqual(error.issues![1]!.expected, { target: { path: "/satisfies", item_id: "stable" } });
    return true;
  });
  assert(contexts.every(context => context.value === invalid));
  assert.deepEqual(invalid, before);
  contexts.length = 0;
  assert.throws(() => registry.resolve(binding, { value: 1, satisfies: false, proof: "unknown" }, emptyAudit()), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues!.map(issue => issue.code), ["requirement_unmet", "proof_invalid"]);
    assert.equal(contexts.length, 2, "independent and resolver errors receive the same feedback context");
    return true;
  });
  profile.validate = () => { throw new ValidationError([{ category: "decision", code: "formal_problem",
    path: "/value", message: "Known result problem.", actual: 1, expected: [1, 2] }]); };
  assert.throws(() => registry.validate(binding, { value: 1, satisfies: true, proof: "source" }, emptyAudit()), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues![0]!.expected, { value: [1, 2], target: { path: "/value", item_id: "stable" } });
    assert.equal(error.issues![0]!.actual, 1);
    return true;
  });
});


test("feedback annotation preserves formal error multiplicity and leaves profiles without a hook unchanged", () => {
  const { registry, profile } = fixture();
  const issue: ValidationIssue = { category: "decision", code: "repeated_detail", path: "/value",
    actual: 1, expected: { constraint: "original" }, message: "Original detail." };
  const original = new ValidationError([issue, issue]);
  profile.validate = () => { throw original; };
  const result = { value: 1, satisfies: true, proof: "source" };
  assert.throws(() => registry.validate(binding, result, emptyAudit()), error => error === original);
  profile.validationIssueContext = () => ({ constraint: "replacement forbidden", target: { item_id: "stable" } });
  assert.throws(() => registry.validate(binding, result, emptyAudit()), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.equal(error.issues!.length, 2);
    assert(error.issues!.every(item => item.code === issue.code && item.path === issue.path && item.actual === issue.actual));
    assert(error.issues!.every(item => (item.expected as { constraint: string }).constraint === "original"));
    assert.deepEqual(issue.expected, { constraint: "original" });
    return true;
  });
});

test("recovery rendering enriches saved errors with current profile guidance without changing durable drafts or constraints", () => {
  const { registry, profile } = fixture();
  const sourceId = "71e88588-5740-4e67-a710-7cc9b7b98717";
  const known = evidenceId(sourceId, 0, "text", "/content", 0, 7);
  const bound: AgentBinding = { ...binding, request: { input: {}, sources: {
    answer: { id: sourceId, value: { messages: [{ role: "system", content: "真实材料与规范。" }] } },
  } }, projectModelInput: projectEvidenceReferences };
  profile.evidenceSelections = true;
  const draft = { value: "wrong", satisfies: false, proof: "unknown" };
  const errors: ValidationIssue[] = [
    { category: "structure", code: "schema_type", path: "/value", actual: "wrong", expected: { type: "number" }, message: "Use a number." },
    { category: "decision", code: "requirement_unmet", path: "/satisfies", actual: false, expected: [true], message: "Meet the requirement." },
  ];
  const shape = { value: 1, satisfies: true, proof: "source" };
  const contexts: ValidationIssue[] = [];
  profile.validationIssueContext = (request, value, issue) => {
    assert.equal(request, bound.request);
    assert.equal(value, draft, "current guidance uses the saved rejected draft");
    contexts.push(issue);
    return { submission_shape: shape, type: "must not replace number", value: "must not replace choices",
      suggested_evidence: [{ quote: "真实材料与规范", reference: { evidence_id: known } }] };
  };
  profile.renderPrompt = (_input, _policy, recovery) => JSON.stringify(recovery);
  const recovery = { draft, errors, evidenceBank: [known], contentSubmissions: 3, fileErrors: 0,
    repeatedErrors: 1, stopped: false, attemptId: "saved-attempt" };
  const before = structuredClone({ recovery, request: bound.request, shape });
  const shown = JSON.parse(registry.prepare(bound).renderAttempt(DEFAULT_POLICY, recovery));
  assert.deepEqual(contexts, errors, "historical errors receive current guidance on resume");
  assert(shown.errors.every((issue: ValidationIssue) => {
    const expected = issue.expected as { submission_shape: unknown; suggested_evidence: { reference: unknown }[] };
    assert.deepEqual(expected.submission_shape, shape);
    assert.deepEqual(expected.suggested_evidence[0].reference, { evidence_index: 1 }, "new guidance uses durable model-facing evidence choices");
    return true;
  }));
  assert.equal(shown.errors[0].expected.type, "number");
  assert.deepEqual(shown.errors[1].expected.value, [true]);
  assert.deepEqual(shown.errors.map((issue: ValidationIssue) => [issue.category, issue.code, issue.path, issue.actual, issue.message]),
    errors.map(issue => [issue.category, issue.code, issue.path, issue.actual, issue.message]));
  assert.deepEqual(shown.draft, draft);
  assert.equal(shown.contentSubmissions, 3);
  assert.deepEqual({ recovery, request: bound.request, shape }, before, "rendering must not rewrite the saved failure or the request");
});


test("rejection and recovery mask source identity in suggested quotes without changing durable choices or raw locations", () => {
  const { registry, profile } = fixture();
  const sourceId = "71e88588-5740-4e67-a710-7cc9b7b98717";
  const text = "Model-A 的原始规则。";
  const known = evidenceId(sourceId, 0, "text", "/content", 0, 7);
  const unread = evidenceId(sourceId, 0, "text", "/content", 0, text.length);
  const presentation = { redactions: [{ text: "Model-A", replacement: "匿名候选甲" }], omitMessageKeys: [] };
  const originalIssue: ValidationIssue = { category: "evidence", code: "proof_invalid", path: "/Model-A/proof",
    message: "Read Model-A actual rule.", expected: { suggested_evidence: [
      { quote: "Model-A", reference: { evidence_id: known } },
      { quote: text, reference: { evidence_id: unread } },
    ], read_request: { candidate: "A", message_index: 0, path: "/Model-A/content", offset: 0, max_chars: text.length } } };
  const bound: AgentBinding = { ...binding, request: { input: {}, sources: {
    A: { id: sourceId, value: { messages: [{ role: "system", content: text }] }, presentation },
    B: { id: "662c6864-14fd-41e1-a29a-d0ff3a255c18", value: { messages: [] }, presentation: structuredClone(presentation) },
  } }, projectModelInput: projectEvidenceReferences };
  profile.evidenceSelections = true;
  profile.resolve = () => { throw new ValidationError([originalIssue]); };
  profile.renderPrompt = (input, _policy, recovery) => JSON.stringify({ input, recovery });
  const draft = { value: 1, satisfies: true, proof: "source" }, audit = { ...emptyAudit(), evidenceBank: [known] };
  const before = structuredClone({ request: bound.request, draft, audit, originalIssue });
  let feedback: ValidationIssue[] = [];
  assert.throws(() => registry.resolve(bound, draft, audit), (error: unknown) => {
    assert(error instanceof ValidationError); feedback = error.issues!; return true;
  });
  const shown = feedback[0].expected as { suggested_evidence: { quote: string; reference?: { evidence_index: number }; read_request?: unknown }[];
    read_request: { path: string; max_chars: number } };
  assert.equal(shown.suggested_evidence[0].quote, "匿名候选甲");
  assert.notEqual(shown.suggested_evidence[0].quote.length, "Model-A".length);
  assert.deepEqual(shown.suggested_evidence[0].reference, { evidence_index: 1 });
  assert.equal(feedback[0].path, "/Model-A/proof");
  assert.equal(shown.read_request.path, "/Model-A/content"); assert.equal(shown.read_request.max_chars, text.length);
  assert.deepEqual(shown.suggested_evidence[1].read_request, { tool: "read_trace", arguments: {
    candidate: "A", message_index: 0, path: "/content", offset: 0, max_chars: text.length,
  } });
  const recovery = { draft, errors: [originalIssue], evidenceBank: [known], contentSubmissions: 1, fileErrors: 0,
    repeatedErrors: 0, stopped: false, attemptId: "real-attempt" };
  const originalRecovery = structuredClone(recovery);
  const rendered = JSON.parse(registry.prepare(bound).renderAttempt(DEFAULT_POLICY, recovery));
  assert.deepEqual(rendered.recovery.errors, feedback);
  assert.deepEqual(rendered.recovery.draft, draft);
  assert.deepEqual(recovery, originalRecovery);
  assert.deepEqual({ request: bound.request, draft, audit, originalIssue }, before);
});

test('initial displayed source and actual read suffix share the validation coverage without changing the audit',()=>{
 const f=fixture(),target={candidate:'answer',message_index:1,kind:'text' as const,path:'/content',start:0,end:10};
 f.profile.validateSubmission=(_request,_draft,audit)=>traceReadCoverage(audit,target).covered?[]:[{category:'evidence',code:'unread',path:'/proof',message:'Source not fully shown'}];
 const draft={value:1,satisfies:true,proof:'source'},audit=emptyAudit();audit.traceReads=[{...target,start:5}];
 const shown={...binding,presentedReads:[{...target,end:5}]};
 f.registry.resolve(shown,draft,audit);
 assert.equal(audit.traceReads.length,1);assert.equal(audit.traceReads[0].start,5);
 assert.throws(()=>f.registry.resolve(binding,draft,audit),error=>error instanceof ValidationError&&error.issues!.some(issue=>issue.code==='unread'));
});

test("program material navigation crosses preparation without entering prompts or source registration",()=>{
  const {registry,profile}=fixture();
  profile.renderPrompt=input=>JSON.stringify(input);
  const source={id:"11111111-1111-4111-8111-111111111111",value:{messages:[{role:"user",content:"original source"}]}};
  const original={...binding,request:{input:{visible:"shown"},sources:{answer:source}}};
  const navigation={nodes:[{node_index:7,detail:"program-only-navigation"}],source:"answer"};
  const wired={...original,materialNavigation:navigation},before=structuredClone(wired);
  const baseline=registry.prepare(original),prepared=registry.prepare(wired);
  assert.deepEqual(prepared.evaluation.materialNavigation,navigation);
  assert.equal(prepared.evaluation.materialNavigation,navigation, "immutable navigation is shared across prepared tasks");
  assert.equal(prepared.prompt,baseline.prompt);
  assert.equal(prepared.renderAttempt(DEFAULT_POLICY),baseline.renderAttempt(DEFAULT_POLICY));
  assert(!prepared.prompt.includes("program-only-navigation"));
  assert.deepEqual(prepared.evidenceBank,baseline.evidenceBank);
  assert.deepEqual(wired,before);
  assert(!Object.hasOwn(baseline.evaluation,"materialNavigation"));
});

test("workflow-computed results need no owned material projection while live evidence selections still do", () => {
  const { registry, profile } = fixture();
  profile.evidenceSelections = true;
  assert.throws(() => registry.prepare(binding),
    /Evidence selections require an owned material projection: partial\/default/);
  const computed = registry.prepare({ ...binding, computedResult: { value: [] } });
  assert.deepEqual(computed.evaluation.outputSchema, profile.submissionSchema, "computed results keep the profile submission shape");
  assert.equal(registry.prepare({ ...binding, projectModelInput: input => input }).evaluation.id, "partial");
});
