import { createElement, useCallback, useEffect, useState } from 'react';
import { IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { ToolRow } from '../../../vendor/deepseek/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx';
import { toolRowModel } from '../../../vendor/deepseek/packages/client/ui-tool/src/client/tool/models/tool-call-model.ts';
import { analysisToolModel } from './tool-model.js';
import { TurnCharts, TurnChartFallback } from './charts.js';
import { IgnoredChart } from './inline-visuals.js';
import { MessageImages } from '../../../vendor/deepseek/packages/client/ui-attachment/src/client/MessageImages.tsx';
const names={list_data:['查询评测数据','List evaluations'],read_data:['读取材料','Read material'],search_data:['搜索消息','Search messages'],search_web:['搜索外部资料','Search the web'],read_web:['读取网页原文','Read web source'],view_image:['查看图片','View image'],calculate:['计算','Calculate'],execute_code:['代码核验','Run code'],read_code_output:['读取代码输出','Read code output'],show_chart:['显示图表','Show chart'],show_comparison:['显示比较图','Show comparison'],call_specialist:['专业评测','Specialist evaluation'],read_specialist:['读取专业结果','Read accepted result'],specialist_output:['专业任务输出','Specialist output']};
function AnalysisTool({toolName,block,cwd,home,openFile,inspect,useDisclosure,t,remote,sessionId}){
 const model=toolRowModel(toolName,block,cwd,home);
 const disclosure=useDisclosure();
 const useRowDisclosure=useCallback(()=>disclosure,[disclosure]);
 const sourceRead=block.meta?.sourceRead;
 const [loaded,setLoaded]=useState(null);
 const [failure,setFailure]=useState('');
 useEffect(()=>{
  if(!disclosure.expanded||!sourceRead){setLoaded(null);setFailure('');return;}
  let active=true;
  setLoaded(null);setFailure('');
  remote.toolResult({sessionId,callId:block.callId}).then(result=>{
   if(!active)return;
   if(!result.ok)throw new Error(result.error.message);
   setLoaded(result.value);
  }).catch(error=>{if(active)setFailure(error.message);});
  return ()=>{active=false;};
 },[disclosure.expanded,sourceRead,remote,sessionId,block.callId]);
 const output=loaded?loaded.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):model.output;
 const images=loaded?.content.filter(part=>part.type==='image').map((part,index)=>({preview:{url:`data:${part.mimeType};base64,${part.data}`,name:`图片 ${index+1}`}}))??[];
 const presentation=analysisToolModel(toolName,{...model,output});
 if(sourceRead&&!loaded)presentation.details={items:[{fields:[],description:failure||'正在读取原始材料…'}]};
 return createElement(ToolRow,{useDisclosure:useRowDisclosure,t,variant:toolName==='search_web'?'search':model.variant,toolName,icon:createElement(IconAgentPresetOutlineRegular,{size:14}),title:names[toolName][document.documentElement.lang.startsWith('zh')?0:1],summary:presentation.summary,details:presentation.details,image:images.length?{label:names[toolName][0],images,text:output}:undefined,renderSlot:(_,props)=>createElement(MessageImages,{...props,t}),loadImage:async()=>{throw new Error('Image reference unavailable');},bodyRaw:model.bodyRaw,output,errorSummary:model.state==='error'?presentation.summary:model.errorSummary,state:model.state,inspect,onOpenFile:openFile});
}
export const inject=['slots','remote','remote.assistant'];
export function apply(ctx){
 ctx.slots.inject('tool.call.toolview',function*(){for(const key of Object.keys(names))yield ctx.slots.register({name:'tool.call.toolview',key,locale:'conversation',inject:sessionId=>({sessionId,remote:ctx.remote.assistant})},AnalysisTool);});
 ctx.slots.inject('conversation.chat.visuals',()=>ctx.slots.register({name:'conversation.chat.visuals',id:'eris-charts',locale:'conversation'},TurnCharts));
 ctx.slots.inject('conversation.chat.turnTail',()=>ctx.slots.register({name:'conversation.chat.turnTail',id:'eris-charts',locale:'conversation'},TurnChartFallback));
 ctx.slots.inject('conversation.chat.fence',function*(){
  yield ctx.slots.register({name:'conversation.chat.fence',key:'chart',locale:'conversation'},IgnoredChart);
 });
}
