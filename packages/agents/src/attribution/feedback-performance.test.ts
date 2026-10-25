import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type ToolAudit } from "@eval/contracts";
import { setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";
import { findingIssueContext } from "./finding-feedback.js";
import { attributionSubmissionSchema, attributionSubmissionShape } from "./submission-schema.js";
import { validateEvaluation } from "./validate.js";
import example from "./fixtures/example.json" with { type: "json" };

test("per-field feedback uses the same shape without rerendering sources or bypassing submission identity validation", () => {
  const request = structuredClone(example.request);
  setFixtureNormDirectory(request);
  const expected = attributionSubmissionSchema(request);
  const source = request.sources.answer.value;
  let sourceReads = 0;
  Object.defineProperty(request.sources.answer, "value", { configurable: true, get() { sourceReads++; return source; } });
  assert.deepEqual(attributionSubmissionShape(request), expected);
  for (let index = 0; index < 20; index++) {
    const context = findingIssueContext(request, {}, { category: "structure", code: "schema_required", path: "/summary", message: "缺少字段" });
    assert.deepEqual(context?.submission_shape, expected.properties.summary);
  }
  assert.equal(sourceReads, 0, "repairing field shape must not repeat whole-source identity validation");
  (request.input.answer.component_catalog[0] as { component: string }).component = "伪造主体";
  assert.throws(() => attributionSubmissionSchema(request), ValidationError);
  const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [] };
  assert.throws(() => validateEvaluation(request, example.result, audit), ValidationError);
  assert(sourceReads > 0, "the submission gate still validates identities against original source records");
});
