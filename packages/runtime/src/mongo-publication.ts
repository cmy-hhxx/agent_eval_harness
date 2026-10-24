import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BSON, MongoClient, type Collection, type Document, type AnyBulkWriteOperation } from "mongodb";
import { errorText, redact, safeId, type PublicationInput, type PublicationResult, type PublicationCounts, type PublicationLabels } from "@eval/contracts";

export interface MongoPublicationConfig { uri: string; database: string; collection: string; evaluationTaskId: string; tlsCAFile?: string; inputsUnchanged?: boolean; resultsOnly?: boolean; topic?: string }
type Stored = Document & { _id: string };
const BATCH_BYTES = 2 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 60_000;

/** No collection creation, migrations, deletes or cross-run result cache. */
export async function publishMongo(
  config: MongoPublicationConfig, date: string, inputs: AsyncIterable<PublicationInput>,
  results: AsyncIterable<PublicationResult>, signal: AbortSignal,
): Promise<PublicationCounts> {
  return withMongoPublication(config, signal, (collection) =>
    config.resultsOnly
      ? replaceMongoPredictionPublication(collection, config.evaluationTaskId, date, inputs, results, signal)
      : writeMongoPublication(collection, config.evaluationTaskId, date, inputs, results, signal, config.inputsUnchanged, config.topic));
}

/** Reject missing or invalid destination identities before spending model calls on a prediction batch. */
export async function checkMongoPredictionSources(
  config: MongoPublicationConfig, date: string, comparisonIds: string[], signal: AbortSignal,
): Promise<void> {
  await withMongoPublication(config, signal, async collection => {
    const found = await collection.find({ batchId: date, kind: "comparison", $or: [
      { "result.comparison.comparison_id": { $in: comparisonIds } },
      { "result.comparison.prediction.source_comparison_id": { $in: comparisonIds } },
    ] }, { signal, timeoutMS: OPERATION_TIMEOUT_MS, timeoutMode: "iteration", projection: {
      evaluationTaskId: 1, caseId: 1, versionA: 1, versionB: 1,
      "result.comparison.comparison_id": 1, "result.comparison.prediction.source_comparison_id": 1,
    } }).toArray();
    for (const sourceId of comparisonIds) {
      const matches = found.filter(row => row.result?.comparison?.comparison_id === sourceId ||
        row.result?.comparison?.prediction?.source_comparison_id === sourceId);
      if (matches.length !== 1) throw new Error(`Prediction requires one existing comparison: ${sourceId} (${matches.length})`);
      assertPredictionIdentity(matches[0], config.evaluationTaskId, date, sourceId);
    }
  });
}

function assertPredictionIdentity(prior: Stored, evaluationTaskId: string, date: string, sourceId: string) {
  if (prior.evaluationTaskId !== evaluationTaskId || typeof prior.caseId !== "string" ||
      prior._id !== `comparison:${evaluationTaskId}:${date}:${prior.caseId}:${prior.versionA}:${prior.versionB}`)
    throw new Error("Prediction destination identity differs from the current Mongo contract; repair original records before publication: " + sourceId);
}

/** Oldest first: the last explicit difficulty wins; absent fields do not clear labels. */
export async function readMongoLabels(config: MongoPublicationConfig, dates: string[], signal: AbortSignal): Promise<PublicationLabels[]> {
  if (!dates.length) return [];
  return withMongoPublication(config, signal, async (collection) => {
    const documents = await collection.find({ evaluationTaskId: config.evaluationTaskId, kind: "input", batchId: { $in: dates } }, {
      signal, timeoutMS: OPERATION_TIMEOUT_MS, timeoutMode: "iteration", batchSize: 500,
      projection: { _id: 1, createdAt: 1, batchId: 1, "trace.case_id": 1, "trace.meta.case_id": 1, "trace.meta.task": 1, "trace.meta.difficulty": 1,
        "trace.meta.info.task": 1, "trace.meta.info.difficulty": 1 },
    }).toArray();
    // A server sort blocks the first batch until all historical traces have been scanned.
    for (const doc of documents) if (typeof doc._id !== "string" || !(doc.createdAt instanceof Date) || !Number.isFinite(doc.createdAt.getTime()))
      throw new Error("Mongo label lacks a valid createdAt or record ID");
    documents.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
    return documents.map((doc) => {
      const caseId = doc.trace?.case_id ?? doc.trace?.meta?.case_id;
      if (typeof doc.batchId !== "string" || typeof caseId !== "string" || !caseId) throw new Error("Mongo label lacks business identity");
      const meta = doc.trace?.meta ?? {}, task = typeof meta.task === "string" ? meta.task.trim() : "";
      return { batchId: doc.batchId, caseId, task: task && !["未分类", "未分层"].includes(task) ? meta.task : meta.info?.task,
        difficulty: meta.difficulty !== undefined ? meta.difficulty : meta.info?.difficulty };
    });
  });
}

