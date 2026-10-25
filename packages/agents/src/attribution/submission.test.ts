import { unknownFormationFixture, responsibilitySubmissionFixture } from "../../../../tests/fixtures/responsibility.js";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { ValidationError, evidenceId, selectEvidence, type AgentRequest, type ToolAudit } from "@eval/contracts";
import { attributionAgent, attributionProfile, type AttributionResult } from "./index.js";
import { businessChainFixture } from "../../../../tests/fixtures/business-chain.js";
import { captureMarkerProblemIssues } from "./source-evidence.js";
import example from "./fixtures/example.json" with { type: "json" };
import { attributionSubmission, setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";

function fixture(request:AgentRequest=structuredClone(example.request),result:AttributionResult=structuredClone(example.result) as AttributionResult) {
  const audit: ToolAudit = {calls:0,requiredReadCalls:0,viewedImages:[],traceReads:[],calculations:[],artifacts:[],evidenceBank:[]};
  setFixtureNormDirectory(request);
  const draft = attributionSubmission(request,result,audit);
  return {request,audit,draft,registry:new AgentRegistry([attributionAgent]),binding:{agent:"attribution",profile:"default",request}};
}
test("flat ordered judgments bind criterion identity and direct evidence numbers without copied IDs",()=>{
  const f=fixture(),before=structuredClone(f.draft);
  assert(!Object.hasOwn(f.draft.criterion_assessments[0],"criterion_id"));
  assert(!Object.hasOwn(f.draft.strengths[0],"assessment"));
  const value=f.registry.resolve(f.binding,f.draft,f.audit) as AttributionResult;
  f.registry.validate(f.binding,value,f.audit);
  assert.equal(value.criterion_assessments[0].criterion_id,example.result.criterion_assessments[0].criterion_id);
  assert.equal(value.findings[0].finding_id,"f0");
  assert.deepEqual(f.draft,before);
});
test("a complete row template does not reject a correct first judgment because of inactive fields",()=>{
  const f=fixture(),schema=attributionProfile.modelSubmissionSchema!(f.request) as any;
  const expected=f.registry.resolve(f.binding,f.draft,f.audit),draft=structuredClone(f.draft) as any;
  for(const [key,definition]of Object.entries(schema.properties) as [string,any][]){
    if(!definition.items?.properties||!Array.isArray(draft[key]))continue;
    for(const row of draft[key])for(const [field,property]of Object.entries(definition.items.properties) as [string,any][]){
      if(Object.hasOwn(row,field))continue;
      row[field]=Array.isArray(property.type)&&property.type.includes("null")?null:
        property.type==="array"?[]:property.type==="boolean"?false:"";
    }
  }
  assert.deepEqual(f.registry.resolve(f.binding,draft,f.audit),expected);
});

function captureFixture(marker: string) {
  const request=structuredClone(example.request) as AgentRequest,id=request.sources.answer.id;
  const result=structuredClone(example.result) as AttributionResult;
  (request.sources.answer.value as {messages:{content:unknown}[]}).messages[1].content=[
    {type:"output_text",text:"2+2=4"},{type:"output_text",text:marker},
  ];
  const final=canonicalEvidence(id,1,"2+2=4","/content/0/text");
  result.correctness_evidence=[final];
  result.criterion_assessments.forEach(row=>{row.evidence=[final];});
  result.findings[0].evidence=[final];
  const f=fixture(request,result),capture=canonicalEvidence(id,1,marker,"/content/1/text");
  const problem=unknownFormationFixture(request,[final]);
  const cause=responsibilitySubmissionFixture(problem.component[0]);
  f.audit.traceReads.push({candidate:"answer",message_index:1,kind:"text",path:"/content/0/text",start:0,end:5});
  f.draft.problems=[{basis_index:null,dimension:"format",stage:"final_answer",importance:"low",
    text:"可视交付有缺口。",reason:"所选材料只提供了采集状态。",impact:"图中内容无法交付给用户。",
    evidence_status:"established",evidence_indices:[selectEvidence(f.audit.evidenceBank!,capture).evidence_index],
    diagnosis:"other",checks:problem.investigation.map(check=>({transition_index:check.transition_index,outcome:check.outcome,
      observation:check.observation,before_evidence_indices:[],after_evidence_indices:[selectEvidence(f.audit.evidenceBank!,final).evidence_index]})),
    calculations:[],causes:[cause],label:"展示缺失"}];
  return {...f,capture,final};
}

test("exact capture markers alone cannot establish a candidate problem",()=>{
  for(const marker of ['{"jgy_visual":"skipped","ref":"jgy-test"}','{"visual":"unsupported","ref":"html-test"}']) {
    const f=captureFixture(marker);
    const finding={type:"problem",assessment:{evidence_status:"established"},evidence:[f.capture]};
    assert(captureMarkerProblemIssues(f.request,{findings:[finding]}).some(issue=>issue.code==="capture_marker_not_candidate_evidence"));
    const excerpt=canonicalEvidence(f.request.sources.answer.id,1,marker.slice(2,12),"/content/1/text",2);
    finding.evidence=[excerpt];
    assert.equal(captureMarkerProblemIssues(f.request,{findings:[finding]}).length,1);
    finding.assessment.evidence_status="uncertain";
    assert.equal(captureMarkerProblemIssues(f.request,{findings:[finding]}).length,0);
    finding.assessment.evidence_status="established";finding.evidence.push(f.final);
    assert.equal(captureMarkerProblemIssues(f.request,{findings:[finding]}).length,0);
  }
});

test("capture-looking ordinary prose is not classified by finding wording or marker keywords",()=>{
  for(const text of ['前文说明：{"visual":"unsupported","ref":"html-test"}',
    '```json\n{"visual":"unsupported","ref":"html-test"}\n```',
    '{"visual":"unsupported","ref":"html-test","answer":"2+2=4"}']) {
    const f=captureFixture(text);
    f.registry.validate(f.binding,f.registry.resolve(f.binding,f.draft,f.audit),f.audit);
  }
});
test("numeric checks select the evidence directory directly even when correctness entries have another order",()=>{
  const f=fixture();
  const final=f.draft.correctness_evidence_indices![0];
  const question=String((f.request.sources.answer.value as {messages:{content:string}[]}).messages[0].content);
  const questionNumber=selectEvidence(f.audit.evidenceBank!,canonicalEvidence(f.request.sources.answer.id,0,question)).evidence_index;
  f.draft.correctness_evidence_indices=[questionNumber,final];
  f.draft.numeric_checks=[{label:"加法结果",reference_index:1,actual:"4",scale:"1",mode:"exact",evidence_index:final}];
  const value=f.registry.resolve(f.binding,f.draft,f.audit) as AttributionResult;
  assert.equal(value.numeric_checks[0].matches,true);
  assert.equal(value.correctness_evidence[value.numeric_checks[0].evidence_index].evidence_id,f.audit.evidenceBank![final-1]);
  f.draft.numeric_checks[0].evidence_index=99999;
  assert.throws(()=>f.registry.resolve(f.binding,f.draft,f.audit),error=>error instanceof ValidationError &&
    error.issues!.some(issue=>issue.code==="evidence_selection_invalid"&&issue.path==="/numeric_checks/0/evidence_index"));
});
test("missing fixed checks and injected identity fields are rejected rather than guessed",()=>{
  const f=fixture();f.draft.criterion_assessments=[];
  assert.throws(()=>f.registry.resolve(f.binding,f.draft,f.audit),/数量必须一致/);
  const g=fixture();Object.assign(g.draft.criterion_assessments[0],{criterion_id:"invented"});
  assert.throws(()=>g.registry.resolve(g.binding,g.draft,g.audit),/additional properties/);
});
test("model-returned objects keep a bounded responsibility layer and program-owned identities",()=>{
  const f=fixture(),schema=attributionProfile.modelSubmissionSchema!(f.request) as any;
  function depth(value:any,level=0):number {
    if(!value||typeof value!=="object")return level;
    const next=level+(value.type==="object"?1:0);
    return Math.max(next,...Object.values(value.properties??{}).map(item=>depth(item,next)),value.items?depth(value.items,next):next,
      ...(value.allOf??[]).map((item:any)=>depth(item,next)));
  }
  assert.equal(depth(schema),4); // Root → problem → calculation → explicit result range.
  assert(!JSON.stringify(schema).includes('"evidence_id"'));
  assert(!JSON.stringify(schema).includes('"criterion_id"'));
});

function toolFixture() {
  const f=businessChainFixture();
  return {request:f.binding.request,audit:f.audit,draft:attributionSubmission(f.binding.request,f.result,f.audit),
    registry:new AgentRegistry([attributionAgent]),binding:f.binding};
}

test("requirement links are explicit choices while verdict, prose and evidence fields remain required",()=>{
  const f=fixture();Reflect.deleteProperty(f.draft.strengths[0],"basis_index");
  assert.throws(()=>f.registry.resolve(f.binding,f.draft,f.audit),error=>error instanceof ValidationError&&
    error.issues!.some(issue=>issue.code==="schema_required"&&issue.path==="/strengths/0/basis_index"));
  f.draft.strengths[0].basis_index=null;
  const result=f.registry.resolve(f.binding,f.draft,f.audit) as AttributionResult;
  assert.equal(result.findings[0].assessment.requirement_index,null);
  for(const key of ["text","evidence_status","reason","evidence_indices"] as const){
    const malformed=structuredClone(f.draft);Reflect.deleteProperty(malformed.strengths[0],key);
    assert.throws(()=>f.registry.resolve(f.binding,malformed,f.audit),ValidationError);
  }
});

test("core and requirement relations use current positive choices and retain actual unknown scope",()=>{
  const f=fixture();f.draft.core_requirements=[99999];
  assert.throws(()=>f.registry.resolve(f.binding,f.draft,f.audit),error=>{
    assert(error instanceof ValidationError);
    const issue=error.issues!.find(issue=>issue.code==="core_requirement_index_invalid")!;
    assert.equal(issue.path,"/core_requirements/0");assert.deepEqual(issue.expected,[1]);assert.equal(issue.actual,99999);
    assert.doesNotMatch(issue.message,/零起始|core_assessment/u);return true;
  });
  const g=toolFixture();g.draft.criterion_assessments[0].status="met";
  assert.throws(()=>g.registry.resolve(g.binding,g.draft,g.audit),error=>error instanceof ValidationError&&error.issues!.some(issue=>issue.code==="finding_requirement_conflict"));
});

test("core uncertainty preserves confirmed local findings without a status-alignment retry",()=>{
  const f=toolFixture();f.draft.meets_core=null;
  f.draft.core_reason="已确认局部数值问题，但任务整体完成情况仍有未核实范围。";
  const before=structuredClone(f.draft);
  const accepted=f.registry.resolve(f.binding,f.draft,f.audit) as AttributionResult;
  f.registry.validate(f.binding,accepted,f.audit);
  assert.equal(accepted.core_assessment.meets_core,null);
  assert.equal(accepted.criterion_assessments[0].evidence_status,"established");
  assert.equal(accepted.findings[0].assessment.evidence_status,"established");
  assert.deepEqual(f.draft,before);
});

test("a minor ancillary defect does not contradict a met task requirement, while material defects still do",()=>{
  const f=fixture();
  const source=f.request.sources.answer.value as {messages:{content:string}[]};
  source.messages[1].content+="。。";
  setFixtureNormDirectory(f.request);
  const final=canonicalEvidence(f.request.sources.answer.id,1,source.messages[1].content);
  const formation=unknownFormationFixture(f.request,[final]);
  const index=selectEvidence(f.audit.evidenceBank!,final).evidence_index;
  f.audit.traceReads.push({candidate:"answer",message_index:1,kind:"text",path:"/content",start:0,end:source.messages[1].content.length});
  f.draft.problems.push({...f.draft.strengths[0],dimension:"format",importance:"low",text:"句尾重复了句号。",
    reason:"计算值4正确，句尾多写的句号不改变数值。",impact:"不影响计算结果的使用。",evidence_indices:[index],
    diagnosis:"other",checks:formation.investigation.map(check=>({transition_index:check.transition_index,outcome:check.outcome,
      observation:check.observation,before_evidence_indices:[],after_evidence_indices:[index]})),
    calculations:[],causes:formation.component.map(responsibilitySubmissionFixture),label:"标点重复"});
  const result=f.registry.resolve(f.binding,f.draft,f.audit) as AttributionResult;
  assert.equal(result.criterion_assessments[0].status,"met");
  assert.equal(result.findings[1].type,"problem");
  for(const importance of ["medium","high"] as const){
    f.draft.problems[0].importance=importance;
    assert.throws(()=>f.registry.resolve(f.binding,f.draft,f.audit),error=>error instanceof ValidationError&&
      error.issues!.some(issue=>issue.code==="finding_requirement_conflict"));
  }
});

test("no-standard submissions omit program correctness fields and preserve independent read errors",()=>{
  const request=structuredClone(example.request) as AgentRequest;
  request.input.ground_truth={available:false,value:null};
  const f=fixture(request);
  assert(!Object.hasOwn(f.draft,"is_correct"));assert(!Object.hasOwn(f.draft,"correctness_reason"));assert(!Object.hasOwn(f.draft,"correctness_evidence_indices"));
  f.registry.validate(f.binding,f.registry.resolve(f.binding,f.draft,f.audit),f.audit);
  for(const [key,value]of [["is_correct",true],["correctness_reason","已核对标准"],["correctness_evidence_indices",[1]]] as const)
    assert.throws(()=>f.registry.resolve(f.binding,{...f.draft,[key]:value},f.audit),ValidationError);
  (request.sources.answer.value as {messages:Record<string,unknown>[]}).messages[1].attachments=[{type:"image",mimeType:"image/png",data:"AA=="}];
  const malformed={...f.draft,criterion_assessments:[],summary:7};
  assert.throws(()=>f.registry.resolve(f.binding,malformed,f.audit),error=>{
    assert(error instanceof ValidationError);
    assert(error.issues!.some(issue=>issue.code==="criterion_slot_count"));
    assert(error.issues!.some(issue=>issue.code==="final_image_not_viewed"));
    return true;
  });
});

test("standard challenge is hidden and rejected by default across submission and result validation",()=>{
  const f=fixture(),schema=attributionProfile.modelSubmissionSchema!(f.request) as any;
  assert(!Object.hasOwn(schema.properties,"standard_conflict"));
  const prompt=attributionProfile.renderPrompt!(f.request.input);
  assert(!prompt.includes("standard_answer_review"));
  const result=f.registry.resolve(f.binding,f.draft,f.audit) as AttributionResult;
  assert.throws(()=>f.registry.resolve(f.binding,{...f.draft,is_correct:false,standard_conflict:true},f.audit),ValidationError);
  assert.throws(()=>f.registry.validate(f.binding,{...result,is_correct:false,standard_conflict:true},f.audit),error=>
    error instanceof ValidationError&&error.issues!.some(issue=>issue.code==="standard_conflict_disabled"));
  f.request.input.allow_standard_conflict=true;
  assert(Object.hasOwn((attributionProfile.modelSubmissionSchema!(f.request) as any).properties,"standard_conflict"));
  assert(attributionProfile.renderPrompt!(f.request.input).includes("standard_answer_review"));
});

test("standard conflicts are an explicit flag and cannot excuse a passing or standard-free judgment",()=>{
  const f=fixture();
  f.request.input.allow_standard_conflict=true;
  assert.equal(f.draft.standard_conflict,undefined);
  f.draft.is_correct=false;f.draft.standard_conflict=true;f.draft.correctness_reason="标准为38.1%，本方工具返回与口径支持38.41%。";
  const result=f.registry.resolve(f.binding,f.draft,f.audit) as AttributionResult;
  assert.equal(result.standard_conflict,true);
  assert.equal(result.is_correct,false);
  f.draft.is_correct=true;
  assert.throws(()=>f.registry.resolve(f.binding,f.draft,f.audit),error=>error instanceof ValidationError&&
    error.issues!.some(issue=>issue.code==="standard_conflict_correctness"));
  const request=structuredClone(example.request) as AgentRequest;
  request.input.ground_truth={available:false,value:null};
  request.input.allow_standard_conflict=true;
  const noStandard=fixture(request);
  assert.throws(()=>noStandard.registry.resolve(noStandard.binding,{...noStandard.draft,standard_conflict:true},noStandard.audit),error=>error instanceof ValidationError&&
    error.issues!.some(issue=>issue.code==="standard_conflict_without_standard"));
});

test("a confirmed wrong reference does not force blame onto a correct answer or its tools",()=>{
  const request=structuredClone(example.request) as AgentRequest;
  request.input.allow_standard_conflict=true;
  request.input.ground_truth={available:true,value:"5"};
  const f=fixture(request);
  f.draft.is_correct=false;f.draft.standard_conflict=true;
  f.draft.correctness_reason="原题2+2的结果为4，回答正确；导入标准5错误，仅标准一致性不通过。";
  f.draft.problems=[];
  const result=f.registry.resolve(f.binding,f.draft,f.audit) as AttributionResult;
  f.registry.validate(f.binding,result,f.audit);
  assert.equal(result.standard_conflict,true);
  assert.equal(result.core_assessment.meets_core,true);
  assert(!result.findings.some(row=>row.type==="problem"));
});

test("an image observation numbered by image order binds to the unique image entry",()=>{
  const f=fixture();
  const messages=(f.request.sources.answer.value as {messages:Record<string,unknown>[]}).messages;
  messages[1].attachments=[{type:"image",mimeType:"image/png",data:"AA=="}];
  f.audit.evidenceBank!.push(evidenceId(f.request.sources.answer.id,1,"image"));
  const imageIndex=f.audit.evidenceBank!.length;
  f.audit.viewedImages.push("answer:1");
  f.draft.image_observations=[{image_number:1,text:"图中是表格。"}];
  f.draft.strengths[0].evidence_indices=[imageIndex];
  const result=f.registry.resolve(f.binding,f.draft,f.audit) as AttributionResult;
  assert.equal(result.findings[0]!.evidence[0]!.quote,"[图像观察]图中是表格。");
  const invalid=fixture();
  (invalid.request.sources.answer.value as {messages:Record<string,unknown>[]}).messages[1].attachments=[{type:"image",mimeType:"image/png",data:"AA=="}];
  invalid.audit.evidenceBank!.push(evidenceId(invalid.request.sources.answer.id,1,"image"));
  invalid.audit.viewedImages.push("answer:1");
  invalid.draft.image_observations=[{image_number:9,text:"图中是表格。"}];
  assert.throws(()=>invalid.registry.resolve(invalid.binding,invalid.draft,invalid.audit),error=>error instanceof ValidationError&&
    error.issues!.some(issue=>issue.code==="image_observation_source"&&Array.isArray((issue.expected as {image_numbers:number[]}).image_numbers)));
});

test("a truncated numeric quote points to directory evidence that contains the actual",()=>{
  const build=(value:string)=>{const request=structuredClone(example.request) as AgentRequest;
    const answer="结论见下表。\n\n| 名称 | 拟回购上限 |\n|---|---|\n| 甲 | 5.0 |\n| 乙 | 3.0 |";
    (request.sources.answer.value as {messages:{content:string}[]}).messages[1]!.content=answer;
    (request.input.answer as {final_answer:string}).final_answer=answer;
    request.input.ground_truth={available:true,value};
    const result=structuredClone(example.result) as AttributionResult;
    result.correctness_evidence=[canonicalEvidence(request.sources.answer.id,1,answer)];
    result.numeric_checks=[{label:"目标",expected:value,actual:value,scale:"1",mode:"exact",matches:true,evidence_index:0}];
    return {request,result,answer};};
  const first=build("5.0"),f=fixture(first.request,first.result);
  const available=f.audit.evidenceBank!.indexOf(first.result.correctness_evidence[0]!.evidence_id)+1;
  assert(available>0);
  f.audit.evidenceBank!.push(canonicalEvidence(first.request.sources.answer.id,1,first.answer.slice(0,12)).evidence_id);
  f.draft.numeric_checks=[{label:"目标",reference_index:1,actual:"5.0",scale:"1",mode:"exact",evidence_index:f.audit.evidenceBank!.length}];
  assert.throws(()=>f.registry.resolve(f.binding,f.draft,f.audit),error=>{
    assert(error instanceof ValidationError);
    const issue=error.issues!.find(item=>item.code==="numeric_answer_missing");
    assert(issue,JSON.stringify(error.issues));
    assert.deepEqual(issue!.expected,{evidence_indices:[available]});
    assert.match(issue!.message,new RegExp(`编号 ${available} 的引文包含该原值`));
    return true;
  });
  // Without any answer evidence holding the value, the repair must still require a real read.
  const second=build("7.7"),g=fixture(second.request,second.result);
  g.audit.evidenceBank!.push(canonicalEvidence(second.request.sources.answer.id,1,second.answer.slice(0,12)).evidence_id);
  g.draft.numeric_checks=[{label:"目标",reference_index:1,actual:"7.7",scale:"1",mode:"exact",evidence_index:g.audit.evidenceBank!.length}];
  assert.throws(()=>g.registry.resolve(g.binding,g.draft,g.audit),error=>error instanceof ValidationError&&
    error.issues!.some(issue=>issue.code==="numeric_answer_missing"&&issue.expected===undefined&&/read_trace/u.test(issue.message)));
});
