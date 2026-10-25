import test from "node:test";
import assert from "node:assert/strict";
import { parseEvidenceCoordinates, ValidationError } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";
import { attributionAgent, attributionProfile, type AttributionResult } from "./index.js";
import { businessChainFixture } from "../../../../tests/fixtures/business-chain.js";
import { attributionSubmission } from "../../../../tests/fixtures/attribution-submission.js";
import { businessChainDirectoryIssues, businessChainReads, investigationIssues } from "./investigation.js";
import { responsibilityIssues } from "./responsibility.js";
import { validateModelSubmission } from "./submission.js";
import { bindAttributionMaterial } from "@eval/workflows/review";
import { cite, evidenceSources, selectEvidenceSource } from "@eval/tools";

const codes = (f: ReturnType<typeof businessChainFixture>) => investigationIssues(f.binding.request, f.problem, f.evidence, f.audit, "/problem").map(issue => issue.code);
test("shell input navigation follows the actual action ID without copying unrelated history into every chain",()=>{
  const f=businessChainFixture(),returned={action_id:"actual-run",stdout:"matching result"};
  const messages=[{type:"user_question",role:"user",content:"检查回测。"},
    {type:"llm_turn",name:"llm-call-1",parent_span:"p",input_messages:[{role:"user",content:"检查回测。"}],output:[{role:"assistant",content:"此前步骤"}]},
    {type:"tool_call",name:"shell",parent_span:"p",end:"2026-10-24T06:08:42.893Z",input:{command:"run"}},
    {type:"tool_result",name:"shell",end:"2026-10-24T06:08:42.893Z",output:returned},
    {type:"llm_turn",name:"llm-call-2",input_messages:[{role:"assistant",content:"此前步骤"},{role:"tool",content:JSON.stringify(returned)},
      {role:"tool",content:JSON.stringify({action_id:"other-run",stdout:"unrelated"})}],output:[{role:"assistant",content:"完成"}]},
    {type:"final_answer",content:"完成"}];
  const binding=bindAttributionMaterial({...f.candidate,final_index:5},{messages});
  const chain=(binding.request.input.answer as any).business_chains[0];
  assert.deepEqual(chain.context_indices,[1,4]);
  const inputs=chain.checkpoints.find((point:any)=>point.step==="模型实际输入").evidence;
  assert.equal(inputs.length,1);
  assert.deepEqual(JSON.parse(inputs[0].quote),returned);
});
test("correct tool return followed by wrong interpretation retains the full business location and inferred hidden mechanism", () => {
  const f = businessChainFixture(), registry = new AgentRegistry([attributionAgent]);
  assert.deepEqual(codes(f), []);
  assert.deepEqual(responsibilityIssues(f.binding.request, f.problem, f.evidence, "/problem"), []);
  const draft = attributionSubmission(f.binding.request, f.result, f.audit);
  const accepted = registry.resolve(f.binding, draft, f.audit) as AttributionResult;
  registry.validate(f.binding, accepted, f.audit);
  assert.equal(accepted.findings[0].assessment.evidence_status, "established");
  assert.equal(accepted.findings[0].problem!.component[0].certainty, "inferred");
  assert.equal(accepted.findings[0].problem!.component[0].business_component, "finquery 返回的价格口径解释与使用");
  assert(accepted.findings[0].problem!.component.every(cause => cause.component !== "finquery"));
  f.cause.certainty = "confirmed";
  assert(codes(f).includes("responsibility_mechanism_inferred"));
});
test("a wrong target selected by the planner points back to that planner and exact request, not the final node", () => {
  const f = businessChainFixture(false, "请预测未来6个月XAU/USD现货黄金，必须查询现货美元每盎司，不能使用ETF代理。");
  assert(f.chain.checkpoints[0].evidence.some(item => item.quote.includes("不能使用ETF代理")));
  f.cause.component = "查询规划 Agent"; f.cause.actor_index=1; f.cause.business_component = "黄金现货查询的标的选择";
  f.cause.chain_step = "查询规划与标的选择"; f.cause.field_names = ["query"];
  f.cause.mechanism_source = "explicit_process"; f.cause.certainty = "confirmed"; f.cause.evidence_gap = null; f.cause.alternatives = [];
  f.cause.mechanism = "公开任务明确要求现货时仍计划查询ETF标的；工具依照该计划执行。";
  assert.deepEqual(codes(f), []);
  f.cause.component = "最终回答组织"; f.cause.actor_index=(f.binding.request.input.answer as any).component_catalog.findIndex((actor:any)=>actor.component===f.cause.component)+1;
  assert(codes(f).includes("responsibility_chain_actor"));
});
test("captured context preparation can own identity and unit loss; the receiving final node alone cannot prove that responsibility", () => {
  const f = businessChainFixture(true);
  assert.deepEqual(f.chain.context_indices, [4, 5]);
  f.problem.diagnosis = "context_loss";
  Object.assign(f.cause, { actor_index:(f.binding.request.input.answer as any).component_catalog.findIndex((actor:any)=>actor.component==="结果整理 Agent")+1, component: "结果整理 Agent", technical_domain: "上下文工程", functional_component: "压缩摘要",
    business_component: "finquery 返回的身份与单位整理", chain_step: "返回整理与上下文传递", certainty: "confirmed", mechanism_source: "explicit_process",
    evidence_gap: null, alternatives: [], mechanism: "整理前含ETF身份和美元单位，整理输出只保留price，最终输入沿用该输出。" });
  assert.deepEqual(codes(f), []);
  f.cause.component = "最终回答组织"; f.cause.actor_index=(f.binding.request.input.answer as any).component_catalog.findIndex((actor:any)=>actor.component===f.cause.component)+1;
  assert(codes(f).includes("responsibility_transfer_actor"));
});
test("readable but unread actual input cannot be called missing, including an uncertain source-absence finding", () => {
  const f = businessChainFixture();
  f.audit.traceReads = f.audit.traceReads.filter(read => read.message_index !== 4);
  assert(codes(f).includes("investigation_read_required"));
  f.problem.investigation[0].steps.find(step => step.step === "模型实际输入")!.status = "not_collected";
  assert(codes(f).includes("investigation_available"));
  f.problem.diagnosis = "source_absence";
  assert(codes(f).includes("source_absence_contradicted"));
  const registry = new AgentRegistry([attributionAgent]);
  f.result.findings[0].assessment.evidence_status = "uncertain";
  assert.throws(() => registry.resolve(f.binding, attributionSubmission(f.binding.request, f.result, f.audit), f.audit),
    error => error instanceof ValidationError && error.issues!.some(issue => issue.code === "investigation_read_required"));
});
test("uncited chains remain navigable without compulsory pre-reading; cited chains still enforce their own evidence", () => {
  const f=businessChainFixture(), before=businessChainReads(f.binding.request);
  f.chain.references=[];
  assert.deepEqual(businessChainReads(f.binding.request),before);
  assert(before.some(read=>read.message_index===f.chain.return_indices[0]));
  assert(before.some(read=>read.message_index===f.chain.context_indices.at(-1)));
  assert(!attributionProfile.requiredReads!(f.binding.request).some(read=>read.message_index===f.chain.return_indices[0]));
  f.audit.traceReads=[];
  assert(codes(f).includes("investigation_read_required"));
});
test("complete serialized return coverage proves its real text leaves without requiring an impossible duplicate read", () => {
  const f = businessChainFixture(), message_index = f.chain.return_indices[0];
  const sources = evidenceSources(f.raw.messages[message_index]);
  const json = sources.find(source => source.kind === "json")!;
  const point = f.chain.checkpoints.find(row => row.step === "原始返回及字段含义")!.evidence
    .map(row => parseEvidenceCoordinates(row.evidence_id)!).find(row => row.kind === "text")!;
  assert(point?.kind === "text");
  const leaf = selectEvidenceSource([json], point.path)!;
  const otherReads = f.audit.traceReads.filter(read => read.message_index !== message_index);
  const read = { candidate: "answer", message_index, kind: "json" as const, path: json.path, start: 0, end: json.text.length };
  f.audit.traceReads = [...otherReads, { ...read, end: leaf.start }, { ...read, start: leaf.start }];
  assert.deepEqual(codes(f), [], "adjacent physical JSON reads cover the complete leaf");
  const registry = new AgentRegistry([attributionAgent]);
  const accepted = registry.resolve(f.binding, attributionSubmission(f.binding.request, f.result, f.audit), f.audit) as AttributionResult;
  registry.validate(f.binding, accepted, f.audit);
  const missing = () => investigationIssues(f.binding.request, f.problem, f.evidence, f.audit, "/problem")
    .some(issue => issue.code === "investigation_read_required" && (issue.expected as { path: string }).path === point.path);
  f.audit.traceReads = [...otherReads, { ...read, end: leaf.end - 1 }];
  assert(missing(), "partial serialized leaf must still be read");
  for (const changed of [{ candidate: "other" }, { message_index: message_index + 1 }, { path: "/other" }]) {
    f.audit.traceReads = [...otherReads, { ...read, ...changed }];
    assert(missing(), "coverage cannot come from another physical source");
  }
});
test("specific actors, business operation and call coordinates stay distinct and forged links or final-only fallback fail", () => {
  const f = businessChainFixture();
  assert.equal(f.chain.request_index, 2); assert.deepEqual(f.chain.return_indices, [3]); assert.equal(f.chain.planner_index, 1);
  assert(!f.problem.component.some(cause => /^llm-call-|^[0-9a-f-]{32,}$/u.test(cause.component)));
  const actor = (f.binding.request.input.answer as any).component_catalog[f.cause.actor_index - 1];
  for (const generic of [actor.component, f.cause.chain_step, "工具执行与数据获取", "语义理解", "llm-call-0"]) {
    f.cause.business_component = generic;
    assert(codes(f).includes("responsibility_business_location"));
  }
  f.cause.chain_index = null;
  assert(codes(f).includes("responsibility_chain"));
  f.problem.investigation = [];
  assert(!codes(f).includes("investigation_incomplete"));
  f.chain.return_indices = [4];
  assert(businessChainDirectoryIssues(f.binding.request).length);
});
test("English renderer finance sources retain identity, price and exact coordinates without indexing private metadata", () => {
  const f = businessChainFixture(), answer = f.binding.request.input.answer as any;
  const source = answer.citation_inventory.references.find((item: any) => item.reference === "pfJtupL");
  assert.equal(source.status, "resolved"); assert(source.sources.some((s: any) => s.origin === "model_visible" && s.quote.includes("SPDR Gold Shares") && s.quote.includes("369")));
  assert(!JSON.stringify(answer.business_chains).includes("SYS_PRIVATE"));
  assert(!JSON.stringify(answer.citation_inventory).includes("PRIVATE_NOT_A_SOURCE"));
  const shown = JSON.stringify(f.binding.modelInput);
  assert(shown.includes("read_request"));
  // The same query in a second request has no unique return link; never pair by adjacency.
  f.raw.messages.splice(3, 0, structuredClone(f.raw.messages[2]));
  (f.raw.messages[3] as any).call_id = "another-call";
  const rebuilt = bindAttributionMaterial({ ...f.candidate, final_index: f.candidate.final_index + 1 }, f.raw);
  assert.deepEqual((rebuilt.request.input.answer as any).business_chains[0].return_indices, [4]);
});

