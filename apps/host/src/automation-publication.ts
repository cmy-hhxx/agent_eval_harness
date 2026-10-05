import path from "node:path";
import { object, REMOTE_MODELS, type JsonObject, type PublicationInput, type PublicationResult } from "@eval/contracts";
import { appendStatisticsLog, readJsonl, readStatisticsLog } from "@eval/data";
import { publishMongo, readMongoLabels, uploadStatisticsLog } from "@eval/runtime/client";
import { PublicationStatistics, publishableComparisons, locateRecordStream, assertStatisticsLog, assertCompleteComparisonRewrite, type EvalConfig } from "@eval/workflows/comparison";
import type { AutomationJob, AutomationState } from "@eval/automations";
import type { AutomationConfig } from "./automation-config.js";
import { checkpoint } from "./automation-evaluation.js";
import { loadConfig } from "./config.js";

/** Reads immutable input files pinned by the publication lane and accepts only settled result references. */
async function publicationSnapshot(config: AutomationConfig, job: AutomationJob, signal: AbortSignal) {
  const host = await loadConfig(config.hostConfigs);
  const runs = await Promise.all(job.runIds.map(async (id) => ({ id, state: await checkpoint(host.evaluation.output.path, id) })));
  async function* inputs(): AsyncGenerator<PublicationInput> {
    const seen = new Set<string>();
    for (const version of host.evaluation.inputs.versions) {
      const id = version.id;
      const registered = [...new Set(runs.flatMap(({ state }) => Object.values(state?.inputs ?? {})
        .filter((input) => input.version === id && input.batch_id === job.date).map((input) => input.source)))];
      const files = job.adopted ? [...new Set(runs.flatMap(({ state }) => Object.values(state?.inputs ?? {})
        .filter((input) => input.version === id).map((input) => input.source)))] : (REMOTE_MODELS as readonly string[]).includes(id)
          ? [path.join(config.sourceDirectory, job.date, id + ".jsonl")] : registered;
      for (const file of files) for await (const item of readJsonl(file)) {
        signal.throwIfAborted();
        const raw = object(item), meta = object(raw.meta ?? {});
        if (!Array.isArray(raw.messages)) throw new Error("Publication input messages must be an array");
        if (!raw.messages.length) continue;
        const batch = raw.batch_id ?? meta.batch_id ?? job.date, caseId = raw.case_id ?? meta.case_id;
        if (batch !== job.date) continue;
        if (typeof caseId !== "string" || !caseId ||
            (raw.version !== undefined && raw.version !== version.name)) throw new Error("Publication input identity differs from source");
        if (seen.has(JSON.stringify([caseId, id]))) throw new Error("Duplicate publication input identity");
        seen.add(JSON.stringify([caseId, id]));
        yield { versionId: id, trace: { ...raw, batch_id: batch, case_id: caseId, version: version.name } };
      }
    }
    // Accepted results may reference records no longer present in the current remote snapshot.
    for (const { state } of runs) if (state) {
      const acceptedInputs = new Set(Object.values(state.tasks).filter((task) => task.stage === "comparison" && !task.data.verificationAudit && task.receipt)
        .flatMap((task) => Object.values(task.inputIds)));
      for (const inputId of acceptedInputs) {
        const candidate = state.inputs[inputId], key = JSON.stringify([candidate.case_id, candidate.version]);
        if (seen.has(key)) continue;
        const version = (state.config as EvalConfig).inputs.versions.find((item) => item.id === candidate.version);
        if (!version) throw new Error("Accepted publication input version is not registered: " + candidate.version);
        const { raw } = await locateRecordStream(candidate.source, { ...candidate, input_id: inputId }, version, job.date);
        seen.add(key);
        yield { versionId: candidate.version, trace: { ...raw, batch_id: candidate.batch_id, case_id: candidate.case_id, version: version.name } };
      }
    }
  }
  async function* results(): AsyncGenerator<PublicationResult> {
    for (const { id, state } of runs) {
      if (!state) continue;
      const requireItems = !job.adopted || (state.config as EvalConfig).rewrite.comparisonItems === true;
      const ready = publishableComparisons(state, requireItems);
      if (!ready.size) continue;
      const labels = new Map(Object.values(state.tasks).filter((task) => task.stage === "comparison" && !task.data.verificationAudit)
        .map((task) => [task.data.comparisonId, Object.keys(task.inputIds)]));
      for await (const item of readJsonl(path.join(host.evaluation.output.path, id, "results/comparison.jsonl"))) {
        signal.throwIfAborted();
        const row = object(item), key = String(row.comparison_id), evaluatedAt = ready.get(key);
        if (evaluatedAt === undefined) continue;
        if (object(row.case).batch_id !== job.date) throw new Error("Publication result belongs to another date");
        if (requireItems) assertCompleteComparisonRewrite(row, labels.get(key)!);
        ready.delete(key);
        yield { row, evaluatedAt };
      }
      if (ready.size) throw new Error(`Accepted comparison rows missing in ${id}: ${ready.size}`);
    }
  }
  const comparisons = runs.flatMap(({ state }) => state ? [
    ...(state.config as EvalConfig).comparisons,
    ...Object.values(state.tasks).flatMap((task) => task.stage === "comparison" && !task.data.verificationAudit && task.receipt && task.data.group ? [task.data.group] : []),
  ] : []);
  return { inputs, results, comparisons: runs.some(({ state }) => state) ? comparisons : host.evaluation.comparisons };
}

