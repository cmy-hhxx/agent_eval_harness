import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceScore,scoreEvidenceTask,bindScore,scoreBlockedReason} from './score.js';
import type {SubmissionReceipt,RunState,ReviewAudit} from '@eval/contracts';
import type {Candidate} from '@eval/workflows/comparison';
const candidate={input_id:'input',case_id:'case',batch_id:'batch'} as Candidate;
const receipt=(evaluation:unknown,review?:ReviewAudit)=>({evaluation,audit:{review}} as SubmissionReceipt);
test('Score expands only after evidence acceptance and all six peers depend only on that same snapshot',()=>{
  const first=scoreEvidenceTask(candidate),next=advanceScore(first,receipt({facts:[],unresolved:[],changed_item_ids:[]}),{} as RunState,{}).tasks;
  assert.equal(next.length,7);
  for(const axis of next.slice(0,6))assert.deepEqual(axis.dependencies,{evidence:first.id});
  const final=next[6];assert.equal(Object.keys(final.dependencies).length,7);
  const repaired=advanceScore(final,receipt({action:'repair',reason:'同一事实的相反判定。',axis_ids:['E','L'],verification_requests:[]}),{} as RunState,{}).tasks;
  assert.equal(repaired.length,3);assert.equal(repaired[2].dependencies.T,final.dependencies.T);
  assert.notEqual(repaired[2].dependencies.E,final.dependencies.E);
  assert.equal((repaired[2].data as any).score_repair_used,true);
  const repeated=receipt({action:'repair',reason:'仍矛盾',axis_ids:['E'],verification_requests:[]});
  const rejected=advanceScore(repaired[2],repeated,{} as RunState,{}).tasks[0];
  assert.match(scoreBlockedReason(rejected,{source:repeated})!,/拒收评分：仍矛盾/);
});
test('late evidence is supplemented once with the original cumulative proof and rescoring uses the new snapshot',()=>{
  const first=scoreEvidenceTask(candidate),final=advanceScore(first,receipt({facts:[],unresolved:[],changed_item_ids:[]}),{} as RunState,{}).tasks[6];
  const correction=receipt({action:'repair',reason:'缺关键事实',axis_ids:[],verification_requests:[{claim:'确认期间',affected_item_ids:['E1']}]});
  const evidence=advanceScore(final,correction,{} as RunState,{}).tasks[0];assert.equal((evidence.data as any).score_evidence_used,true);
  const proof:ReviewAudit={quotes:[],sources:[],actions:[{kind:'search',args:{query:'已有请求'},at:'test'}],viewed:[],searches:[]};
  const source={case_id:'input',task_question:'题目',candidate_output_id:'A',evidence:{Q:'题目',A:'回答'},availability:{candidate_output:'available' as const},public_requirements:{question:'题目'},view:{case_id:'input',task_question:'题目',availability:{candidate_output:'available'}}};
  const binding=bindScore(evidence,source,{evidence:receipt({facts:[],unresolved:[],changed_item_ids:[]},proof),feedback:correction});
  assert.deepEqual((binding.request.sources.case.value as any).review_seed.actions,proof.actions);
  const rescored=advanceScore(evidence,receipt({facts:[{affected_item_ids:['E1'],evidence_ids:['EV_1']}],unresolved:[],changed_item_ids:['E1']}),{} as RunState,{}).tasks;
  assert.equal(rescored.length,2);assert.equal((rescored[0].data as any).score_axis,'E');
  const directed=advanceScore(rescored[1],receipt({action:'repair',reason:'补查后仍有确定性矛盾',axis_ids:['E'],verification_requests:[]}),{} as RunState,{}).tasks;
  assert.equal(directed.length,2);assert.equal((directed[1].data as any).score_evidence_used,true);assert.equal((directed[1].data as any).score_repair_used,true);
});
test('final material preserves verification evidence coordinates when axes quote a different order and reuse local IDs',()=>{
  const seed:ReviewAudit={quotes:[{evidence_id:'EV_1',source_id:'Q',start:0,end:2,quote:'题目'},{evidence_id:'EV_2',source_id:'A',start:0,end:2,quote:'答案'}],sources:[],actions:[],viewed:[],searches:[]};
  const facts=[{affected_item_ids:['T1'],evidence_ids:['EV_1']}];
  const first=scoreEvidenceTask(candidate),final=advanceScore(first,receipt({facts,unresolved:[],changed_item_ids:['T1']}),{} as RunState,{}).tasks[6];
  const dependencies:Record<string,SubmissionReceipt>={evidence:receipt({facts,unresolved:[],changed_item_ids:['T1']},seed)};
  for(const axis of ['T','E','L','A','U','D']){
    const extra=axis==='E'?{evidence_id:'EV_3',source_id:'P',start:0,end:2,quote:'过程'}:axis==='L'?{evidence_id:'EV_3',source_id:'P',start:2,end:4,quote:'后续'}:undefined;
    dependencies[axis]=receipt({case_id:'input',evaluations:[{item_id:axis+'1',reason:extra?'引用EV_3':'引用EV_2',evidence_ids:extra?['EV_2','EV_3']:['EV_2']}],diagnostics:[],findings:[],verification_requests:[],evidence:[seed.quotes[1],...(extra?[extra]:[])]});
  }
  const source={case_id:'input',task_question:'题目',candidate_output_id:'A',evidence:{Q:'题目',A:'答案',P:'过程后续'},availability:{candidate_output:'available' as const},public_requirements:{question:'题目'},view:{case_id:'input',task_question:'题目',availability:{candidate_output:'available'}}};
  const binding=bindScore(final,source,dependencies),quotes=(binding.request.sources.case.value as any).review_seed.quotes as ReviewAudit['quotes'];
  for(const initial of seed.quotes)assert.deepEqual(quotes.find(q=>q.evidence_id===initial.evidence_id),initial,'verification references must keep the exact original source span');
  const axes=(binding.request.sources.score.value as any).axes;
  assert.equal(axes[1].evaluations[0].evidence_ids[1],'EV_3');
  assert.equal(axes[2].evaluations[0].evidence_ids[1],'EV_4');
  assert.equal(axes[2].evaluations[0].reason,'引用EV_4');
  assert.deepEqual(quotes.map(q=>q.quote),['题目','答案','过程','后续']);
});
test('supplementation reuses unaffected axes and no new facts do not replay six judgments',()=>{
  const first=scoreEvidenceTask(candidate),initial=receipt({facts:[],unresolved:[],changed_item_ids:[]});
  const final=advanceScore(first,initial,{} as RunState,{}).tasks[6];
  const correction=receipt({action:'repair',reason:'核对一项期间',axis_ids:[],verification_requests:[{claim:'期间',affected_item_ids:['E1']}]});
  const supplement=advanceScore(final,correction,{} as RunState,{}).tasks[0];
  const unchanged=advanceScore(supplement,receipt({facts:[],unresolved:[{claim:'未取得资料',affected_item_ids:['E1']}],changed_item_ids:[]}),{} as RunState,{}).tasks;
  assert.equal(unchanged.length,1);assert.equal((unchanged[0].data as any).score_part,'final');
  for(const axis of ['T','E','L','A','U','D'])assert.equal(unchanged[0].dependencies[axis],final.dependencies[axis]);
  const changed=advanceScore(supplement,receipt({facts:[],unresolved:[],changed_item_ids:['E1','U2']}),{} as RunState,{}).tasks;
  assert.deepEqual(changed.slice(0,-1).map(t=>(t.data as any).score_axis),['E','U']);
  assert.equal(changed.at(-1)!.dependencies.T,final.dependencies.T);
  const broad=advanceScore(supplement,receipt({facts:[],unresolved:[],changed_item_ids:['E1'],full_rescore_reason:'同一来源同时改变任务对象和所有事实依据，影响无法隔离。'}),{} as RunState,{}).tasks;
  assert.equal(broad.length,7);
});
test('source catalog is lazy while full provenance remains available to tools',()=>{
  const large='长来源'.repeat(10000),first=scoreEvidenceTask(candidate);
  const proof:ReviewAudit={quotes:[],sources:[{id:'V_SRC_1',content:large,record:{record_type:'external_source',url:'https://example.com',response:{content:large}}}],actions:[],viewed:[],searches:[]};
  const next=advanceScore(first,receipt({facts:[],unresolved:[],changed_item_ids:[]},proof),{} as RunState,{}).tasks[0];
  const source={case_id:'input',task_question:'题目',candidate_output_id:'A',evidence:{Q:'题目',A:'回答'},availability:{candidate_output:'available' as const},public_requirements:{question:'题目'},view:{}};
  const binding=bindScore(next,source,{evidence:receipt({facts:[],unresolved:[],changed_item_ids:[]},proof)});
  assert(!JSON.stringify(binding.request.input).includes(large));
  assert.equal((binding.request.sources.case.value as any).review_seed.sources[0].content,large);
});
