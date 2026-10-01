import {object, type ModelConfig, type AssistantModelEntry} from '@eval/contracts';

/** Discover only the configured gateway. Credentials never cross the browser boundary. */
export async function discoverAssistantModels(config: Pick<ModelConfig, 'baseUrl' | 'apiKeyEnv'>): Promise<AssistantModelEntry[]> {
  const key = process.env[config.apiKeyEnv];
  if (!key) throw new Error(`Missing ${config.apiKeyEnv}`);
  const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/models', {
    headers: {Authorization: `Bearer ${key}`}, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`网关模型列表请求失败（HTTP ${response.status}）`);
  const body = object(await response.json());
  if (!Array.isArray(body.data)) throw new Error('网关模型列表缺少 data 数组');
  const seen = new Set<string>();
  return body.data.map(object).map(row => {
    if (typeof row.id !== 'string' || !row.id.trim() || seen.has(row.id)) throw new Error('网关返回了无效或重复的模型 ID');
    seen.add(row.id);
    const capacity = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
    return {id:row.id,name:typeof row.name === 'string' ? row.name : row.id,
      contextWindow:capacity(row.context_window),maxTokens:capacity(row.max_output_tokens)};
  });
}