export async function syncMongoDay(
  config: AutomationConfig, job: AutomationJob, signal: AbortSignal,
  dependencies = { snapshot: publicationSnapshot, mongo: publishMongo },
) {
  const settings = config.publication, uri = process.env[settings.mongoUriEnv];
  if (!uri) throw new Error("Missing " + settings.mongoUriEnv);
  const snapshot = await dependencies.snapshot(config, job, signal);
  // Validate the complete result set before any external writes, including cross-pair core consistency.
  const validation = new PublicationStatistics(snapshot.comparisons);
  for await (const input of snapshot.inputs()) validation.addInput(input);
  for await (const result of snapshot.results()) validation.addResult(result);
  return dependencies.mongo({ uri, database: settings.mongoDatabase, collection: settings.mongoCollection,
    inputsUnchanged: job.mongo?.synced?.inputsUpdatedAt === (job.inputsUpdatedAt ?? 0),
    tlsCAFile: process.env[settings.mongoTlsCAFileEnv] }, job.date, snapshot.inputs(), snapshot.results(), signal);
}

/** One cumulative daily-dashboard inventory across every registered date, including adopted history. */
export async function statisticsSnapshot(
  config: AutomationConfig, state: AutomationState, signal: AbortSignal,
  dependencies = { snapshot: publicationSnapshot, labels: readMongoLabels },
) {
  const jobs = Object.values(state.jobs).sort((a, b) => a.date.localeCompare(b.date));
  const settings = config.publication, uri = process.env[settings.mongoUriEnv];
  if (!uri) throw new Error("Missing " + settings.mongoUriEnv);
  const labels = await dependencies.labels({ uri, database: settings.mongoDatabase, collection: settings.mongoCollection,
    tlsCAFile: process.env[settings.mongoTlsCAFileEnv] }, jobs.map((job) => job.date), signal);
  const statistics = new PublicationStatistics([]);
  for (const label of labels) statistics.addLabels(label);
  for (const job of jobs) {
    if (job.download !== "ready") {
      if (job.downloaded) throw new Error("Statistics input snapshot is not ready: " + job.date);
      continue;
    }
    const snapshot = await dependencies.snapshot(config, job, signal);
    statistics.addGroups(snapshot.comparisons, job.date);
    for await (const input of snapshot.inputs()) statistics.addInput(input);
    for await (const result of snapshot.results()) statistics.addResult(result);
  }
  return statistics;
}

export async function publishSnapshot(
  config: AutomationConfig, state: AutomationState, save: () => Promise<void>, signal: AbortSignal,
  dependencies = { snapshot: statisticsSnapshot, upload: uploadStatisticsLog },
): Promise<void> {
  const delivery = state.publication!, settings = config.publication;
  if (!delivery.traceId) throw new Error("Publication traceId missing");
  if (delivery.log?.status === "uploaded") return;
  if (delivery.log?.status === "sending" || delivery.log?.status === "uncertain") throw new Error("Log upload needs manual receipt resolution");
  let record = await readStatisticsLog(settings.logFile, delivery.traceId);
  if (!record) {
    if (delivery.log) throw new Error("Persisted statistics record missing; refusing to regenerate an upload");
    const statistics = await dependencies.snapshot(config, structuredClone(state), signal);
    record = statistics.record(delivery.traceId, Date.now());
    assertStatisticsLog(record);
    const data = object(record.data);
    delivery.counts = { cases: Number(data.totalCaseCount), comparisons: Number(object(data.progress).completedBattleCount) };
    if (Buffer.byteLength(JSON.stringify(record)) > 10 * 1024 * 1024) throw new Error("Statistics log exceeds the 10 MiB upload limit");
    await save();
    record = await appendStatisticsLog(settings.logFile, record);
    delivery.log = { status: "pending", writtenAt: Date.now() };
  }
  // Validate recovered records too, before persisting an upload attempt or issuing the POST.
  assertStatisticsLog(record);
  // A recovered line retains its embedded log time if the process stopped before saving the append receipt.
  delivery.log ??= { status: "pending", writtenAt: Date.parse(String(record.logtime).replace(" ", "T") + "+08:00") };
  await save();
  if (Buffer.byteLength(JSON.stringify(record)) > 10 * 1024 * 1024) throw new Error("Statistics log exceeds the 10 MiB upload limit");
  // Persist the attempt before the POST. An interrupted/ambiguous POST must never be sent twice automatically.
  signal.throwIfAborted();
  delivery.log.status = "sending";
  delivery.log.startedAt = Date.now();
  await save();
  const requestId = await dependencies.upload(settings.logUrl, record as JsonObject, signal);
  delivery.log = { ...delivery.log, status: "uploaded", requestId, uploadedAt: Date.now() };
  await save();
}
