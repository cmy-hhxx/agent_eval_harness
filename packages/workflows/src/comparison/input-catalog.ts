import { selectDatasetInputs } from "../inputs/catalog.js";
import type { EvalConfig } from "./types.js";

/** A comparison dataset must retain a complete configured pair. */
export async function selectDataset(config: EvalConfig, root: string, id: string): Promise<EvalConfig> {
  const selected = await selectDatasetInputs(config, root, id);
  const comparisons = config.comparisons.filter(group => group.every(version => selected.inputs.versions.some(item => item.id === version)));
  if (selected.inputs.versions.length < 2 || !comparisons.length)
    throw new Error(`评测集 ${id} 没有完整的已配置对比组`);
  return { ...selected, comparisons };
}
