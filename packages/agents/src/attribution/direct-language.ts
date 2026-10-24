import type {ValidationIssue} from '@eval/contracts';

export type AttributionLanguageField='summary'|'text'|'reason'|'label'|'definition';
export type AttributionLanguageStatus='passed'|'failed'|'not_applicable';
export interface AttributionLanguageCheck {path:string;field:AttributionLanguageField;status:AttributionLanguageStatus}

/** The same prose rule is used at submission time and by the read-only result checker. */
export function isChineseAttributionText(text:string){
  const prose=text.replace(/https?:\/\/\S+|`[^`]*`|“[^”]*”|"[^"]*"/gu,'');
  const han=prose.match(/\p{Script=Han}/gu)?.length??0,words=prose.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g)?.length??0;
  return han>=2&&han>=words;
}

/** Problem descriptors are inapplicable only when a strength explicitly carries null. */
export function checkDirectAttributionLanguage(value:unknown){
  const checks:AttributionLanguageCheck[]=[],issues:ValidationIssue[]=[];
  const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
  const issue=(path:string,message:string)=>issues.push({category:'structure',code:'attribution_language',path,message});
  const check=(text:unknown,field:AttributionLanguageField,path:string,strength=false)=>{
    const status:AttributionLanguageStatus=strength&&text===null?'not_applicable':
      !strength&&typeof text==='string'&&isChineseAttributionText(text)?'passed':'failed';
    checks.push({field,path,status});
    if(status==='failed')issue(path,strength?'strength 的 label、definition 必须为 null，记为不适用。':'该点评字段必须为非空中文字符串。');
  };
  if(!object(value)){issue('/','归因结果必须为对象。');return {checks,issues};}
  check(value.summary,'summary','/summary');
  if(!Array.isArray(value.findings)){issue('/findings','findings 必须为数组。');return {checks,issues};}
  value.findings.forEach((finding,index)=>{
    const base='/findings/'+index;
    if(!object(finding)){issue(base,'finding 必须为对象。');return;}
    if(!['strength','problem'].includes(String(finding.type)))issue(base+'/type','finding 类型必须为 strength 或 problem。');
    for(const field of ['text','reason','label','definition'] as const)
      check(finding[field],field,base+'/'+field,finding.type==='strength'&&['label','definition'].includes(field));
  });
  return {checks,issues};
}
