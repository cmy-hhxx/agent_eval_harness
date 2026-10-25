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
import { instructionEvidenceIssues } from "./instructions.js";
import { cite, evidenceSources } from "@eval/tools";

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

test("shared chain facts preserve each problem's fields and reject fields borrowed from another boundary", () => {
  const f=businessChainFixture(),registry=new AgentRegistry([attributionAgent]);
  const schema = attributionProfile.modelSubmissionSchema!(f.binding.request) as any;
  assert(schema.properties.investigation_facts.items.anyOf.some((choice: any) =>
    choice.properties.chain_index.const === f.chain.chain_index && choice.properties.step_index.enum.includes(4)));
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
  const questionFact=draft.investigation_facts.findIndex(fact=>fact.step_index===1);
  draft.investigation_facts[questionFact].field_names=["Closing Price[20261022]"];
  draft.problems[1].investigation_fact_indices=[questionFact+1];
  assert.throws(()=>registry.resolve(f.binding,draft,f.audit),error=>error instanceof ValidationError&&
    error.issues!.some(issue=>issue.code==="investigation_fact_fields"));
});

test("a rejected shared fact identifies its own invalid fields and evidence choices", () => {
  const f=businessChainFixture(),registry=new AgentRegistry([attributionAgent]);
  const draft=attributionSubmission(f.binding.request,f.result,f.audit);
  const index=draft.investigation_facts.findIndex(fact=>fact.step_index===1);
  draft.investigation_facts[index].field_names=["invented_field"];
  assert.throws(()=>registry.resolve(f.binding,draft,f.audit),error=>{
    assert(error instanceof ValidationError);
    const issue=error.issues!.find(issue=>issue.code==="investigation_fact_fields")!;
    const expected=issue.expected as any;
    assert.deepEqual(expected.invalid_fields,["invented_field"]);
    assert.deepEqual(expected.retained_fields,[]);
    assert.equal(expected.fact_index,index+1);
    assert.deepEqual(expected.evidence_indices,draft.investigation_facts[index].evidence_indices);
    assert(expected.evidence_boundaries.some((choice: any) => choice.chain_index === draft.investigation_facts[index].chain_index));
    return true;
  });
  draft.investigation_facts[index].field_names=[];
  const accepted=registry.resolve(f.binding,draft,f.audit) as AttributionResult;
  registry.validate(f.binding,accepted,f.audit);
});

test("user device facts do not acquire private-rule scope, while system rules retain it", () => {
  const request = structuredClone(example.request);
  const raw = { messages: [{ role: "system", content: "内部规则：必须先给风险提示。" },
    { role: "user", content: "盘口怎么调整为五档\n用户设备：pc" }, { role: "assistant", content: "在电脑版查看五档。" }] };
  Object.assign(request.sources.answer.value, raw);
  Object.assign(request.input.answer, { final_message_index: 2 });
  const result = structuredClone(example.result) as AttributionResult;
  const finding = result.findings[0];
  finding.dimension = "relevance";
  finding.assessment.requirement_index = 0;
  finding.assessment.evidence_status = "established";
  result.findings = [finding];
  result.criterion_assessments = [];
  for (const index of [1, 0]) {
    const source = evidenceSources(raw.messages[index]).find(item => item.path === "/content")!;
    finding.evidence = [cite(request.sources.answer.id, index, source, 0, source.text.length)];
    assert.equal(instructionEvidenceIssues(request, result).some(issue => issue.code === "instruction_private_basis"), index === 0);
  }
  const task = request.input.task_analysis as unknown as AttributionResult["task_analysis"];
  task.requirements.push({ ...task.requirements[0], id: "own-device-rule", acceptance_rule: raw.messages[1].content,
    applies_to: [String(request.input.candidate_id)] });
  const userSource = evidenceSources(raw.messages[1]).find(item => item.path === "/content")!;
  finding.evidence = [cite(request.sources.answer.id, 1, userSource, 0, userSource.text.length)];
  assert(instructionEvidenceIssues(request, result).some(issue => issue.code === "instruction_private_basis"),
    "an explicitly registered own rule still cannot borrow a common requirement");
});