test("a readable retrieved Goldman target cannot become an absent-source allegation when the judge skipped it", () => {
  const f = businessChainFixture();
  const result = { serial_number: "gs4900a", title: "Goldman Sachs Research", summary: "$4,900 per troy ounce by end 2026" };
  const final = f.raw.messages.at(-1)!;
  final.content = '高盛目标价4,900美元。<trace ref="gs4900a"/>';
  const turn = f.raw.messages.at(-2)!;
  (turn.output as any[])[0].content = final.content;
  turn.input_messages = [{ role: "user", content: "What you found from web search:\n" + JSON.stringify(result) + "\nFinancial data you fetched:\n" }];
  f.raw.messages.splice(4, 0, { type: "tool_result", name: "search", output: { items: [result] } });
  const binding = bindAttributionMaterial({ ...f.candidate, final_index: f.candidate.final_index + 1 }, f.raw);
  const inventory = (binding.request.input.answer as any).citation_inventory;
  const reference = inventory.references[0];
  assert.equal(reference.status, "resolved");
  assert(reference.sources.some((source: any) => source.origin === "tool_return" && source.quote.includes("$4,900")));
  const proof = reference.occurrences.map((item: any) => item.context);
  f.problem.diagnosis = "source_absence"; f.problem.component[0].chain_index = null;
  assert(investigationIssues(binding.request, f.problem, proof, { ...f.audit, traceReads: [] }, "/problem")
    .some(issue => issue.code === "source_absence_contradicted"));
});

