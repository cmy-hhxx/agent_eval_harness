import type {AgentRequest} from '@eval/contracts';
import {evidenceCovers} from '@eval/tools';
import type {AttributionTransition,Evidence,ProblemProposal,Responsibility,ResponsibilitySubmission} from '@eval/agents/attribution';
export function responsibilityFixture(component='调用（消息 1）',patch:Partial<Responsibility>={}):Responsibility{
 return {transition_index:1,basis:'input_deviation',actor_index:1,role:'primary',component,kind:'generation',mechanism_source:'boundary_comparison',certainty:'inferred',
 reason:'输入保留正确事实，输出偏离该事实；内部过程未记录。',evidence_ids:[],uncertainty:{evidence_gap:'内部处理未采集。',alternatives:['模型转换事实时出错。']},...patch};
}
export function responsibilitySubmissionFixture(c:Responsibility):ResponsibilitySubmission{
 const {transition_index,basis,mechanism_source,reason,certainty,uncertainty}=c;return {transition_index,basis,mechanism_source,reason,certainty,...(uncertainty?{uncertainty}:{})};
}
export function unknownFormationFixture(request:AgentRequest,evidence:Evidence[]):Pick<ProblemProposal,'causes'|'checks'|'uncertainty'>{
 const edge=(request.input.answer as {transitions:AttributionTransition[]}).transitions.find(t=>t.kind==='delivery'&&!t.before.length&&t.actor_index===null);
 if(!edge)throw Error('Fixture requires a genuinely missing formation boundary');
 const ids=evidence.filter(e=>edge.after.some(b=>evidenceCovers(request.sources.answer.value as {messages:unknown[]},request.sources.answer.id,b.evidence_id,e.evidence_id))).map(e=>e.evidence_id);
 return {causes:[],checks:[{transition_index:edge.transition_index,kind:edge.kind,outcome:'unresolved',observation:'交付可见，生成输入输出尚未采集。',before_evidence_ids:[],after_evidence_ids:ids}],uncertainty:{evidence_gap:'生成输入输出及形成主体未采集。',alternatives:['上游输入偏离。','生成或交付偏离。']}};
}
