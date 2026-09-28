// Business data binding for the upstream ToolRow / ToolDetails components.
const parse=value=>{try{return JSON.parse(value??'null');}catch{return null;}};
const label={runId:'运行',inputId:'输入',taskId:'任务',operationId:'专业任务',evaluatorVersion:'评测器',status:'状态',state:'状态',model:'模型',batchId:'批次',caseId:'样本',messageIndex:'消息',offset:'起点',total:'总数',accepted:'已接受',name:'文件',bytes:'字节',role:'角色',chars:'字符数',nextOffset:'下一页',hasMore:'还有内容'};
const fields=value=>Object.entries(value??{}).filter(([key,v])=>label[key]&&['string','number','boolean'].includes(typeof v)).map(([key,value])=>({label:label[key],value:String(value)}));
const referenceText=value=>[value?.runId,value?.inputId,value?.taskId,value?.messageIndex===undefined?null:`消息 ${value.messageIndex}`].filter(Boolean).join(' · ');
export function analysisToolModel(name,model){
 const args=parse(model.bodyRaw)??{},output=parse(model.output),reference=args.reference??args;
 const common=referenceText(reference)||args.operationId||'';
 let summary=common;
 if(name==='list_data')summary=output?.total===undefined?(args.query??common):`${output.total} 项${common?' · '+common:''}`;
 if(name==='search_data')summary=[args.query,common].filter(Boolean).join(' · ');
 if(name==='calculate')summary=[args.operation,(args.operands??[]).join(', '),model.state==='ok'?model.output:null].filter(Boolean).join(' · ');
 if(name==='call_specialist')summary=[args.kind,args.operationId,output?.state].filter(Boolean).join(' · ');
 if(name==='save_summary')summary=output?.name??'Markdown';
 if(name==='specialist_output')summary='实时专业分析';
 if(model.state==='error'||!model.output)return {summary};
 if(output?.sourceRead){const ref=output.sourceRead.args?.reference;return {summary,details:{items:[{title:referenceText(ref),fields:fields(ref)}]}};}
 if(name==='specialist_output')return {summary,details:{items:[{title:'专业任务输出',fields:[],markdown:model.output}]}};
 if(output&&typeof output==='object'){
  const rows=output.items??output.matches??output.messages;
  const items=Array.isArray(rows)?rows.map((row)=>({title:referenceText(row.reference??row)||row.role,fields:fields(row),...(row.text||row.preview?{code:{text:row.text??row.preview,language:'text'}}:{}),...(row.tasks?{groups:[{label:'任务',items:row.tasks.map(task=>({title:task.taskId,fields:fields(task)}))}]}:{})})):[{title:output.operationId??output.name,fields:fields({...output.reference,...output}),...(typeof output.text==='string'?{code:{text:output.text,language:'text'}}:{}),...(Array.isArray(output.evidence)&&output.evidence.length?{groups:[{label:'证据',items:output.evidence.map(entry=>({title:entry.evidence_id,fields:fields(entry),code:{text:entry.quote,language:'text'}}))}]}:{}),...(output.result?{code:{text:JSON.stringify(output.result,null,2),language:'json'}}:{}),...(output.url?{markdown:`[下载总结](${output.url})`}:{})}];
  return {summary,details:{items,empty:'没有匹配的结果'}};
 }
 return {summary};
}
