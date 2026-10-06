import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {assistantModelConfiguration,GatewayAssistantModels} from '../../../apps/host/src/assistant-models.js';
import type {ModelConfig} from '@eval/contracts';

const gateway: ModelConfig = {provider:'evaluation-gateway',model:'MiniMax-M3',baseUrl:'https://example.com/v1',
  api:'openai-responses',apiKeyEnv:'EVAL_API_KEY',thinking:'medium',contextWindow:131072,maxOutputTokens:8192};
const env = {DEEPSEEK_URL:'https://api.deepseek.com',DEEPSEEK_KEY:'fixture'};

test('Eris exposes only Flash on the independent DeepSeek endpoint and honors explicit initial models and limits',()=>{
  const configured = assistantModelConfiguration(gateway,env);
  assert.equal(configured.model.provider,'deepseek');
  assert.equal(configured.model.model,'deepseek-flash');
  assert.equal(configured.model.baseUrl,env.DEEPSEEK_URL);
  assert.equal(configured.model.apiKeyEnv,'DEEPSEEK_KEY');
  assert.equal(configured.model.api,'openai-responses');
  assert.equal(configured.model.supportsDeveloperRole,false);
  assert.equal(configured.model.thinking,'high');
  assert.equal(configured.model.contextWindow,1048576);
  assert.deepEqual(configured.gateways[1].models,[{id:'deepseek-flash',name:'DeepSeek V4.1 Flash'}]);
  assert.deepEqual(configured.gateways[1].efforts,['off','low','high','max']);
  assert.equal(assistantModelConfiguration(gateway,{}).model,gateway);
  assert.equal(assistantModelConfiguration(gateway,{...env,AGENT_MODEL:'MiniMax-M3'}).model,gateway);
  assert.equal(assistantModelConfiguration(gateway,{...env,AGENT_MODEL:'deepseek-flash'}).model.model,'deepseek-flash');
  const limited = assistantModelConfiguration(gateway,{...env,AGENT_CONTEXT_WINDOW:'64000',AGENT_MAX_TOKENS:'4096'}).model;
  assert.equal(limited.contextWindow,64000);assert.equal(limited.maxOutputTokens,4096);
  for (const partial of [{DEEPSEEK_URL:env.DEEPSEEK_URL},{DEEPSEEK_KEY:'fixture'},{AGENT_MODEL:'deepseek-flash'}])
    assert.throws(()=>assistantModelConfiguration(gateway,partial),/DEEPSEEK_URL.*DEEPSEEK_KEY/);
  for (const value of ['0','-1','1.5','invalid'])
    assert.throws(()=>assistantModelConfiguration(gateway,{...env,AGENT_MAX_TOKENS:value}),/AGENT_MAX_TOKENS/);
});

test('configured providers retain their routing, scoped favorites, efforts and application token limits',async()=>{
  const directory=await mkdtemp(tmpdir()+'/eris-model-routing-');
  const {model,gateways}=assistantModelConfiguration(gateway,env);
  const discovered:string[]=[];
  const models=new GatewayAssistantModels(directory,model,gateways,async config=>{
    discovered.push(config.apiKeyEnv);
    return config.provider==='deepseek'
      ? [{id:'deepseek-flash',name:'deepseek-flash',contextWindow:1048576,maxTokens:393216},{id:'deepseek-v4-pro',name:'Pro'}]
      : [{id:'MiniMax-M3',name:'MiniMax-M3',contextWindow:200000,maxTokens:16384}];
  });
  try {
    const catalog=await models.list('alice');
    assert.deepEqual(catalog.models.map(row=>[row.provider,row.id]),[['evaluation-gateway','MiniMax-M3'],['deepseek','deepseek-flash']]);
    assert.deepEqual(catalog.favorites,['deepseek-flash','MiniMax-M3']);
    assert.deepEqual(catalog.default,{provider:'deepseek',model:'deepseek-flash',reasoningEffort:'high'});
    assert(!JSON.stringify(catalog).includes('fixture'));
    assert(!JSON.stringify(catalog).includes('api.deepseek.com'));
    const resolved=await models.resolve({provider:'deepseek',model:'deepseek-flash',reasoningEffort:'max'});
    assert.equal(resolved.baseUrl,env.DEEPSEEK_URL);assert.equal(resolved.apiKeyEnv,'DEEPSEEK_KEY');
    assert.equal(resolved.thinking,'max');assert.equal(resolved.maxOutputTokens,8192);
    const minimax=await models.resolve({provider:'evaluation-gateway',model:'MiniMax-M3'});
    assert.equal(minimax.baseUrl,gateway.baseUrl);assert.equal(minimax.apiKeyEnv,'EVAL_API_KEY');
    assert.equal(minimax.thinking,'medium');assert.equal(minimax.contextWindow,200000);assert.equal(minimax.maxOutputTokens,16384);
    await assert.rejects(models.resolve({provider:'deepseek',model:'MiniMax-M3'}),/网关列表/);
    await assert.rejects(models.resolve({provider:'evaluation-gateway',model:'deepseek-flash'}),/网关列表/);
    await assert.rejects(models.resolve({provider:'deepseek',model:'deepseek-v4-pro'}),/网关列表/);
    await assert.rejects(models.resolve({provider:'deepseek',model:'deepseek-flash',reasoningEffort:'medium'}),/推理等级/);
    await assert.rejects(models.favorites('alice',['deepseek-v4-pro']),/可用/);
    await models.favorites('alice',['MiniMax-M3','deepseek-flash']);
    assert.equal((await models.list('alice')).default.provider,'evaluation-gateway');
    assert.equal((await models.list('bob')).default.provider,'deepseek');
    await models.favorites('alice',['deepseek-flash','MiniMax-M3']);
    assert.equal((await models.list('alice')).default.provider,'deepseek');
    assert.deepEqual(discovered,['EVAL_API_KEY','DEEPSEEK_KEY']);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('missing configured Flash and duplicate model identities fail visibly',async()=>{
  const {model,gateways}=assistantModelConfiguration(gateway,env);
  const missing=new GatewayAssistantModels('/unused',model,gateways,async config=>[
    {id:config.provider==='deepseek'?'deepseek-v4-pro':'MiniMax-M3',name:'fixture'},
  ]);
  await assert.rejects(missing.resolve({provider:'deepseek',model:'deepseek-flash'}),/DeepSeek.*缺少/);
  const duplicate=new GatewayAssistantModels('/unused',model,gateways,async()=>[
    {id:'MiniMax-M3',name:'MiniMax-M3'},{id:'deepseek-flash',name:'Flash'},
  ]);
  await assert.rejects(duplicate.resolve({provider:'deepseek',model:'deepseek-flash'}),/重复的模型 ID/);
});
