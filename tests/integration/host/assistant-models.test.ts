import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {assistantModelConfiguration,GatewayAssistantModels,modelIdentity} from '../../../apps/host/src/assistant-models.js';
import {parseSettings} from '@eval/host-app/config';
import type {ModelConfig} from '@eval/contracts';
import {AssistantSessions} from '@eval/runtime/assistant';
import {assistantEndpoints} from '@eval/assistant/server';

const gateway: ModelConfig = {provider:'evaluation-gateway',model:'shared',baseUrl:'https://example.com/v1',
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
model = shared
[agent]
channel = openai
model = shared
thinking = high
max_output_tokens = 4096
`);

test('Eris inherits Attribution unless an explicit channel and model are selected',()=>{
  const settings=configuration();
  const configured=assistantModelConfiguration(gateway,settings);
  assert.equal(configured.model.provider,'openai');
  assert.equal(configured.model.model,'shared');
  assert.equal(configured.model.apiKeyEnv,'EVAL_CHANNEL_KEY_openai');
  assert.equal(configured.model.thinking,'high');
  assert.equal(configured.model.maxOutputTokens,4096);
  settings.agent={};
  assert.equal(assistantModelConfiguration(gateway,settings).model.provider,'evaluation-gateway');
  assert.equal(assistantModelConfiguration(gateway,settings).model.contextWindow,131072);
});

test('same model IDs across channels retain independent routing, scoped favorites and defaults',async()=>{
  const directory=await mkdtemp(tmpdir()+'/eris-model-routing-');
  const {model,gateways}=assistantModelConfiguration(gateway,configuration());
  const discovered:string[]=[];
  const models=new GatewayAssistantModels(directory,model,gateways,async config=>{
    discovered.push(config.apiKeyEnv);
    return [{id:'shared',name:'Shared model'},{id:'other',name:'Other model'}];
  });
  try {
    const catalog=await models.list('alice');
    assert.equal(catalog.models.length,4);
    assert.deepEqual(catalog.favorites,[modelIdentity('openai','shared'),modelIdentity('evaluation-gateway','shared')]);
    assert.deepEqual(catalog.default,{provider:'openai',model:'shared',reasoningEffort:'high'});
    assert(!JSON.stringify(catalog).includes('secret'));
    assert(!JSON.stringify(catalog).includes('https://'));
    for(const provider of ['evaluation-gateway','openai']) {
      const resolved=await models.resolve({provider,model:'shared',reasoningEffort:'max'});
      assert.equal(resolved.apiKeyEnv,configuration().channels[provider].apiKeyEnv);
      assert.equal(resolved.baseUrl,configuration().channels[provider].baseUrl);
    }
    await models.favorites('alice',[modelIdentity('evaluation-gateway','shared')]);
    assert.equal((await models.list('alice')).default.provider,'evaluation-gateway');
    assert.equal((await models.list('bob')).default.provider,'openai');
    const restored=new GatewayAssistantModels(directory,model,gateways,async()=>[{id:'shared',name:'Shared'}]);
    assert.equal((await restored.list('alice')).default.provider,'evaluation-gateway');
    await assert.rejects(models.favorites('alice',['shared']),/可用/);
    await assert.rejects(models.resolve({provider:'unknown',model:'shared'}),/config.ini/);
    assert.deepEqual(discovered,['EVAL_CHANNEL_KEY_evaluation_Hgateway','EVAL_CHANNEL_KEY_openai']);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('channel whitelist, efforts and token limits are respected and missing configured models fail',async()=>{
  const settings=configuration();
  Object.assign(settings.channels.openai,{models:['shared'],efforts:['off','high','max']});
  const {model,gateways}=assistantModelConfiguration(gateway,settings);
  const models=new GatewayAssistantModels('/unused',model,gateways,async()=>[
    {id:'shared',name:'Shared',maxTokens:32768},{id:'other',name:'Other'},
  ]);
  assert.equal((await models.resolve({provider:'openai',model:'shared'})).maxOutputTokens,4096);
  await assert.rejects(models.resolve({provider:'openai',model:'other'}),/网关列表/);
  await assert.rejects(models.resolve({provider:'openai',model:'shared',reasoningEffort:'medium'}),/推理等级/);
  const missing=new GatewayAssistantModels('/unused',model,gateways,async()=>[{id:'other',name:'Other'}]);
  await assert.rejects(missing.resolve({provider:'openai',model:'shared'}),/OpenAI.*缺少/);
});

test('the conversation picker keeps every channel visible when favorites only contain the original gateway',async()=>{
  const directory=await mkdtemp(tmpdir()+'/eris-channel-picker-');
  const settings=configuration(); settings.agent={};
  delete settings.channels.openai.model;
  const {model,gateways}=assistantModelConfiguration(gateway,settings);
  const models=new GatewayAssistantModels(directory,model,gateways,async()=>[
    {id:'shared',name:'Shared model'},{id:'other',name:'Other model'},
  ]);
  const sessions=new AssistantSessions({directory,url:'http://127.0.0.1:1',model,models,systemPrompt:'test',tools:[]});
  const endpoints=assistantEndpoints(sessions);
  const catalog=()=>endpoints.call('alice','session/modelCatalog',{args:{request:{}}},new AbortController().signal) as Promise<{
    groups:{id:string;models:{id:string;provider:string}[]}[];default:{provider:string;model:string};
  }>;
  try {
    await models.favorites('alice',[modelIdentity('evaluation-gateway','other'),modelIdentity('evaluation-gateway','shared')]);
    const result=await catalog();
    assert.deepEqual(result.groups.map(group=>[group.id,group.models.map(model=>model.id)]),[
      ['evaluation-gateway',['other','shared']],['openai',['shared','other']],
    ]);
    assert.equal(result.default.model,'other');
    assert.equal(result.default.provider,'evaluation-gateway');
    const session=await sessions.create('alice');
    await sessions.selectModel({userId:'alice',sessionId:session.sessionId},{provider:'openai',model:'shared',reasoningEffort:'high'});
    assert.equal((await sessions.list('alice'))[0].modelSelection?.provider,'openai');
    await models.favorites('alice',[modelIdentity('openai','shared')]);
    assert((await catalog()).groups.every(group=>group.models.length===2),'changing favorites must never hide other channels');
    assert(!JSON.stringify(result).includes('secret'));
  } finally {await sessions.dispose();await rm(directory,{recursive:true,force:true});}
});
