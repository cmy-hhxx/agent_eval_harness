import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { object, type PublicationResult } from "@eval/contracts";
import { writeJson } from "@eval/data";
import { publishMongo, readMongoPublicationInventory } from "@eval/runtime/client";
import { PublicationStatistics } from "@eval/workflows/comparison";
import type { AutomationJob } from "@eval/automations";
import type { AutomationConfig } from "./automation-config.js";
import { loadConfig } from "./config.js";
import { publicationSnapshot } from "./automation-publication.js";

/** Completed result revisions bypass long input uploads; existing paired inputs are mandatory. */
export async function syncMongoReadyResults(config: AutomationConfig, job: AutomationJob, signal: AbortSignal,
  dependencies = { snapshot: publicationSnapshot, inventory: readMongoPublicationInventory, mongo: publishMongo },
) {
  if (config.prediction) throw new Error("Prediction uses its exact replacement publication");
  await loadConfig(config.hostConfigs);
  const p = config.publication, uri = process.env[p.mongoUriEnv];
  if (!uri) throw new Error("Missing " + p.mongoUriEnv);
  const settings = { uri, database: p.mongoDatabase, collection: p.mongoCollection, evaluationTaskId: config.id,
    tlsCAFile: process.env[p.mongoTlsCAFileEnv], topic: p.topic, inputsUnchanged: true };
  const inventory = await dependencies.inventory(settings, job.date, signal);
  const key = (caseId: unknown, version: string) => JSON.stringify([caseId, version]);
  const knownInputs = new Set(inventory.inputs.map(input => key(input.trace.case_id, input.versionId)));
  const known = new Map(inventory.comparisons.map(row => [row.id, row.rewritten]));
  const snapshot = await dependencies.snapshot(config, job, signal);
  const selected: PublicationResult[] = [], inputKeys = new Set<string>();
  let waitingForInputs = 0;
  for await (const result of snapshot.results()) {
    const row = result.row, id = String(row.comparison_id);
    if (known.has(id) && isDeepStrictEqual(known.get(id), row.rewritten)) continue;
    const keys = Object.keys(object(row.models)).map(version => key(object(row.case).case_id, version));
    if (!keys.every(item => knownInputs.has(item))) { waitingForInputs++; continue; }
    selected.push(result); keys.forEach(item => inputKeys.add(item));
  }
  if (!selected.length) return { inputs: 0, comparisons: 0, inserted: 0, updated: 0, waitingForInputs };
  const validation = new PublicationStatistics(snapshot.comparisons);
  async function* inputs() {
    for (const input of inventory.inputs)
      if (inputKeys.has(key(input.trace.case_id, input.versionId))) yield input;
  }
  for await (const input of inputs()) validation.addInput(input);
  for (const result of selected) validation.addResult(result);
  const counts = await dependencies.mongo(settings, job.date, inputs(), (async function* () { yield* selected; })(), signal);
  const verified = new Map((await dependencies.inventory(settings, job.date, signal)).comparisons.map(row => [row.id, row.rewritten]));
  for (const { row } of selected)
    if (!verified.has(String(row.comparison_id)) || !isDeepStrictEqual(verified.get(String(row.comparison_id)), row.rewritten))
      throw new Error("Published comparison rewrite verification failed: " + row.comparison_id);
  const receipt = { at: new Date().toISOString(), source: config.id, date: job.date, topic: p.topic,
    comparisonIds: selected.map(({ row }) => row.comparison_id), counts, waitingForInputs };
  await writeJson(path.join(config.stateDirectory, "result-publications", job.date + ".json"), receipt);
  return { ...counts, waitingForInputs };
}

/** One nonblocking delivery per date; retry unacknowledged revisions without rerunning models. */
export function createMongoResultPublisher(config: AutomationConfig,
  failed: (error: unknown) => Promise<void>, publish = syncMongoReadyResults,
) {
  const active = new Map<string, Promise<void>>(), delivered = new Map<string, string>();
  return {
    observe(job: AutomationJob, signal: AbortSignal) {
      if (config.prediction || !process.env[config.publication.mongoUriEnv] || active.has(job.date) ||
          !job.summary?.readyComparisons) return;
      const revision = JSON.stringify([job.inputsUpdatedAt, job.summary.readyComparisons, job.summary.stages.rewrite?.completed]);
      if (delivered.get(job.date) === revision) return;
      const work = publish(config, structuredClone(job), signal).then(receipt => {
        if (!receipt.waitingForInputs) delivered.set(job.date, revision);
      }).catch(failed).finally(() => active.delete(job.date));
      active.set(job.date, work);
    },
    settled: () => Promise.all([...active.values()]),
  };
}
