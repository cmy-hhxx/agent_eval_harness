import { object, type PublicationInput, type PublicationCounts } from "@eval/contracts";
import path from "node:path";
import { completeCaseMetadata, fileSourceReader, readCaseMetadata, withPinnedInputSource } from "@eval/data";
import { normalizeInput } from "@eval/workflows/comparison";
import { publishMongo } from "@eval/runtime/client";
import type { AutomationConfig } from "./automation-config.js";
import { loadConfig, type HostConfig } from "./config.js";
import { automationMongoTarget, createAutomationMongoLane } from "./automation-sources.js";

/** Publish each validated file before installation; short batches share the output publication lane. */
export async function syncMongoInputFile(
  config: AutomationConfig, date: string, model: string, source: string, signal: AbortSignal,
  lane: ReturnType<typeof createAutomationMongoLane>, mongo = publishMongo, loadedHost?: HostConfig,
) {
  if (config.prediction || !config.remoteModels.includes(model)) throw new Error("Unexpected input publication model");
  const host = loadedHost ?? await loadConfig(config.hostConfigs);
  const version = host.evaluation.inputs.versions.find(item => item.id === model);
  if (!version) throw new Error("Input publication model is not configured");
  const settings = config.publication, uri = process.env[settings.mongoUriEnv];
  if (!uri) throw new Error("Missing " + settings.mongoUriEnv);
  const metadata = await readCaseMetadata(path.join(config.sourceDirectory, "case-meta.jsonl"));
  return withPinnedInputSource(source, async file => {
    const revision = await fileSourceReader.revision(file);
    const records: { byteOffset: number; byteLength: number; caseId: string }[] = [];
    const seen = new Set<string>(), duplicates = new Set<string>();
    const normalize = (line: string): PublicationInput => {
      const raw = completeCaseMetadata(normalizeInput(JSON.parse(line)), metadata), meta = object(raw.meta ?? {});
      const batch = raw.batch_id ?? meta.batch_id ?? date, caseId = raw.case_id ?? meta.case_id;
      if (batch !== date || typeof caseId !== "string" || !caseId ||
          (raw.version !== undefined && raw.version !== version.name) || !Array.isArray(raw.messages))
        throw new Error("Downloaded publication input identity differs from source");
      return { versionId: model, trace: { ...raw, batch_id: date, case_id: caseId, version: version.name } };
    };
    // Validate the entire file and quarantine every duplicate before the first write.
    let rows = 0, empty = 0;
    for await (const record of fileSourceReader.lines(file, revision)) {
      signal.throwIfAborted();
      if (!record.line.trim()) continue;
      rows++;
      const input = normalize(record.line);
      if (!(input.trace.messages as unknown[]).length) { empty++; continue; }
      const caseId = input.trace.case_id as string;
      if (seen.has(caseId)) duplicates.add(caseId);
      seen.add(caseId);
      records.push({ byteOffset: record.byteOffset, byteLength: record.byteLength, caseId });
    }
    const counts: PublicationCounts = { inputs: 0, comparisons: 0, inserted: 0, updated: 0 };
    let batch: PublicationInput[] = [], bytes = 0;
    async function flush() {
      if (!batch.length) return;
      const selected = batch;
      const result = await lane(() => mongo({
        uri: uri!, database: settings.mongoDatabase, collection: settings.mongoCollection, evaluationTaskId: config.id,
        tlsCAFile: process.env[settings.mongoTlsCAFileEnv], topic: settings.topic,
      }, date, (async function* () { yield* selected; })(), (async function* () {})(), signal),
      signal, JSON.stringify([automationMongoTarget(config), date]));
      for (const key of ["inputs", "comparisons", "inserted", "updated"] as const) counts[key] += result[key];
      batch = []; bytes = 0;
    }
    for (const record of records) {
      signal.throwIfAborted();
      if (duplicates.has(record.caseId)) continue;
      if (batch.length && (batch.length >= 16 || bytes + record.byteLength > 8 * 1024 * 1024)) await flush();
      batch.push(normalize(fileSourceReader.record(file, record.byteOffset, record.byteLength, revision)));
      bytes += record.byteLength;
    }
    await flush();
    return { model, revision, rows, empty, quarantined: records.filter(record => duplicates.has(record.caseId)).length, counts };
  });
}
