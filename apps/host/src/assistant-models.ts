import type {AssistantModelDirectory,AssistantModelEntry,AssistantModelSelection,ModelConfig} from '@eval/contracts';
import {readAssistantFavorites,writeAssistantFavorites} from '@eval/data';
import {discoverAssistantModels} from '@eval/runtime/assistant';
import {THINKING_LEVELS} from './models.js';

export interface AssistantGateway {
  name: string;
  model: ModelConfig;
  /** Only expose the explicitly selected models from this endpoint. */
  models?: {id: string; name: string}[];
  efforts?: readonly ModelConfig['thinking'][];
}

export function assistantModelConfiguration(gatewayModel: ModelConfig, env: NodeJS.ProcessEnv = process.env) {
  const gateways: AssistantGateway[] = [{name:'评测网关',model:gatewayModel}];
  if (!!env.DEEPSEEK_URL !== !!env.DEEPSEEK_KEY) throw new Error('请同时配置 DEEPSEEK_URL 和 DEEPSEEK_KEY');
  let model = gatewayModel;
  if (env.DEEPSEEK_URL && env.DEEPSEEK_KEY) {
    const deepseek: ModelConfig = {provider:'deepseek',model:'deepseek-flash',baseUrl:env.DEEPSEEK_URL,
      api:'openai-responses',apiKeyEnv:'DEEPSEEK_KEY',supportsDeveloperRole:false,thinking:'high',
      contextWindow:Number(env.AGENT_CONTEXT_WINDOW ?? 1048576),maxOutputTokens:Number(env.AGENT_MAX_TOKENS ?? 8192)};
    for (const [name,value] of [['AGENT_CONTEXT_WINDOW',deepseek.contextWindow],['AGENT_MAX_TOKENS',deepseek.maxOutputTokens]] as const)
      if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
    gateways.push({name:'DeepSeek',model:deepseek,models:[{id:deepseek.model,name:'DeepSeek V4.1 Flash'}],efforts:['off','low','high','max']});
    if (!env.AGENT_MODEL || env.AGENT_MODEL === deepseek.model) model = deepseek;
  } else if (env.AGENT_MODEL === 'deepseek-flash') throw new Error('请配置 DEEPSEEK_URL 和 DEEPSEEK_KEY');
  return {model,gateways};
}

/** Application-owned endpoints and routing, with user-scoped common-model choices. */
export class GatewayAssistantModels implements AssistantModelDirectory {
  private loading?: Promise<AssistantModelEntry[]>;
  constructor(private directory: string, private model: ModelConfig, private gateways: AssistantGateway[], private discover: (config: ModelConfig) => ReturnType<typeof discoverAssistantModels> = discoverAssistantModels) {
    const providers = gateways.map(gateway=>gateway.model.provider);
    if (new Set(providers).size !== providers.length || !providers.includes(model.provider)) throw new Error('无效或重复的模型服务商配置');
  }
  private catalog(refresh = false) {
    if (refresh || !this.loading) this.loading = Promise.all(this.gateways.map(async gateway=>{
      const rows = await this.discover(gateway.model);
      if (gateway.models?.some(model=>!rows.some(row=>row.id===model.id))) throw new Error(`${gateway.name} 中缺少配置的模型`);
      return rows.filter(row=>!gateway.models || gateway.models.some(model=>model.id===row.id)).map(row=>({...row,
        name:gateway.models?.find(model=>model.id===row.id)?.name ?? row.name,
        provider:gateway.model.provider,providerName:gateway.name,
        reasoning:{defaultEffort:gateway.model.thinking,efforts:(gateway.efforts ?? THINKING_LEVELS).map(id=>({id,name:id}))},
      }));
    })).then(groups=>{
      const models = groups.flat();
      if (new Set(models.map(model=>model.id)).size !== models.length) throw new Error('配置的网关返回了重复的模型 ID');
      if (!models.some(model=>model.provider===this.model.provider && model.id===this.model.model)) throw new Error('默认模型已不在配置的网关列表中');
      return models;
    }).catch(error=>{this.loading=undefined;throw error;});
    return this.loading;
  }
  async list(userId: string, refresh = false) {
    const [models,saved]=await Promise.all([this.catalog(refresh),readAssistantFavorites(this.directory,userId)]);
    const favorites=saved ?? [...new Set([this.model.model,...this.gateways.map(gateway=>gateway.model.model)])]
      .filter(id=>models.some(model=>model.id===id));
    const first=models.find(model=>model.id===(favorites.find(id=>models.some(m=>m.id===id)) ?? this.model.model))!;
    const config=this.gateways.find(gateway=>gateway.model.provider===first.provider)!.model;
    return {models,favorites,default:{provider:first.provider,model:first.id,reasoningEffort:config.thinking}};
  }
  readFavorites(userId: string) { return readAssistantFavorites(this.directory,userId); }
  async favorites(userId: string, ids: string[]) {
    const models=await this.catalog();
    if (!ids.length || new Set(ids).size!==ids.length || ids.some(id=>!models.some(m=>m.id===id))) throw new Error('至少勾选一个网关中可用的模型');
    await writeAssistantFavorites(this.directory,userId,ids);
  }
  async resolve(selection: AssistantModelSelection): Promise<ModelConfig> {
    const gateway=this.gateways.find(gateway=>gateway.model.provider===selection.provider);
    if(!gateway)throw new Error('只允许使用 .env 配置的网关');
    const selected=(await this.catalog()).find(m=>m.provider===selection.provider && m.id===selection.model);
    if(!selected)throw new Error('模型已不在网关列表中');
    const efforts=gateway.efforts ?? THINKING_LEVELS;
    if(selection.reasoningEffort!==undefined&&!efforts.includes(selection.reasoningEffort))throw new Error('不支持的推理等级');
    const contextWindow=selected.contextWindow??gateway.model.contextWindow;
    const maxOutputTokens=selected.maxTokens??gateway.model.maxOutputTokens;
    return {...gateway.model,model:selected.id,thinking:selection.reasoningEffort??gateway.model.thinking,
      contextWindow:gateway.model.provider==='deepseek'?Math.min(contextWindow,gateway.model.contextWindow):contextWindow,
      maxOutputTokens:gateway.model.provider==='deepseek'?Math.min(maxOutputTokens,gateway.model.maxOutputTokens):maxOutputTokens};
  }
}