async function withMongoPublication<T>(config: MongoPublicationConfig, signal: AbortSignal, operation: (collection: Collection<Stored>) => Promise<T>): Promise<T> {
  safeId(config.evaluationTaskId);
  let client: MongoClient | undefined;
  const stop = () => { void client?.close().catch(() => {}); };
  try {
    client = new MongoClient(config.uri, {
      compressors: ["zlib"], zlibCompressionLevel: 1,
      ...(config.tlsCAFile ? { tls: true, tlsCAFile: config.tlsCAFile } : {}),
      serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000, socketTimeoutMS: OPERATION_TIMEOUT_MS, timeoutMS: OPERATION_TIMEOUT_MS,
    });
    signal.throwIfAborted();
    signal.addEventListener("abort", stop, { once: true });
    await client.connect();
    const db = client.db(config.database);
    if (!(await db.listCollections({ name: config.collection }, { nameOnly: true }).hasNext()))
      throw new Error("Publication collection does not exist: " + config.collection);
    return await operation(db.collection<Stored>(config.collection));
  } catch (error) {
    const credentials = config.uri.match(/\/\/([^@/]+)@/)?.[1];
    const secrets = [config.uri, credentials, ...credentials?.split(":").flatMap((part) => {
      try { return [part, decodeURIComponent(part)]; } catch { return [part]; }
    }) ?? []].filter((value): value is string => !!value);
    throw new Error(redact(errorText(error), secrets));
  } finally { signal.removeEventListener("abort", stop); await client?.close(); }
}

