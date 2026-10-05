import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {waitForTestState} from '../fixtures/wait.js';
import {GatewayAssistantModels} from '../../apps/host/src/assistant-models.js';
import {AssistantSessions} from '@eval/runtime/assistant';
import type {ModelConfig} from '@eval/contracts';

test('gateway catalog, scoped favorites and durable model/effort switching reach the next driver',async()=>{
 const directory=await mkdtemp(tmpdir()+'/assistant-models-'),requests:string[]=[];
 const server=createServer((request,response)=>{requests.push(request.url!);assert.equal(request.headers.authorization,'Bearer fixture');response.setHeader('content-type','application/json');response.end(JSON.stringify({data:[{id:'analysis-a'},{id:'analysis-b',context_window:64000}]}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const config:ModelConfig={provider:'gateway',model:'analysis-a',api:'openai-completions',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,apiKeyEnv:'ASSISTANT_MODEL_TEST_KEY',thinking:'low',contextWindow:32000,maxOutputTokens:2048};process.env.ASSISTANT_MODEL_TEST_KEY='fixture';
 const models=new GatewayAssistantModels(directory,config),used:ModelConfig[]=[];
 const options={directory,url:'http://127.0.0.1:1',model:config,models,systemPrompt:'test',tools:[],driver:async({model,event}:import('@eval/runtime/assistant').ConversationDriverOptions)=>({async prompt(text:string){used.push(model);await event({type:'agent_start'});await event({type:'turn_start'});await event({type:'message_end',message:{role:'user',content:[{type:'text',text}]}});await event({type:'turn_end'});await event({type:'agent_end'});},async steer(){},async abort(){},async dispose(){}})};
 let sessions=new AssistantSessions(options);
 try{
  assert.equal((await models.list('alice')).models.length,2);
  await models.favorites('alice',['analysis-b']);assert.deepEqual((await models.list('alice')).favorites,['analysis-b']);assert.deepEqual((await models.list('bob')).favorites,['analysis-a']);
  await assert.rejects(models.favorites('alice',['unknown']),/可用/);await assert.rejects(models.resolve({provider:'outside',model:'analysis-b'}),/网关/);
  const {sessionId}=await sessions.create('alice'),scope={userId:'alice',sessionId};
  const send=async()=>{
   const requestId=randomUUID();
   await sessions.prompt('alice',{sessionId,requestId,mode:'queue',content:[{type:'text',text:'test'}]});
   await waitForTestState(()=>sessions.list('alice'),items=>items[0].requests[requestId]==='completed',`Assistant model request ${requestId} did not complete`);
  };
  await send();assert.equal(used[0].model,'analysis-b');
  assert((await models.list('alice')).models.every(model=>model.reasoning?.efforts.some(effort=>effort.id==='max')));
  await sessions.selectModel(scope,{provider:'gateway',model:'analysis-a',reasoningEffort:'max'});await send();assert.equal(used[1].model,'analysis-a');assert.equal(used[1].thinking,'max');
  await sessions.dispose();sessions=new AssistantSessions(options);await send();assert.equal(used[2].thinking,'max');
  assert.deepEqual(requests,['/models']);
 }finally{await sessions.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));delete process.env.ASSISTANT_MODEL_TEST_KEY;await rm(directory,{recursive:true,force:true});}
});