test("wide financial rows navigate identity and the declared latest price field instead of an arbitrary serialized prefix", () => {
  const f = businessChainFixture(), returned = f.raw.messages[3].output as any;
  returned.datas[0] = { ...Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`A-padding-${index}`, index])), ...returned.datas[0] };
  const binding = bindAttributionMaterial(f.candidate, f.raw);
  const chain = (binding.request.input.answer as any).business_chains[0];
  const proof = chain.checkpoints.find((point: any) => point.step === "原始返回及字段含义").evidence;
  assert(proof.some((item: any) => item.quote === "GLD.P"));
  assert(proof.some((item: any) => item.quote === "SPDR Gold Shares"));
  assert(proof.some((item: any) => /"Closing Price\[20261022\]":\s*369/u.test(item.quote)));
});

test("a nameless tool keeps its catalog identity gap instead of displaying an invented name", () => {
  const f = businessChainFixture();
  delete f.raw.messages[2].name; delete f.raw.messages[3].name;
  const binding = bindAttributionMaterial(f.candidate, f.raw), answer = binding.request.input.answer as any;
  const actor = answer.component_catalog.find((actor: any) => actor.kind === "tool" && actor.message_indices.includes(2));
  assert.equal(answer.business_chains[0].tool_component, actor.component);
  assert(!["undefined", "query-call"].includes(actor.component));
  assert.deepEqual(businessChainDirectoryIssues(binding.request), []);
  answer.business_chains[0].tool_component = "finquery";
  assert(businessChainDirectoryIssues(binding.request).length);
});

