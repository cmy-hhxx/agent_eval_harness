import type {AssistantModelDirectory,AssistantModelEntry,AssistantModelSelection,ModelConfig} from '@eval/contracts';
import {readAssistantFavorites,writeAssistantFavorites} from '@eval/data';
import {discoverAssistantModels} from '@eval/runtime/assistant';
import {THINKING_LEVELS, DEFAULT_THINKING} from './models.js';
import type {ApplicationSettings} from './settings.js';

export interface AssistantGateway {
  name: string;
  model: ModelConfig;
  /** Only expose the explicitly selected models from this endpoint. */
  models?: {id: string; name: string}[];
  efforts?: readonly ModelConfig['thinking'][];
}

export function assistantModelConfiguration(gatewayModel: ModelConfig, configuration: ApplicationSettings) {
  const selected = configuration.agent;
  const gateways: AssistantGateway[] = Object.values(configuration.channels).map(channel => ({
    name: channel.name,
    model: { ...channel, model: channel.model ?? "", thinking: channel.thinking ?? DEFAULT_THINKING,
      maxOutputTokens: channel.maxOutputTokens ?? 8192,
      ...(channel.provider === gatewayModel.provider ? gatewayModel : {}),
      contextWindow: selected.contextWindow ?? 512000 },
    models: channel.models?.map(id => ({ id, name: id })), efforts: channel.efforts,
  }));
  const gateway = gateways.find(item => item.model.provider === (selected.channel ?? gatewayModel.provider));
  if (!gateway) throw new Error('Eris 默认渠道未在 config.ini 中配置');
  const model: ModelConfig = { ...gateway.model,
    model: selected.model ?? gateway.model.model,
    thinking: selected.thinking ?? gateway.model.thinking,
    contextWindow: selected.contextWindow ?? gateway.model.contextWindow,
    maxOutputTokens: selected.maxOutputTokens ?? gateway.model.maxOutputTokens };
  if (!model.model) throw new Error('请配置 config.ini [agent].model 或该渠道的 model');
  if (gateway.efforts && !gateway.efforts.includes(model.thinking)) throw new Error('Eris 默认推理等级不受渠道支持');
  gateway.model = model;
  return { model, gateways };
}

export function modelIdentity(provider: string, model: string): string { return JSON.stringify([provider, model]); }

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
      return rows.filter(row=>/^gpt-\d+(?:\.\d+)?-luna(?:-|$)/i.test(row.id)
        && (!gateway.models || gateway.models.some(model=>model.id===row.id))).map(row=>({...row,
        contextWindow: gateway.model.contextWindow,
        name:gateway.models?.find(model=>model.id===row.id)?.name ?? row.name,
        provider:gateway.model.provider,providerName:gateway.name,
        reasoning:{defaultEffort:gateway.model.thinking,efforts:(gateway.efforts ?? THINKING_LEVELS).map(id=>({id,name:id}))},
      }));
    })).then(groups=>{
      const models = groups.flat();
      if (new Set(models.map(model=>modelIdentity(model.provider,model.id))).size !== models.length) throw new Error('配置的渠道返回了重复的模型 ID');
      if (!models.some(model=>model.provider===this.model.provider && model.id===this.model.model)) throw new Error('默认模型已不在配置的网关列表中');
      return models;
    }).catch(error=>{this.loading=undefined;throw error;});
    return this.loading;
  }
  async list(userId: string, refresh = false) {
    const [models,saved]=await Promise.all([this.catalog(refresh),readAssistantFavorites(this.directory,userId)]);
    const available = new Set(models.map(model=>modelIdentity(model.provider,model.id)));
    const favorites=(saved ?? [modelIdentity(this.model.provider,this.model.model),...this.gateways.map(gateway=>modelIdentity(gateway.model.provider,gateway.model.model))])
      .filter((id,index,all)=>available.has(id) && all.indexOf(id)===index);
    const first=models.find(model=>modelIdentity(model.provider,model.id)===(favorites[0] ?? modelIdentity(this.model.provider,this.model.model)))!;
    const config=this.gateways.find(gateway=>gateway.model.provider===first.provider)!.model;
    return {models,favorites,default:{provider:first.provider,model:first.id,reasoningEffort:config.thinking}};
  }
  readFavorites(userId: string) { return readAssistantFavorites(this.directory,userId); }
  async favorites(userId: string, ids: string[]) {
    const models=await this.catalog();
    if (!ids.length || new Set(ids).size!==ids.length || ids.some(id=>!models.some(m=>modelIdentity(m.provider,m.id)===id))) throw new Error('至少勾选一个网关中可用的模型');
    await writeAssistantFavorites(this.directory,userId,ids);
  }
  async resolve(selection: AssistantModelSelection): Promise<ModelConfig> {
    const gateway=this.gateways.find(gateway=>gateway.model.provider===selection.provider);
    if(!gateway)throw new Error('只允许使用 config.ini 配置的网关');
    const selected=(await this.catalog()).find(m=>m.provider===selection.provider && m.id===selection.model);
    if(!selected)throw new Error('模型已不在网关列表中');
    const efforts=gateway.efforts ?? THINKING_LEVELS;
    if(selection.reasoningEffort!==undefined&&!efforts.includes(selection.reasoningEffort))throw new Error('不支持的推理等级');
    const contextWindow=selected.contextWindow??gateway.model.contextWindow;
    const maxOutputTokens=selected.maxTokens??gateway.model.maxOutputTokens;
    return {...gateway.model,model:selected.id,thinking:selection.reasoningEffort??gateway.model.thinking,
      contextWindow:gateway.models?Math.min(contextWindow,gateway.model.contextWindow):contextWindow,
      maxOutputTokens:gateway.models?Math.min(maxOutputTokens,gateway.model.maxOutputTokens):maxOutputTokens};
  }
}
