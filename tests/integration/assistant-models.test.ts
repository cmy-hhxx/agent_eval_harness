import {parseSettings, applySettings} from "@eval/host-app/config";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {waitForTestState} from '../fixtures/wait.js';
import {assistantModelConfiguration,GatewayAssistantModels,modelIdentity} from '../../apps/host/src/assistant-models.js';
import {AssistantSessions} from '@eval/runtime/assistant';
import {body,listen} from '@eval/runtime/http';
import {assistantDirectory} from '@eval/data';
import {object,type ModelConfig,type AssistantModelDirectory,type JsonObject} from '@eval/contracts';

test('gateway catalog, scoped favorites and durable model/effort switching reach the next driver',async()=>{
 const directory=await mkdtemp(tmpdir()+'/assistant-models-'),requests:string[]=[];
 const server=createServer((request,response)=>{requests.push(request.url!);assert.equal(request.headers.authorization,'Bearer fixture');response.setHeader('content-type','application/json');response.end(JSON.stringify({data:[{id:'gpt-6-luna'},{id:'gpt-5.6-luna',context_window:64000}]}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const config:ModelConfig={provider:'gateway',model:'gpt-6-luna',api:'openai-completions',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,apiKeyEnv:'ASSISTANT_MODEL_TEST_KEY',thinking:'low',contextWindow:32000,maxOutputTokens:2048};process.env.ASSISTANT_MODEL_TEST_KEY='fixture';
 const models=new GatewayAssistantModels(directory,config,[{name:'评测网关',model:config}]),used:ModelConfig[]=[];
 const options={directory,url:'http://127.0.0.1:1',model:config,models,systemPrompt:'test',tools:[],driver:async({model,event}:import('@eval/runtime/assistant').ConversationDriverOptions)=>({async prompt(text:string){used.push(model);await event({type:'agent_start'});await event({type:'turn_start'});await event({type:'message_end',message:{role:'user',content:[{type:'text',text}]}});await event({type:'turn_end'});await event({type:'agent_end'});},async steer(){},async abort(){},async dispose(){}})};
 let sessions=new AssistantSessions(options);
 try{
  assert.equal((await models.list('alice')).models.length,2);
  await models.favorites('alice',[modelIdentity('gateway','gpt-5.6-luna')]);assert.deepEqual((await models.list('alice')).favorites,[modelIdentity('gateway','gpt-5.6-luna')]);assert.deepEqual((await models.list('bob')).favorites,[modelIdentity('gateway','gpt-6-luna')]);
  await assert.rejects(models.favorites('alice',['unknown']),/可用/);await assert.rejects(models.resolve({provider:'outside',model:'gpt-5.6-luna'}),/网关/);
  const {sessionId}=await sessions.create('alice'),scope={userId:'alice',sessionId};
  const send=async()=>{
   const requestId=randomUUID();
   await sessions.prompt('alice',{sessionId,requestId,mode:'queue',content:[{type:'text',text:'test'}]});
   await waitForTestState(()=>sessions.list('alice'),items=>items[0].requests[requestId]==='completed',`Assistant model request ${requestId} did not complete`);
  };
  await send();assert.equal(used[0].model,'gpt-5.6-luna');
  assert((await models.list('alice')).models.every(model=>model.reasoning?.efforts.some(effort=>effort.id==='max')));
  await sessions.selectModel(scope,{provider:'gateway',model:'gpt-6-luna',reasoningEffort:'max'});await send();assert.equal(used[1].model,'gpt-6-luna');assert.equal(used[1].thinking,'max');
  await sessions.dispose();sessions=new AssistantSessions(options);await send();assert.equal(used[2].thinking,'max');
  assert.deepEqual(requests,['/models']);
 }finally{await sessions.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));delete process.env.ASSISTANT_MODEL_TEST_KEY;await rm(directory,{recursive:true,force:true});}
});

test('Pi retains explicit DeepSeek Responses routing, tools and reasoning independently of the Luna picker', {timeout:30000}, async()=>{
 const directory=await mkdtemp(tmpdir()+'/assistant-deepseek-');
 const previous={evaluation:process.env["EVAL_CHANNEL_KEY_evaluation_Hgateway"],deepseek:process.env.EVAL_CHANNEL_KEY_deepseek};
 process.env["EVAL_CHANNEL_KEY_evaluation_Hgateway"]='evaluation-fixture';process.env.EVAL_CHANNEL_KEY_deepseek='deepseek-fixture';
 const requests:{url:string;payload:JsonObject}[]=[],errors:unknown[]=[];
 let toolCalls=0;
 const gateway=await listen(async(req,res)=>{
  const deepseek=req.url!.startsWith('/deepseek/');
  assert.equal(req.headers.authorization,`Bearer ${deepseek?'deepseek-fixture':'evaluation-fixture'}`);
  if(req.url!.endsWith('/models')){
   res.setHeader('content-type','application/json');
   res.end(JSON.stringify({data:deepseek?[{id:'deepseek-flash',context_window:1048576,max_output_tokens:393216},{id:'deepseek-v4-pro'}]:[{id:'MiniMax-M3'}]}));return;
  }
  const payload=object(await body(req));requests.push({url:req.url!,payload});
  res.writeHead(200,{'content-type':'text/event-stream'});
  if(!deepseek){
   assert.equal(req.url,'/evaluation/chat/completions');assert.equal(payload.model,'MiniMax-M3');
   const chunk={id:'minimax-fixture',object:'chat.completion.chunk',created:1,model:'MiniMax-M3'};
   res.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',content:'gateway reply'},finish_reason:null}]})}\n\n`);
   res.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`);
   res.end('data: [DONE]\n\n');return;
  }
  assert.equal(req.url,'/deepseek/responses');assert.equal(payload.model,'deepseek-flash');
  assert.equal(payload.max_output_tokens,8192);
  const input=payload.input as JsonObject[];
  assert.equal(input[0].role,'system');assert(!input.some(item=>item.role==='developer'));
  const requestNumber=requests.length,reasoning=object(payload.reasoning).effort!=='none';
  const callTool=!input.some(item=>item.type==='function_call_output');
  const output:JsonObject[]=[];
  const emit=(type:string,data:JsonObject)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  emit('response.created',{response:{id:`resp-${requestNumber}`,object:'response',status:'in_progress',output:[]}});
  if(reasoning){
   const reason={type:'reasoning',id:`rs-${requestNumber}`,status:'completed',summary:[],content:[{type:'reasoning_text',text:`reason-${requestNumber}`} ]};
   emit('response.output_item.added',{output_index:0,item:{...reason,status:'in_progress',content:[]}});
   emit('response.reasoning_text.delta',{output_index:0,content_index:0,item_id:reason.id,delta:`reason-${requestNumber}`});
   emit('response.output_item.done',{output_index:0,item:reason});output.push(reason);
  }
  const item:JsonObject=callTool?{type:'function_call',id:'fc-lookup',call_id:'lookup-call',name:'lookup',arguments:'{}',status:'completed'}
   :{type:'message',id:`msg-${requestNumber}`,role:'assistant',status:'completed',content:[{type:'output_text',text:'Flash reply',annotations:[]}]};
  emit('response.output_item.added',{output_index:output.length,item:callTool?{...item,arguments:''}:{...item,content:[]}});
  emit(callTool?'response.function_call_arguments.delta':'response.output_text.delta',{output_index:output.length,item_id:item.id,content_index:0,delta:callTool?'{}':'Flash reply'});
  emit('response.output_item.done',{output_index:output.length,item});output.push(item);
  emit('response.completed',{response:{id:`resp-${requestNumber}`,object:'response',status:'completed',output,usage:{input_tokens:40,output_tokens:10,total_tokens:50,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:reasoning?5:0}}}});
  res.end();
 });
 const evaluation:ModelConfig={provider:'evaluation-gateway',model:'MiniMax-M3',api:'openai-completions',baseUrl:gateway.url+'/evaluation',apiKeyEnv:'EVAL_CHANNEL_KEY_evaluation_Hgateway',thinking:'low',contextWindow:32000,maxOutputTokens:2048};
 const settings=parseSettings(`[channel.evaluation-gateway]
base_url=${gateway.url}/evaluation
api_key=evaluation-fixture
api=openai-completions
[channel.deepseek]
name=DeepSeek
base_url=${gateway.url}/deepseek
api_key=deepseek-fixture
model=deepseek-flash
models=deepseek-flash
thinking=high
efforts=off,low,high,max
supports_developer_role=false
context_window=1048576
max_output_tokens=8192
[agent]
channel=deepseek
`);
 applySettings(settings);
 const {model,gateways}=assistantModelConfiguration(evaluation,settings);
 const models:AssistantModelDirectory={
  async list(){return {models:[],favorites:[],default:{provider:model.provider,model:model.model,reasoningEffort:model.thinking}};},
  async resolve(selection){const gateway=gateways.find(gateway=>gateway.model.provider===selection.provider)!;return {...gateway.model,model:selection.model,thinking:selection.reasoningEffort??gateway.model.thinking};},
  async favorites(){},async readFavorites(){return [];},
 };
 const options={directory,url:'http://127.0.0.1:1',model,models,systemPrompt:'System instructions',tools:[{name:'lookup',readOnly:true,description:'Read fixture',inputSchema:{type:'object',properties:{}},execute:async()=>{toolCalls++;return {content:[{type:'text' as const,text:'42'}]};}}],onError:(error:unknown)=>errors.push(error)};
 let sessions=new AssistantSessions(options);
 try{
  const {sessionId}=await sessions.create('alice'),scope={userId:'alice',sessionId};
  const send=async()=>{
   const requestId=randomUUID();await sessions.prompt('alice',{sessionId,requestId,mode:'queue',content:[{type:'text',text:'test'}]});
   const state=await waitForTestState(()=>sessions.list('alice'),items=>['completed','interrupted'].includes(items.find(item=>item.sessionId===sessionId)!.requests[requestId]),'Pi conversation did not settle');
   assert.equal(state.find(item=>item.sessionId===sessionId)!.requests[requestId],'completed',JSON.stringify(errors));
  };
  await send();assert.equal(toolCalls,1);assert.equal(requests.length,2);
  assert.equal(object(requests[0].payload.reasoning).effort,'high');
  const secondInput=requests[1].payload.input as JsonObject[];
  assert(secondInput.some(item=>item.type==='reasoning' && JSON.stringify(item.content).includes('reason-1')),'tool continuation returns full plain reasoning');
  await sessions.dispose();sessions=new AssistantSessions(options);await send();
  const restoredInput=requests[2].payload.input as JsonObject[];
  assert.equal(restoredInput.filter(item=>item.type==='reasoning').length,2,'restart restores both prior reasoning items');
  await sessions.selectModel(scope,{provider:'deepseek',model:'deepseek-flash',reasoningEffort:'off'});await send();
  assert.equal(object(requests.at(-1)!.payload.reasoning).effort,'none','off must disable DeepSeek default thinking');
  await sessions.selectModel(scope,{provider:'evaluation-gateway',model:'MiniMax-M3',reasoningEffort:'max'});await send();
  assert.equal(requests.at(-1)!.url,'/evaluation/chat/completions');
  assert.equal(requests.at(-1)!.payload.reasoning_effort,'max');
  const journal=await readFile(assistantDirectory(directory,scope)+'/events.jsonl','utf8');
  assert(!journal.includes('deepseek-fixture'));assert(!journal.includes('evaluation-fixture'));
  assert.deepEqual(errors,[]);
 }finally{
  await sessions.dispose();await gateway.close();await rm(directory,{recursive:true,force:true});
  if(previous.evaluation===undefined)delete process.env["EVAL_CHANNEL_KEY_evaluation_Hgateway"];else process.env["EVAL_CHANNEL_KEY_evaluation_Hgateway"]=previous.evaluation;
  if(previous.deepseek===undefined)delete process.env.EVAL_CHANNEL_KEY_deepseek;else process.env.EVAL_CHANNEL_KEY_deepseek=previous.deepseek;
 }
});