test("an explicitly empty return remains readable process evidence instead of an invalid zero-length mandatory range", () => {
  const f = businessChainFixture(); f.raw.messages[3].output = "";
  const binding = bindAttributionMaterial(f.candidate, f.raw), chain = (binding.request.input.answer as any).business_chains[0];
  const returned = chain.checkpoints.find((point: any) => point.step === "原始返回及字段含义");
  assert.equal(returned.availability, "available");
  assert(returned.evidence.some((item: any) => /"output":\s*""/u.test(item.quote)));
  assert(attributionAgent.profiles.default.requiredReads!(binding.request).every(read => read.end > read.start));
  assert.deepEqual(businessChainDirectoryIssues(binding.request), []);
});

test("reading all materials does not let an actual-input quote impersonate the raw return or either generated boundary", () => {
  const f = businessChainFixture();
  const input = f.chain.checkpoints.find(point => point.step === "模型实际输入")!.evidence.map(item => item.evidence_id);
  for (const stepName of ["原始返回及字段含义", "返回整理与上下文传递", "数据解释与计算", "核验与最终交付"]) {
    const step = f.problem.investigation[0].steps.find(step => step.step === stepName)!, before = step.evidence_ids;
    step.evidence_ids = input;
    assert(codes(f).includes("investigation_stage_evidence"), stepName);
    step.evidence_ids = before;
  }
  assert.deepEqual(codes(f), []);
});
test("a tenfold boundary relation cannot self-declare an explicit confirmed process, while recorded calculation can", () => {
  const f = businessChainFixture();
  Object.assign(f.cause, { mechanism_source: "explicit_process", certainty: "confirmed", evidence_gap: null, alternatives: [] });
  assert(codes(f).includes("responsibility_mechanism_source"));
  const index = f.raw.messages.length - 2;
  f.raw.messages[index].reasoning_content = "将369乘10得到3690，再写为XAU/USD。";
  f.binding = bindAttributionMaterial(f.candidate, f.raw);
  const source = evidenceSources(f.raw.messages[index]).find(source => source.path === "/reasoning_content")!;
  const point = cite(f.candidate.input_id, index, source, 0, source.text.length);
  f.evidence.push(point); f.cause.evidence_ids.push(point.evidence_id);
  const read=parseEvidenceCoordinates(point.evidence_id)!;
  if(read.kind!=='image')f.audit.traceReads.push({candidate:'answer',message_index:index,kind:read.kind,path:read.path,start:read.start,end:read.end});
  f.cause.mechanism = "记录的推理明确将369乘10得到3690，并作为XAU/USD报价输出。";
  f.cause.reason = "该节点的reasoning_content直接记录了转换步骤，输入及生成边界与之相符。";
  assert.deepEqual(codes(f), []);
});
test("an earlier preparer's complete source never substitutes for the final model's input after the source was dropped", () => {
  const f = businessChainFixture(true, undefined, true), last = f.chain.context_indices.at(-1)!;
  f.problem.diagnosis = "context_loss";
  Object.assign(f.cause, { actor_index:(f.binding.request.input.answer as any).component_catalog.findIndex((actor:any)=>actor.component==="结果整理 Agent")+1, component: "结果整理 Agent", technical_domain: "上下文工程", functional_component: "压缩摘要",
    business_component: "finquery 返回整理时删除身份与单位", chain_step: "返回整理与上下文传递", certainty: "confirmed", mechanism_source: "explicit_process",
    evidence_gap: null, alternatives: [], mechanism: "整理前含ETF身份和美元单位，整理输出仅保留price且最后实际输入没有恢复身份与单位。" });
  assert(f.chain.references.includes("pfJtupL"));
  assert.equal((f.binding.request.input.answer as any).citation_inventory.references[0].status, "unknown");
  const inputs = f.chain.checkpoints.find(point => point.step === "模型实际输入")!.evidence;
  assert(inputs.some(item => item.message_index < last && item.quote.includes("SPDR Gold Shares")));
  assert(inputs.some(item => item.message_index === last && item.quote.includes("use the preceding summary")));
  assert.deepEqual(codes(f), []);
  f.problem.diagnosis = "source_absence";
  assert(codes(f).includes("source_absence_contradicted"));
  f.problem.diagnosis = "context_loss";
  const step = f.problem.investigation[0].steps.find(step => step.step === "模型实际输入")!;
  step.evidence_ids = inputs.filter(item => item.message_index < last).map(item => item.evidence_id);
  assert(codes(f).includes("investigation_stage_evidence"));
  f.audit.traceReads = f.audit.traceReads.filter(read => read.message_index !== last);
  assert(codes(f).includes("investigation_read_required"));
});
test("final JSON evidence does not invent an unselected chain, while explicit invalid links still fail", () => {
  const f = businessChainFixture(), index = f.candidate.final_index;
  const source = evidenceSources(f.raw.messages[index]).find(source => source.kind === "json")!;
  const point = cite(f.candidate.input_id, index, source, 0, source.text.length);
  f.problem.investigation = []; f.cause.chain_index = null;
  const issues = investigationIssues(f.binding.request, f.problem, [point], f.audit, "/problem");
  assert(!issues.some(issue => issue.code === "investigation_incomplete"));
  assert(!issues.some(issue => issue.code === "responsibility_chain"));
  f.cause.chain_index=999;
  assert(investigationIssues(f.binding.request,f.problem,[point],f.audit,"/problem")
    .some(issue=>issue.code==="responsibility_chain"));
});