/** Resolve business identities within one evaluation task; new cases get persistent UUIDs. */
export async function writeMongoPublication(
  collection: Pick<Collection<Stored>, "find" | "bulkWrite">, evaluationTaskId: string, date: string,
  inputs: AsyncIterable<PublicationInput>, results: AsyncIterable<PublicationResult>, signal: AbortSignal,
  inputsUnchanged = false,
  topic?: string,
): Promise<PublicationCounts> {
  safeId(evaluationTaskId);
  if (topic !== undefined && (typeof topic !== "string" || !topic.trim())) throw new Error("Invalid publication topic");
  const readOptions = { signal, timeoutMS: OPERATION_TIMEOUT_MS, timeoutMode: "iteration" as const, batchSize: 1 };
  async function step<T>(name: string, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    try { return await operation(); }
    catch (error) { throw new Error(`Mongo ${date} ${name}: ${errorText(error)}`); }
  }
  const existing = await step("read identities", () => collection.find({ evaluationTaskId, batchId: date }, { ...readOptions, batchSize: 5000, projection: {
    kind: 1, caseId: 1, versionId: 1, "trace.case_id": 1, "trace.meta.case_id": 1, "trace.meta.evaluation_topic": 1, evaluatedAt: 1,
  } }).toArray());
  const cases = new Map<string, string>(), rawById = new Map<string, string>();
  const storedIds = new Set(existing.map((doc) => doc._id));
  const topics = new Map(existing.map(doc => [doc._id, doc.trace?.meta?.evaluation_topic]));
  const topicUpdates: AnyBulkWriteOperation<Stored>[] = [];
  for (const doc of existing.filter((item) => item.kind === "input")) {
    const raw = doc.trace?.case_id ?? doc.trace?.meta?.case_id;
    if (typeof raw !== "string" || !raw || typeof doc.caseId !== "string") throw new Error("Mongo input lacks business identity");
    if ((cases.has(raw) && cases.get(raw) !== doc.caseId) || (rawById.has(doc.caseId) && rawById.get(doc.caseId) !== raw))
      throw new Error("Conflicting Mongo case identity: " + raw);
    cases.set(raw, doc.caseId); rawById.set(doc.caseId, raw);
  }
  const counts: PublicationCounts = { inputs: 0, comparisons: 0, inserted: 0, updated: 0 };
  let pending: Stored[] = [], pendingBytes = 0;
  const seen = new Set<string>();
  async function flush() {
    if (!pending.length) return;
    signal.throwIfAborted();
    const batch = `${pending[0].kind} batch (${pending.length} documents, ${pendingBytes} bytes)`;
    const stored = new Map((await step(`read ${batch}`, () => collection.find({ evaluationTaskId, _id: { $in: pending.map((doc) => doc._id) } }, readOptions)
      .toArray())).map((doc) => [doc._id, doc]));
    const operations: AnyBulkWriteOperation<Stored>[] = [];
    for (const doc of pending) {
      const prior = stored.get(doc._id);
      const { _id, createdAt, ...fields } = doc;
      if (prior) {
        if (doc.kind === "comparison" && prior.evaluatedAt > doc.evaluatedAt) continue;
        const prediction = doc.kind === "comparison" && doc.result.comparison.evaluation_purpose === "prediction";
        const priorPrediction = prior.result?.comparison?.evaluation_purpose === "prediction";
        if (doc.kind === "comparison" && priorPrediction && !prediction)
          continue;
        if (prediction) {
          const source = doc.result.comparison.prediction;
          const originalId = priorPrediction
            ? prior.result.comparison.prediction.source_comparison_id : prior.result.comparison.comparison_id;
          if (source.source_evaluation_task_id !== evaluationTaskId || source.source_comparison_id !== originalId)
            throw new Error("Prediction replacement does not reference the stored comparison: " + _id);
          if (priorPrediction && prior.evaluatedAt > doc.evaluatedAt) continue;
        }
        // Raw source refreshes must not erase annotations maintained on the stored input.
        if (doc.kind === "input") {
          const meta = { ...doc.trace.meta };
          for (const field of ["task", "difficulty"])
            if (!meta[field] && prior.trace?.meta?.[field]) meta[field] = prior.trace.meta[field];
          if (!isDeepStrictEqual(meta, doc.trace.meta ?? {})) fields.trace = { ...doc.trace, meta };
        }
        const sameResult = doc.kind === "comparison" && isDeepStrictEqual(prior.result, doc.result);
        const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
          !(key === "evaluatedAt" && sameResult) && !isDeepStrictEqual(prior[key], value)));
        const unsetTask = doc.kind === "comparison" && !Object.hasOwn(doc, "task") && Object.hasOwn(prior, "task");
        if (!Object.keys(changed).length && !unsetTask) continue;
        operations.push({ updateOne: { filter: { evaluationTaskId, _id,
          ...(doc.kind === "comparison" ? { evaluatedAt: prior.evaluatedAt,
            ...(!prediction ? { "result.comparison.evaluation_purpose": { $ne: "prediction" } } : {}) } : {}),
        }, update: { $set: changed, ...(unsetTask ? { $unset: { task: "" } } : {}) } } });
      } else operations.push({ updateOne: { filter: { evaluationTaskId, _id }, update: { $setOnInsert: doc }, upsert: true } });
    }
    if (operations.length) {
      const result = await step(`write ${batch}`, () => collection.bulkWrite(operations, {
        ordered: true, timeoutMS: OPERATION_TIMEOUT_MS,
      }));
      if (!result.isOk()) throw new Error("Mongo publication was not acknowledged");
      counts.inserted += result.upsertedCount;
      counts.updated += result.modifiedCount;
    }
    pending = []; pendingBytes = 0;
  }
  async function queue(doc: Stored) {
    signal.throwIfAborted();
    if (seen.has(doc._id)) throw new Error("Duplicate publication identity: " + doc._id);
    const bytes = BSON.calculateObjectSize(doc);
    if (bytes >= 16 * 1024 * 1024) throw new Error("Mongo document exceeds 16 MiB: " + doc._id);
    if (pendingBytes + bytes > BATCH_BYTES) await flush();
    seen.add(doc._id); pending.push(doc); pendingBytes += bytes;
    if (pending.length >= 100 || pendingBytes >= BATCH_BYTES) await flush();
  }
  const inputTasks = new Map<string, unknown>();
  for await (const { versionId, trace } of inputs) {
    safeId(versionId);
    if (trace.batch_id !== date || typeof trace.case_id !== "string" || !trace.case_id)
      throw new Error("Invalid publication input: " + versionId);
    const caseId = cases.get(trace.case_id) ?? randomUUID();
    cases.set(trace.case_id, caseId);
    inputTasks.set(JSON.stringify([trace.case_id, versionId]), trace.task);
    const id = `input:${evaluationTaskId}:${date}:${caseId}:${versionId}`;
    if (inputsUnchanged && storedIds.has(id)) {
      if (seen.has(id)) throw new Error("Duplicate publication identity: " + id);
      seen.add(id);
      if (topic && topics.get(id) !== topic) topicUpdates.push({ updateOne: {
        filter: { evaluationTaskId, batchId: date, kind: "input", _id: id },
        update: { $set: { "trace.meta.evaluation_topic": topic } },
      } });
    } else {
      if (!Array.isArray(trace.messages) || !trace.messages.length) throw new Error("Invalid publication input: " + versionId);
      await queue({ _id: id, kind: "input", evaluationTaskId, batchId: date, caseId, versionId,
        trace: topic ? { ...trace, meta: { ...trace.meta as Document, evaluation_topic: topic } } : trace, createdAt: new Date() });
    }
    counts.inputs++;
  }
  await flush();
  // Annotate already-uploaded inputs without retransmitting large traces or overwriting manual labels.
  for (let offset = 0; offset < topicUpdates.length; offset += 100) {
    const batch = topicUpdates.slice(offset, offset + 100);
    const result = await step("label input topic", () => collection.bulkWrite(batch, { ordered: true, timeoutMS: OPERATION_TIMEOUT_MS }));
    if (!result.isOk()) throw new Error("Mongo topic publication was not acknowledged");
    counts.updated += result.modifiedCount;
  }
  const core = new Map<string, boolean>();
  for await (const { row, evaluatedAt } of results) {
    if (row.status === "needs_review" || row.evaluation_type === "comparison_review")
      throw new Error("Only decided comparisons can be published");
    const identity = row.case as { batch_id?: string; case_id?: string };
    const models = row.models as Record<string, Document>;
    const versions = Object.keys(models ?? {}).sort(), rawId = identity?.case_id;
    const caseId = rawId && cases.get(rawId);
    if (identity?.batch_id !== date || !caseId || versions.length !== 2 || !Number.isFinite(evaluatedAt) ||
        !versions.every((id) => inputTasks.has(JSON.stringify([rawId, id]))))
      throw new Error("Comparison is missing paired input or evaluation time");
    if (row.rewritten !== undefined && (!Array.isArray((row.rewritten as Document)?.rewrites) || !(row.rewritten as Document).rewrites.length))
      throw new Error("Invalid comparison rewrite");
    const task = inputTasks.get(JSON.stringify([rawId, versions[0]]));
    if (task !== inputTasks.get(JSON.stringify([rawId, versions[1]]))) throw new Error("Comparison input tasks differ");
    for (const version of versions) {
      const key = JSON.stringify([rawId, version]), value = (row.assessments as Document | undefined)?.[version]?.meets_core;
      if (row.status === "decided" && typeof value !== "boolean") throw new Error("Settled comparison is missing a core assessment: " + key);
      if (typeof value !== "boolean") continue;
      if (core.has(key) && core.get(key) !== value) throw new Error("Conflicting answer core assessments across comparisons: " + key);
      core.set(key, value);
    }
    const matching = Object.entries(row.verdicts as Record<string, unknown>).filter(([key]) => {
      const pair = key.split("__vs__");
      return pair.length === 2 && versions.every((id) => pair.includes(id));
    });
    if (matching.length !== 1) throw new Error("Comparison verdict is missing or duplicated");
    const verdict = matching[0][1];
    const comparison = { ...row, ...(topic ? { evaluation_topic: topic } : {}), case: { batch_id: date, case_id: caseId },
      models: Object.fromEntries(versions.map((id) => [id, { ...models[id], version: id, display_name: models[id].version }])), verdict };
    await queue({ _id: `comparison:${evaluationTaskId}:${date}:${caseId}:${versions.join(":")}`, kind: "comparison", evaluationTaskId, batchId: date, caseId,
      ...(typeof task === "string" && task ? { task } : {}), versionA: versions[0], versionB: versions[1],
      result: { comparison }, evaluatedAt: new Date(evaluatedAt), createdAt: new Date(evaluatedAt) });
    counts.comparisons++;
  }
  await flush();
  return counts;
}

