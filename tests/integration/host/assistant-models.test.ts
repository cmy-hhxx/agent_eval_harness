import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {assistantModelConfiguration,GatewayAssistantModels,modelIdentity} from '../../../apps/host/src/assistant-models.js';
import {parseSettings} from '@eval/host-app/config';
import type {ModelConfig} from '@eval/contracts';
import {AssistantSessions} from '@eval/runtime/assistant';
import {assistantEndpoints} from '@eval/assistant/server';

const gateway: ModelConfig = {provider:'evaluation-gateway',model:'gpt-6-luna',baseUrl:'https://example.com/v1',
  api:'openai-responses',apiKeyEnv:'EVAL_CHANNEL_KEY_evaluation_Hgateway',thinking:'medium',contextWindow:131072,maxOutputTokens:8192};
const configuration = () => parseSettings(`
[channel.evaluation-gateway]
name = 评测网关
base_url = https://example.com/v1
api_key = first-secret
[channel.openai]
name = OpenAI
base_url = https://openai.example/v1
api_key = second-secret
model = gpt-6-luna
[agent]
channel = openai
model = gpt-6-luna
thinking = high
max_output_tokens = 4096
`);

test('Eris inherits Attribution unless an explicit channel and model are selected',()=>{
  const settings=configuration();
  const configured=assistantModelConfiguration(gateway,settings);
  assert.equal(configured.model.provider,'openai');
  assert.equal(configured.model.model,'gpt-6-luna');
  assert.equal(configured.model.apiKeyEnv,'EVAL_CHANNEL_KEY_openai');
  assert.equal(configured.model.thinking,'high');
  assert.equal(configured.model.maxOutputTokens,4096);
  settings.agent={};
  assert.equal(assistantModelConfiguration(gateway,settings).model.provider,'evaluation-gateway');
  assert.equal(assistantModelConfiguration(gateway,settings).model.contextWindow,1048576);
});