test("field repair feedback lists actual selected names without silently rewriting invented aliases", () => {
  const f = businessChainFixture();
  f.cause.field_names = ["Closing Price[20261022]", "target price"];
  const issue = investigationIssues(f.binding.request, f.problem, f.evidence, f.audit, "/problem")
    .find(issue => issue.code === "responsibility_fields")!;
  assert.deepEqual(issue.expected, ["Closing Price[20261022]"]);
  assert.deepEqual(f.cause.field_names, ["Closing Price[20261022]", "target price"]);
  f.cause.field_names = issue.expected as string[];
  assert.deepEqual(codes(f), []);
});

test("prose calculations can clear invented field names without allowing entity or unit investigations to lose their fields", () => {
  const f = businessChainFixture();
  f.problem.diagnosis = "other"; f.cause.field_names = ["target price", "spot price"];
  const issue = investigationIssues(f.binding.request, f.problem, f.evidence, f.audit, "/problem")
    .find(issue => issue.code === "responsibility_fields")!;
  assert.deepEqual(issue.expected, []);
  f.cause.field_names = issue.expected as string[];
  assert.deepEqual(codes(f), []);
  f.problem.diagnosis = "entity_or_unit";
  assert(codes(f).includes("responsibility_fields"));
  f.cause.field_names = ["target price"];
  assert.equal(investigationIssues(f.binding.request, f.problem, f.evidence, f.audit, "/problem")
    .find(issue => issue.code === "responsibility_fields")!.expected, undefined);
});

