import { createElement, useCallback, useEffect, useState } from 'react';
import { IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { ToolRow } from '../../../vendor/deepseek/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx';
import { toolRowModel } from '../../../vendor/deepseek/packages/client/ui-tool/src/client/tool/models/tool-call-model.ts';
import { analysisToolModel } from './tool-model.js';
import { MessageImages } from '../../../vendor/deepseek/packages/client/ui-attachment/src/client/MessageImages.tsx';
const names={list_data:['查询评测数据','List evaluations'],read_data:['读取材料','Read material'],search_data:['搜索消息','Search messages'],view_image:['查看图片','View image'],calculate:['计算','Calculate'],call_specialist:['专业评测','Specialist evaluation'],read_specialist:['读取专业结果','Read accepted result'],save_summary:['保存总结','Save summary'],specialist_output:['专业任务输出','Specialist output']};
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
 return createElement(ToolRow,{useDisclosure:useRowDisclosure,t,variant:model.variant,toolName,icon:createElement(IconAgentPresetOutlineRegular,{size:14}),title:names[toolName][document.documentElement.lang.startsWith('zh')?0:1],summary:presentation.summary,details:presentation.details,image:images.length?{label:names[toolName][0],images,text:output}:undefined,renderSlot:(_,props)=>createElement(MessageImages,{...props,t}),loadImage:async()=>{throw new Error('Image reference unavailable');},bodyRaw:model.bodyRaw,output,errorSummary:model.errorSummary,state:model.state,inspect,onOpenFile:openFile});
}
export const inject=['slots','remote','remote.assistant'];
export function apply(ctx){ctx.slots.inject('tool.call.toolview',function*(){for(const key of Object.keys(names))yield ctx.slots.register({name:'tool.call.toolview',key,locale:'conversation',inject:sessionId=>({sessionId,remote:ctx.remote.assistant})},AnalysisTool);});}
