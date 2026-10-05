import type {AssistantModelDirectory,AssistantModelEntry,AssistantModelSelection,ModelConfig} from '@eval/contracts';
import {readAssistantFavorites,writeAssistantFavorites} from '@eval/data';
import {discoverAssistantModels} from '@eval/runtime/assistant';
const efforts: ModelConfig['thinking'][] = ['off','minimal','low','medium','high','xhigh','max'];
/** Application-owned gateway configuration, with user-scoped common-model choices. */
export class GatewayAssistantModels implements AssistantModelDirectory {
  private loading?: Promise<AssistantModelEntry[]>;
  constructor(private directory: string, private model: ModelConfig, private discover = discoverAssistantModels) {}
  private catalog(refresh = false) {
    if (refresh || !this.loading) this.loading = this.discover(this.model).then(rows => rows.map(row => ({...row,
      reasoning: {defaultEffort:this.model.thinking,efforts:efforts.map(id=>({id,name:id}))},
    }))).catch(error=>{this.loading=undefined;throw error;});
    return this.loading;
  }
  async list(userId: string, refresh = false) {
    const [models,saved]=await Promise.all([this.catalog(refresh),readAssistantFavorites(this.directory,userId)]);
    const favorites=saved ?? [this.model.model];
    const first=favorites.find(id=>models.some(m=>m.id===id)) ?? this.model.model;
    return {models,favorites,default:{provider:this.model.provider,model:first,reasoningEffort:this.model.thinking}};
  }
  readFavorites(userId: string) { return readAssistantFavorites(this.directory,userId); }
  async favorites(userId: string, ids: string[]) {
    const models=await this.catalog();
    if (!ids.length || new Set(ids).size!==ids.length || ids.some(id=>!models.some(m=>m.id===id))) throw new Error('至少勾选一个网关中可用的模型');
    await writeAssistantFavorites(this.directory,userId,ids);
  }
  async resolve(selection: AssistantModelSelection): Promise<ModelConfig> {
    if(selection.provider!==this.model.provider)throw new Error('只允许使用 .env 配置的网关');
    const selected=(await this.catalog()).find(m=>m.id===selection.model);
    if(!selected)throw new Error('模型已不在网关列表中');
    if(selection.reasoningEffort!==undefined&&!efforts.includes(selection.reasoningEffort))throw new Error('不支持的推理等级');
    return {...this.model,model:selected.id,thinking:selection.reasoningEffort??this.model.thinking,
      contextWindow:selected.contextWindow??this.model.contextWindow,maxOutputTokens:selected.maxTokens??this.model.maxOutputTokens};
  }
}
