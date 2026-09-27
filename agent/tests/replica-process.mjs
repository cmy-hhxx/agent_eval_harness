import { serveAssistant, AssistantSessions } from '@eval/runtime/assistant';
import { assistantEndpoints } from '@eval/assistant/server';
const directory = process.argv[2];
let interrupt;
const server = await serveAssistant({port:0,userId:'alice',webDirectory:process.cwd()+'/dist/agent/web',endpoints:url=>assistantEndpoints(new AssistantSessions({directory,url,model:{provider:'test',model:'test'},systemPrompt:'test',tools:[],driver:async({event})=>({
 async prompt(text) {
  await event({type:'agent_start'});await event({type:'turn_start'});
  await event({type:'message_end',message:{role:'user',content:[{type:'text',text}]}});
  if(text==='hold') await new Promise(resolve=>{interrupt=resolve;});
  await event({type:'message_start',message:{role:'assistant'}});
  await event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'reply:'+text}});
  await event({type:'message_end',message:{role:'assistant',provider:'test',model:'test',content:[{type:'text',text:'reply:'+text}],stopReason:'stop'}});
  await event({type:'turn_end'});await event({type:'agent_end'});
 },async steer(){},async abort(){interrupt?.();},async dispose(){}
})}))});
process.send?.({url:server.url});
process.on('SIGTERM',async()=>{await server.close();process.exit(0);});
