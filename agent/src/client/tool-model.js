// Business data binding for the upstream ToolRow / ToolDetails components.
const parse=value=>{try{return JSON.parse(value??'null');}catch{return null;}};
const label={runId:'运行',inputId:'输入',taskId:'任务',operationId:'专业任务',evaluatorVersion:'评测器',status:'状态',state:'状态',model:'模型',batchId:'批次',caseId:'样本',messageIndex:'消息',offset:'起点',total:'总数',accepted:'已接受',name:'文件',bytes:'字节',role:'角色',chars:'字符数',nextOffset:'下一页',hasMore:'还有内容'};
const fields=value=>Object.entries(value??{}).filter(([key,v])=>label[key]&&['string','number','boolean'].includes(typeof v)).map(([key,value])=>({label:label[key],value:String(value)}));
const referenceText=value=>[value?.runId,value?.inputId,value?.taskId,value?.messageIndex===undefined?null:`消息 ${value.messageIndex}`].filter(Boolean).join(' · ');
const specialistLabel={attribution:'归因评测',comparison:'对比评测'};
const operationLabel={add:'加法',subtract:'减法',multiply:'乘法',divide:'除法'};
const operationSymbol={add:' + ',subtract:' − ',multiply:' × ',divide:' ÷ '};
const statusText=(model,output)=>output?.error==='missingAttributions'?'待补充归因':output?.error==='interrupted'?'已中断':({succeeded:'已完成',running:'进行中',cancelled:'已取消',failed:'未完成'}[output?.state]??{preparing:'准备中',running:'进行中',ok:'已完成',error:'未完成',stopped:'已停止'}[model.state]??'准备中');
export function analysisToolModel(name,model){
 const args=parse(model.bodyRaw)??{},output=parse(model.output),reference=args.reference??args;
 const status=statusText(model,output);
 let summary=`评测分析 · ${status}`;
 if(name==='list_data')summary=output?.total===undefined?`查询评测目录 · ${status}`:`找到 ${output.total} ${output.kind==='runs'?'批评测':output.kind==='inputs'?'条评测样本':'项结果'}`;
 if(name==='read_data')summary=[reference.taskId?'读取正式结论':'读取原始对话',output?.kind==='messages'?`${output.total} 条消息`:status].join(' · ');
 if(name==='search_data')summary=[args.query===undefined?'搜索对话':`搜索“${args.query}”`,output?.total===undefined?status:`${output.total} 条匹配消息`].join(' · ');
 if(name==='view_image')summary=`查看对话图片 · ${status}`;
 if(name==='calculate'){
  const result=model.state==='ok'?(output?.result??(typeof output==='string'||typeof output==='number'?output:null)):null;
  const expression=(Array.isArray(args.operands)?args.operands:[]).join(operationSymbol[args.operation]??', ');
  summary=[operationLabel[args.operation]??'计算',...(result===null?[expression,status]:[`${expression} = ${result}`])].filter(Boolean).join(' · ');
 }
 if(name==='call_specialist')summary=`${specialistLabel[args.kind]??'专业评测'} · ${status}`;
 if(name==='read_specialist')summary=`读取专业结论 · ${status}`;
 if(name==='save_summary')summary=model.state==='ok'?'总结已保存':`保存总结 · ${status}`;
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
