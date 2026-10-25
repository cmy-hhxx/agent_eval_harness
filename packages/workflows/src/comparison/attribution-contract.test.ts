import test from 'node:test';
import assert from 'node:assert/strict';
import {Ajv2020} from 'ajv/dist/2020.js';
import type {PlannedTask,SubmissionReceipt,RunState,JsonObject} from '@eval/contracts';
import {emptyUsage} from '@eval/contracts';
import {attributionProfile} from '@eval/agents/attribution';
import {attributionResult,emptyAudit,fakeJudge,fakeEvaluatorVersion} from '../../../../tests/fixtures/comparison.js';
import {comparisonAttribution} from './comparison-attribution.js';
import {attributionRow,stageResult,originalResultRow,encodeResult} from './results.js';
import {comparisonCodec} from './codec.js';
import {caseResultView} from './dashboard-view.js';
import {attributionSlots,polishAttribution} from './commentary.js';
import {acceptedAttributionView} from './accepted-attribution.js';
import {groupObservations} from './observations.js';
const keys=['meta','summary','Problem','has_standard_answer','is_correct','correct_reason'].sort();
function fixture(){
 const value=attributionResult(false,'2+2=5',true),task={id:'attribution-task',stage:'attribution',inputIds:{answer:value.meta.input_id},dependencies:{criteria:'criteria-task'},
  data:{stage:'attribution',candidates:{A:{input_id:value.meta.input_id,batch_id:'b1',case_id:'q1',version:'v1',source:'/source.jsonl',line:1}}}} as unknown as PlannedTask;
 const receipt={taskId:task.id,submissionId:'submission',status:'succeeded',evaluation:value,evaluatorVersion:fakeEvaluatorVersion,judge:fakeJudge,audit:emptyAudit(),usage:emptyUsage(),acceptedAt:1} as SubmissionReceipt;
 return {value,task,receipt};
}
test('formal attribution export has exactly six fields and its identity is in meta',()=>{
 const {task,receipt}=fixture(),row=attributionRow(task,receipt,'run-1');
 assert.deepEqual(Object.keys(row).sort(),keys);assert.equal((row.meta as JsonObject).run_id,'run-1');assert.equal((row.meta as JsonObject).task_id,task.id);
 assert(new Ajv2020({strict:false}).compile(attributionProfile.resultSchema!)(row));
 assert.equal(comparisonCodec.resultId(row),task.id);assert.deepEqual(stageResult('attribution',row),row);
 const state={manifest:{runId:'run-1',tasks:[task]},receipts:{[task.id]:receipt}} as unknown as RunState;
 assert.deepEqual(encodeResult(task,state,{}).row,row);
});
test('polish metadata and dashboard preserve the six-field contract and problem path',()=>{
 const {task,receipt,value}=fixture(),row=attributionRow(task,receipt,'run-1');
 (row.meta as JsonObject).rewritten={evaluator_version:'rewrite',rewrites:[{id:'Problem.0.reason',text:'有效改写。'}]};
 const shown=caseResultView('attribution',row)!;assert.deepEqual(Object.keys(shown).sort(),keys);
 const rewritten=(shown.meta as JsonObject).rewritten as {rewrites:{path:string}[]};assert.equal(rewritten.rewrites[0].path,'Problem.0.reason');
 assert(!Object.hasOwn(originalResultRow('attribution',row).meta as JsonObject,'rewritten'));
 const slots=attributionSlots(value);assert.deepEqual(slots.map(item=>item.id),['summary','correct_reason','Problem.0.text','Problem.0.reason']);
 const polished=polishAttribution(value,{'Problem.0.reason':'有效改写。'});assert.equal(polished.Problem[0].reason,'有效改写。');assert.deepEqual(polished.Problem[0].evidence,value.Problem[0].evidence);assert(!Object.hasOwn(polished.Problem[0],'responsibility_boundary'));
});
test('comparison projection preserves problem facts and excludes private responsibility',()=>{
 const {value}=fixture(),projection=comparisonAttribution(value);
 assert.deepEqual(projection.Problem[0].evidence,value.Problem[0].evidence.map(({purposes,...e})=>e));assert.equal(projection.Problem[0].problem_id,'p1');
 assert.deepEqual(Object.keys(projection).sort(),['Problem','correct_reason','has_standard_answer','is_correct','summary']);
 assert(!Object.hasOwn(projection.Problem[0],'responsibility_boundary'));
});
test('accepted evidence cannot be replaced by equal-looking foreign or modified source text',()=>{
 const {value,receipt}=fixture();const request={input:{},sources:{answer:{id:String(value.meta.input_id),value:{messages:[{role:'user',content:'计算2+2'},{role:'assistant',content:'2+2=5'}]}}}};
 assert.deepEqual(acceptedAttributionView(receipt,request),value);
 request.sources.answer.value.messages[1].content='2+2=4';assert.throws(()=>acceptedAttributionView(receipt,request));
});
test('clustering projection keeps current problem judgment without classification questionnaires',()=>{
 const {value}=fixture();Object.assign(value.Problem[0],{component:'计算节点',attribution_reason:'实际输入输出存在差异。',uncertainties:['内部过程未采集。']});
 const rows=groupObservations([{input_id:String(value.meta.input_id),case_id:'q1',source:{file:'source',line:1},Problem:value.Problem}]);
 assert.equal(rows.length,1);assert.equal(rows[0].label,value.Problem[0].text);assert.equal(rows[0].definition,value.Problem[0].reason);assert.equal(rows[0].refs[0].finding_id,'p1');
 assert(!Object.hasOwn(rows[0].examples[0],'dimension'));assert(!Object.hasOwn(rows[0].examples[0],'importance'));
});
