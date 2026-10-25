import test from "node:test";
import assert from "node:assert/strict";
import { attributionProfile } from "./index.js";
import example from "./fixtures/example.json" with { type: "json" };
import { attributionSubmission } from "../../../../tests/fixtures/attribution-submission.js";
import { businessChainFixture } from "../../../../tests/fixtures/business-chain.js";
import { AgentRegistry } from "@eval/host";
import { attributionAgent, type AttributionResult } from "./index.js";
import { ValidationError } from "@eval/contracts";
import { instructionEvidenceIssues } from "./instructions.js";
import { cite, evidenceSources } from "@eval/tools";

test("actual attribution materials select standard, numeric, table and visual rules independently",()=>{
  const f=businessChainFixture(),input=structuredClone(f.binding.request.input);
  const answer=input.answer as Record<string,any>;
  answer.table_check_results=[];
  delete answer.final_images;delete answer.capture_gaps;
  const render=()=>attributionProfile.renderPrompt(input);
  const initial=render();
  for(const heading of ['本次有标准答案','本次有标准数值点','本次有表格待核行','本次有可查看图片','本次有视觉采集占位'])assert(!initial.includes(heading));
  assert(attributionProfile.systemPrompt.includes('照常核查事实与交付'));
  input.ground_truth={available:true,value:'同一实体的名称'};
  assert(render().includes('本次有标准答案'));assert(!render().includes('本次有标准数值点'));
  input.ground_truth={available:true,value:'金额为42美元。'};
  assert(render().includes('本次有标准数值点'));
  input.ground_truth={available:false,value:null};
  answer.table_check_results=[{rows:[]}];
  assert(!render().includes('本次有表格待核行'));
  answer.table_check_results=[{rows:[{row_index:0}]}];
  assert(render().includes('本次有表格待核行'));
  answer.final_images={image_count:1,view_request:{candidate:'answer',message_index:5}};
  assert(render().includes('本次有可查看图片'));assert(!render().includes('本次有视觉采集占位'));
  answer.capture_gaps=[{status:'not_supported'}];
  assert(render().includes('本次有视觉采集占位'));
  for(const heading of ['本次有表格待核行','本次有可查看图片','本次有视觉采集占位'])assert.equal(render().split(heading).length,2);
});

test("attribution submits local transition checks and causes without identity or directory cross-mapping", () => {
  const f=businessChainFixture();
  const schema = attributionProfile.modelSubmissionSchema!(f.binding.request) as any;
  assert.equal(attributionProfile.fileSubmission, false);
  assert(!attributionProfile.toolNames.includes("edit_json"));
  assert(!schema.properties.investigation_facts);
  const problem=schema.properties.problems.items.properties;
  for(const key of ["checks","causes","calculations"])assert(problem[key]);
  assert(!problem.investigation_fact_indices);assert(!problem.component);
  const cause=problem.causes.items;
  for(const key of ["transition_index","function_index","basis"])assert(cause.properties[key]);
  for(const key of ["actor_index","chain_index","step_index","failure_stage_index","evidence_indices","role"])
    assert(!cause.properties[key],key);
  assert.deepEqual(cause.properties.transition_index.enum,f.transitions.map(edge=>edge.transition_index));
});

test("each local problem binds its own checks to program-owned actors", () => {
  const f=businessChainFixture(),registry=new AgentRegistry([attributionAgent]);
  const second=structuredClone(f.result.findings[0]);
  second.text="价格字段的资产口径被错误使用。";second.problem!.label="价格字段错配";
  f.result.findings.push(second);
  const draft=attributionSubmission(f.binding.request,f.result,f.audit);
  assert.equal(draft.problems.length,2);
  assert.notEqual(draft.problems[0].checks,draft.problems[1].checks);
  const accepted=registry.resolve(f.binding,draft,f.audit) as AttributionResult;
  for(const finding of accepted.findings){
    assert.equal(finding.problem!.component[0].transition_index,f.generated.transition_index);
    assert.equal(finding.problem!.component[0].actor_index,f.generated.actor_index);
    assert(finding.problem!.investigation.every(check=>!Object.hasOwn(check,"steps")));
  }
});

test("a foreign boundary selection reports a model-editable local check path", () => {
  const f=businessChainFixture(),registry=new AgentRegistry([attributionAgent]);
  const draft=attributionSubmission(f.binding.request,f.result,f.audit);
  draft.problems[0].checks[0].transition_index=99999;
  assert.throws(()=>registry.resolve(f.binding,draft,f.audit),error=>error instanceof ValidationError&&
    error.issues!.some(issue=>issue.code==="transition_invalid"&&issue.path==="/problems/0/checks/0/transition_index"));
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
