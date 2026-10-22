import path from "node:path";
import { randomUUID } from "node:crypto";
import { object, type JsonObject, type PublicationInput, type PublicationResult } from "@eval/contracts";
import { appendStatisticsLog, completeCaseMetadata, fileSourceReader, readCaseMetadata, readJson, readJsonl, readStatisticsLogs, writeJson } from "@eval/data";
import { publishMongo, readMongoLabels } from "@eval/runtime/client";
import { PublicationStatistics, statisticsInput, publishableComparisons, publicationComparison, locateRecordStream, normalizeInput, assertStatisticsLog, assertCompleteComparisonRewrite, type EvalConfig } from "@eval/workflows/comparison";
import type { AutomationJob, AutomationState } from "@eval/automations";
import type { AutomationConfig } from "./automation-config.js";
import { checkpoint } from "./automation-evaluation.js";
import { loadConfig } from "./config.js";
import { logger } from "./composition.js";
import { automationMongoTarget } from "./automation-sources.js";
import { predictionOrigin } from "./automation-prediction.js";
import { statisticsSource, type StatisticsDeliveryStore } from "./statistics-delivery.js";

/** Reads immutable input files pinned by the publication lane and accepts only settled result references. */
export async function publicationSnapshot(config: AutomationConfig, job: AutomationJob, signal: AbortSignal, purpose: "publication" | "statistics" = "publication") {
  const host = await loadConfig(config.hostConfigs);
  const metadata = await readCaseMetadata(path.join(config.sourceDirectory, "case-meta.jsonl"));
  const runs = await Promise.all(job.runIds.map(async (id) => ({ id, state: await checkpoint(host.evaluation.output.path, id) })));
  const revisions = new Map<string, string>();
  const coordinates = new Map<string, { byteOffset: number; byteLength: number }[]>();
  const inputKey = (caseId: unknown, versionId: string) => JSON.stringify([caseId, versionId]);
  async function* sourceLines(file: string, revision: string, key: string) {
    const selected = coordinates.get(key);
    if (!selected) { yield* fileSourceReader.lines(file, revision); return; }
    if (await fileSourceReader.revision(file) !== revision) throw new Error("读取期间输入文件发生变化，请重试：" + file);
    for (const record of selected) {
      signal.throwIfAborted();
      yield { ...record, line: fileSourceReader.record(file, record.byteOffset, record.byteLength, revision) };
      // Coordinate reads are synchronous; allow active Hosts to handle tools and permits.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (await fileSourceReader.revision(file) !== revision) throw new Error("读取期间输入文件发生变化，请重试：" + file);
  }
  async function* sourceInputs(): AsyncGenerator<PublicationInput> {
    for (const version of host.evaluation.inputs.versions) {
      const id = version.id;
      const registered = [...new Set(runs.flatMap(({ state }) => Object.values(state?.inputs ?? {})
        .filter((input) => input.version === id && input.batch_id === job.date).map((input) => input.source)))];
      const files = config.prediction ? registered : job.adopted ? [...new Set(runs.flatMap(({ state }) => Object.values(state?.inputs ?? {})
        .filter((input) => input.version === id).map((input) => input.source)))] : config.remoteModels.includes(id)
          ? [path.join(config.sourceDirectory, job.date, id + ".jsonl")] : registered;
      for (const file of files) {
        const revision = revisions.get(file) ?? await fileSourceReader.revision(file);
        revisions.set(file, revision);
        const coordinateKey = JSON.stringify([file, id]);
        const selected = coordinates.get(coordinateKey) ?? [];
        const discovering = !coordinates.has(coordinateKey);
        for await (const { line, byteOffset, byteLength } of sourceLines(file, revision, coordinateKey)) {
          signal.throwIfAborted();
          if (!line.trim()) continue;
          const raw = completeCaseMetadata(normalizeInput(JSON.parse(line)), metadata), meta = object(raw.meta ?? {});
          if (!Array.isArray(raw.messages)) throw new Error("Publication input messages must be an array");
          if (!raw.messages.length) continue;
          const batch = raw.batch_id ?? meta.batch_id ?? job.date, caseId = raw.case_id ?? meta.case_id;
          if (batch !== job.date) continue;
          if (config.prediction && !runs.some(({ state }) => Object.values(state?.inputs ?? {}).some(input =>
            input.version === id && input.batch_id === batch && input.case_id === caseId))) continue;
          if (typeof caseId !== "string" || !caseId ||
              (raw.version !== undefined && raw.version !== version.name)) throw new Error("Publication input identity differs from source");
          if (discovering) selected.push({ byteOffset, byteLength });
          yield { versionId: id, trace: { ...raw, batch_id: batch, case_id: caseId, version: version.name } };
        }
        coordinates.set(coordinateKey, selected);
      }
    }
  }
  // Finish identity discovery before yielding anything: every member of a duplicate group is excluded.
  // Retain coordinates and optional statistics fields, never bodies; pin reads to the same revision.
  const identities = new Set<string>(), quarantined = new Set<string>();
  const summaries = purpose === "statistics" ? new Map<string, PublicationInput>() : undefined;
  for await (const input of sourceInputs()) {
    const key = inputKey(input.trace.case_id, input.versionId);
    if (identities.has(key)) quarantined.add(key);
    identities.add(key);
    summaries?.set(key, statisticsInput(input));
  }
  if (quarantined.size) await logger.event("publication_inputs_quarantined", {
    component: "automations", automation_id: config.id, date: job.date, run_id: job.runIds.join(","),
    inputs: [...quarantined].map(key => {
      const [case_id, version] = JSON.parse(key) as [string, string];
      return { case_id, version };
    }),
  });
  async function* inputs(): AsyncGenerator<PublicationInput> {
    const seen = new Set<string>();
    for await (const input of summaries?.values() ?? sourceInputs()) {
      const key = inputKey(input.trace.case_id, input.versionId);
      if (quarantined.has(key)) continue;
      seen.add(key);
      yield input;
    }
    // Accepted results may reference records no longer present in the current remote snapshot.
    for (const { state } of runs) if (state) {
      const acceptedInputs = new Set(Object.values(state.tasks).filter((task) => task.stage === "comparison" && !task.data.verificationAudit && task.receipt)
        .flatMap((task) => Object.values(task.inputIds)));
      for (const inputId of acceptedInputs) {
        const candidate = state.inputs[inputId], key = inputKey(candidate.case_id, candidate.version);
        if (seen.has(key) || quarantined.has(key)) continue;
        const version = (state.config as EvalConfig).inputs.versions.find((item) => item.id === candidate.version);
        if (!version) throw new Error("Accepted publication input version is not registered: " + candidate.version);
        const { raw } = await locateRecordStream(candidate.source, { ...candidate, input_id: inputId }, version, job.date);
        seen.add(key);
        yield { versionId: candidate.version, trace: { ...completeCaseMetadata(raw, metadata), batch_id: candidate.batch_id, case_id: candidate.case_id, version: version.name } };
      }
    }
  }
  async function* runResults(selectedRuns = runs, acknowledged?: ReadonlySet<string>): AsyncGenerator<PublicationResult> {
    for (const { id, state } of selectedRuns) {
      if (!state) continue;
      const ready = acknowledged ? new Map<string, number>() : publishableComparisons(state);
      // Statistics retain confirmed decisions even if a later resume schedules more text polish.
      // Only the published IDs may bypass polish readiness; new Mongo writes use the normal gate.
      if (acknowledged) for (const task of Object.values(state.tasks)) {
        if (task.stage !== "comparison" || task.data.verificationAudit || !task.data.comparisonId ||
            !acknowledged.has(task.data.comparisonId) || task.receipt?.exported?.file === "comparison-review.jsonl") continue;
        const sources = [task, ...Object.values(task.dependencies).map(taskId => state.tasks[taskId])];
        if (sources.some(source => !source || source.status !== "succeeded" || !source.receipt?.exported)) continue;
        const at = Math.max(...sources.map(source => source.receipt!.acceptedAt));
        if (Number.isFinite(at)) ready.set(task.data.comparisonId, at);
      }
      if (!ready.size) continue;
      const comparisonInputs = new Map(Object.values(state.tasks)
        .filter(task => task.stage === "comparison" && !task.data.verificationAudit)
        .map(task => [task.data.comparisonId, task.inputIds]));
      const rewriteIds = new Map<string, string[]>();
      for (const task of acknowledged ? [] : Object.values(state.tasks)) {
        const source = task.data.rewriteOf;
        if (source?.stage !== "comparison" || !task.receipt) continue;
        const comparisonId = state.tasks[source.taskId]?.data.comparisonId;
        if (!comparisonId || !ready.has(comparisonId)) continue;
        if (!task.receipt.rewriteIds?.length) throw new Error("Accepted comparison rewrite scope missing: " + source.taskId);
        rewriteIds.set(comparisonId, [...new Set([...(rewriteIds.get(comparisonId) ?? []), ...task.receipt.rewriteIds])]);
      }
      for await (const item of readJsonl(path.join(host.evaluation.output.path, id, "results/comparison.jsonl"))) {
        signal.throwIfAborted();
        const row = object(item), key = String(row.comparison_id), evaluatedAt = ready.get(key);
        if (evaluatedAt === undefined) continue;
        if (object(row.case).batch_id !== job.date) throw new Error("Publication result belongs to another date");
        ready.delete(key);
        if (Object.keys(object(row.models)).some(version => quarantined.has(inputKey(object(row.case).case_id, version)))) continue;
        const required = rewriteIds.get(key) ?? [];
        if (required.length) assertCompleteComparisonRewrite(row, required);
        yield { row: publicationComparison(row, comparisonInputs.get(key)!, state.inputs), evaluatedAt };
      }
      if (ready.size) throw new Error(`Accepted comparison rows missing in ${id}: ${ready.size}`);
    }
  }
  async function* results(purpose: "publication" | "statistics" = "publication"): AsyncGenerator<PublicationResult> {
    const replacements = new Map<string, PublicationResult>();
    if (config.predictionResults) {
      let published: { runId: string; comparisonIds: string[] } | undefined;
      try { published = await readJson(path.join(config.predictionResults, job.date, "published.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (published) {
        const state = await checkpoint(host.evaluation.output.path, published.runId);
        if (!state) throw new Error("Published prediction run is missing: " + published.runId);
        const pending = new Set(published.comparisonIds);
        for await (const result of runResults([{ id: published.runId, state }], purpose === "statistics" ? new Set(pending) : undefined)) {
          if (!pending.delete(String(result.row.comparison_id))) continue;
          const metadata = object(result.row.prediction);
          if (result.row.evaluation_purpose !== "prediction" || metadata.source_evaluation_task_id !== config.id)
            throw new Error("Prediction replacement belongs to another task");
          const id = String(metadata.source_comparison_id);
          if (replacements.has(id)) throw new Error("Duplicate prediction replacement: " + id);
          replacements.set(id, result);
        }
        if (pending.size) throw new Error("Published prediction result is unavailable");
      }
    }
    for await (const result of runResults()) {
      const replacement = replacements.get(String(result.row.comparison_id));
      if (replacement && (JSON.stringify(replacement.row.case) !== JSON.stringify(result.row.case) ||
          JSON.stringify(Object.keys(object(replacement.row.models)).sort()) !== JSON.stringify(Object.keys(object(result.row.models)).sort())))
        throw new Error("Prediction replacement business identity mismatch");
      yield replacement ?? result;
    }
    for (const [file, revision] of revisions)
      if (await fileSourceReader.revision(file) !== revision) throw new Error("读取期间输入文件发生变化，请重试：" + file);
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
  const comparisonIds: string[] = [];
  for await (const result of snapshot.results()) {
    validation.addResult(result);
    comparisonIds.push(String(result.row.comparison_id));
  }
  if (config.prediction && !comparisonIds.length) return { inputs: 0, comparisons: 0, inserted: 0, updated: 0 };
  const origin = config.prediction ? await predictionOrigin(config) : config;
  const publishedFile = path.join(config.sourceDirectory, job.date, "published.json");
  const confirmed = new Set<string>();
  if (config.prediction) {
    try {
      const previous = await readJson<{ runId: string; comparisonIds: string[] }>(publishedFile);
      if (previous.runId !== job.runIds[0]) throw new Error("Published prediction run differs from the current run");
      for (const id of previous.comparisonIds) confirmed.add(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let filesPublished = !config.prediction && !job.adopted;
  for (const model of filesPublished ? config.remoteModels : []) {
    try {
      const receipt = await readJson<{ revision: string }>(path.join(config.stateDirectory, "input-publications", job.date, model + ".json"));
      if (receipt.revision !== await fileSourceReader.revision(path.join(config.sourceDirectory, job.date, model + ".jsonl")))
        filesPublished = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      filesPublished = false;
    }
  }
  const counts = await dependencies.mongo({ uri, database: settings.mongoDatabase, collection: settings.mongoCollection, evaluationTaskId: origin.id,
    ...(settings.topic ? { topic: settings.topic } : {}),
    ...(config.prediction ? { resultsOnly: true } : {}),
    inputsUnchanged: filesPublished || job.mongo?.target === automationMongoTarget(config) &&
      job.mongo.synced?.inputsUpdatedAt === (job.inputsUpdatedAt ?? 0),
    tlsCAFile: process.env[settings.mongoTlsCAFileEnv] }, job.date, snapshot.inputs(), snapshot.results(), signal);
  if (config.prediction) {
    for (const id of comparisonIds) confirmed.add(id);
    await writeJson(publishedFile, { runId: job.runIds[0], comparisonIds: [...confirmed] });
  }
  return counts;
}

/** One cumulative daily-dashboard inventory across every registered date, including adopted history. */
export async function statisticsSnapshot(
  config: AutomationConfig, state: AutomationState, signal: AbortSignal,
  dependencies = { snapshot: publicationSnapshot, labels: readMongoLabels },
) {
  const jobs = Object.values(state.jobs).sort((a, b) => a.date.localeCompare(b.date));
  const installed = (job: AutomationJob) => job.download === "ready" || (job.download === "downloading" && job.downloaded !== undefined);
  const unavailable = jobs.find(job => job.downloaded && !installed(job));
  if (unavailable) throw new Error("Statistics input snapshot is not ready: " + unavailable.date);
  const settings = config.publication, uri = process.env[settings.mongoUriEnv];
  if (!uri) throw new Error("Missing " + settings.mongoUriEnv);
  const labels = await dependencies.labels({ uri, database: settings.mongoDatabase, collection: settings.mongoCollection, evaluationTaskId: config.id,
    tlsCAFile: process.env[settings.mongoTlsCAFileEnv] }, jobs.map((job) => job.date), signal);
  const statistics = new PublicationStatistics([]);
  for (const job of jobs) {
    if (!installed(job)) continue;
    const snapshot = await dependencies.snapshot(config, job, signal, "statistics");
    statistics.addGroups(snapshot.comparisons, job.date);
    for await (const input of snapshot.inputs()) statistics.addInput(input);
    for await (const result of snapshot.results("statistics")) statistics.addResult(result);
  }
  const labelKeys = new Set<string>();
  try {
    for await (const value of readJsonl(path.join(config.sourceDirectory, "statistics-labels.jsonl"))) {
      signal.throwIfAborted();
      const row = object(value), key = JSON.stringify([row.batchId, row.caseId]);
      if (row.evaluationTaskId !== config.id || typeof row.batchId !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.batchId) ||
          typeof row.caseId !== "string" || !row.caseId ||
          row.task !== undefined && typeof row.task !== "string" || row.difficulty !== undefined && typeof row.difficulty !== "string")
        throw new Error("Statistics label supplement has invalid task or business identity");
      if (labelKeys.has(key)) throw new Error("Duplicate statistics label supplement: " + key);
      labelKeys.add(key);
      statistics.addLabels({ batchId: row.batchId, caseId: row.caseId, task: row.task as string | undefined, difficulty: row.difficulty as string | undefined });
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const label of labels) statistics.addLabels(label);
  return statistics;
}

export async function generateStatisticsSnapshot(
  config: AutomationConfig, state: AutomationState, store: StatisticsDeliveryStore, signal: AbortSignal,
  dependencies = { snapshot: statisticsSnapshot },
): Promise<{ traceId: string; generatedAt: number }> {
  if (!config.publishStatisticsLog) throw new Error("Statistics log publication is disabled for this automation");
  const settings = config.publication, generatedAt = Date.now();
  const window = Math.floor(generatedAt / (4 * 60 * 60_000)) * 4 * 60 * 60_000;
  const prefix = `comparison-snapshot-${config.id}-${window}-`;
  const existing = (await readStatisticsLogs(settings.logFile).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as JsonObject[];
    throw error;
  })).filter(record => typeof record.traceId === "string" && record.traceId.startsWith(prefix));
  if (existing.length > 1) throw new Error("Duplicate statistics snapshot for the current window: " + prefix);
  if (existing[0]) {
    const record = existing[0];
    assertStatisticsLog(record);
    await store.register(statisticsSource(config), record);
    return { traceId: String(record.traceId), generatedAt: Date.parse(String(record.logtime).replace(" ", "T") + "+08:00") };
  }
  const statistics = await dependencies.snapshot(config, state, signal);
  let record = statistics.record(prefix + randomUUID(), generatedAt);
  assertStatisticsLog(record);
  if (Buffer.byteLength(JSON.stringify(record)) > 10 * 1024 * 1024) throw new Error("Statistics log exceeds the 10 MiB upload limit");
  record = await appendStatisticsLog(settings.logFile, record);
  assertStatisticsLog(record);
  await store.register(statisticsSource(config), record);
  return { traceId: String(record.traceId), generatedAt };
}