test("missing investigation choices produce structural feedback without cascading reads", () => {
  const f=businessChainFixture(),registry=new AgentRegistry([attributionAgent]);
  const draft=attributionSubmission(f.binding.request,f.result,f.audit) as any;
  delete draft.problems[0].diagnosis;delete draft.problems[0].investigation_fact_indices;
  draft.problems[0].component[0].actor_index=999;
  assert.throws(()=>registry.resolve(f.binding,draft,f.audit),error=>{
    assert(error instanceof ValidationError);
    assert.equal(error.issues!.filter(issue=>issue.code==='schema_required').length,2);
    assert(error.issues!.some(issue=>issue.code==='schema_maximum'));
    assert(!error.issues!.some(issue=>issue.code.startsWith('investigation_')));return true;
  });
});
test("sufficient existing evidence and an explicit mechanism gap do not require eight investigation facts",()=>{
  const f=businessChainFixture(),registry=new AgentRegistry([attributionAgent]);f.problem.investigation=[];
  const draft=attributionSubmission(f.binding.request,f.result,f.audit);
  const result=registry.resolve(f.binding,draft,f.audit) as AttributionResult;
  registry.validate(f.binding,result,f.audit);
  assert.equal(result.findings[0].problem!.component[0].certainty,'inferred');
  assert(result.findings[0].problem!.component[0].evidence_gap);
});
test('shared missing proof reads are grouped by node across affected problems',()=>{
  const f=businessChainFixture();f.problem.investigation=[];
  Object.assign(f.cause,{certainty:'confirmed',mechanism_source:'explicit_process',evidence_gap:null,alternatives:[]});
  f.result.findings.push(structuredClone(f.result.findings[0]));
  const draft=attributionSubmission(f.binding.request,f.result,f.audit);
  const issues=validateModelSubmission(f.binding.request,draft,{...f.audit,traceReads:[]})
    .filter(issue=>issue.code==='investigation_read_required');
  const requests=issues.flatMap(issue=>(issue.expected as any).read_requests);
  assert(issues.length>0);
  assert.equal(issues.length,new Set(requests.map(read=>read.message_index)).size);
  assert(issues.some(issue=>(issue.expected as any).affected_fields.length===2));
});

test("stage repair feedback provides selectable source indices that repair the actual model submission", () => {
  const f = businessChainFixture(), registry = new AgentRegistry([attributionAgent]);
  f.problem.investigation[0].steps.find(step => step.step === "返回整理与上下文传递")!.evidence_ids =
    f.chain.checkpoints.find(point => point.step === "模型实际输入")!.evidence.map(item => item.evidence_id);
  const draft = attributionSubmission(f.binding.request, f.result, f.audit);
  assert.throws(() => registry.resolve(f.binding, draft, f.audit), error => {
    assert(error instanceof ValidationError);
    const expected = error.issues!.find(issue => issue.code === "investigation_stage_evidence")!.expected as any;
    assert.equal(expected.chain_index, 1);
    assert.equal(expected.step, "返回整理与上下文传递");
    const factIndex=draft.investigation_facts.findIndex(fact=>fact.step_index===5);
    assert.deepEqual(expected.fact_indices,[factIndex+1]);
    assert.deepEqual(expected.repair_paths,[`/investigation_facts/${factIndex}/evidence_indices`]);
    assert(expected.required_sources.every((source:any)=>source.read_request?.candidate==='answer'&&
      typeof source.read_request.path==='string'&&source.end_offset>source.read_request.offset));
    const indices = expected.required_sources.map((source: any) => source.reference.evidence_index);
    assert(indices.every((index: number) => Number.isInteger(index) && index > 0));
    assert(!JSON.stringify(expected).includes(`ev_${f.candidate.input_id}_`));
    const step = draft.investigation_facts.find(fact => fact.step_index === 5)!;
    step.evidence_indices = [...new Set([...step.evidence_indices, ...indices])] as number[];
    return true;
  });
  const accepted = registry.resolve(f.binding, draft, f.audit) as AttributionResult;
  registry.validate(f.binding, accepted, f.audit);
});
