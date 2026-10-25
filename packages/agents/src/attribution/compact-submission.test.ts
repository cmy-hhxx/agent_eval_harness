import test from "node:test";
import assert from "node:assert/strict";
import { attributionProfile } from "./index.js";
import example from "./fixtures/example.json" with { type: "json" };
import { setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";
import { attributionSubmission } from "../../../../tests/fixtures/attribution-submission.js";
import { businessChainFixture } from "../../../../tests/fixtures/business-chain.js";
import { AgentRegistry } from "@eval/host";
import { attributionAgent, type AttributionResult } from "./index.js";
import { ValidationError } from "@eval/contracts";

test("attribution submits structured choices and shares investigation facts instead of repeating export structures", () => {
  const request = structuredClone(example.request);
  setFixtureNormDirectory(request);
  const schema = attributionProfile.modelSubmissionSchema!(request) as any;
  assert.equal(attributionProfile.fileSubmission, false);
  assert(!attributionProfile.toolNames.includes("edit_json"));
  assert(schema.properties.investigation_facts);
  assert(schema.properties.problems.items.properties.investigation_fact_indices);
  assert(!schema.properties.problems.items.properties.investigation);
  const cause = schema.properties.problems.items.properties.component.items;
  for (const field of ["actor_index", "function_index", "step_index", "failure_stage_index"])
    assert(cause.properties[field]);
  for (const field of ["component", "technical_domain", "functional_component", "chain_step", "failure_stage", "reason", "role"])
    assert(!cause.properties[field], field);
});

test("shared chain facts preserve each problem's fields and cannot be swapped across scopes", () => {
  const f=businessChainFixture(),registry=new AgentRegistry([attributionAgent]);
  const first=structuredClone(f.result.findings[0]),second=structuredClone(first);
  first.problem!.component[0].field_names=["etf code"];
  second.problem!.component[0].field_names=["Closing Price[20261022]"];
  second.text="价格字段的资产口径被错误使用。";second.problem!.label="价格字段错配";
  f.result.findings=[first,second];
  const draft=attributionSubmission(f.binding.request,f.result,f.audit);
  assert(draft.investigation_facts.length<draft.problems.reduce((n,p)=>n+p.investigation_fact_indices.length,0));
  const accepted=registry.resolve(f.binding,draft,f.audit) as AttributionResult;
  assert.deepEqual(accepted.findings.map(row=>row.problem!.component[0].field_names),[["etf code"],["Closing Price[20261022]"]]);
  assert(accepted.findings.every(row=>row.problem!.investigation[0].steps.length===8));
  draft.problems[1].investigation_fact_indices=[draft.investigation_facts.findIndex(fact=>fact.step_index===1)+1];
  assert.throws(()=>registry.resolve(f.binding,draft,f.audit),error=>error instanceof ValidationError&&
    error.issues!.some(issue=>issue.code==="investigation_fact_scope"));
});
