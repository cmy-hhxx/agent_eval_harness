import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceId } from '@eval/tools';
import { projectEvidenceReferences, type AgentRequest } from '@eval/contracts';
import { AgentRegistry } from '@eval/host';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { comparisonText } from '@eval/prompts';
import { comparisonAgent, comparisonProfile, comparisonSlots, comparisonSlotChoices } from './index.js';
import example from './fixtures/example.json' with { type: 'json' };
import type { ComparisonInput, ComparisonSubmission, ComparisonResult } from './types.js';
const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const cells = (A: string, B: string) => ({ A: { summary: A, source_review: null as string | null }, B: { summary: B, source_review: null as string | null } });
function setup() {
 const request = structuredClone(example.request) as AgentRequest, input = request.input as unknown as ComparisonInput;
 const registry = new AgentRegistry([comparisonAgent]), binding = { agent: 'comparison', profile: 'default', request };
 const slots = comparisonSlots(request);
 const draft: ComparisonSubmission = { assessments: { A: { summary: 'A真实交付' }, B: { summary: 'B真实交付' } },
  comparisons: slots.map(() => ({ importance: 'medium', better_candidate: null, assessments: cells('核对A原文','核对B原文') })),
  preference: null, tradeoff: '双方核心状态决定判决。' };
 return { request, input, registry, binding, draft, slots };
}
test('program comparison slots supply every criterion and finding reference without copied IDs', () => {
 const f = setup();
 const result = f.registry.resolve(f.binding, f.draft, audit) as ComparisonResult;
 assert.equal(result.status, 'decided');
 assert.deepEqual(result.ranking, [['A','B']]);
 assert.deepEqual(result.decision_basis.comparisons.map(row => row.criterion_ids), f.slots.map(slot => slot.criterion_ids));
 assert.deepEqual(result.decision_basis.comparisons[0].assessments.A.finding_indices, [0]);
 assert.deepEqual(result.decision_basis.comparisons[0].assessments.B.finding_indices, [0]);
 assert(!JSON.stringify(f.draft).includes('criterion_ids'));
 assert.deepEqual(comparisonSlotChoices(f.request).map(slot => slot.slot_index), f.slots.map((_, index) => index));
 assert.deepEqual(comparisonSlotChoices(f.request)[0].applicable_candidates,['A','B']);
 assert.deepEqual(comparisonSlotChoices(f.request)[0].reviewable_candidates,['A','B']);
});
test('prepared per-slot advantage choices agree with established pair facts and retain business rejection', () => {
 for (const mode of ['one-sided','established','source-only','uncertain'] as const) {
  const f = setup();
  if (mode === 'one-sided') {
   f.input.attributions.A.findings[0].assessment.requirement_index = null;
   f.input.attributions.A.findings[0].type = 'problem';
   f.input.attributions.A.findings[0].importance = 'low';
   f.input.candidates.B.original_answer_timing.finish_seconds = 3;
  } else if (mode === 'source-only') {
   f.input.task_analysis.requirements[0].applies_to = [f.input.candidates.A.candidate_id];
   f.input.attributions.B.criterion_assessments[0].status = 'not_applicable';
   f.input.attributions.B.findings = [];
   for (const attr of Object.values(f.input.attributions)) attr.task_analysis = structuredClone(f.input.task_analysis);
  } else if (mode === 'uncertain') f.input.attributions.B.criterion_assessments[0].evidence_status = 'uncertain';
  const slots = comparisonSlots(f.request), index = mode === 'one-sided' ? slots.findIndex(slot => slot.kind === 'finding') : 0;
  f.draft.comparisons = slots.map(() => ({ importance:'low',better_candidate:null,assessments:cells('核查本方实际事实','核查本方实际事实') }));
  const prepared = f.registry.prepare({ ...f.binding, projectModelInput:projectEvidenceReferences });
  const validate = new Ajv2020({ strict:false,allErrors:true }).compile(prepared.evaluation.outputSchema);
  const eligible = mode === 'established';
  for (const candidate of ['A','B'] as const) {
   f.draft.comparisons[index]!.better_candidate = candidate;
   assert.equal(validate(f.draft),eligible,`${mode}: schema must expose only source-qualified choices`);
   if (eligible) {
    const result = f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
    f.registry.validate(f.binding,result,audit);
    assert.deepEqual(result.decision_basis.comparisons[index].better_candidates,[candidate]);
   } else assert.throws(() => comparisonProfile.resolve!(f.request,f.draft,audit), /相对优势|共同适用/,
    'a caller bypassing the model schema still cannot manufacture an advantage');
  }
  assert.deepEqual(comparisonSlotChoices(f.request)[index].advantage_candidates,eligible ? ['A','B'] : []);
  f.draft.comparisons[index]!.better_candidate = null;
  assert.equal(validate(f.draft),true);
  const result = f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
  f.registry.validate(f.binding,result,audit);
  if (mode === 'one-sided') {
   const row = result.decision_basis.comparisons.find(row => !row.criterion_ids.length && row.assessments.A.finding_indices.length)!;
   assert.equal(row.assessments.B.status,'unknown','resource metrics cannot promote a missing counterpart finding');
  }
  f.draft.comparisons[index] = null;
  assert.equal(validate(f.draft),slots[index].optional,`${mode}: only optional slots allow a null row`);
 }
});
test('omitted empty comparison choices derive null without changing required business prose', () => {
 const f = setup(), expected = f.registry.resolve(f.binding,f.draft,audit);
 const draft = structuredClone(f.draft);
 delete draft.preference;
 for (const row of draft.comparisons) if (row) {
  delete row.better_candidate;
  for (const cell of Object.values(row.assessments)) delete cell.source_review;
 }
 const before = structuredClone(draft), result = f.registry.resolve(f.binding,draft,audit);
 f.registry.validate(f.binding,result,audit);
 assert.deepEqual(result,expected);
 assert.deepEqual(draft,before);
});
test('omitting empty choices preserves actual advantages and source reviews', () => {
 const f = setup();
 f.draft.comparisons[0]!.better_candidate='A';
 const expected = f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
 delete f.draft.preference;
 for (const row of f.draft.comparisons) if (row) {
  if (row.better_candidate === null) delete row.better_candidate;
  for (const cell of Object.values(row.assessments)) delete cell.source_review;
 }
 assert.deepEqual(f.registry.resolve(f.binding,f.draft,audit),expected);
 assert.deepEqual(expected.ranking,[['A'],['B']]);
 f.draft.comparisons[0]!.assessments.A.source_review='按本方实际交付复核来源结论。';
 const pending = f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
 f.registry.validate(f.binding,pending,audit);
 assert.equal(pending.status,'needs_review');
 assert.equal(pending.review_requests[0]!.reason,f.draft.comparisons[0]!.assessments.A.source_review);
});
test('optional empty choices never default required prose, importance or unknown fields', () => {
 for (const modify of [
  (draft:any) => { delete draft.tradeoff; },
  (draft:any) => { delete draft.assessments.A.summary; },
  (draft:any) => { delete draft.comparisons[0].importance; },
  (draft:any) => { delete draft.comparisons[0].assessments.B.summary; },
 ]) {
  const f = setup(); modify(f.draft);
  assert.throws(() => f.registry.resolve(f.binding,f.draft,audit),(error:any) => error.issues.some((issue:any) => issue.code==='schema_required'));
 }
 for (const [modify,code] of [
  [(draft:any) => { draft.comparisons[0].invented_choice=true; },'schema_additionalProperties'],
  [(draft:any) => { draft.comparisons[0].better_candidate='C'; },'schema_enum'],
  [(draft:any) => { draft.preference='C'; },'schema_enum'],
  [(draft:any) => { draft.comparisons[0].assessments.A.source_review=''; },'schema_minLength'],
 ] as const) {
  const f = setup(); modify(f.draft);
  assert.throws(() => f.registry.resolve(f.binding,f.draft,audit),(error:any) => error.issues.some((issue:any) => issue.code===code));
 }
});
test('criteria that apply to neither current candidate do not create comparison or review work', () => {
 const f = setup(), originalCount = f.slots.length;
 f.input.task_analysis.requirements.push({ id:'outside',text:'另一个产品的约束',applies_to:['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],acceptance_rule:'只评适用产品。' });
 for (const attr of Object.values(f.input.attributions)) {
  attr.task_analysis = structuredClone(f.input.task_analysis);
  attr.criterion_assessments.push(Object.assign(structuredClone(attr.criterion_assessments[0]!),
   { criterion_id:'outside',status:'not_applicable' as const,evidence_status:'established' as const,summary:'不适用。',evidence:[] }));
 }
 assert.equal(comparisonSlots(f.request).length,originalCount);
 assert(!comparisonSlots(f.request).some(slot => slot.criterion_ids.includes('outside')));
 const result = f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
 f.registry.validate(f.binding,result,audit); assert.equal(result.status,'decided');
});
test('missing slot returns one actionable shape failure rather than finding coverage cascade', () => {
 const f = setup(); f.draft.comparisons = [];
 assert.throws(() => f.registry.resolve(f.binding, f.draft, audit), (error: any) => {
  assert.equal(error.issues.length, 1); assert.equal(error.issues[0].code, 'schema_minItems'); return true;
 });
});
test('all independently missing required rows return together', () => {
 const f = setup();
 const criterion = { id:'second',text:'共同交付条件',applies_to:[],acceptance_rule:'保留真实交付条件。' };
 f.input.task_analysis.requirements.push(criterion);
 for (const attr of Object.values(f.input.attributions)) {
  attr.task_analysis = structuredClone(f.input.task_analysis);
  attr.criterion_assessments.push({...structuredClone(attr.criterion_assessments[0]!),criterion_id:criterion.id});
 }
 const slots = comparisonSlots(f.request);
 assert.equal(slots.length,2);
 assert(slots.every(slot => !slot.optional));
 f.draft.comparisons = [null,null];
 assert.throws(() => f.registry.resolve(f.binding,f.draft,audit),(error:any) => {
  assert.deepEqual(error.issues.map((issue:any) => [issue.code,issue.path]),[
   ['schema_type','/comparisons/0'],['schema_type','/comparisons/1'],
  ]); return true;
 });
});
test('one common medium advantage program owns ranking even when preference is null', () => {
 const f = setup(); f.draft.comparisons[0]!.better_candidate = 'A';
 const result = f.registry.resolve(f.binding, f.draft, audit) as ComparisonResult;
 assert.deepEqual(result.ranking, [['A'],['B']]);
});
test('resource advantages require the same valid metric on both candidates', () => {
 for (const mode of ['different-metrics','conflicted-tokens','shared-time','shared-tokens','shared-time-conflicted-tokens'] as const) {
  const f = setup();
  for (const candidate of Object.values(f.input.candidates)) {
   candidate.original_answer_timing.finish_seconds = null;
   candidate.original_answer_usage.total_tokens = null;
   candidate.original_answer_usage.issues = [];
  }
  if (mode === 'shared-tokens' || mode === 'conflicted-tokens') {
   f.input.candidates.A.original_answer_usage.total_tokens = 100;
   f.input.candidates.B.original_answer_usage.total_tokens = 1000;
   if (mode === 'conflicted-tokens') f.input.candidates.B.original_answer_usage.issues = ['统计冲突'];
  } else {
   f.input.candidates.A.original_answer_timing.finish_seconds = 10;
   if (mode === 'different-metrics') f.input.candidates.B.original_answer_usage.total_tokens = 1000;
   else f.input.candidates.B.original_answer_timing.finish_seconds = 100;
   if (mode === 'shared-time-conflicted-tokens') {
    f.input.candidates.B.original_answer_usage.total_tokens = 1000;
    f.input.candidates.B.original_answer_usage.issues = ['统计冲突'];
   }
  }
  const slots = comparisonSlots(f.request), index = slots.findIndex(slot => slot.kind === 'resource');
  const comparable = mode.startsWith('shared-');
  assert(index >= 0, 'a valid single-sided observation remains available for display');
  assert.deepEqual(comparisonSlotChoices(f.request)[index].advantage_candidates, comparable ? ['A','B'] : []);
  f.draft.comparisons = slots.map(() => ({ importance:'medium',better_candidate:null,assessments:cells('本方实际交付','本方实际交付') }));
  const neutral = f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
  f.registry.validate(f.binding,neutral,audit);
  assert.deepEqual(neutral.ranking,[['A','B']]);
  f.draft.comparisons[index]!.better_candidate = 'A';
  if (comparable) {
   const result = f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
   f.registry.validate(f.binding,result,audit);
   assert.deepEqual(result.ranking,[['A'],['B']]);
  } else {
   assert.throws(() => f.registry.resolve(f.binding,f.draft,audit),(error:any) =>
    error.issues.some((issue:any) => issue.code === 'schema_enum' && issue.path === `/comparisons/${index}/better_candidate`));
   assert.throws(() => comparisonProfile.resolve!(f.request,f.draft,audit), /资源须有双方同种有效指标/,
    'bypassing the prepared schema cannot manufacture a resource advantage');
   neutral.decision_basis.comparisons[index].better_candidates = ['A'];
   neutral.ranking = [['A'],['B']];
   assert.throws(() => f.registry.validate(f.binding,neutral,audit),(error:any) =>
    error.issues.some((issue:any) => issue.code === 'comparison_resource_incomparable'),
   'direct formal validation applies the same measurement guard');
  }
 }
});
test('full decision narratives survive public result validation while preference still requires an established advantage', () => {
 const f = setup(), baseline = f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
 const candidateSummary = '正确交付计算结果，并保留实际执行的依据和适用范围。'.repeat(12);
 const cellSummary = '双方均给出数值4，同一共同要求的既有事实已确认，未见可改变本项结论的实质差异。'.repeat(8);
 const tradeoff = '双方核心结果均可用，原材料与既有事实没有证明中高重要性的单方优势，因此保留同层结论。'.repeat(5);
 for (const label of ['A','B'] as const) {
  f.draft.assessments[label].summary = candidateSummary;
  f.draft.comparisons[0]!.assessments[label].summary = cellSummary;
 }
 f.draft.tradeoff = tradeoff;
 const before = structuredClone(f.draft), result = f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
 f.registry.validate(f.binding,result,audit);
 for (const label of ['A','B'] as const) {
  assert.equal(result.assessments[label].summary,candidateSummary);
  assert.equal(result.decision_basis.comparisons[0].assessments[label].summary,cellSummary);
 }
 assert.equal(result.decision_basis.tradeoff,tradeoff);
 assert.deepEqual(result.ranking,baseline.ranking);
 assert.deepEqual(result.decision_basis.decisive_findings,baseline.decision_basis.decisive_findings);
 assert.deepEqual(f.draft,before);
 f.draft.preference = 'A';
 assert.throws(() => f.registry.resolve(f.binding,f.draft,audit),(error:any) =>
  error.issues.some((issue:any) => issue.code === 'preference_unproven'));
});
test('actual answer contradicting an inherited met assessment becomes pending through its fixed cell', () => {
 const f = setup(), before = structuredClone(f.input.attributions);
 (f.request.sources.A.value as { messages: { content: string }[] }).messages[1].content = '2+2=5';
 const row = f.draft.comparisons[0]!;
 row.assessments.A.summary = '实际回答为2+2=5，与既有核心正确判定冲突。';
 row.assessments.A.source_review = '实际回答的算术结论不成立，请复核既有核心正确判定。';
 f.draft.preference = 'B';
 const pending = f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
 f.registry.validate(f.binding,pending,audit);
 assert.equal(pending.status,'needs_review'); assert.deepEqual(pending.ranking,[]);
 assert.equal(pending.assessments.A.meets_core,null);
 assert.deepEqual(pending.review_requests,[{ candidate:'A',criterion_ids:['sum'],finding_indices:[0],reason:row.assessments.A.source_review }]);
 assert.deepEqual(f.input.attributions,before,'Comparison preserves the existing attribution while requesting its owner to review');
 assert(!Object.hasOwn(f.draft,'review_requests'));
});
test('a source review cannot rewrite attribution for a resource ranking dispute', () => {
 const f = setup(); f.input.candidates.A.original_answer_timing.finish_seconds = 20;
 f.draft.comparisons = comparisonSlots(f.request).map(() => ({ importance:'medium',better_candidate:null,assessments:cells('A原文。','B原文。') }));
 const index = comparisonSlots(f.request).findIndex(slot => slot.kind === 'resource');
 assert.deepEqual(comparisonSlotChoices(f.request)[index].reviewable_candidates,[]);
 f.draft.comparisons[index]!.assessments.A.source_review = '耗时较长，请修改来源核心判定。';
 assert.throws(() => f.registry.resolve(f.binding,f.draft,audit),(error:any) => {
  assert.equal(error.issues[0].code,'review_slot_invalid');
  assert.equal(error.issues[0].path,`/comparisons/${index}/assessments/A/source_review`); return true;
 });
});
test('all independently invalid source review cells are reported in one repair', () => {
 const f = setup();
 f.input.task_analysis.requirements[0].applies_to = [f.input.candidates.A.candidate_id];
 f.input.attributions.B.criterion_assessments[0]!.status = 'not_applicable';
 f.input.attributions.B.findings = [];
 for (const attr of Object.values(f.input.attributions)) attr.task_analysis = structuredClone(f.input.task_analysis);
 f.input.candidates.A.original_answer_timing.finish_seconds = 20;
 f.draft.comparisons = comparisonSlots(f.request).map(() => ({ importance:'medium',better_candidate:null,assessments:cells('A实际回答','B实际回答') }));
 f.draft.comparisons[0]!.assessments.B.source_review = '错误借用另一方规范。';
 const index = comparisonSlots(f.request).findIndex(slot => slot.kind === 'resource');
 f.draft.comparisons[index]!.assessments.A.source_review = '用耗时改来源结论。';
 f.draft.comparisons[index]!.assessments.B.source_review = '用用量改来源结论。';
 assert.throws(() => f.registry.resolve(f.binding,f.draft,audit),(error:any) => {
  assert.deepEqual(error.issues.map((issue:any) => [issue.code,issue.path]), [
   ['review_slot_scope','/comparisons/0/assessments/B/source_review'],
   ['review_slot_invalid',`/comparisons/${index}/assessments/A/source_review`],
   ['review_slot_invalid',`/comparisons/${index}/assessments/B/source_review`],
  ]); return true;
 });
});
test('an unrelated schema failure cannot defer independently known review scope errors', () => {
 const f = setup();
 f.input.candidates.A.original_answer_timing.finish_seconds = 20;
 f.draft.comparisons = comparisonSlots(f.request).map(() => ({ importance:'medium',better_candidate:null,assessments:cells('A实际回答','B实际回答') }));
 const index = comparisonSlots(f.request).findIndex(slot => slot.kind === 'resource');
 f.draft.comparisons[index]!.assessments.A.source_review = '用耗时改来源结论。';
 f.draft.comparisons[index]!.assessments.B.source_review = '用用量改来源结论。';
 f.draft.tradeoff = 7 as unknown as string;
 assert.throws(() => f.registry.resolve(f.binding,f.draft,audit),(error:any) => {
  assert(error.issues.some((issue:any) => issue.code === 'schema_type'));
  assert.deepEqual(error.issues.filter((issue:any) => issue.code === 'review_slot_invalid').map((issue:any) => issue.path),[
   `/comparisons/${index}/assessments/A/source_review`,`/comparisons/${index}/assessments/B/source_review`,
  ]); return true;
 });
});
test('private instruction slot cannot become a shared advantage', () => {
 const f = setup();
 f.input.task_analysis.requirements[0].applies_to = [f.input.candidates.A.candidate_id];
 for (const attr of Object.values(f.input.attributions)) attr.task_analysis = structuredClone(f.input.task_analysis);
 f.input.attributions.B.criterion_assessments[0].status = 'not_applicable';
 const slots = comparisonSlots(f.request); f.draft.comparisons = slots.map(() => ({ importance: 'medium', better_candidate: null,
  assessments: cells('仅A私规','未提供同等规范') }));
 f.draft.comparisons[0]!.better_candidate = 'A';
 assert.throws(() => f.registry.resolve(f.binding, f.draft, audit),(error:any) =>
  error.issues.some((issue:any) => issue.code === 'schema_enum' && issue.path === '/comparisons/0/better_candidate'));
});
test('unmatched blind concern automatically becomes source review without copied status or reason', () => {
 const f = setup(), input = f.input as any;
 input.comparison_draft = f.registry.resolve(f.binding, f.draft, audit);
 (f.request.sources.A.value as { messages: { content: string }[] }).messages[1].content = '2+2=5';
 const verification = { agent: 'comparison', profile: 'verification', request: f.request,
  projectModelInput: projectEvidenceReferences, modelInput: { original: 'blind' }, inspectionInput: { draft: 'revealed' } };
 for (const [label, material] of Object.entries(input.candidates) as [string,any][]) f.request.sources[label].id = material.candidate_id;
 const checks = ['A','B'].map(candidate => ({ candidate, criterion_id: 'sum',
  result: candidate === 'A' ? 'contradicted' : 'supported', source_evidence: [],
  observation: candidate === 'A' ? '实际答案与来源结论冲突' : '实际交付算术正确',
  answer_evidence: [{ evidence_id: evidenceId(input.candidates[candidate].candidate_id, 1, 'text', '/content', 0, 5) }] }));
 const inspection = { checks, concerns: [{ candidate: 'A', criterion_ids: ['sum'], reason: '实际答案与来源结论冲突',
  answer_evidence: checks[0].answer_evidence, source_evidence: [] }] };
 const reads = { ...audit, inspection: { id: 'inspection', value: inspection, proof: { traceReads: [], viewedImages: [] } } };
 const result = f.registry.resolve(verification, { concern_matches: [], concern_refutations: [], source_reviews: [] }, reads) as ComparisonResult;
 assert.equal(result.status, 'needs_review');
 assert.deepEqual(result.review_requests, [{ candidate: 'A', criterion_ids: ['sum'], finding_indices: [], reason: '实际答案与来源结论冲突' }]);
 f.registry.validate(verification, result, reads);
 input.comparison_draft = result;
 const again = f.registry.resolve(verification, { concern_matches: [], concern_refutations: [], source_reviews: [] }, reads) as ComparisonResult;
 assert.deepEqual(again.review_requests, result.review_requests);
});
test('an unbound strength cannot infer counterpart absence from a missing finding', () => {
 const f = setup();
 f.input.attributions.A.findings[0].assessment.requirement_index = null;
 f.input.attributions.A.findings[0].text = '补充了解释过程';
 (f.request.sources.A.value as {messages:{content:string}[]}).messages[1].content = '2+2=4，附解释过程';
 (f.request.sources.B.value as {messages:{content:string}[]}).messages[1].content = '2+2=4，附解释过程';
 const slots = comparisonSlots(f.request), index = slots.findIndex(slot => slot.kind === 'finding');
 f.draft.comparisons = slots.map(slot => slot.optional ? null : ({ importance: 'medium', better_candidate: null,
  assessments: cells('提供解释过程','也提供解释过程，未有同名finding') }));
 f.draft.comparisons[index]!.better_candidate = 'A';
 assert.throws(() => f.registry.resolve(f.binding,f.draft,audit),(error:any) =>
  error.issues.some((issue:any) => issue.code === 'schema_enum' && issue.path === `/comparisons/${index}/better_candidate`));
 f.draft.comparisons[index]!.better_candidate = null;
 const retained = f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
 f.registry.validate(f.binding,retained,audit);
 const row = retained.decision_basis.comparisons.find(row => row.assessments.A.finding_indices.includes(0) && !row.criterion_ids.length)!;
 assert.deepEqual(row.assessments.A.finding_indices,[0]);
 assert.equal(row.assessments.B.status,'unknown'); assert.equal(row.assessments.B.evidence_status,'uncertain');
});
test('a private criterion without mandatory findings is optional but remains selectable for source review', () => {
 const f = setup(), privateCriterion = { id: 'own', text: '本方交付约束', acceptance_rule: '仅评审A自己的交付。', applies_to: [f.input.candidates.A.candidate_id] };
 f.input.task_analysis.requirements.push(privateCriterion);
 for (const attr of Object.values(f.input.attributions)) attr.task_analysis = structuredClone(f.input.task_analysis);
 f.input.attributions.A.criterion_assessments.push({ ...structuredClone(f.input.attributions.A.criterion_assessments[0]!), criterion_id: 'own', status: 'met', evidence_status: 'established', summary: '本方遵循。' });
 f.input.attributions.B.criterion_assessments.push({ ...structuredClone(f.input.attributions.B.criterion_assessments[0]!), criterion_id: 'own', status: 'not_applicable', evidence_status: 'established', summary: '本方无此规范。' });
 const slots = comparisonSlots(f.request), privateIndex = slots.findIndex(slot => slot.criterion_ids.includes('own'));
 assert.equal(slots[privateIndex]!.optional,true);
 f.draft.comparisons = slots.map(slot => slot.optional ? null : { importance: 'medium', better_candidate: null, assessments: cells('A实际交付。','B实际交付。') });
 const decided = f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
 f.registry.validate(f.binding,decided,audit); assert(!decided.decision_basis.comparisons.some(row => row.criterion_ids.includes('own')));
 const reviewDraft = structuredClone(f.draft);
 reviewDraft.comparisons[privateIndex] = { importance: 'low', better_candidate: null, assessments: cells('本方规范需要核查。','本方未提供此规范。') };
 reviewDraft.comparisons[privateIndex]!.assessments.A.source_review = '需要核查本方交付规范的真实遵循情况。';
 assert.deepEqual(comparisonSlotChoices(f.request)[privateIndex].applicable_candidates,['A']);
 const pending = f.registry.resolve(f.binding,reviewDraft,audit) as ComparisonResult;
 assert.equal(pending.status,'needs_review'); assert.deepEqual(pending.review_requests[0]!.criterion_ids,['own']);
 reviewDraft.comparisons[privateIndex]!.assessments.A.source_review = null;
 reviewDraft.comparisons[privateIndex]!.assessments.B.source_review = '将A的私规用于B。';
 assert.throws(() => f.registry.resolve(f.binding,reviewDraft,audit),(error:any) => error.issues[0].code==='review_slot_scope');
 reviewDraft.comparisons[privateIndex]!.assessments.B.source_review = null;
 reviewDraft.comparisons[privateIndex]!.assessments.B.summary = 'B已满足A的私有条款。';
 const scoped = f.registry.resolve(f.binding,reviewDraft,audit) as ComparisonResult;
 const privateRow = scoped.decision_basis.comparisons.find(row => row.criterion_ids.includes('own'))!;
 assert.equal(privateRow.assessments.B.status,'not_applicable');
 assert.equal(privateRow.assessments.B.summary,comparisonText('not_applicable'));
 f.input.attributions.A.findings.push({ ...structuredClone(f.input.attributions.A.findings[0]!), dimension: 'instruction_following', assessment:{...f.input.attributions.A.findings[0]!.assessment,requirement_index:1} });
 assert.equal(comparisonSlots(f.request)[privateIndex]!.optional,false);
 assert.throws(() => f.registry.resolve(f.binding,f.draft,audit),(error:any) => error.issues[0].code==='schema_type');
});
test('all independent invalid advantages return their actual model row paths before ranking feedback', () => {
 const f = setup();
 f.input.task_analysis.scoring_points.push({ id:'unknown',text:'共同附加交付',applies_to:[],acceptance_rule:'原文核查。' });
 for (const attr of Object.values(f.input.attributions)) attr.task_analysis = structuredClone(f.input.task_analysis);
 for (const attr of Object.values(f.input.attributions)) attr.criterion_assessments.push({...structuredClone(attr.criterion_assessments[0]!),criterion_id:'unknown',status:'unknown',evidence_status:'uncertain',summary:'真实附加交付仍未知。'});
 const slots = comparisonSlots(f.request);
 f.input.attributions.B.criterion_assessments[0]!.status='unknown';
 f.input.attributions.B.criterion_assessments[0]!.evidence_status='uncertain';
 f.draft.comparisons = slots.map(() => ({ importance:'medium',better_candidate:'A',assessments:cells('A真实观察。','B仍未知。') }));
 assert.throws(() => f.registry.resolve(f.binding,f.draft,audit),(error:any) => {
  assert.equal(error.issues.length,2);
  assert.deepEqual(error.issues.map((issue:any) => issue.path),['/comparisons/0/better_candidate','/comparisons/1/better_candidate']);
  assert(error.issues.every((issue:any) => issue.code==='schema_enum')); return true;
 });
});
