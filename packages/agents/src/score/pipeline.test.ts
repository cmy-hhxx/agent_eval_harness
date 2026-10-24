import test from 'node:test';
import assert from 'node:assert/strict';
import {Ajv2020} from 'ajv/dist/2020.js';
import type {AgentRequest,ToolAudit,ReviewQuote} from '@eval/contracts';
import {scoreAgent,scoreProfile,scoreAxes,combineScoreAxes,scoreFinalMaterial,type ScoreAxisResult,type ScoreResult} from './index.js';
import originalCase from './fixtures/example-case.json' with {type:'json'};
import originalResult from './fixtures/example-output.json' with {type:'json'};
const audit=():ToolAudit=>({calls:0,requiredReadCalls:0,viewedImages:[],traceReads:[],calculations:[],artifacts:[]});
function request(quotes:ReviewQuote[],axes?:ScoreAxisResult[]):AgentRequest{
  return {input:{},sources:{case:{id:originalCase.case_id,value:{...originalCase,review_seed:{quotes,sources:[],actions:[],viewed:[],searches:[]}}},score:{id:'context',value:{axes}}}} as unknown as AgentRequest;
}
function parts(){return scoreAxes.map(axis=>{
  const p=scoreAgent.profiles[`axis-${axis.toLowerCase()}`];
  const value={evaluations:originalResult.evaluations.filter(r=>r.item_id.startsWith(axis)).map(({item_name:_n,grade:_g,...r})=>r),
    diagnostics:originalResult.diagnostics.filter(r=>r.diagnostic_id.startsWith(axis)).map(({diagnostic_name:_n,...r})=>r),
    findings:originalResult.findings.filter(f=>f.affected_item_ids.some(id=>id.startsWith(axis))).map(f=>{
      const diagnostic_ids=f.diagnostic_ids.filter(id=>id.startsWith(axis));return {...f,affected_item_ids:f.affected_item_ids.filter(id=>id.startsWith(axis)),diagnostic_ids,primary_diagnostic_id:diagnostic_ids[0]};}),verification_requests:[]};
  assert(new Ajv2020({strict:false}).compile(p.submissionSchema)(value));
  const result=p.resolve!(request(originalResult.evidence),value,audit()) as ScoreAxisResult;
  p.validate!(request(originalResult.evidence),result,audit());return result;
});}
test('six independently resolved axes preserve judgments; final grouping merges one cross-axis issue without averaging',()=>{
  const axes=combineScoreAxes(parts(),originalResult.evidence),evidence=[...new Map(axes.flatMap(p=>p.evidence).map(q=>[q.evidence_id,q])).values()];
  const remap=(ids:string[])=>ids.map(id=>{const old=originalResult.evidence.find(q=>q.evidence_id===id)!;return evidence.find(q=>q.source_id===old.source_id&&q.start===old.start&&q.end===old.end)!.evidence_id;});
  const {grade:_grade,...rating}=originalResult.final_answer_score;
  const draft={final_answer_score:{...rating,evidence_ids:remap(rating.evidence_ids),finding_ids:['T:F1']},finding_groups:[['T:F1','D:F1']],explicit_probability:null,probability_evidence_ids:[]};
  const context=request(evidence,axes),result=scoreProfile.resolve!(context,draft,audit()) as ScoreResult;
  scoreProfile.validate!(context,result,audit());
  assert.equal(result.final_answer_score.score,9);assert.equal(result.findings.length,1);
  assert.deepEqual(result.findings[0].affected_item_ids,['T1','T2','D2']);
  assert.deepEqual(result.evaluations,axes.flatMap(p=>p.evaluations));assert.equal(result.diagnostics.length,24);
  assert.equal(result.evidence.length,2);
  for(const part of scoreFinalMaterial(axes))for(const row of part.evaluations){assert(!('score' in row));assert(!('score_range' in row));assert(!('grade' in row));}
  const missing={...draft,finding_groups:[['T:F1']]};assert.throws(()=>scoreProfile.resolve!(context,missing,audit()),/所有分项问题/);
});
test('axis boundaries, fabricated evidence, missing diagnostics and invalid score bands are rejected',()=>{
  const value=parts()[0],p=scoreAgent.profiles['axis-t'],context=request(originalResult.evidence);
  const slim=()=>({evaluations:value.evaluations.map(({item_name:_n,grade:_g,...r})=>r),diagnostics:value.diagnostics.map(({diagnostic_name:_n,...r})=>r),findings:value.findings,verification_requests:[]});
  for(const mutate of [(v:any)=>{v.evaluations[0].item_id='E1';},(v:any)=>{v.evaluations[0].evidence_ids=['FAKE'];},(v:any)=>{v.diagnostics.pop();},(v:any)=>{v.evaluations[0].score=4;}]){
    const draft=structuredClone(slim());mutate(draft);assert.throws(()=>p.resolve!(context,draft,audit()));
  }
});
test('evidence submissions cannot confuse diagnostic identifiers with core item identifiers',()=>{
  const p=scoreAgent.profiles.evidence,validate=new Ajv2020({strict:false}).compile(p.submissionSchema);
  const value={summary:'EPS期间待核。',checks:[{claim:'EPS期间待核',affected_item_ids:['E03'],status:'unverified',reason:'需确认原始期间。',evidence_ids:[]}]};
  assert.equal(validate(value),false,'the model-facing schema must reject the exact identifier mix-up observed in the real pilot');
  value.checks[0].affected_item_ids=['E2'];assert.equal(validate(value),true);
});
test('model-facing metadata pointers reject the missing slash seen in real axis repairs',()=>{
  const schema=scoreAgent.profiles['axis-a'].submissionSchema as any;
  const validate=new Ajv2020({strict:false}).compile(schema.$defs.host_basis);
  const value={rule_id:'no_public_or_observed_trigger',pointer:'public_requirements',value:{question:'题目'}};
  assert.equal(validate(value),false);
  value.pointer='/public_requirements';assert.equal(validate(value),true);
  value.pointer='/candidate_private_rules';assert.equal(validate(value),false);
});
test('recovered process defects need not lower a complete final answer',()=>{
  const value=structuredClone(originalResult) as ScoreResult;
  const context=request(value.evidence),source=context.sources.case.value as any;
  source.task_question=source.evidence.Q='计算收入从100增至120的增长率。';source.public_requirements={question:source.task_question};
  value.evidence[0]={...value.evidence[0],quote:source.evidence.Q,end:Array.from(source.evidence.Q).length};
  source.evidence.C001='初次将100误读为110并计算9.09%，随后改回100并正确复算20%。';
  value.evidence.push({evidence_id:'process',source_id:'C001',start:0,end:Array.from(source.evidence.C001).length,quote:source.evidence.C001});
  for(const row of value.evaluations)if(row.status==='violated')Object.assign(row,{status:'met',score:4,grade:'全部必要要求满足'});
  for(const row of value.diagnostics)if(row.status==='violated')row.status='met';
  Object.assign(value.evaluations.find(r=>r.item_id==='E2')!,{status:'violated',score:3,grade:'核心成立且有非关键局部缺陷',reason:'初次抽错输入，后续已完整恢复。',evidence_ids:['process']});
  Object.assign(value.diagnostics.find(r=>r.diagnostic_id==='E03')!,{status:'violated',reason:'初次误读100，后续更正。',evidence_ids:['process']});
  value.findings=[{finding_id:'process',affected_item_ids:['E2'],description:'初次将收入100误读为110；随后已更正并重算最终交付。',component:'candidate_output',attribution:'established',primary_diagnostic_id:'E03',diagnostic_ids:['E03'],evidence_ids:['process']}];
  value.final_answer_score={status:'met',grade:'全部满足',score:10,score_range:null,reason:'最终20%及必要依据完整正确，早先抽取错误已恢复。',evidence_ids:['EV_1','EV_2','process'],finding_ids:[]};
  scoreProfile.validate!(context,value,audit());assert.equal(value.evaluations.find(r=>r.item_id==='E2')!.score,3);
});
test('semantic repair requests preserve the conflict for the workflow gate and empty material retains its exception',()=>{
  const context=request([]);(context.sources.score.value as any).repair_used=true;
  const repair={action:'repair',reason:'同一事实的相反确定判断仍然存在。',axis_ids:['T','E'],verification_requests:[]};
  assert.deepEqual(scoreProfile.resolve!(context,repair,audit()),repair);
  const empty=request([]);(empty.sources.case.value as any).evidence.A='';
  const result=scoreAgent.profiles.evidence.resolve!(empty,{assessment_status:'host_empty_response',reason:'完整捕获的空答。',missing_material:[],affected_units:[]},audit());
  assert.deepEqual(result,{case_id:originalCase.case_id,assessment_status:'host_empty_response',reason:'完整捕获的空答。',missing_material:[],affected_units:[]});
});
test('after supplementation the final profile requires an axis repair instead of a second evidence request',()=>{
  const context=request([]);(context.sources.score.value as any).evidence_used=true;
  const repair={action:'repair',reason:'已补查仍缺正文，轴判词却将标题视为确证，需重评确定性。',axis_ids:['E','A'],verification_requests:[{claim:'确认产品状态',affected_item_ids:['E1']}]};
  const validate=new Ajv2020({strict:false}).compile(scoreProfile.modelSubmissionSchema!(context));
  assert.equal(validate(repair),false,'the same repeated supplement observed in the pilot must be rejected as an invalid submission');
  assert.throws(()=>scoreProfile.resolve!(context,repair,audit()),/verification_requests必须为空/);
  const directed={...repair,verification_requests:[]};assert.equal(validate(directed),true);
  assert.deepEqual(scoreProfile.resolve!(context,directed,audit()),directed);
});
