import type {AgentRequest} from '@eval/contracts';
export function responsibilityFixture(component='调用（消息 1）') {
 return {component,attribution_reason:'输入正确，输出出现偏离。',uncertainties:['内部处理机制未采集。']};
}
export function unknownFormationFixture(_request:AgentRequest,_evidence:unknown[]):{component:string;attribution_reason:string;uncertainties:string[]}{
 return {component:'责任主体未确定',attribution_reason:'交付缺陷可见，但实际生成输入输出未采集。',uncertainties:['无法区分上游、生成或交付环节形成。']};
}
