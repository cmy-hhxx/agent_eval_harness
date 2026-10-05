import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type AgentRequest, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";
import { findingIssueContext } from "./finding-feedback.js";
import { attributionAgent } from "./index.js";
import type { AttributionResult } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };
import { attributionSubmission, setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";
import { prepareFixtureEvidence, resolveFixtureEvidence } from "../../../../tests/fixtures/evidence.js";

const request: AgentRequest = { input: {}, sources: {} };
const issue = (path: string): ValidationIssue => ({ category: "evidence", code: "evidence_id_invalid",
  path, message: "Use the real source reference.", expected: { normative_sources: ["original"] } });

test("finding feedback retains the exact error path and identifies both public evidence path forms", () => {
  const draft = { findings: Array.from({ length: 6 }, (_, index) => ({ finding_id: `id-${index}`, text: `text-${index}` })) };
  const before = structuredClone(draft);
  for (const path of ["/findings/5/evidence/0", "findings[5].evidence[0]"])
    assert.deepEqual(findingIssueContext(request, draft, issue(path)), { target: { finding_index: 5, index_base: 0,
      path, finding_id: "id-5", text: "text-5" } });
  assert.deepEqual(draft, before);
});

test("finding feedback does not guess missing IDs or classify unrelated, malformed or nonexistent paths", () => {
  const draft = { findings: [null, { finding_id: 8, text: { value: "bad" } }, {}] };
  assert.deepEqual(findingIssueContext(request, draft, issue("/findings/1/text")),
    { target: { finding_index: 1, index_base: 0, path: "/findings/1/text" } });
  assert.deepEqual(findingIssueContext(request, draft, issue("/findings/0")),
    { target: { finding_index: 0, index_base: 0, path: "/findings/0" } });
  for (const path of ["/findings", "/findings/3/evidence", "/findings/01/text", "/findings/-1/text",
    "/findings/9007199254740992/text", "/criterion_assessments/1/evidence", "other.findings[1].evidence"])
    assert.equal(findingIssueContext(request, draft, issue(path)), undefined);
  assert.equal(findingIssueContext(request, null, issue("/findings/0")), undefined);
  assert.equal(findingIssueContext(request, { findings: {} }, issue("/findings/0")), undefined);
});

test("finding feedback bounds only the display text and preserves Unicode and the original stable ID", () => {
  const long = "📌".repeat(161), draft = { findings: [{ finding_id: "id/with~raw punctuation", text: long }] };
  assert.deepEqual(findingIssueContext(request, draft, issue("/findings/0/reason")), { target: {
    finding_index: 0, index_base: 0, path: "/findings/0/reason", finding_id: "id/with~raw punctuation",
    text: "📌".repeat(160) + "…",
  } });
  assert.equal(draft.findings[0]!.text, long);
});

const replayCase = () => {
  const request = structuredClone(example.request) as AgentRequest;
  request.input.ground_truth = { available: false, value: null };
  setFixtureNormDirectory(request);
  const draft = attributionSubmission(request, structuredClone(example.result) as AttributionResult);
  const registry = new AgentRegistry([attributionAgent]);
  const binding = { agent: "attribution", profile: "default", request };
  const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
  const errors = (draft: unknown) => {
    try { resolveFixtureEvidence(registry, binding, draft, audit); assert.fail("the captured malformed submission must be rejected"); }
    catch (error) { assert(error instanceof ValidationError); return error.issues!; }
  };
  return { request, draft, registry, binding, audit, errors };
};

test("Attribution exposes only path submission while retaining the request-derived JSON content contract", () => {
  const { registry, binding } = replayCase();
  const model = prepareFixtureEvidence(registry, binding);
  assert.equal(model.evaluation.fileSubmission, true);
  assert(Object.hasOwn(model.evaluation.toolDescriptions, "submit_evaluation_file"));
  assert(!Object.hasOwn(model.evaluation.toolDescriptions, "submit_evaluation"));
  assert(model.evaluation.toolNames.includes("execute_code"), "file authoring remains available to the model");
  const shape = model.evaluation.outputSchema as any;
  assert.equal(shape.properties.findings.items.properties.assessment.type, "object");
  assert.equal(shape.properties.findings.items.properties.evidence.items.properties.evidence_index.type, "integer");
  assert(!Object.hasOwn(shape.properties, "is_correct"));
  assert.match(model.prompt, /json\.dump/);
  assert.match(model.prompt, /submit_evaluation_file/);
});

test("captured misplaced norm and missing problem receive typed placement feedback in the real registry", () => {
  const { draft, errors } = replayCase();
  const finding = draft.findings[0]!;
  Object.assign(finding, { dimension: "instruction_following", type: "problem" });
  Object.assign(finding.assessment, { norm_index: 0 });
  delete finding.assessment.requirement_index;
  const before = structuredClone(draft);
  const issues = errors(draft);
  const misplaced = issues.find(item => item.code === "schema_additionalProperties" && item.path === "/findings/0/assessment/norm_index")!;
  const shape = (misplaced.expected as any).submission_shape;
  assert.deepEqual(shape.root_fields.findings, { type: "array", items: { type: "object" } });
  assert.equal(shape.field.path, "/findings/0/assessment");
  assert.equal(shape.field.schema.type, "object");
  assert(!Object.hasOwn(shape.field.schema.properties, "norm_index"));
  assert.deepEqual(shape.field_locations, ["/findings/0/norm_index"]);
  const missing = issues.find(item => item.code === "schema_required" && item.path === "/findings/0/problem")!;
  const problem = (missing.expected as any).submission_shape.field;
  assert.equal(problem.path, "/findings/0/problem");
  assert.deepEqual(problem.schema.required, ["model_responsible", "tool_evidence_indices", "label", "definition"]);
  assert.equal(problem.schema.properties.model_responsible.type, "boolean");
  assert.equal(problem.schema.properties.tool_evidence_indices.type, "array");
  assert(issues.some(item => item.code === "problem_required"), "typed feedback must retain independent business errors");
  assert.deepEqual(draft, before, "feedback never edits the submitted draft");
});

test("captured flattened root finding receives its real array and nested object shapes", () => {
  const { draft, errors, registry, binding, audit } = replayCase();
  const flat = { ...draft, findings: undefined, dimension: "format", assessment: "", norm_index: "8", problem: "", label: "边界" };
  delete flat.findings;
  const before = structuredClone(flat);
  const issues = errors(flat);
  const missing = issues.find(item => item.code === "schema_required" && item.path === "/findings")!;
  const shape = (missing.expected as any).submission_shape;
  assert.equal(shape.field.path, "/findings");
  assert.equal(shape.field.schema.type, "array");
  assert.equal(shape.field.schema.items.type, "object");
  assert.equal(shape.field.schema.items.properties.assessment.type, "object");
  assert.equal(shape.field.schema.items.properties.evidence.type, "array");
  assert.equal(shape.field.schema.items.properties.evidence.items.properties.evidence_index.type, "integer");
  assert(!Object.hasOwn(shape.root_fields, "is_correct"), "the request-derived shape must omit standard-answer fields when unavailable");
  const misplaced = issues.find(item => item.code === "schema_additionalProperties" && item.path === "/assessment")!;
  assert.deepEqual((misplaced.expected as any).submission_shape.field_locations, ["/findings/*/assessment"]);
  assert.deepEqual(flat, before);
  const result = resolveFixtureEvidence(registry, binding, draft, audit);
  registry.validate(binding, result, audit);
});

test("conditional prohibitions report false rather than the base field enum in real registry feedback", () => {
  const { draft, errors } = replayCase();
  draft.findings[0]!.dimension = "format";
  draft.findings[0]!.norm_index = 0;
  const before = structuredClone(draft);
  const forbidden = errors(draft).find(item => item.code === "schema_false schema" && item.path === "/findings/0/norm_index")!;
  assert(forbidden, "a non-instruction norm selector must remain rejected");
  const shape = (forbidden.expected as any).submission_shape;
  assert.deepEqual(shape.field, { path: "/findings/0/norm_index", schema: false });
  assert.equal(shape.container.path, "/findings/0");
  assert(shape.container.schema.allOf.some((branch: any) => branch.if?.properties?.dimension?.const === "instruction_following" &&
    branch.else?.properties?.norm_index === false), "the current conditional prohibition remains visible");
  assert.deepEqual(draft, before, "feedback neither changes the dimension nor drops the forbidden selector");

  const strengthWithProblem = structuredClone(draft);
  delete strengthWithProblem.findings[0]!.norm_index;
  strengthWithProblem.findings[0]!.problem = { model_responsible: true, tool_evidence_indices: [], label: "问题", definition: "真实观察。" };
  const problemIssue = errors(strengthWithProblem).find(item => item.code === "schema_false schema" && item.path === "/findings/0/problem")!;
  assert.equal((problemIssue.expected as any).submission_shape.field.schema, false,
    "a strength cannot be guided to submit the base problem object shape");
});
