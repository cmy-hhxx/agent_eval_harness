// Business data binding for the upstream ToolRow / ToolDetails components.
const parse=value=>{try{return JSON.parse(value??'null');}catch{return null;}};
const label={runId:'运行',inputId:'输入',taskId:'任务',operationId:'专业任务',evaluatorVersion:'评测器',status:'状态',state:'状态',model:'模型',batchId:'批次',caseId:'样本',messageIndex:'消息',offset:'起点',total:'总数',accepted:'已接受',name:'文件',bytes:'字节',role:'角色',chars:'字符数',nextOffset:'下一页',hasMore:'还有内容'};
const fields=value=>Object.entries(value??{}).filter(([key,v])=>label[key]&&['string','number','boolean'].includes(typeof v)).map(([key,value])=>({label:label[key],value:String(value)}));
const referenceText=value=>[value?.runId,value?.inputId,value?.taskId,value?.messageIndex===undefined?null:`消息 ${value.messageIndex}`].filter(Boolean).join(' · ');
const specialistLabel={attribution:'归因评测',comparison:'对比评测'};
const operationLabel={add:'加法',subtract:'减法',multiply:'乘法',divide:'除法'};
const operationSymbol={add:' + ',subtract:' − ',multiply:' × ',divide:' ÷ '};
const statusText=(model,output)=>output?.error==='interrupted'?'已中断':({succeeded:'已完成',running:'进行中',cancelled:'已取消',failed:'未完成'}[output?.state]??{preparing:'准备中',running:'进行中',ok:'已完成',error:'未完成',stopped:'已停止'}[model.state]??'准备中');
const string=value=>typeof value==='string'&&value?value:undefined;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const rows=value=>Array.isArray(value)?value.filter(object):[];
const webUrl=value=>{try{if(typeof value!=='string')return undefined;const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href.replace(/[<>\s\\]/g,char=>encodeURIComponent(char)):undefined;}catch{return undefined;}};
const searchFields=value=>Object.entries(value).filter(([,entry])=>['string','number','boolean'].includes(typeof entry)).map(([label,value])=>({label,value:String(value)}));
const dateAssessment=value=>({not_requested:'未限定日期',unknown:'发布日期未确认',within_range:'在日期范围内',outside_range:'超出日期范围'}[value?.status]);
const dateBasis=value=>({search_metadata:'搜索日期',page_metadata:'页面声明',none:'无日期依据'}[value?.basis]);
const caption=value=>searchFields(value).map(({label,value})=>`${label}：${value}`).join(' · ');
function searchItem(row){
 const url=webUrl(row.url);
 const matches=rows(row.matches).filter(match=>Number.isInteger(match.queryIndex)&&Number.isInteger(match.position)&&Number.isInteger(match.page)).map(match=>`查询 ${match.queryIndex+1} · 第 ${match.page} 页 · 第 ${match.position} 条`).join('；');
 return {title:string(row.title),description:string(row.snippet),fields:searchFields({'域名':row.domain,'来源':row.source,'搜索日期':row.date,'日期判断':dateAssessment(row.dateAssessment),'日期依据':dateBasis(row.dateAssessment),'判断日期':row.dateAssessment?.date,'合并排序':row.rank,'缩短字段':Array.isArray(row.truncatedFields)?row.truncatedFields.filter(value=>typeof value==='string').join('、')||undefined:undefined,'命中查询':matches||undefined,...(!url?{'网址':string(row.url)}:{})}),...(url?{markdown:`<${url}>`}:{})};
}
function webSearchModel(model,args,output,status){
 const category=(output?.category??args.category)==='news'?'新闻':'网页';
 const queries=rows(args.queries),attempts=rows(output?.attempts),results=Array.isArray(output?.results)?rows(output.results):null;
 const query=queries.length===1?string(queries[0].query):attempts.length===1?string(attempts[0].query):undefined;
 const queryCount=queries.length||attempts.length;
 const completed=attempts.filter(attempt=>attempt.state==='succeeded').length;
 const failed=attempts.filter(attempt=>attempt.state==='failed').length;
 const receiptStatus=model.state==='ok'&&failed?(completed?`部分完成（${completed}/${attempts.length}）`:`未完成（0/${attempts.length}）`):status;
 const summary=[query?`搜索“${query}”`:'搜索外部资料',queryCount>1?`${queryCount} 种查询`:null,category,model.state==='ok'&&results?`${results.length} 条结果`:null,receiptStatus].filter(Boolean).join(' · ');
 if(model.state==='error'||!results)return {summary};
 const items=results.map(searchItem);
 const groups=[];
 if(attempts.length)groups.push({label:'查询记录',items:attempts.map((attempt,index)=>({title:`查询 ${Number.isInteger(attempt.queryIndex)?attempt.queryIndex+1:index+1}`,description:string(attempt.query),badge:{label:attempt.state==='succeeded'?'已完成':attempt.state==='failed'?'未完成':'状态未知',tone:attempt.state==='succeeded'?'success':attempt.state==='failed'?'error':'neutral'},fields:searchFields({'实际查询':attempt.searchQuery,'域名限制':Array.isArray(attempt.domains)?attempt.domains.filter(value=>typeof value==='string').join('、')||undefined:undefined,'地区':attempt.country,'语言':attempt.language,'页':attempt.page,'结果数':attempt.resultCount,'耗时（毫秒）':attempt.elapsedMs,'用量':attempt.credits,'错误':attempt.error})}))});
 const excluded=rows(output.excludedResults);
 if(excluded.length)groups.push({label:`超出日期范围（${excluded.length}）`,items:excluded.map(searchItem)});
 if(groups.length)items.push({title:'检索记录',...(!results.length?{description:'没有搜索结果'}:{}),fields:[],groups});
 return {summary,details:{items,caption:caption({'服务':output.provider,'检索时间':output.searchedAt,'耗时（毫秒）':output.elapsedMs,'时间范围':output.timeRange,'起始日期':output.dateFrom,'截至日期':output.dateTo,'去重候选':output.totalUnique,'还有结果':output.hasMore,'用量':output.credits,'用量完整':output.creditsComplete}),empty:'没有搜索结果'}};
}
function webReadModel(model,args,output,status){
 const lines=Array.isArray(output?.lines)?rows(output.lines).filter(line=>Number.isInteger(line.number)&&typeof line.text==='string'):null;
 const format=output?.format==='pdf'?'PDF':output?.format==='html'?'网页':'原文';
 const summary=['读取外部原文',format,model.state==='ok'&&lines?`${lines.length} 行`:null,status].filter(Boolean).join(' · ');
 if(model.state==='error'||!lines)return {summary};
 const url=webUrl(output.url),items=[{title:string(output.title),fields:searchFields({'格式':output.format,'页面声明发布日期':output.publicationDate,'页面声明修改日期':output.modifiedDate,'日期判断':dateAssessment(output.dateAssessment),'日期依据':dateBasis(output.dateAssessment),'判断日期':output.dateAssessment?.date,'总行数':output.totalLines,'总页数':output.totalPages,'已读取页数':output.readPages,'下一行':output.nextStartLine,'截断':output.truncated,...(!url?{'网址':string(output.url)}:{})}),...(url?{markdown:`<${url}>`}:{}),...(Array.isArray(output.limitations)?{lines:output.limitations.filter(value=>typeof value==='string')}:{})}];
 const links=rows(output.links).map(link=>({link,url:webUrl(link.url)})).filter(value=>value.url);
 if(links.length)items.push({title:'原文链接与附件',fields:[],groups:[{label:'链接',items:links.map(({link,url})=>({title:string(link.text),fields:[],markdown:`<${url}>`}))}]});
 const matches=rows(output.matches).filter(match=>Number.isInteger(match.line)).map(match=>`第 ${match.line} 行${Number.isInteger(match.page)?` · 第 ${match.page} 页`:''}${string(match.preview)?` · ${match.preview}`:''}`);
 if(matches.length)items.push({title:'匹配位置',fields:searchFields({'查找词':string(args.find)}),lines:matches});
 const pages=new Map();
 for(const line of lines){const page=Number.isInteger(line.page)?line.page:undefined;const values=pages.get(page)??[];values.push(line);pages.set(page,values);}
 for(const [page,values]of pages){
  const pageUrl=url&&page!==undefined?new URL(url):undefined;
  if(pageUrl)pageUrl.hash=`page=${page}`;
  items.push({title:page===undefined?'原文行':'PDF 第 '+page+' 页',fields:[],code:{text:values.map(line=>`${line.number}: ${line.text}`).join('\n'),language:'text'},...(pageUrl?{markdown:`<${webUrl(pageUrl.href)}>`}:{})});
 }
 if(!lines.length)items.push({description:'没有可读取的原文行',fields:[]});
 return {summary,details:{items,caption:caption({'读取时间':output.retrievedAt,'耗时（毫秒）':output.elapsedMs,'请求网址':string(output.requestedUrl)}),empty:'没有可读取的原文行'}};
}
export function analysisToolModel(name,model){
 const args=parse(model.bodyRaw)??{},output=parse(model.output),reference=args.reference??args;
 const status=statusText(model,output);
 if(name==='search_web')return webSearchModel(model,args,output,status);
 if(name==='read_web')return webReadModel(model,args,output,status);
 if(name==='show_chart')return {summary:`显示${({bar:'柱形图',line:'折线图',pie:'饼图'}[output?.chart?.type??args.type])??'图表'} · ${status}`};
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