/** Replace the exact published source comparison; its existing IDs and input documents remain authoritative. */
export async function replaceMongoPredictionPublication(
  collection: Pick<Collection<Stored>, "find" | "bulkWrite">, evaluationTaskId: string, date: string,
  inputs: AsyncIterable<PublicationInput>, results: AsyncIterable<PublicationResult>, signal: AbortSignal,
): Promise<PublicationCounts> {
  const options = { signal, timeoutMS: OPERATION_TIMEOUT_MS, timeoutMode: "iteration" as const, batchSize: 100 };
  const sourceInputs = new Set<string>();
  for await (const input of inputs) {
    if (input.trace.batch_id !== date || typeof input.trace.case_id !== "string")
      throw new Error("Prediction input identity is invalid");
    sourceInputs.add(JSON.stringify([input.trace.case_id, input.versionId]));
  }
  const operations: AnyBulkWriteOperation<Stored>[] = [], seen = new Set<string>();
  let comparisons = 0;
  for await (const { row, evaluatedAt } of results) {
    signal.throwIfAborted();
    const prediction = row.prediction as Document | undefined, identity = row.case as Document;
    const versions = Object.keys((row.models ?? {}) as Document).sort();
    if (row.evaluation_purpose !== "prediction" || row.status !== "decided" ||
        prediction?.source_evaluation_task_id !== evaluationTaskId || typeof prediction.source_comparison_id !== "string" ||
        identity?.batch_id !== date || versions.length !== 2 || !Number.isFinite(evaluatedAt) ||
        !versions.every(version => sourceInputs.has(JSON.stringify([identity.case_id, version]))))
      throw new Error("Prediction replacement lacks provenance or paired inputs");
    const sourceId = prediction.source_comparison_id;
    if (seen.has(sourceId)) throw new Error("Duplicate prediction source comparison: " + sourceId);
    seen.add(sourceId);
    // Source comparison IDs are persisted UUIDs. Resolve that exact receipt, including retries after replacement.
    const found = await collection.find({ batchId: date, kind: "comparison", $or: [
      { "result.comparison.comparison_id": sourceId },
      { "result.comparison.prediction.source_comparison_id": sourceId },
    ] }, options).toArray();
    if (found.length !== 1) throw new Error(`Prediction requires one existing comparison: ${sourceId} (${found.length})`);
    const prior = found[0], stored = prior.result?.comparison;
    assertPredictionIdentity(prior, evaluationTaskId, date, sourceId);
    const models = row.models as Record<string, Document>, storedVersions = [prior.versionA, prior.versionB] as string[];
    const bindings = new Map<string, string>();
    for (const version of versions) {
      const traceId = models[version].trace_id;
      const matches = storedVersions.filter(id => typeof traceId === "string" && !!traceId &&
        stored?.models?.[id]?.trace_id === traceId);
      if (matches.length !== 1) throw new Error("Prediction cannot uniquely bind the original answer trace: " + sourceId);
      bindings.set(version, matches[0]);
    }
    if (new Set(bindings.values()).size !== 2) throw new Error("Prediction answer traces are duplicated: " + sourceId);
    const paired = await collection.find({ batchId: date, caseId: prior.caseId, kind: "input",
      evaluationTaskId, versionId: { $in: storedVersions },
    }, { ...options, projection: { versionId: 1, "trace.case_id": 1, "trace.meta.case_id": 1 } }).toArray();
    if (paired.length !== 2 || new Set(paired.map(input => input.versionId)).size !== 2 ||
        paired.some(input => (input.trace?.case_id ?? input.trace?.meta?.case_id) !== identity.case_id))
      throw new Error("Prediction requires the original paired inputs: " + sourceId);
    const verdicts = Object.entries(row.verdicts as Document).filter(([key]) => {
      const pair = key.split("__vs__"); return pair.length === 2 && versions.every(id => pair.includes(id));
    });
    if (verdicts.length !== 1) throw new Error("Prediction verdict pair mismatch");
    const comparison = bindPublishedPrediction(row, prior.caseId, storedVersions, bindings);
    comparisons++;
    if (stored.evaluation_purpose === "prediction" && isDeepStrictEqual(stored, comparison)) continue;
    if (stored.evaluation_purpose === "prediction" && prior.evaluatedAt > new Date(evaluatedAt))
      throw new Error("A newer prediction result is already published: " + sourceId);
    if (BSON.calculateObjectSize(comparison) >= 16 * 1024 * 1024)
      throw new Error("Prediction document exceeds 16 MiB");
    operations.push({ updateOne: {
      filter: { _id: prior._id, "result.comparison.comparison_id": stored.comparison_id, evaluatedAt: prior.evaluatedAt },
      update: { $set: { result: { comparison }, evaluatedAt: new Date(evaluatedAt) } },
    } });
  }
  // Resolve and validate every selected original before the first write. Never insert, migrate or update input documents.
  let updated = 0, batch: AnyBulkWriteOperation<Stored>[] = [], bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    signal.throwIfAborted();
    const result = await collection.bulkWrite(batch, { ordered: true, timeoutMS: OPERATION_TIMEOUT_MS });
    if (!result.isOk() || result.matchedCount !== batch.length)
      throw new Error("Prediction target changed during publication; retry to verify the stored result");
    updated += result.modifiedCount; batch = []; bytes = 0;
  };
  for (const operation of operations) {
    const size = BSON.calculateObjectSize(operation);
    if (bytes + size > BATCH_BYTES) await flush();
    batch.push(operation); bytes += size;
  }
  await flush();
  return { inputs: 0, comparisons, inserted: 0, updated };
}

