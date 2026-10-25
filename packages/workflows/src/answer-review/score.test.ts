import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentRegistry} from '@eval/host';
import {ValidationError,type SubmissionReceipt} from '@eval/contracts';
import {scoreAgent,type ScoreResult} from '@eval/agents/score';
import type {Candidate} from '@eval/workflows/inputs';
import example from '../../../agents/src/attribution/fixtures/example.json' with {type:'json'};
import {scoreTask,bindScore} from './score.js';
import {scoreSubmission} from '../../../../tests/fixtures/score-submission.js';
import {emptyAudit} from '../../../../tests/fixtures/comparison.js';
import {responsibilityFixture} from '../../../../tests/fixtures/responsibility.js';

function fixture(problem=false,recovered=false){
  const attribution=structuredClone(example.result) as any;
  if(problem){const finding=attribution.findings[0];finding.type='problem';finding.stage=recovered?'execution':'final_answer';
    finding.text=recovered?'取数失败后已重试恢复。':'最终回答仍有已确认的非核心展示缺陷。';
    finding.assessment.impact=recovered?'已经恢复，最终结果完整正确。':'最终交付存在局部展示缺陷，核心数值仍可用。';
    finding.problem={diagnosis:'other',investigation:[],component:[responsibilityFixture()],label:'本条缺陷',definition:finding.text};}
  const receipt={taskId:'attribution',evaluatorVersion:'test',evaluation:attribution} as SubmissionReceipt;
  const raw=structuredClone(example.request.sources.answer.value),candidate={input_id:'case',question:String(raw.messages[0].content),final_index:1} as unknown as Candidate;
  const task=scoreTask(candidate,receipt.taskId),binding=bindScore(task,raw,{attribution:receipt}),registry=new AgentRegistry([scoreAgent]);
  return {task,binding,registry,receipt,draft:scoreSubmission(binding.request.input),audit:emptyAudit()};
}
test('one score task depends on accepted attribution and exposes only native submission',()=>{
  const f=fixture(),prepared=f.registry.prepare(f.binding);
  assert.deepEqual(f.task.dependencies,{attribution:'attribution'});
  assert.deepEqual(prepared.evaluation.toolNames,[]);assert.equal(prepared.evaluation.fileSubmission,false);
  assert.deepEqual(Object.keys(scoreAgent.profiles),['default']);
  const result=f.registry.resolve(f.binding,f.draft,f.audit) as ScoreResult;
  assert.equal(result.evaluations.length,12);assert.equal(result.diagnostics.length,24);assert.equal(result.final_answer_score.score,10);
});
test('score cannot run without an accepted attribution receipt',()=>{
  const f=fixture();assert.throws(()=>bindScore(f.task,{messages:[]},{}),/归因/);
});
test('source final defects prevent full marks even when attribution says the core is usable',()=>{
  const f=fixture(true),before=structuredClone(f.receipt.evaluation);
  assert.equal((f.receipt.evaluation as any).core_assessment.meets_core,true);
  f.draft.problem_assignments[0].final_delivery_affected=false;
  assert.throws(()=>f.registry.resolve(f.binding,f.draft,f.audit),ValidationError);
  f.draft.problem_assignments[0].final_delivery_affected=true;
  const result=f.registry.resolve(f.binding,f.draft,f.audit) as ScoreResult;
  assert.equal(result.final_answer_score.score,9);assert.equal(result.findings[0].description,(before as any).findings[0].text);
  assert.deepEqual(f.receipt.evaluation,before);
});
test('recovered process defects stay in unit diagnostics and do not automatically reduce final delivery',()=>{
  const f=fixture(true,true),result=f.registry.resolve(f.binding,f.draft,f.audit) as ScoreResult;
  assert.equal(result.final_answer_score.score,10);assert.equal(result.findings.length,1);assert.deepEqual(result.final_answer_score.finding_ids,[]);
});
test('compact grading material excludes trace and the eight-step investigation',()=>{
  const f=fixture(),input=f.binding.request.input as any;
  assert(!JSON.stringify(input).includes('business_chains'));assert(!JSON.stringify(input).includes('investigation'));
  assert.equal(typeof input.candidate_answer,'string');assert(input.accepted_attribution.completion.length>0);
  const malformed={...f.draft,repair:{axis_ids:['T']}};
  assert.throws(()=>f.registry.resolve(f.binding,malformed,f.audit),ValidationError);
});
