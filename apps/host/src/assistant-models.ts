import {errorText,redact,type AssistantModelCatalog,type AssistantModelDirectory,type AssistantModelSelection,type ModelConfig} from '@eval/contracts';
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
      contextWindow: selected.contextWindow ?? 1048576 },
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
  private loading?: Promise<AssistantModelCatalog>;
  private loaded?: AssistantModelCatalog;
  constructor(private directory: string, private model: ModelConfig, private gateways: AssistantGateway[], private discover: (config: ModelConfig) => ReturnType<typeof discoverAssistantModels> = discoverAssistantModels) {
    const providers = gateways.map(gateway=>gateway.model.provider);
    if (new Set(providers).size !== providers.length || !providers.includes(model.provider)) throw new Error('无效或重复的模型服务商配置');
  }
  private async catalog(refresh = false): Promise<AssistantModelCatalog> {
    if (!refresh && this.loaded) return this.loaded;
    if (!this.loading) this.loading = Promise.allSettled(this.gateways.map(async gateway=>{
      const rows = await this.discover(gateway.model);
      const expected = new Set([...(gateway.models?.map(model=>model.id) ?? []),
        ...(gateway.model.provider===this.model.provider ? [this.model.model] : [])]);
      const models = rows.filter(row=>/^gpt-\d+(?:\.\d+)?-luna(?:-|$)/i.test(row.id)
        && (!gateway.models || gateway.models.some(model=>model.id===row.id))).map(row=>({...row,
        contextWindow: gateway.model.contextWindow,
        name:gateway.models?.find(model=>model.id===row.id)?.name ?? row.name,
        provider:gateway.model.provider,providerName:gateway.name,
        reasoning:{defaultEffort:gateway.model.thinking,efforts:(gateway.efforts ?? THINKING_LEVELS).map(id=>({id,name:id}))},
      }));
      if (new Set(models.map(model=>model.id)).size !== models.length) throw new Error('渠道返回了重复的模型 ID');
      const missing = [...expected].filter(id=>!models.some(model=>model.id===id));
      const message = missing.length ? `缺少可用的配置模型：${missing.join('、')}` : undefined;
      if (!models.length) throw new Error(message ?? '未返回可用的 GPT Luna 模型');
      return {models,message};
    })).then(groups=>{
      const catalog: AssistantModelCatalog = {models:[],failures:[]};
      const secrets = this.gateways.map(gateway=>process.env[gateway.model.apiKeyEnv] ?? '');
      groups.forEach((group,index)=>{
        if (group.status==='fulfilled') catalog.models.push(...group.value.models);
        const message = group.status==='fulfilled' ? group.value.message : errorText(group.reason);
        if (message) catalog.failures.push({id:this.gateways[index].model.provider,name:this.gateways[index].name,message:redact(message,secrets)});
      });
      this.loaded = catalog.models.length ? catalog : undefined;
      if (!this.loaded) throw new Error(`没有可用的模型渠道：${catalog.failures.map(failure=>`${failure.name}：${failure.message}`).join('；')}`);
      return this.loaded;
    }).finally(()=>{this.loading=undefined;});
    return this.loading;
  }
  async list(userId: string, refresh = false) {
    const [{models,failures},saved]=await Promise.all([this.catalog(refresh),readAssistantFavorites(this.directory,userId)]);
    const available = new Set(models.map(model=>modelIdentity(model.provider,model.id)));
    const favorites=(saved ?? [modelIdentity(this.model.provider,this.model.model),...this.gateways.map(gateway=>modelIdentity(gateway.model.provider,gateway.model.model))])
      .filter((id,index,all)=>available.has(id) && all.indexOf(id)===index);
    const first=models.find(model=>modelIdentity(model.provider,model.id)===favorites[0])
      ?? models.find(model=>model.provider===this.model.provider && model.id===this.model.model)
      ?? models.find(model=>model.id===this.model.model) ?? models[0];
    if (!favorites.length) favorites.push(modelIdentity(first.provider,first.id));
    const config=this.gateways.find(gateway=>gateway.model.provider===first.provider)!.model;
    return {models,failures,favorites,default:{provider:first.provider,model:first.id,reasoningEffort:config.thinking}};
  }
  readFavorites(userId: string) { return readAssistantFavorites(this.directory,userId); }
  async favorites(userId: string, ids: string[]) {
    const {models}=await this.catalog();
    if (!ids.length || new Set(ids).size!==ids.length || ids.some(id=>!models.some(m=>modelIdentity(m.provider,m.id)===id))) throw new Error('至少勾选一个网关中可用的模型');
    await writeAssistantFavorites(this.directory,userId,ids);
  }
  async resolve(selection: AssistantModelSelection): Promise<ModelConfig> {
    const gateway=this.gateways.find(gateway=>gateway.model.provider===selection.provider);
    if(!gateway)throw new Error('只允许使用 config.ini 配置的网关');
    const {models,failures}=await this.catalog();
    const selected=models.find(m=>m.provider===selection.provider && m.id===selection.model);
    if(!selected){
      const failure=failures.find(failure=>failure.id===selection.provider);
      throw new Error(failure ? `${failure.name} 的所选模型不可用：${failure.message}` : '模型已不在网关列表中');
    }
    const efforts=gateway.efforts ?? THINKING_LEVELS;
    if(selection.reasoningEffort!==undefined&&!efforts.includes(selection.reasoningEffort))throw new Error('不支持的推理等级');
    const contextWindow=selected.contextWindow??gateway.model.contextWindow;
    const maxOutputTokens=selected.maxTokens??gateway.model.maxOutputTokens;
    return {...gateway.model,model:selected.id,thinking:selection.reasoningEffort??gateway.model.thinking,
      contextWindow:gateway.models?Math.min(contextWindow,gateway.model.contextWindow):contextWindow,
      maxOutputTokens:gateway.models?Math.min(maxOutputTokens,gateway.model.maxOutputTokens):maxOutputTokens};
  }
}