test('same model IDs across channels retain independent routing, scoped favorites and defaults',async()=>{
  const directory=await mkdtemp(tmpdir()+'/eris-model-routing-');
  const {model,gateways}=assistantModelConfiguration(gateway,configuration());
  const discovered:string[]=[];
  const models=new GatewayAssistantModels(directory,model,gateways,async config=>{
    discovered.push(config.apiKeyEnv);
    return [{id:'gpt-6-luna',name:'Luna',contextWindow:131072},{id:'gpt-5.6-luna',name:'Luna 5.6'}, {id:'gpt-6-sol',name:'Sol'},{id:'deepseek-chat',name:'DeepSeek'}];
  });
  try {
    const catalog=await models.list('alice');
    assert.equal(catalog.models.length,4);
    assert(catalog.models.every(model=>model.contextWindow===1048576));
    await assert.rejects(models.resolve({provider:'openai',model:'gpt-6-sol'}),/网关列表/);
    assert.deepEqual(catalog.favorites,[modelIdentity('openai','gpt-6-luna'),modelIdentity('evaluation-gateway','gpt-6-luna')]);
    assert.deepEqual(catalog.default,{provider:'openai',model:'gpt-6-luna',reasoningEffort:'high'});
    assert(!JSON.stringify(catalog).includes('secret'));
    assert(!JSON.stringify(catalog).includes('https://'));
    for(const provider of ['evaluation-gateway','openai']) {
      const resolved=await models.resolve({provider,model:'gpt-6-luna',reasoningEffort:'max'});
      assert.equal(resolved.contextWindow,1048576);
      assert.equal(resolved.apiKeyEnv,configuration().channels[provider].apiKeyEnv);
      assert.equal(resolved.baseUrl,configuration().channels[provider].baseUrl);
    }
    await models.favorites('alice',[modelIdentity('evaluation-gateway','gpt-6-luna')]);
    assert.equal((await models.list('alice')).default.provider,'evaluation-gateway');
    assert.equal((await models.list('bob')).default.provider,'openai');
    const restored=new GatewayAssistantModels(directory,model,gateways,async()=>[{id:'gpt-6-luna',name:'Shared'}]);
    assert.equal((await restored.list('alice')).default.provider,'evaluation-gateway');
    await assert.rejects(models.favorites('alice',['gpt-6-luna']),/可用/);
    await assert.rejects(models.resolve({provider:'unknown',model:'gpt-6-luna'}),/config.ini/);
    assert.deepEqual(discovered,['EVAL_CHANNEL_KEY_evaluation_Hgateway','EVAL_CHANNEL_KEY_openai']);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('channel whitelist, efforts and token limits are respected and missing configured models fail',async()=>{
  const settings=configuration();
  Object.assign(settings.channels.openai,{models:['gpt-6-luna'],efforts:['off','high','max']});
  const {model,gateways}=assistantModelConfiguration(gateway,settings);
  const models=new GatewayAssistantModels('/unused',model,gateways,async()=>[
    {id:'gpt-6-luna',name:'Shared',maxTokens:32768},{id:'gpt-5.6-luna',name:'Other'},
  ]);
  assert.equal((await models.resolve({provider:'openai',model:'gpt-6-luna'})).maxOutputTokens,4096);
  await assert.rejects(models.resolve({provider:'openai',model:'gpt-5.6-luna'}),/网关列表/);
  await assert.rejects(models.resolve({provider:'openai',model:'gpt-6-luna',reasoningEffort:'medium'}),/推理等级/);
  const missing=new GatewayAssistantModels('/unused',model,gateways,async()=>[{id:'gpt-5.6-luna',name:'Other'}]);
  await assert.rejects(missing.resolve({provider:'openai',model:'gpt-6-luna'}),/OpenAI.*缺少/);
});

test('the conversation picker keeps every channel visible when favorites only contain the original gateway',async()=>{
  const directory=await mkdtemp(tmpdir()+'/eris-channel-picker-');
  const settings=configuration(); settings.agent={};
  delete settings.channels.openai.model;
  const {model,gateways}=assistantModelConfiguration(gateway,settings);
  const models=new GatewayAssistantModels(directory,model,gateways,async()=>[
    {id:'gpt-6-luna',name:'Shared model'},{id:'gpt-5.6-luna',name:'Other model'},
  ]);
  const sessions=new AssistantSessions({directory,url:'http://127.0.0.1:1',model,models,systemPrompt:'test',tools:[]});
  const endpoints=assistantEndpoints(sessions);
  const catalog=()=>endpoints.call('alice','session/modelCatalog',{args:{request:{}}},new AbortController().signal) as Promise<{
    groups:{id:string;models:{id:string;provider:string}[]}[];default:{provider:string;model:string};
  }>;
  try {
    await models.favorites('alice',[modelIdentity('evaluation-gateway','gpt-5.6-luna'),modelIdentity('evaluation-gateway','gpt-6-luna')]);
    const result=await catalog();
    assert.deepEqual(result.groups.map(group=>[group.id,group.models.map(model=>model.id)]),[
      ['evaluation-gateway',['gpt-5.6-luna','gpt-6-luna']],['openai',['gpt-6-luna','gpt-5.6-luna']],
    ]);
    assert.equal(result.default.model,'gpt-5.6-luna');
    assert.equal(result.default.provider,'evaluation-gateway');
    const session=await sessions.create('alice');
    await sessions.selectModel({userId:'alice',sessionId:session.sessionId},{provider:'openai',model:'gpt-6-luna',reasoningEffort:'high'});
    assert.equal((await sessions.list('alice'))[0].modelSelection?.provider,'openai');
    const projections=await sessions.projections({userId:'alice',sessionId:session.sessionId}) as {values:{contextPressure:{contextWindow:number}}};
    assert.equal(projections.values.contextPressure.contextWindow,1048576,'the selected model refreshes capacity without requiring a model request');
    await models.favorites('alice',[modelIdentity('openai','gpt-6-luna')]);
    assert((await catalog()).groups.every(group=>group.models.length===2),'changing favorites must never hide other channels');
    assert(!JSON.stringify(result).includes('secret'));
  } finally {await sessions.dispose();await rm(directory,{recursive:true,force:true});}
});
