import { createElement } from 'react';
import { IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { ToolRow } from '../../../vendor/deepseek/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx';
import { toolRowModel } from '../../../vendor/deepseek/packages/client/ui-tool/src/client/tool/models/tool-call-model.ts';
import { analysisToolModel } from './tool-model.js';
const names={list_data:['查询评测数据','List evaluations'],read_data:['读取材料','Read material'],search_data:['搜索消息','Search messages'],view_image:['查看图片','View image'],calculate:['计算','Calculate'],call_specialist:['专业评测','Specialist evaluation'],read_specialist:['读取专业结果','Read accepted result'],save_summary:['保存总结','Save summary'],specialist_output:['专业任务输出','Specialist output']};
function AnalysisTool({toolName,block,cwd,home,openFile,inspect,useDisclosure,t}){
 const model=toolRowModel(toolName,block,cwd,home);
 const presentation=analysisToolModel(toolName,model);
 return createElement(ToolRow,{useDisclosure,t,variant:model.variant,toolName,icon:createElement(IconAgentPresetOutlineRegular,{size:14}),title:names[toolName][document.documentElement.lang.startsWith('zh')?0:1],summary:presentation.summary,details:presentation.details,bodyRaw:model.bodyRaw,output:model.output,errorSummary:model.errorSummary,state:model.state,inspect,onOpenFile:openFile});
}
export const inject=['slots'];
export function apply(ctx){ctx.slots.inject('tool.call.toolview',function*(){for(const key of Object.keys(names))yield ctx.slots.register({name:'tool.call.toolview',key,locale:'conversation'},AnalysisTool);});}
