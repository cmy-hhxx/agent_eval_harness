// Only environment glue differs from upstream; workloads, measurements and
// budgets live in the checked-in, unchanged Deepseek benchmark sources.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AssistantSessions, serveAssistant } from '@eval/runtime/assistant';
import { assistantEndpoints } from '@eval/assistant/server';
import { AssistantJournal, assistantDirectory, writeJson } from '@eval/data';
import { syntheticReply } from '../../dist/agent/benchmarks/synthetic-history.js';
export const webSnapshotMode = () => 'replay';
export const newEnglishPage = (browser, height=1000) => browser.newPage({viewport:{width:1680,height},locale:'en-US',timezoneId:'Asia/Shanghai'});
export function watchConsole(page) {
 const warnings=[],pageErrors=[];
 page.on('console',message=>{if(/connection lost|gap repair|discontinuous/i.test(message.text()))warnings.push(message.text());});
 page.on('pageerror',error=>pageErrors.push(String(error)));return {warnings,pageErrors};
}
export async function seedSession(scaffold, history, sessionId) {
 const scope={userId:'local',sessionId};
 const journal=await AssistantJournal.create(scaffold.directory,'local',sessionId);
 const events=history.trim().split('\n').slice(1).map(JSON.parse);
 await writeFile(path.join(assistantDirectory(scaffold.directory,scope),'events.jsonl'),events.map(event=>JSON.stringify({kind:'event',event})).join('\n')+'\n');
 const state={...journal.state,title:'SYNTHETIC_BROWSER_HISTORY',lastSeq:events.at(-1).seq,requests:{fixture:'completed'}};
 await writeJson(path.join(journal.directory,'state.json'),state);
}
export async function launchWebScaffold({paceMs=16,replayContextWindow}) {
 const directory=await mkdtemp(path.join(tmpdir(),'eval-browser-benchmark-'));
 let settle=()=>{},cancelSettlement=()=>{},sessions;
 const server=await serveAssistant({port:0,userId:'local',webDirectory:process.cwd()+'/dist/agent/web',endpoints:url=>assistantEndpoints(sessions=new AssistantSessions({directory,url,model:{provider:'test',model:'test',contextWindow:replayContextWindow},systemPrompt:'test',tools:[],driver:async({event})=>({
  async prompt(text){
   await event({type:'agent_start'});await event({type:'turn_start'});
   await event({type:'message_end',message:{role:'user',content:[{type:'text',text}]}});
   await event({type:'message_start',message:{role:'assistant'}});
   let output='',usage;
   for(const chunk of syntheticReply()){
    await delay(paceMs);
    if(chunk.type==='text-delta'){output+=chunk.text;await event({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:chunk.text}});}
    if(chunk.type==='usage')usage=chunk.usage;
   }
   await event({type:'message_end',message:{role:'assistant',provider:'test',model:'test',content:[{type:'text',text:output}],usage:usage&&{input:usage.inputTokens,output:usage.outputTokens,cacheRead:usage.cacheReadTokens??0,cacheWrite:usage.cacheWriteTokens??0,totalTokens:usage.inputTokens+usage.outputTokens},stopReason:'stop'}});
   await event({type:'turn_end'});await event({type:'agent_end'});settle();
  },async steer(){},async abort(){},async dispose(){}
 })}))});
 return {directory,baseUrl:server.url,authenticatedUrl:server.url+'/u/local/',whenTurnSettled:(timeoutMs=30000)=>new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error(`Benchmark turn did not settle within ${timeoutMs}ms`)),timeoutMs);
  settle=()=>{clearTimeout(timeout);resolve();};
  cancelSettlement=()=>{clearTimeout(timeout);reject(new Error('Benchmark scaffold closed before turn settled'));};
 }),close:async()=>{cancelSettlement();await server.close();await rm(directory,{recursive:true,force:true});}};
}
