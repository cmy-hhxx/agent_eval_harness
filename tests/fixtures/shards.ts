import type { RunState } from "@eval/contracts";
import { attributionShards, type AttributionConfig } from "@eval/workflows/attribution";

/** Materialize the streamed shards into one plan; a real run dispatches each shard as it loads. */
export async function stagedAttributionPlan(config: AttributionConfig) {
  const state = { manifest: { config, tasks: [], states: {}, inputCatalog: [], inputs: {}, preflight: {} }, receipts: {} } as unknown as RunState;
  const source = attributionShards(config, state), inputs: Record<string, unknown> = {};
  for (let shard = await source.next(); shard; shard = await source.next()) {
    state.manifest.inputCatalog!.push(...shard.candidates);
    state.manifest.tasks.push(...shard.tasks);
    for (const task of shard.tasks) state.manifest.states[task.id] = { status: "pending", attempts: 0 };
    Object.defineProperties(inputs, Object.getOwnPropertyDescriptors(shard.inputs));
  }
  return { tasks: state.manifest.tasks, inputs, catalog: state.manifest.inputCatalog!, summary: state.manifest.preflight };
}
