import type {ValidationIssue} from '@eval/contracts';

export type AttributionLanguageField='summary'|'text'|'reason';
export type AttributionLanguageStatus='passed'|'failed'|'not_applicable';
export interface AttributionLanguageCheck {path:string;field:AttributionLanguageField;status:AttributionLanguageStatus}

/** The same prose rule is used at submission time and by the read-only result checker. */
export function isChineseAttributionText(text:string){
  const prose=text.replace(/https?:\/\/\S+|`[^`]*`|“[^”]*”|"[^"]*"/gu,'');
  const han=prose.match(/\p{Script=Han}/gu)?.length??0,words=prose.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g)?.length??0;
  return han>=2&&han>=words;
}

/** Display-language audit; not an acceptance or semantic-completion gate. */
export function checkAttributionLanguage(value:unknown){
  const v=value as {summary?:unknown;Problem?:{text?:unknown;reason?:unknown}[]};
  const checks:AttributionLanguageCheck[]=[],issues:ValidationIssue[]=[];
  for(const [path,field,text] of [['/summary','summary',v?.summary],...(Array.isArray(v?.Problem)?v.Problem.flatMap((p,i)=>[['/Problem/'+i+'/text','text',p.text],['/Problem/'+i+'/reason','reason',p.reason]]):[])] as [string,AttributionLanguageField,unknown][]){
    const status=typeof text==='string'&&isChineseAttributionText(text)?'passed':'failed';checks.push({path,field,status});
    if(status==='failed')issues.push({category:'structure',code:'attribution_language',path,message:'点评使用中文。'});
  }
  return {checks,issues};
}