/** Bind by immutable answer trace IDs, preserving the destination's model identities and A/B columns. */
function bindPublishedPrediction(row: Document, caseId: string, columns: string[], bindings: Map<string, string>): Document {
  const id = (value: string) => {
    const mapped = bindings.get(value);
    if (!mapped) throw new Error("Unknown model in prediction result: " + value);
    return mapped;
  };
  const keyed = (value: Document) => Object.fromEntries(Object.entries(value).map(([key, item]) => [id(key), item]));
  const verdicts = Object.fromEntries(Object.entries(row.verdicts as Document).map(([key, value]) => {
    const verdict = value as Document;
    return [key.split("__vs__").map(id).join("__vs__"), { ...verdict,
      winner_version: verdict.winner_version === null ? null : id(verdict.winner_version) }];
  }));
  const sourceColumns = Object.keys(row.models).sort();
  const decision = row.decision_basis;
  return {
    ...row, case: { ...row.case, case_id: caseId },
    models: Object.fromEntries(Object.entries(row.models as Record<string, Document>).map(([key, model]) =>
      [id(key), { ...model, version: id(key), display_name: model.version }])),
    ranking: row.ranking.map((tier: string[]) => tier.map(id)),
    assessments: keyed(row.assessments), evaluations: keyed(row.evaluations),
    attribution_task_ids: keyed(row.attribution_task_ids), verdicts, verdict: Object.values(verdicts)[0],
    decision_basis: { ...decision,
      comparisons: decision.comparisons.map((item: Document) => ({ ...item,
        better_candidates: item.better_candidates.map(id), assessments: keyed(item.assessments) })),
      decisive_findings: decision.decisive_findings.map((item: Document) => ({ ...item, candidate: id(item.candidate) })),
    },
    ...(row.rewritten ? { rewritten: { ...row.rewritten, rewrites: row.rewritten.rewrites.map((item: Document) => ({
      ...item, id: item.id.replace(/^(assessment|comparison\.\d+)\.([AB])\.summary$/u,
        (_match: string, slot: string, label: string) => `${slot}.${columns.indexOf(id(sourceColumns[label === "A" ? 0 : 1])) === 0 ? "A" : "B"}.summary`),
    })) } } : {}),
  };
}
