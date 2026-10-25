import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "@eval/contracts";
import { setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";
import { findingIssueContext } from "./finding-feedback.js";
import { attributionSubmissionSchema, attributionSubmissionShape } from "./submission-schema.js";
import example from "./fixtures/example.json" with { type: "json" };
import { Ajv2020 } from 'ajv/dist/2020.js';

test('scalar or interval calculation results accept native numbers and reject quoted values',()=>{
  const request=structuredClone(example.request);setFixtureNormDirectory(request);
  const field=attributionSubmissionShape(request).properties.Problem.items.properties.calculations.items.properties.result;
  const validate=new Ajv2020({strict:false,allErrors:true}).compile(field);
  assert(validate(1.35));
  assert(validate({lower:1.3,upper:1.4,include_lower:true,include_upper:false}));
  for(const invalid of ['','1.35',{lower:1.3}, {lower:'1.3',upper:1.4,include_lower:true,include_upper:false}])assert(!validate(invalid));
  assert(!validate("1.35"));assert.equal(validate.errors!.length,1);
});

test("decimal type repair shows the exact quoted value without changing the draft", () => {
  const request = structuredClone(example.request);
  setFixtureNormDirectory(request);
  const draft = { Problem: [{ calculations: [{ factor: 1.35, result: 2.7 }] }] };
  const feedback = findingIssueContext(request, draft, { category: 'structure', code: 'schema_type',
    path: '/Problem/0/calculations/0/factor', actual: 1.35, message: 'must be string' });
  assert.match(String(feedback?.repair_action), /"1\.35"/);
  assert.equal(draft.Problem[0].calculations[0].factor, 1.35);
  assert.equal(draft.Problem[0].calculations[0].result, 2.7);
});

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
  assert(sourceReads > 0, "material preparation validates identities against original source records");
});
