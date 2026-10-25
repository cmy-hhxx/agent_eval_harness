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
model = gpt-6-luna
models = gpt-6-luna,gpt-5.6-luna
context_window = 131072
api_key = first-secret
[channel.openai]
name = OpenAI
base_url = https://openai.example/v1
models = gpt-6-luna,gpt-5.6-luna
context_window = 131072
api_key = second-secret
model = gpt-6-luna
[agent]
channel = openai
model = gpt-6-luna
thinking = high
max_output_tokens = 4096
`);

test('Eris requires an explicit independent channel and uses its capacity',()=>{
  const settings=configuration();
  const configured=assistantModelConfiguration(settings);
  assert.equal(configured.model.supportsDeveloperRole,false,'Eris instructions use system by default');
  assert.equal(settings.channels.openai.supportsDeveloperRole,undefined,'evaluation channel capabilities are unchanged');
  settings.channels.openai.supportsDeveloperRole=true;
  assert.equal(assistantModelConfiguration(settings).model.supportsDeveloperRole,true,'explicit channel capability takes precedence');
  assert.equal(configured.model.provider,'openai');
  assert.equal(configured.model.model,'gpt-6-luna');
  assert.equal(configured.model.apiKeyEnv,'EVAL_CHANNEL_KEY_openai');
  assert.equal(configured.model.thinking,'high');
  assert.equal(configured.model.maxOutputTokens,4096);
  settings.agent={};
  assert.throws(()=>assistantModelConfiguration(settings), /默认渠道/);
});

test('same model IDs across channels retain independent routing, scoped favorites and defaults',async()=>{
  const directory=await mkdtemp(tmpdir()+'/eris-model-routing-');
  const {model,gateways}=assistantModelConfiguration(configuration());
  const discovered:string[]=[];
  const models=new GatewayAssistantModels(directory,model,gateways,async config=>{
    discovered.push(config.apiKeyEnv);
    return [{id:'gpt-6-luna',name:'Luna',contextWindow:131072},{id:'gpt-5.6-luna',name:'Luna 5.6'}, {id:'gpt-6-sol',name:'Sol'},{id:'deepseek-chat',name:'DeepSeek'}];
  });
  try {
    const catalog=await models.list('alice');
    assert.equal(catalog.models.length,4);
    assert(catalog.models.every(model=>model.contextWindow===131072));
    await assert.rejects(models.resolve({provider:'openai',model:'gpt-6-sol'}),/网关列表/);
    assert.deepEqual(catalog.favorites,[modelIdentity('openai','gpt-6-luna'),modelIdentity('evaluation-gateway','gpt-6-luna')]);
    assert.deepEqual(catalog.default,{provider:'openai',model:'gpt-6-luna',reasoningEffort:'high'});
    assert(!JSON.stringify(catalog).includes('secret'));
    assert(!JSON.stringify(catalog).includes('https://'));
    for(const provider of ['evaluation-gateway','openai']) {
      const resolved=await models.resolve({provider,model:'gpt-6-luna',reasoningEffort:'max'});
      assert.equal(resolved.contextWindow,131072);
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
  const {model,gateways}=assistantModelConfiguration(settings);
  const models=new GatewayAssistantModels('/unused',model,gateways,async()=>[
    {id:'gpt-6-luna',name:'Shared',maxTokens:32768},{id:'gpt-5.6-luna',name:'Other'},
  ]);
  assert.equal((await models.resolve({provider:'openai',model:'gpt-6-luna'})).maxOutputTokens,4096);
  await assert.rejects(models.resolve({provider:'openai',model:'gpt-5.6-luna'}),/网关列表/);
  await assert.rejects(models.resolve({provider:'openai',model:'gpt-6-luna',reasoningEffort:'medium'}),/推理等级/);
  const missing=new GatewayAssistantModels('/unused',model,gateways,async()=>[{id:'gpt-5.6-luna',name:'Other'}]);
  await assert.rejects(missing.resolve({provider:'openai',model:'gpt-6-luna'}),/OpenAI.*缺少/);
});

test('a failed channel leaves the other channel selectable and catalog retries restore it',async(t)=>{
  for(const failed of ['openai','evaluation-gateway']) await t.test(failed,async()=>{
    const directory=await mkdtemp(tmpdir()+'/eris-channel-failure-');
    const {model,gateways}=assistantModelConfiguration(configuration());
    let offline=true;
    const discoveries:string[]=[];
    const models=new GatewayAssistantModels(directory,model,gateways,async config=>{
      discoveries.push(config.provider);
      if(offline&&config.provider===failed)throw new TypeError('fetch failed');
      return [{id:'gpt-6-luna',name:'Shared'},{id:'gpt-5.6-luna',name:'Other'}];
    });
    const sessions=new AssistantSessions({directory,url:'http://127.0.0.1:1',model,models,systemPrompt:'test',tools:[]});
    const endpoints=assistantEndpoints(sessions);
    const catalog=()=>endpoints.call('alice','session/modelCatalog',{},new AbortController().signal) as Promise<{
      groups:{id:string}[];failures:{id:string;name:string;message:string}[];default:{provider:string;model:string};
    }>;
    const healthy=failed==='openai'?'evaluation-gateway':'openai';
    try {
      const result=await catalog();
      assert.deepEqual(result.groups.map(group=>group.id),[healthy]);
      assert.equal(result.default.provider,healthy);
      assert.deepEqual(result.failures,[{id:failed,name:gateways.find(item=>item.model.provider===failed)!.name,message:'fetch failed'}]);
      const session=await sessions.create('alice');
      await sessions.selectModel({userId:'alice',sessionId:session.sessionId},result.default);
      assert.equal((await sessions.list('alice'))[0].modelSelection?.provider,healthy);
      const resolved=await models.resolve(result.default);
      assert.equal(resolved.baseUrl,configuration().channels[healthy].baseUrl);
      assert.equal(resolved.apiKeyEnv,configuration().channels[healthy].apiKeyEnv);
      assert.equal(discoveries.length,2,'selection and request resolution reuse the available catalog');
      await assert.rejects(models.resolve({provider:failed,model:'gpt-6-luna'}),/fetch failed/);
      offline=false;
      const recovered=await catalog();
      assert.equal(recovered.groups.length,2);
      assert.deepEqual(recovered.failures,[]);
      assert.equal(recovered.default.provider,'openai');
      assert.equal(discoveries.length,4,'the picker retry really refreshes provider discovery');
    } finally {await sessions.dispose();await rm(directory,{recursive:true,force:true});}
  });
});

test('a missing configured or default model leaves available models on the same channel selectable',async()=>{
  const directory=await mkdtemp(tmpdir()+'/eris-partial-models-');
  try {
    const models=new GatewayAssistantModels(directory,gateway,[{name:'评测网关',model:gateway,
      models:[{id:'gpt-6-luna',name:'Luna'},{id:'gpt-5.6-luna',name:'Luna 5.6'}]}],async()=>[
      {id:'gpt-5.6-luna',name:'Available'},
    ]);
    const catalog=await models.list('alice');
    assert.deepEqual(catalog.models.map(model=>model.id),['gpt-5.6-luna']);
    assert.match(catalog.failures[0]!.message,/gpt-6-luna/);
    assert.equal((await models.resolve({provider:gateway.provider,model:'gpt-5.6-luna'})).model,'gpt-5.6-luna');
    await assert.rejects(models.resolve({provider:gateway.provider,model:'gpt-6-luna'}),/gpt-6-luna/,
      'a saved unavailable selection must not be silently rerouted');
    const unfiltered=new GatewayAssistantModels(directory,gateway,[{name:'评测网关',model:gateway}],async()=>[
      {id:'gpt-5.6-luna',name:'Available'},
    ]);
    assert.equal((await unfiltered.list('alice')).models.length,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('unavailable favorites fall back to the same model on a healthy channel without overwriting preferences',async()=>{
  const directory=await mkdtemp(tmpdir()+'/eris-favorite-fallback-');
  const settings=configuration();delete settings.channels['evaluation-gateway'].model;
  const {model,gateways}=assistantModelConfiguration(settings);
  let offline=false;
  const models=new GatewayAssistantModels(directory,model,gateways,async config=>{
    if(offline&&config.provider==='openai')throw new TypeError('fetch failed');
    return [{id:'gpt-5.6-luna',name:'Other'},{id:'gpt-6-luna',name:'Shared'}];
  });
  const saved=[modelIdentity('openai','gpt-6-luna')];
  try {
    await models.favorites('alice',saved);
    offline=true;
    const fallback=await models.list('alice',true);
    assert.equal(fallback.default.provider,'evaluation-gateway');
    assert.equal(fallback.default.model,'gpt-6-luna');
    assert.deepEqual(fallback.favorites,[modelIdentity('evaluation-gateway','gpt-6-luna')]);
    assert.deepEqual(await models.readFavorites('alice'),saved);
    offline=false;
    const restored=await models.list('alice',true);
    assert.equal(restored.default.provider,'openai');
    assert.deepEqual(restored.favorites,saved);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('all failed channels report their names and can recover; concurrent loads share discovery',async()=>{
  const directory=await mkdtemp(tmpdir()+'/eris-catalog-retry-');
  const {model,gateways}=assistantModelConfiguration(configuration());
  let offline=true,discoveries=0;
  const models=new GatewayAssistantModels(directory,model,gateways,async()=>{
    discoveries++;
    if(offline)throw new TypeError('fetch failed');
    return [{id:'gpt-6-luna',name:'Shared'}];
  });
  try {
    const failed=await Promise.allSettled([models.list('alice'),models.list('bob',true)]);
    for(const result of failed){
      assert.equal(result.status,'rejected');
      if(result.status==='rejected')assert.match(result.reason.message,/评测网关.*fetch failed.*OpenAI.*fetch failed/);
    }
    assert.equal(discoveries,2);
    offline=false;
    assert.equal((await models.list('alice')).models.length,2);
    assert.equal(discoveries,4);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('the conversation picker keeps every channel visible when favorites only contain the original gateway',async()=>{
  const directory=await mkdtemp(tmpdir()+'/eris-channel-picker-');
  const settings=configuration(); settings.agent={channel:"evaluation-gateway",model:"gpt-6-luna"};
  delete settings.channels.openai.model;
  const {model,gateways}=assistantModelConfiguration(settings);
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
    const projections=await sessions.projections({userId:'alice',sessionId:session.sessionId}) as {kind:string;values:{contextPressure:{contextWindow:number}}};
    assert.equal(projections.kind,'sequenced','the current client requires an explicit projection-baseline discriminator');
    assert.equal(projections.values.contextPressure.contextWindow,131072,'the selected model refreshes capacity without requiring a model request');
    await models.favorites('alice',[modelIdentity('openai','gpt-6-luna')]);
    assert((await catalog()).groups.every(group=>group.models.length===2),'changing favorites must never hide other channels');
    assert(!JSON.stringify(result).includes('secret'));
  } finally {await sessions.dispose();await rm(directory,{recursive:true,force:true});}
});
